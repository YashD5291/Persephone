#!/usr/bin/env python3
"""
Persephone Native Messaging Host for MacWhisper integration.
Receives JSON messages from Chrome extension and simulates Fn+F5 keypress
to toggle MacWhisper recording.
"""

import json
import struct
import subprocess
import sys


def read_message():
    """Read a native messaging message from stdin (4-byte length prefix)."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack('=I', raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode('utf-8'))


def send_message(obj):
    """Write a native messaging message to stdout (4-byte length prefix)."""
    encoded = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def toggle_whisper(refocus=False):
    """Simulate F5 keypress via osascript to toggle MacWhisper."""
    try:
        subprocess.run(
            ['osascript', '-e', 'tell application "System Events" to key code 96'],
            check=True,
            capture_output=True,
            timeout=5
        )
        if refocus:
            # Re-activate Chrome in the background so MacWhisper types into it.
            # Non-blocking: spawns a detached process that waits then activates.
            subprocess.Popen(
                ['osascript',
                 '-e', 'delay 0.3',
                 '-e', 'tell application "Google Chrome" to activate'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        sys.stderr.write(f"osascript error: {e}\n")
        return False


def get_clipboard():
    """Read current clipboard contents via pbpaste."""
    try:
        result = subprocess.run(
            ['pbpaste'],
            capture_output=True,
            text=True,
            timeout=3
        )
        return result.stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        sys.stderr.write(f"pbpaste error: {e}\n")
        return None


def main():
    message = read_message()
    if message is None:
        send_message({"success": False, "error": "No message received"})
        return

    action = message.get("action")
    if action == "toggle":
        refocus = message.get("refocus", False)
        ok = toggle_whisper(refocus=refocus)
        send_message({"success": ok})
    elif action == "get_clipboard":
        text = get_clipboard()
        if text is not None:
            send_message({"success": True, "text": text})
        else:
            send_message({"success": False, "error": "Failed to read clipboard"})
    else:
        send_message({"success": False, "error": f"Unknown action: {action}"})


if __name__ == '__main__':
    main()
