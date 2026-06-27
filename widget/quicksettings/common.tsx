import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor, createComputed, createState, onCleanup } from "gnim"

export type MaybeAccessor<T> = T | Accessor<T>

// ── Reusable toggle button ────────────────────────────────────────────────────

export function Toggle(props: {
  icon: MaybeAccessor<string>
  label: MaybeAccessor<string>
  sublabel?: MaybeAccessor<string>
  active: Accessor<boolean>
  onClicked: () => void
}) {
  return (
    <button
      cssName="qs-toggle"
      hexpand
      class={props.active.as((a) => (a ? "active" : ""))}
      onClicked={props.onClicked}
    >
      <box spacing={10} halign={Gtk.Align.START}>
        <image cssName="qs-toggle-icon" iconName={props.icon} />
        <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
          <label cssName="qs-toggle-label" halign={Gtk.Align.START} label={props.label} />
          {props.sublabel !== undefined ? (
            <label
              cssName="qs-toggle-sublabel"
              halign={Gtk.Align.START}
              ellipsize={Pango.EllipsizeMode.END}
              maxWidthChars={14}
              label={props.sublabel}
            />
          ) : null}
        </box>
      </box>
    </button>
  )
}

// ── Slider ────────────────────────────────────────────────────────────────────

export function ControlSlider(props: {
  icon: MaybeAccessor<string>
  value: Accessor<number>
  onChange: (value: number) => void
}) {
  return (
    <box cssName="qs-slider" spacing={10}>
      <image cssName="qs-slider-icon" iconName={props.icon} halign={Gtk.Align.START} />
      <slider
        cssName="qs-scale"
        hexpand
        value={props.value}
        min={0}
        max={1}
        step={0.01}
        onChangeValue={(_self, _scroll, value) => {
          props.onChange(value)
          return false
        }}
      />
      <label
        cssName="qs-slider-value"
        halign={Gtk.Align.END}
        label={props.value.as((v) => `${Math.round(v * 100)}%`)}
      />
    </box>
  )
}

// ── Reusable on/off switch ──────────────────────────────────────────────────
// A styled button rather than GtkSwitch: GtkSwitch flips its `:checked` colour
// only after the knob finishes sliding, which desynced the colour from the knob.
// Here a single `.on`/`.off` class drives both, so they animate in lockstep (see
// style.scss `toggle-switch`).
//
// `active` is read from a poll or a D-Bus binding that can lag the click by
// seconds — a VPN service restart, or the Wi-Fi/BT radio powering up. Left as-is
// the knob would sit unmoved for that whole time and the click would look dropped
// (most glaring for VPN, on a 2s `systemctl is-active` poll). So on click we slide
// the knob to the requested side at once (optimistically) and fade the whole switch
// in and out to show it's working, clearing both the moment the real state confirms
// — or after a safety timeout, in case the operation failed and the state never arrives.
export function ToggleSwitch(props: { active: Accessor<boolean>; onToggle: () => void }) {
  const POP_MS = 260 // press-pop keyframe length; kept in sync with style.scss
  // The requested state while we wait for `active` to confirm it; null once settled.
  const [pending, setPending] = createState<boolean | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  // Transient flag for the press "pop" — the knob briefly grows and springs back on
  // each click. Cleared once the keyframe has played, so it replays next press.
  const [popping, setPopping] = createState(false)
  let popTimer: ReturnType<typeof setTimeout> | null = null

  function settle() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    setPending(null)
  }

  // Drop the pending flag as soon as the real state reaches what we asked for.
  const unsubscribe = props.active.subscribe(() => {
    if (pending.peek() !== null && props.active.peek() === pending.peek()) settle()
  })
  onCleanup(() => {
    unsubscribe()
    if (timer) clearTimeout(timer)
    if (popTimer) clearTimeout(popTimer)
  })

  function onToggle() {
    setPending(!props.active.peek())
    if (timer) clearTimeout(timer)
    // Safety net: if the state never catches up (e.g. the service failed to
    // start), stop fading and let the knob fall back to reality after a while.
    timer = setTimeout(settle, 10000)
    // Fire the press pop; the keyframe is one-shot, so drop the class once it has
    // played to leave it armed for the next press.
    setPopping(true)
    if (popTimer) clearTimeout(popTimer)
    popTimer = setTimeout(() => setPopping(false), POP_MS)
    props.onToggle()
  }

  // Knob position follows the optimistic target while pending, else the real state;
  // `.pending` drives the "working" fade, `.pop` the one-shot press grow-and-settle.
  const className = createComputed(() => {
    const p = pending()
    const on = p !== null ? p : props.active()
    return `${on ? "on" : "off"}${p !== null ? " pending" : ""}${popping() ? " pop" : ""}`
  })

  return (
    <button
      cssName="toggle-switch"
      valign={Gtk.Align.CENTER}
      class={className}
      onClicked={onToggle}
    >
      <box cssName="knob" halign={Gtk.Align.START} valign={Gtk.Align.CENTER} />
    </button>
  )
}
