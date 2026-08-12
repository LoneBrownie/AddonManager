/**
 * Updating the app itself.
 *
 * Deliberately separate from `api.ts`: everything there is an intent-level Rust
 * command of ours, whereas this is Tauri's updater plugin. Keeping them apart
 * stops the update flow from looking like part of the addon engine.
 *
 * Outside Tauri there is nothing to update, so `available` is false and the
 * interface hides the section rather than offering a button that cannot work.
 */

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const available = inTauri;

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** The update handle, kept between checking and installing. */
type Handle = { version: string; body?: string; downloadAndInstall: (
  onEvent: (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
) => Promise<void> };

let pending: Handle | null = null;

/**
 * Ask whether a newer version exists.
 *
 * Returns null when the app is already current. A rejection means the check
 * itself failed — no network, or no manifest published yet — which the caller
 * reports differently from "you are up to date".
 */
export async function check(): Promise<UpdateInfo | null> {
  if (!inTauri) return null;
  const { check: pluginCheck } = await import("@tauri-apps/plugin-updater");
  const update = await pluginCheck();
  if (!update) {
    pending = null;
    return null;
  }
  pending = update as unknown as Handle;
  return { version: update.version, notes: update.body ?? null };
}

/**
 * Download and install the update found by [`check`], then restart.
 *
 * `onProgress` receives a fraction between 0 and 1, or null while the download
 * size is still unknown — some servers do not send a content length, and a
 * progress bar that invents one is worse than a spinner.
 */
export async function installAndRelaunch(
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  if (!pending) throw new Error("no update has been found to install");

  let total = 0;
  let downloaded = 0;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data?.contentLength ?? 0;
      onProgress(null);
    } else if (event.event === "Progress") {
      downloaded += event.data?.chunkLength ?? 0;
      onProgress(total > 0 ? downloaded / total : null);
    } else if (event.event === "Finished") {
      onProgress(1);
    }
  });

  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
