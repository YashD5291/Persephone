(function() {
  'use strict';
  const P = window.Persephone = window.Persephone || {};

  const DEFAULT_SKIP_KEYWORDS = ['short', 'shorter', 'shrt', 'shrtr', 'shrter'];

  // ============================================
  // MESSAGE PROTOCOL CONSTANTS
  // ============================================

  const MSG = {
    // Telegram operations
    SEND_TO_TELEGRAM:   'SEND_TO_TELEGRAM',
    EDIT_MESSAGE:       'EDIT_MESSAGE',
    STREAM_EDIT:        'STREAM_EDIT',
    DELETE_MESSAGE:     'DELETE_MESSAGE',
    TEST_CONNECTION:    'TEST_CONNECTION',
    PRECONNECT:         'PRECONNECT',
    GET_STATS:          'GET_STATS',

    // Tab management
    GET_TAB_LIST:       'GET_TAB_LIST',
    GET_TAB_AUTO_SEND:  'GET_TAB_AUTO_SEND',
    SET_TAB_AUTO_SEND:  'SET_TAB_AUTO_SEND',
    SAVE_OWN_AUTO_SEND: 'SAVE_OWN_AUTO_SEND',
    GET_AUTO_SEND_STATE:'GET_AUTO_SEND_STATE',
    SET_AUTO_SEND_STATE:'SET_AUTO_SEND_STATE',

    // Broadcasting
    BROADCAST_QUESTION:   'BROADCAST_QUESTION',
    BROADCAST_SCREENSHOT: 'BROADCAST_SCREENSHOT',
    INSERT_AND_SUBMIT:    'INSERT_AND_SUBMIT',
    PASTE_SCREENSHOT:     'PASTE_SCREENSHOT',

    // Settings (popup → content)
    EXTENSION_ENABLED_CHANGED: 'EXTENSION_ENABLED_CHANGED',
    AUTO_SEND_CHANGED:         'AUTO_SEND_CHANGED',
    SKIP_KEYWORDS_CHANGED:     'SKIP_KEYWORDS_CHANGED',
    SPLIT_THRESHOLD_CHANGED:   'SPLIT_THRESHOLD_CHANGED',
    FIRST_CHUNK_WORD_LIMIT_CHANGED: 'FIRST_CHUNK_WORD_LIMIT_CHANGED',
    AUTO_SUBMIT_VOICE_CHANGED: 'AUTO_SUBMIT_VOICE_CHANGED',
    VOICE_AUTO_RESTART_CHANGED: 'VOICE_AUTO_RESTART_CHANGED',
    VOICE_RESTART_DELAY_CHANGED: 'VOICE_RESTART_DELAY_CHANGED',
    SCREENSHOT_QUALITY_CHANGED: 'SCREENSHOT_QUALITY_CHANGED',

    // Features
    TOGGLE_WHISPER: 'TOGGLE_WHISPER',

    // Live text (MacWhisper Live Captions -> chat box)
    LIVE_TOGGLE:     'LIVE_TOGGLE',      // tab -> background: mic pressed, switch live text on/off
    LIVE_MARK:       'LIVE_MARK',        // tab -> background: start a fresh question
    LIVE_SET_TARGET: 'LIVE_SET_TARGET',  // tab -> background: choose the chat that receives the text
    LIVE_HERE:       'LIVE_HERE',        // tab -> background: the page's live button (live text into this chat, or off)
    LIVE_GET_STATE:  'LIVE_GET_STATE',   // tab -> background: live text state as this tab sees it
    LIVE_SET_ACTIVE: 'LIVE_SET_ACTIVE',  // background -> tab: you are (not) receiving live text
    LIVE_SUBMIT:     'LIVE_SUBMIT',      // background -> tab: the user pressed the send shortcut
    VOICE_TIMING:    'VOICE_TIMING',     // tab -> background: how long one question took, stage by stage
    LIVE_STATE:      'LIVE_STATE',       // background -> all tabs: on/off and current target
    LIVE_TEXT:       'LIVE_TEXT',        // background -> tab: question text so far
    LIVE_STATUS:     'LIVE_STATUS',      // background -> tab: helper / captions problems
    GET_CLIPBOARD:  'GET_CLIPBOARD',
  };

  // --- Exports ---
  Object.assign(P, { DEFAULT_SKIP_KEYWORDS, MSG });
})();
