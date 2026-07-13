// GPS decoding and processing — port of aim_xrk.pyx `_decode_gps`/`_decode_gnfi`
// and libxrk's gps.py (ecef2lla, find_laps, fix_gps_timing_gaps).

import { GPS_CHANNEL_NAMES } from "./constants.js";
import type { ChannelDef, XrkLap } from "./types.js";

const A = 6378137.0; // WGS84 semi-major axis
const E = 8.181919084261345e-2; // WGS84 eccentricity

/** lat/lon in degrees, alt in meters → ECEF x/y/z in meters. */
export function lla2ecef(latDeg: number, lonDeg: number, alt: number): [number, number, number] {
  const eSq = E * E;
  const lat = latDeg * (Math.PI / 180);
  const lon = lonDeg * (Math.PI / 180);
  const clat = Math.cos(lat);
  const slat = Math.sin(lat);
  const N = A / Math.sqrt(1 - eSq * slat * slat);
  return [
    (N + alt) * clat * Math.cos(lon),
    (N + alt) * clat * Math.sin(lon),
    ((1 - eSq) * N + alt) * slat,
  ];
}

/**
 * ECEF (meters) → geodetic lat/lon (degrees) and altitude (meters).
 * Vermeille 2003 closed-form algorithm (same as libxrk).
 */
export function ecef2lla(x: number, y: number, z: number): [number, number, number] {
  const e2 = E * E;
  const e4 = e2 * e2;
  const p = (x * x + y * y) / (A * A);
  const q = ((1 - e2) / (A * A)) * z * z;
  const r = (p + q - e4) / 6;
  const s = (e4 / 4) * ((p * q) / (r * r * r));
  const t = Math.cbrt(1 + s + Math.sqrt(s * (2 + s)));
  let u = r * (1 + t + 1 / t);
  const v = Math.sqrt(u * u + e4 * q);
  u += v;
  const w = (e2 / 2) * ((u - q) / v);
  const k = Math.sqrt(u + w * w) - w;
  const D = (k * Math.sqrt(x * x + y * y)) / (k + e2);
  const rtDDzz = Math.sqrt(D * D + z * z);
  return [
    (180 / Math.PI) * 2 * Math.atan2(z, D + rtDDzz),
    (180 / Math.PI) * Math.atan2(y, x),
    ((k + e2 - 1) / k) * rtDDzz,
  ];
}

function makeGpsChannel(
  name: string,
  units: string,
  decPts: number,
  interpolate: boolean,
  timecodes: Float64Array,
  values: Float64Array | Float32Array,
): ChannelDef {
  return {
    index: -1,
    shortName: "",
    longName: name,
    size: 0,
    units,
    decPts,
    interpolate,
    unknown: new Uint8Array(0),
    func: "",
    sourceType: 0,
    sourceChannelId: 0,
    deviceTag: "",
    calValue1: 0,
    calValue2: 1,
    displayRangeMin: 0,
    displayRangeMax: 0,
    group: null,
    timecodes,
    values,
    hasData: values.length > 0,
  };
}

/**
 * Decode concatenated 56-byte GPS messages (AIM timecode + u-blox NAV-SOL)
 * into the derived GPS channels. Port of aim_xrk.pyx `_decode_gps`.
 */
