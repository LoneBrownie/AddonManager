import { useCallback, useEffect, useMemo, useState } from "react";
import logo from "./img/Logo.png";
import * as api from "./api";
import type { Addon, CatalogEntry, Server } from "./api";
import {
  AddonList,
  ServerBlockedBanner,
  actionable,
  installBlockedBecause,
} from "./components/AddonList";
import { AppUpdate, UpdateChannel } from "./components/AppUpdate";
import { ServerSwitcher } from "./components/ServerSwitcher";
import {
  AddAddonDialog,
  AddServerDialog,
  ConfirmDialog,
  SourceDialog,
} from "./components/dialogs";
import { ManageServers } from "./components/ManageServers";
import {
  AdoptDialog,
  ExportListDialog,
  ImportListDialog,
} from "./components/transfer";
import { WhatsNewDialog } from "./components/WhatsNew";
import { ActivityDock, ToastStack } from "./components/Activity";
import { useActivity, type Notify } from "./activity";
import * as appUpdate from "./appUpdate";
import * as theme from "./theme";

type Page = "addons" | "browse" | "servers" | "settings";

/**
 * Carry the result of an update check across a reload of the list.
 *
 * `list_addons` reports what is installed and nothing about what is upstream —
 * an update check lives in this state and nowhere else. So every reload used
 * to blank out the "update available" badges, and the only way to get them
 * back was to check again. Opening an addon's page was enough to do it: coming
 * back to the window refreshes the servers, which used to take the list with
 * it.
 *
 * A row keeps its answer only while the answer is still about the version it
 * was made about — same installed version, same channel. Anything else moved
 * underneath the check, so the row goes back to saying it does not know.
 */
