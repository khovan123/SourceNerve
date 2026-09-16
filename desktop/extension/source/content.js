(() => {
  const EXTENSION_PROTOCOL_VERSION = 4;
  let epoch = 0;
  let lastUrl = location.href;
  let busyCommandId = '';

  function latestAssistant() {
    const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    return messages[messages.length - 1];
  }

  function latestTurnId() {
    const latest = latestAssistant();
    if (!(latest instanceof HTMLElement)) return '';
    const explicit = latest.getAttribute('data-turn-id') || latest.getAttribute('data-message-id') || '';
    const container = latest.closest('[data-turn-id-container], [data-turn-id]');
    return explicit || (container instanceof HTMLElement ? (container.getAttribute('data-turn-id') || '') : '');
  }

  function frontend() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      epoch += 1;
    }
    return { url: location.href, title: document.title, turnId: latestTurnId(), epoch, extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION };
  }

  function send(type, payload) {
    return chrome.runtime.sendMessage({ type, payload }).catch(() => undefined);
  }

  function presence() {
    send('sourcenerve:presence', frontend());
  }

  function composer() {
    return document.querySelector('#prompt-textarea') || document.querySelector('textarea[data-testid="prompt-textarea"]') || document.querySelector('textarea');
  }

  function assistantSnapshot() {
    const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const latest = latestAssistant();
    return {
      count: messages.length,
      text: latest instanceof HTMLElement ? latest.innerText : '',
      turnId: latestTurnId(),
      generating: Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"]')),
    };
  }

  async function receipt(commandId, stage, extra = {}) {
    return send('sourcenerve:command-receipt', { commandId, stage, frontend: frontend(), ...extra });
  }

  async function insertMessage(text) {
    const el = composer();
    if (!(el instanceof HTMLElement)) throw new Error('composer_unavailable');
    el.focus();
    if (el instanceof HTMLTextAreaElement) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
    document.execCommand('insertText', false, text);
    if (el instanceof HTMLTextAreaElement && !el.value) el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function clickSend() {
    const button = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label="Send prompt"]') || document.querySelector('button[aria-label^="Send"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  }

  function composerEmpty() {
    const el = composer();
    if (el instanceof HTMLTextAreaElement) return el.value.trim().length === 0;
    if (el instanceof HTMLElement) return (el.innerText || el.textContent || '').trim().length === 0;
    return false;
  }

  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function snapshotSignature(snapshot) {
    return `${snapshot.count}:${snapshot.turnId}:${snapshot.text.length}:${snapshot.text.slice(-80)}`;
  }

  async function waitForSettledConversation() {
    const deadline = Date.now() + 2500;
    let lastSignature = '';
    let stablePolls = 0;
    while (Date.now() < deadline) {
      const snapshot = assistantSnapshot();
      if (snapshot.generating) {
        lastSignature = '';
        stablePolls = 0;
        await delay(400);
        continue;
      }
      const signature = snapshotSignature(snapshot);
      if (signature === lastSignature) stablePolls += 1;
      else {
        lastSignature = signature;
        stablePolls = 1;
      }
      if (stablePolls >= 2) return;
      await delay(400);
    }
  }

  async function execute(command) {
    const commandId = command.commandId;
    busyCommandId = commandId;
    try {
      await waitForSettledConversation();
      const before = assistantSnapshot();
      await insertMessage(command.message || '');
      await receipt(commandId, 'inserted');
      const clickDeadline = Date.now() + 5000;
      let sent = false;
      while (Date.now() < clickDeadline) {
        if (clickSend()) {
          sent = true;
          break;
        }
        await delay(100);
      }
      if (!sent) throw new Error('chatgpt_message_not_submitted');
      await receipt(commandId, 'clicked');

      let accepted = false;
      let stableText = '';
      let stableCount = 0;
      let lastStreamedText = '';
      let observedGeneration = false;
      const hardDeadline = Date.now() + 30 * 60 * 1000;
      let idleDeadline = Date.now() + 10 * 60 * 1000;
      let lastActivitySignature = snapshotSignature(before);
      while (Date.now() < hardDeadline && Date.now() < idleDeadline) {
        const snapshot = assistantSnapshot();
        const activitySignature = snapshotSignature(snapshot);
        if (snapshot.generating) observedGeneration = true;
        if (snapshot.generating || activitySignature !== lastActivitySignature) {
          lastActivitySignature = activitySignature;
          idleDeadline = Date.now() + 10 * 60 * 1000;
        }
        const newAssistantTurn = snapshot.turnId ? snapshot.turnId !== before.turnId : snapshot.count > before.count;
        const changedAssistantText = snapshot.text.trim().length > 0 && snapshot.text !== before.text;
        // ChatGPT can reuse the latest assistant DOM node/turn id after tool-call
        // execution. Changed text or observed generation means this is the live
        // reply, even when the turn id/count did not advance.
        const responseCandidate = newAssistantTurn || changedAssistantText || (observedGeneration && snapshot.text.trim().length > 0);
        if (!accepted && (snapshot.generating || snapshot.count > before.count || composerEmpty())) {
          await receipt(commandId, 'accepted');
          accepted = true;
        }
        if (responseCandidate && snapshot.text.trim() && snapshot.text !== lastStreamedText) {
          lastStreamedText = snapshot.text;
          await receipt(commandId, 'streaming', { text: snapshot.text });
        }
        if (responseCandidate && !snapshot.generating && snapshot.text.trim()) {
          if (snapshot.text === stableText) stableCount += 1;
          else {
            stableText = snapshot.text;
            stableCount = 1;
          }
          if (stableCount >= 3) {
            // Return the first stable assistant reply to the native parser.
            // A wrong-format reply should fail fast instead of waiting for the
            // full command timeout.
            await receipt(commandId, 'stable', { text: stableText });
            return;
          }
        }
        await delay(400);
      }
      throw new Error(Date.now() >= hardDeadline ? 'stable_response_hard_timeout' : 'stable_response_idle_timeout');
    } catch (error) {
      await receipt(commandId, 'failed', { error: String(error && error.message || error) });
    } finally {
      busyCommandId = '';
    }
  }

  async function pollCommand() {
    if (busyCommandId) return;
    const response = await send('sourcenerve:command-next');
    if (response && response.ok && response.command) await execute(response.command);
  }

  const observer = new MutationObserver(() => presence());
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-turn-id', 'data-message-id'] });
  window.addEventListener('focus', presence, true);
  setInterval(presence, 5000);
  setInterval(pollCommand, 1000);
  presence();
})();
