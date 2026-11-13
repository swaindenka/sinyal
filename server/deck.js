// Kelime destesi: tahta kartları (kategorili) ve kaptanın sinyal eli.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/**
 * İki kelime aynı tahtada / aynı elde bulunmamalı mı? Aynı kelime, biri diğerini içeriyor
 * (3+ harf) ya da ilk 4 harfi aynı: KAR ↔ KARPUZ, LİMON ↔ LİMONATA, KRAL ↔ KRALİÇE.
 */
export function clashes(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.includes(s)) return true;
  return s.length >= 4 && l.startsWith(s.slice(0, 4));
}

function clashesAny(word, words) {
  for (const w of words) if (clashes(word, w)) return true;
  return false;
}

export class Deck {
  /**
   * @param {{categories: Record<string, {label: string, words: string[]}>, nitelik: string[], kavram: string[]}} data
   */
  constructor(data) {
    this.categories = Object.entries(data.categories).map(([key, c]) => ({ key, label: c.label, words: [...c.words] }));
    this.categoryOf = new Map();
    for (const c of this.categories) for (const w of c.words) this.categoryOf.set(w, c.key);
    this.boardWords = this.categories.flatMap((c) => c.words);
    this.nitelik = [...data.nitelik];
    // Elin "kart" kısmı: soyut kavramlar + bütün somut kelimeler.
    this.cardPool = [...data.kavram, ...this.boardWords];
  }

  static load(file = path.join(ROOT, 'data', 'cards.json')) {
    return new Deck(JSON.parse(readFileSync(file, 'utf8')));
  }

  get size() {
    return this.boardWords.length;
  }

  /**
   * Bir tur için tahta kurar.
   * @param {{parasites: number, near: number, decoys: number}} level
   * @param {{size: number, rng: () => number, used?: Set<string>}} opts
   * @returns {{word: string, role: 'target'|'parasite'|'neutral', category: string}[]}
   */
  board(level, { size, rng, used = new Set() }) {
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    const parasites = Math.min(level.parasites ?? 1, size - 2);
    const near = Math.min(level.near ?? 0, parasites);
    const decoys = Math.min(level.decoys ?? 0, size - 1 - parasites);
    const fromTargetCat = 1 + near + decoys;

    // Aynı oyunda kullanılmamış kelimeler öncelikli; deste biterse kullanılmışlar da gelir.
    const fresh = (words) => {
      const f = words.filter((w) => !used.has(w));
      return f.length ? f : words;
    };

    const eligible = this.categories.filter((c) => fresh(c.words).length >= fromTargetCat);
    const targetCat = pick(eligible.length ? eligible : this.categories);
    const chosen = [];
    const take = (pool, role) => {
      const options = shuffle([...pool]).filter((w) => !clashesAny(w, chosen.map((c) => c.word)));
      if (!options.length) return false;
      chosen.push({ word: options[0], role, category: this.categoryOf.get(options[0]) });
      return true;
    };

    const ownWords = fresh(targetCat.words);
    take(ownWords, 'target');
    for (let i = 0; i < near; i++) take(ownWords, 'parasite');
    for (let i = 0; i < decoys; i++) take(ownWords, 'neutral');

    // Uzak kartlar farklı kategorilerden gelir; mümkün olduğunca her kategoriden en fazla bir kelime.
    const others = shuffle(this.categories.filter((c) => c !== targetCat));
    let ci = 0;
    const takeFar = (role) => {
      for (let tries = 0; tries < others.length * 2; tries++) {
        const cat = others[ci++ % others.length];
        if (take(fresh(cat.words), role)) return;
      }
      take(fresh(this.boardWords), role);
    };
    for (let i = near; i < parasites; i++) takeFar('parasite');
    while (chosen.length < size) takeFar('neutral');
    return shuffle(chosen);
  }

  /**
   * Kaptana kart çeker. `nitelik` kadarı sıfat havuzundan, kalanı kavram + somut kelimelerden gelir.
   * Tahtadaki, eldeki ve bu turda oynanmış kelimelerle çakışanlar gelmez.
   */
  draw({ count, nitelik = 0, avoid = [], rng }) {
    const out = [];
    const blocked = [...avoid];
    const one = (pool) => {
      for (let tries = 0; tries < 60; tries++) {
        const w = pool[Math.floor(rng() * pool.length)];
        if (!clashesAny(w, blocked)) {
          out.push(w);
          blocked.push(w);
          return;
        }
      }
      const rest = pool.filter((w) => !clashesAny(w, blocked));
      if (rest.length) {
        const w = rest[Math.floor(rng() * rest.length)];
        out.push(w);
        blocked.push(w);
      }
    };
    for (let i = 0; i < count; i++) one(i < nitelik ? this.nitelik : this.cardPool);
    return out;
  }
}
