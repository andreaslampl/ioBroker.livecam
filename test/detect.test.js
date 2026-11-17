'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { postprocess, parseZones, inZones, SIZE } = require('../lib/detect');
const { Watcher, jpegSize } = require('../lib/watch');

/** a YOLOX-like output with one detection at grid cell (gx, gy) of the stride-8 head */
function output(cells) {
    const rows = (SIZE / 8) ** 2 + (SIZE / 16) ** 2 + (SIZE / 32) ** 2;
    const data = new Float32Array(rows * 85);
    for (const { gx, gy, w, h, obj, cls, p } of cells) {
        const i = gy * (SIZE / 8) + gx;
        const b = i * 85;
        data[b] = 0.5; // centre = cell + 0.5
        data[b + 1] = 0.5;
        data[b + 2] = Math.log(w / 8);
        data[b + 3] = Math.log(h / 8);
        data[b + 4] = obj;
        data[b + 5 + cls] = p;
    }
    return { data, rows };
}

test('postprocess: boxes in fractions of the original picture, groups, threshold, NMS', () => {
    // picture 832 x 416 -> ratio 0.5, letterboxed to 416 x 208 (top left)
    const { data, rows } = output([
        { gx: 10, gy: 10, w: 40, h: 80, obj: 0.9, cls: 0, p: 0.9 }, // person
        { gx: 11, gy: 10, w: 40, h: 80, obj: 0.8, cls: 0, p: 0.8 }, // same person, overlapping -> dropped
        { gx: 30, gy: 12, w: 80, h: 40, obj: 0.9, cls: 2, p: 0.95 }, // car
        { gx: 40, gy: 20, w: 20, h: 20, obj: 0.9, cls: 15, p: 0.9 }, // cat
        { gx: 5, gy: 20, w: 20, h: 20, obj: 0.9, cls: 56, p: 0.9 }, // chair: not one of our groups
        { gx: 20, gy: 20, w: 20, h: 20, obj: 0.3, cls: 0, p: 0.9 }, // too unsure
    ]);
    const d = postprocess(data, rows, 85, { w: 832, h: 416 }, 0.5);
    assert.deepEqual(d.map(x => x.label).sort(), ['Auto', 'Katze', 'Person']);
    const p = d.find(x => x.group === 'person');
    // centre 84 px in the 416 frame = 168 px original = 0.2019 of 832; width 40 -> 80 px = 0.0962
    assert.ok(Math.abs(p.x + p.w / 2 - 168 / 832) < 1e-3);
    assert.ok(Math.abs(p.w - 80 / 832) < 1e-3);
    assert.ok(Math.abs(p.h - 160 / 416) < 1e-3);
    assert.ok(Math.abs(p.score - 0.81) < 1e-3);
});

test('zones: polygons in 0..1, feet point decides, invalid input ignored', () => {
    assert.deepEqual(parseZones(''), []);
    assert.deepEqual(parseZones('kaputt'), []);
    const z = parseZones('[[[0,0.5],[0.5,0.5],[0.5,1],[0,1]], [[0.1,0.1],[0.2,0.1]], [[2,0],[1,1],[0,1]]]');
    assert.equal(z.length, 1, 'too few points / out of range dropped');
    // feet at (0.25, 0.9): inside; head in the zone but feet outside: not
    assert.equal(inZones({ x: 0.2, y: 0.5, w: 0.1, h: 0.4 }, z), true);
    assert.equal(inZones({ x: 0.6, y: 0.5, w: 0.1, h: 0.4 }, z), false);
    assert.equal(inZones({ x: 0.6, y: 0.5, w: 0.1, h: 0.4 }, []), true, 'no zone = whole picture');
});

test('jpegSize reads the SOF marker', () => {
    const sof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(jpegSize(sof), { w: 1920, h: 1080 });
});

test('watcher: model only on change or while present, on until hold expires, zones, rising edge event', async () => {
    let now = 1000000;
    const calls = [];
    let answer = [];
    const detector = { detect: async () => (calls.push(now), answer) };
    const w = new Watcher({ id: 'c', source: {}, detector, groups: ['person', 'vehicle'], hold: 5000, interval: 1000, now: () => now });
    const events = [];
    const states = [];
    w.on('detected', e => events.push(e.group));
    w.on('state', s => states.push(`${s.group}:${s.on}:${s.count}`));
    const frame = v => Buffer.alloc(SIZE * SIZE * 3, v);
    const tick = async (v, ms = 1000) => {
        now += ms;
        w._frame(frame(v), { w: 1920, h: 1080 });
        await new Promise(r => setImmediate(r));
    };
    await tick(10); // first picture: checked once
    await tick(10); // nothing changed, nothing there: no check
    await tick(10);
    assert.equal(calls.length, 1);
    answer = [{ group: 'person', label: 'Person', score: 0.9, x: 0.4, y: 0.3, w: 0.1, h: 0.5 }];
    await tick(60); // changed -> check -> person
    assert.equal(calls.length, 2);
    assert.deepEqual(events, ['person']);
    await tick(60); // unchanged, but a person is there: checked again (stays on)
    assert.equal(calls.length, 3);
    answer = [];
    await tick(60);
    await tick(60, 2000);
    assert.ok(states.includes('person:true:1'));
    assert.ok(!states.includes('person:false:0'), 'still within hold');
    await tick(60, 4000);
    assert.ok(states.includes('person:false:0'), 'off after hold');
    // zone: person outside the zone does not count
    w.setZones(parseZones('[[[0,0],[0.2,0],[0.2,1],[0,1]]]'));
    answer = [{ group: 'person', label: 'Person', score: 0.9, x: 0.4, y: 0.3, w: 0.1, h: 0.5 }];
    await tick(120);
    assert.equal(events.length, 1, 'outside the zone: no new event');
    // a car: own group, own event
    answer = [{ group: 'vehicle', label: 'Auto', score: 0.8, x: 0.05, y: 0.5, w: 0.1, h: 0.2 }];
    await tick(200);
    assert.deepEqual(events, ['person', 'vehicle']);
});

test('real model (onnxruntime-web, WebAssembly) loads and finds nothing on an empty grey picture', async () => {
    const { Detector } = require('../lib/detect');
    const log = { info() {}, warn() {}, debug() {} };
    const det = new Detector({ log });
    const grey = Buffer.alloc(SIZE * SIZE * 3, 114);
    const found = await det.detect(grey, { w: 1920, h: 1080 }, 0.5);
    assert.deepEqual(found, []);
    assert.equal(det.runs, 1);
});
