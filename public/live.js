// Conexão ao vivo compartilhada pelas páginas do jogador e do admin.
// Reconecta sozinha quando o celular volta do bloqueio de tela ou perde a rede.
function connectLive(onState, statusEl) {
  let es = null;
  let lastBeat = 0;

  function setStatus(on, text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('on', on);
  }

  function open() {
    if (es) es.close();
    es = new EventSource('/events');
    lastBeat = Date.now();
    es.onopen = () => setStatus(true, 'ao vivo');
    es.onerror = () => setStatus(false, 'reconectando…');
    es.onmessage = e => { lastBeat = Date.now(); onState(JSON.parse(e.data)); };
    es.addEventListener('ping', () => { lastBeat = Date.now(); });
  }

  // Sem notícias do servidor por 45 s (o ping vem a cada 20 s): conexão morta, reabre.
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastBeat > 45000) open();
  }, 5000);

  // Ao desbloquear o celular, reabre na hora se a conexão caiu durante o sono.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!es || es.readyState === EventSource.CLOSED || Date.now() - lastBeat > 25000) open();
  });

  open();
}

// Mantém a tela acesa durante o jogo, onde o navegador permite.
function keepScreenOn() {
  if (!('wakeLock' in navigator)) return;
  let lock = null;
  const request = async () => {
    try { lock = await navigator.wakeLock.request('screen'); } catch { /* sem permissão: ignora */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!lock || lock.released)) request();
  });
  request();
}
