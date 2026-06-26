# TranscribeForge

Video-Transkription via OpenAI Whisper + Frame-Analyse via Claude Vision.

- **Server** (`server.js`): Express auf Port 3001, Upload-API + YouTube/Vimeo
- **CLI** (`skill/scripts/transcribe.js` bzw. `~/.claude/skills/transcribeForge/scripts/transcribe.js`): direkter Modus ohne Server, lokale Datei oder URL
- **Multi-Speaker** (`skill/scripts/transcribe-multi.js`): Zoom-Aufnahmen mit getrennten m4a pro Sprecher

## Single-Stream Diarisation (pyannote-audio)

Wenn eine **einzelne Audiodatei mehrere Sprecher im selben Raum** enthält (typisch: iPhone-Mitschnitt eines Meetings), kann TranscribeForge per pyannote-audio Sprecher-Labels in das Whisper-Transkript einbauen.

### Setup (einmalig)

```bash
# 1) HuggingFace-Token + EULA
#    a) Token auf https://huggingface.co/settings/tokens erzeugen (read reicht).
#    b) Auf den Modell-Seiten EULA akzeptieren:
#       - https://huggingface.co/pyannote/speaker-diarization-3.1
#       - https://huggingface.co/pyannote/segmentation-3.0
#    c) HF_TOKEN=<token> in .env eintragen.

# 2) Python-Venv anlegen (Python >= 3.10 empfohlen)
cd /Users/uhi/Projects/TranscribeForge
python3.10 -m venv python/.venv
source python/.venv/bin/activate
pip install -U pip
pip install -r python/requirements.txt
```

### macOS Catalina (10.15) — Hinweis

System-Python 3.8 reicht **nicht** für pyannote-audio 3.1. Python 3.10 via pyenv installieren (`pyenv install 3.10.13`). torch 2.x liefert keine offiziellen Catalina-Wheels mehr — falls die Default-Installation fehlschlägt, in `python/requirements.txt` den auskommentierten Catalina-Fallback aktivieren (`torch==1.13.1` + `pyannote.audio==2.1.1`).

### Aufruf

```bash
# Minimal:
node skill/scripts/transcribe.js --video meeting.m4a --diarize --no-frames

# Mit Klarnamen-Mapping (SPEAKER_00 → Uwe, SPEAKER_01 → Bastian, …):
node skill/scripts/transcribe.js --video meeting.m4a \
  --diarize --speakers "Uwe,Bastian" --no-frames

# Mit pyannote-Hyperparametern:
node skill/scripts/transcribe.js --video meeting.m4a \
  --diarize --min-speakers 2 --max-speakers 3 --no-frames
```

### Ausgabe

Bei aktivem `--diarize` enthält der Transkript-Block zusätzlich pro Whisper-Segment ein Sprecher-Label:

```
[00:12 – Uwe]: Ich hatte das im Auge, ja.
[00:18 – Bastian]: Genau, und dann müssen wir noch …
```

Frame-Analyse und Plain-Transkript bleiben unverändert erhalten (rückwärtskompatibel).

### Verhalten bei Fehlern

- Kein `HF_TOKEN`, EULA nicht akzeptiert, `pyannote.audio` nicht installiert, Python-Venv fehlt → Diarisation wird **übersprungen** (kein Crash). Es gibt eine klare stderr-Meldung, der Lauf endet mit dem normalen Whisper-Transkript.
- Ohne `--diarize` ist das Verhalten **byte-identisch** zur Version vor diesem Feature.

### Performance-Erwartung

- ~5 Min Audio, CPU-Inferenz: ~30 s Diarisation
- Erstes Mal lädt pyannote ~50 MB nach `~/.cache/huggingface/`
- GPU optional via `pip install torch --index-url https://download.pytorch.org/whl/cu121` und `--device cuda` im Python-Skript

## Multi-Speaker (Zoom mit Einzeldateien)

Wenn jeder Sprecher seine eigene m4a-Datei hat: siehe `skill/scripts/transcribe-multi.js` (`--dir <Audio Record/>` oder `--speaker "Name:datei.m4a"`).
