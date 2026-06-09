import { Gtk, Gdk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor, createBinding, createComputed, createState, For, With, onCleanup, onMount } from "gnim"
import Bluetooth from "gi://AstalBluetooth?version=0.1"
import { Toggle, ToggleSwitch } from "./common"

export function BluetoothToggle(props: { onClick: () => void }) {
  const bt = Bluetooth.get_default()
  const powered = createBinding(bt, "isPowered")
  const connected = createBinding(bt, "devices").as((ds) => {
    const dev = ds.find((d) => d.connected)
    return dev ? dev.alias || dev.name : "Not connected"
  })
  return (
    <Toggle
      icon="bluetooth-symbolic"
      label={powered.as((p) => (p ? "Enabled" : "Disabled"))}
      sublabel={connected}
      active={powered}
      onClicked={props.onClick}
    />
  )
}

// BlueZ reports a full-colour icon name (e.g. "audio-headset"). GTK only
// recolours *symbolic* icons via `color`, so a full-colour glyph keeps its own
// (light) colour and blends into the accent background once the row is
// connected. Prefer the "-symbolic" variant when the theme ships one, falling
// back to the plain name, and to a generic bluetooth glyph when there is none.
function symbolicIcon(name: string | null): string {
  const base = name || "bluetooth"
  const symbolic = `${base}-symbolic`
  const display = Gdk.Display.get_default()
  if (display && Gtk.IconTheme.get_for_display(display).has_icon(symbolic)) {
    return symbolic
  }
  return base
}

function BluetoothDeviceRow(props: { device: Bluetooth.Device }) {
  const dev = props.device
  const connected = createBinding(dev, "connected")
  const connecting = createBinding(dev, "connecting")
  const name = createBinding(dev, "alias") // alias falls back to the device name
  const icon = createBinding(dev, "icon")
  const batteryPercentage = createBinding(dev, "batteryPercentage")
  // BlueZ stops updating battery-percentage on disconnect but keeps reporting
  // the last value, so the badge would otherwise linger. Only surface it while
  // the device is actually connected.
  const battery = createComputed(() => (connected() ? batteryPercentage() : -1))
  const [menuOpen, setMenuOpen] = createState(false)
  // Set briefly when a connection attempt fails, to flag it in the UI.
  const [failed, setFailed] = createState(false)

  // Trailing indicator: spinner while connecting, a check once connected, a
  // warning icon for a short while after a failed attempt.
  const status = createComputed(() => {
    if (connecting()) return "connecting"
    if (connected()) return "connected"
    if (failed()) return "failed"
    return "none"
  })

  function onClick() {
    if (connecting.peek()) return
    // These GIO async methods aren't promisified at runtime, so they must be
    // called with a callback (passing none throws). connect_device() pairs as
    // needed; disconnect_device() drops all profiles. The *_finish() call throws
    // on failure (e.g. a powered-off device), which we catch and log.
    if (connected.peek()) {
      dev.disconnect_device((_d, res) => {
        try {
          dev.disconnect_device_finish(res)
        } catch (e) {
          console.error("bluetooth disconnect:", dev.address, "->", String(e))
        }
      })
    } else {
      setFailed(false)
      dev.connect_device((_d, res) => {
        try {
          dev.connect_device_finish(res)
        } catch (e) {
          console.error("bluetooth connect:", dev.address, "->", String(e))
          setFailed(true)
          // Clear the warning after a few seconds so it doesn't linger.
          setTimeout(() => setFailed(false), 4000)
        }
      })
    }
  }

  function forget() {
    setMenuOpen(false)
    Bluetooth.get_default().adapter?.remove_device(dev)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL}>
      <button
        cssName="detail-row"
        class={connected.as((c) => (c ? "connected" : ""))}
        onClicked={onClick}
      >
        {/* Right-click a paired device to forget it. */}
        <Gtk.GestureClick
          button={3}
          onPressed={() => {
            if (dev.paired) setMenuOpen(!menuOpen.peek())
          }}
        />
        <box spacing={10}>
          <image iconName={icon.as(symbolicIcon)} />
          <label
            label={name.as((n) => n || "Unknown device")}
            hexpand
            halign={Gtk.Align.START}
            ellipsize={Pango.EllipsizeMode.END}
          />
          {/* Static wrapper: a re-rendered <With> appends its new widget to the
              END of its parent, so without this the (delayed) battery badge
              would land to the right of the status indicator. Pinned here, it
              always sits just left of the status slot. */}
          <box valign={Gtk.Align.CENTER}>
            <With value={battery}>
              {(b) =>
                b >= 0 ? (
                  <label cssName="detail-badge" label={`${Math.round(b * 100)}%`} />
                ) : (
                  <box />
                )
              }
            </With>
          </box>
          {/* Fixed-size slot so spinner → check swap in place without nudging
              the row; the battery badge then appears to its left. */}
          <box cssName="detail-status" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
            <With value={status}>
              {(s) =>
                s === "connecting" ? (
                  <Gtk.Spinner spinning />
                ) : s === "connected" ? (
                  <image iconName="object-select-symbolic" />
                ) : s === "failed" ? (
                  <image cssName="detail-error" iconName="dialog-warning-symbolic" />
                ) : (
                  <box />
                )
              }
            </With>
          </box>
        </box>
      </button>

      <revealer revealChild={menuOpen} transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}>
        <box cssName="row-menu" orientation={Gtk.Orientation.VERTICAL}>
          <button cssName="row-menu-item" onClicked={forget}>
            <box spacing={8}>
              <image iconName="user-trash-symbolic" />
              <label label="Forget device" hexpand halign={Gtk.Align.START} />
            </box>
          </button>
        </box>
      </revealer>
    </box>
  )
}

