#!/usr/bin/env bash
# install.sh — set up the system bits the myBar VPN toggle needs:
#
#   1. ~/.local/bin/singbox-ctl  — a tiny privileged helper that validates,
#      installs and (re)starts a sing-box config. The only thing granted sudo.
#   2. /etc/sudoers.d/sing-box   — lets the current user run that one helper
#      without a password.
#
# Reading VPN state stays unprivileged; every mutation goes through the helper.
# Safe to re-run: it overwrites both files and validates before installing.

set -euo pipefail

SUDOERS_PATH=/etc/sudoers.d/sing-box
UNIT=sing-box.service
# HELPER_PATH is computed below, once we know the target user's home, since it
# lives under ~/.local/bin (sudoers needs the fully expanded absolute path).

# Re-exec under sudo so the rest runs as root (keeps SUDO_USER pointing at the
# real user, which we need for the sudoers rule).
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Requesting root via sudo…"
  exec sudo -E "$0" "$@"
fi

# The user the rule is written for: the invoker, not root.
TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || true)}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "error: could not determine the target (non-root) user." >&2
  echo "       run this as your normal user: ./install.sh" >&2
  exit 1
fi

TARGET_GROUP="$(id -gn "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
if [ -z "$TARGET_HOME" ]; then
  echo "error: could not resolve the home directory for $TARGET_USER." >&2
  exit 1
fi
BIN_DIR="$TARGET_HOME/.local/bin"
HELPER_PATH="$BIN_DIR/singbox-ctl"

echo "Installing for user: $TARGET_USER (helper -> $HELPER_PATH)"

# Warn (but don't fail) if the pieces we drive aren't present yet.
command -v sing-box >/dev/null 2>&1 || echo "warning: 'sing-box' not found in PATH."
systemctl list-unit-files "$UNIT" >/dev/null 2>&1 || echo "warning: $UNIT not found."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ── 1. helper script ──────────────────────────────────────────────────────────
# Quoted heredoc: nothing here is expanded by install.sh; it lands verbatim.
cat > "$tmp/singbox-ctl" <<'HELPER_EOF'
#!/usr/bin/env bash
# singbox-ctl — minimal privileged helper for the myBar VPN toggle.
# Allowed passwordless via /etc/sudoers.d/sing-box. Keeps the trusted surface to
# this one script instead of granting broad systemctl/cp rights.
set -euo pipefail

SYSTEM_CONFIG=/etc/sing-box/config.json
UNIT=sing-box.service

case "${1:-}" in
  start)
    systemctl reset-failed "$UNIT" 2>/dev/null || true
    systemctl start "$UNIT"
    ;;
  stop)
    systemctl stop "$UNIT"
    ;;
  apply)
    src="${2:-}"
    # Only accept a rendered config from a user's own config directory.
    case "$src" in
      /home/*/.config/sing-box/rendered/*.json) ;;
      *) echo "singbox-ctl: refusing path: $src" >&2; exit 1 ;;
    esac
    [ -f "$src" ] || { echo "singbox-ctl: no such file: $src" >&2; exit 1; }
    /usr/bin/sing-box check -c "$src"
    install -m 0644 -o root -g root "$src" "$SYSTEM_CONFIG"
    systemctl reset-failed "$UNIT" 2>/dev/null || true
    systemctl restart "$UNIT"
    ;;
  *)
    echo "usage: singbox-ctl {start|stop|apply <file>}" >&2
    exit 2
    ;;
esac
HELPER_EOF

# Make sure ~/.local/bin exists and stays owned by the user (never create it as
# root, which would break other tools writing there).
[ -d "$BIN_DIR" ] || install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0755 "$BIN_DIR"
install -m 0755 -o root -g root "$tmp/singbox-ctl" "$HELPER_PATH"
echo "✓ installed $HELPER_PATH"

# ── 2. sudoers rule ───────────────────────────────────────────────────────────
# Unquoted heredoc so ${TARGET_USER} is substituted; nothing else needs it.
cat > "$tmp/sing-box-sudoers" <<EOF
# myBar VPN: control sing-box via the singbox-ctl helper without a password.
${TARGET_USER} ALL=(root) NOPASSWD: ${HELPER_PATH}
EOF

visudo -cf "$tmp/sing-box-sudoers"
install -m 0440 -o root -g root "$tmp/sing-box-sudoers" "$SUDOERS_PATH"
echo "✓ installed $SUDOERS_PATH"

# ── 3. clear any stuck start-rate-limit from earlier testing ───────────────────
systemctl reset-failed "$UNIT" 2>/dev/null || true