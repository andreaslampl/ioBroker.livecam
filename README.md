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
| **Mobotix** | Typ Stream: `http://IP/control/faststream.jpg?stream=full` (bei manchen Modellen `/cgi-bin/faststream.jpg?stream=full`; neuere auch ONVIF/RTSP) | `http://IP/record/current.jpg` |
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

Kurzfassung zum Ausdrucken: [ANLEITUNG-VIS.md](ANLEITUNG-VIS.md)

1. Nach dem Start stehen unter `livecam.0.cameras.<name>.mjpegUrl` die fertigen Adressen,
   z. B. `http://10.0.0.5:8095/cam/haustuer.mjpeg`.
2. In VIS-2 ein **Bild-Widget** (z. B. *Basic → Image*) einfügen.
3. Als Bildquelle die **mjpegUrl** eintragen. **Kein Aktualisierungsintervall** setzen,
   das Livebild aktualisiert sich selbst.

Eine Übersicht aller Kameras gibt es unter `http://<ioBroker-IP>:8095/`.

**Viele Kameras auf einer Seite:** Browser öffnen pro Server höchstens ca. 6 Livebilder
gleichzeitig. Für mehr Kameras die **Kamerawand** (`/view`, schaltet automatisch um) oder die
**snapshotUrl** mit einem Aktualisierungsintervall (z. B. 1 s) verwenden.

## Kamerawand mit Türsprechstelle (2N, Mobotix)

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
| Klingelton / Lautstärke | Ding-Dong, Westminster-Gong, Glockenspiel, Glocke, Telefon, Melodien (Westminster vollständig, Für Elise, Ode an die Freude, Bruder Jakob, Alle meine Entchen, Kuckuck, Xylophon, Harfe, Dreiklang) oder eigene Tondatei; ausprobieren mit `…/view?testring=1&tone=elise` |
| Tür öffnen über | **Tastencode (DTMF)** mit dem in der 2N eingestellten Schaltcode, oder **2N HTTP-API** |

### 2. 2N IP Verso (Weboberfläche)

1. *Dienste → Telefon → SIP:* Peer-to-Peer-Anrufe (Direktwahl per IP) erlauben.
2. *Verzeichnis → Benutzer:* einen Benutzer anlegen, Telefonnummer
   **`sip:tuer@<ioBroker-IP>:5060`** und ihn der Klingeltaste zuweisen.
3. Für „Tür öffnen“ per Tastencode: unter *Hardware → Schalter* einen **Code** für den
   Türöffner festlegen und denselben Code im Adapter eintragen.
4. Audio-Codec: **G.711** (PCMU/PCMA) muss erlaubt sein (Standard).

MicroSIP kann parallel weiter als zweites Ziel eingetragen bleiben, bis alles läuft.

### Von innen zur Sprechstelle anrufen

SmartView (Menü ⚙ → „📞 … anrufen“) kann die Sprechstelle auch **selbst anrufen**, z. B. um mit
jemandem draußen zu sprechen oder Lautsprecher und Mikrofon zu testen. livecam ruft dafür
`sip:door@<IP der Sprechstelle>:5060` direkt an (ohne SIP-Server); der Anruf erscheint nicht in der
Anrufliste. Die Sprechstelle muss **eingehende Direktrufe annehmen**:

- **2N IP Verso:** *Dienste → Telefon → Anrufe:* eingehende Anrufe **automatisch annehmen**
  (sonst klingelt es nur draußen und jemand müsste dort abheben). Bei Direktrufen muss die
  Absender-IP erlaubt sein, falls dort eine Liste gepflegt ist.
- **Mobotix:** eingehende SIP-Anrufe annehmen (automatische Annahme in den Telefon-Einstellungen).

### Klingeltöne anhören und auswählen

Die Seite **`http://<ioBroker-IP>:8095/tones`** (Adresse auch im Datenpunkt `info.tonesUrl`) zeigt
alle Klingeltöne als Kacheln: **▶ Anhören**, Lautstärke-Regler und **Verwenden** - der gewählte
Ton gilt sofort auf allen Kamerawänden, ohne Adapter-Neustart. Auf der Kamerawand führt der Knopf
**„Klingeltöne“** in der Anrufliste dorthin.

