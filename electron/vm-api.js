/* OmniVM Workstation — desktop app data layer.
 *
 * Plain Node (no electron imports) so it can be smoke-tested headlessly.
 * The Electron main process wires this to IPC; every connected window gets
 * state broadcasts and a private console tap. */
import * as store from "../lib/store.js";
import * as mgr from "../lib/manager.js";

/* one runner attachment per VM that at least one window watches */
const taps = new Map(); // vmId -> {client, ring, subs:Set<sink>, statusTimer, uptimeMs}

let stateTimer = null;
let lastVmsJson = "";

export function start() {
  store.ensureDirs();
  stop();
  stateTimer = setInterval(broadcastVms, 2000);
}

export function stop() {
  if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
  for (const [id, tap] of taps) {
    if (tap.statusTimer) clearInterval(tap.statusTimer);
    try { tap.client.close(); } catch {}
  }
  taps.clear();
}

/* ---------------- VM list ---------------- */
export function list() {
  const list = mgr.statesOf(store.listVMs()).map(v => {
    const tap = taps.get(v.id);
    return tap && tap.uptimeMs != null ? { ...v, uptimeMs: tap.uptimeMs } : v;
  });
  return list;
}

function broadcastVms(sink = null) {
  const vms = list();
  const json = JSON.stringify(vms);
  const changed = json !== lastVmsJson;
  lastVmsJson = json;
  if (sink) sink("vms", vms);
  else if (changed) for (const t of taps.values()) for (const s of t.subs) s("vms", vms);
}

/* ---------------- lifecycle actions ---------------- */
export function createVM(opts) {
  const vm = store.createVM(opts || {});
  broadcastVmsSoon();
  return { id: vm.id, name: vm.name };
}

export function deleteVM(id) {
  const vm = store.findVM(id);
  if (!vm) throw new Error(`no such VM`);
  if (mgr.isRunning(mgr.refresh(vm))) throw new Error("power the VM off before deleting it");
  store.deleteVM(vm.id);
  broadcastVmsSoon();
  return true;
}

export function cloneVM(id) {
  const vm = store.findVM(id);
  if (!vm) throw new Error(`no such VM`);
  if (mgr.isRunning(mgr.refresh(vm))) throw new Error("power the VM off before cloning it");
  const c = store.cloneVM(vm);
  broadcastVmsSoon();
  return { id: c.id, name: c.name };
}

const ACTIONS = {
  start: mgr.startVM, stop: mgr.powerOffVM, kill: mgr.killVM,
  suspend: mgr.suspendVM, resume: mgr.resumeVM, reset: mgr.resetVM,
  pause: v => mgr.pauseVM(v, true), unpause: v => mgr.pauseVM(v, false),
};

export async function vmAction(id, action) {
  const vm = store.findVM(id);
  if (!vm) throw new Error(`no such VM`);
  const fn = ACTIONS[action];
  if (!fn) throw new Error(`unknown action ${action}`);
  await fn(vm);
  broadcastVmsSoon();
  return true;
}

/* ---------------- console taps ---------------- */
function tapFor(vmId) {
  let tap = taps.get(vmId);
  if (!tap) {
    const vm = store.findVM(vmId);
    if (!vm) throw new Error(`no such VM`);
    const client = mgr.attach(vm);
    tap = { client, ring: "", subs: new Set(), statusTimer: null, uptimeMs: null };
    taps.set(vmId, tap);
    client.on("event", m => {
      if (m.evt === "serial") {
        tap.ring += Buffer.from(m.data, "base64").toString("latin1");
        if (tap.ring.length > 128 * 1024) tap.ring = tap.ring.slice(-96 * 1024);
        for (const s of tap.subs) s("console", { vmId, data: m.data });
      } else if (m.evt === "state") {
        broadcastVmsSoon();
      }
    });
    client.on("close", () => { taps.delete(vmId); broadcastVmsSoon(); });
    tap.statusTimer = setInterval(async () => {
      if (!tap.client?.ready) return;
      try {
        const st = await tap.client.request({ cmd: "status" }, 8000);
        if (st.ok) { tap.uptimeMs = st.uptimeMs; }
      } catch { /* VM may be stopping */ }
    }, 2000);
  }
  return tap;
}

function maybeReleaseTap(vmId) {
  const tap = taps.get(vmId);
  if (tap && tap.subs.size === 0) {
    if (tap.statusTimer) clearInterval(tap.statusTimer);
    try { tap.client.close(); } catch {}
    taps.delete(vmId);
  }
}

/* attach a subscriber: sink(evt, payload); returns replayed backlog */
export function attach(vmId, sink) {
  const tap = tapFor(vmId);
  tap.subs.add(sink);
  broadcastVms(sink);
  const backlog = tap.ring ? Buffer.from(tap.ring, "latin1").toString("base64") : null;
  if (backlog) sink("console", { vmId, data: backlog });
  return true;
}

export function detach(vmId, sink) {
  const tap = taps.get(vmId);
  if (tap) {
    tap.subs.delete(sink);
    maybeReleaseTap(vmId);
  }
  return true;
}

export function detachAllFor(sink) {
  for (const [id, tap] of taps) {
    if (tap.subs.delete(sink)) maybeReleaseTap(id);
  }
}

export function serialIn(vmId, dataB64) {
  const tap = taps.get(vmId);
  if (!tap) throw new Error("not attached to that VM");
  tap.client.serialIn(Buffer.from(dataB64 || "", "base64").toString("latin1"));
  return true;
}

export async function screen(vmId) {
  const tap = taps.get(vmId);
  if (!tap) throw new Error("not attached to that VM");
  const res = await tap.client.request({ cmd: "screen" }, 15000);
  return res.rows || [];
}

/* ---------------- snapshots ---------------- */
export async function snapshots(vmId) {
  const vm = store.findVM(vmId);
  if (!vm) throw new Error(`no such VM`);
  return mgr.snapshot.list(vm);
}

export async function snapshotTake(vmId, name) {
  const vm = store.findVM(vmId);
  if (!vm) throw new Error(`no such VM`);
  await mgr.snapshot.take(vm, name);
  return true;
}

export async function snapshotRevert(vmId, name) {
  const vm = store.findVM(vmId);
  if (!vm) throw new Error(`no such VM`);
  await mgr.snapshot.restore(vm, name);
  return true;
}

export async function snapshotDelete(vmId, name) {
  const vm = store.findVM(vmId);
  if (!vm) throw new Error(`no such VM`);
  await mgr.snapshot.delete(vm, name);
  return true;
}

function broadcastVmsSoon() { setImmediate(() => broadcastVms()); }
