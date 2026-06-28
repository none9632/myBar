import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import { Accessor, createState, With } from "gnim"
import { QS_ANIM_MS, QS_MARGIN_TOP } from "./QuickSettings"

// A bar button that opens a card in an overlay window dropping from under it —
// same machinery as the Quick Settings panel: slide+fade on BOTH open and close
// (a GtkPopover can't animate its close), a full-screen dismiss layer (Esc /
// clicking outside / clicking the bar all close it), and the card centred on the
// button. Used for the status-indicator menus, the updates list, and the clock
// calendar. The card is built lazily while open (<With> on `mapped`) so the
// content's side effects start on open and stop on close.
export default function BarMenu(props: {
  name: string
  gdkmonitor: Gdk.Monitor
  // Trigger button content (icon, clock labels, …).
  button: JSX.Element
  // Menu content, built lazily each time the menu opens.
  content: () => JSX.Element
  buttonCssName?: string
  // Extra style class on the trigger button, for targeting one menu among several
  // that share a node name (e.g. the individual status-indicator buttons).
  buttonClass?: string
  tooltip?: string | Accessor<string>
  visible?: Accessor<boolean>
}) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

  // `mapped` keeps the window shown while the card animates; `revealed` drives the
  // slide+fade. Splitting them lets the close animation play before the window
  // unmaps. `cardLeft` centres the card under the button.
  const [mapped, setMapped] = createState(false)
  const [revealed, setRevealed] = createState(false)
  const [cardLeft, setCardLeft] = createState(0)
  let isOpen = false
  let closeTimer = 0
  let btn: Gtk.Widget | null = null
  // Card width, to centre it on the button. An estimate until the card is first
  // allocated, then its real measured width (see the card's tick callback).
  // `openCenter` is captured at open so a width correction mid-open re-centres
  // around the same point.
  let cardWidth = 348
  let openCenter = 0

  // Screen-x of the button's centre. The bar window is anchored to the right, so its
  // left edge sits at (monitor width − bar width); add the button's centre within
  // the bar. All in GTK logical px, which is what marginStart wants.
  function buttonCenterX(): number {
    const root = btn?.get_root()
    if (!btn || !root) return openCenter
    const [ok, b] = btn.compute_bounds(root)
    if (!ok) return openCenter
    return (
      props.gdkmonitor.get_geometry().width - root.get_width() + b.get_x() + b.get_width() / 2
    )
  }

  // Centre the card on the button, but clamp it to stay on-screen — the rightmost
  // buttons (e.g. the clock) would otherwise push it off the edge. Keep a small gap
  // from the edges, matching the bar inset.
  function placeCard() {
    const monW = props.gdkmonitor.get_geometry().width
    const max = monW - cardWidth - 10
    setCardLeft(Math.max(10, Math.min(openCenter - cardWidth / 2, max)))
  }

  function open() {
    isOpen = true
    if (closeTimer) {
      GLib.source_remove(closeTimer)
      closeTimer = 0
    }
    openCenter = buttonCenterX()
    placeCard()
    setMapped(true)
    // Let the window map first; revealing in the same frame snaps.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
      if (isOpen) setRevealed(true)
      return GLib.SOURCE_REMOVE
    })
  }

  function close() {
    isOpen = false
    setRevealed(false)
    if (closeTimer) GLib.source_remove(closeTimer)
    // Unmap only after the slide-out has played.
    closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QS_ANIM_MS, () => {
      if (!isOpen) setMapped(false)
      closeTimer = 0
      return GLib.SOURCE_REMOVE
    })
  }

  // The overlay window (self-registers via application={app}).
  ;(
    <window
      visible={mapped}
      name={`barmenu-${props.name}`}
      // No custom namespace: fall under the default "gtk4-layer-shell" so Hyprland's
      // blur layer-rule (which matches that namespace) applies, like the bar itself.
      class="BarMenu"
      gdkmonitor={props.gdkmonitor}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.EXCLUSIVE}
      layer={Astal.Layer.OVERLAY}
      application={app}
    >
      {/* CAPTURE phase: a focused child (the search/password entry) swallows
          Escape in the normal bubble phase, leaving the menu open. Catching it on
          the way down, at the window, makes Escape close reliably regardless of
          what holds focus. */}
      <Gtk.EventControllerKey
        propagationPhase={Gtk.PropagationPhase.CAPTURE}
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) {
            close()
            return true
          }
          return false
        }}
      />
      <overlay>
        {/* Main child: full-screen dismiss area. */}
        <box>
          <Gtk.GestureClick onPressed={() => close()} />
        </box>
        {/* Overlay child: the card, dropping centred under the button. */}
        <revealer
          $type="overlay"
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
          marginStart={cardLeft}
          marginTop={QS_MARGIN_TOP}
          revealChild={revealed}
          transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
          transitionDuration={QS_ANIM_MS}
        >
          <box
            cssName="bar-menu-card"
            class={revealed.as((r) => (r ? "shown" : ""))}
            $={(self: Gtk.Widget) => {
              // Once the card is realized, measure its natural width (the size
              // request — includes padding + the content's min/natural width) and
              // re-clamp so it never overflows the screen edge. Use measure() rather
              // than the allocated get_width, which can under-report (e.g. a bare
              // min-width without padding) and let a wider card spill off-screen.
              self.add_tick_callback(() => {
                if (self.get_width() <= 0) return GLib.SOURCE_CONTINUE
                const [, nat] = self.measure(Gtk.Orientation.HORIZONTAL, -1)
                if (nat > 0 && nat !== cardWidth) {
                  cardWidth = nat
                  if (isOpen) placeCard()
                }
                return GLib.SOURCE_REMOVE
              })
            }}
          >
            <With value={mapped}>{(m) => (m ? props.content() : <box />)}</With>
          </box>
        </revealer>
      </overlay>
    </window>
  )

  return (
    <button
      cssName={props.buttonCssName}
      class={props.buttonClass}
      visible={props.visible}
      tooltipText={props.tooltip}
      onClicked={() => (isOpen ? close() : open())}
      $={(self: Gtk.Widget) => {
        btn = self
      }}
    >
      {props.button}
    </button>
  )
}
