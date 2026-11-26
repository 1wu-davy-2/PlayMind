// 端到端自测：4 人房（1 人类席位 + 3 个参考 bot），打印紧凑时间线。
// 运行：BASE_URL=http://127.0.0.1:8770 node agents/run-demo.mjs
//
// 时间线优先读 SSE（契约 §6，事件最全）；SSE 不通时退回轮询 state.log（契约 §3）。

import { BombTableAgent } from './client.mjs';
import { PERSONAS, runBot, conservativeAction } from './bot.mjs';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8770').replace(/\/+$/, '');
const TOTAL_TIMEOUT_MS = 300_000;
const SEATS = 4;
const CARD_LABEL = { bomb: '炸弹', safe: '安全', question: '质询', supply: '补给' };
const ITEM_LABEL = { defuse: '拆弹钳', xray: '透视', swap: '换手' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(...args);
const pick = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};
const clip = (s, n = 56) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function makeTimeline() {
  const names = new Map();
  const counters = {};
  const remember = (state) => {
    for (const p of state?.players || []) names.set(p.id, p.name);
  };
  const nm = (id) => (id ? names.get(id) || id : '?');
  const count = (k) => {
    counters[k] = (counters[k] || 0) + 1;
  };

  // 引擎事件用 t / drawerId / targetId 等字段；日志条目字段可能不同，做宽匹配。
  function handle(ev) {
    const k = pick(ev, 't', 'kind', 'type') || '?';
    const who = pick(ev, 'playerId', 'pid', 'actorId');
    const target = pick(ev, 'targetId', 'onId', 'victimId');
    const cardName = (c) => CARD_LABEL[c] || c || '?';
    switch (k) {
      case 'begin':
        count(k);
        return log(`[开局] ${(ev.seats || []).map((s) => s.name).join(' / ')}`);
      case 'turn':
        count(k);
        return log(`[轮次] 第 ${ev.round ?? '?'} 轮 · ${nm(who)}`);
      case 'ask':
        count(k);
        return log(`[提问] ${nm(ev.ask?.playerId)} ← ${ev.ask?.kind}`);
      case 'join':
        count(k);
        if (ev.name && who) names.set(who, ev.name);
        return log(`[入座] ${ev.name || nm(who)}`);
      case 'draw':
        count(k);
        return log(`[抽牌] ${nm(who)} → ${cardName(ev.card)}，剩 ${ev.deckLeft ?? '?'} 张`);
      case 'resolve':
        if (ev.card === 'question' || ev.card === 'supply') {
          count(k);
          return log(`[牌面] ${nm(who)} ${ev.text || cardName(ev.card)}`);
        }
        return;
      case 'item':
        count(k);
        return log(
          `[道具] ${nm(who)} 使用 ${ITEM_LABEL[ev.item] || ev.item}${ev.targetId ? ` → ${nm(ev.targetId)}` : ''}`
        );
      case 'handover':
        count(k);
        return log(`[换手] ${nm(ev.fromId)} 把回合交给 ${nm(ev.toId)}`);
      case 'target':
        count(k);
        return log(`[审问] ${nm(ev.drawerId || who)} 指定 ${nm(target)}`);
      case 'say':
        count(k);
        return log(`[发言] ${nm(who)}：“${clip(ev.text, 60)}”`);
      case 'thought':
        count(k);
        return log(`[独白] ${nm(who)}：${clip(ev.delta, 50)}`);
      case 'verdict':
        count(k);
        return log(
          `[判决] ${nm(ev.drawerId || who)} ${ev.decision === 'accuse' ? '指控' : '相信'} ${nm(target)}`
        );
      case 'truth': {
        count(k);
        const head = `${nm(target)} 声称 ${ev.claim} / 实际 ${ev.actualCard}`;
        const tail = ev.lied
          ? ev.decision === 'accuse'
            ? '撒谎 → 被抓，-1HP'
            : '撒谎 → 被信了'
          : ev.decision === 'accuse'
            ? '如实 → 指控错误，-1HP'
            : '如实';
        return log(`[揭秘] ${head} / ${tail}`);
      }
      case 'damage':
        count(k);
        return log(`[受伤] ${nm(who)} -${ev.amount ?? 1}HP（剩 ${ev.hp ?? '?'}）`);
      case 'defused':
        count(k);
        return log(`[拆弹] ${nm(who)} 用拆弹钳化解`);
      case 'caught':
        return; // 已由 truth + damage 表达
      case 'wrong':
        count(k);
        return log(`[误判] ${nm(ev.drawerId || who)} 指控落空`);
      case 'eliminate':
        count(k);
        return log(`[出局] ${nm(who)}`);
      case 'timeout':
        count(k);
        return log(`[超时] ${nm(who)} 系统代打（${ev.kind || '?'}）`);
      case 'reshuffle':
        count(k);
        return log(`[洗牌] 弃牌回洗，牌堆 ${ev.deckLeft ?? '?'} 张`);
      case 'end':
        count(k);
        return log(`[结束] 胜者：${ev.winnerName || nm(ev.winnerId)}`);
      case 'state':
      case 'tick':
      case 'thought-end':
      case 'intel':
      case 'peek':
        return;
      default:
        count(k);
        return log(`[${k}] ${clip(JSON.stringify(ev), 120)}`);
    }
  }

  return { handle, remember, nm, counters };
}

