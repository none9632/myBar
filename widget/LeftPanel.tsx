import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createBinding, For } from "gnim"
import Hyprland from "gi://AstalHyprland?version=0.1"

export default function LeftPanel(gdkmonitor: Gdk.Monitor) {
  const { TOP, LEFT } = Astal.WindowAnchor
  const hypr = Hyprland.get_default()

  const workspaces = hypr
    ? createBinding(hypr, "workspaces").as((wss) =>
        [...wss].filter((ws) => ws.id > 0).sort((a, b) => a.id - b.id),
      )
    : null

  const focusedId = hypr
    ? createBinding(hypr, "focusedWorkspace").as((fw) => fw?.id)
    : null

  const win = (
    <window
      visible
      name="left-panel"
      class="LeftPanel"
      gdkmonitor={gdkmonitor}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={TOP | LEFT}
      resizable={false}
      application={app}
    >
      <box cssName="left-panel-inner">
        <box cssName="workspaces">
          {workspaces && focusedId ? (
            <For each={workspaces} id={(ws) => ws.id}>
              {(ws) => (
                <button
                  cssName="workspace-btn"
                  class={focusedId.as((id) => (id === ws.id ? "active" : ""))}
                  onClicked={() => hypr!.dispatch("workspace", `${ws.id}`)}
                >
                  <label label={`${ws.id}`} />
                </button>
              )}
            </For>
          ) : null}
        </box>
      </box>
    </window>
  ) as Astal.Window

  return win
}
