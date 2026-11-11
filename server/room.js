// SİNYAL oda ve oyun motoru. Sunucu otoriterdir: tüm doğrulama ve renk hesabı burada yapılır.
//
// Durum makinesi (spec 11.1):
//   LOBBY → WORD_SETUP → SIGNAL ⇄ DISCUSSION → [MOLE_VOTE] → REVEAL → WORD_SETUP … → RUN_END
import { randomBytes } from 'node:crypto';
import { score, blindColors } from './score.js';
import { normalize, isAlphabetic, cleanLabel } from './turkish.js';

export const Phase = Object.freeze({
  LOBBY: 'LOBBY',
  WORD_SETUP: 'WORD_SETUP',
  SIGNAL: 'SIGNAL',
  DISCUSSION: 'DISCUSSION',
  MOLE_VOTE: 'MOLE_VOTE',
  REVEAL: 'REVEAL',
  RUN_END: 'RUN_END',
});

/** Kelimenin oynandığı aşamalar (gizli bilgi aktif). */
const WORD_PHASES = new Set([Phase.WORD_SETUP, Phase.SIGNAL, Phase.DISCUSSION]);
/** Sayaç işleyen, duraklatılabilen aşamalar. */
const ACTIVE_PHASES = new Set([...WORD_PHASES, Phase.MOLE_VOTE, Phase.REVEAL]);

export class GameError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

export function emptyStats() {
  return {
    captainWords: 0,
    captainSolved: 0,
    captainRowsSolved: 0,
    captainStars: 0,
    proposed: 0,
    proposedCorrect: 0,
    proposedTrap: 0,
    submitted: 0,
    submittedCorrect: 0,
    submittedTrap: 0,
    moleTurns: 0,
    moleSuccess: 0,
    moleCaught: 0,
    masterMole: 0,
    moleCorrectVotes: 0,
  };
}

const NAME_MAX = 16;
const TEAM_MAX = 24;
const WORD_MAX = 12;

export class Room {
  constructor({
    code,
    config,
    dictionary,
    puzzles,
    store,
    clock = realClock,
    rng = Math.random,
    send = () => {},
    disconnectPlayer = () => {},
    onEmpty = () => {},
  }) {
    this.code = code;
    this.config = config;
    this.dictionary = dictionary;
    this.puzzles = puzzles;
    this.store = store;
    this.clock = clock;
    this.rng = rng;
    this.sendFn = send;
    this.disconnectPlayerFn = disconnectPlayer;
    this.onEmpty = onEmpty;

    this.players = new Map();
    this.order = []; // kaptan sırası (ayrılmamış oyuncu id'leri)
    this.orderCustomized = false;
    this.hostId = null;
    this.teamName = '';

    this.phase = Phase.LOBBY;
    this.endsAt = null;
    this.pausedRemaining = null;
    this.phaseTimer = null;
    this.timerToken = 0;
    this.pauseReasons = new Set();
    this.captainTimer = null;
    this.captainAwayUntil = null;
    this.hostTimer = null;

    this.run = null;
    this.word = null;
    this.reveal = null;
    this.summary = null;

    this.events = [];
    this.eventSeq = 0;
    this.idSeq = 0;
    this.broadcastQueued = false;
    this.closed = false;
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
    if (this.events.length > 12) this.events.shift();
  }

  /** Durumu bir sonraki mikro görevde herkese yayınlar (aynı anda gelen değişiklikler tek yayında). */
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

  orderedPlayers() {
    return this.order.map((id) => this.players.get(id));
  }

  /** Bağlı tahminciler (kaptan hariç). */
  guessers() {
    const captainId = this.word?.captainId;
    return this.connectedPlayers().filter((p) => p.id !== captainId);
  }

  guessThreshold() {
    return Math.floor(this.guessers().length / 2) + 1;
  }

  rowsRemaining() {
    return this.word ? this.word.rowLimit - this.word.board.length : 0;
  }

  isPaused() {
    return this.pauseReasons.size > 0 && ACTIVE_PHASES.has(this.phase);
  }

