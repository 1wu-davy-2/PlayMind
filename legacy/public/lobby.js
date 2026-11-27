/* ============================================================
   BOMB TABLE — 大厅：立案 / 接入令 / 席位监听
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const S = {
  roomId: null,
  joinUrl: '',
  lanJoinUrl: '',
  pitch: '',
  pitchSeats: -1,
  hostToken: null,
  humanToken: null,
  meId: null,
  seats: 4,
  gameType: 'bomb-table',
  gameTitle: 'BOMB TABLE',
  mode: 'mixed',
  state: null,
  es: null,
  starting: false,
  creating: false,
};

const KIND_TAG = {
  human: '<span class="tag tag--human">人类</span>',
  agent: '<span class="tag tag--agent">AGENT</span>',
  bot:   '<span class="tag tag--bot">BOT</span>',
};

/* ---------------- 小工具 ---------------- */

let toastTimer = 0;
function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast show ${bad ? 'toast--bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 1800);
}

async function copy(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 剪贴板 API 不可用时退回 execCommand */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1300);
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式忽略 */ }
}
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/* ---------------- 席位数 ---------------- */

function setSeats(n) {
  S.seats = n;
  $$('#seats .seg__btn').forEach((b) => {
    b.classList.toggle('is-on', Number(b.dataset.seats) === n);
  });
  $('#seat-note').textContent = S.mode === 'ai'
    ? `${n} 人桌 · 全是 AI，你只看`
    : `${n} 人桌 · 你 + ${n - 1} 个 AI`;
  if (S.state) paintRoom();
}

$('#seats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-seats]');
  if (b) setSeats(Number(b.dataset.seats));
});

/* ---------------- 游戏类型 ---------------- */

