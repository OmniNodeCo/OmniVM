/* OmniVM Workstation — the terminal UI. */
import { Screen, style, BORDER } from "./tui.js";
import * as store from "../store.js";
import * as mgr from "../manager.js";

const ST = {
  header: style("brightwhite", "blue", { bold: true }),
  headerDim: style("white", "blue", { dim: true }),
  border: style("blue"),
  borderFocus: style("brightblue"),
  borderWarn: style("yellow"),
  title: style("brightwhite", "default", { bold: true }),
  dim: style("gray"),
  text: style("white"),
  bright: style("brightwhite"),
  sel: style("black", "cyan", { bold: true }),
  selDim: style("black", "cyan"),
  running: style("brightgreen", "default", { bold: true }),
  suspended: style("brightyellow"),
  paused: style("brightyellow"),
  crashed: style("brightred"),
  off: style("gray"),
  key: style("brightyellow"),
  ok: style("brightgreen", "default", { bold: true }),
  err: style("brightred", "default", { bold: true }),
  warn: style("brightyellow", "default", { bold: true }),
  value: style("brightwhite"),
  bar: style("black", "cyan"),
  barDim: style("black", "cyan", { dim: true }),
  toolbar: style("white", "default"),
  consoleText: style("brightwhite"),
  consoleDim: style("gray"),
};

const stateIcon = s => s === "running" ? "●" : s === "suspended" ? "◐" : s === "paused" ? "◑" : s === "crashed" ? "✖" : "○";
const stateSt = s => s === "running" ? ST.running : s === "suspended" || s === "paused" ? ST.suspended : s === "crashed" ? ST.crashed : ST.off;

class SerialDecoder {
  constructor() { this.pending = ""; }
  push(chunk) {
    const ops = [];
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === "\x1b") {
        const m = chunk.slice(i).match(/^\x1b\[([0-9;]*)([A-Za-z])/);
        if (m) {
          const [, param, final] = m;
          if (final === "J" && (param === "2" || param === "3")) ops.push({ type: "clear" });
          i += m[0].length;
          continue;
        }
        i += 1; // lone ESC or unsupported sequence start — swallow
        continue;
      }
      if (ch === "\n") { ops.push({ type: "line", text: this.pending }); this.pending = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\b") { this.pending = this.pending.slice(0, -1); i++; continue; }
      if (ch === "\x07") { i++; continue; }
      if (ch < " " && ch !== "\t") { i++; continue; }
      this.pending += ch;
      i++;
    }
    return ops;
  }
  flush() { return this.pending; }
}

export function launchTUI() {
  new Workstation().run();
}

class Workstation {
  constructor() {
    this.screen = new Screen({ onKey: e => this.onKey(e), onResize: () => { this.draw(); } });
    this.vms = [];
    this.sel = 0;
    this.focus = "library";          // library | console
    this.interactive = false;        // keys go to guest
    this.consoleMode = "serial";     // serial | vga
    this.scrollOffset = 0;           // console scrollback (0 = bottom)
    this.client = null;
    this.clientVmId = null;
    this.consoles = new Map();       // id -> {lines:[], dec, screen:[], gotFirstOutput}
    this.msg = null;                 // {text, kind, until}
    this.busy = false;
    this.mode = "main";              // main | help | newvm | snaps | confirm | prompt
    this.uptimeMs = 0;
    this.quitAt = 0;
    this.confirm = null;
    this.prompt = null;
    this.form = null;
  }

  run() {
    store.ensureDirs();
    this.refreshVMs();
    this.screen.start();
    this.draw();
    this.timers = [
      setInterval(() => this.pollStatus(), 2000),
      setInterval(() => this.slowRefresh(), 4000),
      setInterval(() => { if (this.msg && Date.now() > this.msg.until) { this.msg = null; this.draw(); } }, 500),
    ];
  }

  /* ---------------- data ---------------- */
  refreshVMs() {
    const prevSel = this.vms[this.sel]?.id;
    this.vms = mgr.statesOf(store.listVMs());
    if (prevSel) {
      const i = this.vms.findIndex(v => v.id === prevSel);
      if (i >= 0) this.sel = i;
    }
    if (this.sel >= this.vms.length) this.sel = Math.max(0, this.vms.length - 1);
    this.ensureClient();
  }

