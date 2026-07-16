-- TranscribeForge — Settings-Dialog (AppleScriptObjC).
-- Aufruf:
--   osascript settings-dialog.applescript <video-dauer-min> <video-label> [<result-file>]
--   open -W -n -a TranscribeForge-Settings.app --args <dauer> <label> <result-file>
--
-- Zeigt einen Floating-Dialog mit 4 Presets (Sparmodus, Standard, Hochauflösend,
-- Audio only) und Live-Kostenschätzung pro Preset.
--
-- Wenn <result-file> übergeben wird (Pflicht im .app-Bundle-Modus, da open keinen
-- stdout durchreicht): Bei „Starten" wird eine Zeile key=value pipe-separated
-- dort hineingeschrieben, z.B.
--   preset=sparmodus|interval=6|frame_width=768|no_frames=0
-- Bei „Abbrechen" bleibt die Datei leer.
-- Im osascript-Modus (kein 3. Arg) wird das Result zusätzlich auf stdout zurückgegeben.

use framework "Foundation"
use framework "AppKit"
use scripting additions

property NSApp : missing value
property userConfirmed : false
property userCancelled : false
property popupBtn : missing value

on run argv
	-- argv ist bei .app-Applets via `open --args` immer `missing value`.
	-- Args nur via NSProcessInfo verfügbar (siehe readLaunchArg).
	set durMin to 0.0
	set videoLabel to ""
	set resultFile to ""
	try
		set durMin to (my readLaunchArg(argv, 1)) as real
	end try
	set videoLabel to my readLaunchArg(argv, 2)
	set resultFile to my readLaunchArg(argv, 3)
	if videoLabel is "" then set videoLabel to "(unbenanntes Video)"

	-- Kosten pro Preset berechnen (Faktor × Minuten)
	set costSparmodus to durMin * 0.0138
	set costStandard to durMin * 0.0405
	set costHigh to durMin * 0.057
	set costAudio to durMin * 0.0078

	set sparLabel to "Sparmodus — 6 s · 768 px · Frames an   (~$" & my fmt2(costSparmodus) & ")"
	set stdLabel to "Standard — 3 s · 1280 px · Frames an   (~$" & my fmt2(costStandard) & ")"
	set highLabel to "Hochauflösend — 2 s · 1280 px · Frames an   (~$" & my fmt2(costHigh) & ")"
	set audioLabel to "Audio only — keine Frames   (~$" & my fmt2(costAudio) & ")"

	set my userConfirmed to false
	set my userCancelled to false

	set NSApp to current application's NSApplication's sharedApplication()
	NSApp's setActivationPolicy:0 -- regular

	-- Fenster ~520x320
	set winRect to current application's NSMakeRect(0, 0, 520, 320)
	set styleMask to (1 + 2) -- titled + closable
	set theWindow to (current application's NSWindow's alloc())'s initWithContentRect:winRect styleMask:styleMask backing:2 defer:false
	theWindow's setTitle:"TranscribeForge — Einstellungen"
	theWindow's setLevel:(current application's NSFloatingWindowLevel)
	theWindow's |center|()

	set contentView to theWindow's contentView()

	-- Titel-Label
	set titleRect to current application's NSMakeRect(20, 275, 480, 26)
	set titleField to (current application's NSTextField's alloc())'s initWithFrame:titleRect
	titleField's setBezeled:false
	titleField's setDrawsBackground:false
	titleField's setEditable:false
	titleField's setSelectable:false
	titleField's setFont:(current application's NSFont's boldSystemFontOfSize:14)
	titleField's setStringValue:"Verarbeitungs-Preset wählen"
	(contentView's addSubview:titleField)

	-- Sub-Label (Video-Label + Dauer)
	set subRect to current application's NSMakeRect(20, 246, 480, 22)
	set subField to (current application's NSTextField's alloc())'s initWithFrame:subRect
	subField's setBezeled:false
	subField's setDrawsBackground:false
	subField's setEditable:false
	subField's setSelectable:false
	subField's setFont:(current application's NSFont's systemFontOfSize:12)
	subField's setTextColor:(current application's NSColor's secondaryLabelColor())
	subField's setStringValue:(videoLabel & "   —   " & my fmt1(durMin) & " min")
	(contentView's addSubview:subField)

	-- Hinweis-Label
	set hintRect to current application's NSMakeRect(20, 218, 480, 20)
	set hintField to (current application's NSTextField's alloc())'s initWithFrame:hintRect
	hintField's setBezeled:false
	hintField's setDrawsBackground:false
	hintField's setEditable:false
	hintField's setSelectable:false
	hintField's setFont:(current application's NSFont's systemFontOfSize:11)
	hintField's setTextColor:(current application's NSColor's tertiaryLabelColor())
	hintField's setStringValue:"Kostenschätzung pro Lauf (Whisper + Claude Frames + Summary):"
	(contentView's addSubview:hintField)

	-- Popup-Button mit 4 Presets
	set popupRect to current application's NSMakeRect(20, 170, 480, 30)
	set popup to (current application's NSPopUpButton's alloc())'s initWithFrame:popupRect pullsDown:false
	popup's addItemWithTitle:sparLabel
	popup's addItemWithTitle:stdLabel
	popup's addItemWithTitle:highLabel
	popup's addItemWithTitle:audioLabel
	popup's selectItemAtIndex:0 -- Default: Sparmodus
	(contentView's addSubview:popup)
	set my popupBtn to popup

	-- Info-Block: Erklärung der Presets
	set infoRect to current application's NSMakeRect(20, 70, 480, 90)
	set infoField to (current application's NSTextField's alloc())'s initWithFrame:infoRect
	infoField's setBezeled:false
	infoField's setDrawsBackground:false
	infoField's setEditable:false
	infoField's setSelectable:false
	infoField's setFont:(current application's NSFont's systemFontOfSize:11)
	infoField's setTextColor:(current application's NSColor's secondaryLabelColor())
	set infoText to "Sparmodus: weniger Frames, niedrigere Auflösung — günstig für Talking-Heads." & (ASCII character 10) & ¬
		"Standard: bisheriger Default — gute Balance für Slides/Bildschirm." & (ASCII character 10) & ¬
		"Hochauflösend: dichte Frames, volle Auflösung — für detailreiche Demos." & (ASCII character 10) & ¬
		"Audio only: keine Frame-Analyse — nur Whisper + Summary."
	infoField's setStringValue:infoText
	try
		(infoField's cell())'s setWraps:true
		(infoField's cell())'s setLineBreakMode:0
	end try
	(contentView's addSubview:infoField)

	-- Abbrechen-Button
	set cancelRect to current application's NSMakeRect(280, 18, 110, 32)
	set cancelBtn to (current application's NSButton's alloc())'s initWithFrame:cancelRect
	cancelBtn's setTitle:"Abbrechen"
	cancelBtn's setBezelStyle:1
	cancelBtn's setTarget:me
	cancelBtn's setAction:"cancelPressed:"
	cancelBtn's setKeyEquivalent:(character id 27) -- ESC
	(contentView's addSubview:cancelBtn)

	-- Starten-Button (Default)
	set okRect to current application's NSMakeRect(395, 18, 110, 32)
	set okBtn to (current application's NSButton's alloc())'s initWithFrame:okRect
	okBtn's setTitle:"Starten"
	okBtn's setBezelStyle:1
	okBtn's setTarget:me
	okBtn's setAction:"okPressed:"
	okBtn's setKeyEquivalent:return
	(contentView's addSubview:okBtn)

	theWindow's makeKeyAndOrderFront:(missing value)
	NSApp's activateIgnoringOtherApps:true
	try
		theWindow's makeFirstResponder:okBtn
	end try

	-- Event-Loop bis User entscheidet
	repeat
		set endDate to (current application's NSDate's dateWithTimeIntervalSinceNow:0.1)
		(current application's NSRunLoop's mainRunLoop()'s runUntilDate:endDate)
		if my userConfirmed then exit repeat
		if my userCancelled then exit repeat
		if not (theWindow's isVisible() as boolean) then
			set my userCancelled to true
			exit repeat
		end if
	end repeat

	try
		theWindow's |close|()
	end try

	if my userCancelled then
		NSApp's terminate:(missing value)
		error number 1
	end if

	-- Auswahl auswerten
	set selIdx to (popup's indexOfSelectedItem()) as integer
	set presetName to "sparmodus"
	set tfInterval to 6
	set tfWidth to 768
	set tfNoFrames to 0
	if selIdx is 0 then
		set presetName to "sparmodus"
		set tfInterval to 6
		set tfWidth to 768
		set tfNoFrames to 0
	else if selIdx is 1 then
		set presetName to "standard"
		set tfInterval to 3
		set tfWidth to 1280
		set tfNoFrames to 0
	else if selIdx is 2 then
		set presetName to "hochaufloesend"
		set tfInterval to 2
		set tfWidth to 1280
		set tfNoFrames to 0
	else if selIdx is 3 then
		set presetName to "audio_only"
		set tfInterval to 6
		set tfWidth to 768
		set tfNoFrames to 1
	end if

	set resultLine to "preset=" & presetName & "|interval=" & tfInterval & "|frame_width=" & tfWidth & "|no_frames=" & tfNoFrames

	-- Wenn ein Result-File übergeben wurde (.app-Bundle-Modus), Ergebnis dort
	-- ablegen, weil `open` keinen stdout durchreicht.
	if resultFile is not "" then
		try
			do shell script "/bin/echo " & quoted form of resultLine & " > " & quoted form of resultFile
		end try
	end if

	NSApp's terminate:(missing value)
	return resultLine
end run

on okPressed:sender
	set my userConfirmed to true
end okPressed:

on cancelPressed:sender
	set my userCancelled to true
end cancelPressed:

-- Launch-Arg an n-ter Stelle holen.
-- argv-Logik analog zu progress-window.applescript:
--  osascript-Aufruf: argv = {a,b,c} → item n
--  .app via open --args: argv = missing value → NSProcessInfo
--   processInfo's arguments() = {applet-Pfad, a, b, c} → item (n+1)
on readLaunchArg(argv, n)
	try
		if argv is not missing value then
			if (count of argv) ≥ n then
				return (item n of argv) as text
			end if
		end if
	end try
	try
		set procArgs to current application's NSProcessInfo's processInfo()'s arguments() as list
		if (count of procArgs) ≥ (n + 1) then
			return (item (n + 1) of procArgs) as text
		end if
	end try
	return ""
end readLaunchArg

-- Zahl mit 2 Nachkommastellen formatieren
on fmt2(n)
	set rounded to (round (n * 100)) / 100
	set s to rounded as text
	-- Falls Komma in deutscher Locale: durch Punkt ersetzen
	if s contains "," then
		set AppleScript's text item delimiters to ","
		set parts to text items of s
		set AppleScript's text item delimiters to "."
		set s to parts as text
		set AppleScript's text item delimiters to ""
	end if
	-- Auf 2 Nachkommastellen padden
	if s does not contain "." then
		set s to s & ".00"
	else
		set AppleScript's text item delimiters to "."
		set parts to text items of s
		set AppleScript's text item delimiters to ""
		set intPart to item 1 of parts
		set decPart to item 2 of parts
		if (length of decPart) is 1 then
			set decPart to decPart & "0"
		else if (length of decPart) > 2 then
			set decPart to text 1 thru 2 of decPart
		end if
		set s to intPart & "." & decPart
	end if
	return s
end fmt2

-- Zahl mit 1 Nachkommastelle formatieren
on fmt1(n)
	set rounded to (round (n * 10)) / 10
	set s to rounded as text
	if s contains "," then
		set AppleScript's text item delimiters to ","
		set parts to text items of s
		set AppleScript's text item delimiters to "."
		set s to parts as text
		set AppleScript's text item delimiters to ""
	end if
	if s does not contain "." then
		set s to s & ".0"
	end if
	return s
end fmt1
