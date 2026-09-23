import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor } from "gnim"
import type { SpotlightItem } from "../../lib/spotlight/types"

// One result row: icon + title over an optional subtitle. Source-agnostic — it
// renders whatever the provider put in the item.
export default function ResultRow(props: {
  item: SpotlightItem
  isSelected: Accessor<boolean>
  onActivate: () => void
  onHover: () => void
}) {
  const { item } = props
  return (
    <box
      cssName="spotlight-result"
      class={props.isSelected.as((s) => (s ? "selected" : ""))}
      spacing={12}
    >
      {/* A plain box (not a button) so it carries no theme chrome; the gesture
          makes it clickable and the motion controller lets the mouse drive the
          same selection the arrow keys do. */}
      <Gtk.GestureClick onPressed={() => props.onActivate()} />
      <Gtk.EventControllerMotion onEnter={() => props.onHover()} />
      <image cssName="spotlight-result-icon" iconName={item.icon} />
      <box
        orientation={Gtk.Orientation.VERTICAL}
        valign={Gtk.Align.CENTER}
        hexpand
        halign={Gtk.Align.START}
      >
        <label
          cssName="spotlight-result-name"
          label={item.title}
          halign={Gtk.Align.START}
          ellipsize={Pango.EllipsizeMode.END}
        />
        {item.subtitle ? (
          <label
            cssName="spotlight-result-desc"
            label={item.subtitle}
            halign={Gtk.Align.START}
            ellipsize={Pango.EllipsizeMode.END}
          />
        ) : null}
      </box>
      {item.badge ? (
        <label cssName="spotlight-result-badge" label={item.badge} valign={Gtk.Align.CENTER} />
      ) : null}
    </box>
  )
}
