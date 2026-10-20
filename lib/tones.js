'use strict';

/*
 * Ring tones, shared by the camera wall (/view) and the ring tone page (/tones).
 * `toneEngine` runs in the browser: it is inserted into the pages with toString(), so it must not
 * use Node APIs, backticks or template placeholders.
 */

const TONE_LABELS = {
    dingdong: 'Ding-Dong',
    gong: 'Gong',
    chime: 'Glockenspiel',
    bell: 'Glocke',
    phone: 'Telefon',
    westminster: 'Westminster',
    elise: 'Für Elise',
    ode: 'Ode an die Freude',
    jakob: 'Bruder Jakob',
    entchen: 'Alle meine Entchen',
    kuckuck: 'Kuckuck',
    xylophon: 'Xylophon',
    harfe: 'Harfe',
    dreiklang: 'Dreiklang',
    custom: 'Eigene Tondatei',
};

function toneEngine() {
    // Melodies written as "note/beats" (e.g. "E5/1 D#5/0.5", "-/1" = rest); only old, free tunes.
    function mel(spec, beat, extra) {
        const names = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
        const notes = [];
        let t = 0;
        for (const part of spec.trim().split(/\s+/)) {
            const [n, len] = part.split('/');
            const beats = Number(len || 1);
            const m = /^([A-G]#?)(\d)$/.exec(n);
            if (m) {
                notes.push([440 * Math.pow(2, (12 * (Number(m[2]) + 1) + names[m[1]] - 69) / 12), t, Math.max(0.15, beats * beat * 0.95)]);
            }
            t += beats * beat;
        }
        return Object.assign({ every: Math.round((t + 1.5) * 1000), notes }, extra || {});
    }
    // [frequency Hz, start s, duration s]; notes with the same start sound together
    const TONES = {
        dingdong: { every: 2500, notes: [[880, 0, 0.6], [660, 0.7, 0.9]] },
        gong: { every: 3600, notes: [[659, 0, 1.2], [523, 0.6, 1.2], [587, 1.2, 1.2], [392, 1.8, 1.8]] },
        chime: { every: 2800, notes: [[523, 0, 0.5], [659, 0.3, 0.5], [784, 0.6, 0.5], [1047, 0.9, 1.0]] },
        bell: { every: 2000, notes: [[1319, 0, 0.4], [1319, 0.45, 0.4], [1319, 0.9, 0.6]] },
        phone: { every: 3000, notes: [[440, 0, 0.9], [480, 0, 0.9], [440, 1.1, 0.9], [480, 1.1, 0.9]] },
        // full Westminster quarter chimes (four phrases)
        westminster: mel('G#4/1 F#4/1 E4/1 B3/2 -/1 E4/1 G#4/1 F#4/1 B3/2 -/1 E4/1 F#4/1 G#4/1 E4/2 -/1 G#4/1 E4/1 F#4/1 B3/2', 0.45),
        elise: mel('E5/0.5 D#5/0.5 E5/0.5 D#5/0.5 E5/0.5 B4/0.5 D5/0.5 C5/0.5 A4/1.5 -/0.5 C4/0.5 E4/0.5 A4/0.5 B4/1.5 -/0.5 E4/0.5 G#4/0.5 B4/0.5 C5/1.5', 0.32, { wave: 'triangle' }),
        ode: mel('E4/1 E4/1 F4/1 G4/1 G4/1 F4/1 E4/1 D4/1 C4/1 C4/1 D4/1 E4/1 E4/1.5 D4/0.5 D4/2', 0.33, { wave: 'triangle' }),
        jakob: mel('C5/1 D5/1 E5/1 C5/1 C5/1 D5/1 E5/1 C5/1 E5/1 F5/1 G5/2 E5/1 F5/1 G5/2', 0.3, { wave: 'triangle' }),
        entchen: mel('C5/1 D5/1 E5/1 F5/1 G5/2 G5/2 A5/1 A5/1 A5/1 A5/1 G5/4', 0.25, { wave: 'triangle' }),
        kuckuck: mel('G5/1 E5/2 -/1 G5/1 E5/2', 0.35),
        xylophon: mel('C5/0.5 E5/0.5 G5/0.5 C6/0.5 G5/0.5 E5/0.5 C5/1', 0.18, { wave: 'triangle' }),
        harfe: mel('C4/0.5 E4/0.5 G4/0.5 C5/0.5 E5/0.5 G5/0.5 C6/2', 0.16),
        dreiklang: mel('E5/1 C5/1 G4/2', 0.35),
    };
    let ctx = null;
    let timer = null;
    let audio = null;

    function context() {
        ctx = ctx || new AudioContext();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }
        return ctx;
    }
    function note(freq, start, dur, wave, volume) {
        const c = context();
        const o = c.createOscillator();
        const g = c.createGain();
        o.frequency.value = freq;
        o.type = wave || 'sine';
        const peak = Math.max(0.0002, 0.5 * volume);
        g.gain.setValueAtTime(0.0001, c.currentTime + start);
        g.gain.exponentialRampToValueAtTime(peak, c.currentTime + start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
        o.connect(g).connect(c.destination);
        o.start(c.currentTime + start);
        o.stop(c.currentTime + start + dur + 0.05);
    }
    function stop() {
        clearInterval(timer);
        timer = null;
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
        }
    }
    /**
     * Play a tone. volume 0..1; loop: repeat until stop() (ringing), otherwise once (preview).
     * Returns the length of one round in ms; onError(text) when the browser blocks the sound.
     */
    function play(name, volume, options) {
        const o = options || {};
        stop();
        if (name === 'custom') {
            if (!o.customUrl) {
                return 0;
            }
            if (!audio || audio.src !== new URL(o.customUrl, location.href).href) {
                audio = new Audio(o.customUrl);
            }
            audio.loop = Boolean(o.loop);
            audio.volume = volume;
            audio.play().catch(() => o.onError && o.onError('blocked'));
            return 8000;
        }
        const t = TONES[name] || TONES.dingdong;
        try {
            const round = () => {
                for (const n of t.notes) {
                    note(n[0], n[1], n[2], t.wave, volume);
                }
            };
            round();
            if (o.loop) {
                timer = setInterval(round, t.every);
            }
        } catch (e) {
            if (o.onError) {
                o.onError('blocked');
            }
        }
        return t.every;
    }
    // browsers allow sound only after the first touch/click on the page
    addEventListener(
        'pointerdown',
        () => {
            try {
                context();
            } catch (e) {
                // no Web Audio
            }
        },
        { once: true },
    );
    return { TONES, play, stop };
}

module.exports = { TONE_LABELS, toneEngine };
