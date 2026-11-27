'use client';

/* ============================================================
   通用牌桌（观战 / 人类操作）
   - 1s 轮询 /api/rooms/:id/events 增量事件 + PublicState
   - 2s 轮询 /api/agent/:id/:token 拿 you / ask
   - #fx-stage 协议：chip/card/bid/vote/stamp/clue/phase/end
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react';

/* ---------------- 常量 ---------------- */

const KIND_LABEL = {
  free: '自由发言',
  declare: '公开声明',
  vote: '投票',
  confirm: '确认',
  'multi-pick': '多人挑选',
  bet: '下注',
  'play-card': '出牌',
  challenge: '质疑',
  draw: '抽牌',
  answer: '回答',
  defuse: '拆弹',
  'pick-target': '指定目标',
  verdict: '裁决',
};

const DEFAULT_ASK = {
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
  verdict: '信，还是当场指控？',
};

const MOVE_LABEL = {
  fold: '弃 牌',
  check: '过 牌',
  call: '跟 注',
  raise: '加 注',
  allin: '全 下',
  bet: '下 注',
};

const FIELD_LABEL = {
  count: '数量',
  face: '点数',
  wild: '含 1 点 / 万能',
  word: '词语',
  number: '数字',
  name: '名称',
  target: '目标',
  amount: '金额',
  value: '数值',
};

const SECRET_LABEL = {
  topCard: '牌堆顶',
  word: '你的词',
  isSpy: '卧底',
  role: '身份',
  team: '阵营',
  count: '数量',
  face: '点数',
};

const PHASE_LABEL = {
  lobby: '候场',
  night: '夜晚',
  day: '白天',
  vote: '投票',
  ended: '结束',
};

const STATUS_LABEL = { lobby: '组局中', playing: '进行中', ended: '已结束' };

const KIND_TEXT = { human: '真人', agent: '代理', bot: '代打' };

const LOG_TAG = {
  say: '发言',
  thought: '思考',
  timeout: '超时',
  error: '错误',
  reveal: '揭示',
  ask: '决策',
  'ask-wait': '等待',
  system: '记录',
};

const TEAM_CLASS = {
  red: 'tag--red',
  blue: 'tag--blue',
  good: 'tag--good',
  evil: 'tag--evil',
  wolf: 'tag--evil',
  village: 'tag--good',
  merlin: 'tag--good',
  spy: 'tag--red',
  neutral: 'tag--gold',
};

const FX_LABELS = {
  chip: '下 注',
  card: '出 牌',
  bid: '叫 点',
  vote: '表 决',
  stamp: '揭 示',
  clue: '线 索',
  phase: '阶 段',
  end: '终 局',
};

const FX_GLYPH = {
  chip: '●',
  card: '▣',
  bid: '#',
  vote: '▤',
  stamp: '印',
  clue: '词',
  phase: '—',
  end: '★',
};

const DIE_MAP = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const BRANDS = {
  deepseek: { name: 'DeepSeek', color: '#4D6BFE' },
  openai: { name: 'OpenAI', color: '#10A37F' },
  claude: { name: 'Claude', color: '#D97757' },
  qwen: { name: 'Qwen', color: '#615CED' },
  gemini: { name: 'Gemini', color: '#4285F4' },
  glm: { name: 'GLM', color: '#3B5BDB' },
  moonshot: { name: 'Moonshot', color: '#1A1A1A' },
  doubao: { name: 'Doubao', color: '#3B82F6' },
  hunyuan: { name: 'Hunyuan', color: '#0052D9' },
  ollama: { name: 'Ollama', color: '#F5A623' },
  unknown: { name: 'AI', color: '#6B6455' },
};

/* ---------------- 小工具 ---------------- */

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function clock(ts) {
  const d = new Date(ts || Date.now());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtLeft(ms) {
  if (ms <= 0) return '已超时';
  if (ms >= 60000) return Math.floor(ms / 60000) + ':' + pad2(Math.floor((ms % 60000) / 1000));
  return Math.ceil(ms / 1000) + 's';
}

function fmtVal(v) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.map(fmtVal).join(' · ');
  if (typeof v === 'object') {
    return Object.keys(v)
      .map((k) => {
        const val = v[k];
        if (val === true) return k + ' 是';
        if (val === false) return k + ' 否';
        return k + ' ' + fmtVal(val);
      })
      .join(' · ');
  }
  if (v === true) return '是';
  if (v === false) return '否';
  return String(v);
}

function hueOf(p) {
  const n = Number(p && p.hue);
  if (!isFinite(n)) return 205;
  return Math.round(((n % 360) + 360) % 360);
}

function safeGlyph(p) {
  const g = p && p.glyph ? String(p.glyph) : '';
  if (g && g.length <= 2 && !/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u.test(g)) return g;
  const name = String((p && p.name) || '?');
  return name.slice(0, 1).toUpperCase();
}

function glyphFor(v) {
  const s = String(v || '?').trim();
  return s.slice(0, 1).toUpperCase() || '?';
}

function teamLabel(team) {
  if (!team) return '';
  const map = {
    red: '红队',
    blue: '蓝队',
    good: '好人',
    evil: '恶人',
    wolf: '狼人',
    village: '村民',
    merlin: '梅林',
    spy: '卧底',
    neutral: '中立',
  };
  return map[team] || String(team);
}

function phaseLabel(p) {
  if (!p) return '—';
  return PHASE_LABEL[p] || String(p);
}

function askIdsOf(st) {
  if (!st) return [];
  if (Array.isArray(st.askPlayerIds) && st.askPlayerIds.length) return st.askPlayerIds;
  return st.askPlayerId ? [st.askPlayerId] : [];
}

function brandOfPlayer(p) {
  if (!p || p.kind === 'human') return null;
  if (p.brand && p.brand !== 'unknown' && BRANDS[p.brand]) return BRANDS[p.brand];
  const m = String(p.model || '').toLowerCase();
  if (!m) return null;
  if (m.includes('deepseek')) return BRANDS.deepseek;
  if (m.includes('claude') || m.includes('anthropic')) return BRANDS.claude;
  if (m.includes('qwen') || m.includes('tongyi')) return BRANDS.qwen;
  if (m.includes('gemini')) return BRANDS.gemini;
  if (m.includes('glm') || m.includes('zhipu')) return BRANDS.glm;
  if (m.includes('moonshot') || m.includes('kimi')) return BRANDS.moonshot;
  if (m.includes('doubao') || m.includes('seed')) return BRANDS.doubao;
  if (m.includes('hunyuan')) return BRANDS.hunyuan;
  if (m.includes('llama') || m.includes('ollama') || m.includes('mistral')) return BRANDS.ollama;
  if (m.includes('gpt') || m.includes('openai')) return BRANDS.openai;
  return BRANDS.unknown;
}

function readLS(key) {
  try {
    return window.localStorage.getItem(key) || '';
  } catch (e) {
    return '';
  }
}

function writeLS(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    /* ignore */
  }
}

function blankDraft() {
  return { fields: {}, text: '', picks: [], bet: '', mode: '' };
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
  const s = String(c.color || c.suit || '').toLowerCase();
  return s === 'red' || s === 'r' || s.indexOf('♥') >= 0 || s.indexOf('♦') >= 0 || s.indexOf('红') >= 0;
}

/* ---------------- 打字机 ---------------- */

function Typewriter({ text }) {
  const full = String(text || '');
  const prevRef = useRef('');
  const [shown, setShown] = useState(0);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', on);
    };
  }, []);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = full;
    if (reduce) {
      setShown(full.length);
      return;
    }
    if (prev && full.startsWith(prev)) {
      setShown((s) => Math.min(s, full.length));
    } else {
      setShown(0);
    }
  }, [full, reduce]);

  useEffect(() => {
    if (reduce || shown >= full.length) return undefined;
    const id = setTimeout(() => {
      setShown((s) => Math.min(full.length, s + 2));
    }, 24);
    return () => clearTimeout(id);
  }, [shown, full, reduce]);

  return (
    <span>
      {full.slice(0, shown)}
      {shown < full.length ? <i className="tw-cursor" /> : null}
    </span>
  );
}

/* ---------------- 组件 ---------------- */

