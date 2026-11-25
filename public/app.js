// SİNYAL v2 istemcisi. Sunucu otoriterdir; istemci durumu çizer ve eylemleri gönderir.
import { icon } from './icons.js';

const PASS = 'pass';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ERRORS = {
  NAME_INVALID: 'Bir ad yaz.',
  NAME_TAKEN: 'Bu ad odada kullanılıyor, başka bir ad seç.',
  ROOM_FULL: 'Oda dolu (en fazla 8 kişi).',
  ROOM_NOT_FOUND: 'Bu kodla açık bir oda yok.',
  KICKED: 'Oda sahibi seni odadan çıkardı.',
  SERVER_FULL: 'Sunucu şu an dolu, biraz sonra dene.',
  NOT_HOST: 'Bunu yalnızca oda sahibi yapabilir.',
  NOT_ENOUGH_PLAYERS: 'Başlamak için yeterli oyuncu yok (ortak oyun 2, düello 4 kişi).',
  TEAMS_UNBALANCED: 'Düelloda her takımda en az 2 oyuncu olmalı.',
  NOT_YOUR_TURN: 'Şu an sıra sizde değil.',
  BAD_MODE: 'Bilinmeyen oyun modu.',
  BAD_MARK: 'Bilinmeyen işaret.',
  TEAM_INVALID: 'Takım adı boş olamaz.',
  BAD_PHASE: 'Şu an olmaz.',
  NOT_CAPTAIN: 'Sinyali kaptan oynar.',
  NOT_IN_HAND: 'Bu kart elinde yok.',
  NO_REDRAWS: 'Bu tur elini zaten değiştirdin.',
  CAPTAIN_CANNOT_PICK: 'Kaptan jeton koyamaz.',
  BAD_TARGET: 'Bu karta jeton konamaz.',
  WAITING_PLAYERS: 'Oyuncu bekleniyor.',
  DECK_EMPTY: 'Destede kart kalmadı.',
  SERVER_ERROR: 'Sunucuda bir hata oldu.',
};

// ───────────────────────── durum ─────────────────────────

const store = {
  get(k, fallback = null) {
    try {
      return localStorage.getItem(k) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  session() {
    try {
      return JSON.parse(sessionStorage.getItem('sinyal.session') || 'null');
    } catch {
      return null;
    }
  },
  saveSession(v) {
    try {
      if (v) sessionStorage.setItem('sinyal.session', JSON.stringify(v));
      else sessionStorage.removeItem('sinyal.session');
    } catch {}
  },
};

const S = {
  ws: null,
  conn: 'idle', // idle | connecting | open | closed
  retry: 0,
  retryTimer: null,
  pending: null, // bağlantı açılınca gönderilecek katılma mesajı
  me: null,
  token: null,
  code: null,
  inviteCode: null,
  st: null,
  cap: null,
  sel: null,
  offset: 0,
  bestRtt: Infinity,
  lastSeq: null,
  flipped: new Set(),
  homeError: '',
  homeNotice: '',
  busy: false,
  muted: store.get('sinyal.muted') === '1',
  theme: store.get('sinyal.theme'),
  lastLockSec: null,
  tool: 'token', // kart dokunuşu: 'token' (jeton) | 'cand' (aday) | 'out' (ele)
};

const st = () => S.st;
const round = () => S.st?.round ?? null;
const isHost = () => S.st?.hostId === S.me;
const isCaptain = () => round()?.captainId === S.me;
const player = (id) => S.st?.players.find((p) => p.id === id);
const pname = (id) => player(id)?.name ?? 'Biri';
const serverNow = () => Date.now() + S.offset;
const capInfo = () => (S.cap && round() && S.cap.key === round().key ? S.cap : null);
const myToken = () => round()?.tokens?.[S.me];
const me = () => player(S.me);
const teamName = (t) => S.st?.duelTeams?.[t] ?? '';

/** Şu an jeton koyabilir miyim? (tahminde sırası gelen takımın tahmincileri, çalmada rakip takım) */
function canPickNow() {
  const s = st();
  const r = round();
  const p = me();
  if (!r || !p || s.waiting) return false;
  if (s.phase === 'STEAL') return Boolean(r.steal) && p.team === r.steal.team;
  if (s.phase !== 'GUESS' || r.captainId === S.me) return false;
  return r.team == null || p.team === r.team;
}

/** Kart işaretleyebilir miyim? (kaptan dışında herkes, tur sürerken) */
function canMarkNow() {
  const s = st();
  const r = round();
  return Boolean(r && me() && !s.waiting && ['SIGNAL', 'GUESS', 'STEAL'].includes(s.phase) && r.captainId !== S.me);
}

/** Etkin araç: jeton koyamıyorsam dokunuş aday işaretine döner. */
function activeTool() {
  if (S.tool === 'token' && !canPickNow()) return canMarkNow() ? 'cand' : 'token';
  return S.tool;
}

/** Görebildiğim işaretler: ortak oyunda herkesinki, düelloda yalnızca kendi takımımınki. */
function marksOn(i) {
  const s = st();
  const r = round();
  const myTeam = me()?.team;
  const out = { cand: [], out: [] };
  for (const p of s.players) {
    if (s.run?.mode === 'duel' && p.team !== myTeam) continue;
    const m = r.marks?.[p.id]?.[i];
    if (m) out[m].push(p);
  }
  return out;
}

/** Bu kartı eleyebilecek herkes (bağlı, kaptan değil, düelloda benim takımım) eledi mi? */
function eliminatedByAll(outs) {
  const s = st();
  const r = round();
  const myTeam = me()?.team;
  const voters = s.players.filter((p) => p.connected && p.id !== r.captainId && (s.run?.mode !== 'duel' || p.team === myTeam));
  return voters.length > 0 && voters.every((p) => outs.some((o) => o.id === p.id));
}

function vibrate(pattern) {
  try {
    if (!S.muted) navigator.vibrate?.(pattern);
  } catch {}
}

// ───────────────────────── bağlantı ─────────────────────────

function codeFromUrl() {
  const m = location.pathname.match(/^\/oda\/([A-Za-z]{4})\/?$/);
  const q = new URLSearchParams(location.search).get('oda');
  const c = (m?.[1] || q || '').toUpperCase();
  return /^[A-Z]{4}$/.test(c) ? c : null;
}

function connect() {
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(S.retryTimer);
  S.conn = 'connecting';
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.conn = 'open';
    S.retry = 0;
    const msg = S.pending ?? (S.code && S.token ? { type: 'join', code: S.code, token: S.token } : null);
    S.pending = null;
    if (msg) ws.send(JSON.stringify(msg));
    ping();
    render();
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(msg);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    S.ws = null;
    S.conn = 'closed';
    if (e.code === 4001) {
      leaveLocal(ERRORS.KICKED);
      return;
    }
    if (e.code === 4000) {
      S.homeNotice = 'Bu oyuna başka bir sekmeden bağlandın.';
      leaveLocal();
      return;
    }
    if (S.code && S.token) {
      const delay = Math.min(8000, 600 * 2 ** S.retry++);
      S.retryTimer = setTimeout(connect, delay);
    }
    render();
  };
}

function send(msg) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
}

function joinWith(msg) {
  S.busy = true;
  S.homeError = '';
  if (S.ws?.readyState === WebSocket.OPEN) send(msg);
  else {
    S.pending = msg;
    connect();
  }
  render();
}

let pingSentAt = 0;
function ping() {
  pingSentAt = Date.now();
  send({ type: 'ping' });
}
setInterval(() => S.conn === 'open' && ping(), 20_000);
// Render'ın ücretsiz planı 15 dk HTTP isteği almayan servisi uyutur; odadayken ara ara dürt.
setInterval(() => S.code && fetch('/health', { cache: 'no-store' }).catch(() => {}), 4 * 60_000);

