(function() {
  'use strict';
  const P = window.Persephone;

  const {
    SITE, MSG, state, log, sel, isContextValid, scanAllResponses, removeAllButtons, showToast
  } = P;

  // ============================================
  // AUTO-SEND
  // ============================================

  async function loadSettings() {
    if (!isContextValid()) return;

    try {
      const autoSendKey = SITE === 'claude' ? 'autoSendClaude' : 'autoSendGrok';
      const settings = await chrome.storage.sync.get(['extensionEnabled', autoSendKey, 'autoSendSkipKeywords', 'splitThreshold', 'autoSubmitVoice']);
      state.extensionEnabled = settings.extensionEnabled !== false; // Default true
      state.autoSendFirstChunk = settings[autoSendKey] !== false; // Default true
      state.autoSendSkipKeywords = settings.autoSendSkipKeywords || [...DEFAULT_SKIP_KEYWORDS];
      state.splitThreshold = settings.splitThreshold || 250;
      state.autoSubmitVoice = settings.autoSubmitVoice === true; // Default false

      // Check for per-tab override (persisted in background)
      try {
        const tabOverride = await chrome.runtime.sendMessage({ type: MSG.GET_TAB_AUTO_SEND });
        if (tabOverride?.hasOverride) {
          state.autoSendFirstChunk = tabOverride.autoSend;
          log.state(`🔌 Per-tab auto-send override: ${state.autoSendFirstChunk ? 'ON' : 'OFF'}`);
        }
      } catch (e) {
        // Background not ready yet, use per-site default
      }

      log.state(`🔌 Extension: ${state.extensionEnabled ? 'ON' : 'OFF'}, Auto-send: ${state.autoSendFirstChunk ? 'ON' : 'OFF'}, Skip keywords: ${state.autoSendSkipKeywords.length}`);
    } catch (e) {
      log.state.error('Failed to load settings');
    }
  }

  function toggleExtensionEnabled() {
    state.extensionEnabled = !state.extensionEnabled;

    // Save to storage
    if (isContextValid()) {
      chrome.storage.sync.set({ extensionEnabled: state.extensionEnabled });
    }

    // Show indicator and update UI
    showExtensionIndicator(state.extensionEnabled);

    if (state.extensionEnabled) {
      // Re-scan when enabled
      scanAllResponses();
    } else {
      // Remove all buttons when disabled
      removeAllButtons();
    }

    log.state(`🔌 Extension toggled: ${state.extensionEnabled ? 'ON' : 'OFF'}`);
  }

  function showExtensionIndicator(enabled) {
    const existing = document.querySelector('.persephone-extension-indicator');
    if (existing) existing.remove();

    const indicator = document.createElement('div');
    indicator.className = 'persephone-extension-indicator';
    indicator.innerHTML = enabled
      ? '✓ Persephone ON'
      : '✗ Persephone OFF';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${enabled ? '#22c55e' : '#666'};
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      font-weight: 500;
      z-index: 9999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: persephoneSlideIn 0.3s ease;
    `;

    document.body.appendChild(indicator);
    setTimeout(() => indicator.remove(), 2000);
  }

  function toggleAutoSend() {
    state.autoSendFirstChunk = !state.autoSendFirstChunk;

    // Persist per-tab override via background (survives refresh)
    if (isContextValid()) {
      chrome.runtime.sendMessage({ type: MSG.SAVE_OWN_AUTO_SEND, autoSend: state.autoSendFirstChunk }).catch(() => {});
    }

    showAutoSendIndicator(state.autoSendFirstChunk);
    updateWidgetStates();
    log.state(`⚡ Auto-send toggled (this tab): ${state.autoSendFirstChunk ? 'ON' : 'OFF'}`);
  }

  function showAutoSendIndicator(enabled) {
    // Remove existing indicator
    const existing = document.querySelector('.persephone-autosend-indicator');
    if (existing) existing.remove();

    const indicator = document.createElement('div');
    indicator.className = 'persephone-autosend-indicator';
    indicator.innerHTML = enabled
      ? '⚡ Auto-send ON'
      : '⚡ Auto-send OFF';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${enabled ? '#1a1a1a' : '#666'};
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      font-weight: 500;
      z-index: 9999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: persephoneSlideIn 0.3s ease;
    `;

    document.body.appendChild(indicator);
    setTimeout(() => indicator.remove(), 2000);
  }

  // ============================================
  // FLOATING SETTINGS WIDGET
  // ============================================

  /**
   * Update all widget toggle/input states to match current local variables.
   * Called when settings change externally (popup, keyboard shortcut, storage).
   */
  function updateWidgetStates() {
    const panel = document.querySelector('.persephone-settings-panel');
    if (!panel || panel.classList.contains('hidden')) return;

    const extToggle = panel.querySelector('[data-key="extensionEnabled"]');
    if (extToggle) extToggle.checked = state.extensionEnabled;

    const voiceToggle = panel.querySelector('[data-key="autoSubmitVoice"]');
    if (voiceToggle) voiceToggle.checked = state.autoSubmitVoice;

    const thresholdInput = panel.querySelector('[data-key="splitThreshold"]');
    if (thresholdInput && document.activeElement !== thresholdInput) {
      thresholdInput.value = state.splitThreshold;
    }
  }

  function injectSettingsWidget() {
    if (document.querySelector('.persephone-gear-btn')) return;

    // --- Gear button ---
    const gearBtn = document.createElement('button');
    gearBtn.className = 'persephone-gear-btn';
    gearBtn.title = 'Persephone Settings';
    gearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.611 3.611 0 0112 15.6z"/></svg>`;

    // --- Panel ---
    const panel = document.createElement('div');
    panel.className = 'persephone-settings-panel hidden';

    // Header
    const header = document.createElement('div');
    header.className = 'persephone-panel-header';
    const title = document.createElement('span');
    title.textContent = 'Persephone';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'persephone-panel-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Simple toggle rows (extension + voice)
    const simpleRows = [
      { label: 'Extension', key: 'extensionEnabled', get: () => state.extensionEnabled },
      { label: 'Voice auto-submit', key: 'autoSubmitVoice', get: () => state.autoSubmitVoice },
    ];

    simpleRows.forEach(({ label, key, get }) => {
      const row = document.createElement('div');
      row.className = 'persephone-panel-row';

      const labelEl = document.createElement('span');
      labelEl.className = 'persephone-panel-label';
      labelEl.textContent = label;

      const toggle = document.createElement('label');
      toggle.className = 'persephone-panel-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = get();
      checkbox.setAttribute('data-key', key);
      const track = document.createElement('span');
      track.className = 'persephone-toggle-track';
      toggle.appendChild(checkbox);
      toggle.appendChild(track);

      checkbox.addEventListener('change', () => {
        const val = checkbox.checked;
        if (key === 'extensionEnabled') {
          state.extensionEnabled = val;
          chrome.storage.sync.set({ extensionEnabled: val });
          showExtensionIndicator(val);
          if (val) { scanAllResponses(); } else { removeAllButtons(); }
        } else if (key === 'autoSubmitVoice') {
          state.autoSubmitVoice = val;
          chrome.storage.sync.set({ autoSubmitVoice: val });
        }
      });

      row.appendChild(labelEl);
      row.appendChild(toggle);
      panel.appendChild(row);
    });

    // Auto-send tab list section
    const tabSection = document.createElement('div');
    tabSection.className = 'persephone-panel-section';
    tabSection.textContent = 'Auto-send';
    panel.appendChild(tabSection);

    const tabListContainer = document.createElement('div');
    tabListContainer.className = 'persephone-tab-list';
    panel.appendChild(tabListContainer);

    // Split threshold row
    const thresholdRow = document.createElement('div');
    thresholdRow.className = 'persephone-panel-row';
    const thresholdLabel = document.createElement('span');
    thresholdLabel.className = 'persephone-panel-label';
    thresholdLabel.textContent = 'Split threshold';
    const thresholdInput = document.createElement('input');
    thresholdInput.type = 'number';
    thresholdInput.className = 'persephone-panel-input';
    thresholdInput.value = state.splitThreshold;
    thresholdInput.min = '50';
    thresholdInput.max = '2000';
    thresholdInput.setAttribute('data-key', 'splitThreshold');

    let thresholdDebounce = null;
    thresholdInput.addEventListener('input', () => {
      clearTimeout(thresholdDebounce);
      thresholdDebounce = setTimeout(() => {
        const val = parseInt(thresholdInput.value, 10);
        if (val && val >= 50) {
          state.splitThreshold = val;
          chrome.storage.sync.set({ splitThreshold: val });
          log.ui.debug(`📝 Split threshold updated: ${val}`);
        }
      }, 600);
    });

    thresholdRow.appendChild(thresholdLabel);
    thresholdRow.appendChild(thresholdInput);
    panel.appendChild(thresholdRow);

    // Fetch tab list from background and render into the container
    async function fetchAndRenderTabs() {
      tabListContainer.innerHTML = '<div class="persephone-tab-loading">Loading...</div>';
      try {
        const response = await chrome.runtime.sendMessage({ type: MSG.GET_TAB_LIST });
        if (!response?.tabs) {
          tabListContainer.innerHTML = '<div class="persephone-tab-loading">No tabs found</div>';
          return;
        }
        tabListContainer.innerHTML = '';
        response.tabs.forEach(tab => {
          const row = document.createElement('div');
          row.className = 'persephone-tab-row';

          const info = document.createElement('div');
          info.className = 'persephone-tab-info';

          const dot = document.createElement('span');
          dot.className = `persephone-tab-dot ${tab.reachable ? 'reachable' : 'stale'}`;
          dot.title = tab.reachable ? 'Tab connected' : 'Tab unreachable — reload to reconnect';

          const badge = document.createElement('span');
          badge.className = `persephone-tab-badge ${tab.site}`;
          badge.textContent = tab.site === 'claude' ? 'C' : 'G';

          const title = document.createElement('span');
          title.className = 'persephone-tab-title';
          // Clean up title — remove common suffixes
          let displayTitle = tab.title.replace(/ [-–—|].*$/, '').trim() || tab.site;
          if (displayTitle.length > 22) displayTitle = displayTitle.substring(0, 22) + '...';
          title.textContent = displayTitle;

          info.appendChild(dot);
          info.appendChild(badge);
          info.appendChild(title);

          if (tab.id === response.currentTabId) {
            const current = document.createElement('span');
            current.className = 'persephone-tab-current';
            current.textContent = '(here)';
            info.appendChild(current);
          }

          const toggle = document.createElement('label');
          toggle.className = 'persephone-panel-toggle';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = tab.autoSend;
          const track = document.createElement('span');
          track.className = 'persephone-toggle-track';
          toggle.appendChild(checkbox);
          toggle.appendChild(track);

          checkbox.addEventListener('change', () => {
            // Always persist via background (survives tab refresh)
            chrome.runtime.sendMessage({
              type: MSG.SET_TAB_AUTO_SEND,
              tabId: tab.id,
              autoSend: checkbox.checked
            });
            if (tab.id === response.currentTabId) {
              // Also update locally for immediate effect
              state.autoSendFirstChunk = checkbox.checked;
              showAutoSendIndicator(state.autoSendFirstChunk);
              updateWidgetStates();
            }
          });

          row.appendChild(info);
          row.appendChild(toggle);
          tabListContainer.appendChild(row);
        });
      } catch (e) {
        tabListContainer.innerHTML = '<div class="persephone-tab-loading">Error loading tabs</div>';
        log.ui.error('⚙️ Tab list error:', e.message);
      }
    }

    // --- Toggle panel on gear click ---
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = panel.classList.contains('hidden');
      if (isHidden) {
        panel.classList.remove('hidden');
        // Sync states after showing (updateWidgetStates bails if panel is hidden)
        updateWidgetStates();
        fetchAndRenderTabs();
      } else {
        panel.classList.add('hidden');
      }
    });

    // Prevent clicks inside panel from closing it
    panel.addEventListener('click', (e) => e.stopPropagation());

    // Click outside to close
    document.addEventListener('click', () => {
      if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
      }
    });

    document.body.appendChild(gearBtn);
    document.body.appendChild(panel);
    log.ui('⚙️ Settings widget injected');
  }

  // --- Exports ---
  Object.assign(P, {
    loadSettings, toggleExtensionEnabled, showExtensionIndicator, toggleAutoSend, 
    showAutoSendIndicator, updateWidgetStates, injectSettingsWidget
  });
})();
