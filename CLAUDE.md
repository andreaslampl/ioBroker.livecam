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
- HTTP MJPEG in mode stream (0.3.2): read directly (`HttpClient.open` keeps the response streaming,
  `_readHttp` splits frames, throttled to fps); single image content -> snapshot polling, other
  content (or `width` set, needs scaling) -> ffmpeg. Owner's Mobotix T25 (`/control/faststream.jpg?
  stream=full`, played in VLC but not in livecam before) works with 0.3.2 - confirmed by the owner.
  The exact cause with ffmpeg was not proven (ffmpeg handled a fake Mobotix-like stream fine).
- `lib/sip.js` – minimal SIP UAS over UDP for peer-to-peer calls from the 2N IP Verso 2.0
  (no PBX): INVITE/100/180/200 (+retransmit until ACK), CANCEL->487, BYE both ways,
  only `intercomHost` may call (403 otherwise).
- `lib/sdp.js` – G.711 (caller's preference order) + telephone-event; video m-lines declined.
- Calls from inside (0.4.0, owner wanted to test volume / talk without waiting for a ring): `OutCall` in sip.js
  (`SipServer.invite()`: INVITE with timer A/B, 1xx stops resending, 2xx -> ACK to the Contact (also for retransmits;
  after a local hangup ACK + BYE), >= 300 -> ACK in the INVITE transaction + `failStatus`, hangup = CANCEL before the
  answer, else BYE); responses routed by Call-ID before the BYE bookkeeping. `sdp.buildOffer()` (PCMU, PCMA, DTMF 101).
  `Intercom.dial(ws, sdp, station)` (ws `{type:'dial'}`): session `outgoing`, state `calling`; the browser's offer
  waits until the station answers, then `_browserAudio()` (shared with answer) uses the station's codec. No 'ring',
  no callEnd/history for own calls. State message carries `outgoing` and `stations` [{index, name}]; station
  `sipPort` (tests). Station must auto-answer (2N: incoming calls answered automatically). Tests with a fake
  answering station; not yet tried with the real 2N.
- 0.4.1 field: no audio in either direction from SmartView (iPhone and Debian kiosk), cause unknown -> info log per call:
  browser's ICE candidates (`Intercom.candidates()`, mDNS names marked), ioBroker's own candidates + station address/codec,
  "Ton-Verbindung zum Browser steht / fehlgeschlagen", and after the call `Ton-Statistik` (packets station->ioBroker,
  ->browser, browser->ioBroker, ->station) with hints. Headless Chromium offers only a .local candidate even with mic.
- `lib/intercom.js` – bridges intercom RTP <-> browser WebRTC (werift) without transcoding; several
  stations (`stations`: name, host, camera, door) - the main one from the old single fields plus the
  `intercoms` table (e.g. Mobotix T25/T26); station picked by the caller's IP, state/ring carry its
  camera; door methods dtmf, http (2N API), url (any GET with Basic/Digest);
  browsers connect via `/ws`; first browser to answer gets the call; door via DTMF
  (RFC 4733) or 2N HTTP API `/api/switch/ctrl`.
- `lib/view.js` – `/view` camera wall for the owner's Windows touch PC in VIS-2 (iframe in an
  HTML widget with `allow="microphone; autoplay"`); ring tone via Web Audio; reloads
  the whole page after adapter restarts (detected via the WebSocket) so new cameras appear. Layout via query params
  `cams`, `cols`, `big`, `mode` (mjpeg|jpg), `fps`; above 2 cameras it polls `/cam/<id>.jpg?fresh=1`
  because browsers allow only 6 connections per host, shared by all tabs (verified: forced MJPEG
  shows 6 of 9; in the field the overview tab + VIS with 4 MJPEG tiles left 2 tiles black).
  The overview page `/` polls single images too. Ring tones (dingdong, gong, chime, bell, phone,
  custom URL, plus melodies written as note strings via `mel()` - only public-domain tunes; mind the
  double backslashes inside the page template) and volume come from the settings (`?tone=`/`?volume=` override, `?testring=1`
  shows a test button). The intercom camera falls back to the camera with the intercom's IP.
  On/off from ioBroker (`view.display`, `cameras.<id>.show`, persisted, pushed as `{type:'view'}`
  over `/ws`): off = black, tiles removed so connections close; ring shows the intercom camera,
  a tap wakes the wall for `?wake=` s (default 120). Asked for because the owner's touch monitor
  draws too much power for its supply and switches off after a while. 0.1.9 broke the full-screen
  ring with the wall on (layout() returned early when the tile set did not change), fixed in 0.1.10;
  check ring with wall on AND off when touching layout().
- `lib/tones.js` – `TONE_LABELS` + `toneEngine()` (runs in the browser, inserted with toString - no
  backticks/`${}` inside): `mel()` note strings (public-domain tunes only), play/stop, loop for ringing.
  `lib/tones-page.js` – `/tones`: listen, volume, "Verwenden" -> POST `/tones/select` -> states
  `view.ringTone`/`view.ringVolume` (persisted, writable, pushed in the `{type:'view'}` message; the
  wall uses `?tone=` > view state > settings).
- `lib/history.js` – `CallHistory`: last N calls (answered / missed / rejected) with a photo
  from the intercom camera taken on ring; `history.json` + JPEGs in the instance data dir
  (`calls/`). Served at `/history` and `/history/<id>.jpg`; missed badge on the camera wall.
- `test/` – `node --test`, uses real ffmpeg (`testsrc`) and fake cameras from `test/helpers.js`.

## Dependencies

- werift is pinned to 0.24.4 (exact): 0.25.x requires Node.js >= 22 and the install fails with
  EBADENGINE on the owner's ioBroker (Node.js 20.20.2, 0.3.1). Before raising it, check
  `npm view werift engines` and run the tests with Node 20.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.livecam`;
  ffmpeg must be installed there (`sudo apt install ffmpeg`).
- Run `npm test` before committing.
- Field test (0.1.6): four cameras work, also in VIS-2 via `/view` in an HTML widget: three
  as type Stream with `rtsp://<ip>/axis-media/media.amp` (cameras set to HTTPS only; RTSP on
  554 unaffected) and the 2N IP Verso 2.0 camera via ONVIF. SIP: the real 2N rings the
  camera wall (0.1.6); answering was not yet confirmed (owner's first try: button did
  nothing, cause still open - likely VIS editor mode or mic permission). Snapshot mode is
  not yet tested on real devices; manufacturer URLs in the README are typical
  examples. Before this adapter the owner answered the 2N with MicroSIP
  (peer-to-peer SIP), which works - useful as a reference when debugging.
- 0.1.8: the owner's Edge flag works (secure context ok), but the touch PC reported NotFoundError
  (no microphone) -> answering now falls back to listen-only (recvonly) on NotFound/NotReadable.
  The owner then found the local cause themselves; answering and talking with the real 2N work.
- 0.2.0: owner asked for more ring melodies and Mobotix T25/T26 via SIP (not yet tested with a real
  Mobotix; fake test uses a T25-like SDP with G.722 first).
- Browser mic needs a secure context: on the touch PC the http origins are whitelisted via
  `edge://flags/#unsafely-treat-insecure-origin-as-secure`.
- A real-browser check (Playwright + headless Chromium, fake mic) passed; it is not part of
  `npm test` because it needs Playwright.
