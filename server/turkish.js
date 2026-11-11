// Türkçe alfabe ve normalizasyon (spec 9.1)

export const ALPHABET = [...'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ'];
const ALPHABET_SET = new Set(ALPHABET);
export const VOWELS = new Set([...'AEIİOÖUÜ']);

/**
 * Karşılaştırma için normalize edilmiş büyük harf:
 * toLocaleUpperCase('tr-TR') (i → İ, ı → I) + şapkalı harf sadeleştirme (Â→A, Î→İ, Û→U).
 */
export function normalize(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFC')
    .trim()
    .toLocaleUpperCase('tr-TR')
    .replace(/Â/g, 'A')
    .replace(/Î/g, 'İ')
    .replace(/Û/g, 'U')
    .replace(/̇/g, '');
}

/** Kelime yalnızca 29 harflik Türkçe alfabeden mi oluşuyor? */
export function isAlphabetic(word) {
  if (!word) return false;
  for (const ch of word) if (!ALPHABET_SET.has(ch)) return false;
  return true;
}

/** Görünen ad / takım adı temizliği: kontrol karakterleri ve fazla boşluklar atılır. */
export function cleanLabel(input, maxLen) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}
