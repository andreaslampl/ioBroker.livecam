'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { hasFfmpeg, startFakeCamera, until } = require('./helpers');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.objects = { 'cameras.old_cam': { type: 'channel' } };
        this.deleted = [];
        this.errors = [];
        this.log = { debug() {}, info() {}, warn() {}, error: m => this.errors.push(m) };
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
        return Object.keys(this.objects)
            .filter(id => /^cameras\.[^.]+$/.test(id) && this.objects[id].type === 'channel')
            .map(id => ({ _id: `${this.namespace}.${id}` }));
    }
    async delObjectAsync(id) {
        this.deleted.push(id);
        delete this.objects[id];
    }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter };
    }
    return origLoad.call(this, request, ...rest);
};

test('adapter: objects, URLs, live image and cleanup', { skip: !hasFfmpeg() }, async t => {
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const port = 40000 + Math.floor(Math.random() * 10000);
    const adapter = require('../main.js')({
        config: {
            port,
            publicHost: '127.0.0.1',
            accessKey: '',
            cameras: [
                { enabled: true, name: 'Haustür', type: 'snapshot', url: cam.url('/snapshot.jpg'), user: 'admin', password: 'secret', fps: 4 },
                { enabled: false, name: 'Garage', type: 'stream', url: 'rtsp://x/y' },
                { enabled: true, name: 'Ohne URL', type: 'stream', url: '' },
                { enabled: true, name: 'Tippfehler', type: 'stream', host: '17210.10.5', url: '/axis-media/media.amp' },
                { enabled: true, name: 'Nur Pfad', type: 'stream', url: '/axis-media/media.amp' },
                { enabled: true, name: 'IP egal', type: 'stream', host: '17210.10.1', url: 'rtsp://127.0.0.1/axis-media/media.amp' },
            ],
        },
    });
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));

    assert.equal(s['cameras.haustuer.mjpegUrl'].val, `http://127.0.0.1:${port}/cam/haustuer.mjpeg`);
    assert.equal(adapter.objects['cameras.haustuer'].common.name, 'Haustür');
    assert.equal(adapter.objects['cameras.garage'], undefined);
    assert.match(adapter.errors.join('\n'), /Ohne URL.*no URL/);
    assert.match(adapter.errors.join('\n'), /Tippfehler.*17210\.10\.5.*looks wrong/);
    assert.match(adapter.errors.join('\n'), /Nur Pfad.*only a path/);
    // A wrong but unused IP field does not block a camera with a full URL.
    assert.doesNotMatch(adapter.errors.join('\n'), /IP egal/);
    assert.ok(adapter.objects['cameras.ip_egal']);
    assert.deepEqual(adapter.deleted, ['cameras.old_cam']);

    const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/cam/haustuer.jpg`, res => {
            const c = [];
            res.on('data', d => c.push(d));
            res.on('end', () => resolve(Buffer.concat(c)));
        }).on('error', reject);
    });
    assert.equal(body[0], 0xff);
    await until(() => s['cameras.haustuer.online'] && s['cameras.haustuer.online'].val === true);
});

test('adapter: missed call with photo in the history', { skip: !hasFfmpeg() }, async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const cam = await startFakeCamera();
    t.after(() => cam.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livecam-adapter-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const port = 40000 + Math.floor(Math.random() * 10000);
    const adapter = require('../main.js')({
        config: {
            port,
            publicHost: '127.0.0.1',
            cameras: [{ enabled: true, name: 'Haustür', type: 'snapshot', url: cam.url('/snapshot.jpg'), user: 'admin', password: 'secret', fps: 4 }],
            intercomEnabled: true,
            sipPort: 30000 + Math.floor(Math.random() * 10000),
            intercomHost: '127.0.0.1',
            intercomCamera: 'Haustür',
            doorMethod: 'none',
        },
    });
    adapter.dataDir = dataDir;
    adapter.subscribeStates = () => {};
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.equal(s['intercom.missedCount'].val, 0);

    adapter.intercom.emit('ring', { caller: 'Haustuer' });
    adapter.intercom.emit('callEnd', { caller: 'Haustuer', time: new Date().toISOString(), result: 'missed', duration: 0 });
    await until(() => s['intercom.missedCount'].val === 1);
    const history = JSON.parse(s['intercom.history'].val);
    assert.equal(history[0].result, 'missed');
    assert.equal(history[0].image, true);
    const res = await new Promise((resolve, reject) =>
        http.get(`http://127.0.0.1:${port}/history/${history[0].id}.jpg`, r => {
            const c = [];
            r.on('data', d => c.push(d));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c) }));
        }).on('error', reject),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body[0], 0xff);

    await adapter.onStateChange(`${adapter.namespace}.intercom.missedSeen`, { val: true, ack: false });
    assert.equal(s['intercom.missedCount'].val, 0);
});

