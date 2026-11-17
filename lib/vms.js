'use strict';

/*
 * Optional link to the owner's own video management software "Andreas L.-Arts VMS" (API.md of the VMS):
 *  - GET  /api/integration  cameras, stream names, RTSP release (user/password/port)
 *  - GET  /api/stream       Server-Sent Events: state (per camera), event, plate; ": ping" every 15 s
 *  - GET  /api/cameras      camera settings (record mode, host for finding the door camera)
 *  - PUT  /api/cameras/<id> {"record": {"mode"}} / {"enabled"}
 *  - POST /api/events/external {"camera", "label", "duration"}
 * The API key goes in "Authorization: Bearer"; only MJPEG URLs for ffmpeg / browsers carry it as ?key=.
 * Without a VMS in the settings nothing of this runs.
 */

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

/** "192.168.0.10:8080" -> "http://192.168.0.10:8080" (no trailing slash) */
function normalizeBase(text) {
    let s = String(text || '').trim();
    if (!s) {
        return '';
    }
    if (!/^https?:\/\//i.test(s)) {
        s = `http://${s}`;
    }
    try {
        const u = new URL(s);
        return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
        return '';
    }
}

/** URL of the live picture of a VMS camera: RTSP through the VMS when released, else MJPEG (VMS converts) */
function liveTarget(base, key, info, cam, which = 'sub') {
    const rtsp = info && info.rtsp;
    if (rtsp && rtsp.enabled && cam.rtsp && cam.rtsp[which]) {
        const host = new URL(base).hostname;
        const cred = rtsp.username ? `${encodeURIComponent(rtsp.username)}:${encodeURIComponent(rtsp.password || '')}@` : '';
        const p = String(cam.rtsp[which]);
        return { mode: 'stream', url: `rtsp://${cred}${host.includes(':') ? `[${host}]` : host}:${Number(rtsp.port) || 8554}${p.startsWith('/') ? p : `/${p}`}` };
    }
    const m = cam.mjpeg && (cam.mjpeg[which] || cam.mjpeg.main);
    if (!m) {
        throw new Error(`VMS: Kamera "${cam.id}" hat weder RTSP noch MJPEG`);
    }
    return { mode: 'http', url: `${base}${m}${m.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` };
}

