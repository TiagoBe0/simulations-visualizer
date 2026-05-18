import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const view = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f5f7);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1e6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

// ---------------------------------------------------------------------------
// Point cloud with colormap + filter + slice done on the GPU
// ---------------------------------------------------------------------------
const uniforms = {
  uVmin: { value: 0 }, uVmax: { value: 1 },
  uFilterOn: { value: false }, uFilterMin: { value: 0 }, uFilterMax: { value: 1 },
  uSliceAxis: { value: -1 }, uSlicePos: { value: 0 },
  uSliceHalf: { value: 1e9 }, uSliceFlip: { value: 1 },
  uPointSize: { value: 1.6 }, uCmap: { value: 0 }, uAtten: { value: 600 },
};

const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */`
    attribute float aVal;
    uniform float uVmin, uVmax, uFilterMin, uFilterMax, uSlicePos, uSliceFlip;
    uniform float uSliceHalf, uPointSize, uAtten;
    uniform bool uFilterOn;
    uniform int uSliceAxis;
    varying float vT;
    void main() {
      bool hide = false;
      if (uFilterOn && (aVal < uFilterMin || aVal > uFilterMax)) hide = true;
      if (uSliceAxis >= 0) {
        float c = uSliceAxis == 0 ? position.x
                : uSliceAxis == 1 ? position.y : position.z;
        bool inSlab = abs(c - uSlicePos) <= uSliceHalf;
        // uSliceFlip = 1: keep the slab; -1: keep everything outside it.
        if ((uSliceFlip > 0.0) != inSlab) hide = true;
      }
      vT = clamp((aVal - uVmin) / max(uVmax - uVmin, 1e-12), 0.0, 1.0);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = hide ? 0.0 : uPointSize * (uAtten / -mv.z);
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform int uCmap;
    varying float vT;
    vec3 turbo(float x){
      const vec3 c0=vec3(0.11408901,0.06288341,0.22483372);
      const vec3 c1=vec3(6.71641950,3.18228675,7.57158159);
      const vec3 c2=vec3(-66.0940236,-4.9279827,-10.09439368);
      const vec3 c3=vec3(228.76607915,25.04986700,-91.54105330);
      const vec3 c4=vec3(-334.83515658,-69.31749713,288.58588506);
      const vec3 c5=vec3(218.76372184,67.52150568,-305.20457722);
      const vec3 c6=vec3(-52.88903478,-21.54527365,110.51746477);
      return clamp(c0+x*(c1+x*(c2+x*(c3+x*(c4+x*(c5+x*c6))))),0.0,1.0);
    }
    vec3 viridis(float x){
      const vec3 c0=vec3(0.27772733,0.00549291,0.33409981);
      const vec3 c1=vec3(0.10509304,1.40401300,1.38385295);
      const vec3 c2=vec3(-0.33086183,0.21480766,0.09435759);
      const vec3 c3=vec3(-4.63422147,-5.79916850,-19.33242343);
      const vec3 c4=vec3(6.22843246,14.17967273,56.69051552);
      const vec3 c5=vec3(4.77631830,-13.74582553,-65.35324836);
      const vec3 c6=vec3(-5.43544318,4.64514238,26.31243530);
      return clamp(c0+x*(c1+x*(c2+x*(c3+x*(c4+x*(c5+x*c6))))),0.0,1.0);
    }
    void main(){
      vec2 d = gl_PointCoord - 0.5;
      if (dot(d, d) > 0.25) discard;          // round sprites
      vec3 col = uCmap == 0 ? turbo(vT)
               : uCmap == 1 ? viridis(vT) : vec3(vT);
      gl_FragColor = vec4(col, 1.0);
    }`,
});

let points = null;
const boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x8a929d);
boxHelper.visible = true;
scene.add(boxHelper);

// ---------------------------------------------------------------------------
// State + data loading
// ---------------------------------------------------------------------------
const hud = document.getElementById("hud");
const loading = document.getElementById("loading");
let runs = [], current = null, meta = null, fieldArr = null;

const $ = (id) => document.getElementById(id);

async function bin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return new Float32Array(await r.arrayBuffer());
}

// JS port of the shader colormaps so histogram bars match the 3D view.
const _TURBO = [[0.11408901,0.06288341,0.22483372],[6.71641950,3.18228675,7.57158159],
  [-66.0940236,-4.9279827,-10.09439368],[228.76607915,25.04986700,-91.54105330],
  [-334.83515658,-69.31749713,288.58588506],[218.76372184,67.52150568,-305.20457722],
  [-52.88903478,-21.54527365,110.51746477]];
