// SİNYAL istemcisi. Sunucu otoriterdir; burası sadece durumu çizer ve eylemleri gönderir.
import { icon } from './icons.js';

const app = document.getElementById('app');
const KEY_ROWS = [
  ['E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', 'Ğ', 'Ü'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ş', 'İ'],
  ['ENTER', 'Z', 'C', 'V', 'B', 'N', 'M', 'Ö', 'Ç', 'BACK'],
];
const ALPHABET = new Set([...'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ']);
const WORD_PHASES = new Set(['WORD_SETUP', 'SIGNAL', 'DISCUSSION']);
const STEP_OF = { WORD_SETUP: 0, SIGNAL: 1, DISCUSSION: 2, MOLE_VOTE: 3, REVEAL: 3 };

const PHASE_LABEL = {
  WORD_SETUP: 'Hazırlık',
  SIGNAL: 'Sinyal',
  DISCUSSION: 'Tartışma',
  MOLE_VOTE: 'Köstebek oylaması',
  REVEAL: 'Sonuç',
};

const CHAOS = {
  category: { name: 'Kategori kilidi', icon: 'tag', desc: (w) => `Sinyaller yalnızca “${w.category}” kategorisinden olabilir.` },
  blind: { name: 'Kör renk', icon: 'eyeOff', desc: () => 'Bu kelimede turuncular (kelimede var) gri gösterilir.' },
  fast: { name: 'Hızlı tur', icon: 'zap', desc: () => 'Sinyal ve tartışma süreleri kısaldı.' },
  mole: { name: 'Köstebek', icon: 'ghost', desc: () => 'Tahmincilerden biri gizlice köstebek. Kelime bitince oylama var.' },
};

const RESULT = {
  solved: { label: 'Çözüldü', cls: 'ok' },
  trap: { label: 'Tuzak', cls: 'danger' },
  rows: { label: 'Satır bitti', cls: 'danger' },
  cancelled: { label: 'İptal', cls: '' },
};

const ERRORS = {
  WRONG_LENGTH: (s) => `Kelime ${s.state?.word?.length ?? ''} harfli olmalı`,
  NOT_IN_DICTIONARY: () => 'Sözlükte yok',
  FORBIDDEN_LETTER: () => 'Yasak harf içeriyor',
  WRONG_CATEGORY: (s) => `“${s.state?.word?.category ?? ''}” kategorisinde değil`,
  ALREADY_USED: () => 'Bu kelime bu turda kullanıldı',
  NOT_ALLOWED_IN_PHASE: () => 'Şu an bunu yapamazsın',
  RATE_LIMITED: () => 'Biraz yavaş: 2 saniyede bir öneri',
  ROOM_NOT_FOUND: () => 'Oda bulunamadı',
  ROOM_FULL: () => 'Oda dolu',
  NAME_TAKEN: () => 'Bu isim odada kullanılıyor',
  NAME_INVALID: () => 'Bir isim yaz',
  NOT_HOST: () => 'Bunu yalnızca oda sahibi yapabilir',
  NOT_ENOUGH_PLAYERS: (s) => `En az ${s.state?.minPlayers ?? 3} bağlı oyuncu gerekli`,
  TEAM_NAME_REQUIRED: () => 'Önce takım adını yaz',
  BANK_EMPTY: () => 'Kumbara boş',
  NO_PASS_ON_LAST_ROW: () => 'Son satırda pas yok',
  PAUSED: () => 'Oyun duraklatıldı',
  PROPOSAL_NOT_FOUND: () => 'Bu öneri artık yok',
  INVALID_VOTE: () => 'Geçersiz oy',
  INVALID_ORDER: () => 'Sıra güncellenemedi',
  INVALID_KICK: () => 'Bu oyuncu çıkarılamaz',
  KICKED: () => 'Bu odadan çıkarıldın',
  SERVER_FULL: () => 'Sunucu şu an dolu, biraz sonra dene',
  SERVER_ERROR: () => 'Sunucu hatası',
  INVALID_REACTION: () => 'Geçersiz tepki',
  CAPTAIN_SILENT: () => 'Kaptan kelime sürerken tepki veremez',
};

// ───────────────────────── yardımcılar ─────────────────────────

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const norm = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .toLocaleUpperCase('tr-TR')
    .replace(/Â/g, 'A')
    .replace(/Î/g, 'İ')
    .replace(/Û/g, 'U')
    .replace(/̇/g, '');

const local = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* gizli sekme vb. */
    }
  },
};

// Sekme başına oturum: aynı tarayıcıda iki sekme iki ayrı oyuncu olabilir, yenilemede yer korunur.
const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem('sinyal.session') || 'null');
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      sessionStorage.setItem('sinyal.session', JSON.stringify(v));
    } catch {
      /* yoksay */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem('sinyal.session');
    } catch {
      /* yoksay */
    }
  },
};

const S = {
  ws: null,
  connected: false,
  reconnectDelay: 800,
  reconnectTimer: null,
  openQueue: [],
  lastSeen: 0,
  names: {},
  statsOpen: false,
  myVote: null,
  replaced: false,
  me: session.get(),
  state: null,
  offset: 0,
  captainInfo: null,
  moleInfo: null,
  preview: null,
  typed: '',
  pending: null,
  screen: null,
  wordKey: null,
  renderedRows: 0,
  seenSeq: null,
  muted: local.get('sinyal.muted', false),
  hideSecret: false,
  editOrder: false,
  lastTick: null,
  composer: false,
  phaseKey: null,
};

const params = new URLSearchParams(location.search);
const urlCode = (params.get('oda') || location.pathname.match(/^\/oda\/([A-Za-z]{4})/)?.[1] || '').toUpperCase();
if (S.me && urlCode && S.me.code !== urlCode) S.me = null;

function me() {
  return S.state?.players.find((p) => p.id === S.me?.playerId);
}
function isHost() {
  return S.state && S.me && S.state.hostId === S.me.playerId;
}
function isCaptain() {
  return Boolean(S.state?.word && S.me && S.state.word.captainId === S.me.playerId);
}
function isMole() {
  return Boolean(S.moleInfo && !isCaptain());
}
function playerName(id) {
  return S.state?.players.find((p) => p.id === id)?.name ?? S.names[id] ?? '—';
}
function playerById(id) {
  return S.state?.players.find((p) => p.id === id) ?? { id, name: S.names[id] ?? '?', connected: false };
}
function serverNow() {
  return Date.now() + S.offset;
}

// ───────────────────────── ses ─────────────────────────

let actx = null;
function tone(freqs, { dur = 0.12, type = 'sine', gap = 0.09, vol = 0.07 } = {}) {
  if (S.muted) return;
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    freqs.forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.value = f;
      const t = actx.currentTime + i * gap;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    });
  } catch {
    /* ses desteklenmiyor */
  }
}
const SOUND = {
  start: () => tone([440, 587], { dur: 0.12 }),
  signal: () => tone([660, 880, 1175], { dur: 0.1, gap: 0.07 }),
  proposal: () => tone([740], { dur: 0.06, vol: 0.04 }),
  wrong: () => tone([233, 196], { dur: 0.16, type: 'triangle', gap: 0.1 }),
  solved: () => tone([523, 659, 784, 1047], { dur: 0.2, gap: 0.09 }),
  trap: () => tone([196, 147, 110], { dur: 0.28, type: 'sawtooth', gap: 0.14, vol: 0.05 }),
  coin: () => tone([988, 1319], { dur: 0.1, gap: 0.06 }),
  tick: () => tone([1100], { dur: 0.04, vol: 0.03 }),
  end: () => tone([392, 330, 262], { dur: 0.3, gap: 0.16 }),
  record: () => tone([523, 659, 784, 1047, 1319], { dur: 0.22, gap: 0.1 }),
  bonus: () => tone([1047, 1319, 1568], { dur: 0.12, gap: 0.06, type: 'triangle' }),
  golden: () => tone([784, 988, 1175, 1568], { dur: 0.16, gap: 0.08, type: 'triangle' }),
  chaos: () => tone([311, 466, 311], { dur: 0.14, gap: 0.1, type: 'square', vol: 0.04 }),
  lastLife: () => tone([220, 208, 196], { dur: 0.35, gap: 0.2, type: 'sawtooth', vol: 0.04 }),
};

// ───────────────────────── bildirimler ─────────────────────────

function toast(text, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 2800);
}

// ───────────────────────── büyük anlar (efektler) ─────────────────────────

