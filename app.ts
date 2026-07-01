import app from "ags/gtk4/app"
import style from "./styles/main.scss"
import LeftPanel from "./widget/LeftPanel"
import RightPanel from "./widget/RightPanel"
import { toggleQs } from "./widget/QuickSettings"

app.start({
  css: style,
  // External control via `ags request <msg>` (e.g. a Hyprland keybind). Match by
  // substring so it works whether the CLI forwards just the message or a fuller
  // argv. `ags request quicksettings` toggles the Quick Settings overlay.
  requestHandler(argv, res) {
    const msg = (Array.isArray(argv) ? argv.join(" ") : String(argv)).trim()
    if (msg.includes("quicksettings")) {
      toggleQs()
      res("ok")
      return
    }
    res(`unknown request: ${msg}`)
  },
  main() {
    app.get_monitors().map((monitor) => {
      LeftPanel(monitor)
      RightPanel(monitor)
    })
  },
})
