import { useEffect, useState } from "react";
import {
  errorMessage,
  inspectFolder,
  listGameVersions,
  pickFolder,
  type FolderVerdict,
  type GameVersion,
  type GameVersionOption,
  type Server,
} from "../api";
import { Dialog } from "./Dialog";

/**
 * Add a server: browse, pick the version, name it.
 *
 * There is no scan and no detection. Private-server clients are extracted to
 * arbitrary paths, so the user tells us where and which version (D8).
 */
export function AddServerDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (name: string, path: string, version: GameVersion, force: boolean) => Promise<void>;
}) {
  const [versions, setVersions] = useState<GameVersionOption[]>([]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState<GameVersion>("wotlk");
  const [verdict, setVerdict] = useState<FolderVerdict | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listGameVersions().then(setVersions).catch(() => setVersions([]));
  }, []);

  async function browse() {
    try {
      const chosen = await pickFolder();
      if (!chosen) return;
      setPath(chosen);
      const result = await inspectFolder(chosen);
      setVerdict(result);
      if (!name && result.suggestedName) setName(result.suggestedName);
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await onAdd(name.trim(), path, version, verdict?.verdict === "rejected");
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setSaving(false);
    }
  }

  const ready = path.length > 0 && name.trim().length > 0 && !saving;

  return (
    <Dialog
      title="Add a server"
      description="Point at the folder that contains the game executable."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={!ready}>
            {saving ? "Adding…" : "Add server"}
          </button>
        </>
      }
    >
      {error ? <div className="banner bad">{error}</div> : null}

      <div className="field">
        <label htmlFor="server-path">Game folder</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="server-path"
            className="input"
            value={path}
            placeholder="D:\Games\Epoch"
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="button" className="btn" onClick={browse}>
            Browse…
          </button>
        </div>
        {verdict ? (
          <span className="hint">
            {verdict.verdict === "confident"
              ? "✓ Looks like a WoW installation."
              : verdict.reason}
          </span>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="server-version">Game version</label>
        <select
          id="server-version"
          className="select"
          value={version}
          onChange={(event) => setVersion(event.target.value as GameVersion)}
        >
          {versions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="hint">
          Used to warn you when an addon targets a different version.
        </span>
      </div>

      <div className="field">
        <label htmlFor="server-name">Name</label>
        <input
          id="server-name"
          className="input"
          value={name}
          placeholder="Project Epoch"
          onChange={(event) => setName(event.target.value)}
        />
        <span className="hint">
          Usually the server's name. You can run several folders on the same
          game version.
        </span>
      </div>
    </Dialog>
  );
}

/** Install an addon from a URL, into this server or several at once. */
export function AddAddonDialog({
  servers,
  currentServerId,
  onClose,
  onInstall,
}: {
  servers: Server[];
  currentServerId: string;
  onClose: () => void;
  onInstall: (url: string, serverIds: string[], channel: "release" | "source") => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [channel, setChannel] = useState<"release" | "source">("release");
  const [targets, setTargets] = useState<string[]>([currentServerId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onInstall(url.trim(), targets, channel);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  const installable = servers.filter((server) => server.canInstall);

  return (
    <Dialog
      title="Add an addon"
      description="Paste a GitHub or GitLab repository URL."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={busy || url.trim().length === 0 || targets.length === 0}
          >
            {busy ? "Installing…" : `Install to ${targets.length} server${targets.length === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      {error ? <div className="banner bad">{error}</div> : null}

      <div className="field">
        <label htmlFor="addon-url">Repository URL</label>
        <input
          id="addon-url"
          className="input"
          value={url}
          placeholder="https://github.com/owner/addon"
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="addon-channel">Track</label>
        <select
          id="addon-channel"
          className="select"
          value={channel}
          onChange={(event) => setChannel(event.target.value as "release" | "source")}
        >
          <option value="release">Tagged releases (recommended)</option>
          <option value="source">Latest source build</option>
        </select>
        <span className="hint">
          Source builds suit addons that never cut releases. You can change this
          per addon later.
        </span>
      </div>

      <div className="field">
        <label>Install to</label>
        <span className="hint">
          Only the servers you tick. By default that is just the one you have
          selected.
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {installable.map((server) => (
            <label
              key={server.id}
              style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}
            >
              <input
                type="checkbox"
                checked={targets.includes(server.id)}
                onChange={(event) =>
                  setTargets((current) =>
                    event.target.checked
                      ? [...current, server.id]
                      : current.filter((id) => id !== server.id),
                  )
                }
              />
              {server.name}
              <span className="tag">{server.versionLabel}</span>
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/** Confirm a destructive or surprising action. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message}</p>
    </Dialog>
  );
}
