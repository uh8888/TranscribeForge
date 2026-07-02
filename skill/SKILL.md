---
name: transcribeForge
description: Analysiert lokale Video-Dateien (MP4, MOV, etc.) via TranscribeForge: OpenAI Whisper für Audio-Transkription + Claude Vision für Frame-Analyse. Multi-Speaker-Modus für Zoom-Calls mit Einzeldateien pro Sprecher. Trigger-Beispiele "analysiere das Video", "transkribiere dieses Video", "Zoom-Call transkribieren", "Meeting mit mehreren Sprechern".
---

# transcribeForge

Skill zur vollautomatischen Analyse lokaler Video-Dateien. Nutzt den TranscribeForge-Server (läuft lokal auf Port 3001) mit:
- **OpenAI Whisper** → Transkript des gesprochenen Inhalts
- **Claude Haiku Vision** → Frame-by-Frame-Beschreibung (alle 3 Sekunden)

## Wann nutzen

Immer wenn der User ein lokales Video analysieren, transkribieren oder beschreiben lassen will — egal ob Screenrecording, Meeting-Aufnahme, Tutorial oder Snagit-Capture.

## PFLICHT: Parameter vor Ausführung im Chat abfragen

Bevor das Skript gestartet wird, **immer zuerst die wichtigsten Parameter beim User bestätigen lassen** (per AskUserQuestion oder als nummerierte Frage YY-MM-DD-NNN). Niemals stillschweigend mit Defaults loslaufen.

Mindestens abzufragen:
- `--lang` (Sprache Whisper, Default `de`)
- `--interval` (Frame-Abstand in Sekunden, Default `3` → 0,33 fps; bei statischen Screencasts ggf. 5–10 sinnvoll, bei dichten Demos 1–2)
- `--model` (nur wenn relevant; Default Haiku reicht meist)
- Multi-Speaker-Modus: `--no-summary`, `--summary-model`, `--output` ebenfalls bestätigen
- **Webinar-Modus:** wenn User „Webinar", „Slides-Site", „Vortrag als Website" o. ä. sagt → `--title` und `--slug` per AskUserQuestion abfragen, BEVOR der Skript-Call rausgeht. Aus dem Kontext heraus Vorschläge ableiten (Slug aus Video-Basename lowercased mit `-`).

Erst nach User-Bestätigung das Skript starten.

## Wie aufrufen

```bash
node ~/.claude/skills/transcribeForge/scripts/transcribe.js \
  --video "/absoluter/pfad/zur/datei.mp4" \
  [--lang de] \
  [--interval 3] \
  [--model claude-haiku-4-5-20251001]
```

**Erforderlich:**
- `--video <pfad>` — absoluter Pfad zur Videodatei

**Optional:**
- `--lang <code>` — Sprache für Whisper (z. B. `de`, `en`, `auto`). Default: `de`
- `--interval <sek>` — Frame-Abstand in Sekunden. Default: `3`
- `--model <id>` — Claude-Modell für Frame-Analyse. Default: `claude-haiku-4-5-20251001`

## Ablauf

1. Skript prüft ob TranscribeForge-Server auf Port 3001 läuft
2. Falls nicht → Server wird automatisch aus `/Users/uhi/Projects/TranscribeForge/` gestartet
3. Video wird per HTTP POST hochgeladen
4. Fortschritt wird alle 1s gepollt und ausgegeben
5. Ergebnis: Transkript + Frame-Analyse werden auf stdout ausgegeben

## Env-Vars

Das Skript lädt automatisch `/Users/uhi/Projects/TranscribeForge/.env` — dort liegen `OPENAI_API_KEY` und `ANTHROPIC_API_KEY`. Kein manueller Export nötig.

## Nach dem Aufruf

Das Skript gibt zurück:
- `TRANSKRIPT` — vollständiger gesprochener Text
- `FRAME-ANALYSE` — Beschreibung je Frame im Format `MM:SS – [Beschreibung]`

Claude soll daraus eine zusammenhängende Analyse des Videoinhalts erstellen und die Frage des Users beantworten.

## Typische Videoorte