Per Skript geht es über `view.ringTone` (z. B. `elise`, `harfe`) und `view.ringVolume` (0–100),
etwa nachts ein leiserer Ton.

### Weitere Türsprechstellen (z. B. Mobotix T25/T26)

Im Reiter „Türsprechstelle“ unter **„Weitere Türsprechstellen“** beliebig viele zusätzliche
Sprechstellen eintragen: Name, IP-Adresse, Kamera (leer = Kamera mit derselben IP) und Türöffner.
Klingelt eine davon, zeigt die Kamerawand **ihre** Kamera groß, die Anrufliste ihren Namen.

| Türöffner | Wie |
| --- | --- |
| Tastencode (DTMF) | Code, den die Sprechstelle während des Gesprächs als Türöffner-Befehl annimmt |
| URL (HTTP) | beliebige Adresse, die die Tür öffnet (GET, mit Benutzer/Passwort per Basic/Digest) |

**Mobotix T25/T26:** in der Weboberfläche unter den SIP-/Telefon-Einstellungen einen
**Direktruf (Peer-to-Peer, ohne SIP-Server)** an **`sip:iobroker@<ioBroker-IP>:5060`** anlegen und
der Klingeltaste zuweisen; Audio-Codec **G.711** (PCMU/PCMA) erlauben. Für die Tür entweder die
DTMF-Fernsteuerung der T25 mit einem Code einrichten (Code im Adapter eintragen) oder die
HTTP-Adresse des Türöffners verwenden. Die genauen Menünamen hängen von der Mobotix-Software ab.

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

**Netzwerk / Firewall:** Klingeln läuft über **UDP 5060** (SIP), der Ton über eigene UDP-Ports. Liegen Sprechstelle,
ioBroker und Handys in verschiedenen Netzen (VLANs), unter „UDP-Ports für den Ton“ einen festen Bereich eintragen, z. B.
**`40000-40019`** – die erste Hälfte nimmt livecam für den Ton zur Sprechstelle, die zweite für die Browser. Dann in der
Firewall erlauben:

| Von | Zu | Ports |
| --- | --- | --- |
| Sprechstelle | ioBroker | UDP 5060 und der ganze Bereich (z. B. 40000-40019) |
| ioBroker | Sprechstelle | UDP 5060 und die RTP-Ports der Sprechstelle (2N: in der Weboberfläche unter Telefon/Audio, oft 4900-4999) – oder alles UDP zur Sprechstelle |
| Handys / Touch-PC (wenn in einem anderen Netz) | ioBroker | UDP, der ganze Bereich |

Nach jedem Gespräch steht im Log eine **Ton-Statistik** (Pakete je Richtung) mit Hinweisen, wo der Ton hängen bleibt. In einem normalen Heimnetz ohne Firewall auf dem Server ist nichts zu tun.

## KI-Erkennung: Personen, Fahrzeuge, Tiere

livecam erkennt auf Wunsch **Personen, Fahrzeuge** (Auto, LKW, Bus, Motorrad, Fahrrad) und **Tiere** (Katze, Hund,
Vogel …) – auch mit älteren Kameras ohne eigene Analyse. Damit z. B. **Licht ein, solange jemand am Eingang ist**, oder
eine Push-Mitteilung, wenn eine Person in einen Bereich kommt.

**Einschalten:** in der Kameratabelle Spalte **„KI-Erkennung“** wählen (Personen / + Fahrzeuge / + Tiere). Im Reiter
„KI-Erkennung“: Mindest-Sicherheit (Standard 55 %), wie lange „erkannt“ nach der letzten Erkennung anbleibt (20 s) und
wie oft höchstens geprüft wird (1 × pro Sekunde und Kamera).

