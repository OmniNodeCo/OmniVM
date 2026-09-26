/* OmniVM Workstation — GUI server.
 *
 * Serves the canvas-drawn Workstation GUI (one static host page + the GUI
 * engine) and a WebSocket API. VMs are driven through the same manager every
 * other client uses:
 *
 *   omnivm web [--port 8080]     start the GUI server
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import * as store from "../store.js";
import * as mgr from "../manager.js";
import { assetBuffer } from "../assets.js";

const CONTENT = {
  "index.html": { file: "lib/web/static/index.html", type: "text/html; charset=utf-8" },
  "app.js": { file: "lib/web/static/app.js", type: "text/javascript; charset=utf-8" },
};

async function serveStatic(res, name) {
  const entry = CONTENT[name];
  if (!entry) { res.writeHead(404); res.end("not found"); return; }
  let body;
  try {
    body = await assetBuffer(name);          // embedded in the SEA executable
  } catch {
    body = fs.readFileSync(path.join(store.APP_ROOT, entry.file)); // from source
  }
  res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
  res.end(body);
}

/* ---------------- per-VM console taps ----------------
 * One runner-attachment per VM that at least one browser is watching; serial
 * output fans out to every subscriber, and a ring buffer lets late
 * subscribers catch up. */
const taps = new Map(); // vmId -> {client, ring, subs:Set<ws>, statusTimer, uptimeMs}

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
        const frame = JSON.stringify({ type: "console", id: vmId, data: m.data });
        for (const ws of tap.subs) if (ws.readyState === 1) ws.send(frame);
      } else if (m.evt === "state") {
        broadcastVmsSoon();
      }
    });
    client.on("close", () => { taps.delete(vmId); broadcastVmsSoon(); });
    tap.statusTimer = setInterval(async () => {
      if (!tap.client?.ready) return;
      try {
        const st = await tap.client.request({ cmd: "status" }, 8000);
        if (st.ok) { tap.uptimeMs = st.uptimeMs; broadcastVmsSoon(); }
      } catch { /* VM may be stopping */ }
    }, 2000);
  }
  return tap;
}

function maybeReleaseTap(vmId) {
  const tap = taps.get(vmId);
  if (tap && tap.subs.size === 0) {
    clearInterval(tap.statusTimer);
    try { tap.client.close(); } catch {}
    taps.delete(vmId);
  }
}

/* ---------------- VM list broadcasting ---------------- */
let wssRef = null;
let vmsTimer = null, lastJson = "";
function broadcastVms(ws) {
  const list = mgr.statesOf(store.listVMs()).map(v => {
    const tap = taps.get(v.id);
    return tap && tap.uptimeMs != null ? { ...v, uptimeMs: tap.uptimeMs } : v;
  });
  const json = JSON.stringify(list);
  const changed = json !== lastJson;
  lastJson = json;
  const frame = JSON.stringify({ type: "vms", vms: list });
  if (ws) { if (ws.readyState === 1) ws.send(frame); }
  else if (changed && wssRef) for (const c of wssRef.clients) if (c.readyState === 1) c.send(frame);
}
function broadcastVmsSoon() {
  clearTimeout(vmsTimer);
  vmsTimer = setTimeout(() => broadcastVms(), 120);
}

