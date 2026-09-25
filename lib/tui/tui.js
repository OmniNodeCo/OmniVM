/* Mini TUI framework for OmniVM: cell-buffer screen with diff rendering,
 * ANSI key decoding. Zero dependencies. */

const FG = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34,
  magenta: 35, cyan: 36, white: 37, default: 39,
  gray: 90, brightred: 91, brightgreen: 92, brightyellow: 93,
  brightblue: 94, brightmagenta: 95, brightcyan: 96, brightwhite: 97,
};
const BG = {
  black: 40, red: 41, green: 42, yellow: 43, blue: 44,
  magenta: 45, cyan: 46, white: 47, default: 49,
  gray: 100, darkblue: 104,
};

const styleCache = new Map();
export function style(fg = "default", bg = "default", o = {}) {
  const key = `${fg}|${bg}|${o.bold ? 1 : 0}|${o.dim ? 1 : 0}|${o.reverse ? 1 : 0}`;
  if (styleCache.has(key)) return styleCache.get(key);
  let codes = [];
  if (typeof fg === "number") codes.push(`38;5;${fg}`); else codes.push(FG[fg] ?? 39);
  if (typeof bg === "number") codes.push(`48;5;${bg}`); else codes.push(BG[bg] ?? 49);
  if (o.bold) codes.push(1);
  if (o.dim) codes.push(2);
  if (o.reverse) codes.push(7);
  const s = `\x1b[${codes.join(";")}m`;
  styleCache.set(key, s);
  return s;
}
export const RESET = "\x1b[0m";

export const BORDER = {
  tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
  ml: "├", mr: "┤", mt: "┬", mb: "┴",
};

export class Screen {
  constructor({ onKey, onResize } = {}) {
    this.onKey = onKey;
    this.onResize = onResize;
    this.out = process.stdout;
    this.in = process.stdin;
    this.w = this.out.columns || 80;
    this.h = this.out.rows || 24;
    this.cells = [];      // rows of {ch, st}
    this.prev = [];
    this._flushTimer = null;
    this._escBuf = "";
    this._closed = false;
  }

  start() {
    this.in.setRawMode(true);
    this.in.resume();
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    this.in.on("data", d => this._decode(d.toString("utf8")));
    this.out.on("resize", () => this._resize());
    this._resize();
  }

  cleanup() {
    if (this._closed) return;
    this._closed = true;
    try { this.in.setRawMode(false); } catch {}
    this.out.write("\x1b[?25h\x1b[0m\x1b[?1049l");
    this.in.pause();
  }

  _resize() {
    this.w = this.out.columns || 80;
    this.h = this.out.rows || 24;
    this.prev = []; // force full redraw
    if (this.onResize) this.onResize(this.w, this.h);
    this.render();
  }

