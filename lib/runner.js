/* OmniVM runner: hosts one virtual machine (a v86 engine instance) in its
 * own process. Exposes a NDJSON control socket so the TUI / CLI / console
 * clients can attach, detach, snapshot, suspend, resume, power off — while
 * the VM keeps running independently. */
import fs from "node:fs";
import net from "node:net";
import { V86 } from "v86";
import { wire, send } from "./protocol.js";
import {
  loadVM, saveVM, runDir, controlSock, consoleLog, suspendFile,
  snapshotsDir, diskImage, BIOS, VGA_BIOS, BUNDLED_GUEST,
} from "./store.js";

const BOOT_ORDER = { floppy: 0x321, disk: 0x312, cdrom: 0x123 };
const CONSOLE_MAX_BYTES = 1 << 20; // rotate console.log at 1 MB

let vm, emulator, clients = new Set();
let startedAt = 0, cpuPaused = false, booting = true;
let screenDirty = false, serialTail = Buffer.alloc(0);
let shuttingDown = false;

const log = (...a) => {
  try { fs.appendFileSync(runDir(vm.id) + "/runner.log", `[${new Date().toISOString()}] ${a.join(" ")}\n`); } catch {}
};

function ab(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function setState(state) {
  vm.state = state;
  saveVM(vm);
  broadcast({ evt: "state", state });
}

function broadcast(msg) {
  for (const c of clients) send(c, msg);
}

function toBase64(buf) { return buf.toString("base64"); }

function onSerialByte(byte) {
  serialTail = Buffer.concat([serialTail, Buffer.from([byte])]).slice(-8192);
  try {
    const f = consoleLog(vm.id);
    if (fs.existsSync(f) && fs.statSync(f).size > CONSOLE_MAX_BYTES) {
      fs.renameSync(f, f + ".old");
    }
    fs.appendFileSync(f, Buffer.from([byte]));
  } catch {}
  broadcast({ evt: "serial", data: toBase64(Buffer.from([byte])) });
  screenDirty = true; // guests often echo to VGA too
}

function wrapScreenAdapter() {
  const a = emulator.screen_adapter;
  if (!a) return;
  const mark = () => { screenDirty = true; };
  for (const m of ["put_char", "update_cursor", "set_mode", "clear_screen"]) {
    if (typeof a[m] === "function") {
      const orig = a[m].bind(a);
      a[m] = (...args) => { mark(); orig(...args); };
    }
  }
  // the ANSI screen adapter lacks methods the VGA/restore paths expect
  for (const m of ["clear_text_state", "set_font_page", "set_font_bitmap",
                   "set_scale", "update_cursor_scanline", "update_buffer",
                   "pause", "continue", "destroy"]) {
    if (typeof a[m] !== "function") a[m] = () => {};
  }
}

function screenRows() {
  try {
    return emulator.screen_adapter.get_text_screen()
      .map(r => r.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, ""));
  } catch { return []; }
}

function findImageBuffer() {
  try {
    const cpu = emulator.v86.cpu;
    const fda = cpu.devices?.fdc?.drives?.[0]?.buffer;
    const hda = cpu.devices?.ide?.primary?.master?.buffer
             || cpu.devices?.ide?.primary?.buffer || null;
    return { fda, hda };
  } catch { return { fda: null, hda: null }; }
}

/* Persist guest disk writes back to the image files (best effort).
 * The bundled OmniOS floppy is read-only media (like a live CD). */
