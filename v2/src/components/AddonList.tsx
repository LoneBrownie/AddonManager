import { useMemo, useState } from "react";
import type { Addon, Server } from "../api";

type Sort = "name" | "updates" | "version";
type Filter = "all" | "updatable" | "pinned";

/**
 * The addon list for the selected server, and only that server.
 */
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
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = addons.filter((addon) => {
      if (filter === "updatable" && !addon.needsUpdate) return false;
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
        if (a.needsUpdate !== b.needsUpdate) return a.needsUpdate ? -1 : 1;
      }
      if (sort === "version") {
        return a.installedVersion.localeCompare(b.installedVersion);
      }
      return a.name.localeCompare(b.name);
    });
  }, [addons, query, sort, filter]);

  if (server.availability === "unavailable") {
    return (
      <div className="banner bad">
        <strong>{server.name} is not reachable.</strong> If it lives on an external
        drive, reconnect it. Your addon list has been kept — nothing was removed.
      </div>
    );
  }

  if (addons.length === 0) {
    return (
      <div className="empty">
        <h3>No addons here yet</h3>
        <p>
          Paste a GitHub or GitLab URL to install one, or browse the curated list
          for {server.versionLabel}.
        </p>
        <button type="button" className="btn primary" onClick={onAdd}>
          Add an addon
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="searchbar">
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
        <div className="empty">
          <h3>Nothing matches</h3>
          <p>No addon on this server matches that search and filter.</p>
        </div>
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
            />
          ))}
        </div>
      )}
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
}: {
  addon: Addon;
  busy: boolean;
  onUpdate: () => void;
  onRemove: () => void;
  onTogglePin: () => void;
  onToggleChannel: () => void;
  onOpen: () => void;
}) {
  return (
    <div className={`row${addon.needsUpdate ? " updatable" : ""}`}>
      <div className="row-main">
        <div className="row-title">
          <strong>{addon.name}</strong>
          {addon.needsUpdate ? (
            <span className="tag update">{addon.latestVersion} available</span>
          ) : null}
          {addon.pinned ? <span className="tag pinned">pinned</span> : null}
          {addon.channel === "source" ? (
            <span className="tag source">source</span>
          ) : null}
          {addon.updateStatus === "error" ? (
            <span className="tag error">check failed</span>
          ) : null}
        </div>
        <div className="row-sub" title={addon.folders.join(", ")}>
          {addon.installedVersion} · {addon.folders.length} folder
          {addon.folders.length === 1 ? "" : "s"} · {addon.folders.join(", ")}
        </div>
      </div>

      <div className="row-actions">
        {busy ? <span className="spinner" aria-label="Working" /> : null}
        {addon.needsUpdate ? (
          <button type="button" className="btn primary small" onClick={onUpdate} disabled={busy}>
            Update
          </button>
        ) : null}
        <button
          type="button"
          className="btn small"
          onClick={onTogglePin}
          disabled={busy}
          title={
            addon.pinned
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
          disabled={busy}
          title="Switch between tagged releases and the latest source build"
        >
          {addon.channel === "release" ? "Use source" : "Use releases"}
        </button>
        <button type="button" className="btn small" onClick={onOpen} disabled={busy}>
          Open page
        </button>
        <button type="button" className="btn small danger" onClick={onRemove} disabled={busy}>
          Remove
        </button>
      </div>
    </div>
  );
}
