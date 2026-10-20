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

module.exports = { testFrames, hasFfmpeg, startFakeCamera, readMjpeg, quietLog, until };
