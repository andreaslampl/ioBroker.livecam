'use strict';

const os = require('node:os');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const { CameraSource } = require('./lib/source');
const { CamServer } = require('./lib/server');
const { cameraId, completeUrl, validHost } = require('./lib/util');
const { Intercom } = require('./lib/intercom');
const { CallHistory } = require('./lib/history');

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
        this.intercom = null;
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const port = Number(this.config.port) || 8095;
        const host = (this.config.publicHost || '').trim() || localAddress();
        const key = (this.config.accessKey || '').trim();
        const query = key ? `?key=${encodeURIComponent(key)}` : '';
        const base = `http://${host}:${port}`;

        const cams = Array.isArray(this.config.cameras) ? this.config.cameras : [];
        const used = new Set();
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
            const source = new CameraSource(
                {
                    id,
                    name: cam.name || id,
                    type: cam.type || 'stream',
                    url: completeUrl(cam.type || 'stream', cam.url, cam.host),
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
        });
        this.server.setView(view);
        this.subscribeStates('view.display');
        this.subscribeStates('cameras.*.show');
        try {
            await this.server.listen(port);
        } catch (err) {
            this.log.error(`Cannot open port ${port}: ${err.message}. Choose another port in the settings.`);
            return;
        }
        await this.setState('info.connection', true, true);
        await this.setState('info.viewUrl', `${base}/view${query}`, true);
        this.log.info(`Live images for ${this.sources.size} camera(s) at ${base}/${query}, camera wall at ${base}/view${query}`);
    }

    /** Start the SIP intercom if enabled; returns the camera id shown while ringing. */
    /**
     * Camera shown large while the intercom rings: the configured name, otherwise the camera
     * with the intercom's IP address (the 2N's own camera), otherwise the only camera.
     */
    findIntercomCamera(cameraIds) {
        const c = this.config;
        const wanted = c.intercomCamera ? cameraId(c.intercomCamera, 0) : '';
        if (wanted && cameraIds.has(wanted)) {
            return wanted;
        }
        const ip = (c.intercomHost || '').trim();
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
                `Intercom camera "${c.intercomCamera || ''}" not found among the active cameras` +
                    (found ? `, using "${this.sources.get(found).cfg.name}" (same IP as the intercom)` : ''),
            );
        } else {
            this.log.info(`Intercom camera: "${this.sources.get(found).cfg.name}" (same IP as the intercom)`);
        }
        return found;
    }

    async startIntercom(cameraIds) {
        const c = this.config;
        if (!c.intercomEnabled) {
            return '';
        }
        const camera = this.findIntercomCamera(cameraIds);
        this.intercom = new Intercom({
            sipPort: Number(c.sipPort) || 5060,
            intercomHost: (c.intercomHost || '').trim(),
            camera,
            ringTimeout: Number(c.ringTimeout) || 60,
            door: {
                method: c.doorMethod || 'none',
                code: c.doorCode || '',
                switchNo: Number(c.doorSwitch) || 1,
                user: c.intercomUser || '',
                password: c.intercomPassword || '',
            },
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
        this.intercom.on('ring', () => {
            this.setState('intercom.lastRing', new Date().toISOString(), true);
            // Photo of the visitor for the call history.
            const source = this.sources.get(camera);
            ringPhoto = source ? source.getFrame(1500, 8000).catch(() => null) : Promise.resolve(null);
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
            this.log.info(`Intercom: listening for SIP calls on UDP port ${port}${c.intercomHost ? ` from ${c.intercomHost}` : ''}`);
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
        return { display, hidden };
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
        if (local === 'view.display' && this.server) {
            this.server.setView({ display: Boolean(state.val) });
            this.log.info(`Camera wall ${state.val ? 'on' : 'off'}`);
            await this.setState(local, Boolean(state.val), true);
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
        try {
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

