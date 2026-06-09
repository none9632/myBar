import { execAsync } from "ags/process"
import { createBinding, createState } from "gnim"
import PowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import { Toggle, ControlSlider } from "./common"

// ── Power profile ─────────────────────────────────────────────────────────────

export function PowerToggle() {
  const pp = PowerProfiles.get_default()
  const profile = createBinding(pp, "activeProfile")
  const isPerf = profile.as((p) => p === "performance")
  return (
    <Toggle
      icon={isPerf.as((p) =>
        p ? "power-profile-performance-symbolic" : "power-profile-balanced-symbolic",
      )}
      label={isPerf.as((p) => (p ? "Performance" : "Balanced"))}
      active={isPerf}
      onClicked={() => {
        pp.activeProfile = pp.activeProfile === "performance" ? "balanced" : "performance"
      }}
    />
  )
}

// ── Brightness slider ─────────────────────────────────────────────────────────

export function BrightnessSlider() {
  const [brightness, setBrightness] = createState(0.5)

  // Initial value from brightnessctl (4th field: "75%").
  execAsync(["bash", "-c", "brightnessctl -m | cut -d, -f4 | tr -d '%'"])
    .then((s) => {
      const pct = parseInt(s.trim(), 10)
      if (!isNaN(pct)) setBrightness(pct / 100)
    })
    .catch(() => {})

  return (
    <ControlSlider
      icon="display-brightness-symbolic"
      value={brightness}
      onChange={(v) => {
        setBrightness(v)
        execAsync(["brightnessctl", "set", `${Math.round(v * 100)}%`]).catch(() => {})
      }}
    />
  )
}
