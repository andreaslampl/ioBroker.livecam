'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CameraSource } = require('../lib/source');
const { startFakeCamera, quietLog, until } = require('./helpers');

function source(cam, path, extra = {}) {
    const spawned = [];
    const src = new CameraSource(
        { id: 'mobotix', type: 'stream', url: cam.url(path), user: 'admin', password: 'secret', fps: 5, ...extra },
        { log: quietLog, spawnFn: (...a) => (spawned.push(a), require('node:child_process').spawn(...a)) },
    );
    return { src, spawned };
}

test('HTTP MJPEG (Mobotix faststream) is read directly, with Digest login, limited to fps, no ffmpeg', async t => {
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const { src, spawned } = source(cam, '/control/faststream.jpg?stream=full');
    t.after(() => src.destroy());
    const frames = [];
    src.on('frame', f => frames.push(f));
    src.addViewer();
    await until(() => frames.length >= 6, 8000);
    assert.equal(spawned.length, 0, 'no ffmpeg for HTTP MJPEG');
    for (const f of frames) {
        assert.equal(f[0], 0xff);
        assert.equal(f[1], 0xd8);
        assert.equal(f[f.length - 2], 0xff);
        assert.equal(f[f.length - 1], 0xd9);
    }
    // the camera sends 20/s, we pass at most ~5/s
    const n = frames.length;
    await new Promise(r => setTimeout(r, 2000));
    assert.ok(frames.length - n <= 12, `${frames.length - n} frames in 2 s`);
    assert.equal(cam.streams, 1);
    src.removeViewer();
});

test('wrong password on an MJPEG stream is reported as 401', async t => {
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const { src } = source(cam, '/control/faststream.jpg?stream=full', { password: 'falsch' });
    t.after(() => src.destroy());
    const status = [];
    src.on('status', s => status.push(s));
    src.addViewer();
    await until(() => status.some(s => /401/.test(s.error || '')), 5000);
});

test('an HTTP URL with a single image is polled, other content goes to ffmpeg', async t => {
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const single = source(cam, '/snapshot.jpg');
    t.after(() => single.src.destroy());
    const frames = [];
    single.src.on('frame', f => frames.push(f));
    single.src.addViewer();
    await until(() => frames.length >= 2, 8000);
    assert.equal(single.spawned.length, 0);

    const other = source(cam, '/h264');
    t.after(() => other.src.destroy());
    other.src.addViewer();
    await until(() => other.spawned.length === 1, 5000);
    assert.match(other.spawned[0][1].join(' '), /-i http:\/\/admin:secret@127\.0\.0\.1:\d+\/h264/);
});
