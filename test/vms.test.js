'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { hasFfmpeg, startFakeVms, until } = require('./helpers');
const { VmsClient, normalizeBase, liveTarget } = require('../lib/vms');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.logs = [];
        this.sent = [];
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
    async delObjectAsync(id) {
        delete this.objects[id];
    }
    sendTo(to, cmd, msg) {
        this.sent.push({ to, cmd, msg });
    }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter };
    }
    return origLoad.call(this, request, ...rest);
};

const get = url =>
    new Promise((resolve, reject) => {
        http.get(url, res => {
            const c = [];
            res.on('data', d => c.push(d));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) }));
        }).on('error', reject);
    });

test('vms: address, RTSP through the VMS (credentials encoded) or MJPEG with the key', () => {
    assert.equal(normalizeBase('192.168.1.10:8080/'), 'http://192.168.1.10:8080');
    assert.equal(normalizeBase(''), '');
    const cam = { id: 'haustuere', mjpeg: { sub: '/go2rtc/api/stream.mjpeg?src=haustuere_sub' }, rtsp: { sub: '/haustuere_sub' } };
    const on = { rtsp: { enabled: true, port: 8554, username: 'alvms', password: 'p@ss/1' } };
    assert.deepEqual(liveTarget('http://192.168.1.10:8080', 'alvms_x', on, cam), { mode: 'stream', url: 'rtsp://alvms:p%40ss%2F1@192.168.1.10:8554/haustuere_sub' });
    assert.deepEqual(liveTarget('http://192.168.1.10:8080', 'alvms_x', { rtsp: { enabled: false } }, cam), {
        mode: 'http',
        url: 'http://192.168.1.10:8080/go2rtc/api/stream.mjpeg?src=haustuere_sub&key=alvms_x',
    });
});

test('vms: live channel (SSE) with reconnect and a wrong key', { skip: !hasFfmpeg() }, async t => {
    const vms = await startFakeVms();
    t.after(() => vms.close());
    const log = { info() {}, warn() {}, debug() {} };
    const c = new VmsClient({ base: vms.url, key: vms.key, log });
    const got = [];
    const conn = [];
    c.on('message', (ev, d) => got.push(`${ev}:${d.camera}`));
    c.on('connection', on => conn.push(on));
    c.start();
    t.after(() => c.stop());
    await until(() => got.length === 2);
    assert.deepEqual(got, ['state:haustuere', 'state:einfahrt']);
    vms.push('event', { id: 1, camera: 'einfahrt', kind: 'person' });
    await until(() => got.length === 3);
    // VMS drops the connection: reconnect after the announced retry (3 s)
    c.backoff = 100;
    vms.dropStreams();
    await until(() => vms.connects === 2, 8000);
    assert.deepEqual(conn.slice(0, 3), [true, false, true]);

    const bad = new VmsClient({ base: vms.url, key: 'alvms_falsch', log });
    const why = [];
    bad.on('connection', (on, w) => !on && why.push(w));
    bad._setConnected(true); // so the failure is reported
    bad.start();
    await until(() => why.length >= 1);
    bad.stop();
    assert.match(why[0], /401/);
    await assert.rejects(bad.integration(true), /401 API-Schlüssel/);
});