const fxLayer = () => document.getElementById('fx');
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Ekranın ortasında kısa, büyük bir duyuru. */
function splash(title, sub = '', kind = '') {
  const el = document.createElement('div');
  el.className = `splash ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
  fxLayer().appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

function confetti() {
  if (reducedMotion()) return;
  const colors = ['var(--hit)', 'var(--near)', 'var(--gold)', 'var(--green)', '#ffffff'];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('i');
    p.className = 'confetti';
    p.style.left = `${Math.random() * 100}vw`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    p.style.animationDelay = `${Math.random() * 0.25}s`;
    p.style.animationDuration = `${1.2 + Math.random() * 0.9}s`;
    fxLayer().appendChild(p);
    setTimeout(() => p.remove(), 2600);
  }
}

function shake() {
  const flash = document.createElement('div');
  flash.className = 'flash-red';
  fxLayer().appendChild(flash);
  setTimeout(() => flash.remove(), 700);
  if (reducedMotion()) return;
  app.classList.remove('shake');
  void app.offsetWidth; // animasyonu yeniden başlat
  app.classList.add('shake');
  navigator.vibrate?.(200);
}

/** Tepki emojisi, gönderen oyuncunun masadaki yerinden yukarı uçar. */
function floatReaction(playerId, emoji) {
  const seat = document.querySelector(`#g-table [data-pid="${CSS.escape(playerId)}"]`);
  const box = seat?.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = 'float-emoji';
  el.textContent = emoji;
  el.style.left = `${box ? box.left + box.width / 2 : window.innerWidth / 2}px`;
  el.style.top = `${box ? box.top : window.innerHeight / 2}px`;
  fxLayer().appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function onWordEnd(ev) {
  const extras = [];
  if (ev.lightning) extras.push('Yıldırım +1 kumbara');
  if (ev.streakBonus) extras.push(`${ev.streak}'li seri +1 kumbara`);
  else if (ev.streak >= 2) extras.push(`${ev.streak}'li seri`);
  if (ev.goldenLife) extras.push('Altın: +1 can');
  else if (ev.golden) extras.push('Altın: +2 kumbara');
  if (ev.result === 'solved') {
    SOUND.solved();
    if (ev.lightning || ev.streakBonus || ev.golden) setTimeout(SOUND.bonus, 450);
    confetti();
    splash(ev.lightning ? 'YILDIRIM!' : 'BULUNDU!', extras.join(' · '), 'good');
  } else if (ev.result === 'trap') {
    SOUND.trap();
    shake();
    splash('TUZAK!', ev.streakLost >= 2 ? `${ev.streakLost}'li seri bozuldu · −1 can` : '−1 can', 'bad');
  } else if (ev.result === 'rows') {
    SOUND.end();
    shake();
    splash('SATIRLAR BİTTİ', '−1 can', 'bad');
  } else if (ev.result === 'cancelled') {
    toast('Kaptan dönmedi; kelime iptal edildi (can kaybı yok)');
  }
  if (ev.lifeLost && ev.lives === 1) {
    setTimeout(() => {
      SOUND.lastLife();
      splash('SON CAN!', 'Bir hata daha ve oyun biter', 'bad');
    }, 1900);
  }
}

// ───────────────────────── bağlantı ─────────────────────────

function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function connect(onOpen) {
  clearTimeout(S.reconnectTimer);
  if (S.ws && S.ws.readyState === WebSocket.CONNECTING) {
    // Zaten bağlanıyor: açılınca bu isteği de çalıştır.
    if (onOpen) S.openQueue.push(onOpen);
    return;
  }
  const ws = new WebSocket(wsUrl());
  S.ws = ws;
  S.openQueue = onOpen ? [onOpen] : [];
  let opened = false;
  ws.onopen = () => {
    if (S.ws !== ws) {
      ws.close();
      return;
    }
    opened = true;
    S.connected = true;
    S.lastSeen = Date.now();
    S.reconnectDelay = 800;
    renderConn();
    const queue = S.openQueue;
    S.openQueue = [];
    for (const fn of queue) fn();
  };
  ws.onmessage = (e) => {
    if (S.ws !== ws) return; // eski bağlantıdan gelen mesaj
    S.lastSeen = Date.now();
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false;
    S.ws = null;
    renderConn();
    if (S.me && !S.replaced) {
      S.reconnectTimer = setTimeout(() => connect(rejoin), S.reconnectDelay);
      S.reconnectDelay = Math.min(5000, S.reconnectDelay * 1.7);
    } else if (!opened) toast('Sunucuya bağlanılamadı, tekrar dene', 'err');
  };
}

/** Uyuyan/kopuk bağlantıyı hızlı fark etmek için düzenli ping; cevap gelmezse yeniden bağlan. */
function heartbeat() {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - S.lastSeen > 45_000) {
    S.ws.close();
    return;
  }
  S.ws.send('{"type":"ping"}');
}

function reconnectNow() {
  if (!S.me || S.replaced) return;
  if (S.ws && S.ws.readyState <= WebSocket.OPEN) return;
  S.reconnectDelay = 800;
  connect(rejoin);
}

function send(msg) {
  if (S.ws?.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(msg));
    return true;
  }
  toast('Bağlantı yok', 'err');
  return false;
}

function rejoin() {
  if (S.me) send({ type: 'join', code: S.me.code, token: S.me.token, name: local.get('sinyal.name', '') });
}

function withSocket(fn) {
  if (S.ws?.readyState === WebSocket.OPEN) fn();
  else connect(fn);
}

function goHome(message) {
  session.clear();
  S.me = null;
  S.state = null;
  S.captainInfo = null;
  S.moleInfo = null;
  S.seenSeq = null;
  history.replaceState(null, '', '/');
  if (message) local.set('sinyal.flash', message);
  location.reload();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      S.me = { code: msg.code, playerId: msg.playerId, token: msg.token };
      session.set(S.me);
      history.replaceState(null, '', `/?oda=${msg.code}`);
      break;
    case 'state': {
      S.offset = msg.serverNow - Date.now();
      const prev = S.state;
      S.state = msg;
      onState(prev, msg);
      render();
      break;
    }
    case 'captain_info':
      S.captainInfo = msg;
      render();
      break;
    case 'mole_info':
      S.moleInfo = msg;
      render();
      break;
    case 'signal_preview':
      if (msg.word === S.typed) {
        S.preview = msg;
        renderTyped();
      }
      break;
    case 'error':
      onError(msg);
      break;
    case 'replaced':
      S.replaced = true;
      S.state = null;
      render();
      break;
    case 'kicked':
      goHome('Oda sahibi seni odadan çıkardı.');
      break;
    default:
      break;
  }
}

function onError(msg) {
  if (msg.about === 'join' && S.me && !S.state) {
    // Kayıtlı oturumla yeniden bağlanılamadı (oda kapanmış vb.): giriş ekranına dön.
    session.clear();
    S.me = null;
    if (msg.code === 'ROOM_NOT_FOUND') history.replaceState(null, '', '/');
    render();
  }
  if (['send_signal', 'propose_guess'].includes(msg.about)) S.pending = null;
  const text = ERRORS[msg.code]?.(S) ?? msg.code;
  toast(text, 'err');
}

function onState(prev, st) {
  for (const p of st.players) S.names[p.id] = p.name; // ayrılan oyuncuların adı da gösterilebilsin
  const key = st.run && st.word ? `${st.run.wordIndex}` : null;
  if (key !== S.wordKey) {
    S.wordKey = key;
    S.typed = '';
    S.preview = null;
    S.pending = null;
    S.renderedRows = 0;
    S.myVote = null;
  }
  const idx = st.run?.wordIndex;
  if (S.captainInfo && S.captainInfo.wordIndex !== idx) S.captainInfo = null;
  if (S.moleInfo && S.moleInfo.wordIndex !== idx) S.moleInfo = null;
  if (!st.run) {
    S.captainInfo = null;
    S.moleInfo = null;
  }

  // Klavye: kaptan sinyal aşamasına girince otomatik açılır, diğer aşama geçişlerinde kapanır.
  const phaseKey = `${idx}:${st.phase}`;
  if (phaseKey !== S.phaseKey) {
    S.phaseKey = phaseKey;
    S.composer = Boolean(st.word && st.phase === 'SIGNAL' && st.word.captainId === S.me?.playerId);
  }

  if (S.pending && st.word) {
    const done = st.word.board.some((r) => r.word === S.pending) || st.word.proposals.some((p) => p.word === S.pending);
    if (done) {
      S.typed = '';
      S.preview = null;
      S.pending = null;
      if (st.word.captainId !== S.me?.playerId) S.composer = false;
    }
  }

  // olaylar → ses ve bildirim
  const events = st.events || [];
  const maxSeq = events.length ? events[events.length - 1].seq : 0;
  if (S.seenSeq == null) {
    S.seenSeq = maxSeq;
    return;
  }
  for (const ev of events) {
    if (ev.seq <= S.seenSeq) continue;
    handleEvent(ev, st);
  }
  S.seenSeq = Math.max(S.seenSeq, maxSeq);
}

function handleEvent(ev, st) {
  const mine = ev.playerId === S.me?.playerId;
  switch (ev.type) {
    case 'run_start':
      SOUND.start();
      break;
    case 'word_start':
      SOUND.start();
      if (ev.captainId === S.me?.playerId) {
        toast('Kaptan sensin — konuşmak yok', 'good');
        navigator.vibrate?.([120, 60, 120]);
      } else toast(`${ev.wordIndex}. kelime · Kaptan: ${playerName(ev.captainId)}`);
      if (ev.golden) {
        SOUND.golden();
        splash('ALTIN KELİME', 'Bir satır eksik · çözerseniz +1 can', 'gold');
      } else if (ev.chaosCard) {
        SOUND.chaos();
        splash('KAOS KARTI', CHAOS[ev.chaosCard].name, 'chaos');
      }
      break;
    case 'signal':
      SOUND.signal();
      break;
    case 'empty_row':
      SOUND.wrong();
      toast('Sinyal süresi doldu: boş satır');
      break;
    case 'proposal':
      if (!mine) SOUND.proposal();
      break;
    case 'wrong_guess':
      SOUND.wrong();
      break;
    case 'pass':
      toast('Pas geçildi');
      break;
    case 'time_up':
      toast('Tartışma süresi doldu');
      break;
    case 'bank_row':
      SOUND.coin();
      toast('Kumbaradan 1 satır alındı', 'good');
      break;
    case 'word_end':
      onWordEnd(ev);
      break;
    case 'react':
      floatReaction(ev.playerId, ev.emoji);
      break;
    case 'mole_result':
      toast(ev.caught ? 'Köstebek yakalandı! +1 can' : 'Köstebek kaçtı', ev.caught ? 'good' : 'err');
      break;
    case 'run_end':
      if (ev.newRecord) SOUND.record();
      else SOUND.end();
      break;
    case 'host':
      if (mine) toast('Artık oda sahibi sensin', 'good');
      break;
    case 'join':
      if (!mine && st.phase !== 'LOBBY') toast(`${playerName(ev.playerId)} katıldı`);
      break;
    case 'disconnect':
      if (!mine && st.phase !== 'LOBBY') toast(`${ev.name} bağlantısı koptu`, 'err');
      break;
    case 'reconnect':
      if (!mine && st.phase !== 'LOBBY') toast(`${ev.name} geri döndü`, 'good');
      break;
    case 'leave':
      if (!mine && st.phase !== 'LOBBY' && !S.kickedIds?.has(ev.playerId)) toast(`${ev.name} oyundan ayrıldı`);
      break;
    case 'kick':
      (S.kickedIds ??= new Set()).add(ev.playerId);
      if (!mine) toast(`${ev.name} odadan çıkarıldı`);
      break;
    case 'paused':
      toast('Oyun duraklatıldı');
      break;
    case 'resumed':
      toast('Oyun devam ediyor');
      break;
    default:
      break;
  }
}

// ───────────────────────── çizim altyapısı ─────────────────────────

function currentScreen() {
  if (S.replaced) return 'replaced';
  if (!S.me) return 'home';
  if (!S.state) return 'connecting';
  if (S.state.phase === 'LOBBY') return 'lobby';
  if (S.state.phase === 'RUN_END') return 'end';
  return 'game';
}

/**
 * data-memo işaretli bölümlerde innerHTML yalnızca içerik gerçekten değiştiğinde yazılır.
 * Böylece her durum güncellemesinde düğmeler yeniden oluşmaz; tıklamalar ve açık/kapalı
 * bölümler kaybolmaz.
 */
const INNER_HTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
function memoizeHTML(el) {
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return INNER_HTML.get.call(this);
    },
    set(html) {
      if (this.memoHTML === html) return;
      this.memoHTML = html;
      INNER_HTML.set.call(this, html);
    },
  });
}

