import { useEffect, useState } from "react";
import { ago, asText, isProblem, type Entry } from "../activity";

/**
 * The session's messages, in a section that slides out of the right edge.
 *
 * A toast answers "what just happened". This answers "what happened while I
 * was doing something else", which is the question an import of thirty addons
 * actually raises — and the one the old corner-of-the-screen stack could not
 * answer at all, because reading a message meant reading it before it went.
 *
 * Part of the layout rather than a modal over it: the reason to open it is
 * almost always to compare a failure against the addon list, so the list moves
 * aside instead of being covered, and stays usable while the panel is open.
 * That is also why there is no backdrop and no focus trap — nothing here is
 * blocking, and treating it as though it were would make the app inert for a
 * panel you are meant to read *alongside* your work.
 */
export function ActivityDock({
  entries,
  open,
  unread,
  problems: unreadProblems,
  onOpen,
  onClose,
  onClear,
}: {
  entries: Entry[];
  open: boolean;
  unread: number;
  problems: "none" | "warn" | "error";
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
}) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // "just now" stops being true after a minute, so the timestamps tick while
  // the panel is open and nowhere else.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  // Escape closes it, as it would a dialog. It is not modal, so this is a
  // convenience rather than the only way out.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const problems = entries.filter(isProblem).length;
  const shown = problemsOnly ? entries.filter(isProblem) : entries;

  async function copy() {
    try {
      await navigator.clipboard.writeText(asText(entries));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <aside className="dock" data-open={open || undefined}>
      <div className="panel" aria-hidden={!open}>
        <div className="panel-inner" role="region" aria-label="Activity">
          <header>
            <div>
              <h3>Activity</h3>
              <p>{summarise(entries.length, problems)}</p>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close activity"
              onClick={onClose}
            >
              ×
            </button>
          </header>

          {entries.length > 0 ? (
            <div className="panel-tools">
              <div className="segmented" role="group" aria-label="Filter">
                <button
                  type="button"
                  aria-pressed={!problemsOnly}
                  onClick={() => setProblemsOnly(false)}
                >
                  All
                </button>
                <button
                  type="button"
                  aria-pressed={problemsOnly}
                  onClick={() => setProblemsOnly(true)}
                  disabled={problems === 0}
                >
                  Problems{problems > 0 ? ` (${problems})` : ""}
                </button>
              </div>
              <div className="panel-tools-end">
                <button type="button" className="btn small" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </button>
                <button type="button" className="btn small" onClick={onClear}>
                  Clear
                </button>
              </div>
            </div>
          ) : null}

          <div className="panel-body">
            {shown.length === 0 ? (
              <div className="empty">
                <h3>{entries.length === 0 ? "No activity yet" : "No problems"}</h3>
                <p>
                  {entries.length === 0
                    ? "Installs, updates and anything that goes wrong will be listed here."
                    : "Nothing has failed this session."}
                </p>
              </div>
            ) : (
              shown.map((entry) => <Card key={entry.id} entry={entry} now={now} />)
            )}
          </div>

          <footer>
            <span className="hint">
              Kept until the app closes. Nothing here is written to disk.
            </span>
          </footer>
        </div>
      </div>

      {/* The handle. Always there, so the panel is discoverable without
          occupying a place in the navigation — it is not a destination. */}
      <button
        type="button"
        className="rail"
        aria-expanded={open}
        aria-label={
          unread > 0 ? `Activity, ${unread} unread` : "Activity"
        }
        title="Activity"
        onClick={open ? onClose : onOpen}
      >
        {unread > 0 ? (
          <span
            className={`rail-count${unreadProblems === "none" ? "" : ` ${unreadProblems}`}`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
        <span className="rail-label">Activity</span>
      </button>
    </aside>
  );
}

/** "12 messages this session, 3 of them problems" — and the awkward ones. */
function summarise(total: number, problems: number): string {
  if (total === 0) return "Nothing yet this session.";
  const messages = `${total} message${total === 1 ? "" : "s"} this session`;
  if (problems === 0) return `${messages}, none of them problems.`;
  if (problems === total) {
    return total === 1 ? "One message this session, and it is a problem." : `${messages}, all problems.`;
  }
  return `${messages}, ${problems} of them ${problems === 1 ? "a problem" : "problems"}.`;
}

/** One message, as a card, with its failures folded away underneath it. */
function Card({ entry, now }: { entry: Entry; now: number }) {
  return (
    <div className={`activity ${entry.kind}`}>
      <div className="activity-head">
        <span className="activity-text">
          {entry.text}
          {entry.repeats > 1 ? <span className="tag">×{entry.repeats}</span> : null}
        </span>
        <span className="activity-time" title={new Date(entry.at).toLocaleString()}>
          {ago(entry.at, now)}
        </span>
      </div>
      {entry.detail.length > 0 ? (
        <details>
          <summary>
            {entry.detail.length} detail{entry.detail.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {entry.detail.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The corner stack: the first sighting of a message, and only that.
 *
 * Bounded, and everything expires — errors included. They used to stay until
 * dismissed, which was the right call when a dismissed message was gone
 * forever and the wrong one now that it is not: an import with a dozen
 * failures covered the window with cards that each had to be clicked away.
 */
export function ToastStack({
  showing,
  overflow,
  onDismiss,
  onReview,
}: {
  showing: Entry[];
  overflow: number;
  onDismiss: (id: number) => void;
  onReview: () => void;
}) {
  if (showing.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {overflow > 0 ? (
        <button type="button" className="toast more" onClick={onReview}>
          {overflow} more message{overflow === 1 ? "" : "s"} — review in Activity
        </button>
      ) : null}
      {showing.map((entry) => (
        <div key={entry.id} className={`toast ${entry.kind}`}>
          <span style={{ flex: 1 }}>
            {entry.text}
            {entry.detail.length > 0 ? (
              <button type="button" className="linkish" onClick={onReview}>
                See what failed
              </button>
            ) : null}
          </span>
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(entry.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
