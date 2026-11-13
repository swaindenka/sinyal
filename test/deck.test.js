import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Deck, clashes } from '../server/deck.js';
import { seeded } from './helpers.js';

const data = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8'));
const ALPHABET = new Set('ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ');

test('deste: kelimeler tekil, Türkçe büyük harf, en fazla 10 harf', () => {
  const all = [...Object.values(data.categories).flatMap((c) => c.words), ...data.nitelik, ...data.kavram];
  const seen = new Set();
  for (const w of all) {
    assert.ok(!seen.has(w), `${w} iki kez geçiyor`);
    seen.add(w);
    assert.ok([...w].every((ch) => ALPHABET.has(ch)), `${w} geçersiz harf içeriyor`);
    assert.ok(w.length >= 2 && w.length <= 10, `${w} uzunluğu uygun değil`);
  }
  for (const [key, c] of Object.entries(data.categories)) assert.ok(c.words.length >= 20, `${key} kategorisi küçük`);
});

test('çakışma kuralı', () => {
  assert.ok(clashes('KAR', 'KARPUZ'));
  assert.ok(clashes('LİMON', 'LİMONATA'));
  assert.ok(clashes('KRAL', 'KRALİÇE'));
  assert.ok(clashes('DİŞ', 'DİŞÇİ'));
  assert.ok(!clashes('AY', 'AYI'));
  assert.ok(!clashes('KEDİ', 'KÖPEK'));
});

test('tahta: istenen rol dağılımı, çakışmasız kelimeler', () => {
  const deck = new Deck(data);
  const levels = [
    { parasites: 1, near: 0, decoys: 0 },
    { parasites: 2, near: 1, decoys: 1 },
    { parasites: 3, near: 2, decoys: 1 },
  ];
  for (let seed = 1; seed <= 200; seed++) {
    const level = levels[seed % levels.length];
    const board = deck.board(level, { size: 8, rng: seeded(seed) });
    assert.equal(board.length, 8);
    assert.equal(board.filter((c) => c.role === 'target').length, 1);
    assert.equal(board.filter((c) => c.role === 'parasite').length, level.parasites);
    const target = board.find((c) => c.role === 'target');
    const sameCat = board.filter((c) => c.category === target.category && c !== target);
    assert.ok(sameCat.filter((c) => c.role === 'parasite').length >= level.near);
    if (level.near === 0) assert.equal(sameCat.length, 0, 'ısınmada hedefin kategorisinden başka kart yok');
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) assert.ok(!clashes(board[i].word, board[j].word), `${board[i].word} / ${board[j].word}`);
  }
});

test('el: istenen kadar nitelik, kaçınılan kelimelerle çakışmaz', () => {
  const deck = new Deck(data);
  for (let seed = 1; seed <= 100; seed++) {
    const avoid = deck.board({ parasites: 1 }, { size: 8, rng: seeded(seed) }).map((c) => c.word);
    const hand = deck.draw({ count: 6, nitelik: 2, avoid, rng: seeded(seed + 1000) });
    assert.equal(hand.length, 6);
    assert.ok(hand.slice(0, 2).every((w) => data.nitelik.includes(w)));
    for (const w of hand) for (const a of avoid) assert.ok(!clashes(w, a), `${w} / ${a}`);
    assert.equal(new Set(hand).size, 6);
  }
});
