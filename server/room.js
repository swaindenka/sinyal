// SİNYAL v2 oda ve oyun motoru. Sunucu otoriterdir; kurallar docs/TASARIM.md'de.
//
//   LOBBY → SIGNAL → GUESS → (boş/pas: SIGNAL) … → REVEAL → SIGNAL (sonraki tur) … → END
import { randomBytes } from 'node:crypto';
import { normalize, cleanLabel } from './turkish.js';
import { GameError } from './errors.js';

export { GameError };

export const Phase = Object.freeze({
  LOBBY: 'LOBBY',
  SIGNAL: 'SIGNAL',
  GUESS: 'GUESS',
  REVEAL: 'REVEAL',
  END: 'END',
});

/** Sayaç işleyen aşamalar: oyuncu eksilince donar. */
const PLAY_PHASES = new Set([Phase.SIGNAL, Phase.GUESS, Phase.REVEAL]);
export const PASS = 'pass';

const NAME_MAX = 16;
const TEAM_MAX = 24;
const COLORS = 8;
const EVENTS_KEPT = 30;

export const TEAM_SUGGESTIONS = ['Kartallar', 'Sinyalciler', 'Gece Kuşları', 'Frekans', 'Kuzey Yıldızı', 'Fenerciler', 'Telsizciler', 'Dalga Boyu', 'Pusula', 'Radar'];

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

function emptyStats() {
  return { captainRounds: 0, captainHits: 0, captainPoints: 0 };
}

export class Room {
  constructor({ code, config, deck, store, clock = realClock, rng = Math.random, send = () => {}, disconnectPlayer = () => {}, onEmpty = () => {} }) {
    this.code = code;
    this.config = config;
    this.deck = deck;
    this.store = store;
    this.clock = clock;
    this.rng = rng;
    this.sendFn = send;
    this.disconnectPlayerFn = disconnectPlayer;
    this.onEmpty = onEmpty;

    this.players = new Map();
    this.order = []; // kaptan sırası
    this.hostId = null;
    this.hostTimer = null;
    this.teamName = TEAM_SUGGESTIONS[Math.floor(rng() * TEAM_SUGGESTIONS.length)];

    this.phase = Phase.LOBBY;
    this.endsAt = null;
    this.phaseMs = null;
    this.frozenRemaining = null;
    this.waiting = false;
    this.phaseTimer = null;
    this.timerToken = 0;
    this.lockTimer = null;

    this.runSeq = 0;
    this.run = null;
    this.round = null;
    this.summary = null;

    this.events = [];
    this.eventSeq = 0;
    this.idSeq = 0;
    this.broadcastQueued = false;
    this.closed = false;
    this.emptySince = null;
  }

  // ───────────────────────── yardımcılar ─────────────────────────

  now() {
    return this.clock.now();
  }

  setTimer(fn, ms) {
    return this.clock.setTimeout(() => {
      if (this.closed) return;
      fn();
      this.changed();
    }, ms);
  }

  clearTimer(h) {
    if (h) this.clock.clearTimeout(h);
  }

  send(playerId, msg) {
    this.sendFn(playerId, msg);
  }

  emit(type, data = {}) {
    this.events.push({ seq: ++this.eventSeq, type, at: this.now(), ...data });
    if (this.events.length > EVENTS_KEPT) this.events.shift();
  }

  /** Aynı anda gelen değişiklikler tek yayında gider. */
  changed() {
    if (this.broadcastQueued || this.closed) return;
    this.broadcastQueued = true;
    queueMicrotask(() => {
      this.broadcastQueued = false;
      this.broadcast();
    });
  }

  broadcast() {
    if (this.closed) return;
    const payload = JSON.stringify(this.publicState());
    for (const p of this.players.values()) if (p.connected) this.send(p.id, payload);
  }

  activePlayers() {
    return [...this.players.values()].filter((p) => !p.left);
  }

  connectedPlayers() {
    return this.activePlayers().filter((p) => p.connected);
  }

