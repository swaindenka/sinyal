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
  NOT_ENOUGH_PLAYERS: 'Başlamak için en az 2 oyuncu gerekli.',
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
  const name = (id) => next.players.find((p) => p.id === id)?.name ?? 'Biri';
  switch (ev.type) {
    case 'round':
      if (ev.captainId === S.me) {
        SOUND.turn();
        splash('KAPTAN SENSİN', 'Konuşmak yok, sadece kart', 'signal');
      }
      break;
    case 'signal':
      SOUND.signal();
      if (ev.captainId !== S.me) splash(ev.word, `${ev.n}. sinyal${ev.auto ? ' · süre doldu' : ''}`, 'signal');
      break;
    case 'flip':
      if (ev.role === 'neutral') {
        SOUND.blank();
        splash('BOŞ KART', ev.n >= next.round?.maxSignals ? '' : 'Kaptan yeni sinyal oynayacak', 'info');
      }
      break;
    case 'pass':
      SOUND.blank();
      if (ev.n < (next.round?.maxSignals ?? 3)) toast(ev.reason === 'timeout' ? 'Süre doldu, karar çıkmadı: yeni sinyal' : 'Pas: yeni sinyal isteniyor');
      break;
    case 'round_end':
      if (ev.kind === 'hit') {
        SOUND.hit();
        confetti();
        splash('İSABET!', `+${ev.points} puan${ev.lifeGain ? ' · +1 can' : ''}`, 'good');
      } else if (ev.kind === 'parasite') {
        SOUND.bad();
        shake();
        splash('PARAZİT!', '−1 can', 'bad');
      } else if (ev.kind === 'silence') {
        SOUND.bad();
        shake();
        splash('SİNYAL KESİLDİ', '3 sinyalde bulunamadı · −1 can', 'bad');
      } else toast('Kaptan ayrıldı, tur cezasız yenilendi.');
      break;
    case 'run_end':
      if (ev.newRecord) {
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

function rulesHtml() {
  return `<ol class="rules">
    <li><span>Masada 8 kelime kartı var. <b>Kaptan</b> hangisinin <b>hedef</b>, hangilerinin <b>parazit</b> olduğunu bilir ama konuşamaz.</span></li>
    <li><span>Kaptan elindeki 6 kelime kartından birini <b>sinyal</b> olarak oynar. Turda bir kez elini değiştirebilir.</span></li>
    <li><span>Takım konuşur ve <b>jetonlarını</b> kartlara koyar. Herkes aynı kartta birleşince 3 saniyede kart açılır. <b>Pas</b> yeni sinyal ister.</span></li>
    <li><span>Hedef 1. sinyalde <b>3</b>, 2.de <b>2</b>, 3.de <b>1</b> puan. Boş kartta kaptan yeni sinyal oynar. <b>Parazit</b> ya da 3 sinyalde bulamamak <b>1 can</b> götürür.</span></li>
    <li><span>3 canla başlanır, her 5 isabette 1 can geri gelir. Turlar ilerledikçe parazitler artar ve hedefe benzer.</span></li>
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
          <li><span class="mini tile-target">BULUT</span><div><b>Kaptan hedefi bilir</b><span>Masada 8 kelime var. Hedefi ve parazitleri yalnızca kaptan görür.</span></div></li>
          <li><span class="mini sigcard">PAMUK</span><div><b>Konuşmadan sinyal oynar</b><span>Elindeki kelime kartlarından birini seçer. Konuşmak yasak.</span></div></li>
          <li><span class="mini tile-tokens">BULUT<span class="dots"><i class="pc0"></i><i class="pc1"></i><i class="pc3"></i></span></span><div><b>Takım jetonla karar verir</b><span>Herkesin jetonu aynı kartta birleşince kart açılır. Parazit can götürür.</span></div></li>
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
      <section class="panel" id="l-team"></section>
      <section class="panel">
        <h2 class="panel-title"><span id="l-count"></span><span id="l-tools"></span></h2>
        <ul class="plist" id="l-players"></ul>
      </section>
      <section class="panel"><h2 class="panel-title">Nasıl oynanır</h2>${rulesHtml()}</section>
      <div class="start-bar" id="l-start"></div>
    </main>`,
  game: () => `
    <main class="game">
      <header class="hud" id="g-hud"></header>
      <div class="game-main">
        <section class="status" id="g-status"><div class="say" id="g-say" aria-live="polite"></div><span class="secs" id="g-secs"></span><span class="bar"><i id="g-bar"></i></span><div id="g-wait" class="wait-slot"></div></section>
        <section class="signals" id="g-signals" aria-label="Sinyaller"></section>
        <section class="board" id="g-board" aria-label="Kartlar"></section>
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
  put('l-code', esc(s.code));
  if (document.activeElement?.id !== 'team-input') {
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
  put('l-count', `Oyuncular · kaptan sırası (${s.players.length}/${s.maxPlayers})`);
  put('l-tools', host && s.players.length > 1 ? `<button class="btn ghost small" data-action="shuffle">${icon('shuffle', { size: 15 })} Karıştır</button>` : '');
  put(
    'l-players',
    s.players
      .map((p, i) => {
        const ctrl = host
          ? `<span class="ctrl">
              <button class="icon-btn" data-action="move" data-id="${p.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} aria-label="${esc(p.name)} yukarı">${icon('up', { size: 16 })}</button>
              <button class="icon-btn" data-action="move" data-id="${p.id}" data-dir="down" ${i === s.players.length - 1 ? 'disabled' : ''} aria-label="${esc(p.name)} aşağı">${icon('down', { size: 16 })}</button>
              ${p.id !== S.me ? `<button class="icon-btn" data-action="kick" data-id="${p.id}" aria-label="${esc(p.name)} odadan çıkar">${icon('x', { size: 16 })}</button>` : ''}
            </span>`
          : '';
        return `<li><span class="n">${i + 1}</span>${avatar(p)}<span class="who"><b>${esc(p.name)}</b>${p.id === S.me ? '<span class="badge">sen</span>' : ''}${p.id === s.hostId ? `<span class="badge host">${icon('crown', { size: 12 })} oda sahibi</span>` : ''}${p.connected ? '' : '<span class="badge">bağlantı yok</span>'}</span>${ctrl}</li>`;
      })
      .join(''),
  );
  const connected = s.players.filter((p) => p.connected).length;
  const enough = connected >= s.minPlayers;
  put(
    'l-start',
    host
      ? `<button class="btn primary" data-action="start" ${enough ? '' : 'disabled'}>Oyunu başlat</button><small>${enough ? 'İlk kaptan listedeki ilk oyuncu.' : 'En az 2 oyuncu gerekli. Davet linkini gönder.'}</small>`
      : `<small>${esc(pname(s.hostId))} oyunu başlatacak.</small>`,
  );
}

// ── oyun ──

function hudHtml() {
  const s = st();
  const run = s.run;
  const r = round();
  const hearts = Array.from({ length: run.maxLives }, (_, i) => icon('heart', { size: 18, fill: true, cls: i < run.lives ? '' : 'lost' })).join('');
  return `<div class="where"><b>TUR ${r?.no ?? run.roundNo}</b><span>${esc(r?.level.name ?? '')}${r ? ` · ${r.level.parasites} parazit` : ''} · ${esc(s.teamName)}</span></div>
    <div class="lives" title="Can: ${run.lives}/${run.maxLives}" aria-label="Can ${run.lives}">${hearts}</div>
    <div class="score" aria-label="Puan ${run.score}"><b>${run.score}</b><span>puan</span></div>
    <button class="icon-btn" data-action="menu" aria-label="Menü">${icon('menu', { size: 20 })}</button>`;
}

function nextCaptainName() {
  const s = st();
  const r = round();
  const list = s.players;
  const i = list.findIndex((p) => p.id === r.captainId);
  for (let k = 1; k <= list.length; k++) {
    const p = list[(Math.max(i, 0) + k) % list.length];
    if (p.connected) return p.id === S.me ? 'sen' : p.name;
  }
  return '';
}

function statusInfo() {
  const s = st();
  const r = round();
  const cap = isCaptain();
  const capName = pname(r.captainId);
  const n = r.signals.length;
  if (s.phase === 'REVEAL') {
    const res = r.result ?? { kind: 'cancelled' };
    const target = r.board.find((c) => c.role === 'target')?.word ?? '';
    const next = s.run.lives <= 0 ? 'Canlar bitti, sonuçlar geliyor…' : `Sıradaki kaptan: ${nextCaptainName()}`;
    const map = {
      hit: { big: 'İSABET', badge: `+${res.points} puan${res.lifeGain ? ' · +1 can' : ''}`, sub: `${target} ${n}. sinyalde bulundu. ${next}` },
      parasite: { big: 'PARAZİT', badge: '−1 can', sub: `${r.board[res.index]?.word ?? ''} parazitti, hedef ${target} idi. ${next}` },
      silence: { big: 'SİNYAL KESİLDİ', badge: '−1 can', sub: `Hedef ${target} idi. ${next}` },
      cancelled: { big: 'TUR YENİLENDİ', badge: 'ceza yok', sub: `Kaptan ayrıldı. ${next}` },
    };
    return { cls: `res-${res.kind}`, ...map[res.kind] };
  }
  if (s.phase === 'SIGNAL') {
    if (cap)
      return {
        cls: 'captain-turn me',
        title: n ? `${n + 1}. sinyal kartını seç` : 'Sinyal kartını seç',
        sub: 'Yeşil hedef, kırmızı parazit. Konuşmak yok!',
      };
    return {
      cls: 'captain-turn',
      title: `${capName} ${n ? `${n + 1}. sinyali` : 'sinyal'} seçiyor`,
      sub: n ? 'Hedef henüz bulunamadı. Kaptan yeni bir kart oynayacak.' : 'Kaptan konuşamaz. Hangi kartı oynayacağını bekleyin.',
    };
  }
  // GUESS
  if (cap) return { cls: '', title: 'Sus ve izle!', sub: 'Takım jetonlarını kartlara koyuyor. Herkes aynı kartta birleşince kart açılır.' };
  const mine = myToken();
  if (r.lock) return { cls: 'me', title: 'Kilitleniyor…', sub: 'Vazgeçen jetonunu başka yere taşısın.' };
  if (mine === undefined) return { cls: 'me', title: 'Jetonunu bir karta koy', sub: 'Herkes aynı kartta birleşince 3 saniyede açılır. Emin değilseniz Pas.' };
  const gs = s.players.filter((p) => p.connected && p.id !== r.captainId);
  const same = gs.filter((p) => r.tokens[p.id] === mine).length;
  return { cls: '', title: 'Takımın kalanını bekle', sub: `${same}/${gs.length} jeton seninle aynı yerde. Konuşun, ikna edin.` };
}

function renderStatus() {
  const s = st();
  const info = statusInfo();
  setClass('g-status', `status ${info.cls}`);
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
        `<div class="sig filled${old}"><span class="n">${i + 1}</span><span class="pts">${pts}</span><span class="w${sig.word.length > 8 ? ' long' : ''}">${esc(sig.word)}</span>${sig.auto ? '<span class="auto">süre doldu</span>' : ''}</div>`,
      );
    } else {
      const next = i === r.signals.length && s.phase === 'SIGNAL' ? ' next' : '';
      out.push(`<div class="sig empty${next}"><span class="n">${i + 1}</span><span class="pts">${pts}</span><span class="lbl">${next ? 'sıradaki sinyal' : '—'}</span></div>`);
    }
  }
  put('g-signals', out.join(''));
}

function tileHtml(card, i) {
  const s = st();
  const r = round();
  const cap = capInfo();
  const reveal = s.phase === 'REVEAL';
  const canPick = s.phase === 'GUESS' && !isCaptain() && !card.revealed && !s.waiting;
  const mine = myToken() === i;
  const meP = player(S.me);
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
  const locking = r.lock && r.lock.target === i && s.phase === 'GUESS';
  if (locking) cls.push('locking');
  const toks = s.players
    .filter((p) => r.tokens[p.id] === i)
    .map((p) => `<span class="tok pc${p.color}" title="${esc(p.name)}">${esc([...p.name][0])}</span>`)
    .join('');
  const len = [...card.word].length;
  const wcls = len >= 10 ? ' l10' : len >= 8 ? ' l8' : '';
  const role = cap && !card.revealed ? { target: ', hedef', parasite: ', parazit' }[cap.roles[i]] ?? '' : '';
  return `<button class="${cls.join(' ')}" data-action="tile" data-i="${i}" ${canPick ? '' : 'disabled'} aria-pressed="${mine}" aria-label="${esc(card.word)}${role}${card.revealed ? `, açık: ${tag.replace(/<[^>]+>/g, '').trim()}` : ''}">
    ${tag ? `<span class="tag">${tag}</span>` : ''}<span class="word${wcls}">${esc(card.word)}</span>${toks ? `<span class="toks">${toks}</span>` : ''}${locking ? '<span class="lockn" data-lock></span>' : ''}
  </button>`;
}

function renderBoard() {
  put('g-board', round().board.map(tileHtml).join(''));
}

function renderDock() {
  const s = st();
  const r = round();
  const cap = isCaptain();
  if (s.phase === 'REVEAL') {
    put(
      'g-dock',
      isHost()
        ? `<div class="reveal-actions"><button class="btn primary block" data-action="next" ${s.waiting ? 'disabled' : ''}>${s.run.lives <= 0 ? 'Sonuçları gör' : 'Sonraki tur'} ${icon('next', { size: 18 })}</button></div>`
        : `<p class="dock-note">${s.run.lives <= 0 ? 'Sonuçlar birazdan…' : 'Sıradaki tur birazdan başlıyor…'}</p>`,
    );
    return;
  }
  if (cap) {
    const info = capInfo();
    const hand = info?.hand ?? [];
    const signalPhase = s.phase === 'SIGNAL' && !s.waiting;
    if (S.sel && !hand.includes(S.sel)) S.sel = null;
    const cards = hand
      .map(
        (w) =>
          `<button class="hcard${S.sel === w ? ' sel' : ''}" data-action="card" data-w="${esc(w)}" ${signalPhase ? '' : 'disabled'} aria-pressed="${S.sel === w}">${esc(w)}</button>`,
      )
      .join('');
    const actions = signalPhase
      ? `<div class="hand-actions">
          <button class="btn signal" data-action="play" ${S.sel ? '' : 'disabled'}>${icon('send', { size: 17 })} ${S.sel ? `Oyna: ${esc(S.sel)}` : 'Bir kart seç'}</button>
          <button class="btn" data-action="redraw" ${info?.redraws > 0 ? '' : 'disabled'} aria-label="Eli değiştir">${icon('refresh', { size: 17 })} ${info?.redraws ?? 0}</button>
        </div>
        <p class="dock-note">Seçili karta tekrar dokunmak da oynar. Elini turda bir kez değiştirebilirsin.</p>`
      : `<p class="dock-note">Elin bir sonraki sinyal için hazır. Şimdi sadece izle.</p>`;
    put('g-dock', `<div class="hand">${cards}</div>${actions}`);
    return;
  }
  if (s.phase === 'SIGNAL') {
    put(
      'g-dock',
      `<div class="backs" aria-hidden="true">${'<i></i>'.repeat(Math.min(6, r.handCount))}</div><p class="dock-note">${esc(pname(r.captainId))} elindeki ${r.handCount} karttan birini seçiyor.</p>`,
    );
    return;
  }
  const mine = myToken() === PASS;
  const toks = s.players
    .filter((p) => r.tokens[p.id] === PASS)
    .map((p) => `<span class="tok pc${p.color}" title="${esc(p.name)}">${esc([...p.name][0])}</span>`)
    .join('');
  const locking = r.lock?.target === PASS;
  const left = r.maxSignals - r.signals.length;
  put(
    'g-dock',
    `<button class="pass${mine ? ` mine pc${player(S.me)?.color}` : ''}${locking ? ' locking' : ''}" data-action="pass" ${s.waiting ? 'disabled' : ''} aria-pressed="${mine}">
      ${icon('hand', { size: 18 })} ${left > 0 ? 'Pas · yeni sinyal iste' : 'Pas · sinyal kesilir (−1 can)'} ${toks ? `<span class="toks">${toks}</span>` : ''}${locking ? '<span class="lockn" data-lock></span>' : ''}
    </button>`,
  );
}

function playerChips(vertical = false) {
  const s = st();
  const r = round();
  return s.players
    .map((p) => {
      const cap = r && p.id === r.captainId;
      const decided = r && s.phase === 'GUESS' && !cap && r.tokens[p.id] !== undefined;
      return `<span class="pchip${cap ? ' cap' : ''}${p.connected ? '' : ' off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.me ? ' (sen)' : ''}</span>${cap ? icon('micOff', { size: 14 }) : ''}${decided ? icon('check', { size: 14 }) : ''}${vertical && p.id === s.hostId ? icon('crown', { size: 13 }) : ''}</span>`;
    })
    .join('');
}

