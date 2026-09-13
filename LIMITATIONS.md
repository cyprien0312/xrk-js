# Limitations & known caveats

This document is an honest audit of what `aim-xrk` does **not** do, derived from
reading the source — not from speculation. It exists so you can decide up front
whether the library fits your pipeline, and so you are not surprised in
production.

Every item is tagged:

| Tag | Meaning |
| --- | --- |
| **[Design]** | Deliberate. Usually required for bit-parity with [libxrk](https://github.com/m3rlin45/libxrk) and AiM's official DLL. Changing it would be a regression. |
| **[Unimplemented]** | A real gap. PRs welcome. |
| **[Format]** | An upstream limit of the reverse-engineered XRK format itself. No open implementation can do better without new findings. |

Source references below point at the file and function that implements the
behaviour, so you can verify each claim.

---

## 1. Format coverage

**1.1 Unrecognised header messages are kept raw and never surfaced.**
`parseHeaderContent` (`src/parser.ts`) decodes a fixed set of tokens (`CHS`,
`GRP`, `CNF`, `ENF`, `LAP`, `TRK`, `ODO`, `CAL`, `idn`, `SRC`, `GPSR`, `iSLV`,
`RACM`, `VET`, `CDE`, plus ~20 string tokens). Anything else falls through to a
raw byte copy. Those raw messages are retained internally but the public
`XrkLog` type exposes only `channels`, `laps` and `metadata` — there is no
escape hatch to read them. **[Unimplemented]**

**1.2 Bad-byte recovery is silent and unreported.**
The framing loop wraps every message in `try { … } catch { pos = oldpos + 1 }`.
Any failure — checksum mismatch, unknown `(c` variant, unregistered channel
index, truncated frame — advances one byte and continues. This mirrors the
reference parser exactly and is what makes truncated files usable, but it means
**you get no signal about how much of a file failed to parse**. There is no
error counter, no warning callback, and no "bytes recovered" statistic. A file
that is 90 % garbage parses "successfully" with few channels. **[Design]** for
the recovery itself; the missing diagnostic is **[Unimplemented]**.

**1.3 Errors inside `CNF` config blocks are swallowed by the same mechanism.**
`parseHeaderContent` is invoked *inside* the try/catch, so the throws it raises
(`"CNF without CHS"`, `"Channel short_name mismatch"`, `"GRP references unknown
channel"`) do not propagate — they discard the entire config block and resume
one byte later. A subtly corrupt `CNF` therefore presents as missing channels
rather than as an error. **[Design]** (parity), but worth knowing.

**1.4 `Fuel*` odometer records are dropped.**
`parseHeaderContent`'s `ODO` branch skips any record whose name starts with
`Fuel`, because the unit mapping is unknown. Fuel-used counters are absent from
`metadata`. **[Format]**

**1.5 Only 2 of the observed logger model IDs resolve to a name.**
`LOGGER_MODELS` in `src/constants.ts` maps `649 → "MXP 1.3"` and
`793 → "MXm"`. The committed and extended test corpus alone contains model IDs
**519, 768 and 773**, all of which yield `metadata["Logger Model"] === null`.
`metadata["Logger Model ID"]` is always present — key off that, not off the
name. **[Unimplemented]**

**1.6 Unit and function tables are fixed lookups.**
`UNIT_MAP` has 23 entries and `FUNCTION_MAP` has 44. An unmapped
`unit_type` byte yields `units: ""` and `decPts: 0`; an unmapped
`(display_format, unit_type)` pair yields `func: ""`. Unit code 26 is mapped to
the literal string `"time?"` — that question mark is in the reference spec, not
a typo. **[Format]**

---

## 2. Channel decoding

**2.1 Channels with an unknown decoder byte are silently dropped.**
This is the most consequential caveat in the library. `decoderFor()` looks up
CHS byte `[20]` in `DECODERS` (21 known values). If there is no match,
`processChannel` returns immediately, the channel keeps `hasData: false`, and
`parseXrk` filters it out of the result. **The channel simply does not appear in
`log.channels`, with no error and no warning.** If a channel you expect is
missing, this is the first thing to suspect. **[Unimplemented]**

**2.2 The gear lookup only covers neutral and gears 1–6.**
`gearLookup()` in `src/channels.ts` maps ASCII `'N'` → 0 and `'1'`–`'6'` → 1–6.
Any other byte passes through unchanged, so a 7-speed gearbox reporting ASCII
`'7'` (0x37) decodes as the value **55**, not 7. Affects decoder type 15 only.
**[Unimplemented]**

**2.3 `Calculated_Gear` / `PreCalcGear` are limited to gears 0–7.**
The `calcGear` fixup computes `(x >> 16) & 7`, with bit 0x80000 forcing 0.
**[Design]** (matches the reference).

**2.4 The 64-bit `Q` sample type reads only the low 32 bits.**
Documented in `readStrided`: the only `Q` channels are
`Calculated_Gear`/`PreCalcGear`, whose fixup inspects bits 16–19. Correct today,
but a future `Q` channel carrying data in the high word would decode wrong.
**[Design]**, scoped narrowly.

**2.5 Calibrations are reported, never applied.**
`CAL` messages appear in `metadata["Calibrations"]` (cross-referenced to a
channel name via the CHS cal floats), and `calValue1`/`calValue2` are exposed on
each channel — but the library does **not** scale `values` by them. Raw logger
units are what you get. This matches libxrk. **[Design]**

**2.6 `interpolate` comes from the decoder table, not from the CHS record.**
`processChannel` overwrites `ch.interpolate = d.interpolate`. **[Design]**

**2.7 Channels are keyed by long name; duplicates overwrite.**
`log.channels` is a `Record<string, XrkChannel>` keyed on the CHS long name. Two
channels sharing a long name means the later one silently wins. **[Design]**

**2.8 `StrtRec` and `Master Clk` are always excluded** from the output
(`EXCLUDED_CHANNELS` in `src/index.ts`), for parity. **[Design]**

**2.9 The mV→V conversion is keyed on the unit string.**
`channels.ts` divides values by 1000 when `ch.units === "V"` (set when the unit
byte is 21 with the high bit set). Note that `toPublicChannel` then blanks the
unit string for 1-byte channels (`units: ch.size === 1 ? "" : ch.units`), so such
a channel can be reported with an **empty unit string even though the /1000
scaling was applied**. Parity-preserving, but surprising. **[Design]**

---

## 3. Expansion devices (V1 / V2 / V3 / V4 `(c` messages)

**3.1 Coverage.** V1 (`unk1=0, unk4=6`) is decoded directly into per-channel
rows. V2 long (`unk1=0, unk4=8`, two fp16 samples) and V3 short
(`unk1=1, unk4=2`, one fp16 sample) are buffered and resolved after the main
pass by `resolveV2V3`. V4 (`unk1=1, unk4=6`, see 3.6) likewise. Any other `(c`
variant throws and is skipped by bad-byte recovery. **[Design]**

**3.6 V4 partner messages (`unk1=1, unk4=6`) are decoded from an empirically
established layout — NOT from the reference parser.** Seen when analog inputs
are configured at 1 kHz (RaceStudio sampling-rate change, firmware 2026): each
V2 base message is immediately followed by a 14-byte partner carrying THREE
fp16 samples and **no timecode**. Burst layout oldest→newest:
`[V2.s1 @tc−4, q0 @tc−3, q1 @tc−2, q2 @tc−1, V2.s0 @tc]`.
The pyx reference predates this variant, so there is no parity oracle.
Evidence for the layout: (a) total-variation minimization over all 12 possible
layouts on real 1 kHz suspension data picks it on both suspension channels;
(b) it is the only layout consistent with the established V2 convention
(s0 = newest, s1 = oldest); (c) decoded rates (~976 Hz nominal 1 kHz) and value
ranges (rear shock 0–57 mm, fork −117–0 mm, brake −16–36 bar) are physically
plausible. The intra-burst timecodes (`tc−3/−2/−1` integer ms) are synthesized,
same class of approximation as V3's ±2 ms (see 3.4). **A RaceStudio CSV export
of the same session has NOT yet been diffed against this decoding** — do that
before trusting sub-millisecond timing. **[Format]** + heuristic.

**3.2 The V2/V3 → channel binding is a positional heuristic, not a format
field.** `resolveV2V3` pairs `channel_field` values by low nibble, collects
candidate channels filtered to `decoder byte == 20 && sourceType == 1 &&
hwId != 0`, splits them by nominal period (`Mms ≤ 5` → paired, `≤ 15` →
orphan), sorts both lists by `(hwRef, sourceChannelId, channelIndex)`, and then
**zips them positionally**. If the counts disagree, the surplus is discarded via
`Math.min(...)`. There is no explicit device→channel identifier in the format to
validate against. Mis-assignment on unusual hardware layouts is possible.
**[Format]** + heuristic.

**3.3 Only fp16 channels are eligible.** A channel whose decoder byte is not 20
is never considered a V2/V3 target. **[Design]**

**3.4 V3 timecodes are synthesised with a hardcoded ±2 ms step.**
The step is the nominal period of ~500 Hz shock pots. V3 streams at other rates
get wrong timecodes. This constant is deliberate parity with the reference.
**[Design]** / **[Format]**

**3.5 ~99.97 % sample agreement with AiM's official DLL on V2/V3 data.**
The DLL applies a small proprietary smoothing that no open implementation
reproduces. Inherited from libxrk. **[Format]**

---

## 4. GPS

**4.1 Altitude is ellipsoidal (WGS84), not mean sea level.**
`ecef2lla` implements the Vermeille (2003) closed-form transform. No geoid model
is applied, so `GPS Altitude` differs from map/MSL elevation by the local geoid
undulation — tens of metres in most of the world. Elevation *changes* over a lap
are still fine. **[Design]**

**4.2 Derived acceleration and yaw channels are unfiltered first differences.**
`GPS_InlineAcc`, `GPS_LateralAcc` and `GPS_Yaw_Rate` are computed in `decodeGps`
from consecutive fixes only. Consequences:

- Sample 0 is always 0 for all three.
- They inherit and amplify all GPS noise. There is no smoothing.
- `GPS_Yaw_Rate` is bounded by arithmetic, not by physics. Heading deltas are
  wrapped to (−180°, +180°], so the largest representable value is
  **180 / dt**: ±4500 deg/s at a 25 Hz fix rate (dt = 40 ms), ±1429 deg/s at
  ~8 Hz. Values sitting at that bound mean the heading was garbage (stationary
  vehicle or lost fix), not the car spinning. Reproducible on the committed
  fixtures: `sfj_0101.xrz` (dt = 40 ms) peaks at 4404 deg/s, and
  `aim_official_test.xrk` (dt = 126 ms) peaks at 1488 deg/s.
- `GPS_LateralAcc = speed × yaw_rate`, so it inherits the same artefact.

**[Design]**

**4.3 Heading is derived from the ECEF velocity vector** and is therefore
undefined at rest: at near-zero speed the velocity vector is noise and heading
jumps randomly. **[Format]**

**4.4 The GPS record size is rigid.** `decodeGps` **throws** if the accumulated
GPS byte count is not a multiple of 56. This is one of the few errors that
escapes `parseXrk`. **[Design]**

**4.5 The 16-bit timecode overflow reconstruction only triggers on
non-monotonic timecodes.** `decodeGps` rebuilds wrapped timecodes only after
detecting `rawTc[i] < rawTc[i-1]`. A wrap that happens to keep the sequence
monotonic is not detected. **[Design]**

**4.6 The ~65533 ms firmware timing-bug fix rests on several assumptions.**
`fixGpsTimingGaps` tries three detection methods in order:

1. **GNFI-based** — requires `GNFI` internal-clock messages *and* a final
   GPS-vs-GNFI offset within 65533 ± 5000 ms.
2. **Gap signature** — any gap in **[60000, 70000] ms** is treated as the bug and
   compressed. ⚠️ **A genuine 60–70 s GPS dropout (long tunnel, pit stop under
   cover, red flag) will be misidentified and wrongly removed from the
   timebase.** This is a real false-positive risk on street/endurance logs.
3. **Tail overhang** — GPS extending 60–70 s past every other channel.

If none match, GPS timecodes are left untouched. Additionally:

- `expectedDtMs` is **hardcoded to 40.0 ms (25 Hz)** and is never derived from
  the data — and real files do not all log GPS at 25 Hz. The committed fixture
  `tests/fixtures/data/aim_official_test.xrk` has a mean GPS interval of
  **126 ms (~8 Hz)**, so its gap threshold (`expectedDtMs × 10` = 400 ms) is
  barely three nominal samples rather than the intended ten. That makes the
  gap-index scan far more trigger-happy on slow-GPS logs; only the 60–70 s
  window in method 2 keeps it from misfiring.
- Lap boundaries are corrected **only when laps came from GPS detection**. LAP
  messages use the logger's internal clock and are unaffected by the bug, so
  they are deliberately left alone.

**[Design]** with **[Format]** roots.

**4.7 GNFI messages must be a multiple of 32 bytes** or they are ignored
entirely (`decodeGnfi` returns `null`), disabling detection method 1.
**[Design]**

---

## 5. Laps

**5.1 Partial laps are returned verbatim. Filtering is your job.**
This is the single most common way to get a wrong answer out of this library.
`log.laps` is whatever the logger recorded (or what cross-track detection
found), which normally includes:

- an **out-lap** that begins wherever logging started, not at the start/finish
  line, and
- an **in-lap** that ends when logging stopped.

Both are shorter than a real lap, so a naive `Math.min(...laps.map(lapTime))`
will happily report the out-lap as the fastest lap of the session. The library
does not classify or filter laps, by design — it reports what is in the file.
See the README's "Real-world data gotchas" section for a distance-based filter.
**[Design]**

**5.2 LAP messages win; GPS detection is only a fallback.**
`getLaps` uses `LAP` messages when present (matching the official DLL). GPS
cross-track detection runs **only** when there are no LAP messages *and* GPS
latitude/longitude channels exist *and* a `TRK` message supplies start/finish
coordinates. **[Design]**

**5.3 A lap-number gap larger than 1 throws.**
Exactly one missing lap is inferred and back-filled; a jump of 2 or more raises
`Error("Lap gap from X to Y")`, which escapes `parseXrk`. **[Design]**

**5.4 Split / sector times are discarded.** Only `segment === 0` LAP records are
used. **[Unimplemented]**

**5.5 GPS lap detection uses hardcoded thresholds** — a 30 m start/finish marker
radius and a 4 m/s minimum speed, with a two-pass plane-normal average. Very
slow crossings (kart tracks, formation laps) or GPS scatter beyond 30 m will
miss crossings. **[Design]**

**5.6 GPS-detected laps only span crossings.** Time before the first detected
crossing is not part of any lap; the final lap ends at the last GPS sample.
**[Design]**

**5.7 Lap numbers are renormalised to 0-based** by subtracting the minimum
observed lap number, and start/end times are **truncated to integer
milliseconds**. **[Design]**

---

## 6. Metadata

**6.1 `metadata` is `Record<string, unknown>`.** There is no typed interface and
no guaranteed key set — every field is optional and depends on what the logger
wrote. Callers must narrow types themselves. **[Unimplemented]**

**6.2 Expansion devices are matched to hardware IDs positionally.**
`getMetadata` zips the ordered `ENF` device list against the ordered `iSLV`
messages by index. **[Format]**

**6.3 `Log Date` / `Log Time` are passed through as raw logger strings** — no
parsing, no timezone, no `Date` object. **[Design]**

---

## 7. Errors and failure modes

Most corruption is absorbed silently (§1.2). Only a handful of conditions
actually throw out of `parseXrk`:

| Thrown from | Message | Trigger |
| --- | --- | --- |
| `decodeGps` | `GPS data length N is not a multiple of 56` | Partial GPS record survived framing |
| `getLaps` | `Lap gap from X to Y` | LAP numbering jumps by ≥ 2 |
| `processChannel` | `Can't have both S/c and M records for channel X` | Contradictory sample sources for one channel |

There is no partial-result mode: if one of these fires, you lose the whole
parse. Wrap `parseXrk` in a `try`/`catch` in production. **[Design]**

---

## 8. Performance and memory

Measured on Node 22 (portable v22.23.2), committed fixtures:

| File | Size | Channels | Samples | Parse | Retained typed arrays |
| --- | --- | --- | --- | --- | --- |
| `aim_official_test.xrk` | 3.18 MB | 33 | 549 612 | ~89 ms | 6.1 MB (1.9× file) |
| `sfj_0101.xrz` (compressed) | 3.10 MB | 35 | 871 115 | ~244 ms | 8.4 MB (2.7× file) |

Rules of thumb and caveats:

**8.1 Retained memory is roughly 2–3× the uncompressed file size.** Timecodes
are `Float64Array` — **8 bytes per sample per channel**, which usually dominates
the values array. Grouped channels and all GPS channels share a single
timecode array; ungrouped channels each own one. **[Design]**

**8.2 XRZ decompression pre-allocates 6× the compressed size, up front.**
`decompressIfZlib` calls `inflateRaw(data, 2, data.length * 6)`, and the output
buffer is allocated at that hint immediately. A 20 MB `.xrz` therefore
allocates a 120 MB `Uint8Array` before decoding starts, and `Output.result()`
then makes one more full copy of the decoded bytes. **Peak memory during XRZ
decompression is far above the steady-state figure above** — the main reason to
watch memory in a browser tab. **[Unimplemented]** (a two-pass or chunked
output would fix it).

**8.3 Growable buffers double.** `ByteVec` and the inflate `Output` grow by
doubling, so transient 2× spikes during accumulation are normal. **[Design]**

**8.4 Parsing is fully synchronous and single-shot.** No streaming, no progress
callback, no cancellation, no incremental/partial results. The entire file must
already be in memory as a `Uint8Array`. **[Design]**

---

## 9. Runtime and packaging

**9.1 ESM only — `require()` does not work.**
`package.json` sets `"type": "module"` and the `exports` map defines only an
`import` condition. There is no CommonJS build. Use `import`, or
`await import("aim-xrk")` from CJS. **[Design]**

**9.2 No bundled browser build.** There is no UMD/IIFE artifact and no
`"browser"` field — the package ships plain ESM `dist/` and expects a bundler or
native ESM `<script type="module">`. Zero runtime dependencies, so nothing else
needs polyfilling. **[Design]**

**9.3 Node ≥ 18.** Enforced by `engines`. **[Design]**

**9.4 Run large files in a Web Worker.** Because parsing is synchronous
(§8.4), a multi-megabyte file blocks the main thread for the entire parse and
will freeze the UI. Transfer the `ArrayBuffer` into a Worker, parse there, and
transfer the resulting typed arrays back (they are all transferable).
**[Design]**

**9.5 `SharedArrayBuffer`-backed input is not special-cased.** `parseXrk`
normalises input to a plain `Uint8Array` view over the same buffer. **[Design]**

---

## 10. Parity with Python libxrk

xrk-js is a port of libxrk's Cython parser, and deliberately reproduces its
quirks: one-byte error recovery, strict struct sizes (CHS = 112, LAP = 20,
ODO % 64), timecode dedup rules, and the ±2 ms V3 timecode synthesis. Known
intentional differences and gaps:

**10.1 Output shape differs.** libxrk returns Arrow tables; xrk-js returns plain
objects with typed arrays. Channel keys, units, `dec_pts`, `interpolate`,
`function`, `source_type` and `device_tag` are verified equal by the golden
tests. **[Design]**

**10.2 No Arrow / DataFrame integration, no resampling, no unit conversion, and
no channel math.** xrk-js is a parser, not an analysis toolkit. Interpolating,
aligning channels onto a common timebase and computing derived channels are
left to the caller (see `interpolate` on each channel for the correct
per-channel rule). **[Design]**

**10.3 No writer.** Reading only — xrk-js cannot produce XRK/XRZ files.
**[Design]**

---

## 11. Test coverage

The golden suite (`tests/golden.test.ts`) compares against JSON generated from
Python libxrk by `scripts/make_golden.py`.

**11.1 Two fixtures are committed; five require `XRK_TEST_DATA`.**
A default `npm test` reports **10 passed / 5 skipped** — the 5 skips are the
external cases, *not* failures. See the README for how to enable them.

**11.2 What is covered:**

| Fixture | Logger | Channels | Laps | Notable |
| --- | --- | --- | --- | --- |
| `aim_official_test.xrk` ✅ committed | model 773 (unnamed) | 33 | 11 | AiM's own sample, kart |
| `sfj_0101.xrz` ✅ committed | MXm (793) | 35 | 8 | XRZ path, iGPS |
| `86_2248.xrk` | MXP 1.3 (649) | 100 | 16 | 100 channels, 2 expansion devices |
| `issue68 KK-SII.xrz` | model 519 | 87 | 5 | V2/V3 expansion, TPMS |
| `issue49 badGPSdata.xrk` | model 768 | 86 | 12 | GPS timing-bug path |
| `SFJ 0033.xrk` | MXm (793) | 34 | 13 | |
| `SFJ Suzuka 0090.xrk` | MXm (793) | 35 | 10 | |

**11.3 What is *not* covered:** SoloDL, MXG, MXS and EVO-series loggers; the
GPS-only lap-detection fallback (all seven fixtures carry LAP messages); ≥ 7-speed
gearboxes; corrupt/fuzzy input beyond the truncated-XRZ unit test; and any
logger whose model ID is 519/768/773 being resolved to a real product name.

**11.4 The golden comparison is a per-channel statistical summary, not a
literal sample-by-sample diff.** For every channel it checks sample count, NaN
count, the first 5 and last 5 values, and the sum, min and max — at 1e-6
relative tolerance — for both `values` and `timecodes`. Laps and metadata are
compared by exact deep equality. The checksum-like `sum` comparison makes any
real decoding divergence extremely likely to be caught, but a hypothetical
divergence that preserves count, endpoints, sum, min and max would slip
through. **[Design]**

**11.5 CI runs Ubuntu with Node 18/20/22 only** — no Windows or macOS job, and
no real browser runtime test (`npm run verify:esm` only asserts that a Node ESM
import resolves). **[Unimplemented]**

---

## 12. Encoder (`encodeXrk`)

`encodeXrk` writes an XRK byte stream that this library reads back. It is a
*synthesizer*, not a re-serializer: there is no `parseXrk -> encodeXrk` identity
path, and the output is not a byte-level reproduction of what an AiM logger
would have written.

**12.1 Verified against this parser; RaceStudio acceptance is empirical.**
Every claim below is backed by the round-trip tests in `tests/encode.test.ts`
(encode -> `parseXrk` -> assert). RaceStudio 3 acceptance has been established
only by a user opening files by hand, not by any automated check, and nothing
has been checked against AiM's official `MatLabXRK` DLL. **What is known to
work (2026-09-13):** RaceStudio 3 opens a converted MoTeC session, reads the
GPS stream, and reports lap times that match this library's own `findLaps`
result to the second (verified on a 6-minute, 29-channel file; the full
49-minute / 156-channel build had not yet been reported on when this was
written). RaceStudio
feedback so far, all from a user opening files by hand: an early build without
the device-configuration block (12.9) was rejected with *"no configuration tags
found"*; a build with a 129-byte `SRC` template (one stray byte) with *"can't
find aim device information"*; a build that batched GPS records and wrote GPS
week 0 **opened**, but showed no GPS and no track. A file that round-trips
perfectly here may still be rejected or mis-read by RaceStudio. **[Untested]**

**12.2 The CHS template is borrowed from a real log.** Channel definitions are
built by copying the 112-byte CHS payload of a real MXm channel (`OBDII_RPM`,
decoder 6 / float32 / 100 ms) and overwriting the fields whose meaning is
known. The bytes at `[80:96]` and `[68:72]` vary per channel in real files and
their semantics are unknown; the encoder writes plausible incrementing values.
This is deliberately *less* wrong than zero-filling, but it is still a guess.
**[Design]**

**12.3 Channels are float32 `(M` bursts at a fixed integer-ms period only.**
The encoder emits exactly one channel shape: decoder 6, `size = 4`, samples
evenly spaced at an integer number of milliseconds, written as `(M` burst
messages. Consequences:

- A source at 3 Hz, 7 Hz, or any rate whose period is not a whole number of
  milliseconds cannot be represented and must be resampled by the caller.
- Values are quantised to float32 (~7 significant digits).
- Channels declared with `units: "V"` are multiplied by 1000 on the wire, since
  the parser divides unit-type 21 by 1000 on the way out.
- Units are limited to the encoder's `UNIT_BYTE` table (the invertible subset
  of `UNIT_MAP`); anything else throws. There is no unit byte for `m`, `m/s`,
  `N`, `s` or `ratio`, so such channels have to go out unitless.
