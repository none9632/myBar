import app from "ags/gtk4/app"
import style from "./style.scss"
import LeftPanel from "./widget/LeftPanel"
import RightPanel from "./widget/RightPanel"

app.start({
  css: style,
  main() {
    app.get_monitors().map((monitor) => {
      LeftPanel(monitor)
      RightPanel(monitor)
    })
  },
})
