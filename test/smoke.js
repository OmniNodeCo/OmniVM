/* OmniVM end-to-end smoke test.
 * Runs a real VM (bundled OmniOS guest), drives it over the control socket,
 * and exercises the full lifecycle. Exit 0 = pass. */
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

async function waitSerial(client, pattern, timeoutMs) {
  const buf = [];
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${JSON.stringify(pattern)}; got: ${buf.join("").slice(-200)}`)), timeoutMs);
    client.on("event", m => {
      if (m.evt !== "serial") return;
      buf.push(Buffer.from(m.data, "base64").toString("latin1"));
      if (buf.join("").includes(pattern)) { clearTimeout(to); resolve(buf.join("")); }
    });
  });
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

  // 3. console: wait for the OmniOS banner over serial
  const client = mgr.attach(mgr.refresh(vm));
  let banner;
  await check("guest boots OmniOS (serial banner)", async () => {
    banner = await waitSerial(client, "Type 'help' for commands", 45000);
  });

  // 4. interact
  await check("shell responds to commands", async () => {
    client.serialIn("ver\r");
    await waitSerial(client, "OmniVM Guest Tools", 10000);
    client.serialIn("echo omnivm-works\r");
    await waitSerial(client, "omnivm-works", 10000);
  });

  // 5. snapshot: take, then verify it appears in the list
  await check("live snapshot (save machine state)", async () => {
    const res = await client.request({ cmd: "snapshot-save", name: "clean" });
    if (!res.ok) throw new Error(res.error);
    const list = await mgr.snapshot.list(vm);
    if (!list.find(s => s.name === "clean")) throw new Error("snapshot missing from list");
  });

  // 6. revert to it
  await check("revert to snapshot", async () => {
    const res = await client.request({ cmd: "snapshot-restore", name: "clean" });
    if (!res.ok) throw new Error(res.error);
  });

  // 7. VGA screen query
  await check("VGA text screen query", async () => {
    const res = await client.request({ cmd: "screen" });
    if (!res.ok || !res.rows?.length) throw new Error("no screen rows");
    const flat = res.rows.join("\n");
    if (!flat.includes("omni>")) throw new Error("screen does not show shell prompt");
  });

  // 8. pause / unpause
  await check("pause & unpause", async () => {
    await client.request({ cmd: "pause" });
    let st = await client.request({ cmd: "status" });
    if (st.state !== "paused") throw new Error("state != paused");
    await client.request({ cmd: "unpause" });
    st = await client.request({ cmd: "status" });
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
    const buf = [];
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`no shell response after resume; got: ${buf.join("").slice(-120)}`)), 25000);
      c2.on("event", m => {
        if (m.evt === "serial") {
          buf.push(Buffer.from(m.data, "base64").toString("latin1"));
          if (buf.join("").includes("omni>")) { clearTimeout(to); resolve(); }
        }
      });
      setTimeout(() => c2.serialIn("uptime\r"), 1500);
    });
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

  // 13. cleanup
  deleteVM(vm.id);
  if (findVM("smoke-vm")) throw new Error("VM still exists after delete");
  ok("delete VM");
} catch (e) {
  fail("unexpected", e.stack || e.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
