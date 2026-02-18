// ============================================
// NATIVE MESSAGING (MacWhisper)
// ============================================

/**
 * Toggle MacWhisper recording via native messaging host
 */
async function toggleWhisper(refocus = false) {
  try {
    const response = await chrome.runtime.sendNativeMessage('com.persephone.host', { action: 'toggle', refocus });
    return { success: response?.success ?? false };
  } catch (error) {
    log.native.error('Native messaging error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Read clipboard contents via native messaging host
 */
async function getClipboard() {
  try {
    const response = await chrome.runtime.sendNativeMessage('com.persephone.host', { action: 'get_clipboard' });
    return { success: response?.success ?? false, text: response?.text ?? '' };
  } catch (error) {
    log.native.error('Clipboard read error:', error.message);
    return { success: false, error: error.message };
  }
}