export function decodeGps(gpsBytes: Uint8Array, timeOffset: number): ChannelDef[] {
  if (gpsBytes.length === 0) return [];
  if (gpsBytes.length % 56 !== 0) {
    throw new Error(`GPS data length ${gpsBytes.length} is not a multiple of 56`);
  }
  const n = gpsBytes.length / 56;
  const dv = new DataView(gpsBytes.buffer, gpsBytes.byteOffset, gpsBytes.byteLength);

  // Timecodes, with 16-bit-overflow firmware bug reconstruction.
  const rawTc = new Float64Array(n);
  for (let i = 0; i < n; i++) rawTc[i] = dv.getInt32(i * 56, true);
  let nonMonotonic = false;
  for (let i = 1; i < n; i++) {
    if (rawTc[i] < rawTc[i - 1]) {
      nonMonotonic = true;
      break;
    }
  }
  if (nonMonotonic) {
    const base = rawTc[0] - (rawTc[0] % 65536 + 65536) % 65536;
    for (let i = 0; i < n; i++) rawTc[i] = ((rawTc[i] % 65536) + 65536) % 65536 + base;
    let wraps = 0;
    let prev = rawTc[0];
    for (let i = 1; i < n; i++) {
      const cur = rawTc[i];
      if (cur < prev) wraps += 65536;
      prev = cur;
      rawTc[i] = cur + wraps;
    }
  }
  const timecodes = new Float64Array(n);
  for (let i = 0; i < n; i++) timecodes[i] = rawTc[i] - timeOffset;

  const speed = new Float64Array(n);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const alt = new Float64Array(n);
  const nsat = new Float32Array(n);
  const fix = new Float32Array(n);
  const pdop = new Float32Array(n);
  const posAcc = new Float32Array(n);
  const velAcc = new Float32Array(n);
  const heading = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const off = i * 56;
    const ecefX = dv.getInt32(off + 16, true);
    const ecefY = dv.getInt32(off + 20, true);
    const ecefZ = dv.getInt32(off + 24, true);
    const vx = dv.getInt32(off + 32, true);
    const vy = dv.getInt32(off + 36, true);
    const vz = dv.getInt32(off + 40, true);

    speed[i] = Math.sqrt(vx * vx + vy * vy + vz * vz) / 100.0;
    const [la, lo, al] = ecef2lla(ecefX / 100, ecefY / 100, ecefZ / 100);
    lat[i] = la;
    lon[i] = lo;
    alt[i] = al;

    fix[i] = gpsBytes[off + 14];
    nsat[i] = gpsBytes[off + 51];
    pdop[i] = Math.fround(dv.getUint16(off + 48, true) / 100.0);
    posAcc[i] = Math.fround(dv.getUint32(off + 28, true) / 100.0);
    velAcc[i] = Math.fround(dv.getUint32(off + 44, true) / 100.0);

    // Heading from ECEF velocity via ENU transform
    const latR = la * (Math.PI / 180);
    const lonR = lo * (Math.PI / 180);
    const sinLat = Math.sin(latR);
    const cosLat = Math.cos(latR);
    const sinLon = Math.sin(lonR);
    const cosLon = Math.cos(lonR);
    const vEast = -sinLon * vx + cosLon * vy;
    const vNorth = -sinLat * cosLon * vx - sinLat * sinLon * vy + cosLat * vz;
    heading[i] = Math.atan2(vEast, vNorth) * (180 / Math.PI);
  }

  const inlineAcc = new Float32Array(n);
  const yawRate = new Float32Array(n);
  const yawRateF64 = new Float64Array(n);
  const lateralAcc = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    let dt = (timecodes[i] - timecodes[i - 1]) / 1000.0;
    if (!(dt > 0)) dt = Infinity;
    inlineAcc[i] = Math.fround((speed[i] - speed[i - 1]) / dt / 9.81);
    let dh = heading[i] - heading[i - 1];
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    yawRateF64[i] = dh / dt;
    yawRate[i] = Math.fround(yawRateF64[i]);
  }
  for (let i = 0; i < n; i++) {
    lateralAcc[i] = Math.fround((speed[i] * yawRateF64[i] * (Math.PI / 180)) / 9.81);
  }

  return [
    makeGpsChannel("GPS Speed", "m/s", 1, true, timecodes, speed),
    makeGpsChannel("GPS Latitude", "deg", 4, true, timecodes, lat),
    makeGpsChannel("GPS Longitude", "deg", 4, true, timecodes, lon),
    makeGpsChannel("GPS Altitude", "m", 1, true, timecodes, alt),
    makeGpsChannel("GPS_Satellites", "", 0, false, timecodes, nsat),
    makeGpsChannel("GPS_Fix", "", 0, false, timecodes, fix),
    makeGpsChannel("GPS_pDOP", "", 2, false, timecodes, pdop),
    makeGpsChannel("GPS_Position_Accuracy", "m", 2, true, timecodes, posAcc),
    makeGpsChannel("GPS_Velocity_Accuracy", "m/s", 2, true, timecodes, velAcc),
    makeGpsChannel("GPS_InlineAcc", "g", 2, true, timecodes, inlineAcc),
    makeGpsChannel("GPS_LateralAcc", "g", 2, true, timecodes, lateralAcc),
    makeGpsChannel("GPS_Yaw_Rate", "deg/s", 1, true, timecodes, yawRate),
  ];
}

