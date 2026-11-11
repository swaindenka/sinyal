import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase, computeAwards, emptyStats } from '../server/room.js';
import { makeRoom, testConfig } from './helpers.js';

const cfg = testConfig();

function start(h) {
  h.room.handle(h.ps[0].id, { type: 'start' });
  assert.equal(h.room.phase, Phase.WORD_SETUP);
}

test('lobi: ilk katılan host olur, takım adı ve en az 3 oyuncu gerekir', () => {
  const h = makeRoom({ players: 2 });
  assert.equal(h.room.hostId, h.ps[0].id);
  h.room.handle(h.ps[0].id, { type: 'start' });
  assert.equal(h.lastError(h.ps[0].id), 'NOT_ENOUGH_PLAYERS');
  h.room.join({ name: 'Üçüncü' });
  h.room.handle(h.ps[1].id, { type: 'start' });
  assert.equal(h.lastError(h.ps[1].id), 'NOT_HOST');
  h.room.handle(h.ps[0].id, { type: 'set_team', name: '' });
  h.room.handle(h.ps[0].id, { type: 'start' });
  assert.equal(h.lastError(h.ps[0].id), 'TEAM_NAME_REQUIRED');
  h.room.handle(h.ps[0].id, { type: 'set_team', name: 'Kartallar' });
  h.room.handle(h.ps[0].id, { type: 'start' });
  assert.equal(h.room.phase, Phase.WORD_SETUP);
  assert.equal(h.room.run.lives, 3);
  assert.equal(h.room.run.bank, 0);
  assert.equal(h.room.run.wordIndex, 1);
});

test('lobi: aynı isim alınamaz, oda 8 kişiyle dolar', () => {
  const h = makeRoom({ players: 8 });
  assert.throws(() => h.room.join({ name: 'oyuncu1' }), { code: 'NAME_TAKEN' });
  assert.throws(() => h.room.join({ name: 'Dokuzuncu' }), { code: 'ROOM_FULL' });
});

test('gizli bilgi ortak duruma yazılmaz, yalnızca kaptana gider', () => {
  const h = makeRoom();
  start(h);
  const secret = h.secret();
  const json = JSON.stringify(h.room.publicState());
  assert.ok(!json.includes(secret), 'ortak durumda gizli kelime var');
  assert.ok(!json.includes(h.trap()), 'ortak durumda tuzak var');
  const infos = h.sent.filter((m) => m.msg.type === 'captain_info');
  assert.equal(infos.length, 1);
  assert.equal(infos[0].to, h.captain().id);
  assert.equal(infos[0].msg.secret, secret);
  const meta = h.room.publicState().word;
  assert.equal(meta.length, 5);
  assert.equal(meta.trapCount, 1);
  assert.equal(meta.forbiddenCount, 2);
  assert.equal(meta.rowLimit, 6);
});

test('sinyal geçerlilik kuralları ve canlı önizleme', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  assert.equal(h.room.phase, Phase.SIGNAL);
  const cap = h.captain();
  const [f1] = h.room.word.puzzle.forbidden;
  const tryWord = (w) => {
    h.room.handle(cap.id, { type: 'send_signal', word: w });
    return h.lastError(cap.id);
  };
  assert.equal(tryWord('MASA'), 'WRONG_LENGTH');
  assert.equal(tryWord('QWQWQ'), 'NOT_IN_DICTIONARY');
  assert.equal(tryWord('ZZZZZ'), 'NOT_IN_DICTIONARY');
  assert.equal(tryWord(h.secret()), 'FORBIDDEN_LETTER'); // gizli kelime ve tuzaklar kendiliğinden engellenir
  assert.equal(tryWord(h.trap()), 'FORBIDDEN_LETTER');
  assert.ok(f1);
  // tahminci sinyal gönderemez
  const g = h.guessers()[0];
  h.room.handle(g.id, { type: 'send_signal', word: 'ELMAS' });
  assert.equal(h.lastError(g.id), 'NOT_ALLOWED_IN_PHASE');

  h.room.handle(cap.id, { type: 'preview_signal', word: 'elmas' });
  const preview = h.sent.filter((m) => m.msg.type === 'signal_preview').pop().msg;
  assert.equal(preview.word, 'ELMAS');
  assert.equal(preview.error, null);
  assert.equal(preview.colors.length, 5);

  h.signal('elmas');
  assert.equal(h.room.phase, Phase.DISCUSSION);
  const row = h.room.word.board[0];
  assert.equal(row.type, 'signal');
  assert.equal(row.word, 'ELMAS');
  assert.equal(h.room.word.signalsUsed, 1);
});

