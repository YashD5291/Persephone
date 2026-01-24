document.addEventListener('DOMContentLoaded', async () => {
  const botTokenInput = document.getElementById('botToken');
  const chatIdInput = document.getElementById('chatId');
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
    'autoSendFirstChunk'
  ]);

  if (settings.botToken) botTokenInput.value = settings.botToken;
  if (settings.chatId) chatIdInput.value = settings.chatId;
  autoSendToggle.checked = settings.autoSendFirstChunk !== false; // Default true
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

  function updateStatus(configured) {
    if (configured) {
      statusDot.classList.add('connected');
      statusText.textContent = 'Configured';
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

  // Listen for message count updates
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.messageCount) {
      messageCount.textContent = changes.messageCount.newValue || 0;
    }
    if (changes.autoSendFirstChunk) {
      autoSendToggle.checked = changes.autoSendFirstChunk.newValue || false;
    }
  });
});
