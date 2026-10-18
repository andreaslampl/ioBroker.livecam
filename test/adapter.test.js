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
