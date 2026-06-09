import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor } from "gnim"

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
export function ToggleSwitch(props: { active: Accessor<boolean>; onToggle: () => void }) {
  return (
    <button
      cssName="toggle-switch"
      valign={Gtk.Align.CENTER}
      class={props.active.as((a) => (a ? "on" : "off"))}
      onClicked={props.onToggle}
    >
      <box cssName="knob" halign={Gtk.Align.START} valign={Gtk.Align.CENTER} />
    </button>
  )
}
