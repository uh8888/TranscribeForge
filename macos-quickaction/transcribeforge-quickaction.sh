#!/bin/bash
# TranscribeForge Quick Action: Finder-Rechtsklick → Video/Ordner an TranscribeForge,
# MD-Ablage (neben Quelldatei + Symlink in zentralem Ordner),
# Mail mit Action-Items-Body + MD-Anhang.
#
# Live-Status: Floating Progress-Window via progress-window.js (JXA/AppKit).
#
# Konfiguration: ~/.config/transcribeforge-quickaction.env (siehe install.sh).

set -u

# ---------- Defaults ----------
: "${TF_RECIPIENT:=}"
: "${TF_SENDER:=}"
: "${TF_LANG:=de}"
: "${TF_CENTRAL:=$HOME/Documents/TranscribeForge}"
: "${TF_SUMMARY_MODEL:=claude-sonnet-4-6}"
: "${TF_SKILL_DIR:=$HOME/.claude/skills/transcribeForge}"
: "${TF_LOG:=$HOME/Library/Logs/transcribeforge-quickaction.log}"
: "${TF_PROGRESS_SCRIPT:=$HOME/bin/transcribeforge-progress-window.applescript}"

CONFIG="$HOME/.config/transcribeforge-quickaction.env"
[ -f "$CONFIG" ] && . "$CONFIG"

INPUTS=("$@")
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

mkdir -p "$TF_CENTRAL" "$(dirname "$TF_LOG")"
exec >>"$TF_LOG" 2>&1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') Quick Action start ====="
echo "Inputs: ${INPUTS[*]}"

STATUS_FILE="$(mktemp -t tf-status)"
PROGRESS_PID=""

cleanup() {
  # Falls Fenster noch läuft und kein finaler Status: error
  if [ -n "$PROGRESS_PID" ] && kill -0 "$PROGRESS_PID" 2>/dev/null; then
    grep -q "^status=" "$STATUS_FILE" 2>/dev/null || true
    if ! grep -qE "^status=(done|error)" "$STATUS_FILE"; then
      write_status "error" "" "Abbruch" ""
      sleep 0.5
    fi
  fi
  rm -f "$STATUS_FILE"
}
trap cleanup EXIT INT TERM

write_status() {
  # write_status <status> <label> <phase> [detail] [step] [total] [folder] [mdfile]
  {
    echo "status=$1"
    echo "label=$2"
    echo "phase=$3"
    echo "detail=${4:-}"
    [ -n "${5:-}" ] && echo "step=$5"
    [ -n "${6:-}" ] && echo "total=$6"
    [ -n "${7:-}" ] && echo "folder=$7"
    [ -n "${8:-}" ] && echo "mdfile=$8"
  } > "$STATUS_FILE"
}

start_progress_window() {
  local label="$1"
  write_status "running" "$label" "Initialisierung…" "" "" ""
  /usr/bin/osascript "$TF_PROGRESS_SCRIPT" "$STATUS_FILE" >/dev/null 2>&1 &
  PROGRESS_PID=$!
  disown 2>/dev/null || true
}

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
  # Pfade/Strings per Env durchreichen — robust gegen Umlaute, Leerzeichen, Quotes.
  # visible:true + delay 3 vor send ist der bekannte Workaround für den Mail.app-Bug,
  # bei dem im Hintergrund versandte Mails den Anhang verlieren.
  TF_SUBJECT="$subject" \
  TF_BODYFILE="$bodyfile" \
  TF_MDFILE="$mdfile" \
  TF_OSA_RECIPIENT="$TF_RECIPIENT" \
  TF_OSA_SENDER="$TF_SENDER" \
  /usr/bin/osascript <<'APPLESCRIPT'
set theSubject to (system attribute "TF_SUBJECT")
set theSender to (system attribute "TF_OSA_SENDER")
set theRecipient to (system attribute "TF_OSA_RECIPIENT")
set bodyFile to (system attribute "TF_BODYFILE")
set mdFile to (system attribute "TF_MDFILE")
set theBody to (do shell script "cat " & quoted form of bodyFile)
set theAttachment to (POSIX file mdFile)
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:theSubject, content:theBody, visible:true}
  tell newMessage
    set sender to theSender
    make new to recipient at end of to recipients with properties {address:theRecipient}
    tell content
      make new attachment with properties {file name:theAttachment} at after last paragraph
    end tell
    delay 3
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

  start_progress_window "$label"
  echo "Mode=$mode Label=$label MD=$mdpath"

  if [ "$mode" = "multi" ]; then
    write_status "running" "$label" "Multi-Speaker Whisper-Transkription" "Sprache: $TF_LANG" "2" "4"
    "$NODE_BIN" "$TF_SKILL_DIR/scripts/transcribe-multi.js" \
      --dir "$input/Audio Record" \
      --lang "$TF_LANG" \
      --summary-model "$TF_SUMMARY_MODEL" \
      --output "$mdpath" > "$runlog" 2>&1
  else
    write_status "running" "$label" "Whisper transkribiert" "Sprache: $TF_LANG" "2" "4"
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
    write_status "error" "$label" "Transkription fehlgeschlagen" "Siehe $TF_LOG" "" "" "$parent" ""
    notify "TranscribeForge ❌" "Fehler bei $label"
    echo "Fehler rc=$rc"
    return $rc
  fi

  write_status "running" "$label" "MD-Datei + Symlink schreiben" "$mdname" "3" "4" "$parent" "$mdpath"
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

  write_status "running" "$label" "Mail via Mail.app senden" "→ $TF_RECIPIENT" "4" "4" "$parent" "$mdpath"
  send_mail "TranscribeForge: $label" "$mdpath" "$bodyfile"
  write_status "done" "$label" "Fertig" "MD: $mdname • Mail an $TF_RECIPIENT" "4" "4" "$parent" "$mdpath"
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
