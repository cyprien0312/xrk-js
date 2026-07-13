// Public and internal data types.

/** Numeric sample container types a channel may produce. */
export type SampleArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Uint8Array;

/** A parsed telemetry channel. */
export interface XrkChannel {
  /** Channel long name (unique key in the log). */
  name: string;
  shortName: string;
  units: string;
  decPts: number;
  /** Whether values should be interpolated (vs stepped) when resampling. */
  interpolate: boolean;
  /** AIM function classification (e.g. "Engine RPM"), may be "". */
  func: string;
  sourceType: number;
  sourceChannelId: number;
  deviceTag: string;
  calValue1: number;
  calValue2: number;
  displayRangeMin: number;
  displayRangeMax: number;
  /** Sample timestamps in ms since session start. */
  timecodes: Float64Array;
  /** Sample values, decoded and unit-fixed. */
  values: SampleArray;
}

/** A detected or recorded lap. */
export interface XrkLap {
  /** 0-based lap number. */
  num: number;
  /** Lap start, ms since session start. */
  startTime: number;
  /** Lap end, ms since session start. */
  endTime: number;
}

/** Result of parsing an XRK/XRZ file. */
export interface XrkLog {
  channels: Record<string, XrkChannel>;
  laps: XrkLap[];
  /** Session metadata: Driver, Vehicle, Venue, Log Date, ... */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal structures (mirror aim_xrk.pyx)
// ---------------------------------------------------------------------------

/** Channel definition from a CHS payload. */
export interface ChannelDef {
  index: number;
  shortName: string;
  longName: string;
  size: number;
  units: string;
  decPts: number;
  interpolate: boolean;
  /** Full 112-byte CHS payload with index/short/long zeroed (pyx `unknown`). */
  unknown: Uint8Array;
  func: string;
  sourceType: number;
  sourceChannelId: number;
  deviceTag: string;
  calValue1: number;
  calValue2: number;
  displayRangeMin: number;
  displayRangeMax: number;
  group: { group: GroupDef; offset: number } | null;
  timecodes: Float64Array;
  values: SampleArray;
  /** Set when values/timecodes have been populated by channel processing. */
  hasData: boolean;
}

/** Group definition from a GRP payload. */
export interface GroupDef {
  index: number;
  channels: number[];
  /** Raw accumulated rows (tc + idx + packed data). */
  rows: Uint8Array | null;
  rowStride: number;
  timecodes: Float64Array | null;
}

/** A parsed header message. */
export interface Msg {
  token: number;
  ver: number;
  content: unknown;
}

export type MessageMap = Map<number, Msg[]>;

/** Growable byte buffer. */
export class ByteVec {
  buf = new Uint8Array(1024);
  len = 0;

  ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  appendRange(src: Uint8Array, start: number, end: number): void {
    const n = end - start;
    this.ensure(n);
    this.buf.set(src.subarray(start, end), this.len);
    this.len += n;
  }

  pushByte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Growable int32 vector (for M-message timecodes). */
export class IntVec {
  buf = new Int32Array(256);
  len = 0;

  push(v: number): void {
    if (this.len === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = v;
  }

  view(): Int32Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Per-channel/group data accumulator (pyx `accum`). */
export interface Accum {
  lastTimecode: number;
  addHelper: number;
  Mms: number;
  data: ByteVec;
  timecodes: IntVec;
}

export function newAccum(): Accum {
  return {
    lastTimecode: -1,
    addHelper: 1,
    Mms: 0,
    data: new ByteVec(),
    timecodes: new IntVec(),
  };
}

/** Result of the low-level decode pass (pyx DataStream). */
export interface DataStream {
  /** long_name → processed channel def (with data). */
  channels: Map<string, ChannelDef>;
  messages: MessageMap;
  laps: XrkLap[];
  timeOffset: number;
  gnfiTimecodes: Float64Array | null;
  hasLapMessages: boolean;
}
