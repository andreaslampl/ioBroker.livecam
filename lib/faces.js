'use strict';

/*
 * Face recognition of the household's own people (only those) with a simple liveness check.
 *
 * Models (run on the Detector's onnxruntime-web and queue, see models/README.md):
 *  - face_detect_yunet.onnx   YuNet 2023mar (MIT, Shiqi Yu): input [1,3,640,640] BGR 0..255 (letterbox top left),
 *    outputs cls/obj/bbox/kps per stride 8/16/32 -> boxes + 5 landmarks (right eye, left eye, nose, mouth right, left);
 *  - face_recog_sface.onnx    SFace (Apache-2.0, OpenCV zoo): aligned 112x112 RGB 0..255 -> 128 values, cosine similarity;
 *  - face_live_v2.onnx / face_live_v1se.onnx  MiniFASNet (Apache-2.0, Minivision Silent-Face-Anti-Spoofing): 80x80 BGR
 *    0..255 crops (face box x2.7 / x4.0) -> [fake, real, fake]; real = mean of class 1.
 *
 * Privacy: only embeddings of the people on the list are stored (faces.json in the data dir); a face that is not on
 * the list is never stored or logged ("unbekannt").
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const M = name => path.join(__dirname, '..', 'models', name);
const DSIZE = 640;
const ASIZE = 112;
const LSIZE = 80;
// destination landmarks of the 112 x 112 face (as OpenCV's FaceRecognizerSF::alignCrop)
const DST = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/**
 * YuNet outputs -> faces in pixels of the letterboxed 640 picture.
 * @param {object} out {cls_8: Float32Array, obj_8, bbox_8, kps_8, … _16, _32}
 */
function decodeYunet(out, minScore = 0.6) {
    const faces = [];
    for (const s of [8, 16, 32]) {
        const cols = DSIZE / s;
        const cls = out[`cls_${s}`];
        const obj = out[`obj_${s}`];
        const bbox = out[`bbox_${s}`];
        const kps = out[`kps_${s}`];
        for (let i = 0; i < cls.length; i++) {
            const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
            if (score < minScore) {
                continue;
            }
            const r = Math.floor(i / cols);
            const c = i % cols;
            const cx = (c + bbox[i * 4]) * s;
            const cy = (r + bbox[i * 4 + 1]) * s;
            const w = Math.exp(bbox[i * 4 + 2]) * s;
            const h = Math.exp(bbox[i * 4 + 3]) * s;
            const lm = [];
            for (let n = 0; n < 5; n++) {
                lm.push([(kps[i * 10 + 2 * n] + c) * s, (kps[i * 10 + 2 * n + 1] + r) * s]);
            }
            faces.push({ score, x: cx - w / 2, y: cy - h / 2, w, h, lm });
        }
    }
    faces.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const f of faces) {
        if (keep.every(k => iou(k, f) < 0.3)) {
            keep.push(f);
        }
    }
    return keep;
}

/**
 * Similarity transform (scale, rotation, shift) mapping src points onto dst (least squares).
 * @returns {number[]} [a, b, tx, ty] with x' = a x - b y + tx, y' = b x + a y + ty
 */
function similarity(src, dst) {
    const n = src.length;
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
        sx += src[i][0];
        sy += src[i][1];
        dx += dst[i][0];
        dy += dst[i][1];
    }
    sx /= n;
    sy /= n;
    dx /= n;
    dy /= n;
    let num1 = 0;
    let num2 = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        const x = src[i][0] - sx;
        const y = src[i][1] - sy;
        const u = dst[i][0] - dx;
        const v = dst[i][1] - dy;
        num1 += x * u + y * v;
        num2 += x * v - y * u;
        den += x * x + y * y;
    }
    const a = num1 / (den || 1);
    const b = num2 / (den || 1);
    return [a, b, dx - a * sx + b * sy, dy - b * sx - a * sy];
}

/** warp an RGB picture (w x h) into the size x size face with the transform (bilinear, inverse mapping) */
function warp(rgb, w, h, t, size = ASIZE) {
    const [a, b, tx, ty] = t;
    const det = a * a + b * b || 1;
    const out = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // inverse of [a -b; b a] + t
            const u = x - tx;
            const v = y - ty;
            const sx = (a * u + b * v) / det;
            const sy = (-b * u + a * v) / det;
            const x0 = Math.floor(sx);
            const y0 = Math.floor(sy);
            const fx = sx - x0;
            const fy = sy - y0;
            for (let ch = 0; ch < 3; ch++) {
                const px = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : rgb[(yy * w + xx) * 3 + ch]);
                const val = (1 - fy) * ((1 - fx) * px(x0, y0) + fx * px(x0 + 1, y0)) + fy * ((1 - fx) * px(x0, y0 + 1) + fx * px(x0 + 1, y0 + 1));
                out[(y * size + x) * 3 + ch] = Math.round(val);
            }
        }
    }
    return out;
}