  _decode(data) {
    // combine escape sequences that arrive split
    if (this._escBuf) {
      data = this._escBuf + data;
      this._escBuf = "";
    }
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b") {
        const rest = data.slice(i);
        const m = rest.match(/^(\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[a-zA-Z0-9])/);
        if (!m) { if (rest.length === 1) this._emit({ key: "esc" }); else this._escBuf = rest; break; }
        const seq = m[0];
        i += seq.length;
        const key = KEYMAP[seq];
        if (key) this._emit({ key });
        continue;
      }
      if (ch === "\r") { this._emit({ key: "enter" }); i++; continue; }
      if (ch === "\n") { i++; continue; }
      if (ch === "\t") { this._emit({ key: "tab" }); i++; continue; }
      if (ch === "\x7f") { this._emit({ key: "backspace" }); i++; continue; }
      if (ch === "\x03") { this._emit({ key: "ctrl-c" }); i++; continue; }
      if (ch === "\x11") { this._emit({ key: "ctrl-q" }); i++; continue; }
      if (ch < " ") { i++; continue; }
      // printable run — emit each char as its own key event so single-key
      // hotkeys (P, S, K...) work, with text attached for text input fields
      let j = i;
      while (j < data.length && data[j] >= " ") j++;
      for (let k = i; k < j; k++) this._emit({ key: data[k], text: data[k] });
      i = j;
    }
  }

  _emit(ev) { if (this.onKey && !this._closed) this.onKey(ev); }

  /* ---- drawing ---- */
  clear(styleStr = style("default", "default")) {
    this.cells = [];
    for (let y = 0; y < this.h; y++) {
      const row = new Array(this.w);
      for (let x = 0; x < this.w; x++) row[x] = { ch: " ", st: styleStr };
      this.cells.push(row);
    }
  }

  ensure() {
    if (!this.cells.length) this.clear();
  }

  text(x, y, str, st = style()) {
    this.ensure();
    if (y < 0 || y >= this.h) return;
    for (let i = 0; i < str.length; i++) {
      const cx = x + i;
      if (cx < 0 || cx >= this.w) continue;
      this.cells[y][cx] = { ch: str[i], st };
    }
  }

  textClipped(x, y, str, st, width) {
    if (str.length > width) str = str.slice(0, width - 1) + "…";
    this.text(x, y, str, st);
  }

  fill(x, y, w, h, ch = " ", st = style()) {
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.h) continue;
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= this.w) continue;
        this.cells[yy][xx] = { ch, st };
      }
    }
  }

  box(x, y, w, h, { title = "", borderSt = style("blue"), titleSt = null } = {}) {
    this.ensure();
    if (h < 2 || w < 2) return;
    for (let i = 1; i < w - 1; i++) {
      this.text(x + i, y, BORDER.h, borderSt);
      this.text(x + i, y + h - 1, BORDER.h, borderSt);
    }
    for (let j = 1; j < h - 1; j++) {
      this.text(x, y + j, BORDER.v, borderSt);
      this.text(x + w - 1, y + j, BORDER.v, borderSt);
    }
    this.text(x, y, BORDER.tl, borderSt);
    this.text(x + w - 1, y, BORDER.tr, borderSt);
    this.text(x, y + h - 1, BORDER.bl, borderSt);
    this.text(x + w - 1, y + h - 1, BORDER.br, borderSt);
    if (title) {
      const t = ` ${title} `;
      const tx = x + Math.floor((w - t.length) / 2);
      this.text(tx - 1, y, " ", borderSt);
      this.text(tx + t.length, y, " ", borderSt);
      this.text(tx, y, t, titleSt || style("brightwhite", "default", { bold: true }));
    }
  }

  /* ---- diff render ---- */
  render() {
    if (!this.cells.length || this._closed) return;
    let out = "";
    let lastSt = null;
    for (let y = 0; y < this.h; y++) {
      const cur = this.cells[y];
      const prv = this.prev[y];
      let x = 0;
      while (x < this.w) {
        const c = cur[x];
        const p = prv && prv[x];
        if (p && p.ch === c.ch && p.st === c.st) { x++; continue; }
        out += `\x1b[${y + 1};${x + 1}H`;
        while (x < this.w) {
          const cc = cur[x];
          const pp = prv && prv[x];
          if (pp && pp.ch === cc.ch && pp.st === cc.st) break;
          if (cc.st !== lastSt) { out += cc.st; lastSt = cc.st; }
          out += cc.ch;
          x++;
        }
      }
    }
    this.prev = this.cells.map(r => r.slice());
    if (out) this.out.write(out);
  }
}

const KEYMAP = {
  "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
  "\x1b[H": "home", "\x1b[F": "end", "\x1b[1~": "home", "\x1b[4~": "end",
  "\x1b[5~": "pgup", "\x1b[6~": "pgdn",
  "\x1bOP": "f1", "\x1bOQ": "f2", "\x1bOR": "f3", "\x1bOS": "f4",
  "\x1b[11~": "f1", "\x1b[12~": "f2", "\x1b[13~": "f3", "\x1b[14~": "f4", "\x1b[15~": "f5",
  "\x1b[Z": "shift-tab",
  "\x1b": "esc",
};
