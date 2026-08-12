import { useState } from "react";
import * as api from "../api";
import type { Server } from "../api";
import { Dialog } from "./Dialog";

/** Colours that stay distinguishable against both themes. */
const ACCENTS = [
  "#8b5cf6",
  "#22d3ee",
  "#84cc16",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#a3a3a3",
];

/**
 * Why "Copy addons to…" is unavailable, or null when it is available.
 *
 * Returned as a sentence rather than a boolean so the button can say what to do
 * about it. Copying needs somewhere to copy to, something to copy, and a
 * readable source — three different problems with three different fixes.
 */
function copyBlockedBecause(server: Server, serverCount: number): string | null {
  if (serverCount < 2) {
    return "Add a second server first — there is nowhere to copy to";
  }
  if (server.addonCount === 0) {
    return "This server has no addons to copy";
  }
  if (server.availability === "unavailable") {
    return "Reconnect this server's drive to copy from it";
  }
  return null;
}

/**
 * Rename, recolour, forget, and copy an addon set between servers.
 *
 * Forgetting deliberately leaves files on disk: deregistering is not
 * uninstalling, and silently deleting someone's addons because they tidied up
 * their server list would be a nasty surprise.
 */
export function ManageServers({
  servers,
  onChanged,
  onAddServer,
  notify,
}: {
  servers: Server[];
  onChanged: () => Promise<void>;
  onAddServer: () => void;
  notify: (kind: "info" | "error" | "success", text: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [forgetting, setForgetting] = useState<Server | null>(null);
  const [copying, setCopying] = useState<Server | null>(null);

  /**
   * Point a server at a different folder.
   *
   * Separate from forget-and-re-add because that loses every addon recorded
   * against it — which is the whole reason a moved game needs this.
   */
  async function repoint(server: Server) {
    const picked = await api.pickFolder();
    if (!picked) return;
    try {
      await api.repointServer(server.id, picked);
      await onChanged();
      notify("success", `${server.name} now points at ${picked}`);
    } catch (error) {
      // A folder that does not look like a game directory is refused; offer
      // the same override the add flow has rather than a dead end.
      const message = api.errorMessage(error);
      if (window.confirm(`${message}\n\nUse it anyway?`)) {
        try {
          await api.repointServer(server.id, picked, true);
          await onChanged();
          notify("success", `${server.name} now points at ${picked}`);
        } catch (retry) {
          notify("error", api.errorMessage(retry));
        }
      }
    }
  }

  async function saveName(server: Server) {
    const name = draftName.trim();
    setEditing(null);
    if (!name || name === server.name) return;
    try {
      await api.renameServer(server.id, name);
      await onChanged();
    } catch (error) {
      notify("error", api.errorMessage(error));
    }
  }

  async function setAccent(server: Server, accent: string) {
    try {
      await api.setServerAccent(server.id, accent);
      await onChanged();
    } catch (error) {
      notify("error", api.errorMessage(error));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Servers</h2>
          <p>Each one is a separate game folder with its own addons.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onAddServer}>
            Add a server
          </button>
        </div>
      </div>

      <div className="page-body">
        {servers.length === 0 ? (
          <div className="empty">
            <h3>No servers yet</h3>
            <p>Add the folder containing your WoW executable to get started.</p>
            <button type="button" className="btn primary" onClick={onAddServer}>
              Add a server
            </button>
          </div>
        ) : (
          <div className="rows">
            {servers.map((server) => (
              <div className="row server-row" key={server.id}>
                <div className="row-main">
                  <div className="row-title">
                    <span
                      className="swatch"
                      style={{
                        background: server.accent ?? "var(--accent)",
                        minHeight: 16,
                        width: 6,
                      }}
                      aria-hidden="true"
                    />
                    {editing === server.id ? (
                      <input
                        className="input"
                        style={{ maxWidth: 240 }}
                        value={draftName}
                        autoFocus
                        aria-label={`Rename ${server.name}`}
                        onChange={(event) => setDraftName(event.target.value)}
                        onBlur={() => void saveName(server)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void saveName(server);
                          if (event.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <strong>{server.name}</strong>
                    )}
                    <span className="tag">{server.versionLabel}</span>
                    {server.availability === "unavailable" ? (
                      <span className="tag error">offline</span>
                    ) : null}
                    {server.availability === "readOnly" ? (
                      <span className="tag error">read-only</span>
                    ) : null}
                  </div>
                  <div className="row-sub" title={server.path}>
                    {server.path} · {server.addonCount} addon
                    {server.addonCount === 1 ? "" : "s"}
                  </div>
                  {server.availability === "readOnly" ? (
                    // Naming the state without a way out is what the red tag
                    // did on its own. Elevating instead is what V1 did, and is
                    // the thing this app exists partly to avoid.
                    <div className="row-note">
                      Addons can’t be written here, due to admin restrictions.
                      Move your game folder to a location that isn’t
                      write-protected.
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 5, marginTop: 8 }}>
                    {ACCENTS.map((colour) => (
                      <button
                        key={colour}
                        type="button"
                        aria-label={`Set colour ${colour}`}
                        aria-pressed={server.accent === colour}
                        onClick={() => void setAccent(server, colour)}
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          background: colour,
                          border:
                            server.accent === colour
                              ? "2px solid var(--ink)"
                              : "1px solid var(--rule)",
                          padding: 0,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="row-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setEditing(server.id);
                      setDraftName(server.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void repoint(server)}
                    title="Point this server at a different folder, keeping its addons"
                  >
                    Change folder
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={async () => {
                      try {
                        await api.openServerFolder(server.id);
                      } catch (error) {
                        notify("error", api.errorMessage(error));
                      }
                    }}
                    disabled={server.availability === "unavailable"}
                    title="Open this server's Interface/AddOns folder"
                  >
                    Open folder
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => setCopying(server)}
                    disabled={Boolean(copyBlockedBecause(server, servers.length))}
                    // A disabled button that does not say why is just a dead
                    // control. Every reason it can be disabled gets its own
                    // sentence, because "add a second server first" and
                    // "reconnect the drive" are entirely different problems.
                    title={
                      copyBlockedBecause(server, servers.length) ??
                      "Copy this server's addons to another server"
                    }
                  >
                    Copy addons to…
                  </button>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => setForgetting(server)}
                  >
                    Forget
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {forgetting ? (
        <Dialog
          title={`Forget ${forgetting.name}?`}
          onClose={() => setForgetting(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setForgetting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  const server = forgetting;
                  setForgetting(null);
                  try {
                    await api.forgetServer(server.id);
                    await onChanged();
                    notify("success", `Stopped managing ${server.name}`);
                  } catch (error) {
                    notify("error", api.errorMessage(error));
                  }
                }}
              >
                Forget it
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            This app will stop tracking {forgetting.name}.{" "}
            <strong>The addon files stay exactly where they are</strong> — nothing
            is uninstalled. You can add the folder again later.
          </p>
        </Dialog>
      ) : null}

      {copying ? (
        <CopySetDialog
          from={copying}
          servers={servers}
          onClose={() => setCopying(null)}
          onDone={async (lines) => {
            setCopying(null);
            await onChanged();
            notify("success", `Copied: ${lines.length} addon(s) processed`);
          }}
          notify={notify}
        />
      ) : null}
    </>
  );
}

function CopySetDialog({
  from,
  servers,
  onClose,
  onDone,
  notify,
}: {
  from: Server;
  servers: Server[];
  onClose: () => void;
  onDone: (lines: string[]) => Promise<void>;
  notify: (kind: "info" | "error" | "success", text: string) => void;
}) {
  const targets = servers.filter(
    (server) => server.id !== from.id && server.canInstall,
  );
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      title="Copy addons to another server"
      description={`Everything installed to ${from.name}.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!target || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const lines = await api.copyAddonSet(from.id, target);
                await onDone(lines);
              } catch (error) {
                notify("error", api.errorMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Copying…" : "Copy"}
          </button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p style={{ margin: 0 }}>There is no other server available to copy into.</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="copy-target">Copy to</label>
            <select
              id="copy-target"
              className="select"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {targets.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} — {server.versionLabel}
                </option>
              ))}
            </select>
          </div>
          <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13 }}>
            Files are copied straight across, so the target gets the versions you
            already have rather than whatever is newest upstream. Addons already
            on the target are left alone, and nothing that this app did not
            install is overwritten.
          </p>
        </>
      )}
    </Dialog>
  );
}