let GAMES = [];
let rulesBackup = null;

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function mdToHtml(md) {
  const lines = String(md || '').split('\n');
  let html = '';
  let inUl = false;
  const closeUl = () => { if (inUl) { html += '</ul>'; inUl = false; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { closeUl(); continue; }
    if (/^###\s/.test(l)) { closeUl(); html += `<h4>${inlineMd(l.replace(/^###\s+/, ''))}</h4>`; continue; }
    if (/^##\s/.test(l)) { closeUl(); html += `<h3>${inlineMd(l.replace(/^##\s+/, ''))}</h3>`; continue; }
    if (/^#\s/.test(l)) { closeUl(); html += `<h3>${inlineMd(l.replace(/^#\s+/, ''))}</h3>`; continue; }
    if (/^[-*]\s/.test(l)) {
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += `<li>${inlineMd(l.replace(/^[-*]\s+/, ''))}</li>`;
      continue;
    }
    closeUl();
    html += `<p>${inlineMd(l)}</p>`;
  }
  closeUl();
  return html;
}

function loadRules(id) {
  const box = document.querySelector('#modal-rules .rules');
  const title = $('#rules-title');
  if (!box) return;
  if (id === 'bomb-table') {
    if (rulesBackup) box.innerHTML = rulesBackup;
    if (title) title.textContent = '牌局规则';
    return;
  }
  if (!rulesBackup) rulesBackup = box.innerHTML;
  fetch(`/api/games/${encodeURIComponent(id)}/rules`)
    .then((r) => r.text())
    .then((md) => {
      if (S.gameType !== id) return;
      box.innerHTML = `<div class="rules__col" style="grid-column:1/-1">${mdToHtml(md)}</div>`;
      const g = GAMES.find((x) => x.id === id);
      if (title) title.textContent = `${g ? g.title : ''} · 规则`;
    })
    .catch(() => {
      if (S.gameType !== id) return;
      box.innerHTML = '<div class="rules__col" style="grid-column:1/-1"><p>规则加载失败，请稍后重试。</p></div>';
    });
}

function updateLede() {
  const el = $('#intake-lede');
  if (!el) return;
  const tail = S.gameType === 'bomb-table' ? '开始撒谎。' : '按规则玩完这一局。';
  el.innerHTML = S.mode === 'ai'
    ? '这一桌不坐人。开好桌，把<b>接入链接</b>发给 2 个以上 AI，它们坐满就自动开打 —— 你只需要看。'
    : `你坐主位，剩下的椅子留给 AI。开好桌，你会拿到一条<b>接入链接</b> —— 把它发给任意一个 AI，它自己会读说明书、入座、${tail}`;
}

function setGame(id) {
  const g = GAMES.find((x) => x.id === id) || GAMES[0];
  if (!g) return;
  S.gameType = g.id;
  S.gameTitle = g.title;
  const sel = $('#game-type');
  if (sel) sel.value = g.id;
  $$('#seats .seg__btn').forEach((b) => {
    const n = Number(b.dataset.seats);
    const ok = n >= g.min && n <= g.max;
    b.disabled = !ok;
    b.style.opacity = ok ? '' : '.28';
  });
  if (S.seats < g.min || S.seats > g.max) setSeats(Math.min(g.max, Math.max(g.min, S.seats)));
  store('bt.game', g.id);
  document.title = `${g.title} · 多智能体牌桌`;
  const seal = $('#seal-game');
  if (seal) seal.textContent = g.title;
  const brand = $('#brand-cn');
  if (brand) brand.textContent = g.id === 'bomb-table'
    ? '炸弹牌桌 · 多智能体审讯游戏'
    : `${g.title} · 多智能体牌桌`;
  const f1k = $('#foot1-k');
  const f1v = $('#foot1-v');
  const f2k = $('#foot2-k');
  const f2v = $('#foot2-v');
  if (f1k) f1k.textContent = g.id === 'bomb-table' ? '牌 堆 / 26 张' : '玩 法';
  if (f1v) f1v.textContent = g.id === 'bomb-table'
    ? '炸弹、质询、安全、补给。顺序在你们坐下之前就定好了。'
    : g.desc;
  if (f2k) f2k.textContent = g.id === 'bomb-table' ? '质 询 是 刀' : '私 有 信 息';
  if (f2v) f2v.textContent = g.id === 'bomb-table'
    ? '受审的人能偷看下一张牌，然后当着所有人的面回答你。'
    : '身份、手牌、骰面由服务端按 token 单独下发，每个玩家只看到自己该看的。';
  updateLede();
  loadRules(g.id);
  const note = $('#create-msg');
  if (note && !S.roomId) note.textContent = `${g.title} · ${g.desc}`;
}

async function loadGames() {
  try {
    const res = await fetch('/api/games');
    const j = await res.json();
    GAMES = Array.isArray(j.games) ? j.games : [];
  } catch { GAMES = []; }
  const sel = $('#game-type');
  if (!sel) return;
  if (!GAMES.length) {
    GAMES = [{ id: 'bomb-table', title: 'BOMB TABLE', desc: '抽牌审讯', min: 2, max: 6 }];
  }
  sel.innerHTML = GAMES.map((g) => `<option value="${esc(g.id)}">${esc(g.title)} · ${esc(g.desc)}</option>`).join('');
  setGame(read('bt.game') || 'bomb-table');
  sel.addEventListener('change', () => setGame(sel.value));
}

/* ---------------- 模式 ---------------- */

function setMode(mode) {
  S.mode = mode === 'ai' ? 'ai' : 'mixed';
  $$('#mode .seg__btn').forEach((b) => b.classList.toggle('is-on', b.dataset.mode === S.mode));
  const ai = S.mode === 'ai';
  $('#field-name').hidden = ai;
  updateLede();
  $('#btn-create').textContent = ai ? '开 一 桌 纯 A I' : '开 桌';
  $('#create-msg').textContent = ai
    ? '纯 AI 房：坐满自动开局，你在旁边看。'
    : '牌桌开好后，把接入链接发给 AI 就行。';
  setSeats(S.seats);
}

$('#mode')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) setMode(b.dataset.mode);
});

/* ---------------- 开桌 ---------------- */

async function createRoom() {
  if (S.creating) return;
  const name = ($('#input-name').value || '魏工').trim().slice(0, 12) || '魏工';
  S.creating = true;
  const btn = $('#btn-create');
  const msg = $('#create-msg');
  btn.disabled = true;
  msg.className = 'intake__foot';
  msg.textContent = '正在立卷…';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        humanName: name,
        seats: S.seats,
        gameType: S.gameType,
        mode: S.mode,
        autoStart: S.mode === 'ai',
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.roomId) {
      msg.className = 'intake__foot is-bad';
      msg.textContent = `开桌失败 · ${j.error || res.status}`;
      return;
    }

    S.roomId = j.roomId;
    S.joinUrl = j.joinUrl || `${location.origin}/join/${j.roomId}`;
    S.lanJoinUrl = j.lanJoinUrl || '';
    S.pitch = j.pitch || '';
    S.hostToken = j.hostToken || null;
    S.humanToken = j.humanToken || null;
    S.mode = j.mode || S.mode;
    S.state = j.state || null;
    S.gameTitle = j.gameTitle || S.gameTitle;
    const me = S.state?.players?.find((p) => p.kind === 'human');
    S.meId = me?.id || (S.humanToken ? 'p0' : null);

    store(`bt.token.${S.roomId}`, S.humanToken || '');
    store(`bt.host.${S.roomId}`, S.hostToken || '');
    store(`bt.seats.${S.roomId}`, String(S.seats));
    store(`bt.me.${S.roomId}`, S.meId || '');
    store(`bt.name.${S.roomId}`, name);
    store(`bt.game.${S.roomId}`, S.gameType);

    history.replaceState(null, '', `?room=${S.roomId}`);
    showRoom();
    connect();
  } catch (err) {
    msg.className = 'intake__foot is-bad';
    msg.textContent = `开桌失败 · ${err.message}`;
  } finally {
    S.creating = false;
    btn.disabled = false;
  }
}

