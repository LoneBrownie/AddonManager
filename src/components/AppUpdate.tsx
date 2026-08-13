import { useEffect, useState } from "react";
import * as appUpdate from "../appUpdate";
import type { Notify } from "../activity";
import { ConfirmDialog } from "./dialogs";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "found"; version: string }
  | { kind: "installing"; fraction: number | null };

/**
 * The Settings section for updating the app itself.
 *
 * Manual rather than automatic on purpose: this app writes into a game
 * directory, and someone mid-session does not want it restarting itself. The
 * check is one button and the install is a second, explicit one.
 */
export function AppUpdate({
  notify,
}: {
  notify: Notify;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  if (!appUpdate.available) return null;

  const busy = state.kind === "checking" || state.kind === "installing";

  return (
    <div className="field" style={{ maxWidth: 520, marginTop: 28 }}>
      <label>App updates</label>
      <span className="hint">
        Checks this repository for a newer release. Nothing is downloaded until
        you ask for it, and the app restarts only once the update is installed.
        What changed is shown after the restart, not here.
      </span>

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
                setState({ kind: "found", version: found.version });
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
    </div>
  );
}

/**
 * Which releases this installation takes, and the one-way door onto betas.
 *
 * Shown whether or not the app can update itself, because the channel is a
 * stored preference rather than an update action — and because the browser
 * build is where this gets looked at during development.
 *
 * One-way is the design, not a shortcut. Leaving would mean downgrading, a
 * beta being ahead of stable, and an older binary opening a store a newer one
 * wrote. Both honest ways back are named before anybody opts in.
 */
export function UpdateChannel({ notify }: { notify: Notify }) {
  const [channel, setChannel] = useState<appUpdate.UpdateChannel | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    appUpdate.channel().then(setChannel).catch(() => setChannel(null));
  }, []);

  if (channel === null) return null;

  return (
    <div className="field" style={{ maxWidth: 520, marginTop: 28 }}>
      <label>Update channel</label>

      {channel === "beta" ? (
        <>
          <div className="row-title">
            <strong>Beta</strong>
            <span className="tag source">opted in</span>
          </div>
          <span className="hint" style={{ marginTop: 6 }}>
            You receive beta releases as soon as they are published, and stable
            releases as well. To go back to stable only, reinstall the stable
            build — or wait for the next stable release to overtake the beta you
            are on, though betas will keep arriving after it.
          </span>
        </>
      ) : (
        <>
          <span className="hint">
            You are on <strong>stable</strong>. Betas are published for testing
            before a release and can be broken; taking them helps find that out
            before everybody else does.
          </span>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => setConfirming(true)}>
              Join the beta channel
            </button>
          </div>
          <span className="hint" style={{ marginTop: 8 }}>
            <strong>This cannot be undone from inside the app.</strong> Going
            back means reinstalling the stable build, or waiting for the next
            stable release to catch up with the beta you are running.
          </span>
        </>
      )}

      {confirming ? (
        <ConfirmDialog
          title="Join the beta channel?"
          message={
            "Beta releases are published for testing before a stable release. " +
            "They can be broken in ways a stable release is not.\n\n" +
            "There is no way back from inside the app. To return to stable you " +
            "would either reinstall the stable build, or wait for the next " +
            "stable release to overtake the beta you are running — this channel " +
            "delivers stable releases too, but betas resume after it.\n\n" +
            "Your servers and addons are not affected either way."
          }
          confirmLabel="Join the beta channel"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            try {
              await appUpdate.joinBeta();
              setChannel("beta");
              notify("info", "This installation now takes beta releases.");
            } catch (error) {
              notify(
                "error",
                `Could not switch channel: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}
