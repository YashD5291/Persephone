#!/bin/bash
# Persephone Native Messaging Host Installer
# Sets up the native messaging host for MacWhisper integration.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/persephone_host.py"
HOST_NAME="com.persephone.host"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

echo "=== Persephone Native Messaging Host Installer ==="
echo ""

# Get extension ID
read -p "Enter your Chrome extension ID (from chrome://extensions): " EXT_ID

if [ -z "$EXT_ID" ]; then
  echo "Error: Extension ID is required."
  exit 1
fi

# Make Python script executable
chmod +x "$HOST_SCRIPT"
echo "Made $HOST_SCRIPT executable."

# Create target directory if needed
mkdir -p "$TARGET_DIR"

# Generate manifest with correct paths
cat > "$TARGET_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Persephone native messaging host for MacWhisper integration",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "Installed manifest to: $TARGET_DIR/$HOST_NAME.json"
echo ""
echo "=== Installation complete ==="
echo "Restart Chrome and reload the extension to activate native messaging."
