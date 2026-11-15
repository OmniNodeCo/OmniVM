/* ============================================================================
 * OmniVM Workstation — canvas GUI engine (Electron desktop renderer)
 * ----------------------------------------------------------------------------
 * Every widget — window panels, buttons, icons, list rows, dialogs, the VM
 * console — is drawn onto a single <canvas> by this code. No HTML UI, no
 * CSS, no DOM widgets: a pixel buffer, a mouse and a keyboard, like a
 * native app. It talks to the VM engine over the desktop IPC bridge
 * (window.omnivm, set up by preload.cjs).
 * ==========================================================================*/
"use strict";

/* ---------------- canvas & helpers ---------------- */
const canvas = document.getElementById("omnivm");
const ctx = canvas.getContext("2d");

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FONT_UI = `-apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif`;
const FONT_MONO = `ui-monospace, Menlo, Consolas, "Liberation Mono", monospace`;

const C = {
  bg: "#17181b", bg2: "#1e2024", panel: "#232529", panel2: "#2b2e33",
  border: "#33363c", borderHi: "#4a4e55",
  text: "#e8eaed", muted: "#9aa0a6", dim: "#6b7076",
  accent: "#4fc3f7", accent2: "#2196f3",
  green: "#66bb6a", amber: "#ffca28", red: "#ef5350",
  sel: "#2196f326", selBorder: "#2196f388",
  termBg: "#0c0d0f", termBorder: "#26282c", termText: "#d7dade",
  phosphor: "#7dffa0",
};

function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const font = (px, weight, mono) => `${weight || 400} ${px}px ${mono ? FONT_MONO : FONT_UI}`;
function text(str, x, y, px, color, opts = {}) {
  ctx.font = font(px, opts.weight, opts.mono);
  ctx.fillStyle = color;
  ctx.textBaseline = opts.baseline || "middle";
  if (opts.max) {
    if (ctx.measureText(str).width > opts.max) {
      while (str.length > 1 && ctx.measureText(str + "…").width > opts.max) str = str.slice(0, -1);
      str += "…";
    }
  }
  ctx.fillText(str, x, y);
  return ctx.measureText(str).width;
}
const tw = (str, px, weight, mono) => { ctx.font = font(px, weight, mono); return ctx.measureText(str).width; };

/* ---------------- desktop IPC bridge ---------------- */
const bridge = window.omnivm;
async function rpc(channel, payload, timeoutMs = 180000) {
  const res = await Promise.race([
    bridge.invoke(channel, payload || {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error("request timed out")), timeoutMs)),
  ]);
  if (!res || !res.ok) throw new Error((res && res.error) || "request failed");
  return res.result;
}
function b64text(b64) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("latin1").decode(bytes);
}

/* ---------------- app state ---------------- */
let vms = [];
let selectedId = null;
let consoleView = "serial";
let interactive = false;
let scroll = 0;
let vgaRows = null;
let vgaTimer = null;
const consoles = new Map();
let mouse = { x: -1, y: -1, down: false };
let modal = null;
let hotspots = [];
let toasts = [];
let snaps = [], snapSel = -1, snapName = "", snapFieldFocus = false;
let confirmFn = null, confirmState = { title: "", body: "" };
let lastFrame = Date.now();
let uptimeBase = null, uptimeAt = 0;   // interpolate uptime between broadcasts
let dragDepth = 0;                     // ISO drag & drop overlay

const form = {
  fields: ["name", "mem", "disk", "media", "cdrom"],
  values: { name: "new-vm", mem: "64", disk: "0", media: 0, cdrom: "" },
  labels: { name: "Name", mem: "Memory (MB)", disk: "Hard disk (MB, 0 = none)", media: "Floppy drive", cdrom: "CD-ROM image path (.iso)" },
  focus: 0,
};
const MEDIA_OPTS = ["OmniOS 1.0 (bundled live floppy)", "Empty"];

/* ---------------- events from the engine ---------------- */
bridge.onVms(list => {
  const prev = vms.find(v => v.id === selectedId);
  if (prev && prev.uptimeMs != null) { uptimeBase = prev.uptimeMs; uptimeAt = Date.now(); }
  vms = list || [];
  window.__vmsReceived = true;
});
bridge.onConsole((vmId, data) => {
  const buf = (consoles.get(vmId) || "") + b64text(data);
  consoles.set(vmId, buf.length > 200000 ? buf.slice(-120000) : buf);
});
bridge.onMenu(action => {
  const vm = selectedVM();
  switch (action) {
    case "newvm": modal = "newvm"; form.focus = 0; break;
    case "snapshots": if (vm) openSnaps(); break;
    case "power-on": if (vm) vmAction("start", "Powering on"); break;
    case "power-off": if (vm) vmAction("stop", "Powering off"); break;
    case "suspend": if (vm) vmAction("suspend", "Suspending"); break;
    case "resume": if (vm) vmAction("resume", "Resuming"); break;
    case "reset": if (vm) vmAction("reset", "Resetting"); break;
    case "pause-toggle": if (vm) vmAction(vm.state === "paused" ? "unpause" : "pause", "Pause/unpause"); break;
    case "view-serial": setView("serial"); break;
    case "view-vga": setView("vga"); break;
  }
});

