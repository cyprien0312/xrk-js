// Encoder round-trip tests. `encodeXrk` is only meaningful if `parseXrk` gets
// the same numbers back out, so every test here goes encode -> parse -> assert.
// No fixture files are needed: the inputs are synthesized, which also means
// these run everywhere (unlike the golden tests, which need real logs).
import { describe, it, expect } from "vitest";
import { encodeXrk } from "../src/encode.js";
import { parseXrk } from "../src/index.js";

/** Encode then parse, returning the parsed log. */
function roundTrip(opts: Parameters<typeof encodeXrk>[0]) {
  return parseXrk(encodeXrk(opts));
}

describe("encodeXrk", () => {
  it("round-trips channel values, timecodes and units", () => {
    const n = 500;
    const ramp = Float64Array.from({ length: n }, (_, i) => i * 0.25 - 30);
    const log = roundTrip({
      channels: [
        { name: "OBDII_RPM", shortName: "RPM", units: "rpm", periodMs: 10, values: ramp },
        { name: "Brake_Press", shortName: "BrkP", units: "bar", periodMs: 20, values: ramp },
      ],
    });

    const rpm = log.channels["OBDII_RPM"];
    expect(rpm).toBeDefined();
    expect(rpm.units).toBe("rpm");
    expect(rpm.values.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(rpm.values[i]).toBeCloseTo(ramp[i], 5);
      expect(rpm.timecodes[i]).toBe(i * 10);
    }

    const brake = log.channels["Brake_Press"];
    expect(brake.units).toBe("bar");
    expect(brake.timecodes[1]).toBe(20);
  });

  it("honours startMs as the first timecode", () => {
    const log = roundTrip({
      channels: [
        { name: "Late", units: "", periodMs: 100, startMs: 5000, values: [1, 2, 3] },
        { name: "Early", units: "", periodMs: 100, startMs: 0, values: [9, 9] },
      ],
    });
    // The session time base is the earliest sample across all channels.
    expect(log.channels["Early"].timecodes[0]).toBe(0);
    expect(log.channels["Late"].timecodes[0]).toBe(5000);
  });

  it("stores volts as millivolts so the parser's mV->V rule recovers them", () => {
    const volts = [11.9, 12.4, 13.8];
    const log = roundTrip({
      channels: [{ name: "Battery", units: "V", periodMs: 1000, values: volts }],
    });
    expect(log.channels["Battery"].units).toBe("V");
    for (let i = 0; i < volts.length; i++) {
      expect(log.channels["Battery"].values[i]).toBeCloseTo(volts[i], 4);
    }
  });

  it("round-trips GPS position, altitude and speed through ECEF", () => {
    const n = 200;
    const lat = Float64Array.from({ length: n }, (_, i) => -37.2159 + i * 1e-5);
    const lon = Float64Array.from({ length: n }, (_, i) => 145.0824 + i * 1e-5);
    const alt = Float64Array.from({ length: n }, (_, i) => 300 + (i % 20));
    const speed = Float64Array.from({ length: n }, (_, i) => 10 + (i % 50));
    const heading = Float64Array.from({ length: n }, (_, i) => (i * 1.5) % 360);

    const log = roundTrip({
      channels: [{ name: "Dummy", units: "", periodMs: 100, values: new Float64Array(n) }],
      gps: { periodMs: 40, lat, lon, alt, speedMs: speed, headingDeg: heading },
    });

    const outLat = log.channels["GPS Latitude"];
    const outLon = log.channels["GPS Longitude"];
    const outAlt = log.channels["GPS Altitude"];
    const outSpd = log.channels["GPS Speed"];
    expect(outLat.values.length).toBe(n);
    for (let i = 0; i < n; i++) {
      // ECEF is stored in centimetres; 1e-6 deg is ~11 cm, comfortably above it.
      expect(outLat.values[i]).toBeCloseTo(lat[i], 6);
      expect(outLon.values[i]).toBeCloseTo(lon[i], 6);
      expect(outAlt.values[i]).toBeCloseTo(alt[i], 1);
      expect(outSpd.values[i]).toBeCloseTo(speed[i], 1);
    }
    expect(outLat.timecodes[1]).toBe(40);
  });

  it("emits contiguous laps whose boundaries survive rounding", () => {
    // Fractional boundaries are what findLaps produces; the encoder must round
    // start and end together or the recovered start drifts by a millisecond.
    const bounds = [0, 30500.4, 61200.7, 91000.2];
    const laps = bounds.slice(0, -1).map((s, i) => ({ startMs: s, endMs: bounds[i + 1] }));
    const log = roundTrip({
      channels: [{ name: "Dummy", units: "", periodMs: 100, values: new Float64Array(920) }],
      laps,
    });
    expect(log.laps.length).toBe(laps.length);
    for (let i = 0; i < log.laps.length; i++) {
      expect(log.laps[i].startTime).toBe(Math.round(bounds[i]));
      expect(log.laps[i].endTime).toBe(Math.round(bounds[i + 1]));
      if (i) expect(log.laps[i].startTime).toBe(log.laps[i - 1].endTime);
    }
  });

  it("round-trips session metadata including the start/finish line", () => {
    const log = roundTrip({
      channels: [{ name: "Dummy", units: "", periodMs: 100, values: [1, 2] }],
      metadata: {
        driver: "Jason", vehicle: "r3", venue: "Broadford", session: "Race",
        series: "VRRC round 4", date: "11/23/2025", time: "12:54:42",
        sfLat: -37.2159059, sfLon: 145.0823972,
      },
    });
    expect(log.metadata.Driver).toBe("Jason");
    expect(log.metadata.Vehicle).toBe("r3");
    expect(log.metadata.Venue).toBe("Broadford");
    expect(log.metadata.Session).toBe("Race");
    expect(log.metadata["Log Date"]).toBe("11/23/2025");
    expect(log.metadata["Log Time"]).toBe("12:54:42");
  });

  it("falls back to GPS lap detection when no LAP messages are written", () => {
    // Two laps of a small circle crossing a start/finish point, at speed.
    const perLap = 250;
    const n = perLap * 2;
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const speed = new Float64Array(n);
    const R = 0.004;
    const LAT0 = 22.3706;
    const LON0 = 113.5606;
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * (i % perLap)) / perLap;
      lat[i] = LAT0 + R * Math.cos(th);
      lon[i] = LON0 + (R * Math.sin(th)) / Math.cos((LAT0 * Math.PI) / 180);
      speed[i] = 45;
    }
    const log = roundTrip({
      channels: [{ name: "Dummy", units: "", periodMs: 100, values: new Float64Array(n) }],
      gps: { periodMs: 100, lat, lon, speedMs: speed },
      metadata: { venue: "Circle", sfLat: LAT0 + R, sfLon: LON0 },
    });
    expect(log.laps.length).toBeGreaterThan(0);
  });

  it("is deterministic — the same input encodes to identical bytes", () => {
    const opts = {
      channels: [{ name: "A", units: "bar", periodMs: 10, values: [1, 2, 3, 4, 5] }],
      metadata: { venue: "X", driver: "Y" },
    };
    expect(Array.from(encodeXrk(opts))).toEqual(Array.from(encodeXrk(opts)));
  });

  it("rejects inputs the format cannot represent", () => {
    expect(() =>
      encodeXrk({ channels: [{ name: "A", units: "furlongs", periodMs: 10, values: [1] }] }),
    ).toThrow(/unsupported unit/);
    expect(() =>
      encodeXrk({ channels: [{ name: "A", units: "", periodMs: 0.5, values: [1] }] }),
    ).toThrow(/integer periodMs/);
    expect(() =>
      encodeXrk({
        channels: [{ name: "A".repeat(24), units: "", periodMs: 10, values: [1] }],
      }),
    ).toThrow(/name too long/);
  });
});
