import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import { Toggle } from "./common"

// Airplane mode toggles every radio via rfkill. /dev/rfkill is writable by the
// active-session user (systemd uaccess ACL), so block/unblock needs no privilege.
// State = airplane on when every rfkill device is soft-blocked.
export function AirplaneToggle() {
  const enabled = createPoll(
    false,
    2000,
    ["bash", "-c", "rfkill --noheadings --output SOFT 2>/dev/null"],
    (out) => {
      const lines = out.trim().split("\n").filter(Boolean)
      return lines.length > 0 && lines.every((l) => l.trim() === "blocked")
    },
  )

  function toggle() {
    const cmd = enabled.peek() ? "unblock" : "block"
    execAsync(["rfkill", cmd, "all"]).catch((e) => console.error("airplane:", String(e)))
  }

  return (
    <Toggle
      icon={enabled.as((a) =>
        a ? "airplane-mode-symbolic" : "airplane-mode-disabled-symbolic",
      )}
      label={enabled.as((a) => (a ? "On" : "Off"))}
      sublabel="Airplane mode"
      active={enabled}
      onClicked={toggle}
    />
  )
}
