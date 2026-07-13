import { deflateSync, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fp16ToFloat, tokdec, tokenc } from "../src/constants";
import { decompressIfZlib, inflateRaw, isZlib } from "../src/inflate";
import { ecef2lla, lla2ecef } from "../src/gps";

describe("tokens", () => {
  it("round-trips 3- and 4-char tokens", () => {
    expect(tokenc(tokdec("CHS"))).toBe("CHS");
    expect(tokenc(tokdec("GNFI"))).toBe("GNFI");
    expect(tokdec("GPS")).toBe(0x535047);
  });
});

describe("fp16ToFloat", () => {
  it("decodes IEEE 754 half-precision", () => {
    expect(fp16ToFloat(0x0000)).toBe(0);
    expect(fp16ToFloat(0x3c00)).toBe(1);
    expect(fp16ToFloat(0xc000)).toBe(-2);
    expect(fp16ToFloat(0x7bff)).toBe(65504); // max half
    expect(fp16ToFloat(0x3555)).toBeCloseTo(0.333251953125, 10);
    expect(fp16ToFloat(0x0001)).toBeCloseTo(5.960464477539063e-8, 12); // subnormal
    expect(fp16ToFloat(0x7c00)).toBe(Infinity);
    expect(fp16ToFloat(0xfc00)).toBe(-Infinity);
    expect(Number.isNaN(fp16ToFloat(0x7e00))).toBe(true);
  });
});

describe("inflate", () => {
  function randomish(n: number): Uint8Array {
    // Deterministic pseudo-random with repetitive sections (exercises matches)
    const out = new Uint8Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      out[i] = i % 3 === 0 ? s & 0xff : out[i >> 1];
    }
    return out;
  }

  it("detects zlib headers", () => {
    expect(isZlib(deflateSync(Buffer.from("hello")))).toBe(true);
    expect(isZlib(new Uint8Array([0x3c, 0x68]))).toBe(false);
  });

  it("inflates zlib streams from node:zlib", () => {
    for (const size of [0, 1, 100, 70000, 500000]) {
      const original = randomish(size);
      const compressed = new Uint8Array(deflateSync(original));
      const out = decompressIfZlib(compressed);
      expect(out.length, `size ${size}`).toBe(size);
      expect(Buffer.compare(Buffer.from(out), Buffer.from(original)), `size ${size}`).toBe(0);
    }
  });

  it("inflates raw deflate with stored blocks", () => {
    const original = randomish(300);
    const compressed = new Uint8Array(deflateRawSync(original, { level: 0 }));
    const out = inflateRaw(compressed);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(original))).toBe(0);
  });

  it("recovers partial data from truncated streams", () => {
    const original = randomish(200000);
    const compressed = new Uint8Array(deflateSync(original));
    const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
    const out = decompressIfZlib(truncated);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(original.length);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(original.subarray(0, out.length)))).toBe(0);
  });
});

describe("gps math", () => {
  it("ecef2lla inverts lla2ecef", () => {
    const cases: Array<[number, number, number]> = [
      [35.371, 138.927, 583], // Fuji Speedway
      [-37.9, 145.16, 20],
      [50.436, 5.971, 400], // Spa
      [0.001, 0.001, 0],
    ];
    for (const [lat, lon, alt] of cases) {
      const [x, y, z] = lla2ecef(lat, lon, alt);
      const [la, lo, al] = ecef2lla(x, y, z);
      expect(la).toBeCloseTo(lat, 8);
      expect(lo).toBeCloseTo(lon, 8);
      expect(al).toBeCloseTo(alt, 5);
    }
  });
});
