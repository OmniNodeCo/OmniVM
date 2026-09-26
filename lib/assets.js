/* OmniVM asset resolution.
 *
 * OmniVM ships a few binary assets (BIOS ROMs, the bundled OmniOS floppy
 * image and the v86 WASM engine). When running from a source checkout they
 * are read from disk. When running as a single-file executable (built with
 * Node's Single Executable Application support — see sea-config.json and
 * scripts/build.mjs) they are read from the executable itself via
 * node:sea getAsset().
 */
import fs from "node:fs";
import path from "node:path";

let seaPromise = null;
function sea() {
  if (!seaPromise) {
    seaPromise = import("node:sea")
      .then(m => (typeof m.isSea === "function" && m.isSea()) ? m : null)
      .catch(() => null);
  }
  return seaPromise;
}

/* other packers, kept for robustness */
export const isPkg = Object.prototype.hasOwnProperty.call(process, "pkg");
export const isBun = typeof globalThis.Bun !== "undefined";

export async function isBundledApp() {
  return isPkg || isBun || !!(await sea());
}

const ASSET_MAP = {
  "seabios.bin": "vendor/bios/seabios.bin",
  "vgabios.bin": "vendor/bios/vgabios.bin",
  "omnios.img": "guests/omnios/omnios.img",
  "v86.wasm": "node_modules/v86/build/v86.wasm",
  "index.html": "lib/web/static/index.html",
  "app.js": "lib/web/static/app.js",
};

/* repo root when running from source (works for bin/, lib/, test/ entry
 * points as well as the npm bin shim) */
export function devRoot() {
  const fromArgv = process.argv[1] ? path.resolve(process.argv[1]) : null;
  for (const start of [fromArgv, path.resolve("package.json") ? process.cwd() : null]) {
    let dir = start ? path.dirname(start) : null;
    for (let i = 0; dir && i < 8; i++) {
      try {
        const p = path.join(dir, "package.json");
        if (fs.existsSync(p) && JSON.parse(fs.readFileSync(p, "utf8")).name === "omnivm") return dir;
      } catch { /* keep walking */ }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return process.cwd();
}

export function devAsset(name) {
  const rel = ASSET_MAP[name];
  if (!rel) throw new Error(`unknown asset: ${name}`);
  return path.join(devRoot(), rel);
}

/* Buffer of an embedded (or on-disk) asset */
export async function assetBuffer(name) {
  const s = await sea();
  if (s) return Buffer.from(s.getAsset(name));
  return fs.readFileSync(devAsset(name));
}
