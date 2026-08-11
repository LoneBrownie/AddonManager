#!/usr/bin/env python3
"""Fail the build when a Rust module's non-test code grows past the limit.

V1's defining quality problem was drift: a 1,662-line `addon-manager.js` that
accumulated across many sessions with nobody reviewing the diffs. Since V2 is
written the same way, the limit is enforced by CI rather than by intention
(V2-PLAN.md 5.1.2).

Test code is excluded from the count — a module earning its keep with a large
test suite is a good thing, not drift.
"""

from __future__ import annotations

import sys
from pathlib import Path

LIMIT = 400
ROOT = Path(__file__).resolve().parent.parent


def code_lines(path: Path) -> int:
    """Lines before the first `#[cfg(test)]` block."""
    lines = path.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        if line.strip().startswith("#[cfg(test)]"):
            return index
    return len(lines)


def main() -> int:
    offenders: list[tuple[Path, int]] = []
    for path in sorted(ROOT.rglob("*.rs")):
        if "target" in path.parts:
            continue
        if path.parts and "tests" in path.parts:
            continue  # integration test files are all test code
        count = code_lines(path)
        if count > LIMIT:
            offenders.append((path.relative_to(ROOT), count))

    if not offenders:
        print(f"module size OK — every module is within {LIMIT} lines of code")
        return 0

    print(f"Modules over the {LIMIT}-line limit:", file=sys.stderr)
    for path, count in offenders:
        print(f"  {path}: {count} lines", file=sys.stderr)
    print(
        "\nSplit the module along a real seam rather than raising the limit.\n"
        "See V2-PLAN.md 5.1.2 for why this gate exists.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
