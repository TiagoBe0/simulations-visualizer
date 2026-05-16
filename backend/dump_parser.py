"""LAMMPS dump-file parsing, discovery and caching.

A dump file looks like::

    ITEM: TIMESTEP
    0
    ITEM: NUMBER OF ATOMS
    473344
    ITEM: BOX BOUNDS pp pp pp
    -9.04e+01 9.04e+01
    -9.04e+01 9.04e+01
    -6.73e+01 6.73e+01
    ITEM: ATOMS id type x y z vx vy vz c_pe_atom c_ke_atom c_coord
    <one whitespace-separated row per atom>

Each file here holds a single timestep. A "run" is a directory containing
several such files (one per timestep).
"""

from __future__ import annotations

import os
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

# Directory that holds the run sub-directories. Drop new runs in here.
DATA_DIR = Path(os.environ.get("DATA_DIR", "NuevasCorridas")).resolve()

# Files we treat as dumps: anything starting with "dump"
_DUMP_RE = re.compile(r"^dump\b", re.IGNORECASE)
# Trailing ".<number>" of a filename is used as a cheap timestep label.
_STEP_RE = re.compile(r"\.(\d+)$")

# Candidate coordinate column triplets, in order of preference.
_COORD_SETS = (("x", "y", "z"), ("xu", "yu", "zu"), ("xs", "ys", "zs"))


@dataclass
class Frame:
    """A single parsed timestep, ready to be served as binary."""

    timestep: int
    n_atoms: int
    box: dict          # {"lo": [x,y,z], "hi": [x,y,z]}
    columns: list      # all column names from the ATOMS header
    coords: np.ndarray  # float32, shape (n_atoms, 3) - unwrapped to box units
    fields: dict = field(default_factory=dict)  # name -> float32 array (n_atoms,)

    def field_stats(self) -> dict:
        out = {}
        for name, arr in self.fields.items():
            out[name] = {"min": float(np.nanmin(arr)), "max": float(np.nanmax(arr))}
        return out


def _read_header(fh):
    """Read the textual header, returning (timestep, n_atoms, box, columns,
    number-of-header-lines-consumed)."""
    timestep = 0
    n_atoms = 0
    box_lo = [0.0, 0.0, 0.0]
    box_hi = [0.0, 0.0, 0.0]
    columns: list[str] = []
    header_lines = 0

    line = fh.readline()
    while line:
        header_lines += 1
        s = line.strip()
        if s.startswith("ITEM: TIMESTEP"):
            timestep = int(fh.readline().split()[0])
            header_lines += 1
        elif s.startswith("ITEM: NUMBER OF ATOMS"):
            n_atoms = int(fh.readline().split()[0])
            header_lines += 1
        elif s.startswith("ITEM: BOX BOUNDS"):
            for i in range(3):
                parts = fh.readline().split()
                header_lines += 1
                box_lo[i] = float(parts[0])
                box_hi[i] = float(parts[1])
        elif s.startswith("ITEM: ATOMS"):
            columns = s.split()[2:]
            break
        line = fh.readline()

    box = {"lo": box_lo, "hi": box_hi}
    return timestep, n_atoms, box, columns, header_lines


def peek_timestep(path: Path) -> int:
    """Cheap timestep read: filename suffix, falling back to the header."""
    m = _STEP_RE.search(path.name)
    if m:
        return int(m.group(1))
    try:
        with open(path, "r") as fh:
            line = fh.readline()
            while line:
                if line.strip().startswith("ITEM: TIMESTEP"):
                    return int(fh.readline().split()[0])
                line = fh.readline()
    except (OSError, ValueError):
        pass
    return 0


def parse_dump(path: Path) -> Frame:
    """Parse a full dump file into a :class:`Frame` (numeric columns only)."""
    with open(path, "r") as fh:
        timestep, n_atoms, box, columns, header_lines = _read_header(fh)

    df = pd.read_csv(
        path,
        sep=r"\s+",
        skiprows=header_lines,
        nrows=n_atoms,
        names=columns,
        header=None,
        engine="c",
    )

    # Pick coordinate columns.
    coord_cols = next((c for c in _COORD_SETS if all(k in df.columns for k in c)), None)
    if coord_cols is None:
        raise ValueError(f"No coordinate columns found in {path.name}: {columns}")

    coords = df[list(coord_cols)].to_numpy(dtype=np.float32, copy=True)
    # Scaled coords are in [0,1] -> map into the simulation box.
    if coord_cols == ("xs", "ys", "zs"):
        lo = np.asarray(box["lo"], dtype=np.float32)
        hi = np.asarray(box["hi"], dtype=np.float32)
        coords = lo + coords * (hi - lo)

    fields: dict[str, np.ndarray] = {}
    for col in df.columns:
        series = pd.to_numeric(df[col], errors="coerce")
        fields[col] = series.to_numpy(dtype=np.float32, copy=True)

    return Frame(
        timestep=timestep,
        n_atoms=int(len(df)),
        box=box,
        columns=list(df.columns),
        coords=coords,
        fields=fields,
    )


class _FrameCache:
    """Tiny thread-safe LRU keyed by (path, mtime). Each frame is ~20-40 MB
    so we keep only a handful resident."""

    def __init__(self, maxsize: int = 4):
        self._maxsize = maxsize
        self._lock = threading.Lock()
        self._store: "OrderedDict[tuple, Frame]" = OrderedDict()

    def get(self, path: Path) -> Frame:
        key = (str(path), path.stat().st_mtime_ns)
        with self._lock:
            frame = self._store.get(key)
            if frame is not None:
                self._store.move_to_end(key)
                return frame
        frame = parse_dump(path)  # parse outside the lock
        with self._lock:
            self._store[key] = frame
            self._store.move_to_end(key)
            while len(self._store) > self._maxsize:
                self._store.popitem(last=False)
        return frame


_cache = _FrameCache(maxsize=int(os.environ.get("FRAME_CACHE", "4")))


def get_frame(run: str, step: int) -> Frame:
    path = _resolve(run, step)
    return _cache.get(path)


def _safe_run_dir(run: str) -> Path:
    """Resolve a run name to a directory inside DATA_DIR (no traversal)."""
    d = (DATA_DIR / run).resolve()
    if DATA_DIR not in d.parents and d != DATA_DIR:
        raise ValueError("invalid run path")
    if not d.is_dir():
        raise FileNotFoundError(run)
    return d


def _resolve(run: str, step: int) -> Path:
    run_dir = _safe_run_dir(run)
    for f in run_dir.iterdir():
        if f.is_file() and _DUMP_RE.match(f.name) and peek_timestep(f) == step:
            return f
    raise FileNotFoundError(f"{run} @ step {step}")


def discover_runs() -> list[dict]:
    """List runs (sub-directories of DATA_DIR with dump files) and their
    available timesteps."""
    runs = []
    if not DATA_DIR.is_dir():
        return runs
    for run_dir in sorted(p for p in DATA_DIR.iterdir() if p.is_dir()):
        frames = []
        for f in run_dir.iterdir():
            if f.is_file() and _DUMP_RE.match(f.name):
                frames.append({"step": peek_timestep(f), "file": f.name})
        if frames:
            frames.sort(key=lambda x: x["step"])
            runs.append({"name": run_dir.name, "frames": frames})
    return runs
