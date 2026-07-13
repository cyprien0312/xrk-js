// Low-level XRK stream parser — a faithful port of `_decode_sequence` from
// libxrk's src/libxrk/aim_xrk.pyx (MIT, Copyright 2024 Scott Smith).
//
// The stream is a sequence of framed messages:
//   header messages:  <h TOK len ver > payload < TOK checksum >
//   data messages:    (S ...  (G ...  (M ...  (c ...
// Unparseable bytes are skipped one at a time (bad-byte recovery), matching
// the reference implementation.

import { nulltermString, tokdec, UNIT_MAP, resolveFunction } from "./constants.js";
import {
  Accum,
  ByteVec,
  ChannelDef,
  GroupDef,
  MessageMap,
  Msg,
  newAccum,
} from "./types.js";

const OP_G = 0x4728; // "(G"
const OP_S = 0x5328; // "(S"
const OP_M = 0x4d28; // "(M"
const OP_c = 0x6328; // "(c"
const OP_h = 0x683c; // "<h"
const CP = 0x29; // ")"
const LT = 0x3c; // "<"
const GT = 0x3e; // ">"

const TOK_GPS = tokdec("GPS");
const TOK_GPS1 = tokdec("GPS1");
const TOK_GNFI = tokdec("GNFI");
const TOK_CNF = tokdec("CNF");
const TOK_ENF = tokdec("ENF");
const TOK_GRP = tokdec("GRP");
const TOK_CDE = tokdec("CDE");
const TOK_CHS = tokdec("CHS");
const TOK_LAP = tokdec("LAP");
const TOK_IDN = tokdec("idn");
const TOK_SRC = tokdec("SRC");
const TOK_GPSR = tokdec("GPSR");
const TOK_RACM = tokdec("RACM");
const TOK_VET = tokdec("VET");
const TOK_ISLV = tokdec("iSLV");
const TOK_CAL = tokdec("CAL");
const TOK_TRK = tokdec("TRK");
const TOK_ODO = tokdec("ODO");

const STRING_TOKENS = new Set(
  [
    "RCR", "VEH", "CMP", "VTY", "NDV", "TMD", "TMT",
    "DBUN", "DBUT", "DVER", "MANL", "MODL", "MANI",
    "MODI", "HWNF", "PDLT", "NTE", "+LM", "MAN", "MOD",
  ].map(tokdec),
);

/** V2/V3 expansion-message sample: [timecode, byte0, byte1, priority, order] */
type V2V3Entry = [number, number, number, number, number];

/** Raw parse state (pyx locals of `_decode_sequence`). */
export interface RawParse {
  messages: MessageMap;
  /** Sparse list indexed by channel index; only CNF-registered channels. */
  channels: (ChannelDef | null)[];
  groups: (GroupDef | null)[];
  /** Accumulators: [0]=G(groups) [1]=S [2]=c [3]=M, indexed by channel/group. */
  gc: [Accum[], Accum[], Accum[], Accum[]];
  gpsBytes: ByteVec;
  gnfiBytes: ByteVec;
  /** From first LAP message (end_time - duration), or null. */
  lapTimeOffset: number | null;
  lapLastTime: number | null;
}

function resize(arr: Accum[], idx: number): void {
  while (arr.length <= idx) arr.push(newAccum());
}

function parseChs(payload: Uint8Array): ChannelDef {
  // struct.unpack parity: CHS payloads are exactly 112 bytes
  if (payload.length !== 112) throw new Error("CHS wrong size");
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const unitByte = payload[12];
  let units = "";
  let decPts = 0;
  const um = UNIT_MAP.get(unitByte & 127);
  if (um) {
    units = um[0];
    decPts = um[1];
  }
  if (unitByte & 0x80 && units === "mV") units = "V";
  const deviceTagBytes = payload.subarray(76, 80);
  const hasTag = deviceTagBytes.some((b) => b !== 0);
  const copy = new Uint8Array(payload); // true copy (never a Buffer view)
  copy.fill(0, 0, 2); // index
  copy.fill(0, 24, 32); // short name
  copy.fill(0, 32, 56); // long name
  return {
    index: dv.getUint16(0, true),
    shortName: nulltermString(payload.subarray(24, 32)),
    longName: nulltermString(payload.subarray(32, 56)),
    size: payload[72],
    units,
    decPts,
    interpolate: false,
    unknown: copy,
    func: resolveFunction(payload[13], payload[12], dv.getUint16(14, true)),
    sourceType: payload[16],
    sourceChannelId: dv.getUint16(6, true),
    deviceTag: hasTag ? nulltermString(deviceTagBytes) : "",
    calValue1: dv.getFloat32(96, true),
    calValue2: dv.getFloat32(100, true),
    displayRangeMin: dv.getFloat32(104, true),
    displayRangeMax: dv.getFloat32(108, true),
    group: null,
    timecodes: new Float64Array(0),
    values: new Float64Array(0),
    hasData: false,
  };
}

