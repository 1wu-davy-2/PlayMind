/* ============================================================
   BOMB TABLE — 牌桌：SSE 渲染 / 决策面板 / 监听记录
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const CARD = {
  bomb:     { label: '炸弹', glyph: '爆', cls: 'danger' },
  question: { label: '质询', glyph: '审', cls: 'warn' },
  safe:     { label: '安全', glyph: '安', cls: 'calm' },
  supply:   { label: '补给', glyph: '补', cls: 'good' },
};
const ITEM = {
  defuse: { label: '拆弹钳', glyph: '钳', cls: 'defuse' },
  xray:   { label: '透视镜', glyph: '镜', cls: 'xray' },
  swap:   { label: '换手牌', glyph: '换', cls: 'swap' },
};
const KIND_CN = { human: '人类玩家', agent: '外部 AGENT', bot: '内置 BOT' };
const ASK_CN = {
  draw: '抽牌', defuse: '拆弹', 'pick-target': '指定受审', answer: '回答质询',
  verdict: '裁决', vote: '停战投票', free: '自由决策', declare: '宣称',
  confirm: '确认', 'multi-pick': '多选', bet: '下注', 'play-card': '出牌', challenge: '质疑',
};

const S = {
  roomId: '',
  token: '',
  meId: '',
  you: null,
  state: null,
  ask: null,
  askId: '',
  askTotals: {},
  secret: null,
  sayDraft: '',
  says: {},
  lastSay: null,
  busy: false,
  fetching: false,
  selfBusy: false,
  fetchTimer: 0,
  ended: false,
  es: null,
  thoughts: new Map(),
};

/* ---------------- 工具 ---------------- */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pad2 = (n) => String(n).padStart(2, '0');

const players = () => S.state?.players || [];
const playerOf = (id) => players().find((p) => p.id === id) || null;
const mePlayer = () => {
  if (!S.meId) return null;
  return playerOf(S.meId) || (S.you ? { ...S.you } : null);
};
const nameOf = (id) => playerOf(id)?.name || (id === S.meId ? S.you?.name : '') || '？';

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

let toastTimer = 0;
function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast show ${bad ? 'toast--bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2000);
}

async function copy(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 退回 execCommand */ }
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

function parseRoom() {
  const m = location.pathname.match(/\/play\/([A-Za-z0-9]+)/);
  if (m) return m[1].toUpperCase();
  const q = (new URLSearchParams(location.search).get('room') || '').trim();
  return q.toUpperCase();
}

/* ---------------- 顶栏 / 焦点 / 印章 ---------------- */

function setMode(live, text) {
  const el = $('#mode');
  el.classList.toggle('is-live', !!live);
  $('#mode-text').textContent = text;
}

function focusText(kicker, html) {
  $('#focus').innerHTML = `<div class="focus__kicker">${esc(kicker)}</div><div class="focus__text">${html}</div>`;
}

