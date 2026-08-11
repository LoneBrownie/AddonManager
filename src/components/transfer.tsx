import { useEffect, useState } from "react";
import * as api from "../api";
import type { FoundAddon, Server } from "../api";
import { Dialog } from "./Dialog";

/**
 * Paste an addon list and install everything in it.
 *
 * **This is the migration path from V1.** V1's export carries the URLs the user
 * actually installed from, which is the only reliable source of that
 * information — private-server addons are largely backports and forks, so
 * nothing on disk can tell you which repo a folder came from.
 */
export function ImportListDialog({
  server,
  onClose,
  onDone,
}: {
  server: Server;
  onClose: () => void;
  onDone: (installed: number, failed: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [urls, setUrls] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-parse as the user types, so the count is live rather than a surprise.
  useEffect(() => {
    if (!text.trim()) {
      setUrls([]);
      return;
    }
    let cancelled = false;
    setParsing(true);
    api
      .parseAddonList(text)
      .then((found) => {
        if (!cancelled) setUrls(found);
      })
      .catch(() => {
        if (!cancelled) setUrls([]);
      })
      .finally(() => {
        if (!cancelled) setParsing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  async function install() {
    setError(null);
    const failed: string[] = [];
    let installed = 0;

    for (const [index, url] of urls.entries()) {
      setProgress({ done: index, total: urls.length });
      try {
        await api.installAddon(server.id, url);
        installed += 1;
      } catch (thrown) {
        // One bad URL in a pasted list must not abandon the rest.
        failed.push(`${url} — ${api.errorMessage(thrown)}`);
      }
    }

    setProgress(null);
    onDone(installed, failed);
  }

  return (
    <Dialog
      title="Import an addon list"
      description={`Paste a list and install it into ${server.name}.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={progress !== null}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={install}
            disabled={urls.length === 0 || progress !== null}
          >
            {progress
              ? `Installing ${progress.done + 1} of ${progress.total}…`
              : `Install ${urls.length} addon${urls.length === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      {error ? <div className="banner bad">{error}</div> : null}

      <div className="banner">
        <strong>Moving over from V1?</strong> Open V1, use <em>Export Addon List</em>,
        and paste the result here. That list carries the exact repositories you
        installed from — which is something no amount of inspecting the folders
        on disk can work out, since most 3.3.5a addons are backports.
      </div>

      <div className="field">
        <label htmlFor="import-text">Addon list</label>
        <textarea
          id="import-text"
          className="input"
          value={text}
          placeholder={"Questie: https://github.com/owner/questie-335\nClassic API: https://gitlab.com/Tsoukie/classicapi"}
          onChange={(event) => setText(event.target.value)}
        />
        <span className="hint">
          {parsing
            ? "Reading…"
            : urls.length > 0
              ? `${urls.length} repository URL${urls.length === 1 ? "" : "s"} found. Anything else in the text is ignored.`
              : "Paste a V1 export, or any text containing GitHub and GitLab URLs."}
        </span>
      </div>

      {urls.length > 0 ? (
        <div className="rows" style={{ maxHeight: 190, overflowY: "auto" }}>
          {urls.map((url) => (
            <div className="row" key={url} style={{ padding: "8px 11px" }}>
              <div className="row-sub" style={{ marginTop: 0 }}>
                {url}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Dialog>
  );
}

/** Copy this server's addon list out as shareable text. */
export function ExportListDialog({
  server,
  onClose,
}: {
  server: Server;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.exportAddonList(server.id).then(setText).catch(() => setText(""));
  }, [server.id]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the textarea is selectable regardless.
      setCopied(false);
    }
  }

  return (
    <Dialog
      title="Export addon list"
      description={`Everything installed to ${server.name}.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn primary" onClick={copy} disabled={!text}>
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
        </>
      }
    >
      <div className="field">
        <textarea
          className="input"
          readOnly
          value={text || "Nothing installed to this server yet."}
          aria-label="Addon list"
          onFocus={(event) => event.currentTarget.select()}
        />
        <span className="hint">
          Share this with a guildmate, or keep it as a record. Pasting it into
          Import brings the same addons back.
        </span>
      </div>
    </Dialog>
  );
}

/**
 * Take over addon folders already sitting in the game directory.
 *
 * The user picks a folder and supplies its repository URL, which is how V1
 * worked and the only honest option: nothing on disk reveals which fork or
 * backport a given folder came from.
 */
export function ImportExistingDialog({
  server,
  onClose,
  onAdopted,
}: {
  server: Server;
  onClose: () => void;
  onAdopted: (folder: string) => void;
}) {
  const [found, setFound] = useState<FoundAddon[] | null>(null);
  const [selected, setSelected] = useState<FoundAddon | null>(null);
  const [url, setUrl] = useState("");
  const [includeRelated, setIncludeRelated] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .scanExistingAddons(server.id)
      .then(setFound)
      .catch((thrown) => {
        setError(api.errorMessage(thrown));
        setFound([]);
      });
  }, [server.id]);

  async function adopt() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const folders =
        includeRelated && selected.related.length > 0
          ? [selected.folder, ...selected.related]
          : [selected.folder];
      await api.adoptAddon(server.id, folders, url.trim(), selected.title ?? undefined);
      onAdopted(selected.folder);
      setSelected(null);
      setUrl("");
      setFound((current) =>
        (current ?? []).filter(
          (item) => item.folder !== selected.folder && !folders.includes(item.folder),
        ),
      );
    } catch (thrown) {
      setError(api.errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Import existing addons"
      description={`Folders in ${server.name} that this app does not manage yet.`}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      {error ? <div className="banner bad">{error}</div> : null}

      {found === null ? (
        <p>
          <span className="spinner" /> Scanning…
        </p>
      ) : found.length === 0 ? (
        <div className="empty">
          <h3>Nothing unmanaged</h3>
          <p>Every addon folder here is already managed by this app.</p>
        </div>
      ) : selected ? (
        <>
          <div className="field">
            <label>Folder</label>
            <div className="row-sub" style={{ marginTop: 0 }}>
              {selected.folder}
              {selected.version ? ` · ${selected.version}` : ""}
              {selected.author ? ` · by ${selected.author}` : ""}
            </div>
          </div>

          {selected.related.length > 0 ? (
            <div className="field">
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={includeRelated}
                  onChange={(event) => setIncludeRelated(event.target.checked)}
                />
                Also take over {selected.related.join(", ")}
              </label>
              <span className="hint">
                These share a name prefix, so they are probably parts of the same
                addon. Untick if they are separate.
              </span>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="adopt-url">Repository URL</label>
            <input
              id="adopt-url"
              className="input"
              value={url}
              placeholder="https://github.com/owner/repo"
              onChange={(event) => setUrl(event.target.value)}
            />
            <span className="hint">
              The repository <em>you</em> installed this from. It is not guessed:
              most 3.3.5a addons are backports, so the original project is
              usually the wrong answer.
            </span>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={() => setSelected(null)}>
              Back
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={adopt}
              disabled={busy || url.trim().length === 0}
            >
              {busy ? "Adding…" : "Manage this addon"}
            </button>
          </div>
        </>
      ) : (
        <div className="rows">
          {found.map((item) => (
            <div className="row" key={item.folder}>
              <div className="row-main">
                <div className="row-title">
                  <strong>{item.title ?? item.folder}</strong>
                  {!item.versionMatches ? (
                    <span className="tag error">built for another version</span>
                  ) : null}
                  {item.related.length > 0 ? (
                    <span className="tag">+{item.related.length} folder</span>
                  ) : null}
                </div>
                <div className="row-sub">
                  {item.folder}
                  {item.version ? ` · ${item.version}` : ""}
                </div>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setSelected(item);
                    setUrl("");
                    setIncludeRelated(true);
                  }}
                >
                  Manage…
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
