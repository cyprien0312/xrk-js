// Format constants ported from libxrk (https://github.com/m3rlin45/libxrk, MIT).
// The authoritative wire-format reference is libxrk's spec/xrk_format.py.

/** Encode a 3/4-char ASCII token string to its uint32 LE representation. */
export function tokdec(s: string): number {
  let v = 0;
  for (let i = s.length - 1; i >= 0; i--) v = v * 256 + s.charCodeAt(i);
  return v >>> 0;
}

/** Decode a uint32 token back to its ASCII string. */
export function tokenc(i: number): string {
  let s = "";
  while (i) {
    s += String.fromCharCode(i & 255);
    i = Math.floor(i / 256);
  }
  return s;
}

/** unit_type_byte (lower 7 bits) → [unit string, decimal points] */
export const UNIT_MAP = new Map<number, [string, number]>([
  [1, ["%", 2]],
  [3, ["g", 2]],
  [4, ["deg", 1]],
  [5, ["deg/s", 1]],
  [6, ["", 0]],
  [9, ["Hz", 0]],
  [11, ["", 0]],
  [12, ["mm", 0]],
  [14, ["bar", 2]],
  [15, ["rpm", 0]],
  [16, ["km/h", 0]],
  [17, ["C", 1]],
  [18, ["ms", 0]],
  [19, ["Nm", 0]],
  [20, ["km/h", 0]],
  [21, ["mV", 1]],
  [22, ["l", 1]],
  [24, ["l/s", 0]],
  [26, ["time?", 0]],
  [27, ["A", 0]],
  [30, ["lambda", 2]],
  [31, ["gear", 0]],
  [33, ["%", 2]],
  [43, ["kg", 3]],
]);

/** Sample decoder descriptor: how raw bytes become numbers. */
export interface DecoderSpec {
  /** struct-style type char: i, H, h, f, B, Q */
  stype: string;
  interpolate: boolean;
  /** Post-decode fixup applied to the raw numeric array. */
  fixup?: "gear" | "fp16" | "calcGear";
}

/** decoder_type byte (CHS offset [20]) → decoder */
export const DECODERS = new Map<number, DecoderSpec>([
  [0, { stype: "i", interpolate: false }], // Master Clock on M4GT4
  [1, { stype: "H", interpolate: true }], // plain uint16 (e.g. StartRec)
  [3, { stype: "i", interpolate: false }], // Master Clock on ScottE46
  [4, { stype: "h", interpolate: false }],
  [6, { stype: "f", interpolate: true }], // standard float32
  [8, { stype: "i", interpolate: false }], // iGPS reference
  [11, { stype: "h", interpolate: false }],
  [12, { stype: "i", interpolate: false }], // Predictive Time
  [13, { stype: "B", interpolate: false }], // status field
  [15, { stype: "H", interpolate: false, fixup: "gear" }], // gear lookup
  [20, { stype: "H", interpolate: true, fixup: "fp16" }], // float16 as uint16
  [22, { stype: "i", interpolate: false }], // Lap Time (variant)
  [24, { stype: "i", interpolate: false }], // Best Run Diff
  [26, { stype: "i", interpolate: false }], // Total Odometer
  [27, { stype: "i", interpolate: false }], // Reset Odometer
  [31, { stype: "i", interpolate: false }], // Lap Time
  [32, { stype: "i", interpolate: false }], // Roll Time
  [33, { stype: "i", interpolate: false }], // Best Time
  [37, { stype: "i", interpolate: false }], // GPS_Hours
  [38, { stype: "i", interpolate: false }], // GPS_Date
  [39, { stype: "i", interpolate: false }], // GPS_Time
]);

/** Channels decoded manually by long name (aim_xrk.pyx _manual_decoders). */
export const MANUAL_DECODERS = new Map<string, DecoderSpec>([
  ["Calculated_Gear", { stype: "Q", interpolate: false, fixup: "calcGear" }],
  ["PreCalcGear", { stype: "Q", interpolate: false, fixup: "calcGear" }],
]);

/** Bytes per sample for each struct type char. */
export const STYPE_SIZE: Record<string, number> = {
  i: 4,
  H: 2,
  h: 2,
  f: 4,
  B: 1,
  Q: 8,
};

export const LOGGER_MODELS = new Map<number, string>([
  [649, "MXP 1.3"],
  [793, "MXm"],
]);

