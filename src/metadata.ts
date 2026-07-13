// Session metadata extraction — port of aim_xrk.pyx `_get_metadata`.

import { LOGGER_MODELS, tokdec } from "./constants.js";
import type { ChannelDef, MessageMap, Msg } from "./types.js";

function last(messages: MessageMap, tok: number): Msg | undefined {
  const list = messages.get(tok);
  return list?.[list.length - 1];
}

export function getMetadata(
  messages: MessageMap,
  channels: Map<string, ChannelDef> | null,
): Record<string, unknown> {
  const ret: Record<string, unknown> = {};
  const simple: Array<[string, string]> = [
    ["RCR", "Driver"],
    ["VEH", "Vehicle"],
    ["TMD", "Log Date"],
    ["TMT", "Log Time"],
    ["VTY", "Session"],
    ["CMP", "Series"],
    ["NTE", "Long Comment"],
  ];
  for (const [tokStr, name] of simple) {
    const m = last(messages, tokdec(tokStr));
    if (m !== undefined) ret[name] = m.content;
  }

  const trk = last(messages, tokdec("TRK"));
  if (trk && typeof trk.content === "object" && trk.content !== null && "name" in trk.content) {
    ret["Venue"] = (trk.content as { name: string }).name;
  }

  const odo = last(messages, tokdec("ODO"));
  if (odo && typeof odo.content === "object" && odo.content !== null) {
    for (const [name, stats] of Object.entries(
      odo.content as Record<string, { time: number; dist: number }>,
    )) {
      ret[`Odo/${name} Distance (km)`] = stats.dist / 1000;
      const t = stats.time;
      const h = Math.floor(t / 3600);
      const mnt = Math.floor(t / 60) % 60;
      const s = t % 60;
      ret[`Odo/${name} Time`] =
        `${h}:${String(mnt).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }

  const idn = last(messages, tokdec("idn"));
  if (idn && typeof idn.content === "object" && idn.content !== null && "logger_id" in idn.content) {
    const c = idn.content as { logger_id: number; model_id: number };
    ret["Logger ID"] = c.logger_id;
    ret["Logger Model ID"] = c.model_id;
    ret["Logger Model"] = LOGGER_MODELS.get(c.model_id) ?? null;
  }

  const ndv = last(messages, tokdec("NDV"));
  if (ndv !== undefined) ret["Device Name"] = ndv.content;

  const gpsr = last(messages, tokdec("GPSR"));
  if (gpsr && typeof gpsr.content === "object" && gpsr.content !== null && "type" in gpsr.content) {
    ret["GPS Receiver"] = (gpsr.content as { type: string }).type;
  }

  // Expansion devices from ENF containers (+ hardware IDs from iSLV)
  const enfMsgs = messages.get(tokdec("ENF"));
  if (enfMsgs) {
    const devices: Array<Record<string, unknown>> = [];
    for (const enf of enfMsgs) {
      if (!(enf.content instanceof Map)) continue;
      const sub = enf.content as MessageMap;
      const device: Record<string, unknown> = {};
      const props: Array<[string, string]> = [
        ["DBUN", "Bus Unit"],
        ["DBUT", "Bus Type"],
        ["DVER", "Version"],
        ["MANL", "Manufacturer"],
        ["MODL", "Model"],
      ];
      for (const [tokStr, key] of props) {
        const list = sub.get(tokdec(tokStr));
        if (list && list.length) device[key] = list[list.length - 1].content;
      }
      if (Object.keys(device).length) devices.push(device);
    }
    const islvMsgs = (messages.get(tokdec("iSLV")) ?? []).filter(
      (m) => typeof m.content === "object" && m.content !== null && "logger_id" in (m.content as object),
    );
    devices.forEach((device, i) => {
      if (i < islvMsgs.length) {
        const c = islvMsgs[i].content as { logger_id: number; model_id: number };
        device["Logger ID"] = c.logger_id;
        device["Model ID"] = c.model_id;
      }
    });
    if (devices.length) ret["Expansion Devices"] = devices;
  }

  for (const racm of messages.get(tokdec("RACM")) ?? []) {
    if (typeof racm.content === "string") ret["Race Mode"] = racm.content;
  }

  const vet = last(messages, tokdec("VET"));
  if (vet !== undefined) ret["Vehicle Electronics Type"] = vet.content;

  // Calibrations, cross-referenced with CHS cal values
  const calMsgs = messages.get(tokdec("CAL"));
  if (calMsgs) {
    const calToChannel = new Map<string, string>();
    if (channels) {
      for (const ch of channels.values()) {
        if (ch.unknown.length >= 104) {
          const dv = new DataView(ch.unknown.buffer, ch.unknown.byteOffset, ch.unknown.byteLength);
          const f96 = dv.getFloat32(96, true);
          const f100 = dv.getFloat32(100, true);
          calToChannel.set(`${f96},${f100}`, ch.longName);
        }
      }
    }
    const calibrations: Array<Record<string, unknown>> = [];
    for (const calMsg of calMsgs) {
      if (typeof calMsg.content === "object" && calMsg.content !== null && "raw_1" in calMsg.content) {
        const cal: Record<string, unknown> = { ...(calMsg.content as object) };
        const key = `${cal.raw_1},${cal.raw_2}`;
        const chName = calToChannel.get(key);
        if (chName !== undefined) cal.channel = chName;
        calibrations.push(cal);
      }
    }
    if (calibrations.length) ret["Calibrations"] = calibrations;
  }
  return ret;
}
