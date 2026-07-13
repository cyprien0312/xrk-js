// xrk-js — pure TypeScript parser for AiM XRK/XRZ telemetry files.
//
// A dependency-free port of libxrk (https://github.com/m3rlin45/libxrk, MIT,
// Copyright 2024 Scott Smith), which reverse-engineered the AIM wire format.
//
// Usage:
//   import { parseXrk } from "xrk-js";
//   const log = parseXrk(bytes); // Uint8Array of an .xrk or .xrz file
//   log.channels["GPS Speed"].values; // Float64Array
//   log.laps; // [{num, startTime, endTime}, ...] in ms
//   log.metadata; // { Driver, Vehicle, Venue, ... }

import { processChannel, processGroup } from "./channels";
import { decompressIfZlib } from "./inflate";
import { decodeGnfi, decodeGps, fixGpsTimingGaps } from "./gps";
import { getLaps } from "./laps";
import { getMetadata } from "./metadata";
import { computeTimeBounds, parseRaw } from "./parser";
import type { ChannelDef, XrkChannel, XrkLap, XrkLog } from "./types";

export { decompressIfZlib, isZlib } from "./inflate";
export { ecef2lla, lla2ecef } from "./gps";
export { tokdec, tokenc, GPS_CHANNEL_NAMES } from "./constants";
export type { XrkChannel, XrkLap, XrkLog, SampleArray } from "./types";

/** Channels excluded from the output (pyx parity). */
const EXCLUDED_CHANNELS = new Set(["StrtRec", "Master Clk"]);

function toPublicChannel(ch: ChannelDef): XrkChannel {
  return {
    name: ch.longName,
    shortName: ch.shortName,
    units: ch.size === 1 ? "" : ch.units,
    decPts: ch.decPts,
    interpolate: ch.interpolate,
    func: ch.func,
    sourceType: ch.sourceType,
    sourceChannelId: ch.sourceChannelId,
    deviceTag: ch.deviceTag,
    calValue1: ch.calValue1,
    calValue2: ch.calValue2,
    displayRangeMin: ch.displayRangeMin,
    displayRangeMax: ch.displayRangeMax,
    timecodes: ch.timecodes,
    values: ch.values,
  };
}

/**
 * Parse an AiM XRK or XRZ file.
 *
 * @param input Raw file bytes (XRZ is auto-decompressed).
 * @returns Parsed log with channels, laps and session metadata.
 */
export function parseXrk(input: Uint8Array | ArrayBuffer): XrkLog {
  // Normalize to a plain Uint8Array view: Node Buffers override slice() with
  // view (non-copying) semantics, which would let payload copies alias — and
  // mutate — the file bytes.
  const bytes =
    input instanceof Uint8Array
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
  const data = decompressIfZlib(bytes);

  const state = parseRaw(data);

  const hasChannels = state.channels.some((c) => c !== null);
  let channelMap = new Map<string, ChannelDef>();
  let laps: XrkLap[] = [];
  let hasLapMessages = false;
  let gnfi: Float64Array | null = null;

  if (hasChannels) {
    const [timeOffset, lastTime] = computeTimeBounds(state);

    for (const g of state.groups) {
      if (g) processGroup(g, state, timeOffset);
    }
    for (const ch of state.channels) {
      if (ch && !ch.group) processChannel(ch, state, timeOffset);
    }

    const gpsChannels = decodeGps(state.gpsBytes.view(), timeOffset);
    gnfi = decodeGnfi(state.gnfiBytes.view(), timeOffset);

    let latCh: ChannelDef | null = null;
    let lonCh: ChannelDef | null = null;
    for (const ch of gpsChannels) {
      if (ch.longName === "GPS Latitude") latCh = ch;
      if (ch.longName === "GPS Longitude") lonCh = ch;
    }
    const lapResult = getLaps(latCh, lonCh, state.messages, timeOffset, lastTime);
    laps = lapResult.laps;
    hasLapMessages = lapResult.hasLapMessages;

    const all = [...state.channels, ...gpsChannels];
    for (const ch of all) {
      if (ch && ch.hasData && !EXCLUDED_CHANNELS.has(ch.longName)) {
        channelMap.set(ch.longName, ch);
      }
    }
  }

  const metadata = getMetadata(state.messages, channelMap);

  // Correct the ~65533ms GPS firmware timing bug. Lap boundaries are only
  // corrected when laps came from GPS detection (LAP messages use the
  // internal clock, which is unaffected).
  fixGpsTimingGaps(channelMap, laps, gnfi, !hasLapMessages);

  const channels: Record<string, XrkChannel> = {};
  for (const [name, ch] of channelMap) channels[name] = toPublicChannel(ch);
  return { channels, laps, metadata };
}
