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
  onInstalled,
}: {
  server: Server;
  onClose: () => void;
  onDone: (installed: number, failed: string[]) => void;
  /** One addon landed. Importing thirty takes minutes; the list behind this
   *  dialog should fill up as they arrive rather than all at the end. */
  onInstalled: () => void;
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

    try {
      for (const [index, url] of urls.entries()) {
        setProgress({ done: index, total: urls.length });
        try {
          // An imported list is a list of addons the user already runs, so the
          // two things that make an import fail wholesale are handled rather
          // than reported: a repository with no releases installs from its
          // branch, and one already sitting in the game folder is taken over
          // where it stands instead of being downloaded over the top.
          await api.installAddon(server.id, url, "release", {
            fallbackToSource: true,
            adoptExisting: true,
          });
          installed += 1;
          onInstalled();
        } catch (thrown) {
          // One bad URL in a pasted list must not abandon the rest.
          failed.push(`${url} — ${api.errorMessage(thrown)}`);
        }
      }
    } finally {
      // Whatever went wrong, the list has to end up describing the disk.
      setProgress(null);
      onDone(installed, failed);
    }
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
/**
 * Take over one folder that is already on disk.
 *
 * The repository URL is asked for, never guessed: most 3.3.5a addons are
 * backports, so an addon's own metadata usually names the upstream project
 * rather than the fork actually installed, and guessing would point updates at
 * the wrong repository (V2-PLAN.md D-b).
 */
export function AdoptDialog({
  server,
  found,
  onClose,
  onAdopted,
}: {
  server: Server;
  found: FoundAddon;
  onClose: () => void;
  onAdopted: (folder: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [includeRelated, setIncludeRelated] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function adopt() {
    setBusy(true);
    setError(null);
    try {
      const folders =
        includeRelated && found.related.length > 0
          ? [found.folder, ...found.related]
          : [found.folder];
      await api.adoptAddon(server.id, folders, url.trim(), found.title ?? undefined);
      onAdopted(found.folder);
    } catch (thrown) {
      setError(api.errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Manage ${found.title ?? found.folder}`}
      description={`Already in ${server.name}, but this app does not track it yet.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={adopt}
            disabled={busy || url.trim().length === 0}
          >
            {busy ? "Adding…" : "Manage this addon"}
          </button>
        </>
      }
    >
      {error ? <div className="banner bad">{error}</div> : null}

      <div className="field">
        <label>Folder</label>
        <div className="row-sub" style={{ marginTop: 0 }}>
          {found.folder}
          {found.version ? ` · ${found.version}` : ""}
          {found.author ? ` · by ${found.author}` : ""}
        </div>
      </div>

      {found.related.length > 0 ? (
        <div className="field">
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={includeRelated}
              onChange={(event) => setIncludeRelated(event.target.checked)}
            />
            Also take over {found.related.join(", ")}
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
          autoFocus
          placeholder="https://github.com/owner/repo"
          onChange={(event) => setUrl(event.target.value)}
        />
        <span className="hint">
          The repository <em>you</em> installed this from. It is not guessed:
          most 3.3.5a addons are backports, so the original project is usually
          the wrong answer.
        </span>
      </div>
    </Dialog>
  );
}
