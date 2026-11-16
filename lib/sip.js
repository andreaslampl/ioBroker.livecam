'use strict';

/*
 * Minimal SIP user agent (UDP) that accepts peer-to-peer calls from a door
 * intercom such as the 2N IP Verso. No registrar or PBX involved: the intercom
 * dials sip:<anything>@<ioBroker-IP>.
 *
 * Supported: INVITE (with 100/180/200 and 200 retransmission until ACK),
 * ACK, CANCEL (487), BYE in both directions, OPTIONS, re-INVITE, INFO.
 * Outgoing calls to the intercom (OutCall, `SipServer.invite()`): INVITE with
 * retransmission, ACK for 2xx and error answers, CANCEL, BYE.
 *
 * Events on SipServer: 'invite' (Call). Events on Call: 'ended' (reason).
 * Events on OutCall: 'ringing', 'answered' (remote SDP), 'ended' (reason; `failStatus` on errors).
 */

const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const T1 = 500;
const TIMER_B = 32000;

const REASONS = {
    100: 'Trying',
    180: 'Ringing',
    200: 'OK',
    400: 'Bad Request',
    403: 'Forbidden',
    405: 'Method Not Allowed',
    480: 'Temporarily Unavailable',
    481: 'Call/Transaction Does Not Exist',
    486: 'Busy Here',
    487: 'Request Terminated',
    488: 'Not Acceptable Here',
    603: 'Decline',
};

const randomTag = () => crypto.randomBytes(6).toString('hex');

/** Parse a SIP message. Header names are lower-cased; compact forms expanded. */
function parseMessage(buf) {
    const text = buf.toString('utf8');
    const split = text.indexOf('\r\n\r\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const body = split >= 0 ? text.slice(split + 4) : '';
    const lines = head.split('\r\n');
    const start = lines.shift();
    const msg = { headers: {}, body };
    const compact = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type' };
    let m;
    if ((m = /^SIP\/2\.0 (\d{3}) ?(.*)$/.exec(start))) {
        msg.status = Number(m[1]);
        msg.reason = m[2];
    } else if ((m = /^([A-Z]+) (\S+) SIP\/2\.0$/.exec(start))) {
        msg.method = m[1];
        msg.uri = m[2];
    } else {
        throw new Error('Not a SIP message');
    }
    for (const line of lines) {
        const i = line.indexOf(':');
        if (i < 0) {
            continue;
        }
        let name = line.slice(0, i).trim().toLowerCase();
        name = compact[name] || name;
        const value = line.slice(i + 1).trim();
        (msg.headers[name] = msg.headers[name] || []).push(value);
    }
    msg.header = name => (msg.headers[name] || [])[0];
    const cseq = /^(\d+)\s+(\w+)/.exec(msg.header('cseq') || '');
    msg.cseq = cseq ? { seq: Number(cseq[1]), method: cseq[2] } : null;
    return msg;
}

const tagOf = header => (/;\s*tag=([^;>\s]+)/.exec(header || '') || [])[1];
const uriOf = header => {
    const m = /<([^>]+)>/.exec(header || '');
    return m ? m[1] : String(header || '').split(';')[0].trim();
};

class Call extends EventEmitter {
    constructor(server, invite, rinfo) {
        super();
        this.server = server;
        this.invite = invite;
        this.rinfo = rinfo;
        this.callId = invite.header('call-id');
        this.remoteTag = tagOf(invite.header('from'));
        this.localTag = randomTag();
        this.from = invite.header('from');
        this.remoteSdp = invite.body;
        this.remoteContact = uriOf(invite.header('contact')) || uriOf(invite.header('from'));
        this.state = 'ringing'; // ringing -> answered -> confirmed -> ended
        this.localCseq = Math.floor(Math.random() * 10000) + 1;
        this.lastFinal = null;
        this.retransmit = null;
    }

    /** Display name or user part of the caller. */
    get caller() {
        const m = /^\s*"?([^"<]*)"?\s*<sip:([^@>;]+)/.exec(this.from || '');
        return m ? (m[1].trim() || m[2]) : this.from;
    }

    answer(sdp) {
        if (this.state !== 'ringing') {
            return;
        }
        this.state = 'answered';
        this.localSdp = sdp;
        this.lastFinal = this.server.buildResponse(this.invite, 200, {
            toTag: this.localTag,
            contact: true,
            body: sdp,
            contentType: 'application/sdp',
        });
        // Resend 200 OK until ACK (RFC 3261 13.3.1.4).
        let interval = T1;
        const started = Date.now();
        const send = () => {
            if (this.state !== 'answered') {
                return;
            }
            if (Date.now() - started > TIMER_B) {
                this._end('no ACK');
                return;
            }
            this.server.send(this.lastFinal, this.rinfo);
            this.retransmit = setTimeout(send, interval);
            interval = Math.min(interval * 2, 4000);
        };
        send();
    }

    reject(status = 603) {
        if (this.state !== 'ringing') {
            return;
        }
        this.lastFinal = this.server.buildResponse(this.invite, status, { toTag: this.localTag });
        this.server.send(this.lastFinal, this.rinfo);
        this._end(`rejected ${status}`);
    }

    hangup() {
        if (this.state === 'ringing') {
            this.reject(486);
            return;
        }
        if (this.state === 'ended') {
            return;
        }
        this.localCseq++;
        const bye = this.server.buildRequest('BYE', this.remoteContact, {
            callId: this.callId,
            from: this._localHeader(),
            to: this.from,
            cseq: this.localCseq,
        });
        // Resend BYE a few times (UDP), stop when the 200 arrives or the call is gone.
        let tries = 0;
        const send = () => {
            if (tries++ > 6 || this.byeDone) {
                return;
            }
            this.server.send(bye, this.rinfo);
            this.byeTimer = setTimeout(send, T1 * 2 ** Math.min(tries, 3));
        };
        this.server.pendingBye.set(`${this.callId}:${this.localCseq}`, this);
        send();
        this._end('local hangup');
    }

    _localHeader() {
        const to = this.invite.header('to');
        return tagOf(to) ? to : `${to};tag=${this.localTag}`;
    }

    _ack() {
        if (this.state === 'answered') {
            clearTimeout(this.retransmit);
            this.state = 'confirmed';
            this.emit('confirmed');
        }
    }

    _end(reason) {
        if (this.state === 'ended') {
            return;
        }
        this.state = 'ended';
        clearTimeout(this.retransmit);
        // Keep the call around briefly to answer retransmissions.
        setTimeout(() => this.server.calls.delete(this.callId), TIMER_B).unref();
        this.emit('ended', reason);
    }
}

