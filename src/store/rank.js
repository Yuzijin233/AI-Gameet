/**
 * 排行榜（PRD §2.19）
 *
 * 只有**一个榜**：财富榜（按开心豆/身家排）。
 * 关键约束（用户拍板）：**玩家和 AI 完全平等** —— 同一套行样式、同一个排序规则，
 * 不给自己加任何特殊标记；只有"进不了前十"时，才在下面单独列出自己的名次（那是信息，不是特权）。
 */
import { PERSONAS } from '../data/personas.js';
import { aiBeansOf, aiTitleOf } from './aiBeans.js';
import { equippedTitle } from './titles.js';
import { playerAvatarSrc, avatarSrcOf } from '../data/avatar.js';

export const RANK_SIZE = 10;

/**
 * 榜单数据
 * @returns {{top:object[], me:object|null, inTop:boolean, total:number, size:number}}
 *   entry = { key, kind:'me'|'ai', id, name, avatar, beans, title, titleId }
 *   title = 称号名字（空串 = 没戴）；titleId 给界面取渐变色用
 */
export function wealthRanking(save, size = RANK_SIZE) {
  const mine = equippedTitle(save);
  // 每一行的 avatar 都是**已经可以直接用的 src**（玩家可能是上传的照片）——
  // 这样界面上的 rowHtml 不需要区分玩家和 AI，一行代码管所有人
  const entries = [
    {
      key: 'me',
      kind: 'me',
      id: 'me',
      name: save.nickname || '玩家',
      avatar: playerAvatarSrc(save),
      beans: Math.max(0, Math.round(Number(save.beans) || 0)),
      title: mine ? mine.name : '',
      titleId: mine ? mine.id : '',
    },
    ...PERSONAS.map((p) => {
      const t = aiTitleOf(save, p.id);
      return {
        key: p.id,
        kind: 'ai',
        id: p.id,
        name: p.name,
        avatar: avatarSrcOf(p.avatar),
        beans: Math.max(0, Math.round(Number(aiBeansOf(save, p.id)) || 0)),
        title: t ? t.name : '',
        titleId: t ? t.id : '',
      };
    }),
  ];

  // 身家降序；同分按名字排（保证同一个存档每次刷新顺序一致，不会"跳来跳去"）
  entries.sort((a, b) => (b.beans - a.beans) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  entries.forEach((e, i) => { e.rank = i + 1; });

  const top = entries.slice(0, size);
  const meEntry = entries.find((e) => e.kind === 'me');
  const inTop = top.some((e) => e.kind === 'me');
  return {
    top,
    // 只在自己没进前十时才需要单独给出（进了前十它就在 top 里，不用特殊对待）
    me: inTop ? null : meEntry,
    inTop,
    total: entries.length,
    size,
  };
}

/** 名次的奖牌/配色（前三名才有，和是不是玩家无关） */
export function medalOf(rank) {
  if (rank === 1) return { emoji: '🥇', tone: '#ffd166' };
  if (rank === 2) return { emoji: '🥈', tone: '#cfd8e3' };
  if (rank === 3) return { emoji: '🥉', tone: '#e0a06a' };
  return { emoji: '', tone: '' };
}

/** 身家文案：大数压缩成"1.23万 / 2.5亿"（小数点后多余的 0 去掉） */
export function beanText(v) {
  const n = Math.max(0, Math.round(Number(v) || 0));
  const trim = (s) => s.replace(/\.?0+$/, '');
  if (n >= 100000000) return `${trim((n / 100000000).toFixed(2))}亿`;
  if (n >= 10000) return `${trim((n / 10000).toFixed(2))}万`;
  return n.toLocaleString();
}
