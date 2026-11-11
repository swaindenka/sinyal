// Renk algoritması (spec 9.4) — tekrarlayan harfler dahil.

export const GREEN = 'G';
export const YELLOW = 'Y';
export const GRAY = 'X';

/**
 * @param {string} guess   normalize edilmiş, gizli kelimeyle aynı uzunlukta kelime
 * @param {string} secret  normalize edilmiş gizli kelime
 * @returns {string[]}     her harf için GREEN | YELLOW | GRAY
 */
export function score(guess, secret) {
  const g = [...guess];
  const s = [...secret];
  const n = s.length;
  const result = new Array(n).fill(GRAY);
  const remaining = new Map();
  for (const ch of s) remaining.set(ch, (remaining.get(ch) || 0) + 1);

  // 1. geçiş: yeşiller
  for (let i = 0; i < n; i++) {
    if (g[i] === s[i]) {
      result[i] = GREEN;
      remaining.set(g[i], remaining.get(g[i]) - 1);
    }
  }
  // 2. geçiş: sarılar
  for (let i = 0; i < n; i++) {
    if (result[i] !== GREEN && (remaining.get(g[i]) || 0) > 0) {
      result[i] = YELLOW;
      remaining.set(g[i], remaining.get(g[i]) - 1);
    }
  }
  return result;
}

/** "Kör renk" kaos kartı: sarılar gri gösterilir. */
export function blindColors(colors) {
  return colors.map((c) => (c === YELLOW ? GRAY : c));
}
