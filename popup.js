document.addEventListener('DOMContentLoaded', async () => {
  const botTokenInput = document.getElementById('botToken');
  const chatIdInput = document.getElementById('chatId');
  const enabledToggle = document.getElementById('enabledToggle');
  const autoSendToggle = document.getElementById('autoSendToggle');
  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const messageDiv = document.getElementById('message');
  const messageCount = document.getElementById('messageCount');
  const toggleToken = document.getElementById('toggleToken');
  const tokenIcon = document.getElementById('tokenIcon');

  // Load saved settings
  const settings = await chrome.storage.sync.get([
    'botToken',
    'chatId',
    'messageCount',
    'extensionEnabled',
    'autoSendFirstChunk'
  ]);

  if (settings.botToken) botTokenInput.value = settings.botToken;
  if (settings.chatId) chatIdInput.value = settings.chatId;
  enabledToggle.checked = settings.extensionEnabled !== false; // Default true
  autoSendToggle.checked = settings.autoSendFirstChunk !== false; // Default true
  messageCount.textContent = settings.messageCount || 0;

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
    chrome.tabs.query({ url: ['https://grok.com/*', 'https://x.com/i/grok*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'EXTENSION_ENABLED_CHANGED', extensionEnabled });
      });
    });
  });

  // Auto-send toggle change
  autoSendToggle.addEventListener('change', async () => {
    const autoSendFirstChunk = autoSendToggle.checked;
    await chrome.storage.sync.set({ autoSendFirstChunk });

    // Notify content scripts
    chrome.tabs.query({ url: ['https://grok.com/*', 'https://x.com/i/grok*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'AUTO_SEND_CHANGED', autoSendFirstChunk });
      });
    });
  });

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.messageCount) {
      messageCount.textContent = changes.messageCount.newValue || 0;
    }
    if (changes.extensionEnabled !== undefined) {
      enabledToggle.checked = changes.extensionEnabled.newValue !== false;
      updateStatus(botTokenInput.value && chatIdInput.value, changes.extensionEnabled.newValue !== false);
    }
    if (changes.autoSendFirstChunk !== undefined) {
      autoSendToggle.checked = changes.autoSendFirstChunk.newValue !== false;
    }
  });
});
