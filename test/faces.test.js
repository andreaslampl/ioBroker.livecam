'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { similarity, warp, decodeYunet, bestMatch, cosine, FaceStore, FaceReader, DST } = require('../lib/faces');
const { Detector } = require('../lib/detect');
const { hasFfmpeg, startFakeCamera, until } = require('./helpers');

test('faces: alignment transform, warp, YuNet decoding, best match', () => {
    // landmarks = DST scaled by 2, rotated 90°, shifted -> transform maps them back onto DST
    const src = DST.map(([x, y]) => [200 - 2 * y, 50 + 2 * x]);
    const t = similarity(src, DST);
    for (let i = 0; i < 5; i++) {
        const [x, y] = src[i];
        assert.ok(Math.abs(t[0] * x - t[1] * y + t[2] - DST[i][0]) < 1e-6);
        assert.ok(Math.abs(t[1] * x + t[0] * y + t[3] - DST[i][1]) < 1e-6);
    }
    // warp of a 2 x 2 picture with the identity: same pixels
    const rgb = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    assert.deepEqual(Array.from(warp(rgb, 2, 2, [1, 0, 0, 0], 2)), Array.from(rgb));
    // one face in cell (10, 5) of the stride-8 head
    const n = s => (640 / s) ** 2;
    const out = {};
    for (const s of [8, 16, 32]) {
        out[`cls_${s}`] = new Float32Array(n(s));
        out[`obj_${s}`] = new Float32Array(n(s));
        out[`bbox_${s}`] = new Float32Array(n(s) * 4);
        out[`kps_${s}`] = new Float32Array(n(s) * 10);
    }
    const i = 5 * 80 + 10;
    out.cls_8[i] = 0.9;
    out.obj_8[i] = 0.9;
    out.bbox_8.set([0.5, 0.5, Math.log(4), Math.log(5)], i * 4);
    const f = decodeYunet(out);
    assert.equal(f.length, 1);
    assert.ok(Math.abs(f[0].score - 0.9) < 1e-6);
    [f[0].x, f[0].y, f[0].w, f[0].h].forEach((v, k) => assert.ok(Math.abs(v - [68, 24, 32, 40][k]) < 1e-4));
    // match: best sample of any person
    const persons = [{ id: 'a', name: 'Anna', embeds: [[1, 0, 0], [0.9, 0.1, 0]] }, { id: 'b', name: 'Bert', embeds: [[0, 1, 0]] }];
    assert.equal(bestMatch([1, 0.05, 0], persons).name, 'Anna');
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

test('faces: store - people, samples (max 20), photos, delete removes the files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-'));
    const s = new FaceStore(dir);
    const p = s.add('Anna', true);
    assert.throws(() => s.add('  '), /Name fehlt/);
    const sid = s.addSample(p.id, new Float32Array([0.1, 0.2]), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.ok(s.photo(p.id, sid));
    assert.equal(s.photo('../etc', sid), null);
    assert.deepEqual(new FaceStore(dir).list(), [{ id: p.id, name: 'Anna', door: true, samples: [sid] }], 'saved to faces.json');
    s.update(p.id, { name: 'Anna M.', door: false });
    assert.equal(s.get(p.id).door, false);
    s.removeSample(p.id, sid);
    assert.equal(s.photo(p.id, sid), null);
    for (let i = 0; i < 20; i++) {
        s.addSample(p.id, [i], null);
    }
    assert.throws(() => s.addSample(p.id, [1], null), /Höchstens 20/);
    s.remove(p.id);
    assert.equal(fs.existsSync(path.join(dir, p.id)), false);
    assert.deepEqual(s.list(), []);
});

test('faces: real models load and find no face on a grey picture', { skip: !hasFfmpeg() }, async () => {
    const log = { info() {}, warn() {}, debug() {} };
    const r = new FaceReader({ detector: new Detector({ log }), log });
    const jpeg = require('node:child_process').execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1']);
    assert.deepEqual(await r.read(jpeg, { w: 320, h: 240 }, null), []);
    assert.ok(r.liveA && r.liveB, 'liveness models present');
});

