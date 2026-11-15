/* OmniVM end-to-end smoke test.
 * Runs a real VM (bundled OmniOS guest), drives it over the control socket,
 * and exercises the full lifecycle. Exit 0 = pass.
 *
 * CI notes: GitHub runners are slow and the software-emulated guest may take
 * a while to boot, so every wait has generous timeouts, and the runner
 * replays recent serial history on attach — the banner is detected even if
 * it was printed before this test attached. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = path.join(os.tmpdir(), `omnivm-smoke-${process.pid}`);
process.env.OMNIVM_HOME = HOME;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = name => { passed++; console.log(`  ✔ ${name}`); };
const fail = (name, extra) => { failed++; console.error(`  ✘ ${name}${extra ? " — " + extra : ""}`); };
async function check(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message); }
}

console.log("OmniVM smoke test\n");

const { createVM, findVM, listVMs, deleteVM, homeDir } = await import("../lib/store.js");
const mgr = await import("../lib/manager.js");

/* A serial tap: accumulates everything the guest prints (live bytes + the
 * replay received on attach) and lets checks wait for patterns. */
class SerialTap {
  constructor(client) {
    this.text = "";
    client.on("event", m => {
      if (m.evt === "serial") this.text += Buffer.from(m.data, "base64").toString("latin1");
    });
  }
  /* waits until `pattern` appears in NEW output; consumes through it */
  async wait(pattern, timeoutMs, label) {
    const startLen = 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.text.indexOf(pattern);
      if (idx >= 0) { this.text = this.text.slice(idx + pattern.length); return; }
      if (Date.now() > deadline) {
        throw new Error(
          `timeout (${Math.round(timeoutMs / 1000)}s) waiting for ${JSON.stringify(pattern)}` +
          `${label ? " [" + label + "]" : ""}; last output seen: ${JSON.stringify(this.text.slice(-200))}`
        );
      }
      await sleep(250);
    }
  }
}

