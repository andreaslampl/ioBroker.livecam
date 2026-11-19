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
- 0.4.2: owner's VLANs: ioBroker VM (Synology VMM, several NICs) + touch PC in Smarthome, 2N in Security, ringing works
  (SIP 5060 allowed) but no sound -> setting `rtpPorts` "min-max" (`parsePorts()`, >= 4 ports): first half = RTP socket
  towards the station (`_bindRtp()` tries each port), second half = werift `icePortRange` for browsers. Startup log names
  the ranges. Test checks the SDP ports. Not yet confirmed that the firewall was the cause.
  Field: with the fixed range + firewall rules talking works from the owner's iPhone (both directions); the Debian kiosk
  touch PC (same VLAN as ioBroker) still had no sound - its kiosk script was not updated yet (no
  WebRtcHideLocalIpsWithMdns flag). After updating it: talking works on the touch PC too (owner confirmed).
- AI detection (0.5.0, owner: old cameras, motion detection too unreliable, wants "light on while a person is there", push,
  later number plates; ioBroker = VM on a DS920+ / Celeron J4125, no AVX): `lib/detect.js` `Detector` = YOLOX-nano
  (`models/yolox_nano.onnx`, Apache-2.0, sha256 in models/README.md) on onnxruntime-web 1.31.1 (exact, WebAssembly - no
  AVX needed; ~90 ms per check on the dev machine, expect ~300 ms on the J4125), one session + queue for all cameras,
  `postprocess()` (grid decode, groups person/vehicle/animal with German labels, NMS, boxes as fractions of the picture),
  `parseZones()`/`inZones()` (polygons 0..1, feet point = bottom centre). `lib/watch.js` `Watcher` per camera: stream ->
  own ffmpeg with `-skip_frame nokey` + letterbox 416 raw BGR (orig size parsed from ffmpeg's stderr; files get `-re`),
  snapshot/http -> source.getFrame() + ffmpeg decode; motion gate (52x52 grey mean diff >= 3) / still present / every 30 s,
  max one check per `interval`; 'state' (on/count, off after `hold`) + 'detected' (rising edge). main: camera column
  `detect`, tab settings detectScore/Hold/Interval, states `cameras.<id>.detect.*`, photo = fresh full-size frame checked
  again (else the detection frame) with ffmpeg drawbox -> data dir detect/<id>.jpg, served `/detect/<id>.jpg`;
  `lib/zones-page.js` `/zones` (tap corners, POST /zones/<id> -> `saveZones()`; also the writable zones state);
  `info.zonesUrl`, `info.detectMs`. Tests: synthetic postprocess / zones / watcher + real model on a grey frame; e2e with a
  real photo in the scratchpad (not committed - image licence). Not yet on the owner's cameras / J4125.
  0.5.1: Watcher 'boxes' (JSON [{g,l,s,x,y,w,h}] rounded, only on change, [] when everything is off) -> state
  `detect.boxes` for SmartView's live overlay.
  Field: owner reports person detection works very well on the real cameras (info.detectMs = 270 on the J4125 VM, as expected).
  0.6.0 number plates (owner asked; own vehicles only): `lib/plates.js` `PlateReader` (shares the Detector's ort + queue):
  `models/plate_detect_384.onnx` (open-image-models yolo-v9-t-384 end2end, MIT ankandrew; centred letterbox RGB /255,
  out [n,7] x1 y1 x2 y2 cls score, rows with score 0 = padding) on the vehicle box (+12 %) cut from a fresh full-size
  getFrame() JPEG via ffmpeg, then `models/plate_ocr_cct_s_v2.onnx` (fast-plate-ocr cct_s_v2_global, MIT; uint8 NHWC
  64x128 RGB stretched, plate [1,10,37] probs, '_' = empty). `parseKnown()` / `match()` (normalize, look-alikes O/Q/D=0
  I=1 Z=2 S=5 B=8 G=6, Levenshtein <= 1 for 5+ chars). Camera column `plates` (needs vehicle), config `plates`
  [{plate, name}], `plateUnknown`. main `startPlates()` (states plates.<slug>.present/lastSeen/camera, old slugs deleted;
  detect.plate/plateKnown/plateTime), `plateSession()` on vehicle rising edge (once per appearance, `plateDone`; every
  `plateEvery` 2 s, max `plateTries` 8, reading needs prob >= 0.6), `onPlate()`, `plateGone()` on vehicle off.
  PRIVACY: readings not on the list are never stored or logged (only "unbekannt" with plateUnknown) - keep it that way.
  Tests: unit + real models on `test/fixtures/plate-scene.jpg` (self-made drawing); e2e in the scratchpad (lpr/e2e.js,
  bus photo with a pasted synthetic plate, not committed). Synthetic plates read 100 %; not yet on the owner's cameras.
- Faces (0.8.0, owner asked for face recognition + liveness "for opening doors" when only ioBroker is there): `lib/faces.js`
  `FaceReader` (Detector's ort + queue): YuNet 2023mar (models/face_detect_yunet.onnx, MIT; 640 letterbox top left, BGR 0..255,
  `decodeYunet()` cls/obj/bbox/kps per stride, score sqrt(cls*obj), NMS 0.3) on person boxes (upper 60 % + margin, max 2) of a
  fresh getFrame() via ffmpeg rgb24; `similarity()` + `warp()` to OpenCV's 112x112 landmarks (DST); SFace (face_recog_sface.onnx,
  Apache-2.0, RGB 0..255; fp32 - the int8 file was 4x slower in WASM); liveness MiniFASNetV2 x2.7 + V1SE x4.0 (80x80 BGR 0..255,
  class 1 = real, mean) - converted from Silent-Face's legacy .pth WITHOUT torch by `tools/convert-minifasnet.py` (PyPI torch
  needs the CUDA libs). `FaceStore` faces.json (persons {id, name, door, samples, embeds}, max 20 samples, aligned JPEGs).
  Page `/faces` (lib/faces-page.js) + API only with an access key (403 / locked page otherwise): add / rename / door / delete,
  photos (browser converts to JPEG via canvas), learn at a camera 15 s (size >= 60, alive, cosine < 0.92 to existing). main
  `faceSession()` on person rising edge (once per appearance, `faceDone`; every `faceEvery` 1.5 s, max `faceTries` 10): match
  >= faceMatch (45 %), liveness >= faceLiveMin (80 %) else warn "Foto oder Bildschirm?" and no hit; `onFace()` -> detect.face/
  faceKnown/faceScore/faceLive/faceTime, faces.<slug>.present/lastSeen/camera; `faceDoor` only for door persons with liveness on
  and 2 hits in a row; `faceGone()` on person off. Measured (scratchpad, OpenCV zoo selfie - not committed): same person 0.94,
  others <= 0.25; liveness real 0.97-0.99, phone with frame 0.00, print 0.39, full-frame moire screen 0.89 (passes) -> README
  says faceDoor is not a sole door key. ~0.8 s per check on the dev machine. PRIVACY: unknown faces never stored / logged.
