# xrk-js

[![npm](https://img.shields.io/npm/v/aim-xrk.svg)](https://www.npmjs.com/package/aim-xrk)

Pure TypeScript parser for **AiM XRK/XRZ** motorsports telemetry files. Zero dependencies — runs in browsers, Node.js, Deno, and Bun. No AiM DLL required.

> npm package: **`aim-xrk`** &nbsp;·&nbsp; repository: `xrk-js`

XRK is the native log format of [AiM](https://www.aim-sportline.com/) data loggers (MXP, MXm, MXG, EVO, SoloDL, ...). Until recently the only way to read it was AiM's proprietary Windows-only `MatLabXRK` DLL. [libxrk](https://github.com/m3rlin45/libxrk) reverse-engineered the format into an open Python library; **xrk-js is a faithful TypeScript port of libxrk's parser**, cross-validated against it channel by channel on real logger files.

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

ESM only — use `import`, or `await import("aim-xrk")` from CommonJS.

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

## API

```ts
function parseXrk(input: Uint8Array | ArrayBuffer): XrkLog;
```

The whole file must be in memory. Parsing is synchronous and single-shot — see [Worker note](#browser-notes) for large files in a browser.

**Types** — `XrkLog`, `XrkChannel`, `XrkLap`, `SampleArray`:

```ts
interface XrkLog {
  channels: Record<string, XrkChannel>; // keyed by channel long name
  laps: XrkLap[];
  metadata: Record<string, unknown>;
}

interface XrkChannel {
  name: string;            // long name (same as the key)
  shortName: string;
  units: string;           // "" when the logger's unit code is unmapped
  decPts: number;          // display decimal places
  interpolate: boolean;    // true → interpolate on resample, false → step
  func: string;            // e.g. "Engine RPM"; "" when unmapped
  sourceType: number;
  sourceChannelId: number;
  deviceTag: string;       // "" for logger-native channels
  calValue1: number;       // reported, NOT applied to values
  calValue2: number;
  displayRangeMin: number;
  displayRangeMax: number;
  timecodes: Float64Array; // ms since session start
  values: SampleArray;     // Float64|Float32|Int32|Uint32|Int16|Uint16|Uint8 Array
}

interface XrkLap {
  num: number;       // 0-based
  startTime: number; // ms
  endTime: number;   // ms
}

type SampleArray =
  | Float64Array | Float32Array | Int32Array
  | Uint32Array | Int16Array | Uint16Array | Uint8Array;
```

**Also exported** (utilities, mostly useful for tooling around the format):

| Export | Signature | Purpose |
| --- | --- | --- |
| `isZlib` | `(data: Uint8Array) => boolean` | Detect an XRZ (zlib) container |
| `decompressIfZlib` | `(data: Uint8Array) => Uint8Array` | Inflate XRZ, or pass through XRK |
| `lla2ecef` | `(latDeg, lonDeg, alt) => [x, y, z]` | WGS84 geodetic → ECEF, metres |
| `ecef2lla` | `(x, y, z) => [latDeg, lonDeg, alt]` | ECEF → geodetic (Vermeille 2003) |
| `tokdec` | `(s: string) => number` | ASCII message token → uint32 |
| `tokenc` | `(i: number) => string` | uint32 → ASCII message token |
| `GPS_CHANNEL_NAMES` | `readonly string[]` | The 12 GPS channel names, in output order |

All GPS channels share a single timecode array, so their sample indices line up with each other.

## Real-world data gotchas

Parsing an XRK correctly is not the same as getting trustworthy numbers out of it. The notes below come from running this library over real race sessions — a 14 MB, 43-channel AiM MXP log from a 2022 Yamaha R3 at Phillip Island. **Every issue here is a property of the logger and its sensors, not a parser bug**: the library faithfully reports what is in the file. Handling them is the caller's job.

### 1. Filter out partial laps before computing a "fastest lap"

`log.laps` is exactly what the logger recorded. That normally includes an **out-lap** starting wherever logging began and an **in-lap** ending when logging stopped. In the R3 session the first lap covered 202 m and the last 2409 m, against 4380–4409 m for the real laps — so an unfiltered `Math.min` over lap times picks the 202 m out-lap as the session best.

Filter by distance, not by time:

```ts
import { parseXrk, type XrkLog, type XrkLap, type XrkChannel } from "aim-xrk";

/** Distance in metres over [lap.startTime, lap.endTime), integrating GPS Speed (m/s). */
function lapDistance(log: XrkLog, lap: XrkLap): number {
  const ch = log.channels["GPS Speed"];
  if (!ch) return NaN;
  const t = ch.timecodes;
  const v = ch.values;
  let d = 0;
  for (let i = 1; i < t.length; i++) {
    if (t[i] <= lap.startTime || t[i - 1] >= lap.endTime) continue;
    d += ((v[i] + v[i - 1]) / 2) * ((t[i] - t[i - 1]) / 1000);
  }
  return d;
}

/** Laps within 5% of the median lap distance — drops out-laps and in-laps. */
function completeLaps(log: XrkLog): XrkLap[] {
  const scored = log.laps.map((lap) => ({ lap, d: lapDistance(log, lap) }));
  const sorted = scored.map((s) => s.d).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return scored.filter(({ d }) => d > median * 0.95).map(({ lap }) => lap);
}

const best = completeLaps(log)
  .map((l) => l.endTime - l.startTime)
  .sort((a, b) => a - b)[0];
```

### 2. Assume some channels are dead, and check before trusting one

A logger happily records channels that are not wired up, misconfigured, or reading a broken sensor. In the R3 log:

- the native `RPM` channel was **constant 0** while `OBDII_RPM` carried the real engine speed
- `Calculated_Gear` was **constant 0** (gear calculation not configured)
- `OBDII_SPD` maxed out at **1 km/h** — completely broken; road speed had to come from `GPS Speed`
- a suspension potentiometer channel had only **13 distinct values** across the whole session — a stuck or badly scaled sensor, not real travel

None of these are detectable from metadata. Screen channels before use:

```ts
function channelHealth(ch: XrkChannel) {
  const v = ch.values;
  let min = Infinity;
  let max = -Infinity;
  const distinct = new Set<number>();
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as number;
    if (x < min) min = x;
    if (x > max) max = x;
    if (distinct.size < 64) distinct.add(x);
  }
  return {
    n: v.length,
    min,
    max,
    distinct: distinct.size,          // <= a few → quantised or stuck
    dead: v.length === 0 || min === max, // never moved
  };
}
```

This is routine, not exotic: the two fixtures committed to this repo contain 7 and 3 permanently-constant channels respectively (`External Voltage`, several `* Alarm_*` channels, `GPS_Fix`, `Prev Lap Diff`, ...). Prefer a redundant source when you have one (`GPS Speed` over `OBDII_SPD`, `OBDII_RPM` over a dead native `RPM`), and log which source you picked.

### 3. Gate GPS-derived work on fix quality

GPS drops out — under bridges, in pit garages, at the start of a session before the receiver has settled. Because the library reports the receiver's own quality fields, you can detect it precisely. In the R3 log the bad segments showed:

- `GPS_Position_Accuracy` up to **39 km**
- `GPS_pDOP` up to **99.99** — this is u-blox's "invalid / no solution" sentinel, not a real DOP
- `GPS_Yaw_Rate` pinned at **±4500 deg/s**

That last number is not sensor clipping, it is arithmetic. Yaw rate is a first difference of heading with the delta wrapped to (−180°, +180°], so the largest value it can ever produce is `180 / dt` — exactly 4500 deg/s at a 25 Hz fix rate. Values sitting at that bound mean the heading was garbage (the vehicle was stationary, or the fix was lost), not that the bike was spinning. `GPS_LateralAcc` is `speed × yaw_rate` and inherits the same artefact.

This is not specific to that session — it reproduces on the fixtures committed to this repo. `sfj_0101.xrz` logs GPS at 25 Hz and peaks at 4404 deg/s with `GPS_pDOP` hitting the same 99.99 sentinel and position accuracy reaching 4.6 km; `aim_official_test.xrk` logs at ~8 Hz (dt = 126 ms) and peaks at 1488 deg/s, right at its own `180 / dt` bound.

```ts
const pdop = log.channels["GPS_pDOP"];
const acc = log.channels["GPS_Position_Accuracy"];
// All GPS channels share one timebase, so indices are directly comparable.
const goodFix = (i: number) => pdop.values[i] < 5 && acc.values[i] < 10; // m
```

Apply that mask before map-matching, computing racing lines, or integrating GPS speed.

### 4. Sample rates are per-channel, and slightly under nominal

There is no single "log rate". Measured rates in the R3 session, by family:

| Family | Measured | Nominal |
| --- | --- | --- |
| Suspension pots | 195.44 Hz | 200 Hz |
| OBDII / ECU | 99.84 Hz | 100 Hz |
| IMU | 49.96 Hz | 50 Hz |
| GPS | 25.00 Hz | 25 Hz |
| `Brake_Press` | 19.54 Hz | 20 Hz |

Rates come out slightly under nominal because a few samples are dropped or de-duplicated by the logger — that is normal and not a parsing artefact. Nor is 25 Hz a safe assumption for GPS: the `aim_official_test.xrk` fixture in this repo logs GPS at roughly 8 Hz. Never assume two channels share a timebase; align them explicitly using each channel's own `timecodes`, and respect `interpolate` when you do (linear for analog sensors, step/forward-fill for status and gear channels).

### 5. Altitude is ellipsoidal

`GPS Altitude` is WGS84 ellipsoidal height with no geoid correction, so it will not match map elevation — the offset is tens of metres in most of the world. Elevation *changes* within a lap are still usable.

## In production

xrk-js is used as the ingest stage of a motorcycle track-data analysis pipeline. Representative figures from that use: a 14 MB, 43-channel AiM MXP race log (Phillip Island, 2022 Yamaha R3) parses in about 150 ms on Node 22, with all channels, the lap table and session metadata matching Race Studio's own view of the file.

## Accuracy

The test suite parses real XRK/XRZ files from MXP/MXm loggers (single-seaters, GT86 with 100 channels, karts, expansion modules with 500 Hz shock pots) and compares every channel against Python libxrk output: sample counts, NaN counts, first and last values, and sum/min/max at 1e-6 relative tolerance, for both values and timecodes — plus exact equality on laps and metadata. See `tests/golden.test.ts`.

Known limits (inherited from the reverse-engineered format spec):

- V2/V3 expansion messages (newer loggers): 99.97 % of samples match AiM's official DLL; the DLL applies a small proprietary smoothing that no open implementation replicates (see libxrk's spec notes)
- A few rarely-seen message fields remain unknown; unknown messages are skipped safely

## Limitations & known caveats

**[→ Full audit in `LIMITATIONS.md`](LIMITATIONS.md)**, with a source reference for every item. The ones most likely to bite you:

- **Partial laps are returned as-is.** `log.laps` includes out-laps and in-laps; filtering is your responsibility (see [gotchas](#1-filter-out-partial-laps-before-computing-a-fastest-lap)).
- **Channels with an unrecognised decoder byte are silently dropped** — they simply do not appear in `log.channels`, with no warning. If a channel you expect is missing, this is the first thing to check.
- **Corruption is absorbed silently.** The parser skips one byte and continues on any framing error (deliberate — it is what makes truncated files usable), but there is no error count or "bytes recovered" signal.
- **Calibrations are reported, not applied.** `calValue1/2` and `metadata.Calibrations` are passed through; `values` stay in raw logger units.
- **The gear lookup only covers N and gears 1–6**; a 7th gear reported as ASCII `'7'` decodes as 55.
- **Only 2 logger model IDs resolve to a name** (MXP 1.3, MXm). Key off `metadata["Logger Model ID"]`, which is always present.
- **The ~65533 ms GPS timing-bug fix can false-positive** on a genuine 60–70 s GPS dropout, and assumes a 25 Hz fix rate.
- **Memory: roughly 2–3× the uncompressed file size** is retained, and XRZ decompression pre-allocates 6× the *compressed* size up front.
- **ESM only, no CommonJS build, no writer.** Reading only.

### Browser notes

Parsing is synchronous, so a multi-megabyte file blocks the main thread for the whole parse and will freeze the UI. Run it in a Web Worker and transfer the results back — every array in `XrkLog` is a transferable typed array:

```ts
// worker.ts
import { parseXrk } from "aim-xrk";
self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  const log = parseXrk(new Uint8Array(e.data));
  self.postMessage(log); // structured clone; or collect .buffer refs to transfer
};
```

Watch peak memory on large `.xrz` files in particular — see `LIMITATIONS.md` §8.

## Development

```bash
npm install
npm test              # unit tests + golden tests on committed fixtures
npm run build         # emit dist/
npm run typecheck
```

`npm test` reports **10 passed / 5 skipped**. The 5 skips are the extended golden cases whose source files are too large to commit — they are skipped, not failing. To run them, point `XRK_TEST_DATA` at [libxrk](https://github.com/m3rlin45/libxrk)'s test corpus:

```bash
git clone https://github.com/m3rlin45/libxrk /tmp/libxrk
XRK_TEST_DATA=/tmp/libxrk/tests/test_data npm test   # → 15 passed
```

To regenerate golden JSON after a libxrk update:

```bash
python3 -m venv .venv && .venv/bin/pip install libxrk
.venv/bin/python scripts/make_golden.py file.xrk tests/fixtures/name.golden.json
```

## Credits & license

MIT. The wire format understanding comes from [libxrk](https://github.com/m3rlin45/libxrk) (MIT, Copyright 2024 Scott Smith) — this project is a TypeScript port of its Cython parser and executable format spec. Test fixtures originate from the libxrk repository.

Related projects: [libxrk](https://github.com/m3rlin45/libxrk) (Python original), [Aim_2_MoTeC](https://github.com/ludovicb1239/Aim_2_MoTeC) (Windows AiM→MoTeC converter).
