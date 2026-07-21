# Teverun Fighter Mini (eKFV) Unlock

A web app that connects a Teverun Fighter Mini (eKFV) over Web Bluetooth and live-toggles the speed lock, sets the wheel diameter and turns cruise on/off - straight from the browser, with nothing to install: no App Store, no signing, no developer account. It brings the core of the Android Laufbursche Edition (live-toggle plus wheel diameter plus cruise) to a plain web page.

It works on both platforms:

- **iOS:** in the **Bluefy** browser (free, App Store). Safari and every other iOS browser cannot do Web Bluetooth - Apple forces them all onto the Safari engine, so Bluefy is the one that works.
- **Android / desktop:** in **Chrome** (or another Chromium browser) - Web Bluetooth is built in, no extra browser needed.

---

## What you need

- A browser with Web Bluetooth: **Bluefy** on iOS, **Chrome** on Android or desktop (see above).
- A **Teverun Fighter Mini (eKFV)** running VCU firmware **R5.4.19**, with the unlock firmware flashed once (steps below). The firmware you flash is that same R5.4.19 with the unlock patches applied - it is the same version, just patched.

---

## How to use it

### 1. Open the page
Open **https://laufbursche42.github.io/trfm-unlock/** in Bluefy (iOS) or Chrome (Android / desktop).

### 2. Get the firmware and flash it (one time)
On the page, tap **Download firmware** to get `AWIVCU_PATCHED_R5_4_19.hex`, then flash it **once with the official Teverun app**, the same way you flash any firmware update. You only do this once per scooter.

**Do not rename the file.** The Teverun app validates the name when flashing (the third underscore group must be `R5`, whose last character is the major version). A made-up name is rejected.

What the firmware contains - three patches, applied by the tested Laufbursche Edition patcher. It checks every byte it changes against the expected original, so it only patches a genuine R5.4.19 and cannot corrupt the wrong file; the correct 5.4.19 version marker and CRC are kept intact:

- **Live-toggle** - on the eKFV the speed clamp is driven by a flag = *(identity starts with `TDE`)* **OR** *(a bit the eKFV display always sends)*. This patch removes the display half, so from then on the **FIN/identity alone** is the switch: FIN with `TDE` = 22 km/h locked, FIN without it = open (full speed plus kickstart plus cruise). That is what this web app flips live over Bluetooth - no reflashing to lock or unlock.
- **Blinker fix** - on R5.4.19 an extra reset makes the turn signals stay lit instead of blinking; the patch removes it so they blink again.
- **Wheel-diameter fix** - R5.4.19's settings handler drops the wheel-size value the app sends (and a boot step resets it to 10). The patch restores it and makes it survive a reboot, so the wheel diameter you set actually sticks.

### 3. Connect and control
1. **Connect** - tap your scooter in the chooser.
2. The page reads the state from the FIN / BLE name (`TDE...` = locked).
3. **Unlock** - removes the `DE` from the FIN. The scooter is then open; wheel diameter and cruise are re-applied automatically after the reconnect.
4. **Lock** - adds the `DE` back, forces the wheel diameter to 10 and turns cruise off.
5. **Wheel diameter / cruise** - editable only after connecting; remembered locally in the browser and written back automatically on unlock.

The Bluetooth link runs entirely locally between the phone/PC and the scooter. When the page is served from GitHub Pages, GitHub only sees the page load (your IP), never the Bluetooth data. See [PRIVACY.md](PRIVACY.md) for exactly who sees what, when and where.

---

## Things to be aware of

**iOS**
- Always open it in **Bluefy**; do not add it to the home screen - that opens the Safari engine, which has no Bluetooth.

**Android / desktop**
- Just open it in Chrome (or another Chromium browser) - nothing special to watch out for.

**Both platforms**
- **No background operation.** The link only lives while the browser tab is open and in the foreground.
- **Reconnect only within the session.** After closing the browser you scan again.
- **The FIN field is an emergency fallback.** Lock/unlock is done with the buttons. Never edit the FIN by hand (other than the DE) - a wrong identity breaks the live-toggle (recoverable by typing the correct FIN back).

---

## Drawbacks versus the native Android app