function persistDisks(cb = () => {}) {
  const { fda, hda } = findImageBuffer();
  let pending = 0, done = false;
  const finish = () => { if (!done && pending === 0) { done = true; cb(); } };
  if (hda && vm.diskMB > 0 && typeof hda.get_buffer === "function") {
    pending++;
    hda.get_buffer(buf => {
      try { fs.writeFileSync(diskImage(vm.id), Buffer.from(buf)); } catch (e) { log("hda persist:", e.message); }
      if (--pending === 0) finish();
    });
  }
  if (fda && vm.floppy && vm.floppy !== BUNDLED_GUEST && typeof fda.get_buffer === "function") {
    pending++;
    fda.get_buffer(buf => {
      try { fs.writeFileSync(vm.floppy, Buffer.from(buf)); } catch (e) { log("fda persist:", e.message); }
      if (--pending === 0) finish();
    });
  }
  if (pending === 0) setImmediate(finish);
}

async function bootInstance() {
  const opts = {
    bios: { buffer: ab(fs.readFileSync(BIOS)) },
    vga_bios: { buffer: ab(fs.readFileSync(VGA_BIOS)) },
    wasm_path: new URL("../node_modules/v86/build/v86.wasm", import.meta.url).pathname,
    memory_size: vm.memMB * 1024 * 1024,
    screen: { ansi: true },
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    autostart: true,
    fastboot: true,
    boot_order: BOOT_ORDER[vm.boot] || BOOT_ORDER.floppy,
  };
  if (vm.floppy && fs.existsSync(vm.floppy)) opts.fda = { buffer: ab(fs.readFileSync(vm.floppy)) };
  if (vm.cdrom && fs.existsSync(vm.cdrom)) opts.cdrom = { buffer: ab(fs.readFileSync(vm.cdrom)) };
  if (vm.diskMB > 0 && fs.existsSync(diskImage(vm.id))) opts.hda = { buffer: ab(fs.readFileSync(diskImage(vm.id))) };

  const resuming = vm.state === "suspended" && fs.existsSync(suspendFile(vm.id));
  if (resuming) {
    opts.initial_state = { buffer: ab(fs.readFileSync(suspendFile(vm.id))) };
    try { fs.rmSync(suspendFile(vm.id)); } catch {}
  }

  emulator = new V86(opts);
  emulator.add_listener("serial0-output-byte", onSerialByte);
  emulator.add_listener("emulator-loaded", () => { booting = false; });
  // screen_adapter is created asynchronously inside v86 init; wrap as soon as
  // it appears (before any VGA text is drawn or state restored)
  const wrapWait = setInterval(() => {
    if (emulator && emulator.screen_adapter) {
      clearInterval(wrapWait);
      wrapScreenAdapter();
    }
  }, 1);
  startedAt = Date.now();
  cpuPaused = false;
  setState("running");
  broadcast({ evt: "booted", resumed: resuming });
}

