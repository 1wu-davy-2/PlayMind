'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const MAX_RECENT = 8;

const STATUS_TEXT = {
  lobby: '等待入席',
  waiting: '等待入席',
  playing: '对局中',
  ended: '已结束',
};

const FALLBACK_GAME = {
  id: 'bomb-table',
  title: 'BOMB TABLE',
  desc: '抽牌审讯 · 看 AI 互相说谎',
  min: 2,
  max: 6,
};

/* ---------------- 通用小工具 ---------------- */

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/** 行内 Markdown：`code` / **bold** / *em*，先转义再格式化，避免注入。 */
function inlineMd(text) {
  return String(text == null ? '' : text)
    .split(/(`[^`]*`)/g)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    })
    .join('');
}

/** 规则 Markdown 的简易渲染：标题 / 列表 / 代码块 / 表格 / 引用 / 分隔线。 */
function mdToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const isFence = (s) => /^```/.test(String(s).trim());
  const tableCells = (s) => String(s).trim().replace(/^\|/, '').replace(/\|$/, '')
    .split('|').map((c) => c.trim());
  const isTableSep = (s) => {
    if (!s || !s.includes('-')) return false;
    const cells = tableCells(s);
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  };
  const isTableStart = (idx) => Boolean(
    lines[idx] && lines[idx].includes('|') && lines[idx + 1] && isTableSep(lines[idx + 1]),
  );
  const isListItem = (s) => /^\s*[-*+]\s+/.test(s);
  const isOrderedItem = (s) => /^\s*\d+[.)]\s+/.test(s);
  const isHeading = (s) => /^#{1,6}\s+/.test(String(s).trim());
  const isQuote = (s) => /^\s*>\s?/.test(s);
  const isHr = (s) => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(s);
  const isBlockStart = (idx) => {
    const s = lines[idx];
    if (!s) return false;
    return isFence(s) || isHeading(s) || isListItem(s) || isOrderedItem(s)
      || isQuote(s) || isHr(s) || isTableStart(idx);
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i += 1; continue; }

    if (isFence(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) { buf.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1;
      out.push(`<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (isHr(line)) { out.push('<hr>'); i += 1; continue; }

    if (isTableStart(i)) {
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      const headHtml = head.map((c, idx) => (
        `<th${align[idx] ? ` style="text-align:${align[idx]}"` : ''}>${inlineMd(c)}</th>`
      )).join('');
      const bodyHtml = rows.map((cells) => (
        `<tr>${head.map((_, idx) => (
          `<td${align[idx] ? ` style="text-align:${align[idx]}"` : ''}>${inlineMd(cells[idx] || '')}</td>`
        )).join('')}</tr>`
      )).join('');
      out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    if (isListItem(line)) {
      const items = [];
      while (i < lines.length && isListItem(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (isOrderedItem(line)) {
      const items = [];
      while (i < lines.length && isOrderedItem(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${buf.map(inlineMd).join('<br>')}</blockquote>`);
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(i)) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
  }

  return out.join('');
}

function gameRange(game) {
  const rawMin = Number(game && game.min);
  const rawMax = Number(game && game.max);
  const min = Number.isFinite(rawMin) ? Math.max(2, Math.trunc(rawMin)) : 2;
  const max = Number.isFinite(rawMax) ? Math.max(min, Math.trunc(rawMax)) : Math.max(min, 6);
  return { min, max };
}

function clampSeats(value, min, max) {
  const n = Number(value);
  const base = Number.isFinite(n) ? Math.round(n) : min;
  return Math.min(Math.max(base, min), max);
}

async function requestJson(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `请求失败（${res.status}）`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return data;
}

/** 读取开桌时缓存下来的邀请话术（会话级，隐私模式失败则返回空）。 */
function readStoredInvite(roomId) {
  if (!roomId) return '';
  try {
    return sessionStorage.getItem(`bt_invite_${roomId}`) || '';
  } catch {
    return '';
  }
}

async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 剪贴板 API 不可用时回退到 textarea */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ---------------- 组件 ---------------- */