function render() {
  const screen = currentScreen();
  if (screen !== S.screen) {
    S.screen = screen;
    app.innerHTML = `<div class="wrap screen-${screen}">${LAYOUT[screen]()}</div>`;
    app.querySelectorAll('[data-memo]').forEach(memoizeHTML);
    MOUNT[screen]?.();
  }
  if (screen !== 'game') document.body.classList.remove('last-life');
  UPDATE[screen]?.();
  renderConn();
  updateTitle();
}

function renderConn() {
  document.getElementById('conn').hidden = !(S.me && !S.connected && !S.replaced);
}

function updateTitle() {
  const st = S.state;
  let title = 'SİNYAL';
  if (S.screen === 'lobby') title = `Lobi · ${st.code} · SİNYAL`;
  else if (S.screen === 'end') title = 'Oyun bitti · SİNYAL';
  else if (S.screen === 'game') {
    const rem = remainingMs();
    const secs = rem != null && !st.paused ? `(${Math.ceil(rem / 1000)}) ` : '';
    const cap = isCaptain();
    const label = st.paused
      ? '⏸ Duraklatıldı'
      : st.phase === 'SIGNAL' && cap
        ? '📡 Sinyal sırası sende!'
        : st.phase === 'WORD_SETUP' && cap
          ? '🤐 Kaptan sensin!'
          : st.phase === 'DISCUSSION' && !cap
            ? '💬 Tartışma'
            : PHASE_LABEL[st.phase] ?? '';
    title = `${secs}${label} · SİNYAL`;
  }
  if (document.title !== title) document.title = title;
}

// ───────────────────────── ortak parçalar ─────────────────────────

function logo(small = false) {
  return `<span class="logo ${small ? 'sm' : ''}" role="img" aria-label="SİNYAL"><span class="logo-mark">${icon('signal', { size: small ? 14 : 26 })}</span><span class="logo-word">SİNYAL</span></span>`;
}

function hueOf(name) {
  let h = 7;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function avatar(p, { small = false, status = false } = {}) {
  const initial = [...String(p.name || '?')][0].toLocaleUpperCase('tr-TR');
  return `<span class="avatar ${small ? 'sm' : ''} ${p.connected === false ? 'off' : ''}" style="--hue:${hueOf(p.name)}" title="${esc(p.name)}">${esc(initial)}${
    status ? '<i class="status"></i>' : ''
  }</span>`;
}

/** Kelimeyi küçük bir kâğıt kart olarak gösterir (gizli kelime, tuzak, öneri). */
function wordChip(word, kind = '') {
  return `<span class="wchip ${kind ? `is-${kind}` : ''}">${esc(word)}</span>`;
}

/** Kart üzerindeki harfler: her harfin altında renk çizgisi (tam yer / kelimede var / yok). */
function lettersHtml(word, colors, len = [...word].length) {
  const letters = [...word];
  return Array.from({ length: len }, (_, k) => {
    const c = letters[k];
    if (!c) return '<span class="lt blank">&nbsp;<i></i></span>';
    return `<span class="lt ${colors ? `c-${colors[k]}` : 'typed'}">${esc(c)}<i></i></span>`;
  }).join('');
}

function forbiddenChips(letters) {
  return `<span class="forbidden">${letters.map((c) => `<span class="forbidden-chip">${esc(c)}</span>`).join('')}</span>`;
}

const RULES = `
<details class="card rules">
  <summary>${icon('help')} Nasıl oynanır?</summary>
  <ul>
    <li>2–8 kişilik <b>tek takım</b> olarak, Discord gibi sesli bir kanalda oynayın. İki kişide biri kaptan, diğeri tahminci olur.</li>
    <li>Her kelimede biri <b>kaptan</b> olur: gizli kelimeyi görür ama <b>konuşamaz</b>, sadece <b>sinyal kelimesi</b> gönderir.</li>
    <li>Sinyalin <b>anlamı</b> gizli kelimeyi çağrıştırır; <b>harfleri</b> de ipucu verir: harfin altındaki çizgi mavi ise harf tam yerinde, turuncu ise kelimede var ama başka yerde, gri ise kelimede yok.</li>
    <li><b>Tuzaklar</b> gizli kelimeden tek harf farklı kelimelerdir; tuzağı tahmin etmek can götürür. Kaptan, farkı veren <b>yasak harfleri</b> kullanamaz — bu ayrımı ancak anlamla verebilir.</li>
    <li>Tahminciler tartışır, tahmin önerir ve onaylar. Çoğunluk onaylayınca tahmin gönderilir (tek tahminci varsa hemen). Bir tartışmada en fazla 2 tahmin.</li>
    <li>Her sinyal, tahmin ya da boş satır bir satır harcar. Son satır sadece tahmin içindir.</li>
    <li>Çözülen kelimede artan satırlar <b>kumbaraya</b> gider; gerekince oybirliğiyle kumbaradan satır çekin.</li>
    <li>En fazla 1 sinyalle çözülen kelime yıldız kazandırır. Her 5 çözümde +1 can. Canlar bitene kadar devam!</li>
    <li>4. kelimeden itibaren her 3 kelimede bir <b>kaos kartı</b>: kategori kilidi, kör renk, hızlı tur, köstebek.</li>
    <li><b>Bonuslar:</b> üst üste her 3 çözüm (seri) ve sinyalden sonraki 20 saniyede çözüm (yıldırım) kumbaraya +1 satır kazandırır. Ara sıra gelen <b>altın kelime</b> bir satır eksiktir ama çözülürse +1 can verir.</li>
    <li>Tahminciler masadan tepki gönderebilir; kaptan kelime sürerken tepki de veremez.</li>
  </ul>
</details>`;

// ───────────────────────── ekranlar ─────────────────────────

const LAYOUT = {
  home: () => `
    <main class="home">
      <div class="hero">
        ${logo()}
        <p>2–8 kişilik takım kelime oyunu. Kaptan gizli kelimeyi bilir ama konuşamaz; sadece sinyal kartı gönderir.</p>
      </div>
      <section class="card stack">
        <label class="field"><span class="label">Adın</span><input class="input" type="text" id="name" maxlength="16" autocomplete="nickname" placeholder="ör. Deniz" /></label>
        ${
          urlCode
            ? `<button class="btn primary block" data-action="join">${esc(urlCode)} odasına katıl</button>
               <div class="divider">ya da</div>
               <button class="btn ghost block" data-action="create">Yeni oda kur</button>`
            : `<button class="btn primary block" data-action="create">Oda kur</button>
               <div class="divider">ya da koda katıl</div>
               <div class="join-row"><input class="input code" type="text" id="code" maxlength="4" placeholder="KOD" autocomplete="off" aria-label="Oda kodu" /><button class="btn" data-action="join">Katıl</button></div>`
        }
      </section>
      <section class="intro">
        <div class="intro-step"><span class="num">${icon('micOff')}</span><div><b>Kaptan konuşamaz</b><span>Gizli kelimeyi bilen kaptan sadece sinyal kelimeleri gönderir.</span></div></div>
        <div class="intro-step"><span class="num">${icon('palette')}</span><div><b>Anlam + renkler</b><span>Sinyal kartının anlamı çağrıştırır; harflerin altındaki renkli çizgiler ek ipucu verir.</span></div></div>
        <div class="intro-step"><span class="num">${icon('alert')}</span><div><b>Tuzaklara dikkat</b><span>Tek harf farklı tuzak kelimeyi tahmin etmek can götürür.</span></div></div>
      </section>
      ${RULES}
    </main>`,
  connecting: () => `
    <div class="center-screen"><div class="stack">${logo()}<div class="spinner" aria-hidden="true"></div><div class="muted">Odaya bağlanılıyor…</div>
    <button class="text-btn" data-action="leave">Vazgeç</button></div></div>`,
  replaced: () => `
    <div class="center-screen"><div class="stack">${logo()}<div class="h2">Bu oyun başka bir sekmede açık</div>
    <div class="muted">Aynı oyuncu olarak tek bir sekmede oynayabilirsin.</div>
    <button class="btn primary" data-action="take-over">Burada devam et</button></div></div>`,
  lobby: () => `
    <main class="lobby">
      <header class="topbar">
        <div class="brand">${logo(true)}<span class="name">Lobi</span></div>
        <button class="text-btn" data-action="leave">${icon('logout', { size: 16 })} Odadan çık</button>
      </header>
      <section class="card stack">
        <div class="spread">
          <div><div class="label">Oda kodu</div><div class="room-code" id="l-code"></div></div>
          <button class="btn sm" data-action="copy-link">${icon('link', { size: 16 })} Davet linki</button>
        </div>
        <div class="muted small">Linki arkadaşlarına gönder. Sesli konuşma için Discord gibi bir kanal kullanın.</div>
      </section>
      <section class="card stack">
        <div class="label">Takım adı</div>
        <div id="l-team"></div>
        <div id="l-record" class="muted small"></div>
      </section>
      <section class="card">
        <div class="spread" style="margin-bottom:4px">
          <div class="label">Oyuncular · kaptan sırası <span id="l-count"></span></div>
          <div id="l-order-tools" data-memo></div>
        </div>
        <ol class="plist" id="l-players" data-memo></ol>
        <div id="l-order" class="muted small" style="margin-top:6px" data-memo></div>
      </section>
      <section class="cta" id="l-actions" data-memo></section>
      ${RULES}
    </main>`,
  game: () => `
    <main class="game">
      <header class="topbar" id="g-top" data-memo></header>
      <section class="turn" id="g-turn" data-memo aria-live="polite"></section>
      <div class="col-main">
        <section id="g-table" data-memo></section>
        <section id="g-word" data-memo></section>
        <section class="feed" id="g-board" data-memo aria-label="Kaptanın sinyalleri"></section>
        <div class="dock">
          <div id="g-compose" data-memo></div>
          <div class="typed" id="g-typed" data-memo></div>
          <div class="keyboard" id="g-keyboard" data-memo></div>
        </div>
      </div>
      <aside class="col-side">
        <div id="g-info" data-memo></div>
        <div id="g-secret" data-memo></div>
        <section class="panel" id="g-panel" data-memo></section>
        <div class="toolbar" id="g-tools" data-memo></div>
        ${RULES}
      </aside>
    </main>`,
  end: () => `<main class="end" id="e-main" data-memo></main>`,
};

const MOUNT = {
  home() {
    const name = document.getElementById('name');
    name.value = local.get('sinyal.name', '');
    (name.value ? (document.getElementById('code') ?? name) : name).focus();
    const submit = (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'code' || urlCode) doJoin();
      else doCreate();
    };
    name.addEventListener('keydown', submit);
    document.getElementById('code')?.addEventListener('keydown', submit);
  },
  lobby() {
    S.teamMode = null;
  },
};

