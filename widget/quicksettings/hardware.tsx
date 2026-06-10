import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync } from "ags/process"
import { readFile } from "ags/file"
import { createPoll } from "ags/time"
import { Accessor } from "gnim"

interface HwStats {
  cpu: number // 0..1
  memUsed: number // bytes
  memTotal: number // bytes
  diskUsed: number // bytes
  diskTotal: number // bytes
  temp: number | null // °C
  rx: number // bytes/s
  tx: number // bytes/s
}

// Locate the CPU package temperature sensor once. hwmon numbering isn't stable
// across boots, so match by name (coretemp/k10temp/…) rather than a fixed index.
function findCpuTempPath(): string | null {
  for (let i = 0; i < 20; i++) {
    const base = `/sys/class/hwmon/hwmon${i}`
    try {
      const name = readFile(`${base}/name`).trim()
      if (["coretemp", "k10temp", "zenpower", "cpu_thermal"].includes(name)) {
        return `${base}/temp1_input`
      }
    } catch {
      // gap in the numbering — keep scanning
    }
  }
  return null
}

function field(text: string, re: RegExp): number {
  const m = text.match(re)
  return m ? Number(m[1]) : 0
}

function fmtGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

function fmtRate(bps: number): string {
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${Math.round(bps)} B/s`
}

// Icon glyphs. RAM and the temperature levels come from the user's MyFont
// (contiguous block ram=U+408E, temp=U+408F–U+4093). CPU and Disk use Font
// Awesome glyphs from a Nerd Font (microchip U+F2DB, hdd U+F0A0) — written as \u
// escapes since the raw glyphs don't survive transfer. Their font is set via the
// `nerd`/`disk` classes in style.scss; the rest render in MyFont.
const GLYPH_CPU = "\uf2db"
const GLYPH_RAM = "䂎"
// Cold → hot. Reorder if the thermometer fill looks inverted.
const GLYPH_TEMP = ["䂏", "䂐", "䂑", "䂒", "䂓"]
const GLYPH_DISK = "\uf0a0"

function tempGlyph(t: number | null): string {
  if (t == null || t < 45) return GLYPH_TEMP[0]
  if (t < 55) return GLYPH_TEMP[1]
  if (t < 65) return GLYPH_TEMP[2]
  if (t < 75) return GLYPH_TEMP[3]
  return GLYPH_TEMP[4]
}

// A metric row. The leading mark is either a glyph label (cpu/ram/disk/temp) or
// a themed symbolic icon (network). `glyphClass` switches the glyph's font, e.g.
// "nerd"/"disk" for the Nerd Font marks.
function StatRow(props: {
  glyph?: string | Accessor<string>
  glyphClass?: string
  iconName?: string
  label: string
  level?: Accessor<number>
  value: Accessor<string>
}) {
  return (
    <box cssName="hw-row" spacing={10}>
      {props.glyph !== undefined ? (
        <label cssName="hw-glyph" class={props.glyphClass ?? ""} label={props.glyph} />
      ) : (
        <image cssName="hw-icon" iconName={props.iconName} />
      )}
      <label cssName="hw-label" label={props.label} />
      {props.level ? (
        <Gtk.LevelBar hexpand valign={Gtk.Align.CENTER} value={props.level} />
      ) : (
        <box hexpand />
      )}
      <label cssName="hw-value" label={props.value} halign={Gtk.Align.END} />
    </box>
  )
}

// Live hardware readout (CPU / RAM / disk / temperature / network) plus a button
// that opens btop in a kitty terminal. All sampled from /proc and /sys (disk via
// Gio) — no external tools; CPU and network are delta-based across poll ticks.
export function HardwareInfo(props: { onClose: () => void }) {
  const tempPath = findCpuTempPath()
  // Previous samples for delta-based rates, held across poll ticks.
  let prevCpu: { total: number; idle: number } | null = null
  let prevNet: { rx: number; tx: number; t: number } | null = null

  const stats = createPoll<HwStats>(
    { cpu: 0, memUsed: 0, memTotal: 1, diskUsed: 0, diskTotal: 1, temp: null, rx: 0, tx: 0 },
    2000,
    () => {
      // CPU: aggregate jiffies from the first /proc/stat line.
      const cpuNums = readFile("/proc/stat")
        .split("\n")[0]
        .trim()
        .split(/\s+/)
        .slice(1)
        .map(Number)
      const cpuTotal = cpuNums.reduce((s, n) => s + n, 0)
      const cpuIdle = (cpuNums[3] || 0) + (cpuNums[4] || 0) // idle + iowait
      let cpu = 0
      if (prevCpu) {
        const dt = cpuTotal - prevCpu.total
        const di = cpuIdle - prevCpu.idle
        if (dt > 0) cpu = Math.min(1, Math.max(0, 1 - di / dt))
      }
      prevCpu = { total: cpuTotal, idle: cpuIdle }

      // Memory.
      const mem = readFile("/proc/meminfo")
      const memTotal = field(mem, /MemTotal:\s+(\d+)/) * 1024
      const memAvail = field(mem, /MemAvailable:\s+(\d+)/) * 1024
      const memUsed = Math.max(0, memTotal - memAvail)

      // Disk: usage of the root filesystem, via Gio (no subprocess).
      let diskUsed = 0
      let diskTotal = 1
      try {
        const fsinfo = Gio.File.new_for_path("/").query_filesystem_info(
          "filesystem::size,filesystem::used,filesystem::free",
          null,
        )
        diskTotal = Number(fsinfo.get_attribute_uint64("filesystem::size")) || 1
        const used = Number(fsinfo.get_attribute_uint64("filesystem::used"))
        const free = Number(fsinfo.get_attribute_uint64("filesystem::free"))
        diskUsed = used || Math.max(0, diskTotal - free)
      } catch (e) {
        console.error("disk:", String(e))
      }

      // Temperature.
      let temp: number | null = null
      if (tempPath) {
        try {
          temp = parseInt(readFile(tempPath).trim(), 10) / 1000
        } catch {
          temp = null
        }
      }

      // Network: sum every interface except loopback, then per-second delta.
      let rxBytes = 0
      let txBytes = 0
      for (const line of readFile("/proc/net/dev").split("\n").slice(2)) {
        const f = line.replace(":", " ").trim().split(/\s+/)
        if (f.length < 10 || f[0] === "lo" || f[0] === "") continue
        rxBytes += Number(f[1])
        txBytes += Number(f[9])
      }
      const now = GLib.get_monotonic_time() // µs
      let rx = 0
      let tx = 0
      if (prevNet) {
        const dts = (now - prevNet.t) / 1e6
        if (dts > 0) {
          rx = Math.max(0, (rxBytes - prevNet.rx) / dts)
          tx = Math.max(0, (txBytes - prevNet.tx) / dts)
        }
      }
      prevNet = { rx: rxBytes, tx: txBytes, t: now }

      return { cpu, memUsed, memTotal, diskUsed, diskTotal, temp, rx, tx }
    },
  )

  function openMonitor() {
    execAsync(["kitty", "btop"]).catch((e) => console.error("btop:", String(e)))
    // Dismiss the overlay so the terminal (a normal window) isn't hidden behind
    // this layer-shell panel.
    props.onClose()
  }

  return (
    <box cssName="qs-hardware" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      <StatRow
        glyph={GLYPH_CPU}
        glyphClass="nerd"
        label="CPU"
        level={stats.as((s) => s.cpu)}
        value={stats.as((s) => `${Math.round(s.cpu * 100)}%`)}
      />
      <StatRow
        glyph={GLYPH_RAM}
        label="RAM"
        level={stats.as((s) => (s.memTotal > 0 ? s.memUsed / s.memTotal : 0))}
        value={stats.as((s) => `${fmtGiB(s.memUsed)} / ${fmtGiB(s.memTotal)} GiB`)}
      />
      <StatRow
        glyph={GLYPH_DISK}
        glyphClass="disk"
        label="Disk"
        level={stats.as((s) => (s.diskTotal > 0 ? s.diskUsed / s.diskTotal : 0))}
        value={stats.as((s) => `${fmtGiB(s.diskUsed)} / ${fmtGiB(s.diskTotal)} GiB`)}
      />
      <StatRow
        glyph={stats.as((s) => tempGlyph(s.temp))}
        label="Temp"
        level={stats.as((s) => (s.temp != null ? Math.min(1, s.temp / 100) : 0))}
        value={stats.as((s) => (s.temp != null ? `${Math.round(s.temp)}°C` : "—"))}
      />
      <StatRow
        iconName="network-transmit-receive-symbolic"
        label="Net"
        value={stats.as((s) => `↓ ${fmtRate(s.rx)}   ↑ ${fmtRate(s.tx)}`)}
      />

      <button cssName="qs-monitor" onClicked={openMonitor}>
        <box spacing={8} halign={Gtk.Align.CENTER}>
          <image iconName="utilities-terminal-symbolic" />
          <label label="System monitor (btop)" />
        </box>
      </button>
    </box>
  )
}
