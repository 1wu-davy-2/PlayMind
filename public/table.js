/* ============================================================
   TABLE — 通用牌桌前端
   只认识 state / ask 协议，不认识具体游戏。
   无框架、无构建，普通 <script>。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var KIND_LABEL = {
    free: '自由发言',
    declare: '公开声明',
    vote: '投票',
    confirm: '确认',
    'multi-pick': '多人挑选',
    bet: '下注',
    'play-card': '出牌',
    challenge: '质疑',
    /* 旧牌桌兼容 */
    draw: '抽牌',
    answer: '回答',
    defuse: '拆弹',
    'pick-target': '指定目标',
    verdict: '裁决'
  };

  var DEFAULT_ASK = {
    free: '轮到你发言。',
    declare: '请做出你的声明。',
    vote: '请做出你的选择。',
    confirm: '确认这一步？',
    'multi-pick': '挑选你的目标。',
    bet: '轮到你下注。',
    'play-card': '轮到你出牌。',
    challenge: '接受这个说法，还是当场质疑？',
    draw: '轮到你抽牌。',
    answer: '下一张，是炸弹吗？',
    defuse: '你抽到炸弹，要用拆弹钳吗？',
    'pick-target': '指定一个人。',
    verdict: '信，还是当场指控？'
  };

  var MOVE_LABEL = {
    fold: '弃 牌',
    check: '过 牌',
    call: '跟 注',
    raise: '加 注',
    allin: '全 下',
    bet: '下 注'
  };

  var FIELD_LABEL = {
    count: '数量',
    face: '点数',
    wild: '含 1 点 / 万能',
    word: '词语',
    number: '数字',
    name: '名称',
    target: '目标',
    amount: '金额',
    value: '数值'
  };

  var SECRET_LABEL = {
    topCard: '牌堆顶',
    word: '你的词',
    isSpy: '卧底',
    role: '身份',
    team: '阵营',
    count: '数量',
    face: '点数'
  };

  var PHASE_LABEL = {
    lobby: '候场',
    night: '夜晚',
    day: '白天',
    vote: '投票',
    ended: '结束'
  };

  var STATUS_LABEL = { lobby: '组局中', playing: '进行中', ended: '已结束' };

  var KIND_TEXT = { human: '真人', agent: '代理', bot: '代打' };

  var LOG_TAG = {
    say: '发言',
    thought: '思考',
    timeout: '超时',
    error: '错误',
    reveal: '揭示',
    ask: '决策',
    'ask-wait': '等待',
    system: '记录'
  };

  var TEAM_CLASS = {
    red: 'tag--red',
    blue: 'tag--blue',
    good: 'tag--good',
    evil: 'tag--evil',
    wolf: 'tag--evil',
    village: 'tag--good',
    merlin: 'tag--good',
    spy: 'tag--red',
    neutral: 'tag--gold'
  };

  /* ---------------- 环境 ---------------- */

  var q = new URLSearchParams(location.search);
  var pathRoom = (location.pathname.match(/\/play\/([A-Za-z0-9]+)/) || [])[1] || '';
  var qRoom = q.get('room') || '';
  var MOCK = location.search.indexOf('mock') >= 0;
  var ROOM = pathRoom || qRoom || (MOCK ? 'MOCK' : '');

  var TOKEN_KEY = 'bt_token_' + ROOM;
  var PID_KEY = 'bt_pid_' + ROOM;

  function readLS(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }
  function writeLS(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
  }

  var urlToken = q.get('token') || '';
  var urlPid = q.get('pid') || '';

  var token = urlToken || readLS(TOKEN_KEY) || readLS('bt.token.' + ROOM) || '';
  var pid = '';

  if (urlToken) {
    writeLS(TOKEN_KEY, urlToken);
    pid = urlPid || '';
    if (urlPid) writeLS(PID_KEY, urlPid);
  } else {
    pid = urlPid || readLS(PID_KEY) || readLS('bt.me.' + ROOM) || '';
    if (urlPid) writeLS(PID_KEY, urlPid);
  }

  /* ---------------- 运行时状态 ---------------- */

  var S = {
    state: null,
    ask: null,
    asks: {},
    self: null,
    hint: '',
    myPid: pid,
    myName: '',

    sse: null,
    sseOpen: false,
    openTimer: null,
    retry: 0,
    retryTimer: null,
    pollTimer: null,
    polling: false,
    tokenInvalid: false,
    fatal: '',

    logs: [],
    logSeen: {},
    logRendered: 0,
    logRenderedKey: '',
    logStick: true,

    think: {},

    busy: false,
    submitted: '',
    actionError: '',
    actionSig: '',
    lastAskId: '',
    pickAskId: '',
    picks: [],
    pickMin: 1,
    pickMax: 1,
    formDraft: {},
    sayDraft: '',

    askFetchKey: '',
    askFetchAt: 0
  };

  /* ---------------- 小工具 ---------------- */

  function el(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escAttr(v) { return esc(v); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function clock(ts) {
    var d = new Date(ts || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtLeft(ms) {
    if (ms <= 0) return '已超时';
    if (ms >= 60000) {
      return Math.floor(ms / 60000) + ':' + pad2(Math.floor((ms % 60000) / 1000));
    }
    return Math.ceil(ms / 1000) + 's';
  }

  function clampNum(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function hueOf(p) {
    var n = Number(p && p.hue);
    if (!isFinite(n)) return 205;
    return Math.round(((n % 360) + 360) % 360);
  }

  function safeGlyph(p) {
    var g = p && p.glyph ? String(p.glyph) : '';
    /* 只接受 1-2 个文字字符，避免把服务端的 emoji 当图标 */
    if (g && g.length <= 2 && !/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u.test(g)) return g;
    var name = String((p && p.name) || '?');
    return name.slice(0, 1).toUpperCase();
  }

  function glyphFor(v) {
    var s = String(v || '?').trim();
    return s.slice(0, 1).toUpperCase() || '?';
  }

  function teamLabel(team) {
    if (!team) return '';
    var map = {
      red: '红队', blue: '蓝队', good: '好人', evil: '恶人',
      wolf: '狼人', village: '村民', merlin: '梅林', spy: '卧底', neutral: '中立'
    };
    return map[team] || String(team);
  }

  function phaseLabel(p) {
    if (!p) return '—';
    return PHASE_LABEL[p] || String(p);
  }

  function fmtVal(v) {
    if (v == null || v === '') return '—';
    if (Array.isArray(v)) return v.map(fmtVal).join(' · ');
    if (typeof v === 'object') {
      return Object.keys(v).map(function (k) {
        var val = v[k];
        if (val === true) return k + ' 是';
        if (val === false) return k + ' 否';
        return k + ' ' + fmtVal(val);
      }).join(' · ');
    }
    if (v === true) return '是';
    if (v === false) return '否';
    return String(v);
  }

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function playerOf(id) {
    var ps = (S.state && S.state.players) || [];
    for (var i = 0; i < ps.length; i += 1) if (ps[i].id === id) return ps[i];
    return null;
  }

  function nameOf(id) {
    var p = playerOf(id);
    return p ? p.name : String(id || '?');
  }

  function toast(msg) {
    var t = el('toast');
    if (!t) return;
    t.textContent = String(msg);
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ---------------- 日志 ---------------- */

  function addLog(ev) {
    if (!ev) return false;
    var text = ev.text == null ? '' : String(ev.text);
    if (!text) return false;

    var at = Number(ev.at) || Date.now();
    var k = Math.floor(at / 1000) + '|' + text;
    if (S.logSeen[k]) return false;

    S.logSeen[k] = 1;
    S.logs.push({
      k: k,
      at: at,
      text: text,
      t: ev.t || 'system',
      playerId: ev.playerId || null
    });

    if (S.logs.length > 240) {
      var gone = S.logs.shift();
      if (gone) delete S.logSeen[gone.k];
    }
    return true;
  }

  function mergeStateLog(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (typeof item === 'string') addLog({ text: item });
      else addLog(item);
    }
  }

  function logEntryHTML(item) {
    var t = String(item.t || 'system').toLowerCase().replace(/[^a-z-]/g, '') || 'system';
    var cls = 'lentry lentry--' + t;
    var who = item.playerId ? nameOf(item.playerId) : '';
    return '<div class="' + cls + '">'
      + '<div class="lentry__meta"><span>' + esc(clock(item.at)) + '</span>'
      + (who ? '<span>' + esc(who) + '</span>' : '')
      + '<span class="lentry__tag">' + esc(LOG_TAG[t] || '记录') + '</span></div>'
      + '<div class="lentry__text">' + esc(item.text) + '</div>'
      + '</div>';
  }

  function renderLog() {
    var box = el('log');
    if (!box) return;

    var lastKey = S.logs.length ? S.logs[S.logs.length - 1].k : '';

    /* 记录被裁剪或整体替换时重绘 */
    if (S.logRendered > S.logs.length
        || (S.logRendered === S.logs.length && S.logRenderedKey && S.logRenderedKey !== lastKey)) {
      box.innerHTML = '';
      S.logRendered = 0;
      S.logRenderedKey = '';
    }

    if (!S.logs.length) {
      if (!box.querySelector('.logempty')) {
        box.innerHTML = '<div class="logempty">还没有公开记录。牌桌上的发言与系统事件会打在这里。</div>';
      }
      S.logRendered = 0;
      S.logRenderedKey = '';
    } else {
      var empty = box.querySelector('.logempty');
      if (empty) empty.parentNode.removeChild(empty);

      if (S.logRendered < S.logs.length) {
        var html = '';
        for (var i = S.logRendered; i < S.logs.length; i += 1) {
          html += logEntryHTML(S.logs[i]);
        }
        box.insertAdjacentHTML('beforeend', html);
        S.logRendered = S.logs.length;
        S.logRenderedKey = lastKey;
        if (S.logStick) box.scrollTop = box.scrollHeight;
      }
    }

    var count = el('log-count');
    if (count) count.textContent = String(S.logs.length);
  }

  /* ---------------- 状态 ---------------- */

  function currentAskIds() {
    var st = S.state || {};
    var ids = st.askPlayerIds;
    if (!Array.isArray(ids) || !ids.length) {
      ids = st.askPlayerId ? [st.askPlayerId] : [];
    }
    return ids;
  }

  function applyState(st) {
    if (!st || typeof st !== 'object') return;
    var prev = S.state;
    S.state = st;

    /* 换轮 / 换阶段时清掉上一阶段的思考气泡 */
    if (prev && (prev.round !== st.round || prev.phase !== st.phase)) {
      S.think = {};
    }

    if (S.myPid && Array.isArray(st.players)) {
      var me = playerOf(S.myPid);
      if (me && me.name) S.myName = me.name;
    }

    /* 日志只由 SSE 事件提供；再合并 state.log 会让同一条记录出现两次 */

    var ids = currentAskIds();
    var mine = !!S.myPid && ids.indexOf(S.myPid) >= 0;

    if (!mine) {
      S.ask = null;
    } else if (S.ask && S.ask.playerId !== S.myPid) {
      S.ask = null;
    } else if (S.ask && S.ask.deadline && Number(S.ask.deadline) < Date.now() - 5000) {
      S.ask = null;
    }

    if (mine && !S.ask) ensureMyAsk();

    render();
  }

  /* ---------------- SSE ---------------- */

  function sseURL() {
    var base = '/api/rooms/' + encodeURIComponent(ROOM) + '/events';
    return token ? base + '?token=' + encodeURIComponent(token) : base;
  }

  function connectSSE() {
    if (MOCK || !ROOM) return;
    if (typeof EventSource === 'undefined') { startPolling(); return; }

    closeSSE();

    var es;
    try {
      es = new EventSource(sseURL());
    } catch (e) {
      scheduleReconnect();
      startPolling();
      return;
    }

    S.sse = es;

    S.openTimer = setTimeout(function () {
      if (!S.sseOpen) startPolling();
    }, 6000);

    es.onopen = function () {
      if (S.sse !== es) return;
      S.sseOpen = true;
      S.retry = 0;
      clearTimeout(S.openTimer);
      stopPolling();
      renderMode();
      if (token) pollOnce();
    };

    es.onmessage = function (e) {
      if (S.sse !== es) return;
      var ev = null;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      handleEvent(ev);
    };

    es.onerror = function () {
      if (S.sse !== es) return;
      S.sseOpen = false;
      clearTimeout(S.openTimer);
      try { es.close(); } catch (err) { /* ignore */ }
      if (S.sse === es) S.sse = null;
      startPolling();
      scheduleReconnect();
      renderMode();
    };
  }

  function closeSSE() {
    if (S.sse) {
      try { S.sse.close(); } catch (e) { /* ignore */ }
      S.sse = null;
    }
    S.sseOpen = false;
    clearTimeout(S.openTimer);
  }

  function scheduleReconnect() {
    if (S.retryTimer || MOCK || !ROOM) return;
    var delay = Math.min(30000, 3000 * Math.pow(1.5, S.retry));
    S.retry += 1;
    S.retryTimer = setTimeout(function () {
      S.retryTimer = null;
      connectSSE();
    }, delay);
  }

  var diceTimer = null;

  function dieHTML(n, cls) {
    var map = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    var on = map[Number(n)] || [];
    var dots = '';
    for (var i = 0; i < 9; i += 1) {
      dots += '<i class="die__pip' + (on.indexOf(i) >= 0 ? ' is-on' : '') + '"></i>';
    }
    return '<span class="die ' + (cls || '') + '">' + dots + '</span>';
  }

  function bidTextSafe(b) {
    if (!b || !b.count) return '无叫点';
    var cn = ['', '一', '二', '三', '四', '五', '六'][Number(b.face)] || String(b.face);
    return b.count + ' 个 ' + cn + (b.wild ? '' : '（斋）');
  }

  function pidName(pid) {
    var ps = (S.state && S.state.players) || [];
    for (var i = 0; i < ps.length; i += 1) if (ps[i] && ps[i].id === pid) return ps[i].name || pid;
    return pid;
  }

  function showDice(html, ms) {
    var stage = el('dice-stage');
    if (!stage) return;
    stage.innerHTML = html;
    stage.hidden = false;
    if (diceTimer) clearTimeout(diceTimer);
    if (ms) {
      diceTimer = setTimeout(function () {
        stage.hidden = true;
        stage.innerHTML = '';
      }, ms);
    }
  }

  function handleDiceEffect(ev) {
    var st = S.state || {};
    if (st.gameType !== 'liars-dice') return;

    if (ev.t === 'roll') {
      var total = Math.max(1, Math.min(12, Number(ev.total) || 5));
      var rolling = '<div class="dice-stage__kicker">骰 盅 摇 动</div><div class="dice-stage__row">';
      for (var i = 0; i < total; i += 1) rolling += dieHTML(1 + (i % 6), 'die--roll');
      showDice(rolling + '</div>', 1300);
      return;
    }

    if (ev.t === 'open' && ev.dice) {
      var bid = ev.bid || {};
      var ids = Object.keys(ev.dice);
      var html = '<div class="dice-stage__kicker">开 盅 · ' + esc(bidTextSafe(bid)) + '</div>';
      for (var j = 0; j < ids.length; j += 1) {
        var faces = ev.dice[ids[j]] || [];
        html += '<div class="dice-stage__group"><div class="dice-stage__label">'
          + esc(pidName(ids[j])) + '</div><div class="dice-stage__row">';
        for (var k = 0; k < faces.length; k += 1) {
          var f = Number(faces[k]);
          var hit = Number(bid.face) > 0 && (f === Number(bid.face) || (bid.wild && f === 1));
          html += dieHTML(f, 'die--land' + (hit ? ' die--hit' : ''));
        }
        html += '</div></div>';
      }
      showDice(html, 4500);
    }
  }

  var FX_LABELS = {
    chip: '下 注', card: '出 牌', bid: '叫 点', vote: '表 决',
    stamp: '揭 示', clue: '线 索', phase: '阶 段', end: '终 局'
  };
  var fxTimer = null;

  function fxGlyph(kind) {
    var g = { chip: '●', card: '▣', bid: '#', vote: '▤', stamp: '印', clue: '词', phase: '—', end: '★' };
    return g[kind] || '·';
  }

  function showFx(kind, text, ms) {
    var stage = el('fx-stage');
    if (!stage) return;
    var line = String(text || '').slice(0, 140);
    if (!stage.hidden && stage.getAttribute('data-kind') === kind) {
      var old = stage.querySelector('.fx-text');
      if (old) old.textContent = line;
      if (fxTimer) clearTimeout(fxTimer);
      fxTimer = setTimeout(function () {
        stage.hidden = true;
        stage.innerHTML = '';
        stage.removeAttribute('data-kind');
      }, ms || 2400);
      return;
    }
    stage.setAttribute('data-kind', kind);
    var html = '<div class="fx-stage__kicker">' + esc(FX_LABELS[kind] || '动 作') + '</div>'
      + '<div class="fx-stage__body fx--' + kind + '">'
      + '<span class="fx-glyph">' + esc(fxGlyph(kind)) + '</span>'
      + '<span class="fx-text">' + esc(String(text || '').slice(0, 140)) + '</span></div>';
    stage.innerHTML = html;
    stage.hidden = false;
    if (fxTimer) clearTimeout(fxTimer);
    fxTimer = setTimeout(function () {
      stage.hidden = true;
      stage.innerHTML = '';
      stage.removeAttribute('data-kind');
    }, ms || 2400);
  }

  function handleFx(ev) {
    var fx = ev && ev.fx;
    if (!fx || !FX_LABELS[fx.kind]) return;
    if (fx.kind === 'phase' && !ev.text) return;
    showFx(fx.kind, ev.text, fx.kind === 'end' ? 3600 : 2400);
  }

  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    handleDiceEffect(ev);
    handleFx(ev);

    if (ev.ask || ev.asks) {
      var list = ev.asks || (ev.ask ? [ev.ask] : []);
      var mine = null;
      for (var i = 0; i < list.length; i += 1) {
        var a = list[i];
        if (!a || !a.id) continue;
        /* 重连时服务端会回放旧事件，过期的 ask 不再接 */
        if (a.deadline && Number(a.deadline) < Date.now() - 2000) continue;
        S.asks[a.id] = a;
        if (S.myPid && a.playerId === S.myPid) mine = a;
      }
      if (mine) {
        if (S.ask && S.ask.id !== mine.id && S.submitted && S.submitted !== mine.id) {
          S.submitted = '';
        }
        S.ask = mine;
      }
    }

    if (ev.t === 'thought' && ev.playerId && ev.delta) {
      var prev = S.think[ev.playerId] || '';
      var next = prev + String(ev.delta);
      if (next.length > 600) next = next.slice(-600);
      S.think[ev.playerId] = next;
      scheduleRoster();
    }

    if (ev.t === 'thought-end' && ev.playerId) {
      var whole = String(S.think[ev.playerId] || '').trim();
      if (whole) {
        addLog({ t: 'thought', playerId: ev.playerId, text: '心想：' + whole, at: ev.at || Date.now() });
        renderLog();
      }
      delete S.think[ev.playerId];
      scheduleRoster();
    }

    if (ev.text) {
      addLog(ev);
      renderLog();
    }

    if (ev.t === 'state' && ev.state) {
      applyState(ev.state);
      return;
    }

    if (ev.t !== 'thought' && ev.t !== 'thought-end') render();

    if (token && currentAskIds().indexOf(S.myPid) >= 0 && !S.ask) ensureMyAsk();
  }

  var rosterTimer = null;
  function scheduleRoster() {
    if (rosterTimer) return;
    rosterTimer = setTimeout(function () {
      rosterTimer = null;
      renderRoster();
    }, 140);
  }

  /* ---------------- 轮询兜底 ---------------- */

  function startPolling() {
    if (MOCK || !token) return;
    if (S.pollTimer) return;
    pollOnce();
    S.pollTimer = setInterval(pollOnce, 2000);
    renderMode();
  }

  function stopPolling() {
    if (S.pollTimer) {
      clearInterval(S.pollTimer);
      S.pollTimer = null;
    }
  }

  function pollOnce() {
    if (MOCK || !token || !ROOM || S.polling) return;
    S.polling = true;

    var url = '/api/agent/' + encodeURIComponent(ROOM) + '/' + encodeURIComponent(token);

    fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (j) {
          return { ok: res.ok, status: res.status, body: j };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          if (r.status === 403) {
            S.tokenInvalid = true;
            stopPolling();
            render();
          }
          return;
        }
        S.tokenInvalid = false;

        var j = r.body || {};

        if (j.you && j.you.id) {
          if (S.myPid !== j.you.id) {
            S.myPid = j.you.id;
            writeLS(PID_KEY, S.myPid);
          }
          if (j.you.name) S.myName = j.you.name;
          S.self = j.you;
        }

        if (j.hint) S.hint = String(j.hint);

        if (j.ask && j.ask.id) {
          S.asks[j.ask.id] = j.ask;
          if (!S.myPid || j.ask.playerId === S.myPid) S.ask = j.ask;
        }

        /* SSE 在线时以推送的 state 为准，避免轮询的旧快照覆盖新状态 */
        if (j.state && (!S.sseOpen || !S.state)) {
          applyState(j.state);
        } else {
          render();
        }
      })
      .catch(function () { /* 网络错误：等下一次 */ })
      .then(function () { S.polling = false; });
  }

  function ensureMyAsk() {
    if (!token && !MOCK) return;
    if (!S.myPid) return;
    if (currentAskIds().indexOf(S.myPid) < 0) return;

    var key = currentAskIds().join(',');
    var now = Date.now();
    if (S.askFetchKey === key && now - S.askFetchAt < 2500) return;
    S.askFetchKey = key;
    S.askFetchAt = now;

    if (MOCK) {
      if (!S.ask) S.ask = mockAsk();
      return;
    }
    pollOnce();
  }

  /* ---------------- 渲染：顶栏 ---------------- */

  function renderTop() {
    var st = S.state || {};
    var gameTitle = st.gameTitle || '通用牌桌';
    var room = ROOM || '——';

    if (el('game-title')) el('game-title').textContent = gameTitle;
    if (el('room-id')) el('room-id').textContent = room;

    if (!S.state) {
      if (el('statline')) {
        el('statline').innerHTML = '<span class="stat"><i class="stat__k">状态</i>'
          + '<b class="stat__v">接入中</b></span>'
          + '<span class="stat"><i class="stat__k">房号</i><b class="stat__v">' + esc(room) + '</b></span>';
      }
      return;
    }

    var status = st.status || 'lobby';
    var players = Array.isArray(st.players) ? st.players : [];
    var filled = st.filled != null ? st.filled : players.length;
    var seats = st.seats != null ? st.seats : '?';

    var cells = [
      { k: '状态', v: STATUS_LABEL[status] || status, live: status === 'playing' },
      { k: '回合', v: st.round == null || st.round === '' ? '—' : String(st.round) },
      { k: '阶段', v: st.phase ? phaseLabel(st.phase) : '—' },
      { k: '在场', v: filled + ' / ' + seats }
    ];

    if (el('statline')) {
      el('statline').innerHTML = cells.map(function (c) {
        return '<span class="stat' + (c.live ? ' stat--live' : '') + '">'
          + '<i class="stat__k">' + esc(c.k) + '</i>'
          + '<b class="stat__v">' + esc(c.v) + '</b></span>';
      }).join('');
    }
  }

  function renderMode() {
    var chip = el('mode');
    var txt = el('mode-text');
    var foot = el('conn-foot');
    if (!chip || !txt) return;

    chip.className = 'modechip';
    chip.removeAttribute('title');

    if (MOCK) {
      chip.classList.add('is-live');
      txt.textContent = '演示数据';
      if (foot) foot.textContent = 'MOCK · 本地';
      return;
    }
    if (!token) {
      txt.textContent = '观战中';
      if (foot) foot.textContent = '只读 · 无 token';
      return;
    }
    if (S.tokenInvalid) {
      chip.classList.add('is-bad');
      txt.textContent = 'token 无效';
      chip.title = '服务端不认识这个 token，只能观战';
      if (foot) foot.textContent = 'token 无效';
      return;
    }
    if (S.sseOpen) {
      chip.classList.add('is-live');
      txt.textContent = '已接入';
      if (foot) foot.textContent = 'SSE · 在线';
      return;
    }

    chip.classList.add('is-warn');
    txt.textContent = '重连中';
    chip.title = S.pollTimer
      ? ('SSE 已断开：每 2 秒轮询兜底，同时按退避重连' + (S.retry ? ('（第 ' + S.retry + ' 次）') : ''))
      : (S.retry ? ('第 ' + S.retry + ' 次重连') : '正在重连');
    if (foot) foot.textContent = S.pollTimer ? '轮询兜底 · 2s' : '离线 · 重连中';
  }

  /* ---------------- 渲染：玩家 ---------------- */

  function rosterCardHTML(p) {
    var ids = currentAskIds();
    var isAsk = ids.indexOf(p.id) >= 0;
    var isCurrent = (S.state && S.state.turnPlayerId) === p.id;
    var isDead = p.alive === false;
    var isOff = p.connected === false;

    var cls = 'pcard';
    if (isAsk) cls += ' is-ask';
    if (isCurrent) cls += ' is-current';
    if (isDead) cls += ' is-dead';
    if (isOff) cls += ' is-off';
    if (S.myPid && p.id === S.myPid) cls += ' is-you';

    var tags = '';
    if (p.team) {
      var tc = TEAM_CLASS[p.team] || '';
      tags += '<span class="tag ' + tc + '">' + esc(teamLabel(p.team)) + '</span>';
    }
    if (p.role) tags += '<span class="tag tag--gold">' + esc(p.role) + '</span>';
    if (isCurrent) tags += '<span class="tag tag--live">行动中</span>';
    if (isAsk && !isCurrent) tags += '<span class="tag tag--live">待决策</span>';
    if (isDead) tags += '<span class="tag tag--mute">出局</span>';
    if (p.folded) tags += '<span class="tag tag--mute">已弃牌</span>';
    if (p.caught) tags += '<span class="tag tag--mute">被识破</span>';
    if (isOff) tags += '<span class="tag tag--mute">离线</span>';

    var stats = [];
    if (p.hp != null) {
      var maxHp = p.maxHp != null ? Number(p.maxHp) : Number(p.hp);
      var hp = Number(p.hp) || 0;
      var dots = '';
      for (var i = 0; i < Math.max(maxHp, hp); i += 1) {
        dots += '<i class="hp__dot' + (i < hp ? ' is-on' : '') + '"></i>';
      }
      stats.push('<span class="hp" title="生命 ' + hp + '/' + maxHp + '">' + dots + '</span>');
    }
    if (p.handCount != null) stats.push('<span>手牌 ' + Number(p.handCount) + '</span>');
    if (p.diceCount != null) stats.push('<span>骰 ' + Number(p.diceCount) + '</span>');
    if (p.chips != null) stats.push('<span>筹码 ' + Number(p.chips) + '</span>');

    var html = '<div class="' + cls + '" style="--hue:' + hueOf(p) + '">'
      + '<div class="pcard__top">'
      + '<span class="pcard__glyph">' + esc(safeGlyph(p)) + '</span>'
      + '<span class="pcard__name">' + esc(p.name || '无名') + '</span>'
      + (S.myPid && p.id === S.myPid ? '<span class="pcard__you">你</span>' : '')
      + '<span class="pcard__kind">' + esc(KIND_TEXT[p.kind] || p.kind || '?') + '</span>'
      + '</div>';

    if (tags) html += '<div class="pcard__tags">' + tags + '</div>';
    if (stats.length) html += '<div class="pcard__stats">' + stats.join('') + '</div>';
    if (p.says) html += '<div class="pcard__say">' + esc(p.says) + '</div>';

    var think = S.think[p.id];
    if (think) html += '<div class="pcard__think">' + esc(think) + '</div>';

    return html + '</div>';
  }

  function renderRoster() {
    var box = el('roster');
    if (!box) return;

    var players = (S.state && Array.isArray(S.state.players)) ? S.state.players : [];
    var top = box.scrollTop;

    if (!players.length) {
      box.innerHTML = '<div class="roster__empty">还没有玩家入座。把加入链接发给朋友或 AI。</div>';
    } else {
      box.innerHTML = players.map(rosterCardHTML).join('');
    }
    box.scrollTop = top;

    var alive = players.filter(function (p) { return p.alive !== false; }).length;
    var status = (S.state && S.state.status) || 'lobby';

    if (el('roster-count')) {
      el('roster-count').textContent = players.length
        ? (status === 'lobby' ? (players.length + ' 人') : (alive + '/' + players.length + ' 存活'))
        : '—';
    }
    if (el('roster-foot')) {
      var st = S.state || {};
      var foot = players.length
        ? ('共 ' + players.length + ' 人 · ' + (st.filled != null ? st.filled : players.length) + ' 入座')
        : '等待牌桌数据';
      if (!token && !MOCK) foot += ' · 观战';
      el('roster-foot').textContent = foot;
    }
  }

  /* ---------------- 渲染：桌面 ---------------- */

  function renderTable() {
    var st = S.state || {};
    var lobby = (st.status || 'lobby') === 'lobby';

    var kicker = '牌 桌 / TABLE';
    if (st.phase) kicker = phaseLabel(st.phase) + ' · TABLE';
    if (el('phase-kicker')) el('phase-kicker').textContent = kicker;

    var title = '';
    if (lobby && !(st.table && st.table.title)) title = '等待开局';
    else title = (st.table && st.table.title) || st.gameTitle || '牌桌';
    if (el('table-title')) el('table-title').textContent = title;

    var chip = el('round-chip');
    if (chip) {
      if (st.round == null || st.round === '') {
        chip.hidden = true;
      } else {
        chip.hidden = false;
        chip.textContent = '第 ' + st.round + ' 轮';
      }
    }

    var rows = (st.table && Array.isArray(st.table.rows)) ? st.table.rows : [];
    var rowsBox = el('table-rows');
    if (rowsBox) {
      if (!rows.length) {
        rowsBox.innerHTML = '<div class="rows__empty">'
          + (lobby ? '桌面空着。人齐之后由房主开局。' : '这一局暂时没有公开的桌面信息。')
          + '</div>';
      } else {
        rowsBox.innerHTML = rows.map(function (r) {
          return '<div class="trow"><span class="trow__k">' + esc(r && r.label != null ? r.label : '—') + '</span>'
            + '<span class="trow__v">' + esc(fmtVal(r ? r.value : '')) + '</span></div>';
        }).join('');
      }
    }

    var note = el('table-note');
    if (note) {
      var text = st.table && st.table.note ? String(st.table.note) : '';
      note.textContent = text;
      note.hidden = !text;
    }
  }

  /* ---------------- 渲染：自己 ---------------- */

  function secretText(secret) {
    if (secret == null) return '';
    function one(k, v) {
      var label = SECRET_LABEL[k] || k;
      var val;
      if (v === true) val = '是';
      else if (v === false) val = '否';
      else if (v === 'bomb') val = '炸弹';
      else if (v === 'safe') val = '安全';
      else if (v && typeof v === 'object') val = fmtVal(v);
      else val = String(v);
      return label + ' · ' + val;
    }
    if (typeof secret === 'object' && !Array.isArray(secret)) {
      return Object.keys(secret).map(function (k) { return one(k, secret[k]); }).join('　');
    }
    return fmtVal(secret);
  }

  function renderSelf() {
    var box = el('self');
    if (!box) return;

    var rosterMe = S.myPid ? playerOf(S.myPid) : null;
    if (!S.self && !rosterMe) {
      box.hidden = true;
      return;
    }

    var me = S.self || {};
    var name = me.name || (rosterMe && rosterMe.name) || S.myName || '我';
    var role = me.role || (rosterMe && rosterMe.role) || '';
    var team = me.team || (rosterMe && rosterMe.team) || '';
    var hand = Array.isArray(me.hand) ? me.hand.length : (rosterMe && rosterMe.handCount);
    var dice = Array.isArray(me.dice) ? me.dice.length : (rosterMe && rosterMe.diceCount);
    var chips = me.chips != null ? me.chips : (rosterMe && rosterMe.chips);

    var html = '<span class="selfcard__label">你</span>'
      + '<b class="selfcard__name">' + esc(name) + '</b>';

    if (team) html += '<span class="tag ' + (TEAM_CLASS[team] || '') + '">' + esc(teamLabel(team)) + '</span>';
    if (role) html += '<span class="tag tag--gold">' + esc(role) + '</span>';
    if (hand != null) html += '<span class="selfcard__num">手牌 ' + Number(hand) + '</span>';
    if (dice != null) html += '<span class="selfcard__num">骰 ' + Number(dice) + '</span>';
    if (chips != null) html += '<span class="selfcard__num">筹码 ' + Number(chips) + '</span>';

    var secret = secretText(me.secret);
    if (secret) html += '<span class="selfcard__secret">' + esc(secret) + '</span>';

    box.innerHTML = html;
    box.hidden = false;
  }

  function renderWinner() {
    var box = el('winner');
    if (!box) return;

    var st = S.state || {};
    var w = st.winner;
    var ended = st.status === 'ended';

    if (!w && !ended) {
      box.hidden = true;
      return;
    }

    var name = w && w.name ? w.name : '无人';
    var mine = !!(w && S.myPid && w.id === S.myPid);
    box.innerHTML = '<span class="winner__k">牌 局 结 束</span>'
      + '<span class="winner__name">胜者 · ' + esc(name) + (mine ? '（你）' : '') + '</span>'
      + '<span class="winner__sub">ROOM ' + esc(ROOM || '——') + '</span>';
    box.hidden = false;
  }

  /* ---------------- 渲染：操作区 ---------------- */

  function draftOf(k) {
    return has(S.formDraft, k) ? S.formDraft[k] : undefined;
  }

  function captureDraft() {
    var box = el('action-body');
    if (!box) return;

    var nodes = box.querySelectorAll('[data-field]');
    for (var i = 0; i < nodes.length; i += 1) {
      var n = nodes[i];
      S.formDraft[n.getAttribute('data-field')] = n.type === 'checkbox' ? !!n.checked : n.value;
    }
    var f = box.querySelector('#free-text');
    if (f) S.formDraft['free-text'] = f.value;
    var b = box.querySelector('#bet-amount');
    if (b) S.formDraft['bet-amount'] = b.value;
  }

  function fieldName(f) {
    if (typeof f === 'string') return f;
    return (f && (f.name || f.key || f.id)) || '';
  }

  function fieldLabel(name, desc) {
    if (desc && desc.label) return desc.label;
    return FIELD_LABEL[name] || name;
  }

  function fieldType(name, desc) {
    var t = String((desc && desc.type) || '').toLowerCase();
    if (t === 'number' || t === 'int' || t === 'integer' || t === 'range') return 'number';
    if (t === 'boolean' || t === 'bool' || t === 'checkbox') return 'checkbox';
    if (t === 'text' || t === 'string') return 'text';
    if (/wild|bool|flag|is[A-Z_]/.test(name)) return 'checkbox';
    if (/count|number|face|amount|qty|num|point|denom/i.test(name)) return 'number';
    return 'text';
  }

  function declareFields(payload) {
    var f = payload && payload.fields;
    if (Array.isArray(f)) return f.slice();
    if (f && typeof f === 'object') {
      return Object.keys(f).map(function (k) {
        var d = f[k];
        if (d && typeof d === 'object') {
          var o = {};
          for (var kk in d) if (Object.prototype.hasOwnProperty.call(d, kk)) o[kk] = d[kk];
          o.name = o.name || k;
          return o;
        }
        return { name: k, label: typeof d === 'string' ? d : '' };
      });
    }
    return null;
  }

  function declareHTML(payload) {
    var fields = declareFields(payload);

    if (!fields || !fields.length) {
      var v = draftOf('free-text');
      var ph = (payload && (payload.placeholder || payload.prompt)) || '按提示写下你的声明';
      return '<div class="afield"><label class="afield__label" for="free-text">声明内容</label>'
        + '<textarea class="ainput" id="free-text" rows="3" maxlength="500" placeholder="' + esc(ph) + '">'
        + esc(v == null ? '' : v) + '</textarea></div>'
        + '<div class="arow"><button class="tbtn tbtn--primary" data-act="declare-text">提交声明</button></div>';
    }

    var html = '<div class="afields">';
    for (var i = 0; i < fields.length; i += 1) {
      var f = fields[i];
      var name = fieldName(f);
      if (!name) continue;
      var desc = (typeof f === 'object' && f) ? f : {};
      var type = fieldType(name, desc);
      var label = fieldLabel(name, desc);
      var val = draftOf(name);

      if (type === 'checkbox') {
        var on = val === true;
        html += '<div class="afield afield--check"><label><input type="checkbox" data-field="' + escAttr(name) + '"'
          + (on ? ' checked' : '') + '> ' + esc(label) + '</label></div>';
        continue;
      }

      var attrs = ' data-field="' + escAttr(name) + '"';
      if (type === 'number') {
        attrs += ' type="number" step="1"';
        if (desc.min != null && isFinite(Number(desc.min))) attrs += ' min="' + escAttr(desc.min) + '"';
        if (desc.max != null && isFinite(Number(desc.max))) attrs += ' max="' + escAttr(desc.max) + '"';
      } else {
        attrs += ' type="text"';
      }
      var value = val == null ? (desc.value != null ? desc.value : '') : val;
      html += '<div class="afield"><label class="afield__label">' + esc(label) + '</label>'
        + '<input class="ainput" autocomplete="off"' + attrs
        + ' value="' + escAttr(value) + '"'
        + ' placeholder="' + escAttr(desc.placeholder || (type === 'number' ? '数字' : '')) + '"></div>';
    }
    html += '</div>';

    if (payload && payload.note) {
      html += '<div class="anote">' + esc(payload.note) + '</div>';
    }
    html += '<div class="arow"><button class="tbtn tbtn--primary" data-act="declare">提交声明</button></div>';
    return html;
  }

  function choiceHTML(c, actName) {
    var id;
    var label;
    var meta = '';
    var glyph;

    if (typeof c === 'string' || typeof c === 'number') {
      id = String(c);
      var pl = playerOf(id);
      if (pl) {
        label = pl.name;
        meta = (KIND_TEXT[pl.kind] || pl.kind || '') + ' · ' + (pl.alive === false ? '出局' : '在场');
        if (pl.team) meta += ' · ' + teamLabel(pl.team);
        glyph = safeGlyph(pl);
      } else {
        label = id;
        glyph = glyphFor(id);
      }
    } else if (c && typeof c === 'object') {
      id = String(c.id != null ? c.id : (c.playerId != null ? c.playerId : (c.value != null ? c.value : '')));
      var pl2 = id ? playerOf(id) : null;
      label = c.name || c.label || (pl2 ? pl2.name : id) || '?';
      meta = c.meta || c.description || '';
      if (!meta && pl2) meta = (KIND_TEXT[pl2.kind] || '') + ' · ' + (pl2.alive === false ? '出局' : '在场');
      glyph = c.glyph || (pl2 ? safeGlyph(pl2) : glyphFor(label));
    } else {
      return '';
    }

    if (!id) return '';

    return '<button type="button" class="choice" data-act="' + escAttr(actName) + '" data-target="' + escAttr(id) + '">'
      + '<span class="choice__glyph">' + esc(glyph) + '</span>'
      + '<span class="choice__main"><b>' + esc(label) + '</b>'
      + (meta ? '<em>' + esc(meta) + '</em>' : '')
      + '</span></button>';
  }

  function voteHTML(payload, actName) {
    var p = payload || {};
    var html = '';

    var approvalKey = null;
    if (typeof p.approve === 'boolean') approvalKey = 'approve';
    else if (typeof p.accept === 'boolean') approvalKey = 'accept';

    if (approvalKey) {
      html += '<div class="arow">'
        + '<button type="button" class="tbtn tbtn--primary" data-act="vote-approve" data-key="' + approvalKey + '" data-value="1">赞 成</button>'
        + '<button type="button" class="tbtn" data-act="vote-approve" data-key="' + approvalKey + '" data-value="0">反 对</button>'
        + '</div>';
    }

    var cands = p.candidates || p.options || [];
    if (Array.isArray(cands) && cands.length) {
      var html2 = [];
      for (var i = 0; i < cands.length; i += 1) {
        var one = choiceHTML(cands[i], actName);
        if (one) html2.push(one);
      }
      if (html2.length) html += '<div class="choices">' + html2.join('') + '</div>';
    }

    if (!html) {
      return '<div class="anote">这个决策没有提供候选项，按自由文本提交。</div>' + freeHTML(p);
    }
    return html;
  }

  function freeHTML(payload) {
    var p = payload || {};
    var v = draftOf('free-text');
    var ph = p.placeholder || '写下你的回答，尽量简短。';
    return '<div class="afield"><label class="afield__label" for="free-text">你的回答</label>'
      + '<textarea class="ainput" id="free-text" rows="3" maxlength="500" placeholder="' + esc(ph) + '">'
      + esc(v == null ? '' : v) + '</textarea></div>'
      + '<div class="arow"><button type="button" class="tbtn tbtn--primary" data-act="free-text">提 交</button>'
      + '<span class="anote">提交后不可撤回。</span></div>';
  }

  function confirmHTML(payload) {
    var p = payload || {};
    var yes = p.yes || p.trueLabel || '是';
    var no = p.no || p.falseLabel || '否';
    return '<div class="arow">'
      + '<button type="button" class="tbtn tbtn--primary" data-act="confirm" data-value="1">' + esc(yes) + '</button>'
      + '<button type="button" class="tbtn" data-act="confirm" data-value="0">' + esc(no) + '</button>'
      + '</div>';
  }

  function multiHTML(payload) {
    var p = payload || {};
    var cands = p.candidates || p.options || [];
    if (!Array.isArray(cands)) cands = [];

    var aid = S.ask ? S.ask.id : '';
    if (S.pickAskId !== aid) {
      S.pickAskId = aid;
      S.picks = [];
    }

    var min = Number(p.min);
    if (!isFinite(min) || min < 0) min = 1;
    var max = Number(p.max);
    if (!isFinite(max) || max < 1) max = Math.max(cands.length, 1);
    S.pickMin = min;
    S.pickMax = max;

    var validIds = cands.map(function (c) {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      return String((c && (c.id != null ? c.id : c.value)) || '');
    });
    S.picks = S.picks.filter(function (id) { return validIds.indexOf(id) >= 0; });

    var cards = cands.map(function (c) {
      var one = choiceHTML(c, 'pick');
      var id = typeof c === 'string' ? c : (c && c.id != null ? String(c.id) : '');
      if (!one) return '';
      if (S.picks.indexOf(String(id)) >= 0) {
        one = one.replace('class="choice"', 'class="choice is-on"');
      }
      return one;
    }).join('');

    var count = S.picks.length;
    var enough = count >= min;

    return '<div class="choices">' + cards + '</div>'
      + '<div class="arow"><span class="acount">已选 ' + count + ' / ' + (min === max ? min : (min + '–' + max)) + '</span>'
      + '<button type="button" class="tbtn tbtn--primary" data-act="pick-many"'
      + (enough ? '' : ' disabled') + '>确认选择</button></div>';
  }

  function betHTML(payload) {
    var p = payload || {};
    var legal = Array.isArray(p.legal) ? p.legal : ['fold', 'check', 'call', 'raise', 'allin'];
    var moves = [];

    for (var i = 0; i < legal.length; i += 1) {
      var m = legal[i];
      if (typeof m === 'string') moves.push({ move: m });
      else if (m && (m.move || m.type)) moves.push(m);
    }
    if (!moves.length) moves = [{ move: 'fold' }];

    var min = Number(p.min);
    if (!isFinite(min)) min = 0;
    var max = Number(p.max);
    if (!isFinite(max)) max = Number(p.chips) || 999999;

    var html = '';
    if (p.note || p.pot != null || p.callAmount != null) {
      var bits = [];
      if (p.pot != null) bits.push('底池 ' + p.pot);
      if (p.callAmount != null) bits.push('需跟 ' + p.callAmount);
      if (p.note) bits.push(String(p.note));
      html += '<div class="anote">' + esc(bits.join(' · ')) + '</div>';
    }

    html += '<div class="arow">';
    for (var j = 0; j < moves.length; j += 1) {
      var mv = String(moves[j].move || moves[j].type || '');
      var label = moves[j].label || MOVE_LABEL[mv] || mv;
      if (mv === 'call' && p.callAmount != null) label += ' ' + p.callAmount;
      if (mv === 'raise') continue;
      html += '<button type="button" class="tbtn" data-act="bet" data-move="' + escAttr(mv) + '">' + esc(label) + '</button>';
    }
    html += '</div>';

    for (var k = 0; k < moves.length; k += 1) {
      var rmv = String(moves[k].move || moves[k].type || '');
      if (rmv !== 'raise') continue;
      var rmin = moves[k].min != null && isFinite(Number(moves[k].min)) ? Number(moves[k].min) : min;
      var rmax = moves[k].max != null && isFinite(Number(moves[k].max)) ? Number(moves[k].max) : max;
      var dv = draftOf('bet-amount');
      if (dv === undefined || dv === '') dv = rmin;
      html += '<div class="raise">'
        + '<input class="ainput ainput--num" id="bet-amount" type="number" step="1"'
        + ' min="' + escAttr(rmin) + '" max="' + escAttr(rmax) + '"'
        + ' value="' + escAttr(dv) + '" aria-label="加注金额">'
        + '<button type="button" class="tbtn tbtn--primary" data-act="bet-raise">' + esc(MOVE_LABEL.raise) + '</button>'
        + '<span class="anote">' + esc(rmin + ' – ' + rmax) + '</span>'
        + '</div>';
    }

    return html;
  }

  function cardIdOf(c) {
    if (c == null) return '';
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (typeof c === 'object') {
      if (c.id != null) return String(c.id);
      if (c.cardId != null) return String(c.cardId);
      if (c.key != null) return String(c.key);
      if (c.code != null) return String(c.code);
      if (c.label != null) return String(c.label);
    }
    return '';
  }

  function cardLabelOf(c) {
    if (c == null) return '';
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (typeof c === 'object') {
      if (c.label != null) return String(c.label);
      if (c.name != null) return String(c.name);
      if (c.rank != null && c.suit != null) return String(c.rank) + String(c.suit);
      return cardIdOf(c);
    }
    return String(c);
  }

  function isRedCard(c) {
    if (!c || typeof c !== 'object') return false;
    var s = String(c.color || c.suit || '').toLowerCase();
    return s === 'red' || s === 'r' || s.indexOf('♥') >= 0 || s.indexOf('♦') >= 0 || s.indexOf('红') >= 0;
  }

  function playCardHTML(payload) {
    var p = payload || {};
    var hand = Array.isArray(p.hand) ? p.hand : [];
    var legal = null;
    if (Array.isArray(p.legal)) {
      legal = p.legal.map(cardIdOf).filter(function (x) { return !!x; });
    }

    var html = '';
    if (!hand.length) {
      html += '<div class="anote">手牌为空，只能抽一张。</div>';
    } else {
      html += '<div class="cards">';
      for (var i = 0; i < hand.length; i += 1) {
        var c = hand[i];
        var id = cardIdOf(c);
        var ok = !legal || !legal.length || legal.indexOf(id) >= 0;
        html += '<button type="button" class="cardbtn' + (isRedCard(c) ? ' is-red' : '') + '"'
          + ' data-act="play" data-card="' + escAttr(id) + '"'
          + (ok ? '' : ' disabled') + '>' + esc(cardLabelOf(c)) + '</button>';
      }
      html += '</div>';
    }

    if (p.canDraw !== false) {
      html += '<div class="arow"><button type="button" class="tbtn tbtn--ink" data-act="draw">抽 一 张</button>'
        + (p.note ? '<span class="anote">' + esc(p.note) + '</span>' : '')
        + '</div>';
    } else if (p.note) {
      html += '<div class="anote">' + esc(p.note) + '</div>';
    }

    return html;
  }

  function challengeHTML(payload) {
    var p = payload || {};
    var who = p.claimerName || p.name || '';
    var html = '';
    if (who) html += '<div class="anote">' + esc(who + ' 给出了说法。') + '</div>';
    else if (p.note) html += '<div class="anote">' + esc(p.note) + '</div>';
    html += '<div class="arow">'
      + '<button type="button" class="tbtn tbtn--primary" data-act="challenge" data-value="1">接 受</button>'
      + '<button type="button" class="tbtn" data-act="challenge" data-value="0">质 疑</button>'
      + '</div>';
    return html;
  }

  function answerHTML(payload) {
    var p = payload || {};
    return '<div class="arow">'
      + '<button type="button" class="tbtn tbtn--primary" data-act="answer" data-value="bomb">是炸弹</button>'
      + '<button type="button" class="tbtn" data-act="answer" data-value="safe">不是炸弹</button>'
      + '</div>'
      + (p.note ? '<div class="anote">' + esc(p.note) + '</div>' : '');
  }

  function defuseHTML(payload) {
    var p = payload || {};
    return (p.note ? '<div class="anote">' + esc(p.note) + '</div>' : '')
      + '<div class="arow">'
      + '<button type="button" class="tbtn tbtn--primary" data-act="defuse" data-value="1">用拆弹钳</button>'
      + '<button type="button" class="tbtn" data-act="defuse" data-value="0">硬 扛</button>'
      + '</div>';
  }

  function verdictHTML(payload) {
    var p = payload || {};
    return (p.note ? '<div class="anote">' + esc(p.note) + '</div>' : '')
      + '<div class="arow">'
      + '<button type="button" class="tbtn tbtn--primary" data-act="verdict" data-value="trust">相 信</button>'
      + '<button type="button" class="tbtn" data-act="verdict" data-value="accuse">指 控</button>'
      + '</div>';
  }

  function fallbackHTML(ask) {
    return '<div class="anote">未识别的决策类型「' + esc(ask.kind || '?') + '」，已按自由文本处理。</div>'
      + freeHTML(ask.payload || {});
  }

  function askBodyHTML(ask) {
    var p = ask.payload || {};
    switch (ask.kind) {
      case 'free': return freeHTML(p);
      case 'declare': return declareHTML(p);
      case 'vote': return voteHTML(p, 'vote');
      case 'confirm': return confirmHTML(p);
      case 'multi-pick': return multiHTML(p);
      case 'bet': return betHTML(p);
      case 'play-card': return playCardHTML(p);
      case 'challenge': return challengeHTML(p);
      /* 旧牌桌兼容 */
      case 'draw':
        return '<div class="arow"><button type="button" class="tbtn tbtn--ink" data-act="draw">抽 一 张</button></div>';
      case 'answer': return answerHTML(p);
      case 'defuse': return defuseHTML(p);
      case 'pick-target': return voteHTML(p, 'pick-target');
      case 'verdict': return verdictHTML(p);
      default: return fallbackHTML(ask);
    }
  }

  function askPrompt(ask) {
    var p = ask.payload || {};
    var c = ask.context || {};
    return p.prompt || p.question || p.text || p.description
      || c.prompt || c.question
      || DEFAULT_ASK[ask.kind]
      || ('待决策：' + (ask.kind || '?'));
  }

  function setTimer(deadline) {
    var t = el('action-timer');
    var wrap = el('action-meter-wrap');
    if (!t) return;

    var d = Number(deadline) || 0;
    if (!d) {
      t.textContent = '';
      t.removeAttribute('data-deadline');
      t.removeAttribute('data-total');
      if (wrap) wrap.hidden = true;
      return;
    }

    var total = Number(S.state && S.state.askTimeoutMs) || 120000;
    t.setAttribute('data-deadline', String(d));
    t.setAttribute('data-total', String(total));
    if (wrap) wrap.hidden = false;
    updateTimers();
  }

  function renderAction(force) {
    var st = S.state || null;
    var ids = currentAskIds();
    var mine = !!S.myPid && ids.indexOf(S.myPid) >= 0;
    var ask = (S.ask && S.myPid && S.ask.playerId === S.myPid) ? S.ask : null;
    var canAct = !!token || MOCK;

    var secretKey = S.self && S.self.secret ? JSON.stringify(S.self.secret) : '';
    var sig = [
      st ? (st.status || '') : '',
      st ? (st.turnPlayerId || '') : '',
      ids.join(','),
      ask ? ask.id : '',
      ask ? ask.kind : '',
      ask ? JSON.stringify(ask.payload || null) : '',
      mine ? '1' : '0',
      S.submitted,
      S.busy ? '1' : '0',
      S.actionError,
      S.picks.join(','),
      S.pickMin + '/' + S.pickMax,
      canAct ? '1' : '0',
      S.myPid || '',
      S.hint || '',
      secretKey
    ].join('~');

    if (!force && sig === S.actionSig) {
      updateTimers();
      return;
    }
    S.actionSig = sig;

    captureDraft();

    if (ask && ask.id && ask.id !== S.lastAskId) {
      S.lastAskId = ask.id;
      S.formDraft = {};
      S.picks = [];
      S.pickAskId = ask.id;
      S.actionError = '';
      S.sayDraft = '';
      var si = el('say-input');
      if (si) si.value = '';
    }

    var actionBox = el('action');
    var kindEl = el('action-kind');
    var promptEl = el('action-prompt');
    var bodyEl = el('action-body');
    var sayWrap = el('say-wrap');
    var footEl = el('action-foot');
    if (!actionBox || !kindEl || !promptEl || !bodyEl || !footEl) return;

    var kind = ask ? ask.kind : (st && st.askKind) || '';
    var kindText = kind ? (KIND_LABEL[kind] || kind) : '待 命';
    var prompt = '';
    var bodyHTML = '';
    var foot = [];
    var showSay = false;
    var deadline = 0;
    var isMine = false;

    if (!st) {
      prompt = S.fatal || '正在接入牌局…';
      foot.push(S.fatal ? '' : '如果长时间没有反应，检查服务是否在运行。');
    } else if (!canAct) {
      prompt = ids.length
        ? ('等待 ' + ids.map(nameOf).join('、') + ' 行动（观战）')
        : '观战模式 · 只读';
      deadline = st.askDeadline;
      foot.push('没有 token，只能看不能动。顶部「我有 token」可粘贴后接入。');
    } else if (S.tokenInvalid) {
      prompt = 'token 无法识别';
      foot.push('服务端不认识这个 token。确认房间号与 token 是否匹配。');
    } else if (st.status === 'ended' || st.winner) {
      prompt = st.winner ? ('牌局结束 · ' + st.winner.name) : '牌局结束';
      foot.push('本局已经结束，记录仍可查看。');
    } else if (st.status === 'lobby') {
      prompt = '牌局还没开始';
      foot.push('已入座 ' + (st.filled != null ? st.filled : ((st.players || []).length)) + ' / ' + (st.seats || '?') + ' 人，等待房主开局。');
    } else if (mine) {
      isMine = true;
      if (S.submitted && (!ask || S.submitted === ask.id)) {
        prompt = '已提交，等待牌桌结算';
        foot.push('这一手已经交出去了，下一步会实时推过来。');
        deadline = ask ? ask.deadline : st.askDeadline;
      } else if (ask) {
        prompt = askPrompt(ask);
        bodyHTML = askBodyHTML(ask);
        deadline = ask.deadline || st.askDeadline;
        showSay = true;
        foot.push(S.busy ? '提交中…' : '提交后不可撤回；超时由系统代打。');
      } else {
        prompt = '正在获取决策内容…';
        deadline = st.askDeadline;
        foot.push('已轮到你了，正在向服务端取这一手的明细。');
        ensureMyAsk();
      }
    } else if (ids.length) {
      var names = ids.map(nameOf).join('、');
      prompt = '等待 ' + names + ' 行动';
      deadline = st.askDeadline;
      foot.push(ids.length > 1 ? '这一步有多人同时决策。' : '轮到别人，牌桌会自动刷新。');
    } else {
      prompt = st.status === 'playing' ? '牌桌结算中…' : '牌桌静默中';
      foot.push(st.status === 'playing' ? '没有待决策事项，等下一步。' : '等待牌桌推进。');
    }

    kindEl.textContent = isMine
      ? kindText
      : (kind ? (kindText + ' · 等待') : (ids.length ? '等待行动' : '待 命'));
    promptEl.textContent = prompt;
    bodyEl.innerHTML = bodyHTML;
    sayWrap.hidden = !showSay;
    actionBox.className = 'action' + (isMine ? ' is-mine' : '') + ((st && (st.status === 'ended' || st.winner)) ? ' is-ended' : '');
    actionBox.setAttribute('aria-busy', S.busy ? 'true' : 'false');

    if (S.busy) {
      var btns = bodyEl.querySelectorAll('button');
      for (var i = 0; i < btns.length; i += 1) btns[i].disabled = true;
    }

    var footHTML = '';
    if (S.actionError) footHTML += '<span class="err">' + esc(S.actionError) + '</span>';
    if (S.hint && !isMine) footHTML += '<span>' + esc(S.hint) + '</span>';
    for (var j = 0; j < foot.length; j += 1) {
      if (foot[j]) footHTML += '<span>' + esc(foot[j]) + '</span>';
    }
    footEl.innerHTML = footHTML;

    var thinkRow = el('say-wrap');
    if (thinkRow && showSay) {
      var si2 = el('say-input');
      if (si2 && si2.value !== S.sayDraft) si2.value = S.sayDraft;
    }

    setTimer(deadline);
  }

  function updateTimers() {
    var t = el('action-timer');
    if (!t) return;
    var d = Number(t.getAttribute('data-deadline')) || 0;
    var meter = el('action-meter');
    var wrap = el('action-meter-wrap');

    if (!d) {
      t.textContent = '';
      t.classList.remove('is-urgent');
      if (wrap) wrap.hidden = true;
      return;
    }

    var left = d - Date.now();
    if (left < 0) left = 0;
    t.textContent = left > 0 ? ('剩余 ' + fmtLeft(left)) : '已超时';
    t.classList.toggle('is-urgent', left > 0 && left <= 10000);

    var total = Number(t.getAttribute('data-total')) || 120000;
    if (meter) meter.style.width = (clampNum(left / total, 0, 1) * 100) + '%';
    if (wrap) wrap.hidden = false;
  }

  /* ---------------- 渲染：总入口 ---------------- */

  function render() {
    renderTop();
    renderRoster();
    renderTable();
    renderSelf();
    renderWinner();
    renderAction();
    renderLog();
    renderMode();
  }

  /* ---------------- 提交 ---------------- */

  function currentSay() {
    var input = el('say-input');
    if (input) S.sayDraft = input.value;
    return (S.sayDraft || '').trim();
  }

  function errorMsg(msg) {
    S.actionError = msg;
    renderAction(true);
    toast(msg);
  }

  function declareAction() {
    var box = el('action-body');
    if (!box) return null;

    var nodes = box.querySelectorAll('[data-field]');
    if (!nodes.length) {
      var ta = box.querySelector('#free-text');
      var text = ta ? ta.value.trim() : '';
      if (!text) { errorMsg('请先写下声明内容。'); return null; }
      return { type: 'declare', text: text };
    }

    var action = { type: 'declare' };
    var missing = '';
    var rangeErr = '';

    for (var i = 0; i < nodes.length; i += 1) {
      var n = nodes[i];
      var name = n.getAttribute('data-field');
      if (n.type === 'checkbox') {
        action[name] = !!n.checked;
        continue;
      }
      var raw = n.value.trim();
      if (raw === '') { missing = missing || name; continue; }

      if (n.type === 'number') {
        var num = Number(raw);
        if (!isFinite(num)) { missing = missing || name; continue; }
        var min = n.getAttribute('min');
        var max = n.getAttribute('max');
        if (min != null && min !== '' && num < Number(min)) rangeErr = name + ' 不能小于 ' + min;
        if (max != null && max !== '' && num > Number(max)) rangeErr = name + ' 不能大于 ' + max;
        action[name] = num;
      } else {
        action[name] = raw;
      }
    }

    if (rangeErr) { errorMsg(rangeErr); return null; }
    if (missing) { errorMsg('请填写「' + (FIELD_LABEL[missing] || missing) + '」。'); return null; }
    return action;
  }

  function betRaiseAction() {
    var input = el('bet-amount');
    if (!input) return null;
    var n = Number(input.value);
    var min = Number(input.getAttribute('min'));
    var max = Number(input.getAttribute('max'));

    if (!isFinite(n)) { errorMsg('加注金额需要是数字。'); return null; }
    if (isFinite(min) && n < min) { errorMsg('加注不能少于 ' + min + '。'); return null; }
    if (isFinite(max) && max > 0 && n > max) { errorMsg('加注不能超过 ' + max + '。'); return null; }

    return { type: 'bet', move: 'raise', amount: Math.round(n) };
  }

  function freeTextAction() {
    var ta = el('action-body') && el('action-body').querySelector('#free-text');
    var text = ta ? ta.value.trim() : '';
    if (!text) { errorMsg('请先输入内容。'); return null; }
    return { type: 'text', text: text };
  }

  async function submitAction(action) {
    if (!action) return;

    if (!token && !MOCK) {
      errorMsg('观战模式不能行动。');
      return;
    }
    if (!S.myPid) {
      errorMsg('还没确认你的玩家身份，稍等重连。');
      return;
    }
    if (S.busy) return;

    var say = currentSay();
    S.busy = true;
    S.actionError = '';
    renderAction(true);

    if (MOCK) {
      S.busy = false;
      S.submitted = S.ask ? S.ask.id : '';
      toast('演示数据：已记录 ' + JSON.stringify(action));
      renderAction(true);
      return;
    }

    var payload = { action: action };
    if (say) payload.say = say;

    var url = '/api/agent/' + encodeURIComponent(ROOM) + '/' + encodeURIComponent(token) + '/act';

    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });

      var j = null;
      try { j = await res.json(); } catch (e) { j = null; }

      if (!res.ok) {
        throw new Error((j && j.error) || ('提交失败（HTTP ' + res.status + '）'));
      }

      S.submitted = S.ask ? S.ask.id : '';
      S.sayDraft = '';
      var si = el('say-input');
      if (si) si.value = '';
      toast('已提交，等待牌桌结算。');
    } catch (err) {
      S.actionError = (err && err.message) ? err.message : '网络错误，未能提交。';
    } finally {
      S.busy = false;
      renderAction(true);
    }
  }

  function onActionClick(e) {
    var target = e.target;
    var btn = target && target.closest ? target.closest('button[data-act]') : null;
    if (!btn || btn.disabled) return;

    var act = btn.getAttribute('data-act');
    var val = btn.getAttribute('data-value');
    var key = btn.getAttribute('data-key');

    switch (act) {
      case 'vote':
        submitAction({ type: 'vote', targetId: btn.getAttribute('data-target') });
        break;
      case 'vote-approve': {
        var v = { type: 'vote' };
        v[key || 'approve'] = val === '1';
        submitAction(v);
        break;
      }
      case 'confirm':
        submitAction({ type: 'confirm', use: val === '1' });
        break;
      case 'challenge':
        submitAction({ type: 'challenge', accept: val === '1' });
        break;
      case 'pick': {
        var id = btn.getAttribute('data-target');
        var at = S.picks.indexOf(id);
        if (at >= 0) {
          S.picks.splice(at, 1);
        } else {
          if (S.picks.length >= S.pickMax) {
            toast('最多只能选 ' + S.pickMax + ' 个。');
            return;
          }
          S.picks.push(id);
        }
        renderAction(true);
        break;
      }
      case 'pick-many':
        if (S.picks.length < S.pickMin) {
          errorMsg('至少要选 ' + S.pickMin + ' 个。');
          return;
        }
        submitAction({ type: 'pick-many', ids: S.picks.slice() });
        break;
      case 'bet':
        submitAction({ type: 'bet', move: btn.getAttribute('data-move') });
        break;
      case 'bet-raise': {
        var raise = betRaiseAction();
        if (raise) submitAction(raise);
        break;
      }
      case 'play':
        submitAction({ type: 'play', cardId: btn.getAttribute('data-card') });
        break;
      case 'draw':
        submitAction({ type: 'draw' });
        break;
      case 'free-text': {
        var a1 = freeTextAction();
        if (a1) submitAction(a1);
        break;
      }
      case 'declare-text': {
        var a2 = declareAction();
        if (a2) submitAction(a2);
        break;
      }
      case 'declare': {
        var a3 = declareAction();
        if (a3) submitAction(a3);
        break;
      }
      /* 旧牌桌兼容 */
      case 'answer':
        submitAction({ type: 'answer', claim: val });
        break;
      case 'defuse':
        submitAction({ type: 'defuse', use: val === '1' });
        break;
      case 'pick-target':
        submitAction({ type: 'pick', targetId: btn.getAttribute('data-target') });
        break;
      case 'verdict':
        submitAction({ type: 'verdict', decision: val });
        break;
      default:
        break;
    }
  }

  /* ---------------- 身份切换 ---------------- */

  function adoptToken(value) {
    var v = String(value || '').trim();
    if (!v) { toast('请先粘贴 token。'); return; }

    token = v;
    writeLS(TOKEN_KEY, v);

    S.tokenInvalid = false;
    S.myPid = '';
    S.myName = '';
    S.self = null;
    S.state = null;
    S.ask = null;
    S.asks = {};
    S.submitted = '';
    S.actionError = '';
    S.actionSig = '';
    S.lastAskId = '';
    S.retry = 0;

    var input = el('token-input');
    if (input) input.value = '';

    closeSSE();
    if (S.retryTimer) {
      clearTimeout(S.retryTimer);
      S.retryTimer = null;
    }
    stopPolling();
    connectSSE();
    pollOnce();
    render();
    toast('已接入，正在确认身份。');
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    var form = el('token-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        adoptToken(el('token-input') ? el('token-input').value : '');
      });
    }

    var abortBtn = el('btn-abort');
    if (abortBtn) {
      var host = readLS('bt.host.' + ROOM);
      if (host) abortBtn.hidden = false;
      abortBtn.addEventListener('click', function () {
        if (!host) { toast('只有房主能强制结束', true); return; }
        if (!window.confirm('强制结束这局？所有玩家立刻停止，牌局无法继续。')) return;
        abortBtn.disabled = true;
        fetch('/api/rooms/' + encodeURIComponent(ROOM) + '/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Host-Token': host },
          body: JSON.stringify({ hostToken: host, reason: '房主手动结束' })
        }).then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, j: j }; });
        }).then(function (out) {
          if (!out.ok || out.j.ok === false) throw new Error(out.j.error || '请求失败');
          if (out.j.state) applyState(out.j.state);
          S.ask = null;
          S.submitted = '';
          render();
          toast('已强制结束本局');
        }).catch(function (e) {
          toast('强制结束失败：' + e.message, true);
        }).then(function () {
          abortBtn.disabled = false;
        });
      });
    }

    var body = el('action-body');
    if (body) body.addEventListener('click', onActionClick);

    var say = el('say-input');
    if (say) {
      say.addEventListener('input', function () { S.sayDraft = say.value; });
    }

    var log = el('log');
    if (log) {
      log.addEventListener('scroll', function () {
        S.logStick = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
      });
    }
  }

  /* ---------------- 演示数据 ---------------- */

  function mockState() {
    var now = Date.now();
    return {
      gameType: 'undercover',
      gameTitle: '谁是卧底 · 演示局',
      status: 'playing',
      phase: 'vote',
      round: 2,
      players: [
        {
          id: 'p1', name: '魏工', kind: 'human', glyph: '★', hue: 205,
          alive: true, handCount: 0, diceCount: 0, chips: 0,
          team: null, role: '平民', says: '我这个词，和日常有关。', connected: true
        },
        {
          id: 'p2', name: '沈默', kind: 'agent', glyph: '沈', hue: 32,
          alive: true, handCount: 0, diceCount: 0, chips: 0,
          team: 'red', role: null, says: '不好说，太具体就露了。', connected: true
        },
        {
          id: 'p3', name: '白露', kind: 'agent', glyph: '白', hue: 150,
          alive: false, hp: 0, maxHp: 2, handCount: 0, diceCount: 0, chips: 0,
          team: null, role: null, says: '', connected: true
        },
        {
          id: 'p4', name: '陆沉', kind: 'bot', glyph: '陆', hue: 270,
          alive: true, handCount: 0, diceCount: 0, chips: 0,
          team: 'blue', role: null, says: '我觉得沈默说得最含糊。', connected: false
        }
      ],
      turnPlayerId: 'p1',
      askPlayerIds: ['p1'],
      askPlayerId: 'p1',
      askKind: 'vote',
      askDeadline: now + 45000,
      table: {
        title: '第二轮 · 放逐投票',
        rows: [
          { label: '存活', value: '3 / 4' },
          { label: '本轮发言', value: '4 条' },
          { label: '线索词', value: '————' },
          { label: '当前阶段', value: '投票' }
        ],
        note: '得票最多者出局；平票则重投。'
      },
      log: [
        { at: now - 52000, text: '【系统】第二轮开始，进入放逐投票。', t: 'system' },
        { at: now - 30000, text: '沈默：不好说，太具体就露了。', t: 'say', playerId: 'p2' },
        { at: now - 12000, text: '【系统】白露已被放逐。', t: 'system' }
      ],
      winner: null,
      seats: 4,
      filled: 4,
      askTimeoutMs: 60000
    };
  }

  function mockAsk() {
    return {
      id: 'mock-a1',
      playerId: 'p1',
      kind: 'vote',
      deadline: Date.now() + 45000,
      payload: {
        prompt: '投票放逐一名玩家；也可以先听一轮再投。',
        candidates: ['p2', 'p4']
      },
      context: {}
    };
  }

  function startMock() {
    var st = mockState();
    S.myPid = 'p1';
    S.myName = '魏工';
    S.self = {
      id: 'p1', name: '魏工', kind: 'human', role: '平民', team: null,
      alive: true, hand: ['豆浆'], dice: [], chips: 0,
      secret: { word: '豆浆', isSpy: false }
    };
    mergeStateLog(st.log);
    S.state = st;
    S.ask = mockAsk();
    S.hint = '';
    render();
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    bind();
    setInterval(updateTimers, 500);

    if (MOCK) {
      startMock();
      return;
    }

    if (!ROOM) {
      S.fatal = '地址里缺少房间号。';
      render();
      return;
    }

    render();
    connectSSE();
    if (token) pollOnce();
  }

  boot();
})();