async function consumeSSE(url, onEvent, signal) {
  const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* 忽略半包 */
        }
      }
    }
  }
}

function printSummary(state, counters, nm) {
  const players = state?.players || [];
  log('');
  log('──────── 结果 ────────');
  const winner = state?.winner;
  log(`胜者：${winner ? winner.name || nm(winner.id) : '未知（状态里没有 winner）'}`);
  log(`轮数：${state?.round ?? '?'} · 牌堆剩 ${state?.deckLeft ?? '?'} 张（炸弹 ${state?.bombsLeft ?? '?'}）`);
  log('');
  log('玩家：');
  for (const p of players) {
    log(
      `  ${p.glyph || '·'} ${String(p.name).padEnd(4, '　')} hp ${p.hp}/${p.maxHp}  被抓 ${p.caught ?? 0} 次  ` +
        `道具[${(p.items || []).map((i) => ITEM_LABEL[i] || i).join(',') || '-'}]  ${p.alive === false ? '出局' : '存活'}`
    );
  }
  const keys = Object.keys(counters).sort((a, b) => counters[b] - counters[a]);
  log('');
  log(`事件统计：${keys.map((k) => `${k}×${counters[k]}`).join('  ') || '（无）'}`);
  log('──────────────────────');
}

// 人类席位（p0）无真人操作，用它自己的 token 提交保守动作，避免整局卡死。
// 契约没有"托管"开关，这是自测侧的兜底。
async function humanProxy({ client, roomId, token, playerId, stop }) {
  while (!stop.done) {
    let snap;
    try {
      snap = await client.poll(roomId, token);
    } catch {
      await sleep(600);
      continue;
    }
    if (snap?.state?.status === 'ended') return { acted: true };
    const ask = snap.ask;
    if (ask && (!ask.playerId || ask.playerId === playerId)) {
      try {
        await client.think(roomId, token, '（观察员 · 托管中）');
        await client.act(roomId, token, { action: conservativeAction({ ask, you: snap.you }), say: '我先保守一点。' });
      } catch (err) {
        log(`  [托管失败] ${err.message}`);
        await sleep(300);
      }
    }
    await sleep(450);
  }
}