test('adapter: intercom camera found by the intercom IP when the name does not match', async t => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    const adapter = require('../main.js')({
        config: {
            port,
            publicHost: '127.0.0.1',
            cameras: [
                { enabled: true, name: 'Carport', type: 'stream', url: 'rtsp://172.10.10.111/axis-media/media.amp' },
                { enabled: true, name: 'Sprechanalge', type: 'onvif', host: '172.10.10.120' },
            ],
            intercomEnabled: true,
            sipPort: 30000 + Math.floor(Math.random() * 10000),
            intercomHost: '172.10.10.120',
            intercomCamera: 'Sprechanlage',
            doorMethod: 'none',
        },
    });
    adapter.dataDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'lc-'));
    adapter.subscribeStates = () => {};
    const warnings = [];
    adapter.log.warn = m => warnings.push(m);
    adapter.emit('ready');
    await until(() => adapter.server && adapter.states['info.connection'] && adapter.states['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.equal(adapter.server.intercomCamera, 'sprechanalge');
    assert.match(warnings.join('\n'), /"Sprechanlage" not found.*using "Sprechanalge"/);
});

test('adapter: camera wall and single cameras switched on/off from ioBroker', async t => {
    const WebSocket = require('ws');
    const port = 40000 + Math.floor(Math.random() * 10000);
    const adapter = require('../main.js')({
        config: {
            port,
            publicHost: '127.0.0.1',
            cameras: [
                { enabled: true, name: 'Carport', type: 'stream', url: 'rtsp://172.10.10.111/axis-media/media.amp' },
                { enabled: true, name: 'Garten', type: 'stream', url: 'rtsp://172.10.10.112/axis-media/media.amp' },
            ],
        },
    });
    // Left switched off before the restart: stays off.
    adapter.states['cameras.garten.show'] = { val: false, ack: true };
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.equal(s['view.display'].val, true);
    assert.equal(s['cameras.carport.show'].val, true);
    assert.equal(adapter.objects['view.display'].common.write, true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const views = [];
    ws.on('message', d => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'view') {
            views.push(msg);
        }
    });
    t.after(() => ws.close());
    await until(() => views.length === 1);
    assert.deepEqual(views[0], { type: 'view', display: true, hidden: ['garten'] });

    await adapter.onStateChange(`${adapter.namespace}.view.display`, { val: false, ack: false });
    await until(() => views.length === 2);
    assert.deepEqual(views[1], { type: 'view', display: false, hidden: ['garten'] });
    assert.deepEqual(s['view.display'], { val: false, ack: true });

    await adapter.onStateChange(`${adapter.namespace}.cameras.garten.show`, { val: true, ack: false });
    await adapter.onStateChange(`${adapter.namespace}.cameras.carport.show`, { val: false, ack: false });
    await until(() => views.length === 4);
    assert.deepEqual(views[3].hidden, ['carport']);

    // The page itself starts with the current switch positions.
    const html = await new Promise((resolve, reject) =>
        http.get(`http://127.0.0.1:${port}/view`, r => {
            let b = '';
            r.on('data', d => (b += d));
            r.on('end', () => resolve(b));
        }).on('error', reject),
    );
    assert.match(html, /"view":\{"display":false,"hidden":\["carport"\]\}/);
});