/* ---------------- helpers ---------------- */
const selectedVM = () => vms.find(v => v.id === selectedId) || null;
const stateLabel = s => ({ running: "Powered on", suspended: "Suspended", paused: "Paused", crashed: "Crashed", off: "Powered off" }[s] || s);
const stateColor = s => ({ running: C.green, suspended: C.amber, paused: C.amber, crashed: C.red, off: C.dim }[s] || C.dim);
const fmtMB = mb => mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
const fmtUptime = ms => {
  if (ms == null) return "-";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const shortPath = p => { p = String(p); return p.length > 36 ? "…" + p.slice(-35) : p; };
function currentUptime(vm) {
  if (!vm || (vm.state !== "running" && vm.state !== "paused")) return null;
  return vm.uptimeMs != null ? vm.uptimeMs + (Date.now() - (uptimeAt || Date.now())) : null;
}
function toast(t, kind = "info") {
  toasts.push({ text: t, kind, until: Date.now() + 4200 });
  if (toasts.length > 5) toasts.shift();
}

/* ---------------- actions ---------------- */
function selectVM(id) {
  if (selectedId === id) return;
  if (selectedId) bridge.invoke("console:detach", { id: selectedId });
  selectedId = id;
  consoles.delete(id);
  vgaRows = null; scroll = 0; interactive = false;
  bridge.invoke("console:attach", { id });
  setView(consoleView, true);
}
function setView(view, keep) {
  consoleView = view;
  clearInterval(vgaTimer); vgaTimer = null;
  if (view === "vga" && selectedId) {
    const poll = async () => { try { vgaRows = await rpc("console:screen", { id: selectedId }, 15000); } catch {} };
    poll();
    vgaTimer = setInterval(poll, 1000);
  }
  if (!keep) scroll = 0;
}
async function vmAction(action, label) {
  const vm = selectedVM();
  if (!vm) return;
  toast(`${label} ${vm.name}…`);
  try { await rpc("vm:action", { id: vm.id, action }); }
  catch (e) { toast(e.message, "err"); }
}
function askConfirm(title, body, fn) {
  modal = "confirm"; confirmFn = fn; confirmState = { title, body };
}
async function openSnaps() {
  const vm = selectedVM();
  if (!vm) return;
  modal = "snaps"; snapSel = -1; snaps = []; snapName = ""; snapFieldFocus = false;
  try { snaps = await rpc("snap:list", { id: vm.id }, 30000); } catch {}
}

/* ---------------- ISO drag & drop / paste ---------------- */
function looksLikeIso(p) { return /\.iso$/i.test(String(p || "").trim()); }

async function attachIso(rawPath) {
  const p = String(rawPath || "").trim().replace(/^["']|["']$/g, "");
  if (!p) return;
  if (!looksLikeIso(p)) { toast("Only .iso disc images can be attached", "warn"); return; }
  const vm = selectedVM();
  if (vm) {
    if (vm.state !== "off" && vm.state !== "crashed") {
      toast(`Power "${vm.name}" off to change its media`, "warn");
      return;
    }
    try {
      await rpc("vm:set-cdrom", { id: vm.id, iso: p });
      toast(`Attached ${shortPath(p)} to "${vm.name}"`, "ok");
    } catch (e) { toast(e.message, "err"); }
  } else {
    form.values.cdrom = p;
    form.focus = form.fields.indexOf("cdrom");
    modal = "newvm";
    toast("ISO ready — name the VM and create it", "ok");
  }
}

async function droppedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const iso = files.find(f => looksLikeIso(f.path || "") || looksLikeIso(f.name)) || files[0];
  let p = "";
  try { p = bridge.pathForFile(iso) || ""; } catch { p = ""; }
  if (!p) p = iso.name;
  await attachIso(p);
}

window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; });
window.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
window.addEventListener("dragleave", e => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); });
window.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  droppedFiles(e.dataTransfer && e.dataTransfer.files);
});

async function readClipboard() {
  try { return (await rpc("sys:clipboard-read", {}, 5000)) || ""; }
  catch { return ""; }
}

/* paste behaviour:
 *  - newvm/snaps modal focused field: insert clipboard text
 *  - interactive console: send clipboard text to the guest
 *  - otherwise: attach an ISO whose path was copied to the clipboard */
