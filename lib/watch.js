'use strict';

/*
 * Detection watcher for one camera. Light on the CPU:
 *  - video cameras: an own ffmpeg that decodes only key frames (-skip_frame nokey), scales them to 416 x 416
 *    (letterbox) and hands raw BGR frames over (about 0.5-2 per second, depending on the camera's key frame
 *    interval); snapshot / MJPEG cameras: one picture per second from the CameraSource, decoded by ffmpeg;
 *  - the model only runs when the picture changed (cheap difference on a 52 x 52 grey picture) or while something
 *    is still detected, at most once per `interval`;
 *  - a group (person / vehicle / animal) stays "on" until it was not seen for `hold` ms.
 *
 * Events: 'state' {group, on, count, label, score}, 'detected' {group, dets} (rising edge: photo, push),
 *         'error' (message, logged once per kind by main).
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { SIZE, inZones } = require('./detect');

const FRAME = SIZE * SIZE * 3;
const PAD = '0x727272'; // grey 114 like YOLOX training
const VF = `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,pad=${SIZE}:${SIZE}:0:0:color=${PAD}`;

/** width / height from a JPEG's SOF marker */
function jpegSize(buf) {
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
}

/** 52 x 52 grey sample of a letterboxed BGR frame */
function thumb(bgr) {
    const n = 52;
    const step = SIZE / n;
    const out = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const p = ((y * step + 4) * SIZE + (x * step + 4)) * 3;
            out[y * n + x] = (bgr[p] + 2 * bgr[p + 1] + bgr[p + 2]) >> 2;
        }
    }
    return out;
}

function difference(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += Math.abs(a[i] - b[i]);
    }
    return sum / a.length;
}