function leaveLocal(notice = '') {
  store.saveSession(null);
  S.code = null;
  S.token = null;
  S.me = null;
  S.st = null;
  S.cap = null;
  S.sel = null;
  S.lastSeq = null;
  S.busy = false;
  S.inviteCode = null;
  if (notice) S.homeNotice = notice;
  clearTimeout(S.retryTimer);
  if (S.ws) {
    const ws = S.ws;
    S.ws = null;
    ws.close();
  }
  history.replaceState(null, '', '/');
  document.body.classList.remove('last-life');
  render();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      S.me = msg.playerId;
      S.token = msg.token;
      S.code = msg.code;
      S.busy = false;
      S.homeError = '';
      S.homeNotice = '';
      S.lastSeq = null; // yeniden bağlanınca kaçırılan olayların efektleri topluca oynamasın
      store.saveSession({ code: msg.code, token: msg.token });
      if (location.pathname !== `/oda/${msg.code}`) history.replaceState(null, '', `/oda/${msg.code}`);
      break;
    case 'state':
      if (S.bestRtt === Infinity) S.offset = msg.serverNow - Date.now();
      runEvents(msg);
      S.st = msg;
      if (S.cap && S.cap.key !== msg.round?.key) S.cap = null;
      render();
      break;
    case 'captain':
      S.cap = msg;
      if (S.sel && !msg.hand.includes(S.sel)) S.sel = null;
      render();
      break;
    case 'pong': {
      const now = Date.now();
      const rtt = now - pingSentAt;
      if (rtt < S.bestRtt + 30) {
        S.bestRtt = Math.min(S.bestRtt, rtt);
        S.offset = msg.serverNow - (pingSentAt + now) / 2;
      }
      break;
    }
    case 'error':
      if (msg.about === 'join') {
        S.busy = false;
        if (S.st) {
          // Yeniden bağlanırken oda bulunamadı: sunucu yeniden başlamış ya da oda kapanmış olabilir.
          leaveLocal(msg.code === 'ROOM_NOT_FOUND' ? 'Oda kapanmış. Yeni bir oda kurabilirsin.' : ERRORS[msg.code] ?? 'Odaya yeniden bağlanılamadı.');
          break;
        }
        if (['ROOM_NOT_FOUND', 'KICKED'].includes(msg.code) && store.session()) {
          store.saveSession(null);
          S.code = null;
          S.token = null;
        }
        S.homeError = ERRORS[msg.code] ?? 'Katılınamadı.';
        render();
      } else if (msg.code !== 'RATE_LIMITED') toast(ERRORS[msg.code] ?? 'Olmadı.', 'bad');
      break;
    case 'replaced':
      break;
  }
}

// ───────────────────────── olaylar → efektler ─────────────────────────

function runEvents(next) {
  const evs = next.events ?? [];
  const maxSeq = evs.length ? evs[evs.length - 1].seq : 0;
  if (S.lastSeq === null) {
    S.lastSeq = maxSeq;
    return;
  }
  for (const ev of evs) {
    if (ev.seq <= S.lastSeq) continue;
    onEvent(ev, next);
  }
  S.lastSeq = Math.max(S.lastSeq, maxSeq);
}

function onEvent(ev, next) {
  const myTeam = next.players.find((p) => p.id === S.me)?.team;
  const tname = (t) => next.duelTeams?.[t] ?? '';
  const duel = next.run?.mode === 'duel' || next.mode === 'duel';
  switch (ev.type) {
    case 'round':
      if (ev.captainId === S.me) {
        SOUND.turn();
        vibrate(80);
        splash('KAPTAN SENSİN', 'Konuşmak yok, sadece kart', 'signal');
      } else if (duel && ev.team != null) {
        splash(`${tname(ev.team)} TAKIMI`, ev.team === myTeam ? 'Sizin turunuz' : 'Dinleyin, çalma şansı gelebilir', ev.team === 0 ? 'team0' : 'team1');
      }
      break;
    case 'signal':
      SOUND.signal();
      if (ev.captainId !== S.me) splash(ev.word, `${ev.n}. sinyal${ev.auto ? ' · süre doldu' : ''}`, 'signal');
      break;
    case 'flip':
      if (ev.role === 'neutral' && !ev.steal) {
        SOUND.blank();
        splash('BOŞ KART', ev.n >= next.round?.maxSignals ? '' : 'Kaptan yeni sinyal oynayacak', 'info');
      }
      break;
    case 'pass':
      SOUND.blank();
      if (ev.n < (next.round?.maxSignals ?? 3)) toast(ev.reason === 'timeout' ? 'Süre doldu, karar çıkmadı: yeni sinyal' : 'Pas: yeni sinyal isteniyor');
      break;
    case 'steal': {
      const why = ev.cause === 'parasite' ? 'Parazit!' : 'Sinyal kesildi!';
      if (ev.team === myTeam) {
        SOUND.turn();
        vibrate([60, 40, 60]);
        splash('ÇALMA ŞANSI!', `${why} Hedefi bulun: +${next.round?.stealPoints ?? 2}`, 'signal');
      } else {
        SOUND.bad();
        shake();
        vibrate(200);
        splash(ev.cause === 'parasite' ? 'PARAZİT!' : 'SİNYAL KESİLDİ', `${tname(ev.team)} çalmaya çalışıyor`, 'bad');
      }
      break;
    }
    case 'round_end': {
      const st2 = ev.steal;
      if (st2 && st2.result !== 'pass') {
        const ours = st2.team === myTeam;
        if (st2.result === 'hit') {
          if (ours) {
            SOUND.hit();
            confetti();
            vibrate([30, 50, 30]);
          } else SOUND.bad();
          splash(ours ? 'ÇALDINIZ!' : 'ÇALDILAR!', `${tname(st2.team)} +${st2.points}`, ours ? 'good' : 'bad');
        } else if (st2.result === 'parasite') {
          SOUND.bad();
          splash('ÇALMA PATLADI', `${tname(st2.team)} parazite bastı · ${st2.points}`, ours ? 'bad' : 'good');
        } else toast(`${tname(st2.team)} çalamadı`);
        break;
      }
      if (st2?.result === 'pass') toast(`${tname(st2.team)} çalmadan vazgeçti`);
      if (ev.kind === 'hit') {
        SOUND.hit();
        confetti();
        vibrate([30, 50, 30]);
        const who = duel && ev.team != null ? `${tname(ev.team)} ` : '';
        splash(ev.lightning ? 'YILDIRIM!' : 'İSABET!', `${who}+${ev.points} puan${ev.lifeGain ? ' · +1 can' : ''}`, 'good');
      } else if (ev.kind === 'parasite' && !st2) {
        SOUND.bad();
        shake();
        vibrate(200);
        splash('PARAZİT!', duel ? `${ev.points} puan` : '−1 can', 'bad');
      } else if (ev.kind === 'silence' && !st2) {
        SOUND.bad();
        shake();
        vibrate(200);
        splash('SİNYAL KESİLDİ', duel ? '3 sinyalde bulunamadı' : '3 sinyalde bulunamadı · −1 can', 'bad');
      } else if (ev.kind === 'cancelled') toast(ev.reason === 'team_short' ? 'Takımda yeterli oyuncu yok, tur geçildi.' : 'Kaptan ayrıldı, tur cezasız yenilendi.');
      break;
    }
    case 'run_end':
      if (ev.mode === 'duel') {
        if (ev.winner == null) splash('BERABERE', 'Rövanş?', 'info');
        else if (ev.winner === myTeam) {
          confetti(160);
          SOUND.hit();
          splash('KAZANDINIZ!', `${tname(ev.winner)} takımı`, 'good');
        } else splash('KAYBETTİNİZ', `${tname(ev.winner)} kazandı`, 'bad');
      } else if (ev.newRecord) {
        confetti(140);
        SOUND.hit();
      }
      break;
    case 'join':
      if (ev.playerId !== S.me) toast(`${ev.name} katıldı`);
      break;
    case 'leave':
      if (ev.playerId !== S.me) toast(`${ev.name} ayrıldı`);
      break;
    case 'kick':
      if (ev.playerId !== S.me) toast(`${ev.name} odadan çıkarıldı`);
      break;
    case 'host':
      if (ev.playerId === S.me) toast('Artık oda sahibi sensin');
      break;
  }
}

// ───────────────────────── ses ─────────────────────────

const SOUND = (() => {
  let ctx = null;
  const ac = () => {
    if (S.muted) return null;
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch {
      return null;
    }
    return ctx;
  };
  const tone = (freq, dur, { type = 'sine', vol = 0.07, delay = 0, slide = 0 } = {}) => {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  };
  return {
    unlock: () => ac(),
    signal: () => {
      tone(660, 0.12, { type: 'triangle' });
      tone(990, 0.16, { type: 'triangle', delay: 0.09 });
    },
    tick: () => tone(1200, 0.05, { type: 'square', vol: 0.03 }),
    hit: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, { type: 'triangle', delay: i * 0.08 })),
    bad: () => {
      tone(220, 0.35, { type: 'sawtooth', vol: 0.05, slide: 0.5 });
      tone(160, 0.4, { type: 'square', vol: 0.03, delay: 0.05, slide: 0.6 });
    },
    blank: () => tone(330, 0.18, { type: 'sine', vol: 0.05, slide: 0.7 }),
    turn: () => {
      tone(523, 0.12, { type: 'triangle' });
      tone(784, 0.2, { type: 'triangle', delay: 0.1 });
    },
    pick: () => tone(880, 0.05, { type: 'sine', vol: 0.04 }),
  };
})();

// ───────────────────────── efektler ─────────────────────────

function fx() {
  return document.getElementById('fx');
}