- Snagit-Captures: `~/Documents/Snagit/Autosaved Captures.localized/`
- Desktop: `~/Desktop/`

---

## Single-Stream Diarisation (pyannote)

Für Aufnahmen, in denen **EIN Mikrofon mehrere Sprecher** mitschneidet (iPhone-Mitschnitt eines Meetings im Raum). Whisper-Segmente werden per pyannote-audio Sprechern zugeordnet.

```bash
node ~/.claude/skills/transcribeForge/scripts/transcribe.js \
  --video "/pfad/aufnahme.m4a" \
  --diarize \
  [--speakers "Uwe,Bastian"] \
  [--min-speakers 2] [--max-speakers 4] \
  [--no-frames]
```

**Flags:**
- `--diarize` — pyannote-Pass aktivieren (Default: aus)
- `--speakers <a,b,c>` — Klarnamen-Mapping für SPEAKER_00/01/… in Reihenfolge des ersten Auftretens
- `--min-speakers N` / `--max-speakers N` — pyannote-Hyperparameter, optional

**Voraussetzungen:**
- `HF_TOKEN` in `/Users/uhi/Projects/TranscribeForge/.env`
- EULA für `pyannote/speaker-diarization-3.1` + `pyannote/segmentation-3.0` im HF-Web-UI akzeptiert
- Python-Venv unter `/Users/uhi/Projects/TranscribeForge/python/.venv/` mit `pyannote.audio`

