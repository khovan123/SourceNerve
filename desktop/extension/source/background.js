async function bridgeConfig() {
  const stored = await chrome.storage.local.get(['bridgeOrigin', 'bridgeToken']);
  return {
    origin: typeof stored.bridgeOrigin === 'string' ? stored.bridgeOrigin.replace(/\/$/, '') : '',
    token: typeof stored.bridgeToken === 'string' ? stored.bridgeToken : '',
  };
}

async function bridgeRequest(path, method = 'GET', body) {
  const { origin, token } = await bridgeConfig();
  if (!origin || !token) return { ok: false, error: 'bridge_not_configured' };
  const response = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return response.ok ? payload : { ok: false, error: payload.error || `http_${response.status}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const run = async () => {
    if (message.type === 'sourcenerve:presence') return bridgeRequest('/presence', 'POST', message.payload || {});
    if (message.type === 'sourcenerve:command-next') return bridgeRequest('/command/next', 'GET');
    if (message.type === 'sourcenerve:command-defer') return bridgeRequest('/command/defer', 'POST', message.payload || {});
    if (message.type === 'sourcenerve:command-receipt') return bridgeRequest('/command/receipt', 'POST', message.payload || {});
    return { ok: false, error: 'unknown_message' };
  };
  run().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
  return true;
});