// ---------------- adapter: page/API with key, session with a fake reader ----------------

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.logs = [];
        this.log = { debug() {}, info: m => this.logs.push(m), warn: m => this.logs.push(`WARN ${m}`), error: m => this.logs.push(`ERR ${m}`) };
    }
    async setState(id, val, ack) {
        this.states[id] = { val, ack };
    }
    async getStateAsync(id) {
        return this.states[id] || null;
    }
    subscribeStates() {}
    async extendObject(id, obj) {
        this.objects[id] = obj;
    }
    async getChannelsOfAsync() {
        return [];
    }
    async getObjectViewAsync() {
        return { rows: Object.keys(this.objects).filter(k => /^faces\.[^.]+$/.test(k)).map(k => ({ id: `${this.namespace}.${k}` })) };
    }
    async delObjectAsync(id) {
        for (const k of Object.keys(this.objects)) {
            if (k === id || k.startsWith(`${id}.`)) {
                delete this.objects[k];
            }
        }
    }
}

test('adapter: /faces needs the key, people via the API, door release only alive and twice', { skip: !hasFfmpeg() }, async t => {
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
        return request === '@iobroker/adapter-core' ? { Adapter: FakeAdapter } : origLoad.call(this, request, ...rest);
    };
    t.after(() => (Module._load = origLoad));
    delete require.cache[require.resolve('../main.js')];
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const port = 40000 + Math.floor(Math.random() * 10000);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-faces-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const adapter = require('../main.js')({
        config: {
            port,
            publicHost: '127.0.0.1',
            accessKey: 'geheim',
            cameras: [{ enabled: true, name: 'Haustür', type: 'snapshot', url: cam.url('/snapshot.jpg'), user: 'admin', password: 'secret', fps: 4, detect: 'person', faces: true }],
        },
    });
    adapter.dataDir = dataDir;
    adapter.faceEvery = 20;
    adapter.faceLearnMs = 300;
    adapter.faceLearnGap = 10;
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true, 30000);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.ok(adapter.faceReader, 'face recognition started');

    const req = (method, p, body, key = 'geheim') =>
        new Promise((resolve, reject) => {
            const r = http.request(`http://127.0.0.1:${port}${p}${p.includes('?') ? '&' : '?'}key=${key}`, { method }, res => {
                const c = [];
                res.on('data', d => c.push(d));
                res.on('end', () => {
                    const text = Buffer.concat(c).toString();
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        // page
                    }
                    resolve({ status: res.statusCode, json, text });
                });
            });
            r.on('error', reject);
            r.end(body);
        });
    assert.equal((await req('GET', '/faces/data', null, 'falsch')).status, 403);
    assert.match((await req('GET', '/faces')).text, /Person anlegen/);
    const { id } = (await req('POST', '/faces/person', JSON.stringify({ name: 'Anna', door: true }))).json;
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.ok(adapter.objects['faces.anna.present'], 'person data points');

    // fake reader: the camera "sees" Anna (alive) - embeddings decide
    const anna = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i));
    const stranger = Float32Array.from({ length: 128 }, (_, i) => Math.cos(i * 3));
    let seen = { embed: anna, live: 0.95 };
    adapter.faceReader.read = async () => [{ box: {}, size: 120, score: 0.9, embed: seen.embed, live: seen.live, face: new Uint8Array(112 * 112 * 3), cx: 0.65, cy: 0.3 }];
    const photo = await req('POST', `/faces/person/${id}/photo`, require('./helpers').testFrames()[0]);
    assert.equal(photo.status, 200, photo.text);
    assert.equal(adapter.faceStore.get(id).samples.length, 1);
    const learn = await req('POST', `/faces/person/${id}/learn`, JSON.stringify({ camera: 'haustuer' }));
    assert.equal(learn.json.added, 0, 'same view again: nothing new');
    assert.match(learn.json.hint, /keine neuen Ansichten/);

    // a person in the picture -> session
    const w = adapter.watchers.get('haustuer');
    const camCfg = adapter.faceCams.get('haustuer');
    const person = on => {
        w.state.person = { on, count: on ? 1 : 0, last: Date.now() };
        return adapter.onDetectState(camCfg, { group: 'person', on, count: on ? 1 : 0, label: 'Person', score: 0.9 });
    };
    // two people in the picture: the name goes onto the box with the face
    w.lastBoxes = JSON.stringify([
        { g: 'person', l: 'Person', s: 90, x: 0.1, y: 0.2, w: 0.1, h: 0.5 },
        { g: 'person', l: 'Person', s: 88, x: 0.6, y: 0.2, w: 0.1, h: 0.5 },
    ]);
    await person(true);
    await until(() => s['cameras.haustuer.detect.faceDoor'] && s['cameras.haustuer.detect.faceDoor'].val === true);
    assert.deepEqual(JSON.parse(s['cameras.haustuer.detect.boxes'].val).map(b => b.l), ['Person', 'Anna']);
    w.emit('boxes', JSON.stringify([{ g: 'person', l: 'Person', s: 91, x: 0.62, y: 0.21, w: 0.1, h: 0.5 }]));
    await until(() => JSON.parse(s['cameras.haustuer.detect.boxes'].val)[0].l === 'Anna');
    assert.equal(s['cameras.haustuer.detect.face'].val, 'Anna');
    assert.equal(s['cameras.haustuer.detect.faceKnown'].val, true);
    assert.equal(s['faces.anna.present'].val, true);
    await person(false);
    assert.equal(s['cameras.haustuer.detect.faceDoor'].val, false);
    assert.equal(s['faces.anna.present'].val, false);

    // a photo of Anna (liveness fails): no door, warning
    seen = { embed: anna, live: 0.1 };
    await person(true);
    await until(() => adapter.logs.some(l => /Lebenderkennung ist nicht bestanden/.test(l)));
    await until(() => !adapter.faceRuns.get('haustuer'));
    assert.equal(s['cameras.haustuer.detect.faceDoor'].val, false);
    assert.equal(s['cameras.haustuer.detect.faceKnown'].val, false);
    await person(false);

    // a stranger: nothing stored, nothing named
    seen = { embed: stranger, live: 0.99 };
    await person(true);
    await until(() => !adapter.faceRuns.get('haustuer'));
    assert.equal(s['cameras.haustuer.detect.faceKnown'].val, false);
    assert.equal(adapter.faceStore.persons.length, 1);
    await person(false);

    // delete: data points gone
    await req('DELETE', `/faces/person/${id}`);
    await until(() => !adapter.objects['faces.anna']);
    assert.ok(!adapter.logs.filter(l => /Gesicht/.test(l)).join('\n').includes('geheim'), 'key not in the face log lines');
    assert.match(s['info.facesUrl'].val, /\/faces\?key=geheim$/);
});

