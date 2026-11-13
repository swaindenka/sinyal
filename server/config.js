import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Bütün sayısal oyun değerleri config/game.json'dadır.
 * SINYAL_CONFIG ortam değişkeni başka bir config dosyasını gösterebilir.
 */
export function loadConfig({ file = process.env.SINYAL_CONFIG } = {}) {
  const configPath = file ? path.resolve(file) : path.join(ROOT, 'config', 'game.json');
  return JSON.parse(readFileSync(configPath, 'utf8'));
}
