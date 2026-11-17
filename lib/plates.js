'use strict';

/*
 * Number plates of the owner's own vehicles (only those): find the plate in the picture of a detected vehicle,
 * read it, compare it with the list of known plates.
 *
 * Models (MIT, ankandrew, see models/README.md), run on the Detector's onnxruntime-web and queue:
 *  - plate_detect_384.onnx  YOLOv9-t "end2end": input [1,3,384,384] RGB 0..1 (centred letterbox, grey 114),
 *    output [n,7] = batch, x1, y1, x2, y2, class, score (pixels of the 384 picture);
 *  - plate_ocr_cct_s_v2.onnx  fast-plate-ocr CCT-S v2 global: input [1,64,128,3] uint8 RGB (stretched),
 *    output plate [1,10,37] (probabilities per slot, alphabet below, '_' = empty) + region.
 *
 * Privacy: a reading that is not on the list is never stored or logged - only "unknown vehicle".
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const DET = path.join(__dirname, '..', 'models', 'plate_detect_384.onnx');
const OCR = path.join(__dirname, '..', 'models', 'plate_ocr_cct_s_v2.onnx');
const DSIZE = 384;
const OW = 128;
const OH = 64;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const SLOTS = 10;

/** letters / digits only, upper case ("KL-482 BX" -> "KL482BX") */
function normalize(text) {
    return String(text || '')
        .toUpperCase()
        .replace(/Ä/g, 'AE')
        .replace(/Ö/g, 'OE')
        .replace(/Ü/g, 'UE')
        .replace(/[^A-Z0-9]/g, '');
}

/** characters an OCR mixes up are treated as the same */
function loose(text) {
    const map = { O: '0', Q: '0', D: '0', I: '1', Z: '2', S: '5', B: '8', G: '6' };
    return normalize(text).replace(/[OQDIZSBG]/g, c => map[c]);
}

function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) {
        d[0][j] = j;
    }
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[a.length][b.length];
}

/**
 * Known plates from the settings: [{plate, name}] -> [{plate, name, key}] (invalid rows dropped).
 */
function parseKnown(rows) {
    return (Array.isArray(rows) ? rows : [])
        .map(r => ({ plate: normalize(r && r.plate), name: String((r && r.name) || '').trim() }))
        .filter(r => r.plate.length >= 3)
        .map(r => ({ ...r, name: r.name || r.plate, key: loose(r.plate) }));
}

/**
 * A reading against the list: exact (with look-alike characters), or one character off for plates with 5+ characters.
 * @returns {{plate, name, dist}|null}
 */
function match(reading, known) {
    const r = loose(reading);
    if (r.length < 3) {
        return null;
    }
    let best = null;
    for (const k of known) {
        const dist = distance(r, k.key);
        const ok = dist === 0 || (dist === 1 && k.key.length >= 5);
        if (ok && (!best || dist < best.dist)) {
            best = { plate: k.plate, name: k.name, dist };
        }
    }
    return best;
}

/** OCR output -> text + mean / lowest certainty of the used slots */
function decode(data) {
    let text = '';
    let sum = 0;
    let min = 1;
    for (let s = 0; s < SLOTS; s++) {
        let bi = 0;
        for (let j = 1; j < ALPHABET.length; j++) {
            if (data[s * ALPHABET.length + j] > data[s * ALPHABET.length + bi]) {
                bi = j;
            }
        }
        const ch = ALPHABET[bi];
        if (ch === '_') {
            continue;
        }
        const p = data[s * ALPHABET.length + bi];
        text += ch;
        sum += p;
        min = Math.min(min, p);
    }
    return { text, prob: text ? sum / text.length : 0, min: text ? min : 0 };
}