**Rechenlast:** Die Erkennung läuft im ioBroker (Modell YOLOX-nano, über WebAssembly – auch auf Prozessoren ohne AVX wie
dem Celeron J4125). Damit sie wenig Last macht:
- Video-Kameras: livecam dekodiert dafür **nur die Schlüsselbilder** (meist 1 pro Sekunde) in kleiner Auflösung.
- Die KI rechnet **nur, wenn sich das Bild ändert** oder solange etwas erkannt ist, sonst alle 30 s einmal.
- Alle Kameras teilen sich ein Modell, es rechnet immer nur eine Prüfung gleichzeitig.
Die durchschnittliche Zeit pro Prüfung steht in `info.detectMs`.

**Bereiche:** Auf der Seite **`http://<ioBroker-IP>:8095/zones`** (Adresse in `info.zonesUrl`) auf das Kamerabild
tippen und Ecken setzen – z. B. nur der Weg zur Haustür. Gezählt wird, wer **mit den Füßen** (Unterkante des Rahmens)
im Bereich steht. Mehrere Bereiche pro Kamera möglich; kein Bereich = ganzes Bild.

**Datenpunkte** pro Kamera unter `cameras.<Name>.detect`:

| Datenpunkt | Bedeutung |
| --- | --- |
| `person` / `vehicle` / `animal` | `true`, solange erkannt (bis die Haltezeit nach der letzten Erkennung abgelaufen ist) |
| `personCount` / `vehicleCount` / `animalCount` | wie viele gerade im Bild / Bereich sind |
| `last`, `lastTime` | z. B. „2 × Person (87 %)“ und wann |
| `photoUrl` | Foto der letzten Erkennung mit roten Rahmen (für Push / SmartView) |
| `boxes` | aktuelle Rahmen als JSON (für die Anzeige über dem Livebild in SmartView) |
| `zones` | die eingezeichneten Bereiche (JSON) |

**Beispiele:** Logik-Adapter: `cameras.eingang.detect.person` → Ausgang Außenlicht (bleibt an, solange jemand da ist).
SmartView: Push-Regel „wird Ein“ auf `cameras.eingang.detect.person`.

### Kennzeichen der eigenen Fahrzeuge

livecam kann die **Kennzeichen eurer eigenen Autos** erkennen, z. B. Einfahrtslicht ein oder eine Mitteilung „ID.4 ist
heimgekommen“.

1. Kameratabelle: Die Kamera braucht die Fahrzeug-Erkennung (z. B. „Personen + Fahrzeuge“). Dazu die Spalte
   **„Kennzeichen“** ankreuzen.
2. Reiter „KI-Erkennung“ → **„Eigene Kennzeichen“**: Kennzeichen und einen Namen eintragen (z. B. `KL-482BX` / `ID.4`).
   Bindestriche, Leerzeichen und Groß-/Kleinschreibung sind egal.

Sobald ein Fahrzeug im Bild ist, holt livecam ein Bild in voller Auflösung, sucht darauf das Kennzeichen und liest es.
Das wiederholt es alle 2 s, höchstens 8-mal, bis eines der eigenen Kennzeichen erkannt ist. Ein Zeichen darf dabei
falsch gelesen sein; ähnliche Zeichen wie 0/O, 8/B oder 5/S gelten als gleich.

**Datenschutz:** Gemeldet werden **nur Kennzeichen aus der Liste**, und zwar mit ihrem Namen. Andere Kennzeichen werden
weder gespeichert noch ins Log geschrieben. Mit „Unbekannte Fahrzeuge melden“ steht dann nur „unbekannt“ in
`detect.plate`.

**Gut zu wissen:**
- Das Kennzeichen muss im Kamerabild gut lesbar sein: mindestens etwa 100 Pixel breit, nicht zu schräg, nachts beleuchtet
  (Infrarot geht meist). Eine Kamera, die auf die Einfahrt zoomt, ist viel besser als eine Weitwinkel-Übersicht.
- **Nicht als einziger Schlüssel für Tor oder Tür verwenden** – ein Kennzeichen kann man nachmachen. Für Licht,
  Mitteilungen oder „Garagentor fragt nach“ ist es gut geeignet.
- Rechenlast: nur solange ein Fahrzeug da ist. Die Zeit pro Lesung steht in `info.plateMs`.