/** Decode GNFI (logger internal clock) timecodes. */
export function decodeGnfi(gnfiBytes: Uint8Array, timeOffset: number): Float64Array | null {
  if (gnfiBytes.length === 0 || gnfiBytes.length % 32 !== 0) return null;
  const n = gnfiBytes.length / 32;
  const dv = new DataView(gnfiBytes.buffer, gnfiBytes.byteOffset, gnfiBytes.byteLength);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 32, true) - timeOffset;
  return out;
}

/**
 * GPS-based lap detection via start/finish plane crossings.
 * Port of gps.py `find_laps`.
 */
export function findLaps(
  xyz: Float64Array, // n × 3 ECEF coordinates, meters
  timecodes: Float64Array, // n timecodes, ms
  sfLat: number,
  sfLong: number,
): number[] {
  const n = timecodes.length;
  if (n < 2) return [];
  const SO = lla2ecef(sfLat, sfLong, 0);
  const SD1 = lla2ecef(sfLat, sfLong, 1000);
  const SD = [SD1[0] - SO[0], SD1[1] - SO[1], SD1[2] - SO[2]];
  const sdDotSd = SD[0] * SD[0] + SD[1] * SD[1] + SD[2] * SD[2];

  const m = n - 1;
  // O = XYZ - SO (first m points); D = diff
  const Ox = new Float64Array(m);
  const Oy = new Float64Array(m);
  const Oz = new Float64Array(m);
  const Dx = new Float64Array(m);
  const Dy = new Float64Array(m);
  const Dz = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    Ox[i] = xyz[i * 3] - SO[0];
    Oy[i] = xyz[i * 3 + 1] - SO[1];
    Oz[i] = xyz[i * 3 + 2] - SO[2];
    Dx[i] = xyz[(i + 1) * 3] - xyz[i * 3];
    Dy[i] = xyz[(i + 1) * 3 + 1] - xyz[i * 3 + 1];
    Dz[i] = xyz[(i + 1) * 3 + 2] - xyz[i * 3 + 2];
  }

  const markerSize = 30; // meters

  // minspeed[i]: traveling at least 4 m/s over segment i
  const minspeed = new Uint8Array(m);
  for (let i = 0; i < m; i++) {
    const dd = Dx[i] * Dx[i] + Dy[i] * Dy[i] + Dz[i] * Dz[i];
    const dtm = (timecodes[i + 1] - timecodes[i]) * (4 / 1000);
    minspeed[i] = dd > dtm * dtm ? 1 : 0;
  }

  const computePass = (
    snx: Float64Array | null,
    sny: Float64Array | null,
    snz: Float64Array | null,
    fixedSN: [number, number, number] | null,
  ): { t: Float64Array; pick: Uint8Array; SNx: Float64Array; SNy: Float64Array; SNz: Float64Array } => {
    const t = new Float64Array(m);
    const dist = new Float64Array(m);
    const SNx = snx ?? new Float64Array(m);
    const SNy = sny ?? new Float64Array(m);
    const SNz = snz ?? new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let nx: number, ny: number, nz: number;
      if (fixedSN) {
        [nx, ny, nz] = fixedSN;
      } else {
        const sdDotD = SD[0] * Dx[i] + SD[1] * Dy[i] + SD[2] * Dz[i];
        nx = sdDotSd * Dx[i] - sdDotD * SD[0];
        ny = sdDotSd * Dy[i] - sdDotD * SD[1];
        nz = sdDotSd * Dz[i] - sdDotD * SD[2];
        SNx[i] = nx;
        SNy[i] = ny;
        SNz[i] = nz;
      }
      const denom = nx * Dx[i] + ny * Dy[i] + nz * Dz[i];
      const num = -(nx * Ox[i] + ny * Oy[i] + nz * Oz[i]);
      t[i] = Math.max(num / denom, 0);
      const px = Ox[i] + t[i] * Dx[i];
      const py = Oy[i] + t[i] * Dy[i];
      const pz = Oz[i] + t[i] * Dz[i];
      dist[i] = px * px + py * py + pz * pz;
    }
    const pick = new Uint8Array(m); // pick[i] refers to crossing at segment i (i>=1)
    for (let i = 1; i < m; i++) {
      pick[i] = t[i] <= 1 && t[i - 1] > 1 && dist[i] < markerSize * markerSize ? 1 : 0;
    }
    return { t, pick, SNx, SNy, SNz };
  };

  // Pass 1: per-segment plane normals
  const p1 = computePass(null, null, null, null);
  // Weighted average normal over picked & minspeed crossings
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let i = 1; i < m; i++) {
    if (p1.pick[i] && minspeed[i]) {
      ax += p1.SNx[i];
      ay += p1.SNy[i];
      az += p1.SNz[i];
    }
  }
  // Pass 2: single fixed normal
  const p2 = computePass(null, null, null, [ax, ay, az]);

  const lapMarkers: number[] = [0];
  for (let idx = 1; idx < m; idx++) {
    if (!p2.pick[idx]) continue;
    if (timecodes[idx] <= lapMarkers[lapMarkers.length - 1]) continue;
    let useIdx = idx;
    if (!minspeed[useIdx]) {
      let j = useIdx;
      while (j < m && !minspeed[j]) j++;
      useIdx = j < m ? j : useIdx; // argmax equivalent: first true after idx
    }
    lapMarkers.push(
      timecodes[useIdx] + p2.t[useIdx] * (timecodes[useIdx + 1] - timecodes[useIdx]),
    );
  }
  return lapMarkers.slice(1);
}

