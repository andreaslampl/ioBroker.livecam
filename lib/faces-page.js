'use strict';

/*
 * /faces: the household's people for the face recognition - add, rename, "may open the door", delete;
 * teach in with photos (picked on the phone / PC, sent as JPEG) or live at a camera. Needs the access key.
 */

function renderFaces({ key, locked }) {
    if (locked) {
        return '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gesichter</title></head>' +
            '<body style="font:16px system-ui,sans-serif;background:#111;color:#eee;padding:12px"><h1>Gesichter</h1><p style="color:#f0a020">Bitte zuerst in den Einstellungen von livecam ' +
            'einen <b>Zugriffsschlüssel</b> setzen und diese Seite mit ?key=… öffnen. Ohne Schlüssel könnte jeder im Netz ein Gesicht einlernen.</p></body></html>';
    }
    const Q = JSON.stringify(key ? `key=${encodeURIComponent(key)}` : '');
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gesichter</title><style>
body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#111;color:#eee;padding:12px;max-width:980px}
h1{font-size:20px;margin:4px 0 10px}input,select,button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;margin:4px 6px 4px 0}
button.primary{background:#2f81f7;border-color:#2f81f7}button.danger{border-color:#a33;color:#f88}
.person{border:1px solid #333;border-radius:12px;padding:10px;margin:10px 0}.head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.head b{font-size:18px;margin-right:auto}.samples{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.s{position:relative}.s img{width:84px;height:84px;border-radius:8px;display:block}.s button{position:absolute;top:2px;right:2px;margin:0;padding:0 7px;border-radius:12px;background:rgba(0,0,0,.6)}
.help{color:#aaa;font-size:14px;margin:8px 0}#msg{margin:8px 0;min-height:22px}.warn{color:#f0a020}
.learn{margin-top:8px}.learn img{max-width:100%;max-height:260px;border-radius:8px;display:block;margin-top:6px}label.door{display:inline-flex;gap:6px;align-items:center}
</style></head><body>
<h1>Gesichter</h1>
<div class="help">Nur die Personen auf dieser Seite werden erkannt; fremde Gesichter werden nie gespeichert. Pro Person 3–10 Bilder:
von vorne, mit und ohne Brille, bei Tag und Nacht. „An Kamera einlernen“: vor die Kamera stellen und langsam den Kopf etwas drehen.</div>
<div><input id="name" placeholder="Name"><label class="door"><input type="checkbox" id="door"> darf Tür öffnen</label><button class="primary" id="add">Person anlegen</button></div>
<div id="msg"></div><div id="list"></div>
<script>
const Q = ${Q};
const api = (p, o = {}) => fetch('faces' + p + (Q ? (p.includes('?') ? '&' : '?') + Q : ''), o).then(async r => { const t = await r.json().catch(() => ({})); if (!r.ok) throw new Error(t.error || r.status); return t; });
const msg = (t, warn) => { const m = document.getElementById('msg'); m.textContent = t; m.className = warn ? 'warn' : ''; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let data = { persons: [], cameras: [] };
async function load() { data = await api('/data'); draw(); }
function draw() {
  const L = document.getElementById('list');
  L.innerHTML = data.persons.map(p => '<div class="person" data-id="' + p.id + '"><div class="head"><b>' + esc(p.name) + '</b>' +
    '<label class="door"><input type="checkbox" data-a="door"' + (p.door ? ' checked' : '') + '> darf Tür öffnen</label>' +
    '<button data-a="photo">Fotos hinzufügen</button><button data-a="learn">An Kamera einlernen</button><button data-a="rename">Umbenennen</button><button class="danger" data-a="del">Löschen</button></div>' +
    '<div class="samples">' + (p.samples.length ? p.samples.map(s => '<div class="s"><img src="faces/person/' + p.id + '/sample/' + s + '.jpg' + (Q ? '?' + Q : '') + '"><button data-a="rm" data-s="' + s + '">✕</button></div>').join('') : '<span class="help">Noch keine Bilder</span>') + '</div>' +
    '<div class="learn"></div></div>').join('') || '<div class="help">Noch keine Person angelegt.</div>';
}
/** picked picture -> JPEG (max 1600 px) via canvas, so PNG / HEIC from the phone work too */
function toJpeg(file) {
  return new Promise((ok, bad) => { const img = new Image(); img.onload = () => { const s = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(b => (b ? ok(b) : bad(new Error('Bild nicht lesbar'))), 'image/jpeg', 0.92); URL.revokeObjectURL(img.src); }; img.onerror = () => bad(new Error('Bild nicht lesbar')); img.src = URL.createObjectURL(file); });
}
document.getElementById('add').onclick = async () => {
  try { await api('/person', { method: 'POST', body: JSON.stringify({ name: document.getElementById('name').value, door: document.getElementById('door').checked }) });
    document.getElementById('name').value = ''; msg('✓ angelegt – jetzt Fotos hinzufügen oder an der Kamera einlernen'); load(); } catch (e) { msg('Fehler: ' + e.message, true); }
};
document.getElementById('list').onclick = async e => {
  const b = e.target.closest('[data-a]'); if (!b) return; const box = b.closest('.person'); const id = box.dataset.id; const p = data.persons.find(x => x.id === id);
  try {
    if (b.dataset.a === 'del' && confirm(p.name + ' mit allen Bildern löschen?')) { await api('/person/' + id, { method: 'DELETE' }); msg('gelöscht'); load(); }
    if (b.dataset.a === 'rename') { const n = prompt('Neuer Name', p.name); if (n) { await api('/person/' + id, { method: 'POST', body: JSON.stringify({ name: n }) }); load(); } }
    if (b.dataset.a === 'rm') { await api('/person/' + id + '/sample/' + b.dataset.s, { method: 'DELETE' }); load(); }
    if (b.dataset.a === 'photo') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = async () => { let ok = 0; const errs = [];
        for (const f of inp.files) { msg('Lese ' + f.name + ' …'); try { await api('/person/' + id + '/photo', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: await toJpeg(f) }); ok++; } catch (err) { errs.push(f.name + ': ' + err.message); } }
        msg(ok + ' Bild(er) übernommen' + (errs.length ? ' – ' + errs.join('; ') : ''), errs.length > 0); load(); };
      inp.click();
    }
    if (b.dataset.a === 'learn') {
      const L = box.querySelector('.learn');
      L.innerHTML = '<select>' + data.cameras.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select><button class="primary">Start (15 s)</button><img alt="">';
      const sel = L.querySelector('select'), img = L.querySelector('img'); let t = null;
      const pic = () => { img.src = 'cam/' + sel.value + '.jpg?' + (Q ? Q + '&' : '') + 'fresh=1&t=' + Date.now(); };
      sel.onchange = pic; pic(); t = setInterval(pic, 1000);
      L.querySelector('button').onclick = async () => { msg('Einlernen läuft – bitte vor die Kamera stellen und den Kopf langsam etwas drehen …');
        try { const r = await api('/person/' + id + '/learn', { method: 'POST', body: JSON.stringify({ camera: sel.value }) });
          msg(r.added + ' neue Bild(er) gelernt' + (r.hint ? ' – ' + r.hint : ''), !r.added); } catch (err) { msg('Fehler: ' + err.message, true); }
        clearInterval(t); load(); };
    }
  } catch (err) { msg('Fehler: ' + err.message, true); }
};
document.getElementById('list').onchange = async e => {
  if (e.target.dataset.a !== 'door') return; const id = e.target.closest('.person').dataset.id;
  try { await api('/person/' + id, { method: 'POST', body: JSON.stringify({ door: e.target.checked }) }); msg('gespeichert'); } catch (err) { msg('Fehler: ' + err.message, true); }
};
load().catch(e => msg('Fehler: ' + e.message, true));
</script></body></html>`;
}

module.exports = { renderFaces };
