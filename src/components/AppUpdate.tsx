import { useEffect, useState } from "react";
import * as api from "../api";
import * as appUpdate from "../appUpdate";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "found"; version: string; notes: string | null }
  | { kind: "installing"; fraction: number | null };

/**
 * The Settings section for the app itself: which version this is, and whether
 * there is a newer one.
 *
 * Manual rather than automatic on purpose: this app writes into a game
 * directory, and someone mid-session does not want it restarting itself. The
 * check is one button and the install is a second, explicit one.
 */
export function AppUpdate({
  notify,
}: {
  notify: (kind: "success" | "error" | "info", text: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [version, setVersion] = useState<string | null>(null);

  // Shown whether or not the updater can run, because "which version am I on"
  // is the first thing a bug report needs and the browser build has no updater.
  useEffect(() => {
    api.appVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  const busy = state.kind === "checking" || state.kind === "installing";

  return (
    <div className="field" style={{ maxWidth: 520, marginTop: 28 }}>
      <label>This app</label>
      <span className="hint">
        Version <strong>{version ?? "…"}</strong>
        {appUpdate.available
          ? ". Checking looks for a newer release; nothing is downloaded until you ask for it, and the app restarts only once an update is installed."
          : "."}
      </span>

      {!appUpdate.available ? null : (
      <>
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setState({ kind: "checking" });
            try {
              const found = await appUpdate.check();
              if (found) {
                setState({
                  kind: "found",
                  version: found.version,
                  notes: found.notes,
                });
              } else {
                setState({ kind: "current" });
              }
            } catch (error) {
              setState({ kind: "idle" });
              notify(
                "error",
                `Could not check for updates: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }}
        >
          {state.kind === "checking" ? "Checking…" : "Check for updates"}
        </button>

        {state.kind === "found" ? (
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              setState({ kind: "installing", fraction: null });
              try {
                await appUpdate.installAndRelaunch((fraction) =>
                  setState({ kind: "installing", fraction }),
                );
              } catch (error) {
                setState({ kind: "idle" });
                notify(
                  "error",
                  `Update failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            }}
          >
            Install {state.version} and restart
          </button>
        ) : null}
      </div>

      {state.kind === "current" ? (
        <span className="hint" style={{ marginTop: 8 }}>
          You are on the latest version.
        </span>
      ) : null}

      {state.kind === "installing" ? (
        <span className="hint" style={{ marginTop: 8 }}>
          {state.fraction === null
            ? "Downloading…"
            : `Downloading… ${Math.round(state.fraction * 100)}%`}
        </span>
      ) : null}

      {state.kind === "found" && state.notes ? (
        <pre className="hint" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
          {state.notes}
        </pre>
      ) : null}
      </>
      )}
    </div>
  );
}
