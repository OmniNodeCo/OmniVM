#!/usr/bin/env node
/* Builds a single-file OmniVM executable for the current platform using
 * Node.js Single Executable Application (SEA) support:
 *
 *   1. bundle the app (ESM -> one CJS file) with esbuild
 *   2. generate the SEA blob (code + embedded assets from sea-config.json)
 *   3. copy the local node runtime and inject the blob with postject
 *   4. ad-hoc codesign on macOS (mandatory on Apple Silicon)
 *   5. package an archive (tar.gz on Linux, zip elsewhere)
 *
 * Used by CI (.github/workflows/build.yml) and for local builds:
 *
 *   npm install
 *   node scripts/build.mjs          # -> dist/omnivm-v<version>-<os>-<arch>.*
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : ".", "..");
process.chdir(root);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = process.env.OMNIVM_VERSION || `v${pkg.version}`;
const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const arch = process.arch === "x64" ? "x64" : process.arch; // arm64 stays arm64
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

const sh = cmd => execSync(cmd, { stdio: "inherit", env: process.env });

fs.mkdirSync("dist", { recursive: true });
const exe = path.join("dist", isWin ? "omnivm.exe" : "omnivm");

console.log(`[1/6] bundling app (esbuild)...`);
sh(`npx --no-install esbuild bin/omnivm.js` +
   ` --bundle --platform=node --target=node22 --format=cjs` +
   ` --log-level=warning --outfile=dist/omnivm.cjs`);

console.log(`[2/6] generating SEA blob (code + embedded assets)...`);
sh(`node --experimental-sea-config sea-config.json`);

console.log(`[3/6] copying node runtime...`);
fs.copyFileSync(process.execPath, exe);
if (!isWin) fs.chmodSync(exe, 0o755);

console.log(`[4/6] injecting blob (postject)...`);
if (isMac) { try { sh(`codesign --remove-signature "${exe}"`); } catch { /* unsigned */ } }
sh(`npx --no-install postject "${exe}" NODE_SEA_BLOB dist/prelude.blob` +
   ` --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` +
   (isMac ? ` --macho-segment-name NODE_SEA` : ""));
if (isMac) sh(`codesign --sign - "${exe}"`);

console.log(`[5/6] smoke run...`);
sh(`"${exe}" version`);

/* loose bundle folder (binary + docs) — CI uploads this and lets the
 * artifact store do the one-and-only zip pass, so artifacts are never
 * zip-inside-zip */
const bundleName = `omnivm-${version}-${osName}-${arch}`;
const bundleDir = path.join("dist", bundleName);
fs.rmSync(bundleDir, { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.copyFileSync(exe, path.join(bundleDir, isWin ? "omnivm.exe" : "omnivm"));
for (const f of ["README.md", "LICENSE"]) fs.copyFileSync(f, path.join(bundleDir, f));

fs.writeFileSync("dist/exe-path.txt", exe.replace(/\\/g, "/"));
fs.writeFileSync("dist/bundle-dir.txt", bundleDir.replace(/\\/g, "/"));

if (process.env.OMNIVM_SKIP_ARCHIVE) {
  console.log(`\n✔ bundle: ${bundleDir}`);
  console.log(`  (archive creation skipped — OMNIVM_SKIP_ARCHIVE is set)`);
  process.exit(0);
}

console.log(`[6/6] packaging...`);
const isTar = osName === "linux";
const archive = path.join("dist", `${bundleName}.${isTar ? "tar.gz" : "zip"}`);
fs.rmSync(archive, { force: true });
if (isTar) sh(`tar -czf "${archive}" -C dist "${bundleName}"`);
else sh(`tar -a -cf "${archive}" -C dist "${bundleName}"`);
fs.writeFileSync("dist/archive-path.txt", archive.replace(/\\/g, "/"));
const size = fs.statSync(archive).size;
console.log(`\n✔ ${archive} (${(size / 1048576).toFixed(1)} MB)`);