export default function TableClient({ roomId }) {
  const [token, setToken] = useState('');
  const [hostToken, setHostToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const tokenRef = useRef('');
  const hostRef = useRef('');

  const [pub, setPub] = useState(null);
  const pubRef = useRef(null);

  const [self, setSelf] = useState(null);
  const selfRef = useRef(null);

  const [myPid, setMyPid] = useState('');
  const myPidRef = useRef('');

  const [ask, setAsk] = useState(null);
  const askRef = useRef(null);

  const [hint, setHint] = useState('');
  const [connected, setConnected] = useState(false);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const [logs, setLogs] = useState([]);
  const logKeysRef = useRef(new Set());
  const logBoxRef = useRef(null);
  const logStickRef = useRef(true);

  const [think, setThink] = useState({});
  const thinkRef = useRef({});

  const [fx, setFx] = useState(null);
  const fxRef = useRef(null);
  const [dice, setDice] = useState(null);

  const maxSeqRef = useRef(0);

  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(blankDraft);
  const [say, setSay] = useState('');

  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef(null);
  const [now, setNow] = useState(0);

  /* ---------- 基础副作用 ---------- */

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const showToast = useCallback((msg) => {
    setToastMsg(String(msg || ''));
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2600);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // 身份：localStorage 优先，URL ?token= 覆盖并写回
  useEffect(() => {
    let t = '';
    let h = '';
    try {
      const sp = new URLSearchParams(window.location.search);
      const urlToken = sp.get('token') || '';
      const stored = window.localStorage.getItem('bt_token_' + roomId) || '';
      t = urlToken || stored || '';
      if (urlToken) window.localStorage.setItem('bt_token_' + roomId, urlToken);
      h =
        window.localStorage.getItem('bt_host_' + roomId) ||
        window.localStorage.getItem('bt.host.' + roomId) ||
        '';
    } catch (e) {
      /* ignore */
    }
    tokenRef.current = t;
    setToken(t);
    hostRef.current = h;
    setHostToken(h);
  }, [roomId]);

  /* ---------- 日志 ---------- */

  const addLog = useCallback((ev) => {
    const text = ev && ev.text != null ? String(ev.text) : '';
    if (!text) return;
    const at = Number(ev.at) || Date.now();
    const key = Math.floor(at / 1000) + '|' + text;
    if (logKeysRef.current.has(key)) return;
    logKeysRef.current.add(key);
    setLogs((prev) => {
      const next = prev.concat([
        { key, at, text, t: ev.t || 'system', playerId: ev.playerId || null },
      ]);
      return next.length > 260 ? next.slice(next.length - 260) : next;
    });
  }, []);

  /* ---------- 状态应用 ---------- */

  const applyState = useCallback(
    (st) => {
      if (!st || typeof st !== 'object') return;
      const prev = pubRef.current;
      if (prev && (prev.round !== st.round || prev.phase !== st.phase)) {
        thinkRef.current = {};
        setThink({});
      }
      pubRef.current = st;
      setPub(st);

      if (Array.isArray(st.log)) {
        for (let i = 0; i < st.log.length; i += 1) {
          const item = st.log[i];
          if (typeof item === 'string') addLog({ text: item });
          else addLog(item);
        }
      }

      const ids = askIdsOf(st);
      const mine = !!myPidRef.current && ids.indexOf(myPidRef.current) >= 0;
      const a = askRef.current;
      if (st.status === 'ended') {
        askRef.current = null;
        setAsk(null);
      } else if (a && a.deadline && Number(a.deadline) < Date.now() - 5000) {
        askRef.current = null;
        setAsk(null);
      } else if (ids.length && !mine) {
        askRef.current = null;
        setAsk(null);
      }
    },
    [addLog]
  );

  /* ---------- 事件处理 ---------- */

  const applyEvent = useCallback(
    (ev) => {
      if (!ev || typeof ev !== 'object') return;

      // 兼容两种事件形状：{seq,t,...payload} 与 {seq,type,payload:{...}}
      const e =
        ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload)
          ? Object.assign({}, ev.payload, ev)
          : Object.assign({}, ev);
      if (!e.t && e.type) e.t = e.type;

      // 特效
      const fxObj = e.fx;
      if (fxObj && FX_LABELS[fxObj.kind]) {
        if (!(fxObj.kind === 'phase' && !e.text)) {
          setFx({ key: String(e.seq || '') + '-' + Date.now(), kind: fxObj.kind, text: String(e.text || '') });
        }
      }

      // 大话骰：摇盅 / 开盅
      const gameType = pubRef.current && pubRef.current.gameType;
      if (gameType === 'liars-dice') {
        if (e.t === 'roll') {
          const total = Math.max(1, Math.min(12, Number(e.total) || 5));
          setDice({ mode: 'roll', total });
        } else if (e.t === 'open' && e.dice) {
          setDice({ mode: 'open', dice: e.dice, bid: e.bid || {} });
        }
      }

      // 思考分段
      if (e.t === 'thought' && e.playerId && e.delta) {
        const pid = e.playerId;
        let next = (thinkRef.current[pid] || '') + String(e.delta);
        if (next.length > 600) next = next.slice(-600);
        thinkRef.current = Object.assign({}, thinkRef.current, { [pid]: next });
        setThink(thinkRef.current);
      }

      if (e.t === 'thought-end' && e.playerId) {
        const pid = e.playerId;
        const whole = String(thinkRef.current[pid] || '').trim();
        const copy = Object.assign({}, thinkRef.current);
        delete copy[pid];
        thinkRef.current = copy;
        setThink(copy);
        if (whole) {
          addLog({ t: 'thought', playerId: pid, text: '心想：' + whole, at: e.at || Date.now() });
        }
      }

      // 我的 ask
      if (e.ask || e.asks) {
        const list = e.asks || (e.ask ? [e.ask] : []);
        for (let i = 0; i < list.length; i += 1) {
          const a = list[i];
          if (!a || !a.id) continue;
          if (a.deadline && Number(a.deadline) < Date.now() - 2000) continue;
          if (myPidRef.current && a.playerId === myPidRef.current) {
            if (!askRef.current || askRef.current.id !== a.id) {
              askRef.current = a;
              setAsk(a);
            }
          }
        }
      }

      if (e.text) addLog(e);

      if (e.t === 'state' && e.state) applyState(e.state);
    },
    [addLog, applyState]
  );

  const handleEvents = useCallback(
    (data) => {
      // 先落 state，事件里的游戏类型（骰子动画）与玩家名才能解析
      if (data && data.state) applyState(data.state);

      const evs = Array.isArray(data && data.events) ? data.events : [];
      let seq = maxSeqRef.current;
      for (let i = 0; i < evs.length; i += 1) {
        const ev = evs[i];
        const s = Number(ev && ev.seq);
        if (isFinite(s) && s > seq) seq = s;
        applyEvent(ev);
      }
      const top = Number(data && data.maxSeq);
      if (isFinite(top) && top > seq) seq = top;
      if (seq > maxSeqRef.current) maxSeqRef.current = seq;
    },
    [applyEvent, applyState]
  );

  /* ---------- 轮询：事件流（1s，页面隐藏暂停） ---------- */

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let fails = 0;
    let running = false;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, 1000);
        return;
      }
      if (running) return;
      running = true;
      try {
        const qs = new URLSearchParams();
        qs.set('since', String(maxSeqRef.current || 0));
        if (tokenRef.current) qs.set('token', tokenRef.current);
        const res = await fetch(
          '/api/rooms/' + encodeURIComponent(roomId) + '/events?' + qs.toString(),
          { cache: 'no-store', headers: { Accept: 'application/json' } }
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (cancelled) return;
        fails = 0;
        setConnected(true);
        setReconnecting(false);
        handleEvents(data || {});
      } catch (e) {
        if (!cancelled) {
          fails += 1;
          setConnected(false);
          setReconnecting(true);
        }
      } finally {
        running = false;
        if (!cancelled) {
          const delay = fails ? Math.min(8000, 1000 * Math.pow(1.7, Math.min(fails - 1, 4))) : 1000;
          timer = setTimeout(tick, delay);
        }
      }
    };

    tick();

    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (!document.hidden) {
        clearTimeout(timer);
        if (!running) tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [roomId, token, handleEvents]);

  /* ---------- 轮询：身份与 ask（2s） ---------- */

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    let timer = null;
    let stopped = false;
    let running = false;

    const tick = async () => {
      if (cancelled || stopped || running) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, 2000);
        return;
      }
      running = true;
      try {
        const res = await fetch(
          '/api/agent/' + encodeURIComponent(roomId) + '/' + encodeURIComponent(token),
          { cache: 'no-store', headers: { Accept: 'application/json' } }
        );
        const j = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.status === 403) {
          stopped = true;
          setTokenInvalid(true);
          return;
        }
        if (!res.ok) return;
        setTokenInvalid(false);

        if (j && j.you && j.you.id) {
          selfRef.current = j.you;
          setSelf(j.you);
          if (myPidRef.current !== j.you.id) {
            myPidRef.current = j.you.id;
            setMyPid(j.you.id);
          }
        }
        if (j && j.hint) setHint(String(j.hint));

        if (j && j.ask && j.ask.id) {
          const a = j.ask;
          const expired = a.deadline && Number(a.deadline) < Date.now() - 2000;
          if (!expired && (!myPidRef.current || a.playerId === myPidRef.current)) {
            askRef.current = a;
            setAsk(a);
          }
        } else if (j && j.ask === null) {
          const ids = pubRef.current ? askIdsOf(pubRef.current) : [];
          if (ids.length && myPidRef.current && ids.indexOf(myPidRef.current) < 0) {
            askRef.current = null;
            setAsk(null);
          }
        }

        if (j && j.state && !pubRef.current) applyState(j.state);
      } catch (e) {
        /* 网络错误：等下一次 */
      } finally {
        running = false;
        if (!cancelled && !stopped) timer = setTimeout(tick, 2000);
      }
    };

    tick();
    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (!document.hidden && !cancelled && !stopped) {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [roomId, token, applyState]);

  /* ---------- ask 切换时重置表单 ---------- */

  const askId = ask && ask.id;

  useEffect(() => {
    setSubmitted('');
    setError('');
    setDraft(blankDraft());
    setSay('');
  }, [askId]);

  /* ---------- 特效 / 骰子自动收场 ---------- */

  useEffect(() => {
    if (!fx) return undefined;
    const id = setTimeout(() => setFx(null), fx.kind === 'end' ? 3600 : 2400);
    return () => clearTimeout(id);
  }, [fx]);

  useEffect(() => {
    const el = fxRef.current;
    if (!el || !fx) return;
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      el.animate(
        [
          { opacity: 0, transform: 'translateY(-6px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 220, easing: 'ease-out' }
      );
    } catch (e) {
      /* ignore */
    }
  }, [fx]);

  useEffect(() => {
    if (!dice) return undefined;
    const id = setTimeout(() => setDice(null), dice.mode === 'open' ? 4500 : 1300);
    return () => clearTimeout(id);
  }, [dice]);

  /* ---------- 日志滚动 ---------- */

  useEffect(() => {
    const box = logBoxRef.current;
    if (box && logStickRef.current) box.scrollTop = box.scrollHeight;
  }, [logs]);

  const onLogScroll = () => {
    const box = logBoxRef.current;
    if (!box) return;
    logStickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  };

  /* ---------- 提交 ---------- */

  const submit = async (action) => {
    if (!action) return;
    if (!tokenRef.current) {
      setError('观战模式不能行动。');
      return;
    }
    if (!myPidRef.current) {
      setError('还没确认你的玩家身份，稍等重连。');
      return;
    }
    if (busy) return;

    const payload = { action };
    const s = say.trim();
    if (s) payload.say = s;

    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        '/api/agent/' +
          encodeURIComponent(roomId) +
          '/' +
          encodeURIComponent(tokenRef.current) +
          '/act',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const j = await res.json().catch(() => null);
      if (!res.ok || (j && j.ok === false)) {
        throw new Error((j && j.error) || '提交失败（HTTP ' + res.status + '）');
      }
      setSubmitted(askRef.current ? askRef.current.id : '');
      setSay('');
      setDraft(blankDraft());
      showToast('已提交，等待牌桌结算。');
    } catch (e) {
      const msg = (e && e.message) || '网络错误，未能提交。';
      setError(msg);
      showToast(msg);
    } finally {
      setBusy(false);
    }
  };

  const adoptToken = (value) => {
    const v = String(value || '').trim();
    if (!v) {
      showToast('请先粘贴 token。');
      return;
    }
    writeLS('bt_token_' + roomId, v);
    tokenRef.current = v;
    setToken(v);
    setTokenInput('');
    maxSeqRef.current = 0;
    pubRef.current = null;
    setPub(null);
    askRef.current = null;
    setAsk(null);
    selfRef.current = null;
    setSelf(null);
    myPidRef.current = '';
    setMyPid('');
    setTokenInvalid(false);
    logKeysRef.current = new Set();
    setLogs([]);
    thinkRef.current = {};
    setThink({});
    setSubmitted('');
    setError('');
    setDraft(blankDraft());
    setSay('');
    showToast('已接入，正在确认身份。');
  };

  const copyInvite = async () => {
    if (typeof window === 'undefined') return;
    const url = window.location.origin + '/join/' + roomId;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        showToast('已复制 AI 接入地址：' + url);
        return;
      }
    } catch (e) {
      /* fallthrough */
    }
    showToast('复制失败，请手动复制：' + url);
  };

  const abortRoom = async () => {
    const host = hostRef.current;
    if (!host) {
      showToast('只有房主能强制结束');
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm('强制结束这局？所有玩家立刻停止，牌局无法继续。')) {
      return;
    }
    try {
      const res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Host-Token': host },
        body: JSON.stringify({ hostToken: host, reason: '房主手动结束' }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || (j && j.ok === false)) throw new Error((j && j.error) || '请求失败');
      if (j && j.state) applyState(j.state);
      askRef.current = null;
      setAsk(null);
      setSubmitted('');
      showToast('已强制结束本局');
    } catch (e) {
      showToast('强制结束失败：' + ((e && e.message) || '网络错误'));
    }
  };

  /* ---------- 派生数据 ---------- */

  const st = pub || {};
  const players = Array.isArray(st.players) ? st.players : [];
  const ids = askIdsOf(st);
  const isMine = !!myPid && ids.indexOf(myPid) >= 0;
  const myAsk = ask && myPid && ask.playerId === myPid ? ask : null;
  const status = st.status || 'lobby';
  const ended = status === 'ended' || !!st.winner;
  const filled = st.filled != null ? st.filled : players.length;
  const seats = st.seats != null ? st.seats : '?';

  const playerOf = (id) => {
    for (let i = 0; i < players.length; i += 1) if (players[i].id === id) return players[i];
    return null;
  };
  const nameOf = (id) => {
    const p = playerOf(id);
    return p ? p.name : String(id || '?');
  };

  const choiceInfo = (c) => {
    let id = '';
    let label = '';
    let meta = '';
    let glyph = '';
    if (typeof c === 'string' || typeof c === 'number') {
      id = String(c);
      const pl = playerOf(id);
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
      id = String(c.id != null ? c.id : c.playerId != null ? c.playerId : c.value != null ? c.value : '');
      const pl = id ? playerOf(id) : null;
      label = c.name || c.label || (pl ? pl.name : id) || '?';
      meta = c.meta || c.description || '';
      if (!meta && pl) meta = (KIND_TEXT[pl.kind] || '') + ' · ' + (pl.alive === false ? '出局' : '在场');
      glyph = c.glyph || (pl ? safeGlyph(pl) : glyphFor(label));
    }
    // 密码名牌：候选项是词卡 id，用公开词表换成可读词
    if (id && !playerOf(id) && Array.isArray(st.words)) {
      const w = st.words.find((x) => x && String(x.id) === id);
      if (w && w.word) {
        label = String(w.word);
        meta = w.revealed ? '已翻开 · ' + String(w.revealed) : '词卡';
        glyph = glyphFor(label);
      }
    }
    return { id, label, meta, glyph };
  };

  const candidatesOf = (p) => {
    if (!p) return [];
    if (Array.isArray(p.candidates)) return p.candidates;
    if (Array.isArray(p.options)) return p.options;
    return [];
  };

  const secretText = (secret) => {
    if (secret == null) return '';
    const one = (k, v) => {
      const label = SECRET_LABEL[k] || k;
      let val;
      if (v === true) val = '是';
      else if (v === false) val = '否';
      else if (v === 'bomb') val = '炸弹';
      else if (v === 'safe') val = '安全';
      else if (v && typeof v === 'object') val = fmtVal(v);
      else val = String(v);
      return label + ' · ' + val;
    };
    if (typeof secret === 'object' && !Array.isArray(secret)) {
      return Object.keys(secret)
        .map((k) => one(k, secret[k]))
        .join('　');
    }
    return fmtVal(secret);
  };

  /* ---------- 渲染：玩家 ---------- */

  const rosterCard = (p) => {
    const isAsk = ids.indexOf(p.id) >= 0;
    const isCurrent = st.turnPlayerId === p.id;
    const isDead = p.alive === false;
    const isOff = p.connected === false;
    const mine = myPid && p.id === myPid;
    const brand = brandOfPlayer(p);

    let cls = 'pcard';
    if (isAsk) cls += ' is-ask';
    if (isCurrent) cls += ' is-current';
    if (isDead) cls += ' is-dead';
    if (isOff) cls += ' is-off';
    if (mine) cls += ' is-you';

    const stats = [];
    if (p.hp != null) {
      const maxHp = p.maxHp != null ? Number(p.maxHp) : Number(p.hp);
      const hp = Number(p.hp) || 0;
      const dots = [];
      for (let i = 0; i < Math.max(maxHp, hp); i += 1) {
        dots.push(<i key={i} className={'hp__dot' + (i < hp ? ' is-on' : '')} />);
      }
      stats.push(
        <span className="hp" title={'生命 ' + hp + '/' + maxHp} key="hp">
          {dots}
        </span>
      );
    }
    if (p.handCount != null) stats.push(<span key="hand">手牌 {Number(p.handCount)}</span>);
    if (p.diceCount != null) stats.push(<span key="dice">骰 {Number(p.diceCount)}</span>);
    if (p.chips != null) stats.push(<span key="chips">筹码 {Number(p.chips)}</span>);

    return (
      <div className={cls} style={{ '--hue': String(hueOf(p)) }} key={p.id}>
        <div className="pcard__top">
          <span className="pcard__glyph">{safeGlyph(p)}</span>
          <span className="online-dot" data-on={p.connected === false ? 'off' : 'on'} aria-hidden="true" />
          <span className="pcard__name">{p.name || '无名'}</span>
          {mine ? <span className="pcard__you">你</span> : null}
          <span className="pcard__kind">{KIND_TEXT[p.kind] || p.kind || '?'}</span>
        </div>

        <div className="pcard__tags">
          {brand ? (
            <span className="brandbadge" style={{ color: brand.color, borderColor: brand.color }}>
              {brand.name}
            </span>
          ) : null}
          {p.team ? <span className={'tag ' + (TEAM_CLASS[p.team] || '')}>{teamLabel(p.team)}</span> : null}
          {p.role ? <span className="tag tag--gold">{p.role}</span> : null}
          {isCurrent ? <span className="tag tag--live">行动中</span> : null}
          {isAsk && !isCurrent ? <span className="tag tag--live">待决策</span> : null}
          {isDead ? <span className="tag tag--mute">出局</span> : null}
          {p.folded ? <span className="tag tag--mute">已弃牌</span> : null}
          {p.caught ? <span className="tag tag--mute">被识破</span> : null}
          {isOff ? <span className="tag tag--mute">离线</span> : null}
        </div>

        {stats.length ? <div className="pcard__stats">{stats}</div> : null}
        {p.says ? <div className="pcard__say">{p.says}</div> : null}
        {think[p.id] ? (
          <div className="pcard__think">
            <Typewriter text={think[p.id]} />
          </div>
        ) : null}
      </div>
    );
  };

  /* ---------- 渲染：桌面 ---------- */

  const stageRows = (() => {
    const rows = st.table && Array.isArray(st.table.rows) ? st.table.rows : [];
    if (rows.length) return rows;
    const out = [];
    if (st.deckLeft != null) out.push({ label: '牌堆剩余', value: st.deckLeft });
    if (st.bombsLeft != null) out.push({ label: '炸弹剩余', value: st.bombsLeft });
    if (st.deck != null) out.push({ label: '牌堆', value: st.deck });
    if (st.table && st.table.deck != null) out.push({ label: '牌堆', value: st.table.deck });
    if (players.length) {
      const alive = players.filter((p) => p.alive !== false).length;
      out.push({ label: '存活', value: alive + ' / ' + players.length });
    }
    // 无 table.rows 时按游戏类型给出最小兜底
    const diceBits = players.filter((p) => p.diceCount != null).map((p) => p.name + ' ' + p.diceCount);
    if (diceBits.length) out.push({ label: '骰子', value: diceBits.join(' · ') });
    const handBits = players.filter((p) => p.handCount != null).map((p) => p.name + ' ' + p.handCount);
    if (handBits.length) out.push({ label: '手牌', value: handBits.join(' · ') });
    const chipBits = players.filter((p) => p.chips != null).map((p) => p.name + ' ' + p.chips);
    if (chipBits.length) out.push({ label: '筹码', value: chipBits.join(' · ') });
    if (st.phase) out.push({ label: '阶段', value: phaseLabel(st.phase) });
    if (st.turnPlayerId) out.push({ label: '当前行动', value: nameOf(st.turnPlayerId) });
    return out;
  })();

  const renderDie = (face, cls, key) => {
    const on = DIE_MAP[Number(face)] || [];
    const pips = [];
    for (let i = 0; i < 9; i += 1) {
      pips.push(<i key={i} className={'die__pip' + (on.indexOf(i) >= 0 ? ' is-on' : '')} />);
    }
    return (
      <span className={'die ' + (cls || '')} key={key}>
        {pips}
      </span>
    );
  };

  const bidText = (b) => {
    if (!b || !b.count) return '无叫点';
    const cn = ['', '一', '二', '三', '四', '五', '六'][Number(b.face)] || String(b.face);
    return b.count + ' 个 ' + cn + (b.wild ? '' : '（斋）');
  };

  const diceStage = (() => {
    if (!dice) return null;
    if (dice.mode === 'roll') {
      const list = [];
      for (let i = 0; i < dice.total; i += 1) list.push(renderDie(1 + (i % 6), 'die--roll', i));
      return (
        <div className="dice-stage" id="dice-stage">
          <div className="dice-stage__kicker">骰 盅 摇 动</div>
          <div className="dice-stage__row">{list}</div>
        </div>
      );
    }
    const keys = Object.keys(dice.dice || {});
    const bid = dice.bid || {};
    return (
      <div className="dice-stage" id="dice-stage">
        <div className="dice-stage__kicker">开 盅 · {bidText(bid)}</div>
        {keys.map((pid) => {
          const faces = dice.dice[pid] || [];
          return (
            <div className="dice-stage__group" key={pid}>
              <div className="dice-stage__label">{nameOf(pid)}</div>
              <div className="dice-stage__row">
                {faces.map((f, i) => {
                  const face = Number(f);
                  const hit = Number(bid.face) > 0 && (face === Number(bid.face) || (bid.wild && face === 1));
                  return renderDie(face, 'die--land' + (hit ? ' die--hit' : ''), i);
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  })();

  /* ---------- 渲染：操作区 ---------- */

  const blocked = busy || (myAsk != null && submitted === myAsk.id);

  const choiceBtn = (c, onClick, selected) => {
    const info = choiceInfo(c);
    if (!info.id) return null;
    return (
      <button
        type="button"
        className={'choice' + (selected ? ' is-on' : '')}
        key={info.id}
        onClick={onClick}
        disabled={blocked}
      >
        <span className="choice__glyph">{info.glyph}</span>
        <span className="choice__main">
          <b>{info.label}</b>
          {info.meta ? <em>{info.meta}</em> : null}
        </span>
      </button>
    );
  };

  const declareFields = (p) => {
    const f = p && p.fields;
    if (Array.isArray(f)) return f.slice();
    if (f && typeof f === 'object') {
      return Object.keys(f).map((k) => {
        const d = f[k];
        if (d && typeof d === 'object') {
          return Object.assign({}, d, { name: d.name || k });
        }
        return { name: k, label: typeof d === 'string' ? d : '' };
      });
    }
    return null;
  };

  const fieldName = (f) => {
    if (typeof f === 'string') return f;
    return (f && (f.name || f.key || f.id)) || '';
  };

  const fieldLabel = (name, desc) => {
    if (desc && desc.label) return desc.label;
    return FIELD_LABEL[name] || name;
  };

  const fieldType = (name, desc) => {
    const t = String((desc && desc.type) || '').toLowerCase();
    if (t === 'number' || t === 'int' || t === 'integer' || t === 'range') return 'number';
    if (t === 'boolean' || t === 'bool' || t === 'checkbox') return 'checkbox';
    if (t === 'text' || t === 'string') return 'text';
    if (/wild|bool|flag|is[A-Z_]/.test(name)) return 'checkbox';
    if (/count|number|face|amount|qty|num|point|denom/i.test(name)) return 'number';
    return 'text';
  };

  const setField = (name, value) => {
    setDraft((d) => Object.assign({}, d, { fields: Object.assign({}, d.fields, { [name]: value }) }));
  };

  const collectDeclare = (fields) => {
    if (!fields || !fields.length) {
      const t = draft.text.trim();
      if (!t) {
        setError('请先写下声明内容。');
        return null;
      }
      return { type: 'declare', text: t };
    }
    const action = { type: 'declare' };
    let missing = '';
    let rangeErr = '';
    for (let i = 0; i < fields.length; i += 1) {
      const f = fields[i];
      const name = fieldName(f);
      if (!name) continue;
      const desc = typeof f === 'object' && f ? f : {};
      const type = fieldType(name, desc);
      if (type === 'checkbox') {
        action[name] = !!draft.fields[name];
        continue;
      }
      const raw = String(draft.fields[name] == null ? '' : draft.fields[name]).trim();
      if (raw === '') {
        missing = missing || name;
        continue;
      }
      if (type === 'number') {
        const num = Number(raw);
        if (!isFinite(num)) {
          missing = missing || name;
          continue;
        }
        if (desc.min != null && isFinite(Number(desc.min)) && num < Number(desc.min)) {
          rangeErr = name + ' 不能小于 ' + desc.min;
        }
        if (desc.max != null && isFinite(Number(desc.max)) && num > Number(desc.max)) {
          rangeErr = name + ' 不能大于 ' + desc.max;
        }
        action[name] = num;
      } else {
        action[name] = raw;
      }
    }
    if (rangeErr) {
      setError(rangeErr);
      return null;
    }
    if (missing) {
      setError('请填写「' + (FIELD_LABEL[missing] || missing) + '」。');
      return null;
    }
    return action;
  };

  const actionBody = () => {
    if (!myAsk) return null;
    const p = myAsk.payload || {};
    const kind = myAsk.kind;

    const bar = (items) => <div className="arow">{items}</div>;
    const btn = (label, action, mod) => (
      <button
        type="button"
        className={'tbtn' + (mod ? ' ' + mod : '')}
        disabled={blocked}
        onClick={() => submit(action)}
        key={label + (mod || '')}
      >
        {label}
      </button>
    );

    if (kind === 'draw') {
      const items = Array.isArray(p.items)
        ? p.items
        : self && Array.isArray(self.items)
        ? self.items
        : [];
      if (draft.mode === 'swap') {
        const raw = Array.isArray(p.candidates) && p.candidates.length
          ? p.candidates
          : players.filter((pl) => pl.id !== myPid && pl.alive !== false).map((pl) => pl.id);
        return (
          <>
            <div className="anote">选择交换目标（把这次抽牌换给他）。</div>
            <div className="choices">
              {raw.map((id) => choiceBtn(id, () => submit({ type: 'use', item: 'swap', targetId: id }), false))}
            </div>
            <div className="arow">
              <button
                type="button"
                className="tbtn"
                disabled={blocked}
                onClick={() => setDraft((d) => Object.assign({}, d, { mode: '' }))}
              >
                返 回
              </button>
            </div>
          </>
        );
      }
      const canXray = !items.length || items.indexOf('xray') >= 0;
      const canSwap = !items.length || items.indexOf('swap') >= 0;
      return (
        <>
          <div className="arow">
            {btn('抽 一 张', { type: 'draw' }, 'tbtn--ink')}
            {canXray ? btn('用透视（xray）', { type: 'use', item: 'xray' }) : null}
            {canSwap ? (
              <button
                type="button"
                className="tbtn"
                disabled={blocked}
                onClick={() => setDraft((d) => Object.assign({}, d, { mode: 'swap' }))}
              >
                用交换（swap）
              </button>
            ) : null}
          </div>
          {p.deckLeft != null || p.bombsLeft != null ? (
            <div className="anote">
              牌堆 {p.deckLeft != null ? p.deckLeft : '—'}
              {p.bombsLeft != null ? ' · 炸弹 ' + p.bombsLeft : ''}
              {p.bombRate != null ? ' · 炸弹率 ' + Math.round(Number(p.bombRate) * 100) + '%' : ''}
            </div>
          ) : null}
          {items.length ? <div className="anote">持有道具：{items.join(' · ')}</div> : null}
        </>
      );
    }

    if (kind === 'defuse') {
      return (
        <>
          {p.note ? <div className="anote">{p.note}</div> : null}
          {bar([
            btn('用拆弹钳', { type: 'defuse', use: true }, 'tbtn--primary'),
            btn('硬 扛', { type: 'defuse', use: false }),
          ])}
        </>
      );
    }

    if (kind === 'pick-target') {
      const cands = candidatesOf(p);
      return (
        <>
          {p.note ? <div className="anote">{p.note}</div> : null}
          <div className="choices">
            {cands.map((c) => {
              const info = choiceInfo(c);
              return choiceBtn(c, () => submit({ type: 'pick', targetId: info.id }), false);
            })}
          </div>
        </>
      );
    }

    if (kind === 'answer') {
      return (
        <>
          <div className="arow">
            {btn('是炸弹', { type: 'answer', claim: 'bomb' }, 'tbtn--primary')}
            {btn('不是炸弹', { type: 'answer', claim: 'safe' })}
          </div>
          {p.drawerName ? <div className="anote">{p.drawerName} 抽了一张牌。</div> : null}
          {p.note ? <div className="anote">{p.note}</div> : null}
        </>
      );
    }

    if (kind === 'verdict') {
      return (
        <>
          {p.say ? <div className="anote quote">「{p.say}」</div> : null}
          {p.targetName ? <div className="anote">{p.targetName} 声称：{p.claim === 'bomb' ? '炸弹' : p.claim === 'safe' ? '安全' : p.claim || '—'}</div> : null}
          {p.note ? <div className="anote">{p.note}</div> : null}
          {bar([
            btn('相 信', { type: 'verdict', decision: 'trust' }, 'tbtn--primary'),
            btn('指 控', { type: 'verdict', decision: 'accuse' }),
          ])}
        </>
      );
    }

    if (kind === 'vote') {
      const cands = candidatesOf(p);
      const mode = p.mode || '';
      if (cands.length) {
        const key = mode === 'guess' ? 'cardId' : 'targetId';
        return (
          <>
            {mode === 'guess' && p.clue ? (
              <div className="anote">
                线索「{p.clue.word}」· {p.clue.number} 个 · 剩余 {p.guessesLeft} 次
              </div>
            ) : null}
            {p.note ? <div className="anote">{p.note}</div> : null}
            <div className="choices">
              {cands.map((c) => {
                const info = choiceInfo(c);
                const act = { type: 'vote' };
                act[key] = info.id;
                return choiceBtn(c, () => submit(act), false);
              })}
            </div>
            {mode === 'guess' ? (
              <div className="arow">
                <button
                  type="button"
                  className="tbtn"
                  disabled={blocked}
                  onClick={() => submit({ type: 'vote', cardId: 'pass' })}
                >
                  停 止 猜 测
                </button>
              </div>
            ) : null}
          </>
        );
      }
      const approveKey = mode === 'approve' || typeof p.approve === 'boolean' ? 'approve' : 'accept';
      const bits = [];
      if (p.leaderName) bits.push('发起 · ' + p.leaderName);
      if (p.threshold != null) bits.push('门槛 ' + p.threshold);
      if (p.aliveCount != null) bits.push('存活 ' + p.aliveCount);
      if (p.reason) bits.push(String(p.reason));
      return (
        <>
          {bits.length ? <div className="anote">{bits.join(' · ')}</div> : null}
          {p.note ? <div className="anote">{p.note}</div> : null}
          <div className="arow">
            <button
              type="button"
              className="tbtn tbtn--primary"
              disabled={blocked}
              onClick={() => {
                const act = { type: 'vote' };
                act[approveKey] = true;
                submit(act);
              }}
            >
              同 意
            </button>
            <button
              type="button"
              className="tbtn"
              disabled={blocked}
              onClick={() => {
                const act = { type: 'vote' };
                act[approveKey] = false;
                submit(act);
              }}
            >
              反 对
            </button>
          </div>
        </>
      );
    }

    if (kind === 'free') {
      return (
        <>
          <div className="afield">
            <label className="afield__label" htmlFor="free-text">
              你的回答
            </label>
            <textarea
              id="free-text"
              className="ainput"
              rows={3}
              maxLength={500}
              placeholder={p.placeholder || '写下你的回答，尽量简短。'}
              value={draft.text}
              onChange={(e) => setDraft((d) => Object.assign({}, d, { text: e.target.value }))}
            />
          </div>
          <div className="arow">
            <button
              type="button"
              className="tbtn tbtn--primary"
              disabled={blocked}
              onClick={() => {
                const t = draft.text.trim();
                if (!t) {
                  setError('请先输入内容。');
                  return;
                }
                submit({ type: 'text', text: t });
              }}
            >
              提 交
            </button>
            <span className="anote">提交后不可撤回。</span>
          </div>
        </>
      );
    }

    if (kind === 'declare') {
      const mode = p.mode || '';

      // 大话骰：叫点 / 开盅
      if (p.minCount != null && p.minFace != null) {
        const total = Number(p.totalDice) || 12;
        const countVal =
          draft.fields.count == null || draft.fields.count === ''
            ? String(Math.max(1, Number(p.minCount) || 1))
            : draft.fields.count;
        const faceVal =
          draft.fields.face == null || draft.fields.face === ''
            ? String(Math.min(6, Math.max(2, Number(p.minFace) || 2)))
            : draft.fields.face;
        const wildVal = draft.fields.wild !== false;
        const last = p.lastBid;
        return (
          <>
            {last ? (
              <div className="anote">
                上家 {last.byName} 叫 {bidText(last)}
              </div>
            ) : (
              <div className="anote">本局由你先叫。</div>
            )}
            <div className="afields">
              <div className="afield">
                <label className="afield__label">数量</label>
                <input
                  className="ainput"
                  type="number"
                  min={1}
                  max={total}
                  step={1}
                  value={countVal}
                  onChange={(e) => setField('count', e.target.value)}
                  disabled={blocked}
                />
              </div>
              <div className="afield">
                <label className="afield__label">点数</label>
                <select
                  className="ainput"
                  value={String(faceVal)}
                  onChange={(e) => setField('face', e.target.value)}
                  disabled={blocked}
                >
                  {[2, 3, 4, 5, 6].map((n) => (
                    <option value={String(n)} key={n}>
                      {n} 点
                    </option>
                  ))}
                </select>
              </div>
              <div className="afield afield--check">
                <label>
                  <input
                    type="checkbox"
                    checked={wildVal}
                    onChange={(e) => setField('wild', e.target.checked)}
                    disabled={blocked}
                  />{' '}
                  含 1 点 / 万能
                </label>
              </div>
            </div>
            <div className="arow">
              <button
                type="button"
                className="tbtn tbtn--primary"
                disabled={blocked}
                onClick={() => {
                  const count = Number(countVal);
                  const face = Number(faceVal);
                  if (!Number.isInteger(count) || count < 1 || count > total) {
                    setError('数量需要在 1 – ' + total + ' 之间。');
                    return;
                  }
                  if (!Number.isInteger(face) || face < 2 || face > 6) {
                    setError('点数需要在 2 – 6 之间。');
                    return;
                  }
                  submit({ type: 'declare', count, face, wild: wildVal });
                }}
              >
                叫 点
              </button>
              {p.canOpen ? (
                <button
                  type="button"
                  className="tbtn"
                  disabled={blocked}
                  onClick={() => submit({ type: 'open' })}
                >
                  开 盅 / 质 疑
                </button>
              ) : null}
            </div>
            <div className="anote">
              共 {total} 颗骰子
              {p.minRaise ? ' · 建议至少 ' + bidText(p.minRaise) : ''}
            </div>
          </>
        );
      }

      // UNO：打出变色牌后指定颜色
      if (Array.isArray(p.colors) && p.colors.length) {
        const hex = { r: '#B23A28', y: '#A07C34', g: '#55604E', b: '#3A6B80' };
        return (
          <>
            <div className="anote">选择接下来的颜色。</div>
            <div className="choices">
              {p.colors.map((c) => {
                const id = c && c.id != null ? String(c.id) : '';
                const label = (c && (c.name || c.label)) || id;
                if (!id) return null;
                return (
                  <button
                    type="button"
                    className="choice"
                    key={id}
                    disabled={blocked}
                    onClick={() => submit({ type: 'declare', color: id })}
                  >
                    <span
                      className="choice__glyph"
                      style={{ background: hex[id] || '#6B6455', color: '#FBF6E7', borderColor: hex[id] || '#6B6455' }}
                    >
                      {String(label).slice(0, 1)}
                    </span>
                    <span className="choice__main">
                      <b>{label}色</b>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        );
      }

      // 妙探：嫌疑人 + 凶器 + 房间
      if (Array.isArray(p.suspects) && Array.isArray(p.weapons) && Array.isArray(p.rooms)) {
        const pickVal = (key, list, fallback) => {
          const v = draft.fields[key];
          if (v != null && v !== '') return v;
          const sug = p.suggest && p.suggest[key];
          if (sug) return sug;
          return (list[0] && list[0].id) || fallback || '';
        };
        const suspect = pickVal('suspect', p.suspects, '');
        const weapon = pickVal('weapon', p.weapons, '');
        const room = pickVal('room', p.rooms, '');
        return (
          <>
            {p.prompt ? <div className="anote">{p.prompt}</div> : null}
            <div className="afields">
              <div className="afield">
                <label className="afield__label">嫌疑人</label>
                <select
                  className="ainput"
                  value={suspect}
                  onChange={(e) => setField('suspect', e.target.value)}
                  disabled={blocked}
                >
                  {p.suspects.map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="afield">
                <label className="afield__label">凶器</label>
                <select
                  className="ainput"
                  value={weapon}
                  onChange={(e) => setField('weapon', e.target.value)}
                  disabled={blocked}
                >
                  {p.weapons.map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="afield">
                <label className="afield__label">房间</label>
                <select
                  className="ainput"
                  value={room}
                  onChange={(e) => setField('room', e.target.value)}
                  disabled={blocked}
                >
                  {p.rooms.map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="arow">
              <button
                type="button"
                className="tbtn tbtn--primary"
                disabled={blocked}
                onClick={() => {
                  if (!suspect || !weapon || !room) {
                    setError('三项都要选。');
                    return;
                  }
                  submit({ type: 'declare', suspect, weapon, room });
                }}
              >
                {mode === 'accuse' ? '提 交 指 控' : '提 出 假 设'}
              </button>
              {mode === 'accuse' ? (
                <button
                  type="button"
                  className="tbtn"
                  disabled={blocked}
                  onClick={() => submit({ type: 'pass' })}
                >
                  放弃指控
                </button>
              ) : null}
            </div>
          </>
        );
      }

      const fields = declareFields(p);
      if (!fields || !fields.length) {
        return (
          <>
            <div className="afield">
              <label className="afield__label" htmlFor="free-text">
                声明内容
              </label>
              <textarea
                id="free-text"
                className="ainput"
                rows={3}
                maxLength={500}
                placeholder={p.placeholder || p.prompt || '按提示写下你的声明'}
                value={draft.text}
                onChange={(e) => setDraft((d) => Object.assign({}, d, { text: e.target.value }))}
              />
            </div>
            <div className="arow">
              <button
                type="button"
                className="tbtn tbtn--primary"
                disabled={blocked}
                onClick={() => {
                  const action = collectDeclare(null);
                  if (action) submit(action);
                }}
              >
                提交声明
              </button>
            </div>
          </>
        );
      }
      return (
        <>
          <div className="afields">
            {fields.map((f, i) => {
              const name = fieldName(f);
              if (!name) return null;
              const desc = typeof f === 'object' && f ? f : {};
              const type = fieldType(name, desc);
              const label = fieldLabel(name, desc);
              if (type === 'checkbox') {
                return (
                  <div className="afield afield--check" key={name + i}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!draft.fields[name]}
                        onChange={(e) => setField(name, e.target.checked)}
                        disabled={blocked}
                      />{' '}
                      {label}
                    </label>
                  </div>
                );
              }
              return (
                <div className="afield" key={name + i}>
                  <label className="afield__label">{label}</label>
                  <input
                    className="ainput"
                    type={type === 'number' ? 'number' : 'text'}
                    step={type === 'number' ? 1 : undefined}
                    min={type === 'number' && desc.min != null ? desc.min : undefined}
                    max={type === 'number' && desc.max != null ? desc.max : undefined}
                    autoComplete="off"
                    value={draft.fields[name] == null ? '' : draft.fields[name]}
                    placeholder={desc.placeholder || (type === 'number' ? '数字' : '')}
                    onChange={(e) => setField(name, e.target.value)}
                    disabled={blocked}
                  />
                </div>
              );
            })}
          </div>
          {p.note ? <div className="anote">{p.note}</div> : null}
          <div className="arow">
            <button
              type="button"
              className="tbtn tbtn--primary"
              disabled={blocked}
              onClick={() => {
                const action = collectDeclare(fields);
                if (action) submit(action);
              }}
            >
              提交声明
            </button>
          </div>
        </>
      );
    }

    if (kind === 'confirm') {
      const yes = p.yes || p.trueLabel || '是';
      const no = p.no || p.falseLabel || '否';
      return (
        <>
          {p.note ? <div className="anote">{p.note}</div> : null}
          {bar([
            btn(yes, { type: 'confirm', use: true }, 'tbtn--primary'),
            btn(no, { type: 'confirm', use: false }),
          ])}
        </>
      );
    }

    if (kind === 'multi-pick') {
      const cands = candidatesOf(p);
      let min = Number(p.min);
      if (!isFinite(min) || min < 0) min = 1;
      let max = Number(p.max);
      if (!isFinite(max) || max < 1) max = Math.max(cands.length, 1);
      const picks = draft.picks;
      const enough = picks.length >= min;
      const toggle = (id) => {
        if (blocked || !id) return;
        if (picks.indexOf(id) >= 0) {
          setDraft((d) => Object.assign({}, d, { picks: d.picks.filter((x) => x !== id) }));
        } else if (picks.length >= max) {
          showToast('最多只能选 ' + max + ' 个。');
        } else {
          setDraft((d) => Object.assign({}, d, { picks: d.picks.concat([id]) }));
        }
      };
      return (
        <>
          <div className="choices">
            {cands.map((c) => {
              const info = choiceInfo(c);
              return choiceBtn(c, () => toggle(info.id), picks.indexOf(info.id) >= 0);
            })}
          </div>
          <div className="arow">
            <span className="acount">
              已选 {picks.length} / {min === max ? min : min + '–' + max}
            </span>
            <button
              type="button"
              className="tbtn tbtn--primary"
              disabled={blocked || !enough}
              onClick={() => submit({ type: 'pick-many', ids: picks.slice() })}
            >
              确认选择
            </button>
          </div>
        </>
      );
    }

    if (kind === 'bet') {
      const legal = Array.isArray(p.legal) ? p.legal : ['fold', 'check', 'call', 'raise', 'allin'];
      const moves = [];
      for (let i = 0; i < legal.length; i += 1) {
        const m = legal[i];
        if (typeof m === 'string') moves.push({ move: m });
        else if (m && (m.move || m.type)) moves.push(m);
      }
      if (!moves.length) moves.push({ move: 'fold' });
      const callAmount = p.toCall != null ? Number(p.toCall) : p.callAmount;
      let min = Number(p.minRaise != null ? p.minRaise : p.min);
      if (!isFinite(min)) min = 0;
      let max = Number(p.maxRaise != null ? p.maxRaise : p.max);
      if (!isFinite(max)) max = Number(p.chips) || 999999;
      const raiseMove = moves.find((m) => (m.move || m.type) === 'raise');
      const bits = [];
      if (p.street) bits.push(String(p.street));
      if (p.pot != null) bits.push('底池 ' + p.pot);
      if (callAmount != null) bits.push('需跟 ' + callAmount);
      if (p.raisesLeft != null) bits.push('剩余加注 ' + p.raisesLeft);
      if (p.note) bits.push(String(p.note));
      return (
        <>
          {bits.length ? <div className="anote">{bits.join(' · ')}</div> : null}
          <div className="arow">
            {moves.map((m) => {
              const mv = String(m.move || m.type || '');
              if (mv === 'raise') return null;
              let label = m.label || MOVE_LABEL[mv] || mv;
              if (mv === 'call' && callAmount != null) label += ' ' + callAmount;
              return btn(label, { type: 'bet', move: mv });
            })}
          </div>
          {raiseMove ? (
            <div className="raise">
              <input
                className="ainput ainput--num"
                type="number"
                step={1}
                min={raiseMove.min != null ? raiseMove.min : min}
                max={raiseMove.max != null ? raiseMove.max : max}
                value={draft.bet}
                placeholder={String(raiseMove.min != null ? raiseMove.min : min)}
                aria-label="加注金额"
                onChange={(e) => setDraft((d) => Object.assign({}, d, { bet: e.target.value }))}
                disabled={blocked}
              />
              <button
                type="button"
                className="tbtn tbtn--primary"
                disabled={blocked}
                onClick={() => {
                  const lo = raiseMove.min != null && isFinite(Number(raiseMove.min)) ? Number(raiseMove.min) : min;
                  const hi = raiseMove.max != null && isFinite(Number(raiseMove.max)) ? Number(raiseMove.max) : max;
                  const raw = draft.bet === '' ? lo : Number(draft.bet);
                  if (!isFinite(raw)) {
                    setError('加注金额需要是数字。');
                    return;
                  }
                  if (raw < lo) {
                    setError('加注不能少于 ' + lo + '。');
                    return;
                  }
                  if (hi > 0 && raw > hi) {
                    setError('加注不能超过 ' + hi + '。');
                    return;
                  }
                  submit({ type: 'bet', move: 'raise', amount: Math.round(raw) });
                }}
              >
                {MOVE_LABEL.raise}
              </button>
              <span className="anote">
                {raiseMove.min != null ? raiseMove.min : min} – {raiseMove.max != null ? raiseMove.max : max}
              </span>
            </div>
          ) : null}
        </>
      );
    }

    if (kind === 'play-card') {
      const hand = Array.isArray(p.hand) ? p.hand : [];
      const legal = Array.isArray(p.legal) ? p.legal.map(cardIdOf) : null;
      const canDraw = p.canDraw !== false && !p.optional && !p.drawn;
      return (
        <>
          {hand.length ? (
            <div className="cards">
              {hand.map((c, i) => {
                const id = cardIdOf(c);
                const ok = !legal || !legal.length || legal.indexOf(id) >= 0;
                return (
                  <button
                    type="button"
                    className={'cardbtn' + (isRedCard(c) ? ' is-red' : '')}
                    key={id || i}
                    disabled={blocked || !ok}
                    onClick={() => submit({ type: 'play', cardId: id })}
                  >
                    {cardLabelOf(c)}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="anote">手牌为空，只能抽一张。</div>
          )}
          {canDraw ? (
            <div className="arow">
              {btn('抽 一 张', { type: 'draw' }, 'tbtn--ink')}
              {p.note ? <span className="anote">{p.note}</span> : null}
            </div>
          ) : p.note ? (
            <div className="anote">{p.note}</div>
          ) : null}
        </>
      );
    }

    if (kind === 'challenge') {
      const who = p.claimerName || p.name || '';
      return (
        <>
          {who ? <div className="anote">{who} 给出了说法。</div> : null}
          {p.say ? <div className="anote quote">「{p.say}」</div> : null}
          {!who && p.note ? <div className="anote">{p.note}</div> : null}
          {bar([
            btn('接 受', { type: 'challenge', accept: true }, 'tbtn--primary'),
            btn('质 疑', { type: 'challenge', accept: false }),
          ])}
        </>
      );
    }

    // 未识别的决策类型：退化为自由文本
    return (
      <>
        <div className="anote">未识别的决策类型「{kind || '?'}」，已按自由文本处理。</div>
        <div className="afield">
          <label className="afield__label" htmlFor="free-text">
            你的回答
          </label>
          <textarea
            id="free-text"
            className="ainput"
            rows={3}
            maxLength={500}
            placeholder={p.placeholder || '写下你的回答，尽量简单。'}
            value={draft.text}
            onChange={(e) => setDraft((d) => Object.assign({}, d, { text: e.target.value }))}
          />
        </div>
        <div className="arow">
          <button
            type="button"
            className="tbtn tbtn--primary"
            disabled={blocked}
            onClick={() => {
              const t = draft.text.trim();
              if (!t) {
                setError('请先输入内容。');
                return;
              }
              submit({ type: 'text', text: t });
            }}
          >
            提 交
          </button>
        </div>
      </>
    );
  };

  const askPrompt = (a) => {
    const p = a.payload || {};
    const c = a.context || {};
    return (
      p.prompt ||
      p.question ||
      p.text ||
      p.description ||
      c.prompt ||
      c.question ||
      DEFAULT_ASK[a.kind] ||
      '待决策：' + (a.kind || '?')
    );
  };

  const deadline = myAsk
    ? Number(myAsk.deadline) || 0
    : isMine
    ? Number(st.askDeadline) || 0
    : 0;
  const total = Number(st.askTimeoutMs) || 120000;
  const left = deadline ? Math.max(0, deadline - (now || Date.now())) : 0;
  const mine = !!myAsk && isMine;
  const askKind = myAsk ? myAsk.kind : st.askKind || '';

  let actionPrompt = '';
  let actionFoot = [];
  if (!pub) {
    actionPrompt = '正在接入牌局…';
    actionFoot.push('如果长时间没有反应，检查服务是否在运行。');
  } else if (ended) {
    const w = st.winner;
    const wname = typeof w === 'string' ? w : w && w.name;
    actionPrompt = wname ? '牌局结束 · ' + wname : '牌局结束';
    actionFoot.push('本局已经结束，记录仍可查看。');
  } else if (!token) {
    actionPrompt = ids.length ? '等待 ' + ids.map(nameOf).join('、') + ' 行动（观战）' : '观战模式 · 只读';
    actionFoot.push('没有 token，只能看不能动。顶部「我有 token」可粘贴后接入。');
  } else if (tokenInvalid) {
    actionPrompt = 'token 无法识别';
    actionFoot.push('服务端不认识这个 token。确认房间号与 token 是否匹配。');
  } else if (status === 'lobby') {
    actionPrompt = '牌局还没开始';
    actionFoot.push('已入座 ' + filled + ' / ' + seats + ' 人，等待房主开局。');
  } else if (mine) {
    if (myAsk && submitted === myAsk.id) {
      actionPrompt = '已提交，等待牌桌结算';
      actionFoot.push('这一手已经交出去了，下一步会实时推过来。');
    } else if (myAsk) {
      actionPrompt = askPrompt(myAsk);
      actionFoot.push(busy ? '提交中…' : '提交后不可撤回；超时由系统代打。');
    } else {
      actionPrompt = '正在获取决策内容…';
      actionFoot.push('已轮到你了，正在向服务端取这一手的明细。');
    }
  } else if (ids.length) {
    actionPrompt = '等待 ' + ids.map(nameOf).join('、') + ' 行动';
    actionFoot.push(ids.length > 1 ? '这一步有多人同时决策。' : '轮到别人，牌桌会自动刷新。');
  } else {
    actionPrompt = status === 'playing' ? '牌桌结算中…' : '牌桌静默中';
    actionFoot.push(status === 'playing' ? '没有待决策事项，等下一步。' : '等待牌桌推进。');
  }

  let modeClass = 'modechip';
  let modeText = '连接中';
  if (!token) {
    modeText = '观战中';
  } else if (tokenInvalid) {
    modeClass += ' is-bad';
    modeText = 'token 无效';
  } else if (connected) {
    modeClass += ' is-live';
    modeText = '已接入';
  } else {
    modeClass += ' is-warn';
    modeText = reconnecting ? '重连中…' : '连接中';
  }

  const lobby = status === 'lobby';
  const tableTitle = lobby && !(st.table && st.table.title) ? '等待开局' : (st.table && st.table.title) || st.gameTitle || '牌桌';
  const phaseKicker = st.phase ? phaseLabel(st.phase) + ' · TABLE' : '牌 桌 / TABLE';
  const rosterMe = myPid ? playerOf(myPid) : null;
  const meSelf = self || {};
  const meName = meSelf.name || (rosterMe && rosterMe.name) || '我';
  const meHand = Array.isArray(meSelf.hand) ? meSelf.hand.length : rosterMe && rosterMe.handCount;
  const meDice = Array.isArray(meSelf.dice) ? meSelf.dice.length : rosterMe && rosterMe.diceCount;
  const meChips = meSelf.chips != null ? meSelf.chips : rosterMe && rosterMe.chips;
  const meSecret = secretText(meSelf.secret);
  const showSelf = !!(self || rosterMe);

  const winnerName =
    typeof st.winner === 'string' ? st.winner : st.winner && st.winner.name ? st.winner.name : '';

  return (
    <div className="tbl-root">
      <div className="grain" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />

      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand__line">
              <span className="brand__mark">TABLE</span>
              <span className="brand__mark brand__mark--alt">通用</span>
            </div>
            <div className="brand__cn">
              <b id="game-title">{st.gameTitle || '通用牌桌'}</b> · 房号 <b id="room-id">{roomId}</b>
            </div>
          </div>

          <div className="statline">
            <span className={'stat' + (status === 'playing' ? ' stat--live' : '')}>
              <i className="stat__k">状态</i>
              <b className="stat__v">{STATUS_LABEL[status] || status}</b>
            </span>
            <span className="stat">
              <i className="stat__k">回合</i>
              <b className="stat__v">{st.round == null || st.round === '' ? '—' : String(st.round)}</b>
            </span>
            <span className="stat">
              <i className="stat__k">阶段</i>
              <b className="stat__v">{st.phase ? phaseLabel(st.phase) : '—'}</b>
            </span>
            <span className="stat">
              <i className="stat__k">在场</i>
              <b className="stat__v">{filled + ' / ' + seats}</b>
            </span>
          </div>

          <span className={modeClass} title={tokenInvalid ? '服务端不认识这个 token，只能观战' : ''}>
            <span className="dot" />
            <span>{modeText}</span>
          </span>

          <form
            className="tokenbar"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              adoptToken(tokenInput);
            }}
          >
            <label className="tokenbar__label" htmlFor="token-input">
              我有 token
            </label>
            <input
              className="tokenbar__input"
              id="token-input"
              name="token"
              type="text"
              placeholder="粘贴你的 token"
              spellCheck={false}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <button className="tbtn tbtn--sm tbtn--ghost" type="submit">
              接 入
            </button>
          </form>

          <button className="tbtn tbtn--sm tbtn--ghost" type="button" onClick={copyInvite}>
            邀请 AI
          </button>

          {hostToken && !ended ? (
            <button className="tbtn tbtn--sm tbtn--ghost" type="button" onClick={abortRoom}>
              强制结束
            </button>
          ) : null}

          <a className="tbtn tbtn--sm tbtn--ghost topbar__home" href="/">
            大 厅
          </a>
        </header>

        <main className="board">
          {/* 左：座位 */}
          <section className="panel roster" aria-label="在场人员">
            <div className="panel__head">
              <span className="panel__kicker">在场人员 / ROSTER</span>
              <span className="panel__meta">
                {players.length
                  ? status === 'lobby'
                    ? players.length + ' 人'
                    : players.filter((p) => p.alive !== false).length + '/' + players.length + ' 存活'
                  : '—'}
              </span>
            </div>
            <div className="roster__body">
              {players.length ? (
                players.map((p) => rosterCard(p))
              ) : (
                <div className="roster__empty">还没有玩家入座。把加入链接发给朋友或 AI。</div>
              )}
            </div>
            <div className="panel__foot">
              <span>
                {players.length ? '共 ' + players.length + ' 人 · ' + filled + ' 入座' : '等待牌桌数据'}
                {!token ? ' · 观战' : ''}
              </span>
              <span>{connected ? 'LIVE' : 'OFFLINE'}</span>
            </div>
          </section>

          {/* 中：牌局 */}
          <section className="panel tabletop" aria-label="桌面">
            <div className="tabletop__mark" aria-hidden="true">
              桌
            </div>

            <div className="tabletop__head">
              <div className="tabletop__heading">
                <div className="panel__kicker">{phaseKicker}</div>
                <h1 className="tabletop__title">{tableTitle}</h1>
              </div>
              {st.round != null && st.round !== '' ? <div className="roundchip">第 {st.round} 轮</div> : null}
            </div>

            {ended ? (
              <div className="winner">
                <span className="winner__k">牌 局 结 束</span>
                <span className="winner__name">
                  胜者 · {winnerName || '无人'}
                  {st.winner && st.winner.id && st.winner.id === myPid ? '（你）' : ''}
                </span>
                <span className="winner__sub">ROOM {roomId}</span>
              </div>
            ) : null}

            {diceStage}

            {fx ? (
              <div className="fx-stage" id="fx-stage" data-kind={fx.kind} ref={fxRef}>
                <div className="fx-stage__kicker">{FX_LABELS[fx.kind]}</div>
                <div className={'fx-stage__body fx--' + fx.kind}>
                  <span className="fx-glyph">{FX_GLYPH[fx.kind] || '·'}</span>
                  <span className="fx-text">{String(fx.text || '').slice(0, 140)}</span>
                  {fx.kind === 'vote' ? (
                    <span className="fx-bar" aria-hidden="true">
                      <i />
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="stage-stats">
              {st.deckLeft != null ? (
                <span className="stage-stat">
                  <i>牌堆</i>
                  <b>{st.deckLeft}</b>
                </span>
              ) : null}
              {st.bombsLeft != null ? (
                <span className="stage-stat">
                  <i>炸弹</i>
                  <b>{st.bombsLeft}</b>
                </span>
              ) : null}
              {players.length ? (
                <span className="stage-stat">
                  <i>存活</i>
                  <b>
                    {players.filter((p) => p.alive !== false).length} / {players.length}
                  </b>
                </span>
              ) : null}
            </div>

            <div className="tabletop__scroll">
              {Array.isArray(st.words) && st.words.length ? (
                <div className="wordgrid">
                  {st.words.map((w) => (
                    <span
                      className={'wordcard' + (w && w.revealed ? ' is-' + w.revealed : '')}
                      key={w && w.id}
                    >
                      {w && w.word}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="rows">
                {stageRows.length ? (
                  stageRows.map((r, i) => (
                    <div className="trow" key={i}>
                      <span className="trow__k">{r && r.label != null ? r.label : '—'}</span>
                      <span className="trow__v">{fmtVal(r ? r.value : '')}</span>
                    </div>
                  ))
                ) : (
                  <div className="rows__empty">
                    {lobby ? '桌面空着。人齐之后由房主开局。' : '这一局暂时没有公开的桌面信息。'}
                  </div>
                )}
              </div>
              {st.table && st.table.note ? <p className="tabletop__note">{String(st.table.note)}</p> : null}
            </div>

            {showSelf ? (
              <div className="selfcard">
                <span className="selfcard__label">你</span>
                <b className="selfcard__name">{meName}</b>
                {meSelf.team ? (
                  <span className={'tag ' + (TEAM_CLASS[meSelf.team] || '')}>{teamLabel(meSelf.team)}</span>
                ) : null}
                {meSelf.role ? <span className="tag tag--gold">{meSelf.role}</span> : null}
                {meHand != null ? <span className="selfcard__num">手牌 {Number(meHand)}</span> : null}
                {meDice != null ? <span className="selfcard__num">骰 {Number(meDice)}</span> : null}
                {meChips != null ? <span className="selfcard__num">筹码 {Number(meChips)}</span> : null}
                {meSecret ? <span className="selfcard__secret">{meSecret}</span> : null}
              </div>
            ) : null}

            {token ? (
              <div
                className={'action' + (mine ? ' is-mine' : '') + (ended ? ' is-ended' : '')}
                aria-live="polite"
                aria-busy={busy ? 'true' : 'false'}
              >
              <div className="action__kicker">
                <span>
                  {mine
                    ? KIND_LABEL[askKind] || askKind || '待 命'
                    : askKind
                    ? (KIND_LABEL[askKind] || askKind) + ' · 等待'
                    : ids.length
                    ? '等待行动'
                    : '待 命'}
                </span>
                <span className={'action__timer' + (deadline && left > 0 && left <= 10000 ? ' is-urgent' : '')}>
                  {deadline ? (left > 0 ? '剩余 ' + fmtLeft(left) : '已超时') : ''}
                </span>
              </div>

              {deadline ? (
                <div className="action__meter">
                  <i style={{ width: Math.min(100, Math.max(0, (left / total) * 100)) + '%' }} />
                </div>
              ) : null}

              <div className="action__prompt">{actionPrompt}</div>

              {mine && myAsk && submitted !== myAsk.id ? <div className="action__body">{actionBody()}</div> : null}

              {mine && myAsk && submitted !== myAsk.id ? (
                <div className="action__say">
                  <label className="action__saylabel" htmlFor="say-input">
                    说一句（可选）
                  </label>
                  <input
                    className="ainput"
                    id="say-input"
                    maxLength={200}
                    placeholder="先说两句…"
                    autoComplete="off"
                    value={say}
                    onChange={(e) => setSay(e.target.value)}
                  />
                </div>
              ) : null}

              <div className="action__foot">
                {error ? <span className="err">{error}</span> : null}
                {hint && !mine ? <span>{hint}</span> : null}
                {actionFoot.map((f, i) => (f ? <span key={i}>{f}</span> : null))}
              </div>
              </div>
            ) : null}
          </section>

          {/* 右：公开记录 */}
          <aside className="panel logpanel" aria-label="公开记录">
            <div className="panel__head">
              <span className="panel__kicker">公开记录 / WIRETAP</span>
              <span className="panel__meta">{logs.length}</span>
            </div>
            <div className="log" ref={logBoxRef} onScroll={onLogScroll}>
              {logs.length ? (
                logs.map((item) => {
                  const t = String(item.t || 'system')
                    .toLowerCase()
                    .replace(/[^a-z-]/g, '') || 'system';
                  const who = item.playerId ? nameOf(item.playerId) : '';
                  return (
                    <div className={'lentry lentry--' + t} key={item.key}>
                      <div className="lentry__meta">
                        <span>{clock(item.at)}</span>
                        {who ? <span>{who}</span> : null}
                        <span className="lentry__tag">{LOG_TAG[t] || '记录'}</span>
                      </div>
                      <div className="lentry__text">{item.text}</div>
                    </div>
                  );
                })
              ) : (
                <div className="logempty">还没有公开记录。牌桌上的发言与系统事件会打在这里。</div>
              )}
            </div>
            <div className="panel__foot">
              <span>{connected ? '轮询 · 1s' : reconnecting ? '离线 · 重连中' : '接入中'}</span>
              <span>CH · 04</span>
            </div>
          </aside>
        </main>
      </div>

      <div className={'toast' + (toastMsg ? ' show' : '')} role="status" aria-live="polite">
        {toastMsg}
      </div>
    </div>
  );
}
