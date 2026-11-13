import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom, testConfig } from './helpers.js';
import { Phase, PASS } from '../server/room.js';
import { TeamStore } from '../server/store.js';

// ───────────────────────── lobi ─────────────────────────

test('ilk gelen oda sahibi olur; ad kuralları', () => {
  const h = makeRoom({ players: 2 });
  assert.equal(h.room.hostId, h.ps[0].id);
  assert.throws(() => h.room.join({ name: 'oyuncu1' }), /NAME_TAKEN/);
  assert.throws(() => h.room.join({ name: '   ' }), /NAME_INVALID/);
  assert.notEqual(h.ps[0].color, h.ps[1].color);
});

test('oda en fazla 8 kişi', () => {
  const h = makeRoom({ players: 8 });
  assert.throws(() => h.room.join({ name: 'Dokuz' }), /ROOM_FULL/);
});

test('başlatmak için oda sahibi ve en az 2 bağlı oyuncu gerekir', () => {
  const h = makeRoom({ players: 1 });
  h.start();
  assert.equal(h.lastError(h.ps[0].id), 'NOT_ENOUGH_PLAYERS');
  const b = h.room.join({ name: 'Barış' });
  h.room.handle(b.id, { type: 'start' });
  assert.equal(h.lastError(b.id), 'NOT_HOST');
  h.start();
  assert.equal(h.room.phase, Phase.SIGNAL);
});

test('takım adı ve kaptan sırası lobide düzenlenir', () => {
  const h = makeRoom({ players: 3 });
  h.room.handle(h.ps[0].id, { type: 'set_team', name: '  Gece   Kuşları ' });
  assert.equal(h.room.teamName, 'Gece Kuşları');
  h.room.handle(h.ps[0].id, { type: 'set_team', name: '' });
  assert.equal(h.lastError(h.ps[0].id), 'TEAM_INVALID');
  h.room.handle(h.ps[0].id, { type: 'move', playerId: h.ps[2].id, dir: 'up' });
  assert.deepEqual(h.room.order, [h.ps[0].id, h.ps[2].id, h.ps[1].id]);
  h.start();
  h.room.handle(h.ps[0].id, { type: 'set_team', name: 'Başka' });
  assert.equal(h.lastError(h.ps[0].id), 'BAD_PHASE');
});

// ───────────────────────── tur başlangıcı ─────────────────────────

test('tur: 8 kart, 1 hedef, seviye kadar parazit; roller yalnızca kaptana gider', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  const r = h.room.round;
  assert.equal(r.board.length, 8);
  assert.equal(r.board.filter((c) => c.role === 'target').length, 1);
  assert.equal(r.board.filter((c) => c.role === 'parasite').length, 1);
  assert.equal(h.captain().id, h.ps[0].id);

  const pub = h.state();
  assert.ok(pub.round.board.every((c) => c.role === null && !c.revealed));
  assert.equal(pub.round.handCount, 6);
  assert.equal(JSON.stringify(pub).includes('"target"'), false);

  const priv = h.lastPrivate(h.ps[0].id, 'captain');
  assert.equal(priv.roles.length, 8);
  assert.equal(priv.hand.length, 6);
  for (const g of h.guessers()) assert.equal(h.lastPrivate(g.id, 'captain'), null);
});

test('elde tahtadaki kelimelerle çakışan kart olmaz', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const h = makeRoom({ players: 2, seed });
    h.start();
    const words = h.room.round.board.map((c) => c.word);
    assert.equal(new Set(words).size, 8);
    for (const w of h.room.round.hand) assert.ok(!words.includes(w), `${w} tahtada da var`);
  }
});

// ───────────────────────── sinyal ─────────────────────────

test('sinyali yalnızca kaptan, elindeki karttan oynar', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  const g = h.guessers()[0];
  h.room.handle(g.id, { type: 'play_signal', word: h.room.round.hand[0] });
  assert.equal(h.lastError(g.id), 'NOT_CAPTAIN');
  const cap = h.captain();
  h.room.handle(cap.id, { type: 'play_signal', word: 'OLMAYANKELİME' });
  assert.equal(h.lastError(cap.id), 'NOT_IN_HAND');

  const card = h.room.round.hand[2];
  h.room.handle(cap.id, { type: 'play_signal', word: card.toLocaleLowerCase('tr-TR') });
  assert.equal(h.room.phase, Phase.GUESS);
  assert.deepEqual(h.room.round.signals, [{ word: card, auto: false }]);
  assert.equal(h.room.round.hand.length, 6, 'oynanan kartın yerine yenisi gelir');
  assert.ok(!h.room.round.hand.includes(card));
  assert.deepEqual(h.lastPrivate(cap.id, 'captain').hand, h.room.round.hand);
});