async function pasteSomewhere() {
  const clip = await readClipboard();
  const text = clip.replace(/\r|\n/g, " ").trim();
  if (!text) { toast("Clipboard is empty", "warn"); return; }
  if (modal === "newvm") {
    const f = form.fields[form.focus];
    if (f && f !== "media") { form.values[f] += text; return; }
    return;
  }
  if (modal === "snaps") {
    if (snapFieldFocus) snapName += text;
    return;
  }
  const vm = selectedVM();
  if (interactive && vm && (vm.state === "running" || vm.state === "paused")) {
    bridge.invoke("console:input", { id: vm.id, data: btoa(unescape(encodeURIComponent(clip.replace(/\n/g, "\r")))) });
    toast("Pasted into the guest console", "ok");
    return;
  }
  if (looksLikeIso(text)) { await attachIso(text); return; }
  if (/^[A-Za-z]:\\|^\//.test(text)) toast("Clipboard path is not an .iso", "warn");
}

/* ---------------- icons ---------------- */
function iconPower(x, y, s, color) {
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.6, s / 9); ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(x, y + s * 0.08, s * 0.42, -0.35 * Math.PI, 1.35 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - s * 0.55); ctx.lineTo(x, y + s * 0.02); ctx.stroke();
}
function iconStop(x, y, s, color) {
  ctx.fillStyle = color; rr(x - s * 0.4, y - s * 0.4, s * 0.8, s * 0.8, s * 0.12); ctx.fill();
}
function iconPause(x, y, s, color) {
  ctx.fillStyle = color;
  rr(x - s * 0.42, y - s * 0.45, s * 0.28, s * 0.9, 2); ctx.fill();
  rr(x + s * 0.14, y - s * 0.45, s * 0.28, s * 0.9, 2); ctx.fill();
}
function iconPlay(x, y, s, color) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(x - s * 0.35, y - s * 0.45); ctx.lineTo(x + s * 0.45, y); ctx.lineTo(x - s * 0.35, y + s * 0.45); ctx.closePath(); ctx.fill();
}
function iconReset(x, y, s, color) {
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.6, s / 9); ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(x, y, s * 0.4, 0.4, 2.2 * Math.PI); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(x + s * 0.52, y - s * 0.42); ctx.lineTo(x + s * 0.18, y - s * 0.32); ctx.lineTo(x + s * 0.44, y - s * 0.04); ctx.closePath(); ctx.fill();
}
function iconSwap(x, y, s, color) {
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.6, s / 9); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x - s * 0.42, y - s * 0.15); ctx.lineTo(x + s * 0.3, y - s * 0.15); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + s * 0.05, y - s * 0.4); ctx.lineTo(x + s * 0.32, y - s * 0.15); ctx.lineTo(x + s * 0.05, y + 0.1 * s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + s * 0.42, y + s * 0.2); ctx.lineTo(x - s * 0.3, y + s * 0.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - s * 0.05, y + s * 0.45); ctx.lineTo(x - s * 0.32, y + s * 0.2); ctx.lineTo(x - s * 0.05, y - s * 0.05); ctx.stroke();
}
function iconSnap(x, y, s, color) {
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.6, s / 10);
  ctx.beginPath(); ctx.arc(x, y, s * 0.45, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, s * 0.2, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - s * 0.45); ctx.lineTo(x, y - s * 0.62); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y + s * 0.45); ctx.lineTo(x, y + s * 0.62); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - s * 0.45, y); ctx.lineTo(x - s * 0.62, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + s * 0.45, y); ctx.lineTo(x + s * 0.62, y); ctx.stroke();
}
function iconTrash(x, y, s, color) {
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.6, s / 10);
  rr(x - s * 0.34, y - s * 0.3, s * 0.68, s * 0.78, 3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - s * 0.48, y - s * 0.34); ctx.lineTo(x + s * 0.48, y - s * 0.34); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - s * 0.14, y - s * 0.34); ctx.lineTo(x - s * 0.14, y - s * 0.5); ctx.lineTo(x + s * 0.14, y - s * 0.5); ctx.lineTo(x + s * 0.14, y - s * 0.34); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - s * 0.12, y - s * 0.1); ctx.lineTo(x - s * 0.12, y + s * 0.28); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + s * 0.12, y - s * 0.1); ctx.lineTo(x + s * 0.12, y + s * 0.28); ctx.stroke();
}
function iconClone(x, y, s, color) {
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.6, s / 10);
  rr(x - s * 0.05, y - s * 0.45, s * 0.72, s * 0.72, 3); ctx.stroke();
  rr(x - s * 0.48, y - s * 0.05, s * 0.72, s * 0.72, 3); ctx.stroke();
}
function iconLogo(x, y, s) {
  ctx.fillStyle = C.accent;
  rr(x, y - s * 0.55, s * 1.3, s * 0.85, 3); ctx.fill();
  ctx.fillStyle = C.bg;
  rr(x + s * 0.14, y - s * 0.41, s * 1.02, s * 0.57, 2); ctx.fill();
  ctx.fillStyle = C.accent;
  rr(x + s * 0.38, y + s * 0.42, s * 0.54, s * 0.09, 2); ctx.fill();
}

/* ---------------- layout ---------------- */
const L = { w: 0, h: 0, side: 264, head: 46, pad: 14 };
function layout() {
  L.w = window.innerWidth;
  L.h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== L.w * dpr || canvas.height !== L.h * dpr) {
    canvas.width = L.w * dpr; canvas.height = L.h * dpr;
    canvas.style.width = L.w + "px"; canvas.style.height = L.h + "px";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  L.bodyX = L.side + 1;
  L.bodyW = L.w - L.bodyX;
  L.toolY = L.head + 12;
  L.sumY = L.toolY + 46;
  L.sumH = 158;
  L.conY = L.sumY + L.sumH + 12;
  L.conH = L.h - L.conY - 14;
}

/* ---------------- widgets ---------------- */
function button(x, y, w, h, { label, color = C.text, bg = C.panel, border = C.border, disabled, onClick }) {
  const hov = !disabled && mouse.x >= x && mouse.x <= x + w && mouse.y >= y && mouse.y <= y + h;
  ctx.globalAlpha = disabled ? 0.35 : 1;
  rr(x, y, w, h, 8);
  ctx.fillStyle = hov ? C.panel2 : bg; ctx.fill();
  ctx.strokeStyle = hov ? C.borderHi : border; ctx.lineWidth = 1; ctx.stroke();
  ctx.globalAlpha = 1;
  if (label) text(label, x + 10, y + h / 2 + 1, 12.5, color, { weight: 500 });
  if (!disabled && onClick) hotspots.push({ x, y, w, h, cb: onClick });
}
function statePill(x, y, state) {
  const label = stateLabel(state);
  const w = tw(label, 11.5, 600) + 24, h = 22;
  rr(x, y, w, h, h / 2);
  ctx.fillStyle = stateColor(state) + "1f"; ctx.fill();
  ctx.strokeStyle = stateColor(state); ctx.lineWidth = 1; ctx.stroke();
  text(label, x + 12, y + h / 2 + 0.5, 11.5, stateColor(state), { weight: 600 });
}

/* ---------------- main draw ---------------- */
function draw() {
  hotspots = [];
  layout();
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, L.w, L.h);
  drawHeader();
  drawSidebar();
  const vm = selectedVM();
  if (!vm) drawHero();
  else {
    drawDetailHead(vm);
    drawToolbar(vm);
    drawSummary(vm);
    drawConsole(vm);
  }
  if (modal === "newvm") drawNewVM();
  if (modal === "snaps") drawSnaps();
  if (modal === "confirm") drawConfirm();
  if (dragDepth > 0) drawDropOverlay();
  drawToasts();
}

