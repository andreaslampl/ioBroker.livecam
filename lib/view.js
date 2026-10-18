'use strict';

/*
 * Camera wall with intercom for a touch PC, embedded in VIS-2:
 * all (or selected) cameras in a grid; when the intercom rings its camera goes
 * full screen with a ring tone and answer / hang up / door buttons.
 * Audio runs over WebRTC to the adapter (see intercom.js).
 */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * @param {object} options
 * @param {Array<{id: string, name: string}>} options.cameras
 * @param {string} options.intercomCamera camera id of the intercom ('' = none)
 * @param {boolean} options.intercom intercom enabled
 * @param {string} options.key access key ('' = none)
 */
function renderView({ cameras, intercomCamera, intercom, key }) {
    const config = JSON.stringify({ cameras, intercomCamera, intercom, key }).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>livecam</title>
<style>
  :root { --bg: #000; --fg: #fff; --tile: #111; --green: #1f9d55; --red: #d64545; --blue: #2b6cb0; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; overflow: hidden; }
  #grid { display: grid; gap: 4px; height: 100%; padding: 4px; box-sizing: border-box; }
  .tile { position: relative; background: var(--tile); overflow: hidden; min-height: 0; }
  .tile img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .tile .name { position: absolute; left: 8px; bottom: 6px; font-size: 14px; text-shadow: 0 0 4px #000; }
  .tile .off { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; color: #aaa; }
  .tile.offline .off { display: flex; }
  .tile.big { position: fixed; inset: 0; z-index: 10; background: #000; }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: none; gap: 16px; justify-content: center;
         align-items: center; padding: 16px; background: rgba(0,0,0,.65); flex-wrap: wrap; }
  body.call #bar { display: flex; }
  #info { position: fixed; top: 0; left: 0; right: 0; z-index: 20; display: none; text-align: center; padding: 12px;
          font-size: 22px; background: rgba(0,0,0,.6); }
  body.call #info { display: block; }
  button { font-size: 22px; padding: 18px 34px; border: 0; border-radius: 40px; color: #fff; min-width: 180px; cursor: pointer; }
  button:active { transform: scale(.97); }
  #answer { background: var(--green); } #hangup { background: var(--red); } #door { background: var(--blue); }
  #warn { position: fixed; top: 0; left: 0; right: 0; z-index: 30; background: #b7791f; color: #000; padding: 8px 12px; display: none; font-size: 14px; }
  body.ringing #info { animation: blink 1s infinite; }
  #missed { position: fixed; left: 12px; top: 12px; z-index: 15; display: none; background: var(--red); color: #fff;
            border-radius: 24px; padding: 10px 18px; font-size: 18px; min-width: 0; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
  body.call #missed, body.list #missed { display: none !important; }
  #calls { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.92); display: none; flex-direction: column; }
  #calls.open { display: flex; }
  #calls header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; font-size: 22px; }
  #calls header span { flex: 1; }
  #calls header button { font-size: 18px; padding: 10px 22px; min-width: 0; background: #444; }
  #calls header #seen { background: var(--green); }
  #list { overflow-y: auto; padding: 0 16px 16px; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .call { background: #1b1b1b; border-radius: 8px; overflow: hidden; border-left: 6px solid #555; }
  .call.missed { border-left-color: var(--red); } .call.answered { border-left-color: var(--green); } .call.rejected { border-left-color: #b7791f; }
  .call img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; background: #000; }
  .call div { padding: 8px 10px; font-size: 16px; } .call small { color: #aaa; }
  .call.new div { font-weight: bold; }
  @keyframes blink { 50% { background: rgba(31,157,85,.8); } }
</style>
</head>
<body>
<div id="warn"></div>
<div id="grid"></div>
<button id="missed" type="button"></button>
<div id="calls">
  <header><span>Anrufe</span><button id="seen" type="button">Gesehen</button><button id="close" type="button">Schließen</button></header>
  <div id="list"></div>
</div>
<div id="info"></div>
<div id="bar">
  <button id="answer" type="button">Abnehmen</button>
  <button id="door" type="button">Tür öffnen</button>
  <button id="hangup" type="button">Auflegen</button>
</div>
<audio id="remote" autoplay></audio>
<script>
'use strict';
const CFG = ${config};
const q = CFG.key ? '?key=' + encodeURIComponent(CFG.key) : '';
const params = new URLSearchParams(location.search);
const wanted = (params.get('cams') || '').split(',').filter(Boolean);
const cams = wanted.length ? wanted.map(id => CFG.cameras.find(c => c.id === id)).filter(Boolean) : CFG.cameras;
const grid = document.getElementById('grid');
const tiles = {};

// ---- camera tiles (reconnect on error, so images never stay away) ----
// Layout options: ?cams=a,b,c (selection and order), ?cols=3, ?big=a (tile spans 2x2),
// ?mode=mjpeg|jpg (default: live MJPEG up to 4 cameras, single images above that),
// ?fps=4 (images per second in jpg mode).
// Browsers keep at most 6 open connections per server, so more than ~5 MJPEG
// streams on one page would leave tiles black; jpg mode shares the connections.
const big = params.get('big') || '';
const slots = cams.length + (cams.some(c => c.id === big) ? 3 : 0);
const cols = Math.max(1, Number(params.get('cols')) || Math.ceil(Math.sqrt(slots || 1)));
const mode = params.get('mode') || (cams.length > 4 ? 'jpg' : 'mjpeg');
const pollMs = 1000 / Math.min(15, Math.max(0.2, Number(params.get('fps')) || 4));
grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
grid.style.gridAutoRows = '1fr';
grid.style.gridTemplateRows = 'repeat(' + Math.ceil((slots || 1) / cols) + ', 1fr)';
const camUrl = (id, ext, extra) => '/cam/' + id + '.' + ext + q + (q ? '&' : '?') + (extra || '') + 't=' + Date.now();
for (const cam of cams) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  if (cam.id === big) { tile.style.gridColumn = 'span 2'; tile.style.gridRow = 'span 2'; }
  tile.innerHTML = '<img alt=""><div class="name"></div><div class="off">Verbinde …</div>';
  tile.querySelector('.name').textContent = cam.name;
  const img = tile.querySelector('img');
  if (mode === 'jpg') {
    // Poll single images; the next one is loaded off-screen, then swapped in (no flicker).
    let timer = null;
    const poll = () => {
      clearTimeout(timer);
      const next = new Image();
      const t0 = Date.now();
      next.onload = () => {
        img.src = next.src;
        tile.classList.remove('offline');
        timer = setTimeout(poll, Math.max(0, pollMs - (Date.now() - t0)));
      };
      next.onerror = () => { tile.classList.add('offline'); timer = setTimeout(poll, 3000); };
      next.src = camUrl(cam.id, 'jpg', 'fresh=1&');
    };
    img.onerror = poll;
    poll();
  } else {
    const load = () => { img.src = camUrl(cam.id, 'mjpeg'); };
    img.onload = () => tile.classList.remove('offline');
    img.onerror = () => { tile.classList.add('offline'); setTimeout(load, 3000); };
    load();
  }
  tiles[cam.id] = tile;
  grid.appendChild(tile);
}

// ---- ring tone (Web Audio, no file needed) ----
let audioCtx = null;
let ringTimer = null;
function tone(freq, start, dur) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = freq; o.type = 'sine';
  g.gain.setValueAtTime(0.0001, audioCtx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + start + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(audioCtx.currentTime + start); o.stop(audioCtx.currentTime + start + dur + 0.05);
}
function ring(on) {
  clearInterval(ringTimer); ringTimer = null;
  if (!on) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const play = () => { tone(880, 0, 0.6); tone(660, 0.7, 0.9); };
    play(); ringTimer = setInterval(play, 2500);
  } catch (e) { warn('Klingelton blockiert: Autoplay im Browser erlauben (siehe Anleitung).'); }
}
// Unlock audio on the first touch (browsers block sound until the user interacted once).
addEventListener('pointerdown', () => { try { audioCtx = audioCtx || new AudioContext(); audioCtx.resume(); } catch (e) {} }, { once: true });

function warn(text) { const w = document.getElementById('warn'); w.textContent = text; w.style.display = text ? 'block' : 'none'; }

// ---- intercom ----
let ws = null, pc = null, mic = null, state = { state: 'idle' }, retry = 1000;
const info = document.getElementById('info');
const btnAnswer = document.getElementById('answer'), btnHangup = document.getElementById('hangup'), btnDoor = document.getElementById('door');

function render() {
  const s = state.state;
  const ringing = s === 'ringing';
  const mine = state.mine;
  document.body.classList.toggle('call', s !== 'idle');
  document.body.classList.toggle('ringing', ringing);
  if (s !== 'idle') hideCalls();
  for (const [id, tile] of Object.entries(tiles)) tile.classList.toggle('big', s !== 'idle' && id === CFG.intercomCamera);
  info.textContent = ringing ? 'Es klingelt' + (state.caller ? ' – ' + state.caller : '')
    : s === 'connecting' ? 'Verbinde …'
    : s === 'active' ? (mine ? 'Gespräch läuft' : 'Gespräch an einem anderen Gerät') : '';
  btnAnswer.style.display = ringing ? '' : 'none';
  btnHangup.textContent = ringing ? 'Ablehnen' : 'Auflegen';
  btnHangup.style.display = ringing || mine ? '' : 'none';
  btnDoor.style.display = state.doorAvailable || (s === 'active' && mine && CFG.intercom) ? '' : 'none';
  ring(ringing);
  if (s === 'idle') cleanup();
  const missed = document.getElementById('missed');
  missed.style.display = state.missed ? 'block' : 'none';
  missed.textContent = '🔔 ' + state.missed + ' verpasst';
}

// ---- call history ----
const calls = document.getElementById('calls');
const RESULT = { missed: 'Verpasst', answered: 'Angenommen', rejected: 'Abgelehnt' };
async function showCalls() {
  const list = document.getElementById('list');
  list.textContent = 'Lade …';
  calls.classList.add('open');
  document.body.classList.add('list');
  try {
    const entries = await (await fetch('/history' + q)).json();
    list.textContent = entries.length ? '' : 'Noch keine Anrufe.';
    for (const e of entries) {
      const item = document.createElement('div');
      item.className = 'call ' + e.result + (e.seen ? '' : ' new');
      const when = new Date(e.time).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      if (e.image) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = '/history/' + e.id + '.jpg' + q;
        item.appendChild(img);
      }
      const text = document.createElement('div');
      text.textContent = when + ' – ' + RESULT[e.result] + (e.duration ? ' (' + e.duration + ' s)' : '');
      const who = document.createElement('small');
      who.textContent = e.caller ? ' ' + e.caller : '';
      text.appendChild(who);
      item.appendChild(text);
      list.appendChild(item);
    }
  } catch (err) { list.textContent = 'Anrufliste nicht verfügbar: ' + err.message; }
}
document.getElementById('missed').onclick = showCalls;
function hideCalls() { calls.classList.remove('open'); document.body.classList.remove('list'); }
document.getElementById('close').onclick = hideCalls;
document.getElementById('seen').onclick = () => { ws && ws.send(JSON.stringify({ type: 'seen' })); hideCalls(); };
// Long press on the empty area of the wall also opens the list (when nothing was missed).
let pressTimer = null;
grid.addEventListener('pointerdown', () => { pressTimer = setTimeout(() => CFG.intercom && showCalls(), 1500); });
grid.addEventListener('pointerup', () => clearTimeout(pressTimer));
grid.addEventListener('pointerleave', () => clearTimeout(pressTimer));

let wasConnected = false;
function reloadImages() { for (const t of Object.values(tiles)) { const img = t.querySelector('img'); img.onerror(); } }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + q);
  ws.onopen = () => {
    retry = 1000;
    // Adapter was restarted: the old MJPEG connections are dead, reconnect all images.
    if (wasConnected) reloadImages();
    wasConnected = true;
  };
  ws.onmessage = async ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg; render(); }
    else if (msg.type === 'answer' && pc) await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    else if (msg.type === 'error') { warn(msg.message); setTimeout(() => warn(''), 8000); }
  };
  ws.onclose = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); };
}