/** Call placed by us (e.g. "call the door station" from the camera wall / SmartView). */
class OutCall extends EventEmitter {
    constructor(server, { host, port = 5060, sdp, user = 'door' }) {
        super();
        this.outgoing = true;
        this.server = server;
        this.rinfo = { address: host, port };
        this.callId = `${randomTag()}${randomTag()}@iobroker`;
        this.localTag = randomTag();
        this.branch = `z9hG4bK${randomTag()}`;
        this.uri = `sip:${user}@${host}:${port}`;
        this.fromHeader = `"ioBroker" <sip:iobroker@${server.localIp || '0.0.0.0'}:${server.port}>;tag=${this.localTag}`;
        this.toHeader = `<${this.uri}>`;
        this.remoteContact = this.uri;
        this.localSdp = sdp;
        this.localCseq = 1;
        this.state = 'calling'; // calling -> ringing (180) -> confirmed (200) -> ended
        this.failStatus = null;
    }

    start() {
        this.invite = this.server.buildRequest('INVITE', this.uri, {
            callId: this.callId, from: this.fromHeader, to: this.toHeader, cseq: 1, branch: this.branch,
            contact: true, body: this.localSdp, contentType: 'application/sdp',
        });
        // Timer A/B: resend the INVITE until any answer, give up after 32 s.
        let interval = T1;
        const started = Date.now();
        const send = () => {
            if (this.state !== 'calling' || this.provisional) {
                return;
            }
            if (Date.now() - started > TIMER_B) {
                this._end('no answer from the intercom');
                return;
            }
            this.server.send(this.invite, this.rinfo);
            this.retransmit = setTimeout(send, interval);
            interval = Math.min(interval * 2, 4000);
        };
        send();
    }

    _response(msg) {
        if (!msg.cseq || msg.cseq.method !== 'INVITE') {
            return; // 200 to our CANCEL: the 487 for the INVITE follows
        }
        if (msg.status < 200) {
            this.provisional = true;
            clearTimeout(this.retransmit);
            if ((msg.status === 180 || msg.status === 183) && this.state === 'calling') {
                this.state = 'ringing';
                this.emit('ringing');
            }
            return;
        }
        clearTimeout(this.retransmit);
        const to = msg.header('to') || this.toHeader;
        if (msg.status >= 300) {
            // non-2xx: ACK in the same transaction (same branch), the call is over
            this.server.send(this.server.buildRequest('ACK', this.uri, { callId: this.callId, from: this.fromHeader, to, cseq: 1, branch: this.branch }), this.rinfo);
            if (this.state !== 'ended') {
                this.failStatus = msg.status;
                this._end(`failed ${msg.status} ${msg.reason || ''}`.trim());
            }
            return;
        }
        // 2xx (also retransmitted ones): new ACK to the remote contact
        this.toHeader = to;
        this.remoteContact = uriOf(msg.header('contact')) || this.uri;
        this.server.send(this.server.buildRequest('ACK', this.remoteContact, { callId: this.callId, from: this.fromHeader, to, cseq: 1 }), this.rinfo);
        if (this.state === 'ended') {
            // answered just after we hung up / cancelled: end it properly
            if (!this.byeSent) {
                this._bye();
            }
            return;
        }
        if (this.state !== 'confirmed') {
            this.state = 'confirmed';
            this.remoteSdp = msg.body;
            this.emit('answered', msg.body);
        }
    }