function parseGrp(payload: Uint8Array): GroupDef {
  if (payload.length < 4 || payload.length % 2 !== 0) throw new Error("bad GRP");
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const index = dv.getUint16(0, true);
  const count = dv.getUint16(2, true);
  const channels: number[] = [];
  for (let i = 4; i < payload.length; i += 2) channels.push(dv.getUint16(i, true));
  if (count !== channels.length) {
    throw new Error(`GRP channel count mismatch: ${count} vs ${channels.length}`);
  }
  return { index, channels, rows: null, rowStride: 0, timecodes: null };
}

function parseHeaderContent(
  tok: number,
  payload: Uint8Array,
  state: RawParse,
): unknown {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (tok === TOK_CNF) {
    // Recursive config container: register channels and groups.
    // Reset dedup timecodes so data after a CNF boundary isn't dropped.
    for (const cat of state.gc) {
      for (const acc of cat) acc.lastTimecode = -1;
    }
    const sub = parseRaw(payload).messages;
    const chsMsgs = sub.get(TOK_CHS);
    if (!chsMsgs) throw new Error("CNF without CHS");
    for (const m of chsMsgs) {
      const ch = m.content as ChannelDef;
      while (state.channels.length <= ch.index) state.channels.push(null);
      const existing = state.channels[ch.index];
      if (!existing) {
        state.channels[ch.index] = ch;
        resize(state.gc[1], ch.index);
        state.gc[1][ch.index].addHelper = ch.size + 9;
        resize(state.gc[2], ch.index);
        state.gc[2][ch.index].addHelper = ch.size + 12;
        resize(state.gc[3], ch.index);
        state.gc[3][ch.index].addHelper = ch.size;
        const dvu = new DataView(ch.unknown.buffer, ch.unknown.byteOffset, ch.unknown.byteLength);
        state.gc[3][ch.index].Mms = Math.floor(dvu.getUint32(64, true) / 1000);
      } else {
        if (existing.shortName !== ch.shortName) {
          throw new Error(`Channel short_name mismatch: ${existing.shortName} vs ${ch.shortName}`);
        }
        if (existing.longName !== ch.longName) {
          throw new Error(`Channel long_name mismatch: ${existing.longName} vs ${ch.longName}`);
        }
      }
    }
    for (const m of sub.get(TOK_GRP) ?? []) {
      const grp = m.content as GroupDef;
      while (state.groups.length <= grp.index) state.groups.push(null);
      state.groups[grp.index] = grp;
      let off = 6;
      let total = 0;
      for (const chIdx of grp.channels) {
        const ch = state.channels[chIdx];
        if (!ch) throw new Error(`GRP references unknown channel ${chIdx}`);
        ch.group = { group: grp, offset: off };
        off += ch.size;
        total += ch.size;
      }
      resize(state.gc[0], grp.index);
      state.gc[0][grp.index].addHelper = 9 + total;
    }
    return sub;
  }
  if (tok === TOK_ENF) return parseRaw(payload).messages;
  if (tok === TOK_GRP) return parseGrp(payload);
  if (tok === TOK_CDE) {
    return Array.from(payload, (b) => b.toString(16).padStart(2, "0"));
  }
  if (tok === TOK_CHS) return parseChs(payload);
  if (tok === TOK_LAP) {
    // struct.unpack parity: LAP payloads are exactly 20 bytes; anything else
    // invalidates the whole message (bad-byte recovery).
    if (payload.length !== 20) throw new Error("LAP wrong size");
    // Cache session time offset; content stays raw for later lap decoding.
    const duration = dv.getUint32(4, true);
    const endTime = dv.getUint32(16, true);
    if (state.lapTimeOffset === null) state.lapTimeOffset = endTime - duration;
    state.lapLastTime = endTime;
    return payload.slice();
  }
  if (STRING_TOKENS.has(tok)) return nulltermString(payload);
  if (tok === TOK_IDN) {
    if (payload.length >= 10) {
      return { model_id: dv.getUint16(0, true), logger_id: dv.getUint32(6, true) };
    }
    return payload.slice();
  }
  if (tok === TOK_SRC) {
    if (
      payload.length >= 62 &&
      payload[0] === 0x69 && payload[1] === 0x64 && payload[2] === 0x6e // "idn"
    ) {
      const idn = {
        model_id: dv.getUint16(6, true),
        logger_id: dv.getUint32(12, true),
      };
      // Recorded as an extra idn message (pyx parity); SRC content stays raw.
      appendMsg(state.messages, TOK_IDN, { token: TOK_IDN, ver: 1, content: idn });
    }
    return payload.slice();
  }
  if (tok === TOK_GPSR) {
    if (payload.length >= 36) {
      return {
        type: nulltermString(payload.subarray(4, 8)),
        channel_index: dv.getUint16(22, true),
      };
    }
    return payload.slice();
  }
  if (tok === TOK_RACM || tok === TOK_VET) {
    if (payload.length > 1) return nulltermString(payload);
    return payload.length === 1 ? payload[0] : null;
  }
  if (tok === TOK_ISLV) {
    if (
      payload.length >= 16 &&
      payload[0] === 0x69 && payload[1] === 0x64 && payload[2] === 0x6e
    ) {
      return {
        model_id: dv.getUint16(6, true),
        logger_id: dv.getUint32(12, true),
      };
    }
    return payload.slice();
  }
  if (tok === TOK_CAL) {
    if (payload.length >= 40) {
      const calType = dv.getUint32(20, true);
      const cal: Record<string, number> = {
        type: calType,
        raw_1: dv.getFloat32(24, true),
        raw_2: dv.getFloat32(28, true),
      };
      if (calType === 1) {
        cal.output_1 = dv.getFloat32(32, true);
        cal.output_2 = dv.getFloat32(36, true);
      }
      return cal;
    }
    return payload.slice();
  }
  if (tok === TOK_TRK) {
    if (payload.length >= 44) {
      return {
        name: nulltermString(payload.subarray(0, 32)),
        sf_lat: dv.getInt32(36, true) / 1e7,
        sf_long: dv.getInt32(40, true) / 1e7,
      };
    }
    return payload.slice();
  }
  if (tok === TOK_ODO) {
    if (payload.length % 64 !== 0) throw new Error("ODO wrong size");
    const records: Record<string, { time: number; dist: number }> = {};
    for (let i = 0; i + 64 <= payload.length; i += 64) {
      const name = nulltermString(payload.subarray(i, i + 16));
      if (name.startsWith("Fuel")) continue; // unit mapping unknown (pyx parity)
      records[name] = {
        time: dv.getUint32(i + 16, true),
        dist: dv.getUint32(i + 20, true),
      };
    }
    return records;
  }
  return payload.slice();
}

