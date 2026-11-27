#!/usr/bin/env node
// 执行 db/schema.sql（Neon Serverless PostgreSQL）。
// 用法：DATABASE_URL=postgres://... node db/migrate.mjs（或 npm run db:migrate）
//
// SQL 切分器需正确处理：
//   - $$ ... $$ / $tag$ ... $tag$ 的 PL/pgSQL 函数体（内部含大量分号）
//   - '单引号字符串'（'' 为转义）
//   - -- 行注释
//   - /* 块注释 */（PostgreSQL 支持嵌套）
// 已存在的对象（42P07 表/索引重复、42710 对象重复、42P06 schema 重复、
// 消息含 already exists）跳过并打印 SKIP；其它错误打印语句首行并以退出码 1 结束。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'schema.sql');

function readSchema() {
  try {
    return fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    console.error(`[migrate] 读取 ${schemaPath} 失败：${(err && err.message) || err}`);
    process.exit(1);
  }
}

/** 把 SQL 文本切成可独立执行的语句（去掉注释，保留字符串/美元引用的原样）。 */
export function splitSql(text) {
  const src = String(text || '');
  const statements = [];
  let buf = '';
  let i = 0;

  const flush = () => {
    const stmt = buf.trim();
    if (stmt) statements.push(stmt);
    buf = '';
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // -- 行注释：跳到行尾（不写入 buf）
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      if (i < src.length) { buf += '\n'; i += 1; }
      continue;
    }

    // /* 块注释 */：支持嵌套，整段丢弃
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      buf += ' ';
      continue;
    }

    // '单引号字符串'
    if (ch === "'") {
      buf += ch;
      i += 1;
      while (i < src.length) {
        const c = src[i];
        buf += c;
        i += 1;
        if (c === "'") {
          if (src[i] === "'") { buf += src[i]; i += 1; continue; }
          break;
        }
      }
      continue;
    }

    // 双引号标识符 "..."（" 内部 "" 转义）
    if (ch === '"') {
      buf += ch;
      i += 1;
      while (i < src.length) {
        const c = src[i];
        buf += c;
        i += 1;
        if (c === '"') {
          if (src[i] === '"') { buf += src[i]; i += 1; continue; }
          break;
        }
      }
      continue;
    }

    // 美元引用 $tag$ ... $tag$（tag 可为空）
    if (ch === '$') {
      const match = /^\$[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*\$|^\$\$/.exec(src.slice(i));
      if (match) {
        const tag = match[0];
        buf += tag;
        i += tag.length;
        const end = src.indexOf(tag, i);
        if (end < 0) {
          // 未闭合：把剩余全部当作函数体原样保留，交由数据库报错
          buf += src.slice(i);
          i = src.length;
          break;
        }
        buf += src.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    // 语句分隔符
    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();
  return statements;
}

const IGNORABLE_CODES = new Set(['42P07', '42710', '42P06']);

function isAlreadyExists(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  if (code && IGNORABLE_CODES.has(code)) return true;
  const message = String((err && err.message) || '');
  return /already exists/i.test(message);
}

function firstLine(stmt) {
  const line = String(stmt).split('\n').map((s) => s.trim()).find(Boolean) || '(空语句)';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

async function main() {
  if (!DATABASE_URL) {
    console.error('[migrate] 缺少 DATABASE_URL。请先配置 Neon 连接串，例如：');
    console.error('          DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" npm run db:migrate');
    process.exit(1);
  }

  const schema = readSchema();
  const statements = splitSql(schema);
  if (!statements.length) {
    console.log('[migrate] schema.sql 为空，无事可做。');
    return;
  }

  const sql = neon(DATABASE_URL);
  let applied = 0;
  let skipped = 0;

  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    try {
      await sql.query(stmt);
      applied += 1;
      console.log(`[migrate] OK   ${index + 1}/${statements.length} · ${firstLine(stmt)}`);
    } catch (err) {
      if (isAlreadyExists(err)) {
        skipped += 1;
        console.log(`[migrate] SKIP ${index + 1}/${statements.length} · ${firstLine(stmt)}`);
        continue;
      }
      console.error(`[migrate] FAIL ${index + 1}/${statements.length} · ${firstLine(stmt)}`);
      console.error(`[migrate] 错误：${(err && err.message) || err}`);
      process.exit(1);
    }
  }

  console.log(`[migrate] 完成：执行 ${applied} 条，跳过已存在 ${skipped} 条。`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[migrate] 未处理异常：', (err && err.message) || err);
    process.exit(1);
  });
}
