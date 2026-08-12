/**
 * The only way this UI reaches the disk or the network.
 *
 * Every function here maps to one intent-level Rust command. There is no
 * `readFile`, no `writeFile`, no `download` — V1 exposed exactly those to the
 * renderer and that is what made it unsafe (V2-PLAN.md S1).
 *
 * Outside Tauri, calls are served by `mock.ts` so the interface can be
 * developed and screenshotted in a plain browser.
 */

export type GameVersion = "vanilla" | "tbc" | "wotlk";
export type Channel = "release" | "source";
export type Availability = "ready" | "readOnly" | "unavailable";

export interface Server {
  id: string;
  name: string;
  path: string;
  version: GameVersion;
  versionLabel: string;
  accent: string | null;
  addonCount: number;
  availability: Availability;
  canInstall: boolean;
}

export interface Addon {
  addonId: string;
  name: string;
  sourceUrl: string;
  sourceKind: "github" | "gitlab" | "direct";
  channel: Channel;
  /** The tracked channel no longer matches what is installed. */
  channelPending: boolean;
  pinned: boolean;
  installedVersion: string;
  latestVersion: string | null;
  updateStatus:
    | "upToDate"
    | "updateAvailable"
    | "channelChanged"
    | "error"
    | "unknown";
  needsUpdate: boolean;
  folders: string[];
  /** Recorded folders no longer on disk — removed outside this app. */
  missingFolders: string[];
  installedAt: string;
  /** False when the addon targets a different game version than this server. */
  versionMatches: boolean;
}

export interface FolderVerdict {
  verdict: "confident" | "plausible" | "rejected";
  reason: string | null;
  usable: boolean;
  suggestedName: string | null;
}

export interface GameVersionOption {
  value: GameVersion;
  label: string;
  interfaceVersion: number;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  repoUrl: string;
  category: string;
  dependencies: string[];
  /** Absent for the usual case — tagged releases. */
  channel?: Channel;
  installed: boolean;
}

/** The curated list, plus why it might be empty. */
export interface CatalogResult {
  status: "ok" | "noServer" | "noListForVersion" | "unavailable" | "malformed";
  entries: CatalogEntry[];
}

/** An addon folder on disk that this app does not manage yet. */
export interface FoundAddon {
  folder: string;
  title: string | null;
  version: string | null;
  author: string | null;
  /** Sibling folders that look like parts of the same addon. A suggestion. */
  related: string[];
  /** False when the addon targets a different game version than this server. */
  versionMatches: boolean;
}

/** An addon whose declared dependencies are not all present. */
export interface Unmet {
  addonId: string;
  addonName: string;
  missing: string[];
}

export interface Outcome {
  serverId: string;
  serverName: string;
  ok: boolean;
  message: string;
}

/** A failure the UI can branch on. */
export interface AppError {
  kind: string;
  message: string;
  folder: string | null;
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value
  );
}

/** Extract something worth showing, whatever was thrown. */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  const { mockInvoke } = await import("./mock");
  return mockInvoke<T>(command, args);
}

/** Native folder picker. Falls back to a prompt in the browser. */
export async function pickFolder(): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }
  const { mockPickFolder } = await import("./mock");
  return mockPickFolder();
}

// --- servers ---------------------------------------------------------------

export const listServers = () => call<Server[]>("list_servers");
export const listGameVersions = () => call<GameVersionOption[]>("list_game_versions");
export const inspectFolder = (path: string) =>
  call<FolderVerdict>("inspect_folder", { path });
export const addServer = (
  name: string,
  path: string,
  version: GameVersion,
  force = false,
) => call<Server>("add_server", { name, path, version, force });
export const renameServer = (id: string, name: string) =>
  call<void>("rename_server", { id, name });
export const setServerAccent = (id: string, accent: string | null) =>
  call<void>("set_server_accent", { id, accent });
export const forgetServer = (id: string) => call<void>("forget_server", { id });
/** Point a server at a different folder, keeping its addons. */
export const repointServer = (id: string, path: string, force = false) =>
  call<Server>("repoint_server", { id, path, force });
export const setSelectedServer = (id: string | null) =>
  call<void>("set_selected_server", { id });
export const scanExistingAddons = (serverId: string) =>
  call<FoundAddon[]>("scan_existing_addons", { serverId });
export const adoptAddon = (
  serverId: string,
  folders: string[],
  url: string,
  name?: string,
) => call<void>("adopt_addon", { serverId, folders, url, name });
export const copyAddonSet = (
  fromServerId: string,
  toServerId: string,
  overwriteUnmanaged = false,
) => call<string[]>("copy_addon_set", { fromServerId, toServerId, overwriteUnmanaged });

// --- addons ----------------------------------------------------------------

export const listAddons = (serverId: string) =>
  call<Addon[]>("list_addons", { serverId });
export const installAddon = (
  serverId: string,
  url: string,
  channel: Channel = "release",
  overwriteUnmanaged = false,
) => call<Addon>("install_addon", { serverId, url, channel, overwriteUnmanaged });
export const installAddonToMany = (
  serverIds: string[],
  url: string,
  channel: Channel = "release",
) => call<Outcome[]>("install_addon_to_many", { serverIds, url, channel });
export const removeAddon = (serverId: string, addonId: string) =>
  call<string[]>("remove_addon", { serverId, addonId });
export const checkUpdates = (serverId: string) =>
  call<Addon[]>("check_updates", { serverId });
export const cancelUpdateCheck = (serverId: string) =>
  call<void>("cancel_update_check", { serverId });
export const removalImpact = (serverId: string, addonId: string) =>
  call<string[]>("removal_impact", { serverId, addonId });
export const unmetDependencies = (serverId: string) =>
  call<Unmet[]>("unmet_dependencies", { serverId });
export const resolveCatalogInstall = (serverId: string, entryId: string) =>
  call<CatalogEntry[]>("resolve_catalog_install", { serverId, entryId });
export const updateAddon = (serverId: string, addonId: string) =>
  call<Addon>("update_addon", { serverId, addonId });
export const setAddonPinned = (serverId: string, addonId: string, pinned: boolean) =>
  call<void>("set_addon_pinned", { serverId, addonId, pinned });
export const setAddonChannel = (
  serverId: string,
  addonId: string,
  channel: Channel,
) => call<Addon>("set_addon_channel", { serverId, addonId, channel });

// --- catalogue, sharing, settings ------------------------------------------

export const getCatalog = (serverId: string | null) =>
  call<CatalogResult>("get_catalog", { serverId });
export const exportAddonList = (serverId: string) =>
  call<string>("export_addon_list", { serverId });
export const parseAddonList = (text: string) =>
  call<string[]>("parse_addon_list", { text });
export const hasGithubToken = () => call<boolean>("has_github_token");
export const setGithubToken = (token: string | null) =>
  call<void>("set_github_token", { token });
export const openUrl = (url: string) => call<void>("open_url", { url });
export const appVersion = () => call<string>("app_version");
export const openLogsFolder = () => call<void>("open_logs_folder");
/** Open a server's `Interface/AddOns` in the system file manager. */
export const openServerFolder = (serverId: string) =>
  call<void>("open_server_folder", { serverId });
export const diagnostics = () => call<string>("diagnostics");
