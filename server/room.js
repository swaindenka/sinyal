// SİNYAL oda ve oyun motoru. Sunucu otoriterdir; kurallar docs/TASARIM.md'de.
//
//   LOBBY → SIGNAL → GUESS → (boş/pas: SIGNAL) … → [STEAL] → REVEAL → SIGNAL (sonraki tur) … → END
//
// İki mod: 'coop' (bütün oyuncular tek takım, canlarla rekor kovalar) ve 'duel' (iki takım sırayla
// oynar; hata yapan takımın kartını rakip takım çalmaya çalışır).
import { randomBytes } from 'node:crypto';
import { normalize, cleanLabel } from './turkish.js';
import { GameError } from './errors.js';

export { GameError };

export const Phase = Object.freeze({
  LOBBY: 'LOBBY',
  SIGNAL: 'SIGNAL',
  GUESS: 'GUESS',
  STEAL: 'STEAL',
  REVEAL: 'REVEAL',
  END: 'END',
});

/** Sayaç işleyen aşamalar: oyuncu eksilince donar. */
const PLAY_PHASES = new Set([Phase.SIGNAL, Phase.GUESS, Phase.STEAL, Phase.REVEAL]);
export const PASS = 'pass';
export const MODES = ['coop', 'duel'];
/** Kart işaretleri: 'cand' = aday (düşündüğüm kart), 'out' = ele (bu değil). Jetondan bağımsızdır. */
export const MARKS = ['cand', 'out'];
export const DUEL_TEAMS = ['MAVİ', 'TURUNCU'];

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