function drawDropOverlay() {
  ctx.fillStyle = "#0c14206e"; ctx.fillRect(0, 0, L.w, L.h);
  const pad = 18, x = pad, y = L.head + pad, w = L.w - pad * 2, h = L.h - L.head - pad * 2;
  rr(x, y, w, h, 16);
  ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5;
  ctx.setLineDash([12, 10]);
  ctx.stroke();
  ctx.setLineDash([]);
  const vm = selectedVM();
  const big = vm ? `Drop the ISO to attach it to "${vm.name}"`
                 : "Drop the ISO to create a new VM with it";
  text(big, L.w / 2 - tw(big, 19, 700) / 2, L.h / 2 - 22, 19, "#ffffff", { weight: 700 });
  const small = vm ? "requires the VM to be powered off · Ctrl-V also pastes an ISO path"
                   : "or press Ctrl-V with an ISO path copied";
  text(small, L.w / 2 - tw(small, 12.5) / 2, L.h / 2 + 10, 12.5, "#c9e7f8");
  /* disc icon */
  const cx = L.w / 2, cy = L.h / 2 - 78;
  ctx.strokeStyle = C.accent; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, 26, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 9, 0, 7); ctx.stroke();
}

function drawHeader() {
  ctx.fillStyle = "#1b1d20"; ctx.fillRect(0, 0, L.w, L.head);
  ctx.strokeStyle = C.border; ctx.beginPath(); ctx.moveTo(0, L.head - 0.5); ctx.lineTo(L.w, L.head - 0.5); ctx.stroke();
  iconLogo(16, L.head / 2, 18);
  text("OmniVM", 50, L.head / 2 - 8, 15.5, C.text, { weight: 700 });
  text("Workstation", 50 + tw("OmniVM", 15.5, 700) + 7, L.head / 2 - 8, 15.5, C.muted);
  text("desktop edition", 50, L.head / 2 + 10, 10.5, C.dim);
}

function drawSidebar() {
  ctx.fillStyle = C.bg2; ctx.fillRect(0, L.head, L.side, L.h - L.head);
  ctx.strokeStyle = C.border; ctx.beginPath(); ctx.moveTo(L.side + 0.5, L.head); ctx.lineTo(L.side + 0.5, L.h); ctx.stroke();

  text("VM LIBRARY", 14, L.head + 22, 11, C.muted, { weight: 700 });
  button(L.side - 106, L.head + 8, 92, 27, {
    label: "＋ New VM", color: "#fff", bg: C.accent2, border: C.accent2,
    onClick: () => { modal = "newvm"; form.focus = 0; },
  });

  let y = L.head + 52;
  for (const vm of vms) {
    const h = 52;
    const hov = mouse.x >= 8 && mouse.x <= L.side - 8 && mouse.y >= y && mouse.y <= y + h;
    const sel = vm.id === selectedId;
    if (sel || hov) { rr(8, y, L.side - 16, h, 8); ctx.fillStyle = sel ? C.sel : "#ffffff0d"; ctx.fill(); }
    if (sel) { rr(8, y, L.side - 16, h, 8); ctx.strokeStyle = C.selBorder; ctx.lineWidth = 1; ctx.stroke(); }

    ctx.beginPath(); ctx.arc(26, y + 18, 4.5, 0, 7);
    ctx.fillStyle = stateColor(vm.state); ctx.fill();
    if (vm.state === "running") { ctx.shadowColor = C.green; ctx.shadowBlur = 7; ctx.fill(); ctx.shadowBlur = 0; }

    text(vm.name, 38, y + 15, 13, sel ? "#fff" : C.text, { weight: 600, max: L.side - 130 });
    text(vm.guestOs || "", 38, y + 33, 10.5, C.muted, { max: L.side - 130 });
    text(vm.state, L.side - 16 - tw(vm.state, 10.5, 600) - 4, y + 33, 10.5, stateColor(vm.state), { weight: 600 });
    hotspots.push({ x: 8, y, w: L.side - 16, h, cb: () => selectVM(vm.id) });
    y += h + 4;
  }
  if (!vms.length) {
    text("No virtual machines yet.", 18, y + 30, 12, C.muted);
    text("Click ＋ New VM to create one.", 18, y + 50, 12, C.muted);
  }
}

function drawHero() {
  const cx = L.bodyX + L.bodyW / 2, cy = L.h / 2;
  iconLogo(cx - 34, cy - 110, 40);
  text("Welcome to OmniVM Workstation", cx - tw("Welcome to OmniVM Workstation", 21, 700) / 2, cy - 48, 21, C.text, { weight: 700 });
  const line1 = "Select a virtual machine on the left, or create a new one.";
  const line2 = "Every VM ships with OmniOS — a tiny bundled operating system with a live console.";
  text(line1, cx - tw(line1, 13.5) / 2, cy - 14, 13.5, C.muted);
  text(line2, cx - tw(line2, 13.5) / 2, cy + 8, 13.5, C.muted);
  button(cx - 125, cy + 42, 250, 42, {
    label: "＋ Create a Virtual Machine", color: "#fff", bg: C.accent2, border: C.accent2,
    onClick: () => { modal = "newvm"; form.focus = 0; },
  });
}

function drawDetailHead(vm) {
  text(vm.name, L.bodyX + L.pad, L.head + 26, 20, C.text, { weight: 700 });
  const sub = `${vm.guestOs || "Unknown OS"} · created ${String(vm.created || "").slice(0, 10)}`;
  text(sub, L.bodyX + L.pad + tw(vm.name, 20, 700) + 14, L.head + 27, 12, C.muted);
  statePill(L.w - L.pad - tw(stateLabel(vm.state), 11.5, 600) - 34, L.head + 14, vm.state);
}

