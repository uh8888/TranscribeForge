-- TranscribeForge — Floating Progress Window (AppleScriptObjC).
-- Aufruf: osascript progress-window.applescript <statusfile>
-- Liest <statusfile> alle 0.4s, aktualisiert Phase/Detail/Schritt.
-- Statusfile-Format (key=value, Zeilen):
--   status=running|done|error
--   label=<Datei-/Ordner-Label>
--   phase=<aktuelle Phase>
--   detail=<optionale Detailzeile>
--   step=<int>
--   total=<int>
--   folder=<absoluter Pfad zum Ergebnis-Ordner>   (für Öffnen-Button)
--   mdfile=<absoluter Pfad zur MD-Datei>          (optional, für Öffnen-Button)
--
-- Verhalten: Fenster bleibt offen bis User es schließt (Schließen-Button,
-- Close-Box oder Öffnen-Button). Bei status=done erscheint der "Öffnen"-Button
-- aktiv, Sound spielt, aber kein Auto-Close.

use framework "Foundation"
use framework "AppKit"
use scripting additions

property NSApp : missing value

script ButtonBridge
	property targetWindow : missing value
	property folderPath : ""
	property mdPath : ""
	on openResult:sender
		if mdPath is not "" then
			try
				do shell script "open -R " & quoted form of mdPath
				my closeWindow()
				return
			end try
		end if
		if folderPath is not "" then
			try
				do shell script "open " & quoted form of folderPath
			end try
		end if
		my closeWindow()
	end openResult:
	on closeNow:sender
		my closeWindow()
	end closeNow:
	on closeWindow()
		if targetWindow is not missing value then
			try
				targetWindow's |close|()
			end try
		end if
		NSApp's terminate:(missing value)
	end closeWindow
end script

