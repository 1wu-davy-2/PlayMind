// 数据访问层入口：有 DATABASE_URL 走 Neon，否则走内存实现。
// 模块顶层不建立任何数据库连接；neonStore 只有 createNeonStore(url) 被调用时才建连接。
import { createMemoryStore } from './memoryStore.mjs';
import { createNeonStore } from './neonStore.mjs';

const databaseUrl = typeof process !== 'undefined' && process.env ? process.env.DATABASE_URL : '';

export const dbMode = databaseUrl ? 'neon' : 'memory';

export const db = databaseUrl
  ? createNeonStore(databaseUrl)
  // dev 热更新时保住内存房间：挂在 globalThis 上复用同一实例
  : (globalThis.__pm_memory_db ||= createMemoryStore());
