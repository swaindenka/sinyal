import { loadConfig } from '../server/config.js';
import { Deck } from '../server/deck.js';
import { Room, PASS } from '../server/room.js';
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

/** Gerçek deste; testler kelimelere değil rollere bakar. */
export const deck = Deck.load();

export function testConfig(overrides = {}) {
  return { ...loadConfig(), tokenRateLimitMs: 0, ...overrides };
}

export function makeRoom({ players = 3, config = testConfig(), seed = Number(process.env.TEST_SEED || 7), store = new TeamStore() } = {}) {
  const clock = new FakeClock();
  const sent = [];
  const room = new Room({
    code: 'TEST',
    config,
    deck,
    store,
    clock,
    rng: seeded(seed),
    send: (to, msg) => sent.push({ to, msg: typeof msg === 'string' ? JSON.parse(msg) : msg }),
  });
  const ps = [];
  for (let i = 0; i < players; i++) ps.push(room.join({ name: `Oyuncu${i + 1}` }));
  const h = {
    room,
    clock,
    sent,
    ps,
    store,
    config,
    host: () => room.players.get(room.hostId),
    captain: () => room.players.get(room.round.captainId),
    guessers: () => room.guessers(),
    roleIndex: (role) => room.round.board.findIndex((c) => c.role === role && !c.revealed),
    start() {
      room.handle(room.hostId, { type: 'start' });
    },
    /** Kaptan elinin ilk kartını oynar. */
    signal() {
      const cap = h.captain();
      room.handle(cap.id, { type: 'play_signal', word: room.round.hand[0] });
    },
    /** Bütün tahminciler aynı yere jeton koyar ve kilit süresi dolar. */
    pick(target) {
      for (const g of h.guessers()) room.handle(g.id, { type: 'token', target });
      clock.advance(config.lockSeconds * 1000);
    },
    pickRole(role) {
      h.pick(h.roleIndex(role));
    },
    pass() {
      h.pick(PASS);
    },
    lastPrivate(playerId, type) {
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i].to === playerId && sent[i].msg.type === type) return sent[i].msg;
      return null;
    },
    errors: (playerId) => sent.filter((m) => m.to === playerId && m.msg.type === 'error').map((m) => m.msg.code),
    lastError(playerId) {
      const e = h.errors(playerId);
      return e[e.length - 1];
    },
    state: () => room.publicState(),
  };
  return h;
}
