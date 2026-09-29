# CLAUDE.md

Pure TypeScript parser for AiM XRK/XRZ telemetry files. Zero runtime dependencies; browser + Node. Port of [libxrk](https://github.com/m3rlin45/libxrk) (Python/Cython/Rust, MIT).

## Commands

```bash
npm ci                # clean install from package-lock.json
npm run build         # tsc → dist/
npm run typecheck     # tsc --noEmit
npm test              # vitest run (~3s)
npm run verify:esm    # build + assert `import("./dist/index.js")` exposes parseXrk
```

### Expected test result: `32 passed | 9 skipped`

**The 9 skips are not failures.** `tests/golden.test.ts` defines 8 cases; only 2
fixture files are small enough to commit (`aim_official_test.xrk`,
`sfj_0101.xrz`). The other 6 (plus the issue84 check in
`tests/gps-timecodes.test.ts`) are `it.skipIf`-gated on the env var
`XRK_TEST_DATA` pointing at a [libxrk](https://github.com/m3rlin45/libxrk)
checkout's `tests/test_data`, which holds the large source files:

```bash
git clone https://github.com/m3rlin45/libxrk /tmp/libxrk
XRK_TEST_DATA=/tmp/libxrk/tests/test_data npm test   # → 39 passed | 2 skipped
```

The last 2 skips are `tests/v4-variant.test.ts`, which needs a local 1 kHz
sample via `XRK_V4_SAMPLE` (then 41 passed). If you see anything else,
something is actually wrong.

Regenerating goldens needs Python libxrk, not just the checkout:
`pip install libxrk`, then
`python scripts/make_golden.py file.xrk tests/fixtures/name.golden.json`.

### Local dev environment (Windows, portable Node)

If Node is a portable/zip install rather than a system one, it is not on PATH —
invoke it by absolute path, or prepend its directory per command:

```powershell
$env:PATH = "<path-to>
ode;" + $env:PATH   # then npm.cmd / node.exe work normally
```

Verified toolchain: Node v22.23.2 + npm 10.9.8. Note that Node ESM on Windows
rejects bare absolute paths in `import` — use `file:///C:/...` URLs in one-off
scripts.

## Porting rules (important)

- **Source of truth is libxrk**, specifically `spec/xrk_format.py` (executable wire-format spec) and `src/libxrk/aim_xrk.pyx` (behavioral reference). Golden JSONs in `tests/fixtures/` are generated from Python libxrk via `scripts/make_golden.py`. Any parsing change must keep all golden tests passing.
- **Quirks are deliberate.** Bad-byte recovery (skip one byte on any parse error), strict struct sizes (CHS=112, LAP=20, ODO%64), timecode dedup rules, and the V3 timecode synthesis (±2 ms hardcoded) all mirror pyx exactly — "fixing" them breaks parity with the reference (and the official DLL).
- **This port lags upstream.** It was made from an older libxrk; upstream keeps fixing format bugs. Before debugging a
  parse discrepancy, diff against *current* libxrk (`pip install libxrk`, or clone it and read `spec/docs/companion.md`).
  The 2026-09-29 GPS-timecode shift (LIMITATIONS §4.5) had already been fixed upstream in 0.13.0.
- **Node Buffer hazard:** `Buffer.prototype.slice()` returns a view, not a copy. `parseXrk` normalizes input to a plain `Uint8Array` view at entry; keep payload copies as `new Uint8Array(x)`.

## Layout

- `src/parser.ts` — stream framing, message accumulation, header payload dispatch, CNF/ENF recursion, V2/V3 expansion resolution (port of `_decode_sequence`)
- `src/channels.ts` — sample assembly per channel/group, decoders (fp16, gear, Calculated_Gear), mV→V
- `src/gps.ts` — NAV-SOL decode, Vermeille ECEF→LLA, derived channels, GPS timing-bug fix, cross-track lap detection
- `src/laps.ts`, `src/metadata.ts` — ports of `_get_laps` / `_get_metadata`
- `src/inflate.ts` — dependency-free zlib inflate with truncated-stream recovery (XRZ)
- `tests/golden.test.ts` — cross-implementation comparison; two fixtures committed, five more via `XRK_TEST_DATA`
- `LIMITATIONS.md` — audited list of gaps, heuristics and failure modes, each tagged
  `[Design]` / `[Unimplemented]` / `[Format]` with a source reference. Keep it in sync
  when parsing behavior changes; the README links into it.