function drawToolbar(vm) {
  const on = vm.state === "running";
  const paused = vm.state === "paused";
  const suspended = vm.state === "suspended";
  const off = vm.state === "off" || vm.state === "crashed";
  const runningish = on || paused;

  const defs = [
    { icon: iconPower, label: "Power On", dis: false, act: () => vmAction("start", "Powering on") },
    { icon: iconStop, label: "Power Off", dis: !runningish && !suspended, act: () => vmAction("stop", "Powering off") },
    { icon: iconPause, label: "Suspend", dis: !(on && !paused), act: () => vmAction("suspend", "Suspending") },
    { icon: iconPlay, label: "Resume", dis: !suspended, act: () => vmAction("resume", "Resuming") },
    { icon: iconReset, label: "Reset", dis: !runningish, act: () => vmAction("reset", "Resetting") },
    { icon: iconSwap, label: paused ? "Unpause" : "Pause", dis: !on, act: () => vmAction(paused ? "unpause" : "pause", "Pause/unpause") },
    { sep: true },
    { icon: iconSnap, label: "Snapshots", dis: false, act: openSnaps },
    { icon: iconClone, label: "Clone", dis: !off, act: () => vmAction("clone", "Cloning") },
    { icon: iconTrash, label: "Delete", dis: false, color: "#ff8a80", act: () =>
      askConfirm("Delete VM", `Delete "${vm.name}" and all of its disks? This cannot be undone.`, () => vmAction("delete", "Deleting")) },
  ];
  let x = L.bodyX + L.pad;
  const y = L.toolY;
  for (const d of defs) {
    if (d.sep) { ctx.fillStyle = C.border; ctx.fillRect(x + 2, y + 8, 1, 24); x += 12; continue; }
    const w = 30 + tw(d.label, 12.5, 500) + 14;
    button(x, y, w, 36, {
      label: d.label,
      color: d.color || C.text,
      disabled: d.dis,
      onClick: d.act,
    });
    if (!d.dis) d.icon(x + 15, y + 18, 17, d.color || C.text);
    else d.icon(x + 15, y + 18, 17, "#7a7f86");
    x += w + 6;
  }
}

function drawSummary(vm) {
  const x = L.bodyX + L.pad, y = L.sumY, w = L.bodyW - L.pad * 2, h = L.sumH - 12;
  rr(x, y, w, h, 10); ctx.fillStyle = C.panel; ctx.fill();
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
  text("SUMMARY", x + 16, y + 18, 10.5, C.muted, { weight: 700 });

  const on = vm.state === "running" || vm.state === "paused";
  const up = currentUptime(vm);
  const cards = [
    ["State", stateLabel(vm.state)],
    ["Guest OS", vm.guestOs || "-"],
    ["Memory", `${fmtMB(vm.memMB)} (${vm.memMB} MB)`],
    ["Processors", `${vm.cpus} vCPU (software x86)`],
    ["Hard Disk", vm.diskMB > 0 ? `${fmtMB(vm.diskMB)} raw image` : "none"],
    ["Floppy", vm.floppy === "omnios" ? "OmniOS 1.0 (bundled)" : vm.floppy ? shortPath(vm.floppy) : "empty"],
    ["CD-ROM", vm.cdrom ? shortPath(vm.cdrom) : "empty"],
    ["Boot order", vm.boot || "floppy"],
    ["Uptime", on && up != null ? fmtUptime(up) : "-"],
  ];
  const cols = Math.max(2, Math.floor((w - 24) / 210));
  const cw = (w - 24 - (cols - 1) * 10) / cols;
  const ch = 42;
  cards.forEach(([k, v], i) => {
    const cx = x + 12 + (i % cols) * (cw + 10);
    const cy = y + 30 + Math.floor(i / cols) * (ch + 8);
    rr(cx, cy, cw, ch, 8); ctx.fillStyle = C.bg2; ctx.fill();
    ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
    text(k.toUpperCase(), cx + 10, cy + 13, 9.5, C.muted, { weight: 600 });
    text(String(v), cx + 10, cy + 30, 12.5, v === "none" || v === "empty" || v === "-" ? C.muted : C.text, { weight: 600, max: cw - 18 });
  });
}

/* ---------------- console ---------------- */
function drawConsole(vm) {
  const x = L.bodyX + L.pad, y = L.conY, w = L.bodyW - L.pad * 2, h = L.conH;
  if (h < 120) return;
  rr(x, y, w, h, 10); ctx.fillStyle = C.panel; ctx.fill();
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();

  const powered = vm.state === "running" || vm.state === "paused";

  text("CONSOLE", x + 16, y + 20, 10.5, C.muted, { weight: 700 });
  let tx = x + 16 + tw("CONSOLE", 10.5, 700) + 22;
  for (const [id, label] of [["serial", "Serial (COM1)"], ["vga", "VGA Screen"]]) {
    const wlab = tw(label, 12.5) + 26;
    const active = consoleView === id;
    if (active) { rr(tx, y + 8, wlab, 24, 6); ctx.fillStyle = C.accent + "18"; ctx.fill(); }
    text(label, tx + 13, y + 20.5, 12.5, active ? C.accent : C.muted, { weight: active ? 600 : 400 });
    if (active) { ctx.strokeStyle = C.accent; ctx.beginPath(); ctx.moveTo(tx + 6, y + 32.5); ctx.lineTo(tx + wlab - 6, y + 32.5); ctx.stroke(); }
    if (powered) hotspots.push({ x: tx, y: y + 8, w: wlab, h: 24, cb: () => setView(id) });
    tx += wlab + 8;
  }
  const cbX = x + w - 170, cbY = y + 12;
  const hovCb = mouse.x >= cbX && mouse.x <= cbX + 160 && mouse.y >= cbY && mouse.y <= cbY + 22;
  if (hovCb && powered) hotspots.push({ x: cbX, y: cbY, w: 160, h: 22, cb: () => { interactive = !interactive; } });
  rr(cbX, cbY + 3, 15, 15, 4);
  ctx.fillStyle = interactive ? C.accent2 : "transparent"; ctx.fill();
  ctx.strokeStyle = interactive ? C.accent2 : C.borderHi; ctx.lineWidth = 1.4; ctx.stroke();
  if (interactive) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cbX + 4, cbY + 10.5); ctx.lineTo(cbX + 7, cbY + 14); ctx.lineTo(cbX + 12, cbY + 6.5); ctx.stroke();
  }
  text("Interactive", cbX + 22, cbY + 10.5, 12.5, C.muted);

  const tX = x + 12, tY = y + 40, tW = w - 24, tH = h - 40 - 30;
  rr(tX, tY, tW, tH, 8); ctx.fillStyle = C.termBg; ctx.fill();
  ctx.strokeStyle = interactive && consoleView === "serial" ? "#2b6cb0" : C.termBorder; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.save();
  rr(tX, tY, tW, tH, 8); ctx.clip();

  if (!powered) {
    const msg = vm.state === "suspended" ? "This VM is suspended — press Resume to continue where you left off."
      : vm.state === "crashed" ? "This VM crashed — power it on again."
      : "This VM is powered off — press Power On to boot it.";
    text(msg, tX + 16, tY + tH / 2, 12.5, C.dim);
  } else if (consoleView === "serial") {
    drawSerial(tX, tY, tW, tH);
  } else {
    drawVGA(tX, tY, tW, tH);
  }
  ctx.restore();

  const hint = !powered ? "" :
    interactive ? "Interactive: keys go to the guest — press Esc or untick to release." :
    "Tick Interactive and click the console to type into the guest.";
  text(hint, x + 16, y + h - 15, 11.5, C.muted);
  const up = currentUptime(vm);
  if (powered && up != null) {
    const ups = `up ${fmtUptime(up)}`;
    text(ups, x + w - 16 - tw(ups, 11.5), y + h - 15, 11.5, C.muted);
  }
}