function splash(title, sub, kind) {
  const el = document.createElement('div');
  el.className = `splash ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
  for (const old of fx().querySelectorAll('.splash')) old.remove();
  fx().appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function confetti(n = 90) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ffb020', '#22c55e', '#4f8dff', '#f472b6', '#facc15', '#2dd4bf'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', `${(Math.random() - 0.5) * 200}px`);
    c.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    c.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    c.style.animationDelay = `${Math.random() * 0.25}s`;
    fx().appendChild(c);
    setTimeout(() => c.remove(), 3400);
  }
}

function shake() {
  document.body.classList.remove('shake');
  void document.body.offsetWidth;
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 500);
}

function toast(text, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 2800);
}

// ───────────────────────── küçük parçalar ─────────────────────────

function logo(big = false) {
  return `<span class="logo${big ? ' big' : ''}"><span class="mark">${icon('signal', { size: big ? 36 : 20 })}</span><span class="word">SİNYAL</span></span>`;
}

function avatar(p, extra = '') {
  return `<span class="avatar pc${p.color}${p.connected ? '' : ' off'} ${extra}">${esc([...p.name][0] ?? '?')}</span>`;
}

function rulesHtml(mode = 'coop', R = {}) {
  const r = { boardSize: 12, handSize: 8, points: [3, 2, 1], lives: 3, lifeEveryHits: 5, lightningSeconds: 15, lightningBonus: 1, duelRoundsPerTeam: 4, stealSeconds: 20, stealPoints: 2, duelParasitePenalty: 1, ...R };
  const bolt = r.lightningSeconds > 0 ? ` Sinyalden sonraki <b>${r.lightningSeconds} saniyede</b> bulursanız <b>yıldırım +${r.lightningBonus}</b>.` : '';
  const common = `
    <li><span>Masada ${r.boardSize} kelime kartı var. <b>Kaptan</b> hangisinin <b>hedef</b>, hangilerinin <b>parazit</b> olduğunu bilir ama konuşamaz.</span></li>
    <li><span>Kaptan elindeki ${r.handSize} kelime kartından birini <b>sinyal</b> olarak oynar. Turda bir kez elini değiştirebilir.</span></li>
    <li><span>Tahminciler konuşur ve <b>jetonlarını</b> kartlara koyar. Herkes aynı kartta birleşince 3 saniyede kart açılır. <b>Pas</b> yeni sinyal ister.</span></li>
    <li><span>Düşündüklerinizi göstermek için kartlara jetondan ayrı <b>Aday ★</b> (istediğiniz kadar kart) ya da <b>Ele ✕</b> işareti koyun. Takım arkadaşlarınız görür; herkesin elediği kart soluklaşır.</span></li>`;
  const personal = `<li><span><b>Bireysel puan:</b> kaptan takımına kazandırdığını alır, hedefe jetonunu ilk koyan +1, açılan parazite ilk koyan −1.</span></li>`;
  if (mode === 'duel')
    return `<ol class="rules">${common}
      <li><span><b>Mavi</b> ve <b>Turuncu</b> takımlar sırayla oynar, her takım ${r.duelRoundsPerTeam} tur. Hedef 1. sinyalde <b>${r.points[0]}</b>, 2.de <b>${r.points[1]}</b>, 3.de <b>${r.points[2]}</b> puan.${bolt} Parazit <b>−${r.duelParasitePenalty}</b>.</span></li>
      <li><span>Takım parazite basar ya da 3 sinyalde bulamazsa rakibe <b>${r.stealSeconds} saniyelik çalma</b> hakkı geçer: hedefi bulan <b>+${r.stealPoints}</b>.</span></li>
      ${personal}
    </ol>`;
  return `<ol class="rules">${common}
    <li><span>Hedef 1. sinyalde <b>${r.points[0]}</b>, 2.de <b>${r.points[1]}</b>, 3.de <b>${r.points[2]}</b> puan.${bolt} <b>Parazit</b> ya da 3 sinyalde bulamamak <b>1 can</b> götürür.</span></li>
    <li><span>${r.lives} canla başlanır, her ${r.lifeEveryHits} isabette 1 can geri gelir. Turlar ilerledikçe parazitler artar ve hedefe benzer.</span></li>
    ${personal}
  </ol>`;
}

function put(id, html) {
  const el = document.getElementById(id);
  if (el && el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

function setClass(id, cls) {
  const el = document.getElementById(id);
  if (el && el.className !== cls) el.className = cls;
}

// ───────────────────────── çizim ─────────────────────────

function viewName() {
  if (!S.st) return 'home';
  if (S.st.phase === 'LOBBY') return 'lobby';
  if (S.st.phase === 'END') return 'end';
  return 'game';
}

function render() {
  const app = document.getElementById('app');
  const view = viewName();
  if (app.dataset.view !== view) {
    app.dataset.view = view;
    app.innerHTML = SKELETON[view]();
    if (view === 'home') initHome();
  }
  RENDER[view]();
  renderConn();
  document.body.classList.toggle('last-life', view === 'game' && st().run?.lives === 1);
  tick();
}

function renderConn() {
  let el = document.getElementById('conn');
  const show = S.code && S.conn !== 'open';
  if (!show) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'conn';
    el.className = 'conn';
    document.body.appendChild(el);
  }
  el.innerHTML = `${icon('wifiOff', { size: 16 })} Bağlantı koptu, yeniden bağlanılıyor…`;
}

const SKELETON = {
  home: () => `
    <main class="home">
      <div class="hero">
        ${logo(true)}
        <p class="tagline">Konuşamayan kaptan, tek kartlık sinyal, bütün takım tek karar.</p>
        <div class="fan" aria-hidden="true">
          <span class="fc fc-t"><small>${icon('check', { size: 11 })} HEDEF</small>GORİL</span>
          <span class="fc fc-p"><small>${icon('zap', { size: 11 })} PARAZİT</small>PİYANO</span>
          <span class="fc fc-s">${icon('signal', { size: 54, cls: 'wm' })}<small>SİNYAL</small>ÜNLÜ</span>
          <span class="chip pc0"></span><span class="chip pc1"></span><span class="chip pc3"></span>
        </div>
      </div>
      <section class="panel">
        <form id="f-home" class="join-form" autocomplete="off" novalidate>
          <label class="field"><span>Adın</span><input class="input" id="name" maxlength="16" placeholder="Örn. Ayşe" autocomplete="nickname" enterkeyhint="go" /></label>
          <div id="home-actions" class="join-form"></div>
          <p class="err" id="home-err" role="alert"></p>
        </form>
      </section>
      <section class="panel how" aria-labelledby="how-t">
        <h2 class="panel-title" id="how-t">Nasıl oynanır</h2>
        <ol>
          <li><span class="mini tile-target">BULUT</span><div><b>Kaptan hedefi bilir</b><span>Masada 12 kelime var. Hedefi ve parazitleri yalnızca kaptan görür.</span></div></li>
          <li><span class="mini sigcard">PAMUK</span><div><b>Konuşmadan sinyal oynar</b><span>Elindeki kelime kartlarından birini seçer. Konuşmak yasak.</span></div></li>
          <li><span class="mini tile-tokens">BULUT<span class="dots"><i class="pc0"></i><i class="pc1"></i><i class="pc3"></i></span></span><div><b>Takım jetonla karar verir</b><span>Herkesin jetonu aynı kartta birleşince kart açılır. Parazit can götürür.</span></div></li>
          <li><span class="mini duelmini"><i class="tm0"></i><b>VS</b><i class="tm1"></i></span><div><b>Ya da düello</b><span>İki takım kapışır. Hata yapan takımın kartını rakip çalar.</span></div></li>
        </ol>
      </section>
    </main>`,
  lobby: () => `
    <main class="lobby">
      <div class="topline">${logo()}<button class="btn ghost small" data-action="leave">${icon('logout', { size: 16 })} Odadan çık</button></div>
      <section class="panel">
        <h2 class="panel-title">Oda kodu</h2>
        <div class="room-code"><span class="code" id="l-code"></span><button class="btn small" data-action="copy-link">${icon('link', { size: 16 })} Davet linki</button></div>
        <p class="muted" style="margin:12px 0 0;font-size:14px">Linki ekibe gönder. Konuşmak için Discord gibi bir sesli kanal açın.</p>
      </section>
      <section class="panel" id="l-mode"></section>
      <section class="panel" id="l-team"></section>
      <section class="panel">
        <h2 class="panel-title"><span id="l-count"></span><span id="l-tools"></span></h2>
        <ul class="plist" id="l-players"></ul>
      </section>
      <section class="panel" id="l-board" hidden></section>
      <section class="panel"><h2 class="panel-title">Nasıl oynanır</h2><div id="l-rules"></div></section>
      <div class="start-bar" id="l-start"></div>
    </main>`,
  game: () => `
    <main class="game">
      <header class="hud" id="g-hud"></header>
      <div class="game-main">
        <section class="status" id="g-status"><span class="phase-ic" id="g-ic"></span><div class="say" id="g-say" aria-live="polite"></div><span class="timer" id="g-timer"><svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="19"/><circle class="arc" id="g-arc" cx="22" cy="22" r="19"/></svg><span class="secs" id="g-secs"></span></span><span class="bolt" id="g-bolt" hidden></span><div id="g-wait" class="wait-slot"></div></section>
        <section class="table" aria-label="Masa">
          <div class="signals" id="g-signals" aria-label="Sinyaller"></div>
          <div class="tools" id="g-tools"></div>
          <div class="board" id="g-board" aria-label="Kartlar"></div>
        </section>
        <section class="dock" id="g-dock"></section>
        <section class="players" id="g-players" aria-label="Oyuncular"></section>
      </div>
      <aside class="game-side">
        <section class="panel"><h2 class="panel-title">Oyuncular</h2><div class="side-list" id="g-side-players"></div></section>
        <section class="panel"><h2 class="panel-title">Bu oyun</h2><ol class="history" id="g-history"></ol></section>
      </aside>
    </main>
    <dialog class="sheet" id="menu"></dialog>`,
  end: () => `<main class="end" id="end"></main>`,
};

// ── giriş ──

function initHome() {
  const name = $('#name');
  name.value = store.get('sinyal.name', '');
  if (!name.value) setTimeout(() => name.focus(), 50);
}

function renderHome() {
  const invite = S.inviteCode;
  const label = S.busy ? 'Bağlanıyor…' : null;
  put(
    'home-actions',
    invite
      ? `<button class="btn primary block" type="submit" ${S.busy ? 'disabled' : ''}>${label ?? `${esc(invite)} odasına katıl`}</button>
         <button class="btn ghost small" type="button" data-action="forget-invite">Bunun yerine yeni oda kur</button>`
      : `<button class="btn primary block" type="submit" ${S.busy ? 'disabled' : ''}>${label ?? 'Oda kur'}</button>
         <div class="or">ya da koda katıl</div>
         <div class="code-row"><input class="input code" id="code" maxlength="4" placeholder="Oda kodu" autocapitalize="characters" autocomplete="off" spellcheck="false" /><button class="btn" type="button" data-action="join-code" ${S.busy ? 'disabled' : ''}>Katıl</button></div>`,
  );
  put('home-err', esc(S.homeError || S.homeNotice));
}

function homeName() {
  const name = $('#name')?.value.trim() ?? '';
  if (!name) {
    S.homeError = ERRORS.NAME_INVALID;
    render();
    $('#name')?.focus();
    return null;
  }
  store.set('sinyal.name', name);
  return name;
}

// ── lobi ──

function renderLobby() {
  const s = st();
  const host = isHost();
  const duel = s.mode === 'duel';
  put('l-code', esc(s.code));
  put(
    'l-mode',
    `<h2 class="panel-title">Oyun modu</h2>
     <div class="seg" role="radiogroup" aria-label="Oyun modu">
       <button class="seg-opt${duel ? '' : ' on'}" data-action="mode" data-mode="coop" role="radio" aria-checked="${!duel}" ${host ? '' : 'disabled'}>${icon('users', { size: 18 })}<span><b>Ortak oyun</b><small>Hep birlikte canlar bitene kadar; takım rekoru</small></span></button>
       <button class="seg-opt${duel ? ' on' : ''}" data-action="mode" data-mode="duel" role="radio" aria-checked="${duel}" ${host ? '' : 'disabled'}>${icon('zap', { size: 18 })}<span><b>Düello</b><small>İki takım kapışır, hata yapanın kartı çalınır (4+ kişi)</small></span></button>
     </div>`,
  );
  const teamPanel = document.getElementById('l-team');
  if (teamPanel) teamPanel.hidden = duel;
  if (!duel && document.activeElement?.id !== 'team-input') {
    const rec = s.record ? `Takım rekoru: <b>${s.record.bestScore}</b> puan · ${s.record.runs} oyun` : 'Bu takım adıyla ilk oyun.';
    put(
      'l-team',
      `<h2 class="panel-title">Takım</h2>
       ${
         host
           ? `<form id="f-team" class="team-row"><input class="input" id="team-input" maxlength="24" value="${esc(s.teamName)}" aria-label="Takım adı" /><button class="btn" type="submit">Kaydet</button></form>`
           : `<div class="team-name">${esc(s.teamName)}</div>`
       }
       <p class="muted" style="margin:10px 0 0;font-size:14px">${rec}</p>`,
    );
  }
  put('l-count', duel ? `Takımlar (${s.players.length}/${s.maxPlayers})` : `Oyuncular · kaptan sırası (${s.players.length}/${s.maxPlayers})`);
  put('l-tools', host && s.players.length > 1 ? `<button class="btn ghost small" data-action="shuffle">${icon('shuffle', { size: 15 })} ${duel ? 'Takımları karıştır' : 'Karıştır'}</button>` : '');
  const row = (p, i, list) => {
    const badges = `${p.id === S.me ? '<span class="badge">sen</span>' : ''}${p.id === s.hostId ? `<span class="badge host">${icon('crown', { size: 12 })} oda sahibi</span>` : ''}${p.connected ? '' : '<span class="badge">bağlantı yok</span>'}`;
    let ctrl = '';
    if (host && duel) {
      ctrl = `<span class="ctrl"><button class="icon-btn" data-action="swap-team" data-id="${p.id}" data-team="${1 - p.team}" aria-label="${esc(p.name)} ${esc(teamName(1 - p.team))} takımına geçsin">${icon('shuffle', { size: 16 })}</button>${
        p.id !== S.me ? `<button class="icon-btn" data-action="kick" data-id="${p.id}" aria-label="${esc(p.name)} odadan çıkar">${icon('x', { size: 16 })}</button>` : ''
      }</span>`;
    } else if (host) {
      ctrl = `<span class="ctrl">
          <button class="icon-btn" data-action="move" data-id="${p.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} aria-label="${esc(p.name)} yukarı">${icon('up', { size: 16 })}</button>
          <button class="icon-btn" data-action="move" data-id="${p.id}" data-dir="down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="${esc(p.name)} aşağı">${icon('down', { size: 16 })}</button>
          ${p.id !== S.me ? `<button class="icon-btn" data-action="kick" data-id="${p.id}" aria-label="${esc(p.name)} odadan çıkar">${icon('x', { size: 16 })}</button>` : ''}
        </span>`;
    }
    return `<li>${duel ? '' : `<span class="n">${i + 1}</span>`}${avatar(p)}<span class="who"><b>${esc(p.name)}</b>${badges}</span>${ctrl}</li>`;
  };
  if (duel) {
    put(
      'l-players',
      [0, 1]
        .map((t) => {
          const list = s.players.filter((p) => p.team === t);
          return `<li class="team-col tm${t}"><div class="team-head"><span class="tdot"></span>${esc(teamName(t))}<small>${list.length} kişi</small></div><ul class="plist">${list.map((p, i) => row(p, i, list)).join('') || '<li class="muted">Henüz kimse yok</li>'}</ul></li>`;
        })
        .join(''),
    );
    setClass('l-players', 'plist teams');
  } else {
    put('l-players', s.players.map((p, i) => row(p, i, s.players)).join(''));
    setClass('l-players', 'plist');
  }
  const connected = s.players.filter((p) => p.connected);
  let ok;
  let hint;
  if (duel) {
    const counts = [0, 1].map((t) => connected.filter((p) => p.team === t).length);
    ok = connected.length >= s.duelMinPlayers && counts.every((n) => n >= 2);
    hint = ok ? `Her takım ${s.rules.duelRoundsPerTeam} tur oynar. ${esc(teamName(0))} başlar.` : `Düello için en az ${s.duelMinPlayers} oyuncu ve her takımda en az 2 kişi gerekli.`;
  } else {
    ok = connected.length >= s.minPlayers;
    hint = ok ? 'İlk kaptan listedeki ilk oyuncu.' : 'En az 2 oyuncu gerekli. Davet linkini gönder.';
  }
  put(
    'l-start',
    host
      ? `<button class="btn primary" data-action="start" ${ok ? '' : 'disabled'}>${duel ? 'Düelloyu başlat' : 'Oyunu başlat'}</button><small>${hint}</small>`
      : `<small>${esc(pname(s.hostId))} oyunu başlatacak.</small>`,
  );
  put('l-rules', rulesHtml(s.mode, s.rules));
  const lb = document.getElementById('l-board');
  if (lb) lb.hidden = !s.leaderboard?.length;
  put('l-board', s.leaderboard?.length ? `<h2 class="panel-title">${icon('trophy', { size: 15 })} Rekor tablosu · ortak oyun</h2>${leaderboardHtml(s.leaderboard, s.teamName)}` : '');
}

function leaderboardHtml(list, current) {
  const key = (n) => String(n).toLocaleUpperCase('tr-TR').trim();
  return `<ol class="lboard">${list
    .map((t, i) => `<li class="${key(t.name) === key(current) ? 'me' : ''}"><span class="rk">${i + 1}</span><b>${esc(t.name)}</b><span class="muted">${t.runs} oyun</span><span class="sc">${t.bestScore}</span></li>`)
    .join('')}</ol>`;
}

// ── oyun ──

function hudHtml() {
  const s = st();
  const run = s.run;
  const r = round();
  const lvl = r ? `<em class="lvl l${r.level.index}">${esc(r.level.name)}</em>` : '';
  if (run.mode === 'duel') {
    const active = r?.team;
    const pill = (t) => `<span class="ts tm${t}${active === t ? ' on' : ''}" aria-label="${esc(teamName(t))} ${run.teamScores[t]} puan"><i class="tdot"></i>${esc(teamName(t))}<b>${run.teamScores[t]}</b></span>`;
    const lvlInline = r ? `<em class="lvl inline l${r.level.index}">${esc(r.level.name)}</em>` : '';
    return `<div class="where"><b>TUR ${r?.no ?? run.roundNo}/${run.totalRounds}</b><span>${lvlInline}${r ? `${r.level.parasites} parazit` : ''}</span></div>
      <div class="duel-score">${pill(0)}${pill(1)}</div>
      <button class="icon-btn" data-action="menu" aria-label="Menü">${icon('menu', { size: 20 })}</button>`;
  }
  const hearts = Array.from({ length: run.maxLives }, (_, i) => icon('heart', { size: 18, fill: true, cls: i < run.lives ? '' : 'lost' })).join('');
  return `<div class="where"><b>TUR ${r?.no ?? run.roundNo} ${lvl}</b><span>${r ? `${r.level.parasites} parazit · ` : ''}${esc(s.teamName)}</span></div>
    <div class="lives" title="Can: ${run.lives}/${run.maxLives}" aria-label="Can ${run.lives}">${hearts}</div>
    <div class="score" aria-label="Puan ${run.score}"><b>${run.score}</b><span>puan</span></div>
    <button class="icon-btn" data-action="menu" aria-label="Menü">${icon('menu', { size: 20 })}</button>`;
}

function nextCaptainName() {
  const s = st();
  const r = round();
  const duel = s.run.mode === 'duel';
  const list = s.players;
  if (duel) return `sıra ${teamName(1 - r.team)} takımında`;
  const i = list.findIndex((p) => p.id === r.captainId);
  for (let k = 1; k <= list.length; k++) {
    const p = list[(Math.max(i, 0) + k) % list.length];
    if (p.connected) return `sıradaki kaptan: ${p.id === S.me ? 'sen' : p.name}`;
  }
  return '';
}

function stealLine(steal) {
  if (!steal) return '';
  const tn = teamName(steal.team);
  return {
    hit: `${tn} çaldı: +${steal.points}.`,
    parasite: `${tn} çalarken parazite bastı: ${steal.points}.`,
    miss: `${tn} çalamadı (boş kart).`,
    pass: `${tn} çalmadan vazgeçti.`,
  }[steal.result];
}

function statusInfo() {
  const s = st();
  const r = round();
  const duel = s.run.mode === 'duel';
  const cap = isCaptain();
  const capName = pname(r.captainId);
  const n = r.signals.length;
  const myP = me();
  const myTeam = myP?.team;
  const activeName = duel ? teamName(r.team) : '';
  const watching = duel && myTeam !== r.team;
  if (s.phase === 'REVEAL') {
    const res = r.result ?? { kind: 'cancelled' };
    const target = r.board.find((c) => c.role === 'target')?.word ?? '';
    const over = duel ? s.run.roundNo >= s.run.totalRounds : s.run.lives <= 0;
    const next = over ? 'Oyun bitti, sonuçlar geliyor…' : `${nextCaptainName().replace(/^./, (c) => c.toLocaleUpperCase('tr-TR'))}.`;
    const sl = stealLine(res.steal);
    const who = duel ? `${activeName} · ` : '';
    const map = {
      hit: { big: `${duel ? `${activeName} ` : ''}İSABET`, badge: `+${res.points} puan${res.lightning ? ' · yıldırım' : ''}${res.lifeGain ? ' · +1 can' : ''}`, sub: `${who}${target} ${n}. sinyalde bulundu. ${next}` },
      parasite: { big: 'PARAZİT', badge: duel ? `${res.points} puan` : '−1 can', sub: `${who}${r.board[res.index]?.word ?? ''} parazitti, hedef ${target} idi. ${sl} ${next}` },
      silence: { big: 'SİNYAL KESİLDİ', badge: duel ? '0 puan' : '−1 can', sub: `${who}Hedef ${target} idi. ${sl} ${next}` },
      cancelled: { big: 'TUR GEÇİLDİ', badge: 'ceza yok', sub: `${res.reason === 'team_short' ? 'Takımda yeterli oyuncu yok.' : 'Kaptan ayrıldı.'} ${next}` },
    };
    const cls = res.steal?.result === 'hit' ? 'res-steal' : `res-${res.kind}`;
    return { cls, ...map[res.kind] };
  }
  if (s.phase === 'STEAL') {
    const mine = r.steal && myTeam === r.steal.team;
    const why = r.steal?.cause === 'parasite' ? `${activeName} parazite bastı` : `${activeName} hedefi bulamadı`;
    if (mine) {
      if (r.lock) return { cls: 'me steal', title: 'Kilitleniyor…', sub: 'Vazgeçen jetonunu taşısın.' };
      return { cls: 'me steal', title: 'ÇALMA ŞANSI!', sub: `${why}. Hedefi bulun: +${s.rules.stealPoints} puan. Parazit −${s.rules.duelParasitePenalty}.` };
    }
    return { cls: 'steal', title: `${teamName(r.steal?.team)} çalmaya çalışıyor`, sub: `${why}. Hedefi bulurlarsa +${s.rules.stealPoints} alırlar.` };
  }
  if (s.phase === 'SIGNAL') {
    if (cap)
      return {
        cls: 'captain-turn me',
        title: n ? `${n + 1}. sinyal kartını seç` : 'Sinyal kartını seç',
        sub: 'Yeşil hedef, kırmızı parazit. Konuşmak yok!',
      };
    if (watching) return { cls: 'captain-turn', title: `${activeName} takımın turu`, sub: `${capName} sinyal seçiyor. Dinleyin: hata yaparlarsa çalma hakkı sizin.` };
    return {
      cls: 'captain-turn',
      title: `${capName} ${n ? `${n + 1}. sinyali` : 'sinyal'} seçiyor`,
      sub: n ? 'Hedef henüz bulunamadı. Kaptan yeni bir kart oynayacak.' : 'Kaptan konuşamaz. Hangi kartı oynayacağını bekleyin.',
    };
  }
  // GUESS
  if (cap) return { cls: '', title: 'Sus ve izle!', sub: 'Takım jetonlarını kartlara koyuyor. Herkes aynı kartta birleşince kart açılır.' };
  if (watching) return { cls: '', title: `${activeName} karar veriyor`, sub: 'Parazite basarlarsa ya da bulamazlarsa çalma sırası sizde.' };
  const mine = myToken();
  if (r.lock) return { cls: 'me', title: 'Kilitleniyor…', sub: 'Vazgeçen jetonunu başka yere taşısın.' };
  if (mine === undefined) return { cls: 'me', title: 'Jetonunu bir karta koy', sub: 'Herkes aynı kartta birleşince 3 saniyede açılır. Emin değilseniz Pas.' };
  const gs = s.players.filter((p) => p.connected && p.id !== r.captainId && (r.team == null || p.team === r.team));
  const same = gs.filter((p) => r.tokens[p.id] === mine).length;
  return { cls: '', title: 'Takımın kalanını bekle', sub: `${same}/${gs.length} jeton seninle aynı yerde. Konuşun, ikna edin.` };
}

function renderStatus() {
  const s = st();
  const info = statusInfo();
  setClass('g-status', `status ${info.cls}`);
  const r = round();
  const ic =
    s.phase === 'REVEAL'
      ? r.result?.steal?.result === 'hit'
        ? 'hand'
        : ({ hit: 'check', parasite: 'zap', silence: 'minus', cancelled: 'refresh' }[r.result?.kind] ?? 'refresh')
      : s.phase === 'STEAL'
        ? 'hand'
        : s.phase === 'SIGNAL'
          ? 'signal'
          : isCaptain()
            ? 'micOff'
            : canPickNow()
              ? 'hand'
              : 'clock';
  put('g-ic', icon(ic, { size: 22 }));
  put(
    'g-say',
    info.big
      ? `<div class="big">${esc(info.big)}<em class="rbadge">${esc(info.badge)}</em></div><span>${esc(info.sub)}</span>`
      : `<b>${esc(info.title)}</b><span>${esc(info.sub)}</span>`,
  );
  put('g-wait', s.waiting ? `<div class="waiting-note">${icon('users', { size: 16 })} Oyuncu bekleniyor: en az ${s.minPlayers} kişi gerekli. Süre durdu.</div>` : '');
}

function renderSignals() {
  const r = round();
  const s = st();
  const out = [];
  for (let i = 0; i < r.maxSignals; i++) {
    const sig = r.signals[i];
    const pts = `${r.points[i]} puan`;
    if (sig) {
      const old = i < r.signals.length - 1 ? ' old' : '';
      out.push(
        `<div class="sig filled${old}">${icon('signal', { size: 54, cls: 'wm' })}<span class="n">${i + 1}</span><span class="pts">${pts}</span><span class="w${[...sig.word].length >= 10 ? ' xlong' : [...sig.word].length >= 8 ? ' long' : ''}">${esc(sig.word)}</span>${sig.auto ? '<span class="auto">süre doldu</span>' : ''}</div>`,
      );
    } else {
      const next = i === r.signals.length && s.phase === 'SIGNAL' ? ' next' : '';
      out.push(`<div class="sig empty${next}"><span class="n">${i + 1}</span><span class="pts">${pts}</span><span class="lbl">${next ? 'sıradaki sinyal' : '—'}</span></div>`);
    }
  }
  put('g-signals', out.join(''));
}

function tokenChips(target) {
  const r = round();
  return st()
    .players.filter((p) => r.tokens[p.id] === target)
    .map((p) => `<span class="tok pc${p.color}" title="${esc(p.name)}">${esc([...p.name][0])}</span>`)
    .join('');
}

function tileHtml(card, i) {
  const s = st();
  const r = round();
  const cap = capInfo();
  const reveal = s.phase === 'REVEAL';
  const tool = activeTool();
  const canPick = !card.revealed && (tool === 'token' ? canPickNow() : canMarkNow());
  const mine = myToken() === i;
  const mk = card.revealed || reveal ? { cand: [], out: [] } : marksOn(i);
  const myMark = r.marks?.[S.me]?.[i];
  const allOut = mk.out.length > 0 && eliminatedByAll(mk.out);
  const meP = me();
  const cls = ['tile'];
  let tag = '';
  if (card.revealed) {
    cls.push(card.role === 'target' ? 'open-target' : card.role === 'parasite' ? 'open-parasite' : 'open-blank');
    tag = card.role === 'target' ? `${icon('check', { size: 11 })} HEDEF` : card.role === 'parasite' ? `${icon('zap', { size: 11 })} PARAZİT` : 'BOŞ';
    const key = `${r.key}:${i}`;
    if (!S.flipped.has(key)) {
      S.flipped.add(key);
      cls.push('flip');
    }
  } else if (reveal && card.role) {
    if (card.role === 'target') {
      cls.push('show-target');
      tag = 'HEDEF';
    } else if (card.role === 'parasite') {
      cls.push('show-parasite');
      tag = 'PARAZİT';
    } else cls.push('dim');
  } else if (cap) {
    const role = cap.roles[i];
    if (role === 'target') {
      cls.push('see-target');
      tag = `${icon('check', { size: 11 })} HEDEF`;
    } else if (role === 'parasite') {
      cls.push('see-parasite');
      tag = `${icon('zap', { size: 11 })} PARAZİT`;
    }
  }
  if (mine && meP) cls.push('mine', `pc${meP.color}`);
  if (allOut) {
    cls.push('out-all');
    if (!tag) tag = `${icon('x', { size: 11 })} ELENDİ`;
  } else if (myMark === 'out') cls.push('out-me');
  if (myMark === 'cand') cls.push('cand-me');
  if (mk.cand.length >= 2) cls.push('hot');
  const marks = [
    ...mk.cand.map((p) => `<i class="mk cand pc${p.color}" title="${esc(p.name)}: aday">${esc([...p.name][0])}</i>`),
    ...mk.out.map((p) => `<i class="mk out pc${p.color}" title="${esc(p.name)}: ele">${icon('x', { size: 9 })}</i>`),
  ].join('');
  const locking = r.lock && r.lock.target === i && (s.phase === 'GUESS' || s.phase === 'STEAL');
  if (locking) cls.push('locking');
  const toks = tokenChips(i);
  const len = [...card.word].length;
  const wcls = len >= 10 ? ' l10' : len >= 8 ? ' l8' : '';
  const role = cap && !card.revealed ? ({ target: ', hedef', parasite: ', parazit' }[cap.roles[i]] ?? '') : '';
  return `<button class="${cls.join(' ')}" data-action="tile" data-i="${i}" ${canPick ? '' : 'disabled'} aria-pressed="${mine}" aria-label="${esc(card.word)}${role}${mk.cand.length ? `, ${mk.cand.length} aday` : ''}${mk.out.length ? `, ${mk.out.length} ele` : ''}${card.revealed ? `, açık: ${tag.replace(/<[^>]+>/g, '').trim()}` : ''}">
    ${tag ? `<span class="tag">${tag}</span>` : ''}${card.revealed || marks ? '' : icon('signal', { size: 13, cls: 'pip' })}${marks ? `<span class="mks">${marks}</span>` : ''}<span class="word${wcls}">${esc(card.word)}</span>${toks ? `<span class="toks">${toks}</span>` : ''}${locking ? '<span class="lockn" data-lock></span>' : ''}
  </button>`;
}

function renderTools() {
  if (!canMarkNow()) {
    put('g-tools', '');
    return;
  }
  const tool = activeTool();
  const pick = canPickNow();
  const mineCount = Object.keys(round().marks?.[S.me] ?? {}).length;
  const opt = (id, ic, label, disabled = false) =>
    `<button class="tool${tool === id ? ' on' : ''} t-${id}" data-action="tool" data-tool="${id}" ${disabled ? 'disabled' : ''} aria-pressed="${tool === id}">${icon(ic, { size: 15, fill: id === 'cand' })}${label}</button>`;
  const hint = tool === 'token' ? 'Dokun: jetonunu koy' : tool === 'cand' ? 'Dokun: aday işaretle (birden çok)' : 'Dokun: kartı ele';
  put(
    'g-tools',
    `<div class="toolbar" role="toolbar" aria-label="Kart aracı">${opt('token', 'hand', 'Jeton', !pick)}${opt('cand', 'star', 'Aday')}${opt('out', 'x', 'Ele')}<button class="tool t-clear" data-action="clear-marks" ${mineCount ? '' : 'disabled'} aria-label="İşaretlerimi temizle">${icon('refresh', { size: 14 })}</button></div><span class="tool-hint">${hint}</span>`,
  );
}

function renderBoard() {
  const r = round();
  setClass('g-board', `board n${r.board.length}${st().phase === 'STEAL' ? ' stealing' : ''}`);
  put('g-board', r.board.map(tileHtml).join(''));
}

function renderDock() {
  const s = st();
  const r = round();
  const duel = s.run.mode === 'duel';
  const cap = isCaptain();
  if (s.phase === 'REVEAL') {
    const over = duel ? s.run.roundNo >= s.run.totalRounds : s.run.lives <= 0;
    put(
      'g-dock',
      isHost()
        ? `<div class="reveal-actions"><button class="btn primary block" data-action="next" ${s.waiting ? 'disabled' : ''}>${over ? 'Sonuçları gör' : 'Sonraki tur'} ${icon('next', { size: 18 })}</button></div>`
        : `<p class="dock-note">${over ? 'Sonuçlar birazdan…' : 'Sıradaki tur birazdan başlıyor…'}</p>`,
    );
    return;
  }
  if (cap && s.phase !== 'STEAL') {
    const info = capInfo();
    const hand = info?.hand ?? [];
    const signalPhase = s.phase === 'SIGNAL' && !s.waiting;
    if (S.sel && !hand.includes(S.sel)) S.sel = null;
    const cards = hand
      .map(
        (w) =>
          `<button class="hcard${S.sel === w ? ' sel' : ''}" data-action="card" data-w="${esc(w)}" ${signalPhase ? '' : 'disabled'} aria-pressed="${S.sel === w}">${icon('signal', { size: 40, cls: 'wm' })}<span class="${[...w].length >= 10 ? 'l10' : [...w].length >= 9 ? 'l9' : [...w].length >= 8 ? 'l8' : ''}">${esc(w)}</span></button>`,
      )
      .join('');
    const actions = signalPhase
      ? `<div class="hand-actions">
          <button class="btn signal" data-action="play" ${S.sel ? '' : 'disabled'}>${icon('send', { size: 17 })} ${S.sel ? `Oyna: ${esc(S.sel)}` : 'Bir kart seç'}</button>
          <button class="btn" data-action="redraw" ${info?.redraws > 0 ? '' : 'disabled'} aria-label="Eli değiştir">${icon('refresh', { size: 17 })} ${info?.redraws ?? 0}</button>
        </div>
        <p class="dock-note">Seçili karta tekrar dokunmak da oynar. Elini turda bir kez değiştirebilirsin.</p>`
      : `<p class="dock-note">Elin bir sonraki sinyal için hazır. Şimdi sadece izle.</p>`;
    put('g-dock', `<div class="hand${S.sel ? ' has-sel' : ''}">${cards}</div>${actions}`);
    return;
  }
  if (s.phase === 'SIGNAL') {
    put(
      'g-dock',
      `<div class="backs" aria-hidden="true">${'<i></i>'.repeat(Math.min(8, r.handCount))}</div><p class="dock-note">${esc(pname(r.captainId))} elindeki ${r.handCount} karttan birini seçiyor.</p>`,
    );
    return;
  }
  if (!canPickNow()) {
    const note =
      s.phase === 'STEAL'
        ? `${esc(teamName(r.steal?.team))} çalmaya çalışıyor. Konuşabilirsiniz ama jeton koyamazsınız.`
        : `${esc(teamName(r.team))} karar veriyor. Çalma şansı gelirse jetonlarınız burada açılır.`;
    put('g-dock', `<p class="dock-note watch">${icon('clock', { size: 15 })} ${note}</p>`);
    return;
  }
  const mine = myToken() === PASS;
  const toks = tokenChips(PASS);
  const locking = r.lock?.target === PASS;
  const left = r.maxSignals - r.signals.length;
  const label = s.phase === 'STEAL' ? 'Vazgeç · çalma yok' : left > 0 ? 'Pas · yeni sinyal iste' : duel ? 'Pas · sinyal kesilir, rakip çalar' : 'Pas · sinyal kesilir (−1 can)';
  put(
    'g-dock',
    `<button class="pass${mine ? ` mine pc${me()?.color}` : ''}${locking ? ' locking' : ''}" data-action="pass" ${s.waiting ? 'disabled' : ''} aria-pressed="${mine}">
      ${icon('hand', { size: 18 })} ${label} ${toks ? `<span class="toks">${toks}</span>` : ''}${locking ? '<span class="lockn" data-lock></span>' : ''}
    </button>`,
  );
}

function playerChips(vertical = false) {
  const s = st();
  const r = round();
  const duel = s.run?.mode === 'duel';
  const pickPhase = s.phase === 'GUESS' || s.phase === 'STEAL';
  const list = vertical ? [...s.players].sort((a, b) => (duel ? a.team - b.team : 0) || b.points - a.points) : s.players;
  return list
    .map((p) => {
      const cap = r && p.id === r.captainId && s.phase !== 'STEAL';
      const decided = r && pickPhase && r.tokens[p.id] !== undefined;
      const pts = `<em class="pp${p.points < 0 ? ' neg' : ''}" title="Bireysel puan">${p.points > 0 ? '+' : ''}${p.points}</em>`;
      return `<span class="pchip${cap ? ' cap' : ''}${p.connected ? '' : ' off'}${duel ? ` tm${p.team}` : ''}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.me ? ' (sen)' : ''}</span>${cap ? icon('micOff', { size: 14 }) : ''}${decided ? icon('check', { size: 14 }) : ''}${vertical && p.id === s.hostId ? icon('crown', { size: 13 }) : ''}${pts}</span>`;
    })
    .join('');
}

