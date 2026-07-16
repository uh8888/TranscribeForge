const api = (typeof browser !== 'undefined') ? browser : chrome;

const btn = document.getElementById('send');
const statusEl = document.getElementById('status');
const serverInput = document.getElementById('server');

(async () => {
  try {
    const data = await api.storage.local.get(['serverUrl']);
    if (data?.serverUrl) serverInput.value = data.serverUrl;
  } catch (_) {}
})();

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
}

btn.addEventListener('click', async () => {
  const serverUrl = serverInput.value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(serverUrl)) {
    setStatus('Ungültige Server-URL.', 'err');
    return;
  }
  api.storage.local.set({ serverUrl });

  btn.disabled = true;
  setStatus('Cookies werden gelesen…', 'info');

  try {
    const cookies = await api.cookies.getAll({ domain: '.youtube.com' });
    const ytCookies = await api.cookies.getAll({ domain: 'youtube.com' });
    const all = [...cookies, ...ytCookies];
    const seen = new Set();
    const unique = all.filter(c => {
      const k = c.name + '|' + c.domain;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (unique.length < 3) {
      setStatus('Keine YouTube-Cookies gefunden. Bist du eingeloggt?', 'err');
      btn.disabled = false;
      return;
    }

    const cookieString = unique.map(c => `${c.name}=${c.value}`).join('; ');

    setStatus(`Sende ${unique.length} Cookies an Server…`, 'info');

    const res = await fetch(serverUrl + '/api/youtube/save-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: cookieString }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      setStatus('Fehler: ' + (err.error || res.statusText), 'err');
      btn.disabled = false;
      return;
    }

    const data = await res.json();
    setStatus(`✅ ${data.count} Cookies gespeichert.`, 'ok');
  } catch (e) {
    setStatus('Fehler: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});
