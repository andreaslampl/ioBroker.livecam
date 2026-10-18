'use strict';

/*
 * Minimal ONVIF client: finds the media profiles of a camera and returns the
 * RTSP stream URI and the snapshot URI of one profile.
 *
 * Authentication uses WS-Security UsernameToken (password digest) and, if the
 * camera asks for it, HTTP Digest on top. The camera clock is read first
 * (GetSystemDateAndTime needs no login), because many cameras reject tokens
 * whose timestamp is off by more than a few seconds.
 */

const crypto = require('node:crypto');
const { HttpClient } = require('./http-client');

const NS = {
    soap: 'http://www.w3.org/2003/05/soap-envelope',
    tds: 'http://www.onvif.org/ver10/device/wsdl',
    trt: 'http://www.onvif.org/ver10/media/wsdl',
    tt: 'http://www.onvif.org/ver10/schema',
};

class OnvifError extends Error {}

/** Text of the first element with this local name (any namespace prefix). */
function tag(xml, name) {
    const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
    return m ? m[1].trim() : null;
}

function decodeXml(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

class OnvifClient {
    /**
     * @param {object} options
     * @param {string} options.host camera host name or IP
     * @param {number} [options.port] ONVIF HTTP port (usually 80)
     * @param {string} [options.user]
     * @param {string} [options.password]
     */
    constructor({ host, port = 80, user = '', password = '', timeout = 10000 }) {
        this.host = host;
        this.port = port;
        this.user = user;
        this.password = password;
        this.deviceUrl = `http://${host}:${port}/onvif/device_service`;
        this.http = new HttpClient({ user, password, timeout });
        this.timeOffset = 0;
    }

    _security() {
        if (!this.user) {
            return '';
        }
        const nonce = crypto.randomBytes(16);
        const created = new Date(Date.now() + this.timeOffset).toISOString().replace(/\.\d+Z$/, 'Z');
        const digest = crypto
            .createHash('sha1')
            .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.password)]))
            .digest('base64');
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return (
            '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
            `<UsernameToken><Username>${esc(this.user)}</Username>` +
            `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
            `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>` +
            `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
            '</UsernameToken></Security></s:Header>'
        );
    }

    async _call(url, body, { auth = true } = {}) {
        const envelope =
            `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.soap}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tt="${NS.tt}">` +
            `${auth ? this._security() : ''}<s:Body>${body}</s:Body></s:Envelope>`;
        let res;
        try {
            res = await this.http.request(url, {
                method: 'POST',
                body: envelope,
                headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
            });
        } catch (err) {
            throw new OnvifError(`ONVIF ${this.host}: ${err.message}`);
        }
        const text = res.body.toString('utf8');
        if (res.status >= 400 || /<(?:[\w-]+:)?Fault>/.test(text)) {
            const reason = tag(text, 'Text') || tag(text, 'Reason') || `HTTP ${res.status}`;
            throw new OnvifError(`ONVIF ${this.host}: ${decodeXml(reason.replace(/<[^>]+>/g, ''))}`);
        }
        return text;
    }

    /** Read the camera clock and remember the offset to our clock. */
    async syncTime() {
        try {
            const xml = await this._call(this.deviceUrl, '<tds:GetSystemDateAndTime/>', { auth: false });
            const utc = tag(xml, 'UTCDateTime');
            if (!utc) {
                return;
            }
            const n = name => Number(tag(utc, name));
            const camera = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
            if (Number.isFinite(camera)) {
                this.timeOffset = camera - Date.now();
            }
        } catch {
            // Not fatal: try with our own clock.
        }
    }

    /** Use the configured host in URIs from the camera (cameras behind NAT report internal addresses). */
    _fixHost(uri) {
        try {
            const u = new URL(uri);
            u.hostname = this.host;
            return u.toString();
        } catch {
            return uri;
        }
    }

    async getMediaUrl() {
        const xml = await this._call(this.deviceUrl, '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>');
        const media = tag(xml, 'Media');
        const xaddr = media && tag(media, 'XAddr');
        if (!xaddr) {
            throw new OnvifError(`ONVIF ${this.host}: camera has no media service`);
        }
        return this._fixHost(decodeXml(xaddr));
    }

    /** @returns {Promise<Array<{token: string, name: string, width: number, height: number}>>} */
    async getProfiles(mediaUrl) {
        const xml = await this._call(mediaUrl, '<trt:GetProfiles/>');
        const out = [];
        const re = /<(?:[\w-]+:)?Profiles\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Profiles>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            const token = /\btoken="([^"]+)"/.exec(m[1]);
            if (!token) {
                continue;
            }
            const resolution = tag(m[2], 'Resolution') || '';
            out.push({
                token: token[1],
                name: decodeXml(tag(m[2], 'Name') || token[1]),
                width: Number(tag(resolution, 'Width')) || 0,
                height: Number(tag(resolution, 'Height')) || 0,
            });
        }
        return out;
    }

    async getStreamUri(mediaUrl, token) {
        const xml = await this._call(
            mediaUrl,
            '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>' +
                `<trt:ProfileToken>${token}</trt:ProfileToken></trt:GetStreamUri>`,
        );
        const uri = tag(xml, 'Uri');
        return uri ? this._fixHost(decodeXml(uri)) : null;
    }

    async getSnapshotUri(mediaUrl, token) {
        try {
            const xml = await this._call(mediaUrl, `<trt:GetSnapshotUri><trt:ProfileToken>${token}</trt:ProfileToken></trt:GetSnapshotUri>`);
            const uri = tag(xml, 'Uri');
            return uri ? this._fixHost(decodeXml(uri)) : null;
        } catch {
            return null;
        }
    }

    /**
     * Stream and snapshot URI of one profile.
     *
     * @param {number} profileIndex 0 = first profile (usually the main stream), 1 = second (often a lighter sub stream)
     */
    async resolve(profileIndex = 0) {
        await this.syncTime();
        const mediaUrl = await this.getMediaUrl();
        const profiles = await this.getProfiles(mediaUrl);
        if (!profiles.length) {
            throw new OnvifError(`ONVIF ${this.host}: no media profiles`);
        }
        const profile = profiles[Math.min(Math.max(0, profileIndex), profiles.length - 1)];
        return {
            profile,
            profiles,
            streamUri: await this.getStreamUri(mediaUrl, profile.token),
            snapshotUri: await this.getSnapshotUri(mediaUrl, profile.token),
        };
    }
}

module.exports = { OnvifClient, OnvifError };
