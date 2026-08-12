/**
 * An in-memory stand-in for the Rust backend.
 *
 * Lets the interface be built, driven and screenshotted in a plain browser,
 * with no Tauri and no WoW installation. It mirrors the real commands' shapes
 * and their important behaviours — pinned addons never report updates, an
 * unavailable server refuses installs, installing targets one server only — so
 * a mistake in the UI shows up here rather than only on a real machine.
 *
 * Never bundled into the desktop app: `api.ts` imports it only when the Tauri
 * bridge is absent.
 */

import type {
  Addon,
  CatalogEntry,
  FolderVerdict,
  GameVersionOption,
  Outcome,
  Server,
} from "./api";

const servers: Server[] = [
  {
    id: "srv_epoch",
    name: "Project Epoch",
    path: "D:\\Games\\Epoch",
    version: "wotlk",
    versionLabel: "WotLK 3.3.5a",
    accent: "#8b5cf6",
    addonCount: 4,
    availability: "ready",
    canInstall: true,
  },
  {
    id: "srv_warmane",
    name: "Warmane Lordaeron",
    path: "D:\\Games\\Warmane",
    version: "wotlk",
    versionLabel: "WotLK 3.3.5a",
    accent: "#22d3ee",
    addonCount: 2,
    availability: "ready",
    canInstall: true,
  },
  {
    id: "srv_usb",
    name: "Turtle WoW",
    path: "E:\\wow-vanilla",
    version: "vanilla",
    versionLabel: "Vanilla 1.12",
    accent: "#84cc16",
    addonCount: 1,
    availability: "unavailable",
    canInstall: false,
  },
];

const addons: Record<string, Addon[]> = {
  srv_epoch: [
    row("github:Questie/Questie", "Questie", "v11.2.1", {
      latestVersion: "v11.3.0",
      updateStatus: "updateAvailable",
      needsUpdate: true,
    }),
    row("gitlab:Tsoukie/classicapi", "Classic API", "v3.1", {
      sourceKind: "gitlab",
      sourceUrl: "https://gitlab.com/Tsoukie/classicapi",
    }),
    row("github:WeakAuras/WeakAuras2", "WeakAuras", "v2.4.8", {
      folders: ["WeakAuras", "WeakAuras_Options", "WeakAurasModelPaths"],
    }),
    row("github:someone/DevTool", "DevTool", "master@a1b2c3d", {
      channel: "source",
      pinned: true,
    }),
  ],
  srv_warmane: [
    row("github:Questie/Questie", "Questie", "v11.0.0", {
      latestVersion: "v11.3.0",
      updateStatus: "updateAvailable",
      needsUpdate: true,
    }),
    row("gitlab:Tsoukie/classicapi", "Classic API", "v3.1", {
      sourceKind: "gitlab",
      sourceUrl: "https://gitlab.com/Tsoukie/classicapi",
    }),
  ],
  srv_usb: [row("github:o/Atlas", "Atlas", "v1.0.0")],
};

function row(
  addonId: string,
  name: string,
  installedVersion: string,
  overrides: Partial<Addon> = {},
): Addon {
  return {
    addonId,
    name,
    sourceUrl: `https://github.com/${addonId.split(":")[1] ?? "o/r"}`,
    sourceKind: "github",
    channel: "release",
    pinned: false,
    installedVersion,
    latestVersion: null,
    updateStatus: "unknown",
    needsUpdate: false,
    folders: [name.replace(/\s+/g, "")],
    installedAt: "2026-08-01",
    versionMatches: true,
    ...overrides,
  };
}

const catalog: CatalogEntry[] = [
  entry("classicapi", "Classic API", "Core", "Essential API functions for 3.3.5a addons."),
  entry(
    "compactraidframe",
    "Compact Raid Frames",
    "Raid Frames",
    "Compact, customisable raid frames.",
    ["classicapi"],
  ),
  entry("clique", "Clique", "Healing", "Click-casting for healers.", [
    "classicapi",
  ]),
  entry("atlasloot", "AtlasLoot", "Questing", "Loot tables for every instance."),
  entry("questie", "Questie", "Questing", "Quest helper with map integration."),
];

function entry(
  id: string,
  name: string,
  category: string,
  description: string,
  dependencies: string[] = [],
): CatalogEntry {
  return {
    id,
    name,
    description,
    repoUrl: `https://gitlab.com/Tsoukie/${id}`,
    category,
    dependencies,
    installed: false,
  };
}