/**
 * Detect the ~65533ms GPS 16-bit overflow bug using GNFI as reference clock.
 * Port of gps.py `detect_gps_timing_offset_from_gnfi`.
 */
function detectOffsetFromGnfi(
  gpsTime: Float64Array,
  gnfi: Float64Array | null,
  expectedDtMs: number,
): Array<[number, number]> {
  if (!gnfi || gnfi.length < 2 || gpsTime.length < 2) return [];
  const OVERFLOW_BUG_MS = 65533;
  const TOLERANCE = 5000;
  const offset = gpsTime[gpsTime.length - 1] - gnfi[gnfi.length - 1];
  if (!(offset >= OVERFLOW_BUG_MS - TOLERANCE && offset <= OVERFLOW_BUG_MS + TOLERANCE)) {
    return [];
  }
  const gapThreshold = expectedDtMs * 10;
  let largestGapIdx = -1;
  let largestGap = 0;
  for (let i = 0; i < gpsTime.length - 1; i++) {
    const d = gpsTime[i + 1] - gpsTime[i];
    if (d > gapThreshold && d > largestGap) {
      largestGap = d;
      largestGapIdx = i;
    }
  }
  if (largestGapIdx < 0) return [];
  const gapTime = gpsTime[largestGapIdx];
  const correction =
    largestGap >= OVERFLOW_BUG_MS - TOLERANCE && largestGap <= OVERFLOW_BUG_MS + TOLERANCE
      ? largestGap - expectedDtMs
      : OVERFLOW_BUG_MS;
  return [[gapTime, Math.trunc(correction)]];
}