    /** Before the answer: CANCEL; afterwards: BYE. */
    hangup() {
        if (this.state === 'ended') {
            return;
        }
        if (this.state === 'calling' || this.state === 'ringing') {
            clearTimeout(this.retransmit);
            this.server.send(this.server.buildRequest('CANCEL', this.uri, { callId: this.callId, from: this.fromHeader, to: `<${this.uri}>`, cseq: 1, branch: this.branch }), this.rinfo);
            this._end('cancelled');
            return;
        }
        this._bye();
        this._end('local hangup');
    }

    _bye() {
        this.byeSent = true;
        this.localCseq++;
        const bye = this.server.buildRequest('BYE', this.remoteContact, { callId: this.callId, from: this.fromHeader, to: this.toHeader, cseq: this.localCseq });
        let tries = 0;
        const send = () => {
            if (tries++ > 6 || this.byeDone) {
                return;
            }
            this.server.send(bye, this.rinfo);
            this.byeTimer = setTimeout(send, T1 * 2 ** Math.min(tries, 3));
        };
        this.server.pendingBye.set(`${this.callId}:${this.localCseq}`, this);
        send();
    }

    _end(reason) {
        if (this.state === 'ended') {
            return;
        }
        this.state = 'ended';
        clearTimeout(this.retransmit);
        setTimeout(() => this.server.calls.delete(this.callId), TIMER_B).unref();
        this.emit('ended', reason);
    }
}

class SipServer extends EventEmitter {
    /**
     * @param {object} options
     * @param {number} [options.port] UDP port (5060)
     * @param {string[]} [options.allowed] IP addresses allowed to call (empty = all)
     * @param {object} options.log
     */
    constructor({ port = 5060, allowed = [], log }) {
        super();
        this.port = port;
        this.allowed = allowed.filter(Boolean);
        this.log = log;
        this.calls = new Map();
        this.pendingBye = new Map();
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
        this.socket.on('error', err => this.log.warn(`SIP: ${err.message}`));
    }

    listen() {
        return new Promise((resolve, reject) => {
            this.socket.once('error', reject);
            this.socket.bind(this.port, () => {
                this.socket.removeListener('error', reject);
                this.port = this.socket.address().port;
                resolve(this.port);
            });
        });
    }

    close() {
        for (const call of this.calls.values()) {
            if (call.state !== 'ended') {
                call.hangup();
            }
        }
        return new Promise(resolve => {
            // Give a final BYE a moment to leave.
            setTimeout(() => {
                this.closed = true;
                for (const call of this.calls.values()) {
                    clearTimeout(call.byeTimer);
                    clearTimeout(call.retransmit);
                }
                try {
                    this.socket.close(() => resolve());
                } catch {
                    resolve();
                }
            }, 50);
        });
    }

    /** Local IP address used to reach a remote host (for Via, Contact, SDP). */
    localAddressFor(host) {
        return new Promise(resolve => {
            const probe = dgram.createSocket('udp4');
            probe.connect(9, host, () => {
                const addr = probe.address().address;
                probe.close();
                resolve(addr);
            });
            probe.on('error', () => {
                probe.close();
                resolve('127.0.0.1');
            });
        });
    }

    send(text, rinfo) {
        if (this.closed) {
            return;
        }
        try {
            this.socket.send(Buffer.from(text), rinfo.port, rinfo.address);
        } catch (err) {
            this.log.debug(`SIP send failed: ${err.message}`);
        }
    }

    buildResponse(req, status, { toTag, contact = false, body = '', contentType } = {}) {
        const lines = [`SIP/2.0 ${status} ${REASONS[status] || 'Unknown'}`];
        for (const via of req.headers.via || []) {
            lines.push(`Via: ${via}`);
        }
        lines.push(`From: ${req.header('from')}`);
        const to = req.header('to');
        lines.push(`To: ${toTag && !tagOf(to) && status > 100 ? `${to};tag=${toTag}` : to}`);
        lines.push(`Call-ID: ${req.header('call-id')}`, `CSeq: ${req.header('cseq')}`);
        if (contact) {
            lines.push(`Contact: <sip:iobroker@${this.localIp || '0.0.0.0'}:${this.port}>`);
        }
        if (status === 200 && req.method === 'INVITE') {
            lines.push('Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, INFO');
        }
        lines.push('User-Agent: ioBroker.livecam');
        if (body) {
            lines.push(`Content-Type: ${contentType}`);
        }
        lines.push(`Content-Length: ${Buffer.byteLength(body)}`, '', body);
        return lines.join('\r\n');
    }

