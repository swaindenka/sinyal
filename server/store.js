// Takım rekorları ve takıma verilmiş bulmacalar (spec 4.7, 9.3).
//
// Veriler bellekte tutulur ve arka planda kalıcı hale getirilir:
//   - DATABASE_URL tanımlıysa PostgreSQL (Render Postgres vb.)
//   - değilse DATA_DIR/teams.json dosyası (varsayılan: ./storage)
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { normalize } from './turkish.js';

export function teamKey(name) {
  return normalize(name).replace(/\s+/g, ' ');
}

function emptyTeam(name) {
  return { name, bestScore: 0, bestStars: 0, runs: 0, usedSecrets: [] };
}

export class TeamStore {
  constructor(backend = null) {
    this.backend = backend;
    this.teams = new Map();
    this.dirty = new Set();
    this.flushTimer = null;
  }

  async init() {
    if (!this.backend) return;
    for (const [key, team] of await this.backend.loadAll()) this.teams.set(key, team);
  }

  getTeam(name) {
    const key = teamKey(name);
    if (!this.teams.has(key)) this.teams.set(key, emptyTeam(name));
    return this.teams.get(key);
  }

  /** Kaydı oluşturmadan okur. */
  peekTeam(name) {
    return this.teams.get(teamKey(name)) ?? null;
  }

  usedSecrets(name) {
    return new Set(this.getTeam(name).usedSecrets);
  }

  markUsed(name, secret) {
    const team = this.getTeam(name);
    if (!team.usedSecrets.includes(secret)) team.usedSecrets.push(secret);
    this.touch(name);
  }

  /** Oyun sonu: rekoru günceller. Skor eşitse yıldız sayısına bakılır. */
  recordRun(name, score, stars) {
    const team = this.getTeam(name);
    const previous = { bestScore: team.bestScore, bestStars: team.bestStars };
    const isNewRecord = score > team.bestScore || (score === team.bestScore && stars > team.bestStars);
    if (isNewRecord) {
      team.bestScore = score;
      team.bestStars = stars;
    }
    team.name = name;
    team.runs += 1;
    this.touch(name);
    return { previous, isNewRecord, bestScore: team.bestScore, bestStars: team.bestStars, runs: team.runs };
  }

  touch(name) {
    this.dirty.add(teamKey(name));
    if (!this.backend || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => console.error('[sinyal] kayıt hatası:', err.message));
    }, 500);
    this.flushTimer.unref?.();
  }

  async flush() {
    if (!this.backend || !this.dirty.size) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    await this.backend.save(keys.map((k) => [k, this.teams.get(k)]), this.teams);
  }
}

export class FileBackend {
  constructor(dir) {
    this.file = path.join(dir, 'teams.json');
    mkdirSync(dir, { recursive: true });
  }

  async loadAll() {
    if (!existsSync(this.file)) return [];
    try {
      return Object.entries(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (err) {
      console.error('[sinyal] teams.json okunamadı:', err.message);
      return [];
    }
  }

  async save(_changed, all) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(all)));
    renameSync(tmp, this.file);
  }
}

export class PostgresBackend {
  constructor(url) {
    this.url = url;
    this.pool = null;
  }

  async connect() {
    const { default: pg } = await import('pg');
    const ssl = /sslmode=disable/.test(this.url) || /@(localhost|127\.0\.0\.1)/.test(this.url) ? false : { rejectUnauthorized: false };
    this.pool = new pg.Pool({ connectionString: this.url, ssl, max: 3 });
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS sinyal_teams (key TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
  }

  async loadAll() {
    if (!this.pool) await this.connect();
    const { rows } = await this.pool.query('SELECT key, data FROM sinyal_teams');
    return rows.map((r) => [r.key, r.data]);
  }

  async save(changed) {
    for (const [key, team] of changed) {
      await this.pool.query(
        `INSERT INTO sinyal_teams (key, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [key, team],
      );
    }
  }
}

export async function createStore() {
  let backend;
  if (process.env.DATABASE_URL) {
    backend = new PostgresBackend(process.env.DATABASE_URL);
    console.log('[sinyal] takım kayıtları: PostgreSQL');
  } else {
    const dir = path.resolve(process.env.DATA_DIR || 'storage');
    backend = new FileBackend(dir);
    console.log(`[sinyal] takım kayıtları: ${backend.file}`);
  }
  const store = new TeamStore(backend);
  await store.init();
  return store;
}
