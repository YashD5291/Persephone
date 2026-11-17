#!/bin/bash
# Persephone installer for macOS.
#
#   ./install.sh                 finds the extension ID by itself
#   ./install.sh <extension-id>  uses the ID you give it
#
# What it does:
#   1. checks the tools it needs (Chrome, Apple's command line tools)
#   2. finds the ID Chrome gave this folder when it was loaded as an unpacked
#      extension (asks you to load it first if it is not loaded yet)
#   3. builds the live text helper (Swift) and signs it if it can
#   4. registers both native helpers with Chrome for that ID
#
# Safe to run again at any time, e.g. after moving the folder or pulling updates.

set -e

DIR="$(cd "$(dirname "$0")" && pwd -P)"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"
HOSTS_DIR="$CHROME_DIR/NativeMessagingHosts"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

bold "=== Persephone installer ==="
echo "Folder: $DIR"
echo

# --- 1. Prerequisites -------------------------------------------------------
[ "$(uname)" = "Darwin" ] || fail "Persephone's helpers only run on macOS."
[ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ] \
  || fail "Google Chrome is not installed."
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's command line tools are needed (they provide git, python3 and swift)."
  echo "A macOS installer window will open: click Install, wait for it to finish,"
  echo "then run ./install.sh again."
  xcode-select --install || true
  exit 1
fi
command -v python3 >/dev/null || fail "python3 not found."

# --- 2. Extension ID ----------------------------------------------------------
# Chrome names an unpacked extension after its folder, so the ID differs per Mac
# (and changes if the folder moves). It is read from Chrome's own profile files.
find_extension_id() {
  python3 - "$CHROME_DIR" "$DIR" <<'PY'
import json, os, sys
chrome, folder = sys.argv[1], os.path.realpath(sys.argv[2])
found = []
for profile in sorted(os.listdir(chrome)) if os.path.isdir(chrome) else []:
    for name in ("Secure Preferences", "Preferences"):
        path = os.path.join(chrome, profile, name)
        try:
            settings = json.load(open(path)).get("extensions", {}).get("settings", {})
        except Exception:
            continue
        for ext_id, ext in settings.items():
            if ext.get("path") and os.path.realpath(ext["path"]) == folder and ext_id not in found:
                found.append(ext_id)
print(" ".join(found))
PY
}

EXT_IDS="${1:-}"
if [ -z "$EXT_IDS" ]; then
  EXT_IDS="$(find_extension_id)"
  if [ -z "$EXT_IDS" ]; then
    echo "Persephone is not loaded in Chrome yet. In Chrome:"
    echo "  1. open chrome://extensions"
    echo "  2. switch on Developer mode (top right)"
    echo "  3. click \"Load unpacked\" and choose this folder:"
    echo "     $DIR"
    open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
    echo
    for attempt in 1 2 3; do
      read -r -p "Press Enter once it is loaded (Chrome can take a few seconds to save it)... "
      sleep 2
      EXT_IDS="$(find_extension_id)"
      [ -n "$EXT_IDS" ] && break
      echo "Not found yet."
    done
  fi
  if [ -z "$EXT_IDS" ]; then
    read -r -p "Paste the extension ID shown on Persephone's card in chrome://extensions: " EXT_IDS
  fi
fi
[ -n "$EXT_IDS" ] || fail "No extension ID."
echo "Extension ID: $EXT_IDS"

# One allowed origin per ID (the folder may be loaded in more than one Chrome profile).
ORIGINS=""
for id in $EXT_IDS; do
  [[ "$id" =~ ^[a-p]{32}$ ]] || fail "\"$id\" does not look like a Chrome extension ID (32 letters a-p)."
  ORIGINS="$ORIGINS${ORIGINS:+, }\"chrome-extension://$id/\""
done
echo

# --- 3. Helpers ---------------------------------------------------------------
chmod +x "$DIR/native-host/persephone_host.py" "$DIR/native-host/live/build.sh"

bold "Building the live text helper (first build takes a minute or two)..."
"$DIR/native-host/live/build.sh"
LIVE_BINARY="$DIR/native-host/live/.build/release/persephone-live"
[ -x "$LIVE_BINARY" ] || fail "The live text helper did not build."
echo

# --- 4. Register with Chrome --------------------------------------------------
mkdir -p "$HOSTS_DIR"
cat > "$HOSTS_DIR/com.persephone.host.json" <<EOF
{
  "name": "com.persephone.host",
  "description": "Persephone native messaging host for MacWhisper integration",
  "path": "$DIR/native-host/persephone_host.py",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
EOF
cat > "$HOSTS_DIR/com.persephone.live.json" <<EOF
{
  "name": "com.persephone.live",
  "description": "Persephone live text host (reads MacWhisper Live Captions)",
  "path": "$LIVE_BINARY",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
EOF
echo "Registered both helpers with Chrome in $HOSTS_DIR"
echo

bold "=== Installed ==="
cat <<'EOF'
Finish setting up (one time per Mac):
  1. chrome://extensions: click the reload arrow on Persephone, then refresh
     any open claude.ai tabs.
  2. Persephone's popup (toolbar icon): enter the Telegram bot token and chat ID,
     then "Send test message".
  3. chrome://extensions/shortcuts: set Persephone's two shortcuts to
     Cmd+Shift+1 (send) and Cmd+Shift+2 (live text on/off), scope "Global".
  4. MacWhisper: Settings > Live Captions: model Parakeet v3, and record a
     keyboard shortcut (Ctrl+Opt+Cmd+L is the one used so far). In the Live
     Captions panel, pick the audio source your call arrives on (e.g. Loopback Audio).
  5. The first time live text is switched on, macOS asks to allow
     "persephone-live" under Privacy & Security > Accessibility. Allow it,
     then switch live text on again.
EOF
