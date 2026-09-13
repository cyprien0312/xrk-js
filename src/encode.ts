// XRK encoder — the reverse of `parseXrk`.
//
// Writes a synthetic but well-formed AiM XRK byte stream: a CNF container of
// CHS channel definitions, session metadata messages, `(M` burst data
// messages, u-blox-style GPS records and LAP markers.
//
// Everything here is derived from the parser in this repo plus byte-level
// inspection of real logger files (an MXm `.xrk`); the field layouts are
// documented in LIMITATIONS.md §12. Only the subset of the format needed to
// round-trip through `parseXrk` is produced — see the "not emitted" list in
// LIMITATIONS.md §12.4.

import { lla2ecef } from "./gps.js";

/** unit string → CHS unit_type byte. Inverse of UNIT_MAP's useful subset. */
const UNIT_BYTE = new Map<string, number>([
  ["%", 1],
  ["g", 3],
  ["deg", 4],
  ["deg/s", 5],
  ["", 6],
  ["Hz", 9],
  ["mm", 12],
  ["bar", 14],
  ["rpm", 15],
  ["km/h", 16],
  ["C", 17],
  ["ms", 18],
  ["Nm", 19],
  ["mV", 21],
  ["V", 21 | 0x80], // calibrated-mV flag; parser divides by 1000
  ["l", 22],
  ["l/s", 24],
  ["A", 27],
  ["lambda", 30],
  ["gear", 31],
  ["kg", 43],
]);

/**
 * CHS template taken verbatim from a real MXm log (channel `OBDII_RPM`:
 * decoder 6 / float32 / 100 ms). Named fields are overwritten per channel;
 * the bytes we have no semantics for are inherited from the real file rather
 * than zeroed, which is the whole point of using a template.
 */
const CHS_TEMPLATE = Uint8Array.from([
  0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x0f, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
  0x52, 0x50, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x4f, 0x42, 0x44, 0x49,
  0x49, 0x5f, 0x52, 0x50, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xa0, 0x86, 0x01, 0x00, 0x96, 0x00, 0x00, 0x00,
  0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
  0x04, 0x00, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0xca, 0xf2, 0x49, 0xf1,
  0xca, 0xf2, 0x49, 0x71,
]);

/** TRK tail bytes observed in real files (semantics unknown, copied as-is). */
const TRK_TAIL = Uint8Array.from([0xd9, 0x36, 0x7a, 0xd9, 0x94, 0x10, 0x00, 0x00]);

/** Hex string -> bytes, for the opaque templates lifted out of real logs. */
function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

/**
 * Device-identity and configuration messages, copied byte-for-byte out of a
 * real MXm log. RaceStudio refuses a file that only carries CNF + session
 * strings ("no configuration tags found"), so these have to be present; their
 * internal structure is almost entirely unknown, which is exactly why they are
 * reproduced rather than synthesized.
 *
 * Consequence, stated plainly: a file carrying this block **claims to be an AiM
 * logger** (model 539, with a 635 expansion device) regardless of where the
 * data actually came from. See LIMITATIONS.md §12.9.
 */
const DEVICE = {
// SRC: 128 bytes
  SRC: hex(
    "69646e0138001b02010200005280630002284200022a4a00000000000100000000000000000000000000000000000000" +
    "0000000000000000000000000000000069646e0138000700020000000000000000000000010301000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000",
  ),
  // iSLV: 64 bytes
  iSLV: hex(
    "69646e0138007b026f08000054a15e0002283600022a2400000000000100000000000000000000000000000000000000" +
    "00000000000000000000000000000000",
  ),
  // HWNF: 33 bytes
  HWNF: hex(
    "576946693d45535033327c5265673d65757c5265763d30317c424e4f3035357c00",
  ),
  // ENF: 175 bytes
  ENF: hex(
    "3c684442554e02000000013e31003c4442554e31003e3c684442555404000000013e43414e003c44425554d2003e3c68" +
    "4456455209000000013e30332e30302e3038003c4456455287013e3c684d414e4c06000000013e4f42444949003c4d41" +
    "4e4c67013e3c684d4f444c04000000013e43414e003c4d4f444cd2003e3c684d414e4906000000013e4f42444949003c" +
    "4d414e4967013e3c684d4f444904000000013e43414e003c4d4f4449d2003e",
  ),
  // GPSR: 36 bytes
  GPSR: hex(
    "45f00b006947505300000000ffffffff010000000000230000000000000000009a010000",
  ),
  // PDLT: 18 bytes
  PDLT: hex(
    "42657374204c6170206f6620546573742e00",
  ),
} as const;