class PlateReader {
    /**
     * @param {object} o
     * @param {import('./detect').Detector} o.detector shares onnxruntime and the queue (one model at a time)
     * @param {string} [o.ffmpegPath]
     * @param {Function} [o.spawnFn]
     */
    constructor({ detector, log, ffmpegPath = 'ffmpeg', spawnFn = spawn, detModel = DET, ocrModel = OCR }) {
        this.detector = detector;
        this.log = log;
        this.ffmpegPath = ffmpegPath;
        this.spawnFn = spawnFn;
        this.detModel = detModel;
        this.ocrModel = ocrModel;
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
                const t0 = Date.now();
                this.det = await ort.InferenceSession.create(this.detModel, { executionProviders: ['wasm'] });
                this.ocr = await ort.InferenceSession.create(this.ocrModel, { executionProviders: ['wasm'] });
                this.ort = ort;
                this.log.info(`Kennzeichen: Modelle geladen (${Date.now() - t0} ms)`);
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

    /** raw RGB out of ffmpeg for a part of a JPEG */
    _raw(jpeg, vf, bytes) {
        return new Promise((resolve, reject) => {
            const p = this.spawnFn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const out = [];
            p.stdout.on('data', c => out.push(c));
            p.on('error', reject);
            p.on('exit', () => {
                const b = Buffer.concat(out);
                b.length >= bytes ? resolve(b.subarray(0, bytes)) : reject(new Error('Bildausschnitt konnte nicht gelesen werden'));
            });
            p.stdin.on('error', () => {});
            p.stdin.end(jpeg);
        });
    }

    /**
     * Read the plates in a picture.
     * @param {Buffer} jpeg full-size picture
     * @param {{w: number, h: number}} orig its size
     * @param {{x, y, w, h}[]} [areas] vehicle boxes (fractions); none = whole picture
     * @returns {Promise<{text: string, prob: number, min: number, score: number}[]>}
     */
    read(jpeg, orig, areas) {
        const job = this.detector.queue.then(() => this._read(jpeg, orig, areas));
        this.detector.queue = job.catch(() => {});
        return job;
    }

    async _read(jpeg, orig, areas) {
        await this.init();
        const t0 = Date.now();
        const list = areas && areas.length ? areas.slice(0, 3) : [{ x: 0, y: 0, w: 1, h: 1 }];
        const out = [];
        for (const a of list) {
            // the vehicle and a bit around it (it may have moved since the check)
            const m = 0.12;
            const x1 = Math.max(0, Math.floor((a.x - a.w * m) * orig.w));
            const y1 = Math.max(0, Math.floor((a.y - a.h * m) * orig.h));
            const x2 = Math.min(orig.w, Math.ceil((a.x + a.w * (1 + m)) * orig.w));
            const y2 = Math.min(orig.h, Math.ceil((a.y + a.h * (1 + m)) * orig.h));
            const cw = x2 - x1;
            const ch = y2 - y1;
            if (cw < 16 || ch < 16) {
                continue;
            }
            const r = Math.min(DSIZE / cw, DSIZE / ch);
            const nw = Math.max(1, Math.round(cw * r));
            const nh = Math.max(1, Math.round(ch * r));
            const dw = (DSIZE - nw) / 2;
            const dh = (DSIZE - nh) / 2;
            const rgb = await this._raw(
                jpeg,
                `crop=${cw}:${ch}:${x1}:${y1},scale=${nw}:${nh},pad=${DSIZE}:${DSIZE}:${Math.round(dw - 0.1)}:${Math.round(dh - 0.1)}:color=0x727272`,
                DSIZE * DSIZE * 3,
            );
            const n = DSIZE * DSIZE;
            const input = new Float32Array(3 * n);
            for (let i = 0; i < n; i++) {
                input[i] = rgb[i * 3] / 255;
                input[n + i] = rgb[i * 3 + 1] / 255;
                input[2 * n + i] = rgb[i * 3 + 2] / 255;
            }
            const res = await this.det.run({ [this.det.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, DSIZE, DSIZE]) });
            const o = res[this.det.outputNames[0]];
            const plates = [];
            for (let k = 0; k < o.dims[0]; k++) {
                const p = o.data.subarray(k * 7, k * 7 + 7);
                if (p[6] >= 0.35) {
                    plates.push({ score: p[6], x1: (p[1] - dw) / r + x1, y1: (p[2] - dh) / r + y1, x2: (p[3] - dw) / r + x1, y2: (p[4] - dh) / r + y1 });
                }
            }
            plates.sort((p, q) => q.score - p.score);
            for (const p of plates.slice(0, 2)) {
                const px = Math.max(0, Math.round(p.x1));
                const py = Math.max(0, Math.round(p.y1));
                const pw = Math.min(orig.w - px, Math.round(p.x2 - p.x1));
                const ph = Math.min(orig.h - py, Math.round(p.y2 - p.y1));
                if (pw < 8 || ph < 4) {
                    continue;
                }
                const crop = await this._raw(jpeg, `crop=${pw}:${ph}:${px}:${py},scale=${OW}:${OH}`, OW * OH * 3);
                const oc = await this.ocr.run({ [this.ocr.inputNames[0]]: new this.ort.Tensor('uint8', new Uint8Array(crop), [1, OH, OW, 3]) });
                out.push({ ...decode(oc.plate.data), score: p.score });
            }
        }
        this.runs++;
        this.totalMs += Date.now() - t0;
        return out;
    }
}

module.exports = { PlateReader, normalize, loose, distance, parseKnown, match, decode, ALPHABET };