class VmsClient extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.base e.g. http://192.168.0.10:8080
     * @param {string} o.key API key (alvms_…)
     * @param {number} [o.timeout] ms for normal requests
     */
    constructor({ base, key, log, timeout = 10000 }) {
        super();
        this.base = normalizeBase(base);
        this.key = String(key || '').trim();
        this.log = log;
        this.timeout = timeout;
        this.connected = false;
        this.backoff = 2000;
        this.info = null;
        this.infoAt = 0;
    }

    _request(method, path, body, { timeout = this.timeout } = {}) {
        return new Promise((resolve, reject) => {
            const u = new URL(this.base + path);
            const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
            const lib = u.protocol === 'https:' ? https : http;
            const req = lib.request(
                u,
                {
                    method,
                    headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
                    rejectUnauthorized: false, // own certificate of the VMS
                    timeout,
                },
                res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json = null;
                        try {
                            json = text ? JSON.parse(text) : null;
                        } catch {
                            // not JSON
                        }
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(json);
                        } else {
                            const why = res.statusCode === 401 ? 'API-Schlüssel falsch oder gelöscht' : res.statusCode === 403 ? 'mit dem API-Schlüssel nicht erlaubt' : (json && (json.error || json.detail)) || text.slice(0, 120);
                            const err = new Error(`VMS ${method} ${path}: ${res.statusCode} ${why}`);
                            err.status = res.statusCode;
                            reject(err);
                        }
                    });
                },
            );
            req.on('timeout', () => req.destroy(new Error(`VMS antwortet nicht (${Math.round(timeout / 1000)} s)`)));
            req.on('error', reject);
            req.end(data);
        });
    }

    /** cameras + RTSP release; cached for a minute (resolvers ask often after reconnects) */
    async integration(fresh = false) {
        if (!fresh && this.info && Date.now() - this.infoAt < 60000) {
            return this.info;
        }
        const info = await this._request('GET', '/api/integration');
        if (!info || !Array.isArray(info.cameras)) {
            throw new Error('VMS: unerwartete Antwort von /api/integration');
        }
        this.info = info;
        this.infoAt = Date.now();
        return info;
    }

    cameras() {
        return this._request('GET', '/api/cameras');
    }

    setCamera(id, body) {
        return this._request('PUT', `/api/cameras/${encodeURIComponent(id)}`, body);
    }

    external(camera, label, duration) {
        return this._request('POST', '/api/events/external', { camera, label, duration });
    }

    async live(id, which = 'sub') {
        const info = await this.integration();
        const cam = info.cameras.find(c => c.id === id);
        if (!cam) {
            this.info = null; // maybe new in the VMS
            throw new Error(`VMS: Kamera "${id}" gibt es nicht (mehr)`);
        }
        return liveTarget(this.base, this.key, info, cam, which);
    }

    // ---------------- live channel (SSE) ----------------

    start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this._connect();
    }

    stop() {
        this.running = false;
        clearTimeout(this.retryTimer);
        clearTimeout(this.idleTimer);
        if (this.req) {
            this.req.destroy();
            this.req = null;
        }
    }

    _setConnected(on, why) {
        if (this.connected !== on) {
            this.connected = on;
            this.emit('connection', on, why);
        }
    }

    _connect() {
        if (!this.running) {
            return;
        }
        const u = new URL(`${this.base}/api/stream`);
        const lib = u.protocol === 'https:' ? https : http;
        let buf = '';
        let failed = false;
        const fail = why => {
            if (failed) {
                return;
            }
            failed = true;
            clearTimeout(this.idleTimer);
            if (this.req) {
                this.req.destroy();
                this.req = null;
            }
            this._setConnected(false, why);
            if (this.running) {
                // growing wait: 2 s, 4 s … 60 s (reset after a working connection)
                this.retryTimer = setTimeout(() => this._connect(), this.backoff);
                this.backoff = Math.min(this.backoff * 2, 60000);
            }
        };
        // nothing for 45 s (pings come every 15 s): connection is dead
        const alive = () => {
            clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => fail('keine Daten mehr (45 s)'), this.idleMs || 45000);
        };
        const req = lib.get(u, { headers: { Authorization: `Bearer ${this.key}`, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }, rejectUnauthorized: false }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return fail(res.statusCode === 401 ? 'API-Schlüssel falsch oder gelöscht (401)' : `HTTP ${res.statusCode}`);
            }
            this.backoff = 2000;
            this._setConnected(true);
            alive();
            res.setEncoding('utf8');
            res.on('data', chunk => {
                alive();
                buf += chunk;
                let i;
                while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
                    this._block(block);
                }
            });
            res.on('end', () => fail('Verbindung von der VMS beendet'));
            res.on('error', err => fail(err.message));
        });
        req.on('error', err => fail(err.code === 'ECONNREFUSED' ? 'nicht erreichbar (Verbindung abgelehnt)' : err.message));
        this.req = req;
        // also the connect itself must not hang forever
        alive();
    }

    _block(block) {
        let event = 'message';
        const data = [];
        for (const line of block.split(/\r?\n/)) {
            if (!line || line.startsWith(':')) {
                continue;
            }
            const c = line.indexOf(':');
            const field = c < 0 ? line : line.slice(0, c);
            const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (field === 'event') {
                event = value;
            } else if (field === 'data') {
                data.push(value);
            } else if (field === 'retry' && Number(value) > 0) {
                this.backoff = Math.max(Number(value), 1000);
            }
        }
        if (!data.length) {
            return;
        }
        let payload;
        try {
            payload = JSON.parse(data.join('\n'));
        } catch {
            return;
        }
        this.emit('message', event, payload);
    }
}

module.exports = { VmsClient, normalizeBase, liveTarget };
