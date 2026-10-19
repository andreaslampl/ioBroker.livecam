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
- **Kamerawand mit Türsprechstelle:** Beim Klingeln (z. B. 2N IP Verso) wird die Türkamera groß,
  ein Klingelton spielt, **Abnehmen, Auflegen und Tür öffnen** direkt im Browser, mit
  Gegensprechen über Mikrofon und Lautsprecher des Touch-PCs. Keine Telefonanlage nötig.

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

Benutzername und Passwort gehören in die Spalten **Benutzer** und **Passwort**, nicht in die URL;
der Adapter setzt sie automatisch ein. Trägst du bei *Stream* oder *Snapshot* nur einen Pfad ein
(z. B. `/axis-media/media.amp`) und die IP in der Spalte *IP*, ergänzt der Adapter die vollständige
Adresse (`rtsp://<IP>/axis-media/media.amp`).

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
- **Kameras auf „nur HTTPS“:** RTSP (Port 554) ist davon meist nicht betroffen. Snapshot- und
  MJPEG-Adressen mit `https://` eintragen; selbst ausgestellte Kamera-Zertifikate werden akzeptiert.
  Für ONVIF als Port **443** eintragen. Leitet die Kamera von http auf https weiter oder ist http
  abgeschaltet, wechselt der Adapter auch bei Port 80 selbst auf https.
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
gleichzeitig. Für mehr Kameras die **Kamerawand** (`/view`, schaltet automatisch um) oder die
**snapshotUrl** mit einem Aktualisierungsintervall (z. B. 1 s) verwenden.

## Kamerawand mit Türsprechstelle (2N)

Die Seite **`http://<ioBroker-IP>:8095/view`** zeigt alle Kameras im Raster. Ist die
Türsprechstelle aktiviert und es klingelt, wird die Türkamera bildschirmfüllend angezeigt, mit
Klingelton und den Knöpfen **Abnehmen / Ablehnen / Auflegen / Tür öffnen**. Gesprochen wird über
Mikrofon und Lautsprecher des Geräts, auf dem die Seite läuft. Klingelt es an mehreren
Bildschirmen, nimmt der ab, der zuerst drückt; die anderen zeigen „Gespräch an einem anderen Gerät“.

### Anrufliste und verpasste Anrufe

Bei jedem Klingeln macht der Adapter ein **Foto** mit der Türkamera und merkt sich den Anruf
(Standard: die letzten **20**, einstellbar unter *Türsprechstelle → Anrufe in der Anrufliste*).

- **Verpasst** = niemand hat abgenommen (Klingeldauer abgelaufen oder Besucher hat aufgegeben)
- **Abgelehnt** = jemand hat „Ablehnen“ gedrückt
- **Angenommen** = mit Gesprächsdauer

Gibt es ungesehene verpasste Anrufe, zeigt die Kamerawand oben links **„🔔 2 verpasst“**. Antippen
öffnet die Liste mit Uhrzeit und Foto; **„Gesehen“** setzt den Hinweis zurück. Die Liste lässt sich
auch ohne verpasste Anrufe öffnen: 1,5 Sekunden auf die Kamerawand drücken.

Fotos und Liste liegen im Datenverzeichnis des Adapters und bleiben bei einem Neustart erhalten.

### Wann geht die Ansicht zurück?

Sobald der Anruf vorbei ist: nach **Ablehnen** oder **Auflegen**, wenn der Besucher bzw. die 2N
abbricht, oder wenn niemand innerhalb der **Klingeldauer** (Standard 60 s) abnimmt. Wird an einem
anderen Bildschirm abgenommen, bleibt die Türkamera groß, bis dort aufgelegt wird.

### Kamerawand ein- und ausschalten

Unter `livecam.0.view.display` lässt sich die ganze Kamerawand aus- und einschalten, z. B. per
Skript, Szene, Zeitplan oder Bewegungsmelder:

- **aus:** der Bildschirm bleibt schwarz und es werden keine Bilder geladen; die Kameras werden
  nach 15 s nicht mehr abgefragt (spart Netzwerk und Rechenleistung).
- **Klingeln** schaltet trotzdem die Türkamera groß ein, nach dem Anruf wird es wieder schwarz.
- **Antippen** des schwarzen Bildschirms zeigt die Kameras für 2 Minuten (`?wake=60` = 60 s).

Einzelne Kameras blendet `livecam.0.cameras.<name>.show` aus (aus = nicht auf der Kamerawand,
die anderen Kacheln werden größer). Die Schalter bleiben auch nach einem Neustart so, wie sie
waren. Den Monitor selbst kann eine Webseite nicht ausschalten; er wird aber dunkel und
der Browser hat weniger zu tun.

### Layout anpassen

Die Kamerawand lässt sich über Zusätze an der Adresse einstellen, beliebig kombinierbar mit `&`:

| Zusatz | Wirkung | Beispiel |
| --- | --- | --- |
| `cams=` | welche Kameras, in welcher Reihenfolge | `?cams=haustuer,garten,einfahrt` |
| `cols=` | Anzahl Spalten (sonst automatisch) | `?cols=4` |
| `big=` | eine Kamera doppelt so groß (2×2 Kacheln) | `?big=haustuer` |
| `mode=` | `mjpeg` = Livebild, `jpg` = Einzelbilder | `?mode=jpg` |
| `fps=` | Bilder pro Sekunde im Einzelbild-Modus (Standard 4) | `?fps=6` |
| `wake=` | Sekunden, die Antippen eine ausgeschaltete Kamerawand zeigt (Standard 120) | `?wake=60` |