/** (maybe_display_format, unit_type_byte) → channel function string */
export const FUNCTION_MAP = new Map<number, string>([
  // key = display_format * 256 + unit_type_byte
  [0 * 256 + 0x01, "Percent"],
  [0 * 256 + 0x03, "Acceleration"],
  [0 * 256 + 0x04, "Angle"],
  [0 * 256 + 0x05, "Angular Rate"],
  [0 * 256 + 0x0b, "Number"],
  [0 * 256 + 0x0c, "Distance"],
  [0 * 256 + 0x0e, "Pressure"],
  [0 * 256 + 0x0f, "Engine RPM"],
  [0 * 256 + 0x10, "Rear Wheel Speed"],
  [0 * 256 + 0x11, "Temperature"],
  [0 * 256 + 0x12, "Time"],
  [0 * 256 + 0x15, "Voltage"],
  [0 * 256 + 0x91, "Exhaust Temperature"],
  [0 * 256 + 0x9a, "Lap Time"],
  [1 * 256 + 0x95, "Battery Voltage"],
  [2 * 256 + 0x9a, "Total Odometer"],
  [3 * 256 + 0x1a, "Reset Odometer"],
  [5 * 256 + 0x1a, "Best Lap Time"],
  [5 * 256 + 0x9a, "Rolling Lap Time"],
  [6 * 256 + 0x06, "Gear"],
  [6 * 256 + 0x1f, "Gear"],
  [9 * 256 + 0x1e, "Lambda"],
  [11 * 256 + 0x91, "Oil Temperature"],
  [13 * 256 + 0x84, "Steering Angle"],
  [14 * 256 + 0x81, "Percentage Throttle Load"],
  [16 * 256 + 0x91, "Water Temperature"],
  [17 * 256 + 0x03, "Inline Acceleration"],
  [17 * 256 + 0x05, "Roll Rate"],
  [17 * 256 + 0x83, "Lateral Acceleration"],
  [17 * 256 + 0x85, "Pitch Rate"],
  [18 * 256 + 0x03, "Vertical Acceleration"],
  [18 * 256 + 0x05, "Yaw Rate"],
  [21 * 256 + 0x12, "Master Clock"],
  [26 * 256 + 0x21, "Device Brightness"],
  [27 * 256 + 0x92, "Best Run Diff"],
  [28 * 256 + 0x12, "Prev Lap Diff"],
  [28 * 256 + 0x92, "Ref Lap Diff"],
  [35 * 256 + 0x92, "Best Today Diff"],
  [128 * 256 + 0x10, "Vehicle Speed"],
  [128 * 256 + 0x91, "Intake Air Temperature"],
  [128 * 256 + 0x9a, "Lap Time"],
  [129 * 256 + 0x9a, "GPS Time"],
  [130 * 256 + 0x0e, "Brake Circuit Pressure"],
  [144 * 256 + 0x91, "Water Temperature"],
  [145 * 256 + 0x03, "Inline Acceleration"],
  [145 * 256 + 0x83, "Lateral Acceleration"],
  [146 * 256 + 0x05, "Yaw Rate"],
  [169 * 256 + 0x8c, "LF Shock Position"],
]);

/** Resolve channel function from CHS fields (with config_flags tiebreaker). */
export function resolveFunction(
  displayFormat: number,
  unitTypeByte: number,
  configFlags: number,
): string {
  // Override: (0, 0x11, 1) → Device Temperature (internal logger sensor)
  if (displayFormat === 0 && unitTypeByte === 0x11 && configFlags === 1) {
    return "Device Temperature";
  }
  return FUNCTION_MAP.get(displayFormat * 256 + unitTypeByte) ?? "";
}

/** GPS channel names sharing the GPS timebase (order matters for output). */
export const GPS_CHANNEL_NAMES = [
  "GPS Speed",
  "GPS Latitude",
  "GPS Longitude",
  "GPS Altitude",
  "GPS_Satellites",
  "GPS_Fix",
  "GPS_pDOP",
  "GPS_Position_Accuracy",
  "GPS_Velocity_Accuracy",
  "GPS_InlineAcc",
  "GPS_LateralAcc",
  "GPS_Yaw_Rate",
] as const;

/** Decode a null-terminated ASCII string from bytes. */
export function nulltermString(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  let s = "";
  for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Convert an IEEE 754 half-precision bit pattern to a float (as float32). */
export function fp16ToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) {
    return Math.fround(sign * frac * 2 ** -24); // subnormal (or ±0)
  }
  if (exp === 0x1f) {
    return frac ? NaN : sign * Infinity;
  }
  return Math.fround(sign * (1 + frac / 1024) * 2 ** (exp - 15));
}