// ── lobi ──

function updateLobby() {
  const st = S.state;
  document.getElementById('l-code').textContent = st.code;

  const team = document.getElementById('l-team');
  const mode = isHost() ? 'host' : 'view';
  if (S.teamMode !== mode) {
    S.teamMode = mode;
    if (mode === 'host') {
      team.innerHTML = `<input class="input" type="text" id="team-input" maxlength="24" placeholder="ör. Kartallar" />`;
      const input = document.getElementById('team-input');
      input.value = st.teamName;
      let t;
      const push = () => send({ type: 'set_team', name: input.value });
      input.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(push, 400);
      });
      input.addEventListener('change', push);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    } else team.innerHTML = `<div class="h2" id="team-view"></div>`;
  }
  if (mode === 'host') {
    const input = document.getElementById('team-input');
    if (document.activeElement !== input && input.value !== st.teamName) input.value = st.teamName;
  } else {
    const view = document.getElementById('team-view');
    view.textContent = st.teamName || 'Oda sahibi belirleyecek';
    view.classList.toggle('muted', !st.teamName);
  }
  document.getElementById('l-record').textContent = st.record
    ? `Takım rekoru: ${st.record.bestScore} kelime · ${st.record.bestStars} yıldız · ${st.record.runs} oyun`
    : st.teamName
      ? 'Bu takımın henüz rekoru yok.'
      : '';

  const players = st.players;
  document.getElementById('l-count').textContent = `(${players.length}/${st.maxPlayers})`;
  document.getElementById('l-order-tools').innerHTML = isHost()
    ? `<button class="btn sm ghost" data-action="shuffle">${icon('shuffle', { size: 16 })} Karıştır</button>`
    : '';
  document.getElementById('l-players').innerHTML = players.map((p, i) => playerRow(p, i, players.length, isHost())).join('');
  document.getElementById('l-order').textContent = isHost()
    ? 'Sırayı oklarla düzenle. Elle düzenlenmezse oyun başında rastgele belirlenir.'
    : 'Kaptan sırası oyun başında rastgele belirlenir.';

  const connected = players.filter((p) => p.connected).length;
  let hint = '';
  if (!st.teamName) hint = 'Başlamak için takım adı gerekli.';
  else if (connected < st.minPlayers) hint = `Başlamak için en az ${st.minPlayers} bağlı oyuncu gerekli (şu an ${connected}).`;
  const ready = me()?.ready;
  const readyCount = players.filter((p) => p.ready).length;
  document.getElementById('l-actions').innerHTML = `
    <div class="buttons ${isHost() ? '' : 'single'}">
      <button class="btn ${ready ? 'on' : ''}" data-action="ready">${ready ? `${icon('check', { size: 16 })} Hazırım` : 'Hazırım'}</button>
      ${isHost() ? `<button class="btn primary" data-action="start" ${hint ? 'disabled' : ''}>${icon('play', { size: 16 })} Oyunu başlat</button>` : ''}
    </div>
    <div class="hint">${esc(
      isHost() ? hint || `${readyCount}/${players.length} oyuncu hazır. Herkes hazırsa başlatabilirsin.` : `${readyCount}/${players.length} oyuncu hazır. Oyunu oda sahibi başlatacak.`,
    )}</div>`;
}

/** Lobide ve oyundaki "sıra ve oyuncular" düzenleyicisinde kullanılan oyuncu satırı. */
function playerRow(p, i, total, editable) {
  const st = S.state;
  const self = p.id === S.me.playerId;
  return `<li>
    <span class="order">${i + 1}</span>
    ${avatar(p, { status: true })}
    <span class="pname"><b>${esc(p.name)}</b>
      ${self ? '<span class="tag">sen</span>' : ''}
      ${p.id === st.hostId ? `<span class="tag host">${icon('crown', { size: 12 })} oda sahibi</span>` : ''}
      ${st.phase === 'LOBBY' && p.ready ? `<span class="tag ok">${icon('check', { size: 12 })} hazır</span>` : ''}
      ${p.connected ? '' : '<span class="tag danger">bağlantı yok</span>'}
    </span>
    ${
      editable
        ? `<span class="tools">
            <button class="icon-btn sm" data-action="move" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Yukarı taşı">${icon('up', { size: 16 })}</button>
            <button class="icon-btn sm" data-action="move" data-id="${p.id}" data-dir="1" ${i === total - 1 ? 'disabled' : ''} aria-label="Aşağı taşı">${icon('down', { size: 16 })}</button>
            ${self ? '' : `<button class="icon-btn sm danger" data-action="kick" data-id="${p.id}" title="Odadan çıkar" aria-label="Odadan çıkar">${icon('x', { size: 16 })}</button>`}
          </span>`
        : ''
    }
  </li>`;
}

// ── oyun ──

function updateGame() {
  document.body.classList.toggle('last-life', S.state.run?.lives === 1);
  renderTop();
  renderTurn();
  renderTable();
  renderWord();
  renderInfo();
  renderSecret();
  renderBoard();
  renderPanel();
  renderCompose();
  renderTyped();
  renderKeyboard();
  renderTools();
}

function renderTop() {
  const st = S.state;
  const run = st.run;
  const hearts = Array.from({ length: run.maxLives }, (_, i) => icon('heart', { size: 16, fill: true, cls: i < run.lives ? '' : 'lost' })).join('');
  document.getElementById('g-top').innerHTML = `
    <div class="brand">${logo(true)}<div style="min-width:0"><div class="name">${esc(st.teamName)}</div><div class="code">ODA ${esc(st.code)}</div></div></div>
    <div class="stats">
      <span class="pill hearts" title="Can: ${run.lives}/${run.maxLives}" aria-label="Can ${run.lives}">${hearts}</span>
      <span class="pill gold" title="Kumbara (yedek satır)">${icon('coins', { size: 16 })}${run.bank}</span>
      <span class="pill" title="Çözülen kelime">${icon('check', { size: 16 })}${run.score}</span>
      <span class="pill gold" title="Yıldız">${icon('star', { size: 16, fill: true })}${run.stars}</span>
      ${run.streak >= 2 ? `<span class="pill streak" title="Üst üste çözülen kelime">${icon('flame', { size: 16, fill: true })}${run.streak}</span>` : ''}
    </div>
    <button class="icon-btn" data-action="mute" title="${S.muted ? 'Sesi aç' : 'Sesi kapat'}" aria-label="Ses">${icon(S.muted ? 'mute' : 'volume')}</button>`;
}

function remainingMs() {
  const st = S.state;
  if (!st) return null;
  if (st.endsAt) return Math.max(0, st.endsAt - serverNow());
  if (st.pausedRemaining != null) return st.pausedRemaining;
  return null;
}

/** Bu oyuncu için "şimdi ne oluyor / ne yapmalıyım" metni. */
function turnInfo() {
  const st = S.state;
  const w = st.word;
  const cap = isCaptain();
  const capName = cap ? 'sen' : playerName(w.captainId);
  const kicker = `${st.run.wordIndex}. kelime${w.golden ? ' · ALTIN' : ''} · Kaptan: ${capName}`;
  switch (st.phase) {
    case 'WORD_SETUP':
      if (cap) return { kicker, icon: 'micOff', title: 'Kaptan sensin', sub: 'Gizli kelimeyi ve tuzakları incele. Bu kelime boyunca konuşma.', mine: true };
      if (isMole()) return { kicker, icon: 'ghost', title: 'Köstebeksin', sub: 'Gizli kelimeyi biliyorsun. Takımı fark ettirmeden tuzağa çek.', mine: true };
      return { kicker, icon: 'signal', title: 'Yeni kelime', sub: `${w.length} harf. ${capName} birazdan sinyal gönderecek; kaptan konuşamaz.` };
    case 'SIGNAL':
      if (cap) return { kicker, icon: 'send', title: 'Sinyal gönder', sub: `${w.length} harfli, yasak harf içermeyen bir kelime yaz.`, mine: true };
      return { kicker, icon: 'signal', title: `${capName} sinyal seçiyor`, sub: 'Bu sırada aklınızdaki adayları konuşabilirsiniz.' };
    case 'DISCUSSION': {
      const last = w.rowsRemaining <= 1;
      if (cap) return { kicker, icon: 'micOff', title: 'Takım tartışıyor', sub: 'Sessiz kal. Sıradaki sinyalini şimdiden yazabilirsin.' };
      if (w.guesserCount === 1) {
        return {
          kicker,
          icon: 'target',
          title: 'Tahmin et',
          sub: last ? 'Son kart: pas yok, süre dolarsa kelime kaybedilir.' : 'Tek tahminci sensin: tahminin onay beklemeden gönderilir.',
          mine: true,
          warn: last,
        };
      }
      return {
        kicker,
        icon: 'messages',
        title: 'Tartışın ve tahmin önerin',
        sub: last
          ? 'Son kart: pas yok, süre dolarsa kelime kaybedilir.'
          : `Çoğunluk (${w.thresholds.guess}/${w.guesserCount}) onaylayınca tahmin gönderilir.`,
        mine: true,
        warn: last,
      };
    }
    case 'MOLE_VOTE': {
      const voted = (w.votedIds || []).includes(S.me.playerId);
      return {
        kicker,
        icon: 'ghost',
        title: 'Köstebek kim?',
        sub: voted ? 'Oyun alındı. Diğerleri bekleniyor.' : 'Şüphelendiğin kişiye oy ver. Yakalanırsa takım +1 can kazanır.',
        mine: !voted,
      };
    }
    case 'REVEAL': {
      const r = st.reveal;
      const t = { solved: ['check2', r?.lightning ? 'Yıldırım gibi!' : 'Bulundu!'], trap: ['alert', 'Tuzağa düştünüz'], rows: ['clock', 'Satırlar bitti'] }[r?.result] ?? ['check2', 'Kelime bitti'];
      return { kicker, icon: t[0], title: t[1], sub: st.run.lives > 0 ? 'Sıradaki kelime birazdan…' : 'Canlar bitti, sonuçlar geliyor…' };
    }
    default:
      return { kicker, icon: 'signal', title: '', sub: '' };
  }
}