// Every one of these is a fixed-size structure in the files RaceStudio reads;
// a single stray byte shifts everything after it. An early hand-transcribed
// SRC was 129 bytes instead of 128, which corrupted the second `idn` record —
// this parser only reads the first one, so it looked fine here while
// RaceStudio reported "can't find aim device information". Hence the guard.
const DEVICE_SIZES: Record<keyof typeof DEVICE, number> = {
  SRC: 128, iSLV: 64, HWNF: 33, ENF: 175, GPSR: 36, PDLT: 18,
};
for (const [key, want] of Object.entries(DEVICE_SIZES)) {
  const got = DEVICE[key as keyof typeof DEVICE].length;
  if (got !== want) {
    throw new Error(`encodeXrk: ${key} template is ${got} bytes, expected ${want}`);
  }
}

/**
 * `Master Clk` (index 0) and `iGPS` (last index) CHS payloads, verbatim from a
 * real MXm log. Every AiM file declares these two: the master clock is the
 * logger time base, and `iGPS` is how the GPS stream is declared in CNF even
 * though its samples travel as separate `GPS` header messages.
 */
const SYS_CHS = {
// masterClk: 112 bytes
  masterClk: hex(
    "0000000000000000000000001215000004000000030000004d436c6b000000004d617374657220436c6b000000000000" +
    "00000000000000000000000000000000a086010000000000040000004041494d03100000010000000000000002000000" +
    "000000000000803f00000000caf24971",
  ),
  // iGps: 112 bytes
  iGps: hex(
    "2300000000000000000000009a0100000500000008000000694750530000000069475053000000000000000000000000" +
    "00000000000000000000000000000000409c0000c4000000380000000000000002000000ff000000ffffffff00000000" +
    "000000000000803f000000000000807f",
  ),
} as const;

for (const [key, tpl] of Object.entries(SYS_CHS)) {
  if (tpl.length !== 112) {
    throw new Error(`encodeXrk: ${key} CHS template is ${tpl.length} bytes, expected 112`);
  }
}

/** Copy a system CHS template with its channel index and sample period set. */
function buildSysChs(template: Uint8Array, index: number, periodMs: number): Uint8Array {
  const p = new Uint8Array(template);
  const dv = new DataView(p.buffer);
  dv.setUint16(0, index, true);
  dv.setUint32(64, periodMs * 1000, true);
  return p;
}

/** `ODO` — six 64-byte odometer records (System, Usr 1..4, Fuel Used). */
function buildOdo(totalTimeS: number, totalDistM: number): Uint8Array {
  const names = ["System", "Usr 1", "Usr 2", "Usr 3", "Usr 4", "Fuel Used"];
  const p = new Uint8Array(names.length * 64);
  const dv = new DataView(p.buffer);
  names.forEach((name, i) => {
    const off = i * 64;
    writeAscii(p, off, 16, name);
    const isFuel = name === "Fuel Used";
    dv.setUint32(off + 16, isFuel ? 0 : Math.round(totalTimeS), true);
    dv.setUint32(off + 20, isFuel ? 0 : Math.round(totalDistM), true);
    // [24] is a per-record flag in real files: 0x11 for System, 0x01 for the
    // user odometers, 0x20 for Fuel Used.
    p[off + 24] = isFuel ? 0x20 : i === 0 ? 0x11 : 0x01;
  });
  return p;
}

/** Overwrite the model/logger id inside a templated `idn`-bearing payload. */
function patchedIdentity(template: Uint8Array, modelId?: number, loggerId?: number): Uint8Array {
  if (modelId === undefined && loggerId === undefined) return template;
  const p = new Uint8Array(template);
  const dv = new DataView(p.buffer);
  if (modelId !== undefined) dv.setUint16(6, modelId, true);
  if (loggerId !== undefined) dv.setUint32(12, loggerId, true);
  return p;
}

/**
 * 4 opaque bytes per channel for `CDE`. Real files carry a different value for
 * every channel *and every session* — comparing three sessions of the same
 * logger, all 34 shared channels differ — so these are per-session throwaway
 * ids, not anything a reader can validate. A deterministic hash of the channel
 * name keeps our output byte-reproducible.
 */
