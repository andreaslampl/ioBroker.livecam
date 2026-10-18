'use strict';

/*
 * Call history of the door intercom: the last N calls with time, caller,
 * result (answered / missed / rejected), duration and a photo taken when it
 * rang. Stored as history.json plus one JPEG per call in the instance data
 * directory, so it survives adapter restarts.
 */

const fs = require('node:fs');
const path = require('node:path');

class CallHistory {
    /**
     * @param {object} options
     * @param {string} options.dir directory for history.json and images
     * @param {number} [options.size] number of calls to keep
     * @param {object} options.log
     */
    constructor({ dir, size = 20, log }) {
        this.dir = dir;
        this.size = Math.max(1, size);
        this.log = log;
        this.file = path.join(dir, 'history.json');
        this.entries = [];
    }

    load() {
        fs.mkdirSync(this.dir, { recursive: true });
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.entries = Array.isArray(data) ? data : [];
        } catch {
            this.entries = [];
        }
        this._trim();
    }

    /** Unseen missed calls. */
    get missedCount() {
        return this.entries.filter(e => e.result === 'missed' && !e.seen).length;
    }

    get lastMissed() {
        const e = this.entries.find(x => x.result === 'missed');
        return e ? e.time : null;
    }

    /**
     * @param {{time: string, caller: string, result: 'answered'|'missed'|'rejected', duration: number}} entry
     * @param {Buffer|null} image JPEG taken while ringing
     */
    add(entry, image) {
        const id = String(Date.parse(entry.time) || Date.now());
        const item = { id, ...entry, seen: entry.result !== 'missed', image: false };
        if (image && image.length) {
            try {
                fs.writeFileSync(path.join(this.dir, `${id}.jpg`), image);
                item.image = true;
            } catch (err) {
                this.log.warn(`Call history: cannot save image: ${err.message}`);
            }
        }
        this.entries.unshift(item);
        this._trim();
        this._save();
        return item;
    }

    markSeen() {
        let changed = false;
        for (const e of this.entries) {
            if (!e.seen) {
                e.seen = true;
                changed = true;
            }
        }
        if (changed) {
            this._save();
        }
    }

    /** Path of a call's image, or null (id is validated, no path traversal). */
    imagePath(id) {
        if (!/^\d{1,16}$/.test(id) || !this.entries.some(e => e.id === id && e.image)) {
            return null;
        }
        return path.join(this.dir, `${id}.jpg`);
    }

    _trim() {
        const removed = this.entries.splice(this.size);
        for (const e of removed) {
            if (e.image) {
                fs.rm(path.join(this.dir, `${e.id}.jpg`), { force: true }, () => {});
            }
        }
    }

    _save() {
        try {
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 1));
            fs.renameSync(tmp, this.file);
        } catch (err) {
            this.log.warn(`Call history: cannot save: ${err.message}`);
        }
    }
}

module.exports = { CallHistory };