let selectedFolder = "D:\\Games\\NewServer";
let token: string | null = null;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function mockPickFolder(): Promise<string | null> {
  const entered = window.prompt("Folder path (mock picker)", selectedFolder);
  if (entered) selectedFolder = entered;
  return entered;
}

export async function mockInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  // A little latency so loading states are visible rather than theoretical.
  await wait(120);
  const serverId = args?.["serverId"] as string | undefined;

  switch (command) {
    case "list_servers":
      return servers as T;

    case "list_game_versions":
      return [
        { value: "vanilla", label: "Vanilla 1.12", interfaceVersion: 11200 },
        { value: "tbc", label: "TBC 2.4.3", interfaceVersion: 20400 },
        { value: "wotlk", label: "WotLK 3.3.5a", interfaceVersion: 30300 },
      ] satisfies GameVersionOption[] as T;

    case "inspect_folder": {
      const path = String(args?.["path"] ?? "");
      const verdict: FolderVerdict = path.toLowerCase().includes("wow")
        ? { verdict: "confident", reason: null, usable: true, suggestedName: basename(path) }
        : {
            verdict: "plausible",
            reason:
              "no client executable found, but the folder layout matches a WoW install",
            usable: true,
            suggestedName: basename(path),
          };
      return verdict as T;
    }

    case "add_server": {
      const created: Server = {
        id: `srv_${Math.random().toString(36).slice(2, 8)}`,
        name: String(args?.["name"] ?? "New server"),
        path: String(args?.["path"] ?? ""),
        version: (args?.["version"] as Server["version"]) ?? "wotlk",
        versionLabel: "WotLK 3.3.5a",
        accent: null,
        addonCount: 0,
        availability: "ready",
        canInstall: true,
      };
      servers.push(created);
      addons[created.id] = [];
      return created as T;
    }

    case "rename_server": {
      const server = servers.find((s) => s.id === args?.["id"]);
      if (server) server.name = String(args?.["name"]);
      return undefined as T;
    }

    case "forget_server": {
      const index = servers.findIndex((s) => s.id === args?.["id"]);
      if (index >= 0) servers.splice(index, 1);
      return undefined as T;
    }

    case "list_addons":
      return ((serverId && addons[serverId]) || []) as T;

    case "check_updates": {
      const rows = (serverId && addons[serverId]) || [];
      // Pinned addons are not checked at all — they must never nag.
      return rows.map((addon) =>
        addon.pinned ? { ...addon, updateStatus: "upToDate" as const } : addon,
      ) as T;
    }

    case "install_addon": {
      const url = String(args?.["url"] ?? "");
      const created = row(`github:${pathOf(url)}`, nameFrom(url), "v1.0.0");
      if (serverId) {
        addons[serverId] = [...(addons[serverId] ?? []), created];
        bumpCount(serverId);
      }
      return created as T;
    }

    case "install_addon_to_many": {
      const ids = (args?.["serverIds"] as string[]) ?? [];
      return ids.map((id) => {
        const server = servers.find((s) => s.id === id);
        const ok = server?.canInstall ?? false;
        if (ok && server) {
          addons[id] = [
            ...(addons[id] ?? []),
            row(`github:${pathOf(String(args?.["url"]))}`, nameFrom(String(args?.["url"])), "v1.0.0"),
          ];
          bumpCount(id);
        }
        return {
          serverId: id,
          serverName: server?.name ?? id,
          ok,
          message: ok
            ? "installed v1.0.0"
            : `"${server?.name ?? id}" is not reachable — your addon list has been kept.`,
        } satisfies Outcome;
      }) as T;
    }

    case "update_addon": {
      const rows = (serverId && addons[serverId]) || [];
      const found = rows.find((a) => a.addonId === args?.["addonId"]);
      if (found) {
        found.installedVersion = found.latestVersion ?? found.installedVersion;
        found.needsUpdate = false;
        found.updateStatus = "upToDate";
      }
      return (found ?? rows[0]) as T;
    }

    case "remove_addon": {
      const rows = (serverId && addons[serverId]) || [];
      const index = rows.findIndex((a) => a.addonId === args?.["addonId"]);
      const removed = index >= 0 ? rows.splice(index, 1) : [];
      if (serverId) bumpCount(serverId);
      return (removed[0]?.folders ?? []) as T;
    }

    case "set_addon_pinned": {
      const rows = (serverId && addons[serverId]) || [];
      const found = rows.find((a) => a.addonId === args?.["addonId"]);
      if (found) {
        found.pinned = Boolean(args?.["pinned"]);
        if (found.pinned) found.needsUpdate = false;
      }
      return undefined as T;
    }

    case "set_addon_channel": {
      const rows = (serverId && addons[serverId]) || [];
      const found = rows.find((a) => a.addonId === args?.["addonId"]);
      if (found) found.channel = args?.["channel"] as Addon["channel"];
      return undefined as T;
    }

    case "copy_addon_set": {
      const from = String(args?.["fromServerId"]);
      const to = String(args?.["toServerId"]);
      const source = addons[from] ?? [];
      const existing = new Set((addons[to] ?? []).map((a) => a.addonId));
      const results: string[] = [];
      for (const addon of source) {
        if (existing.has(addon.addonId)) {
          results.push(`already present: ${addon.name}`);
        } else {
          addons[to] = [...(addons[to] ?? []), { ...addon }];
          results.push(`copied ${addon.name}`);
        }
      }
      bumpCount(to);
      return results as T;
    }

    case "scan_existing_addons":
      return [
        {
          folder: "Bartender4",
          title: "Bartender4",
          version: "4.5.9",
          author: "Nevcairiel",
          related: [],
          versionMatches: true,
        },
        {
          folder: "Recount",
          title: "Recount",
          version: "1.0",
          author: "Cryect",
          related: ["Recount_Config"],
          versionMatches: true,
        },
        {
          folder: "RetailOnly",
          title: "Retail Only Addon",
          version: "11.0",
          author: "Someone",
          related: [],
          versionMatches: false,
        },
      ] as T;

    case "adopt_addon":
      return undefined as T;

    case "cancel_update_check":
      return undefined as T;

    case "removal_impact":
      // Classic API is a dependency of two other mocked addons.
      return (args?.["addonId"] === "gitlab:Tsoukie/classicapi"
        ? ["Compact Raid Frames", "Clique"]
        : []) as T;

    case "unmet_dependencies":
      return [
        {
          addonId: "github:WeakAuras/WeakAuras2",
          addonName: "WeakAuras",
          missing: ["Ace3"],
        },
      ] as T;

    case "resolve_catalog_install": {
      const id = String(args?.["entryId"]);
      const entry = catalog.find((e) => e.id === id);
      const deps = (entry?.dependencies ?? [])
        .map((depId) => catalog.find((e) => e.id === depId))
        .filter((e): e is CatalogEntry => Boolean(e));
      return [...deps, ...(entry ? [entry] : [])] as T;
    }

    case "get_catalog":
      return { status: "ok", entries: catalog } as T;

    case "export_addon_list": {
      const rows = (serverId && addons[serverId]) || [];
      return rows.map((a) => `${a.name}: ${a.sourceUrl}`).join("\n") as T;
    }

    case "parse_addon_list": {
      const text = String(args?.["text"] ?? "");
      const matches = text.match(/https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[\w.-]+\/[\w.-]+/g);
      return Array.from(new Set(matches ?? [])) as T;
    }

    case "diagnostics":
      return [
        "Brownie’s Addon Manager 2.0.0-beta.1",
        "Platform: windows x86_64",
        "GitHub token configured: false",
        "Servers: 3",
      ].join("\n") as T;

    case "open_logs_folder":
      return undefined as T;

    case "has_github_token":
      return (token !== null) as T;

    case "set_github_token":
      token = (args?.["token"] as string) || null;
      return undefined as T;

    case "set_selected_server":
    case "set_server_accent":
    case "set_theme":
    case "open_url":
      return undefined as T;

    default:
      throw { kind: "unexpected", message: `no mock for "${command}"`, folder: null };
  }
}

function bumpCount(serverId: string) {
  const server = servers.find((s) => s.id === serverId);
  if (server) server.addonCount = (addons[serverId] ?? []).length;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "New server";
}

function pathOf(url: string): string {
  const parts = url.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || "o/r";
}

function nameFrom(url: string): string {
  const parts = url.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "Addon";
}