test('eli değiştirme turda bir kez', () => {
  const h = makeRoom({ players: 2 });
  h.start();
  const cap = h.captain();
  const before = [...h.room.round.hand];
  h.room.handle(cap.id, { type: 'redraw' });
  assert.equal(h.room.round.hand.length, 6);
  assert.ok(h.room.round.hand.every((w) => !before.includes(w)), 'yeni el eskisinden farklı');
  h.room.handle(cap.id, { type: 'redraw' });
  assert.equal(h.lastError(cap.id), 'NO_REDRAWS');
});

test('sinyal süresi dolarsa elden rastgele kart oynanır', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  const hand = [...h.room.round.hand];
  h.clock.advance(h.config.signalSeconds * 1000);
  assert.equal(h.room.phase, Phase.GUESS);
  assert.equal(h.room.round.signals.length, 1);
  assert.ok(h.room.round.signals[0].auto);
  assert.ok(hand.includes(h.room.round.signals[0].word));
});

// ───────────────────────── jetonlar ─────────────────────────

test('herkes aynı kartta birleşince geri sayım başlar, biri ayrılırsa durur', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  h.signal();
  const [g1, g2] = h.guessers();
  const neutral = h.roleIndex('neutral');
  const other = h.room.round.board.findIndex((c, i) => i !== neutral && c.role === 'neutral');
  h.room.handle(g1.id, { type: 'token', target: neutral });
  assert.equal(h.room.round.lock, null);
  h.room.handle(g2.id, { type: 'token', target: neutral });
  assert.equal(h.room.round.lock.target, neutral);
  h.clock.advance(2000);
  h.room.handle(g2.id, { type: 'token', target: other });
  assert.equal(h.room.round.lock, null, 'jeton değişince kilit iptal');
  h.clock.advance(5000);
  assert.equal(h.room.round.board[neutral].revealed, false);
  h.room.handle(g2.id, { type: 'token', target: null });
  assert.equal(h.room.round.tokens.has(g2.id), false);
});

test('kaptan jeton koyamaz; açık karta jeton konamaz', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  h.signal();
  h.room.handle(h.captain().id, { type: 'token', target: 0 });
  assert.equal(h.lastError(h.captain().id), 'CAPTAIN_CANNOT_PICK');
  const g = h.guessers()[0];
  h.room.handle(g.id, { type: 'token', target: 99 });
  assert.equal(h.lastError(g.id), 'BAD_TARGET');
  h.pickRole('neutral');
  h.signal();
  const opened = h.room.round.board.findIndex((c) => c.revealed);
  h.room.handle(g.id, { type: 'token', target: opened });
  assert.equal(h.lastError(g.id), 'BAD_TARGET');
});

test('jeton hızı sınırlı', () => {
  const h = makeRoom({ players: 3, config: testConfig({ tokenRateLimitMs: 150 }) });
  h.start();
  h.signal();
  const g = h.guessers()[0];
  h.room.handle(g.id, { type: 'token', target: 0 });
  h.room.handle(g.id, { type: 'token', target: 1 });
  assert.equal(h.lastError(g.id), 'RATE_LIMITED');
  assert.equal(h.room.round.tokens.get(g.id), 0);
});

// ───────────────────────── sonuçlar ─────────────────────────

test('hedef 1. sinyalde 3, 2.de 2, 3.de 1 puan', () => {
  for (const [misses, points] of [
    [0, 3],
    [1, 2],
    [2, 1],
  ]) {
    const h = makeRoom({ players: 3 });
    h.start();
    for (let i = 0; i < misses; i++) {
      h.signal();
      h.pickRole('neutral');
      assert.equal(h.room.phase, Phase.SIGNAL, 'boş kart: kaptan yeni sinyal oynar');
    }
    h.signal();
    h.pickRole('target');
    assert.equal(h.room.phase, Phase.REVEAL);
    assert.equal(h.room.run.score, points);
    assert.equal(h.room.round.result.kind, 'hit');
    assert.equal(h.room.run.lives, 3);
    assert.ok(h.state().round.board.every((c) => c.role), 'sonuçta bütün roller açılır');
  }
});

test('parazit 1 can götürür ve turu bitirir', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  h.signal();
  h.pickRole('parasite');
  assert.equal(h.room.phase, Phase.REVEAL);
  assert.equal(h.room.run.lives, 2);
  assert.equal(h.room.run.score, 0);
  assert.equal(h.room.round.result.kind, 'parasite');
});

