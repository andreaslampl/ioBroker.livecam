# ioBroker.livecam

Robuste **Kamera-Livebilder für VIS-2**. Der Adapter holt die Bilder von RTSP-, ONVIF- und
HTTP-Kameras (z. B. **Axis, Hanwha, Sony, Mobotix, 2N**) und stellt jede Kamera als
MJPEG-Livebild bereit, das man direkt in ein Bild-Widget von VIS-2 einträgt.

**Warum noch ein Kamera-Adapter?** Er ist darauf gebaut, dass die Bilder nicht nach einiger
Zeit verschwinden:

- **Wächter:** Kommen einige Sekunden keine Bilder, verbindet sich der Adapter selbst neu,
  mit wachsender Wartezeit bei Dauerstörungen. Kein Neustart von Hand nötig.
- **Eine Verbindung pro Kamera**, egal wie viele Browser zuschauen. Viele Kameras erlauben nur
  wenige gleichzeitige Streams.
- **Langsame oder hängende Zuschauer** (Tablet im Standby, schlechtes WLAN) bekommen Bilder
  ausgelassen, statt den Speicher zu füllen oder andere auszubremsen.
- Die Kamera wird nur abgefragt, **solange jemand zuschaut** (optional „Immer an“).
- **ONVIF:** IP-Adresse eintragen, die Stream-Adresse wird automatisch gefunden.
- **Digest-Anmeldung** (Axis, Hanwha, Sony, 2N …) wird unterstützt.

## Voraussetzung: ffmpeg

Für RTSP-Streams wird **ffmpeg** auf dem ioBroker-Server gebraucht:

```bash
sudo apt install ffmpeg
```

Für reine Snapshot-Kameras ist ffmpeg nicht nötig.

## Installation

Im ioBroker-Admin unter **Adapter** → GitHub-Symbol → Reiter **Benutzerdefiniert**:

```
https://github.com/andreaslampl/ioBroker.livecam
```

oder: `iobroker url https://github.com/andreaslampl/ioBroker.livecam`

## Kameras eintragen

In der Instanz unter **Kameras** eine Zeile pro Kamera:

| Spalte | Bedeutung |
| --- | --- |
| Typ **ONVIF** | IP-Adresse und Login eintragen, der Stream wird automatisch gesucht |
| Typ **Stream** | RTSP- oder HTTP-MJPEG-Adresse unter *URL* |
| Typ **Snapshot** | Adresse eines einzelnen JPEG-Bildes, wird mit *Bilder/s* abgefragt |
| Profil | nur ONVIF: 0 = Hauptstream, **1 = Substream (empfohlen**, braucht weniger Leistung) |
| Bilder/s | 5 reicht für ein Livebild völlig |
| Breite | Bild wird auf diese Breite verkleinert (z. B. 1280), 0 = Originalgröße |
| Immer an | Kamera auch ohne Zuschauer abfragen, damit beim Öffnen sofort ein aktuelles Bild da ist |

Benutzername und Passwort werden automatisch in die Adresse eingesetzt, du musst sie nicht
in die URL schreiben.

### Typische Adressen

Bitte im Handbuch der Kamera prüfen, sie unterscheiden sich je nach Modell und Firmware.

| Hersteller | Stream (RTSP / MJPEG) | Snapshot |
| --- | --- | --- |
| **Axis** | `rtsp://IP/axis-media/media.amp?resolution=1280x720` oder `http://IP/axis-cgi/mjpg/video.cgi` | `http://IP/axis-cgi/jpg/image.cgi` |
| **Hanwha** | `rtsp://IP:554/profile2/media.smp` | `http://IP/stw-cgi/video.cgi?msubmenu=snapshot&action=view` |
| **Sony** | am besten **ONVIF** | `http://IP/oneshotimage.jpg` |
| **Mobotix** | `http://IP/cgi-bin/faststream.jpg?stream=full&fps=5` (neuere Modelle auch ONVIF/RTSP) | `http://IP/record/current.jpg` |
| **2N** | `rtsp://IP:554/h264_stream` | `http://IP/api/camera/snapshot?width=640&height=480` |

**Hinweise:**
- **Axis + ONVIF:** Axis verlangt einen **eigenen ONVIF-Benutzer** (in der Kamera unter
  *System → ONVIF* anlegen).
- **2N:** Die HTTP-API und ein Benutzer mit Kamera-Recht müssen in der 2N-Weboberfläche aktiviert sein.

## In VIS-2 anzeigen

1. Nach dem Start stehen unter `livecam.0.cameras.<name>.mjpegUrl` die fertigen Adressen,
   z. B. `http://10.0.0.5:8095/cam/haustuer.mjpeg`.
2. In VIS-2 ein **Bild-Widget** (z. B. *Basic → Image*) einfügen.
3. Als Bildquelle die **mjpegUrl** eintragen. **Kein Aktualisierungsintervall** setzen,
   das Livebild aktualisiert sich selbst.

Eine Übersicht aller Kameras gibt es unter `http://<ioBroker-IP>:8095/`.

**Viele Kameras auf einer Seite:** Browser öffnen pro Server höchstens ca. 6 Livebilder
gleichzeitig. Für mehr Kameras auf einer Seite die **snapshotUrl** mit einem
Aktualisierungsintervall (z. B. 1 s) verwenden.

## Datenpunkte

| Datenpunkt | Bedeutung |
| --- | --- |
| `info.connection` | Webserver läuft |
| `cameras.<name>.mjpegUrl` | Livebild-Adresse für VIS-2 |
| `cameras.<name>.snapshotUrl` | Einzelbild-Adresse |
| `cameras.<name>.online` | Bilder kommen an |
| `cameras.<name>.fps` | tatsächliche Bilder pro Sekunde |
| `cameras.<name>.viewers` | aktuelle Zuschauer |
| `cameras.<name>.lastError` | letzter Fehler (leer = alles ok) |

## Sicherheit

Der Webserver ist im Heimnetz ohne Anmeldung erreichbar. Optional kann unter *Webserver* ein
**Zugriffsschlüssel** gesetzt werden, dann funktionieren die Adressen nur mit `?key=…`
(wird automatisch angehängt). Den Port nicht ins Internet freigeben.

## Entwicklung

```bash
npm install
npm test
```

Die Tests lassen echtes ffmpeg gegen eine simulierte Kamera laufen, inklusive einer Kamera,
die mitten im Betrieb hängen bleibt, Digest-Anmeldung, ONVIF und einem hängenden Zuschauer.

## Lizenz

MIT