on run argv
	set statusFile to (item 1 of argv) as text

	set NSApp to current application's NSApplication's sharedApplication()
	NSApp's setActivationPolicy:0 -- NSApplicationActivationPolicyRegular

	set winRect to current application's NSMakeRect(0, 0, 560, 220)
	set styleMask to (1 + 2) -- titled + closable
	set theWindow to (current application's NSWindow's alloc())'s initWithContentRect:winRect styleMask:styleMask backing:2 defer:false
	theWindow's setTitle:"TranscribeForge"
	theWindow's setLevel:(current application's NSFloatingWindowLevel)
	theWindow's |center|()

	set contentView to theWindow's contentView()

	-- Phase label
	set phaseRect to current application's NSMakeRect(20, 170, 520, 26)
	set phaseField to (current application's NSTextField's alloc())'s initWithFrame:phaseRect
	phaseField's setBezeled:false
	phaseField's setDrawsBackground:false
	phaseField's setEditable:false
	phaseField's setSelectable:false
	phaseField's setFont:(current application's NSFont's systemFontOfSize:15)
	phaseField's setStringValue:"Starte TranscribeForge…"
	(contentView's addSubview:phaseField)

	-- File label
	set fileRect to current application's NSMakeRect(20, 140, 520, 22)
	set fileField to (current application's NSTextField's alloc())'s initWithFrame:fileRect
	fileField's setBezeled:false
	fileField's setDrawsBackground:false
	fileField's setEditable:false
	fileField's setSelectable:false
	fileField's setFont:(current application's NSFont's systemFontOfSize:12)
	fileField's setTextColor:(current application's NSColor's secondaryLabelColor())
	fileField's setStringValue:""
	(contentView's addSubview:fileField)

	-- Detail label
	set detailRect to current application's NSMakeRect(20, 115, 520, 20)
	set detailField to (current application's NSTextField's alloc())'s initWithFrame:detailRect
	detailField's setBezeled:false
	detailField's setDrawsBackground:false
	detailField's setEditable:false
	detailField's setSelectable:false
	detailField's setFont:(current application's NSFont's systemFontOfSize:11)
	detailField's setTextColor:(current application's NSColor's secondaryLabelColor())
	detailField's setStringValue:""
	(contentView's addSubview:detailField)

	-- Progress bar
	set barRect to current application's NSMakeRect(20, 70, 520, 20)
	set progBar to (current application's NSProgressIndicator's alloc())'s initWithFrame:barRect
	progBar's setStyle:0 -- bar
	progBar's setIndeterminate:true
	progBar's startAnimation:(missing value)
	(contentView's addSubview:progBar)

	-- Buttons
	set ButtonBridge's targetWindow to theWindow

	set openBtnRect to current application's NSMakeRect(260, 20, 160, 32)
	set openBtn to (current application's NSButton's alloc())'s initWithFrame:openBtnRect
	openBtn's setTitle:"Im Finder öffnen"
	openBtn's setBezelStyle:1 -- rounded
	openBtn's setEnabled:false
	openBtn's setTarget:ButtonBridge
	openBtn's setAction:("openResult:")
	(contentView's addSubview:openBtn)

	set closeBtnRect to current application's NSMakeRect(430, 20, 110, 32)
	set closeBtn to (current application's NSButton's alloc())'s initWithFrame:closeBtnRect
	closeBtn's setTitle:"Schließen"
	closeBtn's setBezelStyle:1
	closeBtn's setKeyEquivalent:return
	closeBtn's setTarget:ButtonBridge
	closeBtn's setAction:("closeNow:")
	(contentView's addSubview:closeBtn)

	theWindow's makeKeyAndOrderFront:(missing value)
	NSApp's activateIgnoringOtherApps:true

	set lastSig to ""
	set finished to false

	repeat
		try
			set rawText to (do shell script "cat " & quoted form of statusFile & " 2>/dev/null || true")
		on error
			set rawText to ""
		end try

		if rawText is not "" and rawText is not lastSig then
			set lastSig to rawText
			set kv to my parseKV(rawText)

			set lblVal to my dictGet(kv, "label", "")
			set phaseVal to my dictGet(kv, "phase", "Läuft…")
			set detailVal to my dictGet(kv, "detail", "")
			set stepVal to my dictGet(kv, "step", "")
			set totalVal to my dictGet(kv, "total", "")
			set statusVal to my dictGet(kv, "status", "running")
			set folderVal to my dictGet(kv, "folder", "")
			set mdVal to my dictGet(kv, "mdfile", "")

			fileField's setStringValue:lblVal
			phaseField's setStringValue:phaseVal
			detailField's setStringValue:detailVal

			if folderVal is not "" then set ButtonBridge's folderPath to folderVal
			if mdVal is not "" then set ButtonBridge's mdPath to mdVal

			if stepVal is not "" and totalVal is not "" then
				try
					progBar's setIndeterminate:false
					progBar's setMaxValue:(totalVal as real)
					progBar's setDoubleValue:(stepVal as real)
				end try
			else
				progBar's setIndeterminate:true
				progBar's startAnimation:(missing value)
			end if

			if statusVal is "done" and not finished then
				phaseField's setStringValue:("✓ Fertig: " & lblVal)
				progBar's setIndeterminate:false
				progBar's setMaxValue:1.0
				progBar's setDoubleValue:1.0
				progBar's stopAnimation:(missing value)
				openBtn's setEnabled:true
				try
					(current application's NSSound's soundNamed:"Glass")'s play()
				end try
				set finished to true
			else if statusVal is "error" and not finished then
				phaseField's setStringValue:("❌ Fehler: " & lblVal)
				progBar's setIndeterminate:false
				progBar's stopAnimation:(missing value)
				if folderVal is not "" then openBtn's setEnabled:true
				try
					(current application's NSSound's soundNamed:"Funk")'s play()
				end try
				set finished to true
			end if
		end if

		-- Pump event loop 0.4s
		set endDate to (current application's NSDate's dateWithTimeIntervalSinceNow:0.4)
		(current application's NSRunLoop's mainRunLoop()'s runUntilDate:endDate)

		-- User hat Fenster manuell geschlossen?
		if not (theWindow's isVisible() as boolean) then exit repeat
	end repeat

	NSApp's terminate:(missing value)
end run

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
