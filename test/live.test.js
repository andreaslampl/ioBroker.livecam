'use strict';

// End-to-end with real ffmpeg: fake camera -> CameraSource -> CamServer -> MJPEG viewers.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CameraSource } = require('../lib/source');
const { CamServer } = require('../lib/server');
const { hasFfmpeg, startFakeCamera, readMjpeg, quietLog, until } = require('./helpers');

const skip = !hasFfmpeg();

async function setup(t, camCfg, { accessKey = '', stallTimeout = 3000 } = {}) {
    let camServer;
    const cam = await startFakeCamera();
    const source = new CameraSource({ id: 'door', name: 'Haustür', ...camCfg(cam) }, { log: quietLog, stallTimeout });
    const sources = new Map([['door', source]]);
    const server = new CamServer({ sources, accessKey, log: quietLog });
    camServer = server;
    const { port } = await server.listen(0, '127.0.0.1');
    t.after(async () => {
        source.destroy();
        await server.close();
        await cam.close();
    });
    return { cam, source, server: camServer, url: path => `http://127.0.0.1:${port}${path}` };
}

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('stream camera: shared connection, recovery after a stall, stop when nobody watches', { skip }, async t => {
    const { cam, source, url } = await setup(t, c => ({ type: 'stream', url: c.url('/video.mjpeg'), user: 'admin', password: 'secret', fps: 5, width: 160 }));

    // Two viewers share one camera connection.
    let a = 0;
    let b = 0;
    const v1 = readMjpeg(url('/cam/door.mjpeg'), () => a++);
    const v2 = readMjpeg(url('/cam/door.mjpeg'), () => b++);
    await until(() => a >= 5 && b >= 5);
    assert.equal(cam.streams, 1);
    assert.equal(source.viewers, 2);
    assert.equal(source.online, true);

    // Camera stops sending (connection stays open): watchdog must reconnect on its own.
    cam.stalled = true;
    await until(() => source.online === false);
    assert.match(source.error, /No image/);
    cam.stalled = false;
    const before = a;
    await until(() => a >= before + 5, 20000);
    assert.ok(cam.streams >= 2, 'reconnected');
    assert.equal(source.online, true);
    assert.equal(source.error, '');

    // Single image while the stream runs.
    const jpg = await get(url('/cam/door.jpg'));
    assert.equal(jpg.status, 200);
    assert.equal(jpg.headers['content-type'], 'image/jpeg');
    assert.equal(jpg.body[0], 0xff);

    v1.close();
    v2.close();
    await until(() => source.viewers === 0);
    assert.equal(source.running, true); // still running during the idle grace period
});

test('snapshot camera with digest login', { skip }, async t => {
    const { cam, source, url } = await setup(t, c => ({ type: 'snapshot', url: c.url('/snapshot.jpg'), user: 'admin', password: 'secret', fps: 4 }));
    let n = 0;
    const v = readMjpeg(url('/cam/door.mjpeg'), () => n++);
    t.after(() => v.close());
    await until(() => n >= 4);
    assert.equal(cam.unauthorized, 1);
    assert.equal(source.online, true);
});

test('wrong password is reported and retried, not fatal', { skip }, async t => {
    const { source } = await setup(t, c => ({ type: 'snapshot', url: c.url('/snapshot.jpg'), user: 'admin', password: 'nope', fps: 2 }));
    source.addViewer();
    await until(() => source.error);
    assert.match(source.error, /401/);
    assert.equal(source.online, false);
    assert.ok(source.restartTimer, 'retry scheduled');
    source.removeViewer();
});

test('missing ffmpeg gives a clear hint', async t => {
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const source = new CameraSource({ id: 'x', type: 'stream', url: cam.url('/video.mjpeg') }, { log: quietLog, ffmpegPath: '/nonexistent/ffmpeg' });
    t.after(() => source.destroy());
    source.addViewer();
    await until(() => source.error);
    assert.match(source.error, /ffmpeg not found.*apt install ffmpeg/);
});

test('access key and unknown camera', { skip }, async t => {
    const { url } = await setup(t, c => ({ type: 'snapshot', url: c.url('/snapshot.jpg'), user: 'admin', password: 'secret' }), { accessKey: 'abc' });
    assert.equal((await get(url('/cam/door.jpg'))).status, 403);
    assert.equal((await get(url('/cam/door.jpg?key=abc'))).status, 200);
    assert.equal((await get(url('/cam/garage.jpg?key=abc'))).status, 404);
    const index = await get(url('/?key=abc'));
    assert.match(index.body.toString(), /Haustür.*\/cam\/door\.mjpeg/);
});

test('a stuck viewer does not block others or fill the memory', { skip }, async t => {
    const { url, server } = await setup(t, c => ({ type: 'stream', url: c.url('/video.mjpeg'), user: 'admin', password: 'secret', fps: 10 }));
    // Stuck viewer: never reads from the socket.
    const stuck = http.get(url('/cam/door.mjpeg'), res => res.pause());
    stuck.on('error', () => {});
    t.after(() => stuck.destroy());
    let n = 0;
    const v = readMjpeg(url('/cam/door.mjpeg'), () => n++);
    t.after(() => v.close());
    await until(() => n >= 40, 30000);
    // Frames are skipped for the stuck viewer instead of queued: at most one frame waits per viewer.
    const maxQueued = Math.max(...[...server.clients].map(res => res.writableLength));
    assert.ok(maxQueued < 200 * 1024, `queued ${maxQueued} bytes`);
});
