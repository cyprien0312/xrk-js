# CLAUDE.md

Pure TypeScript parser for AiM XRK/XRZ telemetry files. Zero runtime dependencies; browser + Node. Port of [libxrk](https://github.com/m3rlin45/libxrk) (Python/Cython/Rust, MIT).

## Commands

```bash
npm test              # unit + golden tests on committed fixtures (~3s)
npm run build         # tsc → dist/
npm run typecheck
# Extended golden suite (all 7 real files) needs the libxrk checkout:
XRK_TEST_DATA=<libxrk>/tests/test_data npm test
```

## Porting rules (important)

- **Source of truth is libxrk**, specifically `spec/xrk_format.py` (executable wire-format spec) and `src/libxrk/aim_xrk.pyx` (behavioral reference). Golden JSONs in `tests/fixtures/` are generated from Python libxrk via `scripts/make_golden.py`. Any parsing change must keep all golden tests passing.
- **Quirks are deliberate.** Bad-byte recovery (skip one byte on any parse error), strict struct sizes (CHS=112, LAP=20, ODO%64), timecode dedup rules, and the V3 timecode synthesis (±2 ms hardcoded) all mirror pyx exactly — "fixing" them breaks parity with the reference (and the official DLL).
- **Node Buffer hazard:** `Buffer.prototype.slice()` returns a view, not a copy. `parseXrk` normalizes input to a plain `Uint8Array` view at entry; keep payload copies as `new Uint8Array(x)`.

## Layout

- `src/parser.ts` — stream framing, message accumulation, header payload dispatch, CNF/ENF recursion, V2/V3 expansion resolution (port of `_decode_sequence`)
- `src/channels.ts` — sample assembly per channel/group, decoders (fp16, gear, Calculated_Gear), mV→V
- `src/gps.ts` — NAV-SOL decode, Vermeille ECEF→LLA, derived channels, GPS timing-bug fix, cross-track lap detection
- `src/laps.ts`, `src/metadata.ts` — ports of `_get_laps` / `_get_metadata`
- `src/inflate.ts` — dependency-free zlib inflate with truncated-stream recovery (XRZ)
- `tests/golden.test.ts` — cross-implementation comparison; two fixtures committed, five more via `XRK_TEST_DATA`