test('3 sinyalde bulunamazsa sinyal kesilir: −1 can', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  h.signal();
  h.pickRole('neutral');
  h.signal();
  h.pass();
  assert.equal(h.room.phase, Phase.SIGNAL, 'pas kart açmadan yeni sinyal ister');
  assert.equal(h.room.round.board.filter((c) => c.revealed).length, 1);
  h.signal();
  h.pickRole('neutral');
  assert.equal(h.room.phase, Phase.REVEAL);
  assert.equal(h.room.round.result.kind, 'silence');
  assert.equal(h.room.run.lives, 2);
});

test('karar süresi dolunca en çok jetonlu kart açılır; eşitlik pas sayılır', () => {
  const h = makeRoom({ players: 4 });
  h.start();
  h.signal();
  const [g1, g2, g3] = h.guessers();
  const n = h.roleIndex('neutral');
  const t = h.roleIndex('target');
  h.room.handle(g1.id, { type: 'token', target: n });
  h.room.handle(g2.id, { type: 'token', target: t });
  h.room.handle(g3.id, { type: 'token', target: t });
  h.clock.advance(h.config.guessSeconds * 1000);
  assert.equal(h.room.round.result.kind, 'hit');

  const h2 = makeRoom({ players: 3 });
  h2.start();
  h2.signal();
  const [a, b] = h2.guessers();
  h2.room.handle(a.id, { type: 'token', target: h2.roleIndex('neutral') });
  h2.room.handle(b.id, { type: 'token', target: h2.roleIndex('target') });
  h2.clock.advance(h2.config.guessSeconds * 1000);
  assert.equal(h2.room.phase, Phase.SIGNAL);
  assert.equal(h2.room.round.board.some((c) => c.revealed), false);
});

test('iki kişilik oyun: tek tahmincinin jetonu yeterli', () => {
  const h = makeRoom({ players: 2 });
  h.start();
  h.signal();
  h.pickRole('target');
  assert.equal(h.room.run.score, 3);
});

test('sonuç ekranından sonra sıradaki kaptanla yeni tur; oda sahibi erken geçebilir', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  h.signal();
  h.pickRole('target');
  h.clock.advance(h.config.revealSeconds * 1000);
  assert.equal(h.room.phase, Phase.SIGNAL);
  assert.equal(h.room.round.no, 2);
  assert.equal(h.captain().id, h.ps[1].id);
  h.signal();
  h.pickRole('target');
  h.room.handle(h.ps[1].id, { type: 'next' });
  assert.equal(h.lastError(h.ps[1].id), 'NOT_HOST');
  h.room.handle(h.ps[0].id, { type: 'next' });
  assert.equal(h.captain().id, h.ps[2].id);
});

test('tahta kelimeleri oyun boyunca tekrarlanmaz', () => {
  const h = makeRoom({ players: 2 });
  h.start();
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    for (const c of h.room.round.board) {
      assert.ok(!seen.has(c.word), `${c.word} tekrar geldi`);
      seen.add(c.word);
    }
    h.signal();
    h.pickRole('target');
    h.room.handle(h.room.hostId, { type: 'next' });
  }
});

test('seviye ilerledikçe parazit artar ve hedefle aynı kategoriden gelir', () => {
  const h = makeRoom({ players: 2 });
  h.start();
  for (let i = 1; i < 13; i++) {
    h.signal();
    h.pickRole('target');
    h.room.handle(h.room.hostId, { type: 'next' });
  }
  const r = h.room.round;
  assert.equal(r.no, 13);
  assert.equal(r.level.name, 'Usta');
  const target = r.board.find((c) => c.role === 'target');
  const parasites = r.board.filter((c) => c.role === 'parasite');
  assert.equal(parasites.length, 3);
  assert.ok(parasites.filter((c) => c.category === target.category).length >= 2);
  assert.equal(h.room.phaseMs, 35_000);
});

test('her 5 isabette 1 can geri gelir (en fazla 3)', () => {
  const h = makeRoom({ players: 2 });
  h.start();
  h.signal();
  h.pickRole('parasite');
  h.room.handle(h.room.hostId, { type: 'next' });
  assert.equal(h.room.run.lives, 2);
  for (let i = 0; i < 5; i++) {
    h.signal();
    h.pickRole('target');
    if (i < 4) h.room.handle(h.room.hostId, { type: 'next' });
  }
  assert.equal(h.room.run.lives, 3);
  assert.equal(h.room.round.result.lifeGain, true);
});