function stamp(text) {
  const el = $('#stamp');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

/* ---------------- 渲染 ---------------- */

function pips(hp, max) {
  let out = '';
  for (let i = 0; i < max; i += 1) out += `<span class="pip ${i < hp ? 'is-on' : ''}"></span>`;
  return out;
}

function itemsHTML(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((k) => {
    const it = ITEM[k];
    if (!it) return '';
    return `<span class="item item--${it.cls}" title="${it.label}">${it.glyph}</span>`;
  }).join('');
}

function sayOf(p) {
  if (p && p.says != null) return p.says;
  return S.says[p?.id] || '';
}

/* 品牌徽章：优先用 AI 自报型号，avatarUrl 由 brands.js 自带回退 */
function avatarOf(p, size = 22) {
  const B = window.BombBrands;
  if (B && p.kind !== 'human' && typeof B.avatarHTML === 'function') {
    return `<span class="seat__avatar">${B.avatarHTML(p, size)}</span>`;
  }
  return `<span class="seat__glyph">${esc(p.glyph || (p.kind === 'human' ? '★' : '·'))}</span>`;
}

function modelOf(p) {
  const B = window.BombBrands;
  if (p.kind === 'human') return '人类玩家';
  if (p.kind === 'bot') return '内置代打 · 无模型';
  if (!p.model) return '未上报型号';
  return B && typeof B.modelLabel === 'function' ? B.modelLabel(p.model) : esc(p.model);
}

function seatHTML(p, st) {
  const cur = st.turnPlayerId === p.id && !st.winner;
  const asking = st.askPlayerId === p.id;
  const isMe = p.id === S.meId;
  const cls = [
    'seat',
    p.kind === 'human' ? 'seat--human' : '',
    cur ? 'is-current' : '',
    asking && !cur ? 'is-ask' : '',
    p.alive === false ? 'is-dead' : '',
  ].filter(Boolean).join(' ');

  const kind = KIND_CN[p.kind] || p.kind || '';
  const offline = p.connected === false ? ' · <span class="off">离线</span>' : '';
  const say = sayOf(p);

  return `<div class="${cls}" data-id="${esc(p.id)}">
    ${p.caught > 0 ? `<span class="seat__badge">撒谎被抓 ${p.caught}</span>` : ''}
    <div class="seat__top">
      ${avatarOf(p, 22)}
      <span class="seat__name">${esc(p.name)}</span>
      ${isMe ? '<span class="seat__you">你</span>' : ''}
    </div>
    <div class="seat__title">${esc(kind)}${offline}</div>
    <div class="seat__model" title="${esc(modelOf(p))}">${esc(modelOf(p))}</div>
    <div class="seat__hp">${pips(p.hp, p.maxHp || 4)}</div>
    <div class="seat__items">${itemsHTML(p.items)}</div>
    ${say ? `<div class="seat__say">「${esc(say)}」</div>` : ''}
  </div>`;
}

function meHTML(p, st) {
  const cur = st.turnPlayerId === p.id && !st.winner;
  const asking = st.askPlayerId === p.id;
  const alive = st.players.filter((x) => x.alive !== false).length;
  const say = sayOf(p);
  const cls = ['seat', 'seat--human', cur ? 'is-current' : '', asking && !cur ? 'is-ask' : '', p.alive === false ? 'is-dead' : '']
    .filter(Boolean).join(' ');

  return `<div class="${cls}" data-id="${esc(p.id)}">
    <div>
      <div class="seat__top">
        ${avatarOf(p, 22)}
        <span class="seat__name">${esc(p.name)}</span>
        <span class="seat__you" style="margin-left:8px">你</span>
      </div>
      <div class="seat__model" title="${esc(modelOf(p))}">${esc(modelOf(p))}</div>
      <div class="seat__hp">${pips(p.hp, p.maxHp || 4)}</div>
    </div>
    <div class="me__right">
      <div class="seat__items">${itemsHTML(p.items)}</div>
      <div class="seat__title">在场 ${alive} / ${st.players.length}${p.connected === false ? ' · <span class="off">离线</span>' : ''}</div>
    </div>
    ${say ? `<div class="seat__say">「${esc(say)}」</div>` : ''}
  </div>`;
}

function paintStats() {
  const st = S.state;
  const alive = st.players.filter((p) => p.alive !== false).length;
  $('#statline').innerHTML = `
    <div class="stat"><span class="stat__k">ROUND 轮次</span><span class="stat__v">${pad2(st.round || 0)}</span></div>
    <div class="stat"><span class="stat__k">DECK 牌堆</span><span class="stat__v">${pad2(st.deckLeft || 0)}</span></div>
    <div class="stat"><span class="stat__k">BOMBS 炸弹</span><span class="stat__v"><em>${pad2(st.bombsLeft || 0)}</em></span></div>
    <div class="stat"><span class="stat__k">ALIVE 在场</span><span class="stat__v">${alive}<i> / ${st.players.length}</i></span></div>`;
}

function paintSeats() {
  if (!S.state) return;
  const st = S.state;
  const mine = S.meId;
  const opps = mine ? st.players.filter((p) => p.id !== mine) : st.players;
  $('#seats').innerHTML = opps.map((p) => seatHTML(p, st)).join('');
}

function paintMe() {
  if (!S.state) return;
  const st = S.state;
  const me = S.meId ? st.players.find((p) => p.id === S.meId) : null;
  $('#me').innerHTML = me ? meHTML(me, st) : '';
}

function paintDeck() {
  const st = S.state;
  const n = Math.min(3, Math.max(0, st.deckLeft || 0));
  $('#deck').innerHTML = n
    ? Array.from({ length: n }, () => '<div class="deck__card"></div>').join('')
    : '<div class="deck__empty">EMPTY</div>';

  const left = st.deckLeft || 0;
  const bombs = st.bombsLeft || 0;
  const pct = left ? Math.round((bombs / left) * 100) : 0;
  $('#deckmeta').innerHTML = `剩 <b>${left}</b> 张<br><span class="bomb">炸弹 ${bombs}</span> · ${pct}%`;
}

/* ---------------- 侧栏：牌堆构成 / 审讯状态 ---------------- */

function sideClockText(dl) {
  if (!dl) return '—';
  const left = Math.max(0, Math.ceil((dl - Date.now()) / 1000));
  return left > 0 ? `${pad2(Math.floor(left / 60))}:${pad2(left % 60)}` : '00:00';
}

// 只改右栏时钟文本，复用 updateClock 的 250ms 常驻 ticker，不另起 interval
function paintSideClock() {
  const el = $('#side-clock');
  if (el) el.textContent = sideClockText(S.state?.askDeadline);
}

function lastSayOf(st) {
  if (S.lastSay) return S.lastSay;
  const withSay = (st.players || []).filter((p) => sayOf(p));
  const p = withSay[withSay.length - 1];
  return p ? { name: p.name, text: sayOf(p) } : null;
}

function paintSides(st) {
  const left = st.deckLeft || 0;
  const bombs = st.bombsLeft || 0;
  const pct = left ? Math.round((bombs / left) * 100) : 0;

  const tiles = [
    { glyph: '爆', n: 7, cls: 'danger', t: '炸弹' },
    { glyph: '审', n: 8, cls: 'warn',   t: '质询' },
    { glyph: '安', n: 7, cls: 'calm',   t: '安全' },
    { glyph: '补', n: 4, cls: 'good',   t: '补给' },
  ].map((c) => `<span class="tile tile--${c.cls}" title="${c.t}"><b>${c.glyph}</b><i>${c.n}</i></span>`).join('');

  const leftEl = $('#side-left');
  if (leftEl) leftEl.innerHTML = `
    <div class="sidel__k">档 案 · A / 牌 堆 构 成</div>
    <div class="sidel__h">一副牌 · 贰拾陆张</div>
    <div class="sidel__tiles">${tiles}</div>
    <div class="sidel__lbl">当前炸弹概率 <b>${pct}%</b></div>
    <div class="sidel__bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
    <div class="sidel__row">DECK ${pad2(left)} · BOMBS ${pad2(bombs)}</div>`;

  const whoId = st.askPlayerId;
  const who = whoId ? nameOf(whoId) : '';
  const kindCn = ASK_CN[st.askKind] || (st.askKind ? esc(st.askKind) : '');
  const say = lastSayOf(st);
  const rightEl = $('#side-right');
  if (rightEl) rightEl.innerHTML = `
    <div class="sidel__k">档 案 · B / 审 讯 状 态</div>
    <div class="sidel__h">当前进程</div>
    <div class="sidel__kv"><span>在思考</span><b>${who ? esc(who) : '—'}</b></div>
    <div class="sidel__kv"><span>待决策</span><b>${kindCn || '—'}</b></div>
    <div class="sidel__kv"><span>倒计时</span><b class="sidel__clock" id="side-clock">${sideClockText(st.askDeadline)}</b></div>
    <div class="sidel__say">${say ? `「${esc(say.text)}」<span>— ${esc(say.name)}</span>` : '<span class="sidel__muted">暂无发言记录</span>'}</div>`;
}

function paint() {
  const st = S.state;
  if (!st) return;
  paintStats();
  paintSeats();
  paintMe();
  paintDeck();
  paintSides(st);

  if (st.status === 'lobby') {
    focusText('等 待', '牌局还没开始 —— 回大厅把席位坐满。');
  } else if (st.status === 'ended') {
    const wid = typeof st.winner === 'object' && st.winner ? st.winner.id : st.winner;
    focusText('结 束', `<em>${esc(nameOf(wid))}</em> 是最后站着的人`);
  }
}

/* ---------------- 监听记录 ---------------- */

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
}

