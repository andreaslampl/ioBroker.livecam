'use strict';

/*
 * Minimal HTTP client with Basic and Digest (MD5, MD5-sess, SHA-256)
 * authentication, as used by Axis, Hanwha, Sony, Mobotix and 2N cameras.
 * The last digest challenge is reused, so polling a snapshot URL costs one
 * request per image instead of two.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

class HttpClient {
    constructor({ user = '', password = '', timeout = 10000, rejectUnauthorized = false } = {}) {
        this.user = user;
        this.password = password;
        this.timeout = timeout;
        this.rejectUnauthorized = rejectUnauthorized;
        this.challenge = null;
        this.nc = 0;
    }

    /**
     * Follows up to 3 redirects (cameras in "HTTPS only" mode redirect http -> https).
     *
     * @returns {Promise<{status: number, headers: object, body: Buffer, url: string}>}
     */
    async request(url, options = {}) {
        let current = url;
        for (let i = 0; ; i++) {
            const res = await this._request(current, options);
            if (i < 3 && [301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
                current = new URL(res.headers.location, current).toString();
                continue;
            }
            res.url = current;
            return res;
        }
    }

    /**
     * Like request(), but resolves as soon as the headers are there and leaves the body streaming
     * (MJPEG live streams): `res.stream` is the response, `res.stream.destroy()` ends it.
     *
     * @returns {Promise<{status: number, headers: object, stream: import('node:http').IncomingMessage, url: string}>}
     */
    async open(url, options = {}) {
        let current = url;
        for (let i = 0; ; i++) {
            const res = await this._request(current, { ...options, stream: true });
            if (i < 3 && [301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
                res.stream.destroy();
                current = new URL(res.headers.location, current).toString();
                continue;
            }
            res.url = current;
            return res;
        }
    }

    async _request(url, { method = 'GET', body, headers = {}, stream = false } = {}) {
        const target = new URL(url);
        let auth = this._authorization(method, target);
        let res = await this._send(target, method, body, { ...headers, ...(auth ? { Authorization: auth } : {}) }, stream);
        if (res.status === 401 && this.user) {
            if (stream) {
                res.stream.destroy();
            }
            const header = [].concat(res.headers['www-authenticate'] || []);
            const digest = header.find(h => /^digest/i.test(h));
            if (digest) {
                this.challenge = parseChallenge(digest);
                this.nc = 0;
            } else if (header.some(h => /^basic/i.test(h))) {
                this.challenge = { scheme: 'basic' };
            } else {
                return res;
            }
            auth = this._authorization(method, target);
            res = await this._send(target, method, body, { ...headers, Authorization: auth }, stream);
        }
        return res;
    }

    _authorization(method, target) {
        if (!this.user || !this.challenge) {
            return null;
        }
        if (this.challenge.scheme === 'basic') {
            return `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
        }
        const c = this.challenge;
        const algorithm = (c.algorithm || 'MD5').toUpperCase();
        const hashName = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
        const h = s => crypto.createHash(hashName).update(s).digest('hex');
        const uri = target.pathname + target.search;
        const cnonce = crypto.randomBytes(8).toString('hex');
        this.nc++;
        const nc = this.nc.toString(16).padStart(8, '0');
        let ha1 = h(`${this.user}:${c.realm}:${this.password}`);
        if (algorithm.endsWith('-SESS')) {
            ha1 = h(`${ha1}:${c.nonce}:${cnonce}`);
        }
        const ha2 = h(`${method}:${uri}`);
        const qop = c.qop ? c.qop.split(',').map(s => s.trim()).find(q => q === 'auth') : null;
        const response = qop ? h(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${c.nonce}:${ha2}`);
        const parts = [
            `username="${this.user}"`,
            `realm="${c.realm}"`,
            `nonce="${c.nonce}"`,
            `uri="${uri}"`,
            `algorithm=${c.algorithm || 'MD5'}`,
            `response="${response}"`,
        ];
        if (qop) {
            parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
        }
        if (c.opaque) {
            parts.push(`opaque="${c.opaque}"`);
        }
        return `Digest ${parts.join(', ')}`;
    }

    _send(target, method, body, headers, stream = false) {
        const lib = target.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            const req = lib.request(
                target,
                {
                    method,
                    headers: body ? { 'Content-Length': Buffer.byteLength(body), ...headers } : headers,
                    timeout: this.timeout,
                    rejectUnauthorized: this.rejectUnauthorized,
                },
                res => {
                    if (stream) {
                        resolve({ status: res.statusCode, headers: res.headers, stream: res });
                        return;
                    }
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
                    res.on('error', reject);
                },
            );
            req.on('timeout', () => req.destroy(new Error(`Timeout after ${this.timeout} ms`)));
            req.on('error', reject);
            req.end(body);
        });
    }
}

function parseChallenge(header) {
    const out = { scheme: 'digest' };
    const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
    let m;
    while ((m = re.exec(header)) !== null) {
        out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    }
    return out;
}

module.exports = { HttpClient, parseChallenge };
