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
: "${TF_SETTINGS_DIALOG:=$HOME/bin/transcribeforge-settings-dialog.applescript}"
# .app-Bundles (bevorzugt, weil osascript auf Catalina keine Activation-Policy hat → kein Fokus).
# Wenn die .app existiert, wird sie statt des nackten osascript-Aufrufs benutzt.
: "${TF_PROGRESS_APP:=$HOME/Applications/TranscribeForge-Progress.app}"
: "${TF_SETTINGS_APP:=$HOME/Applications/TranscribeForge-Settings.app}"
: "${TF_NODE_BIN:=}"

CONFIG="$HOME/.config/transcribeforge-quickaction.env"
[ -f "$CONFIG" ] && . "$CONFIG"

# PATH um typische Node-/ffmpeg-Locations erweitern (Quick Action startet mit kargem PATH)
export PATH="$HOME/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v23.1.0/bin:$HOME/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

INPUTS=("$@")

# Node finden — Reihenfolge: TF_NODE_BIN, command -v, nvm-latest, übliche Pfade
find_node() {
  if [ -n "$TF_NODE_BIN" ] && [ -x "$TF_NODE_BIN" ]; then
    echo "$TF_NODE_BIN"; return
  fi
  local n
  n="$(command -v node 2>/dev/null || true)"
  if [ -n "$n" ] && [ -x "$n" ]; then echo "$n"; return; fi
  for n in \
    "$HOME/.nvm/versions/node/v23.1.0/bin/node" \
    "$HOME/.nvm/versions/node/v20.20.2/bin/node" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node; do
    [ -x "$n" ] && echo "$n" && return
  done
  # letzter Versuch: neueste nvm-Version
  n="$(ls -d "$HOME/.nvm/versions/node/"v*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -x "$n" ] && echo "$n" && return
  echo ""
}
NODE_BIN="$(find_node)"

mkdir -p "$TF_CENTRAL" "$(dirname "$TF_LOG")"
exec >>"$TF_LOG" 2>&1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') Quick Action start ====="
echo "Inputs: ${INPUTS[*]}"

STATUS_FILE="$(mktemp -t tf-status)"
PROGRESS_PID=""
PROGRESS_APP_LAUNCHED=0  # 1 wenn .app-Bundle statt nacktem osascript läuft

# Globals für die aktuell aktive Verarbeitung — nötig, damit der INT/TERM-Trap
# (ausgelöst vom Stop-Button via osascript → kill -TERM $$) ein Error-Log
# neben das Video schreiben kann, auch wenn process_one mittendrin abbricht.
CURRENT_LABEL=""
CURRENT_PARENT=""
CURRENT_INPUT=""
CURRENT_RUNLOG=""
CURRENT_FRAMES_CACHE=""
CURRENT_MODE=""

cleanup() {
  # Falls Progress-Window noch läuft: finalen Status sicherstellen, aber
  # Statusdatei NICHT löschen — das Fenster liest sie noch und braucht den
  # Trigger, um den Abschluss-Dialog anzuzeigen. /var/folders wird vom OS
  # aufgeräumt.
  if [ -n "$PROGRESS_PID" ] && kill -0 "$PROGRESS_PID" 2>/dev/null; then
    if ! grep -qE "^status=(done|error)" "$STATUS_FILE" 2>/dev/null; then
      write_status "error" "" "Abbruch" ""
    fi
    return
  fi
  # Bei .app-Modus haben wir keinen lokalen PID — wir wissen aber, dass das
  # Fenster die Datei noch braucht. Statusdatei stehen lassen (OS räumt /var/folders auf).
  if [ "$PROGRESS_APP_LAUNCHED" = "1" ]; then
    if ! grep -qE "^status=(done|error)" "$STATUS_FILE" 2>/dev/null; then
      write_status "error" "" "Abbruch" ""
    fi
    return
  fi
  rm -f "$STATUS_FILE"
}

