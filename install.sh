#!/bin/sh
# Scenaria installer (macOS / Linux) — single binary, no Node.js required.
#   curl -fsSL https://raw.githubusercontent.com/<owner>/scenaria/main/install.sh | sh
# The download is checked against the release's SHA256SUMS before it is installed.
# Options (env): SCENARIA_REPO=owner/repo  SCENARIA_VERSION=0.9.24  SCENARIA_INSTALL_DIR=~/.local/bin
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
# Check the download against the release's SHA256SUMS before anything is unpacked or run.
sums_url="${url%/*}/SHA256SUMS"
if [ "${SCENARIA_SKIP_VERIFY:-}" = "1" ]; then
  say "! Skipping the checksum check (SCENARIA_SKIP_VERIFY=1)."
else
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS" || fail "could not download SHA256SUMS (${sums_url}). Nothing was installed."
  else
    wget -q "$sums_url" -O "$tmp/SHA256SUMS" || fail "could not download SHA256SUMS (${sums_url}). Nothing was installed."
  fi
  want="$(awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == f) print $1 }' "$tmp/SHA256SUMS" | head -n 1)"
  [ -n "$want" ] || fail "SHA256SUMS has no entry for ${asset}. Nothing was installed."
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$tmp/scenaria.gz" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$tmp/scenaria.gz" | awk '{print $1}')"
  else
    fail "sha256sum or shasum is required to check the download. Nothing was installed."
  fi
  [ "$got" = "$want" ] || fail "checksum mismatch for ${asset} (expected ${want}, got ${got}). Nothing was installed."
  say "✔ Checksum matches SHA256SUMS"
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
