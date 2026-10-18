'use strict';

// Fake 2N intercom (SIP over UDP + RTP) calls the adapter; a werift peer
// connected via WebSocket plays the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const http = require('node:http');
const WebSocket = require('ws');
const werift = require('werift');
const { Intercom } = require('../lib/intercom');
const { SipServer, parseMessage } = require('../lib/sip');
const { quietLog, until } = require('./helpers');

/** Fake intercom: places a call, answers ACK/BYE, collects RTP. */
async function fake2N(sipPort) {
    const sip = dgram.createSocket('udp4');
    const rtp = dgram.createSocket('udp4');
    await new Promise(r => sip.bind(0, '127.0.0.1', r));
    await new Promise(r => rtp.bind(0, '127.0.0.1', r));
    const n = { responses: [], requests: [], audio: [], dtmf: [], callId: `call-${Date.now()}@2n`, fromTag: 'tag2n' };
    sip.on('message', buf => {
        const msg = parseMessage(buf);
        if (msg.status) {
            n.responses.push(msg);
        } else {
            n.requests.push(msg);
            if (msg.method === 'BYE') {
                const reply = [
                    'SIP/2.0 200 OK', ...msg.headers.via.map(v => `Via: ${v}`), `From: ${msg.header('from')}`, `To: ${msg.header('to')}`,
                    `Call-ID: ${msg.header('call-id')}`, `CSeq: ${msg.header('cseq')}`, 'Content-Length: 0', '', '',
                ].join('\r\n');
                sip.send(reply, sipPort, '127.0.0.1');
            }
        }
    });
    rtp.on('message', buf => {
        const p = werift.RtpPacket.deSerialize(buf);
        if (p.header.payloadType === 101) {
            n.dtmf.push(p.payload[0]);
        } else {
            n.audio.push(p);
        }
    });
    const base = (method, cseq, extra = [], body = '') =>
        [
            `${method} sip:door@127.0.0.1:${sipPort} SIP/2.0`,
            `Via: SIP/2.0/UDP 127.0.0.1:${sip.address().port};branch=z9hG4bK${method}${cseq}`,
            'Max-Forwards: 70',
            `From: "Haustuer" <sip:verso@127.0.0.1>;tag=${n.fromTag}`,
            `To: <sip:door@127.0.0.1>${n.toTag && method !== 'INVITE' && method !== 'CANCEL' ? `;tag=${n.toTag}` : ''}`,
            `Call-ID: ${n.callId}`,
            `CSeq: ${cseq} ${method}`,
            `Contact: <sip:verso@127.0.0.1:${sip.address().port}>`,
            ...extra,
            `Content-Length: ${Buffer.byteLength(body)}`,
            '',
            body,
        ].join('\r\n');
    const sdp = [
        'v=0', 'o=2N 1 1 IN IP4 127.0.0.1', 's=2N', 'c=IN IP4 127.0.0.1', 't=0 0',
        `m=audio ${rtp.address().port} RTP/AVP 8 0 101`, 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-15',
        'm=video 9078 RTP/AVP 96', 'a=rtpmap:96 H264/90000', '',
    ].join('\r\n');
    n.invite = () => sip.send(base('INVITE', 1, ['Content-Type: application/sdp'], sdp), sipPort, '127.0.0.1');
    n.cancel = () => sip.send(base('CANCEL', 1), sipPort, '127.0.0.1');
    n.ack = () => sip.send(base('ACK', 1), sipPort, '127.0.0.1');
    n.bye = () => sip.send(base('BYE', 2), sipPort, '127.0.0.1');
    n.sendAudio = (count, port) => {
        for (let i = 0; i < count; i++) {
            const h = new werift.RtpHeader({ payloadType: 8, sequenceNumber: i, timestamp: i * 160, ssrc: 4242 });
            rtp.send(new werift.RtpPacket(h, Buffer.alloc(160, 0xd5)).serialize(), port, '127.0.0.1');
        }
    };
    n.close = () => {
        sip.close();
        rtp.close();
    };
    return n;
}

