// V4 partner messages (unk1=1, unk4=6) — 1 kHz analog burst format.
// See LIMITATIONS.md §3.6. No pyx parity oracle exists (the reference predates
// this variant), so this test pins the empirically-validated decoding against
// a real 1 kHz session. The sample file is machine-local (17 MB, not vendored);
// the test skips when it is absent — same discipline as the external golden
// fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseXrk } from "../src/index.js";

const SAMPLE =
  process.env.XRK_V4_SAMPLE ??
  `${process.env.HOME}/aim-analyzer/data/b4c6c69e-a_0189.xrk`;

describe("V4 (unk1=1, unk4=6) 1 kHz analog variant", () => {
  const available = existsSync(SAMPLE);

  it.skipIf(!available)("decodes all three analog channels at ~1 kHz", () => {
    const log = parseXrk(new Uint8Array(readFileSync(SAMPLE)));

    // Channel names as configured in THIS session (they change when the user
    // reconfigures RaceStudio — that is the point of the aliasing downstream).
    const expected: Record<string, { min: number; max: number }> = {
      Rear_Sup: { min: -1, max: 60 }, // rear shock, mm
      BrakeP: { min: -20, max: 40 }, // brake, bar (raw, uncorrected zero)
      Front_Sup1: { min: -120, max: 1 }, // fork, mm (negative convention)
    };

    for (const [name, range] of Object.entries(expected)) {
      const ch = log.channels[name];
      expect(ch, `${name} should be present`).toBeDefined();

      // Sample count: pinned loosely (exact count depends on dropped partial
      // bursts at session edges). 6 full laps at ~976 Hz ≈ 630k samples.
      expect(ch.values.length).toBeGreaterThan(600_000);

      // Rate: nominal 1 kHz, observed 975.6 Hz.
      const t = ch.timecodes;
      const rate = (t.length - 1) / ((t[t.length - 1] - t[0]) / 1000);
      expect(rate).toBeGreaterThan(900);
      expect(rate).toBeLessThan(1050);

      // Value range: physically plausible bounds for this sensor.
      let mn = Infinity,
        mx = -Infinity;
      for (const v of ch.values as Float64Array) {
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      expect(mn).toBeGreaterThan(range.min);
      expect(mx).toBeLessThan(range.max);

      // Timecodes strictly ascending (the migration sort + dedup guarantees
      // this; a regression in burst layout would violate it immediately).
      for (let i = 1; i < Math.min(t.length, 50_000); i++) {
        expect(t[i]).toBeGreaterThan(t[i - 1]);
      }
    }
  });

  it.skipIf(!available)(
    "burst layout: no 1 kHz sawtooth (wrong ordering would alias)",
    () => {
      const log = parseXrk(new Uint8Array(readFileSync(SAMPLE)));
      const v = log.channels["Rear_Sup"].values as Float64Array;
      // Mid-session window, bike on track, suspension active.
      const a = Math.floor(v.length * 0.45);
      const seg = v.subarray(a, a + 20_000);
      // Total variation of the decoded order vs. a deliberately scrambled
      // order (swap within each 5-sample burst). The correct layout must be
      // smoother by a clear margin.
      let tv = 0;
      for (let i = 1; i < seg.length; i++) tv += Math.abs(seg[i] - seg[i - 1]);
      const scrambled = seg.slice();
      for (let i = 0; i + 5 <= scrambled.length; i += 5) {
        const t0 = scrambled[i];
        scrambled[i] = scrambled[i + 3];
        scrambled[i + 3] = t0;
      }
      let tvS = 0;
      for (let i = 1; i < scrambled.length; i++)
        tvS += Math.abs(scrambled[i] - scrambled[i - 1]);
      expect(tv).toBeLessThan(tvS);
    },
  );
});
