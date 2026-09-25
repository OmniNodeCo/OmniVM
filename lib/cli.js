import path from "node:path";
import fs from "node:fs";
import * as store from "./store.js";
import * as mgr from "./manager.js";
import { assetBuffer } from "./assets.js";

const dim = s => `\x1b[2m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const stateColor = s =>
  s === "running" ? green(s) : s === "suspended" ? yellow(s) :
  s === "paused" ? yellow(s) : s === "crashed" ? red(s) : dim(s);

function die(msg) { console.error(red("error: ") + msg); process.exit(1); }

function needVM(nameOrId) {
  const vm = store.findVM(nameOrId);
  if (!vm) die(`no such VM: "${nameOrId}" (see: omnivm list)`);
  return vm;
}

function printHelp() {
  console.log(`
${bold("OmniVM Workstation")} — run virtual machines from your terminal

${bold("usage:")} omnivm [command]

${bold("commands:")}
  (no command)            launch the Workstation TUI
  list                    list virtual machines
  create <name> [opts]    create a VM
                          --mem <MB>        memory (16..1024, default 64)
                          --disk <MB>       hard disk size, 0 = none (default)
                          --floppy <src>    "omnios" (bundled OS) | "none" | path to .img
                          --cdrom <path>    attach a CD-ROM (.iso)
                          --boot <dev>      floppy | disk | cdrom
                          --guest <label>   guest OS label
  start <vm>              power on
  stop <vm>               power off (flushes guest disks)
  kill <vm>               power off forcibly
  suspend <vm>            suspend to disk
  resume <vm>             resume a suspended VM
  reset <vm>              hard reset
  pause <vm> | unpause <vm>
  console <vm>            attach to the serial console (Ctrl-] to detach)
  screen <vm>             dump the VGA text screen
  snapshot <vm> take <name> | list | revert <name> | delete <name>
  clone <vm> [newname]    clone a VM
  delete <vm>             delete a VM and its disks
  status [vm]             show status
  doctor                  check the installation
  version                 print version

${bold("keys in the TUI:")}  ↑/↓ select · Enter console · P power on · O power off
  S suspend · E resume · R reset · N new VM · D delete · C clone
  K snapshots · V serial/VGA · F1 help · Ctrl-Q quit
