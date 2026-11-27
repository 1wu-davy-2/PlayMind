'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../app/godview/godview.css';

/* ============================================================
   造物主后台 · GODVIEW
   masked 视图默认脱敏，raw 必须显式申请并填写 reason。
   raw 永不随轮询自动刷新；3s 轮询只刷新房间列表。
   ============================================================ */

const STATUS_LABEL = {
  waiting: '等待中',
  playing: '进行中',
  ended: '已结束',
};

const ROLE_LABEL = {
  viewer: '观察员 viewer',
  operator: '操作员 operator',
  root: '根权限 root',
};

const OP_LABEL = {
  abort: '强制结束',
  kick: '踢出玩家',
  'advance-phase': '跳到下一阶段',
  'force-act': '代打行动',
};

const OP_EN = {
  abort: 'abort',
  kick: 'kick',
  'advance-phase': 'advance-phase',
  'force-act': 'force-act',
};

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'playing', label: '进行中' },
  { value: 'waiting', label: '等待中' },
  { value: 'ended', label: '已结束' },
];

const GLYPH = {
  'BOMB TABLE': '爆',
  谁是卧底: '卧',
  狼人杀: '狼',
  德州扑克: '牌',
  UNO: 'U',
  阿瓦隆: '亚',
  妙探寻凶: '探',
  代号: '码',
  吹牛骰: '骰',
};

/* ---------------- 请求 / 格式化 ---------------- */