  slowRefresh() {
    try { this.refreshVMs(); this.draw(); } catch {}
  }

  consoleState(id) {
    if (!this.consoles.has(id)) this.consoles.set(id, { lines: [], dec: new SerialDecoder(), screen: [], gotOutput: false });
    return this.consoles.get(id);
  }

  selected() { return this.vms[this.sel] || null; }

  ensureClient() {
    const vm = this.selected();
    const shouldAttach = vm && (vm.state === "running" || vm.state === "paused");
    if (!shouldAttach) {
      if (this.client) { try { this.client.close(); } catch {} this.client = null; this.clientVmId = null; }
      return;
    }
    if (this.client && this.clientVmId === vm.id) return;
    if (this.client) { try { this.client.close(); } catch {} this.client = null; }
    try {
      const c = mgr.attach(vm);
      this.client = c;
      this.clientVmId = vm.id;
      c.on("event", m => this.onRunnerEvent(vm.id, m));
      c.on("close", () => {
        if (this.client === c) { this.client = null; this.clientVmId = null; this.draw(); }
      });
    } catch { /* not up yet */ }
  }

  onRunnerEvent(vmId, m) {
    if (!m.evt) return;
    const cs = this.consoleState(vmId);
    if (m.evt === "serial") {
      const chunk = Buffer.from(m.data, "base64").toString("latin1");
      cs.gotOutput = true;
      for (const op of cs.dec.push(chunk)) {
        if (op.type === "line") cs.lines.push(op.text);
        else if (op.type === "clear") cs.lines = [];
      }
      if (cs.lines.length > 800) cs.lines = cs.lines.slice(-800);
    } else if (m.evt === "screen") {
      // not pushed by runner; we poll
    } else if (m.evt === "state") {
      const vm = this.vms.find(v => v.id === vmId);
      if (vm) { vm.state = m.state; }
    } else if (m.evt === "snapshot-saved") {
      this.toast(`snapshot "${m.name}" saved`, "ok");
    } else if (m.evt === "snapshot-restored") {
      this.toast(`reverted to "${m.name}"`, "ok");
      const c = this.consoleState(vmId); c.lines = []; c.dec = new SerialDecoder();
    }
    if (vmId === this.selected()?.id) this.draw();
  }

  async pollStatus() {
    if (!this.client || !this.client.ready) return;
    try {
      const res = await this.client.request({ cmd: "status" });
      if (res.ok) { this.uptimeMs = res.uptimeMs || 0; if (this.selected()?.state === "running" || this.selected()?.state === "paused") this.draw(); }
    } catch {}
  }

  toast(text, kind = "info") {
    this.msg = { text, kind, until: Date.now() + 4500 };
    this.draw();
  }

  /* ---------------- actions ---------------- */
  async act(label, fn) {
    if (this.busy) return;
    this.busy = true;
    this.toast(label + "…", "info");
    try {
      await fn();
    } catch (e) {
      this.toast(e.message, "error");
    }
    this.busy = false;
    this.refreshVMs();
    this.draw();
  }

  doPowerOn() {
    const vm = this.selected();
    if (!vm) return;
    this.act(`powering on ${vm.name}`, async () => {
      if (vm.state === "suspended") await mgr.resumeVM(vm);
      else await mgr.startVM(vm);
      this.toast(`${vm.name} powered on`, "ok");
    });
  }

  doPowerOff() {
    const vm = this.selected();
    if (!vm) return;
    this.act(`powering off ${vm.name}`, async () => {
      await mgr.powerOffVM(vm);
      this.toast(`${vm.name} powered off`, "ok");
    });
  }

  doKill() {
    const vm = this.selected();
    if (!vm) return;
    this.act(`killing ${vm.name}`, async () => {
      await mgr.killVM(vm);
      this.toast(`${vm.name} forcibly powered off`, "warn");
    });
  }

  doSuspend() {
    const vm = this.selected();
    if (!vm) return;
    this.act(`suspending ${vm.name}`, async () => {
      await mgr.suspendVM(vm);
      this.toast(`${vm.name} suspended to disk`, "ok");
    });
  }

  doResume = () => this.doPowerOn();

  doReset() {
    const vm = this.selected();
    if (!vm) return;
    this.act(`resetting ${vm.name}`, async () => { await mgr.resetVM(vm); this.toast(`${vm.name} reset`, "ok"); });
  }

