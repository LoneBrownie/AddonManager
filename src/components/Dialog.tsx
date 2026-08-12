import { useEffect, useRef, type ReactNode } from "react";

/**
 * A modal that behaves like one.
 *
 * V1's modals had neither a focus trap nor an Escape handler, so keyboard users
 * tabbed straight out into the page behind. This restores focus to whatever was
 * focused before it opened, traps Tab inside while open, and closes on Escape.
 */
export function Dialog({
  title,
  description,
  onClose,
  footer,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panel = useModalChrome(onClose);

  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
      >
        <header>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * Escape to close, Tab kept inside, focus returned on the way out.
 *
 * Shared with the activity drawer, which is the same contract in a different
 * shape — it slides in from the side rather than sitting in the middle, and
 * that is the whole of the difference.
 */
export function useModalChrome(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusTo.current = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusTo.current?.focus();
    };
  }, [onClose]);

  return panel;
}