function drawSerial(tX, tY, tW, tH) {
  const fs = 12.5, lh = fs * 1.45;
  const buf = consoles.get(selectedId) || "";
  const all = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const maxChars = Math.max(20, Math.floor((tW - 24) / tw("M", fs, 400, true)));
  const lines = [];
  for (let l of all) {
    while (l.length > maxChars) { lines.push(l.slice(0, maxChars)); l = l.slice(maxChars); }
    lines.push(l);
  }
  const maxLines = Math.floor((tH - 20) / lh);
  const maxScroll = Math.max(0, lines.length - maxLines);
  scroll = clamp(scroll, 0, maxScroll);
  const startIdx = Math.max(0, lines.length - maxLines - scroll);

  ctx.font = font(fs, 400, true);
  ctx.fillStyle = C.termText;
  ctx.textBaseline = "top";
  for (let i = 0; i < maxLines; i++) {
    const line = lines[startIdx + i];
    if (line === undefined) break;
    ctx.fillText(line, tX + 12, tY + 10 + i * lh);
  }
  if (interactive && (Date.now() % 1000) < 550 && scroll === 0) {
    const last = lines[lines.length - 1] || "";
    const cxp = tX + 12 + tw(last.slice(-maxChars), fs, 400, true);
    const cyp = tY + 10 + (Math.min(maxLines, lines.length) - 1) * lh;
    if (cyp <= tY + tH - lh) { ctx.fillStyle = C.termText; ctx.fillRect(cxp + 1, cyp, 7, fs + 2); }
  }
  if (maxScroll > 0) {
    const sbH = Math.max(30, tH * (maxLines / lines.length));
    const sbY = tY + (tH - sbH) * (1 - scroll / maxScroll);
    rr(tX + tW - 7, sbY, 4, sbH, 2); ctx.fillStyle = "#3a3d43"; ctx.fill();
  }
}

function drawVGA(tX, tY, tW, tH) {
  const rows = vgaRows;
  if (!rows || !rows.length) {
    text("waiting for VGA frame…", tX + 16, tY + tH / 2, 12.5, C.dim);
    return;
  }
  const cols = 80, nRows = rows.length;
  let fs = Math.min((tW - 20) / (cols * 0.6), (tH - 16) / (nRows * 1.15));
  fs = clamp(fs, 5, 15);
  const cw = fs * 0.6, lh = fs * 1.15;
  const ox = tX + (tW - cols * cw) / 2, oy = tY + (tH - nRows * lh) / 2;
  rr(ox - 6, oy - 6, cols * cw + 12, nRows * lh + 12, 6);
  ctx.fillStyle = "#0b0f0c"; ctx.fill();
  ctx.strokeStyle = "#1d2b20"; ctx.stroke();
  ctx.font = font(fs, 400, true);
  ctx.fillStyle = C.phosphor;
  ctx.textBaseline = "top";
  for (let r = 0; r < nRows; r++) {
    const line = (rows[r] || "").replace(/\s+$/, "");
    if (line) ctx.fillText(line, ox, oy + r * lh);
  }
  ctx.fillStyle = "rgba(0,0,0,0.16)";
  for (let sy = oy; sy < oy + nRows * lh; sy += 3) ctx.fillRect(ox - 6, sy, cols * cw + 12, 1);
  const lastRow = rows.map(r => (r || "").replace(/\s+$/, ""));
  for (let r = lastRow.length - 1; r >= 0; r--) {
    if (lastRow[r] && (lastRow[r].endsWith(">") || lastRow[r].endsWith("▌"))) {
      if ((Date.now() % 1000) < 550) { ctx.fillStyle = C.phosphor; ctx.fillRect(ox + lastRow[r].length * cw, oy + r * lh, cw, lh); }
      break;
    }
  }
}

/* ---------------- modals ---------------- */
function modalFrame(w, h, title) {
  ctx.fillStyle = "#000000a8"; ctx.fillRect(0, 0, L.w, L.h);
  const x = (L.w - w) / 2, y = (L.h - h) / 2;
  rr(x, y, w, h, 12); ctx.fillStyle = C.panel; ctx.fill();
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
  text(title, x + 18, y + 24, 15, C.text, { weight: 700 });
  const close = { x: x + w - 34, y: y + 12, w: 24, h: 24, cb: () => { modal = null; } };
  const hov = mouse.x >= close.x && mouse.x <= close.x + 24 && mouse.y >= close.y && mouse.y <= close.y + 24;
  if (hov) { rr(close.x, close.y, 24, 24, 6); ctx.fillStyle = "#ffffff10"; ctx.fill(); }
  text("✕", close.x + 12, close.y + 13, 13, C.muted);
  hotspots.push(close);
  return { x, y, w, h };
}

