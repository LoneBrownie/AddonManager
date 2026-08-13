/**
 * Updating the app itself.
 *
 * Kept out of `api.ts` because these are about the application rather than the
 * addon engine, but they are the same shape: intent-level Rust commands of
 * ours. They used to be Tauri's updater plugin called straight from here, and
 * moved behind commands so the beta channel could pick which manifest to read
 * — a choice the plugin's JavaScript API cannot express.
 *
 * Outside Tauri there is nothing to update, so `available` is false and the
 * interface hides the section rather than offering a button that cannot work.
 * The *channel* is a stored preference, so it is readable either way.
 */

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const available = inTauri;

export interface UpdateInfo {
  version: string;
}

export type UpdateChannel = "stable" | "beta";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  const { mockInvoke } = await import("./mock");
  return mockInvoke<T>(command, args);
}

/** Which releases this installation takes. */
export const channel = () => call<UpdateChannel>("update_channel");

/**
 * Move onto the beta channel, permanently.
 *
 * There is no matching `leave`: see the Rust command for why, and the dialog
 * that precedes this for what the user is told.
 */
export const joinBeta = () => call<void>("join_beta_channel");

/**
 * Ask whether a newer version exists on this installation's channel.
 *
 * Returns null when the app is already current. A rejection means the check
 * itself failed — no network, or no manifest published yet — which the caller
 * reports differently from "you are up to date".
 */
export async function check(): Promise<UpdateInfo | null> {
  if (!inTauri) return null;
  // The manifest carries the release notes and they are deliberately not read
  // here. They are Markdown, and the place to show them is the window that
  // appears after the restart, which renders them — not a raw dump beside a
  // button, which is what this used to be.
  return call<UpdateInfo | null>("check_for_update");
}

/**
 * Download and install the update, then restart.
 *
 * `onProgress` receives a fraction between 0 and 1, or null while the download
 * size is still unknown — some servers do not send a content length, and a
 * progress bar that invents one is worse than a spinner.
 */
export async function installAndRelaunch(
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  if (!inTauri) throw new Error("there is nothing to update outside the app");

  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const progress = new Channel<{ downloaded: number; total: number | null }>();
  progress.onmessage = ({ downloaded, total }) =>
    onProgress(total && total > 0 ? downloaded / total : null);

  await invoke<void>("install_update", { progress });

  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
