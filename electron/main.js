/* OmniVM Workstation — Electron desktop app (main process).
 *
 * A native desktop application: own window, own process, native menus and
 * accelerators. The VM engine lives in this same process tree (runners are
 * spawned as node child processes); the window talks over IPC. There is no
 * server, no browser and no network component.
 */
import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard } from "electron";
import path from "node:path";
import url from "node:url";
import * as api from "./vm-api.js";

const isMac = process.platform === "darwin";
const SMOKE = process.argv.includes("--smoke");
const windows = new Set();

app.setName("OmniVM");

/* obtained instance lock (like a well-behaved desktop app) */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ---------------- window ---------------- */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    title: "OmniVM Workstation",
    backgroundColor: "#17181b",
    show: false,
    webPreferences: {
      preload: path.join(url.fileURLToPath(new URL(".", import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  windows.add(win);

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => windows.delete(win));
  win.on("page-title-updated", e => e.preventDefault());

  /* subscriber sink: pushes state + console events to THIS window */
  const sink = (evt, payload) => {
    if (win.isDestroyed()) return;
    if (evt === "vms") win.webContents.send("vms", payload);
    else if (evt === "console") win.webContents.send("console", payload.vmId, payload.data);
  };
  win.sink = sink;

  /* Smoke mode: register the readiness listener BEFORE loadFile — the
   * renderer sends "renderer-ready" during script execution, which happens
   * before did-finish-load, so a late registration would always miss it. */
  if (SMOKE) {
    console.error("ELECTRON_APP_READY");
    win.webContents.on("did-fail-load", (_e, code, desc, url2) =>
      console.error(`ELECTRON_LOAD_FAIL ${code} ${desc} ${url2}`));
    win.webContents.on("did-finish-load", () => console.error("ELECTRON_WINDOW_LOADED"));
    win.webContents.on("render-process-gone", (_e, details) =>
      console.error(`ELECTRON_RENDERER_GONE ${details.reason}`));

    const timeout = setTimeout(() => { console.error("ELECTRON_SMOKE_TIMEOUT"); app.exit(1); }, 45000);
    ipcMain.once("renderer-ready", async event => {
      try {
        const ready = await event.sender.executeJavaScript("window.__omnivmReady === true");
        const vms = api.list();
        clearTimeout(timeout);
        if (ready && Array.isArray(vms)) {
          console.log(`ELECTRON_SMOKE_OK vms=${vms.length}`);
          app.exit(0);
        } else {
          console.error(`ELECTRON_SMOKE_FAIL ready=${ready} vmsOk=${Array.isArray(vms)}`);
          app.exit(1);
        }
      } catch (e) {
        console.error("ELECTRON_SMOKE_FAIL", e.message);
        app.exit(1);
      }
    });
  }

  win.loadFile(path.join(url.fileURLToPath(new URL(".", import.meta.url)), "renderer", "index.html"));
  return win;
}

function broadcast(action) {
  for (const w of windows) if (!w.isDestroyed()) w.webContents.send("menu", action);
}

/* ---------------- native menu (Workstation-style) ---------------- */
function buildMenu() {
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "&File",
      submenu: [
        { label: "New Virtual Machine", accelerator: "CmdOrCtrl+N", click: () => broadcast("newvm") },
        { label: "Snapshot Manager", accelerator: "CmdOrCtrl+K", click: () => broadcast("snapshots") },
        { type: "separator" },
        ...(isMac ? [] : [{ role: "quit" }]),
      ],
    },
    { label: "&Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "&VM",
      submenu: [
        { label: "Power On", accelerator: "CmdOrCtrl+P", click: () => broadcast("power-on") },
        { label: "Power Off", accelerator: "CmdOrCtrl+O", click: () => broadcast("power-off") },
        { label: "Suspend to Disk", accelerator: "CmdOrCtrl+S", click: () => broadcast("suspend") },
        { label: "Resume", accelerator: "CmdOrCtrl+E", click: () => broadcast("resume") },
        { type: "separator" },
        { label: "Reset", accelerator: "CmdOrCtrl+R", click: () => broadcast("reset") },
        { label: "Pause / Unpause", accelerator: "CmdOrCtrl+U", click: () => broadcast("pause-toggle") },
        { type: "separator" },
        { label: "Enter Full Screen", role: "togglefullscreen" },
      ],
    },
    {
      label: "&View",
      submenu: [
        { label: "Serial Console", accelerator: "CmdOrCtrl+1", click: () => broadcast("view-serial") },
        { label: "VGA Screen", accelerator: "CmdOrCtrl+2", click: () => broadcast("view-vga") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "About OmniVM", click: () => {
          dialog.showMessageBox({
            type: "info",
            title: "About OmniVM",
            message: `OmniVM Workstation ${app.getVersion()}`,
            detail: "Run virtual machines on your desktop.\nEngine: v86 software x86 emulation · Guest: OmniOS (bundled)\n\n© 2026 OmniVM contributors — MIT License",
            buttons: ["OK"],
          });
        } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, payload = {}) => {
    try { return { ok: true, result: await fn(payload, event) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  handle("vms:list", () => api.list());
  handle("vm:create", p => api.createVM(p));
  handle("vm:delete", p => api.deleteVM(p.id));
  handle("vm:clone", p => api.cloneVM(p.id));
  handle("vm:action", p => api.vmAction(p.id, p.action));
  handle("vm:set-cdrom", p => api.setCdrom(p.id, p.iso));
  handle("vm:eject-cdrom", p => api.ejectCdrom(p.id));
  handle("sys:clipboard-read", () => clipboard.readText());
  handle("snap:list", p => api.snapshots(p.id));
  handle("snap:take", p => api.snapshotTake(p.id, p.name));
  handle("snap:revert", p => api.snapshotRevert(p.id, p.name));
  handle("snap:delete", p => api.snapshotDelete(p.id, p.name));
  handle("console:attach", (p, event) => api.attach(p.id, event.sender.sink));
  handle("console:detach", (p, event) => api.detach(p.id, event.sender.sink));
  handle("console:input", p => api.serialIn(p.id, p.data));
  handle("console:screen", p => api.screen(p.id));
}

/* ---------------- lifecycle ---------------- */
app.whenReady().then(() => {
  api.start();
  registerIpc();
  buildMenu();
  const win = createWindow();

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("second-instance", () => {
  const [w] = BrowserWindow.getAllWindows();
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

app.on("window-all-closed", () => { if (!isMac) app.quit(); });
app.on("before-quit", () => api.stop());