async function answer() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    warn('Mikrofon nicht verfügbar: Diese Adresse ist im Browser nicht als sicher freigegeben (siehe Anleitung).');
    return;
  }
  ring(false);
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { warn('Kein Zugriff auf das Mikrofon: ' + e.message); return; }
  pc = new RTCPeerConnection();
  for (const t of mic.getTracks()) pc.addTrack(t, mic);
  pc.ontrack = ev => { const a = document.getElementById('remote'); a.srcObject = ev.streams[0] || new MediaStream([ev.track]); a.play().catch(() => {}); };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const t = setTimeout(res, 2000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
  ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp }));
}

function cleanup() {
  if (pc) { pc.close(); pc = null; }
  if (mic) { mic.getTracks().forEach(t => t.stop()); mic = null; }
}

btnAnswer.onclick = () => answer().catch(e => warn(e.message));
btnHangup.onclick = () => { ws && ws.send(JSON.stringify({ type: 'hangup' })); };
btnDoor.onclick = () => { ws && ws.send(JSON.stringify({ type: 'door' })); btnDoor.disabled = true; setTimeout(() => (btnDoor.disabled = false), 3000); };

if (CFG.intercom && (!navigator.mediaDevices || !window.isSecureContext)) {
  warn('Hinweis: Für das Mikrofon muss diese Adresse im Browser als sicher freigegeben sein (siehe Anleitung).');
}
render();
connect();
</script>
</body>
</html>`;
}

module.exports = { renderView, esc };