function historyHtml(list) {
  if (!list.length) return '<li class="empty">Henüz tur bitmedi.</li>';
  const iconFor = { hit: 'check', parasite: 'zap', silence: 'minus', cancelled: 'refresh' };
  return [...list]
    .reverse()
    .map((h) => {
      // Sinyaller → açılan son kart (isabette hedef, parazitte parazit); bulunamadıysa hedef kesik çizgiyle.
      const last = h.picks.at(-1);
      const end =
        h.kind === 'hit'
          ? `<span class="t">${esc(h.target)}</span>`
          : h.kind === 'parasite'
            ? `<span class="t bad">${esc(last?.word ?? '')}</span>`
            : `<span class="t miss">${esc(h.target)}</span>`;
      const chain = `<span class="chain">${[...h.signals.map((w) => `<span class="s">${esc(w)}</span>`), end].join('<span class="arrow">→</span>')}</span>`;
      const note = h.kind === 'parasite' ? ` · hedef ${esc(h.target)}` : h.kind === 'silence' ? ' · bulunamadı' : h.kind === 'cancelled' ? ' · iptal' : '';
      const pts = h.kind === 'hit' ? `+${h.points}` : h.kind === 'cancelled' ? '' : '−1 can';
      return `<li><span class="ri ${h.kind}">${icon(iconFor[h.kind], { size: 15 })}</span><span class="path">${chain}<small>${h.no}. tur · kaptan ${esc(h.captainName)}${note}</small></span><span class="pts">${pts}</span></li>`;
    })
    .join('');
}

