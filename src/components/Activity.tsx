import { useEffect, useRef, useState } from "react";
import { ago, asText, isProblem, type Entry } from "../activity";

/**
 * The session's messages, in a section that slides out of the right edge.
 *
 * This is now where most messages live and the only place most of them appear:
 * a success has already shown itself in the list it changed, so it flashes the
 * tab and counts up rather than putting a card over that same list. Only
 * failures interrupt. Either way it is all here afterwards, which is what the
 * old corner stack could never offer — reading a message meant reading it
 * before it went.
 *
 * It floats over the work rather than displacing it. Pushing the addon list
 * aside sounds kinder, but the window is 900px at its narrowest and the list
 * has nowhere to go — its rows start stacking their own buttons. Covering the
 * right-hand third of a list you can restore with one click costs less.
 *
 * Nothing about it is modal, though: no backdrop, no focus trap, and the app
 * behind stays live. It is a thing to consult while working, not a question to
 * answer before continuing.
 */
export function ActivityDock({
  entries,
  open,
  unread,
  problems: unreadProblems,
  pulse,
  onOpen,
  onClose,
  onClear,
}: {
  entries: Entry[];
  open: boolean;
  unread: number;
  problems: "none" | "warn" | "error";
  /** Changes on every message; the tab flashes when it does. */
  pulse: number;
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
}) {
  const dock = useRef<HTMLElement>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [flash, setFlash] = useState(false);

  // Most messages no longer raise a toast, so this is how they announce
  // themselves: the tab lights up for a moment and the count goes up. Enough
  // to notice out of the corner of an eye, and nothing to dismiss.
  useEffect(() => {
    if (pulse === 0) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 800);
    return () => clearTimeout(timer);
  }, [pulse]);

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

  // So does anything else you press. There is no backdrop to click — the app
  // behind stays live on purpose — so reaching for the addon list closed
  // nothing and left the panel sitting over what you were reaching for.
  //
  // `pointerdown` rather than `click`: pressing a button behind the panel
  // should both close this and do the thing, and a click handler that fires
  // after React has re-rendered can miss the second half. The tab is excluded
  // because it is its own toggle — closing here as well would leave it
  // reopening on the same press.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && dock.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
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
    <aside className="dock" data-open={open || undefined} ref={dock}>
      {/* The pull-tab. Always there, so the panel is discoverable without
          occupying a place in the navigation — it is not a destination — and
          small enough that it does not read as a second sidebar. It sits to
          the left of the panel, so opening carries it out with the panel
          rather than leaving it stranded at the window's edge. */}
      <button
        type="button"
        className={`tab${flash ? " flash" : ""}`}
        aria-expanded={open}
        aria-label={unread > 0 ? `Activity, ${unread} unread` : "Activity"}
        title="Activity"
        onClick={open ? onClose : onOpen}
      >
        <Tab />
        <span className="tab-content">
          {unread > 0 ? (
            <span
              className={`tab-count${unreadProblems === "none" ? "" : ` ${unreadProblems}`}`}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
          <span className="tab-label">Activity</span>
        </span>
      </button>

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

    </aside>
  );
}

/**
 * The tab's outline.
 *
 * Drawn rather than built from a border radius because the shape that reads as
 * a tab is not a rounded rectangle: it needs shoulders that leave the edge
 * along the edge and arrive at the face along the face, which is two cubics
 * and no amount of `border-radius`. Stroked at a half-pixel inset so neither
 * side of the outline is clipped by the viewBox.
 */
function Tab() {
  return (
    <svg className="tab-shape" viewBox="0 0 28 132" aria-hidden="true">
      <path d="M27.5 0.5 C27.5 12 0.5 10 0.5 22 L0.5 110 C0.5 122 27.5 120 27.5 131.5 Z" />
    </svg>
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
 * Failures, and nothing else.
 *
 * Everything used to arrive here, which meant a stack of cards over the work
 * saying things the work itself already said — "Questie updated to v11.3.0",
 * over a row now reading v11.3.0. What is left is the case where there is
 * genuinely nothing else to see: something did not happen, and no amount of
 * looking at the list will say why.
 *
 * Bounded, and expiring, errors included. They used to stay until dismissed,
 * which was right when a dismissed message was gone forever and wrong now that
 * the panel has it.
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
