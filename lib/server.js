'use strict';

/*
 * HTTP server for the browser / VIS-2:
 *
 *   /cam/<id>.mjpeg   live image (multipart/x-mixed-replace), works in <img>
 *   /cam/<id>.jpg     current single image
 *   /view             camera wall with intercom (for VIS-2 on a touch PC)
 *   /ws               WebSocket for the camera wall (intercom, liveness)
 *   /                 overview page with all cameras
 *
 * All viewers of a camera share one camera connection. A viewer that cannot
 * keep up (slow tablet, bad WLAN) skips frames instead of buffering them.
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');
const { renderView } = require('./view');

const BOUNDARY = 'livecamframe';

class CamServer {
    /**
     * @param {object} options
     * @param {Map<string, import('./source').CameraSource>} options.sources
     * @param {string} [options.accessKey] if set, required as ?key=...
     * @param {object} options.log
     * @param {import('./intercom').Intercom} [options.intercom]
     * @param {string} [options.intercomCamera] camera id shown large when the intercom rings
     */
    constructor({ sources, accessKey = '', log, intercom = null, intercomCamera = '' }) {
        this.sources = sources;
        this.accessKey = accessKey;
        this.log = log;
        this.intercom = intercom;
        this.intercomCamera = intercomCamera;
        this.server = http.createServer((req, res) => this._handle(req, res));
        this.server.keepAliveTimeout = 5000;
        this.clients = new Set();
        if (intercom) {
            intercom.attach(this.server, accessKey);
        } else {
            // Without intercom the camera wall still uses /ws to notice adapter restarts.
            const wss = new WebSocketServer({ noServer: true });
            this.server.on('upgrade', (req, socket, head) => {
                const url = new URL(req.url, 'http://localhost');
                if (url.pathname !== '/ws' || (accessKey && url.searchParams.get('key') !== accessKey)) {
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(req, socket, head, ws => ws.send(JSON.stringify({ type: 'state', state: 'idle' })));
            });
            this.wss = wss;
        }
    }

    listen(port, host = '0.0.0.0') {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', reject);
                resolve(this.server.address());
            });
        });
    }

    close() {
        for (const res of this.clients) {
            res.destroy();
        }
        this.clients.clear();
        if (this.wss) {
            for (const ws of this.wss.clients) {
                ws.terminate();
            }
        }
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    _handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        if (this.accessKey && url.searchParams.get('key') !== this.accessKey) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden: missing or wrong ?key=');
            return;
        }
        const m = /^\/cam\/([\w-]+)\.(mjpeg|mjpg|jpg|jpeg)$/.exec(url.pathname);
        if (m) {
            const source = this.sources.get(m[1]);
            if (!source) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Unknown camera ${m[1]}`);
                return;
            }
            if (m[2].startsWith('mj')) {
                this._mjpeg(source, req, res);
            } else {
                this._snapshot(source, res, url.searchParams.has('fresh') ? 500 : 2000);
            }
            return;
        }
        if (url.pathname === '/view') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(
                renderView({
                    cameras: [...this.sources.values()].map(s => ({ id: s.id, name: s.cfg.name || s.id })),
                    intercomCamera: this.intercomCamera,
                    intercom: Boolean(this.intercom),
                    key: url.searchParams.get('key') || '',
                }),
            );
            return;
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
            this._index(res, url.searchParams.get('key'));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }

    _mjpeg(source, req, res) {
        res.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Connection: 'close',
            'Access-Control-Allow-Origin': '*',
        });
        res.socket.setNoDelay(true);
        this.clients.add(res);
        let busy = false;
        const send = frame => {
            if (busy) {
                return; // client still busy with the previous frame: skip
            }
            const ok = res.write(
                Buffer.concat([
                    Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
                    frame,
                    Buffer.from('\r\n'),
                ]),
            );
            if (!ok) {
                busy = true;
                res.once('drain', () => {
                    busy = false;
                });
            }
        };
        source.on('frame', send);
        source.addViewer();
        // Show the last image right away instead of a blank widget.
        if (source.latest) {
            send(source.latest);
        }
        const done = () => {
            if (this.clients.delete(res)) {
                source.removeListener('frame', send);
                source.removeViewer();
            }
        };
        req.on('close', done);
        res.on('close', done);
        res.on('error', done);
    }

    async _snapshot(source, res, maxAge) {
        try {
            const frame = await source.getFrame(maxAge);
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': frame.length,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(frame);
        } catch (err) {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(err.message);
        }
    }

    _index(res, key) {
        const q = key ? `?key=${encodeURIComponent(key)}` : '';
        const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
        const cards = [...this.sources.values()]
            .map(
                s =>
                    `<figure><img src="/cam/${s.id}.mjpeg${q}" alt="${esc(s.cfg.name || s.id)}" loading="lazy">` +
                    `<figcaption>${esc(s.cfg.name || s.id)} <code>/cam/${s.id}.mjpeg</code></figcaption></figure>`,
            )
            .join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
            '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>livecam</title><style>body{font-family:sans-serif;margin:16px;background:#111;color:#eee}' +
                'main{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}' +
                'figure{margin:0}img{width:100%;background:#222;aspect-ratio:16/9;object-fit:contain}code{color:#9cf}</style></head>' +
                `<body><main>${cards || '<p>Keine Kameras konfiguriert.</p>'}</main></body></html>`,
        );
    }
}

module.exports = { CamServer, BOUNDARY };