/** Browser stand-in: WebSocket + werift peer with a "microphone" track. */
async function fakeBrowser(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const b = { ws, states: [], received: 0 };
    const opened = new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    ws.on('message', async data => {
        const msg = JSON.parse(data);
        if (msg.type === 'state') {
            b.states.push(msg);
            b.state = msg;
        } else if (msg.type === 'answer') {
            await b.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        } else if (msg.type === 'error') {
            b.error = msg.message;
        }
    });
    await opened;
    b.answer = async () => {
        b.pc = new werift.RTCPeerConnection({
            codecs: {
                audio: [
                    new werift.RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 }),
                    new werift.RTCRtpCodecParameters({ mimeType: 'audio/PCMU', clockRate: 8000, channels: 1, payloadType: 0 }),
                    new werift.RTCRtpCodecParameters({ mimeType: 'audio/PCMA', clockRate: 8000, channels: 1, payloadType: 8 }),
                ],
            },
        });
        b.mic = new werift.MediaStreamTrack({ kind: 'audio' });
        b.pc.addTransceiver(b.mic, { direction: 'sendrecv' });
        b.pc.onTrack.subscribe(t => t.onReceiveRtp.subscribe(() => b.received++));
        await b.pc.setLocalDescription(await b.pc.createOffer());
        await until(() => b.pc.iceGatheringState === 'complete', 5000).catch(() => {});
        ws.send(JSON.stringify({ type: 'answer', sdp: b.pc.localDescription.sdp }));
    };
    b.speak = async count => {
        const sender = b.pc.getTransceivers()[0].sender;
        const pt = sender.codec ? sender.codec.payloadType : 8;
        for (let i = 0; i < count; i++) {
            b.mic.writeRtp(new werift.RtpPacket(new werift.RtpHeader({ payloadType: pt, sequenceNumber: i, timestamp: i * 160, ssrc: 77 }), Buffer.alloc(160, 0x55)));
            await new Promise(r => setTimeout(r, 20));
        }
    };
    b.send = msg => ws.send(JSON.stringify(msg));
    b.close = async () => {
        ws.close();
        if (b.pc) {
            await b.pc.close();
        }
    };
    return b;
}

async function setup(t, door = { method: 'dtmf', code: '12*' }) {
    const intercom = new Intercom({ sipPort: 0, intercomHost: '127.0.0.1', camera: 'haustuer', door, log: quietLog });
    const sipPort = await intercom.start();
    intercom.results = [];
    intercom.on('callEnd', e => intercom.results.push(e));
    const server = http.createServer();
    intercom.attach(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
        await intercom.stop();
        server.closeAllConnections();
        await new Promise(r => server.close(r));
    });
    return { intercom, sipPort, port: server.address().port };
}

test('call: ring, answer in the browser, audio both ways, door code, hang up', async t => {
    const { intercom, sipPort, port } = await setup(t);
    const n = await fake2N(sipPort);
    t.after(() => n.close());
    const b1 = await fakeBrowser(port);
    const b2 = await fakeBrowser(port);
    t.after(() => b1.close());
    t.after(() => b2.close());
    await until(() => b1.state && b2.state);
    assert.equal(b1.state.state, 'idle');

    n.invite();
    await until(() => b1.state.state === 'ringing' && b2.state.state === 'ringing');
    assert.equal(b1.state.caller, 'Haustuer');
    assert.equal(b1.state.camera, 'haustuer');
    assert.deepEqual(n.responses.map(r => r.status), [100, 180]);

    await b1.answer();
    await until(() => n.responses.some(r => r.status === 200));
    const ok = n.responses.find(r => r.status === 200);
    n.toTag = /tag=([^;\s]+)/.exec(ok.header('to'))[1];
    assert.match(ok.body, /m=audio \d+ RTP\/AVP 8 101/); // 2N preferred PCMA, DTMF kept
    assert.match(ok.body, /m=video 0 /); // video declined
    n.ack();
    await until(() => b1.state.state === 'active' && b2.state.state === 'active');
    assert.equal(b1.state.mine, true);
    assert.equal(b2.state.mine, false); // second screen: call taken elsewhere
    await until(() => b1.pc.connectionState === 'connected', 10000);

    // Intercom -> browser
    const rtpPort = Number(/m=audio (\d+)/.exec(ok.body)[1]);
    n.sendAudio(30, rtpPort);
    await until(() => b1.received >= 20, 10000);
    // Browser -> intercom, re-stamped as PCMA towards the 2N
    await b1.speak(30);
    await until(() => n.audio.length >= 20, 10000);
    assert.ok(n.audio.every(p => p.header.payloadType === 8));
    const seqs = n.audio.map(p => p.header.sequenceNumber);
    assert.ok(seqs.every((s, i) => i === 0 || s === ((seqs[i - 1] + 1) & 0xffff)), 'continuous sequence numbers');

    // Door: DTMF 1, 2, * (event 10)
    b1.send({ type: 'door' });
    await until(() => new Set(n.dtmf).size === 3, 10000);
    assert.deepEqual([...new Set(n.dtmf)], [1, 2, 10]);

    // Hang up from the browser -> BYE to the intercom
    b1.send({ type: 'hangup' });
    await until(() => n.requests.some(r => r.method === 'BYE'));
    await until(() => b1.state.state === 'idle' && b2.state.state === 'idle');
    assert.equal(intercom.state, 'idle');
    assert.equal(intercom.results.length, 1);
    assert.equal(intercom.results[0].result, 'answered');
    assert.equal(intercom.results[0].caller, 'Haustuer');
});