function renderTurn() {
  const st = S.state;
  const el = document.getElementById('g-turn');
  if (!el || !st.word) return;
  const info = turnInfo();
  const rem = remainingMs();
  const secs = rem == null ? '' : Math.ceil(rem / 1000);
  const timed = st.phase === 'SIGNAL' || st.phase === 'DISCUSSION' || st.phase === 'MOLE_VOTE';
  const low = timed && rem != null && rem < 10_000 && !st.paused;
  const pct = rem != null && st.phaseDuration ? Math.max(0, Math.min(100, (rem / st.phaseDuration) * 100)) : 0;
  const step = STEP_OF[st.phase] ?? 0;
  const steps = ['Hazırlık', 'Sinyal', 'Tartışma', st.phase === 'MOLE_VOTE' ? 'Oylama' : 'Sonuç'];
  const urgent = rem != null && rem < 10_000 && !st.paused && (st.phase === 'SIGNAL' || st.phase === 'DISCUSSION');

  let pause = '';
  if (st.paused) {
    const parts = [];
    if (st.pauseReasons.includes('host')) parts.push('Oda sahibi oyunu duraklattı.');
    if (st.pauseReasons.includes('captain')) {
      const left = st.captainAwayUntil ? Math.max(0, Math.ceil((st.captainAwayUntil - serverNow()) / 1000)) : '';
      parts.push(`Kaptanın bağlantısı koptu, ${left} sn bekleniyor. Dönmezse kelime iptal edilir.`);
    }
    if (st.pauseReasons.includes('players')) parts.push(`Oyuncu bekleniyor: en az ${st.minPlayers} bağlı oyuncu gerekli.`);
    pause = `<div class="notice pause-note">${icon('pause', { size: 16 })}<div>${esc(parts.join(' '))}</div></div>`;
  }

  el.className = `turn ${info.mine && !st.paused ? 'mine' : ''} ${st.paused ? 'paused' : ''} ${urgent ? 'urgent' : ''}`;
  el.dataset.phase = st.phase;
  el.innerHTML = `
    <ol class="steps">${steps.map((s, i) => `<li class="${i < step ? 'done' : i === step ? 'current' : ''}">${s}</li>`).join('')}</ol>
    <div class="turn-main">
      <div class="turn-icon">${icon(info.icon, { size: 22 })}</div>
      <div class="turn-text">
        <div class="turn-kicker">${esc(info.kicker)}</div>
        <div class="turn-title">${esc(info.title)}</div>
        <div class="turn-sub" ${info.warn ? 'style="color:var(--red)"' : ''}>${esc(info.sub)}</div>
      </div>
      ${
        st.paused
          ? `<div class="timer"><b>${icon('pause', { size: 24 })}</b><span>durdu</span></div>`
          : secs === ''
            ? ''
            : `<div class="timer ${low ? 'low' : ''}"><b>${secs}</b><span>saniye</span></div>`
      }
    </div>
    ${pause}
    <div class="bar ${low ? 'low' : ''}" style="width:${st.paused ? 0 : pct}%"></div>`;

  // son 5 saniyede tik sesi (sadece ilgili oyuncuya)
  if (rem != null && !st.paused && secs <= 5 && secs > 0 && S.lastTick !== `${st.phase}:${secs}`) {
    S.lastTick = `${st.phase}:${secs}`;
    const relevant = (st.phase === 'SIGNAL' && isCaptain()) || (st.phase === 'DISCUSSION' && !isCaptain());
    if (relevant) SOUND.tick();
  }
}

function renderInfo() {
  const w = S.state.word;
  const card = w?.chaosCard ? CHAOS[w.chaosCard] : null;
  document.getElementById('g-info').innerHTML = card
    ? `<div class="callout chaos">${icon(card.icon)}<div><b>Kaos kartı: ${card.name}</b><span>${esc(card.desc(w))}</span></div></div>`
    : '';
}

/** Tahtadan çıkan ortak bilgi: kesin yerini bildiğimiz harfler, kelimede olanlar, olmayanlar. */
function knowledge(w) {
  const known = Array(w.length).fill(null);
  const present = new Set();
  const absent = new Set();
  for (const row of w.board) {
    if (!row.colors) continue;
    [...row.word].forEach((c, i) => {
      const col = row.colors[i];
      if (col === 'G') known[i] = c;
      else if (col === 'Y') present.add(c);
      else absent.add(c);
    });
  }
  for (const c of known) if (c) present.delete(c);
  for (const c of [...absent]) if (present.has(c) || known.includes(c)) absent.delete(c);
  return { known, present: [...present], absent: [...absent] };
}

/** Gizli kelime kartı: seviye, kurallar, takımın bildiği harfler ve tuzağın hangi harfte olduğu. */
function renderWord() {
  const w = S.state.word;
  const el = document.getElementById('g-word');
  if (!w) {
    el.innerHTML = '';
    return;
  }
  const k = knowledge(w);
  const blind = w.chaosCard === 'blind';
  const slots = k.known
    .map((c, i) => {
      const trap = w.trapPos === i;
      return `<span class="slot ${c ? 'known' : ''} ${trap ? 'trap' : ''}" ${trap ? 'title="Tuzak bu harfte"' : ''}>${c ? esc(c) : '?'}${trap ? '<em>tuzak</em>' : ''}</span>`;
    })
    .join('');
  const letters = [];
  if (k.present.length) letters.push(`<span>Kelimede var: <b>${esc(k.present.join(' '))}</b></span>`);
  if (k.absent.length && !blind) letters.push(`<span>Yok: <b>${esc(k.absent.join(' '))}</b></span>`);
  if (blind && w.board.length) letters.push('<span>Kör renk: turuncu çizgiler gri görünüyor</span>');
  el.innerHTML = `
    <div class="target-card ${w.golden ? 'golden' : ''}">
      ${w.golden ? `<div class="golden-banner">${icon('star', { size: 14, fill: true })} Altın kelime · bir satır eksik · çözerseniz +1 can</div>` : ''}
      <div class="tc-head">
        <span class="tc-title">${icon('eyeOff', { size: 14 })} Gizli kelime</span>
        <span class="tag primary">Seviye ${w.tier?.level ?? ''}${w.tier?.name ? ` · ${esc(w.tier.name)}` : ''}</span>
      </div>
      <div class="slots" style="--len:${w.length}">${slots}</div>
      <div class="tc-facts"><span><b>${w.length}</b> harf</span><i class="sep"></i><span><b>${w.trapCount}</b> tuzak</span><i class="sep"></i><span><b>${w.forbiddenCount}</b> yasak harf</span></div>
      ${
        w.trapPos != null
          ? `<div class="trap-note">${icon('alert', { size: 14 })} ${w.trapCount > 1 ? `${w.trapCount} tuzak` : 'Tuzak'} gizli kelimeden yalnızca <b>${w.trapPos + 1}. harfte</b> ayrılıyor</div>`
          : ''
      }
      ${letters.length ? `<div class="letters-line">${letters.join('')}</div>` : ''}
      <div class="legend"><span><i class="c-G"></i>tam yerinde</span><span><i class="c-Y"></i>kelimede var</span><span><i class="c-X"></i>yok</span></div>
    </div>`;
}

/** Tepki düğmeleri; kaptan kelime sürerken göremez (ipucu verilmesin). */
function reactionBar() {
  const st = S.state;
  const list = st.reactions ?? [];
  if (!list.length || (isCaptain() && WORD_PHASES.has(st.phase))) return '';
  return `<div class="reactions">${list.map((e) => `<button class="react-btn" data-action="react" data-emoji="${esc(e)}" aria-label="Tepki ${esc(e)}">${esc(e)}</button>`).join('')}</div>`;
}

/** Masa: kaptan ortada, tahminciler iki yanında; herkesin altında o an desteklediği öneri. */
function renderTable() {
  const st = S.state;
  const w = st.word;
  const el = document.getElementById('g-table');
  if (S.editOrder && isHost()) {
    el.innerHTML = `<section class="card">
      <div class="spread" style="margin-bottom:4px"><div class="label">Kaptan sırası ve oyuncular</div>
      <button class="btn sm ghost" data-action="edit-order">Tamam</button></div>
      <ol class="plist">${st.players.map((p, i) => playerRow(p, i, st.players.length, true)).join('')}</ol>
    </section>`;
    return;
  }
  if (!w) {
    el.innerHTML = '';
    return;
  }
  const next = nextCaptainId();
  const voteOf = (id) => {
    if (st.phase === 'MOLE_VOTE') return (w.votedIds || []).includes(id) ? { text: 'oy verdi', on: true } : null;
    const prop = w.proposals.find((x) => x.kind !== 'bank' && x.approvals.includes(id));
    if (!prop) return null;
    return { text: prop.kind === 'pass' ? 'PAS' : prop.word, on: true };
  };
  const seat = (p) => {
    const vote = voteOf(p.id);
    const badges = [];
    if (p.id === st.hostId) badges.push(`<span class="b host" title="Oda sahibi">${icon('crown', { size: 11 })}</span>`);
    if (p.id === next) badges.push(`<span class="b next" title="Sıradaki kaptan">${icon('skip', { size: 10 })}</span>`);
    if (!p.connected) badges.push(`<span class="b" title="Bağlantı yok">${icon('wifiOff', { size: 10 })}</span>`);
    return `<div class="seat ${p.connected ? '' : 'off'}" data-pid="${p.id}">
      <div class="ava-wrap">${avatar(p)}<span class="badges">${badges.join('')}</span></div>
      <div class="sname ${p.id === S.me.playerId ? 'me' : ''}">${p.id === S.me.playerId ? 'Sen' : esc(p.name)}</div>
      <div class="vote ${vote?.on ? 'on' : ''}">${vote ? esc(vote.text) : ''}</div>
    </div>`;
  };
  const captain = playerById(w.captainId);
  const others = st.players.filter((p) => p.id !== w.captainId);
  const half = Math.ceil(others.length / 2);
  const capHost = captain.id === st.hostId ? `<span class="badges"><span class="b host" title="Oda sahibi">${icon('crown', { size: 11 })}</span></span>` : '';
  el.innerHTML = `<div class="table-card"><div class="seats">
    ${others.slice(0, half).map(seat).join('')}
    <div class="seat captain ${captain.connected === false ? 'off' : ''}" data-pid="${captain.id}">
      <div class="ava-wrap">${avatar(captain)}${capHost}</div>
      <div class="sname ${captain.id === S.me.playerId ? 'me' : ''}">${captain.id === S.me.playerId ? 'Sen' : esc(captain.name)}</div>
      <div class="role">${icon('micOff', { size: 12 })} Kaptan</div>
    </div>
    ${others.slice(half).map(seat).join('')}
  </div>${reactionBar()}</div>`;
}

