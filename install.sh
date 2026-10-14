#!/bin/sh
# Scenaria installer (macOS / Linux) — single binary, no Node.js required.
#   curl -fsSL https://raw.githubusercontent.com/<owner>/scenaria/main/install.sh | sh
# Options (env): SCENARIA_REPO=owner/repo  SCENARIA_VERSION=0.3.0  SCENARIA_INSTALL_DIR=~/.local/bin
set -eu

REPO="${SCENARIA_REPO:-aigambitkg/scenaria}"
VERSION="${SCENARIA_VERSION:-latest}"
INSTALL_DIR="${SCENARIA_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'scenaria install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s). On Windows use install.ps1, or: npm install -g scenaria" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported CPU $(uname -m). Try: npm install -g scenaria" ;;
esac

asset="scenaria-${os}-${arch}.gz"
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/v${VERSION}/${asset}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say "Downloading ${url}"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar "$url" -o "$tmp/scenaria.gz" || fail "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress "$url" -O "$tmp/scenaria.gz" || fail "download failed"
else
  fail "curl or wget is required"
fi
gunzip -f "$tmp/scenaria.gz"
chmod +x "$tmp/scenaria"

if [ "$os" = "darwin" ]; then
  # Downloaded binaries are quarantined and need at least an ad-hoc signature on Apple Silicon.
  xattr -d com.apple.quarantine "$tmp/scenaria" 2>/dev/null || true
  codesign --force --sign - "$tmp/scenaria" >/dev/null 2>&1 || true
fi

mkdir -p "$INSTALL_DIR"
mv -f "$tmp/scenaria" "$INSTALL_DIR/scenaria"
say "✔ Installed $INSTALL_DIR/scenaria"

if ! command -v git >/dev/null 2>&1; then
  say "! git was not found — Scenaria needs it for file snapshots."
  [ "$os" = "darwin" ] && say "  Install it with: xcode-select --install"
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say "! $INSTALL_DIR is not on your PATH. Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    say "    export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

say ""
say "Next:"
say "  cd your-project && scenaria start      # dashboard, agents wired, conversations + versions recorded"
say "  scenaria setup --global                # optional: enable Scenaria in every project automatically"
