# xrk-js

[![npm](https://img.shields.io/npm/v/aim-xrk.svg)](https://www.npmjs.com/package/aim-xrk)

Pure TypeScript parser for **AiM XRK/XRZ** motorsports telemetry files. Zero dependencies — runs in browsers, Node.js, Deno, and Bun. No AiM DLL required.

> npm package: **`aim-xrk`** &nbsp;·&nbsp; repository: `xrk-js`

XRK is the native log format of [AiM](https://www.aim-sportline.com/) data loggers (MXP, MXm, MXG, EVO, SoloDL, ...). Until recently the only way to read it was AiM's proprietary Windows-only `MatLabXRK` DLL. [libxrk](https://github.com/m3rlin45/libxrk) reverse-engineered the format into an open Python library; **xrk-js is a faithful TypeScript port of libxrk's parser**, cross-validated sample-by-sample against it on real logger files.

## Features

- Parses `.xrk` and `.xrz` (zlib-compressed, auto-decompressed — including truncated files from interrupted sessions)
- All logged channels with units, sample rates, and per-channel timecodes (S/G/M messages, grouped channels, expansion-device V1/V2/V3 messages, float16/gear/manual decoders)
- GPS: position (Vermeille ECEF→LLA), speed, altitude, satellites/fix/DOP/accuracy, derived inline/lateral acceleration and yaw rate
- Laps from LAP messages, with GPS start/finish-line cross-track detection as fallback
- Corrects the known AiM firmware GPS timing bug (~65533 ms 16-bit overflow jumps), using GNFI internal-clock messages when available
- Session metadata: driver, vehicle, venue, date/time, logger model/serial, GPS receiver, expansion devices, odometers, calibrations
- Fast: parses a 42 MB / 100-channel XRK in ~0.5 s (Node 22)

## Install

```bash
npm install aim-xrk
```

## Usage

```ts
import { parseXrk } from "aim-xrk";

// Node
import { readFileSync } from "node:fs";
const log = parseXrk(readFileSync("session.xrk"));

// Browser
const file = fileInput.files[0];
const log = parseXrk(new Uint8Array(await file.arrayBuffer()));

// Channels: name → { units, timecodes (ms), values, ... }
for (const [name, ch] of Object.entries(log.channels)) {
  console.log(name, ch.units, ch.values.length, "samples");
}
const rpm = log.channels["RPM"];
rpm.timecodes; // Float64Array, ms since session start
rpm.values;    // typed array of samples

// Laps (ms since session start)
log.laps; // [{ num: 0, startTime: 0, endTime: 95335 }, ...]

// Metadata
log.metadata; // { Driver, Vehicle, Venue, "Log Date", "Logger Model", ... }
```

Each channel keeps its **native sample rate** — timecodes are per-channel. Channels with `interpolate: true` (analog sensors) should be linearly interpolated when resampling; others (status/gear) should be stepped/forward-filled.

## Accuracy

The test suite parses real XRK/XRZ files from MXP/MXm loggers (single-seaters, GT86 with 100 channels, karts, expansion modules with 500 Hz shock pots) and compares every channel — sample counts, values, timecodes, laps, metadata — against Python libxrk output. See `tests/golden.test.ts`.

Known limits (inherited from the reverse-engineered format spec):

- V2/V3 expansion messages (newer loggers): 99.97 % of samples match AiM's official DLL; the DLL applies a small proprietary smoothing that no open implementation replicates (see libxrk's spec notes)
- A few rarely-seen message fields remain unknown; unknown messages are skipped safely

## Development

```bash
npm install
npm test              # unit tests + golden tests on committed fixtures
npm run build         # emit dist/
```

The extended golden suite runs against [libxrk](https://github.com/m3rlin45/libxrk)'s full test corpus:

```bash
git clone https://github.com/m3rlin45/libxrk /tmp/libxrk
python3 -m venv .venv && .venv/bin/pip install libxrk   # for regenerating goldens
XRK_TEST_DATA=/tmp/libxrk/tests/test_data npm test
```

To regenerate golden JSON after a libxrk update:

```bash
.venv/bin/python scripts/make_golden.py file.xrk tests/fixtures/name.golden.json
```

## Credits & license

MIT. The wire format understanding comes from [libxrk](https://github.com/m3rlin45/libxrk) (MIT, Copyright 2024 Scott Smith) — this project is a TypeScript port of its Cython parser and executable format spec. Test fixtures originate from the libxrk repository.

Related projects: [libxrk](https://github.com/m3rlin45/libxrk) (Python original), [Aim_2_MoTeC](https://github.com/ludovicb1239/Aim_2_MoTeC) (Windows AiM→MoTeC converter).