function withPriorChecks(previous: Addon[], rows: Addon[]): Addon[] {
  const before = new Map(previous.map((row) => [row.addonId, row]));
  return rows.map((row) => {
    const prior = before.get(row.addonId);
    if (
      !prior ||
      prior.updateStatus === "unknown" ||
      prior.installedVersion !== row.installedVersion ||
      prior.channel !== row.channel
    ) {
      return row;
    }
    return {
      ...row,
      latestVersion: prior.latestVersion,
      updateStatus: prior.updateStatus,
      // Pinning is decided by the engine and can have changed since the check.
      needsUpdate: !row.pinned && prior.needsUpdate,
    };
  });
}

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [page, setPage] = useState<Page>("addons");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [showAddServer, setShowAddServer] = useState(false);
  const [showAddAddon, setShowAddAddon] = useState(false);
  const [confirming, setConfirming] = useState<Addon | null>(null);
  const [editingSource, setEditingSource] = useState<Addon | null>(null);
  const [transfer, setTransfer] = useState<"import" | "export" | null>(null);
  const [unmet, setUnmet] = useState<api.Unmet[]>([]);
  const [unmanaged, setUnmanaged] = useState<api.FoundAddon[]>([]);
  const [adopting, setAdopting] = useState<api.FoundAddon | null>(null);
  const [dependents, setDependents] = useState<string[]>([]);
  const [whatsNew, setWhatsNew] = useState<api.WhatsNew | null>(null);
  const [appTheme, setAppTheme] = useState<api.Theme>(null);
  const [activityOpen, setActivityOpen] = useState(false);

  const selected = useMemo(
    () => servers.find((server) => server.id === selectedId) ?? null,
    [servers, selectedId],
  );

  // Every message in the app goes through this. Failures announce themselves
  // with a toast; everything else only makes the activity tab flash and its
  // count go up. All of it is readable in the panel afterwards either way.
  const activity = useActivity();
  const { notify, notifyFor, announce, markRead } = activity;

  // Anything acting on the server you are looking at says so. Which one that
  // was is not recoverable afterwards — the switcher shows the current server,
  // not the one that was current when the message arrived — so "Updated 3
  // addons" was unanswerable the moment you changed folders. `notify` stays for
  // the messages that are genuinely about no server at all.
  // Keyed on the name rather than the server: `refreshServers` hands back a
  // fresh object every time it runs, and depending on that object rebuilt
  // `say`, and with it `refreshAddons`, on every window focus — which reloaded
  // the list and blanked out the update check nobody had asked to redo.
  const serverName = selected?.name;
  const say = useMemo(() => notifyFor(serverName), [notifyFor, serverName]);

  // Opening the panel *is* reading them, so any toasts go with it — leaving
  // them up would show the same messages twice, one stack over the other.
  const { dismissAll } = activity;
  const openActivity = useCallback(() => {
    setActivityOpen(true);
    markRead();
    dismissAll();
  }, [markRead, dismissAll]);

  const refreshServers = useCallback(async () => {
    try {
      const list = await api.listServers();
      setServers(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    } catch (error) {
      notify("error", api.errorMessage(error));
    }
  }, [notify]);

  // Startup, in one pass: the stored preferences decide the theme and which
  // server comes back, so both have to be read before the first render settles.
  // Not folded into refreshServers, which also runs on every window focus —
  // re-reading preferences there would let a stale value fight the user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [prefs, list] = await Promise.all([
        api.getPreferences().catch(() => null),
        api.listServers(),
      ]);
      if (cancelled) return;

      theme.apply(prefs?.theme ?? null);
      setAppTheme(prefs?.theme ?? null);

      setServers(list);
      // The one that was selected last, if it is still here. A server that has
      // been forgotten since falls back to the first rather than to nothing.
      const remembered = list.find(
        (server) => server.id === prefs?.selectedServerId,
      );
      setSelectedId(remembered?.id ?? list[0]?.id ?? null);
    })().catch((error) => {
      if (!cancelled) notify("error", api.errorMessage(error));
    });
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // Only while the choice is "system"; `follow` returns a no-op otherwise.
  useEffect(() => theme.follow(appTheme), [appTheme]);

  // Shown once, on the first launch after an update. The engine decides
  // whether this is that launch — the interface cannot know what ran last time.
  useEffect(() => {
    api.whatsNew().then(setWhatsNew).catch(() => setWhatsNew(null));
  }, []);

  // One check, on the launch after which nothing checks again.
  //
  // Telling somebody a new version exists is worth an interruption; installing
  // it without being asked is not. So this raises a toast with a way to get to
  // the button, and never touches the update itself — the two presses in
  // Settings stay the only thing that installs anything.
  //
  // Failure is silent on purpose. Being offline is not news, and a launch that
  // opens with "could not reach GitHub" over a check nobody asked for would be
  // an error message for the app's benefit rather than the user's.
  useEffect(() => {
    let cancelled = false;
    appUpdate
      .check()
      .then((found) => {
        if (cancelled || !found) return;
        announce(`Version ${found.version} is available.`, {
          label: "Update",
          run: () => setPage("settings"),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [announce]);

  // Availability is worked out when the server list is read, so a drive that
  // came back stayed "offline" until something else happened to reload it —
  // renaming the server was the only reliable way to make it notice. Coming
  // back to the window is exactly when someone has just plugged it in.
  useEffect(() => {
    const recheck = () => void refreshServers();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [refreshServers]);

  // Both halves of a server's state, always together. Which dependencies are
  // unmet is derived from what is installed, so refreshing one without the
  // other leaves the warning describing a server that no longer exists —
  // installing the missing addon left the banner up until the page changed.
  const refreshUnmet = useCallback(async () => {
    if (!selectedId) {
      setUnmet([]);
      return;
    }
    await api
      .unmetDependencies(selectedId)
      .then(setUnmet)
      .catch(() => setUnmet([]));
  }, [selectedId]);

  const refreshAddons = useCallback(async () => {
    if (!selectedId) {
      setAddons([]);
      setUnmet([]);
      setUnmanaged([]);
      return;
    }
    try {
      const rows = await api.listAddons(selectedId);
      setAddons((current) => withPriorChecks(current, rows));
    } catch (error) {
      say("error", api.errorMessage(error));
    }
    await refreshUnmet();
    // Folders on disk this app does not track. Read with the rest of the
    // server's state so adopting one, or installing something that lands in a
    // folder already there, is reflected without a page change.
    await api
      .scanExistingAddons(selectedId)
      .then(setUnmanaged)
      .catch(() => setUnmanaged([]));
  }, [selectedId, say, refreshUnmet]);

  useEffect(() => {
    void refreshAddons();
    if (selectedId) void api.setSelectedServer(selectedId);
  }, [refreshAddons, selectedId]);

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
      // A pending channel switch is not an update, but saying "up to date"
      // while a Switch button is sitting there is just confusing.
      const switches = rows.filter(
        (row) => row.channelPending && !row.pinned && !row.needsUpdate,
      ).length;
      const parts = [
        count > 0 ? `${count} update${count === 1 ? "" : "s"} available` : null,
        switches > 0
          ? `${switches} waiting to switch channel`
          : null,
      ].filter(Boolean);
      say(
        parts.length > 0 ? "info" : "success",
        parts.length > 0 ? parts.join(", ") : "Everything is up to date",
      );
    } catch (error) {
      say("error", api.errorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  /**
   * Update one addon and report nothing. The caller decides what to say,
   * because one addon and twenty addons want very different things said.
   */
  async function updateOne(addon: Addon): Promise<{ name: string; version?: string; error?: string }> {
    if (!selectedId) return { name: addon.name, error: "no server selected" };
    markBusy(addon.addonId, true);
    try {
      const updated = await api.updateAddon(selectedId, addon.addonId);
      setAddons((current) =>
        current.map((row) => (row.addonId === addon.addonId ? updated : row)),
      );
      void refreshUnmet();
      return { name: updated.name, version: updated.installedVersion };
    } catch (error) {
      return { name: addon.name, error: api.errorMessage(error) };
    } finally {
      markBusy(addon.addonId, false);
    }
  }

  async function handleUpdate(addonId: string) {
    const addon = addons.find((row) => row.addonId === addonId);
    if (!addon) return;
    const result = await updateOne(addon);
    if (result.error) say("error", `${result.name}: ${result.error}`);
    else say("success", `${result.name} updated to ${result.version}`);
  }

  /**
   * One message for the batch, not one per addon.
   *
   * Updating twenty addons used to raise twenty messages, and any that failed
   * stayed on screen until each was clicked away. The failures are now the
   * detail of a single line, which is both less to dismiss and easier to read:
   * they sit together instead of interleaved with the successes.
   */
  async function handleUpdateAll() {
    const queue = addons.filter(actionable);
    if (queue.length === 0) return;

    const results = [];
    for (const addon of queue) {
      results.push(await updateOne(addon));
    }

    const failed = results.filter((result) => result.error);
    say(
      failed.length === 0 ? "success" : "warn",
      failed.length === 0
        ? `Updated ${queue.length} addon${queue.length === 1 ? "" : "s"}`
        : `Updated ${queue.length - failed.length} of ${queue.length} — ${failed.length} failed`,
      failed.map((result) => `${result.name} — ${result.error}`),
    );
  }

  async function handleRemove(addon: Addon) {
    if (!selectedId) return;
    setConfirming(null);
    markBusy(addon.addonId, true);
    try {
      const folders = await api.removeAddon(selectedId, addon.addonId);
      setAddons((current) => current.filter((row) => row.addonId !== addon.addonId));
      void refreshServers();
      void refreshUnmet();
      say("success", `Removed ${addon.name} (${folders.length} folder${folders.length === 1 ? "" : "s"})`);
    } catch (error) {
      say("error", api.errorMessage(error));
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
      say("error", api.errorMessage(error));
    }
  }

  /**
   * Save the Source dialog.
   *
   * Two different intentions come through one form, so they are told apart
   * here: a new repository replaces the files and moves the record, while the
   * same repository on a different channel changes only what the next update
   * fetches. Sending a track change through the switch would reinstall an addon
   * nobody asked to reinstall.
   *
   * Errors are thrown rather than reported, so the dialog shows them against
   * the fields that caused them and stays open to be corrected.
   */
  async function handleSaveSource(addon: Addon, url: string, channel: api.Channel) {
    if (!selectedId) return;

    if (url === addon.sourceUrl) {
      // The command returns the updated row, so whether a switch is now
      // pending comes from the engine rather than being guessed at here.
      const updated = await api.setAddonChannel(selectedId, addon.addonId, channel);
      setAddons((current) =>
        current.map((row) =>
          row.addonId === addon.addonId
            ? { ...updated, latestVersion: row.latestVersion, updateStatus: row.updateStatus, needsUpdate: row.needsUpdate }
            : row,
        ),
      );
      setEditingSource(null);
      const tracks = channel === "source" ? "source builds" : "tagged releases";
      say(
        "info",
        updated.channelPending
          ? `${addon.name} now tracks ${tracks}. Press Switch on its row to fetch it.`
          : `${addon.name} now tracks ${tracks}, which is what is already installed.`,
      );
      return;
    }

    const wasPinned = addon.pinned;
    const updated = await api.changeAddonSource(selectedId, addon.addonId, url, channel);
    setEditingSource(null);
    // The row's identity changes with its source, so it is replaced rather
    // than merged: nothing from the old repository's check still applies.
    setAddons((current) =>
      current.map((row) => (row.addonId === addon.addonId ? updated : row)),
    );
    say(
      "success",
      `${updated.name} now comes from ${url}, at ${updated.installedVersion}`,
      wasPinned ? ["The pin was cleared — it held a version from the old repository."] : [],
    );
  }

  async function handleInstall(
    url: string,
    serverIds: string[],
    channel: "release" | "source",
  ) {
    if (serverIds.length === 1 && serverIds[0]) {
      const target = serverIds[0];
      const installed = await api.installAddon(target, url, channel);
      // Not necessarily the server on screen — this dialog can install to any
      // of them — so the name comes from the one that was picked.
      const to = servers.find((server) => server.id === target)?.name;
      notifyFor(to)("success", `Installed ${installed.name} ${installed.installedVersion}`);
    } else {
      const outcomes = await api.installAddonToMany(serverIds, url, channel);
      const ok = outcomes.filter((outcome) => outcome.ok).length;
      // Left unstamped on purpose: this one spans servers, and the failures
      // underneath it already say which.
      notify(
        ok === outcomes.length ? "success" : "warn",
        `Installed to ${ok} of ${outcomes.length} servers`,
        outcomes
          .filter((outcome) => !outcome.ok)
          .map((outcome) => `${outcome.serverName} — ${outcome.message}`),
      );
    }
    setShowAddAddon(false);
    await refreshAddons();
    void refreshServers();
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src={logo} alt="" width={34} height={34} />
          <div className="brand-text">
            <h1>Brownie’s Addon Manager</h1>
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
                  {addons.some(actionable) ? (
                    <button type="button" className="btn" onClick={handleUpdateAll}>
                      Update all ({addons.filter(actionable).length})
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      try {
                        await api.openServerFolder(selected.id);
                      } catch (error) {
                        say("error", api.errorMessage(error));
                      }
                    }}
                    disabled={selected.availability === "unavailable"}
                    title={`Open ${selected.name}'s Interface/AddOns folder`}
                  >
                    Open folder
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTransfer("import")}
                    disabled={!selected.canInstall}
                    title={
                      installBlockedBecause(selected) ??
                      "Paste an addon list — the way to bring a collection over from V1"
                    }
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
                    title={
                      installBlockedBecause(selected) ?? "Install an addon from a repository URL"
                    }
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
                  onEditSource={setEditingSource}
                  onRecheck={() => void refreshServers()}
                  unmanaged={unmanaged}
                  onAdopt={setAdopting}
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
                  say(
                    "info",
                    `${entry.name} needs ${queue.length - 1} other addon${
                      queue.length === 2 ? "" : "s"
                    }; installing those first.`,
                  );
                }
                for (const step of queue) {
                  // The list says which entries only ever exist as a branch;
                  // without that they install on the release channel and fail.
                  await api.installAddon(selectedId, step.repoUrl, step.channel);
                }
                say("success", `Installed ${entry.name}`);
                await refreshAddons();
                void refreshServers();
              } catch (error) {
                say("error", api.errorMessage(error));
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
            notifyFor={notifyFor}
          />
        ) : null}

        {page === "settings" ? (
          <SettingsPage
            notify={notify}
            appTheme={appTheme}
            onTheme={async (next) => {
              theme.apply(next);
              setAppTheme(next);
              await api.setTheme(next).catch(() => {});
            }}
          />
        ) : null}
      </main>

      {showAddServer ? (
        <AddServerDialog
          onClose={() => setShowAddServer(false)}
          onAdd={async (name, path, version, force) => {
            const created = await api.addServer(name, path, version, force);
            setShowAddServer(false);
            await refreshServers();
            setSelectedId(created.id);
            notifyFor(created.name)("success", `Added ${created.name}`);
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

      {editingSource ? (
        <SourceDialog
          addon={editingSource}
          onClose={() => setEditingSource(null)}
          onSave={(url, channel) => handleSaveSource(editingSource, url, channel)}
        />
      ) : null}

      {transfer === "import" && selected ? (
        <ImportListDialog
          server={selected}
          onClose={() => setTransfer(null)}
          onInstalled={() => void refreshAddons()}
          onDone={async (installed, failed, adopted) => {
            setTransfer(null);
            say(
              failed.length === 0 ? "success" : "warn",
              `Imported ${installed} addon${installed === 1 ? "" : "s"}` +
                // Worth saying: it is the difference between an import that
                // downloaded everything and one that downloaded nothing.
                (adopted > 0 ? `, ${adopted} already here` : "") +
                (failed.length > 0 ? `, ${failed.length} failed` : ""),
              // The failures used to be a toast each — thirty bad lines meant
              // thirty cards, none of which could be read after the fact.
              failed,
            );
            await refreshAddons();
            void refreshServers();
          }}
        />
      ) : null}

      {adopting && selected ? (
        <AdoptDialog
          server={selected}
          found={adopting}
          onClose={() => setAdopting(null)}
          onAdopted={async (folder) => {
            setAdopting(null);
            say("success", `Now managing ${folder}`);
            await refreshAddons();
            void refreshServers();
          }}
        />
      ) : null}

      {whatsNew ? (
        <WhatsNewDialog
          version={whatsNew.version}
          notes={whatsNew.notes}
          onClose={() => setWhatsNew(null)}
        />
      ) : null}

      {transfer === "export" && selected ? (
        <ExportListDialog server={selected} onClose={() => setTransfer(null)} />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Remove ${confirming.name}?`}
          message={
            // A missing addon has nothing left to delete, so promising to
            // delete its folders would be a lie — and this is the way to clear
            // one off the list.
            (confirming.folders.length > 0 &&
            confirming.missingFolders.length === confirming.folders.length
              ? `Its folders are already gone from ${
                  selected?.name ?? "this server"
                }, so this only forgets it. Other servers are not affected.`
              : confirming.missingFolders.length > 0
                ? `This deletes ${confirming.folders
                    .filter((f) => !confirming.missingFolders.includes(f))
                    .join(", ")} from ${
                    selected?.name ?? "this server"
                  } — the rest is already gone. Other servers are not affected.`
                : `This deletes ${confirming.folders.join(", ")} from ${
                    selected?.name ?? "this server"
                  }. Other servers are not affected.`) +
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

      <ActivityDock
        entries={activity.entries}
        open={activityOpen}
        unread={activity.unread}
        problems={activity.unreadProblems}
        pulse={activity.pulse}
        onOpen={openActivity}
        onClose={() => setActivityOpen(false)}
        onClear={activity.clear}
      />

      {activityOpen ? null : (
        <ToastStack
          showing={activity.showing}
          overflow={activity.overflow}
          onDismiss={activity.dismiss}
          onReview={openActivity}
        />
      )}
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
  const [installing, setInstalling] = useState<string | null>(null);

  // Whether an entry is installed is decided by the engine, by comparing the
  // list against what this server has. So it has to be re-read after an
  // install rather than guessed at here — an install can also bring in
  // dependencies the user did not pick, and those turn "Installed" too.
  const load = useCallback(
    () =>
      api
        .getCatalog(server?.id ?? null)
        .then(setResult)
        .catch(() => setResult({ status: "unavailable", entries: [] })),
    [server?.id],
  );

  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

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

            <ServerBlockedBanner
              server={server}
              trailing="The list is shown so you can see what is available."
            />

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
                        disabled={
                          !server?.canInstall || entry.installed || installing !== null
                        }
                        title={
                          installBlockedBecause(server) ??
                          (entry.installed
                            ? "Already installed on this server"
                            : `Install ${entry.name}`)
                        }
                        onClick={async () => {
                          // Held across the whole thing: an install is several
                          // seconds of network, and the button otherwise stays
                          // live and clickable throughout.
                          setInstalling(entry.id);
                          try {
                            await onInstall(entry);
                            await load();
                          } finally {
                            setInstalling(null);
                          }
                        }}
                      >
                        {entry.installed
                          ? "Installed"
                          : installing === entry.id
                            ? "Installing…"
                            : "Install"}
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
      {/* No mention of which versions *are* covered. That sentence named one
          game version in a string, so it went stale the moment a list was
          added for another — and it was addressed to somebody looking at the
          page for a version it did not cover, which is precisely who it was
          wrong for. */}
      <p>You can still add any addon by pasting its GitHub or GitLab URL.</p>
    </div>
  );
}

function SettingsPage({
  notify,
  appTheme,
  onTheme,
}: {
  notify: Notify;
  appTheme: api.Theme;
  onTheme: (theme: api.Theme) => void;
}) {
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  // These two used to be told by a toast, and successes no longer raise one.
  // A button that says what it just did is a better answer anyway: it is where
  // you are already looking, and it cannot be missed by looking elsewhere.
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.hasGithubToken().then(setHasToken).catch(() => setHasToken(false));
    api.appVersion().then(setVersion).catch(() => setVersion(null));
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
          <label>Appearance</label>
          <div className="segmented" role="group" aria-label="Theme">
            {([null, "dark", "light"] as api.Theme[]).map((option) => (
              <button
                key={option ?? "system"}
                type="button"
                aria-pressed={appTheme === option}
                onClick={() => onTheme(option)}
              >
                {option === null ? "System" : option === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>
          <span className="hint">
            Dark by default, because this sits beside a game. <em>System</em>
            {" "}follows your desktop and changes with it.
          </span>
        </div>

        <div className="field" style={{ maxWidth: 520, marginTop: 28 }}>
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
            stored locally and never sent anywhere except GitHub — GitLab is
            asked anonymously, which its own limits are generous enough to allow.
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
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              }}
            >
              {saved ? "Saved" : "Save token"}
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

        <AppUpdate notify={notify} />

        <UpdateChannel notify={notify} />

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
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch (error) {
                  notify("error", api.errorMessage(error));
                }
              }}
            >
              {copied ? "Copied" : "Copy diagnostics"}
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

        {/* Last, quiet, and always present: the string a bug report needs. */}
        <p className="version-note">
          Brownie’s Addon Manager {version ?? "…"}
        </p>
      </div>
    </>
  );
}
