'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

let cachedFrames = null;

/** A few real JPEG frames rendered by ffmpeg (test pattern). */
function testFrames(count = 10) {
    if (!cachedFrames) {
        const out = execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
            '-frames:v', String(count), '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
        ]);
        cachedFrames = [];
        let start = 0;
        for (;;) {
            const s = out.indexOf(Buffer.from([0xff, 0xd8]), start);
            if (s < 0) {
                break;
            }
            const e = out.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
            cachedFrames.push(out.subarray(s, e + 2));
            start = e + 2;
        }
    }
    return cachedFrames;
}

function hasFfmpeg() {
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Fake camera: /video.mjpeg (multipart MJPEG, can be stalled) and
 * /snapshot.jpg, both protected with HTTP Digest (MD5, qop=auth).
 */
async function startFakeCamera({ user = 'admin', password = 'secret', fps = 10 } = {}) {
    const frames = testFrames();
    const cam = { stalled: false, requests: 0, unauthorized: 0, streams: 0 };
    const realm = 'AXIS_TEST';
    const nonce = crypto.randomBytes(8).toString('hex');
    const md5 = s => crypto.createHash('md5').update(s).digest('hex');
    const authorized = req => {
        const h = req.headers.authorization || '';
        if (!h.startsWith('Digest ')) {
            return false;
        }
        const p = {};
        for (const m of h.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
            p[m[1]] = m[2] ?? m[3];
        }
        const ha1 = md5(`${user}:${realm}:${password}`);
        const ha2 = md5(`${req.method}:${p.uri}`);
        return p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) && p.nonce === nonce;
    };
    const server = http.createServer((req, res) => {
        cam.requests++;
        if (!authorized(req)) {
            cam.unauthorized++;
            res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth", algorithm=MD5` });
            res.end();
            return;
        }
        if (req.url.startsWith('/snapshot.jpg')) {
            if (cam.stalled) {
                res.writeHead(503);
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(frames[cam.requests % frames.length]);
            return;
        }
        if (req.url.startsWith('/video.mjpeg')) {
            cam.streams++;
            res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary' });
            let i = 0;
            const timer = setInterval(() => {
                if (cam.stalled) {
                    return; // connection stays open, but no more images
                }
                const f = frames[i++ % frames.length];
                res.write(`--myboundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`);
                res.write(f);
                res.write('\r\n');
            }, 1000 / fps);
            res.on('close', () => clearInterval(timer));
            return;
        }
        if (req.url.startsWith('/control/faststream.jpg')) {
            // like a Mobotix: boundary announced with its dashes, parts without Content-Length
            cam.streams++;
            res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=--myboundary' });
            let i = 0;
            const timer = setInterval(() => {
                if (!cam.stalled) {
                    res.write(Buffer.concat([Buffer.from('--myboundary\r\nContent-Type: image/jpeg\r\n\r\n'), frames[i++ % frames.length], Buffer.from('\r\n')]));
                }
            }, 1000 / 20);
            res.on('close', () => clearInterval(timer));
            return;
        }
        if (req.url.startsWith('/h264')) {
            res.writeHead(200, { 'Content-Type': 'video/H264' });
            res.write(Buffer.alloc(100));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    cam.port = server.address().port;
    cam.url = path => `http://127.0.0.1:${cam.port}${path}`;
    cam.close = () => {
        server.closeAllConnections();
        return new Promise(r => server.close(r));
    };
    return cam;
}

/** Read an MJPEG stream and call onFrame for each JPEG. */
function readMjpeg(url, onFrame) {
    const { JpegSplitter } = require('../lib/jpeg');
    const splitter = new JpegSplitter(onFrame);
    const req = http.get(url, res => {
        res.on('data', c => splitter.push(c));
    });
    req.on('error', () => {});
    return { close: () => req.destroy(), req };
}

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

const until = async (cond, ms = 15000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) {
            throw new Error('timeout waiting for condition');
        }
        await new Promise(r => setTimeout(r, 25));
    }
};

/**
 * Simulated Andreas L.-Arts VMS (API.md): /api/integration, /api/state, /api/cameras (GET/PUT), /api/events/external,
 * /api/stream (SSE: retry + one state per camera on connect, `vms.push(event, data)`), go2rtc MJPEG / frame with ?key=.
 */
async function startFakeVms({ key = 'alvms_test', rtsp = false } = {}) {
    const frames = testFrames();
    const vms = { requests: [], puts: [], external: [], ioSets: [], clients: new Set(), rtsp, connects: 0 };
    vms.io = {
        tuer_sprechstelle: { name: 'Türöffner', kind: 'output', on: false, door: true },
        handy_zuhause: { name: 'Handy zuhause', kind: 'virtual', on: false, door: false },
        klingel: { name: 'Klingeltaster', kind: 'input', on: false, door: false },
    };
    vms.cameras = [
        { id: 'haustuere', name: 'Haustüre', enabled: true, host: '192.168.1.120', record: { mode: 'ai' } },
        { id: 'einfahrt', name: 'Einfahrt', enabled: true, host: '192.168.1.121', record: { mode: 'motion' } },
    ];
    const state = id => ({ name: vms.cameras.find(c => c.id === id).name, enabled: true, online: true, recording: true, motion: false, objects: [] });
    const json = (res, code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        vms.requests.push(`${req.method} ${u.pathname}`);
        const auth = req.headers.authorization === `Bearer ${key}` || req.headers['x-api-key'] === key || u.searchParams.get('key') === key;
        if (u.pathname.startsWith('/go2rtc/')) {
            if (!auth) {
                res.writeHead(401);
                return res.end();
            }
            if (u.pathname.endsWith('stream.mjpeg')) {
                res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
                let i = 0;
                const timer = setInterval(() => {
                    const f = frames[i++ % frames.length];
                    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`);
                    res.write(f);
                    res.write('\r\n');
                }, 100);
                res.on('close', () => clearInterval(timer));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            return res.end(frames[0]);
        }
        if (!auth) {
            return json(res, 401, { error: 'unauthorized' });
        }
        const body = () => new Promise(r => {
            const c = [];
            req.on('data', d => c.push(d));
            req.on('end', () => r(c.length ? JSON.parse(Buffer.concat(c).toString()) : null));
        });
        if (u.pathname === '/api/integration') {
            return json(res, 200, {
                app: 'Andreas L.-Arts VMS',
                version: '0.1.0',
                rtsp: { enabled: vms.rtsp, port: 8554, username: 'alvms', password: 'p@ss/1' },
                cameras: vms.cameras.map(c => ({
                    id: c.id,
                    name: c.name,
                    enabled: c.enabled,
                    streams: { main: c.id, sub: `${c.id}_sub` },
                    mjpeg: { main: `/go2rtc/api/stream.mjpeg?src=${c.id}`, sub: `/go2rtc/api/stream.mjpeg?src=${c.id}_sub` },
                    snapshot: `/go2rtc/api/frame.jpeg?src=${c.id}`,
                    rtsp: { main: `/${c.id}`, sub: `/${c.id}_sub` },
                })),
                kinds: { person: 'Person', car: 'Auto' },
                features: { boxes: true },
                endpoints: { state: '/api/state', stream: '/api/stream', events: '/api/events', external: '/api/events/external' },
            });
        }
        if (u.pathname === '/api/cameras' && req.method === 'GET') {
            return json(res, 200, vms.cameras);
        }
        const cm = /^\/api\/cameras\/([^/]+)$/.exec(u.pathname);
        if (cm && req.method === 'PUT') {
            return body().then(b => {
                const cam = vms.cameras.find(c => c.id === decodeURIComponent(cm[1]));
                if (!cam) {
                    return json(res, 404, { error: 'not found' });
                }
                vms.puts.push({ id: cam.id, body: b });
                Object.assign(cam, b.enabled === undefined ? {} : { enabled: b.enabled }, b.record ? { record: { ...cam.record, ...b.record } } : {});
                json(res, 200, cam);
            });
        }
        if (u.pathname === '/api/io/state') {
            return json(res, 200, vms.io);
        }
        const io = /^\/api\/io\/channels\/([^/]+)\/set$/.exec(u.pathname);
        if (io && req.method === 'POST') {
            return body().then(b => {
                const ch = vms.io[decodeURIComponent(io[1])];
                if (!ch) {
                    return json(res, 404, { error: 'not found' });
                }
                vms.ioSets.push({ channel: io[1], ...b });
                if (b.action !== 'pulse') {
                    ch.on = b.action === 'on';
                }
                json(res, 200, { ok: true });
            });
        }
        if (u.pathname === '/api/events/external' && req.method === 'POST') {
            return body().then(b => {
                vms.external.push(b);
                json(res, 200, { ok: true, id: 100 + vms.external.length });
            });
        }
        if (u.pathname === '/api/stream') {
            vms.connects++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('retry: 3000\n\n: hallo\n\n');
            for (const c of vms.cameras) {
                res.write(`event: state\ndata: ${JSON.stringify({ camera: c.id, ...state(c.id) })}\n\n`);
            }
            vms.clients.add(res);
            res.on('close', () => vms.clients.delete(res));
            return;
        }
        json(res, 404, { error: 'not found' });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    vms.port = server.address().port;
    vms.url = `http://127.0.0.1:${vms.port}`;
    vms.key = key;
    vms.push = (event, data) => {
        for (const c of vms.clients) {
            c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };
    vms.dropStreams = () => {
        for (const c of vms.clients) {
            c.destroy();
        }
    };
    vms.close = () => {
        server.closeAllConnections();
        return new Promise(r => server.close(r));
    };
    return vms;
}

module.exports = { testFrames, hasFfmpeg, startFakeCamera, startFakeVms, readMjpeg, quietLog, until };
