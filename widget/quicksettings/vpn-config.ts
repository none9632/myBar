// VPN (sing-box) logic — no UI. Used by the VPN tile/page in vpn.tsx.
//
// sing-box runs as a system service in TUN mode. We keep a library of VLESS
// profiles under ~/.config/sing-box/profiles/ and switch the active one by
// rendering a full config (a fixed template + the profile's outbound) and
// handing it to the `singbox-ctl` helper, which validates, installs it to
// /etc/sing-box/config.json and restarts the service. Reading state
// (`systemctl is-active`) needs no privilege; every mutation goes through the
// helper, allowed passwordless via /etc/sudoers.d/sing-box.

import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync } from "ags/process"
import { readFile, writeFile } from "ags/file"
import { createPoll } from "ags/time"
import { Accessor } from "gnim"

const VPN_DIR = `${GLib.get_user_config_dir()}/sing-box`
const VPN_PROFILES_DIR = `${VPN_DIR}/profiles`
const VPN_RENDERED = `${VPN_DIR}/rendered/active.json`
const VPN_ACTIVE_FILE = `${VPN_DIR}/active`
const VPN_SYSTEM_CONFIG = "/etc/sing-box/config.json"
export const SINGBOX_CTL = `${GLib.get_home_dir()}/.local/bin/singbox-ctl`

export interface VpnOutbound {
  type: string
  tag: string
  server: string
  server_port: number
  uuid: string
  flow?: string
  tls?: object
  transport?: object
}

export interface VpnProfile {
  id: string
  name: string
  link: string
  outbound: VpnOutbound
}

// Decode a URL query string into a plain map (gjs lacks a guaranteed
// URLSearchParams, so parse by hand).
function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of query.replace(/^\?/, "").split("&")) {
    if (!pair) continue
    const eq = pair.indexOf("=")
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))
    const val = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1))
    out[key] = val
  }
  return out
}

// Parse a `vless://uuid@host:port?params#name` share link into a sing-box
// outbound. Covers the reality/vision + tls cases (and ws/grpc transport);
// returns null if the link isn't a recognisable VLESS URL.
export function parseVlessLink(raw: string): VpnProfile | null {
  const link = raw.trim()
  const m = link.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(#.*)?$/i)
  if (!m) return null
  const [, uuid, host, portStr, query = "", hash = ""] = m
  const p = parseQuery(query)
  const name = (hash ? decodeURIComponent(hash.slice(1)) : "") || host

  const outbound: VpnOutbound = {
    type: "vless",
    tag: "vless-out",
    server: host,
    server_port: parseInt(portStr, 10),
    uuid,
  }
  if (p.flow) outbound.flow = p.flow

  const security = p.security || "none"
  if (security === "reality" || security === "tls") {
    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: p.sni || p.peer || host,
    }
    if (p.fp) tls.utls = { enabled: true, fingerprint: p.fp }
    if (security === "reality") {
      tls.reality = { enabled: true, public_key: p.pbk || "", short_id: p.sid || "" }
    }
    outbound.tls = tls
  }

  if (p.type === "ws") {
    const ws: Record<string, unknown> = { type: "ws", path: p.path || "/" }
    if (p.host) ws.headers = { Host: p.host }
    outbound.transport = ws
  } else if (p.type === "grpc") {
    outbound.transport = { type: "grpc", service_name: p.serviceName || "" }
  }

  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  return { id, name, link, outbound }
}

// A complete, standalone sing-box config built from the fixed template plus the
// given outbound. Mirrors the original /etc/sing-box/config.json so existing
// dns/route behaviour is preserved; only the VLESS server varies.
function renderVpnConfig(outbound: VpnOutbound): string {
  const config = {
    dns: {
      servers: [
        { type: "tls", tag: "google", detour: "vless-out", server: "8.8.8.8" },
        { type: "udp", tag: "local", server: "1.1.1.1" },
      ],
      strategy: "ipv4_only",
    },
    inbounds: [
      {
        type: "tun",
        address: "172.19.0.1/30",
        auto_route: true,
        auto_redirect: true,
        strict_route: true,
      },
    ],
    outbounds: [
      { ...outbound, tag: "vless-out" },
      { type: "direct", tag: "direct" },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
      ],
      auto_detect_interface: true,
      default_domain_resolver: "local",
      final: "vless-out",
    },
  }
  return JSON.stringify(config, null, 2)
}

export function listVpnProfiles(): VpnProfile[] {
  if (!GLib.file_test(VPN_PROFILES_DIR, GLib.FileTest.IS_DIR)) return []
  const profiles: VpnProfile[] = []
  try {
    const en = Gio.File.new_for_path(VPN_PROFILES_DIR).enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    // Always close the enumerator: it holds an open directory fd, and this runs on
    // a 2s poll (the VPN tooltip), so leaking it exhausts the fd limit and crashes
    // the bar after a while ("Too many open files").
    try {
      let info: Gio.FileInfo | null
      while ((info = en.next_file(null)) !== null) {
        const fname = info.get_name()
        if (!fname.endsWith(".json")) continue
        try {
          const data = JSON.parse(readFile(`${VPN_PROFILES_DIR}/${fname}`))
          if (data?.outbound?.server) {
            profiles.push({
              id: fname.replace(/\.json$/, ""),
              name: data.name || data.outbound.server,
              link: data.link || "",
              outbound: data.outbound,
            })
          }
        } catch (e) {
          console.error("vpn profile parse:", fname, "->", String(e))
        }
      }
    } finally {
      en.close(null)
    }
  } catch (e) {
    console.error("vpn list profiles:", String(e))
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}

export function saveVpnProfile(p: VpnProfile) {
  writeFile(
    `${VPN_PROFILES_DIR}/${p.id}.json`,
    JSON.stringify({ name: p.name, link: p.link, outbound: p.outbound }, null, 2),
  )
}

export function deleteVpnProfile(id: string) {
  try {
    Gio.File.new_for_path(`${VPN_PROFILES_DIR}/${id}.json`).delete(null)
  } catch (e) {
    console.error("vpn delete profile:", id, "->", String(e))
  }
}

export function getActiveVpnId(): string {
  try {
    return readFile(VPN_ACTIVE_FILE).trim()
  } catch {
    return ""
  }
}

// Render the profile's config and ask the helper to validate + install + restart.
export function applyVpnProfile(p: VpnProfile): Promise<string> {
  writeFile(VPN_RENDERED, renderVpnConfig(p.outbound))
  writeFile(VPN_ACTIVE_FILE, p.id)
  return execAsync(["sudo", SINGBOX_CTL, "apply", VPN_RENDERED])
}

// First-run seeding: lift the VLESS outbound from the live system config into a
// profile so the user's current server shows up in the list.
export function seedVpnProfiles() {
  if (listVpnProfiles().length > 0) return
  try {
    const cfg = JSON.parse(readFile(VPN_SYSTEM_CONFIG))
    const ob = (cfg.outbounds || []).find((o: VpnOutbound) => o.type === "vless")
    if (!ob?.server) return
    const id = Date.now().toString(36)
    saveVpnProfile({ id, name: ob.server, link: "", outbound: { ...ob, tag: "vless-out" } })
    if (!getActiveVpnId()) writeFile(VPN_ACTIVE_FILE, id)
  } catch (e) {
    console.error("vpn seed:", String(e))
  }
}

export function vpnIsActivePoll(): Accessor<boolean> {
  // `|| true` keeps exit code 0 so an inactive service isn't a failed poll.
  return createPoll(
    false,
    2000,
    ["bash", "-c", "systemctl is-active sing-box || true"],
    (out) => out.trim() === "active",
  )
}