/** Bireysel puan: kaptanın takımına kazandırdığı puan + öncü jetonlar (+1) − tuzağa ilk girişler (−1). */
function emptyStats() {
  return { captainRounds: 0, captainHits: 0, captainPoints: 0, points: 0, firsts: 0, traps: 0, steals: 0 };
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
    this.mode = MODES.includes(config.defaultMode) ? config.defaultMode : 'coop';

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

  /**
   * Şu an jeton koyabilecek bağlı oyuncular: tahmin aşamasında kaptan dışındakiler (düelloda yalnızca
   * sırası gelen takım), çalma aşamasında rakip takımın hepsi.
   */
  guessers() {
    const r = this.round;
    if (!r) return [];
    return this.connectedPlayers().filter((p) => this.canPick(p));
  }

  canPick(p) {
    const r = this.round;
    if (!r || p.left) return false;
    if (this.phase === Phase.STEAL) return r.steal != null && p.team === r.steal.team;
    if (p.id === r.captainId) return false;
    return r.team == null || p.team === r.team;
  }

  isDuel() {
    return (this.run?.mode ?? this.mode) === 'duel';
  }

  teamCounts(onlyConnected = false) {
    const counts = [0, 0];
    for (const p of onlyConnected ? this.connectedPlayers() : this.activePlayers()) if (p.team === 0 || p.team === 1) counts[p.team] += 1;
    return counts;
  }

  /** Yeni gelen oyuncu kalabalık olmayan takıma girer (eşitlikte Mavi). */
  smallerTeam() {
    const [a, b] = this.teamCounts();
    return b < a ? 1 : 0;
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
      team: this.smallerTeam(),
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
      p.team = this.smallerTeam();
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
      if (this.run) {
        if (idx <= this.run.captainCursor) this.run.captainCursor -= 1;
        this.run.teamCursors = this.run.teamCursors.map((c) => (idx <= c ? c - 1 : c));
      }
    }
    this.round?.tokens.delete(playerId);
    this.round?.marks.delete(playerId);
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
    else if (this.phase === Phase.GUESS || this.phase === Phase.STEAL) this.resolveByPlurality();
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
        case 'set_mode':
          this.setMode(p, msg.mode);
          break;
        case 'set_player_team':
          this.setPlayerTeam(p, msg.playerId, msg.team);
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
        case 'mark':
          this.setMark(p, msg.index, msg.mark);
          break;
        case 'mark_clear':
          this.clearMarks(p);
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

  setMode(p, mode) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    if (!MODES.includes(mode)) throw new GameError('BAD_MODE');
    this.mode = mode;
  }

  setPlayerTeam(p, targetId, team) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    const target = this.players.get(targetId);
    if (!target || target.left || (team !== 0 && team !== 1)) throw new GameError('BAD_TARGET');
    target.team = team;
  }

  movePlayer(p, targetId, dir) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    const i = this.order.indexOf(targetId);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.order.length) throw new GameError('BAD_MOVE');
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
  }

  /** Sırayı karıştırır; düelloda takımları da yeniden dengeli dağıtır. */
  shuffleOrder(p) {
    this.requireHost(p);
    this.requirePhase(Phase.LOBBY, Phase.END);
    this.shuffle(this.order);
    if (this.mode === 'duel') this.order.forEach((id, i) => (this.players.get(id).team = i % 2));
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
    if (this.mode === 'duel') {
      if (this.connectedPlayers().length < (this.config.duelMinPlayers ?? 4)) throw new GameError('NOT_ENOUGH_PLAYERS');
      if (this.teamCounts(true).some((n) => n < 2)) throw new GameError('TEAMS_UNBALANCED');
    } else if (this.connectedPlayers().length < this.config.minPlayers) throw new GameError('NOT_ENOUGH_PLAYERS');
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
    const duel = this.mode === 'duel';
    this.run = {
      id: ++this.runSeq,
      mode: this.mode,
      score: 0,
      lives: c.lives,
      maxLives: c.lives,
      teamScores: [0, 0],
      totalRounds: duel ? 2 * (c.duelRoundsPerTeam ?? 4) : null,
      hits: 0,
      firstTry: 0,
      lightnings: 0,
      steals: 0,
      roundNo: 0,
      captainCursor: -1,
      teamCursors: [-1, -1],
      used: new Set(),
      history: [],
      startedAt: this.now(),
    };
    for (const p of this.players.values()) p.stats = emptyStats();
    this.summary = null;
    this.emit('run_start', { mode: this.mode });
    this.startRound();
  }

  /** Sıradaki bağlı kaptan; düelloda yalnızca o takımın oyuncuları arasından. */
  nextCaptain(team = null) {
    const run = this.run;
    const n = this.order.length;
    const cursor = team == null ? run.captainCursor : run.teamCursors[team];
    const eligible = (p) => p && (team == null || p.team === team);
    let fallback = null;
    for (let k = 1; k <= n; k++) {
      const idx = (cursor + k + n) % n;
      const p = this.players.get(this.order[idx]);
      if (!eligible(p)) continue;
      fallback ??= { p, idx };
      if (p.connected) {
        this.setCursor(team, idx);
        return p;
      }
    }
    if (fallback) this.setCursor(team, fallback.idx);
    return fallback?.p ?? null;
  }

  setCursor(team, idx) {
    if (team == null) this.run.captainCursor = idx;
    else this.run.teamCursors[team] = idx;
  }

  /** Düelloda her iki takım da aynı zorlukla karşılaşır: her tur çifti bir seviye. */
  duelLevel(roundNo) {
    const levels = this.config.levels;
    const index = Math.min(Math.ceil(roundNo / 2) - 1, levels.length - 1);
    return { ...levels[index], index };
  }

  startRound() {
    const c = this.config;
    const run = this.run;
    run.roundNo += 1;
    const duel = run.mode === 'duel';
    const team = duel ? (run.roundNo - 1) % 2 : null;
    const level = duel ? this.duelLevel(run.roundNo) : this.levelFor(run.roundNo);
    const captain = this.nextCaptain(team);
    const size = level.boardSize ?? c.boardSize;
    const board = this.deck.board(level, { size, rng: this.rng, used: run.used });
    for (const card of board) run.used.add(card.word);
    this.round = {
      key: `${run.id}:${run.roundNo}`,
      no: run.roundNo,
      team,
      level,
      captainId: captain?.id ?? null,
      board: board.map((card) => ({ ...card, revealed: false, pickedAt: null })),
      signals: [],
      signalAt: null,
      hand: [],
      redraws: c.redrawsPerRound,
      tokens: new Map(),
      tokenAt: new Map(),
      marks: new Map(), // oyuncu → (kart → 'cand' | 'out')
      lock: null,
      picks: [],
      steal: null,
      result: null,
    };
    this.round.hand = this.drawHand(this.round, board.map((b) => b.word));
    if (captain) captain.stats.captainRounds += 1;
    this.emit('round', { no: run.roundNo, captainId: captain?.id ?? null, level: level.name, team });
    // Düelloda takımda kaptan + en az bir tahminci yoksa tur oynanamaz.
    if (duel && this.teamCounts(true)[team] < 2) {
      this.endRound('cancelled', { reason: 'team_short' });
      return;
    }
    this.enterSignal();
  }

  enterSignal() {
    const r = this.round;
    r.tokens.clear();
    r.tokenAt.clear();
    this.cancelLock();
    this.setPhase(Phase.SIGNAL, r.level.signalSeconds ?? this.config.signalSeconds);
    this.sendPrivate(r.captainId);
  }

  enterGuess() {
    const r = this.round;
    r.tokens.clear();
    r.tokenAt.clear();
    this.cancelLock();
    this.setPhase(Phase.GUESS, r.level.guessSeconds ?? this.config.guessSeconds);
    this.sendPrivate(r.captainId);
  }

  /** Tam el: sıfatlar + hedefin kategorisinden kart(lar) + karışık kartlar. */
  drawHand(r, avoid) {
    const c = this.config;
    const kinCategory = r.board.find((b) => b.role === 'target')?.category;
    return this.deck.draw({ count: c.handSize, nitelik: c.handNitelik, kin: c.handKin ?? 0, kinCategory, avoid, rng: this.rng });
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
    r.signalAt = this.now();
    this.refill(r, word);
    this.emit('signal', { word, n: r.signals.length, captainId: r.captainId, auto, team: r.team });
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
    const avoid = [...r.board.map((b) => b.word), ...r.signals.map((s) => s.word), ...r.hand];
    const hand = this.drawHand(r, avoid);
    if (hand.length < this.config.handSize) throw new GameError('DECK_EMPTY');
    r.hand = hand;
    r.redraws -= 1;
    this.emit('redraw', { captainId: p.id });
    this.sendPrivate(p.id);
  }

  placeToken(p, target) {
    this.requirePhase(Phase.GUESS, Phase.STEAL);
    if (!this.canPick(p)) throw new GameError(this.phase === Phase.GUESS && this.isCaptain(p.id) ? 'CAPTAIN_CANNOT_PICK' : 'NOT_YOUR_TURN');
    const r = this.round;
    const now = this.now();
    if (now - p.lastTokenAt < (this.config.tokenRateLimitMs ?? 0)) throw new GameError('RATE_LIMITED');
    p.lastTokenAt = now;
    if (target === null || target === undefined) {
      r.tokens.delete(p.id);
      r.tokenAt.delete(p.id);
    } else {
      let value = PASS;
      if (target !== PASS) {
        value = Number(target);
        if (!Number.isInteger(value) || value < 0 || value >= r.board.length || r.board[value].revealed) throw new GameError('BAD_TARGET');
      }
      if (r.tokens.get(p.id) !== value) r.tokenAt.set(p.id, now);
      r.tokens.set(p.id, value);
    }
    this.checkConsensus();
  }

  /**
   * İşaret: kaptan dışındaki herkes, tur boyunca (sinyal, tahmin ve çalma aşamalarında) açılmamış
   * kartlara istediği kadar aday / ele işareti koyar. Düelloda sırası gelmeyen takım da çalma için
   * hazırlık yapabilir; istemci yalnızca kendi takımının işaretlerini gösterir.
   */
  setMark(p, index, mark) {
    this.requirePhase(Phase.SIGNAL, Phase.GUESS, Phase.STEAL);
    const r = this.round;
    if (p.id === r.captainId) throw new GameError('CAPTAIN_CANNOT_PICK');
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= r.board.length || r.board[i].revealed) throw new GameError('BAD_TARGET');
    if (mark != null && !MARKS.includes(mark)) throw new GameError('BAD_MARK');
    const now = this.now();
    if (now - p.lastTokenAt < (this.config.tokenRateLimitMs ?? 0)) throw new GameError('RATE_LIMITED');
    p.lastTokenAt = now;
    let mine = r.marks.get(p.id);
    if (!mine) r.marks.set(p.id, (mine = new Map()));
    if (mark == null) mine.delete(i);
    else mine.set(i, mark);
    if (!mine.size) r.marks.delete(p.id);
  }

  clearMarks(p) {
    this.requirePhase(Phase.SIGNAL, Phase.GUESS, Phase.STEAL);
    this.round.marks.delete(p.id);
  }

  /** Açılan kartın işaretleri silinir. */
  dropMarks(index) {
    for (const [pid, mine] of this.round.marks) {
      mine.delete(index);
      if (!mine.size) this.round.marks.delete(pid);
    }
  }

  /** Bütün bağlı tahmincilerin jetonu aynı yerdeyse geri sayım başlar; biri ayrılırsa durur. */
  checkConsensus() {
    const r = this.round;
    if (!(this.phase === Phase.GUESS || this.phase === Phase.STEAL) || !r || this.waiting) {
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

  /** Karta jetonunu ilk koyan (açıldığı anda hâlâ orada olanlar arasından). */
  leaderOn(target) {
    const r = this.round;
    let best = null;
    for (const g of this.guessers()) {
      if (r.tokens.get(g.id) !== target) continue;
      const at = r.tokenAt.get(g.id) ?? 0;
      if (!best || at < best.at) best = { p: g, at };
    }
    return best?.p ?? null;
  }

  addTeamPoints(team, points) {
    if (this.run.mode === 'duel') this.run.teamScores[team] += points;
    else this.run.score += points;
  }

  resolvePick(target, reason) {
    if (this.phase === Phase.STEAL) {
      this.resolveSteal(target, reason);
      return;
    }
    const c = this.config;
    const r = this.round;
    const run = this.run;
    const lead = target === PASS ? null : this.leaderOn(target);
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
    this.dropMarks(target);
    r.picks.push({ index: target, word: card.word, role: card.role, reason });
    this.emit('flip', { index: target, word: card.word, role: card.role, reason, n, leaderId: lead?.id ?? null });
    if (card.role === 'target') {
      const base = c.points[Math.min(n, c.points.length) - 1] ?? 0;
      const lightning = (c.lightningSeconds ?? 0) > 0 && r.signalAt != null && this.now() - r.signalAt <= c.lightningSeconds * 1000;
      const bonus = lightning ? (c.lightningBonus ?? 1) : 0;
      const points = base + bonus;
      this.addTeamPoints(r.team, points);
      run.hits += 1;
      if (n === 1) run.firstTry += 1;
      if (lightning) run.lightnings += 1;
      const captain = this.players.get(r.captainId);
      if (captain) {
        captain.stats.captainHits += 1;
        captain.stats.captainPoints += points;
        captain.stats.points += points;
      }
      if (lead) {
        lead.stats.points += 1;
        lead.stats.firsts += 1;
      }
      let lifeGain = false;
      const every = c.lifeEveryHits;
      if (run.mode === 'coop' && every && run.hits % every === 0 && run.lives < run.maxLives) {
        run.lives += 1;
        lifeGain = true;
      }
      this.endRound('hit', { points, base, bonus, lightning, lifeGain, index: target, leaderId: lead?.id ?? null });
    } else if (card.role === 'parasite') {
      if (lead) {
        lead.stats.points -= 1;
        lead.stats.traps += 1;
      }
      if (run.mode === 'duel') {
        const penalty = c.duelParasitePenalty ?? 1;
        this.addTeamPoints(r.team, -penalty);
        this.enterSteal('parasite', { index: target, points: -penalty, leaderId: lead?.id ?? null });
      } else {
        run.lives -= 1;
        this.endRound('parasite', { index: target, leaderId: lead?.id ?? null });
      }
    } else {
      this.nextSignalOrFail();
    }
  }

  nextSignalOrFail() {
    const r = this.round;
    if (r.signals.length < this.config.maxSignals) {
      this.enterSignal();
      return;
    }
    if (this.run.mode === 'duel') this.enterSteal('silence', {});
    else {
      this.run.lives -= 1;
      this.endRound('silence', {});
    }
  }

  /** Düello: hata yapan takımın kartını rakip takım çalmaya çalışır. */
  enterSteal(cause, extra) {
    const r = this.round;
    const team = 1 - r.team;
    if (!this.config.stealSeconds || this.teamCounts(true)[team] === 0) {
      this.endRound(cause, extra);
      return;
    }
    r.steal = { team, cause, extra, result: null };
    r.tokens.clear();
    r.tokenAt.clear();
    this.cancelLock();
    this.emit('steal', { team, cause, no: r.no });
    this.setPhase(Phase.STEAL, this.config.stealSeconds);
  }

  resolveSteal(target, reason) {
    const c = this.config;
    const r = this.round;
    const s = r.steal;
    const lead = target === PASS ? null : this.leaderOn(target);
    this.cancelLock();
    let steal = { team: s.team, result: 'pass', points: 0, index: null, leaderId: null };
    if (target !== PASS) {
      const card = r.board[target];
      card.revealed = true;
      card.pickedAt = 'steal';
      this.dropMarks(target);
      r.picks.push({ index: target, word: card.word, role: card.role, reason, steal: true });
      this.emit('flip', { index: target, word: card.word, role: card.role, reason, steal: true, leaderId: lead?.id ?? null });
      steal = { ...steal, index: target, leaderId: lead?.id ?? null };
      if (card.role === 'target') {
        const points = c.stealPoints ?? 2;
        this.addTeamPoints(s.team, points);
        this.run.steals += 1;
        if (lead) {
          lead.stats.points += 1;
          lead.stats.firsts += 1;
          lead.stats.steals += 1;
        }
        steal = { ...steal, result: 'hit', points };
      } else if (card.role === 'parasite') {
        const penalty = c.duelParasitePenalty ?? 1;
        this.addTeamPoints(s.team, -penalty);
        if (lead) {
          lead.stats.points -= 1;
          lead.stats.traps += 1;
        }
        steal = { ...steal, result: 'parasite', points: -penalty };
      } else steal = { ...steal, result: 'miss' };
    }
    s.result = steal.result;
    this.endRound(s.cause, { ...s.extra, steal });
  }

  endRound(kind, extra) {
    const r = this.round;
    const run = this.run;
    r.tokens.clear();
    r.tokenAt.clear();
    this.cancelLock();
    r.result = { kind, points: 0, lifeGain: false, lightning: false, steal: null, ...extra };
    const captain = this.players.get(r.captainId);
    run.history.push({
      no: r.no,
      team: r.team,
      level: r.level.name,
      captainId: r.captainId,
      captainName: captain?.name ?? '?',
      signals: r.signals.map((s) => s.word),
      target: r.board.find((c) => c.role === 'target')?.word,
      picks: r.picks.filter((pk) => !pk.pass).map((pk) => ({ word: pk.word, role: pk.role, steal: Boolean(pk.steal) })),
      kind,
      points: r.result.points,
      lightning: r.result.lightning,
      steal: r.result.steal,
    });
    this.emit('round_end', {
      kind,
      no: r.no,
      team: r.team,
      points: r.result.points,
      lightning: r.result.lightning,
      lives: run.lives,
      lifeGain: r.result.lifeGain,
      steal: r.result.steal,
      reason: r.result.reason ?? null,
    });
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
    const run = this.run;
    const over = run.mode === 'duel' ? run.roundNo >= run.totalRounds : run.lives <= 0;
    if (over) this.endRun();
    else this.startRound();
  }

  /** Oyun sonu bireysel sıralaması: puan, sonra öncü jeton sayısı. */
  standings() {
    return [...this.players.values()]
      .filter((p) => !p.left || p.stats.points || p.stats.captainRounds)
      .map((p) => ({ playerId: p.id, name: p.name, color: p.color, team: p.team, ...p.stats }))
      .sort((a, b) => b.points - a.points || b.firsts - a.firsts || b.captainHits - a.captainHits);
  }

  endRun() {
    const run = this.run;
    const standings = this.standings();
    const mvp = standings[0] && standings[0].points > 0 ? standings[0] : null;
    const common = {
      mode: run.mode,
      rounds: run.roundNo,
      hits: run.hits,
      firstTry: run.firstTry,
      lightnings: run.lightnings,
      steals: run.steals,
      history: run.history,
      standings,
      mvp,
      durationMs: this.now() - run.startedAt,
    };
    if (run.mode === 'duel') {
      const [a, b] = run.teamScores;
      this.summary = { ...common, teams: DUEL_TEAMS.map((name, i) => ({ name, score: run.teamScores[i] })), winner: a === b ? null : a > b ? 0 : 1 };
      this.emit('run_end', { mode: 'duel', winner: this.summary.winner });
    } else {
      const record = this.store.recordRun(this.teamName, run.score);
      this.summary = { ...common, score: run.score, record };
      this.emit('run_end', { mode: 'coop', score: run.score, newRecord: record.isNewRecord });
    }
    this.round = null;
    this.setPhase(Phase.END, null);
  }

  // ───────────────────────── durum ─────────────────────────

  publicState() {
    const r = this.round;
    const run = this.run;
    const c = this.config;
    const reveal = this.phase === Phase.REVEAL;
    const team = this.store.peekTeam(this.teamName);
    const lobbyish = this.phase === Phase.LOBBY || this.phase === Phase.END;
    return {
      type: 'state',
      code: this.code,
      phase: this.phase,
      mode: run?.mode ?? this.mode,
      serverNow: this.now(),
      endsAt: this.endsAt,
      phaseMs: this.phaseMs,
      waiting: this.waiting,
      hostId: this.hostId,
      teamName: this.teamName,
      duelTeams: DUEL_TEAMS,
      rules: {
        boardSize: c.boardSize,
        handSize: c.handSize,
        maxSignals: c.maxSignals,
        points: c.points,
        lives: c.lives,
        lifeEveryHits: c.lifeEveryHits,
        lightningSeconds: c.lightningSeconds ?? 0,
        lightningBonus: c.lightningBonus ?? 1,
        duelRoundsPerTeam: c.duelRoundsPerTeam ?? 4,
        stealSeconds: c.stealSeconds ?? 0,
        stealPoints: c.stealPoints ?? 2,
        duelParasitePenalty: c.duelParasitePenalty ?? 1,
      },
      minPlayers: c.minPlayers,
      duelMinPlayers: c.duelMinPlayers ?? 4,
      maxPlayers: c.maxPlayers,
      players: this.order
        .map((id) => this.players.get(id))
        .filter(Boolean)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, team: p.team, points: p.stats.points })),
      record: team ? { bestScore: team.bestScore, runs: team.runs } : null,
      leaderboard: lobbyish ? this.store.topTeams(5) : null,
      run: run && {
        id: run.id,
        mode: run.mode,
        score: run.score,
        lives: run.lives,
        maxLives: run.maxLives,
        teamScores: run.teamScores,
        totalRounds: run.totalRounds,
        hits: run.hits,
        roundNo: run.roundNo,
        lifeEveryHits: c.lifeEveryHits,
        history: run.history,
      },
      round: r && {
        key: r.key,
        no: r.no,
        team: r.team,
        level: { name: r.level.name, index: r.level.index, parasites: r.board.filter((x) => x.role === 'parasite').length },
        captainId: r.captainId,
        board: r.board.map((x) => ({ word: x.word, revealed: x.revealed, role: x.revealed || reveal ? x.role : null })),
        signals: r.signals,
        maxSignals: c.maxSignals,
        points: c.points,
        handCount: r.hand.length,
        redraws: r.redraws,
        tokens: Object.fromEntries(r.tokens),
        marks: Object.fromEntries([...r.marks].map(([pid, m]) => [pid, Object.fromEntries(m)])),
        lock: r.lock,
        steal: r.steal && { team: r.steal.team, cause: r.steal.cause, result: r.steal.result },
        stealPoints: c.stealPoints ?? 2,
        lightningUntil: this.phase === Phase.GUESS && r.signalAt != null && c.lightningSeconds > 0 ? r.signalAt + c.lightningSeconds * 1000 : null,
        lightningBonus: c.lightningBonus ?? 1,
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