Beispiel: 9 Kameras, Haustür groß, 4 Spalten:
`http://10.0.0.5:8095/view?big=haustuer&cols=4`

**Wie viele Kameras gehen?** Beliebig viele. Bis 2 Kameras laufen echte Livebilder. Ab 3 Kameras
schaltet die Seite automatisch auf schnell aktualisierte Einzelbilder um, weil Browser pro Server
höchstens 6 Livebild-Verbindungen gleichzeitig offen halten, und zwar **für alle Tabs zusammen**
(VIS-Editor, VIS-Ansicht, Übersichtsseite …). Darüber blieben Kacheln schwarz,
und der Browser würde sogar das Nachladen der Seite blockieren. Die Kamera-IDs (z. B. `haustuer`)
stehen in den Objekten unter `livecam.0.cameras`.

### 1. Adapter (Reiter „Türsprechstelle“)

| Einstellung | Wert |
| --- | --- |
| Türsprechstelle aktivieren | ✔ |
| IP-Adresse der Türsprechstelle | IP der 2N, nur sie darf anrufen |
| SIP-Port | `5060` |
| Kameraname der Türsprechstelle | Name wie in der Kameratabelle, z. B. `Haustür`. Leer oder nicht gefunden: die Kamera mit derselben IP wie die Türsprechstelle |
| Klingelton / Lautstärke | Ding-Dong, Westminster-Gong, Glockenspiel, Glocke, Telefon oder eigene Tondatei; ausprobieren mit `…/view?testring=1` |
| Tür öffnen über | **Tastencode (DTMF)** mit dem in der 2N eingestellten Schaltcode, oder **2N HTTP-API** |

### 2. 2N IP Verso (Weboberfläche)

1. *Dienste → Telefon → SIP:* Peer-to-Peer-Anrufe (Direktwahl per IP) erlauben.
2. *Verzeichnis → Benutzer:* einen Benutzer anlegen, Telefonnummer
   **`sip:tuer@<ioBroker-IP>:5060`** und ihn der Klingeltaste zuweisen.
3. Für „Tür öffnen“ per Tastencode: unter *Hardware → Schalter* einen **Code** für den
   Türöffner festlegen und denselben Code im Adapter eintragen.
4. Audio-Codec: **G.711** (PCMU/PCMA) muss erlaubt sein (Standard).

MicroSIP kann parallel weiter als zweites Ziel eingetragen bleiben, bis alles läuft.

### 3. Touch-PC (Microsoft Edge oder Chrome)

Browser erlauben das Mikrofon nur auf „sicheren“ Seiten (https). Für eine Seite im eigenen
Heimnetz gibt man die Adresse einmalig frei:

1. In der Adresszeile **`edge://flags/#unsafely-treat-insecure-origin-as-secure`** öffnen
   (Chrome: `chrome://flags/…`).
2. Ins Feld beide Adressen eintragen, mit Komma getrennt, z. B.
   **`http://10.0.0.5:8095,http://10.0.0.5:8082`** (Livecam-Port und VIS-2-Port).
3. Auf **Enabled** stellen und den Browser neu starten.
4. **Klingelton erlauben:** `edge://settings/content/mediaAutoplay` → **Zulassen** und die beiden
   Adressen hinzufügen. Ohne diese Einstellung erklingt der Ton erst nach der ersten Berührung.
5. Beim ersten Abnehmen fragt der Browser nach dem Mikrofon: **Zulassen** (dauerhaft).

### 4. VIS-2

Ein Widget **Basic → HTML** über den ganzen Bildschirm legen und als HTML eintragen
(IP und Port anpassen):

```html
<iframe src="http://10.0.0.5:8095/view" allow="microphone; autoplay"
        style="width:100%;height:100%;border:0"></iframe>
```

Wichtig ist `allow="microphone; autoplay"`, sonst blockiert der Browser Mikrofon und Klingelton
im eingebetteten Fenster. Die fertige Adresse steht auch im Datenpunkt `livecam.0.info.viewUrl`.

**Netzwerk:** Der ioBroker-Server braucht eingehend **UDP 5060** (SIP) und freie UDP-Ports für
den Ton. In einem normalen Heimnetz ohne Firewall auf dem Server ist nichts zu tun.

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
| `cameras.<name>.show` | **Schalter:** Kamera auf der Kamerawand anzeigen |
| `info.viewUrl` | Adresse der Kamerawand für VIS-2 |
| `view.display` | **Schalter:** Kamerawand an (aus = schwarz, beim Klingeln trotzdem an) |
| `intercom.ringing` | es klingelt (z. B. für Licht, Telegram, Durchsage) |
| `intercom.active` | Gespräch läuft |
| `intercom.state` | `idle` / `ringing` / `connecting` / `active` |
| `intercom.caller`, `intercom.lastRing` | Anrufer, Zeitpunkt des letzten Klingelns |
| `intercom.missedCount` | Anzahl ungesehener verpasster Anrufe (z. B. für Telegram oder eine Anzeige) |
| `intercom.lastMissed` | Zeitpunkt des letzten verpassten Anrufs |
| `intercom.history` | Anrufliste als JSON |
| `intercom.missedSeen` | **Knopf:** verpasste Anrufe als gesehen markieren |
| `intercom.openDoor` | **Knopf:** Tür öffnen (HTTP-API jederzeit, Tastencode nur im Gespräch) |
| `intercom.hangup` | **Knopf:** auflegen bzw. ablehnen |

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
Die Türsprechstelle wird mit einer simulierten 2N (SIP + RTP) und einem WebRTC-Gegenüber
getestet: Klingeln, Abnehmen, Ton in beide Richtungen, Türcode, Auflegen, Abbruch.

## Lizenz

MIT
