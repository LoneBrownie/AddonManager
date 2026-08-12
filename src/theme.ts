/**
 * Applying the chosen theme to the document.
 *
 * The stylesheet is dark by default and light under `[data-theme="light"]`, so
 * everything here does is decide which of those the document is in. "System"
 * is resolved here rather than in CSS: the choice has to survive a restart, and
 * the engine stores it as an absent value, so the one place that knows what
 * absent *means* is this file.
 */

import type { Theme } from "./api";

/** What the operating system is asking for right now. */
function preferred(): "dark" | "light" {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/**
 * Put `theme` on the document.
 *
 * Dark is the stylesheet's default, so it is expressed by removing the
 * attribute rather than setting it — one state, not two ways of spelling it.
 */
export function apply(theme: Theme): void {
  const resolved = theme ?? preferred();
  const root = document.documentElement;
  if (resolved === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }
}

/**
 * Follow the system while the user has not chosen for themselves.
 *
 * Returns the unsubscribe function. Someone who has picked dark or light means
 * it, so their choice is not overridden when the desktop switches at sunset.
 */
export function follow(theme: Theme): () => void {
  if (theme !== null || typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => apply(null);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
