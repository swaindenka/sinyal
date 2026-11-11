import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tüm sayısal oyun değerleri config/game.json'dan okunur (spec bölüm 13).
 * SINYAL_CONFIG ortam değişkeni başka bir config dosyasını gösterebilir.
 * SINYAL_DEV=1 geliştirme modudur (devMinPlayers tanımlıysa o kadar oyuncuyla başlanabilir).
 */
export function loadConfig({ file = process.env.SINYAL_CONFIG, dev = process.env.SINYAL_DEV === '1' } = {}) {
  const configPath = file ? path.resolve(file) : path.join(ROOT, 'config', 'game.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.devMode = Boolean(dev);
  if (config.devMode && config.devMinPlayers) config.minPlayers = config.devMinPlayers;
  return config;
}
