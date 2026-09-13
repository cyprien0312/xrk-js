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
function buildGpsRecord(
  tcMs: number,
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
  dv.setUint32(4, Math.round(tcMs), true); // iTOW stand-in
  dv.setInt16(12, 0, true); // GPS week
  p[14] = fix;
  p[15] = 0x0c; // fix status flags, as seen in real files

  const [x, y, z] = lla2ecef(latDeg, lonDeg, altM);
  dv.setInt32(16, Math.round(x * 100), true);
  dv.setInt32(20, Math.round(y * 100), true);
  dv.setInt32(24, Math.round(z * 100), true);
  dv.setUint32(28, 200, true); // position accuracy, cm

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
  dv.setUint32(44, 36, true); // velocity accuracy, cm/s
  dv.setUint16(48, Math.round(pdop * 100), true);
  p[51] = sats;
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

  const w = new Writer(1 << 20);

  // --- CNF: the channel configuration container -----------------------------
  const cnf = new Writer(1 << 14);
  channels.forEach((ch, i) => writeHeaderMsg(cnf, "CHS", buildChs(ch, i, 4)));
  writeHeaderMsg(w, "CNF", cnf.view());

  // --- Session metadata -----------------------------------------------------
  const simple: Array<[string, string | undefined]> = [
    ["RCR", metadata.driver],
    ["VEH", metadata.vehicle],
    ["CMP", metadata.series],
    ["VTY", metadata.session],
    ["NTE", metadata.comment],
    ["TMD", metadata.date],
    ["TMT", metadata.time],
  ];
  for (const [tok, value] of simple) {
    if (value !== undefined) writeHeaderMsg(w, tok, stringPayload(value));
  }
  if (metadata.venue !== undefined) {
    writeHeaderMsg(
      w,
      "TRK",
      buildTrk(metadata.venue, metadata.sfLat ?? 0, metadata.sfLon ?? 0),
      2,
    );
  }

  // --- Data, emitted in time-ordered windows --------------------------------
  let endMs = 0;
  for (const ch of channels) {
    endMs = Math.max(endMs, (ch.startMs ?? 0) + ch.values.length * ch.periodMs);
  }
  if (gps) {
    endMs = Math.max(endMs, (gps.startMs ?? 0) + gps.lat.length * gps.periodMs);
  }

  // Channels declared in V are stored as mV on the wire; the parser divides
  // by 1000 on the way back out.
  const wireScale = channels.map((ch) => (ch.units === "V" ? 1000 : 1));
  const cursor = channels.map(() => 0);
  let gpsCursor = 0;
  const msg = new Writer(1 << 16);

  for (let winStart = 0; winStart < endMs; winStart += windowMs) {
    const winEnd = winStart + windowMs;

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
      msg.u16(c);
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
        const payload = new Uint8Array((i - first) * 56);
        for (let k = first; k < i; k++) {
          payload.set(
            buildGpsRecord(
              start + k * gps.periodMs,
              gps.lat[k],
              gps.lon[k],
              at(gps.alt, k, 0),
              at(gps.speedMs, k, 0),
              at(gps.headingDeg, k, 0),
              at(gps.sats, k, 12),
              at(gps.fix, k, 3),
              at(gps.pdop, k, 1),
            ),
            (k - first) * 56,
          );
        }
        writeHeaderMsg(w, "GPS", payload);
      }
    }
  }

  // --- Laps -----------------------------------------------------------------
  if (laps) {
    laps.forEach((lap, i) => {
      writeHeaderMsg(w, "LAP", buildLap(i + 1, lap.startMs, lap.endMs));
    });
  }

  return new Uint8Array(w.view());
}