    buildRequest(method, uri, { callId, from, to, cseq, body = '', branch = `z9hG4bK${randomTag()}`, contact = false, contentType }) {
        return [
            `${method} ${uri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${this.localIp || '0.0.0.0'}:${this.port};branch=${branch};rport`,
            'Max-Forwards: 70',
            `From: ${from}`,
            `To: ${to}`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq} ${method}`,
            ...(contact ? [`Contact: <sip:iobroker@${this.localIp || '0.0.0.0'}:${this.port}>`, 'Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, INFO'] : []),
            'User-Agent: ioBroker.livecam',
            ...(body ? [`Content-Type: ${contentType}`] : []),
            `Content-Length: ${Buffer.byteLength(body)}`,
            '',
            body,
        ].join('\r\n');
    }

    /** Call the intercom (peer to peer). `localIp` must be known (localAddressFor). Returns the OutCall, not started. */
    invite({ host, port = 5060, sdp, user }) {
        const call = new OutCall(this, { host, port, sdp, user });
        this.calls.set(call.callId, call);
        return call;
    }

    async _onMessage(buf, rinfo) {
        let msg;
        try {
            msg = parseMessage(buf);
        } catch {
            return; // keep-alive CRLFs etc.
        }
        if (msg.status) {
            // Response to a call we placed (INVITE / CANCEL)
            const out = this.calls.get(msg.header('call-id'));
            if (out && out.outgoing && msg.cseq && msg.cseq.method !== 'BYE') {
                out._response(msg);
                return;
            }
            // Response to our BYE.
            const key = `${msg.header('call-id')}:${msg.cseq && msg.cseq.seq}`;
            const call = this.pendingBye.get(key);
            if (call) {
                call.byeDone = true;
                clearTimeout(call.byeTimer);
                this.pendingBye.delete(key);
            }
            return;
        }
        if (this.allowed.length && !this.allowed.includes(rinfo.address)) {
            if (msg.method !== 'ACK') {
                this.send(this.buildResponse(msg, 403), rinfo);
            }
            this.log.warn(`SIP: ${msg.method} from ${rinfo.address} rejected (not the configured intercom)`);
            return;
        }
        const callId = msg.header('call-id');
        const call = this.calls.get(callId);
        switch (msg.method) {
            case 'INVITE':
                if (call) {
                    if (call.state === 'confirmed' || call.state === 'answered') {
                        if (msg.cseq.seq > call.invite.cseq.seq) {
                            // re-INVITE (e.g. session refresh): answer with the same SDP.
                            this.send(this.buildResponse(msg, 200, { toTag: call.localTag, contact: true, body: call.localSdp || '', contentType: 'application/sdp' }), rinfo);
                        } else if (call.lastFinal) {
                            this.send(call.lastFinal, rinfo); // retransmitted INVITE
                        }
                    } else if (call.state === 'ringing') {
                        this.send(this.buildResponse(msg, 180, { toTag: call.localTag }), rinfo);
                    } else if (call.lastFinal) {
                        this.send(call.lastFinal, rinfo);
                    }
                    return;
                }
                if (tagOf(msg.header('to'))) {
                    this.send(this.buildResponse(msg, 481), rinfo);
                    return;
                }
                if (!this.localIp) {
                    this.localIp = await this.localAddressFor(rinfo.address);
                    if (this.calls.has(callId)) {
                        return; // retransmission arrived meanwhile
                    }
                }
                {
                    const newCall = new Call(this, msg, rinfo);
                    this.calls.set(callId, newCall);
                    this.send(this.buildResponse(msg, 100), rinfo);
                    this.send(this.buildResponse(msg, 180, { toTag: newCall.localTag }), rinfo);
                    this.emit('invite', newCall);
                }
                return;
            case 'ACK':
                if (call) {
                    call._ack();
                }
                return;
            case 'CANCEL':
                this.send(this.buildResponse(msg, 200), rinfo);
                if (call && call.state === 'ringing') {
                    call.lastFinal = this.buildResponse(call.invite, 487, { toTag: call.localTag });
                    this.send(call.lastFinal, rinfo);
                    call._end('cancelled');
                }
                return;
            case 'BYE':
                this.send(this.buildResponse(msg, call ? 200 : 481), rinfo);
                if (call) {
                    call._end('remote hangup');
                }
                return;
            case 'OPTIONS':
            case 'INFO':
            case 'NOTIFY':
                this.send(this.buildResponse(msg, 200), rinfo);
                return;
            default:
                this.send(this.buildResponse(msg, 405), rinfo);
        }
    }
}

module.exports = { SipServer, Call, OutCall, parseMessage, tagOf };
