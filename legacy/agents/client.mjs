// BOMB TABLE 参考 Agent SDK（零依赖，Node 22+ 内置 fetch）
// 契约见仓库根 CONTRACT.md；所有路径与字段以契约为准。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BombTableAgent {
  constructor({ baseUrl = 'http://127.0.0.1:8770' } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
  }

  async #request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      const err = new Error(`HTTP ${res.status} ${method} ${path} — ${detail}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async createRoom({ humanName = '观察员', seats = 4, askTimeoutMs, gameType = 'bomb-table', mode = 'mixed' } = {}) {
    const body = { humanName, seats, gameType, mode };
    if (askTimeoutMs !== undefined) body.askTimeoutMs = askTimeoutMs;
    return this.#request('POST', '/api/rooms', body);
  }

  async join(roomId, { name, style, model, avatarUrl } = {}) {
    const body = { name, style };
    if (model) body.model = model;
    if (avatarUrl) body.avatarUrl = avatarUrl;
    return this.#request('POST', `/api/rooms/${encodeURIComponent(roomId)}/join`, body);
  }

  async start(roomId, hostToken) {
    return this.#request('POST', `/api/rooms/${encodeURIComponent(roomId)}/start`, { hostToken });
  }

  async abort(roomId, hostToken, reason = '房主手动结束') {
    return this.#request('POST', `/api/rooms/${encodeURIComponent(roomId)}/abort`, { hostToken, reason });
  }

  async poll(roomId, token) {
    return this.#request(
      'GET',
      `/api/agent/${encodeURIComponent(roomId)}/${encodeURIComponent(token)}`,
      undefined
    );
  }

  async think(roomId, token, text) {
    return this.#request('POST', `/api/agent/${encodeURIComponent(roomId)}/${encodeURIComponent(token)}/think`, {
      text,
    });
  }

  async act(roomId, token, { action, say, thought } = {}) {
    const body = { action };
    if (say !== undefined) body.say = say;
    if (thought !== undefined) body.thought = thought;
    return this.#request('POST', `/api/agent/${encodeURIComponent(roomId)}/${encodeURIComponent(token)}/act`, body);
  }

  // 轮询到拿到非空 ask 为止。指数退避 200ms → 上限 1.5s。
  // 期间若房间已结束则立即返回该快照；真正超时才返回 null。
  async waitFor(roomId, token, { timeoutMs = 60000 } = {}) {
    const started = Date.now();
    let delay = 200;
    while (Date.now() - started < timeoutMs) {
      const snap = await this.poll(roomId, token);
      if (snap && (snap.ask || snap.state?.status === 'ended')) return snap;
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) break;
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 1.7, 1500);
    }
    return null;
  }
}

export { sleep };