function historyHtml(list, mode = 'coop') {
  if (!list.length) return '<li class="empty">Henüz tur bitmedi.</li>';
  const iconFor = { hit: 'check', parasite: 'zap', silence: 'minus', cancelled: 'refresh' };
  const duel = mode === 'duel';
  return [...list]
    .reverse()
    .map((h) => {
      // Sinyaller → açılan son kart (isabette hedef, parazitte parazit); bulunamadıysa hedef kesik çizgiyle.
      const own = h.picks.filter((pk) => !pk.steal);
      const last = own.at(-1);
      const end =
        h.kind === 'hit'
          ? `<span class="t">${esc(h.target)}</span>`
          : h.kind === 'parasite'
            ? `<span class="t bad">${esc(last?.word ?? '')}</span>`
            : `<span class="t miss">${esc(h.target)}</span>`;
      const chain = `<span class="chain">${[...h.signals.map((w) => `<span class="s">${esc(w)}</span>`), end].join('<span class="arrow">→</span>')}</span>`;
      const note = h.kind === 'parasite' ? ` · hedef ${esc(h.target)}` : h.kind === 'silence' ? ' · bulunamadı' : h.kind === 'cancelled' ? ' · geçildi' : h.lightning ? ' · yıldırım' : '';
      const teamTag = duel && h.team != null ? `<span class="tt tm${h.team}"><i class="tdot"></i>${esc(teamName(h.team))}</span> ` : '';
      const steal = h.steal && h.steal.result !== 'pass' ? `<small class="stl tm${h.steal.team}">${esc(stealLine(h.steal))}</small>` : '';
      let pts = '';
      if (h.kind === 'hit') pts = `+${h.points}`;
      else if (h.kind !== 'cancelled') pts = duel ? (h.kind === 'parasite' ? String(h.points) : '0') : '−1 can';
      return `<li><span class="ri ${h.kind}">${icon(iconFor[h.kind], { size: 15 })}</span><span class="path">${chain}<small>${teamTag}${h.no}. tur · kaptan ${esc(h.captainName)}${note}</small>${steal}</span><span class="pts">${pts}</span></li>`;
    })
    .join('');
}