  doPauseToggle() {
    const vm = this.selected();
    if (!vm) return;
    const target = vm.state === "paused" ? false : true;
    this.act(target ? `pausing ${vm.name}` : `resuming ${vm.name} from pause`, async () => {
      await mgr.pauseVM(vm, target);
    });
  }

  doCreate(form) {
    this.act("creating VM", async () => {
      const vm = store.createVM({
        name: form.name.trim(),
        memMB: parseInt(form.mem, 10) || 64,
        diskMB: parseInt(form.disk, 10) || 0,
        floppy: form.media === "OmniOS floppy (bundled)" ? "omnios" :
                form.media === "custom floppy image" ? form.floppyPath.trim() : "none",
        cdrom: form.cdrom.trim() || null,
        guestOs: form.media.startsWith("OmniOS") ? "OmniOS 1.0" : "Other",
      });
      const i = this.vms.findIndex(v => v.id === vm.id);
      if (i < 0) { this.vms = mgr.statesOf(store.listVMs()); this.sel = this.vms.findIndex(v => v.id === vm.id); }
      this.toast(`VM "${vm.name}" created`, "ok");
    });
  }

  /* ---------------- keys ---------------- */
  onKey(ev) {
    const { key } = ev;
    if (this.mode === "help") { this.mode = "main"; this.draw(); return; }
    if (this.mode === "confirm") {
      if (key === "enter") { const fn = this.confirm.fn; this.mode = "main"; this.confirm = null; fn(); }
      else if (key === "esc" || key === "n" || key === "q") { this.mode = "main"; this.confirm = null; this.draw(); }
      return;
    }
    if (this.mode === "prompt") {
      if (key === "esc") { this.mode = "main"; this.prompt = null; this.draw(); return; }
      if (key === "enter") { const p = this.prompt; this.mode = "main"; const val = p.value; this.prompt = null; p.onSubmit(val); return; }
      if (key === "backspace") { this.prompt.value = this.prompt.value.slice(0, -1); this.draw(); return; }
      if (ev.text) { this.prompt.value += ev.text; this.draw(); return; }
      return;
    }
    if (this.mode === "newvm") { this.formKey(ev); return; }
    if (this.mode === "snaps") { this.snapsKey(ev); return; }

    // interactive console mode: everything goes to the guest
    if (this.interactive) {
      if (key === "esc") { this.interactive = false; this.draw(); return; }
      if (!this.client) { this.interactive = false; this.draw(); return; }
      let s = "";
      if (key === "enter") s = "\r";
      else if (key === "backspace") s = "\x7f";
      else if (key === "ctrl-c") s = "\x03";
      else if (key === "ctrl-q") s = "\x11";
      else if (key === "tab") s = "\t";
      else if (ev.text) s = ev.text;
      if (s) this.client.serialIn(s);
      return;
    }

    switch (key) {
      case "ctrl-c":
      case "ctrl-q":
      case "q": if (key === "ctrl-q" || key === "q") this.quit(); return;
      case "esc":
        if (this.focus === "console") { this.focus = "library"; this.draw(); }
        return;
      case "up": {
        if (this.focus === "library") { this.sel = (this.sel - 1 + this.vms.length) % Math.max(1, this.vms.length); this.ensureClient(); }
        else this.scrollBy(-3);
        this.draw();
        return;
      }
      case "down": {
        if (this.focus === "library") { this.sel = (this.sel + 1) % Math.max(1, this.vms.length); this.ensureClient(); }
        else this.scrollBy(3);
        this.draw();
        return;
      }
      case "pgup": this.scrollBy(-10); this.draw(); return;
      case "pgdn": this.scrollBy(10); this.draw(); return;
      case "tab":
        this.focus = this.focus === "library" ? "console" : "library";
        this.draw();
        return;
      case "enter":
        if (this.focus === "console") {
          if (this.client && this.selected()?.state !== "suspended") { this.interactive = true; this.scrollOffset = 0; this.draw(); }
        } else {
          this.doPowerOn();
        }
        return;
      case "p": this.doPowerOn(); return;
      case "o": this.doPowerOff(); return;
      case "x": this.doKill(); return;
      case "s": this.doSuspend(); return;
      case "e": this.doResume(); return;
      case "r": this.doReset(); return;
      case "u": this.doPauseToggle(); return;
      case "n": this.openNewVM(); return;
      case "k": this.openSnaps(); return;
      case "v":
        this.consoleMode = this.consoleMode === "serial" ? "vga" : "serial";
        this.draw();
        return;
      case "c": {
        const vm = this.selected();
        if (vm && vm.state === "off") {
          this.askPrompt(`Clone "${vm.name}" as:`, vm.name + "-clone", val => {
            this.act(`cloning ${vm.name}`, async () => {
              const c = store.cloneVM(vm);
              if (val && val.trim()) { c.name = store.sanitizeNamePublic ? store.sanitizeNamePublic(val) : val; store.saveVM(c); }
              this.toast(`cloned to "${c.name}"`, "ok");
            });
          });
        }
        return;
      }
      case "d": {
        const vm = this.selected();
        if (!vm) return;
        this.askConfirm(`Delete VM "${vm.name}" and all its disks?`, () => {
          this.act(`deleting ${vm.name}`, async () => {
            store.deleteVM(vm.id);
            this.refreshVMs();
            this.toast(`"${vm.name}" deleted`, "ok");
          });
        });
        return;
      }
      case "g": this.refreshVMs(); this.draw(); return;
      case "f1":
      case "h": this.mode = "help"; this.draw(); return;
      default: return;
    }
  }

