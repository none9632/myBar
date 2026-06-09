import { Accessor, createBinding } from "gnim"
import Wp from "gi://AstalWp?version=0.1"
import { Toggle, ControlSlider } from "./common"

// ── Microphone ────────────────────────────────────────────────────────────────

export function MicToggle() {
  const wp = Wp.get_default()
  const mic = wp?.defaultMicrophone
  if (!mic) {
    return (
      <Toggle
        icon="microphone-disabled-symbolic"
        label="No Microphone"
        active={new Accessor(() => false)}
        onClicked={() => {}}
      />
    )
  }

  const muted = createBinding(mic, "mute")
  return (
    <Toggle
      icon={muted.as((m) =>
        m ? "microphone-disabled-symbolic" : "audio-input-microphone-symbolic",
      )}
      label={muted.as((m) => (m ? "Disabled" : "Enabled"))}
      active={muted.as((m) => !m)}
      onClicked={() => (mic.mute = !mic.mute)}
    />
  )
}

// ── Volume slider ─────────────────────────────────────────────────────────────

export function VolumeSlider() {
  const wp = Wp.get_default()
  const speaker = wp?.defaultSpeaker
  if (!speaker) return <box />

  const volume = createBinding(speaker, "volume")
  const icon = createBinding(speaker, "volumeIcon")
  return (
    <ControlSlider icon={icon} value={volume} onChange={(v) => (speaker.volume = v)} />
  )
}