function drawField(fx, fy, fw, value, focused, opts = {}) {
  rr(fx, fy, fw, 32, 8);
  ctx.fillStyle = C.bg2; ctx.fill();
  ctx.strokeStyle = focused ? C.accent2 : C.border; ctx.lineWidth = focused ? 1.6 : 1; ctx.stroke();
  text(value || opts.ph || "", fx + 10, fy + 16, 13, value ? C.text : C.dim, { max: fw - 20 });
  if (focused && (Date.now() % 1000) < 550) {
    const cw2 = tw(value, 13);
    ctx.fillStyle = C.accent; ctx.fillRect(fx + 10 + Math.min(cw2, fw - 22) + 1, fy + 8, 1.5, 17);
  }
}

function drawNewVM() {
  const { x, y, w, h } = modalFrame(470, 356, "New Virtual Machine");
  let fy = y + 52;
  form.fields.forEach((f, i) => {
    const focused = form.focus === i;
    text(form.labels[f], x + 18, fy + 8, 11.5, focused ? C.accent : C.muted, { weight: 600 });
    const fw = w - 36;
    if (f === "media") {
      rr(x + 18, fy + 18, fw, 32, 8); ctx.fillStyle = C.bg2; ctx.fill();
      ctx.strokeStyle = focused ? C.accent2 : C.border; ctx.stroke();
      text(MEDIA_OPTS[form.values.media], x + 28, fy + 34, 13, C.text);
      hotspots.push({ x: x + 18, y: fy + 18, w: fw, h: 32, cb: () => { form.values.media = (form.values.media + 1) % MEDIA_OPTS.length; } });
    } else {
      drawField(x + 18, fy + 18, fw, form.values[f], focused, { ph: f === "cdrom" ? "optional — e.g. /path/image.iso" : "" });
      hotspots.push({ x: x + 18, y: fy + 18, w: fw, h: 32, cb: () => { form.focus = i; } });
    }
    fy += 56;
  });
  const bw = 110, bh = 34, by = y + h - 48;
  button(x + w - 18 - bw * 2 - 10, by, bw, bh, { label: "Cancel", onClick: () => { modal = null; } });
  button(x + w - 18 - bw, by, bw, bh, { label: "Create VM", color: "#fff", bg: C.accent2, border: C.accent2, onClick: createFromForm });
}

async function createFromForm() {
  const name = form.values.name.trim();
  if (!name) { toast("Please give the VM a name", "warn"); form.focus = 0; return; }
  try {
    const r = await rpc("vm:create", {
      name,
      memMB: parseInt(form.values.mem, 10) || 64,
      diskMB: parseInt(form.values.disk, 10) || 0,
      floppy: form.values.media === 0 ? "omnios" : "none",
      cdrom: form.values.cdrom.trim() || null,
    }, 120000);
    modal = null;
    toast(`VM "${r.name || name}" created`, "ok");
    selectVM(r.id);
  } catch (e) { toast(e.message, "err"); }
}