function renderGame() {
  put('g-hud', hudHtml());
  renderStatus();
  renderSignals();
  renderBoard();
  renderDock();
  put('g-players', playerChips());
  put('g-side-players', playerChips(true));
  put('g-history', historyHtml(st().run.history));
}

// ── menü ──

function openMenu() {
  const dlg = document.getElementById('menu');
  if (!dlg) return;
  const s = st();
  dlg.innerHTML = `<div class="sheet-body">
    <div class="sheet-head"><h2>${esc(s.teamName)} · oda ${esc(s.code)}</h2><button class="icon-btn" data-action="close-menu" aria-label="Kapat">${icon('x', { size: 18 })}</button></div>
    <div class="menu-row">
      <button class="btn small" data-action="copy-link">${icon('link', { size: 15 })} Davet linki</button>
      <button class="btn small" data-action="mute">${icon(S.muted ? 'mute' : 'volume', { size: 15 })} ${S.muted ? 'Sesi aç' : 'Sesi kapat'}</button>
      <button class="btn small" data-action="theme">${icon(effectiveTheme() === 'dark' ? 'sun' : 'moon', { size: 15 })} ${effectiveTheme() === 'dark' ? 'Açık tema' : 'Koyu tema'}</button>
      <button class="btn small" data-action="leave">${icon('logout', { size: 15 })} Odadan çık</button>
    </div>
    <div><h3 class="panel-title">Kurallar</h3>${rulesHtml()}</div>
  </div>`;
  if (!dlg.open) dlg.showModal();
}