  /** Bağlı tahminciler (kaptan hariç). */
  guessers() {
    const captainId = this.round?.captainId;
    return this.connectedPlayers().filter((p) => p.id !== captainId);
  }

  isCaptain(playerId) {
    return Boolean(this.round) && this.round.captainId === playerId;
  }

  levelFor(roundNo) {
    let level = this.config.levels[0];
    let index = 0;
    this.config.levels.forEach((l, i) => {
      if (roundNo >= l.from) {
        level = l;
        index = i;
      }
    });
    return { ...level, index };
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  nameTaken(name, exceptId = null) {
    const key = normalize(name);
    return this.activePlayers().some((p) => p.id !== exceptId && normalize(p.name) === key);
  }

  freeColor() {
    const used = new Set(this.activePlayers().map((p) => p.color));
    for (let c = 0; c < COLORS; c++) if (!used.has(c)) return c;
    return 0;
  }

  // ───────────────────────── katılma / bağlantı ─────────────────────────

  join({ name, token } = {}) {
    const cleanName = cleanLabel(name, NAME_MAX);
    if (token) {
      const existing = [...this.players.values()].find((p) => p.token === token);
      if (existing) return this.rejoin(existing, cleanName);
    }
    if (!cleanName) throw new GameError('NAME_INVALID');
    if (this.nameTaken(cleanName)) throw new GameError('NAME_TAKEN');
    if (this.activePlayers().length >= this.config.maxPlayers) throw new GameError('ROOM_FULL');
    const p = {
      id: `p${++this.idSeq}`,
      token: randomBytes(16).toString('hex'),
      name: cleanName,
      color: this.freeColor(),
      connected: true,
      left: false,
      kicked: false,
      leaveTimer: null,
      lastTokenAt: -Infinity,
      stats: emptyStats(),
    };
    this.players.set(p.id, p);
    this.order.push(p.id); // oyun sırasında gelen, sıranın sonuna eklenir ve tahminci başlar
    if (!this.hostId || this.players.get(this.hostId)?.left) this.hostId = p.id;
    this.emit('join', { playerId: p.id, name: p.name });
    this.afterConnectionChange();
    this.changed();
    return p;
  }

  rejoin(p, name) {
    if (p.kicked) throw new GameError('KICKED');
    if (p.left) {
      if (this.activePlayers().length >= this.config.maxPlayers) throw new GameError('ROOM_FULL');
      const newName = name || p.name;
      if (this.nameTaken(newName, p.id)) throw new GameError('NAME_TAKEN');
      p.name = newName;
      p.left = false;
      p.color = this.freeColor();
      this.order.push(p.id);
    }
    p.connected = true;
    this.clearTimer(p.leaveTimer);
    p.leaveTimer = null;
    if (this.hostId === p.id) {
      this.clearTimer(this.hostTimer);
      this.hostTimer = null;
    }
    if (!this.hostId || this.players.get(this.hostId)?.left) this.hostId = p.id;
    this.afterConnectionChange();
    this.changed();
    return p;
  }

  disconnect(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.connected) return;
    p.connected = false;
    p.leaveTimer = this.setTimer(() => this.markLeft(playerId), this.config.playerReconnectSeconds * 1000);
    if (this.hostId === playerId) {
      this.clearTimer(this.hostTimer);
      this.hostTimer = this.setTimer(() => this.transferHost(), this.config.hostGraceSeconds * 1000);
    }
    this.emit('disconnect', { playerId, name: p.name });
    this.afterConnectionChange();
    this.changed();
  }