test('adapter: VMS cameras, data points, switches and ring; key never logged', { skip: !hasFfmpeg() }, async t => {
    const vms = await startFakeVms({ rtsp: false });
    t.after(() => vms.close());
    const port = 40000 + Math.floor(Math.random() * 10000);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-vms-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const adapter = require('../main.js')({
        config: {
            port,
            publicHost: '127.0.0.1',
            cameras: [{ enabled: true, name: 'Eingang', type: 'vms', vmsCamera: 'haustuere', fps: 5, width: 0 }],
            vmsUrl: vms.url,
            vmsKey: vms.key,
            vmsImport: true,
            vmsEvents: true,
            vmsRing: true,
            intercomEnabled: true,
            sipPort: 30000 + Math.floor(Math.random() * 10000),
            intercomHost: '192.168.1.120',
            intercomCamera: 'Eingang',
            doorMethod: 'none',
        },
    });
    adapter.dataDir = dataDir;
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));

    // table camera + the other one taken over automatically
    assert.ok(adapter.objects['cameras.eingang']);
    assert.ok(adapter.objects['cameras.einfahrt'], 'taken over from the VMS');
    assert.equal(adapter.objects['cameras.haustuere'], undefined, 'already in the table as "Eingang"');
    const img = await get(`http://127.0.0.1:${port}/cam/einfahrt.jpg`);
    assert.equal(img.status, 200);
    assert.equal(img.body[0], 0xff, 'MJPEG of the VMS');

    // live channel -> data points
    await until(() => s['vms.connection'] && s['vms.connection'].val === true);
    await until(() => s['vms.cameras.einfahrt.recordMode'] && s['vms.cameras.einfahrt.recordMode'].val === 'motion');
    assert.equal(s['vms.cameras.einfahrt.online'].val, true);
    vms.push('state', { camera: 'einfahrt', name: 'Einfahrt', enabled: true, online: true, recording: true, motion: true, objects: ['person', 'car'] });
    await until(() => s['vms.cameras.einfahrt.person'].val === true);
    assert.equal(s['vms.cameras.einfahrt.car'].val, true);
    assert.equal(s['vms.cameras.einfahrt.truck'].val, false);
    assert.equal(s['vms.cameras.einfahrt.motion'].val, true);
    // event with an unknown plate: no plate text in ioBroker
    vms.push('event', { id: 7, camera: 'einfahrt', camera_name: 'Einfahrt', kind: 'car', name: 'Auto', score: 0.9, start: 1794929811.2, end: null, plate: 'W12345X', plate_name: null, plate_kind: null, image: '/api/push/img/7?s=abc', playback: '/#/rec/einfahrt/2026-11-17/1794929811' });
    await until(() => s['vms.cameras.einfahrt.lastEventKind'] && s['vms.cameras.einfahrt.lastEventKind'].val === 'car');
    assert.equal(s['vms.cameras.einfahrt.lastEventImage'].val, `${vms.url}/api/push/img/7?s=abc`);
    assert.equal(s['vms.cameras.einfahrt.lastEventTime'].val, new Date(1794929811200).toISOString());
    assert.equal(s['vms.cameras.einfahrt.lastPlate'].val, '');
    assert.equal(s['vms.cameras.einfahrt.lastPlateKind'].val, 'unknown');
    assert.doesNotMatch(s['vms.cameras.einfahrt.lastEvent'].val, /W12345X/);
    assert.equal(JSON.parse(s['vms.lastEvent'].val).playback, `${vms.url}/#/rec/einfahrt/2026-11-17/1794929811`);
    // own car: plate with name
    vms.push('plate', { id: 8, camera: 'einfahrt', plate: 'GU123AB', plate_name: 'Eigenes Auto', plate_kind: 'known' });
    await until(() => s['vms.cameras.einfahrt.lastPlate'].val === 'GU123AB');
    assert.equal(s['vms.cameras.einfahrt.lastPlateName'].val, 'Eigenes Auto');
    assert.equal(s['vms.cameras.einfahrt.lastPlateKind'].val, 'known');

    // switches -> PUT /api/cameras/<id>
    await adapter.onStateChange(`${adapter.namespace}.vms.cameras.einfahrt.recordMode`, { val: 'continuous', ack: false });
    await adapter.onStateChange(`${adapter.namespace}.vms.cameras.haustuere.enabled`, { val: false, ack: false });
    await adapter.onStateChange(`${adapter.namespace}.vms.cameras.einfahrt.recordMode`, { val: 'immer', ack: false });
    assert.deepEqual(vms.puts, [
        { id: 'einfahrt', body: { record: { mode: 'continuous' } } },
        { id: 'haustuere', body: { enabled: false } },
    ]);
    assert.deepEqual(s['vms.cameras.einfahrt.recordMode'], { val: 'continuous', ack: true });
    assert.deepEqual(s['vms.cameras.haustuere.enabled'], { val: false, ack: true });

    // the 2N rings -> event in the VMS on the camera behind the intercom camera
    adapter.intercom.emit('ring', { camera: 'eingang' });
    await until(() => vms.external.length === 1);
    assert.deepEqual(vms.external[0], { camera: 'haustuere', label: 'ring', duration: 60 });

    // admin list
    await adapter.onMessage({ command: 'vmsCameras', from: 'admin', callback: {} });
    assert.deepEqual(adapter.sent[0].msg.map(x => x.value), ['haustuere', 'einfahrt']);

    // VMS gone: livecam keeps running, connection false
    vms.dropStreams();
    await until(() => s['vms.connection'].val === false);
    assert.equal(s['info.connection'].val, true);
    assert.doesNotMatch(adapter.logs.join('\n'), new RegExp(vms.key));
});

test('adapter: VMS not reachable at start -> cameras from the last list, livecam runs', async t => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-vms-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, 'vms-cameras.json'), JSON.stringify([{ id: 'garten', name: 'Garten', enabled: true }]));
    const adapter = require('../main.js')({
        config: { port, publicHost: '127.0.0.1', cameras: [], vmsUrl: 'http://127.0.0.1:1', vmsKey: 'alvms_x', vmsImport: true, vmsEvents: true },
    });
    adapter.dataDir = dataDir;
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.ok(adapter.objects['cameras.garten']);
    assert.equal(s['vms.connection'].val, false);
    assert.match(adapter.logs.join('\n'), /beim Start nicht erreichbar/);
});

test('adapter: without a VMS nothing of it is created', async t => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    const adapter = require('../main.js')({ config: { port, publicHost: '127.0.0.1', cameras: [{ enabled: true, name: 'Carport', type: 'stream', url: 'rtsp://192.168.1.111/x' }] } });
    adapter.emit('ready');
    await until(() => adapter.states['info.connection'] && adapter.states['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.deepEqual(Object.keys(adapter.objects).filter(k => k.startsWith('vms')), []);
    assert.equal(adapter.vms, null);
});