- 0.9.1 field: owner saw only "Person" on the box after teaching in a face -> FaceReader returns the face centre `cx`/`cy`
  (fractions of the whole picture), main `faceTags` per camera (set in onFace, cleared in faceGone) + `labelBoxes()` puts the
  name on the person box containing it (else the nearest) for every boxes update. Owner asked to ignore cars standing long ->
  Watcher `parkMs` (config `detectPark` min, default 5, 0 = off) + `park()`: vehicle tracks by IoU >= 0.6, parked after
  parkMs = no box / no state / no rising edge, a place is free again 3 min after it was last seen. Tests for both.
- 0.8.1: owner asked for the links in the adapter -> io-package `localLinks` (_default overview, faces, zones, view, tones; admin's
  link symbol), overview `/` gets a nav of the pages in use; `util.keyOk()` = ?key= or cookie `lc_auth` (sha256 of the key,
  32 hex, HttpOnly, SameSite=Lax, 1 year) for pages, API, pictures and both ws upgrades; pages without key -> login form
  (`_loginPage`, POST /login, next only to own pages, 5 wrong per IP -> 1 min); a page opened with ?key= sets the cookie.
- Optional VMS link (0.7.0, owner's own "Andreas L.-Arts VMS", API.md + ADAPTER-AUFTRAG.md on the owner's PC, pasted
  into the session): `lib/vms.js` `VmsClient` (Bearer key; /api/integration cached 60 s; /api/cameras; PUT
  /api/cameras/<id>; POST /api/events/external; SSE /api/stream with ping watchdog 45 s, backoff 2…60 s, `retry:`
  honoured), `liveTarget()` = rtsp://user:pass@<vms host>:<port><rtsp.sub> when released, else MJPEG
  <base><mjpeg.sub>&key=. Camera type `vms` (column `vmsCamera`, autocompleteSendTo 'vmsCameras' -> onMessage,
  messagebox) -> CameraSource cfg.resolve (source._target handles http/snapshot/ffmpeg like stream). main
  `prepareVms()` before the camera loop (list cached in vms-cameras.json for starts without VMS; `vmsImport` appends
  cameras not in the table), `startVms()` (vms.connection, vms.lastEvent, vms.cameras.<slug>.* incl. writable
  recordMode/enabled -> `vmsWrite()`), `onVmsMessage()` (state -> online/recording/motion/kinds; event/plate ->
  lastEvent* with full URLs; plate text only for plate_kind known/alarm, else '' + 'unknown' and stripped from the JSON),
  `vmsRing()` on intercom 'ring' (setting > VMS id of the ring camera > VMS camera whose JSON contains the station IP).
  Key: encryptedNative + protectedNative, `key=` redacted in source/watch logs. Nothing created without url + key.
  Tests: `startFakeVms()` in test/helpers.js, test/vms.test.js. Not yet against the real VMS.
  0.9.0 (owner sent ADAPTER-AUFTRAG.md + API.md of VMS 1.3.1): state `rec`, `faces`/`faces_live` -> faces/facesLive (comma
  text) + `vmsPresence()` (vms.presence.<slug>.present/lastSeen/lastCamera = union over cameras), `spoof`; SSE `face` ->
  lastFace/lastFaceLive (null = not checked)/lastFaceTime; `boxes` (features.boxes) -> `vmsBoxes()` writes livecam format
  [{g,l,s,x,y,w,h,st}] (car/truck/motorcycle/bicycle -> vehicle, l = name if a person is recognised, st = still) into
  cameras.<livecam id>.detect.boxes + person/vehicle/animal for livecam cameras with cfg.vmsId and no own Watcher
  (`vmsBoxObjects()`), event image -> their detect.photoUrl (SmartView's message photo). IO: `vmsIo()` GET /api/io/state on
  every (re)connect (404 = older VMS, skipped), SSE `io` -> vms.io.<slug>.{name,kind,door,on}; on writable only for
  output/virtual without door; door -> `.open` button -> POST set {action: pulse} (never on). Not built: boxes on livecam's
  own /view wall (SmartView draws them). Tests: fake VMS has io + features.boxes.
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