| Datenpunkt | Bedeutung |
| --- | --- |
| `cameras.<Name>.detect.plate` | Name des erkannten eigenen Fahrzeugs (oder „unbekannt“) |
| `cameras.<Name>.detect.plateKnown` | `true`, solange ein eigenes Fahrzeug an dieser Kamera ist |
| `cameras.<Name>.detect.plateTime` | Zeit der Erkennung |
| `plates.<Fahrzeug>.present` | `true`, solange dieses Fahrzeug an einer Kamera steht |
| `plates.<Fahrzeug>.lastSeen`, `.camera` | wann und wo zuletzt gesehen |

### Gesichter der Bewohner (mit Lebenderkennung)

livecam kann die **Gesichter eurer eigenen Leute** erkennen, z. B. „Anna ist da“, Licht nach Person oder eine
Tür-Freigabe.

1. Kameratabelle: Die Kamera braucht die Personen-Erkennung. Dazu die Spalte **„Gesichter“** ankreuzen.
2. Im Reiter „Webserver“ einen **Zugriffsschlüssel** setzen (Pflicht, sonst könnte jeder im Netz ein Gesicht einlernen).
3. Die Seite **`/faces`** öffnen (Adresse steht in `info.facesUrl`). Dort Personen anlegen und einlernen:
   - **Fotos hinzufügen:** 3–10 Fotos von vorne, mit und ohne Brille. Am Handy direkt aus der Fotomediathek.
   - **An Kamera einlernen:** vor die Kamera stellen, Start drücken und den Kopf langsam etwas drehen (15 s).
   - **„darf Tür öffnen“** nur bei Personen ankreuzen, die die Tür öffnen dürfen.

Sobald eine Person im Bild ist, sucht livecam alle 1,5 s nach Gesichtern (höchstens 10-mal) und vergleicht sie mit den
eingelernten Personen.

| Datenpunkt | Bedeutung |
| --- | --- |
| `cameras.<Name>.detect.face` | Name der erkannten Person (oder „unbekannt“, wenn angehakt) |
| `cameras.<Name>.detect.faceKnown` | `true`, solange eine eigene Person da ist (lebend) |
| `cameras.<Name>.detect.faceDoor` | **Tür-Freigabe:** Person darf öffnen, zweimal hintereinander erkannt, Lebenderkennung bestanden |
| `cameras.<Name>.detect.faceScore`, `.faceLive` | Ähnlichkeit und Lebenderkennung in % |
| `faces.<Person>.present`, `.lastSeen`, `.camera` | ist gerade da, wann und wo zuletzt gesehen |

**Lebenderkennung:** prüft, ob ein echter Mensch vor der Kamera steht. Ein vorgehaltenes Handy mit sichtbarem Rand oder
ein ausgedrucktes Foto fällt durch (im Log: „… erkannt, aber die Lebenderkennung ist nicht bestanden“). Ein Bildschirm,
der das ganze Bild füllt, kann aber durchgehen. Eine normale Kamera ohne 3D- oder Infrarot-Sensor kann das nicht sicher
unterscheiden.

**Darum:** `faceDoor` **nicht als einzigen Schlüssel** für die Haustür verwenden. Gut sind z. B. Gesicht **und** Taster an
der Tür, Gesicht **und** PIN, nur tagsüber, oder für Nebentüren und Garage. Für Licht, Begrüßung, Push und „wer ist da“ passt
die Gesichtserkennung ohne Einschränkung.

**Datenschutz:** Gespeichert werden nur die eingelernten Personen (Merkmale + kleine Vorschaubilder im Datenordner der Instanz).
Fremde Gesichter werden nie gespeichert und nicht ins Log geschrieben. Löschen einer Person löscht alles von ihr. Bitte nur
Personen einlernen, die einverstanden sind.

**Rechenlast:** nur solange eine Person an dieser Kamera ist, etwa 1–2 s pro Prüfung auf einem Celeron J4125. Die Zeit steht in
`info.faceMs`.

## Optional: Anbindung an die Andreas L.-Arts VMS

