# Spickzettel: Kameras in VIS-2 einbinden

Meine Adressen (`x.x.x.x` = IP des ioBroker-Servers, steht auch im Datenpunkt `livecam.0.info.viewUrl`):

| Was | Adresse |
| --- | --- |
| ioBroker-Server | `x.x.x.x` |
| Livecam (Kamerabilder) | `http://x.x.x.x:8095` |
| VIS-2 | `http://x.x.x.x:8082` |
| Kamerawand | `http://x.x.x.x:8095/view` |
| Übersicht aller Kameras | `http://x.x.x.x:8095/` |

---

## 1. Kamerawand mit Türsprechstelle (das Wichtigste)

1. VIS-2 öffnen, im **Editor** die gewünschte Seite wählen.
2. Links bei den Widgets nach **HTML** suchen (Gruppe *Basic*) und auf die Seite ziehen.
3. Das Widget **so groß wie den ganzen Bildschirm** ziehen
   (oder rechts bei *Position/Größe*: Breite `100%`, Höhe `100%`, oben `0`, links `0`).
4. Rechts im Feld **HTML** genau das hier einfügen:

```html
<iframe src="http://x.x.x.x:8095/view" allow="microphone; autoplay"
        style="width:100%;height:100%;border:0"></iframe>
```

5. **Speichern**, dann die **Laufzeit-Ansicht** öffnen (nicht im Editor testen,
   dort gehen Mikrofon und Knöpfe nicht).

> ⚠️ `allow="microphone; autoplay"` **nie weglassen**, sonst gehen Mikrofon und Klingelton nicht.

### Aussehen anpassen

Zusätze hinten an die Adresse hängen: der erste mit `?`, jeder weitere mit `&`.

| Zusatz | Wirkung |
| --- | --- |
| `?cams=carport,garten` | nur diese Kameras, in dieser Reihenfolge |
| `?cols=2` | Anzahl Spalten |
| `?big=carport` | eine Kamera doppelt so groß |
| `?fps=6` | mehr Bilder pro Sekunde (Standard 4) |
| `?tone=gong&volume=80` | Klingelton und Lautstärke |
| `?wake=60` | Antippen zeigt die ausgeschaltete Wand 60 s lang |
| `?testring=1` | Knopf „Klingelton testen“ (nur zum Ausprobieren) |

Beispiel:

```html
<iframe src="http://x.x.x.x:8095/view?big=sprechanalge&cols=3" allow="microphone; autoplay"
        style="width:100%;height:100%;border:0"></iframe>
```

Die Kamera-Namen (z. B. `carport`) stehen in ioBroker unter **Objekte → livecam.0 → cameras**.

---

## 2. Einzelne Kamera als Bild (ohne Türsprechstelle)

1. Widget **Image** (Gruppe *Basic*) auf die Seite ziehen.
2. Als Bildquelle die Adresse aus dem Objekt `livecam.0.cameras.<name>.mjpegUrl` eintragen,
   z. B. `http://x.x.x.x:8095/cam/carport.mjpeg`
3. **Kein Aktualisierungsintervall** setzen, das Bild läuft von selbst.

> Mehr als 2 Livebilder auf einer Seite? Lieber die Kamerawand (Punkt 1) nehmen,
> sonst bleiben Bilder schwarz (Browser-Grenze: 6 Verbindungen).

---

## 3. Einmalig am Touch-PC in Edge (für Mikrofon und Klingelton)

1. In die Adresszeile eingeben: `edge://flags/#unsafely-treat-insecure-origin-as-secure`
2. Ins Feld eintragen:
   `http://x.x.x.x:8095,http://x.x.x.x:8082`
3. Auf **Aktiviert** stellen und unten auf **Neu starten** klicken.
4. Klingelton ohne vorheriges Antippen erlauben: `edge://settings/content/mediaAutoplay`
   → **Zulassen** → beide Adressen hinzufügen.
5. Beim ersten Abnehmen fragt Edge nach dem Mikrofon: **Zulassen**.

---

## 4. Kamerawand ein- und ausschalten

In ioBroker unter **Objekte**:

| Datenpunkt | Wirkung |
| --- | --- |
| `livecam.0.view.display` | ganze Kamerawand an/aus (aus = schwarz, beim Klingeln trotzdem an) |
| `livecam.0.cameras.<name>.show` | einzelne Kamera an/aus |

Geht auch per Zeitplan, Skript oder Knopf in VIS (Widget mit diesem Datenpunkt verknüpfen).

---

## 5. Wenn etwas nicht geht

| Problem | Lösung |
| --- | --- |
| Kamerawand bleibt leer | Adresse direkt im Browser öffnen: `http://x.x.x.x:8095/view` |
| Neue Kamera fehlt in VIS | Seite neu laden (F5) |
| Kachel bleibt schwarz | andere Tabs mit Kamerabildern schließen (Browser-Grenze) |
| „Mikrofon nicht freigegeben“ | Punkt 3 prüfen, Edge wirklich neu starten |
| „Kein Mikrofon gefunden“ | Mikrofon in Windows prüfen (Einstellungen → System → Sound → Eingabe) |
| Kein Klingelton | einmal auf den Bildschirm tippen oder Punkt 3.4 einstellen |
| Bild einer Kamera fehlt | in ioBroker `livecam.0.cameras.<name>.lastError` ansehen |

Adapter aktualisieren (auf dem ioBroker-Server):

```
iob url https://github.com/andreaslampl/ioBroker.livecam
```
