'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { OnvifClient, OnvifError } = require('../lib/onvif');

/** Fake ONVIF camera that checks the WS-Security password digest. */
async function startOnvifCamera({ user = 'admin', password = 'secret', clockOffset = 0 } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            const action = (/<s:Body><(?:\w+:)?(\w+)/.exec(body) || [])[1];
            calls.push(action);
            const reply = inner => {
                res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
                res.end(
                    '<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" ' +
                        'xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
                        `xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`,
                );
            };
            if (action === 'GetSystemDateAndTime') {
                const d = new Date(Date.now() + clockOffset);
                reply(
                    '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime>' +
                        `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>` +
                        `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>` +
                        '</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
                );
                return;
            }
            // Check UsernameToken: digest = base64(sha1(nonce + created + password)), created within 10 s of camera clock.
            const get = n => (new RegExp(`<${n}[^>]*>([^<]*)</${n}>`).exec(body) || [])[1];
            const nonce = Buffer.from(get('Nonce') || '', 'base64');
            const created = get('Created') || '';
            const expected = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)])).digest('base64');
            const skew = Math.abs(Date.parse(created) - (Date.now() + clockOffset));
            if (get('Username') !== user || get('Password') !== expected || !(skew < 10000)) {
                res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
                res.end('<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Reason><s:Text xml:lang="en">Sender not Authorized</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>');
                return;
            }
            switch (action) {
                case 'GetCapabilities':
                    // Camera reports an internal address that must be replaced by the configured host.
                    reply('<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://192.168.99.9:' + server.address().port + '/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>');
                    break;
                case 'GetProfiles':
                    reply(
                        '<trt:GetProfilesResponse>' +
                            '<trt:Profiles token="profile_1_h264" fixed="true"><tt:Name>Main &amp; HD</tt:Name><tt:VideoEncoderConfiguration><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>' +
                            '<trt:Profiles token="profile_2_h264"><tt:Name>Sub</tt:Name><tt:VideoEncoderConfiguration><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>' +
                            '</trt:GetProfilesResponse>',
                    );
                    break;
                case 'GetStreamUri': {
                    const token = get('trt:ProfileToken');
                    reply(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://192.168.99.9:554/axis-media/media.amp?profile=${token}&amp;x=1</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`);
                    break;
                }
                case 'GetSnapshotUri':
                    reply('<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://192.168.99.9/axis-cgi/jpg/image.cgi</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>');
                    break;
                default:
                    res.writeHead(400);
                    res.end();
            }
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, calls, port: server.address().port };
}

test('ONVIF resolves stream and snapshot URIs of the chosen profile', async t => {
    // Camera clock is 1 hour off: the token must use the camera time.
    const cam = await startOnvifCamera({ clockOffset: 3600 * 1000 });
    t.after(() => cam.server.close());
    const client = new OnvifClient({ host: '127.0.0.1', port: cam.port, user: 'admin', password: 'secret' });
    const r = await client.resolve(1);
    assert.equal(r.profiles.length, 2);
    assert.equal(r.profiles[0].name, 'Main & HD');
    assert.equal(r.profile.token, 'profile_2_h264');
    assert.equal(r.profile.width, 640);
    assert.equal(r.streamUri, 'rtsp://127.0.0.1:554/axis-media/media.amp?profile=profile_2_h264&x=1');
    assert.equal(r.snapshotUri, 'http://127.0.0.1/axis-cgi/jpg/image.cgi');
    // Profile index beyond the list falls back to the last profile.
    assert.equal((await client.resolve(7)).profile.token, 'profile_2_h264');
});

test('ONVIF reports a wrong password clearly', async t => {
    const cam = await startOnvifCamera();
    t.after(() => cam.server.close());
    const client = new OnvifClient({ host: '127.0.0.1', port: cam.port, user: 'admin', password: 'wrong' });
    await assert.rejects(client.resolve(0), err => err instanceof OnvifError && /not Authorized/.test(err.message));
});

test('ONVIF reports an unreachable camera', async () => {
    const client = new OnvifClient({ host: '127.0.0.1', port: 9, user: 'a', password: 'b', timeout: 2000 });
    await assert.rejects(client.resolve(0), OnvifError);
});
