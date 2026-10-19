# ioBroker.livecam

ioBroker adapter that serves robust MJPEG live images for VIS-2 from RTSP, ONVIF
and HTTP cameras (owner uses Axis, Hanwha, Sony, Mobotix, 2N). Written because the
existing cameras adapter lost its images after a while and needed restarts.

## Layout

- `main.js` – adapter: reads the camera table, creates `cameras.<id>.*` states, starts the web server.
- `lib/source.js` – `CameraSource`: one camera; modes stream (ffmpeg -> JPEG frames),
  snapshot (HTTP polling), onvif (resolves URIs, then stream/snapshot). On-demand start,
  15 s idle grace, watchdog (no frame for `stallTimeout` -> reconnect with backoff 2…60 s).
- `lib/server.js` – `CamServer`: `/cam/<id>.mjpeg`, `/cam/<id>.jpg`, `/`; viewers share
  one source; slow viewers skip frames (no queueing); optional `?key=`.
- `lib/http-client.js` – Basic + Digest (MD5, MD5-sess, SHA-256), challenge reuse, follows up to
  3 redirects, accepts self-signed certificates (owner's cameras are set to HTTPS only).
- `lib/onvif.js` – WS-Security UsernameToken digest, camera clock offset, GetCapabilities ->
  GetProfiles -> GetStreamUri / GetSnapshotUri; replaces hostnames in returned URIs. https when
  port is 443, after an http->https redirect, or when http is refused; http:// service
  addresses reported by the camera are then upgraded to https.
- `lib/jpeg.js` – splits JPEG frames by SOI/EOI markers.
- `lib/sip.js` – minimal SIP UAS over UDP for peer-to-peer calls from the 2N IP Verso 2.0
  (no PBX): INVITE/100/180/200 (+retransmit until ACK), CANCEL->487, BYE both ways,
  only `intercomHost` may call (403 otherwise).
- `lib/sdp.js` – G.711 (caller's preference order) + telephone-event; video m-lines declined.
- `lib/intercom.js` – bridges intercom RTP <-> browser WebRTC (werift) without transcoding;
  browsers connect via `/ws`; first browser to answer gets the call; door via DTMF
  (RFC 4733) or 2N HTTP API `/api/switch/ctrl`.
- `lib/view.js` – `/view` camera wall for the owner's Windows touch PC in VIS-2 (iframe in an
  HTML widget with `allow="microphone; autoplay"`); ring tone via Web Audio; reloads
  the whole page after adapter restarts (detected via the WebSocket) so new cameras appear. Layout via query params
  `cams`, `cols`, `big`, `mode` (mjpeg|jpg), `fps`; above 2 cameras it polls `/cam/<id>.jpg?fresh=1`
  because browsers allow only 6 connections per host, shared by all tabs (verified: forced MJPEG
  shows 6 of 9; in the field the overview tab + VIS with 4 MJPEG tiles left 2 tiles black).
  The overview page `/` polls single images too.
- `lib/history.js` – `CallHistory`: last N calls (answered / missed / rejected) with a photo
  from the intercom camera taken on ring; `history.json` + JPEGs in the instance data dir
  (`calls/`). Served at `/history` and `/history/<id>.jpg`; missed badge on the camera wall.
- `test/` – `node --test`, uses real ffmpeg (`testsrc`) and fake cameras from `test/helpers.js`.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.livecam`;
  ffmpeg must be installed there (`sudo apt install ffmpeg`).
- Run `npm test` before committing.
- Field test (0.1.4): two of the owner's cameras (Carport, Haustür) work as type Stream with
  `rtsp://<ip>/axis-media/media.amp` (Axis path, cameras set to HTTPS only; RTSP on 554
  unaffected). ONVIF, snapshot mode and the 2N intercom are not yet tested on real devices;
  manufacturer URLs in the README are typical examples. Before this adapter the owner answered the 2N with MicroSIP
  (peer-to-peer SIP), which works - useful as a reference when debugging.
- Browser mic needs a secure context: on the touch PC the http origins are whitelisted via
  `edge://flags/#unsafely-treat-insecure-origin-as-secure`.
- A real-browser check (Playwright + headless Chromium, fake mic) passed; it is not part of
  `npm test` because it needs Playwright.