function drawSnaps() {
  const vm = selectedVM();
  const { x, y, w, h } = modalFrame(520, 420, `Snapshots — ${vm ? vm.name : ""}`);
  drawField(x + 18, y + 50, w - 36 - 140, snapName, snapFieldFocus, { ph: "snapshot name" });
  hotspots.push({ x: x + 18, y: y + 50, w: w - 36 - 140, h: 32, cb: () => { snapFieldFocus = true; } });
  button(x + w - 18 - 130, y + 50, 130, 32, { label: "Take Snapshot", color: "#fff", bg: C.accent2, border: C.accent2, onClick: takeSnap });
  let ly = y + 100;
  const lh = 44;
  snaps.forEach((s, i) => {
    const sel = i === snapSel;
    rr(x + 18, ly, w - 36, lh - 8, 8);
    ctx.fillStyle = sel ? "#2196f318" : C.bg2; ctx.fill();
    ctx.strokeStyle = sel ? C.accent2 : C.border; ctx.lineWidth = 1; ctx.stroke();
    text("◫", x + 32, ly + 17, 14, C.accent);
    text(s.name, x + 54, ly + 15, 13, C.text, { weight: 600, max: 200 });
    text(new Date(s.mtime).toLocaleString(), x + 54, ly + 30, 10.5, C.muted);
    hotspots.push({ x: x + 18, y: ly, w: w - 36, h: lh - 8, cb: () => { snapSel = i; } });
    ly += lh;
  });
  if (!snaps.length) text("No snapshots yet.", x + w / 2 - 50, ly + 20, 12.5, C.muted);
  const by = y + h - 48, bw = 130, bh = 34;
  button(x + 18, by, 90, bh, { label: "Close", onClick: () => { modal = null; } });
  button(x + w - 18 - bw * 2 - 10, by, bw, bh, { label: "Revert", disabled: snapSel < 0, onClick: revertSnap });
  button(x + w - 18 - bw, by, bw, bh, { label: "Delete", disabled: snapSel < 0, color: "#ff8a80", border: "#64272c", bg: "#3a2226", onClick: deleteSnap });
}
async function takeSnap() {
  const vm = selectedVM(); if (!vm) return;
  const name = snapName.trim() || `snap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  toast(`Taking snapshot "${name}"…`);
  try {
    await rpc("snap:take", { id: vm.id, name }, 180000);
    snapName = ""; toast(`Snapshot "${name}" saved`, "ok");
    snaps = await rpc("snap:list", { id: vm.id }, 30000);
  } catch (e) { toast(e.message, "err"); }
}
async function revertSnap() {
  if (snapSel < 0) return;
  const vm = selectedVM(), s = snaps[snapSel];
  try { await rpc("snap:revert", { id: vm.id, name: s.name }, 180000); toast(`Reverted to "${s.name}"`, "ok"); modal = null; }
  catch (e) { toast(e.message, "err"); }
}
async function deleteSnap() {
  if (snapSel < 0) return;
  const vm = selectedVM(), s = snaps[snapSel];
  try {
    await rpc("snap:delete", { id: vm.id, name: s.name }, 60000);
    snapSel = -1; toast(`Snapshot "${s.name}" deleted`, "ok");
    snaps = await rpc("snap:list", { id: vm.id }, 30000);
  } catch (e) { toast(e.message, "err"); }
}

function drawConfirm() {
  const { x, y, w, h } = modalFrame(430, 170, confirmState.title);
  let line = "", ly = y + 58;
  for (const wd of confirmState.body.split(" ")) {
    if (tw(line + wd, 13) > w - 60) { text(line, x + 22, ly, 13, C.text); line = ""; ly += 20; }
    line += wd + " ";
  }
  text(line, x + 22, ly, 13, C.text);
  const bw = 110, bh = 34, by = y + h - 48;
  button(x + w - 18 - bw * 2 - 10, by, bw, bh, { label: "Cancel", onClick: () => { modal = null; } });
  button(x + w - 18 - bw, by, bw, bh, { label: "Confirm", color: "#ff8a80", border: "#64272c", bg: "#3a2226", onClick: () => { modal = null; if (confirmFn) confirmFn(); } });
}

function drawToasts() {
  toasts = toasts.filter(t => t.until > Date.now());
  let y = L.h - 20;
  for (let i = toasts.length - 1; i >= 0; i--) {
    const t = toasts[i];
    const w = tw(t.text, 12.5) + 34;
    const x = L.w - w - 16;
    y -= 42;
    const accent = t.kind === "err" ? C.red : t.kind === "ok" ? C.green : t.kind === "warn" ? C.amber : C.accent2;
    rr(x, y, w, 34, 8);
    ctx.fillStyle = C.panel2; ctx.fill();
    ctx.strokeStyle = C.border; ctx.stroke();
    ctx.fillStyle = accent; rr(x, y, 3, 34, 2); ctx.fill();
    text(t.text, x + 16, y + 17, 12.5, C.text, { max: 360 });
  }
}

/* ---------------- input ---------------- */
canvas.addEventListener("mousemove", e => { mouse.x = e.offsetX; mouse.y = e.offsetY; });
canvas.addEventListener("mouseleave", () => { mouse.x = mouse.y = -1; });
canvas.addEventListener("mousedown", () => {
  const hit = [...hotspots].reverse().find(h => mouse.x >= h.x && mouse.x <= h.x + h.w && mouse.y >= h.y && mouse.y <= h.y + h.h);
  if (hit) hit.cb();
  if (snapFieldFocus) snapFieldFocus = false;
});
canvas.addEventListener("wheel", e => {
  if (modal || consoleView !== "serial") return;
  const vm = selectedVM();
  if (!vm || (vm.state !== "running" && vm.state !== "paused")) return;
  scroll += e.deltaY > 0 ? -3 : 3;
  e.preventDefault();
}, { passive: false });

window.addEventListener("keydown", e => {
  if (e.ctrlKey && e.key.toLowerCase() === "v" && !e.altKey && !e.metaKey) {
    // let the browser paste work nowhere — we own every paste target
    e.preventDefault();
    pasteSomewhere();
    return;
  }
  if (modal === "newvm") {
    const f = form.fields[form.focus];
    if (e.key === "Escape") { modal = null; return; }
    if (e.key === "Enter") { createFromForm(); return; }
    if (e.key === "Tab") { form.focus = (form.focus + 1) % form.fields.length; e.preventDefault(); return; }
    if (f === "media") return;
    if (e.key === "Backspace") { form.values[f] = form.values[f].slice(0, -1); e.preventDefault(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { form.values[f] += e.key; e.preventDefault(); }
    return;
  }
  if (modal === "snaps") {
    if (e.key === "Escape") { modal = null; return; }
    if (snapFieldFocus) {
      if (e.key === "Backspace") { snapName = snapName.slice(0, -1); e.preventDefault(); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { snapName += e.key; e.preventDefault(); }
    }
    return;
  }
  if (modal === "confirm") {
    if (e.key === "Escape") modal = null;
    if (e.key === "Enter") { modal = null; if (confirmFn) confirmFn(); }
    return;
  }
  const vm = selectedVM();
  if (interactive && vm && (vm.state === "running" || vm.state === "paused")) {
    let s = null;
    if (e.key === "Enter") s = "\r";
    else if (e.key === "Backspace") s = "\x7f";
    else if (e.ctrlKey && e.key.toLowerCase() === "c") s = "\x03";
    else if (e.ctrlKey && e.key.toLowerCase() === "u") s = "\x15";
    else if (e.ctrlKey || e.altKey || e.metaKey) return;
    else if (e.key === "Escape") { interactive = false; return; }
    else if (e.key.length === 1) s = e.key;
    if (s !== null) {
      bridge.invoke("console:input", { id: vm.id, data: btoa(unescape(encodeURIComponent(s))) });
      e.preventDefault();
    }
    return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key.toLowerCase() === "n") { modal = "newvm"; form.focus = 0; }
  }
});

/* ---------------- boot & main loop ---------------- */
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
canvas.style.display = "block";
(function cursorLoop() {
  const overHot = hotspots.some(h => mouse.x >= h.x && mouse.x <= h.x + h.w && mouse.y >= h.y && mouse.y <= h.y + h.h);
  canvas.style.cursor = overHot ? "pointer" : "default";
  requestAnimationFrame(cursorLoop);
})();
window.__omnivmReady = true;
bridge.ready();
/* belt & braces: actively fetch the library at boot, in addition to the
 * main-process pushes (registerSink + periodic broadcasts) */
rpc("vms:list", {}, 15000).then(l => { if (Array.isArray(l)) vms = l; }).catch(() => {});
(function frame() { draw(); requestAnimationFrame(frame); })();