test('aynı kelime ikinci kez kullanılamaz', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  h.room.handle(h.guessers()[0].id, { type: 'propose_guess', word: 'ELMAS' });
  assert.equal(h.lastError(h.guessers()[0].id), 'ALREADY_USED');
});

test('onay eşiği: floor(T/2)+1, öneren otomatik onaylamış sayılır', () => {
  const h = makeRoom({ players: 5 }); // 4 tahminci → 3 onay
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  const [a, b, c] = h.guessers();
  assert.equal(h.room.publicState().word.thresholds.guess, 3);
  h.room.handle(a.id, { type: 'propose_guess', word: 'MASAL' });
  const prop = h.room.word.proposals[0];
  assert.deepEqual(prop.approvals, [a.id]);
  h.room.handle(b.id, { type: 'approve', proposalId: prop.id });
  assert.equal(h.room.word.board.length, 1, 'henüz gönderilmedi');
  h.room.handle(c.id, { type: 'approve', proposalId: prop.id });
  assert.equal(h.room.word.board.length, 2);
  assert.equal(h.room.word.board[1].type, 'guess');
  assert.equal(h.room.word.board[1].result, 'wrong');
  assert.equal(h.room.word.proposals.length, 0, 'diğer öneriler silinir');
});

test('kaptan öneri yapamaz ve onay veremez', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  const cap = h.captain();
  h.room.handle(cap.id, { type: 'propose_guess', word: 'MASAL' });
  assert.equal(h.lastError(cap.id), 'NOT_ALLOWED_IN_PHASE');
  h.room.handle(cap.id, { type: 'propose_pass' });
  assert.equal(h.lastError(cap.id), 'NOT_ALLOWED_IN_PHASE');
});

test('hız sınırı: 2 saniyede en fazla 1 öneri', () => {
  const h = makeRoom({ players: 5 });
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  const g = h.guessers()[0];
  h.room.handle(g.id, { type: 'propose_guess', word: 'MASAL' });
  h.room.handle(g.id, { type: 'propose_guess', word: 'HELVA' });
  assert.equal(h.lastError(g.id), 'RATE_LIMITED');
  h.clock.advance(2000);
  h.room.handle(g.id, { type: 'propose_guess', word: 'HELVA' });
  assert.equal(h.room.word.proposals.length, 1, 'oy yeni öneriye taşındı');
  assert.equal(h.room.word.proposals[0].word, 'HELVA');
});

test('doğru tahmin: kelime çözülür, kullanılmayan satırlar kumbaraya, 1 sinyalle yıldız', () => {
  const h = makeRoom();
  start(h);
  const firstCaptain = h.captain().id;
  h.toSignal();
  h.signal('ELMAS');
  h.guess(h.secret());
  assert.equal(h.room.phase, Phase.REVEAL);
  assert.equal(h.room.run.score, 1);
  assert.equal(h.room.run.stars, 1);
  assert.equal(h.room.run.bank, 4); // 6 satır − 2 kullanılan
  assert.equal(h.room.reveal.result, 'solved');
  assert.equal(h.room.reveal.secret, h.room.word.puzzle.secret);
  h.clock.advance(cfg.revealSeconds * 1000);
  assert.equal(h.room.phase, Phase.WORD_SETUP);
  assert.equal(h.room.run.wordIndex, 2);
  assert.notEqual(h.captain().id, firstCaptain, 'kaptanlık sıradakine geçer');
});

test('tuzak tahmini: kelime başarısız, can −1, kumbaraya satır eklenmez', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  h.guess(h.trap());
  assert.equal(h.room.phase, Phase.REVEAL);
  assert.equal(h.room.run.lives, 2);
  assert.equal(h.room.run.bank, 0);
  assert.equal(h.room.reveal.result, 'trap');
});

test('sinyal süresi dolarsa boş satır eklenir, boş satır yıldızı bozmaz', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.clock.advance(cfg.signalSeconds * 1000);
  assert.equal(h.room.phase, Phase.DISCUSSION);
  assert.equal(h.room.word.board[0].type, 'empty');
  h.guess(h.secret());
  assert.equal(h.room.run.stars, 1);
});