/* ---------------- 视图切换 ---------------- */

function showRoom() {
  $('#intake').hidden = true;
  $('#room').hidden = false;
  $('#room-no').textContent = S.roomId;
  $('#order-no').textContent = S.roomId;
  document.title = `${S.roomId} · ${S.gameTitle || 'BOMB TABLE'}`;
  paintRoom();
}

/* ---------------- 渲染席位 ---------------- */

function ticketHTML(idx, p) {
  const no = String(idx + 1).padStart(2, '0');

  if (!p) {
    return `<div class="ticket is-empty" style="animation-delay:${idx * 60}ms">
      <div class="ticket__stub"><span>SEAT ${no}</span></div>
      <div class="ticket__body">
        <div class="ticket__top"><b>等待接入…</b></div>
        <div class="ticket__meta">空位 · 把接入令发出去</div>
      </div>
    </div>`;
  }

  const me = p.id === S.meId;
  const cls = ['ticket', p.kind === 'human' ? 'ticket--human' : '', me ? 'ticket--me' : ''].filter(Boolean).join(' ');
  const tags = `${KIND_TAG[p.kind] || ''}${me ? '<span class="tag tag--you">你</span>' : ''}`;

  return `<div class="${cls}" style="animation-delay:${idx * 60}ms">
    <div class="ticket__stub"><span>SEAT ${no}</span></div>
    <div class="ticket__body">
      <div class="ticket__top"><b>${esc(p.name)}</b><span class="ticket__tags">${tags}</span></div>
      <div class="ticket__meta">${esc(p.glyph || '·')} · 已入座${p.alive === false ? ' · 已出局' : ''}</div>
    </div>
  </div>`;
}