function renderGame() {
  put('g-hud', hudHtml());
  renderStatus();
  renderSignals();
  renderTools();
  renderBoard();
  renderDock();
  put('g-players', playerChips());
  put('g-side-players', playerChips(true));
  put('g-history', historyHtml(st().run.history, st().run.mode));
}

// ── menü ──

function openMenu() {
  const dlg = document.getElementById('menu');
  if (!dlg) return;
  const s = st();
  dlg.innerHTML = `<div class="sheet-body">
    <div class="sheet-head"><h2>${s.mode === 'duel' ? 'Düello' : esc(s.teamName)} · oda ${esc(s.code)}</h2><button class="icon-btn" data-action="close-menu" aria-label="Kapat">${icon('x', { size: 18 })}</button></div>
    <div class="menu-row">
      <button class="btn small" data-action="copy-link">${icon('link', { size: 15 })} Davet linki</button>
      <button class="btn small" data-action="mute">${icon(S.muted ? 'mute' : 'volume', { size: 15 })} ${S.muted ? 'Sesi aç' : 'Sesi kapat'}</button>
      <button class="btn small" data-action="theme">${icon(effectiveTheme() === 'dark' ? 'sun' : 'moon', { size: 15 })} ${effectiveTheme() === 'dark' ? 'Açık tema' : 'Koyu tema'}</button>
      <button class="btn small" data-action="leave">${icon('logout', { size: 15 })} Odadan çık</button>
    </div>
    <div><h3 class="panel-title">Kurallar</h3>${rulesHtml(s.mode, s.rules)}</div>
  </div>`;
  if (!dlg.open) dlg.showModal();
}

