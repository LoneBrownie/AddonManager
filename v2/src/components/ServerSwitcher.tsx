import { useEffect, useRef, useState } from "react";
import type { Server } from "../api";

/**
 * The switcher, in the shape CurseForge and WowUp use: a dropdown at the top of
 * the sidebar that scopes the whole app to one server.
 *
 * The path is shown under the name on purpose. Several servers on the same game
 * version is normal for private-server players, so two folders both called
 * "WoW" are otherwise indistinguishable.
 */
export function ServerSwitcher({
  servers,
  selectedId,
  onSelect,
  onAddServer,
}: {
  servers: Server[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddServer: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const selected = servers.find((server) => server.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDocument = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="switcher" ref={container}>
      <div className="switcher-label">Server</div>

      <button
        type="button"
        className="switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="swatch"
          style={selected?.accent ? { background: selected.accent } : undefined}
          aria-hidden="true"
        />
        <span className="switcher-text">
          <div className="switcher-name">{selected ? selected.name : "No server yet"}</div>
          <div className="switcher-meta">
            {selected
              ? `${selected.versionLabel} · ${selected.addonCount} addon${
                  selected.addonCount === 1 ? "" : "s"
                }`
              : "Add one to get started"}
          </div>
        </span>
        <span className="chev" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="switcher-menu" role="listbox" aria-label="Servers">
          {servers.map((server) => (
            <button
              key={server.id}
              type="button"
              role="option"
              aria-selected={server.id === selectedId}
              onClick={() => {
                onSelect(server.id);
                setOpen(false);
              }}
            >
              <span
                className="swatch"
                style={server.accent ? { background: server.accent } : undefined}
                aria-hidden="true"
              />
              <span className="switcher-text">
                <div className="switcher-name">
                  {server.name}
                  {server.availability === "unavailable" ? (
                    <span className="tag error" style={{ marginLeft: 8 }}>
                      offline
                    </span>
                  ) : null}
                </div>
                <div className="switcher-meta" title={server.path}>
                  {server.path}
                </div>
              </span>
            </button>
          ))}

          <button
            type="button"
            className="add-row"
            onClick={() => {
              setOpen(false);
              onAddServer();
            }}
          >
            + Add a server
          </button>
        </div>
      ) : null}
    </div>
  );
}