test('aşamada en fazla 2 tahmin, sonra sinyal aşaması; yanlış tahmin süreyi sıfırlamaz', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  const endsAt = h.room.endsAt;
  h.guess('MASAL');
  assert.equal(h.room.phase, Phase.DISCUSSION);
  assert.equal(h.room.endsAt, endsAt);
  h.guess('HELVA');
  assert.equal(h.room.phase, Phase.SIGNAL);
});

test('pas satır harcamaz; tahminsiz süre dolunca sinyale geçilir', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  const [a, b] = h.guessers();
  h.room.handle(a.id, { type: 'propose_pass' });
  const prop = h.room.word.proposals[0];
  h.room.handle(b.id, { type: 'approve', proposalId: prop.id });
  assert.equal(h.room.phase, Phase.SIGNAL);
  assert.equal(h.room.word.board.length, 1);
  h.signal('HELVA');
  h.clock.advance(cfg.discussionSeconds * 1000);
  assert.equal(h.room.phase, Phase.SIGNAL);
});

test('kalan satır 1 iken sinyal atlanır, pas yoktur, süre dolarsa kelime başarısız', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  // 6 satır: 5 satırı harca
  h.signal('ELMAS'); //1
  h.guess('MASAL'); //2
  h.guess('HELVA'); //3 → SIGNAL
  h.signal('LAVAŞ'); //4
  h.guess('ODUNA'); //5 → kalan 1
  assert.equal(h.room.rowsRemaining(), 1);
  assert.equal(h.room.phase, Phase.DISCUSSION);
  h.room.handle(h.guessers()[0].id, { type: 'propose_pass' });
  assert.equal(h.lastError(h.guessers()[0].id), 'NO_PASS_ON_LAST_ROW');
  h.clock.advance(cfg.discussionSeconds * 1000);
  assert.equal(h.room.phase, Phase.REVEAL);
  assert.equal(h.room.reveal.result, 'rows');
  assert.equal(h.room.run.lives, 2);
});

test('son satırda yanlış tahmin: satırlar bitti, can −1', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  h.guess('MASAL');
  h.guess('HELVA');
  h.signal('LAVAŞ');
  h.guess('ODUNA');
  h.guess('MERAK');
  assert.equal(h.room.reveal.result, 'rows');
  assert.equal(h.room.run.lives, 2);
});

test('kumbara: oybirliğiyle satır limiti +1', () => {
  const h = makeRoom({ players: 4 });
  start(h);
  h.room.run.bank = 2;
  h.toSignal();
  h.signal('ELMAS');
  const [a, b, c] = h.guessers();
  h.room.handle(a.id, { type: 'request_bank_row' });
  const prop = h.room.word.proposals.find((p) => p.kind === 'bank');
  h.room.handle(b.id, { type: 'approve', proposalId: prop.id });
  assert.equal(h.room.word.rowLimit, 6, 'oybirliği yok');
  h.room.handle(c.id, { type: 'approve', proposalId: prop.id });
  assert.equal(h.room.word.rowLimit, 7);
  assert.equal(h.room.run.bank, 1);
});

test('kumbara boşsa talep edilemez; üst sınır 10', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  const g = h.guessers()[0];
  h.room.handle(g.id, { type: 'request_bank_row' });
  assert.equal(h.lastError(g.id), 'BANK_EMPTY');
  h.room.run.bank = 9;
  h.guess(h.secret());
  assert.equal(h.room.run.bank, 10);
});

test('her 5 çözümde +1 can (en fazla 3)', () => {
  const h = makeRoom();
  start(h);
  h.room.run.lives = 2;
  for (let i = 0; i < 5; i++) {
    h.toSignal();
    h.signal('ELMAS');
    h.guess(h.secret());
    if (i < 4) h.room.handle(h.room.hostId, { type: 'skip_reveal' });
  }
  assert.equal(h.room.run.score, 5);
  assert.equal(h.room.run.lives, 3);
});