- `Calculated_Gear` and `PreCalcGear` must not be used as channel names: the
  parser routes them to `MANUAL_DECODERS` (8-byte `Q` with a bitfield fixup)
  regardless of the CHS decoder byte, so a float32 channel by that name decodes
  to garbage. Likewise `StrtRec` and `Master Clk` are filtered out of the
  parser's output entirely. **[Design]**

**12.4 Not emitted.** `(S` single-sample messages, `(G` grouped-channel rows
and `GRP` group definitions, `(c` expansion-device messages (V1/V2/V3/V4),
`GNFI` internal-clock records, and `CAL` calibrations. A parsed encoder output
therefore has no `Calibrations` metadata, and all channels are standalone (no
grouped rows). **[Unimplemented]**

**12.5 GPS records are synthesized, not captured.** Each 56-byte record is
built from lat/lon/alt via `lla2ecef` plus a velocity vector reconstructed from
ground speed and heading. Limits that follow:

- ECEF is stored in centimetres, so position round-trips to ~1 cm and speed to
  ~1 cm/s. Measured worst case on a real 29 220-sample track: 0.83 cm.
- With `utcStartMs` the records carry a real GNSS week and time-of-week (UTC
  + 18 s leap offset). Without it the time-of-week is the AiM timecode and the
  week is 0 (January 1980) — RaceStudio shows no GPS at all for such a file,
  and does not recognise the track. Leap seconds are a constant 18 here.