function appendEntry(html, cls = '') {
  const body = $('#wire');
  const near = nearBottom(body);
  const el = document.createElement('div');
  el.className = `entry ${cls}`;
  el.innerHTML = html;
  body.appendChild(el);
  if (near) body.scrollTop = body.scrollHeight;
  return el;
}

function whoHead(id, tag) {
  const p = playerOf(id);
  const av = p && p.kind !== 'human' && window.BombBrands
    ? `<span class="entry__avatar">${window.BombBrands.avatarHTML(p, 15)}</span>` : '';
  return `<div class="entry__head">${av}<span class="entry__who">${esc(nameOf(id))}</span><span class="entry__tag">${esc(tag)}</span></div>`;
}

function systemEntry(html, cls = 'entry--system') {
  appendEntry(`<div class="entry__head"><span class="entry__tag">记录</span></div><div class="entry__body">${html}</div>`, cls);
}

function flushThought(t) {
  if (t.raf) return;
  const step = () => {
    t.raf = 0;
    if (!t.queue) return;
    const n = Math.max(1, Math.ceil(t.queue.length / 20));
    t.body.textContent += t.queue.slice(0, n);
    t.queue = t.queue.slice(n);
    const body = $('#wire');
    if (nearBottom(body)) body.scrollTop = body.scrollHeight;
    if (t.queue) t.raf = requestAnimationFrame(step);
  };
  t.raf = requestAnimationFrame(step);
}

function onThought(id, delta) {
  if (!id || !delta) return;
  let t = S.thoughts.get(id);
  if (!t) {
    const el = appendEntry(`${whoHead(id, '思考')}<div class="entry__body caret"></div>`, 'entry--thought');
    t = { el, body: el.querySelector('.entry__body'), queue: '', raf: 0 };
    S.thoughts.set(id, t);
    $('#wirefoot').textContent = `${nameOf(id)} 正在思考`;
  }
  t.queue += String(delta);
  flushThought(t);
}

function endThought(id) {
  const t = S.thoughts.get(id);
  if (!t) return;
  t.body.classList.remove('caret');
  S.thoughts.delete(id);
  $('#wirefoot').textContent = '思考链实时投屏';
}

/* ---------------- SSE 事件 ---------------- */

