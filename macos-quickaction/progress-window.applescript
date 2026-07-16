-- TranscribeForge — Floating Progress Window (AppleScriptObjC).
-- Aufruf: osascript progress-window.applescript <statusfile>
-- Liest <statusfile> alle 0.4s, aktualisiert Phase/Detail/Schritt.
-- Statusfile-Format (key=value, Zeilen):
--   status=running|done|error
--   label=<Datei-/Ordner-Label>
--   phase=<aktuelle Phase>
--   detail=<optionale Detailzeile, " • " wird auf Zeilenumbruch gemappt>
--   step=<int>
--   total=<int>
--   folder=<absoluter Pfad zum Ergebnis-Ordner>   (für Öffnen-Aktion)
--   mdfile=<absoluter Pfad zur MD-Datei>          (optional, bevorzugt für Öffnen)
--   wrapper_pid=<PID des Bash-Wrappers — für Stop-Button>
--
-- Verhalten: Fenster bleibt offen, zeigt Live-Phasen.
-- Bei status=done/error werden die Action-Buttons im Fenster selbst eingeblendet
-- (kein modaler Dialog mehr) — das Fenster bleibt sichtbar bis der User klickt,
-- so dass auch nach AFK die Statistik lesbar bleibt.

use framework "Foundation"
use framework "AppKit"
use scripting additions

property NSApp : missing value
property cancelRequested : false
property pendingOpen : false
property userClosed : false
property statusFilePath : ""
property lastFolderPath : ""
property lastMdPath : ""
property mainWindow : missing value

-- UI-Elemente als Properties, damit der NSTimer-Tick-Handler darauf zugreifen kann.
property phaseField : missing value
property fileField : missing value
property detailField : missing value
property progBar : missing value
property stopBtn : missing value
property openBtn : missing value
property closeBtn : missing value

-- Tick-State
property lastSig : ""
property finished : false
property lastLabel : ""
property tickTimer : missing value

-- Hover-State (welcher Button hat gerade die Maus drüber)
property hoveredBtn : missing value
-- Focus-Highlight-State: welcher Button ist gerade per Tab fokussiert UND
-- soll deshalb blau dargestellt werden (nur wenn kein Hover-Konflikt).
property focusHighlightBtn : missing value

-- Indeterminate-Phase-State: einige Phasen (Whisper-API, Visual-Timeline,
-- Summary) liefern keinen sinnvollen Progress, weil OpenAI/Claude die
-- Antwort nicht streamen. Status-File markiert solche Phasen mit
-- phase_indeterminate=1 + phase_started_at=<unix-ts>. Der Progress-Bar
-- läuft dann animiert weiter, und im Phase-Label wird ein Live-Counter
-- " — läuft seit XX s" angehängt, damit der User sieht, dass es nicht hängt.
property currentBasePhase : ""
property currentIndeterm : false
property currentPhaseStartedAt : 0

