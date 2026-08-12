import { useMemo, useState } from "react";
import type { Addon, FoundAddon, Server } from "../api";

type Sort = "name" | "updates" | "version";
type Filter = "all" | "updatable" | "pinned";

/**
 * The addon list for the selected server, and only that server.
 */
/**
 * Is there something to do to this row?
 *
 * An update, or a channel the user switched but has not applied yet. A channel
 * change is deliberately not counted as an *update* — it does not mean upstream
 * moved — but it still needs a button, and without one the app said "update it
 * to switch over" while offering nothing to press.
 */
/**
 * Why nothing can be written to this server, or null when it can.
 *
 * Every control that a read-only or missing folder disables says the same
 * thing, and says it rather than just greying out — a disabled button with no
 * reason reads as a broken app, and letting the click through instead ends in
 * a permission error from somewhere deep in the install.
 */
export function installBlockedBecause(server: Server | null): string | null {
  if (!server) return "Add a server first";
  if (server.availability === "unavailable") {
    return `${server.name} is offline — reconnect its drive to install or update addons`;
  }
  if (!server.canInstall) {
    return `${server.name} is read-only — no addons can be installed or updated here`;
  }
  return null;
}

/** True when the folder cannot be reached at all — an unplugged drive. */
export function unreachable(server: Server | null): boolean {
  return server?.availability === "unavailable";
}

/**
 * The banner both pages show when a server cannot be written to.
 *
 * Shared so the two cannot describe the same state differently — an offline
 * server was being announced as read-only, which is a different problem with a
 * different fix.
 */
export function ServerBlockedBanner({
  server,
  trailing,
  onRecheck,
}: {
  server: Server | null;
  trailing: string;
  onRecheck?: () => void;
}) {
  if (!server || !installBlockedBecause(server)) return null;
  const offline = unreachable(server);
  // Its own wording rather than the tooltip's: a tooltip has to name the
  // remedy in one line, a banner has room to and would otherwise say it twice.
  return (
    <div className={`banner${offline ? " bad" : ""}`}>
      <strong>{offline ? "Not reachable." : "Read-only."}</strong>{" "}
      {offline
        ? `${server.name} is offline.`
        : `${server.name} can’t be written to, due to admin restrictions.`}{" "}
      {trailing}
      {onRecheck ? (
        <>
          {" "}
          <button type="button" className="btn small" onClick={onRecheck}>
            Check again
          </button>
        </>
      ) : null}
    </div>
  );
}

export function actionable(addon: Addon): boolean {
  if (addon.pinned) return false;
  // A missing addon is offered a reinstall. Not for a pinned one: reinstalling
  // fetches whatever the channel resolves to now, which would quietly move it
  // off the version the pin exists to hold.
  //
  // An adopted addon is offered one too: its files came from somewhere this app
  // cannot name, so there is always a known version worth putting in their
  // place — and without a button it would be the one row that can never reach
  // one.
  return (
    addon.needsUpdate ||
    addon.channelPending ||
    addon.versionUnknown ||
    addon.missingFolders.length > 0
  );
}

