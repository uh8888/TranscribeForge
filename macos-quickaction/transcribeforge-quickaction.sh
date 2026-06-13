#!/bin/bash
# TranscribeForge Quick Action: Finder-Rechtsklick → Video/Ordner an TranscribeForge,
# MD-Ablage (neben Quelldatei + Symlink in zentralem Ordner),
# Mail mit Action-Items-Body + MD-Anhang.
#
# Wird von der Automator Quick Action "TranscribeForge senden.workflow"
# mit den selektierten Pfaden als Argumente aufgerufen.
#
# Konfiguration: ~/.config/transcribeforge-quickaction.env (siehe install.sh).
# Umgebungsvariablen können auch direkt im Workflow gesetzt werden.

set -u

# ---------- Defaults ----------
: "${TF_RECIPIENT:=}"           # Empfänger-Mailadresse (z. B. me@example.com)
: "${TF_SENDER:=}"              # Absender-Account (muss in Mail.app vorhanden sein)
: "${TF_LANG:=de}"              # Whisper-Sprache
: "${TF_CENTRAL:=$HOME/Documents/TranscribeForge}"
: "${TF_SUMMARY_MODEL:=claude-sonnet-4-6}"
: "${TF_SKILL_DIR:=$HOME/.claude/skills/transcribeForge}"
: "${TF_LOG:=$HOME/Library/Logs/transcribeforge-quickaction.log}"

CONFIG="$HOME/.config/transcribeforge-quickaction.env"
[ -f "$CONFIG" ] && . "$CONFIG"

INPUTS=("$@")
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

mkdir -p "$TF_CENTRAL" "$(dirname "$TF_LOG")"
exec >>"$TF_LOG" 2>&1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') Quick Action start ====="
echo "Inputs: ${INPUTS[*]}"

notify() {
  local title="$1" msg="$2"
  /usr/bin/osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${title//\"/\\\"}\"" || true
}

slugify() {
  echo "$1" | /usr/bin/iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null \
    | tr -c 'A-Za-z0-9._-' '_' | sed -E 's/_+/_/g; s/^_+|_+$//g'
}

send_mail() {
  local subject="$1" mdfile="$2" bodyfile="$3"
  if [ -z "$TF_RECIPIENT" ] || [ -z "$TF_SENDER" ]; then
    echo "Mail übersprungen: TF_RECIPIENT/TF_SENDER nicht gesetzt"
    return 0
  fi
  /usr/bin/osascript <<APPLESCRIPT
set theBody to (do shell script "cat " & quoted form of "$bodyfile")
set theAttachment to (POSIX file "$mdfile")
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"$subject", content:theBody, visible:false}
  tell newMessage
    set sender to "$TF_SENDER"
    make new to recipient at end of to recipients with properties {address:"$TF_RECIPIENT"}
    tell content
      make new attachment with properties {file name:theAttachment} at after last paragraph
    end tell
    send
  end tell
end tell
APPLESCRIPT
}

process_one() {
  local input="$1"
  local mode label parent base mdname mdpath symlink runlog
  parent="$(dirname "$input")"
  base="$(basename "$input")"

  if [ -d "$input" ] && ls "$input/Audio Record/"*.m4a >/dev/null 2>&1; then
    mode="multi"; label="$base"; parent="$input"
  elif [ -d "$input" ]; then
    echo "Ordner ohne Audio Record/*.m4a — überspringe: $input"
    notify "TranscribeForge" "Ordner ohne Audio Record übersprungen"
    return 0
  else
    case "$input" in
      *.mp4|*.mov|*.m4a|*.mp3|*.wav|*.mkv|*.webm) mode="single" ;;
      *) echo "Unbekannter Dateityp — überspringe: $input"; return 0 ;;
    esac
    label="${base%.*}"
  fi

  mdname="${label}.transcript.md"
  mdpath="$parent/$mdname"
  symlink="$TF_CENTRAL/$(slugify "$label").md"
  runlog="$(mktemp -t tf-quickaction)"

  notify "TranscribeForge" "Starte ($mode): $label"
  echo "Mode=$mode Label=$label MD=$mdpath"

  if [ "$mode" = "multi" ]; then
    "$NODE_BIN" "$TF_SKILL_DIR/scripts/transcribe-multi.js" \
      --dir "$input/Audio Record" \
      --lang "$TF_LANG" \
      --summary-model "$TF_SUMMARY_MODEL" \
      --output "$mdpath" > "$runlog" 2>&1
  else
    "$NODE_BIN" "$TF_SKILL_DIR/scripts/transcribe.js" \
      --video "$input" \
      --lang "$TF_LANG" > "$runlog" 2>&1
    {
      echo "# Transkript: $label"
      echo
      echo "_Generiert: $(date '+%Y-%m-%d %H:%M')_"
      echo
      cat "$runlog"
    } > "$mdpath"
  fi

  local rc=$?
  if [ $rc -ne 0 ]; then
    notify "TranscribeForge ❌" "Fehler bei $label — siehe Log"
    echo "Fehler rc=$rc"
    return $rc
  fi

  ln -sf "$mdpath" "$symlink"
  echo "MD: $mdpath"
  echo "Symlink: $symlink"

  local bodyfile
  bodyfile="$(mktemp -t tf-body)"
  {
    echo "Hallo,"
    echo
    echo "anbei das Transkript/Briefing zu: $label"
    echo "Quelle: $input"
    echo "Erzeugt am: $(date '+%d.%m.%Y %H:%M')"
    echo
    /usr/bin/awk '/^## (Executive Summary|Zusammenfassung|Action Items|ZUSAMMENFASSUNG)/{p=1} p{print}' "$mdpath" \
      | head -200
    echo
    echo "Vollständige MD im Anhang."
  } > "$bodyfile"

  send_mail "TranscribeForge: $label" "$mdpath" "$bodyfile"
  notify "TranscribeForge ✓" "$label — MD + Mail fertig"
  rm -f "$runlog" "$bodyfile"
}

if [ "${#INPUTS[@]}" -eq 0 ]; then
  notify "TranscribeForge" "Keine Auswahl übergeben"
  exit 0
fi

for f in "${INPUTS[@]}"; do
  process_one "$f"
done

echo "===== $(date '+%Y-%m-%d %H:%M:%S') Quick Action done ====="
