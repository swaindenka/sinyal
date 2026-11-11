import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, blindColors } from '../server/score.js';
import { normalize, isAlphabetic } from '../server/turkish.js';

const EMOJI = { G: '🟩', Y: '🟨', X: '⬜' };
const render = (colors) => colors.map((c) => EMOJI[c]).join('');

// Spec 9.4 birim test vakaları
const CASES = [
  ['MASAL', 'ANLAT', '🟨⬜🟨🟩⬜'],
  ['MASAL', 'PRENS', '⬜⬜⬜⬜🟨'],
  ['MASAL', 'AAAAA', '⬜🟩⬜🟩⬜'],
  ['KABAK', 'KAYAK', '🟩🟩⬜🟩🟩'],
  ['KABAK', 'TATLI', '⬜🟩⬜⬜⬜'],
];

for (const [secret, guess, expected] of CASES) {
  test(`score(${guess}, ${secret}) = ${expected}`, () => {
    assert.equal(render(score(guess, secret)), expected);
  });
}

test('Türkçe harfler tek karakter sayılır', () => {
  assert.equal(render(score('ŞİŞLİ', 'İŞLEM')), '🟨🟨⬜🟨⬜');
  assert.equal(render(score('ÇİÇEK', 'ÇİÇEK')), '🟩🟩🟩🟩🟩');
});

test('kör renk sarıları gri yapar', () => {
  assert.equal(render(blindColors(score('ANLAT', 'MASAL'))), '⬜⬜⬜🟩⬜');
});

test('normalize: tr-TR büyük harf ve şapka sadeleştirme', () => {
  assert.equal(normalize('istanbul'), 'İSTANBUL');
  assert.equal(normalize('ılık'), 'ILIK');
  assert.equal(normalize('kâğıt'), 'KAĞIT');
  assert.equal(normalize('îman'), 'İMAN');
  assert.equal(normalize('Ûmumi'), 'UMUMİ');
  assert.equal(normalize('  çiçek '), 'ÇİÇEK');
});

test('alfabe dışı karakterler geçersiz', () => {
  assert.equal(isAlphabetic('KABAK'), true);
  assert.equal(isAlphabetic('ŞEKER'), true);
  for (const w of ['QUEEN', 'WİFİ', 'XRAY', 'KA BAK', 'KA-BAK', 'KAB4K', '']) {
    assert.equal(isAlphabetic(w), false, w);
  }
});
