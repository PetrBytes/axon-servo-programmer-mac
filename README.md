# Axon Servo Programmer for macOS

An unofficial Mac app for programming **Axon servos** with the Axon USB programmer.

> **Pre-release.** This is early software that has been tested against a simulated servo but only lightly on real hardware. Please read the [disclaimer](#disclaimer) before using it.

Axon servos are popular in FIRST Tech Challenge (FTC) because they are strong, programmable and report their position through a fourth feedback wire. The catch is that Axon's programming software only runs on Windows, so teams working on MacBooks end up borrowing a school laptop or a teammate's PC just to change a range or flip a servo's direction before a match. This app lets FTC teams (and anyone else using Axon servos) do all of that on a Mac: plug in the programmer, adjust settings like Range, Sensitivity and Inversion, and write them in seconds. The setting names match the Windows software, so existing team guides and tutorials still make sense.

> Not affiliated with or endorsed by Axon or *FIRST*. Written from scratch by studying how the official Windows tool (v1.0.5) talks to the programmer.

## Features
- Every setting from the Windows tool, using the same names (see table below)
- Detects the programmer and servo being plugged in or out, and reads the servo automatically, like the Windows tool
- Shows exactly what will change before writing, then reads the servo back to verify
- Automatic backup every time a servo is read, with one-click restore
- Save and load profiles to set up a whole robot the same way
- Activity log in the sidebar, kept until you clear it (⌘L to show/hide)
- Settings (⌘,): theme, log, cache and backup management
- Demo mode to try it without hardware

## Setting names (Windows → Mac)
| Windows | Mac app | Notes |
|---|---|---|
| Range / Servo Angle | Range | 1–255 |
| Middle Position / Servo Neutral | Middle Position | −127…127 |
| Sensitivity (Deadband) | Sensitivity | Ultra High / High / Medium / Low |
| Max Power / PWM Power % | Max Power | 100–255, shown as % |
| Damping Factor | Damping Factor | 50–600 |
| PPM Range | PPM Range | 500~2500 / 900~2100 / 1100~1900 µs |
| Lose PPM Protection | Lose PPM Protection | Release / Keep Position / Go Neutral Position |
| Narrow Band, SANWA SSR | Narrow Band, SANWA SSR | Rescale Range when toggled, like Windows |
| Inversion, Soft Start | Inversion, Soft Start | |
| Over Load Protection, Level 1–3 | Over Load Protection | PWM % and time per level |
| Default | Default (Factory) | |

Firmware updating is intentionally **not** included.

## Install
1. Download the `.dmg` from [Releases](../../releases) (Apple Silicon).
2. Drag the app into **Applications**.
3. The app isn't notarised by Apple, so the first time run this in Terminal:
   ```
   xattr -cr "/Applications/Axon Servo Programmer.app" && codesign --force --deep --sign - "/Applications/Axon Servo Programmer.app"
   ```

## Disclaimer
This software is provided **"as is", without warranty of any kind**. It is an independent, unofficial project and is not made, supported or endorsed by Axon. It was built by reverse engineering the official Windows tool and may contain mistakes, may not support every servo or programmer version, and may stop working if Axon changes their hardware or firmware.

By using it you accept that **you do so at your own risk**. The author and contributors are not responsible for any damage to servos, programmers, robots or other equipment, for lost settings, or for any other loss, including problems at competitions. Before relying on it:

- Check the values after every write (the app reads them back for you, but look before you compete).
- Keep the official Windows software available as a backup.
- Use **Restore Backup** or **Default (Factory)** if a servo behaves strangely.

If something doesn't work, please [open an issue](../../issues) rather than assuming it will be fixed.

## Build from source
```bash
npm install
npm start          # run the app
npm test           # protocol tests
npx @electron/packager . "Axon Servo Programmer" --platform=darwin --arch=arm64 \
  --icon=build/icon.icns --asar --out=dist --extend-info=build/extra.plist
```

## How it works
The programmer is a USB HID device (VID `0x0471`, PID `0x13AA`). Each exchange is a 64-byte report:

```
out: [0x04, cmd, addrHi, addrLo, len (<=59), data...]
in : [id, status, error, -, -, data...]
```

| Cmd | Meaning |
|-----|---------|
| `0x91` / `0x90` | Programmer status / init |
| `0x8A` | Identify servo (type + firmware) |
| `0xCD` | Read the 95-byte parameter block |
| `0xCB` | Write the parameter block |
| `0x5A` | Factory default |

The byte layout of the parameter block is documented in [`src/protocol.js`](src/protocol.js).

## Project layout
- `src/protocol.js` – protocol + parameter encoding, with a simulated servo for tests and demo mode
- `src/hid.js` – WebHID transport
- `src/app.js`, `src/index.html`, `src/styles.css` – interface
- `main.js`, `preload.js` – Electron main process
- `test/` – `node --test` suite
- `scripts/mkudzo.py` – builds a compressed `.dmg` on Linux (`zlib` or `bzip2`)

## Changelog
**1.1.0** – Windows setting names, Sensitivity labels, servo plug/unplug detection with auto-read, Narrow Band/SSR range rescaling, sidebar activity log that persists, Settings window (⌘,), new icon, button hover/press states, smaller DMG.

**1.0.0** – First version.
