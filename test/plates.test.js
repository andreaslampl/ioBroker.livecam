'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PlateReader, parseKnown, match, normalize, decode, ALPHABET } = require('../lib/plates');
const { Detector } = require('../lib/detect');

test('plates: list, look-alike characters, one character off, nothing for strangers', () => {
    const known = parseKnown([{ plate: 'KL-482 BX', name: 'ID.4' }, { plate: 'fe 17au', name: '' }, { plate: 'x' }, null]);
    assert.deepEqual(known.map(k => [k.plate, k.name]), [['KL482BX', 'ID.4'], ['FE17AU', 'FE17AU']]);
    assert.equal(normalize('kl-482 bx'), 'KL482BX');
    assert.deepEqual(match('KL482BX', known), { plate: 'KL482BX', name: 'ID.4', dist: 0 });
    assert.equal(match('KL4828X', known).dist, 0, 'B read as 8 counts as the same');
    assert.equal(match('KL482B', known).dist, 1, 'one character missing');
    assert.equal(match('KL48BX', known).name, 'ID.4');
    assert.equal(match('W12345A', known), null);
    assert.equal(match('KL4', known), null);
    assert.equal(match('FE17A', known).name, 'FE17AU');
    // decode: '_' slots are empty, certainty = mean of the used slots
    const data = new Float32Array(10 * ALPHABET.length);
    'AB1'.split('').forEach((c, s) => (data[s * ALPHABET.length + ALPHABET.indexOf(c)] = 0.9));
    for (let s = 3; s < 10; s++) {
        data[s * ALPHABET.length + ALPHABET.length - 1] = 1;
    }
    const d = decode(data);
    assert.equal(d.text, 'AB1');
    assert.ok(Math.abs(d.prob - 0.9) < 1e-6);
});

test('plates: real models find and read the plate on the test picture (vehicle box and whole picture)', async () => {
    const log = { info() {}, warn() {}, debug() {} };
    const reader = new PlateReader({ detector: new Detector({ log }), log });
    const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures', 'plate-scene.jpg'));
    const orig = { w: 1280, h: 720 };
    const car = await reader.read(jpeg, orig, [{ x: 0.33, y: 0.36, w: 0.38, h: 0.56 }]);
    assert.equal(car[0].text, 'KL482BX');
    assert.ok(car[0].prob > 0.9);
    const whole = await reader.read(jpeg, orig, []);
    assert.equal(whole[0].text, 'KL482BX');
    assert.equal(reader.runs, 2);
});