- Exactly one 56-byte record per `GPS` message, as real loggers write them.
  This parser would accept batched records; RaceStudio silently drops the GPS
  stream when they are batched.
- Position accuracy and velocity accuracy are written as constants (200 cm,
  36 cm/s) unless the caller overrides `pdop`.
- **At zero speed the heading is destroyed.** The velocity vector becomes
  `(0,0,0)`, so the parser recovers heading 0 and `GPS_Yaw_Rate` spikes at the
  boundaries of every standstill. This is inherent to the format, not to the
  encoder: real MXm logs show the same effect *worse* (±4500 deg/s over 770
  samples on one reference file, versus ±1800 over 35 on a synthesized one).
  **[Design]**

**12.6 Laps.** `LAP` payloads reuse the constant bytes observed in real files
(`[0]=0x20`, `[12]=0x04`, `[13]=0x02`) and only segment 0 is written. Lap start
and end are rounded together before the stored duration is computed, because
the parser recovers the start as `end - duration`; rounding them independently
shifts the recovered start by a millisecond and breaks contiguity with the
previous lap. Laps must be supplied already sorted and contiguous — the encoder
does not check. **[Design]**

**12.7 Message interleaving is uniform, not logger-realistic.** Data is emitted
in fixed time windows (default 1000 ms), all channels in index order within
each window. A real logger interleaves by arrival. The parser does not care;
RaceStudio might. **[Design]**

