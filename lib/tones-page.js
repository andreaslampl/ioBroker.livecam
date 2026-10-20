'use strict';

/*
 * /tones: listen to all ring tones, set the volume and pick the ring tone of the camera wall.
 * The choice is sent to the adapter (POST /tones/select) and stored in view.ringTone / view.ringVolume.
 */

const { TONE_LABELS, toneEngine } = require('./tones');

/**
 * @param {object} options
 * @param {string} options.current tone in use
 * @param {number} options.volume 0..100
 * @param {string} [options.customUrl] own sound file from the settings
 * @param {string} [options.key] access key
 */
function renderTones({ current, volume, customUrl = '', key = '' }) {
    const labels = Object.fromEntries(Object.entries(TONE_LABELS).filter(([id]) => id !== 'custom' || customUrl));
    const config = JSON.stringify({ current, volume, customUrl, key, labels }).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Klingeltöne</title>
<style>
  :root { --bg: #111; --fg: #fff; --muted: #9aa; --card: #1d1f22; --accent: #1f9d55; --blue: #2b6cb0; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 16px; flex-wrap: wrap; }
  h1 { font-size: 24px; margin: 0; flex: 1; }
  a.back { color: #9cf; font-size: 18px; text-decoration: none; }
  .vol { display: flex; align-items: center; gap: 12px; padding: 0 16px 12px; font-size: 18px; }
  .vol input { flex: 1; max-width: 520px; height: 36px; accent-color: var(--accent); }
  .vol output { width: 48px; }
  main { display: grid; gap: 12px; padding: 0 16px 16px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
  .tone { background: var(--card); border-radius: 16px; padding: 14px; display: flex; flex-direction: column; gap: 12px;
          border: 3px solid transparent; }
  .tone.current { border-color: var(--accent); }
  .tone .name { font-size: 20px; font-weight: 600; }
  .tone .name small { display: block; font-size: 14px; font-weight: normal; color: #7fe0a8; margin-top: 2px; min-height: 18px; }
  .row { display: flex; gap: 10px; }
  button { flex: 1; font-size: 18px; padding: 12px 8px; white-space: nowrap; border: 0; border-radius: 30px; color: #fff; cursor: pointer; background: var(--blue); }
  button.use { background: #444; }
  .tone.current button.use { background: var(--accent); }
  button:active { transform: scale(.97); }
  #msg { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); background: #b7791f; color: #000;
         padding: 10px 16px; border-radius: 8px; display: none; }
</style>
</head>
<body>
<header><h1>Klingeltöne</h1><a class="back" id="back" href="#">← Kamerawand</a></header>
<div class="vol"><span>Lautstärke</span><input id="volume" type="range" min="0" max="100"><output id="volOut"></output></div>
<main id="list"></main>
<div id="msg"></div>
<script>
'use strict';
const CFG = ${config};
const tones = (${toneEngine.toString()})();
const q = CFG.key ? '?key=' + encodeURIComponent(CFG.key) : '';
const $ = id => document.getElementById(id);
let current = CFG.current, playing = '', stopTimer = null, msgTimer = null;
$('back').href = '/view' + q;
const vol = $('volume');
vol.value = CFG.volume;
$('volOut').textContent = CFG.volume + ' %';

function show(text) {
  $('msg').textContent = text;
  $('msg').style.display = text ? 'block' : 'none';
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => show(''), 4000);
}

function stop() {
  tones.stop();
  clearTimeout(stopTimer);
  playing = '';
  render();
}

function listen(id) {
  if (playing === id) { stop(); return; }
  const ms = tones.play(id, vol.value / 100, { customUrl: CFG.customUrl, onError: () => show('Der Browser blockiert den Ton - einmal auf die Seite tippen.') });
  playing = id;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(stop, Math.max(2000, ms));
  render();
}

async function choose(id) {
  try {
    const res = await fetch('/tones/select' + q + (q ? '&' : '?') + 'tone=' + encodeURIComponent(id) + '&volume=' + vol.value, { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    current = id;
    render();
    show('„' + CFG.labels[id] + '“ ist jetzt der Klingelton.');
  } catch (e) { show('Speichern fehlgeschlagen: ' + e.message); }
}

function render() {
  const list = $('list');
  list.textContent = '';
  for (const [id, label] of Object.entries(CFG.labels)) {
    const card = document.createElement('div');
    card.className = 'tone' + (id === current ? ' current' : '');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = label;
    const sub = document.createElement('small');
    sub.textContent = id === current ? '✓ aktueller Klingelton' : '';
    name.appendChild(sub);
    const row = document.createElement('div');
    row.className = 'row';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = playing === id ? '■ Stopp' : '▶ Anhören';
    play.onclick = () => listen(id);
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'use';
    use.textContent = id === current ? 'Verwendet' : 'Verwenden';
    use.onclick = () => choose(id);
    row.append(play, use);
    card.append(name, row);
    list.appendChild(card);
  }
}

// moving the slider plays the current tone briefly; releasing it saves the volume
vol.oninput = () => { $('volOut').textContent = vol.value + ' %'; };
vol.onchange = () => { const id = playing || current; playing = ''; listen(id); choose(current); };
render();
</script>
</body>
</html>`;
}

module.exports = { renderTones };
