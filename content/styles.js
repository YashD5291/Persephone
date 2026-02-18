(function() {
  'use strict';
  const P = window.Persephone;

  // ============================================
  // STYLES
  // ============================================

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* Button Group */
      .persephone-btn-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: 6px;
        vertical-align: middle;
      }

      /* Sent Indicator */
      .persephone-sent-indicator {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
        border-radius: 50%;
      }
      .persephone-sent-indicator svg {
        width: 10px;
        height: 10px;
        fill: white;
      }

      /* Base Button Styles (Send Button) */
      .persephone-inline-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: #fff;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        margin-left: 6px;
        vertical-align: middle;
        opacity: 0.85;
        transition: all 0.15s ease;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
      }
      .persephone-inline-btn:hover {
        opacity: 1;
        transform: scale(1.1);
        box-shadow: 0 2px 8px rgba(255, 255, 255, 0.3);
      }
      .persephone-inline-btn svg {
        width: 12px;
        height: 12px;
        fill: #1a1a1a;
      }

      /* In button group - smaller margins */
      .persephone-btn-group .persephone-inline-btn {
        margin-left: 0;
        width: 20px;
        height: 20px;
      }
      .persephone-btn-group .persephone-inline-btn svg {
        width: 11px;
        height: 11px;
      }

      /* Resend Button */
      .persephone-resend-btn {
        background: #fff;
      }
      .persephone-resend-btn svg {
        fill: #1a1a1a;
      }

      /* Edit Button */
      .persephone-edit-btn {
        background: #525252;
      }
      .persephone-edit-btn svg {
        fill: #fff;
      }

      /* Delete Button */
      .persephone-delete-btn {
        background: #dc2626;
      }
      .persephone-delete-btn svg {
        fill: #fff;
      }

      /* Split Send Button */
      .persephone-split-btn {
        position: relative;
      }
      .persephone-chunk-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        background: #1a1a1a;
        color: #fff;
        font-size: 8px;
        font-weight: 700;
        font-family: system-ui, sans-serif;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        pointer-events: none;
      }

      /* Live Streaming Indicator */
      .persephone-streaming {
        background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%) !important;
        animation: persephonePulse 1s ease-in-out infinite;
      }
      @keyframes persephonePulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
      }

      /* Floating Mic Button */
      .persephone-mic-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: none;
        background: #525252;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        z-index: 9999998;
        transition: background 0.2s, transform 0.15s;
      }
      .persephone-mic-btn:hover {
        background: #3f3f3f;
        transform: scale(1.08);
      }
      .persephone-mic-btn:active {
        transform: scale(0.95);
      }
      .persephone-mic-btn svg {
        width: 22px;
        height: 22px;
      }
      .persephone-mic-btn.recording {
        background: #dc2626;
        animation: persephoneMicPulse 1s ease-in-out infinite;
      }
      @keyframes persephoneMicPulse {
        0%, 100% { box-shadow: 0 4px 14px rgba(220, 38, 38, 0.4); transform: scale(1); }
        50% { box-shadow: 0 4px 24px rgba(220, 38, 38, 0.7); transform: scale(1.06); }
      }

      /* Floating Camera Button */
      .persephone-camera-btn {
        position: fixed;
        bottom: 128px;
        right: 30px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: none;
        background: #525252;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        z-index: 9999998;
        transition: background 0.2s, transform 0.15s;
      }
      .persephone-camera-btn:hover {
        background: #3f3f3f;
        transform: scale(1.08);
      }
      .persephone-camera-btn:active {
        transform: scale(0.95);
      }
      .persephone-camera-btn svg {
        width: 18px;
        height: 18px;
      }
      .persephone-camera-btn.stream-active::after {
        content: '';
        position: absolute;
        top: -1px;
        right: -1px;
        width: 10px;
        height: 10px;
        background: #22c55e;
        border-radius: 50%;
        border: 2px solid #525252;
        pointer-events: none;
      }
      .persephone-camera-btn.capturing {
        animation: persephoneCaptureFlash 0.3s ease;
      }
      @keyframes persephoneCaptureFlash {
        0% { transform: scale(1); }
        50% { transform: scale(1.2); }
        100% { transform: scale(1); }
      }

      /* Toast */
      .persephone-toast {
        position: fixed;
        top: 20px;
        right: 20px;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: system-ui, sans-serif;
        font-size: 14px;
        font-weight: 600;
        z-index: 9999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: persephoneSlideIn 0.3s ease;
      }
      .persephone-toast-success {
        background: rgba(74, 158, 108, 0.92);
      }
      .persephone-toast-error {
        background: rgba(190, 80, 70, 0.92);
      }

      @keyframes persephoneSlideIn {
        from { opacity: 0; transform: translateY(-20px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* Modal */
      .persephone-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999999;
        animation: persephoneFadeIn 0.2s ease;
      }

      @keyframes persephoneFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .persephone-modal {
        background: #fff;
        border-radius: 12px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        border: 1px solid #e5e5e5;
        animation: persephoneSlideUp 0.3s ease;
      }

      @keyframes persephoneSlideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .persephone-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid #eee;
        font-family: system-ui, sans-serif;
        font-weight: 600;
        font-size: 16px;
        color: #1a1a1a;
      }

      .persephone-modal-close {
        background: none;
        border: none;
        color: #999;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        transition: color 0.2s;
      }
      .persephone-modal-close:hover {
        color: #1a1a1a;
      }

      .persephone-modal-body {
        padding: 20px;
        flex: 1;
        overflow: auto;
      }

      .persephone-edit-textarea {
        width: 100%;
        min-height: 200px;
        padding: 12px;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fafafa;
        color: #1a1a1a;
        font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
        font-size: 14px;
        line-height: 1.5;
        resize: vertical;
        box-sizing: border-box;
      }
      .persephone-edit-textarea:focus {
        outline: none;
        border-color: #1a1a1a;
        box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.06);
      }

      .persephone-modal-hint {
        margin-top: 8px;
        font-family: system-ui, sans-serif;
        font-size: 12px;
        color: #888;
      }

      .persephone-modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 16px 20px;
        border-top: 1px solid #eee;
      }

      .persephone-modal-btn {
        padding: 10px 20px;
        border-radius: 6px;
        border: none;
        font-family: system-ui, sans-serif;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
      }

      .persephone-modal-cancel {
        background: #fff;
        color: #666;
        border: 1px solid #e0e0e0;
      }
      .persephone-modal-cancel:hover {
        background: #f5f5f5;
        color: #1a1a1a;
      }

      .persephone-modal-save {
        background: #1a1a1a;
        color: white;
      }
      .persephone-modal-save:hover {
        background: #333;
      }
      .persephone-modal-save:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Floating Gear Button */
      .persephone-gear-btn {
        position: fixed;
        bottom: 80px;
        right: 28px;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: #525252;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        z-index: 9999998;
        transition: background 0.2s, transform 0.15s;
      }
      .persephone-gear-btn:hover {
        background: #3f3f3f;
        transform: scale(1.08);
      }
      .persephone-gear-btn:active {
        transform: scale(0.95);
      }
      .persephone-gear-btn svg {
        width: 20px;
        height: 20px;
      }

      /* Settings Panel */
      .persephone-settings-panel {
        position: fixed;
        bottom: 176px;
        right: 24px;
        width: 280px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
        z-index: 9999998;
        font-family: system-ui, -apple-system, sans-serif;
        animation: persephonePanelIn 0.2s ease;
        overflow: hidden;
      }
      .persephone-settings-panel.hidden {
        display: none;
      }
      @keyframes persephonePanelIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* Panel Header */
      .persephone-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid #eee;
        font-weight: 600;
        font-size: 14px;
        color: #1a1a1a;
      }
      .persephone-panel-close {
        background: none;
        border: none;
        color: #999;
        font-size: 18px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        transition: color 0.2s;
      }
      .persephone-panel-close:hover {
        color: #1a1a1a;
      }

      /* Panel Rows */
      .persephone-panel-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        border-bottom: 1px solid #f0f0f0;
      }
      .persephone-panel-row:last-child {
        border-bottom: none;
      }
      .persephone-panel-label {
        font-size: 13px;
        color: #1a1a1a;
        user-select: none;
      }

      /* Toggle Switch */
      .persephone-panel-toggle {
        position: relative;
        width: 36px;
        height: 20px;
        flex-shrink: 0;
      }
      .persephone-panel-toggle input {
        opacity: 0;
        width: 0;
        height: 0;
        position: absolute;
      }
      .persephone-panel-toggle .persephone-toggle-track {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: #ccc;
        border-radius: 10px;
        cursor: pointer;
        transition: background 0.2s;
      }
      .persephone-panel-toggle .persephone-toggle-track::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        background: #fff;
        border-radius: 50%;
        transition: transform 0.2s;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      }
      .persephone-panel-toggle input:checked + .persephone-toggle-track {
        background: #1a1a1a;
      }
      .persephone-panel-toggle input:checked + .persephone-toggle-track::after {
        transform: translateX(16px);
      }

      /* Tab List Section */
      .persephone-panel-section {
        padding: 8px 16px 4px;
        font-size: 11px;
        font-weight: 600;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid #f0f0f0;
      }
      .persephone-tab-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 7px 16px;
        border-bottom: 1px solid #f0f0f0;
      }
      .persephone-tab-row:last-child {
        border-bottom: none;
      }
      .persephone-tab-info {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }
      .persephone-tab-badge {
        flex-shrink: 0;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
      }
      .persephone-tab-badge.claude { background: #d97706; }
      .persephone-tab-badge.grok { background: #1a1a1a; }
      .persephone-tab-title {
        font-size: 12px;
        color: #1a1a1a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .persephone-tab-current {
        font-size: 10px;
        color: #22c55e;
        font-weight: 600;
        flex-shrink: 0;
        margin-left: 2px;
      }
      .persephone-tab-loading {
        padding: 10px 16px;
        font-size: 12px;
        color: #999;
        text-align: center;
      }

      /* Number Input */
      .persephone-panel-input {
        width: 60px;
        padding: 4px 8px;
        border: 1px solid #ddd;
        border-radius: 6px;
        font-size: 13px;
        font-family: system-ui, sans-serif;
        color: #1a1a1a;
        text-align: center;
        background: #fafafa;
        flex-shrink: 0;
      }
      .persephone-panel-input:focus {
        outline: none;
        border-color: #1a1a1a;
      }
    `;
    document.head.appendChild(style);
  }

  // --- Exports ---
  Object.assign(P, { injectStyles });
})();
