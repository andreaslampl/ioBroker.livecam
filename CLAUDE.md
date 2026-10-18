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
- `lib/http-client.js` – Basic + Digest (MD5, MD5-sess, SHA-256), challenge reuse.
- `lib/onvif.js` – WS-Security UsernameToken digest, camera clock offset, GetCapabilities ->
  GetProfiles -> GetStreamUri / GetSnapshotUri; replaces hostnames in returned URIs.
- `lib/jpeg.js` – splits JPEG frames by SOI/EOI markers.
- `test/` – `node --test`, uses real ffmpeg (`testsrc`) and fake cameras from `test/helpers.js`.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.livecam`;
  ffmpeg must be installed there (`sudo apt install ffmpeg`).
- Run `npm test` before committing.
- Not yet tested against the real cameras; manufacturer URLs in the README are typical
  examples, not verified on the owner's devices.