test('canlar bitince oyun sonu, takım rekoru ve özet', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  h.guess(h.secret());
  for (let i = 0; i < 3; i++) {
    h.room.handle(h.room.hostId, { type: 'skip_reveal' });
    h.toSignal();
    h.signal('ELMAS');
    h.guess(h.trap());
  }
  h.room.handle(h.room.hostId, { type: 'skip_reveal' });
  assert.equal(h.room.phase, Phase.RUN_END);
  const s = h.room.summary;
  assert.equal(s.score, 1);
  assert.equal(s.words.length, 4);
  assert.equal(s.record.isNewRecord, true);
  assert.equal(h.store.peekTeam('Test Takımı').bestScore, 1);
  assert.equal(h.store.peekTeam('test takımı').usedSecrets.length, 4);
  // yeni oyun aynı bulmacaları vermez
  h.room.handle(h.room.hostId, { type: 'start' });
  assert.ok(!s.words.some((w) => w.secret === h.secret()));
});

test('kaptan koparsa oyun duraklar, 30 sn içinde dönmezse kelime iptal (can kaybı yok)', () => {
  const h = makeRoom({ players: 4 });
  start(h);
  h.toSignal();
  const cap = h.captain();
  h.room.disconnect(cap.id);
  assert.equal(h.room.isPaused(), true);
  assert.ok(h.room.pauseReasons.has('captain'));
  h.clock.advance(cfg.captainReconnectSeconds * 1000);
  assert.equal(h.room.phase, Phase.WORD_SETUP);
  assert.equal(h.room.run.wordIndex, 2);
  assert.equal(h.room.run.lives, 3);
  assert.notEqual(h.captain().id, cap.id);
  assert.equal(h.room.run.words[0].result, 'cancelled');
});

test('kaptan zamanında dönerse kaldığı yerden devam eder ve gizli bilgiyi tekrar alır', () => {
  const h = makeRoom({ players: 4 });
  start(h);
  h.toSignal();
  const cap = h.captain();
  const remaining = h.room.endsAt - h.clock.now();
  h.room.disconnect(cap.id);
  h.clock.advance(10_000);
  h.room.join({ token: cap.token });
  h.room.sendPrivate(cap.id);
  assert.equal(h.room.isPaused(), false);
  assert.equal(h.room.phase, Phase.SIGNAL);
  assert.equal(h.room.endsAt - h.clock.now(), remaining, 'sayaç duraklamada durdu');
  assert.equal(h.sent.filter((m) => m.to === cap.id && m.msg.type === 'captain_info').length, 2);
});

test('oyuncu 60 sn içinde dönerse yerini korur, sonra dönerse sıranın sonuna eklenir', () => {
  const h = makeRoom({ players: 4 });
  const p = h.ps[1];
  const idx = h.room.order.indexOf(p.id);
  h.room.disconnect(p.id);
  h.clock.advance(30_000);
  h.room.join({ token: p.token });
  assert.equal(h.room.order.indexOf(p.id), idx);
  h.room.disconnect(p.id);
  h.clock.advance(cfg.playerReconnectSeconds * 1000);
  assert.equal(p.left, true);
  assert.ok(!h.room.order.includes(p.id));
  h.room.join({ token: p.token, name: p.name });
  assert.equal(h.room.order[h.room.order.length - 1], p.id);
});

test('host ayrılırsa yetki sıradaki bağlı oyuncuya geçer', () => {
  const h = makeRoom({ players: 3 });
  const host = h.ps[0];
  h.room.disconnect(host.id);
  assert.equal(h.room.hostId, host.id, 'kısa kopmada host kalır');
  h.clock.advance(cfg.hostGraceSeconds * 1000);
  assert.notEqual(h.room.hostId, host.id);
  assert.ok(h.room.players.get(h.room.hostId).connected);
});

test('bağlı oyuncu sayısı alt sınırın altına düşerse oyun duraklar', () => {
  const h = makeRoom({ players: 3 });
  start(h);
  h.toSignal();
  const g = h.guessers()[0];
  h.room.disconnect(g.id);
  assert.ok(h.room.pauseReasons.has('players'));
  const before = h.room.pausedRemaining;
  h.clock.advance(20_000);
  assert.equal(h.room.pausedRemaining, before);
  h.room.join({ token: g.token });
  assert.equal(h.room.isPaused(), false);
});

