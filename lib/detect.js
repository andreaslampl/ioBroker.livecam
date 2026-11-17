'use strict';

/*
 * Object detection (persons, vehicles, animals) with YOLOX-nano (Apache-2.0, Megvii, models/yolox_nano.onnx)
 * on onnxruntime-web (WebAssembly: runs on CPUs without AVX, e.g. the owner's Celeron J4125).
 *
 * Input: one letterboxed frame of SIZE x SIZE pixels, BGR, 8 bit (ffmpeg scale + pad, see lib/watch.js).
 * Output: detections with boxes in fractions of the original picture (0..1), so zones work for any resolution.
 * One model, one inference at a time for all cameras (the CPU stays free for everything else).
 */

const path = require('node:path');

const SIZE = 416;
const MODEL = path.join(__dirname, '..', 'models', 'yolox_nano.onnx');

/** COCO class ids -> our groups */
const GROUPS = {
    person: { 0: 'Person' },
    vehicle: { 1: 'Fahrrad', 2: 'Auto', 3: 'Motorrad', 5: 'Bus', 7: 'LKW' },
    animal: { 14: 'Vogel', 15: 'Katze', 16: 'Hund', 17: 'Pferd', 18: 'Schaf', 19: 'Kuh' },
};
const CLASS = {};
for (const [group, ids] of Object.entries(GROUPS)) {
    for (const [id, label] of Object.entries(ids)) {
        CLASS[id] = { group, label };
    }
}

/** grid cells of the three YOLOX heads (strides 8, 16, 32) */
function grids(size = SIZE) {
    const out = [];
    for (const stride of [8, 16, 32]) {
        const n = size / stride;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                out.push(x, y, stride);
            }
        }
    }
    return out;
}
const GRID = grids();

function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/**
 * Raw YOLOX output [1, N, 85] -> detections of our groups.
 * @param {Float32Array} data
 * @param {number} rows N
 * @param {number} cols 85 (4 box + objectness + 80 classes)
 * @param {{w: number, h: number}} orig size of the picture before letterboxing
 * @param {number} minScore 0..1
 * @returns {{group: string, label: string, score: number, x: number, y: number, w: number, h: number}[]}
 */
function postprocess(data, rows, cols, orig, minScore = 0.5) {
    const ratio = Math.min(SIZE / orig.w, SIZE / orig.h);
    const found = [];
    for (let i = 0; i < rows; i++) {
        const b = i * cols;
        const obj = data[b + 4];
        if (obj < minScore) {
            continue;
        }
        let best = 0;
        let cls = -1;
        for (let k = 5; k < cols; k++) {
            if (data[b + k] > best) {
                best = data[b + k];
                cls = k - 5;
            }
        }
        const score = obj * best;
        if (score < minScore || !CLASS[cls]) {
            continue;
        }
        const gx = GRID[i * 3];
        const gy = GRID[i * 3 + 1];
        const stride = GRID[i * 3 + 2];
        const cx = (data[b] + gx) * stride;
        const cy = (data[b + 1] + gy) * stride;
        const w = Math.exp(data[b + 2]) * stride;
        const h = Math.exp(data[b + 3]) * stride;
        found.push({
            ...CLASS[cls],
            score,
            x: (cx - w / 2) / ratio / orig.w,
            y: (cy - h / 2) / ratio / orig.h,
            w: w / ratio / orig.w,
            h: h / ratio / orig.h,
        });
    }
    // non-maximum suppression per group
    found.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const d of found) {
        if (!keep.some(k => k.group === d.group && iou(k, d) > 0.45)) {
            keep.push(d);
        }
    }
    return keep;
}

/** point in polygon (even-odd); polygon = [[x, y], ...] in 0..1 */
function inside(px, py, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            hit = !hit;
        }
    }
    return hit;
}

/**
 * Zones: "" = whole picture, else JSON [[[x,y],...], ...] (several polygons, 0..1). A detection counts when the
 * point where it touches the ground (bottom centre of the box) lies in a zone.
 */
function parseZones(text) {
    if (!text) {
        return [];
    }
    try {
        const z = typeof text === 'string' ? JSON.parse(text) : text;
        return (Array.isArray(z) ? z : [])
            .map(p => (Array.isArray(p) ? p : []).filter(pt => Array.isArray(pt) && pt.length === 2 && pt.every(v => typeof v === 'number' && v >= 0 && v <= 1)))
            .filter(p => p.length >= 3)
            .slice(0, 8);
    } catch {
        return [];
    }
}

function inZones(d, zones) {
    return !zones.length || zones.some(z => inside(d.x + d.w / 2, d.y + d.h, z));
}

class Detector {
    /**
     * @param {object} options
     * @param {object} options.log
     * @param {string} [options.model]
     * @param {Function} [options.loadRuntime] () => onnxruntime-web module (tests / installed elsewhere)
     * @param {number} [options.threads] WebAssembly threads (default 1: the J4125 has 4 cores for everything)
     */
    constructor({ log, model = MODEL, loadRuntime, threads = 1 }) {
        this.log = log;
        this.model = model;
        this.loadRuntime = loadRuntime || (() => require('onnxruntime-web'));
        this.threads = threads;
        this.session = null;
        this.queue = Promise.resolve();
        this.runs = 0;
        this.totalMs = 0;
    }

    async init() {
        if (this.session) {
            return;
        }
        if (!this.loading) {
            this.loading = (async () => {
                const ort = this.loadRuntime();
                ort.env.wasm.numThreads = this.threads;
                const t0 = Date.now();
                this.ort = ort;
                this.session = await ort.InferenceSession.create(this.model, { executionProviders: ['wasm'] });
                this.log.info(`Erkennung: Modell geladen (${Date.now() - t0} ms)`);
            })().catch(err => {
                this.loading = null;
                throw err;
            });
        }
        return this.loading;
    }

    /** average time of one inference (ms) */
    get avgMs() {
        return this.runs ? Math.round(this.totalMs / this.runs) : 0;
    }

    /**
     * @param {Buffer} bgr SIZE*SIZE*3 bytes, letterboxed (picture top left, grey padding)
     * @param {{w: number, h: number}} orig
     * @param {number} minScore
     */
    detect(bgr, orig, minScore) {
        const job = this.queue.then(() => this._run(bgr, orig, minScore));
        this.queue = job.catch(() => {});
        return job;
    }

    async _run(bgr, orig, minScore) {
        await this.init();
        const n = SIZE * SIZE;
        const input = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) {
            input[i] = bgr[i * 3];
            input[n + i] = bgr[i * 3 + 1];
            input[2 * n + i] = bgr[i * 3 + 2];
        }
        const t0 = Date.now();
        const out = await this.session.run({ [this.session.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
        this.runs++;
        this.totalMs += Date.now() - t0;
        const o = out[this.session.outputNames[0]];
        return postprocess(o.data, o.dims[1], o.dims[2], orig, minScore);
    }
}

module.exports = { Detector, postprocess, parseZones, inZones, inside, GROUPS, SIZE, MODEL };
