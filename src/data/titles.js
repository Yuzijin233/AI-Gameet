/**
 * 称号系统数据（按豆子自动解锁 + 商城花豆购买 + 连续签到赠送）
 * color 用于徽章渐变（支持 2~3 个色停）
 */
export const TITLES = [
  // ---------- 按豆子量自动解锁 ----------
  { id: 't_poor', name: '穷光蛋', kind: 'beans', beans: 0, color: ['#9aa4b2', '#5c6675'], desc: '身无分文，从头再来' },
  { id: 't_small', name: '小赌怡情', kind: 'beans', beans: 1000, color: ['#8fd6ff', '#3b82c4'], desc: '身家过千' },
  { id: 't_lucky', name: '手气不错', kind: 'beans', beans: 10000, color: ['#a8f0a0', '#2f9e44'], desc: '身家过万' },
  { id: 't_rich', name: '豆子大户', kind: 'beans', beans: 100000, color: ['#ffd166', '#e08b00'], desc: '身家十万' },
  { id: 't_big', name: '一掷千金', kind: 'beans', beans: 1000000, color: ['#ff9ec4', '#c2185b'], desc: '身家百万' },
  { id: 't_mogul', name: '富可敌国', kind: 'beans', beans: 10000000, color: ['#e0b3ff', '#7b2ff7'], desc: '身家千万' },

  // ---------- 连续签到赠送（拿到就永久拥有，断签不会收回） ----------
  { id: 't_labor', name: '劳模', kind: 'signin', days: 8, color: ['#ffd6a5', '#ff8f3f'], desc: '连续签到 8 天，风雨无阻' },

  // ---------- 商城花豆购买 ----------
  { id: 't_rookie', name: '牌桌萌新', kind: 'shop', price: 5000, color: ['#bfe9ff', '#4a90d9'], desc: '刚上桌的新人' },
  { id: 't_general', name: '常胜将军', kind: 'shop', price: 50000, color: ['#ffe08a', '#d98c00'], desc: '赢多输少' },
  { id: 't_boss', name: '桌上一霸', kind: 'shop', price: 200000, color: ['#ffb3b3', '#c62828'], desc: '这张桌子我说了算' },
  /**
   * ★ 斗地主之王：用户拍板改成**充值购买 ¥128**（和买开心豆同一套模拟收银台）。
   *   `price` 只保留"等值豆子"用于展示与旧存档比对，真正的收款看 `cashPrice`；
   *   store/cosmetics.js 的 buyCosmeticWithCash 会认这个字段。
   */
  { id: 't_legend', name: '斗地主之王', kind: 'shop', price: 128 * 1000, cashPrice: 128, color: ['#fff3c4', '#ff7bac', '#7b2ff7'], desc: '传说级称号' },
  { id: 't_night', name: '熬夜冠军', kind: 'shop', price: 20000, color: ['#c8b6ff', '#5b3fa8'], desc: '凌晨三点的牌桌常客' },
  { id: 't_lucky7', name: '手气爆棚', kind: 'shop', price: 120000, color: ['#b9ffcf', '#2f9e44'], desc: '连续摸到好牌的人' },
  { id: 't_tycoon', name: '一掷万金', kind: 'shop', price: 500000, color: ['#ffe9a8', '#ff8f3f'], desc: '输赢都当零花钱' },

  // ---------- 活动里拿到的（买不到、也刷不出来） ----------
  { id: 't_first', name: '初见', kind: 'gift', color: ['#fff3c4', '#ffd166', '#e08b00'], desc: '首充礼包里的见面礼' },
  { id: 't_lucky_star', name: '欧皇', kind: 'gift', color: ['#e0b3ff', '#ff7bac', '#ffd166'], desc: '大转盘抽到的，运气写在脸上' },

  // ---------- 里程碑 100 分奖励（用户拍板：不给豆子货，只给这个称号） ----------
  {
    id: 't_socialite',
    name: '社交达人',
    kind: 'gift',
    color: ['#ffe9a8', '#e0a13c', '#a3702a'],
    desc: '里程碑攒到 100 点的人才有',
  },

  // ---------- 关系达成（用户拍板：第一次成为恋人送「神仙眷侣」） ----------
  {
    id: 't_lovers',
    name: '神仙眷侣',
    kind: 'lover',
    color: ['#ffe3f0', '#ff5c8a', '#a98bff'],
    desc: '第一次和某位好友成为恋人',
  },
];

export function titleById(id) {
  return TITLES.find((t) => t.id === id) || null;
}

export function titleGradient(title) {
  if (!title || !title.color) return 'linear-gradient(92deg, #cfd8e3, #8a94a6)';
  return `linear-gradient(92deg, ${title.color.join(', ')})`;
}