const _VIRIDIS = [[0.27772733,0.00549291,0.33409981],[0.10509304,1.40401300,1.38385295],
  [-0.33086183,0.21480766,0.09435759],[-4.63422147,-5.79916850,-19.33242343],
  [6.22843246,14.17967273,56.69051552],[4.77631830,-13.74582553,-65.35324836],
  [-5.43544318,4.64514238,26.31243530]];
function cmapRGB(t, mode) {
  t = Math.min(1, Math.max(0, t));
  if (mode === 2) { const g = Math.round(t * 255); return `rgb(${g},${g},${g})`; }
  const C = mode === 1 ? _VIRIDIS : _TURBO;
  const ch = (k) => {
    let v = C[6][k];
    for (let i = 5; i >= 0; i--) v = C[i][k] + t * v;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

// ---------------------------------------------------------------------------
// Interactive histogram of the colour-by field. Brushing selects a value
// range that drives the GPU filter (uFilterMin/uFilterMax).
// ---------------------------------------------------------------------------
const histCanvas = $("hist");
const hctx = histCanvas.getContext("2d");
let hist = null;            // {edges, counts, total}
let selLo = null, selHi = null;  // null => no selection (show everything)

async function loadHistogram() {
  const field = $("field").value;
  const st = meta.fields[field];
  const fr = current.frames[+$("step").value];
  const q = `run=${encodeURIComponent(current.name)}&step=${fr.step}` +
            `&field=${field}&bins=72&vmin=${st.min}&vmax=${st.max}`;
  hist = await fetch(`api/frame/histogram?${q}`).then((x) => x.json());
  drawHist();
}

function _x2val(px) {
  const e0 = hist.edges[0], eN = hist.edges[hist.edges.length - 1];
  const t = Math.min(1, Math.max(0, px / histCanvas.width));
  return e0 + t * (eN - e0);
}
function _val2x(v) {
  const e0 = hist.edges[0], eN = hist.edges[hist.edges.length - 1];
  return ((v - e0) / (eN - e0)) * histCanvas.width;
}

function drawHist() {
  const W = histCanvas.width, H = histCanvas.height;
  hctx.clearRect(0, 0, W, H);
  if (!hist) return;
  const counts = hist.counts, n = counts.length;
  const log = $("histLog").checked;
  const tf = (c) => (log ? Math.log1p(c) : c);
  let maxc = 0;
  for (const c of counts) maxc = Math.max(maxc, tf(c));
  maxc = maxc || 1;
  const bw = W / n;
  const lo = selLo == null ? -Infinity : selLo;
  const hi = selHi == null ? Infinity : selHi;
  const cmap = +$("cmap").value;
  let selCount = 0;
  for (let i = 0; i < n; i++) {
    const c0 = hist.edges[i], c1 = hist.edges[i + 1];
    const mid = (c0 + c1) / 2;
    const inSel = mid >= lo && mid <= hi;
    if (inSel) selCount += counts[i];
    const h = (tf(counts[i]) / maxc) * (H - 4);
    hctx.fillStyle = cmapRGB((mid - hist.edges[0]) /
      (hist.edges[n] - hist.edges[0]), cmap);
    hctx.globalAlpha = inSel ? 1 : 0.22;
    hctx.fillRect(i * bw, H - h, Math.max(1, bw - 0.5), h);
  }
  hctx.globalAlpha = 1;
  if (selLo != null) {
    const xa = _val2x(selLo), xb = _val2x(selHi);
    hctx.fillStyle = "rgba(77,163,255,.14)";
    hctx.fillRect(xa, 0, xb - xa, H);
    hctx.strokeStyle = "#4da3ff";
    hctx.lineWidth = 1;
    hctx.strokeRect(xa + .5, .5, xb - xa - 1, H - 1);
  }
  const pct = hist.total ? (100 * selCount / hist.total) : 0;
  $("histInfo").textContent = selLo == null
    ? `${hist.total.toLocaleString()} átomos`
    : `${selCount.toLocaleString()} (${pct.toFixed(1)}%)`;
}

function commitSelection(a, b, fromInputs) {
  if (a > b) [a, b] = [b, a];
  selLo = a; selHi = b;
  if (!fromInputs) {
    $("fmin").value = a.toPrecision(5);
    $("fmax").value = b.toPrecision(5);
  }
  uniforms.uFilterMin.value = a;
  uniforms.uFilterMax.value = b;
  $("filtOn").checked = true;
  uniforms.uFilterOn.value = true;
  drawHist();
}
function clearSelection() {
  selLo = selHi = null;
  $("filtOn").checked = false;
  uniforms.uFilterOn.value = false;
  if (meta) {
    const st = meta.fields[$("field").value];
    $("fmin").value = st.min.toPrecision(5);
    $("fmax").value = st.max.toPrecision(5);
    uniforms.uFilterMin.value = st.min;
    uniforms.uFilterMax.value = st.max;
  }
  drawHist();
}

let dragX0 = null;
function _px(e) {
  const r = histCanvas.getBoundingClientRect();
  return (e.clientX - r.left) / r.width * histCanvas.width;
}
histCanvas.addEventListener("pointerdown", (e) => {
  if (!hist) return;
  dragX0 = _px(e);
  histCanvas.setPointerCapture(e.pointerId);
});
histCanvas.addEventListener("pointermove", (e) => {
  if (dragX0 == null) return;
  const a = _x2val(dragX0), b = _x2val(_px(e));
  selLo = Math.min(a, b); selHi = Math.max(a, b);
  drawHist();
});
histCanvas.addEventListener("pointerup", (e) => {
  if (dragX0 == null) return;
  const x1 = _px(e);
  if (Math.abs(x1 - dragX0) < 3) clearSelection();
  else commitSelection(_x2val(dragX0), _x2val(x1), false);
  dragX0 = null;
});
histCanvas.addEventListener("dblclick", clearSelection);

const esc = (s) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// Run picker as a collapsible directory tree. Run names are POSIX-style
// relative paths (e.g. "proyectoA/sub/sp3_20"); listing them flat saturates
// the panel, so we split on "/" and let the user drill into folders. Leaves
// (and any directory that itself holds dumps) are selectable runs.
// ---------------------------------------------------------------------------
const treeExpanded = new Set();  // folder paths the user has opened
let treeFilter = "";

function buildTree(list) {
  const root = { children: new Map() };
  for (const run of list) {
    const parts = run.name.split("/");
    let node = root, acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      if (!node.children.has(part))
        node.children.set(part,
          { name: part, path: acc, children: new Map(), run: null });
      node = node.children.get(part);
    }
    node.run = run;  // this directory contains dump frames
  }
  return root;
}

function renderTreeNodes(node, depth, forceOpen, out) {
  const kids = [...node.children.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const c of kids) {
    const hasKids = c.children.size > 0;
    const open = forceOpen || treeExpanded.has(c.path);
    const isRun = !!c.run;
    const sel = isRun && current && current.name === c.path ? " sel" : "";
    const caret = hasKids ? (open ? "▾" : "▸") : "";
    const icon = isRun ? "◉" : open ? "▿" : "▹";
    out.push(
      `<div class="tnode${sel}" style="padding-left:${6 + depth * 14}px"` +
      ` data-path="${esc(c.path)}" data-kind="${isRun ? "run" : "dir"}"` +
      ` data-haskids="${hasKids ? 1 : 0}">` +
      `<span class="tcaret">${caret}</span>` +
      `<span class="ticon">${icon}</span>` +
      `<span class="tlabel">${esc(c.name)}</span>` +
      (isRun ? `<span class="tmeta">${c.run.frames.length}</span>` : "") +
      `</div>`);
    if (hasKids && open) renderTreeNodes(c, depth + 1, forceOpen, out);
  }
}

// Rebuild the tree, keeping only runs whose path matches the search text
// (case-insensitive substring). While filtering, every level is forced
// open so matches are visible without manual drilling.
function renderRunTree(filter = "") {
  treeFilter = filter;
  const f = filter.trim().toLowerCase();
  const list = f ? runs.filter((x) => x.name.toLowerCase().includes(f)) : runs;
  const out = [];
  renderTreeNodes(buildTree(list), 0, !!f, out);
  $("runTree").innerHTML =
    out.join("") || `<div class="tempty">Sin coincidencias</div>`;
  $("runCount").textContent =
    `${list.length} de ${runs.length} simulaciones`;
  const cur = $("runTree").querySelector(".tnode.sel");
  if (cur) cur.scrollIntoView({ block: "nearest" });
  return list;
}

// Open every ancestor folder of a run so it shows up after selection.
function expandAncestors(name) {
  const parts = name.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? acc + "/" + parts[i] : parts[i];
    treeExpanded.add(acc);
  }
}

