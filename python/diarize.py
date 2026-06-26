#!/usr/bin/env python3
"""
diarize.py — pyannote-audio Sprecher-Diarisation für TranscribeForge.

Wird vom Node-CLI / Server als Subprozess aufgerufen, sobald `--diarize`
aktiv ist. Liest eine Audiodatei (wav/m4a/mp3) ein und schreibt JSON mit
Sprecher-Turns auf stdout (oder in `--out <pfad>`).

Aufruf:
    python3 diarize.py --audio /tmp/x.wav [--out /tmp/x.json] \
        [--min-speakers 2] [--max-speakers 4] [--device cpu]

Output-Format (JSON):
    {
      "turns": [
        {"start": 0.12, "end": 4.30, "speaker": "SPEAKER_00"},
        ...
      ],
      "num_speakers": 2,
      "model": "pyannote/speaker-diarization-3.1"
    }

Voraussetzungen:
- pyannote.audio >= 3.1
- torch (CPU genügt; GPU optional via --device cuda)
- HF_TOKEN in der Umgebung (HuggingFace Access Token; EULA von
  pyannote/speaker-diarization-3.1 und pyannote/segmentation-3.0 muss
  vorab im HF-Web-UI akzeptiert sein).

Fehlerverhalten: bei jedem Setup-/Laufzeitfehler wird ein klares JSON
mit {"error": "...", "hint": "..."} auf stdout geschrieben und mit
Exitcode 1 beendet, damit der Node-Caller einen sauberen Fallback
auslösen kann.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback


MODEL_ID = "pyannote/speaker-diarization-3.1"


def _emit(payload: dict, out_path: str | None) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
        sys.stdout.write("\n")


def _fail(msg: str, hint: str, out_path: str | None) -> int:
    _emit({"error": msg, "hint": hint}, out_path)
    return 1


def main() -> int:
    p = argparse.ArgumentParser(description="pyannote diarisation for TranscribeForge")
    p.add_argument("--audio", required=True, help="Pfad zur Audio-Datei (wav/m4a/mp3)")
    p.add_argument("--out", default=None, help="Pfad für JSON-Output (Default: stdout)")
    p.add_argument("--min-speakers", type=int, default=None)
    p.add_argument("--max-speakers", type=int, default=None)
    p.add_argument("--device", default=None, help="cpu (Default) oder cuda")
    args = p.parse_args()

    if not os.path.exists(args.audio):
        return _fail(
            f"Audiodatei nicht gefunden: {args.audio}",
            "Pfad prüfen, ggf. ffmpeg-Konvertierung vor Diarisation laufen lassen.",
            args.out,
        )

    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not hf_token:
        return _fail(
            "HF_TOKEN nicht gesetzt.",
            "1) HuggingFace-Token unter https://huggingface.co/settings/tokens anlegen, "
            "2) EULA von pyannote/speaker-diarization-3.1 + pyannote/segmentation-3.0 akzeptieren, "
            "3) HF_TOKEN=<token> in .env eintragen.",
            args.out,
        )

    try:
        from pyannote.audio import Pipeline  # type: ignore
    except Exception as exc:  # ImportError oder torch-Lade-Fehler
        return _fail(
            f"pyannote.audio nicht importierbar: {exc}",
            "Im python/-Ordner ein Venv anlegen und `pip install -r python/requirements.txt` "
            "ausführen. macOS Catalina: Python 3.10 via pyenv nötig (System-3.8 reicht nicht).",
            args.out,
        )

    try:
        pipeline = Pipeline.from_pretrained(MODEL_ID, use_auth_token=hf_token)
    except Exception as exc:
        return _fail(
            f"pyannote-Pipeline konnte nicht geladen werden: {exc}",
            "Token-Scope prüfen + EULA-Accept im HF-Web-UI bestätigen.",
            args.out,
        )

    try:
        import torch  # type: ignore

        if args.device:
            pipeline.to(torch.device(args.device))
    except Exception:
        # device-Wechsel ist optional; bei Fehler bleibt CPU-Default aktiv.
        pass

    kwargs: dict = {}
    if args.min_speakers is not None:
        kwargs["min_speakers"] = args.min_speakers
    if args.max_speakers is not None:
        kwargs["max_speakers"] = args.max_speakers

    try:
        diarization = pipeline(args.audio, **kwargs)
    except Exception as exc:
        return _fail(
            f"Diarisation-Lauf gescheitert: {exc}",
            "Audio-Format prüfen (16 kHz mono wav ist optimal). "
            "Bei OOM: --max-speakers setzen oder kürzeres Sample testen.",
            args.out,
        )

    turns: list[dict] = []
    speakers: set[str] = set()
    for segment, _track, speaker in diarization.itertracks(yield_label=True):
        turns.append(
            {
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "speaker": str(speaker),
            }
        )
        speakers.add(str(speaker))

    _emit(
        {
            "turns": turns,
            "num_speakers": len(speakers),
            "model": MODEL_ID,
        },
        args.out,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # letzter Auffang-Net, falls argparse o.ä. crasht
        sys.stdout.write(
            json.dumps(
                {"error": f"Unerwarteter Fehler: {exc}", "trace": traceback.format_exc()},
                ensure_ascii=False,
            )
            + "\n"
        )
        sys.exit(1)
