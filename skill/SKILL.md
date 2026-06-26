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

Setup-Details: siehe README.md (Abschnitt „Single-Stream Diarisation").

**Verhalten bei Fehlern:** Wenn HF_TOKEN, Venv oder pyannote fehlen, wird die Diarisation übersprungen — Whisper-Output bleibt erhalten. Kein Crash.

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