$("runTree").addEventListener("click", (e) => {
  const row = e.target.closest(".tnode");
  if (!row) return;
  const { path, kind } = row.dataset;
  const hasKids = row.dataset.haskids === "1";
  const onToggle = e.target.classList.contains("tcaret") ||
                   e.target.classList.contains("ticon");
  // Pure folders toggle anywhere; a directory that is also a run toggles
  // only via its caret/icon so the label still selects the run.
  if (hasKids && (kind === "dir" || onToggle)) {
    treeExpanded.has(path)
      ? treeExpanded.delete(path) : treeExpanded.add(path);
    renderRunTree(treeFilter);
  } else if (kind === "run") {
    frameCam = true;
    selectRun(path);
    renderRunTree(treeFilter);
  }
});

async function loadRuns() {
  const r = await fetch("api/runs").then((x) => x.json());
  runs = r.runs;
  if (runs.length) {
    expandAncestors(runs[0].name);
    selectRun(runs[0].name);
  } else {
    hud.textContent = `Sin simulaciones en ${r.data_dir}`;
  }
  renderRunTree();
}

function selectRun(name) {
  setPlay(false);
  current = runs.find((x) => x.name === name);
  const s = $("step");
  s.min = 0; s.max = current.frames.length - 1; s.value = 0;
  $("play").disabled = current.frames.length < 2;
  renderRunFiles();
  loadFrame();
}