test('intercom cancels while ringing; caller hangs up during the call', async t => {
    const { intercom, sipPort, port } = await setup(t);
    const n = await fake2N(sipPort);
    t.after(() => n.close());
    const b = await fakeBrowser(port);
    t.after(() => b.close());

    n.invite();
    await until(() => b.state && b.state.state === 'ringing');
    n.cancel();
    await until(() => b.state.state === 'idle');
    await until(() => n.responses.some(r => r.status === 487));

    // Second call, answered, then the intercom hangs up.
    n.callId = `call2-${Date.now()}@2n`;
    n.responses.length = 0;
    n.invite();
    await until(() => b.state.state === 'ringing');
    await b.answer();
    await until(() => n.responses.some(r => r.status === 200));
    n.toTag = /tag=([^;\s]+)/.exec(n.responses.find(r => r.status === 200).header('to'))[1];
    n.ack();
    await until(() => b.state.state === 'active');
    n.bye();
    await until(() => b.state.state === 'idle');
    assert.equal(intercom.state, 'idle');
    assert.deepEqual(intercom.results.map(r => r.result), ['missed', 'answered']);

    // Missed count is pushed to the camera wall; 'seen' is reported back.
    intercom.setMissed(2);
    await until(() => b.state.missed === 2);
    let seen = false;
    intercom.once('seen', () => (seen = true));
    b.send({ type: 'seen' });
    await until(() => seen);
});

test('reject while ringing sends 603', async t => {
    const { intercom, sipPort, port } = await setup(t);
    const n = await fake2N(sipPort);
    t.after(() => n.close());
    const b = await fakeBrowser(port);
    t.after(() => b.close());
    n.invite();
    await until(() => b.state && b.state.state === 'ringing');
    b.send({ type: 'hangup' });
    await until(() => n.responses.some(r => r.status === 603));
    await until(() => b.state.state === 'idle');
    assert.deepEqual(intercom.results.map(r => r.result), ['rejected']);
});

test('unanswered call times out as missed', async t => {
    const intercom = new Intercom({ sipPort: 0, intercomHost: '127.0.0.1', ringTimeout: 1, log: quietLog });
    const sipPort = await intercom.start();
    t.after(() => intercom.stop());
    const results = [];
    intercom.on('callEnd', e => results.push(e.result));
    const n = await fake2N(sipPort);
    t.after(() => n.close());
    n.invite();
    await until(() => n.responses.some(r => r.status === 480), 5000);
    assert.deepEqual(results, ['missed']);
});

test('door via 2N HTTP API with digest login', async t => {
    const crypto = require('node:crypto');
    let calls = 0;
    const api = http.createServer((req, res) => {
        const h = req.headers.authorization || '';
        if (!h.startsWith('Digest')) {
            res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="HTTP API", nonce="abc", qop="auth"' });
            res.end();
            return;
        }
        const p = Object.fromEntries([...h.matchAll(/(\w+)="?([^",]+)"?/g)].map(m => [m[1], m[2]]));
        const md5 = s => crypto.createHash('md5').update(s).digest('hex');
        const expected = md5(`${md5('api:HTTP API:pw')}:abc:${p.nc}:${p.cnonce}:auth:${md5(`GET:${p.uri}`)}`);
        calls++;
        res.writeHead(p.response === expected && p.uri === '/api/switch/ctrl?switch=2&action=trigger' ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end('{"success": true}');
    });
    await new Promise(r => api.listen(0, '127.0.0.1', r));
    t.after(() => api.close());
    const intercom = new Intercom({
        sipPort: 0,
        intercomHost: `127.0.0.1:${api.address().port}`,
        door: { method: 'http', switchNo: 2, user: 'api', password: 'pw' },
        log: quietLog,
    });
    // HTTP API host includes the port here; SIP is not used in this test.
    await intercom.openDoor();
    assert.equal(calls, 1);
});

test('SIP calls from other devices are refused', async t => {
    const sip = new SipServer({ port: 0, allowed: ['10.9.9.9'], log: quietLog });
    const port = await sip.listen();
    t.after(() => sip.close());
    let invited = false;
    sip.on('invite', () => (invited = true));
    const n = await fake2N(port);
    t.after(() => n.close());
    n.invite();
    await until(() => n.responses.length);
    assert.equal(n.responses[0].status, 403);
    assert.equal(invited, false);
});
