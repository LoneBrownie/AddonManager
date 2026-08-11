import { useCallback, useEffect, useMemo, useState } from "react";
import logo from "./img/Logo.png";
import * as api from "./api";
import type { Addon, CatalogEntry, Server } from "./api";
import { AddonList } from "./components/AddonList";
import { ServerSwitcher } from "./components/ServerSwitcher";
import { AddAddonDialog, AddServerDialog, ConfirmDialog } from "./components/dialogs";
import { ManageServers } from "./components/ManageServers";
import {
  ExportListDialog,
  ImportExistingDialog,
  ImportListDialog,
} from "./components/transfer";

type Page = "addons" | "browse" | "servers" | "settings";
type Toast = { id: number; kind: "info" | "error" | "success"; text: string };

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [page, setPage] = useState<Page>("addons");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showAddServer, setShowAddServer] = useState(false);
  const [showAddAddon, setShowAddAddon] = useState(false);
  const [confirming, setConfirming] = useState<Addon | null>(null);
  const [transfer, setTransfer] = useState<"import" | "export" | "existing" | null>(null);
  const [unmet, setUnmet] = useState<api.Unmet[]>([]);
  const [dependents, setDependents] = useState<string[]>([]);

  const selected = useMemo(
    () => servers.find((server) => server.id === selectedId) ?? null,
    [servers, selectedId],
  );

  const notify = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, text }]);
    // Errors stay until dismissed; they usually need reading.
    if (kind !== "error") {
      setTimeout(() => setToasts((c) => c.filter((t) => t.id !== id)), 4000);
    }
  }, []);

  const refreshServers = useCallback(async () => {
    try {
      const list = await api.listServers();
      setServers(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    } catch (error) {
      notify("error", api.errorMessage(error));
    }
  }, [notify]);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  useEffect(() => {
    if (!selectedId) {
      setAddons([]);
      return;
    }
    api
      .listAddons(selectedId)
      .then(setAddons)
      .catch((error) => notify("error", api.errorMessage(error)));
    api
      .unmetDependencies(selectedId)
      .then(setUnmet)
      .catch(() => setUnmet([]));
    void api.setSelectedServer(selectedId);
  }, [selectedId, notify]);

  const markBusy = (addonId: string, working: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (working) next.add(addonId);
      else next.delete(addonId);
      return next;
    });

  async function handleCheckUpdates() {
    if (!selectedId) return;
    setChecking(true);
    try {
      const rows = await api.checkUpdates(selectedId);
      setAddons(rows);
      const count = rows.filter((row) => row.needsUpdate).length;
      notify(
        count > 0 ? "info" : "success",
        count > 0
          ? `${count} update${count === 1 ? "" : "s"} available`
          : "Everything is up to date",
      );
    } catch (error) {
      notify("error", api.errorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate(addonId: string) {
    if (!selectedId) return;
    markBusy(addonId, true);
    try {
      const updated = await api.updateAddon(selectedId, addonId);
      setAddons((current) =>
        current.map((row) => (row.addonId === addonId ? updated : row)),
      );
      notify("success", `${updated.name} updated to ${updated.installedVersion}`);
    } catch (error) {
      notify("error", api.errorMessage(error));
    } finally {
      markBusy(addonId, false);
    }
  }

  async function handleUpdateAll() {
    const updatable = addons.filter((addon) => addon.needsUpdate);
    for (const addon of updatable) {
      await handleUpdate(addon.addonId);
    }
  }

  async function handleRemove(addon: Addon) {
    if (!selectedId) return;
    setConfirming(null);
    markBusy(addon.addonId, true);
    try {
      const folders = await api.removeAddon(selectedId, addon.addonId);
      setAddons((current) => current.filter((row) => row.addonId !== addon.addonId));
      void refreshServers();
      notify("success", `Removed ${addon.name} (${folders.length} folder${folders.length === 1 ? "" : "s"})`);
    } catch (error) {
      notify("error", api.errorMessage(error));
    } finally {
      markBusy(addon.addonId, false);
    }
  }

  async function handleTogglePin(addon: Addon) {
    if (!selectedId) return;
    const pinned = !addon.pinned;
    try {
      await api.setAddonPinned(selectedId, addon.addonId, pinned);
      setAddons((current) =>
        current.map((row) =>
          row.addonId === addon.addonId
            ? { ...row, pinned, needsUpdate: pinned ? false : row.needsUpdate }
            : row,
        ),
      );
    } catch (error) {
      notify("error", api.errorMessage(error));
    }
  }

  async function handleToggleChannel(addon: Addon) {
    if (!selectedId) return;
    const channel = addon.channel === "release" ? "source" : "release";
    try {
      await api.setAddonChannel(selectedId, addon.addonId, channel);
      setAddons((current) =>
        current.map((row) =>
          row.addonId === addon.addonId ? { ...row, channel } : row,
        ),
      );
      notify(
        "info",
        `${addon.name} now tracks ${channel === "source" ? "source builds" : "tagged releases"}. Update it to switch over.`,
      );
    } catch (error) {
      notify("error", api.errorMessage(error));
    }
  }

  async function handleInstall(
    url: string,
    serverIds: string[],
    channel: "release" | "source",
  ) {
    if (serverIds.length === 1 && serverIds[0]) {
      const installed = await api.installAddon(serverIds[0], url, channel);
      notify("success", `Installed ${installed.name} ${installed.installedVersion}`);
    } else {
      const outcomes = await api.installAddonToMany(serverIds, url, channel);
      const ok = outcomes.filter((outcome) => outcome.ok).length;
      notify(
        ok === outcomes.length ? "success" : "info",
        `Installed to ${ok} of ${outcomes.length} servers`,
      );
      for (const outcome of outcomes.filter((o) => !o.ok)) {
        notify("error", `${outcome.serverName}: ${outcome.message}`);
      }
    }
    setShowAddAddon(false);
    if (selectedId) setAddons(await api.listAddons(selectedId));
    void refreshServers();
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src={logo} alt="" width={34} height={34} />
          <div className="brand-text">
            <h1>Brownie's Addon Manager</h1>
            <p>World of Warcraft addons</p>
          </div>
        </div>

        <ServerSwitcher
          servers={servers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAddServer={() => setShowAddServer(true)}
        />

        <nav className="nav">
          <button
            type="button"
            aria-current={page === "addons" ? "page" : undefined}
            onClick={() => setPage("addons")}
          >
            My addons
            <span className="count">{addons.length}</span>
          </button>
          <button
            type="button"
            aria-current={page === "browse" ? "page" : undefined}
            onClick={() => setPage("browse")}
          >
            Browse
          </button>
          <button
            type="button"
            aria-current={page === "servers" ? "page" : undefined}
            onClick={() => setPage("servers")}
          >
            Servers
            <span className="count">{servers.length}</span>
          </button>
          <button
            type="button"
            aria-current={page === "settings" ? "page" : undefined}
            onClick={() => setPage("settings")}
          >
            Settings
          </button>
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className="btn"
            style={{ width: "100%" }}
            onClick={() => setShowAddServer(true)}
          >
            + Add a server
          </button>
        </div>
      </aside>

      <main className="main">
        {page === "addons" ? (
          <>
            <div className="page-head">
              <div>
                <h2>My addons</h2>
                <p>
                  {selected
                    ? `${selected.name} · ${selected.versionLabel}`
                    : "Add a server to get started"}
                </p>
              </div>
              {selected ? (
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={
                      checking
                        ? () => void api.cancelUpdateCheck(selected.id)
                        : handleCheckUpdates
                    }
                    disabled={
                      !checking && (addons.length === 0 || !selected.canInstall)
                    }
                  >
                    {checking ? "Cancel check" : "Check for updates"}
                  </button>
                  {addons.some((addon) => addon.needsUpdate) ? (
                    <button type="button" className="btn" onClick={handleUpdateAll}>
                      Update all ({addons.filter((a) => a.needsUpdate).length})
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTransfer("existing")}
                    disabled={!selected.canInstall}
                    title="Take over addon folders already in this game directory"
                  >
                    Import existing
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTransfer("import")}
                    disabled={!selected.canInstall}
                    title="Paste an addon list — the way to bring a collection over from V1"
                  >
                    Import list
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTransfer("export")}
                    disabled={addons.length === 0}
                  >
                    Export list
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => setShowAddAddon(true)}
                    disabled={!selected.canInstall}
                  >
                    Add addon
                  </button>
                </div>
              ) : null}
            </div>
            <div className="page-body">
              {selected && unmet.length > 0 ? (
                <div className="banner">
                  <strong>Missing dependencies.</strong>{" "}
                  {unmet
                    .map((item) => `${item.addonName} needs ${item.missing.join(", ")}`)
                    .join("; ")}
                  . These addons may not load until the folders they require are
                  installed.
                </div>
              ) : null}

              {selected ? (
                <AddonList
                  server={selected}
                  addons={addons}
                  busy={busy}
                  onUpdate={handleUpdate}
                  onRemove={(addon) => {
                    setConfirming(addon);
                    setDependents([]);
                    void api
                      .removalImpact(selected.id, addon.addonId)
                      .then(setDependents)
                      .catch(() => setDependents([]));
                  }}
                  onTogglePin={handleTogglePin}
                  onToggleChannel={handleToggleChannel}
                  onOpen={(url) => void api.openUrl(url)}
                  onAdd={() => setShowAddAddon(true)}
                />
              ) : (
                <div className="empty">
                  <h3>No servers yet</h3>
                  <p>
                    Add the folder that contains your WoW executable, pick which
                    version it is, and give it a name.
                  </p>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => setShowAddServer(true)}
                  >
                    Add a server
                  </button>
                </div>
              )}
            </div>
          </>
        ) : null}

        {page === "browse" ? (
          <BrowsePage
            server={selected}
            onInstall={async (entry) => {
              if (!selectedId) return;
              try {
                // Dependencies first, in order, including ones not asked for.
                const plan = await api.resolveCatalogInstall(selectedId, entry.id);
                const queue = plan.length > 0 ? plan : [entry];
                if (queue.length > 1) {
                  notify(
                    "info",
                    `${entry.name} needs ${queue.length - 1} other addon${
                      queue.length === 2 ? "" : "s"
                    }; installing those first.`,
                  );
                }
                for (const step of queue) {
                  await api.installAddon(selectedId, step.repoUrl);
                }
                notify("success", `Installed ${entry.name}`);
                setAddons(await api.listAddons(selectedId));
                void refreshServers();
              } catch (error) {
                notify("error", api.errorMessage(error));
              }
            }}
          />
        ) : null}

        {page === "servers" ? (
          <ManageServers
            servers={servers}
            onChanged={refreshServers}
            onAddServer={() => setShowAddServer(true)}
            notify={notify}
          />
        ) : null}

        {page === "settings" ? <SettingsPage notify={notify} /> : null}
      </main>

      {showAddServer ? (
        <AddServerDialog
          onClose={() => setShowAddServer(false)}
          onAdd={async (name, path, version, force) => {
            const created = await api.addServer(name, path, version, force);
            setShowAddServer(false);
            await refreshServers();
            setSelectedId(created.id);
            notify("success", `Added ${created.name}`);
          }}
        />
      ) : null}

      {showAddAddon && selectedId ? (
        <AddAddonDialog
          servers={servers}
          currentServerId={selectedId}
          onClose={() => setShowAddAddon(false)}
          onInstall={handleInstall}
        />
      ) : null}

      {transfer === "import" && selected ? (
        <ImportListDialog
          server={selected}
          onClose={() => setTransfer(null)}
          onDone={async (installed, failed) => {
            setTransfer(null);
            notify(
              failed.length === 0 ? "success" : "info",
              `Installed ${installed} addon${installed === 1 ? "" : "s"}` +
                (failed.length > 0 ? `, ${failed.length} failed` : ""),
            );
            for (const line of failed) notify("error", line);
            if (selectedId) setAddons(await api.listAddons(selectedId));
            void refreshServers();
          }}
        />
      ) : null}

      {transfer === "export" && selected ? (
        <ExportListDialog server={selected} onClose={() => setTransfer(null)} />
      ) : null}

      {transfer === "existing" && selected ? (
        <ImportExistingDialog
          server={selected}
          onClose={async () => {
            setTransfer(null);
            if (selectedId) setAddons(await api.listAddons(selectedId));
            void refreshServers();
          }}
          onAdopted={(folder) => notify("success", `Now managing ${folder}`)}
        />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Remove ${confirming.name}?`}
          message={
            `This deletes ${confirming.folders.join(", ")} from ${
              selected?.name ?? "this server"
            }. Other servers are not affected.` +
            (dependents.length > 0
              ? `\n\nWarning: ${dependents.join(" and ")} declare${
                  dependents.length === 1 ? "s" : ""
                } a dependency on it and may stop working.`
              : "")
          }
          confirmLabel="Remove"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void handleRemove(confirming)}
        />
      ) : null}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <span style={{ flex: 1 }}>{toast.text}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToasts((c) => c.filter((t) => t.id !== toast.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BrowsePage({
  server,
  onInstall,
}: {
  server: Server | null;
  onInstall: (entry: CatalogEntry) => Promise<void>;
}) {
  const [result, setResult] = useState<api.CatalogResult | null>(null);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");

  useEffect(() => {
    setResult(null);
    api
      .getCatalog(server?.id ?? null)
      .then(setResult)
      .catch(() => setResult({ status: "unavailable", entries: [] }));
  }, [server?.id]);

  const entries = result?.entries ?? [];
  const categories = ["All", ...new Set(entries.map((entry) => entry.category))];

  const needle = query.trim().toLowerCase();
  const shown = entries.filter((entry) => {
    if (category !== "All" && entry.category !== category) return false;
    if (!needle) return true;
    return (
      entry.name.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle) ||
      entry.category.toLowerCase().includes(needle)
    );
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Browse</h2>
          <p>
            {server
              ? `Curated addons for ${server.versionLabel}`
              : "Add a server to see the curated list"}
          </p>
        </div>
      </div>
      <div className="page-body">
        {result === null ? (
          <p>
            <span className="spinner" /> Loading the curated list…
          </p>
        ) : entries.length === 0 ? (
          <EmptyCatalog status={result.status} server={server} />
        ) : (
          <>
            <div className="searchbar">
              <input
                className="input"
                type="search"
                placeholder="Search the curated list…"
                aria-label="Search the curated list"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                className="select"
                aria-label="Category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {categories.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            {shown.length === 0 ? (
              <div className="empty">
                <h3>Nothing matches</h3>
                <p>No curated addon matches that search and category.</p>
              </div>
            ) : (
              <div className="cards">
                {shown.map((entry) => (
                  <div className="card" key={entry.id}>
                    <h4>{entry.name}</h4>
                    <p>{entry.description}</p>
                    <div className="foot">
                      <span className="tag">{entry.category}</span>
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={!server?.canInstall || entry.installed}
                        onClick={() => void onInstall(entry)}
                      >
                        {entry.installed ? "Installed" : "Install"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * Why the curated list is empty.
 *
 * Being offline and nobody having curated a list for TBC yet are different
 * situations; showing one message for both left the user unable to tell whether
 * to check their connection or stop waiting.
 */
function EmptyCatalog({
  status,
  server,
}: {
  status: api.CatalogResult["status"];
  server: Server | null;
}) {
  if (status === "noServer") {
    return (
      <div className="empty">
        <h3>No server selected</h3>
        <p>Add a server to see the curated list for its game version.</p>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="empty">
        <h3>Could not reach the curated list</h3>
        <p>
          Check your connection and try again. Everything else still works —
          you can add addons by URL in the meantime.
        </p>
      </div>
    );
  }

  if (status === "malformed") {
    return (
      <div className="empty">
        <h3>The curated list could not be read</h3>
        <p>
          It downloaded but is not valid. That is a problem with the list
          itself rather than with your setup — please report it. You can still
          add addons by URL.
        </p>
      </div>
    );
  }

  // "noListForVersion", or an empty file.
  return (
    <div className="empty">
      <h3>No curated list for {server?.versionLabel ?? "this version"} yet</h3>
      <p>
        The curated list currently covers WotLK 3.3.5a. You can still add any
        addon by pasting its GitHub or GitLab URL.
      </p>
    </div>
  );
}

function SettingsPage({
  notify,
}: {
  notify: (kind: Toast["kind"], text: string) => void;
}) {
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    api.hasGithubToken().then(setHasToken).catch(() => setHasToken(false));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>Preferences that apply to every server.</p>
        </div>
      </div>
      <div className="page-body">
        <div className="field" style={{ maxWidth: 520 }}>
          <label htmlFor="token">GitHub token (optional)</label>
          <input
            id="token"
            className="input"
            type="password"
            value={token}
            placeholder={hasToken ? "•••••••• (a token is saved)" : "ghp_…"}
            onChange={(event) => setToken(event.target.value)}
          />
          <span className="hint">
            Without a token, GitHub allows 60 requests an hour, which a large
            addon list can exhaust. A read-only token raises that to 5,000. It is
            stored locally and never sent anywhere except GitHub.
          </span>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={async () => {
                await api.setGithubToken(token || null);
                setHasToken(Boolean(token));
                setToken("");
                notify("success", token ? "Token saved" : "Token cleared");
              }}
            >
              Save token
            </button>
            {hasToken ? (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await api.setGithubToken(null);
                  setHasToken(false);
                  notify("info", "Token cleared");
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div className="field" style={{ maxWidth: 520, marginTop: 28 }}>
          <label>Diagnostics</label>
          <span className="hint">
            If something goes wrong, this is what to attach to a bug report. The
            summary lists your servers and addons with paths shortened and no
            token included.
          </span>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  const text = await api.diagnostics();
                  await navigator.clipboard.writeText(text);
                  notify("success", "Diagnostics copied to the clipboard");
                } catch (error) {
                  notify("error", api.errorMessage(error));
                }
              }}
            >
              Copy diagnostics
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void api.openLogsFolder()}
            >
              Open logs folder
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