Setup-Details: siehe `/Users/uhi/Projects/TranscribeForge/README.md` (Abschnitt „Single-Stream Diarisation").

**Verhalten bei Fehlern:** Wenn HF_TOKEN, Venv oder pyannote fehlen, wird die Diarisation übersprungen — Whisper-Output bleibt erhalten. Kein Crash.

---

## Webinar-Modus (Slides-Site aus Video)

Erzeugt aus einem Vortragsvideo automatisch eine statische Website mit synchron eingeblendeten Folien-Screenshots + Volltranskript und deployt sie unter `https://transcribeforge.hiltmann.cloud/webinare/<slug>/`. Die Verarbeitung läuft **auf dem Backend-Server** (Volumes + Templates liegen dort).

```bash
node ~/.claude/skills/transcribeForge/scripts/transcribe.js \
  --video "/absoluter/pfad/vortrag.mp4" \
  --lang de --interval 1 \
  --webinar \
  --title "Mein Webinar-Titel" \
  --slug "mein-webinar-slug" \
  [--no-deploy]
```

**Flags:**
- `--webinar` — aktiviert den Modus. Das Video wird an `/api/transcribe` hochgeladen; das Backend läuft Whisper + Frames + Slides-Pipeline (Extract → Cluster → Vision → Dedup → Render → Deploy).
- `--title "<str>"` — Site-Titel (Pflicht wenn `--webinar`).
- `--slug "<str>"` — URL-Slug (Pflicht). Zeichen ausserhalb `[a-z0-9-]` werden clientseitig zu `-` und Rand-`-` gestrippt. Max. 80 Zeichen.
- `--no-deploy` — Site nur bauen, NICHT unter `/webinare/<slug>/` veröffentlichen. Default: deployen.

**PFLICHT-Rückfrage bei Skill-Aufruf über Claude Code:**
Wenn User „Webinar", „Slides-Site" oder „Vortrag als Website" sagt und `--title`/`--slug` fehlen, MUSS Claude **vor** dem Skript-Call per AskUserQuestion abfragen. Vorschlag ableiten:
- Slug: `basename.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')`
- Title: Basename ohne Extension mit Leerzeichen statt `_-`.

Der Skript-Prozess ohne TTY (Claude-Modus) bricht mit exit(1) und klarer Fehlermeldung ab, wenn `--webinar` gesetzt ist, aber Title/Slug fehlen — Claude soll dann die Frage stellen.

**Ergebnis-Ausgabe:**
```
════════════════════════════════════════
WEBINAR-SITE
════════════════════════════════════════
URL:    https://transcribeforge.hiltmann.cloud/webinare/<slug>/
Status: deployed
```

**Backend-Endpoint (Debug):** `POST https://transcribeforge.hiltmann.cloud/api/transcribe` mit Multipart-Feldern `webinar=1`, `webinar_title`, `webinar_slug`, `webinar_deploy`. Progress-Polling per `GET /api/progress/:jobId`, Steps 1–8.

---

## Multi-Speaker-Modus (Zoom-Calls)

Für Zoom-Aufnahmen mit separaten Sprecher-Dateien (Einstellung "Record a separate audio file for each participant").

```bash
# Automatisch via Ordner (Sprechernamen aus Dateinamen):
node ~/.claude/skills/transcribeForge/scripts/transcribe-multi.js \
  --dir "/pfad/zum/Audio Record" \
  [--lang de] [--no-summary] [--output ergebnis.txt]

# Manuell mit expliziten Namen:
node ~/.claude/skills/transcribeForge/scripts/transcribe-multi.js \
  --speaker "Uwe:uwe.m4a" \
  --speaker "Volkan:volkan.m4a" \
  --speaker "Max:max.m4a"
```

**Flags:**
- `--dir <pfad>` — Ordner mit .m4a-Einzeldateien; Zoom-Dateinamen → Sprechernamen automatisch
- `--speaker "Name:datei.m4a"` — manuell (wiederholbar); optional `"Name:datei.m4a:1080"` für Offset in Sek.
- `--lang <code>` — Whisper-Sprache (default: `de`)
- `--no-summary` — Nur Transkript, keine Claude-Zusammenfassung
- `--summary-model <id>` — Claude-Modell für Summary (default: `claude-sonnet-4-6`)
- `--output <datei>` — Ergebnis zusätzlich in Textdatei speichern

**Ablauf:**
1. Dateidauern per ffprobe messen → Offset automatisch berechnen (längste Datei = Referenz)
2. Alle Sprecher parallel mit Whisper transkribieren (mit Segment-Timestamps)
3. Segmente chronologisch mergen → `[MM:SS – Name]: Text`
4. Claude erstellt Zusammenfassung + Action Items mit Sprecher-Zuweisung

**Offset-Logik:** Alle Teilnehmer müssen das Meeting zur gleichen Zeit beendet haben. Kürzere Dateien = später beigetreten → Offset = Längste − Eigene.

**Ausgabe:**
- `TRANSKRIPT` — Speaker-gelabeltes Volltranskript
- `ZUSAMMENFASSUNG & ACTION ITEMS` — Executive Summary, Themen, Entscheidungen, Action Items mit Verantwortlichem

---

## Fehlerquellen

- Port 3001 belegt → `lsof -ti:3001 | xargs kill` und erneut versuchen
- `OPENAI_API_KEY` fehlt → `.env` in `/Users/uhi/Projects/TranscribeForge/` prüfen
- Datei im iCloud (`.icloud` Suffix) → erst mit `brctl download <pfad>` herunterladen

---

## Changelog

- **v1.2.0** — Selective HQ Frames + Panzoom Lightbox
  - Vision-Prompt erweitert um `readable_at_1280` (bewertet Text-Lesbarkeit bei 1280×720/Q82)
  - Für Slides mit `readable_at_1280=false` wird zusätzlich ein hochaufgelöstes Frame nach `assets/frames_hq/` extrahiert (bis 2560px lange Kante, JPEG-Q92). Nur wenn Videoauflösung ≥ 1600px lange Kante — sonst redundant.
  - Frontend-Lightbox integriert Panzoom.js (lokal in `assets/vendor/panzoom.min.js`, DSGVO-konform, keine CDN)
  - Slide-Cards mit HQ zeigen "HD zoom"-Badge und `cursor: zoom-in`
  - Zoom-Controls (−/100%/+), Mausrad-Zoom, Doppelklick-Zoom, Pan per Drag
  - Ordnerstruktur: `assets/frames/` (1280×720 Q82) und `assets/frames_hq/` (native bis 2560 Q92)
- **v1.1.0** — Webinar-Modus (Slides-Site aus Video)
- **v1.0.0** — Basis-Transkription + Multi-Speaker-Modus
