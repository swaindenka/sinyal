// Sunucuyu gerçek bir süreç olarak başlatıp HTTP ve WebSocket uçlarını dener.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let proc;
let base;

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sinyal-')), DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`sunucu açılmadı: ${out}`)), 10_000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://localhost:${m[1]}`);
      }
    });
    proc.stderr.on('data', (d) => (out += d));
  });
});

after(() => proc?.kill());

test('bozuk adres sunucuyu çökertmez', async () => {
  const bad = await fetch(`${base}/%E0%A4%A`);
  assert.equal(bad.status, 400);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test('statik dosyalar ETag ile sunulur, dizin dışına çıkılamaz', async () => {
  const res = await fetch(`${base}/app.js`);
  assert.equal(res.status, 200);
  const etag = res.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  const index = await fetch(`${base}/oda/ABCD`);
  assert.match(await index.text(), /SİNYAL/);
  const traversal = await fetch(`${base}/..%2fpackage.json`);
  assert.ok([403, 404].includes(traversal.status));
  assert.equal((await fetch(`${base}/yok.js`)).status, 404);
});

function client() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    wait(pred, ms = 3000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('mesaj gelmedi')), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
  };
}

test('WebSocket: oda kur, katıl, yeniden bağlan', async () => {
  const a = client();
  await a.ready;
  a.send({ type: 'create', name: 'Ayşe' });
  const welcome = await a.wait((m) => m.type === 'welcome');
  assert.match(welcome.code, /^[A-Z]{4}$/);
  const st = await a.wait((m) => m.type === 'state');
  assert.equal(st.phase, 'LOBBY');
  assert.equal(st.hostId, welcome.playerId);

  const b = client();
  await b.ready;
  b.send({ type: 'join', code: 'ZZZZ', name: 'Barış' });
  assert.equal((await b.wait((m) => m.type === 'error')).code, 'ROOM_NOT_FOUND');
  b.send({ type: 'join', code: welcome.code.toLowerCase(), name: 'Barış' });
  const wb = await b.wait((m) => m.type === 'welcome');
  const st2 = await a.wait((m) => m.type === 'state' && m.players.length === 2);
  assert.deepEqual(st2.players.map((p) => p.name), ['Ayşe', 'Barış']);

  // Barış'ın bağlantısı kopar, aynı tokenla döner: aynı oyuncu olarak kalır.
  b.ws.close();
  await a.wait((m) => m.type === 'state' && m.players.some((p) => p.name === 'Barış' && !p.connected));
  const b2 = client();
  await b2.ready;
  b2.send({ type: 'join', code: welcome.code, token: wb.token });
  const wb2 = await b2.wait((m) => m.type === 'welcome');
  assert.equal(wb2.playerId, wb.playerId);
  await a.wait((m) => m.type === 'state' && m.players.every((p) => p.connected));

  // Bozuk mesajlar bağlantıyı düşürmez.
  b2.ws.send('{bozuk json');
  b2.send({ type: 'play_signal', word: 12345 });
  assert.equal((await b2.wait((m) => m.type === 'error')).code, 'BAD_PHASE');

  // Oyun başlar: rolleri ve eli yalnızca kaptan alır, tahminci jetonla karar verir.
  a.send({ type: 'start' });
  const cap = await a.wait((m) => m.type === 'captain');
  assert.equal(cap.roles.filter((r) => r === 'target').length, 1);
  assert.equal(cap.hand.length, 6);
  const sig = await b2.wait((m) => m.type === 'state' && m.phase === 'SIGNAL');
  assert.equal(sig.round.captainId, welcome.playerId);
  assert.ok(sig.round.board.every((c) => c.role === null));
  a.send({ type: 'play_signal', word: cap.hand[0] });
  await b2.wait((m) => m.type === 'state' && m.phase === 'GUESS');
  b2.send({ type: 'token', target: cap.roles.indexOf('target') });
  const locked = await a.wait((m) => m.type === 'state' && m.round?.lock);
  assert.equal(locked.round.lock.target, cap.roles.indexOf('target'));
  const hit = await a.wait((m) => m.type === 'state' && m.phase === 'REVEAL', 6000);
  assert.equal(hit.run.score, 3);
  assert.equal(hit.round.result.kind, 'hit');
  a.ws.close();
  b2.ws.close();
});
