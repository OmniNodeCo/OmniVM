/* OmniVM Workstation — preload (context bridge).
 * Exposes a minimal, promise-based desktop API to the renderer. No node
 * integration leaks into the GUI. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omnivm", {
  /* request/response */
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),

  /* push events */
  onVms: cb => ipcRenderer.on("vms", (_e, vms) => cb(vms)),
  onConsole: cb => ipcRenderer.on("console", (_e, vmId, dataB64) => cb(vmId, dataB64)),
  onMenu: cb => ipcRenderer.on("menu", (_e, action) => cb(action)),

  /* desktop smoke hook */
  ready: () => ipcRenderer.send("renderer-ready"),
});