  scrollBy(delta) {
    const cs = this.consoleState(this.selected()?.id);
    const rows = this.consoleMode === "serial" ? cs.lines : cs.screen;
    const maxOff = Math.max(0, rows.length - this.consoleHeight());
    this.scrollOffset = Math.min(maxOff, Math.max(0, (this.scrollOffset || 0) + delta));
  }

  quit() {
    clearInterval(this.timers[0]); clearInterval(this.timers[1]); clearInterval(this.timers[2]);
    if (this.client) try { this.client.close(); } catch {}
    this.screen.cleanup();
    process.exit(0);
  }

  /* ---------------- dialogs ---------------- */
  askConfirm(text, fn) {
    this.confirm = { text, fn };
    this.mode = "confirm";
    this.draw();
  }

  askPrompt(label, value, onSubmit) {
    this.prompt = { label, value, onSubmit };
    this.mode = "prompt";
    this.draw();
  }

  openNewVM() {
    this.form = {
      fields: ["name", "mem", "disk", "media", "floppyPath", "cdrom"],
      values: { name: "new-vm", mem: "64", disk: "0", media: "OmniOS floppy (bundled)", floppyPath: "", cdrom: "" },
      labels: { name: "Name", mem: "Memory (MB)", disk: "Disk (MB, 0=none)", media: "Floppy media", floppyPath: "Floppy image path", cdrom: "CD-ROM path (.iso)" },
      active: 0,
    };
    this.mode = "newvm";
    this.draw();
  }

  formKey(ev) {
    const f = this.form;
    const key = ev.key;
    if (key === "esc") { this.mode = "main"; this.form = null; this.draw(); return; }
    if (key === "up") { f.active = (f.active - 1 + f.fields.length) % f.fields.length; this.draw(); return; }
    if (key === "down" || key === "tab") { f.active = (f.active + 1) % f.fields.length; this.draw(); return; }
    const field = f.fields[f.active];
    if (field === "media") {
      if (key === "enter" || key === "right" || ev.text === " ") {
        const opts = ["OmniOS floppy (bundled)", "no floppy", "custom floppy image"];
        f.values.media = opts[(opts.indexOf(f.values.media) + 1) % opts.length];
        this.draw();
      }
      return;
    }
    if (key === "enter") {
      this.doCreate(f.values);
      this.mode = "main"; this.form = null; this.draw();
      return;
    }
    if (key === "backspace") { f.values[field] = f.values[field].slice(0, -1); this.draw(); return; }
    if (ev.text) { f.values[field] += ev.text; this.draw(); }
  }

  openSnaps() {
    const vm = this.selected();
    if (!vm) return;
    this.snaps = { vm, list: [], active: 0 };
    this.mode = "snaps";
    mgr.snapshot.list(vm).then(list => { this.snaps.list = list; this.draw(); }).catch(e => this.toast(e.message, "error"));
    this.draw();
  }