**12.8 No compression.** `encodeXrk` returns an uncompressed `.xrk` stream. The
library only decompresses (`decompressIfZlib`); producing `.xrz` is left to the
caller. **[Unimplemented]**

**12.9 The file claims to be an AiM logger.** RaceStudio rejects a file that
carries only `CNF` plus session strings — it reports *"no configuration tags
found"*. Making it acceptable means reproducing the configuration block a real
logger writes, and most of that block is opaque. So, by default
(`deviceIdentity: true`), `encodeXrk` emits `SRC`, `iSLV`, `HWNF`, `ENF`,
`GPSR`, `PDLT` and `ODO` copied byte-for-byte from a real MXm log, a `CDE`
alongside every `CHS` inside `CNF`, a `Master Clk` channel at index 0 and an
`iGPS` channel declaration at the last index.

Consequences worth being explicit about:

- **The output advertises a specific logger identity** — model id 539, logger
  id 6520914, plus a model-635 expansion device — regardless of what actually
  produced the data. `deviceIdentity: { modelId, loggerId }` overrides the two
  logger fields; the rest of the block stays as copied. `deviceIdentity: false`
  omits it entirely, which this parser is happy with and RaceStudio is not.
- `HWNF`, `ENF` and `GPSR` describe *that* logger's hardware (ESP32 WiFi,
  BNO055 IMU, an OBDII CAN bus, an iGPS receiver). They are not a description
  of the data source.
- `CDE` carries 4 opaque bytes per channel. Real files use a different value
  for every channel *and every session* — across three sessions of one logger,
  all 34 shared channels differ — so nothing can be validating them; the
  encoder writes a deterministic hash of the channel name.
- `ODO` reports session time and GPS-integrated distance, not a lifetime
  odometer.
- `Master Clk` is emitted truthfully (its value is the timecode), and the
  parser filters it out of `channels` as it does for real files.

**[Design]** — and still **[Untested]** against RaceStudio: see 12.1.

---

## Reporting

Found a file this library mis-parses? Please open an issue at
<https://github.com/cyprien0312/xrk-js/issues> with the logger model, the
channel(s) affected, and — if you can share it — the file. Divergences from
Python libxrk are treated as bugs; divergences from AiM's official DLL are
treated as findings for the upstream format spec.
