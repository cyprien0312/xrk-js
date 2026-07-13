#!/usr/bin/env python3
"""Generate golden reference JSON from Python libxrk for cross-implementation tests.

Usage: make_golden.py <file.xrk|file.xrz> <out.json>

Requires a venv with `libxrk` installed (see README "Development").
"""

import json
import math
import sys

import numpy as np
from libxrk import aim_xrk
from libxrk.base import ChannelMetadata


def jsafe(v):
    """Convert numpy / non-finite values to JSON-safe representations."""
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return f
    if isinstance(v, dict):
        return {k: jsafe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsafe(x) for x in v]
    return v


def summarize(values: np.ndarray) -> dict:
    vals = np.asarray(values, dtype=np.float64)
    nan_count = int(np.isnan(vals).sum())
    finite = vals[~np.isnan(vals)]
    return {
        "n": int(len(vals)),
        "nan_count": nan_count,
        "first": [jsafe(x) for x in vals[:5]],
        "last": [jsafe(x) for x in vals[-5:]],
        "sum": jsafe(np.sum(finite, dtype=np.float64)) if len(finite) else 0.0,
        "min": jsafe(np.min(finite)) if len(finite) else None,
        "max": jsafe(np.max(finite)) if len(finite) else None,
    }


def main():
    src, out = sys.argv[1], sys.argv[2]
    log = aim_xrk(src)

    channels = {}
    for name, table in log.channels.items():
        meta = ChannelMetadata.from_field(table.schema.field(name))
        tc = table.column("timecodes").to_numpy()
        vals = table.column(name).to_numpy()
        channels[name] = {
            "units": meta.units,
            "dec_pts": meta.dec_pts,
            "interpolate": meta.interpolate,
            "function": meta.function,
            "source_type": meta.source_type,
            "device_tag": meta.device_tag,
            "values": summarize(vals),
            "timecodes": summarize(tc),
        }

    laps = []
    if log.laps is not None:
        nums = log.laps.column("num").to_pylist()
        starts = log.laps.column("start_time").to_pylist()
        ends = log.laps.column("end_time").to_pylist()
        laps = [[int(n), int(s), int(e)] for n, s, e in zip(nums, starts, ends)]

    golden = {
        "metadata": jsafe(log.metadata),
        "laps": laps,
        "channels": channels,
    }
    with open(out, "w") as f:
        json.dump(golden, f, indent=1, sort_keys=True)
    print(f"{out}: {len(channels)} channels, {len(laps)} laps")


if __name__ == "__main__":
    main()