test('canlar bitince oyun biter, rekor kaydedilir, yeniden başlanabilir', () => {
  const store = new TeamStore();
  const h = makeRoom({ players: 3, store });
  h.start();
  h.signal();
  h.pickRole('target');
  h.room.handle(h.room.hostId, { type: 'next' });
  for (let i = 0; i < 3; i++) {
    h.signal();
    h.pickRole('parasite');
    h.room.handle(h.room.hostId, { type: 'next' });
  }
  assert.equal(h.room.phase, Phase.END);
  const s = h.state().summary;
  assert.equal(s.score, 3);
  assert.equal(s.rounds, 4);
  assert.equal(s.hits, 1);
  assert.equal(s.record.isNewRecord, true);
  assert.equal(s.bestCaptain.name, 'Oyuncu1');
  assert.equal(s.history.length, 4);
  assert.deepEqual(
    s.history.map((x) => x.kind),
    ['hit', 'parasite', 'parasite', 'parasite'],
  );
  assert.equal(store.peekTeam(h.room.teamName).bestScore, 3);

  h.start();
  assert.equal(h.room.phase, Phase.SIGNAL);
  assert.equal(h.room.run.score, 0);
  assert.equal(h.room.run.lives, 3);
});

// ───────────────────────── bağlantı ─────────────────────────

test('kopan tahminci beklenmez; dönen oyuncu aynı kişi olarak devam eder', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  h.signal();
  const [g1, g2] = h.guessers();
  h.room.handle(g1.id, { type: 'token', target: h.roleIndex('target') });
  assert.equal(h.room.round.lock, null);
  h.room.disconnect(g2.id);
  assert.equal(h.room.round.lock.target, h.roleIndex('target'), 'kalan tahminciler uzlaştı');
  const back = h.room.join({ token: g2.token });
  assert.equal(back.id, g2.id);
  assert.equal(h.room.round.lock, null, 'dönen oyuncunun jetonu bekleniyor');
});

test('oyuncu 2nin altına düşerse sayaç donar, dönünce devam eder', () => {
  const h = makeRoom({ players: 2 });
  h.start();
  const g = h.guessers()[0];
  h.room.disconnect(g.id);
  assert.equal(h.room.waiting, true);
  assert.equal(h.room.endsAt, null);
  h.clock.advance(h.config.signalSeconds * 1000 + 5000);
  assert.equal(h.room.phase, Phase.SIGNAL, 'donmuş sayaç dolmaz');
  h.room.join({ token: g.token });
  assert.equal(h.room.waiting, false);
  assert.ok(h.room.endsAt > h.clock.now());
});

test('kaptan sinyal aşamasında kopar ve dönmezse tur cezasız yenilenir', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  const cap = h.captain();
  h.room.disconnect(cap.id);
  h.clock.advance(h.config.signalSeconds * 1000);
  assert.equal(h.room.phase, Phase.REVEAL);
  assert.equal(h.room.round.result.kind, 'cancelled');
  assert.equal(h.room.run.lives, 3);
  h.clock.advance(h.config.revealSeconds * 1000);
  assert.notEqual(h.captain().id, cap.id);
});

test('kaptan oyundan çıkarsa tur cezasız biter', () => {
  const h = makeRoom({ players: 3 });
  h.start();
  h.signal();
  h.room.handle(h.captain().id, { type: 'leave' });
  assert.equal(h.room.round.result.kind, 'cancelled');
  assert.equal(h.room.run.lives, 3);
});

test('oda sahibi koparsa yetki devredilir; oyuncu çıkarılabilir', () => {
  const h = makeRoom({ players: 3 });
  h.room.disconnect(h.ps[0].id);
  h.clock.advance(h.config.hostGraceSeconds * 1000);
  assert.equal(h.room.hostId, h.ps[1].id);
  h.room.handle(h.ps[1].id, { type: 'kick', playerId: h.ps[2].id });
  assert.equal(h.room.players.get(h.ps[2].id).left, true);
  assert.throws(() => h.room.join({ token: h.ps[2].token }), /KICKED/);
});

test('oyun sırasında gelen oyuncu tahminci olarak katılır', () => {
  const h = makeRoom({ players: 2 });
  h.start();
  h.signal();
  const late = h.room.join({ name: 'Geç' });
  assert.ok(h.guessers().some((g) => g.id === late.id));
  h.pickRole('target');
  assert.equal(h.room.run.score, 3);
  assert.equal(h.room.order.at(-1), late.id);
});

test('tek başına kalan oda kapanır', () => {
  let closed = false;
  const h = makeRoom({ players: 1 });
  h.room.onEmpty = () => (closed = true);
  h.room.handle(h.ps[0].id, { type: 'leave' });
  assert.equal(closed, true);
});

test('pas sabiti istemciyle aynı', () => {
  assert.equal(PASS, 'pass');
});
