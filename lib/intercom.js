'use strict';

/*
 * Door intercom: SIP call from the intercom <-> WebRTC audio in the browser.
 *
 *   intercom --SIP/RTP (G.711)--> SipServer + RTP socket
 *                                    | relay RTP payloads, no transcoding
 *   browser  <--WebRTC (G.711)--> werift peer connection
 *
 * Browsers connect to /ws. While a call rings, every browser shows it; the
 * first one that answers gets the audio, the others are told it was taken.
 *
 * Messages to the browser:   {type: 'state', state, caller, camera, mine}
 *                            {type: 'answer', sdp}  {type: 'error', message}
 * Messages from the browser: {type: 'answer', sdp}  (WebRTC offer)
 *                            {type: 'hangup'}  {type: 'door'}  {type: 'seen'}
 *
 * Events: 'state', 'ring', 'door', 'seen' and 'callEnd' ({caller, result, duration, time})
 * with result 'answered', 'missed' or 'rejected'.
 */

const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const werift = require('werift');
const { SipServer } = require('./sip');
const { parseSdp, chooseCodec, buildAnswer } = require('./sdp');
const { HttpClient } = require('./http-client');

const DTMF_EVENTS = { '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15 };

class Intercom extends EventEmitter {
    /**
     * @param {object} options
     * @param {number} [options.sipPort]
     * @param {string} [options.intercomHost] only this IP may call (recommended)
     * @param {string} [options.camera] camera id shown large while ringing
     * @param {number} [options.ringTimeout] seconds
     * @param {{method: 'none'|'dtmf'|'http', code?: string, switchNo?: number, user?: string, password?: string}} [options.door]
     * @param {object} options.log
     */
    constructor({ sipPort = 5060, intercomHost = '', camera = '', ringTimeout = 60, door = { method: 'none' }, log }) {
        super();
        this.log = log;
        this.camera = camera;
        this.intercomHost = intercomHost;
        this.ringTimeout = ringTimeout * 1000;
        this.door = door;
        this.sip = new SipServer({ port: sipPort, allowed: intercomHost ? [intercomHost] : [], log });
        this.sip.on('invite', call => this._incoming(call));
        this.clients = new Set();
        this.session = null;
        this.http = door.method === 'http' ? new HttpClient({ user: door.user, password: door.password }) : null;
    }

    async start() {
        return this.sip.listen();
    }

    /** Accept WebSocket connections on /ws of an existing HTTP server. */
    attach(httpServer, accessKey = '') {
        this.wss = new WebSocketServer({ noServer: true });
        httpServer.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname !== '/ws' || (accessKey && url.searchParams.get('key') !== accessKey)) {
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, ws => this._client(ws));
        });
    }

    async stop() {
        this._finish('adapter stopped', true);
        for (const ws of this.clients) {
            ws.terminate();
        }
        if (this.wss) {
            this.wss.close();
        }
        await this.sip.close();
    }

    /** Number of unseen missed calls, shown on the camera wall. */
    setMissed(count) {
        if (this.missed !== count) {
            this.missed = count;
            this._broadcast();
        }
    }

    get state() {
        return this.session ? this.session.state : 'idle';
    }

    _client(ws) {
        ws.id = crypto.randomBytes(4).toString('hex');
        ws.isAlive = true;
        this.clients.add(ws);
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        ws.on('message', data => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            this._fromClient(ws, msg).catch(err => {
                this.log.warn(`Intercom: ${err.message}`);
                this._send(ws, { type: 'error', message: err.message });
            });
        });
        ws.on('close', () => {
            this.clients.delete(ws);
            if (this.session && this.session.owner === ws) {
                this.log.info('Intercom: answering browser disconnected, hanging up');
                this.hangup();
            }
        });
        this._sendState(ws);
        if (!this.pingTimer) {
            // Detect dead browser connections (tablet sleeping, WLAN gone).
            this.pingTimer = setInterval(() => {
                for (const c of this.clients) {
                    if (!c.isAlive) {
                        c.terminate();
                        continue;
                    }
                    c.isAlive = false;
                    c.ping();
                }
            }, 15000);
            this.pingTimer.unref();
        }
    }

    async _fromClient(ws, msg) {
        if (msg.type === 'answer') {
            await this.answer(ws, msg.sdp);
        } else if (msg.type === 'hangup') {
            this.hangup();
        } else if (msg.type === 'door') {
            await this.openDoor();
        } else if (msg.type === 'seen') {
            this.emit('seen');
        }
    }

    _send(ws, msg) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(msg));
        }
    }

    _sendState(ws) {
        const s = this.session;
        this._send(ws, {
            type: 'state',
            state: this.state,
            caller: s ? s.caller : '',
            camera: this.camera,
            mine: Boolean(s && s.owner === ws),
            doorAvailable: this.door.method === 'http' || (this.door.method === 'dtmf' && this.state === 'active'),
            missed: this.missed || 0,
        });
    }

    _broadcast() {
        for (const ws of this.clients) {
            this._sendState(ws);
        }
        const s = this.session;
        this.emit('state', { state: this.state, caller: s ? s.caller : '' });
    }

    async _incoming(call) {
        if (this.session) {
            call.reject(486);
            return;
        }
        const offer = parseSdp(call.remoteSdp);
        const codec = chooseCodec(offer.audio);
        if (!codec || !offer.audio.port) {
            this.log.warn('Intercom: call without G.711 audio, rejected');
            call.reject(488);
            return;
        }
        const rtp = dgram.createSocket('udp4');
        await new Promise(resolve => rtp.bind(0, resolve));
        const session = {
            call,
            codec,
            offer,
            rtp,
            state: 'ringing',
            caller: call.caller,
            remote: { address: offer.audio.address || call.rinfo.address, port: offer.audio.port },
            out: { seq: crypto.randomInt(0, 0xffff), ts: crypto.randomInt(0, 0xffffffff), ssrc: crypto.randomInt(1, 0xffffffff) },
            owner: null,
            pc: null,
            started: Date.now(),
        };
        this.session = session;
        this.log.info(`Intercom: incoming call from ${session.caller} (${codec.name}${codec.dtmfPayloadType !== null ? ' + DTMF' : ''})`);
        session.ringTimer = setTimeout(() => {
            if (session.state === 'ringing') {
                call.reject(480);
            }
        }, this.ringTimeout);
        call.on('ended', reason => {
            if (this.session === session) {
                this.log.info(`Intercom: call ended (${reason})`);
                this._finish(reason, false);
            }
        });
        rtp.on('message', (msg, rinfo) => this._fromIntercom(session, msg, rinfo));
        rtp.on('error', err => this.log.warn(`Intercom RTP: ${err.message}`));
        this.emit('ring', { caller: session.caller });
        this._broadcast();
    }

    /** A browser picks up: WebRTC offer from the browser, our answer back, SIP 200 OK to the intercom. */
    async answer(ws, browserOffer) {
        const session = this.session;
        if (!session || session.state !== 'ringing') {
            throw new Error('No call to answer');
        }
        session.state = 'connecting';
        session.owner = ws;
        clearTimeout(session.ringTimer);
        const mime = session.codec.name === 'PCMA' ? 'audio/PCMA' : 'audio/PCMU';
        const pc = new werift.RTCPeerConnection({
            codecs: {
                audio: [new werift.RTCRtpCodecParameters({ mimeType: mime, clockRate: 8000, channels: 1, payloadType: mime === 'audio/PCMA' ? 8 : 0 })],
            },
        });
        session.pc = pc;
        session.toBrowser = new werift.MediaStreamTrack({ kind: 'audio' });
        pc.addTransceiver(session.toBrowser, { direction: 'sendrecv' });
        pc.onTrack.subscribe(track => {
            track.onReceiveRtp.subscribe(packet => this._toIntercom(session, packet.payload));
        });
        pc.connectionStateChange.subscribe(state => {
            if ((state === 'failed' || state === 'closed') && this.session === session && session.state !== 'ended') {
                this.log.warn(`Intercom: browser audio connection ${state}`);
                this.hangup();
            }
        });
        try {
            await pc.setRemoteDescription({ type: 'offer', sdp: browserOffer });
            await pc.setLocalDescription(await pc.createAnswer());
            await waitForGathering(pc);
        } catch (err) {
            session.state = 'ringing';
            session.owner = null;
            throw new Error(`Browser audio setup failed: ${err.message}`);
        }
        if (this.session !== session) {
            pc.close();
            return; // caller hung up meanwhile
        }
        this._send(ws, { type: 'answer', sdp: pc.localDescription.sdp });
        const localIp = this.sip.localIp || (await this.sip.localAddressFor(session.call.rinfo.address));
        session.call.answer(buildAnswer({ ip: localIp, port: session.rtp.address().port, codec: session.codec, offer: session.offer }));
        session.state = 'active';
        session.since = Date.now();
        this.log.info('Intercom: call answered');
        this._broadcast();
    }

    hangup() {
        const session = this.session;
        if (!session) {
            return;
        }
        if (session.state === 'ringing') {
            session.rejected = true;
            session.call.reject(603);
        } else {
            session.call.hangup();
        }
        this._finish('hangup', false);
    }

    async openDoor() {
        const d = this.door;
        if (d.method === 'http') {
            const url = `http://${this.intercomHost}/api/switch/ctrl?switch=${Number(d.switchNo) || 1}&action=trigger`;
            const res = await this.http.request(url);
            const text = res.body.toString();
            if (res.status !== 200 || /"success"\s*:\s*false/.test(text)) {
                throw new Error(`Door: HTTP ${res.status} ${text.slice(0, 200)}`);
            }
            this.log.info('Intercom: door opened (HTTP API)');
            this.emit('door');
            return;
        }
        if (d.method === 'dtmf') {
            const s = this.session;
            if (!s || s.state !== 'active') {
                throw new Error('Door code can only be sent during a call');
            }
            if (s.codec.dtmfPayloadType === null) {
                throw new Error('The intercom did not offer DTMF (telephone-event)');
            }
            for (const digit of String(d.code || '')) {
                if (s.state !== 'active') {
                    return; // hung up while the code was being sent
                }
                await this._sendDtmf(s, digit);
                await sleep(120);
            }
            this.log.info('Intercom: door code sent');
            this.emit('door');
            return;
        }
        throw new Error('Door opening is not configured');
    }

    _fromIntercom(session, msg, rinfo) {
        if (msg.length < 12 || (msg[0] & 0xc0) !== 0x80) {
            return;
        }
        // Symmetric RTP: answer to where the audio really comes from (NAT, other port).
        if (rinfo.address !== session.remote.address || rinfo.port !== session.remote.port) {
            session.remote = { address: rinfo.address, port: rinfo.port };
        }
        if (session.state !== 'active' || !session.toBrowser) {
            return;
        }
        const pt = msg[1] & 0x7f;
        if (pt !== session.codec.payloadType) {
            return; // DTMF events, comfort noise, ...
        }
        try {
            const packet = werift.RtpPacket.deSerialize(msg);
            packet.header.payloadType = session.codec.name === 'PCMA' ? 8 : 0;
            session.toBrowser.writeRtp(packet);
        } catch {
            // malformed packet
        }
    }

    _rtpOut(session, payloadType, payload, { marker = false, advance = payload.length, timestamp } = {}) {
        if (session.state === 'ended') {
            return;
        }
        const o = session.out;
        const header = new werift.RtpHeader({
            payloadType,
            sequenceNumber: o.seq,
            timestamp: (timestamp !== undefined ? timestamp : o.ts) >>> 0,
            ssrc: o.ssrc,
            marker,
        });
        o.seq = (o.seq + 1) & 0xffff;
        if (timestamp === undefined) {
            o.ts = (o.ts + advance) >>> 0; // G.711: one byte per sample at 8 kHz
        }
        session.rtp.send(new werift.RtpPacket(header, payload).serialize(), session.remote.port, session.remote.address);
    }

    _toIntercom(session, payload) {
        if (session.state === 'active' && !session.sendingDtmf) {
            this._rtpOut(session, session.codec.payloadType, payload);
        }
    }

    /** RFC 4733 telephone-event: 3 packets while pressed, 3 end packets, all with the same timestamp. */
    async _sendDtmf(session, digit) {
        const event = /\d/.test(digit) ? Number(digit) : DTMF_EVENTS[digit.toUpperCase()];
        if (event === undefined) {
            return;
        }
        session.sendingDtmf = true;
        const ts = session.out.ts;
        const pt = session.codec.dtmfPayloadType;
        const packet = (end, duration) => Buffer.from([event, (end ? 0x80 : 0) | 10, (duration >> 8) & 0xff, duration & 0xff]);
        try {
            for (let i = 1; i <= 5; i++) {
                this._rtpOut(session, pt, packet(false, i * 160), { marker: i === 1, timestamp: ts });
                await sleep(20);
            }
            for (let i = 0; i < 3; i++) {
                this._rtpOut(session, pt, packet(true, 960), { timestamp: ts });
            }
            session.out.ts = (ts + 960) >>> 0;
        } finally {
            session.sendingDtmf = false;
        }
    }

    _finish(reason, hangupCall) {
        const session = this.session;
        if (!session) {
            return;
        }
        this.session = null;
        clearTimeout(session.ringTimer);
        this.emit('callEnd', {
            caller: session.caller,
            time: new Date(session.started).toISOString(),
            result: session.since ? 'answered' : session.rejected ? 'rejected' : 'missed',
            duration: session.since ? Math.round((Date.now() - session.since) / 1000) : 0,
        });
        if (hangupCall && session.call.state !== 'ended') {
            session.call.hangup();
        }
        session.state = 'ended';
        if (session.pc) {
            session.pc.close().catch(() => {});
        }
        try {
            session.rtp.close();
        } catch {
            // already closed
        }
        this._broadcast();
    }
}

function waitForGathering(pc, timeout = 3000) {
    if (pc.iceGatheringState === 'complete') {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const timer = setTimeout(resolve, timeout);
        pc.iceGatheringStateChange.subscribe(state => {
            if (state === 'complete') {
                clearTimeout(timer);
                resolve();
            }
        });
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { Intercom };
