#!/bin/bash
# Builds the live text helper and signs it.
#
# Why signing matters: macOS ties the Accessibility permission to the helper's
# code identity. An unsigned build gets a new identity every time it is
# rebuilt, so an approval given to one build silently stops applying to the
# next ("Failed to match existing code requirement" in the TCC log). Signed
# with the same certificate each time, the identity stays the same and the
# approval survives rebuilds.
#
# Identity: $PERSEPHONE_SIGN_IDENTITY, or the first code-signing identity in
# the keychain. A self-signed "Code Signing" certificate made in Keychain
# Access (Certificate Assistant > Create a Certificate) is enough.

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
swift build -c release --package-path "$DIR"
BINARY="$(cd "$DIR/.build/release" && pwd -P)/persephone-live"

IDENTITY="${PERSEPHONE_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' 'NF >= 3 { print $2; exit }')"
fi

if [ -n "$IDENTITY" ] && codesign --force --sign "$IDENTITY" --identifier com.persephone.live "$BINARY"; then
  echo "Signed with \"$IDENTITY\". Accessibility permission will survive future rebuilds."
elif [ -n "$IDENTITY" ]; then
  # Usually a locked keychain, e.g. when installing over SSH. The helper still
  # works signed ad hoc; run the installer again at the Mac itself to sign it
  # properly.
  codesign --force --sign - --identifier com.persephone.live "$BINARY"
  echo "WARNING: could not sign with \"$IDENTITY\" (keychain locked? e.g. over SSH)."
  echo "         Signed ad hoc instead: it works, but after a rebuild macOS will ask"
  echo "         for Accessibility again. Run ./install.sh at the Mac itself to sign it properly."
else
  echo "WARNING: no code-signing identity found, the helper is unsigned."
  echo "         After every rebuild you will have to remove \"persephone-live\" from"
  echo "         System Settings > Privacy & Security > Accessibility and allow it again."
fi