// A titled group of devices. The header (and the whole group) is hidden while
// the group is empty, so an unused section leaves no stray label behind.
function DeviceSection(props: { title: string; devices: Accessor<Bluetooth.Device[]> }) {
  return (
    <With value={props.devices.as((d) => d.length > 0)}>
      {(hasAny) =>
        hasAny ? (
          <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <label cssName="detail-section" label={props.title} halign={Gtk.Align.START} />
            <For each={props.devices} id={(d) => d.address}>
              {(d) => <BluetoothDeviceRow device={d} />}
            </For>
          </box>
        ) : (
          <box />
        )
      }
    </With>
  )
}

export function BluetoothPage(props: { onBack: () => void }) {
  const bt = Bluetooth.get_default()
  const powered = createBinding(bt, "isPowered")
  const devicesBinding = createBinding(bt, "devices")
  // Split into devices we've paired with before vs. freshly discovered ones.
  // Paired group: connected first, then by name. Available group: by name.
  const paired = devicesBinding.as((ds) =>
    [...ds]
      .filter((d) => d.paired && (d.name || d.alias))
      .sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1
        return (a.alias || a.name).localeCompare(b.alias || b.name)
      }),
  )
  const available = devicesBinding.as((ds) =>
    [...ds]
      .filter((d) => !d.paired && (d.name || d.alias))
      .sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name)),
  )

  // Scan for nearby devices while the page is open; stop on the way out so the
  // adapter isn't left discovering in the background. Discovery only works once
  // the adapter is powered — calling start_discovery() while it's off throws
  // org.bluez.Error.NotReady — so we guard on `powered` and (re)start if the
  // user turns Bluetooth on while the page is open.
  const adapter = bt.adapter
  function startDiscovery() {
    if (!adapter || !adapter.powered || adapter.discovering) return
    try {
      adapter.start_discovery()
    } catch (e) {
      console.error("bluetooth start_discovery:", String(e))
    }
  }
  onMount(startDiscovery)
  const unsubscribe = powered.subscribe(startDiscovery)
  onCleanup(() => {
    unsubscribe()
    if (adapter?.discovering) {
      try {
        adapter.stop_discovery()
      } catch (e) {
        console.error("bluetooth stop_discovery:", String(e))
      }
    }
  })

  return (
    <box cssName="detail-page" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box cssName="detail-header" spacing={10}>
        <button cssName="detail-back" onClicked={props.onBack}>
          <image iconName="go-previous-symbolic" />
        </button>
        <label cssName="detail-title" label="Bluetooth" hexpand halign={Gtk.Align.START} />
        <ToggleSwitch active={powered.as((p) => !!p)} onToggle={() => bt.toggle()} />
      </box>

      <scrolledwindow
        cssName="detail-list"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        propagateNaturalHeight
        maxContentHeight={300}
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <DeviceSection title="My devices" devices={paired} />
          <DeviceSection title="Available" devices={available} />
        </box>
      </scrolledwindow>
    </box>
  )
}