# Signal-Handler für Stop-Button (TERM) und Ctrl-C (INT).
# Killt alle Kindprozesse (node/ffmpeg/whisper-Uploads) und schreibt ein
# Error-Log neben das Video, sodass der User auch nach AFK weiß was passiert ist.
on_signal() {
  local sig="$1"
  echo "===== Signal $sig empfangen — beende Kindprozesse ====="
  # Alle direkten Kinder dieser Shell killen (node, ffmpeg, ...).
  # pkill -P $$ schickt erstmal TERM; nach kurzer Karenz KILL für Hartnäckige.
  pkill -TERM -P $$ 2>/dev/null || true
  sleep 1
  pkill -KILL -P $$ 2>/dev/null || true

  if [ -n "$CURRENT_LABEL" ] && [ -n "$CURRENT_PARENT" ]; then
    local errlog="$CURRENT_PARENT/${CURRENT_LABEL}.transcribeforge-error.log"
    {
      echo "===== TranscribeForge: Manueller Abbruch ====="
      echo "Zeitpunkt: $(date '+%Y-%m-%d %H:%M:%S')"
      echo "Quelle:    $CURRENT_INPUT"
      echo "Modus:     $CURRENT_MODE | Sprache: $TF_LANG | Summary-Modell: $TF_SUMMARY_MODEL"
      echo "Grund:     Stop-Button ('Prozess stoppen') oder Signal $sig"
      if [ -n "$CURRENT_FRAMES_CACHE" ] && [ -s "$CURRENT_FRAMES_CACHE" ]; then
        echo "Frame-Cache erhalten: $CURRENT_FRAMES_CACHE ($(wc -c < "$CURRENT_FRAMES_CACHE") Bytes)"
        echo "→ Re-Run nutzt diesen Cache automatisch (keine erneute Frame-Analyse)."
      fi
      if [ -n "$CURRENT_RUNLOG" ] && [ -s "$CURRENT_RUNLOG" ]; then
        echo "----- Bisheriger Skript-Output -----"
        cat "$CURRENT_RUNLOG" 2>&1
      fi
    } > "$errlog"
    write_status "error" "$CURRENT_LABEL" "Abgebrochen" "Log: $errlog" "" "" "$CURRENT_PARENT" "$errlog"
    notify "TranscribeForge ⏹" "$CURRENT_LABEL — abgebrochen, Log: $(basename "$errlog")"
  fi
  cleanup
  exit 143
}

trap cleanup EXIT
trap 'on_signal INT'  INT
trap 'on_signal TERM' TERM

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
    # wrapper_pid für den Stop-Button im Progress-Window.
    echo "wrapper_pid=$$"
  } > "$STATUS_FILE"
}

