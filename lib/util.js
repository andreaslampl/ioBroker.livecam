'use strict';

/** Object ID part from a camera name: "Haustür Nord" -> "haustuer_nord". */
function cameraId(name, index) {
    const id = String(name || '')
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return id || `cam${index + 1}`;
}

module.exports = { cameraId };

/** True for a plausible host: IPv4 with 4 octets 0-255, or a host name; an optional :port is allowed. */
function validHost(host) {
    let h = String(host || '').trim();
    const port = /:(\d{1,5})$/.exec(h);
    if (port) {
        if (Number(port[1]) < 1 || Number(port[1]) > 65535) {
            return false;
        }
        h = h.slice(0, port.index);
    }
    if (/^[\d.]+$/.test(h)) {
        const parts = h.split('.');
        return parts.length === 4 && parts.every(p => p !== '' && Number(p) <= 255);
    }
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h);
}

/**
 * Complete a camera URL: "/axis-media/media.amp" plus host 10.0.0.5 becomes
 * "rtsp://10.0.0.5/axis-media/media.amp" (http:// for snapshots); a URL
 * without scheme ("10.0.0.5/path") gets one too.
 */
function completeUrl(type, url, host) {
    const u = String(url || '').trim();
    if (!u || /^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
        return u;
    }
    const h = String(host || '').trim();
    const scheme = type === 'snapshot' ? (/:443$/.test(h) ? 'https' : 'http') : 'rtsp';
    if (u.startsWith('/')) {
        return h ? `${scheme}://${h}${u}` : u;
    }
    return `${scheme}://${u}`;
}

module.exports.validHost = validHost;
module.exports.completeUrl = completeUrl;
