/* OmniVM desktop app smoke test (used by CI on Linux with xvfb).
 * Launches the real Electron binary with --smoke: the main process creates
 * the window, the canvas renderer boots, and both sides verify a full IPC
 * roundtrip before reporting success on stdout. Exits 0 on success. */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
let electronPath;
try {
  electronPath = require("electron"); // string path when required from node
} catch {
  console.error("electron not installed");
  process.exit(1);
}
if (typeof electronPath !== "string") {
  console.error("electron binary missing (was it installed with ELECTRON_SKIP_BINARY_DOWNLOAD?)");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const child = spawn(electronPath, [root, "--smoke", "--no-sandbox"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
});

let out = "", err = "";
const timer = setTimeout(() => {
  console.error("timeout waiting for ELECTRON_SMOKE_OK");
  console.error("stdout:", out.slice(-500));
  console.error("stderr:", err.slice(-800));
  child.kill("SIGKILL");
  process.exit(1);
}, 60000);

child.stdout.on("data", d => { out += d; process.stdout.write(d); });
child.stderr.on("data", d => { err += d; });
child.on("exit", code => {
  clearTimeout(timer);
  const ok = out.includes("ELECTRON_SMOKE_OK");
  console.log(ok ? "\ndesktop app smoke: PASS" : `\ndesktop app smoke: FAIL (exit ${code})`);
  process.exit(ok ? 0 : 1);
});
