# Axon Servo Programmer for macOS

An unofficial Mac app for programming **Axon servos** with the Axon USB programmer.

> Not affiliated with or endorsed by Axon. Written from scratch by studying how the official Windows tool (v1.0.5) talks to the programmer.

## Features
- Read and write every setting from the Windows tool: Range, Neutral, Sensitivity, Inversion, Max Power, Damping, Soft Start, PPM Range, Narrow Band / Sanwa SSR, Lost-PPM behaviour, Overload Protection levels
- Shows exactly what will change before writing, then reads the servo back to verify
- Automatic backup every time a servo is read, with one-click restore
- Save and load profiles to set up a whole robot the same way
- Demo mode to try it without hardware
- Light and dark mode

Firmware updating is intentionally **not** included.

## Install
1. Download the `.dmg` from [Releases](../../releases).
2. Drag the app into **Applications**.
3. The app isn't notarised by Apple, so the first time run this in Terminal:
   ```
   xattr -cr "/Applications/Axon Servo Programmer.app" && codesign --force --deep --sign - "/Applications/Axon Servo Programmer.app"
   ```

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
- `scripts/mkudzo.py` – builds a compressed `.dmg` on Linux
