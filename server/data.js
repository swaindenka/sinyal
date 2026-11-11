// Sözlük, kategoriler ve bulmaca havuzu (scripts/build_data.py çıktıları).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export class Dictionary {
  /** @param {Map<string, number>} ranks  KELİME → sıklık sırası */
  constructor(ranks, categories = {}) {
    this.ranks = ranks;
    this.categories = {};
    for (const [name, words] of Object.entries(categories)) {
      this.categories[name] = new Set(words.filter((w) => ranks.has(w)));
    }
  }

  has(word) {
    return this.ranks.has(word);
  }

  rank(word) {
    return this.ranks.get(word) ?? Infinity;
  }

  inCategory(word, category) {
    return this.categories[category]?.has(word) ?? false;
  }

  /** Belirli uzunlukta, sıklık sırası maxRank'tan küçük (yaygın, bilinen) kelimeler. */
  knownWords(length, maxRank = Infinity) {
    this.knownCache ??= new Map();
    const key = `${length}:${maxRank}`;
    if (!this.knownCache.has(key)) {
      const out = [];
      for (const [w, r] of this.ranks) if (w.length === length && r <= maxRank) out.push(w);
      this.knownCache.set(key, out);
    }
    return this.knownCache.get(key);
  }

  categoryNames() {
    return Object.keys(this.categories);
  }

  /** Kategoride, verilen uzunlukta ve yasak harf içermeyen kelimeler. */
  categorySignals(category, length, forbidden) {
    const bad = new Set(forbidden);
    const out = [];
    for (const w of this.categories[category] ?? []) {
      if (w.length === length && ![...w].some((c) => bad.has(c))) out.push(w);
    }
    return out;
  }

  static fromWords(words, categories = {}) {
    return new Dictionary(new Map(words.map((w, i) => [w, i + 1])), categories);
  }
}

export class PuzzleBank {
  /**
   * @param {object[]} puzzles  {id, secret, traps[], forbidden[], length, consonantOnly, rank, approved}
   * @param {object} config
   */
  constructor(puzzles, config) {
    this.config = config;
    let pool = puzzles;
    if (config.requireApprovedPuzzles) {
      const approved = puzzles.filter((p) => p.approved);
      if (approved.length) pool = approved;
      else console.warn('[sinyal] requireApprovedPuzzles açık ama onaylı bulmaca yok; tüm bulmacalar kullanılıyor.');
    }
    this.puzzles = pool.map((p) => ({ ...p, trapCount: p.traps.length }));
    // Her bulmacanın uyduğu en düşük seviye (config değişse de doğru kalsın diye çalışma anında hesaplanır).
    for (const p of this.puzzles) p.baseTier = this.config.tiers.findIndex((t) => this.matchesTier(p, t));
  }

  matchesTier(p, tier) {
    const [lo, hi] = tier.trapRange;
    if (!tier.lengths.includes(p.length)) return false;
    if (p.trapCount < lo || p.trapCount > hi) return false;
    if (tier.consonantOnly && !p.consonantOnly) return false;
    if (p.rank > (tier.maxRank ?? this.config.commonWordLimit)) return false;
    const [dlo, dhi] = tier.difficulty ?? [0, 100];
    if ((p.difficulty ?? 0) < dlo || (p.difficulty ?? 0) > dhi) return false;
    return true;
  }

  /**
   * İstenen seviyeden kullanılmamış bir bulmaca seçer. O seviyede kalmadıysa
   * bir alt seviyeye iner (spec 5). Önce tam o seviyeye ait olanlar denenir.
   * @param {number} tierIndex
   * @param {(p) => boolean} isUsed
   * @param {() => number} rng
   */
  pick(tierIndex, isUsed, rng) {
    for (let t = tierIndex; t >= 0; t--) {
      const tier = this.config.tiers[t];
      const own = this.puzzles.filter((p) => p.baseTier === t && !isUsed(p));
      const pool = own.length ? own : this.puzzles.filter((p) => this.matchesTier(p, tier) && !isUsed(p));
      if (pool.length) return { puzzle: pool[Math.floor(rng() * pool.length)], tierIndex: t };
    }
    return null;
  }

  get size() {
    return this.puzzles.length;
  }
}

export function loadGameData(config, dataDir = path.join(ROOT, 'data')) {
  const ranks = new Map();
  for (const line of readFileSync(path.join(dataDir, 'words.tsv'), 'utf8').split('\n')) {
    if (!line) continue;
    const [word, rank] = line.split('\t');
    ranks.set(word, Number(rank));
  }
  const categories = JSON.parse(readFileSync(path.join(dataDir, 'categories.json'), 'utf8'));
  const puzzles = JSON.parse(readFileSync(path.join(dataDir, 'puzzles.json'), 'utf8'));
  return {
    dictionary: new Dictionary(ranks, categories),
    puzzles: new PuzzleBank(puzzles, config),
  };
}