function renderSecret() {
  const el = document.getElementById('g-secret');
  const st = S.state;
  const active = WORD_PHASES.has(st.phase) || st.phase === 'MOLE_VOTE';
  const info = active && isCaptain() ? S.captainInfo : active ? S.moleInfo : null;
  if (!info) {
    el.innerHTML = '';
    return;
  }
  const mole = !isCaptain();
  const hide = S.hideSecret;
  el.innerHTML = `
    <section class="secret ${mole ? 'mole' : ''}">
      <div class="secret-head">
        ${icon(mole ? 'ghost' : 'micOff', { size: 20 })}
        <div class="title">${mole ? 'Köstebek dosyası' : 'Kaptan dosyası'}<small>${
          mole ? 'Takımı tuzağa çek, ama yakalanma.' : 'Konuşma; sadece sinyal kartı gönder.'
        }</small></div>
        <button class="icon-btn" data-action="toggle-secret" title="${hide ? 'Göster' : 'Gizle (ekran paylaşırken)'}" aria-label="Gizli bilgiyi gizle/göster">${icon(hide ? 'eye' : 'eyeOff')}</button>
      </div>
      ${
        hide
          ? '<div class="hidden-note">Gizli bilgi saklandı.</div>'
          : `<div class="kv">
              <span class="label">Gizli kelime</span>${wordChip(info.secret, 'secret')}
              <span class="label">${info.traps.length > 1 ? 'Tuzaklar' : 'Tuzak'}</span><span class="traps">${info.traps.map((t) => wordChip(t, 'trap')).join('')}</span>
              <span class="label">Yasak harf</span>${forbiddenChips(info.forbidden)}
            </div>
            ${mole ? '' : '<div class="muted small">Yasak harfler sinyalde hiçbir yerde kullanılamaz.</div>'}
            ${!mole && info.categoryWords ? categoryWordsHtml(info) : ''}`
      }
    </section>`;
}

/** Kategori kilidinde kaptana, kabul edilen ve henüz kullanılmamış sinyaller gösterilir. */
function categoryWordsHtml(info) {
  const used = new Set((S.state.word?.board ?? []).map((r) => r.word).filter(Boolean));
  const words = info.categoryWords.filter((w) => !used.has(w));
  return `<div class="cat-box">
    <div class="label">${icon('tag', { size: 14 })} “${esc(info.category)}” kategorisinde geçerli sinyaller</div>
    <div class="cat-words">${
      words.length
        ? words.map((w) => `<button class="chip-btn" data-action="fill" data-word="${esc(w)}">${esc(w)}</button>`).join('')
        : '<span class="muted small">Kullanılabilir kelime kalmadı.</span>'
    }</div>
  </div>`;
}

/** Sunucuyla aynı kural: mevcut kaptandan sonraki ilk bağlı oyuncu. */
function nextCaptainId() {
  const st = S.state;
  const order = st?.players ?? [];
  const n = order.length;
  const i = order.findIndex((p) => p.id === st?.word?.captainId);
  for (let k = 1; k <= n; k++) {
    const p = order[(((i + k) % n) + n) % n];
    if (p.connected) return p.id;
  }
  return null;
}

/**
 * Masa: oynanan her satır bir kelime kartıdır. Kaptanın sinyalleri koyu "kaptan kartı",
 * tahminler kâğıt kart; tuzak kartı siyah ve damgalı. Kalan satırlar ters çevrilmiş deste.
 */
function renderBoard() {
  const st = S.state;
  const w = st.word;
  const el = document.getElementById('g-board');
  if (!w) {
    el.innerHTML = '';
    return;
  }
  const capName = playerName(w.captainId);
  let signalNo = 0;
  const cards = w.board.map((row, i) => {
    const deal = i >= S.renderedRows ? 'deal' : '';
    if (row.type === 'signal') {
      signalNo += 1;
      return `<article class="wcard signal ${deal}">
        <header><span>${signalNo}. sinyal</span><span>${icon('micOff', { size: 12 })} ${esc(capName)}</span></header>
        <div class="wc-word" style="--len:${w.length}">${lettersHtml(row.word, row.colors)}</div>
      </article>`;
    }
    if (row.type === 'empty') {
      return `<article class="wcard empty ${deal}">
        <header><span>sinyal yok</span></header>
        <div class="wc-empty">${icon('clock', { size: 18 })} süre doldu</div>
      </article>`;
    }
    const stamp = row.result === 'trap' ? '<span class="stamp">TUZAK</span>' : row.result === 'correct' ? '<span class="stamp ok">BULUNDU</span>' : '';
    return `<article class="wcard guess ${row.result ? `res-${row.result}` : ''} ${deal}">
      <header><span>tahmin</span><span>${esc(playerName(row.byPlayerId))}</span></header>
      <div class="wc-word" style="--len:${w.length}">${lettersHtml(row.word, row.colors)}</div>
      ${stamp}
    </article>`;
  });

  if (st.phase === 'SIGNAL' || st.phase === 'WORD_SETUP') {
    const text = st.phase === 'WORD_SETUP' ? 'İlk sinyal birazdan' : isCaptain() ? 'Sinyalini bekliyoruz' : `${esc(capName)} sinyal seçiyor`;
    cards.push(`<div class="wcard waiting"><span>${text}</span><span class="typing-dots"><i></i><i></i><i></i></span></div>`);
  }
  const left = w.rowsRemaining;
  if (left > 0 && st.phase !== 'REVEAL' && st.phase !== 'MOLE_VOTE') {
    cards.push(`<div class="wcard deck ${left === 1 ? 'last' : ''}" title="Kalan satır hakkı">
      <b>${left}</b><span>${left === 1 ? 'son kart · sadece tahmin' : 'kart kaldı'}</span>
    </div>`);
  }
  el.innerHTML = `<div class="cards">${cards.join('')}</div>`;
  S.renderedRows = w.board.length;
}

function proposalHtml(p, st, canAct) {
  const w = st.word;
  const mine = p.approvals.includes(S.me.playerId);
  const need = p.kind === 'bank' ? w.thresholds.bank : w.thresholds.guess;
  const pct = Math.min(100, (p.approvals.length / Math.max(1, need)) * 100);
  const what =
    p.kind === 'guess'
      ? wordChip(p.word)
      : p.kind === 'pass'
        ? `${icon('skip', { size: 16 })} Pas <span class="muted small">(satır harcamaz)</span>`
        : `${icon('coins', { size: 16 })} Kumbaradan +1 satır <span class="muted small">(oybirliği)</span>`;
  return `<div class="proposal ${mine ? 'mine' : ''}">
    <div class="what">${what}</div>
    ${
      canAct
        ? `<button class="btn sm ${mine ? 'ghost' : 'primary'}" data-action="approve" data-id="${p.id}">${mine ? 'Geri çek' : `${icon('thumbsUp', { size: 14 })} Onayla`}</button>`
        : '<span></span>'
    }
    <div class="who">
      <span class="avatars">${p.approvals.map((id) => avatar(playerById(id), { small: true })).join('')}</span>
      <span>${esc(playerName(p.byPlayerId))} önerdi</span>
      <span class="votebar"><i style="width:${pct}%"></i></span>
      <b>${p.approvals.length}/${need}</b>
    </div>
  </div>`;
}

function renderPanel() {
  const st = S.state;
  const w = st.word;
  const el = document.getElementById('g-panel');
  const cap = isCaptain();
  let html = '';
  if (st.phase === 'DISCUSSION') {
    const lastRow = w.rowsRemaining <= 1;
    const left = w.maxGuesses - w.guessesThisDiscussion;
    html = `
      <div class="panel-head"><h3 class="h2">${w.guesserCount === 1 ? 'Hamleler' : 'Öneriler'}</h3><span class="muted small">Bu turda ${left} tahmin hakkı</span></div>
      ${
        w.proposals.length
          ? `<div class="proposals">${w.proposals.map((p) => proposalHtml(p, st, !cap && !st.paused)).join('')}</div>`
          : `<div class="empty-state">${
              w.guesserCount === 1
                ? cap
                  ? 'Tahminci kartını seçiyor.'
                  : 'Tahminin onay beklemeden gönderilir. İstersen pas geçip yeni sinyal isteyebilirsin.'
                : cap
                  ? 'Henüz öneri yok.'
                  : 'Henüz öneri yok. Bir kelime yazıp önerebilirsin.'
            }</div>`
      }
      ${
        cap
          ? ''
          : `<div class="panel-actions">
              <button class="btn sm" data-action="pass" ${lastRow || st.paused ? 'disabled' : ''} title="${lastRow ? 'Son satırda pas yok' : 'Yeni sinyal iste (satır harcamaz)'}">${icon('skip', { size: 16 })} ${w.guesserCount === 1 ? 'Pas geç' : 'Pas öner'}</button>
              <button class="btn sm" data-action="bank" ${st.run.bank <= 0 || st.paused ? 'disabled' : ''} title="Herkes onaylarsa bu kelimeye +1 satır">${icon('coins', { size: 16 })} +1 satır (${st.run.bank})</button>
            </div>`
      }`;
  } else if (st.phase === 'MOLE_VOTE') {
    const voted = new Set(w.votedIds || []);
    const targets = st.players.filter((p) => p.id !== S.me.playerId && p.id !== w.captainId);
    const total = st.players.filter((p) => p.connected).length;
    html = `
      <div class="panel-head"><h3 class="h2">Köstebek kim?</h3><span class="muted small">${voted.size}/${total} oy</span></div>
      <div class="vote-grid">${targets
        .map(
          (p) =>
            `<button class="vote-btn ${S.myVote === p.id ? 'chosen' : ''}" data-action="vote" data-id="${p.id}" ${st.paused ? 'disabled' : ''}>${avatar(p, { small: true })}<span>${esc(p.name)}</span></button>`,
        )
        .join('')}</div>
      <div class="muted small">En çok oyu alan köstebekse takım +1 can kazanır; eşitlikte köstebek kaçar.</div>`;
  } else if (st.phase === 'REVEAL') {
    html = revealHtml(st);
  }
  el.innerHTML = html;
}