  /** Oyuncu kalıcı olarak ayrılır ("Ayrıl", çıkarılma ya da bağlantı süresi doldu). */
  markLeft(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.left) return;
    p.left = true;
    p.connected = false;
    this.clearTimer(p.leaveTimer);
    p.leaveTimer = null;
    const idx = this.order.indexOf(playerId);
    if (idx >= 0) {
      this.order.splice(idx, 1);
      if (this.run && idx <= this.run.captainCursor) this.run.captainCursor -= 1;
    }
    this.round?.tokens.delete(playerId);
    if (!this.activePlayers().length) {
      this.close();
      this.onEmpty(this);
      return;
    }
    if (this.hostId === playerId) this.transferHost(true);
    this.emit('leave', { playerId, name: p.name });
    if (this.isCaptain(playerId) && (this.phase === Phase.SIGNAL || this.phase === Phase.GUESS)) this.cancelRound('captain_left');
    this.afterConnectionChange();
    this.changed();
  }

  transferHost(force = false) {
    this.clearTimer(this.hostTimer);
    this.hostTimer = null;
    const current = this.players.get(this.hostId);
    if (!force && current && current.connected && !current.left) return;
    const start = Math.max(0, this.order.indexOf(this.hostId) + 1);
    const n = this.order.length;
    for (let k = 0; k < n; k++) {
      const p = this.players.get(this.order[(start + k) % n]);
      if (p && p.connected && p.id !== this.hostId) {
        this.hostId = p.id;
        this.emit('host', { playerId: p.id });
        return;
      }
    }
    if (!current || current.left) this.hostId = this.order[0] ?? null;
  }

  afterConnectionChange() {
    this.updateWaiting();
    this.checkConsensus();
  }

  /** Bağlı oyuncu sayısı alt sınırın altındaysa sayaç donar (oyuncu beklenir). */
  updateWaiting() {
    const waiting = PLAY_PHASES.has(this.phase) && this.connectedPlayers().length < this.config.minPlayers;
    if (waiting === this.waiting) return;
    this.waiting = waiting;
    if (waiting) {
      this.frozenRemaining = this.endsAt != null ? Math.max(0, this.endsAt - this.now()) : null;
      this.clearTimer(this.phaseTimer);
      this.phaseTimer = null;
      this.timerToken++;
      this.endsAt = null;
      this.cancelLock();
    } else {
      const ms = this.frozenRemaining;
      this.frozenRemaining = null;
      // Kalan süre çok azsa oyunculara toparlanma payı bırak.
      if (ms != null) this.schedule(Math.max(ms, 5000));
    }
  }

  // ───────────────────────── sayaçlar ─────────────────────────

  setPhase(phase, seconds) {
    this.clearTimer(this.phaseTimer);
    this.phaseTimer = null;
    this.timerToken++;
    this.phase = phase;
    this.endsAt = null;
    this.frozenRemaining = null;
    this.phaseMs = seconds == null ? null : seconds * 1000;
    this.waiting = false;
    this.updateWaiting();
    if (seconds == null) return;
    if (this.waiting) this.frozenRemaining = this.phaseMs;
    else this.schedule(this.phaseMs);
  }

  schedule(ms) {
    const token = ++this.timerToken;
    this.endsAt = this.now() + ms;
    this.clearTimer(this.phaseTimer);
    this.phaseTimer = this.setTimer(() => {
      if (token !== this.timerToken) return;
      this.phaseTimer = null;
      this.endsAt = null;
      this.onTimeout();
    }, ms);
  }

  onTimeout() {
    if (this.phase === Phase.SIGNAL) this.signalTimeout();
    else if (this.phase === Phase.GUESS) this.resolveByPlurality();
    else if (this.phase === Phase.REVEAL) this.afterReveal();
  }

  // ───────────────────────── gizli bilgi ─────────────────────────

  /** Kartların rolleri ve el yalnızca kaptana gider. */
  sendPrivate(playerId) {
    const r = this.round;
    if (!r || r.captainId !== playerId || !(this.phase === Phase.SIGNAL || this.phase === Phase.GUESS)) return;
    this.send(playerId, {
      type: 'captain',
      key: r.key,
      roles: r.board.map((c) => c.role),
      hand: [...r.hand],
      redraws: r.redraws,
    });
  }

  // ───────────────────────── mesajlar ─────────────────────────

  handle(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p || p.left || this.closed) return;
    try {
      switch (msg.type) {
        case 'set_team':
          this.setTeam(p, msg.name);
          break;
        case 'move':
          this.movePlayer(p, msg.playerId, msg.dir);
          break;
        case 'shuffle':
          this.shuffleOrder(p);
          break;
        case 'kick':
          this.kick(p, msg.playerId);
          break;
        case 'start':
          this.start(p);
          break;
        case 'to_lobby':
          this.toLobby(p);
          break;
        case 'play_signal':
          this.playSignal(p, msg.word);
          break;
        case 'redraw':
          this.redraw(p);
          break;
        case 'token':
          this.placeToken(p, msg.target);
          break;
        case 'next':
          this.skipReveal(p);
          break;
        case 'leave':
          this.markLeft(p.id);
          return;
        default:
          throw new GameError('UNKNOWN_MESSAGE');
      }
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      this.send(playerId, { type: 'error', code: err.code, about: msg.type });
      return;
    }
    this.changed();
  }

  requireHost(p) {
    if (p.id !== this.hostId) throw new GameError('NOT_HOST');
  }

  requirePhase(...phases) {
    if (!phases.includes(this.phase)) throw new GameError('BAD_PHASE');
  }

  // ───────────────────────── lobi ─────────────────────────

  setTeam(p, name) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    const clean = cleanLabel(name, TEAM_MAX);
    if (!clean) throw new GameError('TEAM_INVALID');
    this.teamName = clean;
  }

  movePlayer(p, targetId, dir) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    const i = this.order.indexOf(targetId);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.order.length) throw new GameError('BAD_MOVE');
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
  }

  shuffleOrder(p) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    this.shuffle(this.order);
  }

  kick(p, targetId) {
    this.requireHost(p);
    const target = this.players.get(targetId);
    if (!target || target.left || target.id === p.id) throw new GameError('BAD_TARGET');
    target.kicked = true;
    this.disconnectPlayerFn(target.id);
    this.emit('kick', { playerId: target.id, name: target.name });
    this.markLeft(target.id);
  }

  start(p) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    if (this.connectedPlayers().length < this.config.minPlayers) throw new GameError('NOT_ENOUGH_PLAYERS');
    this.startRun();
  }

  toLobby(p) {
    this.requireHost(p);
    this.requirePhase(Phase.END);
    this.summary = null;
    this.run = null;
    this.round = null;
    this.setPhase(Phase.LOBBY, null);
  }

  // ───────────────────────── oyun akışı ─────────────────────────

  startRun() {
    const c = this.config;
    this.run = {
      id: ++this.runSeq,
      score: 0,
      lives: c.lives,
      maxLives: c.lives,
      hits: 0,
      firstTry: 0,
      roundNo: 0,
      captainCursor: -1,
      used: new Set(),
      history: [],
      startedAt: this.now(),
    };
    for (const p of this.players.values()) p.stats = emptyStats();
    this.summary = null;
    this.emit('run_start');
    this.startRound();
  }

  nextCaptain() {
    const run = this.run;
    const n = this.order.length;
    for (let k = 1; k <= n; k++) {
      const idx = (run.captainCursor + k + n) % n;
      const p = this.players.get(this.order[idx]);
      if (p?.connected) {
        run.captainCursor = idx;
        return p;
      }
    }
    run.captainCursor = (run.captainCursor + 1 + n) % n;
    return this.players.get(this.order[run.captainCursor]);
  }

  startRound() {
    const c = this.config;
    const run = this.run;
    run.roundNo += 1;
    const level = this.levelFor(run.roundNo);
    const captain = this.nextCaptain();
    const board = this.deck.board(level, { size: c.boardSize, rng: this.rng, used: run.used });
    for (const card of board) run.used.add(card.word);
    this.round = {
      key: `${run.id}:${run.roundNo}`,
      no: run.roundNo,
      level,
      captainId: captain.id,
      board: board.map((card) => ({ ...card, revealed: false, pickedAt: null })),
      signals: [],
      hand: [],
      redraws: c.redrawsPerRound,
      tokens: new Map(),
      lock: null,
      picks: [],
      result: null,
    };
    this.round.hand = this.deck.draw({ count: c.handSize, nitelik: c.handNitelik, avoid: board.map((b) => b.word), rng: this.rng });
    captain.stats.captainRounds += 1;
    this.emit('round', { no: run.roundNo, captainId: captain.id, level: level.name });
    this.enterSignal();
  }

  enterSignal() {
    const r = this.round;
    r.tokens.clear();
    this.cancelLock();
    this.setPhase(Phase.SIGNAL, r.level.signalSeconds ?? this.config.signalSeconds);
    this.sendPrivate(r.captainId);
  }

  enterGuess() {
    const r = this.round;
    r.tokens.clear();
    this.cancelLock();
    this.setPhase(Phase.GUESS, r.level.guessSeconds ?? this.config.guessSeconds);
    this.sendPrivate(r.captainId);
  }

  /** Oynanan kartın yerine aynı türden (nitelik / kart) yenisi gelir. */
  refill(r, played) {
    const isNitelik = this.deck.nitelik.includes(played);
    const avoid = [...r.board.map((b) => b.word), ...r.hand, ...r.signals.map((s) => s.word)];
    const [card] = this.deck.draw({ count: 1, nitelik: isNitelik ? 1 : 0, avoid, rng: this.rng });
    if (card) r.hand.push(card);
  }

  commitSignal(word, auto) {
    const r = this.round;
    const idx = r.hand.indexOf(word);
    r.hand.splice(idx, 1);
    r.signals.push({ word, auto });
    this.refill(r, word);
    this.emit('signal', { word, n: r.signals.length, captainId: r.captainId, auto });
    this.enterGuess();
  }

  playSignal(p, raw) {
    this.requirePhase(Phase.SIGNAL);
    if (!this.isCaptain(p.id)) throw new GameError('NOT_CAPTAIN');
    if (this.waiting) throw new GameError('WAITING_PLAYERS');
    const word = normalize(raw);
    if (!this.round.hand.includes(word)) throw new GameError('NOT_IN_HAND');
    this.commitSignal(word, false);
  }

  signalTimeout() {
    const r = this.round;
    const captain = this.players.get(r.captainId);
    if (!captain?.connected) {
      this.cancelRound('captain_away');
      return;
    }
    const word = r.hand[Math.floor(this.rng() * r.hand.length)];
    this.commitSignal(word, true);
  }

  redraw(p) {
    this.requirePhase(Phase.SIGNAL);
    if (!this.isCaptain(p.id)) throw new GameError('NOT_CAPTAIN');
    const r = this.round;
    if (r.redraws <= 0) throw new GameError('NO_REDRAWS');
    const c = this.config;
    const avoid = [...r.board.map((b) => b.word), ...r.signals.map((s) => s.word), ...r.hand];
    const hand = this.deck.draw({ count: c.handSize, nitelik: c.handNitelik, avoid, rng: this.rng });
    if (hand.length < c.handSize) throw new GameError('DECK_EMPTY');
    r.hand = hand;
    r.redraws -= 1;
    this.emit('redraw', { captainId: p.id });
    this.sendPrivate(p.id);
  }

  placeToken(p, target) {
    this.requirePhase(Phase.GUESS);
    if (this.isCaptain(p.id)) throw new GameError('CAPTAIN_CANNOT_PICK');
    const r = this.round;
    const now = this.now();
    if (now - p.lastTokenAt < (this.config.tokenRateLimitMs ?? 0)) throw new GameError('RATE_LIMITED');
    p.lastTokenAt = now;
    if (target === null || target === undefined) {
      r.tokens.delete(p.id);
    } else if (target === PASS) {
      r.tokens.set(p.id, PASS);
    } else {
      const i = Number(target);
      if (!Number.isInteger(i) || i < 0 || i >= r.board.length || r.board[i].revealed) throw new GameError('BAD_TARGET');
      r.tokens.set(p.id, i);
    }
    this.checkConsensus();
  }

  /** Bütün bağlı tahmincilerin jetonu aynı yerdeyse geri sayım başlar; biri ayrılırsa durur. */
  checkConsensus() {
    const r = this.round;
    if (this.phase !== Phase.GUESS || !r || this.waiting) {
      this.cancelLock();
      return;
    }
    const gs = this.guessers();
    let target;
    for (const g of gs) {
      const t = r.tokens.get(g.id);
      if (t === undefined || (target !== undefined && t !== target)) {
        this.cancelLock();
        return;
      }
      target = t;
    }
    if (target === undefined) {
      this.cancelLock();
      return;
    }
    if (r.lock && r.lock.target === target) return;
    this.cancelLock();
    const ms = this.config.lockSeconds * 1000;
    r.lock = { target, endsAt: this.now() + ms };
    this.lockTimer = this.setTimer(() => {
      this.lockTimer = null;
      this.resolvePick(target, 'consensus');
    }, ms);
  }

  cancelLock() {
    this.clearTimer(this.lockTimer);
    this.lockTimer = null;
    if (this.round) this.round.lock = null;
  }

  /** Karar süresi doldu: en çok jetonun olduğu yer seçilir; eşitlik ya da boşluk pas sayılır. */
  resolveByPlurality() {
    const r = this.round;
    const counts = new Map();
    for (const g of this.guessers()) {
      const t = r.tokens.get(g.id);
      if (t !== undefined) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let best = null;
    let bestN = 0;
    let tie = false;
    for (const [t, n] of counts) {
      if (n > bestN) {
        best = t;
        bestN = n;
        tie = false;
      } else if (n === bestN) tie = true;
    }
    this.resolvePick(best === null || tie ? PASS : best, 'timeout');
  }

  resolvePick(target, reason) {
    const r = this.round;
    const run = this.run;
    this.cancelLock();
    const n = r.signals.length;
    if (target === PASS) {
      r.picks.push({ pass: true, reason });
      this.emit('pass', { reason, n });
      this.nextSignalOrFail();
      return;
    }
    const card = r.board[target];
    card.revealed = true;
    card.pickedAt = n;
    r.picks.push({ index: target, word: card.word, role: card.role, reason });
    this.emit('flip', { index: target, word: card.word, role: card.role, reason, n });
    if (card.role === 'target') {
      const pts = this.config.points;
      const points = pts[Math.min(n, pts.length) - 1] ?? 0;
      run.score += points;
      run.hits += 1;
      if (n === 1) run.firstTry += 1;
      const captain = this.players.get(r.captainId);
      if (captain) {
        captain.stats.captainHits += 1;
        captain.stats.captainPoints += points;
      }
      let lifeGain = false;
      const every = this.config.lifeEveryHits;
      if (every && run.hits % every === 0 && run.lives < run.maxLives) {
        run.lives += 1;
        lifeGain = true;
      }
      this.endRound('hit', { points, lifeGain, index: target });
    } else if (card.role === 'parasite') {
      run.lives -= 1;
      this.endRound('parasite', { index: target });
    } else {
      this.nextSignalOrFail();
    }
  }

  nextSignalOrFail() {
    const r = this.round;
    if (r.signals.length >= this.config.maxSignals) {
      this.run.lives -= 1;
      this.endRound('silence', {});
    } else {
      this.enterSignal();
    }
  }

  endRound(kind, extra) {
    const r = this.round;
    const run = this.run;
    r.tokens.clear();
    r.result = { kind, points: 0, lifeGain: false, ...extra };
    const captain = this.players.get(r.captainId);
    run.history.push({
      no: r.no,
      level: r.level.name,
      captainId: r.captainId,
      captainName: captain?.name ?? '?',
      signals: r.signals.map((s) => s.word),
      target: r.board.find((c) => c.role === 'target')?.word,
      picks: r.picks.filter((pk) => !pk.pass).map((pk) => ({ word: pk.word, role: pk.role })),
      kind,
      points: r.result.points,
    });
    this.emit('round_end', { kind, points: r.result.points, lives: run.lives, lifeGain: r.result.lifeGain, no: r.no });
    this.setPhase(Phase.REVEAL, this.config.revealSeconds);
  }

  /** Kaptan koptu ya da ayrıldı: tur cezasız yenilenir. */
  cancelRound(reason) {
    this.endRound('cancelled', { reason });
  }

  skipReveal(p) {
    this.requireHost(p);
    this.requirePhase(Phase.REVEAL);
    if (this.waiting) throw new GameError('WAITING_PLAYERS');
    this.afterReveal();
  }

  afterReveal() {
    if (this.run.lives <= 0) this.endRun();
    else this.startRound();
  }

  endRun() {
    const run = this.run;
    const record = this.store.recordRun(this.teamName, run.score);
    let bestCaptain = null;
    for (const id of this.order) {
      const p = this.players.get(id);
      if (!p || !p.stats.captainRounds) continue;
      const s = p.stats;
      if (!bestCaptain || s.captainPoints > bestCaptain.points || (s.captainPoints === bestCaptain.points && s.captainHits > bestCaptain.hits)) {
        bestCaptain = { playerId: p.id, name: p.name, points: s.captainPoints, hits: s.captainHits, rounds: s.captainRounds };
      }
    }
    this.summary = {
      score: run.score,
      rounds: run.roundNo,
      hits: run.hits,
      firstTry: run.firstTry,
      record,
      bestCaptain: bestCaptain && bestCaptain.points > 0 ? bestCaptain : null,
      history: run.history,
      durationMs: this.now() - run.startedAt,
    };
    this.round = null;
    this.emit('run_end', { score: run.score, newRecord: record.isNewRecord });
    this.setPhase(Phase.END, null);
  }

  // ───────────────────────── durum ─────────────────────────

  publicState() {
    const r = this.round;
    const run = this.run;
    const reveal = this.phase === Phase.REVEAL;
    const team = this.store.peekTeam(this.teamName);
    return {
      type: 'state',
      code: this.code,
      phase: this.phase,
      serverNow: this.now(),
      endsAt: this.endsAt,
      phaseMs: this.phaseMs,
      waiting: this.waiting,
      hostId: this.hostId,
      teamName: this.teamName,
      minPlayers: this.config.minPlayers,
      maxPlayers: this.config.maxPlayers,
      players: this.order
        .map((id) => this.players.get(id))
        .filter(Boolean)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, connected: p.connected })),
      record: team ? { bestScore: team.bestScore, runs: team.runs } : null,
      run: run && {
        id: run.id,
        score: run.score,
        lives: run.lives,
        maxLives: run.maxLives,
        hits: run.hits,
        roundNo: run.roundNo,
        lifeEveryHits: this.config.lifeEveryHits,
        history: run.history,
      },
      round: r && {
        key: r.key,
        no: r.no,
        level: { name: r.level.name, index: r.level.index, parasites: r.board.filter((c) => c.role === 'parasite').length },
        captainId: r.captainId,
        board: r.board.map((c) => ({ word: c.word, revealed: c.revealed, role: c.revealed || reveal ? c.role : null })),
        signals: r.signals,
        maxSignals: this.config.maxSignals,
        points: this.config.points,
        handCount: r.hand.length,
        redraws: r.redraws,
        tokens: Object.fromEntries(r.tokens),
        lock: r.lock,
        result: r.result,
      },
      summary: this.summary,
      events: this.events,
    };
  }

  close() {
    this.closed = true;
    this.clearTimer(this.phaseTimer);
    this.clearTimer(this.lockTimer);
    this.clearTimer(this.hostTimer);
    for (const p of this.players.values()) this.clearTimer(p.leaveTimer);
  }
}
