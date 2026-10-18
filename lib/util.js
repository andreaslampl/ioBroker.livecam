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