/* ---------------- websocket API ---------------- */
function handleApi(ws, msg) {
  const reply = (ok, extra = {}) => ws.readyState === 1 && ws.send(JSON.stringify({ req: msg.req, ok, ...extra }));
  const fail = e => reply(false, { error: e.message });

  switch (msg.type) {
    case "list":
      broadcastVms(ws);
      reply(true);
      break;
    case "create":
      store.createVM({
        name: msg.name, memMB: msg.memMB, diskMB: msg.diskMB,
        floppy: msg.floppy, cdrom: msg.cdrom,
      });
      broadcastVmsSoon();
      reply(true);
      break;
    case "delete": {
      const vm = store.findVM(msg.id);
      if (!vm) throw new Error(`no such VM`);
      if (mgr.isRunning(mgr.refresh(vm))) throw new Error("power the VM off before deleting it");
      store.deleteVM(vm.id);
      broadcastVmsSoon();
      reply(true);
      break;
    }
    case "start": case "stop": case "kill": case "suspend":
    case "resume": case "reset": case "pause": case "unpause": {
      const vm = store.findVM(msg.id);
      if (!vm) throw new Error(`no such VM`);
      const fn = {
        start: mgr.startVM, stop: mgr.powerOffVM, kill: mgr.killVM,
        suspend: mgr.suspendVM, resume: mgr.resumeVM, reset: mgr.resetVM,
        pause: v => mgr.pauseVM(v, true), unpause: v => mgr.pauseVM(v, false),
      }[msg.type];
      fn(vm).then(() => { broadcastVmsSoon(); reply(true); }).catch(fail);
      break;
    }
    case "clone": {
      const vm = store.findVM(msg.id);
      if (!vm) throw new Error(`no such VM`);
      if (mgr.isRunning(mgr.refresh(vm))) throw new Error("power the VM off before cloning it");
      const c = store.cloneVM(vm);
      broadcastVmsSoon();
      reply(true, { id: c.id, name: c.name });
      break;
    }
    case "attach": {
      const tap = tapFor(msg.id);
      tap.subs.add(ws);
      ws.vmId = msg.id;
      if (tap.ring) ws.send(JSON.stringify({ type: "console", id: msg.id, data: Buffer.from(tap.ring, "latin1").toString("base64") }));
      broadcastVmsSoon();
      reply(true);
      break;
    }
    case "detach": {
      const tap = taps.get(msg.id);
      if (tap) tap.subs.delete(ws);
      if (ws.vmId === msg.id) ws.vmId = null;
      maybeReleaseTap(msg.id);
      reply(true);
      break;
    }
    case "serial-in": {
      const tap = taps.get(msg.id);
      if (!tap) throw new Error("not attached to that VM");
      tap.client.serialIn(Buffer.from(msg.data || "", "base64").toString("latin1"));
      reply(true);
      break;
    }
    case "screen": {
      const tap = taps.get(msg.id);
      if (!tap) throw new Error("not attached to that VM");
      tap.client.request({ cmd: "screen" }, 15000)
        .then(r => ws.readyState === 1 && ws.send(JSON.stringify({ type: "screen", id: msg.id, rows: r.rows || [] })))
        .catch(e => ws.readyState === 1 && ws.send(JSON.stringify({ type: "error", message: e.message })));
      reply(true);
      break;
    }
    case "snapshots": {
      const vm = store.findVM(msg.id);
      if (!vm) throw new Error(`no such VM`);
      mgr.snapshot.list(vm).then(s => reply(true, { snapshots: s })).catch(fail);
      break;
    }
    case "snapshot-take": case "snapshot-revert": case "snapshot-delete": {
      const vm = store.findVM(msg.id);
      if (!vm) throw new Error(`no such VM`);
      const fn = {
        "snapshot-take": v => mgr.snapshot.take(v, msg.name),
        "snapshot-revert": v => mgr.snapshot.restore(v, msg.name),
        "snapshot-delete": v => mgr.snapshot.delete(v, msg.name),
      }[msg.type];
      fn(vm).then(() => { broadcastVmsSoon(); reply(true); }).catch(fail);
      break;
    }
    default:
      reply(false, { error: `unknown message type ${msg.type}` });
  }
}

/* ---------------- entry ---------------- */
export function startWebServer({ port = 8080, host = "0.0.0.0", openBrowser = false } = {}) {
  store.ensureDirs();
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const name = url === "/" ? "index.html" : url.slice(1);
    serveStatic(res, name).catch(() => { res.writeHead(500); res.end(); });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wssRef = wss;
  wss.on("connection", ws => {
    broadcastVms(ws);
    ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        handleApi(ws, msg);
      } catch (e) {
        if (msg.req) ws.send(JSON.stringify({ req: msg.req, ok: false, error: e.message }));
        else ws.send(JSON.stringify({ type: "error", message: e.message }));
      }
    });
    ws.on("close", () => {
      if (ws.vmId) {
        const tap = taps.get(ws.vmId);
        if (tap) { tap.subs.delete(ws); maybeReleaseTap(ws.vmId); }
      }
    });
  });

  return new Promise(resolve => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const urls = [];
      for (const ifs of Object.values(os.networkInterfaces())) {
        for (const i of ifs || []) if (i.family === "IPv4") urls.push(`http://${i.address}:${actualPort}`);
      }
      if (openBrowser) {
        const url = `http://localhost:${actualPort}`;
        const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
        try { spawn(cmd, process.platform === "win32" ? ["/c", "start", "", url] : [url], { detached: true, stdio: "ignore" }).unref(); } catch {}
      }
      resolve({ server, wss, port: actualPort, urls });
    });
  });
}