livecam läuft weiter eigenständig wie bisher. Nur wenn im Reiter **„VMS“** eine Adresse **und** ein API-Schlüssel
eingetragen sind, kommen Kameras, Livebilder, Ereignisse, Kennzeichen und Schalter zusätzlich von der VMS. Kamerawand,
Türsprechstelle und Anrufliste bleiben unverändert.

**Einrichten**
1. In der VMS unter *Einstellungen → Schnittstelle* einen Schlüssel erstellen (`alvms_…`). Für das beste Livebild dort
   auch die **RTSP-Freigabe** einschalten und den Port in der Windows-Firewall freigeben.
2. livecam, Reiter „VMS“: Adresse (z. B. `http://192.168.1.10:8080`) und Schlüssel eintragen, speichern.
3. Kameras: entweder **„Kameras von der VMS übernehmen“** ankreuzen, dann erscheinen alle VMS-Kameras ohne eigenen
   Tabelleneintrag. Oder in der Kameratabelle **Typ „VMS“** wählen und in der Spalte **„VMS-Kamera“** die Kamera aussuchen.
   Die Liste füllt sich, sobald Adresse und Schlüssel gespeichert sind. Für eine Kamera aus der Tabelle gelten auch die
   Spalten KI-Erkennung und Kennzeichen von livecam.

**Livebild:** über RTSP der VMS (Unterstream), wenn die Freigabe an ist, sonst als MJPEG von der VMS. Jede Kamera hat so
nur eine Verbindung, nämlich die zur VMS.

**Datenpunkte** (Haken „Ereignisse als Datenpunkte“) unter `vms.`:

| Datenpunkt | Bedeutung |
| --- | --- |
| `vms.connection` | Live-Kanal zur VMS steht |
| `vms.cameras.<Kamera>.online`, `.recording`, `.motion` | Zustand der Kamera in der VMS |
| `.person`, `.car`, `.animal`, `.motorcycle`, `.bicycle`, `.truck` | `true`, solange die VMS das erkennt |
| `.lastEvent` (JSON), `.lastEventKind`, `.lastEventTime` | letztes Ereignis |
| `.lastEventImage` | Foto des Ereignisses, signierter Link, funktioniert ohne Schlüssel (z. B. für Telegram) |
| `.lastPlate`, `.lastPlateName`, `.lastPlateKind` | Kennzeichen aus den Listen der VMS (`known` / `alarm`); fremde Kennzeichen nur als `unknown`, ohne Text |
| `.recordMode` | **schaltbar**: `off` / `continuous` / `motion` / `ai` |
| `.enabled` | **schaltbar**: Kamera in der VMS an/aus |
| `vms.lastEvent` | letztes Ereignis aller Kameras (JSON) |

**Klingeln an die VMS** (Haken „Klingeln an die VMS melden“): Wenn die 2N klingelt, meldet livecam das der VMS. Die VMS
macht Foto und Aufnahme und schickt Push. Welche VMS-Kamera gilt: die eingestellte, sonst die VMS-Kamera hinter der
Sprechstellen-Kamera, sonst die VMS-Kamera mit der IP der 2N.

**Wenn die VMS nicht erreichbar ist:** livecam läuft normal weiter, `vms.connection` = false. Der Adapter verbindet
sich mit wachsender Wartezeit neu (2 s bis 60 s). Übernommene Kameras bleiben mit der zuletzt bekannten Liste angelegt.

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
| `info.tonesUrl` | Adresse der Klingelton-Seite |
| `view.ringTone`, `view.ringVolume` | **Schreibbar:** Klingelton und Lautstärke der Kamerawand |
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

MIT. Das Erkennungsmodell `models/yolox_nano.onnx` stammt aus YOLOX von Megvii (Apache-2.0,
https://github.com/Megvii-BaseDetection/YOLOX); die KI-Laufzeit onnxruntime-web von Microsoft (MIT). Die Kennzeichen-Modelle
`models/plate_*.onnx` stammen von ankandrew (open-image-models und fast-plate-ocr, MIT), Details in `models/README.md`. Gesichter: YuNet (MIT), SFace und MiniFASNet (Apache-2.0), ebenfalls dort.
