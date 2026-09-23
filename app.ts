import app from "ags/gtk4/app"
import style from "./styles/main.scss"
import LeftPanel from "./widget/LeftPanel"
import RightPanel from "./widget/RightPanel"
import { toggleQs } from "./widget/QuickSettings"
import SpotlightWindow, { toggleSpotlight } from "./widget/Spotlight"
import { initKeyboard } from "./lib/keyboard"

app.start({
  css: style,
  // External control via `ags request <msg>` (e.g. a Hyprland keybind). Match by
  // substring so it works whether the CLI forwards just the message or a fuller
  // argv. `ags request quicksettings` toggles the Quick Settings overlay;
  // `ags request spotlight` toggles the launcher.
  requestHandler(argv, res) {
    const msg = (Array.isArray(argv) ? argv.join(" ") : String(argv)).trim()
    if (msg.includes("quicksettings")) {
      toggleQs()
      res("ok")
      return
    }
    if (msg.includes("spotlight")) {
      toggleSpotlight()
      res("ok")
      return
    }
    res(`unknown request: ${msg}`)
  },
  main() {
    // Starts tracking the main keyboard's layout so overlays can force latin
    // input and put the previous layout back.
    initKeyboard()

    const monitors = app.get_monitors()
    monitors.map((monitor) => {
      LeftPanel(monitor)
      RightPanel(monitor)
    })
    // A single launcher instance on the primary monitor (Phase 1); it stays hidden
    // until `ags request spotlight`. Multi-monitor "open on the focused output" is
    // a later refinement.
    if (monitors[0]) SpotlightWindow({ gdkmonitor: monitors[0] })
  },
})