/**
 * Detect and correct spurious ~65533ms GPS timing gaps in-place across the
 * GPS channels (and optionally lap boundaries). Port of gps.py
 * `fix_gps_timing_gaps`.
 */
export function fixGpsTimingGaps(
  channels: Map<string, ChannelDef>,
  laps: XrkLap[],
  gnfiTimecodes: Float64Array | null,
  correctLaps: boolean,
  expectedDtMs = 40.0,
): void {
  const OVERFLOW_BUG_MS = 65533;
  const OVERFLOW_GAP_MIN = 60000;
  const OVERFLOW_GAP_MAX = 70000;

  let gpsChannel: ChannelDef | null = null;
  for (const name of GPS_CHANNEL_NAMES) {
    const ch = channels.get(name);
    if (ch) {
      gpsChannel = ch;
      break;
    }
  }
  if (!gpsChannel) return;
  const gpsTime = gpsChannel.timecodes;
  if (gpsTime.length < 2) return;

  const gapThreshold = expectedDtMs * 10;
  const gapIndices: number[] = [];
  for (let i = 0; i < gpsTime.length - 1; i++) {
    if (gpsTime[i + 1] - gpsTime[i] > gapThreshold) gapIndices.push(i);
  }
  if (gapIndices.length === 0) return;

  let corrections: Array<[number, number]> = [];

  // Method 1: GNFI-based
  corrections = detectOffsetFromGnfi(gpsTime, gnfiTimecodes, expectedDtMs);

  // Method 2: direct gap signature
  if (corrections.length === 0) {
    for (const gi of gapIndices) {
      const gapSize = gpsTime[gi + 1] - gpsTime[gi];
      if (gapSize >= OVERFLOW_GAP_MIN && gapSize <= OVERFLOW_GAP_MAX) {
        corrections.push([gpsTime[gi], gapSize - expectedDtMs]);
      }
    }
  }

  // Method 3: GPS extends ~65533ms beyond all other channels
  if (corrections.length === 0) {
    const gpsNames = new Set<string>(GPS_CHANNEL_NAMES);
    let maxNonGpsEnd = -Infinity;
    for (const [name, ch] of channels) {
      if (!gpsNames.has(name) && ch.timecodes.length) {
        maxNonGpsEnd = Math.max(maxNonGpsEnd, ch.timecodes[ch.timecodes.length - 1]);
      }
    }
    if (maxNonGpsEnd > -Infinity) {
      const endOffset = gpsTime[gpsTime.length - 1] - maxNonGpsEnd;
      if (endOffset >= OVERFLOW_GAP_MIN && endOffset <= OVERFLOW_GAP_MAX) {
        let largestGapIdx = gapIndices[0];
        let largestGap = 0;
        for (const gi of gapIndices) {
          const d = gpsTime[gi + 1] - gpsTime[gi];
          if (d > largestGap) {
            largestGap = d;
            largestGapIdx = gi;
          }
        }
        corrections.push([gpsTime[largestGapIdx], OVERFLOW_BUG_MS]);
      }
    }
  }

  if (corrections.length === 0) return;

  // Correct GPS timecodes (single shared array; write a fixed copy to each
  // GPS channel).
  const fixed = new Float64Array(gpsTime.length);
  fixed.set(gpsTime);
  for (const [gapTime, correction] of corrections) {
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i] > gapTime) fixed[i] -= correction;
    }
  }
  // int64 cast parity
  for (let i = 0; i < fixed.length; i++) fixed[i] = Math.trunc(fixed[i]);
  for (const name of GPS_CHANNEL_NAMES) {
    const ch = channels.get(name);
    if (ch) ch.timecodes = fixed;
  }

  if (correctLaps && laps.length) {
    for (const lap of laps) {
      for (const [gapTime, correction] of corrections) {
        if (lap.startTime > gapTime) lap.startTime -= correction;
        if (lap.endTime > gapTime) lap.endTime -= correction;
      }
      lap.startTime = Math.trunc(lap.startTime);
      lap.endTime = Math.trunc(lap.endTime);
    }
  }
}
