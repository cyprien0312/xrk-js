// Lap extraction — port of aim_xrk.pyx `_get_laps`.

import { tokdec } from "./constants.js";
import { findLaps, lla2ecef } from "./gps.js";
import type { ChannelDef, MessageMap, XrkLap } from "./types.js";

const TOK_LAP = tokdec("LAP");
const TOK_TRK = tokdec("TRK");

export function getLaps(
  latCh: ChannelDef | null,
  lonCh: ChannelDef | null,
  messages: MessageMap,
  timeOffset: number,
  lastTime: number,
): { laps: XrkLap[]; hasLapMessages: boolean } {
  const lapNums: number[] = [];
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  let hasLapMessages = false;

  const lapMsgs = messages.get(TOK_LAP);
  if (lapMsgs) {
    // Prefer LAP messages (matches official DLL behavior)
    hasLapMessages = true;
    for (const m of lapMsgs) {
      const raw = m.content as Uint8Array;
      if (!(raw instanceof Uint8Array) || raw.length < 20) continue;
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const segment = raw[1];
      const lap = dv.getUint16(2, true);
      const duration = dv.getUint32(4, true);
      const endTime = dv.getUint32(16, true) - timeOffset;
      if (segment) continue;
      if (lapNums.length === 0) {
        // first lap
      } else if (lapNums[lapNums.length - 1] === lap) {
        continue; // duplicate
      } else if (lapNums[lapNums.length - 1] + 1 === lap) {
        // consecutive
      } else if (lapNums[lapNums.length - 1] + 2 === lap) {
        // one lap missing — infer it
        lapNums.push(lap - 1);
        startTimes.push(endTimes[endTimes.length - 1]);
        endTimes.push(endTime - duration);
      } else {
        throw new Error(`Lap gap from ${lapNums[lapNums.length - 1]} to ${lap}`);
      }
      lapNums.push(lap);
      startTimes.push(endTime - duration);
      endTimes.push(endTime);
    }
  } else if (latCh && lonCh) {
    // GPS-based fallback using the TRK start/finish coordinates
    const trkMsgs = messages.get(TOK_TRK);
    const trk = trkMsgs?.[trkMsgs.length - 1]?.content as
      | { sf_lat: number; sf_long: number }
      | undefined;
    if (trk && typeof trk.sf_lat === "number") {
      const lat = latCh.values;
      const lon = lonCh.values;
      const n = Math.min(lat.length, lon.length);
      const xyz = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        const [x, y, z] = lla2ecef(lat[i] as number, lon[i] as number, 0);
        xyz[i * 3] = x;
        xyz[i * 3 + 1] = y;
        xyz[i * 3 + 2] = z;
      }
      const markers = findLaps(xyz, latCh.timecodes, trk.sf_lat, trk.sf_long);
      const sessionEnd = latCh.timecodes.length
        ? latCh.timecodes[latCh.timecodes.length - 1]
        : lastTime
          ? lastTime - timeOffset
          : 0;
      if (markers.length) {
        const bounds = [...markers, sessionEnd];
        for (let lap = 0; lap + 1 < bounds.length; lap++) {
          lapNums.push(lap);
          startTimes.push(bounds[lap]);
          endTimes.push(bounds[lap + 1]);
        }
      }
    }
  }

  // Normalize lap numbers to 0-based indexing
  if (lapNums.length) {
    const minLap = Math.min(...lapNums);
    for (let i = 0; i < lapNums.length; i++) lapNums[i] -= minLap;
  }

  const laps: XrkLap[] = lapNums.map((num, i) => ({
    num,
    startTime: Math.trunc(startTimes[i]),
    endTime: Math.trunc(endTimes[i]),
  }));
  return { laps, hasLapMessages };
}