start_progress_window() {
  local label="$1"
  write_status "running" "$label" "Initialisierung…" "" "" ""
  if [ -d "$TF_PROGRESS_APP" ]; then
    # .app-Bundle hat Activation-Policy „regular" → Buttons sind klickbar,
    # Fenster bekommt Fokus (auf Catalina sonst nicht möglich).
    # `open -na` startet eine neue Instanz und blockiert NICHT.
    /usr/bin/open -na "$TF_PROGRESS_APP" --args "$STATUS_FILE" >/dev/null 2>&1 || true
    PROGRESS_PID=""
    PROGRESS_APP_LAUNCHED=1
  else
    /usr/bin/osascript "$TF_PROGRESS_SCRIPT" "$STATUS_FILE" >/dev/null 2>&1 &
    PROGRESS_PID=$!
    disown 2>/dev/null || true
  fi
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

  # Auto-Multi-Detection: Wenn input eine Datei ist und im Parent-Ordner ein
  # 'Audio Record/' mit ≥2 .m4a-Spuren existiert (Zoom-Multi-Track-Recording),
  # automatisch in den Multi-Modus wechseln. Genauere Transkription (separate
  # Sprecher-Spuren, deterministische Speaker-Labels, keine
  # Mixdown-Halluzinationen bei Sprecher-Überlappung).
  if [ -f "$input" ]; then
    local _pdir="$(dirname "$input")"
    if [ -d "$_pdir/Audio Record" ]; then
      local _m4a_count
      _m4a_count="$(find "$_pdir/Audio Record" -maxdepth 1 -type f -iname "*.m4a" 2>/dev/null | wc -l | tr -d ' ')"
      if [ "${_m4a_count:-0}" -ge 2 ]; then
        echo "Auto-Multi: $_m4a_count Sprecher-Spuren in '$_pdir/Audio Record/' gefunden → wechsle in Multi-Modus."
        notify "TranscribeForge" "Multi-Modus: $_m4a_count Sprecher-Spuren erkannt"
        input="$_pdir"
        base="$(basename "$input")"
        parent="$(dirname "$input")"
      fi
    fi
  fi

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

  # Globals für Stop-Handler setzen (siehe on_signal).
  CURRENT_LABEL="$label"
  CURRENT_PARENT="$parent"
  CURRENT_INPUT="$input"
  CURRENT_RUNLOG="$runlog"
  CURRENT_MODE="$mode"

  # --- Settings-Dialog für Single-Video-Modus ---
  # Defaults (Sparmodus) — gelten auch wenn ffprobe fehlt oder Dialog übersprungen wird.
  local tf_interval=6
  local tf_frame_width=768
  local tf_no_frames=0
  if [ "$mode" = "single" ] && { [ -d "$TF_SETTINGS_APP" ] || [ -f "$TF_SETTINGS_DIALOG" ]; }; then
    if command -v ffprobe >/dev/null 2>&1; then
      local dur_sec dur_min settings_out settings_rc ffprobe_bin
      ffprobe_bin="$(command -v ffprobe)"
      echo "ffprobe gefunden: $ffprobe_bin"
      # stderr in Variable speichern, damit wir sehen, woran ffprobe scheitert,
      # wenn es im Quick-Action-Kontext (sandboxed Finder-Launch) nicht klappt.
      dur_sec="$("$ffprobe_bin" -i "$input" -show_entries format=duration -of csv=p=0 2>/tmp/tf-ffprobe-err.log | tr -d '[:space:]')"
      echo "ffprobe-Output: dur_sec='$dur_sec'  stderr-Tail: $(tail -1 /tmp/tf-ffprobe-err.log 2>/dev/null)"
      if [ -n "$dur_sec" ]; then
        # Sekunden → Minuten mit einer Nachkommastelle (awk, weil bash kein float kann)
        dur_min="$(awk -v s="$dur_sec" 'BEGIN{ printf "%.1f", s/60 }')"
      else
        dur_min="0"
      fi
      echo "Dialog-Input: dur_min=$dur_min label=$label"
      if [ -d "$TF_SETTINGS_APP" ]; then
        # .app-Bundle: open -W blockiert bis App quittet, aber kein stdout durchgereicht.
        # → Ergebnis landet in result-file (3. Argument).
        local settings_result_file
        settings_result_file="$(mktemp -t tf-settings-result)"
        : > "$settings_result_file"
        /usr/bin/open -W -na "$TF_SETTINGS_APP" --args "$dur_min" "$label" "$settings_result_file" >/dev/null 2>&1
        settings_rc=$?
        settings_out="$(cat "$settings_result_file" 2>/dev/null | tr -d '\r\n')"
        rm -f "$settings_result_file"
        # User-Abbruch: leeres File ODER Exit-Code != 0
        if [ -z "$settings_out" ]; then
          echo "Settings-Dialog abgebrochen (leeres Result) — überspringe."
          notify "TranscribeForge" "Abgebrochen: $label"
          CURRENT_LABEL=""; CURRENT_PARENT=""; CURRENT_INPUT=""; CURRENT_RUNLOG=""; CURRENT_MODE=""
          return 0
        fi
      else
        settings_out="$(/usr/bin/osascript "$TF_SETTINGS_DIALOG" "$dur_min" "$label" 2>/dev/null)"
        settings_rc=$?
        if [ $settings_rc -ne 0 ]; then
          echo "Settings-Dialog abgebrochen (rc=$settings_rc) — User-Abbruch, überspringe."
          notify "TranscribeForge" "Abgebrochen: $label"
          CURRENT_LABEL=""; CURRENT_PARENT=""; CURRENT_INPUT=""; CURRENT_RUNLOG=""; CURRENT_MODE=""
          return 0
        fi
      fi
      # Output parsen: preset=...|interval=N|frame_width=N|no_frames=0|1
      local kv val
      for kv in ${settings_out//|/ }; do
        case "$kv" in
          interval=*)    tf_interval="${kv#interval=}" ;;
          frame_width=*) tf_frame_width="${kv#frame_width=}" ;;
          no_frames=*)   tf_no_frames="${kv#no_frames=}" ;;
        esac
      done
      echo "Settings: interval=$tf_interval frame_width=$tf_frame_width no_frames=$tf_no_frames"
    else
      echo "ffprobe nicht gefunden — verwende Default-Sparmodus (6/768/Frames an)"
    fi
  fi

  start_progress_window "$label"
  echo "Mode=$mode Label=$label MD=$mdpath NODE_BIN=$NODE_BIN"

  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    write_status "error" "$label" "Node nicht gefunden" "TF_NODE_BIN in Config setzen" "" "" "$parent" ""
    notify "TranscribeForge ❌" "Node-Binary nicht gefunden"
    echo "Fehler: NODE_BIN leer oder nicht ausführbar"
    return 1
  fi

  local rc=0
  local stats_short=""
  local metrics_file frames_cache
  metrics_file="$(mktemp -t tf-metrics)"
  # Frame-Cache neben dem Video, damit eine teure Frame-Analyse einen Whisper-
  # /Summary-Fehler überlebt und der nächste Re-Run sie wiederverwendet.
  frames_cache="$parent/.${label}.transcribeforge-frames.cache"
  CURRENT_FRAMES_CACHE="$frames_cache"

  if [ "$mode" = "multi" ]; then
    write_status "running" "$label" "Multi-Speaker Whisper-Transkription" "Sprache: $TF_LANG" "10" "100" "$parent"
    TF_STATUS_FILE="$STATUS_FILE" TF_STATUS_LABEL="$label" TF_STATUS_FOLDER="$parent" \
    TF_METRICS_FILE="$metrics_file" \
    "$NODE_BIN" "$TF_SKILL_DIR/scripts/transcribe-multi.js" \
      --dir "$input/Audio Record" \
      --lang "$TF_LANG" \
      --summary-model "$TF_SUMMARY_MODEL" \
      --output "$mdpath" > "$runlog" 2>&1
    rc=$?
  else
    write_status "running" "$label" "Whisper + Frame-Analyse + Summary" "Sprache: $TF_LANG" "5" "100" "$parent"
    # Optionales --no-frames Flag aus Settings-Dialog
    local no_frames_flag=""
    if [ "$tf_no_frames" = "1" ]; then
      no_frames_flag="--no-frames"
    fi
    TF_STATUS_FILE="$STATUS_FILE" TF_STATUS_LABEL="$label" TF_STATUS_FOLDER="$parent" \
    TF_METRICS_FILE="$metrics_file" TF_FRAMES_CACHE="$frames_cache" \
    "$NODE_BIN" "$TF_SKILL_DIR/scripts/transcribe.js" \
      --video "$input" \
      --lang "$TF_LANG" \
      --interval "$tf_interval" \
      --frame-width "$tf_frame_width" \
      $no_frames_flag \
      --summary \
      --summary-model "$TF_SUMMARY_MODEL" > "$runlog"
    rc=$?
    if [ $rc -eq 0 ]; then
      # Kosten-Zeile aus Metrics-JSON bauen (falls vorhanden)
      local cost_line=""
      stats_short=""
      if [ -s "$metrics_file" ] && command -v python3 >/dev/null 2>&1; then
        cost_line="$(python3 -c "