export function AddonList({
  server,
  addons,
  busy,
  onUpdate,
  onRemove,
  onTogglePin,
  onToggleChannel,
  onOpen,
  onAdd,
  onRecheck,
  unmanaged,
  onAdopt,
}: {
  server: Server;
  addons: Addon[];
  busy: Set<string>;
  onUpdate: (addonId: string) => void;
  onRemove: (addon: Addon) => void;
  onTogglePin: (addon: Addon) => void;
  onToggleChannel: (addon: Addon) => void;
  onOpen: (url: string) => void;
  onAdd: () => void;
  onRecheck: () => void;
  unmanaged: FoundAddon[];
  onAdopt: (found: FoundAddon) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = addons.filter((addon) => {
      if (filter === "updatable" && !actionable(addon)) return false;
      if (filter === "pinned" && !addon.pinned) return false;
      if (!needle) return true;
      return (
        addon.name.toLowerCase().includes(needle) ||
        addon.sourceUrl.toLowerCase().includes(needle) ||
        addon.folders.some((folder) => folder.toLowerCase().includes(needle))
      );
    });

    return [...matches].sort((a, b) => {
      if (sort === "updates") {
        if (actionable(a) !== actionable(b)) return actionable(a) ? -1 : 1;
      }
      if (sort === "version") {
        return a.installedVersion.localeCompare(b.installedVersion);
      }
      return a.name.localeCompare(b.name);
    });
  }, [addons, query, sort, filter]);

  const banner = (
    <ServerBlockedBanner
      server={server}
      onRecheck={onRecheck}
      trailing={
        unreachable(server)
          ? "If it lives on an external drive, reconnect it. The addons below are the last known state — nothing has been removed."
          : "Existing addons are listed, but they can’t be changed."
      }
    />
  );

  if (addons.length === 0 && unmanaged.length === 0) {
    return (
      <>
      {banner}
      <div className="empty">
        <h3>No addons here yet</h3>
        <p>
          Paste a GitHub or GitLab URL to install one, or browse the curated list
          for {server.versionLabel}.
        </p>
        <button
          type="button"
          className="btn primary"
          onClick={onAdd}
          disabled={installBlockedBecause(server) !== null}
          title={installBlockedBecause(server) ?? undefined}
        >
          Add an addon
        </button>
      </div>
      </>
    );
  }

  return (
    <>
      {banner}
      {/* Nothing to search through until something is managed. */}
      <div className="searchbar" hidden={addons.length === 0}>
        <input
          className="input"
          type="search"
          placeholder="Search addons…"
          aria-label="Search addons"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="select"
          aria-label="Filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
        >
          <option value="all">All addons</option>
          <option value="updatable">Updates available</option>
          <option value="pinned">Pinned</option>
        </select>
        <select
          className="select"
          aria-label="Sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as Sort)}
        >
          <option value="name">Sort by name</option>
          <option value="updates">Sort by updates first</option>
          <option value="version">Sort by version</option>
        </select>
      </div>

      {visible.length === 0 ? (
        // Two different nothings. With unmanaged folders below and none of them
        // adopted yet, the list is empty because nothing has been taken over —
        // saying "nothing matches" blames a search the user never typed.
        addons.length === 0 ? (
          <div className="empty">
            <h3>Nothing managed here yet</h3>
            <p>
              The folders below are already in {server.name}. Give one its
              repository URL to start looking after it, or add an addon by URL.
            </p>
          </div>
        ) : (
          <div className="empty">
            <h3>Nothing matches</h3>
            <p>No addon on this server matches that search and filter.</p>
          </div>
        )
      ) : (
        <div className="rows">
          {visible.map((addon) => (
            <AddonRow
              key={addon.addonId}
              addon={addon}
              busy={busy.has(addon.addonId)}
              onUpdate={() => onUpdate(addon.addonId)}
              onRemove={() => onRemove(addon)}
              onTogglePin={() => onTogglePin(addon)}
              onToggleChannel={() => onToggleChannel(addon)}
              onOpen={() => onOpen(addon.sourceUrl)}
              blocked={installBlockedBecause(server)}
              offline={unreachable(server)}
            />
          ))}
        </div>
      )}

      {unmanaged.length > 0 ? (
        <>
          <h3 className="list-divider">
            Not managed by this app
            <span className="hint">
              Already in this folder. Give each one its repository URL and it
              joins the list above, updates included.
            </span>
          </h3>
          <div className="rows">
            {unmanaged.map((item) => (
              <div className="row unmanaged" key={item.folder}>
                <div className="row-main">
                  <div className="row-title">
                    <strong>{item.title ?? item.folder}</strong>
                    <span className="tag">unmanaged</span>
                    {item.related.length > 0 ? (
                      <span className="tag">
                        +{item.related.length} folder
                        {item.related.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                    {!item.versionMatches ? (
                      <span
                        className="tag error"
                        title="Its .toc declares a different game version than this server"
                      >
                        built for another version
                      </span>
                    ) : null}
                  </div>
                  <div className="row-sub" title={item.folder}>
                    {item.folder}
                    {item.version ? ` · ${item.version}` : ""}
                    {item.author ? ` · by ${item.author}` : ""}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => onAdopt(item)}
                    disabled={Boolean(installBlockedBecause(server))}
                    title={
                      installBlockedBecause(server) ??
                      "Give this folder a repository URL so it can be updated"
                    }
                  >
                    Manage
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function AddonRow({
  addon,
  busy,
  onUpdate,
  onRemove,
  onTogglePin,
  onToggleChannel,
  onOpen,
  blocked,
  offline,
}: {
  addon: Addon;
  busy: boolean;
  onUpdate: () => void;
  onRemove: () => void;
  onTogglePin: () => void;
  onToggleChannel: () => void;
  onOpen: () => void;
  blocked: string | null;
  offline: boolean;
}) {
  return (
    <div className={`row${actionable(addon) ? " updatable" : ""}${offline ? " offline" : ""}`}>
      <div className="row-main">
        <div className="row-title">
          <strong>{addon.name}</strong>
          {addon.needsUpdate ? (
            <span className="tag update">{addon.latestVersion} available</span>
          ) : null}
          {addon.missingFolders.length > 0 ? (
            <span
              className="tag error"
              title={`Not on disk: ${addon.missingFolders.join(", ")}. Removed or renamed outside this app.`}
            >
              missing
            </span>
          ) : null}
          {!addon.pinned && addon.channelPending ? (
            <span className="tag update">
              switch to {addon.channel === "source" ? "source" : "releases"}
            </span>
          ) : null}
          {addon.versionUnknown ? (
            <span
              className="tag"
              title="Taken over from what was already in the game folder, so which version these files are was never recorded. Update to put a known one there."
            >
              adopted
            </span>
          ) : null}
          {addon.pinned ? <span className="tag pinned">pinned</span> : null}
          {addon.channel === "source" ? (
            <span className="tag source">source</span>
          ) : null}
          {addon.updateStatus === "error" ? (
            <span className="tag error">check failed</span>
          ) : null}
          {!addon.versionMatches ? (
            <span
              className="tag error"
              title="This addon's .toc declares a different game version than this server"
            >
              built for another version
            </span>
          ) : null}
        </div>
        <div className="row-sub" title={addon.folders.join(", ")}>
          {addon.installedVersion} · {addon.folders.length} folder
          {addon.folders.length === 1 ? "" : "s"} · {addon.folders.join(", ")}
        </div>
      </div>

      <div className="row-actions">
        {busy ? <span className="spinner" aria-label="Working" /> : null}
        {actionable(addon) ? (
          <button
            type="button"
            className="btn primary small"
            onClick={onUpdate}
            disabled={busy || blocked !== null}
            title={
              blocked ??
              (addon.missingFolders.length > 0
                ? "Put this addon back — its folders are no longer on disk"
                : addon.needsUpdate
                  ? "Install the newer version"
                  : addon.versionUnknown
                    ? "Replace these files with a version this app can name"
                    : `Fetch this addon from its ${addon.channel === "source" ? "default branch" : "latest release"}`)
            }
          >
            {addon.missingFolders.length > 0
              ? "Reinstall"
              : addon.needsUpdate || addon.versionUnknown
                ? "Update"
                : "Switch"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn small"
          onClick={onTogglePin}
          disabled={busy || offline}
          title={
            blocked && offline
              ? blocked
              : addon.pinned
              ? "Resume checking this addon for updates"
                : "Keep this version and stop checking for updates"
          }
        >
          {addon.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={onToggleChannel}
          disabled={busy || offline}
          title={
            (offline ? blocked : null) ??
            "Switch between tagged releases and the latest source build"
          }
        >
          {addon.channel === "release" ? "Use source" : "Use releases"}
        </button>
        <button type="button" className="btn small" onClick={onOpen} disabled={busy}>
          Open page
        </button>
        <button
          type="button"
          className="btn small danger"
          onClick={onRemove}
          disabled={busy || offline}
          title={offline ? (blocked ?? undefined) : undefined}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
