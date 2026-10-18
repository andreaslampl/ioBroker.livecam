'use strict';

/*
 * One camera as a source of JPEG frames.
 *
 * Modes:
 *   stream    any URL ffmpeg can read (RTSP H.264/H.265, HTTP MJPEG, ...),
 *             transcoded to JPEG frames
 *   snapshot  an HTTP URL returning a single JPEG, polled at the frame rate
 *   onvif     stream URI (or snapshot URI as fallback) found via ONVIF
 *
 * The camera is only contacted while someone watches (or keepAlive is set).
 * A watchdog restarts the connection when no frame arrived for stallTimeout,
 * with increasing delays after repeated failures.
 *
 * Events: 'frame' (Buffer), 'status' ({online, fps, error, viewers}).
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { JpegSplitter } = require('./jpeg');
const { HttpClient } = require('./http-client');
const { OnvifClient } = require('./onvif');

const IDLE_STOP = 15000;
const MIN_BACKOFF = 2000;
const MAX_BACKOFF = 60000;

/** Put user/password into a URL (ffmpeg reads credentials from the URL). */
function withCredentials(url, user, password) {
    if (!user) {
        return url;
    }
    try {
        const u = new URL(url);
        if (!u.username) {
            u.username = user;
            u.password = password || '';
        }
        return u.toString();
    } catch {
        return url;
    }
}

/** URL without credentials, for logs. */
function redact(url) {
    try {
        const u = new URL(url);
        if (u.username || u.password) {
            u.username = '***';
            u.password = '';
        }
        return u.toString();
    } catch {
        return url;
    }
}

class CameraSource extends EventEmitter {
    /**
     * @param {object} cfg
     * @param {string} cfg.id
     * @param {'stream'|'snapshot'|'onvif'} cfg.type
     * @param {string} [cfg.url]
     * @param {string} [cfg.host] for onvif
     * @param {number} [cfg.onvifPort]
     * @param {number} [cfg.profile]
     * @param {string} [cfg.user]
     * @param {string} [cfg.password]
     * @param {number} [cfg.fps]
     * @param {number} [cfg.width]
     * @param {number} [cfg.quality] ffmpeg -q:v (2 best … 31 worst)
     * @param {boolean} [cfg.keepAlive]
     * @param {string} [cfg.rtspTransport] tcp | udp
     */
    constructor(cfg, { log, ffmpegPath = 'ffmpeg', stallTimeout = 15000, spawnFn = spawn } = {}) {
        super();
        this.cfg = {
            fps: 5,
            width: 0,
            quality: 5,
            rtspTransport: 'tcp',
            ...cfg,
        };
        this.id = cfg.id;
        this.log = log;
        this.ffmpegPath = ffmpegPath;
        this.stallTimeout = stallTimeout;
        this.spawnFn = spawnFn;
        this.viewers = 0;
        this.latest = null;
        this.latestAt = 0;
        this.running = false;
        this.online = false;
        this.error = '';
        this.backoff = MIN_BACKOFF;
        this.proc = null;
        this.startedAt = 0;
        this.idleTimer = null;
        this.restartTimer = null;
        this.watchdog = null;
        this.frameCount = 0;
        this.fps = 0;
        this.resolved = null;
        this.http = new HttpClient({ user: cfg.user, password: cfg.password });
        this.splitter = new JpegSplitter(frame => this._frame(frame));
        if (this.cfg.keepAlive) {
            this._start();
        }
    }

    addViewer() {
        this.viewers++;
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (!this.running) {
            this._start();
        }
        this._status();
    }

    removeViewer() {
        this.viewers = Math.max(0, this.viewers - 1);
        if (!this.viewers && !this.cfg.keepAlive && !this.idleTimer) {
            // Keep it running a little so a page reload does not reconnect.
            this.idleTimer = setTimeout(() => {
                this.idleTimer = null;
                if (!this.viewers) {
                    this._stop();
                }
            }, IDLE_STOP);
        }
        this._status();
    }