class Watcher extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.id
     * @param {import('./source').CameraSource} o.source
     * @param {import('./detect').Detector} o.detector
     * @param {string[]} o.groups e.g. ['person', 'vehicle']
     * @param {Array} [o.zones] parsed zones (empty = whole picture)
     * @param {number} [o.minScore] 0..1
     * @param {number} [o.hold] ms a group stays on after it was last seen
     * @param {number} [o.interval] ms between two inferences of this camera
     * @param {number} [o.motion] mean grey difference that counts as a change
     */
    constructor(o) {
        super();
        this.id = o.id;
        this.source = o.source;
        this.detector = o.detector;
        this.log = o.log;
        this.groups = o.groups;
        this.zones = o.zones || [];
        this.minScore = o.minScore || 0.5;
        this.hold = o.hold || 20000;
        this.interval = o.interval || 1000;
        this.motion = o.motion || 3;
        // vehicles at the same place for longer than parkMs are parked: no box, no detection (0 = off)
        this.parkMs = o.parkMs || 0;
        this.tracks = [];
        this.ffmpegPath = o.ffmpegPath || 'ffmpeg';
        this.spawnFn = o.spawnFn || spawn;
        this.now = o.now || (() => Date.now());
        this.state = {};
        for (const g of this.groups) {
            this.state[g] = { on: false, count: 0, last: 0 };
        }
        this.prev = null;
        this.lastBoxes = '[]'; // main sets the state to [] at start
        this.lastRun = 0;
        this.lastCheck = 0;
        this.busy = false;
        this.running = false;
        this.backoff = 5000;
    }

    start() {
        if (this.running) {
            return;
        }
        this.running = true;
        // "off" also when no picture comes any more
        this.tick = setInterval(() => this._expire(this.now()), 2000);
        this.tick.unref();
        this._connect();
    }

    stop() {
        this.running = false;
        clearTimeout(this.retry);
        clearInterval(this.tick);
        this.pollToken = null;
        if (this.proc) {
            this.proc.kill('SIGKILL');
            this.proc = null;
        }
    }

    setZones(zones) {
        this.zones = zones;
    }

    async _connect() {
        if (!this.running) {
            return;
        }
        let target;
        try {
            target = await this.source._target();
        } catch (err) {
            return this._fail(err.message);
        }
        if (!this.running) {
            return;
        }
        if (target.mode === 'stream') {
            this._stream(target.url);
        } else {
            this._poll();
        }
    }

    _fail(message) {
        this.emit('error', message);
        if (this.proc) {
            this.proc.kill('SIGKILL');
            this.proc = null;
        }
        if (this.running) {
            this.retry = setTimeout(() => this._connect(), this.backoff);
            this.backoff = Math.min(this.backoff * 2, 60000);
        }
    }

    /** RTSP / video: only key frames, scaled, as raw BGR */
    _stream(url) {
        const args = ['-hide_banner', '-loglevel', 'info', '-nostdin'];
        if (/^rtsps?:/i.test(url)) {
            args.push('-rtsp_transport', this.source.cfg.rtspTransport || 'tcp');
        }
        if (!/^[a-z]+:/i.test(url)) {
            args.push('-re'); // a file (tests): play in real time like a camera
        }
        args.push('-skip_frame', 'nokey', '-i', url, '-an', '-sn', '-dn', '-vf', `fps=2,${VF}`, '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1');
        let proc;
        try {
            proc = this.spawnFn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            return this._fail(err.message);
        }
        this.proc = proc;
        let orig = null;
        let stderr = '';
        let buf = Buffer.alloc(0);
        proc.stderr.on('data', chunk => {
            stderr = (stderr + chunk.toString()).slice(-4000);
            if (!orig) {
                const m = /Stream #\d+:\d+.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
                if (m) {
                    orig = { w: Number(m[1]), h: Number(m[2]) };
                }
            }
        });
        proc.stdout.on('data', chunk => {
            buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
            while (buf.length >= FRAME) {
                const frame = buf.subarray(0, FRAME);
                buf = buf.subarray(FRAME);
                this.backoff = 5000;
                if (orig) {
                    this._frame(Buffer.from(frame), orig);
                }
            }
        });
        proc.on('error', err => this.proc === proc && this._fail(err.message));
        proc.on('exit', code => {
            if (this.proc === proc) {
                this.proc = null;
                const last = stderr.trim().split('\n').filter(l => !/^\s/.test(l)).pop() || '';
                this._fail(`ffmpeg ended (code ${code})${last ? `: ${last.replace(/\/\/[^@\s/]+@/g, '//***@').replace(/key=[^&\s]+/g, 'key=***')}` : ''}`);
            }
        });
    }

    /** snapshot / MJPEG cameras: one picture per second */
    async _poll() {
        const token = (this.pollToken = {});
        while (this.running && this.pollToken === token) {
            const t0 = this.now();
            try {
                const jpeg = await this.source.getFrame(1500, 10000);
                const orig = jpegSize(jpeg);
                if (orig) {
                    this._frame(await this._decode(jpeg), orig);
                }
                this.backoff = 5000;
            } catch (err) {
                if (this.pollToken === token) {
                    this.pollToken = null;
                    return this._fail(err.message);
                }
                return;
            }
            await new Promise(r => setTimeout(r, Math.max(100, 1000 - (this.now() - t0))));
        }
    }

    _decode(jpeg) {
        return new Promise((resolve, reject) => {
            const p = this.spawnFn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-vf', VF, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1'], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const out = [];
            p.stdout.on('data', c => out.push(c));
            p.on('error', reject);
            p.on('exit', () => {
                const b = Buffer.concat(out);
                b.length >= FRAME ? resolve(b.subarray(0, FRAME)) : reject(new Error('picture could not be decoded'));
            });
            p.stdin.on('error', () => {});
            p.stdin.end(jpeg);
        });
    }

    /** a decoded frame: run the model when something changed or something is still there */
    _frame(bgr, orig) {
        const now = this.now();
        const small = thumb(bgr);
        const changed = !this.prev || difference(small, this.prev) >= this.motion;
        this.prev = small;
        const present = this.groups.some(g => this.state[g].on);
        this._expire(now);
        if (this.busy || now - this.lastRun < this.interval) {
            return;
        }
        // also a check every 30 s, so a person standing still is found and the "off" is confirmed
        if (!changed && !present && now - this.lastCheck < 30000) {
            return;
        }
        this.busy = true;
        this.lastRun = now;
        this.lastCheck = now;
        this.detector
            .detect(bgr, orig, this.minScore)
            .then(dets => this._result(dets, orig, bgr))
            .catch(err => this.emit('error', `Erkennung: ${err.message}`))
            .finally(() => {
                this.busy = false;
            });
    }

    /** detections of this camera's groups inside its zones */
    filter(all) {
        return all.filter(d => this.groups.includes(d.group) && inZones(d, this.zones));
    }

    /** drop vehicles that stand at the same place for longer than parkMs (a parked car is no event) */
    park(dets, now) {
        if (!this.parkMs) {
            return dets;
        }
        const iou = (a, b) => {
            const x1 = Math.max(a.x, b.x);
            const y1 = Math.max(a.y, b.y);
            const x2 = Math.min(a.x + a.w, b.x + b.w);
            const y2 = Math.min(a.y + a.h, b.y + b.h);
            const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
            return inter / (a.w * a.h + b.w * b.h - inter || 1);
        };
        const out = [];
        for (const d of dets) {
            if (d.group !== 'vehicle') {
                out.push(d);
                continue;
            }
            let t = this.tracks.find(k => iou(k, d) >= 0.6);
            if (!t) {
                t = { x: d.x, y: d.y, w: d.w, h: d.h, since: now, last: now };
                this.tracks.push(t);
            }
            t.last = now;
            if (now - t.since < this.parkMs) {
                out.push(d);
            }
        }
        // a place not seen for 3 min (and at least the hold time) is free again
        const keep = Math.max(180000, this.hold);
        this.tracks = this.tracks.filter(t => now - t.last < keep);
        return out;
    }

    _result(all, orig, bgr) {
        const now = this.now();
        const dets = this.park(this.filter(all), now);
        if (dets.length && bgr) {
            this.lastFrame = { bgr, orig };
        }
        this._boxes(dets);
        for (const g of this.groups) {
            const seen = dets.filter(d => d.group === g);
            const st = this.state[g];
            if (seen.length) {
                st.last = now;
                const best = seen[0];
                if (!st.on || st.count !== seen.length) {
                    const rising = !st.on;
                    st.on = true;
                    st.count = seen.length;
                    this.emit('state', { group: g, on: true, count: seen.length, label: best.label, score: best.score });
                    if (rising) {
                        this.emit('detected', { group: g, dets: seen });
                    }
                }
            }
        }
        this._expire(now);
    }

    _expire(now) {
        for (const g of this.groups) {
            const st = this.state[g];
            if (st.on && now - st.last >= this.hold) {
                st.on = false;
                st.count = 0;
                this.emit('state', { group: g, on: false, count: 0, label: '', score: 0 });
            }
        }
        if (!this.groups.some(g => this.state[g].on)) {
            this._boxes([]);
        }
    }

    /** boxes of the last check for live overlays ('boxes' only when they change) */
    _boxes(dets) {
        const r = v => Math.round(v * 1000) / 1000;
        const list = dets.slice(0, 20).map(d => ({ g: d.group, l: d.label, s: Math.round(d.score * 100), x: r(d.x), y: r(d.y), w: r(d.w), h: r(d.h) }));
        const text = JSON.stringify(list);
        if (text !== this.lastBoxes) {
            this.lastBoxes = text;
            this.emit('boxes', text);
        }
    }
}

module.exports = { Watcher, jpegSize, thumb, difference, VF, FRAME };
