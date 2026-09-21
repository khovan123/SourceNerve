(() => {
  const EXTENSION_PROTOCOL_VERSION = 6;
  const SOURCE_NERVE_APP_NAME = 'SourceNerve';
  const APP_MENTION_WAIT_MS = 10000;
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

  function normalizeUrl(value) {
    try {
      const url = new URL(value, location.origin);
      url.search = '';
      url.hash = '';
      return url.href.replace(/\/$/, '');
    } catch {
      return '';
    }
  }

  function isProjectUrl(value) {
    try {
      const url = new URL(value, location.origin);
      return url.origin === 'https://chatgpt.com' && !/^\/c\//.test(url.pathname) && /(?:project|g-p-)/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function projectStorageKey(projectName) {
    return `sourcenerve:project:${projectName}`;
  }

  function rememberedProjectUrl(projectName) {
    const value = sessionStorage.getItem(projectStorageKey(projectName)) || '';
    return isProjectUrl(value) ? normalizeUrl(value) : '';
  }

  function rememberProjectUrl(projectName, projectUrl) {
    if (isProjectUrl(projectUrl)) sessionStorage.setItem(projectStorageKey(projectName), normalizeUrl(projectUrl));
  }

  function exactText(element, value) {
    return element instanceof HTMLElement && (element.innerText || element.textContent || '').trim() === value;
  }

  function findExistingProject(projectName) {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links.find((link) => {
      const href = link instanceof HTMLAnchorElement ? link.href : '';
      return isProjectUrl(href) && exactText(link, projectName);
    });
  }

  function pageMatchesProject(projectName) {
    if (!isProjectUrl(location.href)) return false;
    return Array.from(document.querySelectorAll('h1,h2,[data-testid],a,button,span')).some((node) => exactText(node, projectName));
  }

  function pageFailureText() {
    return (document.querySelector('main')?.innerText || document.body?.innerText || '').slice(0, 12000);
  }

  function conversationUnavailable() {
    return /(?:unable to load|could not load|can't load|cannot load|not found|unavailable).{0,80}conversation|conversation.{0,80}(?:not found|unavailable|does not exist)/i.test(pageFailureText());
  }

  function projectUnavailable() {
    return /(?:unable to load|could not load|can't load|cannot load|not found|unavailable).{0,80}project|project.{0,80}(?:not found|unavailable|does not exist)/i.test(pageFailureText());
  }

  async function deferCommand(commandId, projectUrl, clearProject = false, clearConversation = false) {
    return send('sourcenerve:command-defer', {
      commandId,
      ...(projectUrl ? { projectUrl } : {}),
      ...(clearProject ? { clearProject: true } : {}),
      ...(clearConversation ? { clearConversation: true } : {}),
    });
  }

  async function navigateDeferred(commandId, target, projectUrl) {
    await deferCommand(commandId, projectUrl);
    location.assign(target);
    return false;
  }

  function attemptedConversationKey(commandId) {
    return `sourcenerve:attempted-conversation:${commandId}`;
  }

  function attemptedProjectKey(commandId) {
    return `sourcenerve:attempted-project:${commandId}`;
  }

  async function ensureSidebarOpen() {
    if (document.querySelector('[data-testid="sidebar-item-projects"]') || document.querySelector('button[aria-label="New project"]')) return;
    const opener = document.querySelector('[data-testid="open-sidebar-button"]')
      || document.querySelector('button[data-testid="open-sidebar-button"]')
      || document.querySelector('button[aria-label="Open sidebar"]');
    if (!(opener instanceof HTMLElement)) return;
    opener.click();
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (document.querySelector('[data-testid="sidebar-item-projects"]') || document.querySelector('button[aria-label="New project"]')) return;
      await delay(100);
    }
  }

  async function fillProjectName(input, value) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, '');
    else input.value = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    for (const character of value) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true }));
      document.execCommand('insertText', false, character);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: character }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true }));
    }
  }

  async function ensureCommandLocation(command) {
    const commandId = command.commandId;
    const projectName = String(command.projectName || '').trim();
    if (!projectName) throw new Error('project_name_missing');

    if (command.conversationUrl) {
      if (normalizeUrl(location.href) === normalizeUrl(command.conversationUrl)) {
        sessionStorage.removeItem(attemptedConversationKey(commandId));
        const fallbackProjectUrl = rememberedProjectUrl(projectName) || command.projectUrl || '';
        if (conversationUnavailable()) {
          await deferCommand(commandId, fallbackProjectUrl, false, true);
          location.assign(fallbackProjectUrl || 'https://chatgpt.com/');
          return false;
        }
        return fallbackProjectUrl;
      }
      const attemptedConversation = sessionStorage.getItem(attemptedConversationKey(commandId));
      if (attemptedConversation === normalizeUrl(command.conversationUrl)) {
        sessionStorage.removeItem(attemptedConversationKey(commandId));
        await deferCommand(commandId, undefined, false, true);
        return false;
      }
      sessionStorage.setItem(attemptedConversationKey(commandId), normalizeUrl(command.conversationUrl));
      return navigateDeferred(commandId, command.conversationUrl, command.projectUrl);
    }

    const boundProjectUrl = command.projectUrl || rememberedProjectUrl(projectName);
    if (boundProjectUrl) {
      if (normalizeUrl(location.href) === normalizeUrl(boundProjectUrl)) {
        sessionStorage.removeItem(attemptedProjectKey(commandId));
        if (projectUnavailable()) {
          sessionStorage.removeItem(projectStorageKey(projectName));
          await deferCommand(commandId, undefined, true);
          location.assign('https://chatgpt.com/');
          return false;
        }
        rememberProjectUrl(projectName, boundProjectUrl);
        return boundProjectUrl;
      }
      const attempted = sessionStorage.getItem(attemptedProjectKey(commandId));
      if (attempted === normalizeUrl(boundProjectUrl)) {
        sessionStorage.removeItem(attemptedProjectKey(commandId));
        sessionStorage.removeItem(projectStorageKey(projectName));
        await deferCommand(commandId, undefined, true);
        return false;
      }
      sessionStorage.setItem(attemptedProjectKey(commandId), normalizeUrl(boundProjectUrl));
      return navigateDeferred(commandId, boundProjectUrl, boundProjectUrl);
    }

    if (isProjectUrl(location.href) && pageMatchesProject(projectName)) {
      const projectUrl = normalizeUrl(location.href);
      rememberProjectUrl(projectName, projectUrl);
      await deferCommand(commandId, projectUrl);
      return false;
    }

    await ensureSidebarOpen();
    const existing = findExistingProject(projectName);
    if (existing instanceof HTMLAnchorElement) {
      const projectUrl = normalizeUrl(existing.href);
      rememberProjectUrl(projectName, projectUrl);
      return navigateDeferred(commandId, projectUrl, projectUrl);
    }

    if (normalizeUrl(location.href) !== 'https://chatgpt.com') {
      return navigateDeferred(commandId, 'https://chatgpt.com/', undefined);
    }

    const newProject = document.querySelector('[data-testid="sidebar-item-projects"] button[aria-label="New project"]')
      || document.querySelector('button[aria-label="New project"]');
    if (!(newProject instanceof HTMLButtonElement)) throw new Error('new_project_button_unavailable');
    newProject.click();

    const inputDeadline = Date.now() + 5000;
    let input = null;
    while (Date.now() < inputDeadline) {
      input = document.querySelector('#project-name') || document.querySelector('input[name="projectName"]');
      if (input instanceof HTMLInputElement) break;
      await delay(100);
    }
    if (!(input instanceof HTMLInputElement)) throw new Error('project_name_input_unavailable');
    await fillProjectName(input, projectName);

    const submitDeadline = Date.now() + 5000;
    let submit = null;
    while (Date.now() < submitDeadline) {
      submit = Array.from(document.querySelectorAll('button[type="submit"]')).find((button) => /create project/i.test((button.textContent || '').trim()));
      if (submit instanceof HTMLButtonElement && !submit.disabled) break;
      await delay(100);
    }
    if (!(submit instanceof HTMLButtonElement) || submit.disabled) throw new Error('create_project_button_disabled');
    await deferCommand(commandId);
    submit.click();
    return false;
  }

  function presence() {
    send('sourcenerve:presence', frontend());
  }

  function composer() {
    return document.querySelector('#prompt-textarea') || document.querySelector('textarea[data-testid="prompt-textarea"]') || document.querySelector('textarea');
  }

  function assistantSnapshot() {
    const allMessages = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const assistantMessages = allMessages.filter((message) => message.getAttribute('data-message-author-role') === 'assistant');
    const userMessages = allMessages.filter((message) => message.getAttribute('data-message-author-role') === 'user');
    const turnId = (message) => {
      if (!(message instanceof HTMLElement)) return '';
      const explicit = message.getAttribute('data-turn-id') || message.getAttribute('data-message-id') || '';
      const container = message.closest('[data-turn-id-container], [data-turn-id]');
      return explicit || (container instanceof HTMLElement ? (container.getAttribute('data-turn-id') || '') : '');
    };
    const assistantIds = assistantMessages.map(turnId);
    const userIds = userMessages.map(turnId);
    const latest = assistantMessages[assistantMessages.length - 1];
    const latestUser = userMessages[userMessages.length - 1];
    const latestAssistantIndex = latest ? allMessages.lastIndexOf(latest) : -1;
    const latestUserIndex = latestUser ? allMessages.lastIndexOf(latestUser) : -1;
    return {
      count: assistantMessages.length,
      text: latest instanceof HTMLElement ? latest.innerText : '',
      turnIds: assistantIds.filter(Boolean),
      turnId: assistantIds[assistantIds.length - 1] || '',
      userCount: userMessages.length,
      userTurnIds: userIds.filter(Boolean),
      latestUserTurnId: userIds[userIds.length - 1] || '',
      latestUserText: latestUser instanceof HTMLElement ? latestUser.innerText : '',
      assistantAfterLatestUser: latestAssistantIndex >= 0 && latestUserIndex >= 0 && latestAssistantIndex > latestUserIndex,
      generating: Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"]')),
    };
  }

  function submittedControlOwnershipMarkers(message, taskId) {
    const markers = [`TASK_ID: ${taskId}`];
    for (const name of ['STATE', 'ITERATION']) {
      const match = String(message || '').match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'mi'));
      if (match && match[1]) markers.push(`${name}: ${match[1].trim()}`);
    }
    return markers;
  }

  function snapshotOwnsSubmittedUserTurn(before, snapshot, message, taskId) {
    const newUserTurn = snapshot.userCount > before.userCount
      || Boolean(snapshot.latestUserTurnId && !before.userTurnIds.includes(snapshot.latestUserTurnId))
      || Boolean(snapshot.latestUserText && snapshot.latestUserText !== before.latestUserText);
    if (!newUserTurn) return false;
    return submittedControlOwnershipMarkers(message, taskId)
      .every((marker) => snapshot.latestUserText.includes(marker));
  }

  function ownedAssistantResponseCandidate(before, snapshot, accepted, acceptedOwnedUserTurn) {
    if (!accepted) return false;
    const newAssistantTurn = snapshot.turnId
      ? !before.turnIds.includes(snapshot.turnId)
      : snapshot.count > before.count;
    const changedAssistantText = snapshot.text.trim().length > 0 && snapshot.text !== before.text;
    if (acceptedOwnedUserTurn) {
      return snapshot.assistantAfterLatestUser && (newAssistantTurn || changedAssistantText);
    }
    return newAssistantTurn;
  }

  async function receipt(commandId, stage, extra = {}) {
    return send('sourcenerve:command-receipt', { commandId, stage, frontend: frontend(), ...extra });
  }

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function sourceNerveMentionOption() {
    const normalizeMentionLabel = (value) =>
      String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const sourceNerveName = normalizeMentionLabel(SOURCE_NERVE_APP_NAME);
    const sourceNerveLabel = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const values = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-value'),
        element.innerText,
        element.textContent,
      ].map(normalizeMentionLabel).filter(Boolean);
      return values.some((value) =>
        value === sourceNerveName
        || value === `@${sourceNerveName}`
        || value.startsWith(`${sourceNerveName} `)
        || value.startsWith(`@${sourceNerveName} `)
      );
    };
    const interactiveSelector = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      'button',
      'a',
      '[data-testid]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    const optionFromRoot = (root) => {
      if (!(root instanceof HTMLElement)) return null;
      const candidates = [
        ...(root.matches(interactiveSelector) ? [root] : []),
        ...Array.from(root.querySelectorAll(interactiveSelector)),
      ];
      const direct = candidates.find((element) => visible(element) && sourceNerveLabel(element));
      if (direct instanceof HTMLElement) return direct;

      const exactLabel = [root, ...Array.from(root.querySelectorAll('*'))]
        .find((element) => {
          if (!visible(element)) return false;
          const text = normalizeMentionLabel(element.innerText || element.textContent || '');
          return text === sourceNerveName || text === `@${sourceNerveName}`;
        });
      const row = exactLabel instanceof HTMLElement ? exactLabel.closest(interactiveSelector) : null;
      if (row instanceof HTMLElement && visible(row) && root.contains(row)) return row;
      return exactLabel instanceof HTMLElement && visible(exactLabel) ? exactLabel : null;
    };

    const overlays = Array.from(document.querySelectorAll(
      '[role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-radix-menu-content], [data-radix-select-content], [data-testid*="mention"], [data-testid*="popover"], [data-testid*="menu"], [data-testid*="app"]'
    )).filter(visible);
    for (const overlay of overlays) {
      const candidate = optionFromRoot(overlay);
      if (candidate) return candidate;
    }

    const globalCandidate = Array.from(document.querySelectorAll(
      '[role="option"], [role="menuitem"], [role="menuitemradio"]'
    )).find((element) => visible(element) && sourceNerveLabel(element));
    return globalCandidate instanceof HTMLElement ? globalCandidate : null;
  }
  async function bindSourceNerveMention(el) {
    const mentionText = `@${SOURCE_NERVE_APP_NAME}`;
    for (const char of mentionText) {
      document.execCommand('insertText', false, char);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
      await delay(char === '@' ? 120 : 25);
    }
    const deadline = Date.now() + APP_MENTION_WAIT_MS;
    while (Date.now() < deadline) {
      const option = sourceNerveMentionOption();
      if (option) {
        option.click();
        return true;
      }
      await delay(100);
    }
    if (el instanceof HTMLTextAreaElement) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
    return false;
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
    const appMentionBound = await bindSourceNerveMention(el);
    const payload = `${appMentionBound ? "\n" : ""}${text}`;
    document.execCommand('insertText', false, payload);
    if (el instanceof HTMLTextAreaElement && !el.value) el.value = payload;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload }));
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
    return [
      snapshot.count,
      snapshot.turnId,
      snapshot.userCount,
      snapshot.latestUserTurnId,
      snapshot.text.length,
      snapshot.text.slice(-80),
    ].join(':');
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
      const projectRoute = await ensureCommandLocation(command);
      if (projectRoute === false) return;
      const projectUrl = typeof projectRoute === 'string' ? projectRoute : '';
      if (projectUrl) rememberProjectUrl(command.projectName, projectUrl);
      await waitForSettledConversation();
      const before = assistantSnapshot();
      await insertMessage(command.message || '');
      await receipt(commandId, 'inserted', projectUrl ? { projectUrl } : {});
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
      await receipt(commandId, 'clicked', projectUrl ? { projectUrl } : {});

      let accepted = false;
      let acceptedOwnedUserTurn = false;
      let stableText = '';
      let stableCount = 0;
      let lastStreamedText = '';
      const hardDeadline = Date.now() + 30 * 60 * 1000;
      let idleDeadline = Date.now() + 10 * 60 * 1000;
      let lastActivitySignature = snapshotSignature(before);
      while (Date.now() < hardDeadline && Date.now() < idleDeadline) {
        const snapshot = assistantSnapshot();
        const activitySignature = snapshotSignature(snapshot);
        if (snapshot.generating || activitySignature !== lastActivitySignature) {
          lastActivitySignature = activitySignature;
          idleDeadline = Date.now() + 10 * 60 * 1000;
        }
        const ownsSubmittedUserTurn = snapshotOwnsSubmittedUserTurn(
          before,
          snapshot,
          command.message || '',
          command.taskId || '',
        );
        if (ownsSubmittedUserTurn) acceptedOwnedUserTurn = true;
        if (!accepted && (ownsSubmittedUserTurn || snapshot.generating || snapshot.count > before.count || snapshot.userCount > before.userCount || composerEmpty())) {
          await receipt(commandId, 'accepted', projectUrl ? { projectUrl } : {});
          accepted = true;
        }
        const responseCandidate = ownedAssistantResponseCandidate(
          before,
          snapshot,
          accepted,
          acceptedOwnedUserTurn,
        );
        if (responseCandidate && snapshot.text.trim() && snapshot.text !== lastStreamedText) {
          lastStreamedText = snapshot.text;
          await receipt(commandId, 'streaming', { text: snapshot.text, ...(projectUrl ? { projectUrl } : {}) });
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
            await receipt(commandId, 'stable', { text: stableText, ...(projectUrl ? { projectUrl } : {}) });
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