function paintRoom() {
  const st = S.state;
  const players = st?.players || [];
  const total = Number(st?.seats) || S.seats || Math.max(2, players.length);

  const rows = [];
  for (let i = 0; i < total; i += 1) rows.push(ticketHTML(i, players[i]));
  $('#tickets').innerHTML = rows.join('');

  const n = Math.min(players.length, total);
  $('#seat-count').textContent = `${n} / ${total}`;
  $('#desk-n').textContent = String(n);
  $('#desk-t').textContent = `/ ${total}`;
  $('#desk-pips').innerHTML = Array.from({ length: total },
    (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');

  const startBtn = $('#btn-start');
  const canStart = n >= 2 && !!S.hostToken && !S.starting;
  startBtn.disabled = !canStart;
  startBtn.setAttribute('aria-disabled', String(!canStart));

  const abortBtn = $('#btn-abort-room');
  if (abortBtn) {
    abortBtn.hidden = !S.hostToken;
    abortBtn.disabled = !S.hostToken || S.state?.status === 'ended';
  }

  const note = $('#start-note');
  if (!S.hostToken) {
    note.textContent = '这张桌不是你开的，只有开桌的人能开局。';
    note.className = 'desk__note is-bad';
  } else if (S.starting) {
    note.textContent = '正在封卷、发牌…';
    note.className = 'desk__note';
  } else if (n < 2) {
    note.textContent = '至少 2 人可开局，空位由内置 bot 落座。';
    note.className = 'desk__note';
  } else {
    note.textContent = `还差 ${total - n} 席没坐满 —— 也可以直接开，空位由内置 bot 填。`;
    note.className = 'desk__note';
  }

  $('#join-url').textContent = S.joinUrl || `${location.origin}/join/${S.roomId}`;
  const lanRow = $('#lan-row');
  if (lanRow) {
    const lan = S.lanJoinUrl || '';
    if (lan && lan !== S.joinUrl) {
      lanRow.hidden = false;
      $('#lan-url').textContent = lan;
    } else {
      lanRow.hidden = true;
    }
  }
  paintPitch();
}

/* ---------------- SSE ---------------- */

function setHint(text, live) {
  const el = $('#board-hint');
  el.innerHTML = live
    ? `<span class="dotline"><i></i><i></i><i></i></span>${esc(text)}`
    : esc(text);
  el.style.color = live ? '' : 'var(--red)';
}

function connect() {
  if (S.es) S.es.close();
  const es = new EventSource(`/api/rooms/${encodeURIComponent(S.roomId)}/events`);
  S.es = es;

  es.onopen = () => { setHint('正在监听接入', true); };

  es.onerror = () => { setHint('连接中断 · 重连中', false); };

  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }

    if (ev.t === 'state' && ev.state) {
      const prevFilled = S.pitchSeats;
      S.state = ev.state;
      paintRoom();
      if (prevFilled !== S.state.players.length) {
        S.pitchSeats = S.state.players.length;
        refreshPitchSoon();
      }
      if (S.state.status === 'playing') {
        S.es.close();
        setHint('牌局已开局 · 正在进入', true);
        setTimeout(() => { location.href = `/play/${S.roomId}`; }, 500);
      } else if (S.state.status === 'ended') {
        setHint('牌局已结束', false);
      }
    } else if (ev.t === 'join') {
      setHint('有人正在入座…', true);
    }
  };
}

/* ---------------- 开局 / 弃桌 ---------------- */

async function startGame() {
  if (S.starting) return;
  S.starting = true;
  paintRoom();
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(S.roomId)}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Host-Token': S.hostToken || '',
      },
      body: JSON.stringify({ hostToken: S.hostToken }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      S.starting = false;
      paintRoom();
      toast(`开局失败 · ${j.error || res.status}`, true);
      return;
    }
    if (S.es) S.es.close();
    location.href = `/play/${S.roomId}`;
  } catch (err) {
    S.starting = false;
    paintRoom();
    toast(`开局失败 · ${err.message}`, true);
  }
}

async function abortRoom() {
  if (!S.hostToken) { toast('只有房主能强制结束', true); return; }
  if (!confirm('强制结束这局？所有玩家立刻停止，牌局无法继续。')) return;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(S.roomId)}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': S.hostToken },
      body: JSON.stringify({ hostToken: S.hostToken, reason: '房主手动结束' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) { toast(`强制结束失败 · ${j.error || res.status}`, true); return; }
    S.state = j.state || S.state;
    toast('已强制结束本局');
    paintRoom();
  } catch (err) {
    toast(`强制结束失败 · ${err.message}`, true);
  }
}

function abandon() {
  if (!confirm('放弃这张牌桌？房间会留在服务端，但你会失去房主令牌。')) return;
  ['token', 'host', 'seats', 'me', 'name'].forEach((k) => {
    try { localStorage.removeItem(`bt.${k}.${S.roomId}`); } catch { /* ignore */ }
  });
  location.href = '/';
}

