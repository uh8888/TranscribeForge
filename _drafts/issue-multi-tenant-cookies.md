# Multi-Tenant: YouTube-Download via User-Cookies (Option E)

## Problem

Aktuell scheitert der server-seitige YouTube-Download regelmäßig an YT-Bot-Detection auf Datacenter-IPs (Hostinger-VPS). Der lokal-downloaden-und-uploaden-Umweg funktioniert nur für Uwe als Single-User. Für andere Nutzer der TranscribeForge-App muss eine skalierbare Lösung her.

## Lösungs-Skizze

Nutzer bringt seine eigenen YouTube-Auth-Cookies als Upload mit — VPS ruft `yt-dlp --cookies <user-file>` und ist damit als eingeloggter Nutzer authentifiziert (keine Bot-Detection).

**User-Flow:**
1. Nutzer installiert Browser-Extension „Get cookies.txt LOCALLY" (open-source, Chrome + Firefox)
2. Nutzer öffnet youtube.com im eingeloggten Browser, klickt Extension → cookies.txt Download
3. Im TranscribeForge-Web-UI: neues Feld „YouTube-Cookies (optional)" mit Datei-Upload
4. Beim Klick auf „Analysieren" wird die Cookies-Datei zusammen mit der URL an `POST /api/transcribe-url` gesendet
5. Server ruft yt-dlp mit user-cookies (nur für diesen Job), löscht die Datei nach dem Download

## Sicherheit

- Cookies enthalten Session-Tokens → **sofort nach Download-Abschluss löschen** (in `finally`-Block)
- Cookies **niemals persistieren** oder in Logs schreiben
- Kein cross-user-leak: temporäre Datei mit random name pro Job (`/tmp/cookies-<jobId>.txt`)
- Client-Hinweis prominent im UI: „Deine Cookies werden nach dem Download gelöscht"

## Aufwand

- Web-UI: File-Input + upload-hint (~30 Min)
- Server-Endpoint erweitern: Multer für zweiten File-Slot, cookies-Datei durchreichen (~45 Min)
- yt-dlp-Aufruf: `--cookies <path>` zusätzlich zum bestehenden PoT-Provider (~15 Min)
- Test mit mehreren Test-Accounts (~30 Min)
- Doku/README + Anleitung Extension-Installation (~30 Min)

**Gesamt: ~2,5 h** Umsetzung

## Alternativen (verworfen)

- Tailscale/WireGuard/SSH-Tunnel — Onboarding-Hürde zu groß für Endkunden
- Residential Proxy-Provider (BrightData/Smartproxy) — Kosten pro GB, macht Kalkulation teuer
- Cloudflare Browser Rendering — Vendor-Lock, teurer bei Skalierung

## Priorität

**Später** — erst wenn zweiter Nutzer TranscribeForge produktiv nutzt. Für Uwe reicht aktuell der lokal-download-und-upload-Weg (siehe Issue #1 für seine parallele Mac-als-Proxy-Roadmap).

## Referenzen

- Skill-Doku: `/Users/uhi/.claude/skills/transcribeForge/SKILL.md`
- Server-Code: `server.js` Funktion `downloadWithYtDlp`, Route `/api/transcribe-url`
- Extension: https://github.com/kairi003/Get-cookies.txt-LOCALLY (MIT-Lizenz)

Aus Chat-Diskussion 2026-07-10 (26-07-10-064)
