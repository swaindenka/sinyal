// Takım rekorları. v1 (kelime sayısı) rekorları yeni puanlamayla karışmasın diye v2 ayrı yere yazılır.
//
// Veriler bellekte tutulur ve arka planda kalıcı hale getirilir:
//   - DATABASE_URL tanımlıysa PostgreSQL (Render Postgres vb.), tablo: sinyal_teams_v2
//   - değilse DATA_DIR/teams-v2.json dosyası (varsayılan: ./storage)
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { normalize } from './turkish.js';

export function teamKey(name) {
  return normalize(name).replace(/\s+/g, ' ');
}

function emptyTeam(name) {
  return { name, bestScore: 0, runs: 0 };
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

  /** Oyun sonu: rekoru günceller. */
  recordRun(name, score) {
    const team = this.getTeam(name);
    const previous = team.bestScore;
    const isNewRecord = score > 0 && score > team.bestScore;
    if (isNewRecord) team.bestScore = score;
    team.name = name;
    team.runs += 1;
    this.touch(name);
    return { previous, isNewRecord, bestScore: team.bestScore, runs: team.runs };
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
    try {
      await this.backend.save(keys.map((k) => [k, this.teams.get(k)]), this.teams);
    } catch (err) {
      // Yazılamayanlar kaybolmasın: bir sonraki denemede tekrar yazılır.
      for (const k of keys) this.dirty.add(k);
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.flush().catch((e) => console.error('[sinyal] kayıt hatası:', e.message));
        }, 10_000);
        this.retryTimer.unref?.();
      }
      throw err;
    }
  }
}

export class FileBackend {
  constructor(dir) {
    this.file = path.join(dir, 'teams-v2.json');
    mkdirSync(dir, { recursive: true });
  }

  async loadAll() {
    if (!existsSync(this.file)) return [];
    try {
      return Object.entries(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (err) {
      console.error('[sinyal] takım kayıtları okunamadı:', err.message);
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
    const createTable =
      'CREATE TABLE IF NOT EXISTS sinyal_teams_v2 (key TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())';
    // Adreste sslmode varsa ona uyulur. Yoksa önce SSL denenir (Render dış adresi, Neon, Supabase…),
    // sunucu SSL desteklemiyorsa (Render iç adresi, yerel kurulum) SSL'siz bağlanılır.
    const attempts = /sslmode=/.test(this.url) ? [undefined] : [{ rejectUnauthorized: false }, false];
    let lastErr;
    for (const ssl of attempts) {
      const pool = new pg.Pool({ connectionString: this.url, ...(ssl === undefined ? {} : { ssl }), max: 3 });
      pool.on('error', (err) => console.error('[sinyal] PostgreSQL bağlantı hatası:', err.message));
      try {
        await pool.query(createTable);
        this.pool = pool;
        return;
      } catch (err) {
        lastErr = err;
        await pool.end().catch(() => {});
      }
    }
    throw lastErr;
  }

  async loadAll() {
    if (!this.pool) await this.connect();
    const { rows } = await this.pool.query('SELECT key, data FROM sinyal_teams_v2');
    return rows.map((r) => [r.key, r.data]);
  }

  async save(changed) {
    for (const [key, team] of changed) {
      await this.pool.query(
        `INSERT INTO sinyal_teams_v2 (key, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [key, team],
      );
    }
  }
}

function fileStore() {
  const backend = new FileBackend(path.resolve(process.env.DATA_DIR || 'storage'));
  console.log(`[sinyal] takım kayıtları: ${backend.file}`);
  return new TeamStore(backend);
}

/** Veritabanına ulaşılamazsa oyun yine açılır; kayıtlar dosyaya yazılır. */
export async function createStore() {
  if (process.env.DATABASE_URL) {
    const store = new TeamStore(new PostgresBackend(process.env.DATABASE_URL));
    try {
      await store.init();
      console.log('[sinyal] takım kayıtları: PostgreSQL');
      return store;
    } catch (err) {
      console.error(`[sinyal] PostgreSQL'e bağlanılamadı (${err.message}); kayıtlar dosyaya yazılacak.`);
    }
  }
  const store = fileStore();
  await store.init();
  return store;
}
