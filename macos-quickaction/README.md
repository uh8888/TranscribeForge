# TranscribeForge — macOS Quick Action

Finder-Rechtsklick-Integration für TranscribeForge: Videodatei oder Zoom-Ordner an den lokalen TranscribeForge-Server schicken, Ergebnis als Markdown ablegen und per Mail (Mail.app) verschicken.

## Was passiert beim Aufruf

1. Quick Action erhält die im Finder selektierten Pfade (Video, Audio oder Ordner).
2. Heuristik:
   - **Ordner mit `Audio Record/*.m4a`** → Multi-Speaker-Modus (`scripts/transcribe-multi.js`)
   - **Einzelne Mediendatei** (`.mp4`, `.mov`, `.m4a`, `.mp3`, `.wav`, `.mkv`, `.webm`) → Standard (`scripts/transcribe.js`)
3. MD wird **neben der Quelldatei** abgelegt: `<label>.transcript.md`.
4. Zusätzlich Symlink in **`~/Documents/TranscribeForge/`** (chronologische Sammelablage).
5. Mail wird über **Mail.app** versendet:
   - Body: Header + Executive Summary + Action Items (aus der MD extrahiert)
   - Anhang: vollständige MD-Datei
6. **Floating Status-Fenster** zeigt während des gesamten Laufs Live-Phasen
   (Initialisierung → Whisper → MD/Symlink → Mail) inkl. Schritt 1–4 und Detailzeile.
7. Sound + macOS-Notification am Ende (Glass = Erfolg, Funk = Fehler).

## Voraussetzungen

- macOS (getestet auf 10.15 Catalina)
- TranscribeForge-Server lokal lauffähig (Skill ruft ihn selbständig)
- Skill-Scripts unter `~/.claude/skills/transcribeForge/scripts/` (siehe Haupt-README)
- Node.js (`node` im `$PATH`)
- Mail.app eingerichtet mit dem Account, der als Absender genutzt werden soll

## Installation

```bash
./install.sh
```

Der Installer:
- kopiert das Shell-Script nach `~/bin/transcribeforge-quickaction.sh`
- legt den Automator-Service unter `~/Library/Services/TranscribeForge senden.workflow` ab
- erzeugt (falls nicht vorhanden) `~/.config/transcribeforge-quickaction.env` mit leeren Defaults
- flusht den Services-Cache

Danach **`~/.config/transcribeforge-quickaction.env`** öffnen und mindestens `TF_RECIPIENT` und `TF_SENDER` setzen.

## Konfiguration

Alle Werte werden aus `~/.config/transcribeforge-quickaction.env` gelesen, können aber durch gesetzte Umgebungsvariablen überschrieben werden.

| Variable | Default | Bedeutung |
|---|---|---|
| `TF_RECIPIENT` | — | Empfänger-Mailadresse. Leer = keine Mail. |
| `TF_SENDER` | — | Absender-Adresse. Muss als Account in Mail.app existieren. |
| `TF_LANG` | `de` | Whisper-Sprache (`de`, `en`, `auto` …). |
| `TF_CENTRAL` | `~/Documents/TranscribeForge` | Zentralordner für Symlinks. |
| `TF_SUMMARY_MODEL` | `claude-sonnet-4-6` | Claude-Modell für Multi-Speaker-Summary. |
| `TF_SKILL_DIR` | `~/.claude/skills/transcribeForge` | Pfad zu den Skill-Scripts. |
| `TF_LOG` | `~/Library/Logs/transcribeforge-quickaction.log` | Logdatei. |
| `TF_PROGRESS_SCRIPT` | `~/bin/transcribeforge-progress-window.applescript` | Pfad zum Progress-Window-Skript (AppleScriptObjC). |

## Nutzung

Im Finder Rechtsklick auf eine Mediendatei oder einen Zoom-Ordner →
**Quick Actions** (oder **Dienste**) → **TranscribeForge senden**.

Auf Catalina muss der Dienst ggf. einmalig aktiviert werden:
**Systemeinstellungen → Tastatur → Kurzbefehle → Dienste → Dateien und Ordner →
"TranscribeForge senden"** anhaken.

## Troubleshooting

- **Eintrag fehlt im Kontextmenü** — Services-Cache neu laden:
  ```bash
  /System/Library/CoreServices/pbs -flush && /System/Library/CoreServices/pbs -update
  killall Finder
  ```
- **Mail wird nicht versendet** — `TF_SENDER` muss exakt der Adresse eines aktiven Mail.app-Accounts entsprechen.
- **Multi-Speaker greift nicht** — Zoom-Aufnahme muss als separate Audiospuren konfiguriert sein; im Ordner muss ein `Audio Record/` mit `*.m4a` liegen.
- **Log:** `~/Library/Logs/transcribeforge-quickaction.log`

## Deinstallation

```bash
rm "$HOME/bin/transcribeforge-quickaction.sh"
rm -rf "$HOME/Library/Services/TranscribeForge senden.workflow"
rm "$HOME/.config/transcribeforge-quickaction.env"
/System/Library/CoreServices/pbs -flush
```
