// Channel/group sample assembly — port of `process_group` / `process_channel`
// from aim_xrk.pyx.

import {
  DECODERS,
  MANUAL_DECODERS,
  STYPE_SIZE,
  fp16ToFloat,
  type DecoderSpec,
} from "./constants";
import type { RawParse } from "./parser";
import type { ChannelDef, GroupDef, SampleArray } from "./types";

/** Gear lookup for decoder 15: ASCII 'N'→0, '1'..'6'→1..6, else identity. */
function gearLookup(v: number): number {
  if (v === 0x4e) return 0; // 'N'
  if (v >= 0x31 && v <= 0x36) return v - 0x30; // '1'..'6'
  return v;
}

/** Read strided samples of struct type `stype` out of a raw row buffer. */
function readStrided(
  buf: Uint8Array,
  byteOffset: number,
  stride: number,
  rows: number,
  stype: string,
): SampleArray {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  switch (stype) {
    case "i": {
      const out = new Int32Array(rows);
      for (let r = 0; r < rows; r++) out[r] = dv.getInt32(byteOffset + r * stride, true);
      return out;
    }
    case "H": {
      const out = new Uint16Array(rows);
      for (let r = 0; r < rows; r++) out[r] = dv.getUint16(byteOffset + r * stride, true);
      return out;
    }
    case "h": {
      const out = new Int16Array(rows);
      for (let r = 0; r < rows; r++) out[r] = dv.getInt16(byteOffset + r * stride, true);
      return out;
    }
    case "f": {
      const out = new Float32Array(rows);
      for (let r = 0; r < rows; r++) out[r] = dv.getFloat32(byteOffset + r * stride, true);
      return out;
    }
    case "B": {
      const out = new Uint8Array(rows);
      for (let r = 0; r < rows; r++) out[r] = buf[byteOffset + r * stride];
      return out;
    }
    case "Q": {
      // Only used by Calculated_Gear/PreCalcGear whose fixup reads bits 16-19,
      // so the low 32-bit word carries all needed information.
      const out = new Uint32Array(rows);
      for (let r = 0; r < rows; r++) out[r] = dv.getUint32(byteOffset + r * stride, true);
      return out;
    }
    default:
      throw new Error(`unknown stype ${stype}`);
  }
}

/** Strided int32 timecodes from a raw row buffer, minus the session offset. */
function readTimecodes(
  buf: Uint8Array,
  stride: number,
  rows: number,
  timeOffset: number,
): Float64Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float64Array(rows);
  for (let r = 0; r < rows; r++) out[r] = dv.getInt32(r * stride, true) - timeOffset;
  return out;
}

function applyFixup(values: SampleArray, fixup: DecoderSpec["fixup"]): SampleArray {
  if (fixup === "gear") {
    const out = new Uint16Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = gearLookup(values[i] as number);
    return out;
  }
  if (fixup === "fp16") {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = fp16ToFloat(values[i] as number);
    return out;
  }
  if (fixup === "calcGear") {
    const out = new Uint32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const x = values[i] as number;
      out[i] = x & 0x80000 ? 0 : (x >> 16) & 7;
    }
    return out;
  }
  return values;
}

function decoderFor(ch: ChannelDef): DecoderSpec | undefined {
  return MANUAL_DECODERS.get(ch.longName) ?? DECODERS.get(ch.unknown[20]);
}

/** Populate group timecodes and process all member channels. */
export function processGroup(
  g: GroupDef,
  state: RawParse,
  timeOffset: number,
): void {
  g.rows = null;
  g.timecodes = new Float64Array(0);
  if (g.index < state.gc[0].length) {
    const acc = state.gc[0][g.index];
    if (acc.data.len) {
      g.rows = acc.data.view();
      g.rowStride = acc.addHelper - 3;
      const rows = Math.floor(g.rows.length / g.rowStride);
      g.timecodes = readTimecodes(g.rows, g.rowStride, rows, timeOffset);
    }
  }
  for (const chIdx of g.channels) {
    const ch = state.channels[chIdx];
    if (ch) processChannel(ch, state, timeOffset);
  }
}

/** Assemble a channel's timecodes and decoded values. */
export function processChannel(
  ch: ChannelDef,
  state: RawParse,
  timeOffset: number,
): void {
  const d = decoderFor(ch);
  if (!d) return;

  ch.interpolate = d.interpolate;
  const sampleSize = STYPE_SIZE[d.stype];

  if (ch.group) {
    const grp = ch.group.group;
    ch.timecodes = grp.timecodes ?? new Float64Array(0);
    if (grp.rows && grp.timecodes && grp.timecodes.length) {
      ch.values = readStrided(
        grp.rows,
        ch.group.offset,
        grp.rowStride,
        grp.timecodes.length,
        d.stype,
      );
    } else {
      ch.values = readStrided(new Uint8Array(0), 0, sampleSize, 0, d.stype);
    }
  } else {
    // S messages first, then expansion (c) messages, then M bursts.
    let viewOffset = 6;
    let strideOffset = 3;
    let acc = ch.index < state.gc[1].length ? state.gc[1][ch.index] : null;
    if (!acc || !acc.data.len) {
      viewOffset = 4;
      strideOffset = 8;
      acc = ch.index < state.gc[2].length ? state.gc[2][ch.index] : null;
    }
    if (acc && acc.data.len) {
      if (ch.timecodes.length !== 0) {
        throw new Error(`Can't have both S/c and M records for channel ${ch.longName}`);
      }
      const view = acc.data.view();
      const stride = acc.addHelper - strideOffset;
      const rows = Math.floor(view.length / stride);
      ch.timecodes = readTimecodes(view, stride, rows, timeOffset);
      ch.values = readStrided(view, viewOffset, stride, rows, d.stype);
    } else {
      const mAcc = ch.index < state.gc[3].length ? state.gc[3][ch.index] : null;
      if (mAcc && mAcc.timecodes.len) {
        const n = mAcc.timecodes.len;
        const tcs = new Float64Array(n);
        for (let i = 0; i < n; i++) tcs[i] = mAcc.timecodes.buf[i] - timeOffset;
        ch.timecodes = tcs;
        ch.values = readStrided(mAcc.data.view(), 0, sampleSize, n, d.stype);
      } else {
        ch.timecodes = new Float64Array(0);
        ch.values = new Float64Array(0);
      }
    }
  }

  if (d.fixup) ch.values = applyFixup(ch.values, d.fixup);
  if (ch.units === "V") {
    // unit_type 21 is mV; the calibrated flag converts to V
    const out = new Float64Array(ch.values.length);
    for (let i = 0; i < ch.values.length; i++) out[i] = (ch.values[i] as number) / 1000;
    ch.values = out;
  }
  ch.hasData = ch.values.length > 0;
}
