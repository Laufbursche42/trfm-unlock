'use strict';

// Every visible string of the page, in both languages. The keys match the data-t
// attributes in index.html and the t() lookups in app.js, so a missing entry shows
// up as an empty element instead of silently falling back to the other language.
// German is the default; the switcher sits in the header.
//
// The log stays English in both languages: ota.js writes into the same log and must
// not be touched, so a mixed-language transcript is worse than one language.
window.I18N = {
  de: {
    pageTitle: "Laufbursche Fighter Mini (eKFV) entsperren",
    brandSub: "Fighter Mini (eKFV) entsperren",
    langGroup: "Sprache",
    sub: "Live sperren und entsperren über Web Bluetooth. Läuft in Bluefy (iOS) oder Chrome (Android/Desktop).",

    s1Title: "So fängst du an",
    startHintGuide: "Neu hier? In der <a href=\"GUIDE.de.md\" data-doc=\"GUIDE\" data-t=\"footGuide\">Anleitung</a> steht jeder Schritt.",

    s2Title: "Steuerung",
    btnConnect: "Verbinden",
    btnDisconnect: "Trennen",
    btnUnlock: "Entsperren",
    btnLock: "Sperren",
    btnReading: "liest...",
    controlsHint: "Der Button zeigt die Aktion zum aktuellen Zustand, live vom Scooter gelesen: <b>Entsperren</b>, wenn er gesperrt ist, <b>Sperren</b>, wenn er offen ist. Beides schaltet die Geschwindigkeitssperre direkt über BLE (Befehl 0x1B).",

    tileWheel: "Rad",
    tileCruise: "Tempomat",
    rowSwVer: "Firmware-Version:",
    rowFwVer: "Laufbursche-Version:",
    cruiseOff: "Aus",
    cruiseAuto: "Auto",
    cruiseManual: "Manuell",

    s3Title: "Einstellungen",
    lblWheel: "Raddurchmesser",
    phWheel: "erst verbinden",
    btnSetWheel: "Rad setzen",
    lblCruise: "Tempomat",
    btnSetCruise: "Tempomat setzen",
    settingsHint: "Beide Werte merkt sich der Browser auf diesem Gerät. Nach jedem Entsperren schreibt die Seite sie von selbst wieder in den Scooter, du musst sie also nur einmal eintragen.",
    tipWheelLocked: "Entsperre den Scooter, um die Radgröße zu ändern",
    tipCruiseLocked: "Entsperre den Scooter, um den Tempomat zu ändern",

    s4Title: "Firmware flashen",
    flashHint: "Wähle eine Firmware-Datei, prüfe die Meldung dazu und flashe dann. Der Scooter muss den ganzen Lauf über an und in Reichweite bleiben, etwa sieben Minuten.",
    btnPick: "Datei wählen",
    btnFlash: "Flashen",
    btnCancel: "Abbrechen",
    flashDanger: "<b>Brich einen laufenden Flash nicht ab.</b> Lass den Scooter an, lass diese Seite offen und bleib in Reichweite. Ein Flash, der auf halbem Weg stehen bleibt, hinterlässt einen Scooter, der nicht fährt, bis ein Flash vollständig durchläuft. Ein neuer Flash holt ihn zurück.",
    flashHw: "<b>Hardware:</b> nur für die <b>IVCU-Hardware-Version 5.x</b>. Nicht für die \"Ali-Box\".",

    fwOkVcu: "Controller-Firmware angenommen",
    fwOkBms: "Batterie-Firmware angenommen",
    fwBad: "Diese Datei lässt sich nicht flashen",
    fwReadFail: "Die Datei konnte nicht gelesen werden",
    fwVersion: "Version",
    fwBytes: "Bytes",
    fwPackets: "Pakete",
    fwDone: "Fertig. Schalte den Scooter aus und wieder ein.",
    fwStopped: "Abgebrochen in {phase}: {msg}",
    progPacket: "Paket {n}/{m}, {phase}",
    // Keyed by the phase strings ota.js and app.js report, so an unknown phase falls
    // through to its raw name instead of showing nothing.
    phase: {
      preparing: "wird vorbereitet",
      sending: "senden",
      "packet data": "Paketdaten",
      done: "fertig",
      prepare: "Vorbereitung",
      START: "Start",
      INFO: "Info",
      PACKINFO: "Paketinfo",
      PACKDATA: "Paketdaten",
      FINISH: "Abschluss"
    },
    // Keyed by the result messages ota.js hands to finished(). The two with packet
    // numbers are matched by pattern, the rest verbatim.
    msg: {
      cancelled: "abgebrochen",
      "firmware updated": "Firmware aktualisiert",
      "the scooter disconnected": "der Scooter hat die Verbindung getrennt",
      "the update timed out after 30 minutes": "der Lauf ist nach 30 Minuten abgelaufen",
      "no response to the update request. Is the scooter on and in range?": "keine Antwort auf die Update-Anfrage. Ist der Scooter an und in Reichweite?",
      "CRC error, upgrade failure": "CRC-Fehler, das Update ist gescheitert",
      "timeout error": "Zeitüberschreitung",
      "the upgrade failed": "das Update ist gescheitert",
      packetFailed: "Paket {n}/{m} ist mehrfach fehlgeschlagen",
      packetNoAnswer: "Paket {n}/{m} antwortet nicht. Ist der Scooter an und in Reichweite?"
    },

    s5Title: "Verknüpfung auf dem Startbildschirm (iOS / Android)",
    shortcutIos: "<b>iOS (Bluefy)</b>: App Kurzbefehle -&gt; neuer Kurzbefehl -&gt; Aktion <b>URLs öffnen</b> -&gt; einen Link von unten einsetzen -&gt; zum Startbildschirm hinzufügen (oder als Siri-Satz). Ein einfacher <code>https</code>-Link öffnet Safari, das kein Bluetooth hat. Das Schema <code>bluefy://</code> öffnet Bluefy.",
    shortcutAndroid: "<b>Android (Chrome)</b>: einen Link von unten in Chrome öffnen -&gt; Menü -&gt; <b>Zum Startbildschirm hinzufügen</b>. Web Bluetooth ist eingebaut, das Symbol öffnet also direkt die Seite.",
    shortcutNote: "Der Scooter muss an und in Reichweite sein. Der allererste Besuch braucht weiterhin das einmalige <b>Verbinden</b> mit der Auswahl des Browsers (Sicherheitsregel des Browsers).",

    s6Title: "Protokoll",

    footGuide: "Anleitung",
    footSource: "Quellcode",
    footDisclaimer: "Haftungsausschluss",
    footLicense: "Lizenz",
    footPrivacy: "Datenschutz",
    footTrademarks: "Marken",
    buildLabel: "Build",
    docClose: "Schließen",
    docLoading: "wird geladen ...",
    docFail: "Das Dokument konnte nicht geladen werden.",
    docEnglish: "(englisch)",

    discLede: "Dieses Werkzeug ist ein freies Gemeinschaftsprojekt und steht in keiner Verbindung zu Teverun. Bitte lies diese Punkte, bevor du es benutzt.",
    discPoints: [
      "<b>Betriebserlaubnis:</b> Ein entsperrter Scooter fährt schneller, als seine Betriebserlaubnis zulässt. Damit erlischt sie und mit ihr in aller Regel der Versicherungsschutz. Bei einem Unfall haftest du persönlich, auch gegenüber Dritten.",
      "<b>Öffentlicher Verkehr:</b> Wir raten dringend davon ab, entsperrt außerhalb von Privatgelände zu fahren. Was bei dir erlaubt ist, musst du selbst prüfen.",
      "<b>Du wählst die Firmware.</b> Diese Seite prüft nur Aufbau, Prüfsumme und Zieladresse der Datei. Was eine Firmware im Fahrbetrieb tut, kann sie nicht wissen. Das gilt auch für eine Datei, die du mit unserem Patcher gebaut hast.",
      "<b>Flashen kann schiefgehen.</b> Ein abgebrochener Flash hinterlässt einen Scooter, der nicht fährt, bis ein Flash vollständig durchläuft.",
      "<b>Gewährleistung:</b> Hersteller und Händler können jede Gewährleistung ablehnen, sobald die Firmware verändert wurde.",
      "<b>Keine Zusagen:</b> Wir versprechen nicht, dass diese Seite mit deinem Gerät, deinem Browser oder deinem Scooter funktioniert.",
      "<b>Haftung:</b> Für Schäden an Fahrzeug, Personen oder Dritten, die durch oder mit dieser Seite entstehen, übernehmen wir keine Haftung, soweit gesetzlich zulässig. Die Nutzung erfolgt auf eigenes Risiko."
    ],
    dlgTitle: "Lies das, bevor du flashst",
    dlgFile: "Geflasht wird: {name}, Version {version}, {bytes} Bytes, {packets} Pakete.",
    dlgPoints: [
      "<b>Du hast diese Datei ausgewählt.</b> Geprüft werden nur Aufbau, Prüfsumme und Zieladresse. Was die Firmware im Fahrbetrieb tut, weiß diese Seite nicht.",
      "<b>Eine gepatchte Firmware beendet die Betriebserlaubnis</b> und damit den Versicherungsschutz.",
      "<b>Nicht abbrechen.</b> Lass den Scooter an, lass diese Seite offen und bleib etwa sieben Minuten in Reichweite.",
      "<b>Ein abgebrochener Flash hinterlässt einen Scooter, der nicht fährt</b>, bis ein Flash vollständig durchläuft. Ein neuer Flash holt ihn zurück.",
      "<b>Haftung:</b> Für Schäden durch oder mit dieser Firmware übernehmen wir keine Haftung, soweit das Gesetz es zulässt. Die Nutzung erfolgt auf eigenes Risiko."
    ],
    dlgConsent: "Ich habe den Haftungsausschluss gelesen und flashe auf eigene Gefahr.",
    dlgNo: "Abbrechen",
    dlgYes: "Verstanden, flashen"
  },

  en: {
    pageTitle: "Laufbursche Fighter Mini (eKFV) unlock",
    brandSub: "Fighter Mini (eKFV) unlock",
    langGroup: "Language",
    sub: "Live lock and unlock over Web Bluetooth. Works in Bluefy (iOS) or Chrome (Android/desktop).",

    s1Title: "How to start",
    startHintGuide: "New here? Every step is in the <a href=\"GUIDE.en.md\" data-doc=\"GUIDE\" data-t=\"footGuide\">guide</a>.",

    s2Title: "Controls",
    btnConnect: "Connect",
    btnDisconnect: "Disconnect",
    btnUnlock: "Unlock",
    btnLock: "Lock",
    btnReading: "reading...",
    controlsHint: "The button shows the action for the current state, read live from the scooter: <b>Unlock</b> when it is locked, <b>Lock</b> when it is open. Both switch the speed lock directly over BLE (cmd 0x1B).",

    tileWheel: "Wheel",
    tileCruise: "Cruise",
    rowSwVer: "Firmware version:",
    rowFwVer: "Laufbursche version:",
    cruiseOff: "Off",
    cruiseAuto: "Auto",
    cruiseManual: "Manual",

    s3Title: "Settings",
    lblWheel: "Wheel diameter",
    phWheel: "connect first",
    btnSetWheel: "Set wheel",
    lblCruise: "Cruise",
    btnSetCruise: "Set cruise",
    settingsHint: "The browser remembers both values on this device. After every unlock the page writes them back into the scooter by itself, so you only enter them once.",
    tipWheelLocked: "Unlock the scooter to change the wheel size",
    tipCruiseLocked: "Unlock the scooter to change cruise control",

    s4Title: "Flash firmware",
    flashHint: "Pick a firmware file, read what the page says about it and then flash. The scooter must stay on and in range for the whole run, about seven minutes.",
    btnPick: "Choose file",
    btnFlash: "Flash",
    btnCancel: "Cancel",
    flashDanger: "<b>Do not interrupt a running flash.</b> Keep the scooter on, keep this page open and stay in range. A flash that stops halfway leaves a scooter that will not run until a flash completes. Flashing again recovers it.",
    flashHw: "<b>Hardware:</b> for the <b>IVCU hardware version 5.x</b> only. Not for the \"Ali box\".",

    fwOkVcu: "Controller firmware accepted",
    fwOkBms: "Battery firmware accepted",
    fwBad: "This file cannot be flashed",
    fwReadFail: "The file could not be read",
    fwVersion: "version",
    fwBytes: "bytes",
    fwPackets: "packets",
    fwDone: "Done. Switch the scooter off and on again.",
    fwStopped: "Stopped in {phase}: {msg}",
    progPacket: "packet {n}/{m}, {phase}",
    phase: {
      preparing: "preparing",
      sending: "sending",
      "packet data": "packet data",
      done: "done",
      prepare: "prepare",
      START: "start",
      INFO: "info",
      PACKINFO: "packet info",
      PACKDATA: "packet data",
      FINISH: "finish"
    },
    msg: {
      cancelled: "cancelled",
      "firmware updated": "firmware updated",
      "the scooter disconnected": "the scooter disconnected",
      "the update timed out after 30 minutes": "the update timed out after 30 minutes",
      "no response to the update request. Is the scooter on and in range?": "no response to the update request. Is the scooter on and in range?",
      "CRC error, upgrade failure": "CRC error, the upgrade failed",
      "timeout error": "timeout error",
      "the upgrade failed": "the upgrade failed",
      packetFailed: "packet {n}/{m} failed repeatedly",
      packetNoAnswer: "packet {n}/{m} got no response. Is the scooter on and in range?"
    },

    s5Title: "Home-screen shortcut (iOS / Android)",
    shortcutIos: "<b>iOS (Bluefy)</b>: Shortcuts app -&gt; new shortcut -&gt; action <b>Open URLs</b> -&gt; paste a link below -&gt; add it to the home screen (or a Siri phrase). A plain <code>https</code> link opens Safari, which has no Bluetooth. The <code>bluefy://</code> scheme opens Bluefy.",
    shortcutAndroid: "<b>Android (Chrome)</b>: open a link below in Chrome -&gt; menu -&gt; <b>Add to Home screen</b>. Web Bluetooth is built in, so the icon opens straight into the page.",
    shortcutNote: "The scooter must be on and in range. The first-ever visit still needs the one-time <b>Connect</b> with the browser's picker (browser security).",

    s6Title: "Log",

    footGuide: "Guide",
    footSource: "Source",
    footDisclaimer: "Disclaimer",
    footLicense: "License",
    footPrivacy: "Privacy",
    footTrademarks: "Trademarks",
    docClose: "Close",
    docLoading: "loading ...",
    docFail: "The document could not be loaded.",
    docEnglish: "(English)",
    buildLabel: "build",

    discLede: "This tool is a free community project with no connection to Teverun. Please read these points before you use it.",
    discPoints: [
      "<b>Road approval:</b> An unlocked scooter runs faster than its type approval allows. That approval is void and with it, as a rule, your insurance cover. In an accident you are personally liable, including towards third parties.",
      "<b>Public roads:</b> We strongly advise against riding unlocked anywhere but on private property. What is allowed where you live is yours to check.",
      "<b>You pick the firmware.</b> This page only checks the structure, the checksum and the target address of the file. What a firmware does out on the road is beyond it. That holds for a file built with our own patcher as well.",
      "<b>Flashing can fail.</b> An interrupted flash leaves a scooter that will not run until a flash completes.",
      "<b>Warranty:</b> The manufacturer and your dealer can refuse any warranty claim once the firmware has been changed.",
      "<b>No promises:</b> We do not promise that this page works with your device, your browser or your scooter.",
      "<b>Liability:</b> To the extent the law allows, we accept no liability for damage to the vehicle, to people or to third parties caused by or with this page. You use it at your own risk."
    ],
    dlgTitle: "Read this before you flash",
    dlgFile: "About to flash: {name}, version {version}, {bytes} bytes, {packets} packets.",
    dlgPoints: [
      "<b>You picked this file.</b> Only its structure, its checksum and its target address are checked. What the firmware does out on the road is unknown to this page.",
      "<b>A patched firmware ends the road approval</b> and with it your insurance cover.",
      "<b>Do not interrupt.</b> Keep the scooter on, keep this page open and stay in range for about seven minutes.",
      "<b>An interrupted flash leaves a scooter that will not run</b> until a flash completes. Flashing again recovers it.",
      "<b>Liability:</b> for damage caused by or with this firmware we accept no liability, as far as the law allows. Use at your own risk."
    ],
    dlgConsent: "I have read the disclaimer and I flash at my own risk.",
    dlgNo: "Cancel",
    dlgYes: "I understand, flash"
  }
};
