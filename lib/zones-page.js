'use strict';

/*
 * /zones: draw the detection areas on the camera picture (touch or mouse). Each tap adds a corner, "Bereich
 * schließen" finishes a polygon (several per camera), "Speichern" posts them to /zones/<id>. Coordinates are
 * fractions of the picture (0..1), so they fit any resolution.
 */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderZones({ cameras, key }) {
    const q = key ? `key=${encodeURIComponent(key)}` : '';
    const data = JSON.stringify(cameras.map(c => ({ id: c.id, name: c.name, zones: c.zones || [] }))).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Erkennungs-Bereiche</title><style>
body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#111;color:#eee;padding:12px}
h1{font-size:20px;margin:4px 0 10px}select,button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;margin:4px 6px 4px 0}
button.primary{background:#2f81f7;border-color:#2f81f7}.wrap{position:relative;display:inline-block;max-width:100%;touch-action:none}
.wrap img{display:block;max-width:100%;max-height:70vh}canvas{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair}
.help{color:#aaa;font-size:14px;margin:8px 0}#msg{margin-left:8px}</style></head><body>
<h1>Erkennungs-Bereiche</h1>
<div><select id="cam"></select><button id="close">Bereich schließen</button><button id="undo">Letzten Punkt weg</button><button id="clear">Alle Bereiche löschen</button><button class="primary" id="save">Speichern</button><span id="msg"></span></div>
<div class="help">Auf das Bild tippen = Ecke setzen. Mit „Bereich schließen“ ist ein Bereich fertig, dann kann der nächste beginnen. Gezählt wird, wer mit den Füßen (Unterkante) im Bereich steht. Kein Bereich = ganzes Bild.</div>
<div class="wrap" id="wrap"><img id="img" alt=""><canvas id="cv"></canvas></div>
<script>
const CAMS = ${data};
const Q = ${JSON.stringify(q)};
const sel = document.getElementById('cam'), img = document.getElementById('img'), cv = document.getElementById('cv'), msg = document.getElementById('msg');
let cam = null, zones = [], cur = [];
for (const c of CAMS) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.appendChild(o); }
function pick() {
  cam = CAMS.find(c => c.id === sel.value) || CAMS[0];
  if (!cam) { msg.textContent = 'Keine Kamera mit KI-Erkennung (Einstellungen → Kameratabelle → Spalte „KI-Erkennung“).'; return; }
  zones = JSON.parse(JSON.stringify(cam.zones)); cur = [];
  img.src = 'cam/' + cam.id + '.jpg?' + (Q ? Q + '&' : '') + 'fresh=1&t=' + Date.now();
}
function draw() {
  const r = img.getBoundingClientRect(); cv.width = r.width; cv.height = r.height;
  const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  const poly = (pts, done) => { if (!pts.length) return; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, x * cv.width, y * cv.height)); if (done) g.closePath();
    g.fillStyle = 'rgba(47,129,247,.25)'; if (done) g.fill(); g.strokeStyle = done ? '#2f81f7' : '#f0883e'; g.lineWidth = 3; g.stroke();
    for (const [x, y] of pts) { g.fillStyle = done ? '#2f81f7' : '#f0883e'; g.beginPath(); g.arc(x * cv.width, y * cv.height, 5, 0, 7); g.fill(); } };
  zones.forEach(z => poly(z, true)); poly(cur, false);
}
img.onload = draw; window.addEventListener('resize', draw);
cv.addEventListener('pointerdown', e => { const r = cv.getBoundingClientRect();
  cur.push([+((e.clientX - r.left) / r.width).toFixed(4), +((e.clientY - r.top) / r.height).toFixed(4)]); draw(); });
document.getElementById('close').onclick = () => { if (cur.length >= 3) { zones.push(cur); cur = []; draw(); } else msg.textContent = 'Mindestens 3 Ecken setzen'; };
document.getElementById('undo').onclick = () => { if (cur.length) cur.pop(); else zones.pop(); draw(); };
document.getElementById('clear').onclick = () => { zones = []; cur = []; draw(); };
document.getElementById('save').onclick = async () => {
  if (cur.length >= 3) { zones.push(cur); cur = []; }
  const r = await fetch('zones/' + cam.id + (Q ? '?' + Q : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(zones) });
  const t = await r.json().catch(() => ({}));
  if (r.ok) { cam.zones = t.zones; zones = JSON.parse(JSON.stringify(t.zones)); draw(); msg.textContent = '✓ gespeichert (' + (t.zones.length ? t.zones.length + ' Bereich(e)' : 'ganzes Bild') + ')'; }
  else msg.textContent = 'Fehler: ' + (t.error || r.status);
};
sel.onchange = pick; pick();
</script></body></html>`;
}

module.exports = { renderZones, esc };