test('host duraklatınca sayaçlar durur ve eylemler engellenir', () => {
  const h = makeRoom();
  start(h);
  h.toSignal();
  h.room.handle(h.room.hostId, { type: 'pause' });
  assert.equal(h.room.isPaused(), true);
  h.clock.advance(cfg.signalSeconds * 1000 * 2);
  assert.equal(h.room.phase, Phase.SIGNAL);
  h.room.handle(h.captain().id, { type: 'send_signal', word: 'ELMAS' });
  assert.equal(h.lastError(h.captain().id), 'PAUSED');
  h.room.handle(h.room.hostId, { type: 'pause' });
  h.signal('ELMAS');
  assert.equal(h.room.phase, Phase.DISCUSSION);
});

test('tahminci koparsa onay eşiği yeniden hesaplanır', () => {
  const h = makeRoom({ players: 5 }); // 4 tahminci → 3
  start(h);
  h.toSignal();
  h.signal('ELMAS');
  const [a, b, , d] = h.guessers();
  h.room.handle(a.id, { type: 'propose_guess', word: 'MASAL' });
  h.room.handle(b.id, { type: 'approve', proposalId: h.room.word.proposals[0].id });
  assert.equal(h.room.word.board.length, 1);
  h.room.disconnect(d.id); // 3 tahminci → 2 onay yeterli
  assert.equal(h.room.word.board.length, 2);
});

test('oyun sırasında katılan oyuncu sıranın sonuna eklenir ve tahminci başlar', () => {
  const h = makeRoom();
  start(h);
  const late = h.room.join({ name: 'Geç Kalan' });
  assert.equal(h.room.order[h.room.order.length - 1], late.id);
  assert.notEqual(h.room.word.captainId, late.id);
  assert.ok(h.guessers().some((g) => g.id === late.id));
});

test('zorluk eğrisi: 4. kelimeden itibaren 5 satır', () => {
  const h = makeRoom();
  start(h);
  for (let i = 0; i < 3; i++) {
    h.toSignal();
    h.signal('ELMAS');
    h.guess(h.secret());
    h.room.handle(h.room.hostId, { type: 'skip_reveal' });
  }
  assert.equal(h.room.run.wordIndex, 4);
  assert.equal(h.room.word.rowLimit, 5);
});

test('kaos: kör renk sarıları gri gösterir', () => {
  const config = testConfig({ chaos: { startWord: 1, cards: ['blind'] } });
  const h = makeRoom({ config });
  start(h);
  assert.equal(h.room.word.chaosCard, 'blind');
  h.toSignal();
  h.signal('ELMAS');
  assert.ok(!h.room.word.board[0].colors.includes('Y'));
});

test('kaos: hızlı tur süreleri kısaltır', () => {
  const config = testConfig({ chaos: { startWord: 1, cards: ['fast'] } });
  const h = makeRoom({ config });
  start(h);
  h.toSignal();
  assert.equal(h.room.endsAt - h.clock.now(), config.chaos.fastSignalSeconds * 1000);
  h.signal('ELMAS');
  assert.equal(h.room.endsAt - h.clock.now(), config.chaos.fastDiscussionSeconds * 1000);
});

test('kaos: kategori kilidi sinyalleri kategoriyle sınırlar', () => {
  const config = testConfig({ chaos: { startWord: 1, cards: ['category'] } });
  const h = makeRoom({ config });
  start(h);
  assert.equal(h.room.word.chaosCard, 'category');
  assert.equal(h.room.word.category, 'yemek');
  h.toSignal();
  h.room.handle(h.captain().id, { type: 'send_signal', word: 'ELMAS' });
  assert.equal(h.lastError(h.captain().id), 'WRONG_CATEGORY');
  const ok = ['HELVA', 'ÇORBA', 'PİLAV', 'MANTI', 'ŞEKER', 'LOKUM'].find((w) => !h.room.validateSignal(w));
  h.signal(ok);
  assert.equal(h.room.phase, Phase.DISCUSSION);
});

test('kaos: 3 tahminciden azsa köstebek çekilmez', () => {
  const config = testConfig({ chaos: { startWord: 1, cards: ['mole', 'fast'] } });
  const h = makeRoom({ config, players: 3 });
  start(h);
  assert.equal(h.room.word.chaosCard, 'fast');
  assert.equal(h.room.word.moleId, null);
});