// ── oyun sonu ──

function renderEnd() {
  const s = st();
  const sum = s.summary;
  if (!sum) return;
  const rec = sum.record;
  const best = sum.bestCaptain;
  const host = isHost();
  put(
    'end',
    `<div class="topline">${logo()}<button class="btn ghost small" data-action="leave">${icon('logout', { size: 16 })} Odadan çık</button></div>
    <section class="panel end-hero">
      <span class="label">${esc(s.teamName)} · oyun bitti</span>
      <span class="num">${sum.score}</span>
      <span class="muted">puan</span>
      ${rec.isNewRecord ? `<span class="record">${icon('trophy', { size: 16 })} Yeni takım rekoru!</span>` : `<span class="muted">Takım rekoru: <b>${rec.bestScore}</b> puan</span>`}
    </section>
    <section class="stats">
      <div class="stat"><b>${sum.rounds}</b><span>tur</span></div>
      <div class="stat"><b>${sum.hits}</b><span>isabet</span></div>
      <div class="stat"><b>${sum.firstTry}</b><span>ilk sinyalde</span></div>
    </section>
    ${best ? `<section class="panel" style="display:flex;align-items:center;gap:12px">${avatar(player(best.playerId) ?? { name: best.name, color: 0, connected: true })}<div><b>En iyi kaptan: ${esc(best.name)}</b><div class="muted" style="font-size:14px">${best.points} puan · ${best.hits}/${best.rounds} turda isabet</div></div></section>` : ''}
    <section class="panel"><h2 class="panel-title">Turlar</h2><ol class="history">${historyHtml(sum.history)}</ol></section>
    <div class="end-actions">
      ${
        host
          ? `<button class="btn primary block" data-action="start">${icon('refresh', { size: 18 })} Yeniden oyna</button><button class="btn block" data-action="to-lobby">Lobiye dön</button>`
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
  if (bar) bar.style.transform = `scaleX(${remaining == null || !s.phaseMs ? (s.waiting ? 1 : 0) : Math.min(1, remaining / s.phaseMs)})`;
  const urgent = remaining != null && remaining <= 10_000 && (s.phase === 'SIGNAL' || s.phase === 'GUESS');
  statusEl?.classList.toggle('urgent', urgent);
  const lock = round()?.lock;
  if (lock && s.phase === 'GUESS') {
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
  if (!r || st().phase !== 'GUESS' || isCaptain()) return;
  const next = myToken() === target ? null : target;
  // İyimser güncelleme: dokunuş anında görünsün, sunucu onaylar.
  if (next === null) delete r.tokens[S.me];
  else r.tokens[S.me] = next;
  SOUND.pick();
  send({ type: 'token', target: next });
  render();
}

const ACTIONS = {
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
  tile: (el) => setToken(Number(el.dataset.i)),
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
  if (s.phase === 'SIGNAL' && isCaptain()) {
    const hand = capInfo()?.hand ?? [];
    const k = Number(e.key);
    if (k >= 1 && k <= hand.length) {
      S.sel = hand[k - 1];
      render();
    } else if (e.key === 'Enter') playSelected();
  } else if (s.phase === 'GUESS' && !isCaptain()) {
    const k = Number(e.key);
    if (k >= 1 && k <= r.board.length && !r.board[k - 1].revealed) setToken(k - 1);
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
