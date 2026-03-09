/**
 * Inline HTML and script for the Chat webview (no separate HTTP server).
 */

export function getWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Chat</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; padding: 8px; }
    h3 { margin: 0 0 8px; font-size: 13px; }
    .field { margin-bottom: 8px; }
    .field label { display: block; margin-bottom: 2px; color: var(--vscode-foreground); opacity: 0.8; }
    .field input { width: 100%; padding: 6px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    .row { display: flex; gap: 8px; margin-top: 8px; }
    button { padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .status { font-size: 12px; margin-top: 6px; color: var(--vscode-foreground); opacity: 0.8; }
    .status.error { color: var(--vscode-errorForeground); }
    #message-list { height: 220px; overflow-y: auto; border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; margin: 8px 0; background: var(--vscode-input-background); }
    .message { margin-bottom: 6px; padding: 4px 6px; border-radius: 4px; font-size: 12px; }
    .message.user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-button-background); }
    .message.assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
    .message .role { font-weight: 600; font-size: 11px; opacity: 0.8; }
    .input-row { display: flex; gap: 8px; margin-top: 8px; }
    .input-row input { flex: 1; padding: 6px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  </style>
</head>
<body>
  <section id="config">
    <h3>Connection</h3>
    <div class="field">
      <label for="brokerUrl">Broker URL</label>
      <input id="brokerUrl" type="url" />
    </div>
    <div class="field">
      <label for="gatewayId">Gateway ID</label>
      <input id="gatewayId" type="text" />
      <button type="button" id="btn-generate" class="secondary">Generate ID + Key</button>
    </div>
    <div class="field">
      <label for="secretKey">Secret Key</label>
      <input id="secretKey" type="password" />
    </div>
    <div class="field">
      <label for="sessionKey">Session Key</label>
      <input id="sessionKey" type="text" />
    </div>
    <div class="row">
      <button type="button" id="btn-connect">Connect</button>
      <button type="button" id="btn-disconnect" class="secondary">Disconnect</button>
    </div>
    <p id="status" class="status"></p>
  </section>
  <section id="chat">
    <h3>Chat</h3>
    <div id="message-list"></div>
    <div class="input-row">
      <input id="message-input" type="text" placeholder="Type a message..." />
      <button type="button" id="btn-send">Send</button>
    </div>
  </section>
  <script>
    const vscode = acquireVsCodeApi();
    const statusEl = document.getElementById('status');
    const messageListEl = document.getElementById('message-list');
    const messageInputEl = document.getElementById('message-input');
    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.className = 'status' + (isError ? ' error' : '');
    }
    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }
    let messages = [];
    let streamText = null;
    function render() {
      let html = '';
      for (const m of messages) {
        html += '<div class="message ' + m.role + '"><span class="role">' + escapeHtml(m.role) + '</span><div>' + escapeHtml(m.text || '') + '</div></div>';
      }
      if (streamText) {
        html += '<div class="message assistant"><span class="role">assistant</span><div>' + escapeHtml(streamText) + '…</div></div>';
      }
      messageListEl.innerHTML = html || '<div class="message">No messages. Connect and send one.</div>';
      messageListEl.scrollTop = messageListEl.scrollHeight;
    }
    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'settings') {
        document.getElementById('brokerUrl').value = msg.brokerUrl || '';
        document.getElementById('gatewayId').value = msg.gatewayId || '';
        document.getElementById('secretKey').value = msg.secretKey || '';
        document.getElementById('sessionKey').value = msg.sessionKey || 'agent:default:main';
      } else if (msg.type === 'connected') {
        setStatus('Connected');
      } else if (msg.type === 'disconnected') {
        setStatus('Disconnected');
      } else if (msg.type === 'error') {
        setStatus(msg.message || 'Error', true);
      } else if (msg.type === 'history') {
        messages = (msg.messages || []).map(m => ({ role: m.role || 'user', text: m.text || '' }));
        render();
      } else if (msg.type === 'chatEvent') {
        const p = msg.payload || {};
        if (p.state === 'delta' && p.message) {
          const text = (p.message.content && p.message.content[0] && p.message.content[0].text) || p.message.text || '';
          if (text) streamText = (streamText || '') + text;
        } else if (p.state === 'final' || p.state === 'aborted') {
          const text = (p.message && (p.message.content && p.message.content[0] && p.message.content[0].text) || p.message.text) || streamText || '';
          if (text.trim()) messages.push({ role: 'assistant', text: text.trim() });
          streamText = null;
        } else if (p.state === 'error') {
          streamText = null;
          setStatus(p.errorMessage || 'Chat error', true);
        }
        render();
      }
    });
    document.getElementById('btn-generate').onclick = () => vscode.postMessage({ type: 'generate' });
    document.getElementById('btn-connect').onclick = () => {
      vscode.postMessage({
        type: 'connect',
        brokerUrl: document.getElementById('brokerUrl').value,
        gatewayId: document.getElementById('gatewayId').value,
        secretKey: document.getElementById('secretKey').value,
        sessionKey: document.getElementById('sessionKey').value || 'agent:default:main'
      });
    };
    document.getElementById('btn-disconnect').onclick = () => vscode.postMessage({ type: 'disconnect' });
    document.getElementById('btn-send').onclick = () => {
      const text = messageInputEl.value.trim();
      if (text) {
        vscode.postMessage({ type: 'sendMessage', text });
        messages.push({ role: 'user', text });
        messageInputEl.value = '';
        render();
      }
    };
    messageInputEl.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('btn-send').click(); };
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