function revealHtml(st) {
  const r = st.reveal;
  if (!r) return '';
  const good = r.result === 'solved';
  const title = { solved: 'Çözüldü!', trap: 'Tuzağa düştünüz', rows: 'Satırlar bitti' }[r.result] ?? 'Kelime bitti';
  const gains = [];
  if (r.star) gains.push(`<span class="tag primary">${icon('star', { size: 12, fill: true })} +1 yıldız</span>`);
  if (r.bankGained) gains.push(`<span class="tag">${icon('coins', { size: 12 })} +${r.bankGained} kumbara</span>`);
  if (r.lightning) gains.push(`<span class="tag primary">${icon('zap', { size: 12, fill: true })} yıldırım</span>`);
  if (r.streak >= 2) gains.push(`<span class="tag streak">${icon('flame', { size: 12, fill: true })} ${r.streak}'li seri</span>`);
  if (r.goldenLife) gains.push(`<span class="tag gold">${icon('star', { size: 12, fill: true })} altın: +1 can</span>`);
  if (r.lifeGained) gains.push(`<span class="tag ok">${icon('heart', { size: 12, fill: true })} +1 can</span>`);
  if (r.lifeLost) gains.push(`<span class="tag danger">${icon('heart', { size: 12, fill: true })} −1 can</span>`);
  let mole = '';
  if (r.moleId) {
    const votes = r.votes ? Object.entries(r.votes).map(([v, t]) => `${playerName(v)} → ${playerName(t)}`).join(', ') : '';
    const status = r.moleVoteSkipped ? 'bağlantısı koptuğu için oylama yapılmadı' : r.moleCaught ? 'yakalandı, takım +1 can kazandı' : 'yakalanmadı';
    mole = `<div class="notice ${r.moleCaught ? 'info' : 'danger'}">${icon('ghost', { size: 16 })}<div>Köstebek <b>${esc(playerName(r.moleId))}</b>: ${status}.${
      votes ? `<div class="small" style="opacity:.8">Oylar: ${esc(votes)}</div>` : ''
    }</div></div>`;
  }
  return `
    <div class="result ${good ? 'good' : 'bad'}">
      <div class="badge">${icon(good ? 'check2' : r.result === 'trap' ? 'alert' : 'clock', { size: 22 })}</div>
      <div><div class="result-banner">${title}</div>${gains.length ? `<div class="gains">${gains.join('')}</div>` : ''}</div>
    </div>
    <div class="kv">
      <span class="label">Gizli kelime</span>${wordChip(r.secret, 'secret')}
      <span class="label">${r.traps.length > 1 ? 'Tuzaklar' : 'Tuzak'}</span><span class="traps">${r.traps.map((t) => wordChip(t, 'trap')).join('')}</span>
      <span class="label">Yasak harf</span>${forbiddenChips(r.forbidden)}
    </div>
    ${mole}
    ${nextCaptainLine()}
    ${isHost() ? `<button class="btn primary block" data-action="skip-reveal">Devam ${icon('skip', { size: 16 })}</button>` : ''}`;
}

function nextCaptainLine() {
  const st = S.state;
  if (st.run.lives <= 0) return '<div class="notice danger">Canlar bitti — sonuçlar geliyor.</div>';
  const next = nextCaptainId();
  if (!next) return '';
  return next === S.me.playerId
    ? '<div class="notice info next-cap">Sıradaki kaptan <b>sensin</b> — hazırlan!</div>'
    : `<div class="small next-cap" style="color:var(--text-2)">Sıradaki kaptan: <b>${esc(playerName(next))}</b></div>`;
}

function canType() {
  const st = S.state;
  if (!st?.word || !WORD_PHASES.has(st.phase)) return false;
  if (isCaptain()) return true;
  return st.phase === 'SIGNAL' || st.phase === 'DISCUSSION';
}

function canSubmitNow() {
  const st = S.state;
  if (!st?.word || st.paused || [...S.typed].length !== st.word.length) return false;
  return isCaptain() ? st.phase === 'SIGNAL' : st.phase === 'DISCUSSION';
}

/** Klavye kapalıyken tek bir düğme; açıkken "gizle" bağlantısı. */
function renderCompose() {
  const el = document.getElementById('g-compose');
  const st = S.state;
  if (!canType()) {
    el.innerHTML = '';
    return;
  }
  const cap = isCaptain();
  if (S.composer) {
    el.innerHTML = `<div class="composer-head"><button class="text-btn" data-action="compose">${icon('down', { size: 16 })} Klavyeyi gizle</button></div>`;
    return;
  }
  const draft = S.typed ? ` <span class="muted">(${esc(S.typed)})</span>` : '';
  let btn;
  if (cap && st.phase === 'SIGNAL') btn = `<button class="btn primary" data-action="compose">${icon('send', { size: 16 })} Sinyal yaz${draft}</button>`;
  else if (cap) btn = `<button class="btn ghost" data-action="compose">${icon('send', { size: 16 })} Sıradaki sinyali hazırla${draft}</button>`;
  else if (st.phase === 'DISCUSSION') {
    const label = st.word.guesserCount === 1 ? 'Tahmin et' : 'Tahmin öner';
    btn = `<button class="btn primary" data-action="compose">${icon('target', { size: 16 })} ${label}${draft}</button>`;
  }
  else btn = `<button class="btn ghost" data-action="compose">${icon('target', { size: 16 })} Taslak yaz${draft}</button>`;
  el.innerHTML = `<div class="composer-bar">${btn}</div>`;
}

function renderTyped() {
  const el = document.getElementById('g-typed');
  if (!el) return;
  const st = S.state;
  if (!canType() || !S.composer) {
    el.innerHTML = '';
    return;
  }
  const len = st.word.length;
  const cap = isCaptain();
  const pv = cap && S.preview && S.preview.word === S.typed ? S.preview : null;
  const letters = [...S.typed];
  const card = `<div class="wcard compose ${cap ? 'signal' : 'guess'}">
    <header><span>${cap ? 'sinyalin' : 'tahminin'}</span><span>${letters.length}/${len}</span></header>
    <div class="wc-word" style="--len:${len}">${lettersHtml(S.typed, pv?.colors ?? null, len)}</div>
  </div>`;
  let msg = '';
  let cls = '';
  if (cap) {
    if (pv?.error && !(pv.error === 'WRONG_LENGTH' && letters.length < len)) {
      msg = ERRORS[pv.error]?.(S) ?? pv.error;
      cls = 'err';
    } else if (pv && !pv.error) {
      msg = st.phase === 'SIGNAL' ? 'Geçerli sinyal — GÖNDER ile gönder' : 'Geçerli sinyal — sinyal aşamasında gönderebilirsin';
      cls = 'ok';
    } else msg = 'Önizleme: renkler gönderilince herkese böyle görünür';
  } else {
    const solo = st.word.guesserCount === 1;
    msg = st.phase === 'DISCUSSION' ? (solo ? 'Kelimeyi yaz, TAHMİN ile gönder' : 'Kelimeyi yaz, ÖNER ile tahmin önerisi yap') : 'Taslak yazabilirsin; tahminler tartışmada açılır';
  }
  el.innerHTML = `${card}<div class="msg ${cls}">${esc(msg)}</div>`;
  // GÖNDER/ÖNER tuşu, gönderilebilir durumdayken vurgulanır.
  const enter = document.querySelector('.key[data-key="ENTER"]');
  if (enter) enter.classList.toggle('go', canSubmitNow());
}

function keyColors() {
  const best = {};
  const rank = { G: 3, Y: 2, X: 1 };
  for (const row of S.state.word?.board ?? []) {
    if (!row.colors) continue;
    [...row.word].forEach((c, i) => {
      const col = row.colors[i];
      if (!best[c] || rank[col] > rank[best[c]]) best[c] = col;
    });
  }
  return best;
}

function renderKeyboard() {
  const el = document.getElementById('g-keyboard');
  if (!canType() || !S.composer) {
    el.innerHTML = '';
    return;
  }
  const colors = keyColors();
  const forbidden = new Set(isCaptain() ? (S.captainInfo?.forbidden ?? []) : []);
  const cap = isCaptain();
  el.innerHTML = KEY_ROWS.map(
    (row) =>
      `<div class="krow">${row
        .map((k) => {
          if (k === 'ENTER') {
            const label = cap ? 'GÖNDER' : S.state.word.guesserCount === 1 ? 'TAHMİN' : 'ÖNER';
            return `<button class="key wide ${canSubmitNow() ? 'go' : ''}" data-action="key" data-key="ENTER">${label}</button>`;
          }
          if (k === 'BACK') return `<button class="key wide" data-action="key" data-key="BACK" aria-label="Sil">${icon('backspace', { size: 20 })}</button>`;
          const cls = forbidden.has(k) ? 'forbidden' : colors[k] ? `c-${colors[k]}` : '';
          return `<button class="key ${cls}" data-action="key" data-key="${k}">${k}</button>`;
        })
        .join('')}</div>`,
  ).join('');
}

function renderTools() {
  const el = document.getElementById('g-tools');
  const st = S.state;
  const hostPaused = st.pauseReasons.includes('host');
  el.innerHTML = `
    ${isHost() ? `<button class="btn sm" data-action="pause">${icon(hostPaused ? 'play' : 'pause', { size: 16 })} ${hostPaused ? 'Devam ettir' : 'Duraklat'}</button>` : ''}
    ${isHost() && !S.editOrder ? `<button class="btn sm ghost" data-action="edit-order">${icon('users', { size: 16 })} Sıra ve oyuncular</button>` : ''}
    <span class="grow"></span>
    <button class="text-btn" data-action="leave">${icon('logout', { size: 16 })} Ayrıl</button>`;
}

// ── oyun sonu ──

const CHAOS_NAME = { category: 'Kategori kilidi', blind: 'Kör renk', fast: 'Hızlı tur', mole: 'Köstebek' };