try {
  // 1. create
  const vm = createVM({ name: "smoke-vm", memMB: 64, diskMB: 16, floppy: "omnios" });
  if (!findVM("smoke-vm")) throw new Error("VM not found after create");
  ok("create VM");

  // 2. start
  await mgr.startVM(vm);
  if (!mgr.isRunning(mgr.refresh(vm))) throw new Error("not running after start");
  ok("power on (runner process detached)");

  // 3. console: the runner replays serial history, so the banner is detected
  //    even if the guest printed it before we attached (fast boots happen).
  const client = mgr.attach(mgr.refresh(vm));
  const tap = new SerialTap(client);
  await check("guest boots OmniOS (serial banner)", () =>
    tap.wait("Type 'help' for commands", 240000, "boot"));

  // 4. interact
  await check("shell responds to commands", async () => {
    client.serialIn("ver\r");
    await tap.wait("OmniVM Guest Tools", 90000, "ver");
    client.serialIn("echo omnivm-works\r");
    await tap.wait("omnivm-works", 90000, "echo");
  });

  // 5. snapshot: take, then verify it appears in the list
  await check("live snapshot (save machine state)", async () => {
    const res = await client.request({ cmd: "snapshot-save", name: "clean" }, 120000);
    if (!res.ok) throw new Error(res.error);
    const list = await mgr.snapshot.list(vm);
    if (!list.find(s => s.name === "clean")) throw new Error("snapshot missing from list");
  });

  // 6. revert to it
  await check("revert to snapshot", async () => {
    const res = await client.request({ cmd: "snapshot-restore", name: "clean" }, 120000);
    if (!res.ok) throw new Error(res.error);
  });

  // 7. VGA screen query
  await check("VGA text screen query", async () => {
    const res = await client.request({ cmd: "screen" }, 60000);
    if (!res.ok || !res.rows?.length) throw new Error("no screen rows");
    const flat = res.rows.join("\n");
    if (!flat.includes("omni>")) throw new Error("screen does not show shell prompt");
  });

  // 8. pause / unpause
  await check("pause & unpause", async () => {
    await client.request({ cmd: "pause" }, 60000);
    let st = await client.request({ cmd: "status" }, 60000);
    if (st.state !== "paused") throw new Error("state != paused");
    await client.request({ cmd: "unpause" }, 60000);
    st = await client.request({ cmd: "status" }, 60000);
    if (st.state !== "running") throw new Error("state != running");
  });

  // 9. suspend (runner saves state and exits)
  await check("suspend to disk", async () => {
    await mgr.suspendVM(vm);
    if (!fs.existsSync(path.join(homeDir(), "vms", vm.id, "run", "suspend.v86s"))) throw new Error("no suspend state file");
    if (mgr.isRunning(mgr.refresh(vm))) throw new Error("still running after suspend");
  });
  client.close();

  // 10. resume — the guest restores to its exact pre-suspend state; the
  // prompt is NOT re-printed (same as VMware), so type a command to prove it
  await check("resume from disk (guest state restored)", async () => {
    await mgr.resumeVM(vm);
    const c2 = mgr.attach(mgr.refresh(vm));
    const tap2 = new SerialTap(c2);
    await sleep(1500); // let the engine come up
    c2.serialIn("uptime\r");
    await tap2.wait("Uptime", 120000, "post-resume uptime");
    c2.close();
  });

  // 11. power off
  await check("power off (flushes disks)", async () => {
    await mgr.powerOffVM(vm);
    if (mgr.isRunning(mgr.refresh(vm))) throw new Error("still running after power off");
  });

  // 12. snapshot listing offline
  await check("snapshot list (powered off)", async () => {
    const list = await mgr.snapshot.list(vm);
    if (!list.find(s => s.name === "clean")) throw new Error("snapshot lost");
  });

  // 12b. desktop app data layer (electron/vm-api): window sink push
  // (regression: the VM library never loaded because windows were never
  //  pushed the list — this check pins the fix)
  await check("desktop app data layer (VM library push to windows)", async () => {
    const api = await import("../electron/vm-api.js");
    api.start();
    const seen = [];
    const sink = (evt, payload) => { if (evt === "vms") seen.push(payload); };
    api.registerSink(sink);
    try {
      await sleep(100);
      if (!seen.length) throw new Error("no initial vms push on registerSink");
      if (!Array.isArray(seen[0])) throw new Error("push payload is not a list");
      if (!seen[0].some(v => v.id === vm.id)) throw new Error("created VM missing from pushed list");
      api.unregisterSink(sink);
    } finally {
      api.stop();
    }
  });

  await check("desktop app data layer (attach, console, input)", async () => {
    const api = await import("../electron/vm-api.js");
    api.start();
    try {
      const vm2 = mgr.refresh(vm);
      await mgr.startVM(vm2);
      await sleep(4000);
      let got = "";
      const sink = (evt, payload) => {
        if (evt === "console") got += Buffer.from(payload.data, "base64").toString("latin1");
      };
      api.attach(vm2.id, sink);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !got.includes("omni>")) await sleep(300);
      if (!got.includes("omni>")) throw new Error(`no console replay/stream: ${JSON.stringify(got.slice(-80))}`);
      api.serialIn(vm2.id, Buffer.from("echo desktop-layer\\r").toString("base64"));
      const t0 = Date.now();
      while (Date.now() - t0 < 20000 && !got.includes("desktop-layer")) await sleep(300);
      if (!got.includes("desktop-layer")) throw new Error("serial input did not reach guest");
      const rows = await api.screen(vm2.id);
      if (!rows.length) throw new Error("no VGA rows");
      api.detach(vm2.id, sink);
      await mgr.powerOffVM(vm2);
    } finally {
      api.stop();
    }
  });

  // 12c. ISO attach/eject via the desktop data layer (drag & drop backend)
  await check("attach & eject ISO (desktop data layer)", async () => {
    const api = await import("../electron/vm-api.js");
    const iso = path.join(os.tmpdir(), `omnivm-test-${process.pid}.iso`);
    fs.writeFileSync(iso, "fake iso contents");
    try {
      const vm3 = mgr.refresh(vm);
      if (mgr.isRunning(vm3)) throw new Error("precondition: VM should be off");
      const r1 = api.setCdrom(vm3.id, iso);
      if (path.resolve(r1.cdrom) !== path.resolve(iso)) throw new Error("cdrom not set");
      if (r1.boot !== "cdrom") throw new Error(`boot order not switched to cdrom (got ${r1.boot}) — the ISO would never boot`);
      if (findVM(vm3.id).cdrom !== path.resolve(iso)) throw new Error("vm.json not updated");
      let rejected2 = false;
      try { api.setCdrom(vm3.id, iso + ".missing"); } catch { rejected2 = true; }
      if (!rejected2) throw new Error("missing file accepted");
      await mgr.startVM(vm3);
      await sleep(1500);
      let rejected = false;
      try { api.setCdrom(vm3.id, iso); } catch { rejected = true; }
      if (!rejected) throw new Error("hot media change was not rejected");
      await mgr.powerOffVM(vm3);
      api.ejectCdrom(vm3.id);
      if (findVM(vm3.id).cdrom !== null) throw new Error("eject failed");
      if (findVM(vm3.id).boot === "cdrom") throw new Error("boot still cdrom after eject");
    } finally {
      fs.rmSync(iso, { force: true });
    }
  });

  // 13. cleanup
  deleteVM(vm.id);
  if (findVM("smoke-vm")) throw new Error("VM still exists after delete");
  ok("delete VM");
} catch (e) {
  fail("unexpected", e.stack || e.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