export default function Lobby() {
  const router = useRouter();

  const [games, setGames] = useState([]);
  const [gamesError, setGamesError] = useState('');
  const [gameId, setGameId] = useState(FALLBACK_GAME.id);
  const [seats, setSeats] = useState(FALLBACK_GAME.min);
  const [mode, setMode] = useState('mixed');
  const [humanName, setHumanName] = useState('魏工');
  const [hostName, setHostName] = useState('');

  const [creating, setCreating] = useState(false);
  const [selfplaying, setSelfplaying] = useState(false);
  const [formError, setFormError] = useState('');

  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesMap, setRulesMap] = useState({});

  const [recentRooms, setRecentRooms] = useState([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState('');
  const [copyingKey, setCopyingKey] = useState('');

  const [toast, setToast] = useState(null);

  const gameIdRef = useRef(gameId);
  const rulesCacheRef = useRef(new Map());
  const inviteCacheRef = useRef(new Map());
  const toastTimerRef = useRef(null);
  const closeBtnRef = useRef(null);

  useEffect(() => { gameIdRef.current = gameId; }, [gameId]);
  useEffect(() => () => { clearTimeout(toastTimerRef.current); }, []);

  const showToast = useCallback((text, bad = false) => {
    setToast({ text, bad });
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  }, []);

  const currentGame = useMemo(
    () => games.find((g) => g.id === gameId) || games[0] || FALLBACK_GAME,
    [games, gameId],
  );
  const { min, max } = gameRange(currentGame);
  const seatValue = clampSeats(seats, min, max);

  /* ---------- 游戏目录 ---------- */

  const loadGames = useCallback(async () => {
    setGamesError('');
    try {
      const data = await requestJson('/api/games');
      const list = (Array.isArray(data && data.games) ? data.games : Array.isArray(data) ? data : [])
        .filter((g) => g && typeof g.id === 'string' && g.id);
      if (!list.length) throw new Error('游戏目录为空，请稍后重试');
      setGames(list);
      const preferred = list.find((g) => g.id === gameIdRef.current)
        || list.find((g) => g.id === FALLBACK_GAME.id)
        || list[0];
      setGameId(preferred.id);
      setSeats(gameRange(preferred).min);
    } catch (err) {
      setGames([]);
      setGamesError(err.message || '游戏目录加载失败');
    }
  }, []);

  /* ---------- 最近房间 ---------- */

  const loadRecent = useCallback(async () => {
    setRecentLoading(true);
    setRecentError('');
    try {
      const data = await requestJson('/api/rooms');
      const list = Array.isArray(data && data.rooms) ? data.rooms : Array.isArray(data) ? data : [];
      setRecentRooms(list.filter((r) => r && r.roomId).slice(0, MAX_RECENT));
    } catch (err) {
      setRecentRooms([]);
      setRecentError(err.message || '最近房间加载失败');
    } finally {
      setRecentLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGames();
    loadRecent();
  }, [loadGames, loadRecent]);

  /* ---------- 规则 ---------- */

  const ensureRules = useCallback(async (id, force = false) => {
    if (!id) return;
    if (!force && rulesCacheRef.current.has(id)) return;
    setRulesMap((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(id)}/rules`, { cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) {
        let message = `规则加载失败（${res.status}）`;
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.error) message = parsed.error;
        } catch { /* 非 JSON 错误体，沿用状态码提示 */ }
        throw new Error(message);
      }
      rulesCacheRef.current.set(id, text);
      setRulesMap((prev) => ({ ...prev, [id]: { markdown: text } }));
    } catch (err) {
      rulesCacheRef.current.delete(id);
      setRulesMap((prev) => ({ ...prev, [id]: { error: err.message || '规则加载失败' } }));
    }
  }, []);

  useEffect(() => {
    if (!games.length) return;
    ensureRules(gameId);
  }, [gameId, games.length, ensureRules]);

  const rulesState = rulesMap[gameId];
  const rulesMarkdown = (rulesState && rulesState.markdown) || '';
  const rulesLoading = !rulesState || Boolean(rulesState.loading);
  const rulesError = (rulesState && rulesState.error) || '';
  const rulesHtml = useMemo(() => mdToHtml(rulesMarkdown), [rulesMarkdown]);

  useEffect(() => {
    if (!rulesOpen) return undefined;
    if (closeBtnRef.current) closeBtnRef.current.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setRulesOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [rulesOpen]);

  /* ---------- 选择 ---------- */

  function selectGame(game) {
    if (!game || game.id === gameId) return;
    const range = gameRange(game);
    setGameId(game.id);
    setSeats((prev) => clampSeats(prev, range.min, range.max));
    setFormError('');
  }

  /* ---------- 开桌 / 自玩 ---------- */

  async function handleCreate(event) {
    if (event) event.preventDefault();
    if (creating || selfplaying || !games.length) return;
    const name = (humanName || '').trim().slice(0, 12) || '魏工';
    const host = (hostName || '').trim().slice(0, 12);
    setCreating(true);
    setFormError('');
    try {
      const payload = {
        gameType: gameId,
        seats: seatValue,
        mode,
        humanName: name,
        autoStart: mode === 'ai',
      };
      if (host) payload.hostName = host;

      const data = await requestJson('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!data || !data.roomId) throw new Error('服务端未返回房间号');

      try {
        if (data.hostToken) localStorage.setItem(`bt_host_${data.roomId}`, data.hostToken);
        if (data.humanToken) localStorage.setItem(`bt_token_${data.roomId}`, data.humanToken);
      } catch {
        /* 隐私模式下无法写入本地存储，牌桌会退化为观战 */
      }

      const inviteText = data.invite || data.pitch || '';
      if (inviteText) {
        try { sessionStorage.setItem(`bt_invite_${data.roomId}`, inviteText); } catch { /* 忽略 */ }
      }

      router.push(`/table/${encodeURIComponent(data.roomId)}`);
    } catch (err) {
      const message = err.message || '开桌失败';
      setFormError(message);
      showToast(message, true);
    } finally {
      setCreating(false);
    }
  }

  async function handleSelfplay() {
    if (selfplaying || creating || !games.length) return;
    setSelfplaying(true);
    setFormError('');
    try {
      const data = await requestJson('/api/selfplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: gameId, seats: seatValue }),
      });
      if (!data || !data.roomId) throw new Error('服务端未返回房间号');
      router.push(`/table/${encodeURIComponent(data.roomId)}`);
    } catch (err) {
      const message = err.message || '一键自玩失败';
      setFormError(message);
      showToast(message, true);
    } finally {
      setSelfplaying(false);
    }
  }

  /* ---------- 进入 / 复制 ---------- */

  function enterRoom(roomId) {
    if (!roomId) return;
    router.push(`/table/${encodeURIComponent(roomId)}`);
  }

  function joinUrlOf(room) {
    if (room && room.joinUrl) return room.joinUrl;
    if (typeof window === 'undefined' || !room || !room.roomId) return '';
    return `${window.location.origin}/join/${encodeURIComponent(room.roomId)}`;
  }

  async function handleCopyJoin(room) {
    if (!room || !room.roomId || copyingKey) return;
    setCopyingKey(`join:${room.roomId}`);
    const ok = await copyText(joinUrlOf(room));
    setCopyingKey('');
    if (ok) showToast('接入链接已复制');
    else showToast('接入链接复制失败，请手动复制', true);
  }

  async function handleCopyInvite(room) {
    if (!room || !room.roomId || copyingKey) return;
    setCopyingKey(`invite:${room.roomId}`);

    let text = room.invite || room.pitch || inviteCacheRef.current.get(room.roomId)
      || readStoredInvite(room.roomId) || '';
    if (!text) {
      try {
        const data = await requestJson(`/api/rooms/${encodeURIComponent(room.roomId)}/invite`);
        text = (data && (data.invite || data.pitch || data.text)) || '';
      } catch {
        text = '';
      }
    }
    if (!text) {
      const title = room.gameTitle || room.gameType || 'PlayMind';
      text = `来打一局「${title}」。打开这个链接，按里面的说明入座并开始行动：${joinUrlOf(room)}`;
    }
    inviteCacheRef.current.set(room.roomId, text);

    const ok = await copyText(text);
    setCopyingKey('');
    if (ok) showToast('邀请话术已复制');
    else showToast('邀请话术复制失败，请手动复制', true);
  }

  /* ---------- 渲染辅助 ---------- */

  const canCreate = games.length > 0 && !creating && !selfplaying;
  const seatNote = mode === 'ai'
    ? `${seatValue} 人桌 · 全是 AI，你只看`
    : `${seatValue} 人桌 · 你 + ${Math.max(0, seatValue - 1)} 个 AI`;
  const actionNote = creating
    ? '正在生成接入令…'
    : selfplaying
      ? '正在让 AI 们落座…'
      : games.length
        ? `${currentGame.title} · ${currentGame.desc || ''}`
        : '';

  return (
    <div className="lobby-page">
      <div className="pm-grain" aria-hidden="true" />
      <div className="pm-vignette" aria-hidden="true" />

      <main className="pm-wrap">
        <header className="pm-masthead">
          <div>
            <div className="pm-brand">
              <span className="pm-brand__en">PLAY</span>
              <span className="pm-brand__en alt">MIND</span>
              <span className="pm-brand__pm">多智能体牌局</span>
            </div>
            <p className="pm-brand__cn">AI 同桌 · 公开思考 · 全程监听</p>
          </div>
          <div className="pm-filemeta">
            <span>卷宗 BT · {String(games.length || 9).padStart(2, '0')} 款游戏</span>
            <span className="pm-stamp">机密 · TOP SECRET</span>
          </div>
        </header>

        <section aria-labelledby="pm-title">
          <div className="pm-hero">
            <div>
              <div className="pm-kicker">立案申请 / CASE INTAKE</div>
              <h1 id="pm-title" className="pm-title">开一张<span>新牌桌</span></h1>
            </div>
            <div className="pm-seal" aria-hidden="true">
              机密
              <span>PlayMind</span>
            </div>
          </div>

          <p className="pm-lede">
            你坐主位，剩下的椅子留给 AI。选一款游戏、开好桌，把<b>接入链接</b>发给任意 AI ——
            它会自己读说明书、入座、开始撒谎。
          </p>

          <form className="pm-card" onSubmit={handleCreate}>
            <div className="pm-field">
              <div className="pm-field-label">牌桌类型 <em>GAME</em></div>
              {gamesError ? (
                <div className="pm-alert" role="alert">
                  {gamesError}
                  <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={loadGames}>
                    重 试
                  </button>
                </div>
              ) : games.length === 0 ? (
                <p className="pm-loading" role="status">正在载入游戏目录…</p>
              ) : (
                <div className="pm-games" role="radiogroup" aria-label="选择游戏">
                  {games.map((game, index) => (
                    <button
                      key={game.id}
                      type="button"
                      role="radio"
                      aria-checked={game.id === gameId}
                      className="pm-game"
                      onClick={() => selectGame(game)}
                    >
                      <span className="pm-game__tick" aria-hidden="true">✓</span>
                      <span className="pm-game__no">{`NO.${String(index + 1).padStart(2, '0')}`}</span>
                      <span className="pm-game__t">{game.title || game.id}</span>
                      <span className="pm-game__d">{game.desc || ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="pm-form-row">
              <div className="pm-field">
                <label className="pm-field-label" htmlFor="pm-human-name">
                  你的名字 <em>NAME</em>
                </label>
                <input
                  id="pm-human-name"
                  className="pm-input"
                  value={humanName}
                  maxLength={12}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setHumanName(event.target.value)}
                />
              </div>
              <div className="pm-field">
                <label className="pm-field-label" htmlFor="pm-host-name">
                  房主名 <em>HOST · 可选</em>
                </label>
                <input
                  id="pm-host-name"
                  className="pm-input"
                  value={hostName}
                  maxLength={12}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="留空则记为「房主」"
                  onChange={(event) => setHostName(event.target.value)}
                />
              </div>
            </div>

            <div className="pm-field">
              <div className="pm-field-label">牌桌模式 <em>MODE</em></div>
              <div className="pm-seg" role="radiogroup" aria-label="牌桌模式">
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'mixed'}
                  onClick={() => setMode('mixed')}
                >
                  和 AI 同桌
                  <small>你亲自下场</small>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'ai'}
                  onClick={() => setMode('ai')}
                >
                  只看 AI 打
                  <small>纯 AI 房 · 观战</small>
                </button>
              </div>
            </div>

            <div className="pm-field">
              <div className="pm-seat-head">
                <label className="pm-field-label" htmlFor="pm-seats">
                  席位数量 <em>SEATS</em>
                </label>
                <span className="pm-seat-count">{seatValue} 人</span>
              </div>
              <input
                id="pm-seats"
                className="pm-range"
                type="range"
                min={min}
                max={max}
                step={1}
                value={seatValue}
                style={{ '--fill': `${(max > min ? ((seatValue - min) / (max - min)) : 0) * 100}%` }}
                aria-valuetext={`${seatValue} 人`}
                aria-describedby="pm-seat-note"
                onChange={(event) => setSeats(clampSeats(event.target.value, min, max))}
              />
              <div className="pm-range-meta">
                <span>{min} 人</span>
                <span id="pm-seat-note" className="pm-seat-note">{seatNote}</span>
                <span>{max} 人</span>
              </div>
            </div>

            <div className="pm-actions">
              <button
                type="submit"
                className="pm-btn pm-btn--primary pm-btn--xl"
                disabled={!canCreate}
                aria-busy={creating}
              >
                {creating ? '正在立卷…' : mode === 'ai' ? '开 一 桌 纯 A I' : '开 桌'}
              </button>

              {mode === 'ai' && (
                <button
                  type="button"
                  className="pm-btn pm-btn--ghost"
                  disabled={!canCreate}
                  aria-busy={selfplaying}
                  onClick={handleSelfplay}
                >
                  {selfplaying ? '正在开局…' : '一键自玩'}
                </button>
              )}

              <button
                type="button"
                className="pm-btn pm-btn--ghost"
                onClick={() => {
                  setRulesOpen(true);
                  if (games.length) ensureRules(gameId);
                }}
              >
                牌 局 规 则
              </button>

              <span className="pm-note" role="status" aria-live="polite">{actionNote}</span>
            </div>

            {formError && (
              <div className="pm-alert" role="alert">{formError}</div>
            )}
          </form>
        </section>

        <section className="pm-section" aria-labelledby="pm-recent-title" aria-busy={recentLoading}>
          <div className="pm-section-head">
            <h2 id="pm-recent-title">最近房间 <b>{recentRooms.length ? `· ${recentRooms.length}` : ''}</b></h2>
            <button
              type="button"
              className="pm-btn pm-btn--ghost pm-btn--sm"
              onClick={loadRecent}
              disabled={recentLoading}
            >
              {recentLoading ? '刷新中…' : '刷 新'}
            </button>
          </div>

          {recentError && (
            <div className="pm-alert" role="alert">{recentError}</div>
          )}

          {recentLoading ? (
            <p className="pm-loading" role="status">正在读取最近的牌桌…</p>
          ) : recentRooms.length === 0 ? (
            <p className="pm-empty">
              还没有房间。开一张新牌桌，或让 AI 自己开房 —— 入口见页面底部「AI 手册」。
            </p>
          ) : (
            <div className="pm-rooms">
              {recentRooms.map((room) => {
                const statusText = STATUS_TEXT[room.status] || room.status || '未知状态';
                const filled = Number(room.filled);
                const total = Number(room.seats);
                const fillText = Number.isFinite(filled) && Number.isFinite(total)
                  ? `${filled}/${total} 席`
                  : '席位未知';
                const modeText = room.mode === 'ai' ? '纯 AI 房' : '和 AI 同桌';
                return (
                  <article className="pm-room" key={room.roomId}>
                    <button
                      type="button"
                      className="pm-room__main"
                      onClick={() => enterRoom(room.roomId)}
                      aria-label={`进入房间 ${room.roomId}`}
                    >
                      <span className="pm-room__top">
                        <span className="pm-room__id">{room.roomId}</span>
                        <span className="pm-room__title">{room.gameTitle || room.gameType || '牌桌'}</span>
                        <span className={`pm-room__status${room.status === 'playing' ? ' is-live' : ''}`}>
                          {statusText}
                        </span>
                      </span>
                      <span className="pm-room__meta">{`${fillText} · ${modeText}`}</span>
                      {room.canJoin && room.status !== 'ended' && (
                        <span className="pm-room__joinable">可加入</span>
                      )}
                    </button>
                    <div className="pm-room__acts">
                      <button
                        type="button"
                        className="pm-btn pm-btn--ghost pm-btn--sm"
                        onClick={() => handleCopyJoin(room)}
                        disabled={copyingKey === `join:${room.roomId}`}
                        aria-label={`复制 ${room.roomId} 的接入链接`}
                      >
                        复制链接
                      </button>
                      <button
                        type="button"
                        className="pm-btn pm-btn--ghost pm-btn--sm"
                        onClick={() => handleCopyInvite(room)}
                        disabled={copyingKey === `invite:${room.roomId}`}
                        aria-label={`复制 ${room.roomId} 的邀请话术`}
                      >
                        邀请话术
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <footer>
          <div className="pm-footnotes">
            <div>
              <b>牌 堆 / 26 张</b>
              <p>炸弹、质询、安全、补给。顺序在你们坐下之前就定好了。</p>
            </div>
            <div>
              <b>质 询 是 刀</b>
              <p>受审的人能偷看下一张牌，然后当着所有人的面回答你。</p>
            </div>
            <div>
              <b>思 考 是 公 开 的</b>
              <p>AI 的内心独白实时打在监听记录上 —— 它知道你在看。</p>
            </div>
          </div>

          <nav className="pm-links" aria-label="更多入口">
            <a className="pm-link" href="/godview">
              造物主后台 <span>/godview</span>
            </a>
            <a className="pm-link" href="/api/manual" target="_blank" rel="noreferrer">
              AI 手册 <span>GET /api/manual</span>
            </a>
          </nav>
        </footer>
      </main>

      {rulesOpen && (
        <div
          className="modal open"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRulesOpen(false);
          }}
        >
          <div className="sheet sheet--wide" role="dialog" aria-modal="true" aria-labelledby="pm-rules-title">
            <div className="sheet__head">
              <h2 id="pm-rules-title">{currentGame.title || currentGame.id} · 规则</h2>
              <button
                type="button"
                className="sheet__close"
                aria-label="关闭规则"
                ref={closeBtnRef}
                onClick={() => setRulesOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="pm-rules">
              {rulesLoading && (
                <p className="pm-rules__hint" role="status">正在取回规则…</p>
              )}

              {!rulesLoading && rulesError && (
                <div className="pm-alert" role="alert">
                  {rulesError}
                  <button
                    type="button"
                    className="pm-btn pm-btn--ghost pm-btn--sm"
                    onClick={() => ensureRules(gameId, true)}
                  >
                    重 试
                  </button>
                </div>
              )}

              {!rulesLoading && !rulesError && rulesMarkdown && (
                <>
                  <div className="pm-rules__meta">
                    {`GAME · ${currentGame.id}${currentGame.desc ? `　${currentGame.desc}` : ''}`}
                  </div>
                  <div className="pm-md" dangerouslySetInnerHTML={{ __html: rulesHtml }} />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        className={`pm-toast${toast ? ' show' : ''}${toast && toast.bad ? ' is-bad' : ''}`}
        role="status"
        aria-live="polite"
      >
        {toast ? toast.text : ''}
      </div>
    </div>
  );
}
