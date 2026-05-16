"""FastAPI server: lists LAMMPS runs and streams frame data as compact
little-endian float32 binary so the browser can render hundreds of
thousands of atoms without parsing megabytes of text."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .dump_parser import DATA_DIR, discover_runs, get_frame

app = FastAPI(title="LAMMPS Dump Visualizer")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


@app.get("/api/runs")
def api_runs():
    """All runs found under DATA_DIR and their available timesteps."""
    return {"data_dir": str(DATA_DIR), "runs": discover_runs()}


def _load(run: str, step: int):
    try:
        return get_frame(run, step)
    except FileNotFoundError:
        raise HTTPException(404, f"frame not found: {run} @ {step}")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/frame/meta")
def api_meta(run: str = Query(...), step: int = Query(...)):
    """Atom count, box bounds, available scalar fields and their ranges."""
    f = _load(run, step)
    return {
        "run": run,
        "timestep": f.timestep,
        "n_atoms": f.n_atoms,
        "box": f.box,
        "columns": f.columns,
        "fields": f.field_stats(),
    }


@app.get("/api/frame/positions")
def api_positions(run: str = Query(...), step: int = Query(...)):
    """xyz coordinates as float32 binary, length n_atoms*3."""
    f = _load(run, step)
    buf = np.ascontiguousarray(f.coords, dtype="<f4").tobytes()
    return Response(buf, media_type="application/octet-stream")


@app.get("/api/frame/scalar")
def api_scalar(
    run: str = Query(...), step: int = Query(...), field: str = Query(...)
):
    """One scalar column as float32 binary, length n_atoms."""
    f = _load(run, step)
    if field not in f.fields:
        raise HTTPException(400, f"unknown field: {field}")
    buf = np.ascontiguousarray(f.fields[field], dtype="<f4").tobytes()
    return Response(buf, media_type="application/octet-stream")


@app.get("/api/frame/histogram")
def api_histogram(
    run: str = Query(...),
    step: int = Query(...),
    field: str = Query(...),
    bins: int = Query(64, ge=4, le=512),
    vmin: float | None = Query(None),
    vmax: float | None = Query(None),
):
    """Counts per bin for a field's distribution. The optional vmin/vmax
    pin the histogram range so it stays stable while brushing."""
    f = _load(run, step)
    if field not in f.fields:
        raise HTTPException(400, f"unknown field: {field}")
    arr = f.fields[field]
    arr = arr[np.isfinite(arr)]
    lo = float(arr.min()) if vmin is None else vmin
    hi = float(arr.max()) if vmax is None else vmax
    if hi <= lo:
        hi = lo + 1.0
    counts, edges = np.histogram(arr, bins=bins, range=(lo, hi))
    return {
        "field": field,
        "edges": edges.tolist(),
        "counts": counts.astype(int).tolist(),
        "total": int(arr.size),
    }


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


# Static assets (app.js, etc.). Mounted last so /api/* keeps priority.
app.mount("/", StaticFiles(directory=FRONTEND), name="static")
