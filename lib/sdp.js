'use strict';

/*
 * Just enough SDP for an audio call with a door intercom: G.711 (PCMU/PCMA)
 * plus RFC 4733 telephone-event for DTMF. Video offered by the intercom is
 * declined (the picture comes from the camera stream instead).
 */

const STATIC = { 0: 'PCMU', 8: 'PCMA' };

/** @returns {{address: string, audio: {port: number, payloads: number[], rtpmap: object}|null, media: string[]}} */
function parseSdp(text) {
    const out = { address: null, audio: null, media: [] };
    let current = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        let m;
        if ((m = /^c=IN IP4 (\S+)/.exec(line))) {
            if (current) {
                current.address = m[1];
            } else {
                out.address = m[1];
            }
        } else if ((m = /^m=(\w+) (\d+)(?:\/\d+)? (\S+) ?(.*)$/.exec(line))) {
            current = { kind: m[1], port: Number(m[2]), proto: m[3], payloads: m[4].split(/\s+/).filter(Boolean).map(Number), rtpmap: {} };
            out.media.push(current);
            if (m[1] === 'audio' && !out.audio) {
                out.audio = current;
            }
        } else if ((m = /^a=rtpmap:(\d+) ([\w-]+)\/(\d+)/.exec(line)) && current) {
            current.rtpmap[Number(m[1])] = { name: m[2].toUpperCase(), rate: Number(m[3]) };
        }
    }
    for (const media of out.media) {
        media.address = media.address || out.address;
    }
    return out;
}

/** Pick the first G.711 codec in the caller's order of preference, plus telephone-event. */
function chooseCodec(audio) {
    if (!audio) {
        return null;
    }
    const name = pt => (audio.rtpmap[pt] ? audio.rtpmap[pt].name : STATIC[pt]);
    const codecPt = audio.payloads.find(pt => name(pt) === 'PCMU' || name(pt) === 'PCMA');
    if (codecPt === undefined) {
        return null;
    }
    const dtmf = audio.payloads.find(pt => name(pt) === 'TELEPHONE-EVENT' && audio.rtpmap[pt].rate === 8000);
    return { payloadType: codecPt, name: name(codecPt), dtmfPayloadType: dtmf === undefined ? null : dtmf };
}

/** SDP answer for the intercom. */
function buildAnswer({ ip, port, codec, offer }) {
    const sessionId = Date.now();
    const pts = [codec.payloadType, ...(codec.dtmfPayloadType !== null ? [codec.dtmfPayloadType] : [])];
    const lines = [
        'v=0',
        `o=iobroker ${sessionId} ${sessionId} IN IP4 ${ip}`,
        's=ioBroker livecam',
        `c=IN IP4 ${ip}`,
        't=0 0',
    ];
    // One answer m-line per offered m-line, in the same order; everything but audio is declined.
    let audioDone = false;
    for (const media of offer.media) {
        if (media.kind === 'audio' && !audioDone) {
            audioDone = true;
            lines.push(`m=audio ${port} RTP/AVP ${pts.join(' ')}`);
            lines.push(`a=rtpmap:${codec.payloadType} ${codec.name}/8000`);
            if (codec.dtmfPayloadType !== null) {
                lines.push(`a=rtpmap:${codec.dtmfPayloadType} telephone-event/8000`, `a=fmtp:${codec.dtmfPayloadType} 0-15`);
            }
            lines.push('a=ptime:20', 'a=sendrecv');
        } else {
            lines.push(`m=${media.kind} 0 ${media.proto} ${media.payloads.length ? media.payloads[0] : 0}`);
        }
    }
    return `${lines.join('\r\n')}\r\n`;
}

module.exports = { parseSdp, chooseCodec, buildAnswer };