async function main() {
  log(`BOMB TABLE demo · ${BASE_URL}`);
  const client = new BombTableAgent({ baseUrl: BASE_URL });
  const timeline = makeTimeline();
  const { counters, nm } = timeline;
  let latestState = null;
  const stop = { done: false };

  log('');
  log('[1/4] 创建房间…');
  const room = await client.createRoom({ humanName: '观察员', seats: SEATS });
  const roomId = room.roomId || room.id;
  if (!roomId) throw new Error(`创建房间返回缺少 roomId：${clip(JSON.stringify(room), 200)}`);
  latestState = room.state || null;
  timeline.remember(latestState);
  log(`  roomId=${roomId}  joinUrl=${room.joinUrl || '(缺失)'}`);
  if (!room.hostToken || !room.humanToken) log('  警告：响应缺 hostToken / humanToken，后续会失败');

  const human = (latestState?.players || []).find((p) => p.kind === 'human') || { id: 'p0', name: '观察员' };
  log(`  人类席位：${human.name} (${human.id})`);

  log('');
  log('[2/4] 三个 bot 入座…');
  const bots = [];
  for (const persona of PERSONAS.slice(0, SEATS - 1)) {
    const res = await client.join(roomId, {
      name: persona.name,
      style: persona.style,
      model: process.env.BOT_MODEL || persona.model || '',
    });
    timeline.remember(res.state);
    latestState = res.state || latestState;
    log(`  ${persona.name} → seat ${res.seat ?? '?'} (${res.playerId})`);
    bots.push({ persona, token: res.token, playerId: res.playerId });
  }

  log('');
  log('[3/4] 开局…');
  const started = await client.start(roomId, room.hostToken);
  latestState = started?.state || latestState;
  timeline.remember(latestState);
  log('  已开局');

  const readToken = room.humanToken || bots[0].token;
  const sseStatus = { alive: false };
  const printer = (async () => {
    const ctrl = new AbortController();
    const guard = setInterval(() => {
      if (stop.done) ctrl.abort();
    }, 400);
    try {
      await consumeSSE(
        `${BASE_URL}/api/rooms/${roomId}/events?token=${encodeURIComponent(readToken)}`,
        (ev) => {
          sseStatus.alive = true;
          if (ev.t === 'state' || ev.state) {
            latestState = ev.state || latestState;
            timeline.remember(latestState);
            return;
          }
          timeline.handle(ev);
        },
        ctrl.signal
      );
    } catch (err) {
      if (!stop.done) log(`  [时间线] SSE 中断：${err.message}`);
    } finally {
      clearInterval(guard);
    }
  })();

  // 契约要求 state.log；若 SSE 不可用，退化为轮询日志（后端目前未实现 log，会只剩结束检测）
  const logFallback = (async () => {
    const waitedFrom = Date.now();
    while (!sseStatus.alive && !stop.done && Date.now() - waitedFrom < 8000) await sleep(300);
    if (sseStatus.alive || stop.done) return; // SSE 正常，不再重复打印
    log('  [时间线] SSE 不可用，改读 state.log');
    let seen = 0;
    while (!stop.done) {
      let snap;
      try {
        snap = await client.poll(roomId, readToken);
      } catch {
        await sleep(600);
        continue;
      }
      latestState = snap.state || latestState;
      timeline.remember(latestState);
      const events = Array.isArray(snap.state?.log) ? snap.state.log : [];
      if (events.length < seen) seen = 0;
      for (let i = seen; i < events.length; i++) timeline.handle(events[i]);
      seen = events.length;
      if (snap.state?.status === 'ended') return;
      await sleep(700);
    }
  })();

  const runner = Promise.all([
    ...bots.map((b) =>
      runBot({
        baseUrl: BASE_URL,
        client,
        roomId,
        token: b.token,
        name: b.persona.name,
        persona: b.persona,
        log: (m) => log(`  ${m}`),
      }).catch((err) => {
        log(`  [bot 异常] ${b.persona.name}: ${err.message}`);
        return { reason: 'error', error: err.message };
      })
    ),
    humanProxy({ client, roomId, token: room.humanToken, playerId: human.id, stop }),
    printer,
    logFallback,
  ]);

  let timeoutHit = false;
  const timeout = sleep(TOTAL_TIMEOUT_MS).then(() => {
    timeoutHit = true;
    return { reason: 'timeout' };
  });

  const results = await Promise.race([runner, timeout]);
  stop.done = true;

  if (timeoutHit) {
    log('');
    log(`[超时] ${TOTAL_TIMEOUT_MS / 1000}s 未结束，打印当前状态：`);
    try {
      const snap = await client.poll(roomId, readToken);
      latestState = snap.state || latestState;
      timeline.remember(latestState);
    } catch {}
    printSummary(latestState, counters, nm);
    printStall(latestState, nm);
    process.exit(1);
  }

  log('');
  log('[4/4] 对局结束');
  for (const r of results) {
    if (r && r.reason && r.reason !== 'ended') log(`  结束原因：${r.reason}${r.error ? ` (${r.error})` : ''}`);
  }
  try {
    const snap = await client.poll(roomId, readToken);
    latestState = snap.state || latestState;
    timeline.remember(latestState);
  } catch {}
  printSummary(latestState, counters, nm);
  printStall(latestState, nm);
}

function printStall(state, nm) {
  if (!state || state.status !== 'playing') return;
  log('');
  log(`卡住诊断：askPlayerId=${state.askPlayerId ? nm(state.askPlayerId) : 'null'} kind=${state.askKind ?? '?'}`);
  log(`turnPlayerId=${state.turnPlayerId ? nm(state.turnPlayerId) : 'null'}`);
}

main().catch((err) => {
  console.error('');
  console.error(`[失败] ${err.message}`);
  if (err.status) console.error(`HTTP ${err.status}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`);
  process.exitCode = 1;
});
