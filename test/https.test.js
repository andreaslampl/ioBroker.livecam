'use strict';

// Cameras set to "HTTPS only": self-signed certificate, http redirected or switched off.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { OnvifClient } = require('../lib/onvif');
const { HttpClient } = require('../lib/http-client');

let tls = null;
function selfSigned() {
    if (!tls) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livecam-tls-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=axis-camera',
            '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
        tls = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return tls;
}
const hasOpenssl = (() => {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

/** ONVIF camera on https; media service reported as http:// like real cameras do. */
async function startHttpsCamera() {
    const calls = [];
    const server = https.createServer(selfSigned(), (req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            if (req.url === '/snapshot.jpg') {
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                res.end(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
                return;
            }
            const action = (/<s:Body><(?:\w+:)?(\w+)/.exec(body) || [])[1];
            calls.push(`${req.url} ${action}`);
            const port = server.address().port;
            const replies = {
                GetSystemDateAndTime: '<tds:GetSystemDateAndTimeResponse/>',
                GetCapabilities: `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://127.0.0.1/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`,
                GetProfiles: '<trt:GetProfilesResponse><trt:Profiles token="p1"><tt:Name>Main</tt:Name></trt:Profiles></trt:GetProfilesResponse>',
                GetStreamUri: '<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1/axis-media/media.amp</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>',
                GetSnapshotUri: `<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>https://127.0.0.1:${port}/snapshot.jpg</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`,
            };
            res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
            res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><s:Body>${replies[action] || ''}</s:Body></s:Envelope>`);
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, calls, port: server.address().port };
}

test('ONVIF over https with a self-signed certificate', { skip: !hasOpenssl }, async t => {
    const cam = await startHttpsCamera();
    t.after(() => cam.server.close());
    const client = new OnvifClient({ host: '127.0.0.1', port: cam.port, https: true, user: 'root', password: 'pw' });
    const r = await client.resolve(0);
    assert.equal(r.streamUri, 'rtsp://127.0.0.1/axis-media/media.amp');
    // The http:// media address from the camera was used over https on the same port.
    assert.ok(cam.calls.includes('/onvif/media_service GetProfiles'));
});

test('ONVIF follows an http -> https redirect', { skip: !hasOpenssl }, async t => {
    const cam = await startHttpsCamera();
    const redirect = http.createServer((req, res) => {
        res.writeHead(301, { Location: `https://127.0.0.1:${cam.port}${req.url}` });
        res.end();
    });
    await new Promise(r => redirect.listen(0, '127.0.0.1', r));
    t.after(() => {
        cam.server.close();
        redirect.close();
    });
    const client = new OnvifClient({ host: '127.0.0.1', port: redirect.address().port, user: 'root', password: 'pw' });
    const r = await client.resolve(0);
    assert.equal(r.profile.token, 'p1');
    assert.equal(client.secure, true);
    assert.equal(r.snapshotUri, `https://127.0.0.1:${cam.port}/snapshot.jpg`);
});

test('snapshots: self-signed https and redirects are accepted', { skip: !hasOpenssl }, async t => {
    const cam = await startHttpsCamera();
    const redirect = http.createServer((req, res) => {
        res.writeHead(302, { Location: `https://127.0.0.1:${cam.port}/snapshot.jpg` });
        res.end();
    });
    await new Promise(r => redirect.listen(0, '127.0.0.1', r));
    t.after(() => {
        cam.server.close();
        redirect.close();
    });
    const res = await new HttpClient().request(`http://127.0.0.1:${redirect.address().port}/axis-cgi/jpg/image.cgi`);
    assert.equal(res.status, 200);
    assert.equal(res.body[0], 0xff);
    assert.ok(res.url.startsWith('https://'));
});