`);
}

async function cmdConsole(vm) {
  const cur = mgr.refresh(vm);
  if (!mgr.isRunning(cur)) die(`"${cur.name}" is not powered on`);
  const client = mgr.attach(cur);
  console.log(dim(`Attaching to serial console of "${cur.name}" — press Ctrl-] to detach...`));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", buf => {
    const s = buf.toString("latin1");
    if (s === "\x1d") { console.log(dim("\nDetached.")); client.close(); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.exit(0); }
    client.serialIn(s);
  });
  client.on("event", m => {
    if (m.evt === "serial") process.stdout.write(Buffer.from(m.data, "base64").toString("latin1"));
  });
  client.on("close", () => { console.log(dim("\nVM console closed.")); process.exit(0); });
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "tui" || cmd === "ui") {
    const { launchTUI } = await import("./tui/app.js");
    launchTUI();
    return;
  }

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
      console.log("OmniVM Workstation 1.0.0 (engine: v86 software x86 emulation)");
      break;
    case "list":
    case "ls": {
      const vms = mgr.statesOf(store.listVMs());
      if (!vms.length) { console.log("no VMs yet — create one: omnivm create myvm"); break; }
      console.log(bold("NAME".padEnd(22)) + bold("STATE".padEnd(12)) + bold("MEM".padEnd(9)) + bold("DISK".padEnd(9)) + bold("GUEST OS"));
      for (const v of vms) {
        console.log(
          v.name.padEnd(22) + stateColor(v.state.padEnd(12)) +
          store.fmtMB(v.memMB).padEnd(9) + store.fmtMB(v.diskMB).padEnd(9) + (v.guestOs || "-")
        );
      }
      break;
    }
    case "create": {
      if (!rest[0]) die("usage: omnivm create <name> [--mem 64] [--disk 0] [--floppy omnios|none|path] [--cdrom iso] [--boot floppy] [--guest label]");
      const o = { name: rest[0] };
      for (let i = 1; i < rest.length; i += 2) {
        const k = rest[i].replace(/^--/, ""), v = rest[i + 1];
        if (v === undefined) die(`missing value for ${rest[i]}`);
        if (k === "mem") o.memMB = v;
        else if (k === "disk") o.diskMB = v;
        else if (k === "floppy") o.floppy = v;
        else if (k === "cdrom") o.cdrom = v;
        else if (k === "boot") o.boot = v;
        else if (k === "guest") o.guestOs = v;
        else if (k === "notes") o.notes = v;
      }
      const vm = store.createVM(o);
      console.log(green(`✔ created VM "${vm.name}"`) + dim(` (${vm.id}) — ${store.fmtMB(vm.memMB)} RAM, ${vm.diskMB ? store.fmtMB(vm.diskMB) + " disk, " : ""}${store.isBundledFloppy(vm.floppy) ? "OmniOS floppy" : vm.floppy ? "floppy " + vm.floppy : "no floppy"}`));
      console.log(dim(`  power it on:  omnivm start ${vm.name}`));
      break;
    }
    case "start": {
      const vm = needVM(rest[0]);
      console.log(dim(`powering on "${vm.name}"...`));
      await mgr.startVM(vm);
      console.log(green(`✔ "${vm.name}" is powered on`) + dim(` — omnivm console ${vm.name}`));
      break;
    }
    case "stop": {
      const vm = needVM(rest[0]);
      console.log(dim(`powering off "${vm.name}"...`));
      await mgr.powerOffVM(vm);
      console.log(green(`✔ "${vm.name}" is powered off`));
      break;
    }
    case "kill": {
      const vm = needVM(rest[0]);
      await mgr.killVM(vm);
      console.log(green(`✔ "${vm.name}" was powered off forcibly`));
      break;
    }
    case "suspend": {
      const vm = needVM(rest[0]);
      await mgr.suspendVM(vm);
      console.log(green(`✔ "${vm.name}" suspended to disk`) + dim(` — omnivm resume ${vm.name}`));
      break;
    }
    case "resume": {
      const vm = needVM(rest[0]);
      console.log(dim(`resuming "${vm.name}"...`));
      await mgr.resumeVM(vm);
      console.log(green(`✔ "${vm.name}" resumed`));
      break;
    }
    case "reset": {
      const vm = needVM(rest[0]);
      await mgr.resetVM(vm);
      console.log(green(`✔ "${vm.name}" reset`));
      break;
    }
    case "pause":
    case "unpause": {
      const vm = needVM(rest[0]);
      await mgr.pauseVM(vm, cmd === "pause");
      console.log(green(`✔ "${vm.name}" ${cmd === "pause" ? "paused" : "resumed from pause"}`));
      break;
    }
    case "console": {
      const vm = needVM(rest[0]);
      await cmdConsole(vm);
      break;
    }
    case "screen": {
      const vm = needVM(rest[0]);
      if (!mgr.isRunning(vm)) die(`"${vm.name}" is not powered on`);
      const client = mgr.attach(vm);
      const res = await client.request({ cmd: "screen" });
      for (const row of res.rows || []) console.log(row);
      client.close();
      process.exit(0);
      break;
    }
    case "snapshot":
    case "snap": {
      const vm = needVM(rest[0]);
      const [action, name] = rest.slice(1);
      if (action === "take" && name) {
        await mgr.snapshot.take(vm, name);
        console.log(green(`✔ snapshot "${name}" taken on "${vm.name}"`));
      } else if (action === "list" || !action) {
        const snaps = await mgr.snapshot.list(vm);
        if (!snaps.length) { console.log(dim("no snapshots")); break; }
        for (const s of snaps) console.log(`  ${s.name.padEnd(20)} ${dim(new Date(s.mtime).toLocaleString())}  ${dim((s.size / 1048576).toFixed(1) + " MB")}`);
      } else if (action === "revert" && name) {
        await mgr.snapshot.restore(vm, name);
        console.log(green(`✔ "${vm.name}" reverted to "${name}"`));
      } else if (action === "delete" && name) {
        await mgr.snapshot.delete(vm, name);
        console.log(green(`✔ snapshot "${name}" deleted`));
      } else {
        die("usage: omnivm snapshot <vm> take <name> | list | revert <name> | delete <name>");
      }
      break;
    }
    case "clone": {
      const vm = needVM(rest[0]);
      const clone = store.cloneVM(vm);
      console.log(green(`✔ cloned "${vm.name}" → "${clone.name}"`));
      break;
    }
    case "config": {
      const vm = needVM(rest[0]);
      const cur = mgr.refresh(vm);
      if (mgr.isRunning(cur)) die(`power off "${cur.name}" before changing its settings`);
      const o = {};
      for (let i = 1; i < rest.length; i += 2) {
        const k = rest[i].replace(/^--/, ""), v = rest[i + 1];
        if (v === undefined) die(`missing value for ${rest[i]}`);
        o[k] = v;
      }
      if (!Object.keys(o).length) {
        console.log(`settings for ${bold(cur.name)}:`);
        for (const k of ["memMB", "diskMB", "floppy", "cdrom", "boot", "guestOs", "notes"]) {
          const v = k === "floppy" && store.isBundledFloppy(cur[k]) ? "omnios (bundled)" : cur[k];
          console.log(`  ${k.padEnd(9)} ${v ?? "-"}`);
        }
        console.log(dim("  change with: omnivm config <vm> --mem 128 --disk 64 --floppy omnios|none|path --cdrom path.iso --boot floppy|disk|cdrom"));
        break;
      }
      const patch = {};
      if (o.mem !== undefined) patch.memMB = store.clampInt(o.mem, 16, 1024, cur.memMB);
      if (o.floppy !== undefined) {
        if (o.floppy === "omnios") patch.floppy = store.BUNDLED_FLOPPY;
        else if (o.floppy === "none") patch.floppy = null;
        else {
          patch.floppy = path.resolve(o.floppy);
          if (!fs.existsSync(patch.floppy)) die(`floppy image not found: ${patch.floppy}`);
        }
      }
      if (o.cdrom !== undefined) {
        if (o.cdrom === "none") patch.cdrom = null;
        else {
          patch.cdrom = path.resolve(o.cdrom);
          if (!fs.existsSync(patch.cdrom)) die(`CD image not found: ${patch.cdrom}`);
        }
      }
      if (o.boot !== undefined) {
        if (!["floppy", "disk", "cdrom"].includes(o.boot)) die("--boot must be floppy | disk | cdrom");
        patch.boot = o.boot;
      }
      if (o.notes !== undefined) patch.notes = o.notes;
      const updated = { ...cur, ...patch };
      store.saveVM(updated);
      console.log(green(`✔ settings updated for "${updated.name}"`));
      break;
    }
    case "delete":
    case "rm": {
      const vm = needVM(rest[0]);
      store.deleteVM(vm.id);
      console.log(green(`✔ VM "${vm.name}" deleted`));
      break;
    }
    case "status": {
      const vms = rest[0] ? [needVM(rest[0])] : store.listVMs();
      for (const v of mgr.statesOf(vms)) {
        console.log(`${bold(v.name)}  [${stateColor(v.state)}]  ${store.fmtMB(v.memMB)} RAM · ${v.cpus} vCPU · ${v.diskMB ? "disk " + store.fmtMB(v.diskMB) : "no disk"}`);
      }
      break;
    }
    case "doctor": {
      const checks = [];
      const ok = m => console.log(green("  ✔ ") + m);
      const bad = m => { console.log(red("  ✘ ") + m); checks.push(m); };
      console.log(bold("OmniVM doctor"));
      ok(`node ${process.version} (${process.platform}-${process.arch})`);
      for (const [label, name] of [
        ["BIOS (SeaBIOS)", "seabios.bin"],
        ["VGA BIOS", "vgabios.bin"],
        ["v86 engine (WASM)", "v86.wasm"],
        ["bundled guest OS (OmniOS floppy)", "omnios.img"],
      ]) {
        try {
          const b = await assetBuffer(name);
          b.length ? ok(`${label} found (${(b.length / 1024).toFixed(0)} KB)`) : bad(`${label} is empty`);
        } catch { bad(`${label} missing`); }
      }
      store.ensureDirs();
      ok(`VM library at ${store.homeDir()}`);
      const vms = store.listVMs();
      console.log(dim(`  ${vms.length} VM(s) registered`));
      if (checks.length) process.exit(1);
      break;
    }
    case "run": { // internal: spawn a runner
      await import("./runner.js"); // executes the runner main()
      break;
    }
    default:
      die(`unknown command "${cmd}" — try: omnivm help`);
  }
}

process.on("unhandledRejection", e => die(e.message || String(e)));
main().catch(e => die(e.stack || e.message || String(e)));
