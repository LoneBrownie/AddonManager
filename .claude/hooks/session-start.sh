#!/bin/bash
# Prepare a Claude Code on the web container to build and test V2.
#
# Without this, the Tauri app cannot be compiled in a web session: the base
# image has no WebKitGTK, and the apt index is stale enough that a plain
# `apt-get install` 404s on the package versions it thinks exist.
#
# The engine (v2/core) needs none of this — it is a plain Rust library with no
# GUI dependency, which is why it stays buildable even if this hook fails.
set -euo pipefail

# Local machines already have whatever the developer set up. Only the
# ephemeral web container needs provisioning.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo "Preparing V2 build environment..."

# --- Linux GUI toolchain for Tauri ---------------------------------------
# Skip entirely if it is already present, so the hook is cheap on re-runs and
# safe on a cached container.
if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "  WebKitGTK already present, skipping apt"
else
  echo "  Installing Tauri's Linux dependencies (this takes a minute)"
  export DEBIAN_FRONTEND=noninteractive

  # The refresh is the important part. The base image's package index points at
  # versions that have since been superseded, so installing without it fails
  # with 404s that look like a blocked network but are not.
  apt-get update -qq || echo "  (apt-get update reported warnings; continuing)"

  apt-get install -y -qq --no-install-recommends \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    build-essential \
    pkg-config \
    || echo "  (dependency install failed — v2/core still builds, the Tauri shell will not)"
fi

if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "  ✓ webkit2gtk-4.1 available — the Tauri app can be compiled"
else
  echo "  ! webkit2gtk-4.1 unavailable — v2/core still builds and tests fine"
fi

# --- Rust dependencies ----------------------------------------------------
# Warms the cargo cache so the first `cargo test` in the session is fast. The
# container image is snapshotted after this hook, so the download is paid once.
if [ -f "$CLAUDE_PROJECT_DIR/v2/Cargo.toml" ]; then
  echo "  Fetching cargo dependencies"
  (cd "$CLAUDE_PROJECT_DIR/v2" && cargo fetch --quiet) \
    || echo "  (cargo fetch failed; the build will fetch on demand)"
fi

# Playwright's browsers are preinstalled in the image; point at them rather
# than letting an npm postinstall try to download its own copy.
{
  echo 'export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers'
  echo 'export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1'
} >> "${CLAUDE_ENV_FILE:-/dev/null}"

echo "V2 build environment ready."
