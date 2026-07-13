// Cross-implementation tests: parse real XRK/XRZ files and compare against
// golden JSON generated from Python libxrk (scripts/make_golden.py).

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseXrk } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

// External test files (too large to commit) — set XRK_TEST_DATA to the
// libxrk checkout's tests/test_data directory to run the extended suite.
const external = process.env.XRK_TEST_DATA ?? "";

interface Summary {
  n: number;
  nan_count: number;
  first: Array<number | string>;
  last: Array<number | string>;
  sum: number | string;
  min: number | string | null;
  max: number | string | null;
}

interface GoldenChannel {
  units: string;
  dec_pts: number;
  interpolate: boolean;
  function: string;
  source_type: number;
  device_tag: string;
  values: Summary;
  timecodes: Summary;
}

interface Golden {
  metadata: Record<string, unknown>;
  laps: Array<[number, number, number]>;
  channels: Record<string, GoldenChannel>;
}

const CASES: Array<{ name: string; golden: string; data: string; ext?: boolean }> = [
  { name: "aim_official test.xrk", golden: "aim_official_test.golden.json", data: "data/aim_official_test.xrk" },
  { name: "SFJ 0101.xrz", golden: "sfj_0101.golden.json", data: "data/sfj_0101.xrz" },
  { name: "issue68 KK-SII.xrz (V2/V3 expansion)", golden: "issue68.golden.json", data: "issue68/CMD_KK-SII_Tsukuba_Car_Generic testing_a_0101.xrz", ext: true },
  { name: "issue49 badGPSdata.xrk (GPS timing bug)", golden: "issue49_badgps.golden.json", data: "issue49/badGPSdata.xrk", ext: true },
  { name: "86 2248.xrk (100 channels)", golden: "86_2248.golden.json", data: "86/CMD_Inferno 86_Fuji GP Sh_Generic testing_a_2248.xrk", ext: true },
  { name: "SFJ 0033.xrk", golden: "sfj_0033.golden.json", data: "SFJ/CMD_SFJ_Fuji GP Sh_Generic testing_a_0033.xrk", ext: true },
  { name: "SFJ Suzuka 0090.xrk", golden: "sfj_suzuka_0090.golden.json", data: "SFJ/CMD_SFJ_Suzuka Car_Generic testing_a_0090.xrk", ext: true },
];

function num(v: number | string): number {
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  return v as number;
}

function expectClose(actual: number, expected: number | string, relTol: number, label: string) {
  const exp = num(expected);
  if (Number.isNaN(exp)) {
    expect(Number.isNaN(actual), `${label}: expected NaN, got ${actual}`).toBe(true);
    return;
  }
  if (!Number.isFinite(exp)) {
    expect(actual, label).toBe(exp);
    return;
  }
  const tol = Math.max(Math.abs(exp) * relTol, relTol);
  expect(
    Math.abs(actual - exp) <= tol,
    `${label}: ${actual} != ${exp} (tol ${tol})`,
  ).toBe(true);
}

function summarize(values: ArrayLike<number>): {
  n: number;
  nanCount: number;
  first: number[];
  last: number[];
  sum: number;
  min: number | null;
  max: number | null;
} {
  const n = values.length;
  let nanCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      nanCount++;
      continue;
    }
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const arr = Array.from({ length: Math.min(5, n) }, (_, i) => values[i]);
  const lastArr = Array.from(
    { length: Math.min(5, n) },
    (_, i) => values[n - Math.min(5, n) + i],
  );
  return {
    n,
    nanCount,
    first: arr,
    last: lastArr,
    sum,
    min: n - nanCount > 0 ? min : null,
    max: n - nanCount > 0 ? max : null,
  };
}

function compareSummary(
  actual: ReturnType<typeof summarize>,
  expected: Summary,
  label: string,
) {
  expect(actual.n, `${label}: sample count`).toBe(expected.n);
  expect(actual.nanCount, `${label}: NaN count`).toBe(expected.nan_count);
  expected.first.forEach((v, i) => expectClose(actual.first[i], v, 1e-6, `${label} first[${i}]`));
  expected.last.forEach((v, i) => expectClose(actual.last[i], v, 1e-6, `${label} last[${i}]`));
  expectClose(actual.sum, expected.sum, 1e-6, `${label} sum`);
  if (expected.min !== null) expectClose(actual.min!, expected.min, 1e-6, `${label} min`);
  if (expected.max !== null) expectClose(actual.max!, expected.max, 1e-6, `${label} max`);
}

function jsonSafeMeta(v: unknown): unknown {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return v;
  }
  if (Array.isArray(v)) return v.map(jsonSafeMeta);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafeMeta(x);
    return out;
  }
  return v;
}

describe.each(CASES)("golden: $name", ({ golden, data, ext }) => {
  const goldenPath = join(fixtures, golden);
  const dataPath = ext ? join(external, data) : join(fixtures, data);
  const available = existsSync(goldenPath) && (!ext || (external && existsSync(dataPath)));

  it.skipIf(!available)("matches Python libxrk output", () => {
    const expected: Golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    const log = parseXrk(readFileSync(dataPath));

    // Channel sets
    const actualNames = Object.keys(log.channels).sort();
    const expectedNames = Object.keys(expected.channels).sort();
    expect(actualNames).toEqual(expectedNames);

    // Per-channel data
    for (const name of expectedNames) {
      const ch = log.channels[name];
      const exp = expected.channels[name];
      expect(ch.units, `${name}: units`).toBe(exp.units);
      expect(ch.decPts, `${name}: dec_pts`).toBe(exp.dec_pts);
      expect(ch.interpolate, `${name}: interpolate`).toBe(exp.interpolate);
      expect(ch.func, `${name}: function`).toBe(exp.function);
      expect(ch.sourceType, `${name}: source_type`).toBe(exp.source_type);
      expect(ch.deviceTag, `${name}: device_tag`).toBe(exp.device_tag);
      compareSummary(summarize(ch.values), exp.values, `${name} values`);
      compareSummary(summarize(ch.timecodes), exp.timecodes, `${name} timecodes`);
    }

    // Laps
    expect(log.laps.map((l) => [l.num, l.startTime, l.endTime])).toEqual(expected.laps);

    // Metadata
    expect(jsonSafeMeta(log.metadata)).toEqual(expected.metadata);
  });
});