  snapsKey(ev) {
    const s = this.snaps;
    const key = ev.key;
    if (key === "esc" || key === "q") { this.mode = "main"; this.snaps = null; this.draw(); return; }
    if (key === "up") { s.active = Math.max(0, s.active - 1); this.draw(); return; }
    if (key === "down") { s.active = Math.min(s.list.length - 1, s.active + 1); this.draw(); return; }
    if (key === "t") {
      this.askPrompt("Snapshot name:", `snap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`, val => {
        this.act(`taking snapshot`, async () => {
          await mgr.snapshot.take(s.vm, val.trim() || "snapshot");
        });
      });
      return;
    }
    const cur = s.list[s.active];
    if (!cur) return;
    if (key === "r") {
      this.act(`reverting to ${cur.name}`, async () => { await mgr.snapshot.restore(s.vm, cur.name); });
      return;
    }
    if (key === "d") {
      this.askConfirm(`Delete snapshot "${cur.name}"?`, () => {
        this.act(`deleting snapshot`, async () => {
          await mgr.snapshot.delete(s.vm, cur.name);
          s.list.splice(s.active, 1);
          s.active = Math.max(0, Math.min(s.active, s.list.length - 1));
        });
      });
      return;
    }
  }

  /* ---------------- drawing ---------------- */
  layout() {
    const { w, h } = this.screen;
    const libW = Math.min(30, Math.max(20, Math.floor(w * 0.24)));
    const bodyY = 1, bodyH = h - 3;
    const sumH = Math.min(11, Math.max(7, Math.floor(bodyH * 0.42)));
    return { w, h, libW, bodyY, bodyH, sumH,
      sum: { x: libW, y: bodyY, w: w - libW, h: sumH },
      con: { x: libW, y: bodyY + sumH, w: w - libW, h: bodyH - sumH } };
  }

  consoleHeight() { return Math.max(1, this.layout().con.h - 2); }

  draw() {
    const S = this.screen;
    const L = this.layout();
    S.clear(style("white", "default"));
    this.drawHeader();
    this.drawLibrary(L);
    this.drawSummary(L);
    this.drawConsole(L);
    this.drawToolbar(L);
    this.drawStatus(L);
    if (this.mode === "help") this.drawHelp(L);
    if (this.mode === "confirm") this.drawConfirm(L);
    if (this.mode === "prompt") this.drawPrompt(L);
    if (this.mode === "newvm") this.drawNewVM(L);
    if (this.mode === "snaps") this.drawSnaps(L);
    S.render();
  }

  drawHeader() {
    const S = this.screen;
    const { w } = this.screen;
    S.fill(0, 0, w, 1, " ", ST.header);
    const title = " ◉ OmniVM Workstation ";
    S.text(0, 0, title, ST.header);
    const right = `library: ${store.homeDir().replace(process.env.HOME, "~")}  `;
    const rightText = right.length > w - title.length ? "" : right;
    S.text(Math.max(0, w - rightText.length - 1), 0, rightText, ST.headerDim);
  }

  drawLibrary(L) {
    const S = this.screen;
    const focused = this.focus === "library" && this.mode === "main";
    S.box(0, L.bodyY, L.libW, L.bodyH, {
      title: ` VM Library (${this.vms.length}) `,
      borderSt: focused ? ST.borderFocus : ST.border,
    });
    const innerW = L.libW - 2;
    let y = L.bodyY + 1;
    this.vms.forEach((vm, i) => {
      if (y > L.bodyY + L.bodyH - 2) return;
      const isSel = i === this.sel;
      const st = isSel ? ST.sel : ST.text;
      const icon = stateIcon(vm.state);
      S.text(1, y, " ", isSel ? ST.sel : style());
      S.text(2, y, icon, isSel ? ST.sel : stateSt(vm.state));
      S.textClipped(4, y, vm.name, isSel ? ST.sel : st, innerW - 4);
      // right-side mini state letter
      const tag = vm.state === "running" ? "ON" : vm.state === "suspended" ? "SUS" : vm.state === "paused" ? "PAU" : vm.state === "crashed" ? "ERR" : "OFF";
      S.text(L.libW - 5, y, tag, isSel ? ST.sel : (vm.state === "off" ? ST.dim : stateSt(vm.state)));
      y++;
    });
    if (!this.vms.length) {
      S.text(2, L.bodyY + 1, "no VMs yet", ST.dim);
      S.text(2, L.bodyY + 2, "press N to create", ST.dim);
    }
  }