// ── oyun sonu ──

function standingsHtml(list, mode) {
  const duel = mode === 'duel';
  return `<ol class="standings">${list
    .map((x, i) => {
      const bits = [];
      if (x.captainPoints) bits.push(`kaptan +${x.captainPoints}`);
      if (x.firsts) bits.push(`öncü ${x.firsts}`);
      if (x.steals) bits.push(`çalma ${x.steals}`);
      if (x.traps) bits.push(`tuzak ${x.traps}`);
      const p = player(x.playerId) ?? { name: x.name, color: x.color, connected: true };
      return `<li class="${i === 0 && x.points > 0 ? 'mvp' : ''}${duel ? ` tm${x.team}` : ''}"><span class="rk">${i === 0 && x.points > 0 ? icon('crown', { size: 15 }) : i + 1}</span>${avatar(p)}<span class="who"><b>${esc(x.name)}</b><small>${bits.join(' · ') || 'puan yok'}</small></span><span class="sc${x.points < 0 ? ' neg' : ''}">${x.points > 0 ? '+' : ''}${x.points}</span></li>`;
    })
    .join('')}</ol>`;
}

function renderEnd() {
  const s = st();
  const sum = s.summary;
  if (!sum) return;
  const host = isHost();
  const duel = sum.mode === 'duel';
  let hero;
  if (duel) {
    const [a, b] = sum.teams;
    const myTeam = me()?.team;
    const title = sum.winner == null ? 'BERABERE' : `${esc(sum.teams[sum.winner].name)} KAZANDI`;
    const mine = sum.winner != null && myTeam === sum.winner;
    hero = `<section class="panel end-hero duel${sum.winner != null ? ` win${sum.winner}` : ''}">
      <span class="label">Düello bitti</span>
      <span class="winner">${title}</span>
      <div class="vs"><span class="tm0"><i class="tdot"></i>${esc(a.name)}<b>${a.score}</b></span><em>—</em><span class="tm1"><b>${b.score}</b>${esc(b.name)}<i class="tdot"></i></span></div>
      ${sum.winner != null ? `<span class="record">${icon('trophy', { size: 16 })} ${mine ? 'Tebrikler!' : 'Rövanş için yeniden oynayın'}</span>` : ''}
    </section>`;
  } else {
    const rec = sum.record;
    hero = `<section class="panel end-hero">
      <span class="label">${esc(s.teamName)} · oyun bitti</span>
      <span class="num">${sum.score}</span>
      <span class="muted">puan</span>
      ${rec.isNewRecord ? `<span class="record">${icon('trophy', { size: 16 })} Yeni takım rekoru!</span>` : `<span class="muted">Takım rekoru: <b>${rec.bestScore}</b> puan</span>`}
    </section>`;
  }
  const stats = duel
    ? [
        [sum.rounds, 'tur'],
        [sum.hits, 'isabet'],
        [sum.steals, 'çalma'],
        [sum.lightnings, 'yıldırım'],
      ]
    : [
        [sum.rounds, 'tur'],
        [sum.hits, 'isabet'],
        [sum.firstTry, 'ilk sinyalde'],
        [sum.lightnings, 'yıldırım'],
      ];
  put(
    'end',
    `<div class="topline">${logo()}<button class="btn ghost small" data-action="leave">${icon('logout', { size: 16 })} Odadan çık</button></div>
    ${hero}
    <section class="stats">${stats.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}</section>
    <section class="panel"><h2 class="panel-title">Bireysel sıralama</h2>${standingsHtml(sum.standings, sum.mode)}<p class="muted small-note">Kaptan takımına kazandırdığı puanı alır. Hedefe jetonunu ilk koyan +1, açılan parazite ilk koyan −1.</p></section>
    ${!duel && s.leaderboard?.length ? `<section class="panel"><h2 class="panel-title">${icon('trophy', { size: 15 })} Rekor tablosu</h2>${leaderboardHtml(s.leaderboard, s.teamName)}</section>` : ''}
    <section class="panel"><h2 class="panel-title">Turlar</h2><ol class="history">${historyHtml(sum.history, sum.mode)}</ol></section>
    <div class="end-actions">
      ${
        host
          ? `<button class="btn primary block" data-action="start">${icon('refresh', { size: 18 })} ${duel ? 'Rövanş' : 'Yeniden oyna'}</button><button class="btn block" data-action="to-lobby">Lobiye dön</button>`
          : `<p class="dock-note">${esc(pname(s.hostId))} yeni oyunu başlatabilir.</p>`
      }
    </div>`,
  );
}