function paintPitch() {
  const el = $('#join-pitch');
  if (!el) return;
  if (el.dataset.sig === String(S.pitch.length)) return;
  el.dataset.sig = String(S.pitch.length);
  el.textContent = S.pitch || '——';
  const meta = $('#pitch-meta');
  if (meta) {
    const lines = (S.pitch || '').split('\n').length;
    meta.textContent = `规则 · 接入步骤 · 行为约束　|　${S.pitch.length} 字 / ${lines} 行`;
  }
}

/* 席位变了就重新取一份话术（里面的在座人数是动态的） */
let pitchTimer = null;
function refreshPitchSoon() {
  clearTimeout(pitchTimer);
  pitchTimer = setTimeout(async () => {
    if (!S.roomId) return;
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(S.roomId)}/pitch`);
      const j = await r.json();
      if (j.pitch) { S.pitch = j.pitch; paintPitch(); }
    } catch { /* 取不到就沿用旧的 */ }
  }, 400);
}

$('#manual-url').textContent = `${location.origin}/api/manual`;
$('#btn-copy-manual')?.addEventListener('click', async (e) => {
  const ok = await copy(`${location.origin}/api/manual`);
  flash(e.currentTarget, ok ? '已 复 制' : '复 制 失 败');
  if (!ok) toast('复制失败，请手动选中地址', true);
});

/* ---------------- 复制 ---------------- */

$('#btn-copy-url').addEventListener('click', async (e) => {
  const ok = await copy(S.joinUrl);
  flash(e.currentTarget, ok ? '已 复 制' : '复 制 失 败');
  if (!ok) toast('复制失败，请手动选中链接', true);
});

$('#btn-copy-lan')?.addEventListener('click', async (e) => {
  const ok = await copy(S.lanJoinUrl || '');
  flash(e.currentTarget, ok ? '已 复 制' : '复 制 失 败');
  if (!ok) toast('复制失败，请手动选中链接', true);
});

$('#btn-toggle-pitch')?.addEventListener('click', (e) => {
  const el = $('#join-pitch');
  const open = el.classList.toggle('is-open');
  e.currentTarget.textContent = open ? '收 起' : '展 开';
  if (open) el.scrollTop = 0;
});

$('#btn-copy-say').addEventListener('click', async (e) => {
  const text = S.pitch || `打开这个链接，按里面的说明加入牌局并开始行动：${S.joinUrl}`;
  const ok = await copy(text);
  flash(e.currentTarget, ok ? '已 复 制 · 粘给 AI 即可' : '复 制 失 败');
  if (!ok) toast('复制失败，请手动选中话术', true);
});

/* ---------------- 事件绑定 ---------------- */

$('#btn-create').addEventListener('click', createRoom);
$('#input-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createRoom();
});
$('#btn-start').addEventListener('click', startGame);
$('#btn-abandon').addEventListener('click', abandon);
$('#btn-abort-room')?.addEventListener('click', abortRoom);

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { $('#modal-rules').classList.add('open'); return; }
  const close = e.target.closest('[data-close]');
  if (close) { close.closest('.modal').classList.remove('open'); return; }
  if (e.target.classList.contains('modal')) e.target.classList.remove('open');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal.open').forEach((m) => m.classList.remove('open'));
});

/* ---------------- 启动 ---------------- */

(function boot() {
  setSeats(4);
  loadGames();

  const room = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(room)) return;

  // 刷新页面后回到同一张桌：令牌都在本地，能接着等或接着开
  S.roomId = room;
  S.joinUrl = `${location.origin}/join/${room}`;
  S.hostToken = read(`bt.host.${room}`) || null;
  S.humanToken = read(`bt.token.${room}`) || null;
  S.meId = read(`bt.me.${room}`) || null;
  S.seats = Number(read(`bt.seats.${room}`)) || 4;
  store('bt.game', read(`bt.game.${room}`) || 'bomb-table');
  const name = read(`bt.name.${room}`);
  if (name) $('#input-name').value = name;

  showRoom();
  connect();
})();