    /** Wait for a frame newer than maxAge (starts the camera if needed). */
    async getFrame(maxAge = 2000, timeout = 10000) {
        if (this.latest && Date.now() - this.latestAt <= maxAge) {
            return this.latest;
        }
        this.addViewer();
        try {
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.removeListener('frame', onFrame);
                    reject(new Error(this.error || 'No image from camera'));
                }, timeout);
                const onFrame = frame => {
                    clearTimeout(timer);
                    resolve(frame);
                };
                this.once('frame', onFrame);
            });
        } finally {
            this.removeViewer();
        }
    }

    destroy() {
        this.cfg.keepAlive = false;
        clearTimeout(this.idleTimer);
        this._stop();
        this.removeAllListeners();
    }

    _start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.backoff = MIN_BACKOFF;
        this.watchdog = setInterval(() => this._checkStall(), 1000);
        this._connect();
    }

    _stop() {
        this.running = false;
        clearInterval(this.watchdog);
        clearTimeout(this.restartTimer);
        this.watchdog = null;
        this.restartTimer = null;
        this._disconnect();
        this._setOnline(false);
    }

    async _connect() {
        if (!this.running) {
            return;
        }
        this.startedAt = Date.now();
        this.splitter.reset();
        try {
            const { mode, url } = await this._target();
            if (!this.running) {
                return;
            }
            if (mode === 'snapshot') {
                this._pollSnapshots(url);
            } else {
                this._spawnFfmpeg(url);
            }
        } catch (err) {
            this._fail(err.message);
        }
    }

    async _target() {
        const c = this.cfg;
        if (c.type === 'snapshot') {
            return { mode: 'snapshot', url: c.url };
        }
        if (c.type === 'stream') {
            return { mode: 'stream', url: withCredentials(c.url, c.user, c.password) };
        }
        if (!this.resolved) {
            const onvif = new OnvifClient({ host: c.host, port: c.onvifPort || 80, user: c.user, password: c.password });
            const r = await onvif.resolve(Number(c.profile) || 0);
            this.resolved = r;
            this.log.info(
                `${this.id}: ONVIF profile "${r.profile.name}" ${r.profile.width}x${r.profile.height}, ` +
                    `stream ${r.streamUri ? redact(r.streamUri) : '-'}, snapshot ${r.snapshotUri ? redact(r.snapshotUri) : '-'}`,
            );
            this.emit('resolved', r);
        }
        if (this.resolved.streamUri) {
            return { mode: 'stream', url: withCredentials(this.resolved.streamUri, c.user, c.password) };
        }
        if (this.resolved.snapshotUri) {
            return { mode: 'snapshot', url: this.resolved.snapshotUri };
        }
        throw new Error('ONVIF returned neither a stream nor a snapshot URI');
    }

    _spawnFfmpeg(url) {
        const c = this.cfg;
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
        if (/^rtsps?:/i.test(url)) {
            args.push('-rtsp_transport', c.rtspTransport, '-fflags', 'nobuffer', '-flags', 'low_delay');
        }
        args.push('-i', url, '-an', '-sn', '-dn');
        const filters = [`fps=${Math.max(0.2, Number(c.fps) || 5)}`];
        if (Number(c.width) > 0) {
            filters.push(`scale=${Number(c.width)}:-2`);
        }
        args.push('-vf', filters.join(','), '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', String(c.quality), 'pipe:1');

        this.log.debug(`${this.id}: starting ffmpeg for ${redact(url)}`);
        let proc;
        try {
            proc = this.spawnFn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            this._fail(`Cannot start ffmpeg: ${err.message}`);
            return;
        }
        this.proc = proc;
        let stderr = '';
        proc.stdout.on('data', chunk => this.splitter.push(chunk));
        proc.stderr.on('data', chunk => {
            stderr = (stderr + chunk.toString()).slice(-2000);
        });
        proc.on('error', err => {
            if (this.proc === proc) {
                this.proc = null;
                this._fail(
                    err.code === 'ENOENT' ? `ffmpeg not found (${this.ffmpegPath}). Install it: sudo apt install ffmpeg` : err.message,
                );
            }
        });
        proc.on('exit', (code, signal) => {
            if (this.proc !== proc) {
                return;
            }
            this.proc = null;
            const lastLine = stderr.trim().split('\n').pop() || '';
            this._fail(`ffmpeg ended (${signal || `code ${code}`})${lastLine ? `: ${lastLine.replace(/rtsp:\/\/[^@\s]+@/g, 'rtsp://***@')}` : ''}`);
        });
    }

    async _pollSnapshots(url) {
        const token = (this.pollToken = {});
        const interval = 1000 / Math.max(0.2, Number(this.cfg.fps) || 1);
        while (this.running && this.pollToken === token) {
            const t0 = Date.now();
            try {
                const res = await this.http.request(url);
                if (this.pollToken !== token) {
                    return;
                }
                if (res.status !== 200) {
                    throw new Error(res.status === 401 ? 'Login rejected (401): check user and password' : `HTTP ${res.status}`);
                }
                this.splitter.push(res.body);
            } catch (err) {
                if (this.pollToken === token) {
                    this.pollToken = null;
                    this._fail(err.message);
                }
                return;
            }
            await new Promise(r => setTimeout(r, Math.max(0, interval - (Date.now() - t0))));
        }
    }

    _disconnect() {
        this.pollToken = null;
        if (this.proc) {
            const proc = this.proc;
            this.proc = null;
            proc.kill('SIGKILL');
        }
    }

    _frame(frame) {
        this.latest = frame;
        this.latestAt = Date.now();
        this.frameCount++;
        if (this.error) {
            this.log.info(`${this.id}: receiving images again`);
            this.error = '';
        }
        this.backoff = MIN_BACKOFF;
        this._setOnline(true);
        this.emit('frame', frame);
    }

    _checkStall() {
        const now = Date.now();
        // Measured frame rate, once per second.
        this.fps = this.frameCount;
        this.frameCount = 0;
        if (!this.restartTimer && now - Math.max(this.latestAt, this.startedAt) > this.stallTimeout) {
            this._fail(`No image for ${Math.round(this.stallTimeout / 1000)} s`);
        }
        this._status();
    }

    _fail(message) {
        if (!this.running) {
            return;
        }
        this._disconnect();
        if (message !== this.error) {
            this.log.warn(`${this.id}: ${message} - reconnecting in ${Math.round(this.backoff / 1000)} s`);
        }
        this.error = message;
        this._setOnline(false);
        // ONVIF URIs may change (camera reconfigured); resolve again next time.
        this.resolved = null;
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this._connect();
        }, this.backoff);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    }

    _setOnline(online) {
        if (this.online !== online) {
            this.online = online;
            this._status();
        }
    }

    _status() {
        this.emit('status', { online: this.online, fps: this.fps, error: this.error, viewers: this.viewers });
    }
}

module.exports = { CameraSource, withCredentials, redact };
