// 游戏注册表。新增游戏只在这里挂一行。
import { BombTable } from './games/bomb-table.mjs';
import { Undercover } from './games/undercover.mjs';
import { LiarsDice } from './games/liars-dice.mjs';
import { Werewolf } from './games/werewolf.mjs';
import { Avalon } from './games/avalon.mjs';
import { Codenames } from './games/codenames.mjs';
import { Cluedo } from './games/cluedo.mjs';
import { Holdem } from './games/holdem.mjs';
import { Uno } from './games/uno.mjs';

export const GAME_SPECS = {
  'bomb-table': {
    id: 'bomb-table',
    title: 'BOMB TABLE',
    desc: '抽牌审讯 · 看 AI 互相说谎',
    min: 2,
    max: 6,
    Class: BombTable,
  },
  undercover: {
    id: 'undercover',
    title: '谁是卧底',
    desc: '描述、找异类、投票放逐',
    min: 4,
    max: 8,
    Class: Undercover,
  },
  'liars-dice': {
    id: 'liars-dice',
    title: '大话骰',
    desc: '叫点、诈唬、开盅',
    min: 2,
    max: 6,
    Class: LiarsDice,
  },
  werewolf: {
    id: 'werewolf',
    title: '狼人杀',
    desc: '6 人明牌局 · 夜晚与放逐',
    min: 6,
    max: 6,
    Class: Werewolf,
  },
  avalon: {
    id: 'avalon',
    title: '阿瓦隆',
    desc: '组队任务 · 隐藏阵营 · 刺杀梅林',
    min: 5,
    max: 10,
    Class: Avalon,
  },
  codenames: {
    id: 'codenames',
    title: '密码名牌',
    desc: '一词一线索，避开刺客',
    min: 4,
    max: 8,
    Class: Codenames,
  },
  cluedo: {
    id: 'cluedo',
    title: '妙探寻凶',
    desc: '提问、排除、指认凶手',
    min: 3,
    max: 6,
    Class: Cluedo,
  },
  holdem: {
    id: 'holdem',
    title: '德州扑克',
    desc: '底牌、下注、诈唬、摊牌',
    min: 2,
    max: 6,
    Class: Holdem,
  },
  uno: {
    id: 'uno',
    title: 'UNO',
    desc: '颜色数字、功能牌、+4 质疑',
    min: 2,
    max: 6,
    Class: Uno,
  },
};

export function getGameSpec(id) {
  return GAME_SPECS[String(id || '').toLowerCase()] || null;
}

export function listGames() {
  return Object.values(GAME_SPECS).map(({ id, title, desc, min, max }) => ({ id, title, desc, min, max }));
}