test('server: key asked once on a login page, remembered as cookie; pictures without key refused', async t => {
    const { CamServer } = require('../lib/server');
    const log = { info() {}, warn() {}, debug() {}, error() {} };
    const srv = new CamServer({ sources: new Map(), accessKey: 'geheim', log, zones: { cameras: () => [{ id: 'a' }], save: async () => [] }, faces: { enabled: () => true, list: () => [], cameras: () => [] } });
    const port = 40000 + Math.floor(Math.random() * 10000);
    await srv.listen(port);
    t.after(() => srv.close());
    const get = (p, headers = {}, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers, redirect: 'manual', ...opts });
    let r = await get('/faces');
    assert.equal(r.status, 401);
    assert.match(await r.text(), /Zugriffsschlüssel/);
    assert.equal((await get('/cam/x.jpg')).status, 403);
    const form = (key, next) => ({ method: 'POST', body: new URLSearchParams({ key, next }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    r = await fetch(`http://127.0.0.1:${port}/login`, { ...form('falsch', '/faces'), redirect: 'manual' });
    assert.equal(r.status, 403);
    r = await fetch(`http://127.0.0.1:${port}/login`, { ...form('geheim', 'https://evil.example/'), redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/', 'no redirect to other sites');
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^lc_auth=[0-9a-f]{32}$/);
    assert.ok(!cookie.includes('geheim'), 'the key itself is not in the cookie');
    r = await get('/faces/data', { cookie });
    assert.equal(r.status, 200);
    r = await get('/', { cookie });
    assert.match(await r.text(), /href="\/faces">Gesichter einlernen/);
    // a link with ?key= sets the cookie as well
    r = await get('/zones?key=geheim');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /^lc_auth=/);
    // 5 wrong keys: pause
    for (let i = 0; i < 5; i++) {
        await fetch(`http://127.0.0.1:${port}/login`, { ...form('x', '/'), redirect: 'manual' });
    }
    r = await fetch(`http://127.0.0.1:${port}/login`, { ...form('geheim', '/'), redirect: 'manual' });
    assert.match(await r.text(), /Zu viele Versuche/);
});
