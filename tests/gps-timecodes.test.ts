// GPS record timecode reconstruction — port of libxrk's phase-unwrap rule
// (spec/xrk_format.py `reconstruct_gps_timecodes`, spec/docs/companion.md §6).
//
// Some AIM firmware corrupts the upper 16 bits of the GPS record timecode, so a
// non-monotonic stream is rebuilt from the low 16 bits. Only a backwards step
// close to 65536 is a rollover. The superseded rule ("+65536 on ANY decrease")
// turned every all-zero dropout record and every 100 ms buffer-seam step into a
// fake rollover; fixGpsTimingGaps then removed only (gap − 40 ms) of it, leaving
// the whole rest of the GPS stream shifted against the logger-clock channels
// (+2157 ms on a real R3 session). See LIMITATIONS.md §4.5.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeGps, fixGpsTimingGaps } from "../src/gps";
import { parseRaw } from "../src/parser";
import { decompressIfZlib } from "../src/inflate";
import { parseXrk } from "../src/index";
import type { ChannelDef } from "../src/types";

const WRAP = 65536;

/** 56-byte GPS records carrying only a timecode (+ iTOW); everything else zero. */
function gpsBytes(tcs: number[], itow?: number[]): Uint8Array {
  const out = new Uint8Array(tcs.length * 56);
  const dv = new DataView(out.buffer);
  tcs.forEach((tc, i) => {
    dv.setInt32(i * 56, tc, true);
    if (itow) dv.setUint32(i * 56 + 4, itow[i], true);
  });
  return out;
}

function decodedTimecodes(tcs: number[]): number[] {
  const speed = decodeGps(gpsBytes(tcs), 0).find((c) => c.longName === "GPS Speed")!;
  return Array.from(speed.timecodes);
}

/** decodeGps followed by fixGpsTimingGaps, as parseXrk runs them (no GNFI, LAP-message laps). */
function pipelineTimecodes(tcs: number[]): number[] {
  const channels = new Map<string, ChannelDef>();
  for (const c of decodeGps(gpsBytes(tcs), 0)) channels.set(c.longName, c);
  fixGpsTimingGaps(channels, [], null, false);
  return Array.from(channels.get("GPS Speed")!.timecodes);
}

const ramp = (start: number, n: number, dt = 40) => Array.from({ length: n }, (_, i) => start + i * dt);

describe("GPS timecode reconstruction (phase unwrap)", () => {
  it("returns a clean stream unchanged", () => {
    expect(decodedTimecodes([1000, 1040, 1080, 1120])).toEqual([1000, 1040, 1080, 1120]);
  });

  it("leaves a monotonic stream with a large forward gap untouched", () => {
    expect(decodedTimecodes([1000, 1040, 200_000, 200_040])).toEqual([1000, 1040, 200_000, 200_040]);
  });

  it("advances one band on a genuine 16-bit rollover", () => {
    expect(decodedTimecodes([65440, 65480, 65520, 24, 64])).toEqual([65440, 65480, 65520, 65560, 65600]);
  });

  it("does not read a replayed block as a rollover", () => {
    const tcs = [1000, 1040, 1080, 1000, 1040, 1080, 1120];
    expect(decodedTimecodes(tcs)).toEqual(tcs);
  });

  it("does not read seam jitter as a rollover", () => {
    const tcs = [100, 200, 160, 240, 280];
    expect(decodedTimecodes(tcs)).toEqual(tcs);
  });

  it("places a straggler from before a rollover at its pre-wrap time", () => {
    expect(decodedTimecodes([65500, 65530, 20, 65510, 50])).toEqual([65500, 65530, 65556, 65510, 65586]);
  });

  it("absorbs a single all-zero dropout record", () => {
    const out = decodedTimecodes([66063, 66103, 66143, 0, 66183, 66223]);
    expect(out[4]).toBe(66183);
    expect(out[5]).toBe(66223);
  });

  it("rebuilds garbage upper bits from the low 16", () => {
    const truth = ramp(500, 8);
    const corrupt = truth.map((t, i) => (t & 0xffff) + (i % 3 === 2 ? WRAP * 7 : 0));
    expect(decodedTimecodes(corrupt)).toEqual(truth);
  });

  it("always preserves the low 16 bits", () => {
    const corrupt = [500, 540, 400, 65_000, 20, 60];
    expect(decodedTimecodes(corrupt).map((t) => t & 0xffff)).toEqual(corrupt.map((t) => t & 0xffff));
  });
});

// The two shapes seen in real R3 logs (aim-analyzer D14). After the full
// decode → timing-gap-fix pipeline every record after the fault must sit at
// its raw logger time — the old rule left +2157 ms and +140 ms here.
describe("GPS timecodes stay on the logger clock through fixGpsTimingGaps", () => {
  it("all-zero record while GPS is still acquiring, followed by a 2.72 s real gap", () => {
    const before = ramp(73_075, 1330);                   // ... 126_235
    const after = ramp(128_955, 200);
    const out = pipelineTimecodes([...before, 0, ...after]);
    expect(out.slice(0, before.length)).toEqual(before);
    expect(out.slice(before.length + 1)).toEqual(after);
  });

  it("100 ms backwards step at a buffer seam", () => {
    const before = ramp(4988, 264);                      // ... 15_508
    const after = ramp(15_408, 400);
    const tcs = [...before, ...after];
    expect(pipelineTimecodes(tcs)).toEqual(tcs);
  });
});

// Real fixture from libxrk (tests/test_data/issue84): the logger re-emits a
// block of 41 GPS records, stepping its clock back 1600 ms. iTOW is written by
// the receiver and cannot be touched by the logger bug, so it is the ground
// truth for the span. libxrk pins the same file against AIM's official DLL:
// one backwards step and 41 duplicate timecodes are kept, not dropped.
const external = process.env.XRK_TEST_DATA ?? "";
const ISSUE84 = join(external, "issue84/CMD_KK-SII_Tsukuba_Car_Qualifying testing_a_0159.xrz");

describe("issue84 fixture (replayed GPS block)", () => {
  it.skipIf(!external || !existsSync(ISSUE84))("GPS span matches the receiver clock and non-GPS channels", () => {
    const bytes = new Uint8Array(readFileSync(ISSUE84));
    const raw = parseRaw(decompressIfZlib(bytes)).gpsBytes.view();
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const itow: number[] = [];
    for (let o = 0; o < raw.length; o += 56) {
      const v = dv.getUint32(o + 4, true);
      if (v > 0) itow.push(v);
    }
    const truthSpan = Math.max(...itow) - Math.min(...itow);

    const log = parseXrk(bytes);
    const t = log.channels["GPS Speed"].timecodes;
    expect(Math.abs(t[t.length - 1] - t[0] - truthSpan)).toBeLessThanOrEqual(100);

    let back = 0;
    for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) back++;
    expect(back).toBe(1);
    expect(t.length - new Set(t).size).toBe(41);

    const spans = Object.entries(log.channels)
      .filter(([n, c]) => !n.startsWith("GPS") && c.timecodes.length > 1)
      .map(([, c]) => c.timecodes[c.timecodes.length - 1] - c.timecodes[0]);
    expect(Math.abs(t[t.length - 1] - t[0] - Math.max(...spans))).toBeLessThanOrEqual(100);
  });
});