/** bilinear crop of the rectangle (x1, y1, sw * size, sh * size) to size x size */
function scaleCrop(rgb, w, h, x1, y1, sw, sh, size) {
    const out = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sx = Math.min(w - 1, Math.max(0, x1 + (x + 0.5) * sw - 0.5));
            const sy = Math.min(h - 1, Math.max(0, y1 + (y + 0.5) * sh - 0.5));
            const x0 = Math.floor(sx);
            const y0 = Math.floor(sy);
            const x1b = Math.min(w - 1, x0 + 1);
            const y1b = Math.min(h - 1, y0 + 1);
            const fx = sx - x0;
            const fy = sy - y0;
            for (let ch = 0; ch < 3; ch++) {
                const p = (xx, yy) => rgb[(yy * w + xx) * 3 + ch];
                out[(y * size + x) * 3 + ch] = Math.round((1 - fy) * ((1 - fx) * p(x0, y0) + fx * p(x1b, y0)) + fy * ((1 - fx) * p(x0, y1b) + fx * p(x1b, y1b)));
            }
        }
    }
    return out;
}

function cosine(a, b) {
    let d = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        d += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return d / (Math.sqrt(na * nb) || 1);
}

/** best person for an embedding: [{id, name, embeds}] -> {id, name, score} (score = best cosine of any sample) */
function bestMatch(embed, persons) {
    let best = null;
    for (const p of persons) {
        for (const e of p.embeds || []) {
            const score = cosine(embed, e);
            if (!best || score > best.score) {
                best = { id: p.id, name: p.name, score };
            }
        }
    }
    return best;
}

/** RGB (HWC) -> float32 NCHW, optionally swapped to BGR */
function planar(rgb, size, bgr) {
    const n = size * size;
    const out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
        const r = rgb[i * 3];
        const g = rgb[i * 3 + 1];
        const b = rgb[i * 3 + 2];
        out[i] = bgr ? b : r;
        out[n + i] = g;
        out[2 * n + i] = bgr ? r : b;
    }
    return out;
}

class FaceReader {
    constructor({ detector, log, ffmpegPath = 'ffmpeg', spawnFn = spawn, models = {} }) {
        this.detector = detector;
        this.log = log;
        this.ffmpegPath = ffmpegPath;
        this.spawnFn = spawnFn;
        this.models = { detect: M('face_detect_yunet.onnx'), recog: M('face_recog_sface.onnx'), liveA: M('face_live_v2.onnx'), liveB: M('face_live_v1se.onnx'), ...models };
        this.runs = 0;
        this.totalMs = 0;
    }

    async init() {
        if (this.det) {
            return;
        }
        if (!this.loading) {
            this.loading = (async () => {
                await this.detector.init();
                const ort = this.detector.ort;
                const o = { executionProviders: ['wasm'], logSeverityLevel: 3 };
                const t0 = Date.now();
                const det = await ort.InferenceSession.create(this.models.detect, o);
                this.recog = await ort.InferenceSession.create(this.models.recog, o);
                this.liveA = fs.existsSync(this.models.liveA) ? await ort.InferenceSession.create(this.models.liveA, o) : null;
                this.liveB = fs.existsSync(this.models.liveB) ? await ort.InferenceSession.create(this.models.liveB, o) : null;
                this.ort = ort;
                this.det = det;
                this.log.info(`Gesichter: Modelle geladen (${Date.now() - t0} ms)`);
            })().catch(err => {
                this.loading = null;
                this.det = null;
                throw err;
            });
        }
        return this.loading;
    }

    get avgMs() {
        return this.runs ? Math.round(this.totalMs / this.runs) : 0;
    }

    /** raw RGB of the whole picture or a part of it, scaled to at most maxW wide */
    rgb(jpeg, area, orig, maxW = 1280) {
        let vf = '';
        let w = orig.w;
        let h = orig.h;
        if (area) {
            const x = Math.max(0, Math.floor(area.x * orig.w));
            const y = Math.max(0, Math.floor(area.y * orig.h));
            w = Math.max(16, Math.min(orig.w - x, Math.ceil(area.w * orig.w)));
            h = Math.max(16, Math.min(orig.h - y, Math.ceil(area.h * orig.h)));
            vf = `crop=${w}:${h}:${x}:${y},`;
        }
        if (w > maxW) {
            h = Math.round((h * maxW) / w);
            w = maxW;
        }
        w -= w % 2;
        h -= h % 2;
        vf += `scale=${w}:${h}`;
        return new Promise((resolve, reject) => {
            const p = this.spawnFn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const out = [];
            p.stdout.on('data', c => out.push(c));
            p.on('error', reject);
            p.on('exit', () => {
                const b = Buffer.concat(out);
                b.length >= w * h * 3 ? resolve({ rgb: b.subarray(0, w * h * 3), w, h }) : reject(new Error('Bild konnte nicht gelesen werden'));
            });
            p.stdin.on('error', () => {});
            p.stdin.end(jpeg);
        });
    }