function cdeValue(name: string, index: number): number {
  let h = 0x811c9dc5;
  const s = `${index}:${name}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** One channel to encode. Values are written as float32 at a fixed period. */
export interface EncodeChannel {
  /** Long name, max 23 chars (CHS field is 24 bytes incl. NUL). */
  name: string;
  /** Short name, max 7 chars. Defaults to a truncation of `name`. */
  shortName?: string;
  /** Unit string; must be a key of the encoder's unit table. Default "". */
  units?: string;
  /** Integer sample period in milliseconds (>= 1). */
  periodMs: number;
  /** Sample values, evenly spaced at `periodMs`. */
  values: ArrayLike<number>;
  /** Timecode of `values[0]` in ms. Default 0. */
  startMs?: number;
  /** CHS source_type byte (cosmetic; 9 = ECU-ish, 4 = internal). */
  sourceType?: number;
  /** CHS display_format byte; drives the reported `func` string. */
  displayFormat?: number;
}

/** GPS track to encode as u-blox NAV-SOL style records. */
export interface EncodeGps {
  /** Integer sample period in milliseconds. */
  periodMs: number;
  /** Timecode of sample 0 in ms. Default 0. */
  startMs?: number;
  /**
   * Degrees. A NaN in either array means "no record at this sample": the
   * message is simply not written, leaving a gap in the stream. Use this for
   * a no-fix period when you would rather show nothing than a held position.
   */
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  /** Metres. Default 0. */
  alt?: ArrayLike<number>;
  /** Ground speed in m/s. Default 0. */
  speedMs?: ArrayLike<number>;
  /** Heading in degrees (0 = north, clockwise). Default 0. */
  headingDeg?: ArrayLike<number>;
  /** Satellite count. Default 12. */
  sats?: ArrayLike<number>;
  /** Fix type (3 = 3D). Default 3. */
  fix?: ArrayLike<number>;
  /** Positional dilution of precision. Default 1.0. */
  pdop?: ArrayLike<number>;
  /**
   * UTC time of sample 0 as epoch milliseconds. When given, every record
   * carries a real GNSS week number and time-of-week; without it the
   * time-of-week is just the timecode and the week is 0 (January 1980), which
   * RaceStudio appears to treat as "no GPS".
   */
  utcStartMs?: number;
}

export interface EncodeLap {
  startMs: number;
  endMs: number;
}

export interface EncodeMetadata {
  driver?: string;
  vehicle?: string;
  venue?: string;
  session?: string;
  series?: string;
  comment?: string;
  /** "MM/DD/YYYY" */
  date?: string;
  /** "HH:MM:SS" */
  time?: string;
  /** Start/finish latitude in degrees (written into TRK). */
  sfLat?: number;
  /** Start/finish longitude in degrees (written into TRK). */
  sfLon?: number;
}

export interface EncodeOptions {
  channels: EncodeChannel[];
  gps?: EncodeGps;
  laps?: EncodeLap[];
  metadata?: EncodeMetadata;
  /**
   * Emit the AiM device-identity / configuration block (SRC, iSLV, HWNF, ENF,
   * GPSR, PDLT, ODO). Default true — RaceStudio reports "no configuration tags
   * found" without it. Setting `false` produces a leaner file that this
   * library still parses. Pass an object to override the advertised ids.
   *
   * Note what enabling this means: the file then identifies itself as an AiM
   * logger, whatever produced the data. See LIMITATIONS.md 12.9.
   */
  deviceIdentity?: boolean | { modelId?: number; loggerId?: number };
  /**
   * Data messages are emitted in time-ordered windows of this many ms so that
   * channels interleave the way a real logger writes them. Default 1000.
   */
  windowMs?: number;
}

/** Growable little-endian byte writer. */
class Writer {
  private buf: Uint8Array;
  private dv: DataView;
  len = 0;

  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
    this.dv = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(this.buf.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    this.ensure(2);
    this.dv.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
  }

  i32(v: number): void {
    this.ensure(4);
    this.dv.setInt32(this.len, v | 0, true);
    this.len += 4;
  }

  u32(v: number): void {
    this.ensure(4);
    this.dv.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    this.dv.setFloat32(this.len, Number.isFinite(v) ? v : 0, true);
    this.len += 4;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Encode a 3/4-char ASCII token as its uint32 wire value (high byte 0). */
function tokenWord(tok: string): number {
  let v = 0;
  for (let i = tok.length - 1; i >= 0; i--) v = v * 256 + tok.charCodeAt(i);
  return v >>> 0;
}

/** Write a framed header message: `<h TOK len ver > payload < TOK sum >`. */
function writeHeaderMsg(w: Writer, tok: string, payload: Uint8Array, ver = 1): void {
  const word = tokenWord(tok);
  w.u8(0x3c); // '<'
  w.u8(0x68); // 'h'
  w.u32(word);
  w.i32(payload.length);
  w.u8(ver);
  w.u8(0x3e); // '>'
  w.bytes(payload);
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += payload[i];
  w.u8(0x3c); // '<'
  w.u32(word);
  w.u16(sum & 0xffff);
  w.u8(0x3e); // '>'
}

/** NUL-terminated ASCII payload (what the string metadata tokens carry). */
function stringPayload(s: string): Uint8Array {
  const out = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

function writeAscii(buf: Uint8Array, offset: number, field: number, s: string): void {
  buf.fill(0, offset, offset + field);
  const n = Math.min(s.length, field - 1);
  for (let i = 0; i < n; i++) buf[offset + i] = s.charCodeAt(i) & 0x7f;
}

/** Build the 112-byte CHS payload for one channel. */
function buildChs(ch: EncodeChannel, index: number, sizeBytes: number): Uint8Array {
  const p = new Uint8Array(CHS_TEMPLATE); // copy the proven byte pattern
  const dv = new DataView(p.buffer);
  const units = ch.units ?? "";
  const unitByte = UNIT_BYTE.get(units);
  if (unitByte === undefined) throw new Error(`encodeXrk: unsupported unit ${JSON.stringify(units)}`);

  dv.setUint16(0, index, true); // channel index
  dv.setUint16(4, 0, true); // hw id — 0 keeps us out of the V2/V3 expansion path
  dv.setUint16(6, 0, true); // source channel id
  dv.setUint32(8, 0, true); // hw ref
  p[12] = unitByte;
  p[13] = ch.displayFormat ?? 0;
  dv.setUint16(14, 0, true); // config flags
  p[16] = ch.sourceType ?? 9;
  p[20] = 6; // decoder 6 = float32, interpolated
  writeAscii(p, 24, 8, ch.shortName ?? ch.name.slice(0, 7));
  writeAscii(p, 32, 24, ch.name);
  dv.setUint32(64, ch.periodMs * 1000, true); // sample period in microseconds
  dv.setUint32(68, 150 + index, true); // per-channel id (observed to increment)
  p[72] = sizeBytes;
  dv.setUint32(88, 48 + index * 8, true); // second per-channel id
  dv.setFloat32(96, 0, true); // cal value 1
  dv.setFloat32(100, 1, true); // cal value 2
  dv.setFloat32(104, -1e30, true); // display range min
  dv.setFloat32(108, 1e30, true); // display range max
  return p;
}

/** Build the 96-byte TRK payload (track name + start/finish coordinates). */
function buildTrk(name: string, sfLat: number, sfLon: number): Uint8Array {
  const p = new Uint8Array(96);
  const dv = new DataView(p.buffer);
  writeAscii(p, 0, 32, name);
  p[33] = 0x09; // observed constant
  dv.setInt32(36, Math.round(sfLat * 1e7), true);
  dv.setInt32(40, Math.round(sfLon * 1e7), true);
  p.set(TRK_TAIL, 88);
  return p;
}

/** Build one 20-byte LAP payload. */
function buildLap(lapNum: number, startMs: number, endMs: number): Uint8Array {
  const p = new Uint8Array(20);
  const dv = new DataView(p.buffer);
  p[0] = 0x20; // observed constant
  p[1] = 0; // segment 0 — non-zero segments are skipped by the parser
  dv.setUint16(2, lapNum, true);
  // A lap is stored as (end, duration) and read back as (end - duration, end),
  // so both must be rounded before subtracting. Rounding them independently
  // shifts the recovered start by a millisecond and breaks contiguity with the
  // previous lap's end.
  const end = Math.round(endMs);
  const start = Math.round(startMs);
  dv.setUint32(4, Math.max(0, end - start), true);
  p[12] = 0x04; // observed constant
  p[13] = 0x02; // observed constant
  dv.setUint32(16, end, true);
  return p;
}

/** Build one 56-byte GPS record: 4-byte AiM timecode + u-blox NAV-SOL body. */
/** GPS epoch and the current UTC->GPS leap-second offset (18 s since 2017). */
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const GPS_LEAP_MS = 18_000;
const WEEK_MS = 7 * 24 * 3600 * 1000;

function buildGpsRecord(
  tcMs: number,
  utcMs: number | null,
  latDeg: number,
  lonDeg: number,
  altM: number,
  speedMs: number,
  headingDeg: number,
  sats: number,
  fix: number,
  pdop: number,
): Uint8Array {
  const p = new Uint8Array(56);
  const dv = new DataView(p.buffer);
  dv.setInt32(0, Math.round(tcMs), true);
  if (utcMs !== null) {
    const gpsMs = utcMs + GPS_LEAP_MS - GPS_EPOCH_MS;
    const week = Math.floor(gpsMs / WEEK_MS);
    dv.setUint32(4, Math.round(gpsMs - week * WEEK_MS), true); // iTOW
    dv.setInt16(12, week, true);
  } else {
    dv.setUint32(4, Math.round(tcMs), true); // iTOW stand-in
    dv.setInt16(12, 0, true);
  }
  p[14] = fix;
  p[15] = 0x0c; // fix status flags, as seen in real files

  const [x, y, z] = lla2ecef(latDeg, lonDeg, altM);
  dv.setInt32(16, Math.round(x * 100), true);
  dv.setInt32(20, Math.round(y * 100), true);
  dv.setInt32(24, Math.round(z * 100), true);
  // Accuracy fields as a real receiver reports them: ~2 m / 0.36 m/s with a
  // 3D fix, and 39 km / 20 m/s with no fix at all (copied from a real MXm
  // log's no-fix records). Claiming 2 m accuracy on a fix=0 sample is a
  // contradiction a reader may act on.
  const noFix = fix === 0;
  dv.setUint32(28, noFix ? 3908122 : 200, true); // position accuracy, cm

  // Ground speed + heading → ENU → ECEF velocity (transpose of the parser's
  // ECEF→ENU rotation, so decodeGps recovers the same speed and heading).
  const latR = latDeg * (Math.PI / 180);
  const lonR = lonDeg * (Math.PI / 180);
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinLon = Math.sin(lonR);
  const cosLon = Math.cos(lonR);
  const hdgR = headingDeg * (Math.PI / 180);
  const vEast = speedMs * Math.sin(hdgR);
  const vNorth = speedMs * Math.cos(hdgR);
  const vx = -sinLon * vEast - sinLat * cosLon * vNorth;
  const vy = cosLon * vEast - sinLat * sinLon * vNorth;
  const vz = cosLat * vNorth;
  dv.setInt32(32, Math.round(vx * 100), true);
  dv.setInt32(36, Math.round(vy * 100), true);
  dv.setInt32(40, Math.round(vz * 100), true);
  dv.setUint32(44, noFix ? 2000 : 36, true); // velocity accuracy, cm/s
  dv.setUint16(48, Math.round(pdop * 100), true);
  p[51] = sats;
  p[53] = 0x10; // reserved tail is 00 10 00 00 in every real record seen
  return p;
}

function at(a: ArrayLike<number> | undefined, i: number, fallback: number): number {
  if (!a || i >= a.length) return fallback;
  const v = a[i];
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Encode channels, GPS, laps and metadata into an uncompressed XRK byte
 * stream that `parseXrk` reads back.
 *
 * All channels are written as float32 `(M` bursts at a fixed integer-ms
 * period; values in `V` are scaled to mV so the parser's mV→V conversion
 * recovers them.
 */
export function encodeXrk(opts: EncodeOptions): Uint8Array {
  const { channels, gps, laps, metadata = {} } = opts;
  const windowMs = opts.windowMs ?? 1000;
  if (windowMs <= 0) throw new Error("encodeXrk: windowMs must be positive");
  const identityOpt = opts.deviceIdentity ?? true;
  const emitIdentity = identityOpt !== false;
  const device = typeof identityOpt === "object" ? identityOpt : {};

  for (const ch of channels) {
    if (!Number.isInteger(ch.periodMs) || ch.periodMs < 1) {
      throw new Error(`encodeXrk: channel ${ch.name} needs an integer periodMs >= 1`);
    }
    if (ch.name.length > 23) {
      throw new Error(`encodeXrk: channel name too long (max 23): ${ch.name}`);
    }
  }
  if (gps && (!Number.isInteger(gps.periodMs) || gps.periodMs < 1)) {
    throw new Error("encodeXrk: gps.periodMs must be an integer >= 1");
  }

  let endMs = 0;
  for (const ch of channels) {
    endMs = Math.max(endMs, (ch.startMs ?? 0) + ch.values.length * ch.periodMs);
  }
  if (gps) {
    endMs = Math.max(endMs, (gps.startMs ?? 0) + gps.lat.length * gps.periodMs);
  }

  // Index 0 is the master clock in every real file, so user channels start at
  // 1 and the GPS declaration takes the last slot.
  const CLK_PERIOD_MS = 100;
  const clkIndex = emitIdentity ? 0 : -1;
  const userBase = emitIdentity ? 1 : 0;
  const gpsIndex = emitIdentity && gps ? userBase + channels.length : -1;

  const w = new Writer(1 << 20);

  // --- CNF: the channel configuration container -----------------------------
  // Real files pair every CHS with a CDE carrying the same channel index, and
  // RaceStudio rejects a CNF that has only CHS.
  const cnf = new Writer(1 << 14);
  const writeCde = (index: number, name: string) => {
    const cde = new Uint8Array(6);
    const cdv = new DataView(cde.buffer);
    cdv.setUint16(0, index, true);
    cdv.setUint32(2, cdeValue(name, index), true);
    writeHeaderMsg(cnf, "CDE", cde);
  };
  if (clkIndex >= 0) {
    writeHeaderMsg(cnf, "CHS", buildSysChs(SYS_CHS.masterClk, clkIndex, CLK_PERIOD_MS));
    writeCde(clkIndex, "Master Clk");
  }
  channels.forEach((ch, i) => {
    writeHeaderMsg(cnf, "CHS", buildChs(ch, userBase + i, 4));
    writeCde(userBase + i, ch.name);
  });
  if (gpsIndex >= 0 && gps) {
    writeHeaderMsg(cnf, "CHS", buildSysChs(SYS_CHS.iGps, gpsIndex, gps.periodMs));
    writeCde(gpsIndex, "iGPS");
  }
  const cnfPayload = new Uint8Array(cnf.view()); // reused: real files repeat it
  writeHeaderMsg(w, "CNF", cnfPayload);

  // --- Header block, in the order a real logger writes it --------------------
  // The session strings appear twice in a real file: empty placeholders here,
  // then the real values at the very end (the logger fills them in when the
  // session closes). `getMetadata` takes the last of each, so the trailing
  // copies are what a reader sees.
  const EMPTY = Uint8Array.from([0]);
  for (const tok of ["RCR", "VEH", "CMP", "VTY", "NDV", "RACM", "VET"]) {
    writeHeaderMsg(w, tok, EMPTY);
  }

  if (emitIdentity) {
    writeHeaderMsg(w, "SRC", patchedIdentity(DEVICE.SRC, device.modelId, device.loggerId));
    writeHeaderMsg(w, "iSLV", DEVICE.iSLV);
    writeHeaderMsg(w, "HWNF", DEVICE.HWNF);
    writeHeaderMsg(w, "ENF", DEVICE.ENF);
    writeHeaderMsg(w, "RACM", stringPayload("speed"));
  }

  if (metadata.venue !== undefined) {
    // The token is "TRK " with a trailing space in real files, not "TRK\0".
    writeHeaderMsg(
      w,
      "TRK ",
      buildTrk(metadata.venue, metadata.sfLat ?? 0, metadata.sfLon ?? 0),
      2,
    );
  }
  if (emitIdentity) writeHeaderMsg(w, "PDLT", DEVICE.PDLT);
  if (metadata.date !== undefined) writeHeaderMsg(w, "TMD", stringPayload(metadata.date));
  if (metadata.time !== undefined) writeHeaderMsg(w, "TMT", stringPayload(metadata.time));

  // Session totals, used by both ODO copies.
  let sessionDistM = 0;
  if (gps) {
    const step = gps.periodMs / 1000;
    for (let i = 0; i < gps.lat.length; i++) sessionDistM += at(gps.speedMs, i, 0) * step;
  }
  if (emitIdentity) {
    // Real logs close the header with ODO, then repeat the whole CNF and
    // declare the GPS receiver before any samples appear.
    writeHeaderMsg(w, "ODO", buildOdo(endMs / 1000, sessionDistM));
    writeHeaderMsg(w, "CNF", cnfPayload);
    writeHeaderMsg(w, "GPSR", DEVICE.GPSR);
  }

  // --- Data, emitted in time-ordered windows --------------------------------
  // Channels declared in V are stored as mV on the wire; the parser divides
  // by 1000 on the way back out.
  const wireScale = channels.map((ch) => (ch.units === "V" ? 1000 : 1));
  const cursor = channels.map(() => 0);
  let gpsCursor = 0;
  const msg = new Writer(1 << 16);

  for (let winStart = 0; winStart < endMs; winStart += windowMs) {
    const winEnd = winStart + windowMs;

    // Master clock: decoder 3 is a plain int32, and the value is the timecode
    // itself — this is the logger's time base, not a measurement.
    if (clkIndex >= 0) {
      const first = Math.ceil(winStart / CLK_PERIOD_MS);
      const last = Math.ceil(Math.min(winEnd, endMs) / CLK_PERIOD_MS);
      if (last > first) {
        msg.len = 0;
        msg.u8(0x28);
        msg.u8(0x4d);
        msg.i32(first * CLK_PERIOD_MS);
        msg.u16(clkIndex);
        msg.u16(last - first);
        for (let k = first; k < last; k++) msg.i32(k * CLK_PERIOD_MS);
        msg.u8(0x29);
        w.bytes(msg.view());
      }
    }

    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      const start = ch.startMs ?? 0;
      let i = cursor[c];
      const first = i;
      while (i < ch.values.length && start + i * ch.periodMs < winEnd) i++;
      if (i === first) continue;
      cursor[c] = i;

      msg.len = 0;
      msg.u8(0x28); // '('
      msg.u8(0x4d); // 'M'
      msg.i32(start + first * ch.periodMs);
      msg.u16(userBase + c);
      msg.u16(i - first);
      const sc = wireScale[c];
      for (let k = first; k < i; k++) msg.f32(ch.values[k] * sc);
      msg.u8(0x29); // ')'
      w.bytes(msg.view());
    }

    if (gps) {
      const start = gps.startMs ?? 0;
      const n = gps.lat.length;
      let i = gpsCursor;
      const first = i;
      while (i < n && start + i * gps.periodMs < winEnd) i++;
      if (i > first) {
        gpsCursor = i;
        // One record per message. Real loggers never batch them, and the
        // parser's concatenation tolerance is not something RaceStudio shares.
        for (let k = first; k < i; k++) {
          const la = gps.lat[k];
          const lo = gps.lon[k];
          if (!Number.isFinite(la) || !Number.isFinite(lo)) continue; // gap
          const tc = start + k * gps.periodMs;
          writeHeaderMsg(
            w,
            "GPS",
            buildGpsRecord(
              tc,
              gps.utcStartMs !== undefined ? gps.utcStartMs + k * gps.periodMs : null,
              la,
              lo,
              at(gps.alt, k, 0),
              at(gps.speedMs, k, 0),
              at(gps.headingDeg, k, 0),
              at(gps.sats, k, 12),
              at(gps.fix, k, 3),
              at(gps.pdop, k, 1),
            ),
          );
        }
      }
    }
  }

  // --- Laps -----------------------------------------------------------------
  if (laps) {
    laps.forEach((lap, i) => {
      writeHeaderMsg(w, "LAP", buildLap(i + 1, lap.startMs, lap.endMs));
    });
  }

  // --- Trailing block: odometers, then the real session strings --------------
  // Real logs re-emit ODO periodically; one closing copy is enough here.
  if (emitIdentity) writeHeaderMsg(w, "ODO", buildOdo(endMs / 1000, sessionDistM));
  // Version 0, matching the real files: these are the values a reader keeps.
  const trailing: Array<[string, string | undefined]> = [
    ["RCR", metadata.driver],
    ["VEH", metadata.vehicle],
    ["CMP", metadata.series],
    ["VTY", metadata.session],
    ["NTE", metadata.comment],
  ];
  for (const [tok, value] of trailing) {
    if (value !== undefined) {
      // Trailing strings are written without the NUL terminator in real files.
      const bytes = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0x7f;
      writeHeaderMsg(w, tok, bytes, 0);
    }
  }

  return new Uint8Array(w.view());
}
