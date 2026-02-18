document.addEventListener('DOMContentLoaded', async () => {
  const botTokenInput = document.getElementById('botToken');
  const chatIdInput = document.getElementById('chatId');
  const enabledToggle = document.getElementById('enabledToggle');
  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const messageDiv = document.getElementById('message');
  const messageCount = document.getElementById('messageCount');
  const toggleToken = document.getElementById('toggleToken');
  const tokenIcon = document.getElementById('tokenIcon');
  const skipKeywordsInput = document.getElementById('skipKeywords');
  const resetKeywordsBtn = document.getElementById('resetKeywords');
  const keywordsSection = document.getElementById('keywordsSection');
  const splitThresholdInput = document.getElementById('splitThreshold');
  const firstChunkWordLimitInput = document.getElementById('firstChunkWordLimit');
  const autoSubmitVoiceToggle = document.getElementById('autoSubmitVoiceToggle');
  const voiceAutoRestartToggle = document.getElementById('voiceAutoRestartToggle');
  const voiceRestartDelayInput = document.getElementById('voiceRestartDelay');

  const DEFAULT_SKIP_KEYWORDS = ['short', 'shorter', 'shrt', 'shrtr', 'shrter'];
  const DEFAULT_SPLIT_THRESHOLD = 250;
  const DEFAULT_FIRST_CHUNK_WORD_LIMIT = 42;
  const DEFAULT_VOICE_RESTART_DELAY = 3;
  const TAB_URLS = ['https://grok.com/*', 'https://x.com/i/grok*', 'https://claude.ai/*'];

  // Load saved settings
  const settings = await chrome.storage.sync.get([
    'botToken',
    'chatId',
    'messageCount',
    'extensionEnabled',
    'autoSendSkipKeywords',
    'splitThreshold',
    'firstChunkWordLimit',
    'autoSubmitVoice',
    'voiceAutoRestart',
    'voiceRestartDelay'
  ]);

  if (settings.botToken) botTokenInput.value = settings.botToken;
  if (settings.chatId) chatIdInput.value = settings.chatId;
  enabledToggle.checked = settings.extensionEnabled !== false; // Default true
  splitThresholdInput.value = settings.splitThreshold || DEFAULT_SPLIT_THRESHOLD;
  firstChunkWordLimitInput.value = settings.firstChunkWordLimit || DEFAULT_FIRST_CHUNK_WORD_LIMIT;
  autoSubmitVoiceToggle.checked = settings.autoSubmitVoice === true; // Default false
  voiceAutoRestartToggle.checked = settings.voiceAutoRestart === true; // Default false
  voiceRestartDelayInput.value = settings.voiceRestartDelay || DEFAULT_VOICE_RESTART_DELAY;
  messageCount.textContent = settings.messageCount || 0;

  // Load skip keywords
  const keywords = settings.autoSendSkipKeywords || DEFAULT_SKIP_KEYWORDS;
  skipKeywordsInput.value = keywords.join(', ');

  updateStatus(settings.botToken && settings.chatId, settings.extensionEnabled !== false);

  // Toggle token visibility
  toggleToken.addEventListener('click', () => {
    if (botTokenInput.type === 'password') {
      botTokenInput.type = 'text';
      tokenIcon.textContent = 'Hide';
    } else {
      botTokenInput.type = 'password';
      tokenIcon.textContent = 'Show';
    }
  });

  // Save settings
  saveBtn.addEventListener('click', async () => {
    const botToken = botTokenInput.value.trim();
    const chatId = chatIdInput.value.trim();

    if (!botToken || !chatId) {
      showMessage('Please fill in both Bot Token and Chat ID', 'error');
      return;
    }

    await chrome.storage.sync.set({ botToken, chatId });
    updateStatus(true);
    showMessage('Settings saved successfully!', 'success');
  });

  // Test connection
  testBtn.addEventListener('click', async () => {
    const botToken = botTokenInput.value.trim();
    const chatId = chatIdInput.value.trim();

    if (!botToken || !chatId) {
      showMessage('Please fill in both Bot Token and Chat ID', 'error');
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_CONNECTION',
        botToken,
        chatId
      });

      if (response.success) {
        showMessage('Connection successful! Test message sent.', 'success');
      } else {
        showMessage(`Error: ${response.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Error: ${error.message}`, 'error');
    }

    testBtn.disabled = false;
    testBtn.textContent = 'Test Connection';
  });

  function updateStatus(configured, enabled = true) {
    if (!enabled) {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Disabled';
    } else if (configured) {
      statusDot.classList.add('connected');
      statusText.textContent = 'Active';
    } else {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Not configured';
    }
  }

  function showMessage(text, type) {
    messageDiv.textContent = text;
    messageDiv.className = `message ${type}`;
    setTimeout(() => {
      messageDiv.className = 'message';
    }, 4000);
  }

  // Extension enabled toggle change
  enabledToggle.addEventListener('change', async () => {
    const extensionEnabled = enabledToggle.checked;
    await chrome.storage.sync.set({ extensionEnabled });

    updateStatus(botTokenInput.value && chatIdInput.value, extensionEnabled);

    // Notify content scripts
    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTENSION_ENABLED_CHANGED', extensionEnabled });
      });
    });
  });

  // Auto-submit voice toggle change
  autoSubmitVoiceToggle.addEventListener('change', async () => {
    const autoSubmitVoice = autoSubmitVoiceToggle.checked;
    await chrome.storage.sync.set({ autoSubmitVoice });

    // Notify content scripts
    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'AUTO_SUBMIT_VOICE_CHANGED', autoSubmitVoice });
      });
    });
  });

  // Voice auto-restart toggle change
  voiceAutoRestartToggle.addEventListener('change', async () => {
    const voiceAutoRestart = voiceAutoRestartToggle.checked;
    await chrome.storage.sync.set({ voiceAutoRestart });

    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'VOICE_AUTO_RESTART_CHANGED', voiceAutoRestart });
      });
    });
  });

  // Voice restart delay: save on change
  let restartDelaySaveTimeout = null;
  voiceRestartDelayInput.addEventListener('input', () => {
    clearTimeout(restartDelaySaveTimeout);
    restartDelaySaveTimeout = setTimeout(saveVoiceRestartDelay, 600);
  });
  voiceRestartDelayInput.addEventListener('blur', saveVoiceRestartDelay);

  async function saveVoiceRestartDelay() {
    clearTimeout(restartDelaySaveTimeout);
    const val = parseInt(voiceRestartDelayInput.value, 10);
    const voiceRestartDelay = (val && val >= 1) ? val : DEFAULT_VOICE_RESTART_DELAY;
    voiceRestartDelayInput.value = voiceRestartDelay;
    await chrome.storage.sync.set({ voiceRestartDelay });

    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'VOICE_RESTART_DELAY_CHANGED', voiceRestartDelay });
      });
    });
  }

  // Keywords: save on blur (when user finishes editing)
  let keywordsSaveTimeout = null;
  skipKeywordsInput.addEventListener('input', () => {
    clearTimeout(keywordsSaveTimeout);
    keywordsSaveTimeout = setTimeout(saveKeywords, 800);
  });
  skipKeywordsInput.addEventListener('blur', saveKeywords);

  async function saveKeywords() {
    clearTimeout(keywordsSaveTimeout);
    const raw = skipKeywordsInput.value;
    const keywords = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
    await chrome.storage.sync.set({ autoSendSkipKeywords: keywords });

    // Notify content scripts
    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'SKIP_KEYWORDS_CHANGED', keywords });
      });
    });
  }

  // Reset keywords to defaults
  resetKeywordsBtn.addEventListener('click', async () => {
    skipKeywordsInput.value = DEFAULT_SKIP_KEYWORDS.join(', ');
    await saveKeywords();
    showMessage('Keywords reset to defaults', 'success');
  });

  // Split threshold: save on change
  let thresholdSaveTimeout = null;
  splitThresholdInput.addEventListener('input', () => {
    clearTimeout(thresholdSaveTimeout);
    thresholdSaveTimeout = setTimeout(saveSplitThreshold, 600);
  });
  splitThresholdInput.addEventListener('blur', saveSplitThreshold);

  async function saveSplitThreshold() {
    clearTimeout(thresholdSaveTimeout);
    const val = parseInt(splitThresholdInput.value, 10);
    const splitThreshold = (val && val >= 50) ? val : DEFAULT_SPLIT_THRESHOLD;
    splitThresholdInput.value = splitThreshold;
    await chrome.storage.sync.set({ splitThreshold });

    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'SPLIT_THRESHOLD_CHANGED', splitThreshold });
      });
    });
  }

  // First chunk word limit: save on change
  let wordLimitSaveTimeout = null;
  firstChunkWordLimitInput.addEventListener('input', () => {
    clearTimeout(wordLimitSaveTimeout);
    wordLimitSaveTimeout = setTimeout(saveFirstChunkWordLimit, 600);
  });
  firstChunkWordLimitInput.addEventListener('blur', saveFirstChunkWordLimit);

  async function saveFirstChunkWordLimit() {
    clearTimeout(wordLimitSaveTimeout);
    const val = parseInt(firstChunkWordLimitInput.value, 10);
    const firstChunkWordLimit = (val && val >= 10) ? val : DEFAULT_FIRST_CHUNK_WORD_LIMIT;
    firstChunkWordLimitInput.value = firstChunkWordLimit;
    await chrome.storage.sync.set({ firstChunkWordLimit });

    chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'FIRST_CHUNK_WORD_LIMIT_CHANGED', firstChunkWordLimit });
      });
    });
  }

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.messageCount) {
      messageCount.textContent = changes.messageCount.newValue || 0;
    }
    if (changes.extensionEnabled !== undefined) {
      enabledToggle.checked = changes.extensionEnabled.newValue !== false;
      updateStatus(botTokenInput.value && chatIdInput.value, changes.extensionEnabled.newValue !== false);
    }
    if (changes.autoSendSkipKeywords !== undefined) {
      const kw = changes.autoSendSkipKeywords.newValue || DEFAULT_SKIP_KEYWORDS;
      skipKeywordsInput.value = kw.join(', ');
    }
    if (changes.splitThreshold !== undefined) {
      splitThresholdInput.value = changes.splitThreshold.newValue || DEFAULT_SPLIT_THRESHOLD;
    }
    if (changes.firstChunkWordLimit !== undefined) {
      firstChunkWordLimitInput.value = changes.firstChunkWordLimit.newValue || DEFAULT_FIRST_CHUNK_WORD_LIMIT;
    }
    if (changes.autoSubmitVoice !== undefined) {
      autoSubmitVoiceToggle.checked = changes.autoSubmitVoice.newValue === true;
    }
    if (changes.voiceAutoRestart !== undefined) {
      voiceAutoRestartToggle.checked = changes.voiceAutoRestart.newValue === true;
    }
    if (changes.voiceRestartDelay !== undefined) {
      voiceRestartDelayInput.value = changes.voiceRestartDelay.newValue || DEFAULT_VOICE_RESTART_DELAY;
    }
  });
});