    /**
     * Faces in a picture (or the given person areas), each with embedding and liveness.
     * @returns {Promise<{box, size, score, embed: Float32Array, live: number|null, face: Uint8Array}[]>}
     */
    read(jpeg, orig, areas, opts) {
        const job = this.detector.queue.then(() => this._read(jpeg, orig, areas, opts));
        this.detector.queue = job.catch(() => {});
        return job;
    }

    async _read(jpeg, orig, areas, { minSize = 40, max = 3 } = {}) {
        await this.init();
        const t0 = Date.now();
        const out = [];
        // a person: the upper part with the head (+ a margin); else the whole picture
        const regions = areas && areas.length
            ? areas.slice(0, max).map(a => {
                  const mx = a.w * 0.15;
                  const x = Math.max(0, a.x - mx);
                  const y = Math.max(0, a.y - a.h * 0.05);
                  return { x, y, w: Math.min(1 - x, a.w + 2 * mx), h: Math.min(1 - y, a.h * 0.6) };
              })
            : [null];
        for (const reg of regions) {
            const img = await this.rgb(jpeg, reg, orig);
            const faces = await this._detect(img);
            for (const f of faces.slice(0, 2)) {
                if (Math.min(f.w, f.h) < minSize) {
                    continue;
                }
                const face = warp(img.rgb, img.w, img.h, similarity(f.lm, DST));
                const e = await this.recog.run({ [this.recog.inputNames[0]]: new this.ort.Tensor('float32', planar(face, ASIZE, false), [1, 3, ASIZE, ASIZE]) });
                const embed = Float32Array.from(e[this.recog.outputNames[0]].data);
                const live = await this._live(img, f);
                // centre of the face as a fraction of the whole picture (to put the name on the person's box)
                const r = reg || { x: 0, y: 0, w: 1, h: 1 };
                const cx = r.x + ((f.x + f.w / 2) / img.w) * r.w;
                const cy = r.y + ((f.y + f.h / 2) / img.h) * r.h;
                out.push({ box: f, size: Math.round(Math.min(f.w, f.h)), score: f.score, embed, live, face, cx, cy });
            }
        }
        this.runs++;
        this.totalMs += Date.now() - t0;
        return out;
    }

    async _detect(img) {
        const r = Math.min(DSIZE / img.w, DSIZE / img.h);
        const nw = Math.round(img.w * r);
        const nh = Math.round(img.h * r);
        // letterbox top left, black padding (nearest-neighbour scale is enough for detection)
        const buf = new Uint8Array(DSIZE * DSIZE * 3);
        for (let y = 0; y < nh; y++) {
            const sy = Math.min(img.h - 1, Math.floor(y / r));
            for (let x = 0; x < nw; x++) {
                const sx = Math.min(img.w - 1, Math.floor(x / r));
                const s = (sy * img.w + sx) * 3;
                const d = (y * DSIZE + x) * 3;
                buf[d] = img.rgb[s];
                buf[d + 1] = img.rgb[s + 1];
                buf[d + 2] = img.rgb[s + 2];
            }
        }
        const res = await this.det.run({ [this.det.inputNames[0]]: new this.ort.Tensor('float32', planar(buf, DSIZE, true), [1, 3, DSIZE, DSIZE]) });
        const o = {};
        for (const k of Object.keys(res)) {
            o[k] = res[k].data;
        }
        return decodeYunet(o).map(f => ({ ...f, x: f.x / r, y: f.y / r, w: f.w / r, h: f.h / r, lm: f.lm.map(([x, y]) => [x / r, y / r]) }));
    }

    async _live(img, f) {
        if (!this.liveA || !this.liveB) {
            return null;
        }
        let real = 0;
        for (const [sess, scale] of [
            [this.liveA, 2.7],
            [this.liveB, 4.0],
        ]) {
            const crop = scaleCropBox(img, f, scale);
            const res = await sess.run({ [sess.inputNames[0]]: new this.ort.Tensor('float32', planar(crop, LSIZE, true), [1, 3, LSIZE, LSIZE]) });
            const d = res[sess.outputNames[0]].data;
            const m = Math.max(d[0], d[1], d[2]);
            const ex = [d[0], d[1], d[2]].map(v => Math.exp(v - m));
            real += ex[1] / (ex[0] + ex[1] + ex[2]);
        }
        return real / 2;
    }
}

