#!/usr/bin/osascript -l JavaScript
// TranscribeForge — Floating Progress Window (JXA + AppKit).
// Aufruf: osascript -l JavaScript progress-window.js <statusfile>
// Liest <statusfile> alle 0.4s, aktualisiert Phase/Detail/Progress.
// Statusfile-Format (key=value, Zeilen):
//   status=running|done|error
//   label=<Datei-/Ordner-Label>
//   phase=<aktuelle Phase>
//   detail=<optionale Detailzeile>
//   step=<int>
//   total=<int>
// Bei status=done: Sound "Glass" + Fenster schließt sich automatisch.
// Bei status=error: Sound "Funk", Fenster bleibt 6s, dann schließt sich.

ObjC.import('AppKit');
ObjC.import('Foundation');

const args = $.NSProcessInfo.processInfo.arguments;
const argv = ObjC.deepUnwrap(args);
const statusFile = argv[argv.length - 1];

function readStatus() {
  const fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(statusFile)) return null;
  const raw = $.NSString.stringWithContentsOfFileEncodingError(statusFile, $.NSUTF8StringEncoding, null);
  if (!raw || raw.isNil()) return null;
  const text = ObjC.unwrap(raw);
  const result = {};
  text.split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) result[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
  });
  return result;
}

const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyRegular);

const winRect = $.NSMakeRect(0, 0, 540, 180);
const style = ($.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable);
const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  winRect, style, $.NSBackingStoreBuffered, false
);
win.title = "TranscribeForge";
win.level = $.NSFloatingWindowLevel;
win.center;

function makeLabel(rect, size, value, secondary) {
  const l = $.NSTextField.alloc.initWithFrame(rect);
  l.bezeled = false;
  l.drawsBackground = false;
  l.editable = false;
  l.selectable = false;
  l.font = $.NSFont.systemFontOfSize(size);
  if (secondary) l.textColor = $.NSColor.secondaryLabelColor;
  l.stringValue = value;
  l.lineBreakMode = $.NSLineBreakByTruncatingMiddle;
  return l;
}

const labelTitle = makeLabel($.NSMakeRect(20, 130, 500, 26), 15, "Starte TranscribeForge…", false);
const labelFile  = makeLabel($.NSMakeRect(20, 100, 500, 22), 12, "", true);
const labelDetail= makeLabel($.NSMakeRect(20, 75,  500, 20), 11, "", true);

const progress = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(20, 35, 500, 20));
progress.style = 0; // NSProgressIndicatorStyleBar
progress.indeterminate = true;
progress.startAnimation(null);

const content = win.contentView;
content.addSubview(labelTitle);
content.addSubview(labelFile);
content.addSubview(labelDetail);
content.addSubview(progress);

win.makeKeyAndOrderFront(null);
app.activateIgnoringOtherApps(true);

let lastSig = "";
let exitAt = null;

function tick() {
  const s = readStatus();
  if (!s) return;
  const sig = JSON.stringify(s);
  if (sig !== lastSig) {
    lastSig = sig;
    labelFile.stringValue = s.label || "";
    labelTitle.stringValue = s.phase || "Läuft…";
    labelDetail.stringValue = s.detail || "";

    if (s.step && s.total) {
      progress.indeterminate = false;
      progress.maxValue = parseFloat(s.total);
      progress.doubleValue = parseFloat(s.step);
    } else {
      progress.indeterminate = true;
      progress.startAnimation(null);
    }

    if (s.status === "done") {
      labelTitle.stringValue = "✓ Fertig: " + (s.label || "");
      labelDetail.stringValue = s.detail || "MD gespeichert, Mail versendet";
      progress.indeterminate = false;
      progress.maxValue = 1; progress.doubleValue = 1;
      const snd = $.NSSound.soundNamed("Glass");
      if (snd) snd.play;
      exitAt = Date.now() + 2200;
    } else if (s.status === "error") {
      labelTitle.stringValue = "❌ Fehler: " + (s.label || "");
      progress.indeterminate = false;
      const snd = $.NSSound.soundNamed("Funk");
      if (snd) snd.play;
      exitAt = Date.now() + 6000;
    }
  }
}

const rl = $.NSRunLoop.mainRunLoop;
while (true) {
  tick();
  rl.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.4));
  if (exitAt !== null && Date.now() >= exitAt) break;
  if (!win.isVisible) break; // User hat Fenster geschlossen
}
app.terminate(null);
