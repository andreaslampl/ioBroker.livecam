'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CallHistory } = require('../lib/history');
const { quietLog } = require('./helpers');

test('call history keeps the last N calls with photos and survives a restart', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livecam-history-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const h = new CallHistory({ dir, size: 3, log: quietLog });
    h.load();
    const jpg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const at = i => new Date(Date.UTC(2026, 9, 18, 10, i)).toISOString();
    h.add({ time: at(1), caller: 'Haustuer', result: 'missed', duration: 0 }, jpg);
    h.add({ time: at(2), caller: 'Haustuer', result: 'answered', duration: 42 }, jpg);
    h.add({ time: at(3), caller: 'Haustuer', result: 'rejected', duration: 0 }, null);
    h.add({ time: at(4), caller: 'Haustuer', result: 'missed', duration: 0 }, jpg);
    assert.equal(h.entries.length, 3);
    assert.deepEqual(h.entries.map(e => e.result), ['missed', 'rejected', 'answered']);
    assert.equal(h.missedCount, 1);
    assert.equal(h.lastMissed, at(4));
    // Oldest photo deleted with its entry.
    const first = String(Date.parse(at(1)));
    setImmediate(() => assert.equal(fs.existsSync(path.join(dir, `${first}.jpg`)), false));
    assert.ok(h.imagePath(h.entries[0].id));
    assert.equal(h.imagePath(h.entries[1].id), null); // rejected call had no photo
    assert.equal(h.imagePath('../history'), null);
    assert.equal(h.imagePath('123'), null);

    h.markSeen();
    assert.equal(h.missedCount, 0);
    const again = new CallHistory({ dir, size: 3, log: quietLog });
    again.load();
    assert.equal(again.entries.length, 3);
    assert.equal(again.missedCount, 0);
});