  drawSummary(L) {
    const S = this.screen;
    const vm = this.selected();
    const focused = false;
    S.box(L.sum.x, L.sum.y, L.sum.w, L.sum.h, {
      title: vm ? ` Summary — ${vm.name} ` : " Summary ",
      borderSt: ST.border,
    });
    if (!vm) return;
    const w = L.sum.w - 4;
    const rows = [];
    const stateText = vm.state === "running" ? "Powered on" :
      vm.state === "suspended" ? "Suspended (state saved to disk)" :
      vm.state === "paused" ? "Paused" :
      vm.state === "crashed" ? "Crashed" : "Powered off";
    rows.push(["State", stateText, stateSt(vm.state)]);
    rows.push(["Guest OS", vm.guestOs || "-", ST.value]);
    rows.push(["Memory", `${store.fmtMB(vm.memMB)} (${vm.memMB} MB)`, ST.value]);
    rows.push(["Processors", `${vm.cpus} vCPU (software x86)`, ST.value]);
    rows.push(["Hard Disk", vm.diskMB > 0 ? `${store.fmtMB(vm.diskMB)} raw image` : "none", ST.value]);
    rows.push(["Floppy", vm.floppy ? (vm.floppy === store.BUNDLED_GUEST ? "OmniOS 1.0 (bundled)" : vm.floppy.replace(process.env.HOME, "~")) : "empty", ST.value]);
    rows.push(["CD-ROM", vm.cdrom ? vm.cdrom.replace(process.env.HOME, "~") : "empty", ST.value]);
    rows.push(["Boot order", vm.boot, ST.value]);
    if (L.sum.h >= 11) {
      rows.push(["Uptime", vm.state === "running" || vm.state === "paused" ? fmtUptime(this.uptimeMs) : "-", ST.value]);
      rows.push(["Created", (vm.created || "").slice(0, 10), ST.dim]);
    }
    let y = L.sum.y + 1;
    for (const [k, v, st] of rows.slice(0, L.sum.h - 2)) {
      S.text(L.sum.x + 2, y, k.padEnd(11), ST.dim);
      S.textClipped(L.sum.x + 13, y, String(v), st, w - 11);
      y++;
    }
  }

  drawConsole(L) {
    const S = this.screen;
    const vm = this.selected();
    const conFocused = this.focus === "console" && this.mode === "main";
    const titleBits = [];
    titleBits.push(this.consoleMode === "serial" ? "Serial Console (COM1)" : "Console — VGA text screen");
    if (this.interactive) titleBits.push("interactive — Esc to detach");
    let borderSt = ST.border;
    if (this.interactive) borderSt = ST.borderWarn;
    else if (conFocused) borderSt = ST.borderFocus;
    S.box(L.con.x, L.con.y, L.con.w, L.con.h, { title: ` ${titleBits.join(" · ")} `, borderSt });
    if (!vm) return;
    const cs = this.consoleState(vm.id);
    const innerW = L.con.w - 4;
    const rows = this.consoleMode === "serial" ? cs.lines : cs.screen;
    const viewH = L.con.h - 2;

    if (vm.state !== "running" && vm.state !== "paused") {
      const msg = vm.state === "suspended" ? "VM is suspended — press E to resume"
        : vm.state === "crashed" ? "VM crashed — see run/error.log"
        : "VM is powered off — press P to power on";
      S.text(L.con.x + 3, L.con.y + Math.floor(viewH / 2), msg, ST.dim);
      return;
    }
    if (this.consoleMode === "vga" && this.client?.ready) {
      const now = Date.now();
      if (!this._vgaPending && now - (this._lastVgaReq || 0) > 500) {
        this._vgaPending = true;
        this._lastVgaReq = now;
        this.client.request({ cmd: "screen" }).then(res => {
          this._vgaPending = false;
          if (res.ok && res.rows) {
            cs.screen = res.rows;
            if (this.consoleMode === "vga") this.draw();
          }
        }).catch(() => { this._vgaPending = false; });
      }
    }
    if (this.consoleMode === "serial" && !cs.gotOutput) {
      S.text(L.con.x + 3, L.con.y + 1, "waiting for guest output… (BIOS/POST)", ST.dim);
    }
    const h = viewH - (this.consoleMode === "serial" && !cs.gotOutput ? 1 : 0);
    const visible = this.scrollOffset
      ? rows.slice(Math.max(0, rows.length - this.scrollOffset - h), rows.length - this.scrollOffset)
      : rows.slice(-Math.max(1, h));
    let y = L.con.y + 1 + (this.consoleMode === "serial" && !cs.gotOutput ? 1 : 0);
    for (const line of visible) {
      S.textClipped(L.con.x + 2, y, line, ST.consoleText, innerW);
      y++;
      if (y > L.con.y + L.con.h - 2) break;
    }
    if (this.interactive) {
      const hint = "▌";
      S.text(L.con.x + L.con.w - 3, L.con.y + L.con.h - 2, hint, ST.warn);
    }
  }

