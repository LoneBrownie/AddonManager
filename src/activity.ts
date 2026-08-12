import { useCallback, useEffect, useMemo, useReducer } from "react";

/**
 * Every message the app raises, kept for the session.
 *
 * The toasts came first and were the only thing: a message appeared in the
 * corner, and when it went, it was gone. That works for one message and fails
 * badly for thirty — importing a list from V1 with a dozen bad URLs put a
 * dozen error cards on screen, each needing its own dismissal, and reading
 * them meant reading them *then*, because there was no second chance.
 *
 * So the toast stops being where a message lives and becomes only where it
 * first appears. Everything lands here too, and stays until the app closes.
 * That is what lets the toasts be brief — including the errors, which used to
 * sit on screen indefinitely for want of anywhere else to be.
 */
export type Kind = "info" | "success" | "warn" | "error";

export type Entry = {
  id: number;
  kind: Kind;
  /** The line the toast shows. Keep it to one sentence. */
  text: string;
  /**
   * The individual failures behind a summary, for anything that acts on many
   * addons at once. These are the lines that used to be a toast each.
   */
  detail: string[];
  at: number;
  /** Consecutive arrivals of the identical message, collapsed into one row. */
  repeats: number;
  seen: boolean;
};

export type Notify = (kind: Kind, text: string, detail?: string[]) => void;

/** Oldest entries fall off the end. Long enough for any one session's work. */
const LIMIT = 200;

/** How long a toast stays up. Errors get longer — they are worth reading. */
const LINGER: Record<Kind, number> = {
  success: 4_000,
  info: 5_500,
  warn: 8_000,
  error: 10_000,
};

/** Toasts on screen at once. The rest are counted, not stacked. */
export const VISIBLE = 3;

/** Identical messages inside this window collapse rather than repeat. */
const REPEAT_WINDOW = 20_000;

type Toast = { id: number; until: number };

type State = {
  /** Newest first, which is both the drawer's order and the merge check. */
  entries: Entry[];
  toasts: Toast[];
};

type Action =
  | { type: "notify"; id: number; kind: Kind; text: string; detail: string[]; now: number }
  | { type: "tick"; now: number }
  | { type: "dismiss"; id: number }
  | { type: "dismissAll" }
  | { type: "read" }
  | { type: "clear" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "notify": {
      const newest = state.entries[0];
      const toast = { id: 0, until: action.now + LINGER[action.kind] };

      // "Check for updates" pressed four times running should read as one
      // line with a count, not four identical ones — but only while they are
      // adjacent, so a repeat an hour later is still its own event.
      if (
        newest &&
        newest.kind === action.kind &&
        newest.text === action.text &&
        action.detail.length === 0 &&
        newest.detail.length === 0 &&
        action.now - newest.at < REPEAT_WINDOW
      ) {
        const merged: Entry = {
          ...newest,
          at: action.now,
          repeats: newest.repeats + 1,
          seen: false,
        };
        return {
          entries: [merged, ...state.entries.slice(1)],
          toasts: [
            { ...toast, id: merged.id },
            ...state.toasts.filter((item) => item.id !== merged.id),
          ],
        };
      }

      const entry: Entry = {
        id: action.id,
        kind: action.kind,
        text: action.text,
        detail: action.detail,
        at: action.now,
        repeats: 1,
        seen: false,
      };
      return {
        entries: [entry, ...state.entries].slice(0, LIMIT),
        toasts: [{ ...toast, id: entry.id }, ...state.toasts],
      };
    }

    case "tick": {
      const live = state.toasts.filter((item) => item.until > action.now);
      return live.length === state.toasts.length ? state : { ...state, toasts: live };
    }

    case "dismiss":
      return { ...state, toasts: state.toasts.filter((item) => item.id !== action.id) };

    case "dismissAll":
      return { ...state, toasts: [] };

    case "read":
      return state.entries.every((entry) => entry.seen)
        ? state
        : {
            ...state,
            entries: state.entries.map((entry) =>
              entry.seen ? entry : { ...entry, seen: true },
            ),
          };

    case "clear":
      return { entries: [], toasts: [] };
  }
}

let nextId = 0;

/**
 * The activity log, its unread count, and the toasts currently on screen.
 *
 * `notify` keeps the identity it has always had, because it is a dependency of
 * half the callbacks in the app and a changing one would re-run them.
 */
export function useActivity() {
  const [state, dispatch] = useReducer(reducer, { entries: [], toasts: [] });

  const notify = useCallback<Notify>((kind, text, detail) => {
    nextId += 1;
    dispatch({
      type: "notify",
      id: nextId,
      kind,
      text,
      detail: detail ?? [],
      now: Date.now(),
    });
  }, []);

  // One timer for the whole stack rather than one per toast, so a burst of
  // thirty messages does not schedule thirty timeouts — and so a toast's life
  // is not restarted by the next one arriving. It stops when the stack empties.
  const anyToasts = state.toasts.length > 0;
  useEffect(() => {
    if (!anyToasts) return;
    const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 250);
    return () => clearInterval(timer);
  }, [anyToasts]);

  const unread = useMemo(
    () => state.entries.filter((entry) => !entry.seen).length,
    [state.entries],
  );
  // The badge's colour: the worst thing waiting to be read, or nothing.
  const unreadProblems = useMemo<"none" | "warn" | "error">(() => {
    const unseen = state.entries.filter((entry) => !entry.seen);
    if (unseen.some((entry) => entry.kind === "error")) return "error";
    if (unseen.some((entry) => entry.kind === "warn")) return "warn";
    return "none";
  }, [state.entries]);

  /** The toasts to draw, oldest of the visible few first so new ones rise. */
  const showing = useMemo(
    () =>
      state.toasts
        .slice(0, VISIBLE)
        .map((toast) => state.entries.find((entry) => entry.id === toast.id))
        .filter((entry): entry is Entry => entry !== undefined)
        .reverse(),
    [state.toasts, state.entries],
  );

  return {
    entries: state.entries,
    notify,
    unread,
    unreadProblems,
    showing,
    /** Messages beyond the visible few, counted so nothing is silently lost. */
    overflow: Math.max(0, state.toasts.length - VISIBLE),
    dismiss: useCallback((id: number) => dispatch({ type: "dismiss", id }), []),
    dismissAll: useCallback(() => dispatch({ type: "dismissAll" }), []),
    markRead: useCallback(() => dispatch({ type: "read" }), []),
    clear: useCallback(() => dispatch({ type: "clear" }), []),
  };
}

/**
 * Whether this entry is something that went wrong.
 *
 * A batch that half worked is a `warn` rather than an `error` — "updated 14 of
 * 18" is not a failure — but it is still the thing somebody opened the drawer
 * to find, so the filter and the badge treat the two together.
 */
export function isProblem(entry: Entry): boolean {
  return entry.kind === "error" || entry.kind === "warn";
}

/** "just now", "4 min ago", "2 hr ago" — then the clock time. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 12) return `${hours} hr ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The log as text, for pasting into a bug report. */
export function asText(entries: Entry[]): string {
  return entries
    .slice()
    .reverse()
    .flatMap((entry) => {
      const stamp = new Date(entry.at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const repeats = entry.repeats > 1 ? ` (×${entry.repeats})` : "";
      return [
        `[${stamp}] ${entry.kind.toUpperCase()} ${entry.text}${repeats}`,
        ...entry.detail.map((line) => `    ${line}`),
      ];
    })
    .join("\n");
}
