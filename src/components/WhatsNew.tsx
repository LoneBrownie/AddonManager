import type { ReactElement } from "react";
import { Dialog } from "./Dialog";

/**
 * What changed in the version now running, shown once after an update.
 *
 * The notes come out of the binary rather than off the network, so this works
 * on a machine that has just restarted with no connection — and so the notes
 * always describe the code actually running.
 */
export function WhatsNewDialog({
  version,
  notes,
  onClose,
}: {
  version: string;
  notes: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={`What’s new in ${version}`}
      description="This is what changed in the version you have just moved to."
      onClose={onClose}
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          Got it
        </button>
      }
    >
      <div className="notes">
        <Markdown text={notes} />
      </div>
    </Dialog>
  );
}

/**
 * The small Markdown subset CHANGELOG.md actually uses.
 *
 * Headings, bullets — including the indented ones — bold, and inline code.
 * Written out rather than pulled in as a dependency: a changelog entry is a
 * handful of constructs, and the alternative is a parser several times the size
 * of this whole component for the sake of syntax this file never contains.
 *
 * Everything becomes React elements. Nothing is set as HTML, so even though
 * this text ships inside the binary, no part of it can become markup.
 */
function Markdown({ text }: { text: string }) {
  const blocks: ReactElement[] = [];
  let bullets: { depth: number; text: string }[] = [];

  const flush = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {items.map((item, index) => (
          <li key={index} className={item.depth > 0 ? "nested" : undefined}>
            <Inline text={item.text} />
          </li>
        ))}
      </ul>,
    );
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    if (line.trim().length === 0) {
      continue;
    }

    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(<h4 key={`h-${blocks.length}`}>{heading[1]}</h4>);
      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push({
        depth: Math.floor((bullet[1] ?? "").length / 2),
        text: bullet[2] ?? "",
      });
      continue;
    }

    // A wrapped continuation of the bullet above it. The changelog wraps at
    // 80 columns, so most entries are several lines of one sentence.
    const last = bullets[bullets.length - 1];
    if (last) {
      last.text = `${last.text} ${line.trim()}`;
      continue;
    }

    flush();
    blocks.push(
      <p key={`p-${blocks.length}`}>
        <Inline text={line.trim()} />
      </p>,
    );
  }

  flush();
  return <>{blocks}</>;
}

/**
 * `**bold**`, `*italic*` and `` `code` `` within a line.
 *
 * Bold is matched before italic, or `**a**` would be read as an empty italic
 * either side of the word.
 */
function Inline({ text }: { text: string }) {
  const parts: ReactElement[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > index) {
      parts.push(<span key={parts.length}>{text.slice(index, match.index)}</span>);
    }
    if (match[1] !== undefined) {
      parts.push(<strong key={parts.length}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      parts.push(<em key={parts.length}>{match[2]}</em>);
    } else if (match[3] !== undefined) {
      parts.push(<code key={parts.length}>{match[3]}</code>);
    }
    index = match.index + match[0].length;
  }
  if (index < text.length) {
    parts.push(<span key={parts.length}>{text.slice(index)}</span>);
  }

  return <>{parts}</>;
}