// ---------------------------------------------------------------------------
// Simulation scripts (.in / .txt / .lammps) of the selected run, so a
// reviewer can see which script produced the simulation. Clicking one
// opens a read-only text viewer.
// ---------------------------------------------------------------------------
function renderRunFiles() {
  const sc = (current && current.scripts) || [];
  $("runFiles").innerHTML = sc.length
    ? `<label>Archivos de simulación</label>` + sc.map((f) =>
        `<button class="fbtn" data-file="${esc(f)}">` +
        `<span class="ficon">📄</span>` +
        `<span class="flabel">${esc(f)}</span></button>`).join("")
    : "";
}

async function openScript(run, file) {
  $("fileName").textContent = `${run} / ${file}`;
  $("fileBody").textContent = "Cargando…";
  $("fileView").style.display = "flex";
  try {
    const q = `run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`;
    $("fileDl").href = `api/runs/script/download?${q}`;
    $("fileDl").setAttribute("download", file);
    const r = await fetch(`api/runs/script?${q}`);
    if (!r.ok) throw new Error(await r.text());
    $("fileBody").textContent = (await r.json()).content;
  } catch (e) {
    $("fileBody").textContent = "Error: " + e.message;
  }
}
function closeFile() { $("fileView").style.display = "none"; }

$("runFiles").addEventListener("click", (e) => {
  const b = e.target.closest(".fbtn");
  if (b && current) openScript(current.name, b.dataset.file);
});
$("fileClose").onclick = closeFile;
$("fileView").addEventListener("click", (e) => {
  if (e.target.id === "fileView") closeFile();  // click on backdrop
});
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("imageView").style.display === "flex") closeImageView();
  else if ($("fileView").style.display === "flex") closeFile();
});

// ---------------------------------------------------------------------------
// Playback: step through every frame like a movie. Each iteration waits for
// the frame to fully load (positions + scalar) before advancing, so it never
// runs ahead of the network; `fps` only paces frames once they're ready.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let playing = false, playSession = 0;

function setPlay(on) {
  if (on === playing) return;
  playing = on;
  $("play").textContent = on ? "⏸ Pausar" : "▶ Reproducir";
  if (on) playLoop();
}

async function playLoop() {
  const session = ++playSession;
  while (playing && session === playSession) {
    const t0 = performance.now();
    await loadFrame();
    if (!playing || session !== playSession) break;
    const s = $("step");
    let next = +s.value + 1;
    if (next > +s.max) {
      if (!$("loopOn").checked) { setPlay(false); break; }
      next = 0;
    }
    s.value = next;
    const target = 1000 / +$("fps").value;
    const dt = performance.now() - t0;
    if (dt < target) await sleep(target - dt);
  }
}

