document.addEventListener('DOMContentLoaded', async () => {
  const botTokenInput = document.getElementById('botToken');
  const chatIdInput = document.getElementById('chatId');
  const enableToggle = document.getElementById('enableToggle');
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
    'enabled',
    'messageCount'
  ]);

  if (settings.botToken) botTokenInput.value = settings.botToken;
  if (settings.chatId) chatIdInput.value = settings.chatId;
  enableToggle.checked = settings.enabled || false;
  messageCount.textContent = settings.messageCount || 0;

  updateStatus(settings.botToken && settings.chatId);

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
    const enabled = enableToggle.checked;

    if (!botToken || !chatId) {
      showMessage('Please fill in both Bot Token and Chat ID', 'error');
      return;
    }

    await chrome.storage.sync.set({ botToken, chatId, enabled });
    updateStatus(true);
    showMessage('Settings saved successfully!', 'success');

    // Notify content scripts about the change
    chrome.tabs.query({ url: ['https://grok.com/*', 'https://x.com/i/grok*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', enabled });
      });
    });
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

  // Enable toggle change
  enableToggle.addEventListener('change', async () => {
    const enabled = enableToggle.checked;
    await chrome.storage.sync.set({ enabled });

    // Notify content scripts
    chrome.tabs.query({ url: ['https://grok.com/*', 'https://x.com/i/grok*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', enabled });
      });
    });
  });

  function updateStatus(configured) {
    if (configured) {
      statusDot.classList.add('connected');
      statusText.textContent = enableToggle.checked ? 'Active' : 'Configured (disabled)';
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

  // Listen for message count updates
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.messageCount) {
      messageCount.textContent = changes.messageCount.newValue || 0;
    }
  });
});
