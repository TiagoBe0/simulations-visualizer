"""FastAPI server: lists LAMMPS runs and streams frame data as compact
little-endian float32 binary so the browser can render hundreds of
thousands of atoms without parsing megabytes of text."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .dump_parser import (
    DATA_DIR,
    discover_runs,
    frame_path,
    get_frame,
    get_script,
    script_path,
)

app = FastAPI(title="LAMMPS Dump Visualizer")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
FIGURES_DIR = Path(__file__).resolve().parent.parent / "figures"

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
_IMAGE_MEDIA = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
}


def _walk_figures(path: Path, rel: str) -> dict:
    node: dict = {"name": path.name, "path": rel, "type": "dir", "children": []}
    try:
        items = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        for child in items:
            child_rel = f"{rel}/{child.name}"
            if child.is_dir():
                node["children"].append(_walk_figures(child, child_rel))
            elif child.is_file():
                node["children"].append({
                    "name": child.name,
                    "path": child_rel,
                    "type": "file",
                    "ext": child.suffix.lower(),
                })
    except PermissionError:
        pass
    return node


@app.get("/api/runs")
def api_runs():
    """All runs found under DATA_DIR and their available timesteps."""
    return {"data_dir": str(DATA_DIR), "runs": discover_runs()}


@app.get("/api/runs/script")
def api_script(run: str = Query(...), file: str = Query(...)):
    """Text content of a simulation script (.in/.txt/.lammps) in a run dir."""
    try:
        return {"run": run, "file": file, "content": get_script(run, file)}
    except FileNotFoundError:
        raise HTTPException(404, f"script not found: {run}/{file}")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/runs/script/download")
def api_script_download(run: str = Query(...), file: str = Query(...)):
    """Download a simulation script as a file attachment."""
    try:
        path = script_path(run, file)
    except FileNotFoundError:
        raise HTTPException(404, f"script not found: {run}/{file}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return FileResponse(
        path, filename=path.name, media_type="application/octet-stream"
    )


@app.get("/api/frame/download")
def api_frame_download(run: str = Query(...), step: int = Query(...)):
    """Download the original LAMMPS dump file for a timestep."""
    try:
        path = frame_path(run, step)
    except FileNotFoundError:
        raise HTTPException(404, f"frame not found: {run} @ {step}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    fname = f"{run.replace('/', '_')}_{path.name}"
    return FileResponse(
        path, filename=fname, media_type="application/octet-stream"
    )


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


@app.get("/api/figures")
def api_figures():
    """Recursive directory tree of the figures/ folder."""
    if not FIGURES_DIR.exists():
        return {"children": []}
    root: dict = {"children": []}
    items = sorted(FIGURES_DIR.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    for item in items:
        if item.is_dir():
            root["children"].append(_walk_figures(item, item.name))
        elif item.is_file():
            root["children"].append({
                "name": item.name,
                "path": item.name,
                "type": "file",
                "ext": item.suffix.lower(),
            })
    return root


@app.get("/api/figures/image")
def api_figures_image(path: str = Query(...)):
    """Serve an image file from the figures/ directory."""
    try:
        target = (FIGURES_DIR / path).resolve()
        target.relative_to(FIGURES_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")
    ext = target.suffix.lower()
    if ext not in _IMAGE_MEDIA:
        raise HTTPException(400, "Not a supported image format")
    return FileResponse(target, media_type=_IMAGE_MEDIA[ext])


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


# Static assets (app.js, etc.). Mounted last so /api/* keeps priority.
app.mount("/", StaticFiles(directory=FRONTEND), name="static")