import json,sys
try:
    d=json.load(open('$metrics_file'))
    print(f\"_Modell-Kosten: ~\${d['total_usd']:.4f} (Whisper \${d['whisper_usd']:.4f} · Frames \${d['frames_usd']:.4f} · Summary \${d['compact_usd']+d['summary_usd']:.4f})_  •  Audio: {d['audio_minutes']:.1f} min  •  Frame-Modell: \`{d['frame_model']}\`  •  Summary-Modell: \`{d['summary_model']}\`\")
except Exception as e:
    pass
" 2>/dev/null)"
        # Kurzform für das Floating-Window — wird unten in den done-Detail eingebettet.
        stats_short="$(python3 -c "
import json
try:
    d=json.load(open('$metrics_file'))
    print(f\"Kosten ~\${d['total_usd']:.2f} · Whisper \${d['whisper_usd']:.2f} · Frames \${d['frames_usd']:.2f} · Summary \${d['compact_usd']+d['summary_usd']:.2f} · Audio {d['audio_minutes']:.1f} min\")
except Exception:
    pass
" 2>/dev/null)"
      fi
      {
        echo "# Briefing: $label"
        echo
        echo "_Generiert: $(date '+%Y-%m-%d %H:%M')_  •  Quelle: \`$(basename "$input")\`"
        [ -n "$cost_line" ] && echo "$cost_line"
        echo
        cat "$runlog"
      } > "$mdpath"
    fi
  fi
  rm -f "$metrics_file"

  if [ $rc -ne 0 ]; then
    # Fehler-Log dauerhaft neben das Video legen, damit der User es auch findet,
    # wenn das Dialogfeld geschlossen oder durch Sleep verloren ist.
    local errlog="$parent/${label}.transcribeforge-error.log"
    {
      echo "===== TranscribeForge Fehler ====="
      echo "Zeitpunkt: $(date '+%Y-%m-%d %H:%M:%S')"
      echo "Quelle:    $input"
      echo "Modus:     $mode | Sprache: $TF_LANG | Summary-Modell: $TF_SUMMARY_MODEL"
      echo "Exit-Code: $rc"
      if [ -s "$frames_cache" ]; then
        echo "Frame-Cache erhalten: $frames_cache ($(wc -c < "$frames_cache") Bytes)"
        echo "→ Re-Run nutzt diesen Cache automatisch (keine erneute Frame-Analyse)."
      fi
      echo "----- Skript-Output -----"
      cat "$runlog" 2>&1
    } > "$errlog"
    write_status "error" "$label" "Transkription fehlgeschlagen" "Log: $errlog" "" "" "$parent" "$errlog"
    notify "TranscribeForge ❌" "$label — Log: $(basename "$errlog")"
    echo "Fehler rc=$rc — Error-Log: $errlog"
    return $rc
  fi
  # Erfolg: Frame-Cache löschen (nicht mehr nötig)
  rm -f "$frames_cache"

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

  # Endzustand: Kostensumme (oben bereits in $stats_short gecached) ins Detail
  # einbetten, damit das Floating-Window dem User die finale Statistik dauerhaft
  # anzeigt. Statusdatei-Format kann mehrzeiliges detail nicht — daher mit " · ".
  local done_detail="MD: $mdname • Mail an $TF_RECIPIENT"
  if [ -n "$stats_short" ]; then
    done_detail="$stats_short • MD: $mdname • Mail an $TF_RECIPIENT"
  fi
  write_status "done" "$label" "Fertig" "$done_detail" "4" "4" "$parent" "$mdpath"
  notify "TranscribeForge ✓" "$label — MD + Mail fertig"
  rm -f "$runlog" "$bodyfile"

  # Globals zurücksetzen, damit ein späteres Signal nicht fälschlich diesen
  # bereits fertigen Job als „abgebrochen" loggt.
  CURRENT_LABEL=""
  CURRENT_PARENT=""
  CURRENT_INPUT=""
  CURRENT_RUNLOG=""
  CURRENT_FRAMES_CACHE=""
  CURRENT_MODE=""
}

if [ "${#INPUTS[@]}" -eq 0 ]; then
  notify "TranscribeForge" "Keine Auswahl übergeben"
  exit 0
fi

for f in "${INPUTS[@]}"; do
  process_one "$f"
done

echo "===== $(date '+%Y-%m-%d %H:%M:%S') Quick Action done ====="
