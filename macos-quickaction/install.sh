#!/bin/bash
# Installer für die TranscribeForge Quick Action (macOS).
# Kopiert Script + Automator-Workflow + erstellt Config-Datei.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_TARGET="$HOME/bin/transcribeforge-quickaction.sh"
SERVICES_DIR="$HOME/Library/Services"
WF_NAME="TranscribeForge senden.workflow"
CONFIG_DIR="$HOME/.config"
CONFIG_FILE="$CONFIG_DIR/transcribeforge-quickaction.env"

echo "→ Installiere Script nach $BIN_TARGET"
mkdir -p "$HOME/bin"
install -m 755 "$REPO_DIR/transcribeforge-quickaction.sh" "$BIN_TARGET"

echo "→ Installiere Automator-Workflow nach $SERVICES_DIR/$WF_NAME"
mkdir -p "$SERVICES_DIR"
rm -rf "$SERVICES_DIR/$WF_NAME"
cp -R "$REPO_DIR/$WF_NAME" "$SERVICES_DIR/$WF_NAME"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "→ Lege Default-Config an: $CONFIG_FILE"
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<'EOF'
# TranscribeForge Quick Action — lokale Konfiguration.
# Diese Datei landet NICHT im Git-Repo. Werte hier befüllen.

# Empfänger der Action-Items-Mail (leer = keine Mail)
TF_RECIPIENT=""

# Absender — muss als Account in Mail.app vorhanden sein
TF_SENDER=""

# Whisper-Sprache (de / en / auto)
TF_LANG="de"

# Zentralordner für Symlinks
TF_CENTRAL="$HOME/Documents/TranscribeForge"

# Claude-Modell für die Zusammenfassung
TF_SUMMARY_MODEL="claude-sonnet-4-6"

# Skill-Verzeichnis
TF_SKILL_DIR="$HOME/.claude/skills/transcribeForge"
EOF
  echo "  → Trage TF_RECIPIENT und TF_SENDER in $CONFIG_FILE ein."
else
  echo "→ Config bereits vorhanden, lasse $CONFIG_FILE unverändert"
fi

echo "→ Services-Cache flushen"
/System/Library/CoreServices/pbs -flush >/dev/null 2>&1 || true
/System/Library/CoreServices/pbs -update >/dev/null 2>&1 || true

cat <<'EOM'

✓ Installation fertig.

Nutzung:
  Finder → Rechtsklick auf Videodatei oder Zoom-Ordner
        → Quick Actions / Dienste / "TranscribeForge senden"

Falls Eintrag fehlt:
  Systemeinstellungen → Tastatur → Kurzbefehle → Dienste
  → "Dateien und Ordner" aufklappen → "TranscribeForge senden" aktivieren
  (oder kurz `killall Finder`)
EOM
