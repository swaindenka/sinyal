// SİNYAL sunucusu: statik dosyalar + WebSocket oyun odaları.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig, ROOT } from './config.js';
import { loadGameData } from './data.js';
import { createStore } from './store.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CODE_CHARS = 'ABCDEFGHJKLMNPRSTUVYZ';
const MAX_MESSAGE_BYTES = 2048;
const MSG_WINDOW_MS = 5000;
const MSG_WINDOW_MAX = 60;

const config = loadConfig();
const { dictionary, puzzles } = loadGameData(config);
const store = await createStore();
console.log(`[sinyal] sözlük: ${dictionary.ranks.size} kelime, bulmaca: ${puzzles.size}${config.devMode ? ' (geliştirme modu: 2 oyuncu yeterli)' : ''}`);

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
    dictionary,
    puzzles,
    store,
    send: (playerId, msg) => sendTo(code, playerId, msg),
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
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    let players = 0;
    for (const r of rooms.values()) players += r.connectedPlayers().length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.startsWith('/oda/')) rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Bulunamadı');
  }
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
  console.log(`[sinyal] http://localhost:${PORT} adresinde çalışıyor`);
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
