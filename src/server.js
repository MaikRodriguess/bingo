// Servidor de Bingo em tempo real (sem dependências externas).
// Usa Server-Sent Events (SSE) para enviar cada número sorteado a todos os jogadores.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(3).toString('hex');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_NUMBER = 75;

// Arquivos públicos permitidos (lista fechada evita directory traversal)
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/live.js': ['live.js', 'text/javascript; charset=utf-8'],
};

const state = {
  round: 1,
  drawn: [],            // números sorteados, em ordem
  cards: new Map(),     // id -> { id, name, grid, round, wins:Set }
  winners: [],          // { name, type, number, at }
};
const clients = new Set();

// ---------- Cartela ----------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Cartela 5x5 estilo B-I-N-G-O: coluna B = 1-15, I = 16-30, ... centro livre (0)
function generateGrid() {
  const cols = [];
  for (let c = 0; c < 5; c++) {
    const pool = Array.from({ length: 15 }, (_, i) => c * 15 + i + 1);
    cols.push(shuffle(pool).slice(0, 5).sort((a, b) => a - b));
  }
  const grid = [];
  for (let r = 0; r < 5; r++) grid.push(cols.map(col => col[r]));
  grid[2][2] = 0;
  return grid;
}

function lines(grid) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    out.push(grid[i]);
    out.push(grid.map(row => row[i]));
  }
  out.push([0, 1, 2, 3, 4].map(i => grid[i][i]));
  out.push([0, 1, 2, 3, 4].map(i => grid[i][4 - i]));
  return out;
}

function cardStats(card, drawnSet) {
  const isMarked = n => n === 0 || drawnSet.has(n);
  const flat = card.grid.flat();
  const hits = flat.filter(n => n !== 0 && drawnSet.has(n)).length;
  const bestLineMissing = Math.min(...lines(card.grid).map(l => l.filter(n => !isMarked(n)).length));
  return { hits, bestLineMissing, full: flat.every(isMarked) };
}

function checkWinners(number) {
  const drawnSet = new Set(state.drawn);
  for (const card of state.cards.values()) {
    const s = cardStats(card, drawnSet);
    if (s.bestLineMissing === 0 && !card.wins.has('linha')) {
      card.wins.add('linha');
      state.winners.push({ ref: card.ref, name: card.name, type: 'linha', number, at: Date.now() });
    }
    if (s.full && !card.wins.has('cheia')) {
      card.wins.add('cheia');
      state.winners.push({ ref: card.ref, name: card.name, type: 'cartela cheia', number, at: Date.now() });
    }
  }
}

// ---------- Estado público / broadcast ----------
// Estado enxuto enviado a todos os celulares a cada sorteio (sem a lista de jogadores)
function publicState() {
  return {
    round: state.round,
    drawn: state.drawn,
    last: state.drawn[state.drawn.length - 1] ?? null,
    remaining: MAX_NUMBER - state.drawn.length,
    winners: state.winners.map(({ ref, name, type, number }) => ({ ref, name, type, number })),
    playerCount: state.cards.size,
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(payload);
}

// ---------- HTTP helpers ----------
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid json')); }
    });
  });
}