function updateEnd() {
  const st = S.state;
  const s = st.summary;
  const el = document.getElementById('e-main');
  if (!s) {
    el.innerHTML = '';
    return;
  }
  const rec = s.record;
  const stats = s.players
    .map((p) => {
      const t = p.stats;
      const avg = t.captainSolved ? (t.captainRowsSolved / t.captainSolved).toFixed(1) : '—';
      return `<tr><td><span class="row">${avatar({ name: p.name }, { small: true })}${esc(p.name)}</span></td><td>${t.captainWords}</td><td>${t.captainSolved}</td><td>${avg}</td><td>${t.captainStars}</td>
        <td>${t.proposed}</td><td>${t.submitted}</td><td>${t.submittedCorrect}</td><td>${t.submittedTrap}</td>
        <td>${t.moleTurns}</td><td>${t.moleSuccess}</td><td>${t.moleCaught}</td><td>${t.moleCorrectVotes}</td></tr>`;
    })
    .join('');
  const recordLine = rec?.isNewRecord
    ? `Yeni takım rekoru!${rec.previous.bestScore || rec.previous.bestStars ? ` Önceki: ${rec.previous.bestScore} kelime · ${rec.previous.bestStars} yıldız` : ''}`
    : rec
      ? `Takım rekoru: ${rec.bestScore} kelime · ${rec.bestStars} yıldız`
      : '';
  el.innerHTML = `
    <header class="topbar">
      <div class="brand">${logo(true)}<div style="min-width:0"><div class="name">${esc(s.teamName)}</div><div class="code">OYUN BİTTİ</div></div></div>
      <button class="text-btn" data-action="leave">${icon('logout', { size: 16 })} Odadan çık</button>
    </header>
    <section class="card score-card">
      <div class="trophy">${icon('trophy', { size: 28 })}</div>
      <div class="label">Çözülen kelime</div>
      <div class="score-big">${s.score}</div>
      <span class="row" style="justify-content:center;flex-wrap:wrap">
        <span class="pill gold">${icon('star', { size: 16, fill: true })} ${s.stars} yıldız</span>
        ${s.bestStreak >= 2 ? `<span class="pill streak">${icon('flame', { size: 16, fill: true })} en uzun seri ${s.bestStreak}</span>` : ''}
      </span>
      <div class="record ${rec?.isNewRecord ? 'new' : ''}">${esc(recordLine)}</div>
    </section>
    ${
      s.awards.length
        ? `<section class="stack"><div class="label">Ödüller</div><div class="awards">${s.awards
            .map(
              (a) => `<div class="card award"><span class="medal">${icon('award', { size: 18 })}</span><div>
                <div class="t">${esc(a.title)}</div><div class="d">${esc(a.description)}</div>
                <div class="w">${a.winners.map((w) => esc(w.name)).join(', ')}</div></div></div>`,
            )
            .join('')}</div></section>`
        : ''
    }
    <section class="card flush">
      <div class="card-head label">Kelimeler</div>
      <ul class="wordlist">${s.words
        .map((w) => {
          const res = RESULT[w.result] ?? { label: w.result, cls: '' };
          const meta = [
            `Tuzak: ${w.traps.join(', ')}`,
            `Kaptan ${w.captainName}`,
            `${w.rowsUsed}/${w.rowLimit} satır`,
            w.chaosCard ? CHAOS_NAME[w.chaosCard] : '',
          ].filter(Boolean);
          return `<li><span class="idx">${w.wordIndex}</span><span class="w">${wordChip(w.secret, w.result === 'solved' ? 'secret' : w.result === 'cancelled' ? '' : 'trap')}</span>
            <span class="tag ${res.cls}">${res.label}${w.star ? ` ${icon('star', { size: 12, fill: true })}` : ''}</span>
            <span class="sub">${esc(meta.join(' · '))}</span></li>`;
        })
        .join('')}</ul>
    </section>
    <details class="card" id="stats-details" ${S.statsOpen ? 'open' : ''}>
      <summary>Oyuncu istatistikleri</summary>
      <div class="table-wrap"><table>
        <tr><th>Oyuncu</th><th>Kaptan</th><th>Çözdü</th><th>Ort. satır</th><th>Yıldız</th><th>Öneri</th><th>Gönderilen</th><th>Doğru</th><th>Tuzak</th><th>Köstebek</th><th>Başarılı</th><th>Yakalandı</th><th>Doğru oy</th></tr>
        ${stats}
      </table></div>
    </details>
    <section class="cta">
      ${
        isHost()
          ? `<div class="buttons"><button class="btn ghost" data-action="to-lobby">${icon('home', { size: 16 })} Lobiye dön</button><button class="btn primary" data-action="start">${icon('restart', { size: 16 })} Yeniden oyna</button></div>`
          : '<div class="hint">Yeni oyunu oda sahibi başlatabilir.</div>'
      }
    </section>`;
}

const UPDATE = { lobby: updateLobby, game: updateGame, end: updateEnd };

// ───────────────────────── eylemler ─────────────────────────

function readName() {
  const name = document.getElementById('name')?.value.trim() ?? '';
  if (!name) {
    toast('Önce adını yaz', 'err');
    document.getElementById('name')?.focus();
    return null;
  }
  local.set('sinyal.name', name);
  return name;
}

function doCreate() {
  const name = readName();
  if (!name) return;
  withSocket(() => send({ type: 'create', name }));
}

function doJoin() {
  const name = readName();
  if (!name) return;
  const code = (urlCode || document.getElementById('code')?.value || '').trim().toUpperCase();
  if (code.length !== 4) {
    toast('4 harfli oda kodunu yaz', 'err');
    return;
  }
  withSocket(() => send({ type: 'join', code, name }));
}

function leave() {
  if (S.ws?.readyState === WebSocket.OPEN && S.me) send({ type: 'leave' });
  session.clear();
  S.me = null;
  S.state = null;
  S.captainInfo = null;
  S.moleInfo = null;
  S.seenSeq = null;
  const ws = S.ws;
  S.ws = null;
  ws?.close();
  S.connected = false;
  history.replaceState(null, '', '/');
  location.reload();
}

let previewTimer = null;
function setTyped(value) {
  const st = S.state;
  const len = st.word.length;
  S.typed = [...value].slice(0, len).join('');
  S.preview = null;
  renderTyped();
  if (isCaptain()) {
    clearTimeout(previewTimer);
    const word = S.typed;
    previewTimer = setTimeout(() => {
      if (word) send({ type: 'preview_signal', word });
    }, 90);
  }
}

function pressKey(k) {
  if (!canType()) return;
  if (k === 'BACK') {
    setTyped([...S.typed].slice(0, -1).join(''));
    return;
  }
  if (k === 'ENTER') {
    submitTyped();
    return;
  }
  if (!ALPHABET.has(k)) return;
  if (isCaptain() && S.captainInfo?.forbidden.includes(k)) {
    toast(`${k} yasak harf`, 'err');
    return;
  }
  if ([...S.typed].length >= S.state.word.length) return;
  setTyped(S.typed + k);
}

function submitTyped() {
  const st = S.state;
  const len = st.word.length;
  if ([...S.typed].length !== len) {
    toast(`${len} harfli bir kelime yaz`, 'err');
    return;
  }
  if (isCaptain()) {
    if (st.phase !== 'SIGNAL') {
      toast('Sinyal sadece sinyal aşamasında gönderilir', 'err');
      return;
    }
    S.pending = S.typed;
    send({ type: 'send_signal', word: S.typed });
  } else {
    if (st.phase !== 'DISCUSSION') {
      toast('Tahminler tartışma aşamasında önerilir', 'err');
      return;
    }
    S.pending = S.typed;
    send({ type: 'propose_guess', word: S.typed });
  }
}

function moveOrder(id, dir) {
  const order = S.state.players.map((p) => p.id);
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  send({ type: 'reorder', order });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const { action, id } = btn.dataset;
  switch (action) {
    case 'create':
      doCreate();
      break;
    case 'join':
      doJoin();
      break;
    case 'leave':
      leave();
      break;
    case 'take-over':
      S.replaced = false;
      S.state = null;
      S.seenSeq = null;
      connect(rejoin);
      render();
      break;
    case 'copy-link': {
      const link = `${location.origin}/?oda=${S.state.code}`;
      navigator.clipboard?.writeText(link).then(
        () => toast('Davet linki kopyalandı', 'good'),
        () => toast(link),
      );
      break;
    }
    case 'ready':
      send({ type: 'ready' });
      break;
    case 'start':
      send({ type: 'start' });
      break;
    case 'to-lobby':
      send({ type: 'to_lobby' });
      break;
    case 'shuffle':
      send({ type: 'shuffle' });
      break;
    case 'move':
      moveOrder(id, Number(btn.dataset.dir));
      break;
    case 'edit-order':
      S.editOrder = !S.editOrder;
      render();
      break;
    case 'pause':
      send({ type: 'pause' });
      break;
    case 'skip-reveal':
      send({ type: 'skip_reveal' });
      break;
    case 'mute':
      S.muted = !S.muted;
      local.set('sinyal.muted', S.muted);
      render();
      break;
    case 'toggle-secret':
      S.hideSecret = !S.hideSecret;
      render();
      break;
    case 'key':
      pressKey(btn.dataset.key);
      break;
    case 'compose':
      S.composer = !S.composer;
      render();
      break;
    case 'react':
      send({ type: 'react', emoji: btn.dataset.emoji });
      break;
    case 'approve':
      send({ type: 'approve', proposalId: id });
      break;
    case 'fill':
      if (isCaptain() && canType()) {
        S.composer = true;
        setTyped(btn.dataset.word);
        render();
      }
      break;
    case 'kick':
      if (confirm(`${playerName(id)} odadan çıkarılsın mı?`)) send({ type: 'kick', playerId: id });
      break;
    case 'pass':
      send({ type: 'propose_pass' });
      break;
    case 'bank':
      send({ type: 'request_bank_row' });
      break;
    case 'vote':
      S.myVote = id;
      send({ type: 'vote_mole', playerId: id });
      render();
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (S.screen !== 'game' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'Escape' && S.composer) {
    S.composer = false;
    render();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    pressKey('BACK');
  } else if (e.key === 'Enter') {
    if (e.target instanceof HTMLButtonElement && e.target.dataset.action !== 'key') return; // odaklı düğmeye bırak
    e.preventDefault();
    pressKey('ENTER');
  } else if (e.key.length === 1) {
    const k = norm(e.key);
    if (ALPHABET.has(k)) {
      e.preventDefault();
      if (canType() && !S.composer) {
        S.composer = true; // fiziksel klavyeyle yazmaya başlayınca alan açılır
        render();
      }
      pressKey(k);
    }
  }
});

document.addEventListener(
  'toggle',
  (e) => {
    if (e.target.id === 'stats-details') S.statsOpen = e.target.open;
  },
  true,
);

// Sayaçları sunucudaki endsAt'e göre çiz.
setInterval(() => {
  if (S.screen === 'game') {
    renderTurn();
    updateTitle();
  }
}, 250);

// Kalp atışı ve sekmeye dönünce hemen yeniden bağlanma (mobil tarayıcılar arka planda soketi keser).
setInterval(heartbeat, 15_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectNow();
});
window.addEventListener('online', reconnectNow);

// Odadayken sunucuya ara sıra HTTP isteği: ücretsiz barındırmada (Render) oyun ortasında uykuya geçmesin.
setInterval(() => {
  if (S.me && S.connected) fetch('/health', { cache: 'no-store' }).catch(() => {});
}, 4 * 60_000);

// iOS/Safari: ses ancak bir dokunuştan sonra açılabilir.
document.addEventListener(
  'pointerdown',
  () => {
    try {
      actx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch {
      /* ses yok */
    }
  },
  { passive: true },
);

// ───────────────────────── başlat ─────────────────────────

const flash = local.get('sinyal.flash', null);
if (flash) {
  local.set('sinyal.flash', null);
  setTimeout(() => toast(flash, 'err'), 100);
}
render();
if (S.me) connect(rejoin);
