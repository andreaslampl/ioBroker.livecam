'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { JpegSplitter } = require('../lib/jpeg');
const { HttpClient } = require('../lib/http-client');
const { withCredentials, redact } = require('../lib/source');
const { cameraId, completeUrl, validHost } = require('../lib/util');
const { testFrames, hasFfmpeg, startFakeCamera } = require('./helpers');

test('JPEG splitter handles multipart headers, garbage and split markers', { skip: !hasFfmpeg() }, () => {
    const frames = testFrames().slice(0, 3);
    const stream = Buffer.concat([
        Buffer.from('garbage\xff'),
        ...frames.flatMap(f => [Buffer.from(`--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`), f, Buffer.from('\r\n')]),
    ]);
    for (const size of [1, 2, 7, 1000, stream.length]) {
        const out = [];
        const s = new JpegSplitter(f => out.push(f));
        for (let i = 0; i < stream.length; i += size) {
            s.push(stream.subarray(i, i + size));
        }
        assert.equal(out.length, 3, `chunk size ${size}`);
        out.forEach((f, i) => assert.ok(f.equals(frames[i])));
    }
});

test('credentials are added to stream URLs and hidden in logs', () => {
    assert.equal(withCredentials('rtsp://10.0.0.5:554/axis-media/media.amp', 'root', 'p@ss'), 'rtsp://root:p%40ss@10.0.0.5:554/axis-media/media.amp');
    assert.equal(withCredentials('rtsp://u:x@cam/s', 'root', 'p'), 'rtsp://u:x@cam/s');
    assert.equal(redact('rtsp://root:secret@10.0.0.5/s'), 'rtsp://***@10.0.0.5/s');
});

test('camera ids', () => {
    assert.equal(cameraId('Haustür Nord', 0), 'haustuer_nord');
    assert.equal(cameraId('', 2), 'cam3');
    assert.equal(cameraId('2N IP Verso!', 0), '2n_ip_verso');
});

test('HTTP digest login and reuse of the challenge', { skip: !hasFfmpeg() }, async t => {
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const client = new HttpClient({ user: 'admin', password: 'secret' });
    for (let i = 0; i < 5; i++) {
        const res = await client.request(cam.url('/snapshot.jpg'));
        assert.equal(res.status, 200);
        assert.equal(res.body[0], 0xff);
    }
    assert.equal(cam.unauthorized, 1); // only the very first request is challenged
    const wrong = await new HttpClient({ user: 'admin', password: 'nope' }).request(cam.url('/snapshot.jpg'));
    assert.equal(wrong.status, 401);
});

test('HTTP basic login', async t => {
    const server = http.createServer((req, res) => {
        if (req.headers.authorization === `Basic ${Buffer.from('u:p').toString('base64')}`) {
            res.end('ok');
        } else {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
            res.end();
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const res = await new HttpClient({ user: 'u', password: 'p' }).request(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.body.toString(), 'ok');
});

test('camera URLs are completed and IPs checked', () => {
    assert.equal(completeUrl('stream', '/axis-media/media.amp', '192.168.1.50'), 'rtsp://192.168.1.50/axis-media/media.amp');
    assert.equal(completeUrl('snapshot', '/axis-cgi/jpg/image.cgi', '192.168.1.50'), 'http://192.168.1.50/axis-cgi/jpg/image.cgi');
    assert.equal(completeUrl('stream', '192.168.1.50/axis-media/media.amp', ''), 'rtsp://192.168.1.50/axis-media/media.amp');
    assert.equal(completeUrl('stream', 'rtsp://cam/x', '1.2.3.4'), 'rtsp://cam/x');
    assert.equal(completeUrl('stream', '/x', ''), '/x');
    assert.equal(completeUrl('snapshot', '/axis-cgi/jpg/image.cgi', '192.168.1.50:443'), 'https://192.168.1.50:443/axis-cgi/jpg/image.cgi');
    assert.equal(validHost('192.168.1.50'), true);
    assert.equal(validHost('17210.10.5'), false);
    assert.equal(validHost('192.168.1.256'), false);
    assert.equal(validHost('axis-haustuer.local'), true);
    assert.equal(validHost('192.168.1.50:554'), true);
    assert.equal(validHost('192.168.1.50:99999'), false);
    assert.equal(completeUrl('stream', '/axis-media/media.amp', '192.168.1.50:554'), 'rtsp://192.168.1.50:554/axis-media/media.amp');
});

test('ring tones: every melody has notes', () => {
    const { toneEngine, TONE_LABELS } = require('../lib/tones');
    global.addEventListener = () => {};
    const { TONES } = toneEngine();
    delete global.addEventListener;
    for (const [name, t] of Object.entries(TONES)) {
        assert.ok(t.notes.length > 1 && t.every > 1000, name);
        assert.ok(TONE_LABELS[name], name);
    }
    assert.equal(Math.round(TONES.elise.notes[0][0]), 659); // E5
});
