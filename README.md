# OmniVM Workstation

```
      _  _  __    __  __ ___ ____
     | || |/__\ |  \/  |_ _|_  /
     | __ / _ \| |\/| || | / /
     |_||_\___/|_|  |_|___/___|
```

**Run virtual machines from your terminal.** OmniVM is a VMware
Workstation–style VM manager that lives entirely in the console — no HTML, no
Python, no GUI toolkit. Pure Node.js.

It ships with a complete virtualization stack:

| Layer        | What it is                                                            |
|--------------|-----------------------------------------------------------------------|
| **Engine**   | [v86](https://github.com/copy/v86) — a full x86 PC emulator (WASM JIT): CPU, BIOS, VGA, PIC/PIT, UART, floppy/IDE/CD controllers |
| **Manager**  | VM lifecycle processes ("runners") with a control socket — VMs keep running when you close the window, like VMware |
| **OmniOS**   | A bundled guest operating system written in x86 assembly (boot sector + kernel with a working shell), built from source in this repo |
| **UI**       | A hand-rolled, flicker-free terminal UI (TUI) + full CLI               |

```console
$ npm install
$ ./bin/omnivm
```

---

## Features

- **VM library** — create, clone, rename, delete VMs; live state (powered on /
  off / suspended / paused / crashed) at a glance
- **Power management** — power on, power off (flushes guest disks), force
  kill, hard reset, **suspend to disk & resume** (exact machine state, like
  VMware's suspend), pause/unpause the CPU
- **Live console** — attach to the guest's serial console (COM1) and *type
  into the running OS*, or flip to the **VGA text screen** view
- **Snapshots** — take live snapshots of machine state, revert, delete —
  even while the VM keeps running
- **Virtual hardware** — configurable memory, raw hard-disk images, floppy
  drives (including the bundled OmniOS live floppy), CD-ROM (`.iso`) with
  boot-order selection
- **Detached execution** — each VM runs in its own process; close the TUI and
  the VM keeps running; reattach any time from any terminal
- **Zero services required** — software emulation means it runs anywhere
  Node runs: no `/dev/kvm`, no hypervisor, no root

## Quick start

**Option A — standalone executable (no Node needed):** grab an archive from
the [Releases](../../releases) page — `omnivm-<version>-<os>-<arch>` for
Linux (tar.gz), macOS and Windows (zip) — extract and run the `omnivm`
binary inside. Everything (runtime, x86 emulator, BIOS, OmniOS guest) is
embedded in that one file.

**Option B — from source:**

```console
# 1. install (only dependency: the v86 engine)
$ npm install

# 2. sanity-check the installation
$ ./bin/omnivm doctor

# 3. create a VM with the bundled OmniOS guest
$ ./bin/omnivm create my-first-vm

# 4. power it on and open the console
$ ./bin/omnivm start my-first-vm
$ ./bin/omnivm console my-first-vm

omni> sysinfo
--- System Information ---
OS      : OmniOS 1.0.0 (OmniVM guest tools)
CPU     : GenuineIntel
...

# 5. or just live in the UI
$ ./bin/omnivm
```

VMs are stored in `~/.omnivm/vms/<id>/` (`vm.json` config, `disks/`,
`snapshots/`, `run/`). Override with `OMNIVM_HOME`.

### Building the executables yourself

CI builds every target (Linux x64/arm64, macOS Apple Silicon, Windows x64) on every push to `main`
(`.github/workflows/build.yml`) and attaches archives to GitHub Releases on
`v*` tags (`.github/workflows/release.yml`). Locally:

```console
$ npm install
$ node scripts/build.mjs        # builds for THIS platform
# -> dist/omnivm-v<version>-<os>-<arch>.(tar.gz|zip)
```

Under the hood it uses Node's official
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
support: esbuild bundles the app to one CJS file, the BIOS ROMs / OmniOS
floppy / v86 WASM engine are embedded as SEA assets (`sea-config.json`), and
the blob is injected into a copy of the node binary with postject.

CI artifacts are a single zip of the unpacked bundle (no nested archives);
the release archives (`tar.gz`/`zip`) are assembled once in `release.yml`,
which also restores the executable bit the artifact store strips.

## The Workstation UI

```console
$ ./bin/omnivm
```

```
 ◉ OmniVM Workstation                        library: ~/.omnivm
┌──────────────┐ ┌  Summary — web-demo  ──────────────────────┐
│ VM Library   │ │ State      Powered on                      │
│ ● web-demo ON│ │ Guest OS   OmniOS 1.0                      │
│ ○ alpine-lab │ │ Memory     64 MB (64 MB)                   │
│ ○ legacy     │ │ Processors 1 vCPU (software x86)           │
│              │ │ Hard Disk  32 MB raw image                 │
│              │ ├  Serial Console (COM1) · interactive ──────┤
│              │ │ omni> uptime                               │
│              │ │ Uptime          : 00:01:42                 │
│              │ │ omni> ▌                                    │
└──────────────┘ └────────────────────────────────────────────┘
 P:Power On O:Power Off X:Kill S:Suspend E:Resume R:Reset U:Pause K:Snaps…
 web-demo — running          3 VM(s) · Tab focus · Enter console · Ctrl-Q quit
```

**Keys**

| Key            | Action                                            |
|----------------|---------------------------------------------------|
| `↑`/`↓`        | select VM · scroll console back                    |
| `Tab`          | focus: library ↔ console                           |
| `Enter`        | library: power on · console: interactive typing    |
| `P` / `O` / `X`| power on / power off / power off (force)           |
| `S` / `E`      | suspend to disk / resume                           |
| `R` / `U`      | hard reset / pause–unpause                         |
| `N`            | new VM wizard                                      |
| `C` / `D`      | clone / delete                                     |
| `K`            | snapshot manager (`T` take · `R` revert · `D` del) |
| `V`            | console view: serial ↔ VGA text screen             |
| `Esc`          | detach from interactive console / close dialogs    |
| `F1` or `H`    | help                                               |
| `Ctrl-Q`       | quit (VMs keep running)                            |

## CLI reference

```
omnivm list                          list VMs and states
omnivm create <name> [--mem 64] [--disk 0] [--floppy omnios|none|path]
                 [--cdrom file.iso] [--boot floppy|disk|cdrom] [--guest label]
omnivm config <vm> [--mem 128] [--floppy ...] [--cdrom ...] [--boot ...]
omnivm start|stop|kill|suspend|resume|reset|pause|unpause <vm>
omnivm console <vm>                  attach serial console (Ctrl-] detaches)
omnivm screen <vm>                   dump the guest VGA text screen
omnivm snapshot <vm> take <n> | list | revert <n> | delete <n>
omnivm clone <vm> [newname]
omnivm delete <vm>
omnivm status [vm] · doctor · version · help
```

## OmniOS — the bundled guest

`guests/omnios/` contains a complete, tiny operating system written in x86
assembly (GNU `as`, `.code16`), built to a 1.44 MB bootable floppy:

- boot sector with CHS-aware floppy loader and retries
- COM1 serial console (115200 8N1) mirrored to the VGA text screen
- interactive shell: `help`, `ver`, `echo`, `cls`, `mem`, `cpu`, `uptime`,
  `time`, `sysinfo`, `banner`, `reboot`, `halt`
- line editing (backspace, Ctrl-U, Ctrl-C), hand-rolled 32÷16-bit division
  for uptime, CPUID reporting, RTC reads

Rebuild it (requires `binutils`):

```console
$ make -C guests/omnios        # -> guests/omnios/omnios.img
```

## How it works

```
┌────────────────────────────── OmniVM (Node.js) ───────────────────────────┐
│                                                                           │
│  bin/omnivm ──► lib/cli.js ──► lib/tui/*  (Workstation TUI)               │
│                        │              │                                   │
│                        │              │ NDJSON over unix control socket    │
│                        ▼              ▼  (serial bytes, screen, commands) │
│                   lib/manager.js ── spawns/detaches ──┐                   │
│                                                       ▼                   │
│                                              lib/runner.js (per-VM proc)  │
│                                              ┌─────────────────────────┐  │
│                                              │ v86 engine (x86 on WASM)│  │
│                                              │ SeaBIOS · VGA · UART    │  │
│                                              │ floppy · IDE · CD-ROM   │  │
│                                              └───────────┬─────────────┘  │
│                                                          ▼                │
│                                              OmniOS guest (omnios.img)    │
└───────────────────────────────────────────────────────────────────────────┘
```

- **One process per VM.** `omnivm start` spawns a detached runner hosting the
  emulator. Clients (TUI, CLI, `console`) attach to its unix control socket —
  so VMs outlive the terminal that started them.
- **State is real.** Suspend saves the machine state (CPU registers, RAM,
  devices) to `run/suspend.v86s`; resume loads it byte-for-byte. Snapshots
  are the same mechanism, kept under `snapshots/`.
- **Disks persist.** Guest writes accumulate in the emulator's image buffers
  and are flushed back to `disks/hda.img` on power-off, suspend and
  snapshots. The bundled OmniOS floppy is read-only media (like a live CD).

## Tests

```console
$ npm test        # end-to-end: boots a real VM, drives the console,
                  # snapshots, suspends, resumes, powers off
```

## Honest limitations

- **Software emulation** (no KVM): expect roughly 486-class throughput —
  perfect for OmniOS and small DOS-era guests, not for booting modern Linux.
- **1 vCPU** per VM (the engine is single-core).
- **No guest networking yet** — the NIC device exists in the emulator but no
  relay backend is wired up.
- Console is serial-first; guests that don't speak on COM1 will show a blank
  serial view (use `V` for their VGA screen).

## Project layout

```
bin/omnivm.js          entry point
lib/cli.js             command-line interface
lib/store.js           VM registry & disk/image paths
lib/assets.js          asset resolution (repo files or SEA-embedded)
lib/manager.js         lifecycle, control-socket client, attach/console
lib/runner.js          per-VM runner process (v86 host + control server)
lib/protocol.js        NDJSON framing
lib/tui/tui.js         terminal screen: cell buffer, diff rendering, keys
lib/tui/app.js         the Workstation UI
guests/omnios/         bundled guest OS (assembly source + Makefile + image)
vendor/bios/           SeaBIOS + VGABIOS (vendored, see vendor/bios/README)
scripts/build.mjs      single-file executable builder (Node SEA + postject)
sea-config.json        SEA manifest: entry + embedded assets
.github/workflows/     build.yml (all-platform executables) · release.yml
test/smoke.js          end-to-end lifecycle test
```

## Credits

- [v86](https://github.com/copy/v86) by Fabian Hemmer (copy) — the x86
  emulator engine, BSD-2-Clause.
- [SeaBIOS](https://www.seabios.org) & VGABIOS — vendored binaries in
  `vendor/bios/`, LGPLv3 (see `vendor/bios/README.md`).

Licensed under the MIT License (see `LICENSE`).