  drawToolbar(L) {
    const S = this.screen;
    const vm = this.selected();
    S.fill(0, L.h - 2, L.w, 1, " ", style());
    const btn = (key, label, on) => ({ key, label, on });
    const running = vm && (vm.state === "running" || vm.state === "paused");
    const suspended = vm && vm.state === "suspended";
    const off = !vm || vm.state === "off" || vm.state === "crashed";
    const btns = [
      btn("P", "Power On", off || suspended),
      btn("O", "Power Off", running),
      btn("X", "Kill", running),
      btn("S", "Suspend", running && vm.state === "running"),
      btn("E", "Resume", suspended),
      btn("R", "Reset", running),
      btn("U", vm?.state === "paused" ? "Unpause" : "Pause", running),
      btn("K", "Snapshots", true),
      btn("N", "New VM", true),
      btn("V", this.consoleMode === "serial" ? "VGA View" : "Serial View", running),
      btn("F1", "Help", true),
    ];
    let x = 1;
    for (const b of btns) {
      const label = ` ${b.key}:${b.label} `;
      const st = b.on ? ST.bar : ST.barDim;
      if (x + label.length > L.w) break;
      S.text(x, L.h - 2, label, st);
      x += label.length + 1;
    }
  }

  drawStatus(L) {
    const S = this.screen;
    const { w, h } = this.screen;
    S.fill(0, h - 1, w, 1, " ", ST.bar);
    const vm = this.selected();
    let left = vm ? `${vm.name} — ${vm.state}` : "no VM selected";
    if (this.busy) left += "  ·  working…";
    S.text(1, h - 1, left.slice(0, w - 40), ST.bar);
    const right = `${this.vms.length} VM(s) · Tab focus · Enter console · Ctrl-Q quit`;
    S.text(Math.max(1, w - right.length - 1), h - 1, right, ST.barDim);
    if (this.msg) {
      const st = this.msg.kind === "error" ? ST.err : this.msg.kind === "ok" ? ST.ok : this.msg.kind === "warn" ? ST.warn : ST.bright;
      S.text(2, h - 2, this.msg.text.slice(0, w - 4), st);
    } else if (this.focus === "console" && !this.interactive) {
      S.text(2, h - 2, "console focused: ↑↓/PgUp/PgDn scrollback · Enter = interact · V = view", ST.dim);
    }
  }

  drawHelp(L) {
    const S = this.screen;
    const w = Math.min(74, L.w - 4), h = 21;
    const x = Math.floor((L.w - w) / 2), y = Math.floor((L.h - h) / 2);
    S.fill(x, y, w, h, " ", style("white", "blue", { reverse: false }));
    S.box(x, y, w, h, { title: " OmniVM Workstation — Help ", borderSt: style("brightblue"), titleSt: ST.title });
    const lines = [
      ["↑ / ↓", "select VM in library · scroll console"],
      ["Tab", "move focus: library ↔ console"],
      ["Enter", "library: power on · console: interactive mode"],
      ["P / O / X", "power on / power off / power off (force)"],
      ["S / E", "suspend to disk / resume"],
      ["R / U", "hard reset / pause & unpause"],
      ["N", "new VM wizard"],
      ["C / D", "clone VM / delete VM"],
      ["K", "snapshot manager (T take · R revert · D delete)"],
      ["V", "console view: serial (COM1) ↔ VGA text screen"],
      ["Esc", "leave interactive console / close dialogs"],
      ["F1 or H", "this help"],
      ["Ctrl-Q", "quit OmniVM"],
      ["", ""],
      ["Guest tip", "OmniOS bundled guest: log in at the console and type help"],
    ];
    let yy = y + 1;
    for (const [k, v] of lines) {
      S.text(x + 2, yy, k.padEnd(11), ST.key);
      S.textClipped(x + 14, yy, v, ST.text, w - 16);
      yy++;
    }
    S.text(x + 2, y + h - 1, " any key to close ", ST.dim);
  }