  nameTaken(name, exceptId = null) {
    const key = normalize(name);
    return this.activePlayers().some((p) => p.id !== exceptId && normalize(p.name) === key);
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ───────────────────────── katılma / bağlantı ─────────────────────────

  /**
   * Odaya katılır ya da token ile yeniden bağlanır. Taşıma katmanı soketi bağladıktan
   * sonra sendPrivate(id) çağırmalıdır.
   */
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
      connected: true,
      left: false,
      ready: false,
      stats: emptyStats(),
      lastProposalAt: -Infinity,
      leaveTimer: null,
    };
    this.players.set(p.id, p);
    this.order.push(p.id); // oyun sırasında katılan sıranın sonuna eklenir, tahminci başlar
    this.run?.participants.add(p.id);
    if (!this.hostId || this.players.get(this.hostId)?.left) this.hostId = p.id;
    this.emit('join', { playerId: p.id });
    this.afterConnectionChange();
    this.changed();
    return p;
  }

  rejoin(p, name) {
    if (p.kicked && p.left) throw new GameError('KICKED');
    if (p.left) {
      // 60 sn'den sonra dönen oyuncu yerini kaybetmiştir: sıranın sonuna eklenir.
      if (this.activePlayers().length >= this.config.maxPlayers) throw new GameError('ROOM_FULL');
      const newName = name || p.name;
      if (this.nameTaken(newName, p.id)) throw new GameError('NAME_TAKEN');
      p.name = newName;
      p.left = false;
      p.ready = false;
      this.order.push(p.id);
      this.run?.participants.add(p.id);
    }
    if (!p.connected) this.emit('reconnect', { playerId: p.id, name: p.name });
    p.connected = true;
    this.clearTimer(p.leaveTimer);
    p.leaveTimer = null;
    if (this.hostId === p.id) {
      this.clearTimer(this.hostTimer);
      this.hostTimer = null;
    }
    if (!this.hostId || this.players.get(this.hostId)?.left) this.hostId = p.id;
    if (this.word && this.word.captainId === p.id && this.captainTimer) this.captainReturned();
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
    if (this.word && WORD_PHASES.has(this.phase) && this.word.captainId === playerId) this.captainLeft();
    if (this.phase === Phase.MOLE_VOTE && this.word?.moleId === playerId) {
      this.word.moleVoteSkipped = true;
      this.enterReveal();
    }
    this.emit('disconnect', { playerId, name: p.name });
    this.afterConnectionChange();
    this.changed();
  }

  /** Oyuncu kalıcı olarak ayrılır (60 sn dolunca ya da "Ayrıl" ile). */
  markLeft(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.left) return;
    const wasCaptain = this.word && WORD_PHASES.has(this.phase) && this.word.captainId === playerId;
    p.left = true;
    p.connected = false;
    p.ready = false;
    this.clearTimer(p.leaveTimer);
    p.leaveTimer = null;
    this.removeFromOrder(playerId);
    if (this.word) {
      for (const prop of this.word.proposals) prop.approvals = prop.approvals.filter((id) => id !== playerId);
      this.pruneProposals();
    }
    if (!this.activePlayers().length) {
      this.close();
      this.onEmpty(this);
      return;
    }
    if (this.hostId === playerId) this.transferHost(true);
    this.emit('leave', { playerId, name: p.name });
    if (wasCaptain) this.cancelWord();
    else if (this.phase === Phase.MOLE_VOTE && this.word?.moleId === playerId) {
      this.word.moleVoteSkipped = true;
      this.enterReveal();
    }
    this.afterConnectionChange();
    this.changed();
  }

  removeFromOrder(playerId) {
    const idx = this.order.indexOf(playerId);
    if (idx < 0) return;
    this.order.splice(idx, 1);
    if (this.run && idx <= this.run.captainCursor) this.run.captainCursor -= 1;
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
      if (p.connected && p.id !== this.hostId) {
        this.hostId = p.id;
        this.emit('host', { playerId: p.id });
        return;
      }
    }
    if (current?.left) this.hostId = this.order[0] ?? null;
  }

  /** Bağlı oyuncu sayısı alt sınırın altına düşerse oyun duraklar (spec 10). */
  updatePlayersPause(phase = this.phase) {
    const enough = this.connectedPlayers().length >= this.config.minPlayers;
    if (ACTIVE_PHASES.has(phase) && !enough) this.pauseReasons.add('players');
    else this.pauseReasons.delete('players');
  }

  afterConnectionChange() {
    this.updatePlayersPause();
    this.applyPause();
    if (this.phase === Phase.DISCUSSION && !this.isPaused()) this.checkProposals();
    if (this.phase === Phase.MOLE_VOTE) this.checkMoleVoteComplete();
  }

  // ── kaptan kopması (spec 10): 30 sn beklenir, dönmezse kelime iptal ──

  captainLeft() {
    this.pauseReasons.add('captain');
    this.captainAwayUntil = this.now() + this.config.captainReconnectSeconds * 1000;
    this.clearTimer(this.captainTimer);
    this.captainTimer = this.setTimer(() => {
      this.captainTimer = null;
      this.captainAwayUntil = null;
      this.pauseReasons.delete('captain');
      this.cancelWord();
    }, this.config.captainReconnectSeconds * 1000);
    this.applyPause();
  }

  captainReturned() {
    this.clearTimer(this.captainTimer);
    this.captainTimer = null;
    this.captainAwayUntil = null;
    this.pauseReasons.delete('captain');
    this.applyPause();
  }

  clearCaptainWait() {
    if (!this.captainTimer && !this.pauseReasons.has('captain')) return;
    this.clearTimer(this.captainTimer);
    this.captainTimer = null;
    this.captainAwayUntil = null;
    this.pauseReasons.delete('captain');
  }

  // ───────────────────────── gizli bilgi ─────────────────────────

  /** Gizli bilgiler yalnızca ilgili oyuncuya özel mesajla gider (spec 7). */
  sendPrivate(playerId) {
    const w = this.word;
    if (!w || !(WORD_PHASES.has(this.phase) || this.phase === Phase.MOLE_VOTE)) return;
    const { secret, traps, forbidden } = w.puzzle;
    if (w.captainId === playerId) {
      // Kategori kilidinde kaptan, kategoride kabul edilen kelimeleri görür (yasak harfliler hariç).
      const categoryWords = w.category ? this.dictionary.categorySignals(w.category, secret.length, forbidden).sort((a, b) => a.localeCompare(b, 'tr')) : null;
      this.send(playerId, { type: 'captain_info', wordIndex: this.run.wordIndex, secret, traps, forbidden, category: w.category, categoryWords });
    }
    if (w.moleId === playerId) {
      this.send(playerId, { type: 'mole_info', wordIndex: this.run.wordIndex, secret, traps, forbidden });
    }
  }

  // ───────────────────────── sayaçlar ve duraklatma ─────────────────────────

  setPhase(phase, seconds) {
    this.clearTimer(this.phaseTimer);
    this.phaseTimer = null;
    this.timerToken++;
    this.phase = phase;
    this.endsAt = null;
    this.pausedRemaining = null;
    this.phaseDuration = seconds == null ? null : seconds * 1000;
    if (seconds == null) return;
    const ms = seconds * 1000;
    if (this.isPaused()) this.pausedRemaining = ms;
    else this.schedule(ms);
  }

  schedule(ms) {
    const token = ++this.timerToken;
    this.endsAt = this.now() + ms;
    this.phaseTimer = this.setTimer(() => {
      if (token === this.timerToken) this.onTimeout();
    }, ms);
  }

  applyPause() {
    if (this.isPaused()) {
      if (this.endsAt != null) {
        this.pausedRemaining = Math.max(0, this.endsAt - this.now());
        this.endsAt = null;
        this.clearTimer(this.phaseTimer);
        this.phaseTimer = null;
        this.timerToken++;
      }
    } else if (this.pausedRemaining != null) {
      const ms = this.pausedRemaining;
      this.pausedRemaining = null;
      this.schedule(ms);
    }
  }

  onTimeout() {
    this.phaseTimer = null;
    this.endsAt = null;
    switch (this.phase) {
      case Phase.WORD_SETUP:
        this.enterSignal();
        break;
      case Phase.SIGNAL:
        // Süre doldu: boş satır eklenir (satır harcanır).
        this.word.board.push({ type: 'empty', word: null, colors: null, byPlayerId: this.word.captainId });
        this.emit('empty_row');
        this.enterDiscussion();
        break;
      case Phase.DISCUSSION:
        if (this.rowsRemaining() <= 1) this.finishWord('rows');
        else {
          this.emit('time_up');
          this.enterSignal();
        }
        break;
      case Phase.MOLE_VOTE:
        this.resolveMoleVote();
        break;
      case Phase.REVEAL:
        this.afterReveal();
        break;
      default:
        break;
    }
  }

  // ───────────────────────── mesaj yönlendirme ─────────────────────────

  handle(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p || p.left || !msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case 'ready':
          this.requirePhase(Phase.LOBBY, Phase.RUN_END);
          p.ready = msg.ready === undefined ? !p.ready : Boolean(msg.ready);
          break;
        case 'set_team':
          this.requireHost(p);
          this.requirePhase(Phase.LOBBY, Phase.RUN_END);
          this.teamName = cleanLabel(msg.name, TEAM_MAX);
          break;
        case 'start':
          this.requireHost(p);
          this.startRun();
          break;
        case 'to_lobby':
          this.requireHost(p);
          this.requirePhase(Phase.RUN_END);
          this.toLobby();
          break;
        case 'reorder':
          this.requireHost(p);
          this.reorder(msg.order);
          break;
        case 'shuffle':
          this.requireHost(p);
          this.requirePhase(Phase.LOBBY, Phase.RUN_END);
          this.shuffle(this.order);
          this.orderCustomized = true;
          break;
        case 'pause':
          this.requireHost(p);
          this.togglePause(msg.paused);
          break;
        case 'skip_reveal':
          this.requireHost(p);
          this.requireActive();
          this.requirePhase(Phase.REVEAL);
          this.afterReveal();
          break;
        case 'preview_signal':
          this.previewSignal(p, msg.word);
          return; // yayın gerekmez
        case 'send_signal':
          this.sendSignal(p, msg.word);
          break;
        case 'propose_guess':
          this.proposeGuess(p, msg.word);
          break;
        case 'approve':
          this.approve(p, msg.proposalId);
          break;
        case 'propose_pass':
          this.proposePass(p);
          break;
        case 'request_bank_row':
          this.requestBankRow(p);
          break;
        case 'vote_mole':
          this.voteMole(p, msg.playerId);
          break;
        case 'kick':
          this.requireHost(p);
          this.kick(p, msg.playerId);
          return;
        case 'leave':
          this.markLeft(p.id);
          return;
        default:
          throw new GameError('UNKNOWN_MESSAGE');
      }
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      this.send(playerId, { type: 'error', code: err.code, detail: err.detail, about: msg.type });
      return;
    }
    this.changed();
  }

  requireHost(p) {
    if (p.id !== this.hostId) throw new GameError('NOT_HOST');
  }

  requirePhase(...phases) {
    if (!phases.includes(this.phase)) throw new GameError('NOT_ALLOWED_IN_PHASE');
  }

  requireActive() {
    if (this.isPaused()) throw new GameError('PAUSED');
  }

  requireCaptain(p) {
    if (!this.word || this.word.captainId !== p.id) throw new GameError('NOT_ALLOWED_IN_PHASE');
  }

  requireGuesser(p) {
    if (!this.word || this.word.captainId === p.id) throw new GameError('NOT_ALLOWED_IN_PHASE');
  }

  rateLimit(p) {
    const now = this.now();
    if (now - p.lastProposalAt < this.config.proposalRateLimitMs) throw new GameError('RATE_LIMITED');
    p.lastProposalAt = now;
  }

  /** Oda sahibi bir oyuncuyu çıkarır (ör. ekran başında olmayan biri onay eşiğini tıkıyorsa). */
  kick(host, targetId) {
    const t = this.players.get(targetId);
    if (!t || t.left || t.id === host.id) throw new GameError('INVALID_KICK');
    t.kicked = true;
    this.send(t.id, { type: 'kicked' });
    this.disconnectPlayerFn(t.id);
    this.emit('kick', { playerId: t.id, name: t.name });
    this.markLeft(t.id);
  }

  togglePause(paused) {
    if (!ACTIVE_PHASES.has(this.phase)) throw new GameError('NOT_ALLOWED_IN_PHASE');
    const want = paused === undefined ? !this.pauseReasons.has('host') : Boolean(paused);
    if (want) this.pauseReasons.add('host');
    else this.pauseReasons.delete('host');
    this.emit(want ? 'paused' : 'resumed');
    this.applyPause();
    if (!this.isPaused() && this.phase === Phase.DISCUSSION) this.checkProposals();
    if (!this.isPaused() && this.phase === Phase.MOLE_VOTE) this.checkMoleVoteComplete();
  }

  reorder(order) {
    const current = new Set(this.order);
    if (!Array.isArray(order) || order.length !== this.order.length || !order.every((id) => current.has(id)) || new Set(order).size !== order.length) {
      throw new GameError('INVALID_ORDER');
    }
    const lastCaptain = this.run ? this.word?.captainId ?? this.order[this.run.captainCursor] : null;
    this.order = [...order];
    this.orderCustomized = true;
    if (this.run) {
      const idx = lastCaptain ? this.order.indexOf(lastCaptain) : -1;
      this.run.captainCursor = idx >= 0 ? idx : Math.min(this.run.captainCursor, this.order.length - 1);
    }
  }

  // ───────────────────────── oyun akışı ─────────────────────────

  startRun() {
    this.requirePhase(Phase.LOBBY, Phase.RUN_END);
    if (!this.teamName) throw new GameError('TEAM_NAME_REQUIRED');
    if (this.connectedPlayers().length < this.config.minPlayers) throw new GameError('NOT_ENOUGH_PLAYERS');
    if (!this.orderCustomized) this.shuffle(this.order); // kaptan sırası oyun başında rastgele
    for (const p of this.players.values()) p.stats = emptyStats();
    this.teamUsed = this.store?.usedSecrets(this.teamName) ?? new Set();
    this.run = {
      lives: this.config.startLives,
      bank: 0,
      score: 0,
      stars: 0,
      wordIndex: 0,
      captainCursor: -1,
      usedSecrets: new Set(),
      words: [],
      participants: new Set(this.activePlayers().map((p) => p.id)),
      startedAt: this.now(),
    };
    this.summary = null;
    this.reveal = null;
    this.pauseReasons.clear();
    this.emit('run_start');
    this.startWord();
  }

  toLobby() {
    this.setPhase(Phase.LOBBY, null);
    this.run = null;
    this.word = null;
    this.reveal = null;
    this.summary = null;
    this.pauseReasons.clear();
    for (const p of this.players.values()) p.ready = false;
  }

  tierIndexFor(wordIndex) {
    let idx = 0;
    this.config.tiers.forEach((t, i) => {
      if (wordIndex >= t.fromWord) idx = i;
    });
    return idx;
  }

  nextCaptain() {
    const n = this.order.length;
    for (let k = 1; k <= n; k++) {
      const idx = (((this.run.captainCursor + k) % n) + n) % n;
      const p = this.players.get(this.order[idx]);
      if (p.connected) {
        this.run.captainCursor = idx;
        return p.id;
      }
    }
    // Hiç bağlı oyuncu yoksa sıradakini al (oyun zaten duraklamış olur).
    const idx = (((this.run.captainCursor + 1) % n) + n) % n;
    this.run.captainCursor = idx;
    return this.order[idx];
  }

  pickPuzzle(tierIndex) {
    const run = this.run;
    const team = this.teamUsed ?? new Set();
    const attempts = [
      (p) => run.usedSecrets.has(p.secret) || team.has(p.secret),
      (p) => run.usedSecrets.has(p.secret),
      () => false,
    ];
    for (const isUsed of attempts) {
      const res = this.puzzles.pick(tierIndex, isUsed, this.rng);
      if (res) return res;
    }
    throw new Error('Bulmaca havuzu boş');
  }

  startWord() {
    const run = this.run;
    run.wordIndex += 1;
    const captainId = this.nextCaptain();
    const tierIndex = this.tierIndexFor(run.wordIndex);
    const tier = this.config.tiers[tierIndex];
    const { puzzle } = this.pickPuzzle(tierIndex);
    run.usedSecrets.add(puzzle.secret);

    this.word = {
      puzzle,
      captainId,
      tierIndex,
      rowLimit: tier.rows,
      board: [],
      proposals: [],
      used: new Set(),
      guessesThisDiscussion: 0,
      signalsUsed: 0,
      chaosCard: null,
      category: null,
      moleId: null,
      votes: new Map(),
      moleVoteSkipped: false,
      result: null,
    };
    this.reveal = null;
    const { startWord, every } = this.config.chaos;
    if (run.wordIndex >= startWord && (run.wordIndex - startWord) % every === 0) this.drawChaosCard();

    this.clearCaptainWait();
    this.updatePlayersPause(Phase.WORD_SETUP);
    this.setPhase(Phase.WORD_SETUP, this.config.setupSeconds);
    this.emit('word_start', { wordIndex: run.wordIndex, captainId, chaosCard: this.word.chaosCard });
    this.sendPrivate(captainId);
    if (this.word.moleId) this.sendPrivate(this.word.moleId);
  }

  /** Kaos kartı (spec 6): koşulu sağlamayan kart atlanıp başkası çekilir. */
  drawChaosCard() {
    const w = this.word;
    const chaos = this.config.chaos;
    for (const card of this.shuffle([...chaos.cards])) {
      if (card === 'mole') {
        const candidates = this.guessers();
        if (candidates.length < chaos.moleMinGuessers) continue;
        w.moleId = candidates[Math.floor(this.rng() * candidates.length)].id;
        w.chaosCard = 'mole';
        return;
      }
      if (card === 'category') {
        const { secret, forbidden } = w.puzzle;
        const cats = this.shuffle(this.dictionary.categoryNames());
        const cat = cats.find(
          (c) => this.dictionary.categorySignals(c, secret.length, forbidden).length >= chaos.categoryMinSignals,
        );
        if (!cat) continue;
        w.category = cat;
        w.chaosCard = 'category';
        return;
      }
      if (card === 'blind' || card === 'fast') {
        w.chaosCard = card;
        return;
      }
    }
  }

  signalSeconds() {
    return this.word.chaosCard === 'fast' ? this.config.chaos.fastSignalSeconds : this.config.signalSeconds;
  }

  discussionSeconds() {
    return this.word.chaosCard === 'fast' ? this.config.chaos.fastDiscussionSeconds : this.config.discussionSeconds;
  }

  enterSignal() {
    this.word.proposals = [];
    // Kalan satır 1 ise sinyal aşaması atlanır: son satır yalnızca tahmin içindir.
    if (this.rowsRemaining() <= 1) {
      this.enterDiscussion();
      return;
    }
    this.setPhase(Phase.SIGNAL, this.signalSeconds());
  }

  enterDiscussion() {
    this.word.proposals = [];
    this.word.guessesThisDiscussion = 0;
    this.setPhase(Phase.DISCUSSION, this.discussionSeconds());
  }

  colorsFor(word) {
    const colors = score(word, this.word.puzzle.secret);
    return this.word.chaosCard === 'blind' ? blindColors(colors) : colors;
  }

  // ── sinyal (spec 4.3) ──

  validateSignal(word) {
    const { secret, forbidden } = this.word.puzzle;
    if ([...word].some((c) => forbidden.includes(c))) return 'FORBIDDEN_LETTER';
    if (word.length !== secret.length) return 'WRONG_LENGTH';
    if (!isAlphabetic(word) || !this.dictionary.has(word)) return 'NOT_IN_DICTIONARY';
    if (this.word.used.has(word)) return 'ALREADY_USED';
    if (this.word.category && !this.dictionary.inCategory(word, this.word.category)) return 'WRONG_CATEGORY';
    return null;
  }

  previewSignal(p, raw) {
    if (!this.word || !WORD_PHASES.has(this.phase)) return;
    if (this.word.captainId !== p.id) return;
    const word = normalize(raw).slice(0, WORD_MAX);
    const error = word ? this.validateSignal(word) : null;
    const colors = word.length === this.word.puzzle.secret.length && isAlphabetic(word) ? this.colorsFor(word) : null;
    this.send(p.id, { type: 'signal_preview', word, colors, error });
  }

  sendSignal(p, raw) {
    this.requirePhase(Phase.SIGNAL);
    this.requireCaptain(p);
    this.requireActive();
    const word = normalize(raw).slice(0, WORD_MAX);
    const error = this.validateSignal(word);
    if (error) throw new GameError(error);
    this.word.used.add(word);
    this.word.board.push({ type: 'signal', word, colors: this.colorsFor(word), byPlayerId: p.id });
    this.word.signalsUsed += 1;
    this.emit('signal', { word });
    this.enterDiscussion();
  }

  // ── tartışma (spec 4.4) ──

  validateGuess(word) {
    if (word.length !== this.word.puzzle.secret.length) return 'WRONG_LENGTH';
    if (!isAlphabetic(word) || !this.dictionary.has(word)) return 'NOT_IN_DICTIONARY';
    if (this.word.used.has(word)) return 'ALREADY_USED';
    return null;
  }

  newProposal(kind, p, word = null) {
    const prop = { id: `q${++this.idSeq}`, kind, word, byPlayerId: p.id, approvals: [], createdAt: this.now() };
    this.word.proposals.push(prop);
    return prop;
  }

  /** Tahmin/pas için her oyuncunun tek aktif onayı vardır; kumbara onayı ayrıdır. */
  castVote(p, prop) {
    if (prop.kind !== 'bank') {
      for (const other of this.word.proposals) {
        if (other !== prop && other.kind !== 'bank') other.approvals = other.approvals.filter((id) => id !== p.id);
      }
    }
    if (!prop.approvals.includes(p.id)) prop.approvals.push(p.id);
    this.pruneProposals();
  }

  pruneProposals() {
    this.word.proposals = this.word.proposals.filter((prop) => prop.approvals.length > 0);
  }

  proposeGuess(p, raw) {
    this.requirePhase(Phase.DISCUSSION);
    this.requireGuesser(p);
    this.requireActive();
    const word = normalize(raw).slice(0, WORD_MAX);
    const error = this.validateGuess(word);
    if (error) throw new GameError(error);
    this.rateLimit(p);
    let prop = this.word.proposals.find((x) => x.kind === 'guess' && x.word === word);
    if (!prop) {
      prop = this.newProposal('guess', p, word);
      if (this.word.moleId !== p.id) {
        p.stats.proposed += 1;
        if (word === this.word.puzzle.secret) p.stats.proposedCorrect += 1;
        if (this.word.puzzle.traps.includes(word)) p.stats.proposedTrap += 1;
      }
      this.emit('proposal', { playerId: p.id, kind: 'guess', word });
    }
    this.castVote(p, prop);
    this.checkProposals();
  }

  proposePass(p) {
    this.requirePhase(Phase.DISCUSSION);
    this.requireGuesser(p);
    this.requireActive();
    if (this.rowsRemaining() <= 1) throw new GameError('NO_PASS_ON_LAST_ROW');
    this.rateLimit(p);
    let prop = this.word.proposals.find((x) => x.kind === 'pass');
    if (!prop) {
      prop = this.newProposal('pass', p);
      this.emit('proposal', { playerId: p.id, kind: 'pass' });
    }
    this.castVote(p, prop);
    this.checkProposals();
  }

  requestBankRow(p) {
    this.requirePhase(Phase.DISCUSSION);
    this.requireGuesser(p);
    this.requireActive();
    if (this.run.bank <= 0) throw new GameError('BANK_EMPTY');
    this.rateLimit(p);
    let prop = this.word.proposals.find((x) => x.kind === 'bank');
    if (!prop) {
      prop = this.newProposal('bank', p);
      this.emit('proposal', { playerId: p.id, kind: 'bank' });
    }
    this.castVote(p, prop);
    this.checkProposals();
  }

  approve(p, proposalId) {
    this.requirePhase(Phase.DISCUSSION);
    this.requireGuesser(p);
    this.requireActive();
    const prop = this.word.proposals.find((x) => x.id === proposalId);
    if (!prop) throw new GameError('PROPOSAL_NOT_FOUND');
    if (prop.approvals.includes(p.id)) {
      // Onayı geri çek
      prop.approvals = prop.approvals.filter((id) => id !== p.id);
      this.pruneProposals();
      return;
    }
    if (prop.kind === 'pass' && this.rowsRemaining() <= 1) throw new GameError('NO_PASS_ON_LAST_ROW');
    this.castVote(p, prop);
    this.checkProposals();
  }

  /** Eşiğe ilk ulaşan öneri gönderilir; açık olan diğer öneriler silinir. */
  checkProposals() {
    if (this.phase !== Phase.DISCUSSION || this.isPaused()) return;
    const guessers = new Set(this.guessers().map((g) => g.id));
    const T = guessers.size;
    if (!T) return;
    const need = Math.floor(T / 2) + 1;
    for (const prop of [...this.word.proposals]) {
      const count = prop.approvals.filter((id) => guessers.has(id)).length;
      if (prop.kind === 'bank') {
        if (count >= T) this.executeBank(prop);
        continue;
      }
      if (count >= need) {
        if (prop.kind === 'guess') this.executeGuess(prop);
        else this.executePass();
        return;
      }
    }
  }

  executeBank(prop) {
    this.word.proposals = this.word.proposals.filter((x) => x !== prop);
    if (this.run.bank <= 0) return;
    this.run.bank -= 1;
    this.word.rowLimit += 1;
    this.emit('bank_row');
  }

  executePass() {
    this.word.proposals = [];
    this.emit('pass');
    this.enterSignal();
  }

  executeGuess(prop) {
    const w = this.word;
    const { secret, traps } = w.puzzle;
    w.proposals = [];
    const word = prop.word;
    const result = word === secret ? 'correct' : traps.includes(word) ? 'trap' : 'wrong';
    w.used.add(word);
    w.board.push({ type: 'guess', word, colors: this.colorsFor(word), byPlayerId: prop.byPlayerId, approvals: prop.approvals, result });

    const proposer = this.players.get(prop.byPlayerId);
    if (proposer && w.moleId !== proposer.id) {
      proposer.stats.submitted += 1;
      if (result === 'correct') proposer.stats.submittedCorrect += 1;
      if (result === 'trap') proposer.stats.submittedTrap += 1;
    }

    if (result === 'correct') return this.finishWord('solved');
    if (result === 'trap') return this.finishWord('trap');

    this.emit('wrong_guess', { word });
    if (this.rowsRemaining() <= 0) return this.finishWord('rows');
    w.guessesThisDiscussion += 1;
    if (w.guessesThisDiscussion >= this.config.maxGuessesPerDiscussion) this.enterSignal();
    // aksi halde tartışma sürer, süre sıfırlanmaz
  }

  // ── kelime sonu (spec 4.5) ──

  finishWord(result) {
    const run = this.run;
    const w = this.word;
    const cfg = this.config;
    this.clearCaptainWait();
    w.result = result;
    w.proposals = [];
    const rowsUsed = w.board.length;
    const outcome = { bankGained: 0, star: false, lifeGained: false, lifeLost: false };

    if (result === 'solved') {
      const before = run.bank;
      run.bank = Math.min(cfg.bankMax, run.bank + Math.max(0, w.rowLimit - rowsUsed));
      outcome.bankGained = run.bank - before;
      run.score += 1;
      if (w.signalsUsed <= cfg.starMaxSignals) {
        run.stars += 1;
        outcome.star = true;
      }
      if (run.score % cfg.lifeEverySolved === 0 && run.lives < cfg.maxLives) {
        run.lives += 1;
        outcome.lifeGained = true;
      }
    } else if (result === 'trap' || result === 'rows') {
      run.lives = Math.max(0, run.lives - 1);
      outcome.lifeLost = true;
    }
    w.outcome = outcome;

    const captain = this.players.get(w.captainId);
    if (captain && result !== 'cancelled') {
      captain.stats.captainWords += 1;
      if (result === 'solved') {
        captain.stats.captainSolved += 1;
        captain.stats.captainRowsSolved += rowsUsed;
        if (outcome.star) captain.stats.captainStars += 1;
      }
    }
    const mole = w.moleId ? this.players.get(w.moleId) : null;
    if (mole) {
      mole.stats.moleTurns += 1;
      if (result === 'trap') mole.stats.moleSuccess += 1;
    }

    run.words.push({
      wordIndex: run.wordIndex,
      captainId: w.captainId,
      captainName: captain?.name ?? '?',
      secret: w.puzzle.secret,
      traps: w.puzzle.traps,
      forbidden: w.puzzle.forbidden,
      result,
      rowsUsed,
      rowLimit: w.rowLimit,
      signalsUsed: w.signalsUsed,
      chaosCard: w.chaosCard,
      category: w.category,
      star: outcome.star,
    });
    this.store?.markUsed(this.teamName, w.puzzle.secret);
    this.teamUsed?.add(w.puzzle.secret);
    this.emit('word_end', { result, wordIndex: run.wordIndex });

    if (result === 'cancelled') {
      // Kaptan dönmedi: can kaybı yok, sıradaki kaptanla yeni kelime.
      this.startWord();
      return;
    }
    if (mole && mole.connected && !mole.left) {
      this.setPhase(Phase.MOLE_VOTE, cfg.moleVoteSeconds);
      return;
    }
    if (mole) w.moleVoteSkipped = true;
    this.enterReveal();
  }

  cancelWord() {
    if (!this.word || !WORD_PHASES.has(this.phase)) return;
    this.finishWord('cancelled');
  }

  // ── köstebek oylaması (spec 6.1) ──

  voteTargets(voterId) {
    return this.activePlayers().filter((p) => p.id !== voterId && p.id !== this.word.captainId);
  }

  voteMole(p, targetId) {
    this.requirePhase(Phase.MOLE_VOTE);
    this.requireActive();
    if (!this.voteTargets(p.id).some((t) => t.id === targetId)) throw new GameError('INVALID_VOTE');
    this.word.votes.set(p.id, targetId);
    this.checkMoleVoteComplete();
  }

  checkMoleVoteComplete() {
    if (this.phase !== Phase.MOLE_VOTE || this.isPaused()) return;
    const voters = this.connectedPlayers();
    if (voters.length && voters.every((v) => this.word.votes.has(v.id))) this.resolveMoleVote();
  }

  resolveMoleVote() {
    const w = this.word;
    const tally = new Map();
    for (const target of w.votes.values()) tally.set(target, (tally.get(target) || 0) + 1);
    let max = 0;
    for (const n of tally.values()) max = Math.max(max, n);
    const top = [...tally.entries()].filter(([, n]) => n === max).map(([id]) => id);
    const caught = max > 0 && top.length === 1 && top[0] === w.moleId; // eşitlikte yakalanmamış sayılır
    w.moleCaught = caught;

    for (const [voterId, target] of w.votes) {
      if (target === w.moleId) this.players.get(voterId).stats.moleCorrectVotes += 1;
    }
    const mole = this.players.get(w.moleId);
    if (caught) {
      mole.stats.moleCaught += 1;
      if (this.run.lives < this.config.maxLives) {
        this.run.lives += 1;
        w.outcome.moleLife = true;
      }
    } else if (w.result === 'trap') {
      mole.stats.masterMole += 1;
    }
    this.emit('mole_result', { caught });
    this.enterReveal();
  }

  // ── hesaplaşma (spec 4.6) ──

  enterReveal() {
    const w = this.word;
    const p = w.puzzle;
    this.reveal = {
      wordIndex: this.run.wordIndex,
      secret: p.secret,
      traps: p.traps,
      forbidden: p.forbidden,
      pos: p.pos,
      result: w.result,
      captainId: w.captainId,
      ...w.outcome,
      moleId: w.moleId,
      moleCaught: w.moleCaught ?? false,
      moleVoteSkipped: w.moleVoteSkipped,
      votes: w.moleId ? Object.fromEntries(w.votes) : null,
    };
    this.setPhase(Phase.REVEAL, this.config.revealSeconds);
  }

  afterReveal() {
    if (this.run.lives <= 0) this.endRun();
    else this.startWord();
  }

  // ── oyun sonu (spec 4.7, 8) ──

  endRun() {
    const run = this.run;
    this.setPhase(Phase.RUN_END, null);
    this.pauseReasons.clear();
    const record = this.store?.recordRun(this.teamName, run.score, run.stars) ?? null;
    const participants = [...run.participants].map((id) => this.players.get(id)).filter(Boolean);
    this.summary = {
      teamName: this.teamName,
      score: run.score,
      stars: run.stars,
      words: run.words,
      record,
      awards: computeAwards(participants),
      players: participants.map((p) => ({ id: p.id, name: p.name, stats: p.stats })),
    };
    this.word = null;
    this.reveal = null;
    this.emit('run_end', { score: run.score, stars: run.stars, newRecord: record?.isNewRecord ?? false });
  }

  // ───────────────────────── ortak durum ─────────────────────────

  /** Herkese eşitlenen durum. Gizli kelime, tuzaklar ve köstebek burada YOKTUR (hesaplaşma hariç). */
  publicState() {
    const run = this.run;
    const w = this.word;
    const team = this.teamName && this.store ? this.store.peekTeam(this.teamName) : null;
    let word = null;
    if (w) {
      const guessers = this.guessers();
      word = {
        captainId: w.captainId,
        length: w.puzzle.secret.length,
        trapCount: w.puzzle.traps.length,
        forbiddenCount: w.puzzle.forbidden.length,
        rowLimit: w.rowLimit,
        rowsRemaining: this.rowsRemaining(),
        tier: { level: w.tierIndex + 1, name: this.config.tiers[w.tierIndex]?.name ?? '' },
        // Tuzağın ayrıldığı konum (harfleri değil). Tahmincilere "bu harfe dikkat" uyarısı için.
        trapPos: this.config.showTrapPosition ? w.puzzle.pos : null,
        chaosCard: w.chaosCard,
        category: w.category,
        board: w.board.map(({ type, word: text, colors, byPlayerId, result, approvals }) => ({
          type,
          word: text,
          colors,
          byPlayerId,
          approvals,
          result,
        })),
        proposals: w.proposals.map(({ id, kind, word: text, byPlayerId, approvals }) => ({ id, kind, word: text, byPlayerId, approvals })),
        guessesThisDiscussion: w.guessesThisDiscussion,
        maxGuesses: this.config.maxGuessesPerDiscussion,
        guesserCount: guessers.length,
        thresholds: { guess: Math.floor(guessers.length / 2) + 1, bank: guessers.length },
        votedIds: this.phase === Phase.MOLE_VOTE ? [...w.votes.keys()] : null,
        hasMole: Boolean(w.moleId),
      };
    }
    return {
      type: 'state',
      code: this.code,
      phase: this.phase,
      serverNow: this.now(),
      endsAt: this.endsAt,
      phaseDuration: this.phaseDuration ?? null,
      pausedRemaining: this.pausedRemaining,
      paused: this.isPaused(),
      pauseReasons: [...this.pauseReasons],
      captainAwayUntil: this.captainAwayUntil,
      hostId: this.hostId,
      teamName: this.teamName,
      devMode: this.config.devMode,
      minPlayers: this.config.minPlayers,
      maxPlayers: this.config.maxPlayers,
      players: this.orderedPlayers().map((p) => ({ id: p.id, name: p.name, connected: p.connected, ready: p.ready })),
      run: run
        ? {
            lives: run.lives,
            maxLives: this.config.maxLives,
            bank: run.bank,
            bankMax: this.config.bankMax,
            score: run.score,
            stars: run.stars,
            wordIndex: run.wordIndex,
            lifeEverySolved: this.config.lifeEverySolved,
          }
        : null,
      record: team ? { bestScore: team.bestScore, bestStars: team.bestStars, runs: team.runs } : null,
      word,
      reveal: this.reveal,
      summary: this.summary,
      events: this.events,
    };
  }

  close() {
    this.closed = true;
    this.clearTimer(this.phaseTimer);
    this.clearTimer(this.captainTimer);
    this.clearTimer(this.hostTimer);
    for (const p of this.players.values()) this.clearTimer(p.leaveTimer);
  }
}

