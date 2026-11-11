// Kart mekanikleri: kaptanın sinyal eli ve takımın güç kartları.
//
// Sinyal eli (kart modu): kaptan kelime yazmaz, elindeki sinyal kartlarından birini oynar.
// El, yasak harf içermeyen bilinen kelimelerden dağıtılır; bir kısmı harf açısından güçlü
// (gizli kelimeyle çok harf paylaşan), kalanı rastgeledir. Böylece kaptan "anlamca yakın mı,
// harfçe güçlü mü?" seçimini yapar.
//
// Güç kartları: seri, yıldırım ve altın kelimeyle kazanılır; takımın ortak elinde birikir ve
// doğru anda oynanır.
import { score } from './score.js';
import { GameError } from './errors.js';

/** by: kim oynayabilir; phases: hangi aşamalarda. */
export const POWERS = {
  fener: { by: 'guesser', phases: ['SIGNAL', 'DISCUSSION'] },
  kalkan: { by: 'guesser', phases: ['SIGNAL', 'DISCUSSION'] },
  saat: { by: 'any', phases: ['SIGNAL', 'DISCUSSION'] },
  satir: { by: 'any', phases: ['WORD_SETUP', 'SIGNAL', 'DISCUSSION'] },
  anahtar: { by: 'captain', phases: ['WORD_SETUP', 'SIGNAL', 'DISCUSSION'] },
  sakin: { by: 'any', phases: ['WORD_SETUP', 'SIGNAL', 'DISCUSSION'] },
};

function letterValue(word, secret) {
  return score(word, secret).reduce((sum, c) => sum + (c === 'G' ? 2 : c === 'Y' ? 1 : 0), 0);
}

/** Kaptanın bu kelimede çekebileceği sinyal kartları. */
export function signalPool(room) {
  const w = room.word;
  const { secret, forbidden } = w.puzzle;
  const cfg = room.config.cards;
  const pool = w.category
    ? room.dictionary.categorySignals(w.category, secret.length, forbidden)
    : room.dictionary.knownWords(secret.length, cfg.poolRank).filter((x) => ![...x].some((c) => forbidden.includes(c)));
  const taken = new Set([...w.hand, ...w.used, ...w.discarded]);
  return pool.filter((x) => !taken.has(x));
}

/**
 * n kart çeker; bunlardan `helpful` tanesi harf değeri en yüksek %20'lik dilimden gelir.
 */
export function drawSignals(room, n, helpful) {
  const pool = signalPool(room);
  const secret = room.word.puzzle.secret;
  const ranked = pool.map((x) => [x, letterValue(x, secret)]).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, Math.max(helpful, Math.ceil(ranked.length * 0.2))).map(([x]) => x);
  const rest = ranked.map(([x]) => x);
  const out = new Set();
  const take = (arr) => {
    const free = arr.filter((x) => !out.has(x));
    if (free.length) out.add(free[Math.floor(room.rng() * free.length)]);
  };
  for (let i = 0; i < helpful && out.size < n; i++) take(top);
  while (out.size < n && out.size < rest.length) take(rest);
  return room.shuffle([...out]);
}

export function dealHand(room) {
  const w = room.word;
  const cfg = room.config.cards;
  w.hand = [];
  w.hand = drawSignals(room, cfg.handSize, cfg.helpfulCards);
  w.handRedraws = cfg.redrawsPerWord;
  w.blankCards = cfg.blankCardsPerWord;
}

/** Oynanan kartın yerine desteden bir kart (yarı olasılıkla harfçe güçlü). */
export function replaceCard(room, played) {
  const w = room.word;
  w.hand = w.hand.filter((x) => x !== played);
  const helpful = room.rng() < 0.5 ? 1 : 0;
  w.hand.push(...drawSignals(room, 1, helpful));
}

export function redrawHand(room) {
  const w = room.word;
  if (w.handRedraws <= 0) throw new GameError('NO_REDRAWS');
  for (const x of w.hand) w.discarded.add(x);
  const keepRedraws = w.handRedraws - 1;
  const keepBlanks = w.blankCards;
  dealHand(room);
  w.handRedraws = keepRedraws;
  w.blankCards = keepBlanks;
}

/** Ağırlıklı rastgele güç kartı; el doluysa kart kaybolur. */
export function drawPower(room, reason) {
  const run = room.run;
  const cfg = room.config.cards;
  if (run.powerHand.length >= cfg.powerHandMax) {
    room.emit('power_full', { reason });
    return null;
  }
  const entries = Object.entries(cfg.powers).filter(([type, weight]) => POWERS[type] && weight > 0);
  const total = entries.reduce((s, [, wgt]) => s + wgt, 0);
  if (!total) return null;
  let r = room.rng() * total;
  let type = entries[entries.length - 1][0];
  for (const [t, wgt] of entries) {
    r -= wgt;
    if (r < 0) {
      type = t;
      break;
    }
  }
  const card = { id: `k${++room.idSeq}`, type };
  run.powerHand.push(card);
  room.emit('power_gain', { kind: type, reason });
  return type;
}

/** Takım elinden bir güç kartı oynar. */
export function playPower(room, p, cardId) {
  const run = room.run;
  const w = room.word;
  if (!run || !w) throw new GameError('NOT_ALLOWED_IN_PHASE');
  const idx = run.powerHand.findIndex((c) => c.id === cardId);
  if (idx < 0) throw new GameError('POWER_NOT_FOUND');
  const card = run.powerHand[idx];
  const def = POWERS[card.type];
  if (!def.phases.includes(room.phase)) throw new GameError('NOT_ALLOWED_IN_PHASE');
  const isCaptain = w.captainId === p.id;
  if ((def.by === 'guesser' && isCaptain) || (def.by === 'captain' && !isCaptain)) throw new GameError('POWER_NOT_YOURS');
  room.requireActive();

  const detail = {};
  switch (card.type) {
    case 'fener': {
      const known = new Set();
      for (const row of w.board) row.colors?.forEach((c, i) => c === 'G' && known.add(i));
      const options = [...w.puzzle.secret]
        .map((_, i) => i)
        .filter((i) => i !== w.puzzle.pos && !known.has(i) && !w.revealed.has(i));
      if (!options.length) throw new GameError('POWER_NO_EFFECT');
      const pos = options[Math.floor(room.rng() * options.length)];
      w.revealed.set(pos, w.puzzle.secret[pos]);
      detail.pos = pos;
      break;
    }
    case 'kalkan':
      if (w.shield) throw new GameError('POWER_NO_EFFECT');
      w.shield = true;
      break;
    case 'saat':
      room.extendPhase(room.config.cards.timeBonusSeconds * 1000);
      detail.seconds = room.config.cards.timeBonusSeconds;
      break;
    case 'satir':
      w.rowLimit += 1;
      break;
    case 'anahtar':
      if (w.forbiddenPass) throw new GameError('POWER_NO_EFFECT');
      w.forbiddenPass = true;
      break;
    case 'sakin':
      if (!w.chaosCard) throw new GameError('POWER_NO_EFFECT');
      detail.cancelled = w.chaosCard;
      w.chaosCard = null;
      w.category = null;
      w.moleId = null;
      break;
    default:
      throw new GameError('POWER_NOT_FOUND');
  }
  run.powerHand.splice(idx, 1);
  room.emit('power', { kind: card.type, playerId: p.id, ...detail });
  // Kaptanın görünümü değişebilir (anahtar, kategori iptali): eli tazele.
  room.sendPrivate(w.captainId);
}
