import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { devRoot } from "./assets.js";

export const APP_ROOT = devRoot();

/* sentinel stored in vm.json for the bundled OmniOS live floppy */
export const BUNDLED_FLOPPY = "omnios";

/* true if a VM's floppy setting refers to the bundled OmniOS image
 * (sentinel, or a legacy absolute path into an old checkout) */
export function isBundledFloppy(vmOrPath) {
  const f = typeof vmOrPath === "string" ? vmOrPath : vmOrPath?.floppy;
  if (f === BUNDLED_FLOPPY) return true;
  if (!f || typeof f !== "string") return false;
  try {
    return path.basename(f) === "omnios.img" && !fs.existsSync(f);
  } catch { return false; }
}

export function homeDir() {
  return process.env.OMNIVM_HOME || path.join(os.homedir(), ".omnivm");
}

export function vmsDir() { return path.join(homeDir(), "vms"); }
export function isoDir() { return path.join(homeDir(), "isos"); }
export function vmDir(id) { return path.join(vmsDir(), id); }
export function vmFile(id) { return path.join(vmDir(id), "vm.json"); }
export function runDir(id) { return path.join(vmDir(id), "run"); }
export function controlSock(id) { return path.join(runDir(id), "control.sock"); }
export function consoleLog(id) { return path.join(runDir(id), "console.log"); }
export function suspendFile(id) { return path.join(runDir(id), "suspend.v86s"); }
export function snapshotsDir(id) { return path.join(vmDir(id), "snapshots"); }
export function disksDir(id) { return path.join(vmDir(id), "disks"); }
export function diskImage(id) { return path.join(disksDir(id), "hda.img"); }

export const BIOS = path.join(APP_ROOT, "vendor", "bios", "seabios.bin");
export const VGA_BIOS = path.join(APP_ROOT, "vendor", "bios", "vgabios.bin");

export function ensureDirs() {
  for (const d of [homeDir(), vmsDir(), isoDir()]) fs.mkdirSync(d, { recursive: true });
}

export function newId() {
  return crypto.randomBytes(4).toString("hex");
}

export function sanitizeName(name) {
  const n = String(name || "").trim().replace(/\s+/g, "-");
  if (!n || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/.test(n)) {
    throw new Error(`invalid VM name "${name}" (use letters, digits, . _ -)`);
  }
  return n;
}

export function listVMs() {
  ensureDirs();
  const out = [];
  for (const id of fs.readdirSync(vmsDir())) {
    try {
      const vm = JSON.parse(fs.readFileSync(vmFile(id), "utf8"));
      out.push(vm);
    } catch { /* skip broken entries */ }
  }
  out.sort((a, b) => (a.created || "").localeCompare(b.created || ""));
  return out;
}

export function findVM(idOrName) {
  const vms = listVMs();
  return vms.find(v => v.id === idOrName) || vms.find(v => v.name === idOrName) || null;
}

export function loadVM(id) {
  return JSON.parse(fs.readFileSync(vmFile(id), "utf8"));
}

export function saveVM(vm) {
  fs.mkdirSync(vmDir(vm.id), { recursive: true });
  const tmp = vmFile(vm.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(vm, null, 2) + "\n");
  fs.renameSync(tmp, vmFile(vm.id));
}

export function createVM(opts = {}) {
  ensureDirs();
  const name = sanitizeName(opts.name);
  if (findVM(name)) throw new Error(`a VM named "${name}" already exists`);
  const memMB = clampInt(opts.memMB, 16, 1024, 64);
  const diskMB = clampInt(opts.diskMB, 0, 2048, 0);
  let floppy = opts.floppy ?? BUNDLED_FLOPPY;
  if (floppy === BUNDLED_FLOPPY) floppy = BUNDLED_FLOPPY;
  else if (floppy === "none" || floppy === "no") floppy = null;
  else if (floppy) floppy = path.resolve(String(floppy));
  if (floppy && floppy !== BUNDLED_FLOPPY && !fs.existsSync(floppy)) throw new Error(`floppy image not found: ${floppy}`);
  let cdrom = opts.cdrom || null;
  if (cdrom) {
    cdrom = path.resolve(String(cdrom));
    if (!fs.existsSync(cdrom)) throw new Error(`CD-ROM image not found: ${cdrom}`);
  }

  const vm = {
    id: newId(),
    name,
    guestOs: opts.guestOs || (floppy === BUNDLED_FLOPPY ? "OmniOS 1.0" : cdrom ? "Custom (CD-ROM)" : "Other"),
    engine: "v86 (software x86)",
    cpus: 1,
    memMB,
    diskMB,
    floppy,
    cdrom,
    boot: opts.boot || (floppy ? "floppy" : cdrom ? "cdrom" : "disk"),
    notes: opts.notes || "",
    created: new Date().toISOString(),
    state: "off",
  };
  saveVM(vm);
  if (diskMB > 0) {
    fs.mkdirSync(disksDir(vm.id), { recursive: true });
    const f = fs.openSync(diskImage(vm.id), "w");
    fs.ftruncateSync(f, diskMB * 1024 * 1024);
    fs.closeSync(f);
  }
  return vm;
}

export function deleteVM(id) {
  fs.rmSync(vmDir(id), { recursive: true, force: true });
}

export function cloneVM(src) {
  const name = sanitizeName(src.name + "-clone");
  let n = name, i = 2;
  while (findVM(n)) n = `${name}${i++}`;
  const vm = createVM({
    name: n,
    memMB: src.memMB,
    diskMB: src.diskMB,
    floppy: src.floppy,
    cdrom: src.cdrom,
    guestOs: src.guestOs,
    boot: src.boot,
    notes: src.notes,
  });
  if (src.diskMB > 0) {
    const s = diskImage(src.id), d = diskImage(vm.id);
    if (fs.existsSync(s)) fs.copyFileSync(s, d);
  }
  return vm;
}

export function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export function fmtMB(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;
  return `${mb} MB`;
}
