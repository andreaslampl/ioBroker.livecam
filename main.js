'use strict';

const os = require('node:os');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const { CameraSource } = require('./lib/source');
const { CamServer } = require('./lib/server');
const { cameraId, completeUrl, validHost } = require('./lib/util');
const { Intercom } = require('./lib/intercom');
const { CallHistory } = require('./lib/history');
const { TONE_LABELS } = require('./lib/tones');
const { Detector, parseZones, GROUPS, SIZE } = require('./lib/detect');
const { Watcher, jpegSize } = require('./lib/watch');
const { PlateReader, parseKnown, match: matchPlate } = require('./lib/plates');
const { VmsClient, normalizeBase } = require('./lib/vms');
const { FaceReader, FaceStore, bestMatch, cosine } = require('./lib/faces');
const fs = require('node:fs');

function localAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
}

/** object kinds of the VMS that get their own data point */
const VMS_KINDS = ['person', 'car', 'animal', 'motorcycle', 'bicycle', 'truck'];
const VMS_KIND_DE = { person: 'Person', car: 'Auto', animal: 'Tier', motorcycle: 'Motorrad', bicycle: 'Fahrrad', truck: 'LKW' };
const VMS_MODES = ['off', 'continuous', 'motion', 'ai'];
/** VMS object kinds -> livecam's groups (for detect.boxes, SmartView's overlay) */
const VMS_GROUP = { person: 'person', animal: 'animal', car: 'vehicle', truck: 'vehicle', motorcycle: 'vehicle', bicycle: 'vehicle' };