  drawConfirm(L) {
    const S = this.screen;
    const w = Math.min(56, L.w - 6), h = 7;
    const x = Math.floor((L.w - w) / 2), y = Math.floor((L.h - h) / 2);
    S.fill(x, y, w, h, " ", style("brightwhite", "red"));
    S.box(x, y, w, h, { title: " Confirm ", borderSt: style("brightred"), titleSt: ST.err });
    S.textClipped(x + 2, y + 2, this.confirm.text, ST.bright, w - 4);
    S.text(x + 2, y + h - 2, "Enter = yes   Esc/N = no", ST.warn);
  }

  drawPrompt(L) {
    const S = this.screen;
    const w = Math.min(60, L.w - 6), h = 7;
    const x = Math.floor((L.w - w) / 2), y = Math.floor((L.h - h) / 2);
    S.fill(x, y, w, h, " ", style());
    S.box(x, y, w, h, { title: " Input ", borderSt: ST.borderFocus });
    S.textClipped(x + 2, y + 2, this.prompt.label, ST.text, w - 4);
    S.text(x + 2, y + 4, "> " + this.prompt.value + "▌", ST.value);
    S.text(x + w - 20, y + h - 2, "Enter = ok · Esc = cancel", ST.dim);
  }

  drawNewVM(L) {
    const S = this.screen;
    const f = this.form;
    const w = Math.min(64, L.w - 4), h = 12;
    const x = Math.floor((L.w - w) / 2), y = Math.floor((L.h - h) / 2);
    S.fill(x, y, w, h, " ", style());
    S.box(x, y, w, h, { title: " New Virtual Machine ", borderSt: ST.borderFocus });
    let yy = y + 1;
    f.fields.forEach((field, i) => {
      const active = i === f.active;
      const label = f.labels[field];
      let val = f.values[field];
      if (field === "media") val = `< ${val} > (space to change)`;
      S.text(x + 2, yy, label.padEnd(17), active ? ST.key : ST.dim);
      const valSt = active ? ST.sel : ST.value;
      S.textClipped(x + 20, yy, val || (field === "media" ? "" : ""), valSt, w - 24);
      yy++;
    });
    S.text(x + 2, y + h - 2, "↑↓ fields · type to edit · Enter = create · Esc = cancel", ST.dim);
  }

  drawSnaps(L) {
    const S = this.screen;
    const s = this.snaps;
    const w = Math.min(62, L.w - 4), h = Math.min(14, L.h - 4);
    const x = Math.floor((L.w - w) / 2), y = Math.floor((L.h - h) / 2);
    S.fill(x, y, w, h, " ", style());
    S.box(x, y, w, h, { title: ` Snapshots — ${s.vm.name} `, borderSt: ST.borderFocus });
    if (!s.list.length) S.text(x + 3, y + 2, "no snapshots yet — press T to take one", ST.dim);
    s.list.forEach((snap, i) => {
      const yy = y + 2 + i;
      if (yy > y + h - 4) return;
      const st = i === s.active ? ST.sel : ST.text;
      S.text(x + 2, yy, i === s.active ? "▸" : " ", st);
      S.textClipped(x + 4, yy, snap.name.padEnd(22), st, 24);
      S.textClipped(x + 28, yy, new Date(snap.mtime).toLocaleString(), i === s.active ? ST.selDim : ST.dim, w - 30);
    });
    S.text(x + 2, y + h - 2, "T take · R revert · D delete · ↑↓ select · Esc close", ST.dim);
  }
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

process.on("exit", () => { try { process.stdout.write("\x1b[?25h\x1b[0m\x1b[?1049l"); } catch {} });