/** Oyun sonu ödülleri (spec 8). Eşitlikte paylaşılır; ölçütü karşılayan yoksa gösterilmez. */
export function computeAwards(players) {
  const awards = [];
  const pick = (key, title, description, metric, better, eligible) => {
    const pool = players.filter(eligible);
    if (!pool.length) return;
    const best = pool.reduce((acc, p) => (better(metric(p), acc) ? metric(p) : acc), metric(pool[0]));
    const winners = pool.filter((p) => metric(p) === best);
    awards.push({ key, title, description, value: best, winners: winners.map((p) => ({ id: p.id, name: p.name })) });
  };
  const s = (p) => p.stats;
  pick(
    'legend_captain',
    'Efsane Kaptan',
    'Çözülen kelime başına en az satır',
    (p) => Math.round((s(p).captainRowsSolved / s(p).captainSolved) * 100) / 100,
    (a, b) => a < b,
    (p) => s(p).captainSolved >= 1,
  );
  pick('oracle', 'Kâhin', 'En çok doğru tahmin öneren', (p) => s(p).proposedCorrect, (a, b) => a > b, (p) => s(p).proposedCorrect >= 1);
  pick('trapper', 'Tuzakçı', 'En çok tuzak öneren', (p) => s(p).proposedTrap, (a, b) => a > b, (p) => s(p).proposedTrap >= 1);
  pick('mole_hunter', 'Köstebek Avcısı', 'Köstebeğe en çok doğru oy veren', (p) => s(p).moleCorrectVotes, (a, b) => a > b, (p) => s(p).moleCorrectVotes >= 1);
  pick('master_mole', 'Usta Köstebek', 'Takımı tuzağa düşürüp yakalanmayan', (p) => s(p).masterMole, (a, b) => a > b, (p) => s(p).masterMole >= 1);
  return awards;
}
