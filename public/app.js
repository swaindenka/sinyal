// SİNYAL istemcisi. Sunucu otoriterdir; burası sadece durumu çizer ve eylemleri gönderir.

const app = document.getElementById('app');
const KEY_ROWS = [
  ['E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', 'Ğ', 'Ü'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ş', 'İ'],
  ['ENTER', 'Z', 'C', 'V', 'B', 'N', 'M', 'Ö', 'Ç', 'BACK'],
];
const ALPHABET = new Set([...'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ']);
const WORD_PHASES = new Set(['WORD_SETUP', 'SIGNAL', 'DISCUSSION']);

const PHASE_LABEL = {
  WORD_SETUP: 'Hazırlık',
  SIGNAL: 'Sinyal aşaması',
  DISCUSSION: 'Tartışma aşaması',
  MOLE_VOTE: 'Köstebek oylaması',
  REVEAL: 'Hesaplaşma',
};

const CHAOS = {
  category: { name: 'Kategori kilidi', icon: '🏷️', desc: (w) => `Sinyaller yalnızca “${w.category}” kategorisinden olabilir.` },
  blind: { name: 'Kör renk', icon: '🙈', desc: () => 'Bu kelimede sarılar gri gösterilir.' },
  fast: { name: 'Hızlı tur', icon: '⚡', desc: () => 'Sinyal ve tartışma süreleri kısaldı.' },
  mole: { name: 'Köstebek', icon: '🕵️', desc: () => 'Tahmincilerden biri gizlice köstebek! Kelime bitince oylama var.' },
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
  SERVER_ERROR: () => 'Sunucu hatası',
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
function playerName(id) {
  return S.state?.players.find((p) => p.id === id)?.name ?? '—';
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

// ───────────────────────── bağlantı ─────────────────────────

function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function connect(onOpen) {
  clearTimeout(S.reconnectTimer);
  const ws = new WebSocket(wsUrl());
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    S.reconnectDelay = 800;
    renderConn();
    onOpen?.();
  };
  ws.onmessage = (e) => {
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
    }
  };
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
  const key = st.run && st.word ? `${st.run.wordIndex}` : null;
  if (key !== S.wordKey) {
    S.wordKey = key;
    S.typed = '';
    S.preview = null;
    S.pending = null;
    S.renderedRows = 0;
  }
  const idx = st.run?.wordIndex;
  if (S.captainInfo && S.captainInfo.wordIndex !== idx) S.captainInfo = null;
  if (S.moleInfo && S.moleInfo.wordIndex !== idx) S.moleInfo = null;
  if (!st.run) {
    S.captainInfo = null;
    S.moleInfo = null;
  }

  if (S.pending && st.word) {
    const done = st.word.board.some((r) => r.word === S.pending) || st.word.proposals.some((p) => p.word === S.pending);
    if (done) {
      S.typed = '';
      S.preview = null;
      S.pending = null;
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
      if (ev.captainId === S.me?.playerId) toast('Kaptan sensin! Konuşmak yok 🤐', 'good');
      else toast(`${ev.wordIndex}. kelime · Kaptan: ${playerName(ev.captainId)}`);
      if (ev.chaosCard) toast(`${CHAOS[ev.chaosCard].icon} Kaos kartı: ${CHAOS[ev.chaosCard].name}`);
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
      toast('Kumbaradan 1 satır alındı 🪙', 'good');
      break;
    case 'word_end':
      if (ev.result === 'solved') SOUND.solved();
      else if (ev.result === 'trap') SOUND.trap();
      else if (ev.result === 'rows') SOUND.end();
      else if (ev.result === 'cancelled') toast('Kaptan dönmedi; kelime iptal edildi (can kaybı yok)');
      break;
    case 'mole_result':
      toast(ev.caught ? 'Köstebek yakalandı! +1 can' : 'Köstebek kaçtı…', ev.caught ? 'good' : 'err');
      break;
    case 'run_end':
      if (ev.newRecord) SOUND.record();
      else SOUND.end();
      break;
    case 'host':
      if (mine) toast('Artık oda sahibi sensin 👑', 'good');
      break;
    case 'join':
      if (!mine && st.phase !== 'LOBBY') toast(`${playerName(ev.playerId)} katıldı`);
      break;
    case 'paused':
      toast('Oyun duraklatıldı ⏸');
      break;
    case 'resumed':
      toast('Oyun devam ediyor ▶');
      break;
    default:
      break;
  }
}

// ───────────────────────── çizim ─────────────────────────

function currentScreen() {
  if (S.replaced) return 'replaced';
  if (!S.me) return 'home';
  if (!S.state) return 'connecting';
  if (S.state.phase === 'LOBBY') return 'lobby';
  if (S.state.phase === 'RUN_END') return 'end';
  return 'game';
}

function render() {
  const screen = currentScreen();
  if (screen !== S.screen) {
    S.screen = screen;
    app.innerHTML = `<div class="wrap">${LAYOUT[screen]()}</div>`;
    MOUNT[screen]?.();
  }
  UPDATE[screen]?.();
  renderConn();
}

function renderConn() {
  document.getElementById('conn').hidden = !(S.me && !S.connected && !S.replaced);
}

const RULES = `
<details class="rules">
  <summary>Nasıl oynanır?</summary>
  <ul>
    <li>3–8 kişilik <b>tek takım</b> olarak, Discord gibi sesli bir kanalda oynayın.</li>
    <li>Her kelimede biri <b>kaptan</b> olur: gizli kelimeyi görür ama <b>konuşamaz</b>, sadece <b>sinyal kelimesi</b> gönderir.</li>
    <li>Sinyalin <b>anlamı</b> gizli kelimeyi çağrıştırır; <b>harfleri</b> Wordle renkleriyle gösterilir: 🟩 doğru yer, 🟨 kelimede var, ⬜ yok.</li>
    <li><b>Tuzaklar</b> gizli kelimeden tek harf farklı kelimelerdir; tuzağı tahmin etmek can götürür. Kaptan, aradaki farkı veren <b>yasak harfleri</b> kullanamaz — bu ayrımı ancak anlamla verebilir.</li>
    <li>Tahminciler tartışır, tahmin önerir ve onaylar. Çoğunluk onaylayınca tahmin gönderilir. Bir tartışmada en fazla 2 tahmin.</li>
    <li>Her satır (sinyal, tahmin ya da boş satır) satır hakkından düşer. Son satır sadece tahmin içindir.</li>
    <li>Çözülen kelimede artan satırlar <b>kumbaraya</b> gider; gerekince oybirliğiyle kumbaradan satır çekin.</li>
    <li>En fazla 1 sinyalle çözülen kelime ⭐ kazandırır. Her 5 çözümde +1 can. Canlar bitene kadar devam!</li>
    <li>4. kelimeden itibaren her 3 kelimede bir <b>kaos kartı</b>: kategori kilidi, kör renk, hızlı tur, köstebek.</li>
  </ul>
</details>`;

const LOGO = `<h1 class="logo"><span class="s1">SİN</span><span class="s2">Y</span><span class="s3">AL</span></h1>`;

const LAYOUT = {
  home: () => `
    <main class="home">
      ${LOGO}
      <p class="tagline">Takımca, sesli oynanan Türkçe kelime oyunu. Kaptan konuşamaz — sadece sinyal gönderir.</p>
      <label><div class="label">Adın</div><input type="text" id="name" maxlength="16" autocomplete="nickname" placeholder="ör. Deniz" /></label>
      ${
        urlCode
          ? `<button class="primary" data-action="join">${esc(urlCode)} odasına katıl</button>
             <div class="or">ya da</div>
             <button data-action="create">Yeni oda kur</button>`
          : `<button class="primary" data-action="create">Oda kur</button>
             <div class="or">ya da bir odaya katıl</div>
             <div class="join-row"><input type="text" id="code" maxlength="4" placeholder="KOD" autocomplete="off" /><button data-action="join">Katıl</button></div>`
      }
      ${RULES}
    </main>`,
  connecting: () => `<div class="center-screen"><div>${LOGO}<p class="muted">Bağlanıyor…</p><button class="link" data-action="leave">Vazgeç</button></div></div>`,
  replaced: () => `<div class="center-screen"><div>${LOGO}<p>Bu oyun başka bir sekmede açıldı.</p><button class="primary" data-action="take-over">Burada devam et</button></div></div>`,
  lobby: () => `
    <main class="lobby">
      ${LOGO}
      <section class="card row-between">
        <div><div class="label">Oda kodu</div><div class="room-code" id="l-code"></div></div>
        <button data-action="copy-link">🔗 Davet linki</button>
      </section>
      <section class="card">
        <div class="label">Takım adı</div>
        <div id="l-team"></div>
        <div id="l-record" class="muted small" style="margin-top:6px"></div>
      </section>
      <section class="card">
        <div class="row-between"><div class="label">Oyuncular · kaptan sırası</div><span id="l-count" class="muted small"></span></div>
        <ol class="player-list" id="l-players"></ol>
        <div id="l-order" class="muted small" style="margin-top:8px"></div>
      </section>
      <div class="actions" id="l-actions"></div>
      ${RULES}
      <div style="text-align:center"><button class="link" data-action="leave">Odadan ayrıl</button></div>
    </main>`,
  game: () => `
    <main class="game">
      <header class="topbar" id="g-top"></header>
      <section class="phasebar" id="g-phase"></section>
      <div class="meta" id="g-meta"></div>
      <div id="g-secret"></div>
      <section class="board" id="g-board"></section>
      <section class="panel" id="g-panel"></section>
      <div class="dock"><div class="typed" id="g-typed"></div><div class="keyboard" id="g-keyboard"></div></div>
      <div class="players" id="g-players"></div>
      <div id="g-host" class="actions"></div>
    </main>`,
  end: () => `<main class="end" id="e-main"></main>`,
};

const MOUNT = {
  home() {
    const name = document.getElementById('name');
    name.value = local.get('sinyal.name', '');
    (name.value ? document.getElementById('code') ?? name : name).focus();
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
      team.innerHTML = `<input type="text" id="team-input" maxlength="24" placeholder="ör. Kartallar" />`;
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
    } else team.innerHTML = `<div style="font-size:20px;font-weight:800" id="team-view"></div>`;
  }
  if (mode === 'host') {
    const input = document.getElementById('team-input');
    if (document.activeElement !== input && input.value !== st.teamName) input.value = st.teamName;
  } else {
    document.getElementById('team-view').textContent = st.teamName || 'Oda sahibi takım adını belirleyecek…';
  }
  document.getElementById('l-record').textContent = st.record
    ? `Takım rekoru: ${st.record.bestScore} kelime · ⭐ ${st.record.bestStars} (${st.record.runs} oyun)`
    : st.teamName
      ? 'Bu takımın henüz rekoru yok.'
      : '';

  const players = st.players;
  document.getElementById('l-count').textContent = `${players.length}/${st.maxPlayers}`;
  document.getElementById('l-players').innerHTML = players
    .map(
      (p, i) => `
      <li>
        <span class="num">${i + 1}.</span>
        <span class="dot ${p.connected ? '' : 'off'}" title="${p.connected ? 'bağlı' : 'bağlantı yok'}"></span>
        <span class="pname">${esc(p.name)}</span>
        ${p.id === S.me.playerId ? '<span class="badge">sen</span>' : ''}
        ${p.id === st.hostId ? '<span class="badge host">👑 oda sahibi</span>' : ''}
        ${p.ready ? '<span class="badge ready">✓ hazır</span>' : ''}
        ${
          isHost()
            ? `<button class="icon small" data-action="move" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="yukarı">↑</button>
               <button class="icon small" data-action="move" data-id="${p.id}" data-dir="1" ${i === players.length - 1 ? 'disabled' : ''} aria-label="aşağı">↓</button>`
            : ''
        }
      </li>`,
    )
    .join('');
  document.getElementById('l-order').innerHTML = isHost()
    ? `Sırayı oklarla düzenleyebilir ya da <button class="link small" data-action="shuffle">karıştırabilirsin</button>. Elle düzenlenmezse oyun başında rastgele belirlenir.`
    : 'Kaptan sırası oyun başında rastgele belirlenir (oda sahibi düzenleyebilir).';

  const connected = players.filter((p) => p.connected).length;
  let hint = '';
  if (!st.teamName) hint = 'Başlamak için takım adı gerekli.';
  else if (connected < st.minPlayers) hint = `Başlamak için en az ${st.minPlayers} bağlı oyuncu gerekli.`;
  const ready = me()?.ready;
  document.getElementById('l-actions').innerHTML = `
    <button class="${ready ? 'success' : ''}" data-action="ready">${ready ? '✓ Hazırım' : 'Hazırım'}</button>
    ${isHost() ? `<button class="primary" data-action="start" ${hint ? 'disabled' : ''}>Oyunu başlat</button>` : ''}
    <div class="hint">${
      isHost() ? esc(hint) || 'Herkes hazırsa başlatabilirsin.' : 'Oyunu oda sahibi başlatacak.'
    }${st.devMode ? ' · Geliştirme modu: 2 oyuncu yeterli.' : ''}</div>`;
}

// ── oyun ──

function updateGame() {
  renderTop();
  renderPhase();
  renderMeta();
  renderSecret();
  renderBoard();
  renderPanel();
  renderTyped();
  renderKeyboard();
  renderPlayers();
  renderHostBar();
}

function renderTop() {
  const st = S.state;
  const run = st.run;
  const hearts = Array.from({ length: run.maxLives }, (_, i) => `<span class="${i < run.lives ? '' : 'off'}">❤️</span>`).join('');
  document.getElementById('g-top').innerHTML = `
    <div class="team" title="Oda ${esc(st.code)}">${esc(st.teamName)} <span class="muted small">· ${esc(st.code)}</span></div>
    <span class="stat hearts" title="Can">${hearts}</span>
    <span class="stat" title="Kumbara">🪙 ${run.bank}</span>
    <span class="stat" title="Çözülen kelime">✓ ${run.score}</span>
    <span class="stat" title="Yıldız">⭐ ${run.stars}</span>
    <button class="icon small" data-action="mute" title="Ses">${S.muted ? '🔇' : '🔊'}</button>`;
}

function remainingMs() {
  const st = S.state;
  if (!st) return null;
  if (st.endsAt) return Math.max(0, st.endsAt - serverNow());
  if (st.pausedRemaining != null) return st.pausedRemaining;
  return null;
}

function renderPhase() {
  const st = S.state;
  const el = document.getElementById('g-phase');
  if (!el) return;
  const rem = remainingMs();
  const secs = rem == null ? '' : Math.ceil(rem / 1000);
  const pct = rem != null && st.phaseDuration ? Math.max(0, Math.min(100, (rem / st.phaseDuration) * 100)) : 0;
  let note = '';
  if (st.paused) {
    const parts = [];
    if (st.pauseReasons.includes('host')) parts.push('Oda sahibi oyunu duraklattı.');
    if (st.pauseReasons.includes('captain')) {
      const left = st.captainAwayUntil ? Math.max(0, Math.ceil((st.captainAwayUntil - serverNow()) / 1000)) : '';
      parts.push(`Kaptanın bağlantısı koptu, bekleniyor (${left} sn). Dönmezse kelime iptal edilir.`);
    }
    if (st.pauseReasons.includes('players')) parts.push(`Oyuncu bekleniyor: en az ${st.minPlayers} bağlı oyuncu gerekli.`);
    note = `<div class="pause-note">⏸ ${parts.join(' ')}</div>`;
  }
  el.className = `phasebar ${st.paused ? 'paused' : ''}`;
  el.innerHTML = `
    <div class="row-between">
      <div class="title">${st.run.wordIndex}. kelime · ${PHASE_LABEL[st.phase] ?? ''}</div>
      <div class="count ${rem != null && rem < 10000 && !st.paused ? 'low' : ''}">${secs === '' ? '' : `${secs} sn`}</div>
    </div>
    ${note}
    <div class="bar" style="width:${pct}%"></div>`;

  // son 5 saniyede tik sesi (sadece ilgili oyuncuya)
  if (rem != null && !st.paused && secs <= 5 && secs > 0 && S.lastTick !== `${st.phase}:${secs}`) {
    S.lastTick = `${st.phase}:${secs}`;
    const relevant = (st.phase === 'SIGNAL' && isCaptain()) || (st.phase === 'DISCUSSION' && !isCaptain());
    if (relevant) SOUND.tick();
  }
}

function renderMeta() {
  const w = S.state.word;
  if (!w) return;
  const used = w.rowLimit - w.rowsRemaining;
  const card = w.chaosCard ? CHAOS[w.chaosCard] : null;
  document.getElementById('g-meta').innerHTML = `
    <span class="chip">${w.length} harf</span>
    <span class="chip">${w.trapCount} tuzak</span>
    <span class="chip">${w.forbiddenCount} yasak harf</span>
    <span class="chip">Satır ${used}/${w.rowLimit}</span>
    ${card ? `<span class="chip chaos">${card.icon} <b>${card.name}:</b> ${esc(card.desc(w))}</span>` : ''}`;
}

function miniTiles(word, cls) {
  return `<span class="mini-tiles ${cls}">${[...word].map((c) => `<span>${esc(c)}</span>`).join('')}</span>`;
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
    <div class="secret ${mole ? 'mole' : ''}">
      <div class="row-between">
        <strong>${mole ? '🕵️ Köstebeksin! Takımı tuzağa çek, yakalanma.' : '🤐 Kaptan sensin — konuşmak yok, sadece sinyal!'}</strong>
        <button class="icon small" data-action="toggle-secret" title="Gizle/göster">${hide ? '👁️' : '🙈'}</button>
      </div>
      ${
        hide
          ? '<div class="hidden-word">GİZLİ BİLGİ SAKLANDI</div>'
          : `
      <div class="line"><span class="label" style="margin:0">Gizli kelime</span>${miniTiles(info.secret, 'secret-w')}</div>
      <div class="line"><span class="label" style="margin:0">Tuzak</span>${info.traps.map((t) => miniTiles(t, 'trap-w')).join(' ')}</div>
      <div class="line"><span class="label" style="margin:0">Yasak harfler</span>${info.forbidden
        .map((c) => `<span class="forbidden-chip">${esc(c)}</span>`)
        .join('')}${mole ? '' : '<span class="muted small">sinyalde hiçbir yerde kullanılamaz</span>'}</div>`
      }
    </div>`;
}

function rowHtml(row, len, i, opts) {
  const kindIcon = { signal: '📡', guess: '🎯', empty: '⏱️' };
  if (!row) {
    const last = opts.last;
    return `<div class="brow future ${last ? 'last-row' : ''}" title="${last ? 'Son satır: yalnızca tahmin' : ''}">
      <span class="kind">${last ? '🎯' : ''}</span>
      <div class="tiles">${'<div class="tile"></div>'.repeat(len)}</div>
      <span class="by">${last ? 'son satır: yalnızca tahmin' : ''}</span>
    </div>`;
  }
  const anim = opts.animate ? 'flip' : '';
  const tiles =
    row.type === 'empty'
      ? '<div class="tile empty-row"></div>'.repeat(len)
      : [...row.word].map((c, k) => `<div class="tile c-${row.colors[k]}" style="animation-delay:${k * 70}ms">${esc(c)}</div>`).join('');
  const by =
    row.type === 'signal'
      ? `Sinyal · ${esc(playerName(row.byPlayerId))}`
      : row.type === 'guess'
        ? `Tahmin · ${esc(playerName(row.byPlayerId))}${row.result === 'trap' ? ' · 💥 TUZAK' : row.result === 'correct' ? ' · ✅' : ''}`
        : 'Boş satır (süre doldu)';
  return `<div class="brow ${anim} ${row.result ? `res-${row.result}` : ''}">
    <span class="kind" title="${row.type}">${kindIcon[row.type]}</span>
    <div class="tiles">${tiles}</div>
    <span class="by">${by}</span>
  </div>`;
}

function renderBoard() {
  const w = S.state.word;
  const el = document.getElementById('g-board');
  if (!w) {
    el.innerHTML = '';
    return;
  }
  el.style.setProperty('--len', w.length);
  const rows = [];
  for (let i = 0; i < w.rowLimit; i++) {
    rows.push(rowHtml(w.board[i], w.length, i, { animate: i >= S.renderedRows && i < w.board.length, last: i === w.rowLimit - 1 }));
  }
  el.innerHTML = rows.join('');
  S.renderedRows = w.board.length;
}

function proposalHtml(p, st, canAct) {
  const w = st.word;
  const mine = p.approvals.includes(S.me.playerId);
  const need = p.kind === 'bank' ? w.thresholds.bank : w.thresholds.guess;
  const what =
    p.kind === 'guess'
      ? miniTiles(p.word, 'plain')
      : p.kind === 'pass'
        ? '<strong>⏭ PAS</strong> <span class="muted small">(satır harcamaz)</span>'
        : '<strong>🪙 Kumbaradan +1 satır</strong> <span class="muted small">(oybirliği)</span>';
  const approvers = p.approvals.map(playerName).join(', ');
  return `<div class="proposal ${mine ? 'mine' : ''}">
    <div class="what">${what}<div class="who">${esc(playerName(p.byPlayerId))} önerdi · onaylayan: ${esc(approvers)}</div></div>
    <span class="votes">${p.approvals.length}/${need}</span>
    ${canAct ? `<button class="small ${mine ? '' : 'primary'}" data-action="approve" data-id="${p.id}">${mine ? 'Geri çek' : 'Onayla'}</button>` : ''}
  </div>`;
}

function renderPanel() {
  const st = S.state;
  const w = st.word;
  const el = document.getElementById('g-panel');
  const cap = isCaptain();
  let html = '';
  switch (st.phase) {
    case 'WORD_SETUP':
      html = cap
        ? `<h3>Kaptan sensin! 🤐</h3><div class="big-note">Gizli kelimeyi ve tuzakları incele. Birazdan sinyal göndereceksin. Bu kelime boyunca <b>konuşma</b>.</div>`
        : `<h3>Yeni kelime: ${w.length} harf</h3><div class="big-note">Kaptan <b>${esc(playerName(w.captainId))}</b>. Kaptan konuşamaz; sinyalini bekleyin.</div>`;
      break;
    case 'SIGNAL':
      html = cap
        ? `<h3>Sinyal gönder</h3><div class="big-note">${w.length} harfli, yasak harf içermeyen bir kelime yaz. Renklerin önizlemesini aşağıda görürsün.</div>`
        : `<h3>Kaptan sinyal düşünüyor…</h3><div class="big-note">Bu sırada aklınızdaki adayları konuşabilirsiniz. Tahmin önerileri tartışma aşamasında açılır.</div>`;
      break;
    case 'DISCUSSION': {
      const lastRow = w.rowsRemaining <= 1;
      const props = w.proposals.length
        ? `<div class="proposals">${w.proposals.map((p) => proposalHtml(p, st, !cap && !st.paused)).join('')}</div>`
        : '<div class="muted">Henüz öneri yok.</div>';
      html = `
        <div class="row-between"><h3>${cap ? 'Takım tartışıyor — sessiz kal 🤐' : 'Tartışın ve tahmin önerin'}</h3>
        <span class="muted small">Tahmin ${w.guessesThisDiscussion}/${w.maxGuesses} · onay eşiği ${w.thresholds.guess}/${w.guesserCount}</span></div>
        ${lastRow ? '<div class="pause-note" style="margin:0">🎯 Son satır: pas yok, süre dolarsa kelime kaybedilir.</div>' : ''}
        ${props}
        ${
          cap
            ? '<div class="muted small">Sıradaki sinyalini şimdiden yazıp önizleyebilirsin.</div>'
            : `<div class="actions">
                 <button data-action="pass" ${lastRow || st.paused ? 'disabled' : ''}>⏭ Pas öner</button>
                 <button data-action="bank" ${st.run.bank <= 0 || st.paused ? 'disabled' : ''}>🪙 Kumbaradan satır (${st.run.bank})</button>
               </div>`
        }`;
      break;
    }
    case 'MOLE_VOTE': {
      const voted = new Set(w.votedIds || []);
      const targets = st.players.filter((p) => p.id !== S.me.playerId && p.id !== w.captainId);
      html = `<h3>🕵️ Köstebek kim?</h3>
        <div class="big-note">Kelime bitti. Köstebek olduğunu düşündüğün kişiye oy ver. En çok oyu alan köstebekse takım +1 can kazanır (eşitlikte kaçar).</div>
        <div class="vote-grid">${targets
          .map((p) => `<button data-action="vote" data-id="${p.id}" class="${S.myVote === p.id ? 'chosen' : ''}" ${st.paused ? 'disabled' : ''}>${esc(p.name)}</button>`)
          .join('')}</div>
        <div class="muted small">${voted.size}/${st.players.filter((p) => p.connected).length} kişi oy verdi${voted.has(S.me.playerId) ? ' · senin oyun alındı' : ''}</div>`;
      break;
    }
    case 'REVEAL':
      html = revealHtml(st);
      break;
    default:
      html = '';
  }
  el.innerHTML = html;
  el.hidden = !html;
}

function revealHtml(st) {
  const r = st.reveal;
  if (!r) return '';
  const title = {
    solved: ['good', `Çözüldü! 🎉${r.star ? ' +⭐' : ''}`],
    trap: ['bad', 'Tuzağa düştünüz! 💥 −1 can'],
    rows: ['bad', 'Satırlar bitti… −1 can'],
  }[r.result] ?? ['', 'Kelime bitti'];
  const extras = [];
  if (r.bankGained) extras.push(`🪙 +${r.bankGained} kumbara`);
  if (r.lifeGained) extras.push('❤️ +1 can (5 çözüm)');
  let mole = '';
  if (r.moleId) {
    const votes = r.votes ? Object.entries(r.votes).map(([v, t]) => `${esc(playerName(v))} → ${esc(playerName(t))}`).join(', ') : '';
    mole = `<div>🕵️ Köstebek: <b>${esc(playerName(r.moleId))}</b> — ${
      r.moleVoteSkipped ? 'bağlantısı koptuğu için oylama yapılmadı' : r.moleCaught ? 'yakalandı! ❤️ +1 can' : 'yakalanmadı'
    }${votes ? `<div class="muted small">Oylar: ${votes}</div>` : ''}</div>`;
  }
  return `
    <div class="result-banner ${title[0]}">${title[1]}</div>
    ${extras.length ? `<div>${extras.join(' · ')}</div>` : ''}
    <div class="reveal-grid">
      <div class="line"><span class="label">Gizli kelime</span> ${miniTiles(r.secret, 'secret-w')}</div>
      <div class="line"><span class="label">Tuzak</span> ${r.traps.map((t) => miniTiles(t, 'trap-w')).join(' ')}</div>
      <div class="line"><span class="label">Yasak harfler</span> ${r.forbidden.map((c) => `<span class="forbidden-chip">${esc(c)}</span>`).join(' ')}</div>
    </div>
    ${mole}
    <div class="muted">🎙️ Kaptan ${esc(playerName(r.captainId))} artık konuşabilir: sinyallerini açıklasın!</div>
    ${isHost() ? '<button class="primary" data-action="skip-reveal">Devam</button>' : ''}`;
}

function canType() {
  const st = S.state;
  if (!st?.word || !WORD_PHASES.has(st.phase)) return false;
  if (isCaptain()) return true;
  return st.phase === 'SIGNAL' || st.phase === 'DISCUSSION';
}

function renderTyped() {
  const el = document.getElementById('g-typed');
  if (!el) return;
  const st = S.state;
  if (!canType()) {
    el.innerHTML = '';
    return;
  }
  const len = st.word.length;
  const cap = isCaptain();
  const pv = cap && S.preview && S.preview.word === S.typed ? S.preview : null;
  const letters = [...S.typed];
  const tiles = Array.from({ length: len }, (_, i) => {
    const c = letters[i] ?? '';
    const color = pv?.colors ? `c-${pv.colors[i]}` : c ? 'filled' : '';
    return `<div class="tile ${color}">${esc(c)}</div>`;
  }).join('');
  let msg = '';
  let cls = '';
  if (cap) {
    if (pv?.error && !(pv.error === 'WRONG_LENGTH' && letters.length < len)) {
      msg = ERRORS[pv.error]?.(S) ?? pv.error;
      cls = 'err';
    } else if (pv && !pv.error) {
      msg = st.phase === 'SIGNAL' ? 'Geçerli sinyal ✓ GÖNDER tuşuyla gönder' : 'Geçerli sinyal ✓ (sinyal aşamasında gönderebilirsin)';
      cls = 'ok';
    } else msg = 'Önizleme: renkler gönderilince herkese böyle görünecek';
  } else {
    msg = st.phase === 'DISCUSSION' ? 'Kelimeyi yaz, ÖNER ile tahmin önerisi yap' : 'Taslak yazabilirsin; öneriler tartışmada açılır';
  }
  el.innerHTML = `
    <div class="typed-row" style="--tile: min(44px, calc((100vw - 32px - 6px * ${len}) / ${len}))"><div class="tiles">${tiles}</div></div>
    <div class="msg ${cls}">${esc(msg)}</div>`;
  // GÖNDER/ÖNER tuşu, gönderilebilir durumdayken vurgulanır.
  const enter = document.querySelector('.key[data-key="ENTER"]');
  if (enter) enter.classList.toggle('go', canSubmitNow());
}

function canSubmitNow() {
  const st = S.state;
  if (!st?.word || st.paused || [...S.typed].length !== st.word.length) return false;
  return isCaptain() ? st.phase === 'SIGNAL' : st.phase === 'DISCUSSION';
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
  if (!canType()) {
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
          if (k === 'ENTER') return `<button class="key wide ${canSubmitNow() ? 'go' : ''}" data-action="key" data-key="ENTER">${cap ? 'GÖNDER' : 'ÖNER'}</button>`;
          if (k === 'BACK') return `<button class="key wide" data-action="key" data-key="BACK" aria-label="sil">⌫</button>`;
          const cls = forbidden.has(k) ? 'forbidden' : colors[k] ? `c-${colors[k]}` : '';
          return `<button class="key ${cls}" data-action="key" data-key="${k}">${k}</button>`;
        })
        .join('')}</div>`,
  ).join('');
}