async function api(url, options = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const error = new Error((data && (data.error || data.message)) || `请求失败（${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return data || {};
}

function uiStateOf(room) {
  if (!room) return '';
  if (room.uiState) return room.uiState;
  if (room.status === 'lobby') return 'waiting';
  return room.status || '';
}

function glyphOf(room) {
  const title = room && room.gameTitle ? String(room.gameTitle) : '';
  if (GLYPH[title]) return GLYPH[title];
  const fallback = title || (room && room.gameType) || '?';
  return fallback.slice(0, 1).toUpperCase();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTime(iso, withSeconds = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return String(iso).slice(0, 16).replace('T', ' ') || '—';
  }
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? `:${pad2(d.getSeconds())}` : ''}`;
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? `今日 ${hm}` : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : '—';
}

function winnerText(winner) {
  if (!winner) return '—';
  if (typeof winner === 'string') return winner;
  if (typeof winner === 'object') {
    return winner.name || winner.id || JSON.stringify(winner);
  }
  return String(winner);
}

function parsePayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** masked 档只呈现锁定标记，绝不 stringify 服务端的 secret 对象。 */
function maskedSecretText(player) {
  const kind = player && player.secret && player.secret.kind;
  return kind ? `{"redacted":true,"kind":"${kind}"}` : '{"redacted":true}';
}

function handDiceText(player, isRaw) {
  if (isRaw) {
    const hand = Array.isArray(player.hand) ? player.hand.length : 0;
    const dice = Array.isArray(player.dice) ? player.dice.length : 0;
    return `手牌 ${hand} · 骰 ${dice}`;
  }
  const hand = typeof player.handCount === 'number' ? player.handCount : 0;
  const dice = typeof player.diceCount === 'number' ? player.diceCount : 0;
  return `手牌 ${hand} · 骰 ${dice}`;
}

/** masked 档兜底截断，即使服务端漏裁也不在 DOM 里出现完整思考链。 */
function thoughtText(player, isRaw) {
  const text = player && player.thought ? String(player.thought) : '';
  if (!text) return '—';
  if (isRaw) return text;
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function badgeClassOf(uiState) {
  if (uiState === 'playing') return 'gv-badge--play';
  if (uiState === 'waiting') return 'gv-badge--wait';
  return 'gv-badge--end';
}

/* ---------------- 组件 ---------------- */

export default function GodviewClient() {
  const [auth, setAuth] = useState('checking'); // checking | login | ready
  const [session, setSession] = useState(null);

  const [loginName, setLoginName] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [formError, setFormError] = useState('');

  const [rooms, setRooms] = useState([]);
  const [stats, setStats] = useState(null);
  const [roomTotal, setRoomTotal] = useState(0);
  const [roomsError, setRoomsError] = useState('');

  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [gameFilter, setGameFilter] = useState('');

  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null); // { level:'masked'|'raw', data }
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [audit, setAudit] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');

  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);

  const detailReqRef = useRef(0);
  const toastTimerRef = useRef(null);
  const reasonRef = useRef(null);

  const showToast = useCallback((text, bad = false) => {
    setToast({ text, bad });
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  /* ---------- 房间列表 ---------- */

  const applyRooms = useCallback((data) => {
    if (!data) return;
    const list = Array.isArray(data.rooms) ? data.rooms : [];
    setRooms(list);
    setStats(data.stats || null);
    setRoomTotal(Number.isFinite(Number(data.total)) ? Number(data.total) : list.length);
    setRoomsError('');
    if (data.admin) {
      setSession((prev) => ({
        ...(prev || {}),
        username: data.admin.username || (prev && prev.username) || '',
        role: data.admin.role || (prev && prev.role) || 'viewer',
      }));
    }
  }, []);

  const fetchRooms = useCallback(async () => {
    try {
      const data = await api('/api/admin/rooms');
      applyRooms(data);
      return true;
    } catch (err) {
      if (err.status === 401) {
        setSession(null);
        setAuth('login');
      } else {
        setRoomsError(err.message || '房间列表刷新失败');
      }
      return false;
    }
  }, [applyRooms]);

  /* 首次进入：用轻量房间接口探测会话 */
  useEffect(() => {
    let alive = true;
    (async () => {
      const ok = await fetchRooms();
      if (alive) setAuth(ok ? 'ready' : 'login');
    })();
    return () => { alive = false; };
  }, [fetchRooms]);

  /* 3s 轮询房间列表；页面隐藏时暂停请求 */
  useEffect(() => {
    if (auth !== 'ready') return undefined;
    let inFlight = false;
    const tick = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try { await fetchRooms(); } finally { inFlight = false; }
    };
    const timer = setInterval(tick, 3000);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [auth, fetchRooms]);

  /* ---------- 审计流水 ---------- */

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const data = await api('/api/admin/audit?limit=50');
      const records = Array.isArray(data.records) ? data.records : [];
      setAudit(records
        .slice()
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, 50));
      setAuditError('');
    } catch (err) {
      if (err.status === 401) {
        setSession(null);
        setAuth('login');
      }
      setAuditError(err.message || '审计流水加载失败');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auth === 'ready') loadAudit();
  }, [auth, loadAudit]);

  /* 会话失效 / 登出：清空一切管理员数据，避免残留明文 */
  useEffect(() => {
    if (auth !== 'login') return;
    setRooms([]);
    setStats(null);
    setRoomTotal(0);
    setSelectedId('');
    setDetail(null);
    setDetailError('');
    setAudit([]);
    setModal(null);
    setLoginPass('');
  }, [auth]);

  /* ---------- 房间详情 ---------- */

  const loadDetail = useCallback(async (roomId, level = 'masked') => {
    if (!roomId) return false;
    const token = detailReqRef.current + 1;
    detailReqRef.current = token;
    setDetailLoading(true);
    setDetailError('');
    try {
      const data = await api(`/api/admin/rooms/${encodeURIComponent(roomId)}/godview?level=${level}`);
      if (detailReqRef.current !== token) return false;
      setDetail({ level, data });
      return true;
    } catch (err) {
      if (detailReqRef.current !== token) return false;
      if (err.status === 401) {
        setSession(null);
        setAuth('login');
      }
      setDetailError(err.message || '房间视图加载失败');
      return false;
    } finally {
      if (detailReqRef.current === token) setDetailLoading(false);
    }
  }, []);

  function selectRoom(room) {
    if (!room || !room.roomId) return;
    setSelectedId(room.roomId);
    setDetail(null);
    setDetailError('');
    loadDetail(room.roomId, 'masked');
  }

  const selectedRoom = useMemo(
    () => rooms.find((room) => room.roomId === selectedId) || null,
    [rooms, selectedId],
  );

  const filteredRooms = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rooms.filter((room) => {
      const ui = uiStateOf(room);
      if (stateFilter && ui !== stateFilter) return false;
      if (gameFilter && room.gameType !== gameFilter) return false;
      if (!q) return true;
      return [room.roomId, room.displayCode, room.gameTitle, room.gameType]
        .some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [rooms, query, stateFilter, gameFilter]);

  const gameOptions = useMemo(() => {
    const map = new Map();
    rooms.forEach((room) => {
      if (room.gameType) map.set(room.gameType, room.gameTitle || room.gameType);
    });
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [rooms]);

  const view = detail && detail.data ? detail.data : null;
  const viewRoom = (view && view.room) || null;
  const viewPlayers = Array.isArray(view && view.players) ? view.players : [];
  const viewAsks = Array.isArray(view && view.asks) ? view.asks : [];
  const viewThoughts = Array.isArray(view && view.thoughts) ? view.thoughts : [];
  const viewEvents = Array.isArray(view && view.events) ? view.events : [];
  const viewMeta = (view && view.meta) || {};
  const isRaw = Boolean(detail && detail.level === 'raw');
  // masked 档只展示服务端标注为 public 的事件（服务端应已过滤，这里再兜底）
  const visibleEvents = viewEvents.filter(
    (event) => isRaw || !event.visibility || event.visibility === 'public',
  );

  const role = (session && session.role) || 'viewer';
  const canIntervene = role === 'operator' || role === 'root';
  const canRaw = canIntervene;

  const roomStatus = (viewRoom && viewRoom.status) || (selectedRoom && selectedRoom.status) || '';
  const isEnded = roomStatus === 'ended';
  const opsAllowed = canIntervene && !isEnded;

  const abortDisabled = !opsAllowed;
  const kickDisabled = !opsAllowed || viewPlayers.length === 0;
  const advanceDisabled = !opsAllowed || roomStatus !== 'playing';
  const forceDisabled = role !== 'root' || roomStatus !== 'playing' || viewPlayers.length === 0;

  /* ---------- 登录 / 登出 ---------- */

  async function handleLogin(event) {
    if (event) event.preventDefault();
    if (loggingIn) return;
    const username = loginName.trim();
    if (!username || !loginPass) {
      setFormError('请输入用户名与密码');
      return;
    }
    setLoggingIn(true);
    setFormError('');
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: loginPass }),
      });
      setSession({
        username: data.username || username,
        role: data.role || 'viewer',
        adminId: data.adminId,
        expiresAt: data.expiresAt,
      });
      setLoginPass('');
      try {
        const roomsData = await api('/api/admin/rooms');
        applyRooms(roomsData);
      } catch (err) {
        if (err.status === 401) throw err;
        setRoomsError(err.message || '房间列表加载失败');
      }
      setAuth('ready');
    } catch (err) {
      setFormError(err.message || '登录失败');
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } catch {
      /* 会话可能已过期，本地状态仍需清空 */
    }
    setAuth('login');
    setSession(null);
    setRooms([]);
    setStats(null);
    setRoomTotal(0);
    setRoomsError('');
    setSelectedId('');
    setDetail(null);
    setDetailError('');
    setAudit([]);
    setAuditError('');
    setModal(null);
    setLoginName('');
    setLoginPass('');
    setFormError('');
  }

  /* ---------- 干预 / 揭示弹窗 ---------- */

  function openReveal() {
    if (!selectedId || !detail) return;
    setModal({ mode: 'reveal', action: null, reason: '', ack: false, targetId: '', payloadText: '', error: '', submitting: false });
  }

  function openIntervene(action) {
    if (!selectedId) return;
    setModal({
      mode: 'intervene',
      action,
      reason: '',
      ack: false,
      targetId: '',
      payloadText: '',
      error: '',
      submitting: false,
    });
  }

  function closeModal() {
    setModal(null);
  }

  function patchModal(patch) {
    setModal((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  const modalOpen = Boolean(modal);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const focusTimer = setTimeout(() => {
      if (reasonRef.current) reasonRef.current.focus();
    }, 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setModal(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [modalOpen]);

  const modalNeedsTarget = Boolean(modal && (modal.action === 'kick' || modal.action === 'force-act'));
  const modalNeedsPayload = Boolean(modal && modal.action === 'force-act');
  const payloadState = modalNeedsPayload && modal ? parsePayload(modal.payloadText) : { ok: false };
  const canConfirm = Boolean(modal)
    && modal.reason.trim().length > 0
    && modal.ack
    && (!modalNeedsTarget || Boolean(modal.targetId))
    && (!modalNeedsPayload || payloadState.ok);

  async function handleConfirm() {
    if (!modal || !canConfirm || modal.submitting) return;
    const reason = modal.reason.trim();
    setModal((prev) => (prev ? { ...prev, submitting: true, error: '' } : prev));

    if (modal.mode === 'reveal') {
      try {
        const data = await api(
          `/api/admin/rooms/${encodeURIComponent(selectedId)}/godview?level=raw&reason=${encodeURIComponent(reason)}`,
        );
        setDetail({ level: 'raw', data });
        setDetailError('');
        setModal(null);
        showToast('RAW 已返回 · 快照与审计已写入');
        loadAudit();
      } catch (err) {
        if (err.status === 401) {
          setSession(null);
          setAuth('login');
          setModal(null);
          return;
        }
        patchModal({ submitting: false, error: err.message || 'raw 揭示失败' });
      }
      return;
    }

    const body = { action: modal.action, reason };
    if (modal.action === 'kick' || modal.action === 'force-act') {
      body.targetPlayerId = modal.targetId;
    }
    if (modal.action === 'force-act') {
      body.actionPayload = parsePayload(modal.payloadText).value;
    }

    try {
      const data = await api(`/api/admin/rooms/${encodeURIComponent(selectedId)}/intervene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const auditId = data && data.auditId;
      const label = OP_LABEL[modal.action] || '干预';
      setModal(null);
      showToast(`${label} · 已执行${auditId ? ` · 审计 #${auditId}` : ''}`);
      loadAudit();
      fetchRooms();
      // 状态已变化，回到 masked；raw 不自动续取
      setDetail(null);
      await loadDetail(selectedId, 'masked');
    } catch (err) {
      if (err.status === 401) {
        setSession(null);
        setAuth('login');
        setModal(null);
        return;
      }
      patchModal({ submitting: false, error: err.message || '干预失败' });
    }
  }

  /* ---------- 渲染：登录 / 探测 ---------- */

  const toastNode = (
    <div
      className={`gv-toast${toast ? ' is-show' : ''}${toast && toast.bad ? ' is-bad' : ''}`}
      role="status"
      aria-live="polite"
    >
      {toast ? toast.text : ''}
    </div>
  );

  if (auth !== 'ready') {
    return (
      <div className="godview-page">
        <div className="gv-grain" aria-hidden="true" />
        <div className="gv-login">
          <div className="gv-login-card">
            <div className="gv-kicker">造物主视图 / GODVIEW · 机密</div>
            <h1 className="gv-login-title">全局<span>造物主</span>后台</h1>

            {auth === 'checking' ? (
              <p className="gv-loading" role="status">正在核对管理员会话…</p>
            ) : (
              <form onSubmit={handleLogin}>
                <p className="gv-login-desc">
                  后门独立入口。登录成功后由服务端种下 HttpOnly 会话 Cookie，与玩家 token 完全隔离。
                </p>

                <div className="gv-field">
                  <label htmlFor="gv-login-user">管理员 / ADMIN</label>
                  <input
                    id="gv-login-user"
                    className="gv-input"
                    value={loginName}
                    autoComplete="username"
                    spellCheck={false}
                    onChange={(event) => setLoginName(event.target.value)}
                  />
                </div>

                <div className="gv-field">
                  <label htmlFor="gv-login-pass">密码 / PASSWORD</label>
                  <input
                    id="gv-login-pass"
                    className="gv-input"
                    type="password"
                    value={loginPass}
                    autoComplete="current-password"
                    onChange={(event) => setLoginPass(event.target.value)}
                  />
                </div>

                {formError && <div className="gv-alert" role="alert">{formError}</div>}
                {roomsError && <div className="gv-alert" role="alert">{roomsError}</div>}

                <button
                  type="submit"
                  className="gv-btn gv-btn--danger gv-btn--wide gv-login-submit"
                  disabled={loggingIn}
                  aria-busy={loggingIn}
                >
                  {loggingIn ? '正在验证…' : '进入造物主后台'}
                </button>

                <p className="gv-login-note">
                  登录、揭示与干预都会写入不可删的审计链。请勿在公共设备上保持会话。
                </p>
              </form>
            )}
          </div>
        </div>
        {toastNode}
      </div>
    );
  }

  /* ---------- 渲染：主界面 ---------- */

  const revealedMeta = isRaw ? 'RAW' : 'masked';

  return (
    <div className="godview-page">
      <div className="gv-grain" aria-hidden="true" />
      <div className="gv-shell">
        <header className="gv-top">
          <div>
            <div className="gv-kicker">造物主视图 / GODVIEW · 机密</div>
            <h1 className="gv-title">全局<span>造物主</span>后台</h1>
          </div>
          <div className="gv-session">
            <p className="gv-power">
              你拥有<b>揭示一切</b>与<b>终止一切</b>的权力。<br />
              每一次越界，都会留下不可删的审计印记。
            </p>
            <div className="gv-who">
              <span className="gv-who-name">{session && session.username ? session.username : '—'}</span>
              <span
                className="gv-role"
                title={session && session.expiresAt ? `会话到期 ${formatTime(session.expiresAt, true)}` : undefined}
              >
                {ROLE_LABEL[role] || role}
              </span>
              <button
                type="button"
                className="gv-btn gv-btn--sm"
                onClick={handleLogout}
                aria-label="登出管理员会话"
              >
                登出
              </button>
            </div>
          </div>
        </header>

        <div className="gv-statrow">
          <div className="gv-stat">
            <b>{num(stats && stats.activeRooms)}</b>
            <span>活跃房间 · activeRooms</span>
          </div>
          <div className="gv-stat">
            <b>{num(stats && stats.agentsPresent)}</b>
            <span>在线 AI · agentsPresent</span>
          </div>
          <div className="gv-stat gv-stat--red">
            <b>{num(stats && stats.revealsToday)}</b>
            <span>今日揭示 · revealsToday</span>
          </div>
          <div className={`gv-stat ${stats && stats.unloggedOps ? 'gv-stat--red' : 'gv-stat--ok'}`}>
            <b>{num(stats && stats.unloggedOps)}</b>
            <span>未审计操作 · unloggedOps</span>
          </div>
        </div>

        {roomsError && <div className="gv-alert" role="alert">{roomsError}</div>}

        <div className="gv-grid">
          {/* 房间列表 */}
          <section className="gv-panel" aria-labelledby="gv-rooms-title">
            <div className="gv-phead">
              <h2 id="gv-rooms-title">全局房间 / ALL ROOMS</h2>
              <span className="gv-meta">共 {roomTotal} 间 · 每 3s 轮询</span>
            </div>

            <div className="gv-filters">
              <input
                className="gv-input"
                value={query}
                placeholder="搜索 displayCode / roomId / 游戏…"
                aria-label="搜索房号或游戏"
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                className="gv-input"
                value={gameFilter}
                aria-label="按游戏筛选"
                onChange={(event) => setGameFilter(event.target.value)}
              >
                <option value="">全部游戏</option>
                {gameOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <div className="gv-seg" role="group" aria-label="按状态筛选">
                {STATUS_FILTERS.map((item) => (
                  <button
                    key={item.value || 'all'}
                    type="button"
                    className={stateFilter === item.value ? 'is-on' : ''}
                    aria-pressed={stateFilter === item.value}
                    onClick={() => setStateFilter(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gv-rooms">
              {filteredRooms.length === 0 ? (
                <p className="gv-empty">没有符合条件的房间</p>
              ) : filteredRooms.map((room) => {
                const ui = uiStateOf(room);
                const active = room.roomId === selectedId;
                const primary = room.displayCode || room.roomId;
                return (
                  <button
                    key={room.roomId}
                    type="button"
                    className={`gv-room${active ? ' is-on' : ''}`}
                    aria-pressed={active}
                    aria-label={`查看房间 ${primary}（${room.roomId}）`}
                    onClick={() => selectRoom(room)}
                  >
                    <span className="gv-room-glyph" aria-hidden="true">{glyphOf(room)}</span>
                    <span className="gv-room-body">
                      <span className="gv-room-id">{primary}</span>
                      <span className="gv-room-game">{room.gameTitle || room.gameType || '牌桌'}</span>
                      <span className="gv-room-meta">
                        roomId {room.roomId} · {formatTime(room.createdAt)}
                      </span>
                    </span>
                    <span className="gv-room-right">
                      <span className={`gv-badge ${badgeClassOf(ui)}`}>
                        {STATUS_LABEL[ui] || ui || '未知'}
                      </span>
                      <span className="gv-room-n">
                        {num(room.filled)}/{num(room.seats)} 人
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 房间详情 */}
          <section className="gv-panel gv-detail" aria-labelledby="gv-detail-title" aria-busy={detailLoading}>
            <div className="gv-phead">
              <h2 id="gv-detail-title">房间详情 / OVERSIGHT</h2>
              <span className="gv-detail-meta">
                {isRaw && <span className="gv-rawflag">RAW · 已记录审计</span>}
                <span className="gv-meta">
                  {selectedRoom
                    ? `${selectedRoom.displayCode ? `${selectedRoom.displayCode} · ` : ''}${selectedRoom.roomId}`
                    : '未选择'}
                </span>
              </span>
            </div>

            {!selectedId && (
              <p className="gv-empty">从左侧选择一个房间，查看公开状态与脱敏私有信息。</p>
            )}

            {selectedId && detailLoading && !detail && (
              <p className="gv-loading" role="status">正在读取房间视图…</p>
            )}

            {detailError && (
              <div className="gv-alert" role="alert">
                {detailError}
                <button
                  type="button"
                  className="gv-btn gv-btn--sm"
                  onClick={() => loadDetail(selectedId, 'masked')}
                >
                  重试
                </button>
              </div>
            )}

            {view && viewRoom && (
              <>
                <h3>公开状态 <em>PUBLIC</em></h3>
                <div className="gv-kv"><span>游戏</span><b>{viewRoom.gameTitle || viewRoom.gameType || '—'}</b></div>
                <div className="gv-kv"><span>状态</span><b>{STATUS_LABEL[uiStateOf(viewRoom)] || viewRoom.status || '—'}</b></div>
                <div className="gv-kv"><span>阶段</span><b>{viewRoom.phase || '—'}</b></div>
                <div className="gv-kv"><span>回合</span><b>{num(viewRoom.round)}</b></div>
                <div className="gv-kv">
                  <span>玩家</span>
                  <b>{viewPlayers.length}{selectedRoom ? ` / ${num(selectedRoom.seats)}` : ''}</b>
                </div>
                <div className="gv-kv"><span>房主</span><b>{viewRoom.hostName || '—'}</b></div>
                <div className="gv-kv"><span>创建</span><b>{formatTime(viewRoom.createdAt)}</b></div>
                <div className="gv-kv"><span>胜者</span><b>{winnerText(viewRoom.winner)}</b></div>
                <div className="gv-kv"><span>事件数</span><b>{num(viewMeta.eventCount)}</b></div>

                <h3>玩家 <em>PLAYERS</em></h3>
                {viewPlayers.length === 0 ? (
                  <p className="gv-empty">暂无玩家</p>
                ) : (
                  <div className="gv-table-wrap">
                    <table className="gv-table">
                      <thead>
                        <tr>
                          <th scope="col">座</th>
                          <th scope="col">玩家</th>
                          <th scope="col">状态</th>
                          <th scope="col">角色 / 阵营</th>
                          <th scope="col">secret</th>
                          <th scope="col">手牌 / 骰</th>
                        </tr>
                      </thead>
                      <tbody>
                        {viewPlayers.map((player) => (
                          <tr key={player.playerId}>
                            <td className="gv-seat">{num(player.seat)}</td>
                            <td>
                              <div className="gv-name">{player.name || player.playerId}</div>
                              <div className="gv-sub">
                                {player.playerId} · {player.kind || 'unknown'}
                                {player.brand ? ` · ${player.brand}` : ''}
                                {player.model ? ` · ${player.model}` : ''}
                              </div>
                            </td>
                            <td>
                              {player.alive === false ? (
                                <span className="gv-dead">出局</span>
                              ) : (
                                <span className="gv-hp">HP {num(player.hp)}</span>
                              )}
                            </td>
                            <td>
                              <div>{player.role || '—'}</div>
                              <div className="gv-sub">{player.team || '—'}</div>
                            </td>
                            <td>
                              {isRaw ? (
                                <code className="gv-js gv-js--hot">{JSON.stringify(player.secret ?? null)}</code>
                              ) : (
                                <span className="gv-lock">{maskedSecretText(player)}</span>
                              )}
                            </td>
                            <td className="gv-mono-cell">{handDiceText(player, isRaw)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <h3>
                  私有信息揭示
                  <em>PRIVATE · level={revealedMeta}</em>
                  {isRaw && <span className="gv-rawflag">RAW · 已记录审计</span>}
                </h3>

                <div className={`gv-reveal${isRaw ? ' is-raw' : ''}`}>
                  {viewPlayers.length === 0 ? (
                    <div className="gv-mline"><span>players[]</span><b>暂无</b></div>
                  ) : viewPlayers.map((player) => (
                    <div key={player.playerId} className="gv-mplayer">
                      <div className="gv-mline">
                        <span>{player.name || player.playerId} ({player.playerId}) · secret</span>
                        <b>{isRaw ? JSON.stringify(player.secret ?? null) : maskedSecretText(player)}</b>
                      </div>
                      <div className="gv-mline">
                        <span>{player.name || player.playerId} ({player.playerId}) · 手牌 / 骰子</span>
                        <b>
                          {isRaw
                            ? `${JSON.stringify(Array.isArray(player.hand) ? player.hand : [])} / ${JSON.stringify(Array.isArray(player.dice) ? player.dice : [])}`
                            : handDiceText(player, false)}
                        </b>
                      </div>
                      <div className="gv-mline">
                        <span>{player.name || player.playerId} ({player.playerId}) · thought</span>
                        <b>{thoughtText(player, isRaw)}</b>
                      </div>
                    </div>
                  ))}
                  <div className="gv-mline">
                    <span>asks[].context</span>
                    <b>{isRaw ? '见下方 ASKS 完整上下文' : '{"redacted":true}'}</b>
                  </div>
                </div>

                <div className="gv-reveal-hint">
                  锁定态不请求 raw，DOM 中只保留 redacted 标记与计数。
                  {isRaw
                    ? ' 当前为服务端返回的 raw 快照，不会随 3s 轮询自动刷新。'
                    : ' 点击下方按钮 → 填写 reason → 服务端写审计后才返回明文。'}
                </div>

                <button
                  type="button"
                  className="gv-btn gv-btn--reveal"
                  onClick={openReveal}
                  disabled={!canRaw || !detail}
                  aria-label="申请揭示 raw 档私有信息"
                  title={canRaw ? '需填写 reason 并二次确认' : 'viewer 无权查看 raw'}
                >
                  {isRaw ? '重新申请揭示 RAW' : '申请揭示 RAW'}
                </button>

                <div className="gv-warnbox">
                  揭示私有信息会破坏牌局公平。<b>仅用于仲裁与复盘</b>；raw 需 reason，且每次查看写快照 + 审计。
                </div>

                <h3>强制干预 <em>POST .../intervene</em></h3>
                <div className="gv-ops">
                  <button
                    type="button"
                    className="gv-btn gv-btn--danger"
                    onClick={() => openIntervene('abort')}
                    disabled={abortDisabled}
                    aria-label="强制结束房间"
                    title={abortDisabled ? '当前角色或房间状态不允许' : undefined}
                  >
                    强制结束 <small>{OP_EN.abort}</small>
                  </button>
                  <button
                    type="button"
                    className="gv-btn gv-btn--kick"
                    onClick={() => openIntervene('kick')}
                    disabled={kickDisabled}
                    aria-label="踢出玩家"
                    title={kickDisabled ? '需要 operator 以上、进行中房间与目标玩家' : undefined}
                  >
                    踢出玩家 <small>{OP_EN.kick}</small>
                  </button>
                  <button
                    type="button"
                    className="gv-btn"
                    onClick={() => openIntervene('advance-phase')}
                    disabled={advanceDisabled}
                    aria-label="跳到下一阶段"
                    title={advanceDisabled ? '仅对进行中的房间可用' : undefined}
                  >
                    跳到下一阶段 <small>{OP_EN['advance-phase']}</small>
                  </button>
                  {role === 'root' && (
                    <button
                      type="button"
                      className="gv-btn gv-btn--kick"
                      onClick={() => openIntervene('force-act')}
                      disabled={forceDisabled}
                      aria-label="代打行动（root）"
                      title={forceDisabled ? '仅 root 且房间进行中可用' : undefined}
                    >
                      代打行动 <small>{OP_EN['force-act']}</small>
                    </button>
                  )}
                </div>

                {!canIntervene && (
                  <div className="gv-warnbox gv-warnbox--warn">
                    当前角色为 viewer：只能查看脱敏视图，raw 与干预需 operator 以上权限。
                    前端禁用仅为体验优化，服务端仍会做权威校验。
                  </div>
                )}

                <h3>待决请求 <em>ASKS</em></h3>
                {viewAsks.length === 0 ? (
                  <p className="gv-empty">当前没有待决请求</p>
                ) : (
                  <ul className="gv-list">
                    {viewAsks.map((ask) => (
                      <li key={ask.askId}>
                        <div>
                          <b>{ask.playerId}</b> · {ask.kind || 'ask'}
                          <span className="gv-sub">　ask {ask.askId}{ask.deadline ? ` · 截止 ${formatTime(ask.deadline, true)}` : ''}</span>
                        </div>
                        {ask.payload !== undefined && (
                          <div className="gv-json">payload: {JSON.stringify(ask.payload)}</div>
                        )}
                        <div className={`gv-json${isRaw ? '' : ' is-locked'}`}>
                          context: {isRaw ? JSON.stringify(ask.context ?? null) : '{"redacted":true}'}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <h3>公开记录 <em>EVENTS</em></h3>
                {visibleEvents.length === 0 ? (
                  <p className="gv-empty">暂无事件</p>
                ) : (
                  <ul className="gv-list">
                    {visibleEvents
                      .slice()
                      .sort((a, b) => Number(b.seq) - Number(a.seq))
                      .slice(0, 8)
                      .map((event) => (
                        <li key={`${event.seq}-${event.type}`}>
                          <span className="gv-ev-seq">#{event.seq}</span>
                          {event.text || event.type || '事件'}
                          {isRaw && event.visibility && (
                            <span className="gv-ev-vis">{event.visibility}</span>
                          )}
                        </li>
                      ))}
                  </ul>
                )}

                {isRaw && viewThoughts.length > 0 && (
                  <>
                    <h3>思考链 <em>THOUGHTS</em></h3>
                    <ul className="gv-list">
                      {viewThoughts
                        .slice()
                        .sort((a, b) => Number(b.seq) - Number(a.seq))
                        .slice(0, 10)
                        .map((thought) => (
                          <li key={`${thought.playerId}-${thought.seq}`}>
                            <span className="gv-ev-seq">{thought.playerId} · #{thought.seq}</span>
                            {thought.delta || ''}
                            <span className="gv-sub">　{formatTime(thought.at, true)}</span>
                          </li>
                        ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>

          {/* 审计 */}
          <section className="gv-panel gv-span" aria-labelledby="gv-audit-title" aria-busy={auditLoading}>
            <div className="gv-phead">
              <h2 id="gv-audit-title">审计记录 / AUDIT TRAIL</h2>
              <span className="gv-audit-head">
                <span className="gv-meta">append-only · sha256 哈希链 · seal = hash 前 8 位</span>
                <button
                  type="button"
                  className="gv-btn gv-btn--sm"
                  onClick={loadAudit}
                  disabled={auditLoading}
                  aria-label="刷新审计流水"
                >
                  {auditLoading ? '刷新中…' : '刷新'}
                </button>
              </span>
            </div>

            {auditError && <div className="gv-alert" role="alert">{auditError}</div>}

            <div className="gv-audit-wrap">
              <table className="gv-table gv-audit-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">时间</th>
                    <th scope="col">操作者</th>
                    <th scope="col">ACTION</th>
                    <th scope="col">目标</th>
                    <th scope="col">REASON</th>
                    <th scope="col">SEAL</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="gv-empty">暂无审计记录</td>
                    </tr>
                  ) : audit.map((record) => {
                    const seal = record.seal || (record.hash ? String(record.hash).slice(0, 8) : '—');
                    const target = `${record.targetType || ''} ${record.targetId || ''}`.trim() || '—';
                    return (
                      <tr key={record.id}>
                        <td className="gv-seat">{record.id}</td>
                        <td className="gv-nowrap">{formatTime(record.createdAt, true)}</td>
                        <td>{record.actorUsername || 'system'}</td>
                        <td className="gv-audit-action">{record.action || '—'}</td>
                        <td className="gv-mono-cell">{target}</td>
                        <td className="gv-audit-reason">{record.reason || '—'}</td>
                        <td><span className="gv-audit-seal">seal {seal}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {/* 二次确认弹窗 */}
      {modal && (
        <div
          className="gv-modal"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeModal();
          }}
        >
          <div
            className="gv-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gv-modal-title"
          >
            <h2 id="gv-modal-title">
              {modal.mode === 'reveal'
                ? '申请揭示私有信息 · RAW'
                : `${OP_LABEL[modal.action] || '干预'} · 二次确认`}
            </h2>

            {modal.mode === 'reveal' ? (
              <p className="gv-sheet-desc">
                即将请求
                {' '}
                <span className="gv-target">
                  GET /api/admin/rooms/{selectedId}/godview?level=raw
                </span>
                。仅用于仲裁与复盘，本次查看会写快照与审计，且 raw 不会随轮询自动刷新。
              </p>
            ) : (
              <p className="gv-sheet-desc">
                你正在对
                {' '}
                <span className="gv-target">
                  {selectedRoom ? `${selectedRoom.displayCode ? `${selectedRoom.displayCode}（` : ''}${selectedId}${selectedRoom.displayCode ? '）' : ''}` : selectedId}
                </span>
                {' '}
                执行「{OP_LABEL[modal.action] || modal.action}」。不可撤销，且写入审计。
                {modal.action === 'force-act' && ' 该操作会直接改写对局结果，请先取 raw 快照确认 before。'}
              </p>
            )}

            {modalNeedsTarget && (
              <div className="gv-field gv-field-inline">
                <label htmlFor="gv-modal-target">目标玩家 / TARGET</label>
                <select
                  id="gv-modal-target"
                  className="gv-input"
                  value={modal.targetId}
                  onChange={(event) => patchModal({ targetId: event.target.value })}
                >
                  <option value="">请选择玩家</option>
                  {viewPlayers.map((player) => (
                    <option key={player.playerId} value={player.playerId}>
                      {`${num(player.seat)} · ${player.name || player.playerId}（${player.playerId}）`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {modalNeedsPayload && (
              <div className="gv-field gv-field-inline">
                <label htmlFor="gv-modal-payload">ACTION PAYLOAD / JSON</label>
                <textarea
                  id="gv-modal-payload"
                  className="gv-textarea"
                  value={modal.payloadText}
                  placeholder='{"say":"…","action":{…}}'
                  spellCheck={false}
                  onChange={(event) => patchModal({ payloadText: event.target.value })}
                />
                {modal.payloadText.trim() && !payloadState.ok && (
                  <div className="gv-audit-tip">payload 不是合法 JSON，确认按钮保持禁用。</div>
                )}
              </div>
            )}

            <div className="gv-reason">
              <label htmlFor="gv-modal-reason">REASON / 操作理由（必填，写入审计）</label>
              <textarea
                id="gv-modal-reason"
                className="gv-textarea"
                ref={reasonRef}
                value={modal.reason}
                placeholder="例如：牌局卡死超过 10 分钟，人工结束"
                onChange={(event) => patchModal({ reason: event.target.value })}
              />
              <div className="gv-audit-tip">
                本次查看 / 操作将被记录：who / when / target / before / after / reason。
              </div>
            </div>

            <label className="gv-check">
              <input
                type="checkbox"
                checked={modal.ack}
                onChange={(event) => patchModal({ ack: event.target.checked })}
              />
              <span>我知悉此操作不可撤销，并将写入审计</span>
            </label>

            {modal.error && <div className="gv-alert gv-alert--modal" role="alert">{modal.error}</div>}

            <div className="gv-sheet-ops">
              <button
                type="button"
                className="gv-btn"
                onClick={closeModal}
                disabled={modal.submitting}
              >
                取消
              </button>
              <button
                type="button"
                className="gv-btn gv-btn--danger"
                onClick={handleConfirm}
                disabled={!canConfirm || modal.submitting}
                aria-busy={modal.submitting}
              >
                {modal.submitting ? '执行中…' : modal.mode === 'reveal' ? '确认揭示并记录' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toastNode}
    </div>
  );
}