on run argv
	-- argv ist bei .app-Applets, die via `open --args` gestartet werden,
	-- `missing value`. Args kommen nur über NSProcessInfo's arguments() rein.
	-- Item 1 = applet-Binary-Pfad, ab Item 2 folgen die echten User-Args.
	set statusFile to my readLaunchArg(argv, 1)
	my dlog("run start statusFile=" & statusFile)
	if statusFile is "" then
		display dialog "TranscribeForge-Progress: kein Status-File übergeben." buttons {"OK"} default button 1 with icon stop
		return
	end if
	set my statusFilePath to statusFile
	set my cancelRequested to false
	set my pendingOpen to false
	set my userClosed to false

	-- AppleKeyboardUIMode VOR sharedApplication() in die REGISTRATION-Domain
	-- legen — NSApp liest den Wert beim Init, fällt durch die Defaults-Chain
	-- und findet den Wert in registerDefaults: (App-Domain-Schreiben würde
	-- AppKit ignorieren, weil der Schlüssel global gemeint ist).
	-- 2 = „All controls" (Tab fokussiert NSButton et al.), Integer (NICHT Bool).
	try
		set kbDict to current application's NSDictionary's dictionaryWithObject:2 forKey:"AppleKeyboardUIMode"
		current application's NSUserDefaults's standardUserDefaults()'s registerDefaults:kbDict
	end try

	set NSApp to current application's NSApplication's sharedApplication()
	NSApp's setActivationPolicy:0 -- NSApplicationActivationPolicyRegular

	-- Window höher (200) damit Stats auf 2 Zeilen Platz haben.
	set winRect to current application's NSMakeRect(0, 0, 560, 200)
	set styleMask to (1 + 2) -- titled + closable
	set theWindow to (current application's NSWindow's alloc())'s initWithContentRect:winRect styleMask:styleMask backing:2 defer:false
	theWindow's setTitle:"TranscribeForge"
	theWindow's setLevel:(current application's NSFloatingWindowLevel)
	theWindow's |center|()
	-- Delegate setzen: User-Erwartung ist, dass der rote Schließen-Knopf
	-- den Wrapper-Prozess ebenfalls beendet (nicht nur das Fenster).
	-- windowShouldClose: triggert die gleiche Logik wie der Stop-Button.
	theWindow's setDelegate:me
	set my mainWindow to theWindow

	set contentView to theWindow's contentView()

	-- Phase label (oben)
	set phaseRect to current application's NSMakeRect(20, 150, 520, 26)
	set my phaseField to (current application's NSTextField's alloc())'s initWithFrame:phaseRect
	(my phaseField)'s setBezeled:false
	(my phaseField)'s setDrawsBackground:false
	(my phaseField)'s setEditable:false
	(my phaseField)'s setSelectable:false
	(my phaseField)'s setFont:(current application's NSFont's systemFontOfSize:15)
	(my phaseField)'s setStringValue:"Starte TranscribeForge…"
	(contentView's addSubview:(my phaseField))

	-- File label
	set fileRect to current application's NSMakeRect(20, 122, 520, 22)
	set my fileField to (current application's NSTextField's alloc())'s initWithFrame:fileRect
	(my fileField)'s setBezeled:false
	(my fileField)'s setDrawsBackground:false
	(my fileField)'s setEditable:false
	(my fileField)'s setSelectable:false
	(my fileField)'s setFont:(current application's NSFont's systemFontOfSize:12)
	(my fileField)'s setTextColor:(current application's NSColor's secondaryLabelColor())
	(my fileField)'s setStringValue:""
	(contentView's addSubview:(my fileField))

	-- Detail label (multi-line für Stats nach Abschluss; setUsesSingleLineMode:false)
	set detailRect to current application's NSMakeRect(20, 60, 520, 60)
	set my detailField to (current application's NSTextField's alloc())'s initWithFrame:detailRect
	(my detailField)'s setBezeled:false
	(my detailField)'s setDrawsBackground:false
	(my detailField)'s setEditable:false
	(my detailField)'s setSelectable:true -- User kann Stats kopieren
	(my detailField)'s setFont:(current application's NSFont's systemFontOfSize:11)
	(my detailField)'s setTextColor:(current application's NSColor's secondaryLabelColor())
	(my detailField)'s setStringValue:""
	try
		((my detailField)'s cell())'s setWraps:true
		((my detailField)'s cell())'s setLineBreakMode:0 -- NSLineBreakByWordWrapping
	end try
	(contentView's addSubview:(my detailField))

	-- Progress bar
	set barRect to current application's NSMakeRect(20, 18, 380, 20)
	set my progBar to (current application's NSProgressIndicator's alloc())'s initWithFrame:barRect
	(my progBar)'s setStyle:0 -- bar
	(my progBar)'s setIndeterminate:true
	(my progBar)'s startAnimation:(missing value)
	(contentView's addSubview:(my progBar))

	-- Stop button (rechts neben Progress-Bar) — sichtbar während Lauf
	set stopRect to current application's NSMakeRect(410, 12, 135, 28)
	set my stopBtn to (current application's NSButton's alloc())'s initWithFrame:stopRect
	(my stopBtn)'s setTitle:"Prozess stoppen"
	(my stopBtn)'s setBezelStyle:1 -- NSBezelStyleRounded
	(my stopBtn)'s setTarget:me
	(my stopBtn)'s setAction:"stopPressed:"
	(contentView's addSubview:(my stopBtn))

	-- Done/Error-Buttons — initial versteckt, erscheinen statt Progress-Bar+Stop.
	-- Hover-Layer aktivieren: setWantsLayer + clear layer-bg, damit wir später per
	-- layer's setBackgroundColor: blau hinterlegen können (setBezelColor wirkt bei
	-- bezelStyle:1 auf Catalina nicht sichtbar — Layer-Background ist robuster).
	set openRect to current application's NSMakeRect(280, 12, 130, 28)
	set my openBtn to (current application's NSButton's alloc())'s initWithFrame:openRect
	(my openBtn)'s setTitle:"Im Finder öffnen"
	(my openBtn)'s setBezelStyle:1
	(my openBtn)'s setTarget:me
	(my openBtn)'s setAction:"openPressed:"
	(my openBtn)'s setHidden:true
	(my openBtn)'s setWantsLayer:true
	((my openBtn)'s layer())'s setCornerRadius:5.0
	(contentView's addSubview:(my openBtn))

	set closeRect to current application's NSMakeRect(415, 12, 130, 28)
	set my closeBtn to (current application's NSButton's alloc())'s initWithFrame:closeRect
	(my closeBtn)'s setTitle:"Schließen"
	(my closeBtn)'s setBezelStyle:1
	(my closeBtn)'s setTarget:me
	(my closeBtn)'s setAction:"closePressed:"
	(my closeBtn)'s setWantsLayer:true
	((my closeBtn)'s layer())'s setCornerRadius:5.0
	-- Esc-Taste schließt (Default-Button-Blau bewusst NICHT gesetzt — gleiche
	-- Optik wie „Im Finder öffnen").
	(my closeBtn)'s setKeyEquivalent:(character id 27)
	(my closeBtn)'s setHidden:true
	(contentView's addSubview:(my closeBtn))

	-- Unsichtbare Tab-Catcher-Buttons.
	-- Auf Catalina ist die Tab-Navigation zwischen NSButtons selbst mit
	-- AppleKeyboardUIMode = 2 nicht zuverlässig. Robust: zwei Buttons
	-- außerhalb des sichtbaren Bereichs, deren keyEquivalent Tab bzw.
	-- Shift-Tab ist. AppKit ruft den Handler dann unabhängig vom
	-- Fokus-Loop auf, und wir setzen den firstResponder manuell.
	-- ASCII 9 = Tab. Modifier 131072 = NSEventModifierFlagShift (1<<17).
	set tabFwdRect to current application's NSMakeRect(-100, -100, 1, 1)
	set tabFwdBtn to (current application's NSButton's alloc())'s initWithFrame:tabFwdRect
	tabFwdBtn's setTitle:""
	tabFwdBtn's setTarget:me
	tabFwdBtn's setAction:"tabFwdPressed:"
	tabFwdBtn's setKeyEquivalent:(ASCII character 9)
	tabFwdBtn's setKeyEquivalentModifierMask:0
	(contentView's addSubview:tabFwdBtn)

	set tabBackRect to current application's NSMakeRect(-100, -100, 1, 1)
	set tabBackBtn to (current application's NSButton's alloc())'s initWithFrame:tabBackRect
	tabBackBtn's setTitle:""
	tabBackBtn's setTarget:me
	tabBackBtn's setAction:"tabBackPressed:"
	tabBackBtn's setKeyEquivalent:(ASCII character 9)
	tabBackBtn's setKeyEquivalentModifierMask:131072
	(contentView's addSubview:tabBackBtn)

	-- Tab-Cycling zwischen Buttons aktivieren + explizite Key-View-Reihenfolge.
	-- Damit Tab überhaupt bei Buttons stoppt (auch wenn „Full Keyboard Access"
	-- in Sys-Prefs nicht auf „All controls" steht), den NSApp explizit auf
	-- full-keyboard-access setzen. AppleKeyboardUIMode ist ein Integer (Bitfeld),
	-- NICHT Bool: 2 = „All controls". setBool:true schreibt YES, das wird beim
	-- Lesen via integerForKey: zu 1 → reicht nicht für NSButton.
	try
		-- Zweiter Versuch, falls der erste setInteger-Call vor sharedApplication()
		-- nicht durchgekommen ist. registerDefaults: ist idempotent.
		set kbDict to current application's NSDictionary's dictionaryWithObject:2 forKey:"AppleKeyboardUIMode"
		current application's NSUserDefaults's standardUserDefaults()'s registerDefaults:kbDict
	end try
	try
		-- Wir lassen das Loop von AppKit ableiten — manuelles
		-- setNextKeyView ist erfahrungsgemäß auf Catalina fragil; mit
		-- autorecalculates=true und canBecomeKeyView ergibt sich der Loop
		-- automatisch aus subview-Reihenfolge.
		theWindow's setAutorecalculatesKeyViewLoop:true
		(my openBtn)'s setFocusRingType:0 -- default ring
		(my closeBtn)'s setFocusRingType:0
		(my openBtn)'s setRefusesFirstResponder:false
		(my closeBtn)'s setRefusesFirstResponder:false
		(my stopBtn)'s setRefusesFirstResponder:false
		-- Explizite KeyView-Kette setzen (autorecalculates allein reicht auf
		-- Catalina nicht zuverlässig, wenn die Buttons als letzte Subviews
		-- hinzugefügt wurden).
		(my openBtn)'s setNextKeyView:(my closeBtn)
		(my closeBtn)'s setNextKeyView:(my openBtn)
		-- Force re-calc des Loops jetzt
		theWindow's recalculateKeyViewLoop()
		theWindow's setInitialFirstResponder:(my openBtn)
	end try
	theWindow's makeKeyAndOrderFront:(missing value)
	NSApp's activateIgnoringOtherApps:true
	my dlog("window ordered front")

	set my lastSig to ""
	set my finished to false
	set my lastLabel to ""

	-- NSTimer für Polling + Hover. Main-Thread idlet im AppKit-Event-Loop
	-- (NSApp's run()) → instant Cursor, native Tab-Cycling, Hover-Tracking.
	-- Bei Done-State weiterhin laufen, weil Hover-Updates gebraucht werden.
	set my tickTimer to (current application's NSTimer's scheduledTimerWithTimeInterval:0.15 target:me selector:"onTick:" userInfo:(missing value) repeats:true)

	my dlog("entering NSApp run loop")
	NSApp's |run|()
	my dlog("NSApp run loop exited")
end run

-- Tick: liest Status-File, aktualisiert UI, macht Hover-Highlighting.
on onTick:theTimer
	-- 1) Status-File lesen + UI aktualisieren
	try
		my pollStatusFile()
	end try
	-- 2) Hover-Tracking — über welchem Button ist die Maus?
	try
		my updateHover()
	end try
	-- 3) Focus-Highlight (Tab) — fokussierter Button wird blau, falls kein
	-- Hover gleichzeitig auf einem anderen Button steht.
	try
		my updateFocusHighlight()
	end try
	-- 4) Bei indeterminierten Phasen (Whisper, Summary) live „läuft seit XX s"
	-- ins Phase-Label hängen, damit der User sieht, dass der Prozess lebt.
	try
		my updateIndeterminateLabel()
	end try
end onTick:

-- Hängt bei laufender indeterminate-Phase ein " — läuft seit XX s" (oder
-- "M:SS Min") ans Phase-Label. Wird vom Tick alle 150 ms aufgerufen, aber nur
-- 1× pro Sekunde sichtbar nachgezogen (die Sekunden-Auflösung reicht).
on updateIndeterminateLabel()
	if not (my currentIndeterm) then return
	if (my currentBasePhase) is "" then return
	if (my currentPhaseStartedAt) is 0 then return
	if (my finished) then return
	set nowTs to (current application's NSDate's |date|()'s timeIntervalSince1970()) as integer
	set elapsed to nowTs - (my currentPhaseStartedAt)
	if elapsed < 0 then set elapsed to 0
	set suffix to my formatElapsedSeconds(elapsed)
	set newLabel to (my currentBasePhase) & "   —   läuft seit " & suffix
	try
		(my phaseField)'s setStringValue:newLabel
	end try
end updateIndeterminateLabel

-- "42 s" für <60s, "1:05 Min" ab 60s
on formatElapsedSeconds(s)
	if s < 60 then return ((s as integer) as text) & " s"
	set mins to s div 60
	set secs to s mod 60
	set secStr to (secs as text)
	if (length of secStr) is 1 then set secStr to "0" & secStr
	return (mins as text) & ":" & secStr & " Min"
end formatElapsedSeconds

-- Den per Tab fokussierten Button blau hinterlegen (gleiches setHighlighted
-- wie beim Hover). Hover hat Priorität — wenn die Maus auf einem Button
-- liegt, kümmert sich updateHover ums Highlight, und die separate Focus-
-- Färbung wird entfernt, damit nicht zwei Buttons gleichzeitig blau sind.
on updateFocusHighlight()
	-- Wenn ein Hover aktiv ist, übernimmt updateHover das Highlight.
	-- Trotzdem den focusHighlightBtn löschen, falls er auf einem anderen
	-- Button steht.
	if (my hoveredBtn) is not missing value then
		if (my focusHighlightBtn) is not missing value then
			set sameAsHover to false
			try
				if ((my focusHighlightBtn)'s title() as text) is ((my hoveredBtn)'s title() as text) then set sameAsHover to true
			end try
			if not sameAsHover then
				try
					((my focusHighlightBtn)'s cell())'s setHighlighted:false
				end try
				set my focusHighlightBtn to missing value
			end if
		end if
		return
	end if

	-- Kein Hover → firstResponder bestimmen.
	set fr to missing value
	try
		set fr to (my mainWindow)'s firstResponder()
	end try
	set newFocus to missing value
	if fr is not missing value then
		try
			set frTitle to (fr's title() as text)
			if frTitle is "Im Finder öffnen" then set newFocus to (my openBtn)
			if frTitle is "Schließen" then set newFocus to (my closeBtn)
		end try
	end if

	-- Unverändert? Nichts tun.
	set sameAsBefore to false
	if (my focusHighlightBtn) is not missing value and newFocus is not missing value then
		try
			if ((my focusHighlightBtn)'s title() as text) is (newFocus's title() as text) then set sameAsBefore to true
		end try
	else if (my focusHighlightBtn) is missing value and newFocus is missing value then
		set sameAsBefore to true
	end if
	if sameAsBefore then return

	-- Alten Focus-Highlight zurücksetzen
	if (my focusHighlightBtn) is not missing value then
		try
			((my focusHighlightBtn)'s cell())'s setHighlighted:false
		end try
	end if
	-- Neuen Focus-Highlight setzen
	if newFocus is not missing value then
		try
			(newFocus's cell())'s setHighlighted:true
		end try
	end if
	set my focusHighlightBtn to newFocus
end updateFocusHighlight

on pollStatusFile()
	set rawText to ""
	try
		set nsStr to current application's NSString's stringWithContentsOfFile:(my statusFilePath) encoding:4 |error|:(missing value)
		if nsStr is not missing value then set rawText to (nsStr as text)
	end try
	if rawText is "" or rawText is (my lastSig) then return
	set my lastSig to rawText
	set kv to my parseKV(rawText)

	set lblVal to my dictGet(kv, "label", "")
	set phaseVal to my dictGet(kv, "phase", "Läuft…")
	set detailVal to my dictGet(kv, "detail", "")
	set stepVal to my dictGet(kv, "step", "")
	set totalVal to my dictGet(kv, "total", "")
	set statusVal to my dictGet(kv, "status", "running")
	set folderVal to my dictGet(kv, "folder", "")
	set mdVal to my dictGet(kv, "mdfile", "")
	set indetVal to my dictGet(kv, "phase_indeterminate", "")
	set startedAtVal to my dictGet(kv, "phase_started_at", "")

	(my fileField)'s setStringValue:lblVal
	(my phaseField)'s setStringValue:phaseVal
	(my detailField)'s setStringValue:(my multilineDetail(detailVal))

	if folderVal is not "" then set my lastFolderPath to folderVal
	if mdVal is not "" then set my lastMdPath to mdVal
	if lblVal is not "" then set my lastLabel to lblVal

	-- Indeterminate-Phase: setProgress(..., {indeterminate:true, startedAt:…})
	-- aus transcribe.js. Whisper-API + Summary streamen keinen Fortschritt;
	-- wir blenden statt 60-%-Standstand einen animierten Bar + Live-Counter
	-- " — läuft seit XX s" im Phase-Label ein (siehe updateIndeterminateLabel).
	set my currentBasePhase to phaseVal
	if indetVal is "1" then
		set my currentIndeterm to true
		try
			set my currentPhaseStartedAt to (startedAtVal as integer)
		on error
			set my currentPhaseStartedAt to 0
		end try
		try
			(my progBar)'s setIndeterminate:true
			(my progBar)'s startAnimation:(missing value)
		end try
		try
			if (my currentPhaseStartedAt) > 0 then
				set nowTs to (current application's NSDate's |date|()'s timeIntervalSince1970()) as integer
				set elapsed to nowTs - (my currentPhaseStartedAt)
				if elapsed < 0 then set elapsed to 0
				(my phaseField)'s setStringValue:(phaseVal & "   —   läuft seit " & my formatElapsedSeconds(elapsed))
			end if
		end try
	else
		set my currentIndeterm to false
		set my currentPhaseStartedAt to 0
		if stepVal is not "" and totalVal is not "" then
			try
				(my progBar)'s setIndeterminate:false
				(my progBar)'s setMaxValue:(totalVal as real)
				(my progBar)'s setDoubleValue:(stepVal as real)
				set pct to ((stepVal as real) / (totalVal as real) * 100) as integer
				(my phaseField)'s setStringValue:(phaseVal & "   —   " & pct & " %")
			end try
		else
			(my progBar)'s setIndeterminate:true
			(my progBar)'s startAnimation:(missing value)
		end if
	end if

	if statusVal is "done" and not (my finished) then
		set my finished to true
		my dlog("entering done branch lbl=" & lblVal)
		(my phaseField)'s setStringValue:("✓ Fertig: " & lblVal)
		(my progBar)'s setIndeterminate:false
		(my progBar)'s setMaxValue:1.0
		(my progBar)'s setDoubleValue:1.0
		(my progBar)'s stopAnimation:(missing value)
		try
			(current application's NSSound's soundNamed:"Glass")'s play()
		end try
		(my stopBtn)'s setHidden:true
		(my progBar)'s setHidden:true
		(my openBtn)'s setTitle:"Im Finder öffnen"
		(my openBtn)'s setHidden:false
		(my closeBtn)'s setHidden:false
		(my mainWindow)'s setLevel:(current application's NSFloatingWindowLevel)
		NSApp's activateIgnoringOtherApps:true
		(my mainWindow)'s makeKeyAndOrderFront:(missing value)
		try
			-- FirstResponder = openBtn → Tab cycelt zu closeBtn → zurück.
			-- (Vorher closeBtn; aber closeBtn ist via Esc bereits erreichbar — der
			-- erste Tab-Stop soll der nicht-defaulte Button sein.)
			(my mainWindow)'s makeFirstResponder:(my openBtn)
		end try
	else if statusVal is "error" and not (my finished) then
		set my finished to true
		(my phaseField)'s setStringValue:("❌ Fehler: " & lblVal)
		(my progBar)'s setIndeterminate:false
		(my progBar)'s stopAnimation:(missing value)
		try
			(current application's NSSound's soundNamed:"Funk")'s play()
		end try
		(my stopBtn)'s setHidden:true
		(my progBar)'s setHidden:true
		(my openBtn)'s setTitle:"Ordner öffnen"
		(my openBtn)'s setHidden:false
		(my closeBtn)'s setHidden:false
		(my mainWindow)'s setLevel:(current application's NSFloatingWindowLevel)
		NSApp's activateIgnoringOtherApps:true
		(my mainWindow)'s makeKeyAndOrderFront:(missing value)
		try
			(my mainWindow)'s makeFirstResponder:(my openBtn)
		end try
	end if

	if my cancelRequested and not (my finished) then
		(my phaseField)'s setStringValue:"Abbruch läuft…"
		(my detailField)'s setStringValue:"Stoppe laufende Prozesse — Error-Log wird geschrieben."
		(my progBar)'s setIndeterminate:true
		(my progBar)'s startAnimation:(missing value)
		(my stopBtn)'s setEnabled:false
		(my stopBtn)'s setTitle:"Wird gestoppt…"
	end if
end pollStatusFile

-- Hover-Highlighting: blau, wenn Maus über einem sichtbaren Button.
-- macOS bietet keinen out-of-the-box Hover für Standard-NSButton; wir polln
-- die Mauskoordinaten und setzen setBezelColor entsprechend.
--
-- KOORDINATEN-SYSTEM (Catalina):
--   NSEvent's mouseLocation() liefert Screen-Coords (Y wächst nach oben, origin
--   unten-links des MAIN-Screens).
--   Button-Frames sind in contentView-Coords (origin unten-links des Content-
--   Bereichs, OHNE Titlebar).
--   Window's frame() liefert window-rect inkl. Titlebar (origin = unten-links
--   des Window-Rahmens). Auf Catalina liegt die Titlebar OBEN (~22px), also
--   gilt: contentView.frame.origin in window-coords = (0, 0), aber die Titlebar
--   addiert ~22px Höhe oben → window-Höhe = content-Höhe + 22.
--   D.h. window-y(0..content_h) = content-y(0..content_h); y(content_h..win_h)
--   liegt in der Titlebar. Wir brauchen also nur Screen→Window-Conversion und
--   können dann direkt mit Button-Frames vergleichen (weil contentView am
--   Window-Ursprung sitzt).
--
-- Wir nutzen convertRectFromScreen: — verfügbar ab macOS 10.7, Catalina-safe.
on updateHover()
	set mx to -1.0
	set my0 to -1.0
	set localX to -1.0
	set localY to -1.0
	set cvOx to -1.0
	set cvOy to -1.0
	set cvLocalX to -1.0
	set cvLocalY to -1.0
	set debugBtnFrame to "n/a"
	set newHover to missing value
	set errStage to "init"
	try
		set errStage to "mouseLocation"
		set mouseScreen to current application's NSEvent's mouseLocation()
		-- mouseScreen ist NSPoint — als AppleScript-Record-Liste extrahieren
		set msList to mouseScreen as list
		set mx to (item 1 of msList) as real
		set my0 to (item 2 of msList) as real
		-- WindowFrame-Origin (Screen-Coords): manuell Screen→Window rechnen.
		-- Window-Coords = Screen-Coords - winFrame.origin (origin = unten-links
		-- des Window-Rahmens in Screen-Space). Y wächst nach oben in beiden.
		set errStage to "winFrame"
		set winFrame to (my mainWindow)'s frame()
		set wfList to winFrame as list
		-- winFrame als list: {{ox, oy}, {w, h}}
		set wfOriginL to item 1 of wfList
		set wfSizeL to item 2 of wfList
		set wfx to (item 1 of wfOriginL) as real
		set wfy to (item 2 of wfOriginL) as real
		set wfw to (item 1 of wfSizeL) as real
		set wfh to (item 2 of wfSizeL) as real
		set localX to mx - wfx
		set localY to my0 - wfy

		set errStage to "contentView"
		set cv to (my mainWindow)'s contentView()
		set cvFrame to cv's frame()
		set cvFrList to cvFrame as list
		set cvOrigL to item 1 of cvFrList
		set cvSizeL to item 2 of cvFrList
		set cvOx to (item 1 of cvOrigL) as real
		set cvOy to (item 2 of cvOrigL) as real
		set cvW to (item 1 of cvSizeL) as real
		set cvH to (item 2 of cvSizeL) as real
		set cvLocalX to localX - cvOx
		set cvLocalY to localY - cvOy

		set errStage to "buttonLoop"
		repeat with btn in {my stopBtn, my openBtn, my closeBtn}
			if not ((btn's isHidden()) as boolean) then
				set bFrm to btn's frame()
				set bFrmList to bFrm as list
				set bOrigL to item 1 of bFrmList
				set bSizeL to item 2 of bFrmList
				set fx to (item 1 of bOrigL) as real
				set fy to (item 2 of bOrigL) as real
				set fw to (item 1 of bSizeL) as real
				set fh to (item 2 of bSizeL) as real
				try
					if (contents of btn) is (my openBtn) then
						set debugBtnFrame to ("(" & fx & "," & fy & "," & fw & "," & fh & ")")
					end if
				end try
				set hitX to (cvLocalX ≥ fx) and (cvLocalX ≤ (fx + fw))
				set hitY to (cvLocalY ≥ fy) and (cvLocalY ≤ (fy + fh))
				try
					if (contents of btn) is (my openBtn) then
						do shell script "echo \"[$(date +%H:%M:%S)] HITTEST openBtn cvL=" & cvLocalX & "," & cvLocalY & " btn=(" & fx & "," & fy & "," & fw & "," & fh & ") hitX=" & (hitX as text) & " hitY=" & (hitY as text) & "\" >> /tmp/tf-hover-debug.log"
					end if
				end try
				if hitX and hitY then
					set newHover to btn
					exit repeat
				end if
			end if
		end repeat
		set errStage to "doneLoop"
	on error errMsg number errNum
		try
			do shell script "echo \"[$(date +%H:%M:%S)] ERR stage=" & errStage & " num=" & errNum & " msg=" & (do shell script "printf '%s' " & quoted form of (errMsg as text)) & "\" >> /tmp/tf-hover-debug.log"
		end try
	end try

	set isInside to "NO"
	try
		if newHover is not missing value then
			if (newHover as anything) = ((my openBtn) as anything) then set isInside to "YES"
		end if
	end try
	-- Robusterer Vergleich: über title (eindeutig pro Button)
	try
		if newHover is not missing value then
			if (newHover's title() as text) is "Im Finder öffnen" then set isInside to "YES"
		end if
	end try
	try
		set debugLine to "stage=" & errStage & " mouseScr=(" & mx & "," & my0 & ") winOrig=(" & wfx & "," & wfy & ") winSize=(" & wfw & "," & wfh & ") local=(" & localX & "," & localY & ") cvOrig=(" & cvOx & "," & cvOy & ") cvLocal=(" & cvLocalX & "," & cvLocalY & ") openBtn=" & debugBtnFrame & " openInside=" & isInside
		do shell script "echo \"[$(date +%H:%M:%S)] " & debugLine & "\" >> /tmp/tf-hover-debug.log"
	end try

	-- Hover-Highlight: setBordered:false + Layer-BG blau + weiße Schrift.
	-- setBezelColor wirkt bei bezelStyle:1 auf Catalina NICHT sichtbar — Layer-BG
	-- ohne Border ist die einzige zuverlässige Variante. Button-Identität via
	-- title() vergleichen (NSButton-Referenzvergleich via `is` ist in
	-- AppleScriptObjC unzuverlässig).
	set hoveredTitle to ""
	if newHover is not missing value then
		try
			set hoveredTitle to (newHover's title() as text)
		end try
	end if
	set prevTitle to ""
	if (my hoveredBtn) is not missing value then
		try
			set prevTitle to ((my hoveredBtn)'s title() as text)
		end try
	end if
	if hoveredTitle is prevTitle then return

	-- Alten Hover zurücksetzen: cell-highlight aus
	if (my hoveredBtn) is not missing value then
		try
			((my hoveredBtn)'s cell())'s setHighlighted:false
		end try
	end if
	-- Neuen Hover setzen: cell-highlight an → Button zeigt pressed/blauen Look.
	-- Das ist die Catalina-zuverlässige Variante (setBezelColor wird bei
	-- bezelStyle:1 nicht gerendert; Layer-BG wird vom Bezel überdeckt).
	if newHover is not missing value then
		try
			(newHover's cell())'s setHighlighted:true
		end try
	end if
	set my hoveredBtn to newHover
end updateHover

-- Stop-Button: Signal an Bash-Wrapper schicken. Der Wrapper läuft in einer
-- eigenen Prozessgruppe; sein PID liegt als wrapper_pid=… in der Statusdatei.
-- TERM dort triggert den Wrapper-Trap, der pkill -P $$ + Error-Log macht.
--
-- Robustheits-Schicht (nach Vorfall 2026-06-15 14:13 — Click hatte keinen Effekt):
--  1) sofortiges Visual-Feedback im UI, BEVOR wir das Shell-Script ausführen
--  2) jeder Schritt loggt nach /tmp/tf-progress-debug.log
--  3) kill -TERM <PID> + Fallback pkill -f gegen den Wrapper-Skript-Pfad
--  4) Shell-Call läuft mit `&` + `disown` → blockiert NICHT den AppKit-Thread
on stopPressed:sender
	my dlog("stopPressed: enter")
	-- 1) UI-Feedback SOFORT, damit der User nicht denkt nichts passiert.
	try
		(my phaseField)'s setStringValue:"Abbruch läuft…"
		(my detailField)'s setStringValue:"Stoppe laufende Prozesse — Error-Log wird geschrieben."
		(my stopBtn)'s setEnabled:false
		(my stopBtn)'s setTitle:"Wird gestoppt…"
		(my progBar)'s setIndeterminate:true
		(my progBar)'s startAnimation:(missing value)
	end try
	set my cancelRequested to true

	-- 2) Status-File lesen
	set kvText to ""
	try
		set kvText to (do shell script "cat " & quoted form of (my statusFilePath) & " 2>/dev/null || true")
	on error errMsg
		my dlog("stopPressed: read status-file FAILED msg=" & errMsg)
	end try
	set wpid to my extractWrapperPid(kvText)
	my dlog("stopPressed: statusFile=" & (my statusFilePath) & " wpid=" & wpid)

	-- 3) Kill direkt + Fallback. Mit `( … ) &` als async Job, damit AppleScript
	--    auch dann sofort weitergeht, wenn ein einzelner kill hängt.
	if wpid is not "" then
		try
			-- TERM auslösen, lange genug warten, damit der Wrapper-Trap sein
			-- Error-Log schreiben und status=error setzen kann (das löst im
			-- Progress-Window die Close-Buttons aus). Erst nach 15 s eskalieren.
			set killCmd to "( kill -TERM " & wpid & " 2>>/tmp/tf-progress-debug.log; sleep 15; kill -KILL " & wpid & " 2>/dev/null ) >/dev/null 2>&1 &"
			do shell script killCmd
			my dlog("stopPressed: kill async dispatched for pid=" & wpid & " (escalate KILL after 15s)")
		on error errMsg
			my dlog("stopPressed: kill failed msg=" & errMsg)
		end try
	else
		-- Fallback wenn kein PID lesbar: best-effort pkill auf Skriptname.
		try
			do shell script "( pkill -TERM -f transcribeforge-quickaction.sh; sleep 2; pkill -KILL -f transcribeforge-quickaction.sh ) >/dev/null 2>&1 &"
			my dlog("stopPressed: no wpid — pkill fallback dispatched")
		on error errMsg
			my dlog("stopPressed: pkill fallback failed msg=" & errMsg)
		end try
	end if
end stopPressed:

-- Im Finder öffnen — Ordner sofort öffnen, Fenster bleibt offen, damit
-- User die Statistik noch lesen / kopieren kann. Erst Klick auf „Schließen"
-- beendet die App.
on openPressed:sender
	my doOpen(my lastMdPath, my lastFolderPath)
end openPressed:

-- Schließen: Fenster sofort verstecken, Timer invalidieren, terminieren.
-- terminate: kann durch noch laufendes `do shell script` 1-2s blockieren — der User
-- sieht aber sofort, dass der Klick gewirkt hat.
on closePressed:sender
	set my pendingOpen to false
	set my userClosed to true
	try
		(my mainWindow)'s orderOut:(missing value)
	end try
	try
		if (my tickTimer) is not missing value then (my tickTimer)'s invalidate()
	end try
	try
		NSApp's terminate:(missing value)
	end try
end closePressed:

-- NSWindowDelegate: roter Schließen-Knopf in Titelleiste.
-- Solange der Wrapper noch läuft, behandelt das Fenster den Close wie einen
-- Klick auf „Prozess stoppen" — Kill-Signal an Wrapper, UI auf „Wird gestoppt…",
-- Fenster bleibt offen, bis status=error eintrifft und der „Schließen"-Button
-- sichtbar wird. Sobald der Lauf fertig ist (my finished = true), darf der
-- Klick das Fenster sofort schließen.
on windowShouldClose:sender
	my dlog("windowShouldClose: finished=" & (my finished as text))
	if (my finished) then return true
	-- Lauf noch aktiv → wie Stop-Button behandeln, NICHT direkt schließen.
	my stopPressed:(missing value)
	return false
end windowShouldClose:

-- Tab- bzw. Shift-Tab-Catcher (siehe unsichtbare Buttons im run-Handler).
-- Cycle zwischen openBtn ↔ closeBtn (nur die sichtbaren, nicht versteckten).
on tabFwdPressed:sender
	my cycleFocus(1)
end tabFwdPressed:

on tabBackPressed:sender
	my cycleFocus(-1)
end tabBackPressed:

on cycleFocus(direction)
	try
		set w to my mainWindow
		set current to w's firstResponder()
		-- AppKit unterscheidet zwischen einem NSButton und dessen FieldEditor;
		-- über cell()'s controlView() kommt man wieder zum Button zurück.
		set onOpen to false
		try
			if current is (my openBtn) then set onOpen to true
		end try
		if onOpen then
			w's makeFirstResponder:(my closeBtn)
		else
			w's makeFirstResponder:(my openBtn)
		end if
	end try
end cycleFocus

on extractWrapperPid(t)
	set lns to paragraphs of t
	repeat with l in lns
		set ls to l as text
		if ls starts with "wrapper_pid=" then
			return text 13 thru -1 of ls
		end if
	end repeat
	return ""
end extractWrapperPid

-- " • " im Detail durch Zeilenumbrüche ersetzen, damit lange Stats-Zeilen
-- vom NSTextField sauber auf mehrere Zeilen umbrechen.
on multilineDetail(t)
	if t is "" then return ""
	set AppleScript's text item delimiters to " • "
	set parts to text items of t
	set AppleScript's text item delimiters to (ASCII character 10)
	set out to parts as text
	set AppleScript's text item delimiters to ""
	return out
end multilineDetail

on doOpen(mdPath, folderPath)
	if mdPath is not "" then
		try
			do shell script "open -R " & quoted form of mdPath
			return
		end try
	end if
	if folderPath is not "" then
		try
			do shell script "open " & quoted form of folderPath
		end try
	end if
end doOpen

on parseKV(txt)
	set d to current application's NSMutableDictionary's dictionary()
	set kvLines to paragraphs of txt
	repeat with rawLine in kvLines
		set lineText to rawLine as text
		if lineText is not "" then
			set p to offset of "=" in lineText
			if p > 1 then
				set theKey to text 1 thru (p - 1) of lineText
				set theVal to text (p + 1) thru -1 of lineText
				(d's setObject:theVal forKey:theKey)
			end if
		end if
	end repeat
	return d
end parseKV

on dictGet(d, k, fallback)
	set val to d's objectForKey:k
	if val is missing value then return fallback
	return (val as text)
end dictGet

-- AttrString mit weißer Schrift (für Hover-Highlight auf blau).
on whiteAttrTitle(t)
	set fontSz to 13.0
	set attrs to current application's NSDictionary's dictionaryWithObjects:{current application's NSColor's whiteColor(), (current application's NSFont's systemFontOfSize:fontSz)} forKeys:{current application's NSForegroundColorAttributeName, current application's NSFontAttributeName}
	return (current application's NSAttributedString's alloc()'s initWithString:t attributes:attrs)
end whiteAttrTitle

-- AttrString mit Default-Schrift (für Reset nach Hover).
on plainAttrTitle(t)
	set fontSz to 13.0
	set attrs to current application's NSDictionary's dictionaryWithObjects:{current application's NSColor's labelColor(), (current application's NSFont's systemFontOfSize:fontSz)} forKeys:{current application's NSForegroundColorAttributeName, current application's NSFontAttributeName}
	return (current application's NSAttributedString's alloc()'s initWithString:t attributes:attrs)
end plainAttrTitle

-- Debug-Log nach /tmp (für .app-Crashes, wo stderr unsichtbar ist)
on dlog(msg)
	try
		do shell script "echo \"[$(date +%H:%M:%S)] " & msg & "\" >> /tmp/tf-progress-debug.log"
	end try
end dlog

-- Launch-Arg an n-ter Stelle holen.
-- Bei `osascript script.applescript a b c` ist argv = {"a","b","c"} → item n.
-- Bei .app via `open --args a b c` ist argv = missing value → NSProcessInfo:
--   processInfo's arguments() = {"/.../applet", "a", "b", "c"} → item (n+1).
on readLaunchArg(argv, n)
	-- 1) Standardweg: osascript-Aufruf
	try
		if argv is not missing value then
			if (count of argv) ≥ n then
				return (item n of argv) as text
			end if
		end if
	end try
	-- 2) Fallback: NSProcessInfo (für .app-Bundle-Launches)
	try
		set procArgs to current application's NSProcessInfo's processInfo()'s arguments() as list
		-- Item 1 ist Binary-Pfad, User-Args ab Item 2.
		if (count of procArgs) ≥ (n + 1) then
			return (item (n + 1) of procArgs) as text
		end if
	end try
	return ""
end readLaunchArg
