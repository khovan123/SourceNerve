const origin = document.getElementById('origin');
const token = document.getElementById('token');
const status = document.getElementById('status');
chrome.storage.local.get(['bridgeOrigin', 'bridgeToken']).then((stored) => {
  origin.value = stored.bridgeOrigin || '';
  token.value = stored.bridgeToken || '';
});
document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ bridgeOrigin: origin.value.trim(), bridgeToken: token.value.trim() });
  status.textContent = 'Saved.';
});
document.getElementById('test').addEventListener('click', async () => {
  const base = origin.value.trim().replace(/\/$/, '');
  const secret = token.value.trim();
  if (!base || !secret) { status.textContent = 'Missing origin/token.'; return; }
  try {
    const response = await fetch(`${base}/health?token=${encodeURIComponent(secret)}`);
    status.textContent = response.ok ? 'Connected.' : `Failed: HTTP ${response.status}`;
  } catch (error) {
    status.textContent = `Failed: ${String(error && error.message || error)}`;
  }
});