const RENDER = { home: renderHome, lobby: renderLobby, game: renderGame, end: renderEnd };

// ───────────────────────── sayaç ─────────────────────────

function tick() {
  const s = st();
  if (!s || viewName() !== 'game') return;
  const secsEl = document.getElementById('g-secs');
  const bar = document.getElementById('g-bar');
  const statusEl = document.getElementById('g-status');
  let remaining = null;
  if (s.endsAt) remaining = Math.max(0, s.endsAt - serverNow());
  if (secsEl) secsEl.textContent = remaining == null ? '' : String(Math.ceil(remaining / 1000));
  const frac = remaining == null || !s.phaseMs ? (s.waiting ? 1 : 0) : Math.min(1, remaining / s.phaseMs);
  if (bar) bar.style.transform = `scaleX(${frac})`;
  const arc = document.getElementById('g-arc');
  if (arc) arc.style.strokeDashoffset = String(119.38 * (1 - frac));
  const urgent = remaining != null && remaining <= 10_000 && (s.phase === 'SIGNAL' || s.phase === 'GUESS' || s.phase === 'STEAL');
  statusEl?.classList.toggle('urgent', urgent);
  const bolt = document.getElementById('g-bolt');
  const until = round()?.lightningUntil;
  const boltLeft = until && s.phase === 'GUESS' && !s.waiting ? until - serverNow() : 0;
  if (bolt) {
    bolt.hidden = boltLeft <= 0;
    if (boltLeft > 0) bolt.innerHTML = `${icon('zap', { size: 13 })} Yıldırım +${round().lightningBonus} · ${Math.ceil(boltLeft / 1000)} sn`;
  }
  const lock = round()?.lock;
  if (lock && (s.phase === 'GUESS' || s.phase === 'STEAL')) {
    const sec = Math.max(1, Math.ceil((lock.endsAt - serverNow()) / 1000));
    for (const el of document.querySelectorAll('[data-lock]')) el.textContent = String(sec);
    if (sec !== S.lastLockSec) {
      S.lastLockSec = sec;
      SOUND.tick();
    }
  } else S.lastLockSec = null;
}
setInterval(tick, 200);