function appendMsg(messages: MessageMap, tok: number, msg: Msg): void {
  const list = messages.get(tok);
  if (list) list.push(msg);
  else messages.set(tok, [msg]);
}

/**
 * Parse a raw XRK byte stream: framing, accumulation and header dispatch.
 * Bad bytes are skipped one at a time, exactly like the reference parser.
 */
export function parseRaw(data: Uint8Array): RawParse {
  const state: RawParse = {
    messages: new Map(),
    channels: [],
    groups: [],
    gc: [[], [], [], []],
    gpsBytes: new ByteVec(),
    gnfiBytes: new ByteVec(),
    lapTimeOffset: null,
    lapLastTime: null,
  };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = data.length;

  // V2/V3 (c-message variants: see spec/xrk_format.py _resolve_c_variants)
  const v2v3ByCf = new Map<number, V2V3Entry[]>();
  const lastV2BaseTc = new Map<number, [number, number]>();
  const lastV2Plus4Tc = new Map<number, [number, number]>();
  let cVarPos = 0;

  let pos = 0;
  while (pos < len) {
    const oldpos = pos;
    try {
      if (pos + 10 >= len) throw new RangeError("eof");
      const typ = dv.getUint16(pos, true);
      if (typ === OP_G || typ === OP_S) {
        const cat = typ === OP_S ? 1 : 0;
        const index = dv.getUint16(pos + 6, true);
        const accums = state.gc[cat];
        if (index >= accums.length) throw new RangeError("unregistered index");
        const acc = accums[index];
        pos += acc.addHelper;
        if (pos - 1 >= len || data[pos - 1] !== CP) {
          throw new Error("missing close paren");
        }
        const tc = dv.getInt32(oldpos + 2, true);
        if (tc > acc.lastTimecode) {
          acc.lastTimecode = tc;
          acc.data.appendRange(data, oldpos + 2, pos - 1);
        }
      } else if (typ === OP_M) {
        const index = dv.getUint16(pos + 6, true);
        const accums = state.gc[3];
        if (index >= accums.length) throw new RangeError("unregistered index");
        const acc = accums[index];
        if (acc.Mms === 0) throw new Error("No ms understood for channel");
        const count = dv.getUint16(pos + 8, true);
        pos += acc.addHelper * count + 10;
        if (pos >= len || data[pos] !== CP) throw new Error("missing close paren");
        const tc = dv.getInt32(oldpos + 2, true);
        let mSkip = 0;
        if (tc <= acc.lastTimecode && acc.Mms > 0) {
          mSkip = Math.floor((acc.lastTimecode - tc) / acc.Mms) + 1;
        }
        if (mSkip < count) {
          acc.lastTimecode = tc + (count - 1) * acc.Mms;
          for (let i = mSkip; i < count; i++) acc.timecodes.push(tc + i * acc.Mms);
          acc.data.appendRange(data, oldpos + 10 + mSkip * acc.addHelper, pos);
        }
        pos += 1;
      } else if (typ === OP_c) {
        const unk1 = data[pos + 2];
        const cf = dv.getUint16(pos + 3, true);
        const unk3 = data[pos + 5];
        const unk4 = data[pos + 6];
        if (unk3 !== 0x84) throw new Error("unexpected c.unk3");
        if (unk1 === 0 && unk4 === 6) {
          // V1 — channel_index = channel_field >> 3
          if ((cf & 7) !== 4) throw new Error("unexpected c.channel low bits");
          const index = cf >> 3;
          const accums = state.gc[2];
          if (index >= accums.length) throw new RangeError("unregistered index");
          const acc = accums[index];
          pos += acc.addHelper;
          if (pos - 1 >= len || data[pos - 1] !== CP) {
            throw new Error("missing close paren");
          }
          const tc = dv.getInt32(oldpos + 7, true);
          if (tc > acc.lastTimecode) {
            acc.lastTimecode = tc;
            acc.data.appendRange(data, oldpos + 7, pos - 1);
          }
        } else if (unk1 === 0 && unk4 === 8) {
          // V2 long — two fp16 samples
          if (pos + 16 > len) throw new RangeError("eof");
          if (data[pos + 15] !== CP) throw new Error("V2 close");
          const tc = dv.getInt32(pos + 7, true);
          const low = cf & 0xf;
          let lst = v2v3ByCf.get(cf);
          if (!lst) v2v3ByCf.set(cf, (lst = []));
          if (low === 0 || low === 8) {
            lst.push([tc, data[pos + 11], data[pos + 12], 3, cVarPos]);
            lst.push([tc - 4, data[pos + 13], data[pos + 14], 3, cVarPos]);
            lastV2BaseTc.set(cf, [tc, cVarPos]);
          } else {
            lst.push([tc - 2, data[pos + 11], data[pos + 12], 1, cVarPos]);
            lst.push([tc - 4, data[pos + 13], data[pos + 14], 1, cVarPos]);
            lastV2Plus4Tc.set(cf, [tc, cVarPos]);
          }
          cVarPos += 1;
          pos += 16;
        } else if (unk1 === 1 && unk4 === 2) {
          // V3 short — one fp16 sample, timecode synthesized
          if (pos + 10 > len) throw new RangeError("eof");
          if (data[pos + 9] !== CP) throw new Error("V3 close");
          const baseCf = cf ^ 0x4;
          const baseEntry = lastV2BaseTc.get(baseCf);
          const plus4Entry = lastV2Plus4Tc.get(cf);
          let synthTc = -1;
          if (baseEntry && (!plus4Entry || baseEntry[1] >= plus4Entry[1])) {
            synthTc = baseEntry[0] - 2; // Mms=2 for shock pots
          } else if (plus4Entry) {
            synthTc = plus4Entry[0] + 2;
          }
          if (synthTc >= 0) {
            let lst = v2v3ByCf.get(cf);
            if (!lst) v2v3ByCf.set(cf, (lst = []));
            lst.push([synthTc, data[pos + 7], data[pos + 8], 2, cVarPos]);
          }
          cVarPos += 1;
          pos += 10;
        } else {
          throw new Error("unknown c variant");
        }
      } else if (typ === OP_h) {
        const wireTok = dv.getUint32(pos + 2, true);
        const hlen = dv.getInt32(pos + 6, true);
        const ver = data[pos + 10];
        if (hlen < 0 || hlen >= len) throw new RangeError("bad hlen");
        if (data[pos + 11] !== GT) throw new Error("expected >");
        const payloadStart = pos + 12;
        const footerStart = payloadStart + hlen;
        if (footerStart + 8 > len) throw new RangeError("eof");
        if (data[footerStart] !== LT) throw new Error("expected <");
        let bytesum = 0;
        for (let i = payloadStart; i < footerStart; i++) bytesum += data[i];
        bytesum &= 0xffff;
        if (dv.getUint32(footerStart + 1, true) !== wireTok) {
          throw new Error("token mismatch");
        }
        if (dv.getUint16(footerStart + 5, true) !== bytesum) {
          throw new Error("checksum mismatch");
        }
        if (data[footerStart + 7] !== GT) throw new Error("expected >");
        pos = footerStart + 8;

        let tok = wireTok;
        if (tok >>> 24 === 0x20) tok = (tok - 0x20000000) >>> 0; // strip trailing space

        if (tok === TOK_GPS || tok === TOK_GPS1) {
          state.gpsBytes.appendRange(data, payloadStart, footerStart);
        } else if (tok === TOK_GNFI) {
          state.gnfiBytes.appendRange(data, payloadStart, footerStart);
        } else {
          const payload = data.subarray(payloadStart, footerStart);
          const content = parseHeaderContent(tok, payload, state);
          appendMsg(state.messages, tok, { token: tok, ver, content });
        }
      } else {
        throw new Error("unknown byte sequence");
      }
    } catch {
      pos = oldpos + 1; // bad-byte recovery
    }
  }

  resolveV2V3(state, v2v3ByCf);
  return state;
}