function onEvent(ev) {
  switch (ev.t) {
    case 'state':
      onState(ev.state);
      break;

    case 'begin':
      $('#wire').innerHTML = '';
      S.thoughts.clear();
      appendEntry('<div class="entry__head"><span class="entry__tag">开局</span></div><div class="entry__body">牌堆已洗好。顺序在你们坐下之前就定了。</div>', 'entry--system');
      stamp('开 局');
      break;

    case 'turn': {
      const p = playerOf(ev.playerId);
      focusText('轮 到', `<em>${esc(p?.name || '？')}</em> 抽牌`);
      break;
    }

    case 'draw': {
      const p = playerOf(ev.playerId);
      const c = CARD[ev.card] || CARD.safe;
      const el = $('#played');
      el.innerHTML = `<div class="card card--${c.cls}">
        <span class="card__idx">${pad2(ev.deckLeft ?? 0)}</span>
        <span class="card__glyph">${c.glyph}</span>
        <span class="card__name">${c.label}</span>
      </div>`;
      focusText(ev.chained ? '验 证 抽 牌' : '抽 牌', `<em>${esc(p?.name || '？')}</em> 抽到 <s>${c.label}</s>`);
      appendEntry(`<div class="entry__head"><span class="entry__tag">抽牌</span><span>${esc(p?.name || '？')}</span></div><div class="entry__body">抽到「${c.label}」，牌堆还剩 ${ev.deckLeft ?? '?'} 张。</div>`, 'entry--system');
      if (ev.card === 'bomb') stamp('炸 弹');
      break;
    }

    case 'resolve':
      if (ev.text) focusText('结 算', esc(ev.text));
      break;

    case 'target': {
      const a = nameOf(ev.drawerId);
      const b = nameOf(ev.targetId);
      focusText('指 定 受 审', `<em>${esc(a)}</em> 点名 <em>${esc(b)}</em>`);
      systemEntry(`${esc(a)} 指定 ${esc(b)} 受审。<br>受审者已单独看到牌堆顶那张牌 —— 只有他知道。`);
      break;
    }

    case 'intel': {
      const pid = ev.playerId || ev.targetId;
      const list = ev.cards || (ev.card ? [ev.card] : []);
      const labels = list.map((c) => CARD[c]?.label || '?').join(' / ');
      if (pid && pid === S.meId) {
        if (!ev.cards && ev.card) S.secret = ev.card;
        appendEntry(`<div class="entry__head"><span class="entry__tag">私密 · 仅你可见</span></div><div class="entry__body">${ev.cards ? '透视镜：牌堆顶两张是' : '系统只给你看：牌堆顶是'}「${esc(labels)}」。<br>别人不知道你看到了什么。</div>`, 'entry--reveal');
        renderPanel();
      } else if (pid) {
        systemEntry(`${esc(nameOf(pid))} 拿到了牌堆顶的情报。没有人知道那是什么，除了他。`);
      }
      break;
    }

    case 'thought':
      onThought(ev.playerId, ev.delta != null ? ev.delta : ev.text);
      break;

    case 'thought-end':
      endThought(ev.playerId);
      break;

    case 'say': {
      const text = ev.text != null ? ev.text : ev.say;
      if (!text) break;
      S.says[ev.playerId] = text;
      S.lastSay = { name: nameOf(ev.playerId), text };
      paintSeats();
      paintMe();
      if (S.state) paintSides(S.state);
      appendEntry(`${whoHead(ev.playerId, '开口')}<div class="entry__body">「${esc(text)}」</div>`, 'entry--say');
      focusText('他 说', `<em>${esc(nameOf(ev.playerId))}</em>「${esc(text)}」`);
      break;
    }

    case 'verdict': {
      const a = nameOf(ev.drawerId || ev.playerId);
      const accuse = ev.decision === 'accuse';
      focusText('裁 决', `<em>${esc(a)}</em> ${accuse ? '当场指控' : '选择相信'}`);
      break;
    }

    case 'truth': {
      const actual = CARD[ev.actualCard || ev.card]?.label || '?';
      const claim = (ev.claim === 'bomb') ? '是炸弹' : '不是炸弹';
      const lied = !!ev.lied;
      appendEntry(`
        ${whoHead(ev.targetId, '揭 秘')}
        <div class="reveal">
          <span class="reveal__k">他声称</span><span class="reveal__v">${claim}</span>
          <span class="reveal__k">牌堆顶</span><span class="reveal__v">${actual}</span>
          <span class="reveal__k">判定</span><span class="reveal__v ${lied ? 'bad' : 'good'}">${lied ? '撒 谎' : '诚 实'}</span>
        </div>
        ${ev.note ? `<div class="reveal__note">真实想法：${esc(ev.note)}</div>` : ''}
      `, 'entry--reveal');
      stamp(lied ? '说 谎' : '诚 实');
      break;
    }

    case 'defused':
      stamp('拆 弹');
      systemEntry(`${esc(nameOf(ev.playerId))} 用拆弹钳剪断了引信。`);
      break;

    case 'damage': {
      const hp = ev.hp != null ? `剩 ${ev.hp} 点命` : '';
      stamp(ev.cause === 'bomb' ? '爆 炸' : '扣 血');
      const hurt = playerOf(ev.playerId);
      if (hurt && ev.hp != null) hurt.hp = ev.hp;
      paintSeats();
      paintMe();
      if (ev.playerId) systemEntry(`${esc(nameOf(ev.playerId))} 掉了 1 点命${hp ? ` · ${esc(hp)}` : ''}。`, 'entry--reveal');
      break;
    }

    case 'caught':
      systemEntry(`${esc(nameOf(ev.targetId))} 撒谎被当场抓住，掉 1 点命。<br>${esc(nameOf(ev.drawerId))} 顺手拿走一个拆弹钳。`, 'entry--reveal');
      break;

    case 'wrong':
      systemEntry(`${esc(nameOf(ev.drawerId))} 冤枉了好人 —— 他说的确实是真的。反噬 1 点命。`, 'entry--reveal');
      break;

    case 'eliminate':
      stamp('出 局');
      systemEntry(`<b>${esc(nameOf(ev.playerId))}</b> 生命归零，离开牌桌。`, 'entry--reveal');
      break;

    case 'timeout': {
      appendEntry(`<div class="entry__head"><span class="entry__tag">超时</span><span>${esc(nameOf(ev.playerId))}</span></div><div class="entry__body">⏱ 超时 · 系统代打</div>`, 'entry--timeout');
      break;
    }

    case 'join':
      if (ev.playerId || ev.name) {
        systemEntry(`${esc(ev.name || nameOf(ev.playerId))} 接入牌桌。`);
      }
      break;

    case 'leave':
      if (ev.playerId) systemEntry(`${esc(nameOf(ev.playerId))} 断开了连接。`);
      break;

    case 'vote-start':
      showVote(ev);
      break;

    case 'vote-cast':
      castVote(ev);
      break;

    case 'vote-result':
      resultVote(ev);
      break;

    case 'vote-skip':
      skipVote(ev);
      break;

    case 'settle':
      stamp('停 战');
      break;

    case 'end':
      showOver(ev);
      break;

    case 'error':
      if (ev.message) systemEntry(`异常：${esc(ev.message)}`, 'entry--reveal');
      break;

    default:
      break;
  }
}