let loadToken = 0;
async function loadFrame() {
  const token = ++loadToken;
  if (!playing) loading.style.display = "flex";
  try {
    const fr = current.frames[+$("step").value];
    $("stepLbl").textContent = fr.step;
    const q = `run=${encodeURIComponent(current.name)}&step=${fr.step}`;
    meta = await fetch(`api/frame/meta?${q}`).then((x) => x.json());
    if (token !== loadToken) return;

    populateFields();
    const pos = await bin(`api/frame/positions?${q}`);
    const field = $("field").value;
    fieldArr = await bin(`api/frame/scalar?${q}&field=${field}`);
    if (token !== loadToken) return;

    rebuild(pos, fieldArr);
    applyFieldRange(field);
    selLo = selHi = null;
    $("filtOn").checked = false;
    uniforms.uFilterOn.value = false;
    await loadHistogram();
    if (token !== loadToken) return;
    hud.textContent =
      `${current.name} · t=${meta.timestep} · ${meta.n_atoms.toLocaleString()} átomos`;
  } catch (e) {
    hud.textContent = "Error: " + e.message;
  } finally {
    if (token === loadToken) loading.style.display = "none";
  }
}

function populateFields() {
  const sel = $("field"), prev = sel.value;
  const names = Object.keys(meta.fields);
  sel.innerHTML = names.map((n) => `<option>${n}</option>`).join("");
  if (names.includes(prev)) sel.value = prev;
}