test('köstebek: gizli bilgiyi görür, yakalanırsa takım +1 can kazanır', () => {
  const config = testConfig({ chaos: { startWord: 1, cards: ['mole'] } });
  const h = makeRoom({ config, players: 5 });
  start(h);
  const moleId = h.room.word.moleId;
  assert.ok(moleId);
  assert.notEqual(moleId, h.captain().id);
  const info = h.sent.find((m) => m.msg.type === 'mole_info');
  assert.equal(info.to, moleId);
  assert.ok(!JSON.stringify(h.room.publicState()).includes('"moleId"'), 'köstebek kimliği ortak durumda');
  assert.equal(h.room.publicState().word.hasMole, true);
  h.toSignal();
  h.signal('ELMAS');
  h.guess(h.trap());
  assert.equal(h.room.phase, Phase.MOLE_VOTE);
  assert.equal(h.room.run.lives, 2);
  for (const p of h.room.connectedPlayers()) {
    const target = p.id === moleId ? h.room.voteTargets(p.id)[0].id : moleId;
    h.room.handle(p.id, { type: 'vote_mole', playerId: target });
  }
  assert.equal(h.room.phase, Phase.REVEAL);
  assert.equal(h.room.reveal.moleCaught, true);
  assert.equal(h.room.run.lives, 3);
  assert.equal(h.room.players.get(moleId).stats.moleCaught, 1);
});

test('köstebek: oylamada eşitlik yakalanmamış sayılır; tuzağa düşürdüyse usta köstebek', () => {
  const config = testConfig({ chaos: { startWord: 1, cards: ['mole'] } });
  const h = makeRoom({ config, players: 5 });
  start(h);
  const moleId = h.room.word.moleId;
  h.toSignal();
  h.signal('ELMAS');
  h.guess(h.trap());
  const others = h.room.activePlayers().filter((p) => p.id !== moleId && p.id !== h.room.word.captainId);
  h.room.handle(others[0].id, { type: 'vote_mole', playerId: moleId });
  h.room.handle(others[1].id, { type: 'vote_mole', playerId: others[2].id });
  h.clock.advance(cfg.moleVoteSeconds * 1000);
  assert.equal(h.room.reveal.moleCaught, false);
  assert.equal(h.room.players.get(moleId).stats.masterMole, 1);
  assert.equal(h.room.players.get(others[0].id).stats.moleCorrectVotes, 1);
});

test('ödüller: eşitlikte paylaşılır, ölçüt yoksa gösterilmez', () => {
  const mk = (id, stats) => ({ id, name: id, stats: { ...emptyStats(), ...stats } });
  const awards = computeAwards([
    mk('a', { captainSolved: 2, captainRowsSolved: 6, proposedCorrect: 2 }),
    mk('b', { captainSolved: 1, captainRowsSolved: 3, proposedCorrect: 2, proposedTrap: 1 }),
    mk('c', {}),
  ]);
  const by = Object.fromEntries(awards.map((a) => [a.key, a]));
  assert.deepEqual(by.legend_captain.winners.map((w) => w.id), ['a', 'b']);
  assert.deepEqual(by.oracle.winners.map((w) => w.id), ['a', 'b']);
  assert.deepEqual(by.trapper.winners.map((w) => w.id), ['b']);
  assert.equal(by.mole_hunter, undefined);
  assert.equal(by.master_mole, undefined);
});

test('kaptan sırası: bağlı olmayan oyuncular atlanır', () => {
  const h = makeRoom({ players: 4 });
  start(h);
  const order = h.room.order;
  const first = h.captain().id;
  const nextId = order[(order.indexOf(first) + 1) % order.length];
  h.room.disconnect(nextId);
  h.toSignal();
  h.signal('ELMAS');
  h.guess(h.secret());
  h.room.handle(h.room.hostId, { type: 'skip_reveal' });
  assert.notEqual(h.captain().id, nextId);
  assert.equal(h.captain().id, order[(order.indexOf(first) + 2) % order.length]);
});

test('host kaptan sırasını düzenleyebilir', () => {
  const h = makeRoom({ players: 3 });
  const reversed = [...h.room.order].reverse();
  h.room.handle(h.ps[0].id, { type: 'reorder', order: reversed });
  assert.deepEqual(h.room.order, reversed);
  start(h);
  assert.equal(h.captain().id, reversed[0], 'elle düzenlenen sıra karıştırılmaz');
  h.room.handle(h.ps[1].id, { type: 'reorder', order: reversed });
  assert.equal(h.lastError(h.ps[1].id), 'NOT_HOST');
});