function onState(st) {
  if (!st) return;
  S.state = st;

  if (S.you) {
    const fresh = st.players?.find((p) => p.id === S.meId);
    if (fresh) S.you = { ...S.you, ...fresh, secret: S.you.secret };
  }

  paint();

  if (!S.meId) {
    if (S.token) { /* 令牌还没验证完，等 fetchSelf */ } else setMode(true, '观战中');
  } else if (st.askPlayerId === S.meId) {
    queueFetchAsk();
  } else if (S.ask) {
    S.ask = null;
    renderPanel();
  }

  renderPanel();
  if (st.status === 'ended' && st.winner && !S.ended) setTimeout(showOverFromState, 900);
}

/* ---------------- 轮询自己的 ask ---------------- */

function applySelf(j) {
  if (j.you) {
    S.you = j.you;
    if (!S.meId) S.meId = j.you.id;
    S.secret = j.you.secret?.topCard || S.secret;
  }
  if (j.state) S.state = j.state;
  S.ask = j.ask || null;
  paint();
  renderPanel();
}

async function fetchSelf() {
  if (!S.token || S.selfBusy) return;
  const url = `/api/agent/${encodeURIComponent(S.roomId)}/${encodeURIComponent(S.token)}`;
  S.selfBusy = true;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 404 || r.status === 401 || r.status === 403) {
        S.token = '';
        S.meId = '';
        setMode(true, '观战中');
        systemEntry('令牌无效或房间已结束 —— 你已转入观战模式。', 'entry--reveal');
        renderPanel();
      }
      return;
    }
    applySelf(j);
    setMode(true, '已接入');
  } catch {
    setMode(false, '重连中');
  } finally {
    S.selfBusy = false;
  }
}

function queueFetchAsk() {
  clearTimeout(S.fetchTimer);
  S.fetchTimer = setTimeout(fetchAsk, 220);
}