/** Silent-Face crop: face box times `scale`, kept inside the picture, resized to 80 x 80 */
function scaleCropBox(img, box, scale) {
    const { rgb, w, h } = img;
    const s = Math.min((h - 1) / box.h, (w - 1) / box.w, scale);
    const nw = box.w * s;
    const nh = box.h * s;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let x1 = cx - nw / 2;
    let y1 = cy - nh / 2;
    let x2 = cx + nw / 2;
    let y2 = cy + nh / 2;
    if (x1 < 0) {
        x2 -= x1;
        x1 = 0;
    }
    if (y1 < 0) {
        y2 -= y1;
        y1 = 0;
    }
    if (x2 > w - 1) {
        x1 -= x2 - w + 1;
        x2 = w - 1;
    }
    if (y2 > h - 1) {
        y1 -= y2 - h + 1;
        y2 = h - 1;
    }
    return scaleCrop(rgb, w, h, x1, y1, (x2 - x1) / LSIZE, (y2 - y1) / LSIZE, LSIZE);
}

// ---------------- the people (faces.json + aligned photos) ----------------

class FaceStore {
    constructor(dir, { log } = {}) {
        this.dir = dir;
        this.file = path.join(dir, 'faces.json');
        this.log = log || console;
        this.persons = [];
        try {
            const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.persons = Array.isArray(d.persons) ? d.persons : [];
        } catch {
            // none yet
        }
    }

    save() {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ persons: this.persons }));
        fs.renameSync(`${this.file}.tmp`, this.file);
    }

    /** without the embeddings (for the page) */
    list() {
        return this.persons.map(p => ({ id: p.id, name: p.name, door: Boolean(p.door), samples: (p.samples || []).map(s => s.id) }));
    }

    get(id) {
        return this.persons.find(p => p.id === id);
    }

    add(name, door) {
        const clean = String(name || '').trim().slice(0, 40);
        if (!clean) {
            throw new Error('Name fehlt');
        }
        const p = { id: crypto.randomBytes(4).toString('hex'), name: clean, door: Boolean(door), samples: [], embeds: [] };
        this.persons.push(p);
        this.save();
        return p;
    }

    update(id, { name, door }) {
        const p = this.get(id);
        if (!p) {
            throw new Error('Person gibt es nicht');
        }
        if (name !== undefined && String(name).trim()) {
            p.name = String(name).trim().slice(0, 40);
        }
        if (door !== undefined) {
            p.door = Boolean(door);
        }
        this.save();
        return p;
    }

    remove(id) {
        this.persons = this.persons.filter(p => p.id !== id);
        fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
        this.save();
    }

    /** one sample: embedding + the aligned 112 x 112 face as JPEG (for the page), at most 20 per person */
    addSample(id, embed, jpeg) {
        const p = this.get(id);
        if (!p) {
            throw new Error('Person gibt es nicht');
        }
        p.samples = p.samples || [];
        p.embeds = p.embeds || [];
        if (p.samples.length >= 20) {
            throw new Error('Höchstens 20 Bilder pro Person');
        }
        const sid = crypto.randomBytes(4).toString('hex');
        if (jpeg) {
            fs.mkdirSync(path.join(this.dir, id), { recursive: true });
            fs.writeFileSync(path.join(this.dir, id, `${sid}.jpg`), jpeg);
        }
        p.samples.push({ id: sid });
        p.embeds.push(Array.from(embed, v => Math.round(v * 1e5) / 1e5));
        this.save();
        return sid;
    }

    removeSample(id, sid) {
        const p = this.get(id);
        const i = p ? p.samples.findIndex(s => s.id === sid) : -1;
        if (i < 0) {
            throw new Error('Bild gibt es nicht');
        }
        p.samples.splice(i, 1);
        p.embeds.splice(i, 1);
        fs.rmSync(path.join(this.dir, id, `${sid}.jpg`), { force: true });
        this.save();
    }

    photo(id, sid) {
        if (!/^[0-9a-f]{8}$/.test(id) || !/^[0-9a-f]{8}$/.test(sid)) {
            return null;
        }
        const f = path.join(this.dir, id, `${sid}.jpg`);
        return fs.existsSync(f) ? f : null;
    }
}

module.exports = { FaceReader, FaceStore, decodeYunet, similarity, warp, cosine, bestMatch, scaleCropBox, DST, ASIZE };
