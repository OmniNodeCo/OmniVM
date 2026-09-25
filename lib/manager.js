/* Manager: host-side VM lifecycle. Spawns runner processes, talks to their
 * control sockets, reconciles state. */
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { APP_ROOT } from "./store.js";
import {
  loadVM, saveVM, listVMs, controlSock, runDir, suspendFile, snapshotsDir,
} from "./store.js";
import { wire, send } from "./protocol.js";

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readRunInfo(vm) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir(vm.id), "run.json"), "utf8")); }
  catch { return null; }
}

export function isRunning(vm) {
  const info = readRunInfo(vm);
  return !!(info && pidAlive(info.pid) && vm.state !== "off" && vm.state !== "suspended");
}

export function statesOf(vms) {
  return vms.map(vm => {
    const running = isRunning(vm);
    let state = vm.state;
    if (running && (state === "off" || state === "suspended")) state = "running";
    if (!running && state === "running") state = "off"; // runner died
    if (running && state === "off") state = "running";
    return { ...vm, state };
  });
}

export function refresh(vm) {
  const v = loadVM(vm.id);
  const st = statesOf([v])[0];
  return st;
}

function persist(vm) { const cur = loadVM(vm.id); cur.state = vm.state; saveVM(cur); }

/* raw request/response over the control socket */
export function ctlRequest(vm, msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const tag = msg.tag || "t" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const sock = net.connect(controlSock(vm.id));
    let done = false;
    const to = setTimeout(() => finish(new Error(`control socket timeout (cmd: ${msg.cmd})`)), timeoutMs);
    const finish = (err, res) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      sock.destroy();
      err ? reject(err) : resolve(res);
    };
    sock.on("connect", () => {
      wire(sock, m => {
        if (m.tag !== tag) return;
        if (m.ok === false) finish(new Error(m.error || "command failed"));
        else finish(null, m);
      });
      send(sock, { ...msg, tag });
    });
    sock.on("error", e => finish(new Error(`cannot reach VM "${vm.name}" (${e.message}) — is it powered on?`)));
  });
}

export async function startVM(vm) {
  const cur = refresh(vm);
  if (isRunning(cur)) throw new Error(`"${cur.name}" is already powered on`);
  fs.mkdirSync(runDir(cur.id), { recursive: true });
  fs.rmSync(controlSock(cur.id), { force: true });

  const child = spawn(process.execPath, [path.join(APP_ROOT, "bin", "omnivm.js"), "run", "--id", cur.id], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // wait for the control socket to answer
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const res = await ctlRequest(cur, { cmd: "ping" }, 1500);
      if (res.ok) { cur.state = "running"; persist(cur); return cur; }
    } catch { /* not up yet */ }
  }
  const errFile = path.join(runDir(cur.id), "error.log");
  const detail = fs.existsSync(errFile) ? ":\n" + fs.readFileSync(errFile, "utf8").slice(-400) : " (no error log)";
  cur.state = "crashed"; persist(cur);
  throw new Error(`VM failed to boot${detail}`);
}

export async function powerOffVM(vm) {
  const cur = refresh(vm);
  if (!isRunning(cur)) { cur.state = "off"; persist(cur); return cur; }
  await ctlRequest(cur, { cmd: "poweroff" }, 20000);
  await new Promise(r => setTimeout(r, 300));
  cur.state = "off"; persist(cur);
  return cur;
}

export async function killVM(vm) {
  const cur = refresh(vm);
  if (!isRunning(cur)) { cur.state = "off"; persist(cur); return cur; }
  try { await ctlRequest(cur, { cmd: "kill" }, 5000); } catch {}
  cur.state = "off"; persist(cur);
  return cur;
}

export async function suspendVM(vm) {
  const cur = refresh(vm);
  if (!isRunning(cur)) throw new Error(`"${cur.name}" is not powered on`);
  await ctlRequest(cur, { cmd: "suspend" }, 30000);
  await new Promise(r => setTimeout(r, 400));
  cur.state = "suspended"; persist(cur);
  return cur;
}

export const resumeVM = startVM; // runner picks up suspend.v86s

export async function resetVM(vm) {
  const cur = refresh(vm);
  if (!isRunning(cur)) throw new Error(`"${cur.name}" is not powered on`);
  await ctlRequest(cur, { cmd: "reset" }, 30000);
  return cur;
}

export async function pauseVM(vm, paused) {
  const cur = refresh(vm);
  if (!isRunning(cur)) throw new Error(`"${cur.name}" is not powered on`);
  await ctlRequest(cur, { cmd: paused ? "pause" : "unpause" }, 10000);
  return cur;
}

export const snapshot = {
  async list(vm) {
    const cur = refresh(vm);
    if (!isRunning(cur)) {
      const dir = snapshotsDir(cur.id);
      return fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => f.endsWith(".v86s")).map(f => ({
            name: f.slice(0, -5), size: fs.statSync(dir + "/" + f).size,
            mtime: fs.statSync(dir + "/" + f).mtime.toISOString(),
          }))
        : [];
    }
    const res = await ctlRequest(cur, { cmd: "snapshot-list" });
    return res.snapshots || [];
  },
  async take(vm, name) {
    const cur = refresh(vm);
    if (!isRunning(cur)) throw new Error(`"${cur.name}" must be powered on to snapshot (live snapshot)`);
    const res = await ctlRequest(cur, { cmd: "snapshot-save", name }, 60000);
    return res;
  },
  async restore(vm, name) {
    const cur = refresh(vm);
    if (!isRunning(cur)) throw new Error(`"${cur.name}" must be powered on to revert`);
    return ctlRequest(cur, { cmd: "snapshot-restore", name }, 60000);
  },
  async delete(vm, name) {
    const cur = refresh(vm);
    if (isRunning(cur)) return ctlRequest(cur, { cmd: "snapshot-delete", name });
    const f = snapshotsDir(cur.id) + `/${name}.v86s`;
    fs.rmSync(f, { force: true });
  },
};

/* Live client for consoles: subscribes to serial/screen events. */
export function attach(vm) {
  const sock = net.connect(controlSock(vm.id));
  const listeners = { event: [], close: [] };
  let ready = false;
  sock.on("connect", () => { ready = true; });
  wire(sock,
    m => { for (const fn of listeners.event) fn(m); },
    () => { for (const fn of listeners.close) fn(); });
  sock.on("error", () => {});
  return {
    socket: sock,
    get ready() { return ready; },
    send(msg) { send(sock, msg); },
    serialIn(text) { send(sock, { cmd: "serial-in", data: Buffer.from(text, "latin1").toString("base64") }); },
    request(msg, timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        const tag = "c" + Math.random().toString(36).slice(2);
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; reject(new Error(`request timeout (${msg.cmd})`)); } }, timeoutMs);
        const off = () => { const i = listeners.event.indexOf(fn); if (i >= 0) listeners.event.splice(i, 1); };
        const fn = m => {
          if (m.tag === tag && !done) {
            done = true;
            clearTimeout(to);
            off();
            if (m.ok === false) reject(new Error(m.error || "command failed"));
            else resolve(m);
          }
        };
        listeners.event.push(fn);
        send(sock, { ...msg, tag });
      });
    },
    on(event, fn) { listeners[event].push(fn); },
    close() { sock.destroy(); },
  };
}

export function suspendedToday(vm) {
  return vm.state === "suspended" || fs.existsSync(suspendFile(vm.id));
}
