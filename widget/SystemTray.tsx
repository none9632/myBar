import { Gtk } from "ags/gtk4"
import { createBinding, For, onCleanup } from "gnim"
import Tray from "gi://AstalTray?version=0.1"

// StatusNotifierItem tray: one button per registered item, fed by the
// AstalTray watcher. Each item exposes a D-Bus menu (menuModel + actionGroup),
// so we render a <menubutton> whose popover is that menu. Clicking the button
// opens the app's own menu; items that ship no menu fall back to activate().

// Action-group prefix the menu model's "action" attributes are resolved against.
const MENU_PREFIX = "dbusmenu"

function TrayButton(item: Tray.TrayItem) {
  // menuModel / actionGroup arrive over D-Bus and can change after the item is
  // first seen, so wire them in a setup callback and re-sync on notify.
  const setup = (self: Gtk.MenuButton) => {
    const sync = () => {
      self.set_menu_model(item.menuModel)
      self.insert_action_group(MENU_PREFIX, item.actionGroup)
    }
    sync()
    const ids = [
      item.connect("notify::menu-model", sync),
      item.connect("notify::action-group", sync),
    ]
    onCleanup(() => ids.forEach((id) => item.disconnect(id)))
  }

  return (
    <menubutton
      cssName="tray-item"
      $={setup}
      // No menu → left-click sends an activate request to the app instead.
      onActivate={() => {
        if (!item.menuModel) item.activate(0, 0)
      }}
      tooltipMarkup={createBinding(item, "tooltipMarkup")}
    >
      <image gicon={createBinding(item, "gicon")} />
    </menubutton>
  )
}

export default function SystemTray() {
  const tray = Tray.get_default()
  const items = createBinding(tray, "items")

  return (
    <box cssName="system-tray" visible={items.as((i) => i.length > 0)}>
      <For each={items} id={(item) => item.id}>
        {(item) => TrayButton(item)}
      </For>
    </box>
  )
}