function renderPlayers() {
  const st = S.state;
  const w = st.word;
  document.getElementById('g-players').innerHTML = st.players
    .map((p, i) => {
      const captain = w && p.id === w.captainId;
      return `<span class="pchip ${captain ? 'captain' : ''} ${p.id === S.me.playerId ? 'me' : ''}">
        <span class="dot ${p.connected ? '' : 'off'}"></span>
        ${i + 1}. ${esc(p.name)}${captain ? ' 🤐' : ''}${p.id === st.hostId ? ' 👑' : ''}
        ${
          S.editOrder && isHost()
            ? `<button class="icon small" data-action="move" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon small" data-action="move" data-id="${p.id}" data-dir="1" ${i === st.players.length - 1 ? 'disabled' : ''}>↓</button>`
            : ''
        }
      </span>`;
    })
    .join('');
}

function renderHostBar() {
  const el = document.getElementById('g-host');
  const st = S.state;
  const hostPaused = st.pauseReasons.includes('host');
  el.innerHTML = `
    ${isHost() ? `<button class="small" data-action="pause">${hostPaused ? '▶ Devam ettir' : '⏸ Duraklat'}</button>` : ''}
    ${isHost() ? `<button class="small" data-action="edit-order">${S.editOrder ? '✓ Sıra tamam' : '↕ Kaptan sırası'}</button>` : ''}
    <button class="small link" data-action="leave">Ayrıl</button>`;
}

// ── oyun sonu ──

const RESULT_LABEL = { solved: '✅ çözüldü', trap: '💥 tuzak', rows: '⌛ satır bitti', cancelled: '🚫 iptal' };
const CHAOS_SHORT = { category: '🏷️', blind: '🙈', fast: '⚡', mole: '🕵️' };

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
      return `<tr><td>${esc(p.name)}</td><td>${t.captainWords}</td><td>${t.captainSolved}</td><td>${avg}</td><td>${t.captainStars}</td>
        <td>${t.proposed}</td><td>${t.submitted}</td><td>${t.submittedCorrect}</td><td>${t.submittedTrap}</td>
        <td>${t.moleTurns}</td><td>${t.moleSuccess}</td><td>${t.moleCaught}</td><td>${t.moleCorrectVotes}</td></tr>`;
    })
    .join('');
  el.innerHTML = `
    ${LOGO}
    <div class="muted" style="text-align:center">${esc(s.teamName)} · oyun bitti</div>
    <div class="score-big">${s.score} <small>kelime</small> · ⭐ ${s.stars}</div>
    <div class="record ${rec?.isNewRecord ? 'new' : 'muted'}">${
      rec?.isNewRecord
        ? `🏆 Yeni takım rekoru!${rec.previous.bestScore || rec.previous.bestStars ? ` (önceki: ${rec.previous.bestScore} kelime · ⭐ ${rec.previous.bestStars})` : ''}`
        : rec
          ? `Takım rekoru: ${rec.bestScore} kelime · ⭐ ${rec.bestStars}`
          : ''
    }</div>
    ${
      s.awards.length
        ? `<section><div class="label">Ödüller</div><div class="awards">${s.awards
            .map((a) => `<div class="award"><div class="t">🏅 ${esc(a.title)}</div><div class="muted small">${esc(a.description)}</div><div class="w">${a.winners.map((w) => esc(w.name)).join(', ')}</div></div>`)
            .join('')}</div></section>`
        : ''
    }
    <section class="card">
      <div class="label">Kelimeler</div>
      <div class="table-wrap"><table>
        <tr><th>#</th><th>Kelime</th><th>Tuzak</th><th>Kaptan</th><th>Sonuç</th><th>Satır</th><th></th></tr>
        ${s.words
          .map(
            (w) => `<tr><td>${w.wordIndex}</td><td><b>${esc(w.secret)}</b></td><td class="muted">${esc(w.traps.join(', '))}</td><td>${esc(w.captainName)}</td>
              <td>${RESULT_LABEL[w.result] ?? w.result}${w.star ? ' ⭐' : ''}</td><td>${w.rowsUsed}/${w.rowLimit}</td><td>${w.chaosCard ? CHAOS_SHORT[w.chaosCard] : ''}</td></tr>`,
          )
          .join('')}
      </table></div>
    </section>
    <details class="card">
      <summary style="cursor:pointer;font-weight:700">Oyuncu istatistikleri</summary>
      <div class="table-wrap"><table>
        <tr><th>Oyuncu</th><th>Kaptan</th><th>Çözdü</th><th>Ort. satır</th><th>⭐</th><th>Öneri</th><th>Gönderilen</th><th>Doğru</th><th>Tuzak</th><th>Köstebek</th><th>Başarılı</th><th>Yakalandı</th><th>Doğru oy</th></tr>
        ${stats}
      </table></div>
    </details>
    <div class="actions">
      ${isHost() ? '<button class="primary" data-action="start">🔁 Yeniden oyna</button><button data-action="to-lobby">Lobiye dön</button>' : '<div class="hint">Yeni oyunu oda sahibi başlatabilir.</div>'}
    </div>
    <div style="text-align:center"><button class="link" data-action="leave">Odadan ayrıl</button></div>`;
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
    case 'submit':
      submitTyped();
      break;
    case 'approve':
      send({ type: 'approve', proposalId: id });
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
  if (e.key === 'Backspace') {
    e.preventDefault();
    pressKey('BACK');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pressKey('ENTER');
  } else if (e.key.length === 1) {
    const k = norm(e.key);
    if (ALPHABET.has(k)) {
      e.preventDefault();
      pressKey(k);
    }
  }
});

// Sayaçları sunucudaki endsAt'e göre çiz.
setInterval(() => {
  if (S.screen === 'game') renderPhase();
}, 250);

// Köstebek oyu kelime değişince sıfırlanır.
let lastVoteWord = null;
setInterval(() => {
  const k = S.state?.run?.wordIndex;
  if (k !== lastVoteWord) {
    lastVoteWord = k;
    S.myVote = null;
  }
}, 500);

// ───────────────────────── başlat ─────────────────────────

render();
if (S.me) connect(rejoin);