class Livecam extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'livecam' });
        this.sources = new Map();
        this.server = null;
        this.lastStatus = new Map();
        this.spawnFn = undefined; // injectable for tests
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.intercom = null;
        this.vms = null;
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const port = Number(this.config.port) || 8095;
        const host = (this.config.publicHost || '').trim() || localAddress();
        const key = (this.config.accessKey || '').trim();
        const query = key ? `?key=${encodeURIComponent(key)}` : '';
        const base = `http://${host}:${port}`;

        const cams = Array.isArray(this.config.cameras) ? [...this.config.cameras] : [];
        const used = new Set();
        const detectCams = [];
        this.urlBase = { base, query };
        // optional: cameras of the Andreas L.-Arts VMS (nothing changes without an address + key)
        await this.prepareVms(cams);
        for (const [i, cam] of cams.entries()) {
            if (cam.enabled === false) {
                continue;
            }
            let id = cameraId(cam.name, i);
            while (used.has(id)) {
                id = `${id}_${i + 1}`;
            }
            used.add(id);
            const problem = this.checkCamera(cam);
            if (problem) {
                this.log.error(`Camera "${cam.name || id}": ${problem}`);
                continue;
            }
            const vmsId = cam.type === 'vms' ? String(cam.vmsCamera || '').trim() : '';
            const source = new CameraSource(
                {
                    id,
                    name: cam.name || id,
                    type: cam.type || 'stream',
                    vmsId,
                    resolve: vmsId ? () => this.vms.live(vmsId) : undefined,
                    url: vmsId ? '' : completeUrl(cam.type || 'stream', cam.url, cam.host),
                    // ONVIF has its own port column; drop a port typed into the IP field.
                    host: (cam.host || '').trim().replace(/:\d+$/, ''),
                    onvifPort: Number(cam.onvifPort) || 80,
                    profile: Number(cam.profile) || 0,
                    user: cam.user || '',
                    password: cam.password || '',
                    fps: Number(cam.fps) || 5,
                    width: Number(cam.width) || 0,
                    keepAlive: Boolean(cam.keepAlive),
                    rtspTransport: cam.rtspTransport || 'tcp',
                },
                { log: this.log, ffmpegPath: (this.config.ffmpegPath || '').trim() || 'ffmpeg', spawnFn: this.spawnFn },
            );
            this.sources.set(id, source);
            if (cam.detect) {
                const groups = String(cam.detect).split(',').filter(g => GROUPS[g]);
                detectCams.push({ id, name: cam.name || id, groups, plates: Boolean(cam.plates) && groups.includes('vehicle'), faces: Boolean(cam.faces) && groups.includes('person') });
            }
            await this.createCameraObjects(id, cam.name || id);
            await this.setState(`cameras.${id}.mjpegUrl`, `${base}/cam/${id}.mjpeg${query}`, true);
            await this.setState(`cameras.${id}.snapshotUrl`, `${base}/cam/${id}.jpg${query}`, true);
            await this.setState(`cameras.${id}.online`, false, true);
            source.on('status', status => this.onStatus(id, status));
        }
        await this.removeStaleCameras(used);
        const view = await this.restoreView();

        const intercomCamera = await this.startIntercom(used);

        this.server = new CamServer({
            sources: this.sources,
            accessKey: key,
            log: this.log,
            intercom: this.intercom,
            intercomCamera,
            history: this.history,
            sound: {
                ringTone: this.config.ringTone || 'dingdong',
                ringToneUrl: (this.config.ringToneUrl || '').trim(),
                ringVolume: Number(this.config.ringVolume) || 70,
            },
            onToneSelect: (tone, volume) => this.onToneSelect(tone, volume).catch(err => this.log.warn(err.message)),
            detectDir: detectCams.length ? this.detectDir() : '',
            zones: {
                cameras: () => [...(this.watchers || new Map()).values()].map(w => ({ id: w.id, name: this.sources.get(w.id).cfg.name, zones: w.zones })),
                save: (id, zones) => this.saveZones(id, zones),
            },
            faces: this.faceApi(),
        });
        this.server.setView(view);
        this.subscribeStates('view.display');
        this.subscribeStates('view.ringTone');
        this.subscribeStates('view.ringVolume');
        this.subscribeStates('cameras.*.show');
        try {
            await this.server.listen(port);
        } catch (err) {
            this.log.error(`Cannot open port ${port}: ${err.message}. Choose another port in the settings.`);
            return;
        }
        await this.startDetection(detectCams);
        await this.startVms();
        await this.setState('info.connection', true, true);
        await this.setState('info.viewUrl', `${base}/view${query}`, true);
        await this.setState('info.tonesUrl', `${base}/tones${query}`, true);
        await this.setState('info.zonesUrl', this.watchers && this.watchers.size ? `${base}/zones${query}` : '', true);
        this.log.info(`Live images for ${this.sources.size} camera(s) at ${base}/${query}, camera wall at ${base}/view${query}`);
    }

    // ---------------- AI detection ----------------

    detectDir() {
        return path.join(this.dataDir || utils.getAbsoluteInstanceDataDir(this), 'detect');
    }

    /** One model for all cameras with "AI detection"; a Watcher per camera. */
    async startDetection(list) {
        this.watchers = new Map();
        const old = new Set();
        if (!list.length) {
            return;
        }
        fs.mkdirSync(this.detectDir(), { recursive: true });
        this.detector = new Detector({ log: this.log, loadRuntime: this.loadOrt });
        try {
            await this.detector.init();
        } catch (err) {
            this.log.error(`KI-Erkennung kann nicht starten: ${err.message}`);
            return;
        }
        const c = this.config;
        for (const cam of list) {
            if (!cam.groups.length) {
                continue;
            }
            await this.createDetectObjects(cam.id, cam.groups);
            const zoneState = await this.getStateAsync(`cameras.${cam.id}.detect.zones`).catch(() => null);
            const w = new Watcher({
                id: cam.id,
                source: this.sources.get(cam.id),
                detector: this.detector,
                log: this.log,
                groups: cam.groups,
                zones: parseZones(zoneState && zoneState.val),
                minScore: Math.min(0.95, Math.max(0.2, (Number(c.detectScore) || 55) / 100)),
                hold: Math.max(2, Number(c.detectHold) || 20) * 1000,
                interval: Math.max(0.3, Number(c.detectInterval) || 1) * 1000,
                ffmpegPath: (c.ffmpegPath || '').trim() || 'ffmpeg',
                spawnFn: this.spawnFn,
            });
            w.on('state', st => this.onDetectState(cam, st).catch(err => this.log.warn(err.message)));
            w.on('boxes', text => this.setState(`cameras.${cam.id}.detect.boxes`, text, true));
            w.on('detected', ev => this.onDetected(cam, ev).catch(err => this.log.warn(`${cam.name}: Foto: ${err.message}`)));
            w.on('error', msg => {
                if (!old.has(`${cam.id}:${msg}`)) {
                    old.add(`${cam.id}:${msg}`);
                    this.log.warn(`${cam.name}: Erkennung: ${msg}`);
                }
            });
            this.watchers.set(cam.id, w);
            w.start();
        }
        await this.startPlates(list.filter(cam => cam.plates && this.watchers.has(cam.id)));
        await this.startFaces(list.filter(cam => cam.faces && this.watchers.has(cam.id)));
        this.subscribeStates('cameras.*.detect.zones');
        this.log.info(`KI-Erkennung aktiv für ${[...this.watchers.keys()].join(', ')}`);
        // average time of one check, so the CPU load can be judged
        this.detectStats = setInterval(() => {
            if (this.detector && this.detector.runs) {
                this.setState('info.detectMs', this.detector.avgMs, true);
            }
            if (this.faceReader && this.faceReader.runs) {
                this.setState('info.faceMs', this.faceReader.avgMs, true);
            }
            if (this.plateReader && this.plateReader.runs) {
                this.setState('info.plateMs', this.plateReader.avgMs, true);
            }
        }, 60000);
    }

    async createDetectObjects(id, groups) {
        const words = { person: ['Person', 'person'], vehicle: ['Fahrzeug', 'vehicle'], animal: ['Tier', 'animal'] };
        await this.extendObject(`cameras.${id}.detect`, { type: 'channel', common: { name: { en: 'AI detection', de: 'KI-Erkennung' } }, native: {} });
        const states = {};
        for (const g of groups) {
            states[g] = { name: { en: `${words[g][1]} detected`, de: `${words[g][0]} erkannt` }, type: 'boolean', role: g === 'person' ? 'sensor.motion' : 'indicator', def: false };
            states[`${g}Count`] = { name: { en: `number of ${words[g][1]}s`, de: `Anzahl ${words[g][0]}` }, type: 'number', role: 'value', def: 0 };
        }
        Object.assign(states, {
            last: { name: { en: 'Last detection', de: 'Letzte Erkennung' }, type: 'string', role: 'text', def: '' },
            lastTime: { name: { en: 'Time of the last detection', de: 'Zeit der letzten Erkennung' }, type: 'string', role: 'date', def: '' },
            photoUrl: { name: { en: 'Photo of the last detection (with boxes)', de: 'Foto der letzten Erkennung (mit Rahmen)' }, type: 'string', role: 'url.cam', def: '' },
            boxes: { name: { en: 'Current boxes (JSON, fractions of the picture)', de: 'Aktuelle Rahmen (JSON, Anteile des Bildes)' }, type: 'string', role: 'json', def: '[]' },
        });
        for (const [key, common] of Object.entries(states)) {
            await this.extendObject(`cameras.${id}.detect.${key}`, { type: 'state', common: { ...common, read: true, write: false }, native: {} });
        }
        await this.extendObject(`cameras.${id}.detect.zones`, {
            type: 'state',
            common: { name: { en: 'Areas (JSON, set on the page /zones)', de: 'Bereiche (JSON, auf der Seite /zones einzeichnen)' }, type: 'string', role: 'json', read: true, write: true, def: '' },
            native: {},
        });
        // groups no longer chosen: remove their states
        for (const g of Object.keys(GROUPS).filter(x => !groups.includes(x))) {
            await this.delObjectAsync(`cameras.${id}.detect.${g}`).catch(() => {});
            await this.delObjectAsync(`cameras.${id}.detect.${g}Count`).catch(() => {});
        }
        await this.setState(`cameras.${id}.detect.boxes`, '[]', true);
        for (const g of groups) {
            await this.setState(`cameras.${id}.detect.${g}`, false, true);
            await this.setState(`cameras.${id}.detect.${g}Count`, 0, true);
        }
    }

    // ---------------- Andreas L.-Arts VMS (optional) ----------------

    vmsCacheFile() {
        try {
            return path.join(this.dataDir || utils.getAbsoluteInstanceDataDir(this), 'vms-cameras.json');
        } catch {
            return '';
        }
    }

    /**
     * Before the cameras are created: client, camera list (cached for starts while the VMS is down) and the cameras
     * taken over automatically ("Kameras von der VMS übernehmen") appended to `cams`.
     */
    async prepareVms(cams) {
        const c = this.config;
        const base = normalizeBase(c.vmsUrl);
        const key = String(c.vmsKey || '').trim();
        if (!base || !key) {
            if (base || key) {
                this.log.warn('VMS: Adresse und API-Schlüssel eintragen (Reiter „VMS“) – Anbindung bleibt aus');
            }
            return;
        }
        this.vms = new VmsClient({ base, key, log: this.log, timeout: 8000 });
        const file = this.vmsCacheFile();
        let list = null;
        try {
            const info = await this.vms.integration(true);
            list = info.cameras.map(x => ({ id: x.id, name: x.name || x.id, enabled: x.enabled !== false }));
            this.log.info(`VMS ${base}: ${list.length} Kamera(s), RTSP-Freigabe ${info.rtsp && info.rtsp.enabled ? 'an' : 'aus (Livebild als MJPEG)'}`);
            if (file) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(list));
            }
        } catch (err) {
            this.log.warn(`VMS ${base} beim Start nicht erreichbar (${err.message}) – livecam läuft trotzdem, Verbindung wird weiter versucht`);
            try {
                list = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
            } catch {
                list = null;
            }
        }
        this.vmsList = Array.isArray(list) ? list : [];
        if (!c.vmsImport) {
            return;
        }
        const inTable = new Set(cams.filter(x => x.type === 'vms').map(x => String(x.vmsCamera || '').trim()));
        let added = 0;
        for (const v of this.vmsList) {
            if (inTable.has(v.id)) {
                continue;
            }
            cams.push({ enabled: true, name: v.name, type: 'vms', vmsCamera: v.id, fps: Number(c.vmsFps) || 5, width: 0, vmsAuto: true });
            added++;
        }
        if (added) {
            this.log.info(`VMS: ${added} Kamera(s) automatisch übernommen`);
        }
    }

    /** VMS id -> object id part */
    vmsSlug(id) {
        return cameraId(id, 0);
    }

    async vmsCameraObjects(v) {
        const slug = this.vmsSlug(v.id);
        this.vmsIds = this.vmsIds || new Map();
        if (this.vmsIds.has(slug)) {
            return slug;
        }
        this.vmsIds.set(slug, v.id);
        const pre = `vms.cameras.${slug}`;
        await this.extendObject(pre, { type: 'channel', common: { name: v.name || v.id }, native: { vmsId: v.id } });
        const ro = {
            online: [{ en: 'Online', de: 'Online' }, 'boolean', 'indicator.reachable'],
            recording: [{ en: 'Recording', de: 'Nimmt auf' }, 'boolean', 'indicator'],
            motion: [{ en: 'Motion', de: 'Bewegung' }, 'boolean', 'sensor.motion'],
            lastEvent: [{ en: 'Last event (JSON)', de: 'Letztes Ereignis (JSON)' }, 'string', 'json'],
            lastEventKind: [{ en: 'Kind of the last event', de: 'Art des letzten Ereignisses' }, 'string', 'text'],
            lastEventTime: [{ en: 'Time of the last event', de: 'Zeit des letzten Ereignisses' }, 'string', 'date'],
            lastEventImage: [{ en: 'Photo of the last event (signed link, no key needed)', de: 'Foto des letzten Ereignisses (signierter Link, ohne Schlüssel)' }, 'string', 'url.cam'],
            lastPlate: [{ en: 'Last plate (own list of the VMS only)', de: 'Letztes Kennzeichen (nur aus den Listen der VMS)' }, 'string', 'text'],
            lastPlateName: [{ en: 'Name of the last plate', de: 'Name zum letzten Kennzeichen' }, 'string', 'text'],
            lastPlateKind: [{ en: 'Kind of the last plate (known / alarm / unknown)', de: 'Art des letzten Kennzeichens (known / alarm / unknown)' }, 'string', 'text'],
            rec: [{ en: 'Really recording now (REC)', de: 'Nimmt gerade wirklich auf (REC)' }, 'boolean', 'indicator'],
            faces: [{ en: 'Recognised people now (comma list)', de: 'Gerade erkannte Personen (Komma-Liste)' }, 'string', 'text'],
            facesLive: [{ en: 'Recognised people with liveness passed', de: 'Erkannte Personen mit bestandener Lebenderkennung' }, 'string', 'text'],
            spoof: [{ en: 'Photo / screen in front of the camera', de: 'Foto / Bildschirm vor der Kamera' }, 'boolean', 'indicator.alarm'],
            lastFace: [{ en: 'Last face (name, empty = unknown)', de: 'Letztes Gesicht (Name, leer = unbekannt)' }, 'string', 'text'],
            lastFaceLive: [{ en: 'Last face: liveness (true / false / null = not checked)', de: 'Letztes Gesicht: Lebenderkennung (true / false / null = ungeprüft)' }, 'boolean', 'indicator'],
            lastFaceTime: [{ en: 'Time of the last face', de: 'Zeit des letzten Gesichts' }, 'string', 'date'],
        };
        for (const k of VMS_KINDS) {
            ro[k] = [{ en: `${k} detected`, de: `${VMS_KIND_DE[k]} erkannt` }, 'boolean', k === 'person' ? 'sensor.motion' : 'indicator'];
        }
        for (const [key, [name, type, role]] of Object.entries(ro)) {
            await this.extendObject(`${pre}.${key}`, { type: 'state', common: { name, type, role, read: true, write: false }, native: {} });
        }
        await this.extendObject(`${pre}.recordMode`, {
            type: 'state',
            common: {
                name: { en: 'Recording mode (writes to the VMS)', de: 'Aufnahme-Modus (schaltet in der VMS)' },
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                states: { off: 'Aus', continuous: 'Dauernd', motion: 'Bei Bewegung', ai: 'Bei KI-Erkennung' },
            },
            native: {},
        });
        await this.extendObject(`${pre}.enabled`, {
            type: 'state',
            common: { name: { en: 'Camera on in the VMS (writes to the VMS)', de: 'Kamera in der VMS an (schaltet in der VMS)' }, type: 'boolean', role: 'switch.enable', read: true, write: true },
            native: {},
        });
        return slug;
    }

    /** after the web server: data points, settings of the cameras, live channel */
    async startVms() {
        if (!this.vms) {
            return;
        }
        const c = this.config;
        await this.extendObject('vms', { type: 'channel', common: { name: 'Andreas L.-Arts VMS' }, native: {} });
        await this.extendObject('vms.connection', {
            type: 'state',
            common: { name: { en: 'Connected to the VMS', de: 'Mit der VMS verbunden' }, type: 'boolean', role: 'indicator.connected', read: true, write: false },
            native: {},
        });
        await this.setState('vms.connection', false, true);
        if (!c.vmsEvents) {
            return;
        }
        await this.extendObject('vms.lastEvent', {
            type: 'state',
            common: { name: { en: 'Last event of all cameras (JSON)', de: 'Letztes Ereignis aller Kameras (JSON)' }, type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.extendObject('vms.cameras', { type: 'channel', common: { name: { en: 'Cameras of the VMS', de: 'Kameras der VMS' } }, native: {} });
        for (const v of this.vmsList || []) {
            await this.vmsCameraObjects(v);
        }
        this.subscribeStates('vms.cameras.*.recordMode');
        this.subscribeStates('vms.cameras.*.enabled');
        this.subscribeStates('vms.io.*.on');
        this.subscribeStates('vms.io.*.open');
        await this.extendObject('vms.presence', { type: 'channel', common: { name: { en: 'Presence (faces of the VMS)', de: 'Anwesenheit (Gesichter der VMS)' } }, native: {} });
        await this.extendObject('vms.io', { type: 'channel', common: { name: { en: 'Inputs / outputs of the VMS', de: 'Ein-/Ausgänge der VMS' } }, native: {} });
        await this.vmsBoxObjects();
        this.vms.on('connection', (on, why) => {
            this.setState('vms.connection', on, true);
            if (on) {
                this.log.info('VMS: Live-Kanal verbunden');
                this.vmsSettings().catch(err => this.log.debug(`VMS: Einstellungen: ${err.message}`));
                this.vmsIo().catch(err => this.log.debug(`VMS: Ein-/Ausgänge: ${err.message}`));
            } else {
                this.log.warn(`VMS: Live-Kanal getrennt (${why}) – neuer Versuch in ${Math.round(this.vms.backoff / 1000)} s`);
            }
        });
        this.vms.on('message', (event, data) => this.onVmsMessage(event, data).catch(err => this.log.warn(`VMS: ${event}: ${err.message}`)));
        this.vms.start();
    }

    /** record modes / enabled of the cameras (also for ones that are new in the VMS) */
    async vmsSettings() {
        const list = await this.vms.cameras();
        const arr = Array.isArray(list) ? list : list && Array.isArray(list.cameras) ? list.cameras : [];
        this.vmsCams = arr;
        for (const cam of arr) {
            if (!cam || !cam.id) {
                continue;
            }
            const slug = await this.vmsCameraObjects(cam);
            const mode = cam.record && cam.record.mode;
            if (mode) {
                await this.setState(`vms.cameras.${slug}.recordMode`, String(mode), true);
            }
            if (typeof cam.enabled === 'boolean') {
                await this.setState(`vms.cameras.${slug}.enabled`, cam.enabled, true);
            }
        }
    }

    // ---- boxes for SmartView: VMS cameras shown in livecam get cameras.<id>.detect.boxes / person / vehicle / animal ----

    /** livecam cameras showing a VMS camera without livecam's own AI: VMS id -> [livecam ids] */
    async vmsBoxObjects() {
        this.vmsBoxCams = new Map();
        for (const src of this.sources.values()) {
            const vid = src.cfg.vmsId;
            if (!vid || (this.watchers && this.watchers.has(src.id))) {
                continue;
            }
            this.vmsBoxCams.set(vid, [...(this.vmsBoxCams.get(vid) || []), src.id]);
            const pre = `cameras.${src.id}.detect`;
            await this.extendObject(pre, { type: 'channel', common: { name: { en: 'AI detection (from the VMS)', de: 'KI-Erkennung (von der VMS)' } }, native: {} });
            const st = {
                boxes: [{ en: 'Current boxes (JSON, fractions of the picture)', de: 'Aktuelle Rahmen (JSON, Anteile des Bildes)' }, 'string', 'json', '[]'],
                person: [{ en: 'Person detected', de: 'Person erkannt' }, 'boolean', 'sensor.motion', false],
                vehicle: [{ en: 'Vehicle detected', de: 'Fahrzeug erkannt' }, 'boolean', 'indicator', false],
                animal: [{ en: 'Animal detected', de: 'Tier erkannt' }, 'boolean', 'indicator', false],
                photoUrl: [{ en: 'Photo of the last event (VMS, signed link)', de: 'Foto des letzten Ereignisses (VMS, signierter Link)' }, 'string', 'url.cam', ''],
            };
            for (const [key, [name, type, role, def]] of Object.entries(st)) {
                await this.extendObject(`${pre}.${key}`, { type: 'state', common: { name, type, role, read: true, write: false, def }, native: {} });
            }
            await this.setState(`${pre}.boxes`, '[]', true);
        }
    }

    async vmsBoxes(vid, boxes) {
        const ids = this.vmsBoxCams && this.vmsBoxCams.get(vid);
        if (!ids || !Array.isArray(boxes)) {
            return;
        }
        const r = v => Math.round(Number(v) * 1000) / 1000;
        const list = boxes
            .filter(b => b && VMS_GROUP[b.kind])
            .slice(0, 20)
            .map(b => ({ g: VMS_GROUP[b.kind], l: b.name || b.label || VMS_KIND_DE[b.kind] || b.kind, s: Math.round((Number(b.score) || 0) * 100), x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h), ...(b.still ? { st: 1 } : {}) }));
        const text = JSON.stringify(list);
        for (const id of ids) {
            await this.setState(`cameras.${id}.detect.boxes`, text, true);
            for (const g of ['person', 'vehicle', 'animal']) {
                await this.setState(`cameras.${id}.detect.${g}`, list.some(b => b.g === g), true);
            }
        }
    }

    // ---- presence: vms.presence.<name> while a camera of the VMS sees the person ----

    async vmsPresence(camSlug, camName, faces) {
        this.vmsFaces = this.vmsFaces || new Map();
        this.vmsFaces.set(camSlug, { name: camName, faces: faces.map(String).filter(Boolean) });
        const now = new Map(); // name -> camera name
        for (const { name, faces: f } of this.vmsFaces.values()) {
            for (const n of f) {
                now.set(n, name);
            }
        }
        this.vmsHere = this.vmsHere || new Map(); // slug -> name
        for (const [n, cam] of now) {
            const slug = cameraId(n, 0);
            if (!this.vmsHere.has(slug)) {
                await this.extendObject(`vms.presence.${slug}`, { type: 'channel', common: { name: n }, native: {} });
                const st = {
                    present: [{ en: 'Is there', de: 'Ist da' }, 'boolean', 'sensor.motion'],
                    lastSeen: [{ en: 'Last seen', de: 'Zuletzt gesehen' }, 'string', 'date'],
                    lastCamera: [{ en: 'Last camera', de: 'Letzte Kamera' }, 'string', 'text'],
                };
                for (const [key, [name, type, role]] of Object.entries(st)) {
                    await this.extendObject(`vms.presence.${slug}.${key}`, { type: 'state', common: { name, type, role, read: true, write: false }, native: {} });
                }
                await this.setState(`vms.presence.${slug}.present`, true, true);
                this.vmsHere.set(slug, n);
            }
            await this.setState(`vms.presence.${slug}.lastSeen`, new Date().toISOString(), true);
            await this.setState(`vms.presence.${slug}.lastCamera`, cam, true);
        }
        for (const [slug, n] of this.vmsHere) {
            if (!now.has(n)) {
                this.vmsHere.delete(slug);
                await this.setState(`vms.presence.${slug}.present`, false, true);
            }
        }
    }

    // ---- inputs / outputs: vms.io.<channel> ----

    async vmsIoObjects(id, ch) {
        this.vmsIoIds = this.vmsIoIds || new Map();
        const slug = String(id).replace(/[^A-Za-z0-9_-]/g, '_') || '_';
        const door = Boolean(ch.door);
        const writable = !door && ['output', 'virtual'].includes(String(ch.kind || ''));
        const known = this.vmsIoIds.get(slug);
        if (known && known.door === door && known.writable === writable) {
            return slug;
        }
        this.vmsIoIds.set(slug, { id, door, writable });
        const pre = `vms.io.${slug}`;
        await this.extendObject(pre, { type: 'channel', common: { name: ch.name || id }, native: { channel: id } });
        await this.extendObject(`${pre}.name`, { type: 'state', common: { name: 'Name', type: 'string', role: 'text', read: true, write: false }, native: {} });
        await this.extendObject(`${pre}.kind`, { type: 'state', common: { name: { en: 'Kind (input / output / virtual)', de: 'Art (input / output / virtual)' }, type: 'string', role: 'text', read: true, write: false }, native: {} });
        await this.extendObject(`${pre}.door`, { type: 'state', common: { name: { en: 'Door opener', de: 'Türöffner' }, type: 'boolean', role: 'indicator', read: true, write: false }, native: {} });
        await this.extendObject(`${pre}.on`, {
            type: 'state',
            common: {
                name: writable ? { en: 'On (switches in the VMS)', de: 'An (schaltet in der VMS)' } : { en: 'On', de: 'An' },
                type: 'boolean',
                role: writable ? 'switch' : 'sensor',
                read: true,
                write: writable,
            },
            native: {},
        });
        if (door) {
            // a door opener only as a button with a pulse, never permanently on
            await this.extendObject(`${pre}.open`, {
                type: 'state',
                common: { name: { en: 'Open the door (pulse)', de: 'Tür öffnen (Impuls)' }, type: 'boolean', role: 'button', read: false, write: true },
                native: {},
            });
        } else {
            await this.delObjectAsync(`${pre}.open`).catch(() => {});
        }
        return slug;
    }

    async vmsIoValue(id, ch) {
        const slug = await this.vmsIoObjects(id, ch);
        if (ch.name !== undefined) {
            await this.setState(`vms.io.${slug}.name`, String(ch.name || id), true);
        }
        if (ch.kind !== undefined) {
            await this.setState(`vms.io.${slug}.kind`, String(ch.kind || ''), true);
        }
        await this.setState(`vms.io.${slug}.door`, Boolean(ch.door), true);
        if (typeof ch.on === 'boolean') {
            await this.setState(`vms.io.${slug}.on`, ch.on, true);
        }
    }

    async vmsIo() {
        let all;
        try {
            all = await this.vms.ioState();
        } catch (err) {
            if (err.status === 404) {
                return; // VMS without inputs / outputs
            }
            throw err;
        }
        for (const [id, ch] of Object.entries(all || {})) {
            if (ch && typeof ch === 'object') {
                await this.vmsIoValue(id, ch);
            }
        }
    }

    /** vms.io.<ch>.on / .open written in ioBroker -> POST /api/io/channels/<ch>/set */
    async vmsIoWrite(slug, key, val) {
        const ch = this.vmsIoIds && this.vmsIoIds.get(slug);
        if (!this.vms || !ch) {
            return;
        }
        const on = val === true || val === 'true' || val === 1;
        if (key === 'open' ? !ch.door || !on : !ch.writable) {
            if (key === 'on' && !ch.writable) {
                this.log.warn(`VMS: ${ch.id} kann man nicht schalten${ch.door ? ' (Türöffner: Datenpunkt open)' : ' (Eingang)'}`);
            }
            const st = await this.getStateAsync(`vms.io.${slug}.on`).catch(() => null);
            if (key === 'on') {
                await this.setState(`vms.io.${slug}.on`, st && st.ack ? st.val : null, true);
            }
            return;
        }
        const action = key === 'open' ? 'pulse' : on ? 'on' : 'off';
        try {
            await this.vms.ioSet(ch.id, action);
            this.log.info(`VMS: ${ch.id} ${action === 'pulse' ? 'Tür geöffnet (Impuls)' : action === 'on' ? 'ein' : 'aus'}`);
            if (key === 'on') {
                await this.setState(`vms.io.${slug}.on`, on, true);
            }
        } catch (err) {
            this.log.warn(`VMS: ${ch.id} nicht geschaltet: ${err.message}`);
        }
        if (key === 'open') {
            await this.setState(`vms.io.${slug}.open`, false, true);
        }
    }

    async onVmsMessage(event, d) {
        if (event === 'io') {
            if (d && d.channel) {
                const known = this.vmsIoIds && [...this.vmsIoIds.values()].find(x => x.id === d.channel);
                await this.vmsIoValue(String(d.channel), { name: d.name, kind: d.kind, door: d.door !== undefined ? d.door : known && known.door, on: d.on });
            }
            return;
        }
        if (!d || typeof d !== 'object' || !d.camera) {
            return;
        }
        const slug = await this.vmsCameraObjects({ id: String(d.camera), name: d.camera_name || d.name || String(d.camera) });
        const pre = `vms.cameras.${slug}`;
        if (event === 'state') {
            for (const k of ['online', 'recording', 'motion', 'enabled']) {
                if (typeof d[k] === 'boolean') {
                    await this.setState(`${pre}.${k}`, d[k], true);
                }
            }
            const objects = Array.isArray(d.objects) ? d.objects : [];
            for (const k of VMS_KINDS) {
                await this.setState(`${pre}.${k}`, objects.includes(k), true);
            }
            if (typeof d.rec === 'boolean') {
                await this.setState(`${pre}.rec`, d.rec, true);
            }
            if (Array.isArray(d.faces)) {
                await this.setState(`${pre}.faces`, d.faces.join(', '), true);
                await this.vmsPresence(slug, d.name || String(d.camera), d.faces);
            }
            if (Array.isArray(d.faces_live)) {
                await this.setState(`${pre}.facesLive`, d.faces_live.join(', '), true);
            }
            if (typeof d.spoof === 'boolean') {
                await this.setState(`${pre}.spoof`, d.spoof, true);
            }
            if (Array.isArray(d.boxes)) {
                await this.vmsBoxes(String(d.camera), d.boxes);
            }
            return;
        }
        if (event === 'face') {
            const live = d.face_live === true ? true : d.face_live === false ? false : null;
            await this.setState(`${pre}.lastFace`, typeof d.face === 'string' ? d.face : '', true);
            await this.setState(`${pre}.lastFaceLive`, live, true);
            await this.setState(`${pre}.lastFaceTime`, Number(d.start) > 0 ? new Date(Number(d.start) * 1000).toISOString() : new Date().toISOString(), true);
            if (live === false) {
                this.log.warn(`VMS: ${d.camera_name || d.camera}: Foto oder Bildschirm vor der Kamera?`);
            }
            return;
        }
        if (event !== 'event' && event !== 'plate') {
            return;
        }
        const base = this.vms.base;
        const full = u => (u && typeof u === 'string' ? (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`) : '');
        // plates: only those on a list of the VMS (known / alarm) as text - others stay unknown, like livecam's own reading
        const listed = d.plate_kind === 'known' || d.plate_kind === 'alarm';
        const ev = { ...d, image: full(d.image), playback: full(d.playback) };
        if (d.plate && !listed) {
            ev.plate = '';
            ev.plate_name = null;
        }
        if (d.plate || event === 'plate') {
            await this.setState(`${pre}.lastPlate`, listed ? String(d.plate || '') : '', true);
            await this.setState(`${pre}.lastPlateName`, listed ? String(d.plate_name || '') : '', true);
            await this.setState(`${pre}.lastPlateKind`, listed ? d.plate_kind : 'unknown', true);
        }
        if (event === 'plate') {
            return;
        }
        const time = Number(d.start) > 0 ? new Date(Number(d.start) * 1000).toISOString() : new Date().toISOString();
        const json = JSON.stringify(ev);
        await this.setState(`${pre}.lastEvent`, json, true);
        await this.setState(`${pre}.lastEventKind`, String(d.kind || ''), true);
        await this.setState(`${pre}.lastEventTime`, time, true);
        await this.setState(`${pre}.lastEventImage`, ev.image, true);
        await this.setState('vms.lastEvent', json, true);
        // SmartView takes the photo of a detection from detect.photoUrl
        for (const id of (this.vmsBoxCams && this.vmsBoxCams.get(String(d.camera))) || []) {
            if (ev.image) {
                await this.setState(`cameras.${id}.detect.photoUrl`, ev.image, true);
            }
        }
    }

    /** recordMode / enabled written in ioBroker -> PUT /api/cameras/<id> */
    async vmsWrite(slug, key, val) {
        const id = this.vmsIds && this.vmsIds.get(slug);
        const back = async () => {
            const st = await this.getStateAsync(`vms.cameras.${slug}.${key}`).catch(() => null);
            await this.setState(`vms.cameras.${slug}.${key}`, st && st.ack ? st.val : null, true);
        };
        if (!this.vms || !id) {
            return;
        }
        let body;
        if (key === 'recordMode') {
            const mode = String(val);
            if (!VMS_MODES.includes(mode)) {
                this.log.warn(`VMS: Aufnahme-Modus "${mode}" gibt es nicht (${VMS_MODES.join(', ')})`);
                return;
            }
            body = { record: { mode } };
        } else {
            body = { enabled: val === true || val === 'true' || val === 1 };
        }
        try {
            await this.vms.setCamera(id, body);
            this.log.info(`VMS: ${id} ${key === 'recordMode' ? `Aufnahme-Modus ${body.record.mode}` : body.enabled ? 'eingeschaltet' : 'ausgeschaltet'}`);
            await this.setState(`vms.cameras.${slug}.${key}`, key === 'recordMode' ? body.record.mode : body.enabled, true);
        } catch (err) {
            this.log.warn(`VMS: ${id} nicht geschaltet: ${err.message}`);
            await back();
        }
    }

    /**
     * The door station rings: tell the VMS (photo, keeps the recording, push). VMS camera = setting, else the VMS
     * camera behind the livecam camera of the station, else the VMS camera with the IP of the station.
     */
    async vmsRing(livecamCamera, stations) {
        let target = String(this.config.vmsRingCamera || '').trim();
        if (!target) {
            const src = this.sources.get(livecamCamera);
            target = (src && src.cfg.vmsId) || '';
        }
        if (!target) {
            const st = (stations || []).find(x => x.camera === livecamCamera) || (stations || [])[0];
            const ip = st && st.host;
            if (ip) {
                const list = this.vmsCams || (await this.vms.cameras().catch(() => []));
                const arr = Array.isArray(list) ? list : (list && list.cameras) || [];
                const hit = arr.find(x => x && x.id && new RegExp(`(^|[^\\d.])${ip.replace(/\./g, '\\.')}([^\\d.]|$)`).test(JSON.stringify(x)));
                target = hit ? hit.id : '';
            }
        }
        if (!target) {
            this.log.warn('VMS: Klingeln nicht gemeldet – keine VMS-Kamera für die Tür gefunden (Reiter „VMS“ → Kamera der Tür)');
            return;
        }
        const r = await this.vms.external(target, 'ring', 60);
        this.log.info(`VMS: Klingeln an ${target} gemeldet${r && r.id ? ` (Ereignis ${r.id})` : ''}`);
    }

    /** admin: list of the VMS cameras for the camera table / ring camera */
    async onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) {
            return;
        }
        if (obj.command === 'vmsCameras') {
            let list = [];
            try {
                const info = this.vms ? await this.vms.integration(true) : null;
                list = info ? info.cameras.map(x => ({ label: `${x.name || x.id} (${x.id})`, value: x.id })) : [];
            } catch (err) {
                this.log.warn(`VMS: Kameraliste: ${err.message}`);
            }
            if (!list.length) {
                list = (this.vmsList || []).map(x => ({ label: `${x.name} (${x.id})`, value: x.id }));
            }
            this.sendTo(obj.from, obj.command, list, obj.callback);
        }
    }

    // ---------------- number plates (own vehicles only) ----------------

    /** Plate reading for cameras with the column "Kennzeichen" (needs vehicle detection). */
    async startPlates(list) {
        this.plateCams = new Map(list.map(cam => [cam.id, cam]));
        this.knownPlates = parseKnown(this.config.plates);
        const slugs = new Set();
        for (const k of this.knownPlates) {
            let slug = cameraId(k.name, 0);
            while (slugs.has(slug)) {
                slug += '_';
            }
            slugs.add(slug);
            k.slug = slug;
        }
        // own vehicles: plates.<name>.present / lastSeen / camera (also without a camera, so the objects exist)
        const old = await this.getObjectViewAsync('system', 'channel', { startkey: `${this.namespace}.plates.`, endkey: `${this.namespace}.plates.\u9999` }).catch(() => ({ rows: [] }));
        for (const row of old.rows) {
            const slug = row.id.split('.').pop();
            if (!slugs.has(slug)) {
                await this.delObjectAsync(`plates.${slug}`, { recursive: true }).catch(() => {});
            }
        }
        for (const k of this.knownPlates) {
            await this.extendObject(`plates.${k.slug}`, { type: 'channel', common: { name: k.name }, native: {} });
            const states = {
                present: { name: { en: 'Vehicle is there (plate read)', de: 'Fahrzeug ist da (Kennzeichen gelesen)' }, type: 'boolean', role: 'sensor.motion', def: false },
                lastSeen: { name: { en: 'Last seen', de: 'Zuletzt gesehen' }, type: 'string', role: 'date', def: '' },
                camera: { name: { en: 'Camera', de: 'Kamera' }, type: 'string', role: 'text', def: '' },
            };
            for (const [key, common] of Object.entries(states)) {
                await this.extendObject(`plates.${k.slug}.${key}`, { type: 'state', common: { ...common, read: true, write: false }, native: {} });
            }
            await this.setState(`plates.${k.slug}.present`, false, true);
        }
        for (const cam of list) {
            const states = {
                plate: { name: { en: 'Vehicle (name from the list of plates)', de: 'Fahrzeug (Name aus der Kennzeichen-Liste)' }, type: 'string', role: 'text', def: '' },
                plateKnown: { name: { en: 'Own vehicle recognised', de: 'Eigenes Fahrzeug erkannt' }, type: 'boolean', role: 'indicator', def: false },
                plateTime: { name: { en: 'Time of the reading', de: 'Zeit der Erkennung' }, type: 'string', role: 'date', def: '' },
            };
            for (const [key, common] of Object.entries(states)) {
                await this.extendObject(`cameras.${cam.id}.detect.${key}`, { type: 'state', common: { ...common, read: true, write: false }, native: {} });
            }
            await this.setState(`cameras.${cam.id}.detect.plate`, '', true);
            await this.setState(`cameras.${cam.id}.detect.plateKnown`, false, true);
        }
        if (!list.length) {
            return;
        }
        if (!this.knownPlates.length && !this.config.plateUnknown) {
            this.log.warn('Kennzeichen: die Liste der eigenen Kennzeichen ist leer – es wird nichts gemeldet');
        }
        this.plateReader = new PlateReader({ detector: this.detector, log: this.log, ffmpegPath: (this.config.ffmpegPath || '').trim() || 'ffmpeg', spawnFn: this.spawnFn });
        try {
            await this.plateReader.init();
        } catch (err) {
            this.log.error(`Kennzeichen-Erkennung kann nicht starten: ${err.message}`);
            this.plateReader = null;
            return;
        }
        this.plateRuns = new Map();
        this.log.info(`Kennzeichen-Erkennung aktiv für ${list.map(c => c.name).join(', ')} (${this.knownPlates.length} eigene Kennzeichen)`);
    }

    /**
     * While a vehicle is there: read the plate every `plateEvery` ms, at most `plateTries` times, until an own plate
     * is found. Readings that are not on the list are dropped (never stored or logged).
     */
    async plateSession(cam) {
        // one session per appearance of a vehicle (a new count while it is there does not start another one)
        this.plateDone = this.plateDone || new Set();
        if (!this.plateReader || this.plateRuns.get(cam.id) || this.plateDone.has(cam.id)) {
            return;
        }
        this.plateDone.add(cam.id);
        const run = { stop: false };
        this.plateRuns.set(cam.id, run);
        const w = this.watchers.get(cam.id);
        const tries = this.plateTries || 8;
        let unknown = 0;
        let read = 0;
        try {
            for (let i = 0; i < tries && !run.stop && !this.unloading; i++) {
                if (i) {
                    await new Promise(r => setTimeout(r, this.plateEvery || 2000));
                }
                if (run.stop || !w.state.vehicle || !w.state.vehicle.on) {
                    break;
                }
                let jpeg;
                try {
                    jpeg = await this.sources.get(cam.id).getFrame(2000, 8000);
                } catch (err) {
                    this.log.debug(`${cam.name}: Kennzeichen: kein Bild (${err.message})`);
                    continue;
                }
                const orig = jpegSize(jpeg);
                if (!orig) {
                    continue;
                }
                let areas = [];
                try {
                    areas = JSON.parse(w.lastBoxes || '[]').filter(b => b.g === 'vehicle');
                } catch {
                    // whole picture
                }
                areas.sort((a, b) => b.w * b.h - a.w * a.h);
                const readings = await this.plateReader.read(jpeg, orig, areas);
                let found = null;
                for (const r of readings) {
                    if (r.text.length < 3 || r.prob < 0.6) {
                        continue;
                    }
                    read++;
                    const m = matchPlate(r.text, this.knownPlates);
                    if (m) {
                        found = { ...m, prob: r.prob };
                        break;
                    }
                    if (r.prob >= 0.8 && r.text.length >= 4) {
                        unknown++;
                    }
                }
                if (found) {
                    await this.onPlate(cam, found);
                    return;
                }
            }
            if (unknown && this.config.plateUnknown) {
                await this.setState(`cameras.${cam.id}.detect.plate`, 'unbekannt', true);
                await this.setState(`cameras.${cam.id}.detect.plateTime`, new Date().toISOString(), true);
                this.log.info(`${cam.name}: Fahrzeug mit unbekanntem Kennzeichen`);
            } else if (!read) {
                this.log.debug(`${cam.name}: kein Kennzeichen lesbar`);
            }
        } finally {
            this.plateRuns.delete(cam.id);
        }
    }

    async onPlate(cam, m) {
        const k = this.knownPlates.find(x => x.plate === m.plate);
        const now = new Date().toISOString();
        await this.setState(`cameras.${cam.id}.detect.plate`, m.name, true);
        await this.setState(`cameras.${cam.id}.detect.plateKnown`, true, true);
        await this.setState(`cameras.${cam.id}.detect.plateTime`, now, true);
        if (k) {
            await this.setState(`plates.${k.slug}.present`, true, true);
            await this.setState(`plates.${k.slug}.lastSeen`, now, true);
            await this.setState(`plates.${k.slug}.camera`, cam.name, true);
            this.platePresent = this.platePresent || new Map();
            this.platePresent.set(k.slug, cam.id);
        }
        this.log.info(`${cam.name}: eigenes Fahrzeug erkannt – ${m.name}${m.dist ? ' (ein Zeichen anders gelesen)' : ''}, Sicherheit ${Math.round(m.prob * 100)} %`);
    }

    /** vehicle gone at a camera: its own-vehicle states go off */
    async plateGone(cam) {
        const run = this.plateRuns && this.plateRuns.get(cam.id);
        if (run) {
            run.stop = true;
        }
        if (this.plateDone) {
            this.plateDone.delete(cam.id);
        }
        await this.setState(`cameras.${cam.id}.detect.plateKnown`, false, true);
        for (const [slug, camId] of this.platePresent || []) {
            if (camId === cam.id) {
                this.platePresent.delete(slug);
                await this.setState(`plates.${slug}.present`, false, true);
            }
        }
    }

    // ---------------- faces of the household (own people only) ----------------

    faceCfg() {
        const c = this.config;
        const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
        return {
            match: Math.min(0.9, Math.max(0.3, num(c.faceMatch, 45) / 100)),
            live: c.faceLive !== false,
            liveMin: Math.min(0.99, Math.max(0.3, num(c.faceLiveMin, 80) / 100)),
            minSize: Math.max(30, num(c.faceMinSize, 50)),
            unknown: Boolean(c.faceUnknown),
        };
    }

    /** API for the page /faces (lib/server.js); works once a camera has face recognition */
    faceApi() {
        const need = () => {
            if (!this.faceStore || !this.faceReader) {
                throw new Error('Gesichtserkennung ist bei keiner Kamera eingeschaltet');
            }
        };
        const changed = () => this.facePersons().catch(err => this.log.warn(`Gesichter: ${err.message}`));
        return {
            enabled: () => Boolean(this.faceStore),
            list: () => (need(), this.faceStore.list()),
            cameras: () => [...this.sources.values()].map(s => ({ id: s.id, name: s.cfg.name })),
            add: (name, door) => {
                need();
                const p = this.faceStore.add(name, door);
                this.log.info(`Gesichter: Person "${p.name}" angelegt${p.door ? ' (darf Tür öffnen)' : ''}`);
                changed();
                return { id: p.id };
            },
            update: (id, b) => {
                need();
                const p = this.faceStore.update(id, b || {});
                if (b && b.door !== undefined) {
                    this.log.info(`Gesichter: "${p.name}" darf Tür öffnen: ${p.door ? 'ja' : 'nein'}`);
                }
                changed();
                return { ok: true };
            },
            remove: id => {
                need();
                const p = this.faceStore.get(id);
                this.faceStore.remove(id);
                this.log.info(`Gesichter: Person "${p ? p.name : id}" mit allen Bildern gelöscht`);
                changed();
                return { ok: true };
            },
            removeSample: (id, sid) => (need(), this.faceStore.removeSample(id, sid), { ok: true }),
            photo: (id, sid) => (this.faceStore ? this.faceStore.photo(id, sid) : null),
            addPhoto: async (id, jpeg) => {
                need();
                const orig = jpegSize(jpeg);
                if (!orig) {
                    throw new Error('kein JPEG-Bild');
                }
                const faces = await this.faceReader.read(jpeg, orig, null, { minSize: 40, max: 1 });
                if (!faces.length) {
                    throw new Error('kein Gesicht gefunden (Gesicht mindestens 40 Pixel, von vorne)');
                }
                const f = faces.sort((a, b) => b.size - a.size)[0];
                await this.faceSample(id, f);
                return { ok: true, faces: faces.length, size: f.size };
            },
            learn: (id, camera) => (need(), this.faceLearn(id, camera)),
        };
    }

    async faceSample(id, f) {
        const thumb = await this.ffmpegImage(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '112x112', '-i', 'pipe:0'], Buffer.from(f.face)).catch(() => null);
        this.faceStore.addSample(id, f.embed, thumb);
    }

    /** live at a camera: 15 s, up to 5 new samples (big enough, alive, not too similar to the ones already there) */
    async faceLearn(id, camera) {
        const p = this.faceStore.get(id);
        const src = this.sources.get(String(camera || ''));
        if (!p || !src) {
            throw new Error(!p ? 'Person gibt es nicht' : 'Kamera gibt es nicht');
        }
        const cfg = this.faceCfg();
        const end = Date.now() + (this.faceLearnMs || 15000);
        let added = 0;
        let seen = 0;
        let fake = 0;
        while (Date.now() < end && added < 5 && (p.samples || []).length < 20) {
            const jpeg = await src.getFrame(1500, 8000).catch(() => null);
            const orig = jpeg && jpegSize(jpeg);
            if (orig) {
                const faces = (await this.faceReader.read(jpeg, orig, null, { minSize: 60, max: 1 })).sort((a, b) => b.size - a.size);
                const f = faces[0];
                if (f) {
                    seen++;
                    if (cfg.live && f.live !== null && f.live < cfg.liveMin) {
                        fake++;
                    } else if ((p.embeds || []).every(e => cosine(e, f.embed) < 0.92)) {
                        await this.faceSample(id, f);
                        added++;
                    }
                }
            }
            await new Promise(r => setTimeout(r, this.faceLearnGap === undefined ? 700 : this.faceLearnGap));
        }
        this.log.info(`Gesichter: "${p.name}" an ${src.cfg.name} eingelernt: ${added} neue(s) Bild(er)`);
        const hint = !seen ? 'kein Gesicht gesehen (näher hin, Gesicht mindestens 60 Pixel)' : fake && !added ? 'Lebenderkennung nicht bestanden (Licht? Gegenlicht?)' : !added ? 'keine neuen Ansichten (Kopf etwas drehen)' : '';
        return { added, seen, hint };
    }

    async startFaces(list) {
        this.faceCams = new Map(list.map(cam => [cam.id, cam]));
        if (!list.length) {
            return;
        }
        const dir = path.join(this.dataDir || utils.getAbsoluteInstanceDataDir(this), 'faces');
        this.faceStore = new FaceStore(dir, { log: this.log });
        for (const cam of list) {
            const states = {
                face: { name: { en: 'Person recognised (name from /faces, or unbekannt)', de: 'Erkannte Person (Name von /faces, oder unbekannt)' }, type: 'string', role: 'text', def: '' },
                faceKnown: { name: { en: 'Own person recognised (alive)', de: 'Eigene Person erkannt (lebend)' }, type: 'boolean', role: 'indicator', def: false },
                faceDoor: { name: { en: 'Door release: person may open, alive, recognised twice', de: 'Tür-Freigabe: Person darf öffnen, lebend, zweimal erkannt' }, type: 'boolean', role: 'indicator', def: false },
                faceScore: { name: { en: 'Similarity', de: 'Ähnlichkeit' }, type: 'number', role: 'value', unit: '%', def: 0 },
                faceLive: { name: { en: 'Liveness', de: 'Lebenderkennung' }, type: 'number', role: 'value', unit: '%', def: 0 },
                faceTime: { name: { en: 'Time of the recognition', de: 'Zeit der Erkennung' }, type: 'string', role: 'date', def: '' },
            };
            for (const [key, common] of Object.entries(states)) {
                await this.extendObject(`cameras.${cam.id}.detect.${key}`, { type: 'state', common: { ...common, read: true, write: false }, native: {} });
            }
            await this.setState(`cameras.${cam.id}.detect.face`, '', true);
            await this.setState(`cameras.${cam.id}.detect.faceKnown`, false, true);
            await this.setState(`cameras.${cam.id}.detect.faceDoor`, false, true);
        }
        this.faceReader = new FaceReader({ detector: this.detector, log: this.log, ffmpegPath: (this.config.ffmpegPath || '').trim() || 'ffmpeg', spawnFn: this.spawnFn });
        try {
            await this.faceReader.init();
        } catch (err) {
            this.log.error(`Gesichtserkennung kann nicht starten: ${err.message}`);
            this.faceReader = null;
            return;
        }
        this.faceRuns = new Map();
        this.faceDone = new Set();
        await this.facePersons();
        const { base, query } = this.urlBase;
        await this.setState('info.facesUrl', `${base}/faces${query}`, true);
        this.log.info(`Gesichtserkennung aktiv für ${list.map(c => c.name).join(', ')} (${this.faceStore.persons.length} Person(en), einlernen auf ${base}/faces${query ? '?key=…' : ''})`);
    }

    /** faces.<person>.present / lastSeen / camera - follow the list on /faces */
    async facePersons() {
        if (!this.faceStore) {
            return;
        }
        await this.extendObject('faces', { type: 'channel', common: { name: { en: 'Recognised people', de: 'Erkannte Personen' } }, native: {} });
        const slugs = new Map();
        for (const p of this.faceStore.persons) {
            let slug = cameraId(p.name, 0);
            while ([...slugs.values()].includes(slug)) {
                slug += '_';
            }
            slugs.set(p.id, slug);
        }
        this.faceSlugs = slugs;
        const old = await this.getObjectViewAsync('system', 'channel', { startkey: `${this.namespace}.faces.`, endkey: `${this.namespace}.faces.\u9999` }).catch(() => ({ rows: [] }));
        const want = new Set(slugs.values());
        for (const row of old.rows) {
            const slug = row.id.split('.').pop();
            if (!want.has(slug)) {
                await this.delObjectAsync(`faces.${slug}`, { recursive: true }).catch(() => {});
            }
        }
        for (const p of this.faceStore.persons) {
            const slug = slugs.get(p.id);
            await this.extendObject(`faces.${slug}`, { type: 'channel', common: { name: p.name }, native: { id: p.id } });
            const states = {
                present: { name: { en: 'Is there (face recognised)', de: 'Ist da (Gesicht erkannt)' }, type: 'boolean', role: 'sensor.motion', def: false },
                lastSeen: { name: { en: 'Last seen', de: 'Zuletzt gesehen' }, type: 'string', role: 'date', def: '' },
                camera: { name: { en: 'Camera', de: 'Kamera' }, type: 'string', role: 'text', def: '' },
            };
            for (const [key, common] of Object.entries(states)) {
                await this.extendObject(`faces.${slug}.${key}`, { type: 'state', common: { ...common, read: true, write: false }, native: {} });
            }
            const st = await this.getStateAsync(`faces.${slug}.present`).catch(() => null);
            if (!st) {
                await this.setState(`faces.${slug}.present`, false, true);
            }
        }
    }

    /**
     * While a person is there: look for faces every `faceEvery` ms, at most `faceTries` times. Own people are
     * reported by name when alive; a person who may open the door additionally gets `faceDoor` after two recognitions
     * in a row (liveness must be on). Faces not on the list are never stored or logged.
     */
    async faceSession(cam) {
        if (!this.faceReader || this.faceRuns.get(cam.id) || this.faceDone.has(cam.id)) {
            return;
        }
        this.faceDone.add(cam.id);
        const run = { stop: false };
        this.faceRuns.set(cam.id, run);
        const w = this.watchers.get(cam.id);
        const cfg = this.faceCfg();
        let unknown = 0;
        let fakeWarned = false;
        let reported = null;
        let last = null;
        let row = 0;
        try {
            for (let i = 0; i < (this.faceTries || 10) && !run.stop && !this.unloading; i++) {
                if (i) {
                    await new Promise(r => setTimeout(r, this.faceEvery || 1500));
                }
                if (run.stop || !w.state.person || !w.state.person.on) {
                    break;
                }
                const jpeg = await this.sources.get(cam.id).getFrame(2000, 8000).catch(() => null);
                const orig = jpeg && jpegSize(jpeg);
                if (!orig) {
                    continue;
                }
                let areas = [];
                try {
                    areas = JSON.parse(w.lastBoxes || '[]').filter(b => b.g === 'person');
                } catch {
                    // whole picture
                }
                areas.sort((a, b) => b.w * b.h - a.w * a.h);
                const faces = (await this.faceReader.read(jpeg, orig, areas, { minSize: cfg.minSize, max: 2 })).sort((a, b) => b.size - a.size);
                let hit = null;
                for (const f of faces) {
                    const m = bestMatch(f.embed, this.faceStore.persons);
                    if (!m || m.score < cfg.match) {
                        if (f.size >= cfg.minSize + 10) {
                            unknown++;
                        }
                        continue;
                    }
                    if (cfg.live && f.live !== null && f.live < cfg.liveMin) {
                        if (!fakeWarned) {
                            fakeWarned = true;
                            this.log.warn(`${cam.name}: Gesicht von ${m.name} erkannt, aber die Lebenderkennung ist nicht bestanden (${Math.round(f.live * 100)} %) - Foto oder Bildschirm?`);
                            await this.setState(`cameras.${cam.id}.detect.faceLive`, Math.round(f.live * 100), true);
                        }
                        continue;
                    }
                    hit = { ...m, live: f.live };
                    break;
                }
                if (!hit) {
                    last = null;
                    row = 0;
                    continue;
                }
                row = last === hit.id ? row + 1 : 1;
                last = hit.id;
                if (reported !== hit.id) {
                    reported = hit.id;
                    await this.onFace(cam, hit);
                }
                const p = this.faceStore.get(hit.id);
                if (!p || !p.door) {
                    return;
                }
                if (cfg.live && row >= 2) {
                    await this.setState(`cameras.${cam.id}.detect.faceDoor`, true, true);
                    this.log.info(`${cam.name}: Tür-Freigabe für ${hit.name} (zweimal erkannt, lebend)`);
                    return;
                }
            }
            if (!reported && unknown && cfg.unknown) {
                await this.setState(`cameras.${cam.id}.detect.face`, 'unbekannt', true);
                await this.setState(`cameras.${cam.id}.detect.faceTime`, new Date().toISOString(), true);
                this.log.info(`${cam.name}: unbekanntes Gesicht`);
            }
        } finally {
            this.faceRuns.delete(cam.id);
        }
    }

    async onFace(cam, m) {
        const now = new Date().toISOString();
        await this.setState(`cameras.${cam.id}.detect.face`, m.name, true);
        await this.setState(`cameras.${cam.id}.detect.faceKnown`, true, true);
        await this.setState(`cameras.${cam.id}.detect.faceScore`, Math.round(m.score * 100), true);
        if (m.live !== null && m.live !== undefined) {
            await this.setState(`cameras.${cam.id}.detect.faceLive`, Math.round(m.live * 100), true);
        }
        await this.setState(`cameras.${cam.id}.detect.faceTime`, now, true);
        const slug = this.faceSlugs && this.faceSlugs.get(m.id);
        if (slug) {
            await this.setState(`faces.${slug}.present`, true, true);
            await this.setState(`faces.${slug}.lastSeen`, now, true);
            await this.setState(`faces.${slug}.camera`, cam.name, true);
            this.facePresent = this.facePresent || new Map();
            this.facePresent.set(slug, cam.id);
        }
        this.log.info(`${cam.name}: ${m.name} erkannt (Ähnlichkeit ${Math.round(m.score * 100)} %${m.live !== null && m.live !== undefined ? `, lebend ${Math.round(m.live * 100)} %` : ''})`);
    }

    async faceGone(cam) {
        const run = this.faceRuns && this.faceRuns.get(cam.id);
        if (run) {
            run.stop = true;
        }
        if (this.faceDone) {
            this.faceDone.delete(cam.id);
        }
        await this.setState(`cameras.${cam.id}.detect.faceKnown`, false, true);
        await this.setState(`cameras.${cam.id}.detect.faceDoor`, false, true);
        for (const [slug, camId] of this.facePresent || []) {
            if (camId === cam.id) {
                this.facePresent.delete(slug);
                await this.setState(`faces.${slug}.present`, false, true);
            }
        }
    }

    async onDetectState(cam, st) {
        if (st.group === 'person' && this.faceCams && this.faceCams.has(cam.id)) {
            if (st.on) {
                this.faceSession(cam).catch(err => this.log.warn(`${cam.name}: Gesichter: ${err.message}`));
            } else {
                await this.faceGone(cam);
            }
        }
        if (st.group === 'vehicle' && this.plateCams && this.plateCams.has(cam.id)) {
            if (st.on) {
                this.plateSession(cam).catch(err => this.log.warn(`${cam.name}: Kennzeichen: ${err.message}`));
            } else {
                await this.plateGone(cam);
            }
        }
        await this.setState(`cameras.${cam.id}.detect.${st.group}Count`, st.count, true);
        await this.setState(`cameras.${cam.id}.detect.${st.group}`, st.on, true);
        if (st.on) {
            const text = `${st.count > 1 ? `${st.count} × ` : ''}${st.label} (${Math.round(st.score * 100)} %)`;
            await this.setState(`cameras.${cam.id}.detect.last`, text, true);
            await this.setState(`cameras.${cam.id}.detect.lastTime`, new Date().toISOString(), true);
            this.log.info(`${cam.name}: ${text}`);
        }
    }

    /** rising edge: full-size picture with boxes, at most one per 10 s and camera */
    async onDetected(cam, ev) {
        this.photoAt = this.photoAt || new Map();
        if (Date.now() - (this.photoAt.get(cam.id) || 0) < 10000) {
            return;
        }
        this.photoAt.set(cam.id, Date.now());
        const w = this.watchers.get(cam.id);
        const boxes = dets =>
            dets
                .slice(0, 10)
                .map(d => `drawbox=x=iw*${d.x.toFixed(4)}:y=ih*${d.y.toFixed(4)}:w=iw*${d.w.toFixed(4)}:h=ih*${d.h.toFixed(4)}:color=red@0.9:t=4`)
                .join(',');
        let out = null;
        // a fresh full-size picture, checked again so the boxes fit exactly
        try {
            const jpeg = await this.sources.get(cam.id).getFrame(2000, 8000);
            const orig = jpegSize(jpeg);
            const dets = orig ? w.filter(await this.detector.detect(await w._decode(jpeg), orig, w.minScore)).filter(d => d.group === ev.group) : [];
            if (dets.length) {
                out = await this.ffmpegImage(['-f', 'mjpeg', '-i', 'pipe:0', '-vf', boxes(dets)], jpeg);
            }
        } catch (err) {
            this.log.debug(`${cam.name}: full-size photo: ${err.message}`);
        }
        // else the small picture the detection was made on (without the grey padding)
        if (!out && w.lastFrame) {
            const { bgr, orig } = w.lastFrame;
            const r = Math.min(SIZE / orig.w, SIZE / orig.h);
            const pw = Math.round(orig.w * r);
            const ph = Math.round(orig.h * r);
            out = await this.ffmpegImage(
                ['-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', `${SIZE}x${SIZE}`, '-i', 'pipe:0', '-vf', `crop=${pw}:${ph}:0:0,scale=${pw * 2}:-2,${boxes(ev.dets)}`],
                bgr,
            );
        }
        if (!out) {
            return;
        }
        fs.writeFileSync(path.join(this.detectDir(), `${cam.id}.jpg`), out);
        const { base, query } = this.urlBase;
        await this.setState(`cameras.${cam.id}.detect.photoUrl`, `${base}/detect/${cam.id}.jpg${query}${query ? '&' : '?'}t=${Date.now()}`, true);
    }

    /** one JPEG out of ffmpeg (input on stdin) */
    ffmpegImage(inputArgs, input) {
        return new Promise((resolve, reject) => {
            const { spawn } = require('node:child_process');
            const p = (this.spawnFn || spawn)((this.config.ffmpegPath || '').trim() || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', ...inputArgs, '-frames:v', '1', '-q:v', '4', '-f', 'mjpeg', 'pipe:1'], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const chunks = [];
            p.stdout.on('data', c => chunks.push(c));
            p.on('error', reject);
            p.on('exit', code => (code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg code ${code}`))));
            p.stdin.on('error', () => {});
            p.stdin.end(input);
        });
    }

    /** from the page /zones or the zones state */
    async saveZones(id, zones) {
        const w = this.watchers && this.watchers.get(id);
        if (!w) {
            throw new Error('Für diese Kamera ist keine KI-Erkennung eingeschaltet');
        }
        const clean = parseZones(zones);
        w.setZones(clean);
        await this.setState(`cameras.${id}.detect.zones`, clean.length ? JSON.stringify(clean) : '', true);
        this.log.info(`${this.sources.get(id).cfg.name}: ${clean.length ? `${clean.length} Bereich(e)` : 'ganzes Bild'} für die Erkennung`);
        return clean;
    }

    /** Start the SIP intercom if enabled; returns the camera id shown while ringing. */
    /**
     * Camera shown large while the intercom rings: the configured name, otherwise the camera
     * with the intercom's IP address (the 2N's own camera), otherwise the only camera.
     */
    findIntercomCamera(cameraIds, name = this.config.intercomCamera, ip = this.config.intercomHost) {
        const wanted = name ? cameraId(name, 0) : '';
        if (wanted && cameraIds.has(wanted)) {
            return wanted;
        }
        ip = (ip || '').trim();
        const hostOf = s => {
            try {
                return s.cfg.host || new URL(s.cfg.url).hostname;
            } catch {
                return s.cfg.host || '';
            }
        };
        const byIp = ip ? [...this.sources.values()].find(s => hostOf(s).replace(/:\d+$/, '') === ip) : null;
        const found = byIp ? byIp.id : this.sources.size === 1 ? [...this.sources.keys()][0] : '';
        if (wanted || !found) {
            this.log.warn(
                `Intercom camera "${name || ''}" not found among the active cameras` +
                    (found ? `, using "${this.sources.get(found).cfg.name}" (same IP as the intercom)` : ''),
            );
        } else {
            this.log.info(`Intercom camera: "${this.sources.get(found).cfg.name}" (same IP as the intercom ${ip})`);
        }
        return found;
    }

    /** Door stations: the main one from the intercom tab plus the table of further stations (e.g. Mobotix T25/T26). */
    intercomStations(cameraIds) {
        const c = this.config;
        const stations = [
            {
                name: '',
                host: (c.intercomHost || '').trim(),
                camera: this.findIntercomCamera(cameraIds),
                door: {
                    method: c.doorMethod || 'none',
                    code: c.doorCode || '',
                    switchNo: Number(c.doorSwitch) || 1,
                    user: c.intercomUser || '',
                    password: c.intercomPassword || '',
                },
            },
        ];
        for (const row of Array.isArray(c.intercoms) ? c.intercoms : []) {
            const host = String(row.host || '').trim();
            if (row.enabled === false || !host) {
                continue;
            }
            stations.push({
                name: String(row.name || '').trim() || host,
                host,
                camera: this.findIntercomCamera(cameraIds, row.camera, host),
                door: {
                    method: row.doorMethod || 'none',
                    code: row.doorCode || '',
                    url: String(row.doorUrl || '').trim(),
                    user: row.user || '',
                    password: row.password || '',
                },
            });
        }
        return stations;
    }

    async startIntercom(cameraIds) {
        const c = this.config;
        if (!c.intercomEnabled) {
            return '';
        }
        const stations = this.intercomStations(cameraIds);
        const camera = stations[0].camera;
        this.intercom = new Intercom({
            sipPort: Number(c.sipPort) || 5060,
            rtpPorts: String(c.rtpPorts || ''),
            stations,
            ringTimeout: Number(c.ringTimeout) || 60,
            log: this.log,
        });
        this.intercom.on('state', ({ state, caller }) => {
            this.setState('intercom.state', state, true);
            this.setState('intercom.ringing', state === 'ringing', true);
            this.setState('intercom.active', state === 'active' || state === 'connecting', true);
            if (caller) {
                this.setState('intercom.caller', caller, true);
            }
        });
        this.history = new CallHistory({
            dir: path.join(this.dataDir || utils.getAbsoluteInstanceDataDir(this), 'calls'),
            size: Number(c.historySize) || 20,
            log: this.log,
        });
        this.history.load();
        let ringPhoto = null;
        this.intercom.on('ring', ({ camera: ringCamera }) => {
            this.setState('intercom.lastRing', new Date().toISOString(), true);
            // Photo of the visitor for the call history, from the camera of the station that rings.
            const source = this.sources.get(ringCamera || camera);
            ringPhoto = source ? source.getFrame(1500, 8000).catch(() => null) : Promise.resolve(null);
            if (this.vms && this.config.vmsRing) {
                this.vmsRing(ringCamera || camera, stations).catch(err => this.log.warn(`VMS: Klingeln nicht gemeldet: ${err.message}`));
            }
        });
        this.intercom.on('callEnd', async entry => {
            const image = ringPhoto ? await ringPhoto : null;
            ringPhoto = null;
            this.history.add(entry, image);
            this.log.info(`Intercom: call ${entry.result}${entry.duration ? ` (${entry.duration} s)` : ''}`);
            await this.publishHistory();
        });
        this.intercom.on('seen', () => {
            this.history.markSeen();
            this.publishHistory();
        });
        try {
            const port = await this.intercom.start();
            const hosts = stations.map(st => st.host).filter(Boolean);
            this.log.info(`Intercom: listening for SIP calls on UDP port ${port}${hosts.length ? ` from ${hosts.join(', ')}` : ''}`);
            this.log.info(this.intercom.ports
                ? `Intercom: Ton über UDP ${this.intercom.ports.station.join('-')} (Sprechstelle) und ${this.intercom.ports.browser.join('-')} (Browser) - in der Firewall freigeben`
                : 'Intercom: Ton über zufällige UDP-Ports (für Firewall-Regeln einen festen Bereich bei "UDP-Ports für den Ton" eintragen)');
        } catch (err) {
            this.log.error(`Intercom: cannot open SIP port ${c.sipPort || 5060}: ${err.message}`);
            this.intercom = null;
            return camera;
        }
        await this.setState('intercom.state', 'idle', true);
        await this.setState('intercom.ringing', false, true);
        await this.setState('intercom.active', false, true);
        this.subscribeStates('intercom.openDoor');
        this.subscribeStates('intercom.hangup');
        this.subscribeStates('intercom.missedSeen');
        await this.publishHistory();
        return camera;
    }

    /** Camera wall on/off and per-camera visibility as left before the restart (default: on). */
    async restoreView() {
        await this.extendObject('view', { type: 'channel', common: { name: { en: 'Camera wall', de: 'Kamerawand' } }, native: {} });
        await this.extendObject('view.display', {
            type: 'state',
            common: {
                name: { en: 'Camera wall on (off = black screen, shown anyway when the intercom rings)', de: 'Kamerawand an (aus = schwarzer Bildschirm, beim Klingeln trotzdem an)' },
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: true,
            },
            native: {},
        });
        const value = async id => {
            const st = await this.getStateAsync(id).catch(() => null);
            return st && st.val !== null && st.val !== undefined ? Boolean(st.val) : true;
        };
        const display = await value('view.display');
        await this.setState('view.display', display, true);
        const hidden = [];
        for (const id of this.sources.keys()) {
            const show = await value(`cameras.${id}.show`);
            await this.setState(`cameras.${id}.show`, show, true);
            if (!show) {
                hidden.push(id);
            }
        }
        // Ring tone picked on /tones (or by a script); starts with the one from the settings.
        await this.extendObject('view.ringTone', {
            type: 'state',
            common: {
                name: { en: 'Ring tone of the camera wall', de: 'Klingelton der Kamerawand' },
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                states: Object.fromEntries(Object.entries(TONE_LABELS).filter(([id]) => id !== 'custom' || this.config.ringToneUrl)),
            },
            native: {},
        });
        await this.extendObject('view.ringVolume', {
            type: 'state',
            common: { name: { en: 'Ring tone volume', de: 'Lautstärke des Klingeltons' }, type: 'number', role: 'level.volume', min: 0, max: 100, unit: '%', read: true, write: true },
            native: {},
        });
        const stored = async id => {
            const st = await this.getStateAsync(id).catch(() => null);
            return st ? st.val : null;
        };
        let ringTone = await stored('view.ringTone');
        if (!TONE_LABELS[ringTone]) {
            ringTone = this.config.ringTone || 'dingdong';
        }
        let ringVolume = Number(await stored('view.ringVolume'));
        if (!(ringVolume > 0 && ringVolume <= 100)) {
            ringVolume = Number(this.config.ringVolume) || 70;
        }
        await this.setState('view.ringTone', ringTone, true);
        await this.setState('view.ringVolume', ringVolume, true);
        return { display, hidden, ringTone, ringVolume };
    }

    /** Ring tone chosen on the /tones page. */
    async onToneSelect(tone, volume) {
        this.log.info(`Ring tone: ${TONE_LABELS[tone]}, volume ${volume} %`);
        await this.setState('view.ringTone', tone, true);
        await this.setState('view.ringVolume', volume, true);
    }

    async publishHistory() {
        const h = this.history;
        this.intercom.setMissed(h.missedCount);
        await this.setState('intercom.missedCount', h.missedCount, true);
        await this.setState('intercom.lastMissed', h.lastMissed, true);
        await this.setState('intercom.history', JSON.stringify(h.entries), true);
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const local = id.slice(this.namespace.length + 1);
        const vio = /^vms\.io\.([^.]+)\.(on|open)$/.exec(local);
        if (vio) {
            await this.vmsIoWrite(vio[1], vio[2], state.val);
            return;
        }
        const vw = /^vms\.cameras\.([^.]+)\.(recordMode|enabled)$/.exec(local);
        if (vw) {
            await this.vmsWrite(vw[1], vw[2], state.val);
            return;
        }
        if (local === 'view.ringTone' && this.server) {
            if (TONE_LABELS[state.val]) {
                this.server.setView({ ringTone: state.val });
            } else {
                this.log.warn(`Unknown ring tone "${state.val}" (${Object.keys(TONE_LABELS).join(', ')})`);
            }
            await this.setState(local, this.server.view.ringTone, true);
            return;
        }
        if (local === 'view.ringVolume' && this.server) {
            const v = Math.round(Math.min(100, Math.max(0, Number(state.val) || 0)));
            this.server.setView({ ringVolume: v });
            await this.setState(local, v, true);
            return;
        }
        if (local === 'view.display' && this.server) {
            this.server.setView({ display: Boolean(state.val) });
            this.log.info(`Camera wall ${state.val ? 'on' : 'off'}`);
            await this.setState(local, Boolean(state.val), true);
            return;
        }
        const zm = /^cameras\.([^.]+)\.detect\.zones$/.exec(local);
        if (zm) {
            await this.saveZones(zm[1], state.val).catch(err => this.log.warn(err.message));
            return;
        }
        const show = /^cameras\.([^.]+)\.show$/.exec(local);
        if (show && this.server && this.sources.has(show[1])) {
            const hidden = this.server.view.hidden.filter(h => h !== show[1]);
            if (!state.val) {
                hidden.push(show[1]);
            }
            this.server.setView({ hidden });
            await this.setState(local, Boolean(state.val), true);
            return;
        }
        if (!this.intercom) {
            return;
        }
        try {
            if (local === 'intercom.openDoor') {
                await this.intercom.openDoor();
            } else if (local === 'intercom.hangup') {
                this.intercom.hangup();
            } else if (local === 'intercom.missedSeen') {
                this.history.markSeen();
                await this.publishHistory();
            } else {
                return;
            }
        } catch (err) {
            this.log.warn(`Intercom: ${err.message}`);
        }
        await this.setState(local, false, true);
    }

    checkCamera(cam) {
        const type = cam.type || 'stream';
        if (type === 'vms') {
            if (!this.vms) {
                return 'Typ VMS: im Reiter „VMS“ fehlen Adresse oder API-Schlüssel';
            }
            return String(cam.vmsCamera || '').trim() ? null : 'Typ VMS: keine VMS-Kamera gewählt (Spalte „VMS-Kamera“)';
        }
        const host = (cam.host || '').trim();
        if (type === 'onvif') {
            if (!host) {
                return 'ONVIF needs the IP address of the camera';
            }
            return validHost(host) ? null : `IP address "${host}" looks wrong (example: 192.168.1.50)`;
        }
        // The IP column only matters when the URL is just a path.
        if (host && String(cam.url || '').trim().startsWith('/') && !validHost(host)) {
            return `IP address "${host}" looks wrong (example: 192.168.1.50)`;
        }
        const url = completeUrl(type, cam.url, host);
        if (!url) {
            return 'no URL configured';
        }
        if (url.startsWith('/')) {
            return `URL "${url}" is only a path: enter the full address (rtsp://<IP>${url}) or the IP address`;
        }
        if (type === 'snapshot' && !/^https?:\/\//i.test(url)) {
            return 'snapshot URL must start with http:// or https://';
        }
        if (type === 'stream' && !/^(rtsps?|https?|rtmp):\/\//i.test(url)) {
            return `stream URL "${url}" must start with rtsp:// or http://`;
        }
        try {
            const h = new URL(url).hostname;
            if (/^[\d.]+$/.test(h) && !validHost(h)) {
                return `IP address "${h}" in the URL looks wrong (example: 192.168.1.50)`;
            }
        } catch {
            return `URL "${url}" is not valid`;
        }
        return null;
    }

    async onStatus(id, status) {
        const prev = this.lastStatus.get(id) || {};
        this.lastStatus.set(id, status);
        for (const key of ['online', 'fps', 'viewers']) {
            if (prev[key] !== status[key]) {
                await this.setState(`cameras.${id}.${key}`, status[key], true);
            }
        }
        if (prev.error !== status.error) {
            await this.setState(`cameras.${id}.lastError`, status.error, true);
        }
    }

    async createCameraObjects(id, name) {
        await this.extendObject(`cameras.${id}`, { type: 'channel', common: { name }, native: {} });
        const states = {
            online: { name: { en: 'Receiving images', de: 'Bilder kommen an' }, type: 'boolean', role: 'indicator.reachable' },
            mjpegUrl: { name: { en: 'Live image URL (for VIS-2)', de: 'Livebild-URL (für VIS-2)' }, type: 'string', role: 'url.cam' },
            snapshotUrl: { name: { en: 'Single image URL', de: 'Einzelbild-URL' }, type: 'string', role: 'url.cam' },
            viewers: { name: { en: 'Current viewers', de: 'Aktuelle Zuschauer' }, type: 'number', role: 'value' },
            fps: { name: { en: 'Frames per second', de: 'Bilder pro Sekunde' }, type: 'number', role: 'value', unit: 'fps' },
            lastError: { name: { en: 'Last error', de: 'Letzter Fehler' }, type: 'string', role: 'text' },
        };
        for (const [key, common] of Object.entries(states)) {
            await this.extendObject(`cameras.${id}.${key}`, {
                type: 'state',
                common: { ...common, read: true, write: false },
                native: {},
            });
        }
        await this.extendObject(`cameras.${id}.show`, {
            type: 'state',
            common: {
                name: { en: 'Show on the camera wall', de: 'Auf der Kamerawand anzeigen' },
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: true,
            },
            native: {},
        });
    }

    /** Delete objects of cameras that were removed or renamed in the settings. */
    async removeStaleCameras(used) {
        const channels = await this.getChannelsOfAsync('cameras').catch(() => []);
        for (const ch of channels || []) {
            const id = ch._id.split('.').pop();
            if (!used.has(id)) {
                await this.delObjectAsync(`cameras.${id}`, { recursive: true });
            }
        }
    }

    async onUnload(callback) {
        this.unloading = true;
        try {
            if (this.vms) {
                this.vms.stop();
            }
            clearInterval(this.detectStats);
            for (const w of (this.watchers || new Map()).values()) {
                w.stop();
            }
            for (const s of this.sources.values()) {
                s.destroy();
            }
            if (this.intercom) {
                await this.intercom.stop();
            }
            if (this.server) {
                await this.server.close();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Livecam(options);
} else {
    new Livecam();
}