function isAdmin(req) {
  const given = String(req.headers['x-admin-password'] || '');
  const a = Buffer.from(given), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cardView(card) {
  return { id: card.id, ref: card.ref, name: card.name, grid: card.grid, round: card.round };
}

function cleanName(name) {
  return String(name || '').replace(/[<>]/g, '').trim().slice(0, 40);
}

function createCard(name) {
  const id = crypto.randomUUID();
  const card = { id, ref: id.slice(-8), name, grid: generateGrid(), round: state.round, wins: new Set() };
  state.cards.set(id, card);
  return card;
}

// Lista detalhada (só para o admin): link + progresso de cada cartela, mais perto de ganhar primeiro
function cardLinks() {
  const drawnSet = new Set(state.drawn);
  return [...state.cards.values()]
    .map(c => {
      const { hits, bestLineMissing } = cardStats(c, drawnSet);
      return { id: c.id, name: c.name, hits, bestLineMissing };
    })
    .sort((a, b) => a.bestLineMissing - b.bestLineMissing || b.hits - a.hits || a.name.localeCompare(b.name));
}

// ---------- Rotas ----------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'Content-Type': type });
    return fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
  }

  // Link individual da cartela: /cartela/<id> abre a página do jogador
  if (req.method === 'GET' && /^\/cartela\/[0-9a-f-]{36}$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
  }

  if (route === 'GET /events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // evita que proxies segurem os eventos
    });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    // ping visível ao navegador: o celular usa para perceber conexão morta e reconectar
    const ping = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 20_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (route === 'POST /api/join') {
    const { name } = await readBody(req);
    const clean = cleanName(name);
    if (!clean) return sendJson(res, 400, { error: 'Informe seu nome.' });
    const card = createCard(clean);
    checkWinners(state.drawn[state.drawn.length - 1] ?? null);
    broadcast();
    return sendJson(res, 201, cardView(card));
  }

  const cardMatch = url.pathname.match(/^\/api\/card\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && cardMatch) {
    const card = state.cards.get(cardMatch[1]);
    return card ? sendJson(res, 200, cardView(card)) : sendJson(res, 404, { error: 'Cartela não encontrada.' });
  }

  if (url.pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'Senha de administrador inválida.' });

    if (route === 'POST /api/admin/check') return sendJson(res, 200, { ok: true });

    // Lista de nomes -> uma cartela (e um link) para cada nome
    if (route === 'POST /api/admin/cards') {
      const { names } = await readBody(req);
      const list = (Array.isArray(names) ? names : []).map(cleanName).filter(Boolean).slice(0, 500);
      if (!list.length) return sendJson(res, 400, { error: 'Informe pelo menos um nome.' });
      list.forEach(createCard);
      checkWinners(state.drawn[state.drawn.length - 1] ?? null);
      broadcast();
      return sendJson(res, 201, { cards: cardLinks() });
    }

    if (route === 'POST /api/admin/cards/list') return sendJson(res, 200, { cards: cardLinks() });

    const delMatch = url.pathname.match(/^\/api\/admin\/cards\/([0-9a-f-]{36})\/delete$/);
    if (req.method === 'POST' && delMatch) {
      state.cards.delete(delMatch[1]);
      broadcast();
      return sendJson(res, 200, { cards: cardLinks() });
    }

    if (route === 'POST /api/admin/draw') {
      const drawnSet = new Set(state.drawn);
      const left = [];
      for (let n = 1; n <= MAX_NUMBER; n++) if (!drawnSet.has(n)) left.push(n);
      if (!left.length) return sendJson(res, 409, { error: 'Todos os números já foram sorteados.' });
      const number = left[crypto.randomInt(left.length)];
      state.drawn.push(number);
      checkWinners(number);
      broadcast();
      return sendJson(res, 200, { number });
    }

    if (route === 'POST /api/admin/reset') {
      const { keepPlayers = true } = await readBody(req);
      state.round += 1;
      state.drawn = [];
      state.winners = [];
      if (keepPlayers) {
        for (const card of state.cards.values()) {
          card.grid = generateGrid();
          card.round = state.round;
          card.wins = new Set();
        }
      } else {
        state.cards.clear();
      }
      broadcast();
      return sendJson(res, 200, { ok: true, round: state.round });
    }
  }

  sendJson(res, 404, { error: 'Não encontrado.' });
}

http.createServer((req, res) => {
  handle(req, res).catch(err => sendJson(res, 400, { error: err.message }));
}).listen(PORT, () => {
  console.log(`Bingo rodando em http://localhost:${PORT}`);
  console.log(`Painel do administrador: http://localhost:${PORT}/admin`);
  console.log(`Senha do administrador: ${ADMIN_PASSWORD}`);
});