async function handleMessage(msg, sock) {
  const reply = (r) => send(sock, { ...r, tag: msg.tag });
  try {
    switch (msg.cmd) {
      case "ping":
        reply({ ok: true, pong: true });
        break;
      case "status":
        reply({
          ok: true,
          state: cpuPaused ? "paused" : vm.state,
          uptimeMs: startedAt ? Date.now() - startedAt : 0,
          name: vm.name, memMB: vm.memMB, cpus: vm.cpus,
          resumedFromSuspend: !startedAt ? false : undefined,
        });
        break;
      case "serial-in": {
        if (!emulator || cpuPaused) break;
        const data = Buffer.from(msg.data || "", "base64").toString("latin1");
        emulator.serial0_send(data);
        break;
      }
      case "screen":
        reply({ ok: true, rows: screenRows() });
        break;
      case "pause":
        if (emulator && !cpuPaused) { await emulator.stop(); cpuPaused = true; broadcast({ evt: "state", state: "paused" }); }
        reply({ ok: true });
        break;
      case "unpause":
        if (emulator && cpuPaused) { await emulator.run(); cpuPaused = false; broadcast({ evt: "state", state: "running" }); }
        reply({ ok: true });
        break;
      case "reset":
        reply({ ok: true });
        broadcast({ evt: "log", line: "resetting VM..." });
        try { if (emulator) await emulator.destroy(); } catch {}
        await bootInstance();
        break;
      case "snapshot-save": {
        if (!emulator) throw new Error("VM is not running");
        const name = String(msg.name || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "snapshot";
        fs.mkdirSync(snapshotsDir(vm.id), { recursive: true });
        const state = await emulator.save_state();
        fs.writeFileSync(snapshotsDir(vm.id) + `/${name}.v86s`, Buffer.from(state));
        persistDisks();
        broadcast({ evt: "snapshot-saved", name });
        reply({ ok: true, name });
        break;
      }
      case "snapshot-restore": {
        const f = snapshotsDir(vm.id) + `/${String(msg.name).replace(/[^A-Za-z0-9._-]/g, "_")}.v86s`;
        if (!emulator || !fs.existsSync(f)) throw new Error("snapshot not found (is the VM running?)");
        await emulator.restore_state(ab(fs.readFileSync(f)));
        broadcast({ evt: "snapshot-restored", name: msg.name });
        reply({ ok: true });
        break;
      }
      case "snapshot-delete": {
        const f = snapshotsDir(vm.id) + `/${String(msg.name).replace(/[^A-Za-z0-9._-]/g, "_")}.v86s`;
        fs.rmSync(f, { force: true });
        broadcast({ evt: "snapshot-deleted", name: msg.name });
        reply({ ok: true });
        break;
      }
      case "snapshot-list": {
        const dir = snapshotsDir(vm.id);
        const names = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter(f => f.endsWith(".v86s")).map(f => ({
              name: f.slice(0, -5),
              size: fs.statSync(dir + "/" + f).size,
              mtime: fs.statSync(dir + "/" + f).mtime.toISOString(),
            }))
          : [];
        reply({ ok: true, snapshots: names });
        break;
      }
      case "suspend": {
        if (!emulator) throw new Error("VM is not running");
        const state = await emulator.save_state();
        fs.mkdirSync(runDir(vm.id), { recursive: true });
        fs.writeFileSync(suspendFile(vm.id), Buffer.from(state));
        persistDisks(() => {
          setState("suspended");
          reply({ ok: true });
          setTimeout(() => process.exit(0), 150);
        });
        break;
      }
      case "poweroff":
        reply({ ok: true });
        await powerOff();
        break;
      case "kill":
        reply({ ok: true });
        setState("off");
        setTimeout(() => process.exit(0), 80);
        break;
      default:
        reply({ ok: false, error: `unknown command ${msg.cmd}` });
    }
  } catch (e) {
    log("cmd error:", e.stack || e.message);
    reply({ ok: false, error: e.message });
  }
}

async function powerOff() {
  if (shuttingDown) return;
  shuttingDown = true;
  persistDisks(() => {
    setState("off");
    setTimeout(() => process.exit(0), 100);
  });
}

async function main() {
  const id = process.argv[process.argv.indexOf("--id") + 1];
  vm = loadVM(id);
  fs.mkdirSync(runDir(vm.id), { recursive: true });
  try { fs.rmSync(controlSock(vm.id), { force: true }); } catch {}

  const server = net.createServer(sock => {
    clients.add(sock);
    wire(sock, m => handleMessage(m, sock), () => clients.delete(sock));
    send(sock, { evt: "hello", name: vm.name, state: vm.state });
  });
  server.listen(controlSock(vm.id));
  server.on("error", e => { log("control socket error:", e.message); });

  fs.writeFileSync(runDir(vm.id) + "/run.json", JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  process.on("SIGTERM", () => powerOff());
  process.on("SIGINT", () => powerOff());
  const crash = e => {
    log("fatal:", e.stack || e.message);
    try { fs.appendFileSync(runDir(vm.id) + "/error.log", `${new Date().toISOString()} ${e.stack || e.message}\n`); } catch {}
    vm.state = "crashed";
    saveVM(vm);
    setTimeout(() => process.exit(1), 100);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  try {
    await bootInstance();
  } catch (e) {
    crash(e);
  }
}

main();
