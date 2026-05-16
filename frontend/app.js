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

// Rebuild the run list box, keeping only entries that match the search
// text (case-insensitive substring). The current run stays selected if
// it still passes the filter.
function renderRunOptions(filter = "") {
  const f = filter.trim().toLowerCase();
  const list = f ? runs.filter((x) => x.name.toLowerCase().includes(f)) : runs;
  $("run").innerHTML = list
    .map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`)
    .join("");
  if (current && list.some((x) => x.name === current.name))
    $("run").value = current.name;
  $("runCount").textContent =
    `${list.length} de ${runs.length} simulaciones`;
  return list;
}

async function loadRuns() {
  const r = await fetch("api/runs").then((x) => x.json());
  runs = r.runs;
  renderRunOptions();
  if (runs.length) selectRun(runs[0].name);
  else hud.textContent = `Sin simulaciones en ${r.data_dir}`;
}

function selectRun(name) {
  current = runs.find((x) => x.name === name);
  const s = $("step");
  s.min = 0; s.max = current.frames.length - 1; s.value = 0;
  loadFrame();
}

let loadToken = 0;
async function loadFrame() {
  const token = ++loadToken;
  loading.style.display = "flex";
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
$("run").onchange = (e) => { frameCam = true; selectRun(e.target.value); };
$("runSearch").oninput = (e) => renderRunOptions(e.target.value);
// Enter on the search box opens the first match.
$("runSearch").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const first = $("run").options[0];
  if (first) { frameCam = true; $("run").value = first.value; selectRun(first.value); }
};
$("step").oninput = loadFrame;
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
function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
resize();
$("psLbl").textContent = $("psize").value;
loadRuns();
tick();