/**
 * Resolve V2/V3 expansion c-messages into per-channel sample rows in gc[2].
 * Port of the post-parse block in aim_xrk.pyx (and spec _resolve_c_variants).
 */
function resolveV2V3(state: RawParse, v2v3ByCf: Map<number, V2V3Entry[]>): void {
  if (v2v3ByCf.size === 0) return;
  const cfs = [...v2v3ByCf.keys()].sort((a, b) => a - b);
  const cfSet = new Set(cfs);
  const pairs: Array<[number, number]> = [];
  const orphans: number[] = [];
  const processed = new Set<number>();
  for (const cf of cfs) {
    if (processed.has(cf)) continue;
    const low = cf & 0xf;
    if ((low === 0x0 || low === 0x8) && cfSet.has(cf | 0x4)) {
      pairs.push([cf, cf | 0x4]);
      processed.add(cf);
      processed.add(cf | 0x4);
    } else if ((low === 0x4 || low === 0xc) && cfSet.has(cf & ~0x4)) {
      continue;
    } else {
      orphans.push(cf);
      processed.add(cf);
    }
  }

  const pairedCandidates: Array<[number, number, number]> = []; // [hwRef, srcId, chIdx]
  const orphanCandidates: Array<[number, number, number]> = [];
  state.channels.forEach((ch, chIdx) => {
    if (!ch || ch.unknown.length < 68) return;
    if (ch.unknown[20] !== 20 || ch.sourceType !== 1) return;
    const dvu = new DataView(ch.unknown.buffer, ch.unknown.byteOffset, ch.unknown.byteLength);
    const hwId = dvu.getUint16(4, true);
    if (hwId === 0) return;
    const hwRef = dvu.getUint32(8, true);
    const mms = Math.floor(dvu.getUint32(64, true) / 1000);
    if (mms <= 5) pairedCandidates.push([hwRef, ch.sourceChannelId, chIdx]);
    else if (mms <= 15) orphanCandidates.push([hwRef, ch.sourceChannelId, chIdx]);
  });
  const byKey = (a: [number, number, number], b: [number, number, number]) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  pairedCandidates.sort(byKey);
  orphanCandidates.sort(byKey);

  const expansionMap = new Map<number, number>();
  for (let i = 0; i < Math.min(pairs.length, pairedCandidates.length); i++) {
    expansionMap.set(pairs[i][0], pairedCandidates[i][2]);
    expansionMap.set(pairs[i][1], pairedCandidates[i][2]);
  }
  for (let i = 0; i < Math.min(orphans.length, orphanCandidates.length); i++) {
    expansionMap.set(orphans[i], orphanCandidates[i][2]);
  }

  // Per-channel: tc → [b0, b1, priority]; higher priority wins on collision.
  const perChannel = new Map<number, Map<number, [number, number, number]>>();
  for (const [cf, entries] of v2v3ByCf) {
    const chIdx = expansionMap.get(cf);
    if (chIdx === undefined) continue;
    let bucket = perChannel.get(chIdx);
    if (!bucket) perChannel.set(chIdx, (bucket = new Map()));
    for (const [tc, b0, b1, prio] of entries) {
      const existing = bucket.get(tc);
      if (!existing || prio > existing[2]) bucket.set(tc, [b0, b1, prio]);
    }
  }

  // Migrate into gc[2] rows: 4-byte LE timecode + 2 data bytes per row.
  for (const [chIdx, samples] of perChannel) {
    resize(state.gc[2], chIdx);
    const acc = state.gc[2][chIdx];
    if (acc.addHelper === 1) {
      const ch = state.channels[chIdx];
      acc.addHelper = (ch ? ch.size : 2) + 12;
    }
    const tcs = [...samples.keys()].sort((a, b) => a - b);
    for (const tc of tcs) {
      if (tc <= acc.lastTimecode) continue;
      acc.lastTimecode = tc;
      acc.data.pushByte(tc & 0xff);
      acc.data.pushByte((tc >> 8) & 0xff);
      acc.data.pushByte((tc >> 16) & 0xff);
      acc.data.pushByte((tc >> 24) & 0xff);
      const [b0, b1] = samples.get(tc)!;
      acc.data.pushByte(b0);
      acc.data.pushByte(b1);
    }
  }
}

