// SİNYAL sunucusu: statik dosyalar + WebSocket oyun odaları.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig, ROOT } from './config.js';
import { Deck } from './deck.js';
import { createStore } from './store.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CODE_CHARS = 'ABCDEFGHJKLMNPRSTUVYZ';
const MAX_MESSAGE_BYTES = 2048;
const MSG_WINDOW_MS = 5000;
const MSG_WINDOW_MAX = 100;
const MAX_ROOMS = 2000;

const config = loadConfig();
const deck = Deck.load();
const store = await createStore();
console.log(`[sinyal] deste: ${deck.size} tahta kelimesi, ${deck.cardPool.length + deck.nitelik.length} sinyal kartı`);

/** @type {Map<string, Room>} */
const rooms = new Map();
/** `${oda}:${oyuncu}` → WebSocket */
const sockets = new Map();

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sendTo(code, playerId, msg) {
  const ws = sockets.get(`${code}:${playerId}`);
  if (ws && ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function createRoom() {
  const code = newCode();
  const room = new Room({
    code,
    config,
    deck,
    store,
    send: (playerId, msg) => sendTo(code, playerId, msg),
    disconnectPlayer: (playerId) => {
      // Oda sahibi oyuncuyu çıkardı: soketi oyundan ayır.
      const key = `${code}:${playerId}`;
      const ws = sockets.get(key);
      sockets.delete(key);
      if (ws) {
        ws.ctx = null;
        setTimeout(() => ws.close(4001, 'kicked'), 50);
      }
    },
    onEmpty: () => rooms.delete(code),
  });
  rooms.set(code, room);
  return room;
}

function deleteRoom(room) {
  room.close();
  rooms.delete(room.code);
  for (const key of sockets.keys()) if (key.startsWith(`${room.code}:`)) sockets.delete(key);
}

// ───────────────────────── HTTP ─────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Statik dosyalar bellekte, içerik özetiyle (ETag) tutulur; yeni sürüm yayınlanınca tarayıcı hemen
 * yeniler. Dosya diskte değişirse (geliştirme sırasında) önbellek tazelenir.
 */
const fileCache = new Map();
async function loadStatic(file) {
  const { mtimeMs } = await stat(file);
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const body = await readFile(file);
  const entry = { body, mtimeMs, etag: `"${createHash('sha1').update(body).digest('base64url')}"` };
  fileCache.set(file, entry);
  return entry;
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    let players = 0;
    for (const r of rooms.values()) players += r.connectedPlayers().length;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'İzin verilmiyor');
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'Geçersiz adres');
    return;
  }
  if (rel === '/' || rel.startsWith('/oda/')) rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, 'Yasak');
    return;
  }
  let entry;
  try {
    entry = await loadStatic(file);
  } catch {
    sendText(res, 404, 'Bulunamadı');
    return;
  }
  const headers = {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    etag: entry.etag,
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : entry.body);
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error('[sinyal] HTTP hatası:', err);
    if (!res.headersSent) sendText(res, 500, 'Sunucu hatası');
    else res.end();
  });
});

// ───────────────────────── WebSocket ─────────────────────────

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

function sendRaw(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function handleJoin(ws, msg) {
  if (ws.ctx) {
    sendRaw(ws, { type: 'error', code: 'ALREADY_IN_ROOM' });
    return;
  }
  let room;
  const creating = msg.type === 'create';
  if (creating && rooms.size >= MAX_ROOMS) {
    sendRaw(ws, { type: 'error', code: 'SERVER_FULL', about: 'join' });
    return;
  }
  if (creating) room = createRoom();
  else {
    room = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!room || room.closed) {
      sendRaw(ws, { type: 'error', code: 'ROOM_NOT_FOUND', about: 'join' });
      return;
    }
  }
  let player;
  try {
    player = room.join({ name: msg.name, token: typeof msg.token === 'string' ? msg.token : undefined });
  } catch (err) {
    if (creating) deleteRoom(room);
    sendRaw(ws, { type: 'error', code: err.code || 'JOIN_FAILED', about: 'join' });
    return;
  }
  const key = `${room.code}:${player.id}`;
  const old = sockets.get(key);
  if (old && old !== ws) {
    old.ctx = null;
    sendRaw(old, { type: 'replaced' });
    old.close(4000, 'replaced');
  }
  sockets.set(key, ws);
  ws.ctx = { room, playerId: player.id, key };
  sendRaw(ws, { type: 'welcome', code: room.code, playerId: player.id, token: player.token });
  room.sendPrivate(player.id);
  room.changed();
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.window = { start: Date.now(), count: 0 };
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    const now = Date.now();
    if (now - ws.window.start > MSG_WINDOW_MS) ws.window = { start: now, count: 0 };
    if (++ws.window.count > MSG_WINDOW_MAX) {
      sendRaw(ws, { type: 'error', code: 'RATE_LIMITED' });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      sendRaw(ws, { type: 'pong', serverNow: Date.now() });
      return;
    }
    if (msg.type === 'create' || msg.type === 'join') {
      handleJoin(ws, msg);
      return;
    }
    if (!ws.ctx) {
      sendRaw(ws, { type: 'error', code: 'NOT_IN_ROOM' });
      return;
    }
    const { room, playerId, key } = ws.ctx;
    try {
      room.handle(playerId, msg);
    } catch (err) {
      console.error('[sinyal] mesaj işlenemedi:', err);
      sendRaw(ws, { type: 'error', code: 'SERVER_ERROR' });
    }
    if (msg.type === 'leave') {
      sockets.delete(key);
      ws.ctx = null;
    }
  });

  ws.on('close', () => {
    if (!ws.ctx) return;
    const { room, playerId, key } = ws.ctx;
    if (sockets.get(key) === ws) sockets.delete(key);
    ws.ctx = null;
    if (!room.closed) room.disconnect(playerId);
  });
});

// Ölü bağlantıları temizle (Render vb. boşta bağlantıları kapatmasın diye ping).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

// Kimsenin bağlı olmadığı odaları bir süre sonra kapat.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.connectedPlayers().length) {
      room.emptySince = null;
      continue;
    }
    room.emptySince ??= now;
    if (now - room.emptySince > config.emptyRoomSeconds * 1000) deleteRoom(room);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`[sinyal] http://localhost:${server.address().port} adresinde çalışıyor`);
});

async function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  try {
    await store.flush();
  } catch (err) {
    console.error('[sinyal] kapanışta kayıt hatası:', err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
