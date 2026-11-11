import { loadConfig } from '../server/config.js';
import { Dictionary, PuzzleBank } from '../server/data.js';
import { Room } from '../server/room.js';
import { TeamStore } from '../server/store.js';

export class FakeClock {
  constructor() {
    this.t = 1_000_000;
    this.timers = new Map();
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  advance(ms) {
    const target = this.t + ms;
    for (;;) {
      let next = null;
      for (const [id, tm] of this.timers) if (tm.at <= target && (!next || tm.at < next[1].at)) next = [id, tm];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = target;
  }
}

export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const WORDS = [
  'KABAK', 'KAPAK', 'KAVAK', 'KAZAK', 'KAYAK', 'KAÇAK', 'YÜREK', 'KÜREK', 'KAĞIT', 'KAYIT',
  'ŞEHİR', 'ŞEHİT', 'TANIM', 'TARIM', 'BAVUL', 'DAVUL', 'KALAN', 'YALAN',
  'MASAL', 'TATLI', 'ARMUT', 'ELMAS', 'SİNEK', 'KÖPEK', 'ASLAN', 'ZEBRA', 'LİMON', 'ÇİLEK',
  'KİRAZ', 'TAVUK', 'HOROZ', 'ÖRDEK', 'KUZEY', 'GÜNEY', 'DOLAP', 'SALON', 'ODUNA', 'MERAK',
  'ÇORBA', 'PİLAV', 'KÖFTE', 'SİMİT', 'HELVA', 'LOKUM', 'MANTI', 'ŞEKER', 'KAVUN', 'LAVAŞ', 'ÇALIM',
];

export const CATEGORIES = { yemek: ['LİMON', 'ÇİLEK', 'KİRAZ', 'ARMUT', 'TATLI', 'ÇORBA', 'PİLAV', 'KÖFTE', 'SİMİT', 'HELVA', 'LOKUM', 'MANTI', 'ŞEKER', 'KAVUN'] };

function puzzle(secret, traps, pos) {
  const forbidden = [secret[pos], ...traps.map((t) => t[pos])];
  return { id: `${secret}:${traps.join(',')}`, secret, traps, forbidden, pos, length: secret.length, consonantOnly: true, rank: 10, difficulty: 30, approved: true };
}

export const PUZZLES = [
  puzzle('KABAK', ['KAPAK'], 2),
  puzzle('YÜREK', ['KÜREK'], 0),
  puzzle('KAĞIT', ['KAYIT'], 2),
  puzzle('ŞEHİR', ['ŞEHİT'], 4),
  puzzle('TANIM', ['TARIM'], 2),
  puzzle('BAVUL', ['DAVUL'], 0),
  puzzle('KALAN', ['YALAN'], 0),
];

export function testConfig(overrides = {}) {
  const config = loadConfig({ dev: false });
  return { ...config, ...overrides, chaos: { ...config.chaos, ...(overrides.chaos || {}) } };
}

/** Oyuncuları katılmış, takım adı belirlenmiş bir oda kurar. */
export function makeRoom({ players = 3, config = testConfig({ chaos: { startWord: 999 } }), seed = Number(process.env.TEST_SEED || 7), puzzles = PUZZLES, store = new TeamStore() } = {}) {
  const clock = new FakeClock();
  const sent = [];
  const room = new Room({
    code: 'TEST',
    config,
    dictionary: Dictionary.fromWords(WORDS, CATEGORIES),
    puzzles: new PuzzleBank(puzzles, config),
    store,
    clock,
    rng: seeded(seed),
    send: (to, msg) => sent.push({ to, msg: typeof msg === 'string' ? JSON.parse(msg) : msg }),
  });
  const ps = [];
  for (let i = 0; i < players; i++) ps.push(room.join({ name: `Oyuncu${i + 1}` }));
  room.handle(ps[0].id, { type: 'set_team', name: 'Test Takımı' });
  const h = {
    room,
    clock,
    sent,
    ps,
    store,
    captain: () => room.players.get(room.word.captainId),
    guessers: () => room.guessers(),
    secret: () => room.word.puzzle.secret,
    trap: () => room.word.puzzle.traps[0],
    /** Bir kelimeyi kurulumdan sinyal aşamasına getirir. */
    toSignal() {
      clock.advance(config.setupSeconds * 1000);
    },
    signal(word) {
      room.handle(h.captain().id, { type: 'send_signal', word });
    },
    /** Tüm tahmincilerle (rate limit'e takılmadan) tahmin gönderir. */
    guess(word) {
      const gs = h.guessers();
      room.handle(gs[0].id, { type: 'propose_guess', word });
      const prop = room.word?.proposals.find((p) => p.word === word);
      if (prop) for (const g of gs.slice(1)) room.handle(g.id, { type: 'approve', proposalId: prop.id });
      clock.advance(config.proposalRateLimitMs);
    },
    errors: (playerId) => sent.filter((m) => m.to === playerId && m.msg.type === 'error').map((m) => m.msg.code),
    lastError(playerId) {
      const e = h.errors(playerId);
      return e[e.length - 1];
    },
  };
  return h;
}