async function fetchAsk() {
  if (!S.token || S.fetching || S.busy) return;
  S.fetching = true;
  try {
    const url = `/api/agent/${encodeURIComponent(S.roomId)}/${encodeURIComponent(S.token)}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return;
    const j = await r.json().catch(() => ({}));
    applySelf(j);
  } catch { /* SSE 会再来一次 */ } finally {
    S.fetching = false;
  }
}

/* ---------------- 操作栏 ---------------- */

function barIdle(html) {
  clearTicker();
  $('#actionbar').innerHTML = `<div class="actionbar__idle"><span class="dots"></span><span>${html}</span></div>`;
}
/* 等别人决策：带秒数倒计时，让"卡住"变得可解释 */
function barWaiting(name, deadline) {
  clearTicker();
  const tick = () => {
    const left = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
    $('#actionbar').innerHTML = left === null
      ? `<div class="actionbar__idle"><span class="dots"></span><b>${esc(name)}</b> 正在想怎么走…</div>`
      : `<div class="actionbar__idle"><span class="dots"></span><b>${esc(name)}</b> 正在决策 · <em class="cd">${left}s</em> 后系统代打</div>`;
  };
  tick();
  if (deadline) S.ticker = setInterval(tick, 1000);
}

function clearTicker() {
  if (S.ticker) { clearInterval(S.ticker); S.ticker = null; }
}


function barBusy(text) {
  $('#actionbar').innerHTML = `<div class="actionbar__idle"><span class="dots"></span><span>${esc(text)}</span></div>`;
}

function barPrompt(kicker, questionHTML, optsHTML, extraHTML, deadline) {
  const clock = deadline
    ? `<span class="clock" id="clock">⏱ <b>--:--</b></span>`
    : '';
  $('#actionbar').innerHTML = `
    <div class="prompt">
      ${deadline ? '<div class="prompt__timer"><i id="timerbar"></i></div>' : ''}
      <div class="prompt__q"><span class="k">${esc(kicker)}</span><span>${questionHTML}</span>${clock}</div>
      ${extraHTML || ''}
      <div class="prompt__opts">${optsHTML}</div>
    </div>`;

  $$('#actionbar .opt').forEach((el, i) => {
    if (i > 8) return;
    const n = document.createElement('span');
    n.className = 'opt__num';
    n.textContent = String(i + 1);
    el.insertBefore(n, el.firstChild);
  });

  const inp = $('#say-input');
  if (inp) {
    inp.value = S.sayDraft;
    inp.addEventListener('input', () => { S.sayDraft = inp.value; });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  updateClock();
}

function renderPanel() {
  const st = S.state;
  const me = mePlayer();

  if (st?.status === 'ended') { barIdle('牌局已结束'); return; }

  if (!S.token) { barIdle('观战模式 · 你不是这局的玩家'); return; }
  if (!me) { barIdle('正在接入牌桌…'); return; }
  if (me.alive === false) { barIdle('你已出局 · 观战中'); return; }

  const ask = S.ask;
  if (!ask) {
    const who = st?.askPlayerId ? playerOf(st.askPlayerId) : null;
    if (who && who.id !== S.meId) barWaiting(who.name, st?.askDeadline);
    else if (st?.turnPlayerId) barIdle(`轮到 <b>${esc(nameOf(st.turnPlayerId))}</b>`);
    else barIdle('等待牌桌推进…');
    return;
  }

  if (ask.playerId && ask.playerId !== S.meId) {
    barWaiting(nameOf(ask.playerId), ask.deadline || st?.askDeadline);
    return;
  }

  if (ask.id && ask.id !== S.askId) {
    S.askId = ask.id;
    S.sayDraft = '';
    if (ask.kind !== 'answer') S.secret = null;
    if (ask.deadline) S.askTotals[ask.id] = Math.max(1000, ask.deadline - Date.now());
  }

  // 状态事件可能在打字时到达；输入框有焦点就保留现有面板，避免吞字
  const key = [ask.id, ask.kind, me.hp, (me.items || []).join(','), st.deckLeft, st.bombsLeft,
    (ask.payload?.candidates || []).join(',')].join('|');
  const active = document.activeElement;
  if (active && active.id === 'say-input' && S.panelKey === key) return;
  S.panelKey = key;

  switch (ask.kind) {
    case 'draw':        return panelDraw(ask, me);
    case 'defuse':      return panelDefuse(ask);
    case 'pick-target': return panelPick(ask);
    case 'answer':      return panelAnswer(ask);
    case 'verdict':     return panelVerdict(ask);
    case 'vote':        return panelVote(ask);
    default:            return barIdle('等待你的决定…');
  }
}

/* ---------------- 停战投票 ---------------- */

function voteChip(p, state) {
  const mark = state === true ? '✓' : state === false ? '✕' : '·';
  const cls = state === true ? 'is-yes' : state === false ? 'is-no' : 'is-wait';
  return `<span class="vchip ${cls}" data-vid="${esc(p.id)}">
    <b>${esc(p.name)}</b><span class="vchip__hp">${p.hp}</span><i>${mark}</i>
  </span>`;
}

function showVote(ev) {
  const p = ev.proposal || {};
  const box = $('#vote');
  if (!box) return;
  box.hidden = false;
  box.classList.remove('is-pass', 'is-fail');
  $('#vote-title').textContent = '牌堆已经打完一副';
  $('#vote-body').innerHTML =
    `接受 → <em>${esc(p.leaderName || '?')}</em>（${p.topHp} 点血）直接获胜<br>` +
    `通过门槛 <b>${p.threshold}/${p.aliveCount}</b> 票${p.aliveCount === 2 ? '（两人局必须全票）' : '（三分之二多数）'}`;
  $('#vote-tally').innerHTML = (ev.alive || []).map((x) => voteChip(x, null)).join('');
  $('#vote-foot').textContent = '正在收票…';
}

function castVote(ev) {
  const chip = document.querySelector(`.vchip[data-vid="${ev.playerId}"]`);
  if (chip) {
    chip.classList.remove('is-wait', 'is-yes', 'is-no');
    chip.classList.add(ev.accept ? 'is-yes' : 'is-no');
    chip.querySelector('i').textContent = ev.accept ? '✓' : '✕';
  }
  const foot = $('#vote-foot');
  if (foot) foot.textContent = `已收 ${ev.cast}/${ev.total} 票 · 同意 ${ev.yes}`;
}

function resultVote(ev) {
  const box = $('#vote');
  if (!box) return;
  box.classList.add(ev.passed ? 'is-pass' : 'is-fail');
  $('#vote-title').textContent = ev.passed ? '停战通过' : '停战被否决';
  $('#vote-foot').innerHTML = ev.passed
    ? `${ev.yes}/${ev.total} 票同意 · <em>${esc(ev.leaderName)}</em> 以 ${ev.total ? '' : ''}血量最高获胜`
    : `${ev.yes} 票同意 / ${ev.no} 票反对，未达 ${ev.threshold} 票 · 重洗再发`;
  setTimeout(() => { if (box && !box.dataset.keep) box.hidden = true; }, ev.passed ? 4200 : 3200);
}

function skipVote(ev) {
  const box = $('#vote');
  if (!box) return;
  box.hidden = false;
  box.classList.remove('is-pass', 'is-fail');
  $('#vote-title').textContent = ev.reason === 'tie' ? '最高血量并列' : '已经投过三次';
  $('#vote-body').innerHTML = ev.reason === 'tie'
    ? `${esc((ev.names || []).join('、'))} 都是 ${ev.topHp} 点血 —— 停战裁不出唯一胜者。`
    : '这一局不再发起停战表决，直接把牌洗回来。';
  $('#vote-tally').innerHTML = '';
  $('#vote-foot').textContent = '重洗再发';
  setTimeout(() => { box.hidden = true; }, 2600);
}

function panelVote(ask) {
  const p = ask.payload || {};
  const me = playerOf(S.meId);
  const myHp = me ? me.hp : 0;
  const gap = (p.topHp ?? 0) - myHp;
  const lead = gap <= 0
    ? `你就是血最多的那个（${myHp} 点）——收手你就赢。`
    : `领先你的是 <em>${esc(p.leaderName || '?')}</em>（${p.topHp} 点），你差 ${gap} 点。`;

  barPrompt('停 战 投 票',
    `一副牌打完了。${lead} 要通过需要 <em>${p.threshold}/${p.aliveCount}</em> 票。`, `
    <button class="opt opt--go" data-act="vote" data-accept="1">接 受 收 手<span class="k">血最多者胜</span></button>
    <button class="opt opt--danger" data-act="vote" data-accept="0">继 续 战 斗<span class="k">重洗再发</span></button>`, '', ask.deadline);
}

function panelDraw(ask, me) {
  const st = S.state;
  const left = st.deckLeft || 0;
  const bombs = st.bombsLeft || 0;
  const rate = left ? Math.round((bombs / left) * 100) : 0;
  const items = me.items || [];

  const opts = [`<button class="opt opt--go" data-act="draw">抽 牌<span class="k">牌堆 ${left} · 炸弹 ${bombs} · ${rate}%</span></button>`];

  if (items.includes('xray')) {
    opts.push('<button class="opt" data-act="use" data-item="xray">透 视 镜<span class="k">看顶两张</span></button>');
  }
  if (items.includes('swap')) {
    st.players
      .filter((p) => p.alive !== false && p.id !== S.meId)
      .forEach((p) => {
        opts.push(`<button class="opt opt--quiet" data-act="use" data-item="swap" data-target="${esc(p.id)}">换 手 → ${esc(p.name)}<span class="k">${p.hp} 血</span></button>`);
      });
  }

  barPrompt('你 的 回 合', `牌堆剩 <em>${left}</em> 张 · 炸弹 <em>${bombs}</em> 张 · 命中 <em>${rate}%</em>`, opts.join(''), '', ask.deadline);
}

function panelDefuse(ask) {
  barPrompt('炸 弹', '抽到了炸弹。<em>用拆弹钳</em>，还是硬吃这一下？', `
    <button class="opt opt--go" data-act="defuse" data-use="1">用 拆 弹 钳<span class="k">免伤</span></button>
    <button class="opt opt--danger" data-act="defuse" data-use="0">硬 吃<span class="k">−1 血</span></button>`, '', ask.deadline);
}

function panelPick(ask) {
  let cands = ask.payload?.candidates || [];
  if (!cands.length) {
    cands = players().filter((p) => p.alive !== false && p.id !== S.meId).map((p) => p.id);
  }
  const opts = cands.map((id) => {
    const p = playerOf(id);
    return `<button class="opt" data-act="pick" data-target="${esc(id)}">${esc(p?.name || id)}<span class="k">${p ? p.hp : '?'} 血 · 被抓撒谎 ${p ? p.caught || 0 : 0} 次</span></button>`;
  }).join('');

  barPrompt('质 询', '你抽到了质询牌。<em>指定一个人受审</em> —— 他会看到下一张牌，然后回答你。', opts || '<span class="spectate-note">没有可审的人</span>', '', ask.deadline);
}

function panelAnswer(ask) {
  const top = S.you?.secret?.topCard || S.secret || null;
  const drawerId = ask.payload?.drawerId;
  const drawer = ask.payload?.drawerName || nameOf(drawerId);
  const isBomb = top === 'bomb';

  const intel = top
    ? `<div class="intel">
        <span class="intel__k">只有你能看到</span>
        <span class="intel__card card--${CARD[top]?.cls || 'calm'}"><b>${CARD[top]?.glyph || '?'}</b>${CARD[top]?.label || top}</span>
        <span class="intel__q">${esc(drawer)} 问你：下一张，是炸弹吗？</span>
      </div>`
    : `<div class="intel">
        <span class="intel__k">只有你能看到</span>
        <span class="intel__q">情报还没有送到 —— 凭直觉答，或者说谎。</span>
      </div>`;

  const markBomb = top ? (isBomb ? '<span class="truthy truthy--true">真话</span>' : '<span class="truthy truthy--lie">谎话</span>') : '';
  const markSafe = top ? (isBomb ? '<span class="truthy truthy--lie">谎话</span>' : '<span class="truthy truthy--true">真话</span>') : '';

  const opts = `
    <button class="opt opt--go" data-act="answer" data-claim="bomb">说「是炸弹」${markBomb}</button>
    <button class="opt opt--go" data-act="answer" data-claim="safe">说「不是」${markSafe}</button>
    <div class="say-row">
      <input id="say-input" class="say-input" maxlength="80" autocomplete="off"
        placeholder="加一句原话（可选）—— 他只能听到这句">
    </div>`;

  barPrompt('你 被 点 名', '轮到你回答。他信不信，取决于你怎么说。', opts, intel, ask.deadline);
}

function panelVerdict(ask) {
  const p = ask.payload || {};
  const target = p.targetName || nameOf(p.targetId);
  const claim = p.claim === 'bomb' ? '「是炸弹」' : '「不是」';
  const quote = p.say || S.says[p.targetId] || '';
  const extra = quote
    ? `<div class="intel"><span class="intel__k">对方原话</span><span class="intel__q">「${esc(quote)}」</span></div>`
    : '';

  barPrompt('裁 决', `<em>${esc(target)}</em> 说 ${claim}。你信吗？`, `
    <button class="opt opt--go" data-act="verdict" data-decision="trust">相 信<span class="k">自己抽下一张</span></button>
    <button class="opt opt--danger" data-act="verdict" data-decision="accuse">指 控<span class="k">当场验真</span></button>`, extra, ask.deadline);
}

/* ---------------- 倒计时 ---------------- */

function updateClock() {
  paintSideClock();
  const ask = S.ask;
  const clock = $('#clock');
  const bar = $('#timerbar');
  if (!ask || !ask.deadline || !clock) return;

  const left = Math.max(0, ask.deadline - Date.now());
  const total = S.askTotals[ask.id] || 120000;
  const sec = Math.ceil(left / 1000);
  clock.innerHTML = `⏱ <b>${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}</b>`;
  clock.classList.toggle('is-low', left < 15000);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
  if (left <= 0) clock.innerHTML = '⏱ <b>超时</b> · 系统代打';
}

/* ---------------- 提交 ---------------- */

async function submit(action) {
  if (S.busy || !S.ask) return;
  const say = (S.sayDraft || '').trim();
  const body = { action };
  if (say && (S.ask.kind === 'answer' || S.ask.kind === 'verdict')) body.say = say;

  S.busy = true;
  barBusy('正在上报…');
  try {
    const url = `/api/agent/${encodeURIComponent(S.roomId)}/${encodeURIComponent(S.token)}/act`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false || j.accepted === false) {
      S.busy = false;
      toast(j.error || '这一手不被接受', true);
      renderPanel();
      return;
    }
    S.ask = null;
    S.sayDraft = '';
    S.busy = false;
    setMode(true, '已接入');
    barIdle('已上报 · 等待牌桌回应…');
  } catch (err) {
    S.busy = false;
    toast(`上报失败 · ${err.message}`, true);
    renderPanel();
  }
}

/* ---------------- 结算 ---------------- */

function showOver(ev) {
  if (S.ended && $('#over').classList.contains('open')) return;
  S.ended = true;
  const st = S.state;
  const me = mePlayer();
  const win = ev.winnerId && ev.winnerId === S.meId;

  $('#over-title').textContent = win ? '你 活 下 来 了' : `${ev.winnerName || nameOf(ev.winnerId)} 赢 了`;
  $('#over-sub').textContent = win
    ? '所有人坐下，只有你站起来。'
    : (me && me.alive === false
      ? '你出局了。牌桌没有停，一直打到只剩一个人。'
      : (S.token ? '牌桌认了这个人。' : '你只是看着 —— 牌桌认了这个人。'));

  const rounds = st?.round ?? 0;
  const caught = (st?.players || []).reduce((a, p) => a + (p.caught || 0), 0);
  $('#over-stats').innerHTML = `
    <div><div class="k">轮 次</div><div class="v">${rounds}</div></div>
    <div><div class="k">剩余牌</div><div class="v">${st?.deckLeft ?? 0}</div></div>
    <div><div class="k">撒谎被抓</div><div class="v">${caught}</div></div>`;

  $('#over').classList.add('open');
  barIdle('牌局结束');
}

function showOverFromState() {
  const st = S.state;
  if (!st?.winner || S.ended) return;
  const wid = typeof st.winner === 'object' ? st.winner.id : st.winner;
  showOver({ winnerId: wid, winnerName: nameOf(wid) });
}

/* ---------------- 交互绑定 ---------------- */

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (t) {
    const act = t.dataset.act;
    if (act === 'draw') submit({ type: 'draw' });
    else if (act === 'use') {
      const action = { type: 'use', item: t.dataset.item };
      if (t.dataset.target) action.targetId = t.dataset.target;
      submit(action);
    } else if (act === 'defuse') submit({ type: 'defuse', use: t.dataset.use === '1' });
    else if (act === 'pick') submit({ type: 'pick', targetId: t.dataset.target });
    else if (act === 'answer') submit({ type: 'answer', claim: t.dataset.claim });
    else if (act === 'verdict') submit({ type: 'verdict', decision: t.dataset.decision });
    else if (act === 'vote') submit({ type: 'vote', accept: t.dataset.accept === '1' });
    return;
  }

  const open = e.target.closest('[data-open]');
  if (open) { $('#modal-rules').classList.add('open'); return; }

  const close = e.target.closest('[data-close]');
  if (close) { close.closest('.modal').classList.remove('open'); return; }

  if (e.target.classList.contains('modal')) e.target.classList.remove('open');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $$('.modal.open').forEach((m) => m.classList.remove('open'));
    return;
  }
  if (e.target.closest('input, textarea')) return;
  if (!/^[1-9]$/.test(e.key)) return;
  const opts = $$('#actionbar .opt').filter((b) => !b.disabled);
  const btn = opts[Number(e.key) - 1];
  if (btn) { e.preventDefault(); btn.click(); }
});

$('#btn-copy-join').addEventListener('click', async (e) => {
  const url = `${location.origin}/join/${S.roomId}`;
  const ok = await copy(url);
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  if (!ok) toast('复制失败，请手动复制地址栏里的链接', true);
  setTimeout(() => { btn.textContent = old; }, 1300);
});

$('#btn-lobby').addEventListener('click', () => { location.href = '/'; });
$('#btn-again').addEventListener('click', () => { location.href = '/'; });
$('#btn-back').addEventListener('click', () => { location.href = '/'; });

$('#wire-head').addEventListener('click', () => {
  if (!window.matchMedia('(max-width: 960px)').matches) return;
  const panel = $('#wire-panel');
  panel.classList.toggle('is-open');
  $('#wire-toggle-text').textContent = panel.classList.contains('is-open') ? '收起' : '展开';
});

/* ---------------- 启动 ---------------- */

(function boot() {
  S.roomId = parseRoom();
  if (!S.roomId) {
    $('#focus').innerHTML = '<div class="focus__kicker">错 误</div><div class="focus__text">地址里没有房间号</div>';
    return;
  }

  $('#room-tag').textContent = S.roomId;
  document.title = `${S.roomId} · BOMB TABLE`;

  S.token = read(`bt.token.${S.roomId}`) || '';
  S.meId = read(`bt.me.${S.roomId}`) || '';

  setMode(false, S.token ? '连接中' : '观战中');
  renderPanel();

  const es = new EventSource(`/api/rooms/${encodeURIComponent(S.roomId)}/events`);
  S.es = es;

  es.onopen = () => {
    setMode(true, S.token ? '已接入' : '观战中');
    if (S.token && !S.you) fetchSelf();
  };  es.onerror = () => setMode(false, '重连中');

  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    try { onEvent(ev); } catch (err) { console.error('event', ev.t, err); }
  };

  if (S.token) fetchSelf();
  setInterval(updateClock, 250);
})();