function rebuild(pos, vals) {
  const b = meta.box;
  const ctr = new THREE.Vector3(
    (b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2);

  // Center geometry on the box so orbiting/slicing stay intuitive.
  const n = vals.length;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    p[3*i]   = pos[3*i]   - ctr.x;
    p[3*i+1] = pos[3*i+1] - ctr.y;
    p[3*i+2] = pos[3*i+2] - ctr.z;
  }

  if (points) { points.geometry.dispose(); scene.remove(points); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  g.setAttribute("aVal", new THREE.BufferAttribute(vals, 1));
  points = new THREE.Points(g, material);
  points.frustumCulled = false;
  scene.add(points);

  const half = new THREE.Vector3(
    (b.hi[0]-b.lo[0])/2, (b.hi[1]-b.lo[1])/2, (b.hi[2]-b.lo[2])/2);
  boxHelper.box.set(half.clone().negate(), half.clone());
  uniforms.uAtten.value = view.clientHeight * 0.9;

  // Frame the camera once per run change only.
  if (frameCam) {
    const d = half.length() * 2.4;
    camera.position.set(d, d * 0.6, d);
    controls.target.set(0, 0, 0);
    controls.update();
    frameCam = false;
  }
}
let frameCam = true;

function applyFieldRange(field) {
  const st = meta.fields[field];
  $("vmin").value = st.min.toPrecision(5);
  $("vmax").value = st.max.toPrecision(5);
  $("fmin").value = st.min.toPrecision(5);
  $("fmax").value = st.max.toPrecision(5);
  uniforms.uVmin.value = st.min;
  uniforms.uVmax.value = st.max;
  uniforms.uFilterMin.value = st.min;
  uniforms.uFilterMax.value = st.max;
  updateSlice();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
$("runSearch").oninput = (e) => renderRunTree(e.target.value);
// Enter on the search box opens the first matching run.
$("runSearch").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const f = $("runSearch").value.trim().toLowerCase();
  const first = (f ? runs.filter((x) => x.name.toLowerCase().includes(f))
                   : runs)[0];
  if (first) {
    frameCam = true;
    expandAncestors(first.name);
    selectRun(first.name);
    renderRunTree($("runSearch").value);
  }
};
$("step").oninput = () => { setPlay(false); loadFrame(); };
$("play").onclick = () => setPlay(!playing);
function nudge(d) {
  setPlay(false);
  const s = $("step");
  let v = +s.value + d;
  v = v < 0 ? +s.max : v > +s.max ? 0 : v;
  s.value = v;
  loadFrame();
}
$("stepBack").onclick = () => nudge(-1);
$("stepFwd").onclick = () => nudge(1);
$("frameDl").onclick = () => {
  if (!current) return;
  const fr = current.frames[+$("step").value];
  const q = `run=${encodeURIComponent(current.name)}&step=${fr.step}`;
  const a = document.createElement("a");
  a.href = `api/frame/download?${q}`;
  a.download = "";                       // let the server name the file
  document.body.appendChild(a);
  a.click();
  a.remove();
};
$("fps").oninput = (e) => $("fpsLbl").textContent = e.target.value;
$("fpsLbl").textContent = $("fps").value;
$("field").onchange = async () => {
  const q = `run=${encodeURIComponent(current.name)}&step=${current.frames[+$("step").value].step}`;
  fieldArr = await bin(`api/frame/scalar?${q}&field=${$("field").value}`);
  points.geometry.setAttribute("aVal", new THREE.BufferAttribute(fieldArr, 1));
  applyFieldRange($("field").value);
  selLo = selHi = null;
  $("filtOn").checked = false;
  uniforms.uFilterOn.value = false;
  await loadHistogram();
};
$("cmap").onchange = (e) => { uniforms.uCmap.value = +e.target.value; drawHist(); };
$("vmin").oninput = (e) => uniforms.uVmin.value = +e.target.value;
$("vmax").oninput = (e) => uniforms.uVmax.value = +e.target.value;
$("vreset").onclick = () => applyFieldRange($("field").value);
$("histLog").onchange = drawHist;
$("filtOn").onchange = (e) => {
  if (e.target.checked) commitSelection(+$("fmin").value, +$("fmax").value, false);
  else clearSelection();
};
$("fmin").oninput = (e) => { uniforms.uFilterMin.value = +e.target.value;
  if ($("filtOn").checked) { selLo = +e.target.value; drawHist(); } };
$("fmax").oninput = (e) => { uniforms.uFilterMax.value = +e.target.value;
  if ($("filtOn").checked) { selHi = +e.target.value; drawHist(); } };
$("sliceAxis").onchange = updateSlice;
$("slicePos").oninput = updateSlice;
$("sliceThick").oninput = updateSlice;
$("sliceFlip").onchange = updateSlice;
$("psize").oninput = (e) => {
  uniforms.uPointSize.value = +e.target.value;
  $("psLbl").textContent = e.target.value;
};
$("boxOn").onchange = (e) => boxHelper.visible = e.target.checked;

function updateSlice() {
  const axis = +$("sliceAxis").value;
  uniforms.uSliceAxis.value = axis;
  uniforms.uSliceFlip.value = $("sliceFlip").checked ? -1 : 1;
  if (axis >= 0 && meta) {
    const lo = meta.box.lo[axis], hi = meta.box.hi[axis];
    const ctr = (lo + hi) / 2, extent = hi - lo;
    const t = +$("slicePos").value;            // 0..1 across the box
    const world = lo + t * extent;
    const thick = +$("sliceThick").value * extent;  // box units
    uniforms.uSlicePos.value = world - ctr;     // geometry is box-centered
    uniforms.uSliceHalf.value = thick / 2;
    $("sliceLbl").textContent = world.toFixed(2);
    $("sliceThickLbl").textContent = thick.toFixed(2);
  } else {
    $("sliceLbl").textContent = "";
    $("sliceThickLbl").textContent = "";
  }
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
function switchTab(tab) {
  if (tab === "sim") {
    $("simPanel").style.display = "block";
    $("figPanel").style.display = "none";
    $("tabSim").classList.add("active");
    $("tabFig").classList.remove("active");
  } else {
    $("simPanel").style.display = "none";
    $("figPanel").style.display = "block";
    $("tabSim").classList.remove("active");
    $("tabFig").classList.add("active");
    if (!figTree) loadFigures();
  }
}
$("tabSim").onclick = () => switchTab("sim");
$("tabFig").onclick = () => switchTab("fig");

// ---------------------------------------------------------------------------
// Figures browser
// ---------------------------------------------------------------------------
const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
let figTree = null;
const figExpanded = new Set();
let figFilter = "";

function isImgNode(node) {
  return node.type === "file" && IMG_EXTS.has(node.ext);
}

async function loadFigures() {
  $("figTree").innerHTML = `<div class="tempty">Cargando…</div>`;
  try {
    figTree = await fetch("api/figures").then((x) => x.json());
    renderFigTree();
  } catch (e) {
    $("figTree").innerHTML = `<div class="tempty">Error: ${e.message}</div>`;
  }
}

function nodeMatchesFilter(node, f) {
  if (node.name.toLowerCase().includes(f)) return true;
  if (node.type === "dir")
    return (node.children || []).some((c) => nodeMatchesFilter(c, f));
  return false;
}

function renderFigNodes(nodes, depth, forceOpen, f, out) {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of sorted) {
    if (f && !nodeMatchesFilter(node, f)) continue;
    if (node.type === "dir") {
      const open = forceOpen || figExpanded.has(node.path);
      out.push(
        `<div class="tnode" style="padding-left:${6 + depth * 14}px"` +
        ` data-figpath="${esc(node.path)}" data-figkind="dir">` +
        `<span class="tcaret">${open ? "▾" : "▸"}</span>` +
        `<span class="ticon">${open ? "▿" : "▹"}</span>` +
        `<span class="tlabel">${esc(node.name)}</span></div>`
      );
      if (open && node.children)
        renderFigNodes(node.children, depth + 1, forceOpen, f, out);
    } else {
      const img = isImgNode(node);
      out.push(
        `<div class="tnode ${img ? "fig-img" : "fig-other"}"` +
        ` style="padding-left:${6 + depth * 14}px"` +
        ` data-figpath="${esc(node.path)}" data-figkind="file"` +
        ` data-figimg="${img ? 1 : 0}">` +
        `<span class="tcaret"></span>` +
        `<span class="ticon">${img ? "◈" : "▪"}</span>` +
        `<span class="tlabel">${esc(node.name)}</span></div>`
      );
    }
  }
}

function renderFigTree(filter = "") {
  figFilter = filter;
  const f = filter.trim().toLowerCase();
  if (!figTree) return;
  const out = [];
  renderFigNodes(figTree.children || [], 0, !!f, f, out);
  $("figTree").innerHTML = out.join("") ||
    `<div class="tempty">Sin coincidencias</div>`;
}

$("figTree").addEventListener("click", (e) => {
  const row = e.target.closest(".tnode");
  if (!row) return;
  const { figpath, figkind, figimg } = row.dataset;
  if (figkind === "dir") {
    figExpanded.has(figpath) ? figExpanded.delete(figpath) : figExpanded.add(figpath);
    renderFigTree(figFilter);
  } else if (figkind === "file" && figimg === "1") {
    openImage(figpath);
  }
});
$("figSearch").oninput = (e) => renderFigTree(e.target.value);

// ---------------------------------------------------------------------------
// Image viewer with zoom + pan
// ---------------------------------------------------------------------------
let imgScale = 1, imgX = 0, imgY = 0;
let imgDragging = false, imgDragStart = null;

function applyImgTransform() {
  $("imageEl").style.transform = `translate(${imgX}px,${imgY}px) scale(${imgScale})`;
  $("imageZoomLbl").textContent = `${Math.round(imgScale * 100)}%`;
}

function resetImgView() {
  imgScale = 1; imgX = 0; imgY = 0;
  applyImgTransform();
}

function openImage(path) {
  $("imageName").textContent = path;
  const url = `api/figures/image?path=${encodeURIComponent(path)}`;
  $("imageDl").href = url;
  $("imageDl").setAttribute("download", path.split("/").pop());
  $("imageEl").src = url;
  resetImgView();
  $("imageView").style.display = "flex";
}

function closeImageView() { $("imageView").style.display = "none"; }

const imgBody = $("imageBody");

imgBody.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  imgScale = Math.max(0.05, Math.min(30, imgScale * factor));
  applyImgTransform();
}, { passive: false });

imgBody.addEventListener("pointerdown", (e) => {
  imgDragging = true;
  imgDragStart = { x: e.clientX - imgX, y: e.clientY - imgY };
  imgBody.setPointerCapture(e.pointerId);
  imgBody.classList.add("dragging");
});
imgBody.addEventListener("pointermove", (e) => {
  if (!imgDragging) return;
  imgX = e.clientX - imgDragStart.x;
  imgY = e.clientY - imgDragStart.y;
  applyImgTransform();
});
imgBody.addEventListener("pointerup", () => {
  imgDragging = false;
  imgBody.classList.remove("dragging");
});
imgBody.addEventListener("dblclick", resetImgView);
$("imageZoomReset").onclick = resetImgView;
$("imageClose").onclick = closeImageView;
$("imageView").addEventListener("click", (e) => {
  if (e.target.id === "imageView" || e.target.id === "imageBody") closeImageView();
});

// ---------------------------------------------------------------------------
function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
resize();
$("psLbl").textContent = $("psize").value;
loadRuns();
tick();