// ───────────────────────── eylemler ─────────────────────────

function effectiveTheme() {
  return S.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function applyTheme() {
  if (S.theme) document.documentElement.dataset.theme = S.theme;
  else delete document.documentElement.dataset.theme;
}

async function copyLink() {
  const url = `${location.origin}/oda/${st().code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Davet linki kopyalandı');
  } catch {
    prompt('Davet linki:', url);
  }
}

function playSelected() {
  if (!S.sel || !isCaptain() || st().phase !== 'SIGNAL') return;
  send({ type: 'play_signal', word: S.sel });
  S.sel = null;
}

function setToken(target) {
  const r = round();
  if (!r || !canPickNow()) return;
  const next = myToken() === target ? null : target;
  // İyimser güncelleme: dokunuş anında görünsün, sunucu onaylar.
  if (next === null) delete r.tokens[S.me];
  else r.tokens[S.me] = next;
  SOUND.pick();
  send({ type: 'token', target: next });
  render();
}

function toggleMark(i, kind) {
  const r = round();
  if (!r || !canMarkNow() || r.board[i]?.revealed) return;
  r.marks ??= {};
  const mine = (r.marks[S.me] ??= {});
  const next = mine[i] === kind ? null : kind;
  // İyimser güncelleme
  if (next) mine[i] = next;
  else delete mine[i];
  SOUND.pick();
  send({ type: 'mark', index: i, mark: next });
  render();
}

const ACTIONS = {
  mode: (el) => send({ type: 'set_mode', mode: el.dataset.mode }),
  'swap-team': (el) => send({ type: 'set_player_team', playerId: el.dataset.id, team: Number(el.dataset.team) }),
  'forget-invite': () => {
    S.inviteCode = null;
    history.replaceState(null, '', '/');
    render();
  },
  'join-code': () => {
    const code = ($('#code')?.value ?? '').trim().toUpperCase();
    if (!/^[A-ZÇĞİÖŞÜ]{4}$/.test(code)) {
      S.homeError = 'Oda kodu 4 harftir.';
      render();
      return;
    }
    const name = homeName();
    if (name) joinWith({ type: 'join', code, name });
  },
  leave: () => {
    send({ type: 'leave' });
    document.getElementById('menu')?.close();
    leaveLocal();
  },
  'copy-link': copyLink,
  shuffle: () => send({ type: 'shuffle' }),
  move: (el) => send({ type: 'move', playerId: el.dataset.id, dir: el.dataset.dir }),
  kick: (el) => {
    if (confirm(`${pname(el.dataset.id)} odadan çıkarılsın mı?`)) send({ type: 'kick', playerId: el.dataset.id });
  },
  start: () => send({ type: 'start' }),
  'to-lobby': () => send({ type: 'to_lobby' }),
  card: (el) => {
    const w = el.dataset.w;
    if (S.sel === w) playSelected();
    else {
      S.sel = w;
      SOUND.pick();
    }
    render();
  },
  play: playSelected,
  redraw: () => send({ type: 'redraw' }),
  tile: (el) => {
    const i = Number(el.dataset.i);
    const tool = activeTool();
    if (tool === 'token') setToken(i);
    else toggleMark(i, tool);
  },
  tool: (el) => {
    S.tool = el.dataset.tool;
    render();
  },
  'clear-marks': () => {
    const r = round();
    if (r?.marks) delete r.marks[S.me];
    send({ type: 'mark_clear' });
    render();
  },
  pass: () => setToken(PASS),
  next: () => send({ type: 'next' }),
  menu: openMenu,
  'close-menu': () => document.getElementById('menu')?.close(),
  mute: () => {
    S.muted = !S.muted;
    store.set('sinyal.muted', S.muted ? '1' : '0');
    openMenu();
  },
  theme: () => {
    S.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
    store.set('sinyal.theme', S.theme);
    applyTheme();
    openMenu();
  },
};

document.addEventListener('click', (e) => {
  SOUND.unlock();
  if (e.target instanceof HTMLDialogElement) {
    e.target.close();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  ACTIONS[el.dataset.action]?.(el, e);
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'f-home') {
    const name = homeName();
    if (!name) return;
    if (S.inviteCode) joinWith({ type: 'join', code: S.inviteCode, name });
    else joinWith({ type: 'create', name });
  } else if (e.target.id === 'f-team') {
    const v = $('#team-input').value.trim();
    if (v) send({ type: 'set_team', name: v });
    $('#team-input').blur();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.target instanceof Element && e.target.closest('input, textarea, dialog')) || e.metaKey || e.ctrlKey || e.altKey) return;
  const s = st();
  if (!s || viewName() !== 'game') return;
  const r = round();
  const key = e.key.toLocaleLowerCase('tr-TR');
  if (canMarkNow() && ['j', 'a', 'e'].includes(key)) {
    S.tool = { j: 'token', a: 'cand', e: 'out' }[key];
    render();
    return;
  }
  if (s.phase === 'SIGNAL' && isCaptain()) {
    const hand = capInfo()?.hand ?? [];
    const k = Number(e.key);
    if (k >= 1 && k <= hand.length) {
      S.sel = hand[k - 1];
      render();
    } else if (e.key === 'Enter') playSelected();
  } else if (canMarkNow()) {
    const k = e.key === '0' ? 10 : Number(e.key);
    if (k >= 1 && k <= r.board.length && !r.board[k - 1].revealed) ACTIONS.tile({ dataset: { i: k - 1 } });
    else if (e.key.toLocaleLowerCase('tr-TR') === 'p') setToken(PASS);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.code && S.conn !== 'open') connect();
});

// ───────────────────────── başlangıç ─────────────────────────

applyTheme();
S.inviteCode = codeFromUrl();
const saved = store.session();
if (saved && (!S.inviteCode || S.inviteCode === saved.code)) {
  S.code = saved.code;
  S.token = saved.token;
  S.busy = true;
  connect();
}
render();