/**
 * Compute the session time offset and last time from accumulated raw buffers
 * (pyx: the min/max candidate scan after the main loop).
 */
export function computeTimeBounds(state: RawParse): [number, number] {
  const mins: number[] = [];
  const maxs: number[] = [];
  if (state.lapTimeOffset !== null) mins.push(state.lapTimeOffset);
  if (state.lapLastTime !== null) maxs.push(state.lapLastTime);
  for (let cat = 0; cat < 3; cat++) {
    for (const acc of state.gc[cat]) {
      const size = acc.data.len;
      if (!size) continue;
      const view = acc.data.view();
      const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
      mins.push(dv.getInt32(0, true));
      const stride = acc.addHelper - (cat < 2 ? 3 : 8);
      const nRows = Math.floor(size / stride);
      maxs.push(dv.getInt32((nRows - 1) * stride, true));
    }
  }
  for (const acc of state.gc[3]) {
    if (acc.timecodes.len) {
      mins.push(acc.timecodes.buf[0]);
      maxs.push(acc.timecodes.buf[acc.timecodes.len - 1]);
    }
  }
  if (state.gpsBytes.len >= 56) {
    const view = state.gpsBytes.view();
    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    mins.push(dv.getInt32(0, true));
    maxs.push(dv.getInt32(state.gpsBytes.len - 56, true));
  }
  const timeOffset = mins.length ? Math.min(...mins) : 0;
  const lastTime = maxs.length ? Math.max(...maxs) : 0;
  return [timeOffset, lastTime];
}
