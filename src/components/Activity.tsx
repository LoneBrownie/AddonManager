import { useEffect, useState } from "react";
import { ago, asText, isProblem, type Entry } from "../activity";
import { useModalChrome } from "./Dialog";

/**
 * The session's messages, in a panel that slides in from the right.
 *
 * A toast answers "what just happened". This answers "what happened while I
 * was doing something else", which is the question an import of thirty addons
 * actually raises — and the one the old corner-of-the-screen stack could not
 * answer at all, because reading a message meant reading it before it went.
 *
 * Deliberately a drawer rather than a page: the reason to open it is usually
 * to compare a failure against the addon list, and a page swap takes that
 * list away at exactly the wrong moment.
 */
export function ActivityDrawer({
  entries,
  onClose,
  onClear,
}: {
  entries: Entry[];
  onClose: () => void;
  onClear: () => void;
}) {
  const panel = useModalChrome(onClose);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // "just now" stops being true after a minute, so the timestamps tick while
  // the drawer is open and nowhere else.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

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
    <div
      className="backdrop drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Activity"
        ref={panel}
      >
        <header>
          <div>
            <h3>Activity</h3>
            <p>{summarise(entries.length, problems)}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {entries.length > 0 ? (
          <div className="drawer-tools">
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
            <div className="drawer-tools-end">
              <button type="button" className="btn small" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="btn small" onClick={onClear}>
                Clear
              </button>
            </div>
          </div>
        ) : null}

        <div className="drawer-body">
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
            shown.map((entry) => <Row key={entry.id} entry={entry} now={now} />)
          )}
        </div>

        <footer>
          <span className="hint">
            Kept until the app closes. Nothing here is written to disk.
          </span>
        </footer>
      </div>
    </div>
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

/** One message, with its failures folded away underneath it. */
function Row({ entry, now }: { entry: Entry; now: number }) {
  return (
    <div className={`activity ${entry.kind}`}>
      <div className="activity-head">
        <span className="activity-text">
          {entry.text}
          {entry.repeats > 1 ? <span className="tag">×{entry.repeats}</span> : null}
        </span>
        <span
          className="activity-time"
          title={new Date(entry.at).toLocaleString()}
        >
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