The native Android app is the **Laufbursche Edition** ([github.com/Laufbursche42/tr-lb-edition](https://github.com/Laufbursche42/tr-lb-edition)). Compared to it, this web app has a few limits:

- GitHub (not the author) sees your IP when the page loads.
- You need the official Teverun app to flash the firmware.
- None of the Laufbursche Edition extras (navigation, ride logger, SRT, etc.).

---

## Who sees which data, and when?

In short: apart from your IP address when the page loads, nobody sees anything.

- **GitHub - only when the page loads/reloads:** sees your **IP address** and which file you request (the normal web-server logs every website has). This happens once, on open. GitHub sees **no** scooter data, no telemetry, no settings and no FIN.
- **The Bluetooth link (device <-> scooter) - during use:** telemetry, FIN, gears, wheel diameter, cruise and the lock/unlock commands run **entirely locally** over Web Bluetooth between your browser and the scooter. This data **never** leaves your device. No server, no backend, no GitHub sees it.
- **Your browser (local) - stored persistently:** wheel diameter and cruise live in `localStorage` (only on your device, for the automatic restore on unlock). Nothing is uploaded anywhere.
- **The author / anyone else:** gets **nothing**. No tracking, no analytics, no cookies, no network requests other than the one-time load of the static files from GitHub.
- **For comparison:** the original Teverun app uploads GPS, rides and error codes to the manufacturer backend. This web app does none of that.

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

---

## Disclaimer

**Please read in full.**

- This firmware and this web app **remove the speed limiter** of an eKFV. Once the limiter is removed, the vehicle is **no longer a road-legal eKFV** under the German eKFV regulation and the StVZO.
- **After unlocking, the scooter may only be ridden on private property or on closed, non-public grounds.** Using it in public traffic (roads, cycle paths, public spaces) is **illegal**.
- Depending on the speed you unlock, the vehicle would fall into a higher legal class that requires a **matching driver's license** (for example a Mofa test certificate, an AM moped license or a motorcycle license) - but since it has **no operating permit** it cannot be registered or insured for public roads at all.
- Unlocking **voids** the operating permit (Betriebserlaubnis), any **insurance cover** and the manufacturer warranty. A derestricted vehicle has **no valid insurance**.
- Operating a derestricted vehicle in public traffic is a **criminal offence** (driving without an operating permit and without insurance) and you are fully liable yourself.
- **Flashing firmware can brick the device.** This is done at your own risk.
- The firmware is intended solely for the Teverun Fighter Mini (eKFV) with VCU **R5.4.19**. On other hardware it can cause damage.
- Use is entirely at **your own risk**. The author accepts **no liability** for damage to the device, to persons or to third parties, for fines, legal consequences or any other disadvantage.
- There is **no warranty** of function, correctness or fitness for a particular purpose.

By flashing the firmware and using this page you agree to these terms.

---

## Technical notes

- Pure static page (`index.html` plus `app.js`), Web Bluetooth. The BLE core is ported 1:1 from the Laufbursche Edition (`CommandBuilder` / `SettingsState` / `FrameParser`); the CRC-8 is verified bit-exact against the native version.
- Host on GitHub Pages (which provides the HTTPS that Web Bluetooth requires, for free). Put the files in the repo, enable Pages, open the URL.
- No firmware flashing from the web app (deliberately) - flashing runs through the stable official app.

## Security (development)

Hardened as much as possible even for a static page:

- **No backend, no server code** - no server attack surface (no SQLi, no SSRF).
- **All dynamic data via `textContent`** (never `innerHTML`/`eval`/`document.write`) - no DOM-XSS.
- **Strict Content-Security-Policy** (only `self`, no external script/style/image, no `fetch`/`iframe`).
- **Zero runtime dependencies** (pure vanilla JS) - no supply-chain attack surface, no Dependabot needed.
- **Git hooks** (enable after cloning with `git config core.hooksPath .githooks`):
  - `pre-commit`: normalizes Unicode dashes to ASCII, checks syntax (JS/HTML/JSON), scans the staged content for secrets/credentials and Windows home paths, checks against an **out-of-tree** personal-data blocklist (`.git/tr-personal-blocklist.txt`, never committed) and runs the web security scanner (`scripts/security-scan.py`).
  - `pre-push`: full security scan over the whole tree as a final gate.
- **CI (GitHub Actions):** the same scanner (`.github/workflows/ci.yml`) plus **GitHub CodeQL** (`.github/workflows/codeql.yml`, `security-extended`) on every push and pull request - runs automatically once the repo is on GitHub.

## License, privacy, trademarks

- **License:** CC BY-NC-ND 4.0 - viewing and private use yes, no published forks, no commercial use. Details in [license.md](license.md).
- **Privacy:** [PRIVACY.md](PRIVACY.md) - nothing leaves your device but the page load.
- **Trademarks:** [TRADEMARKS.md](TRADEMARKS.md) - independent project, not affiliated with Teverun.
