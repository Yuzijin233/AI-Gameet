/**
 * 局势判断 + 该不该说话（PRD §2.8）
 * 解决两个问题：①AI 每出一手牌都说一句，太吵；②台词与牌局无关
 */
import { handToString } from '../core/cards.js';
import { isLongCombo } from './events.js';

/** 汇总当前局势（只使用公开信息 + 自己的手牌，符合 PRD Q17） */
export function buildSituation(game, seat, names = ['你', '下家', '上家']) {
  const counts = game.hands.map((h) => h.length);
  const landlordSeat = game.landlordSeat;
  const isLandlord = seat === landlordSeat;
  const others = [0, 1, 2].filter((s) => s !== seat);
  const teammate = isLandlord ? -1 : others.find((s) => s !== landlordSeat);
  const landlordCount = counts[landlordSeat] ?? 0;
  const teammateCount = teammate >= 0 ? counts[teammate] : 99;
  const mult = 2 ** ((game.robs || 0) + (game.bombs || 0) + (game.rockets || 0));

  let key = 'normal';
  let urgent = false;
  if (isLandlord) {
    if (counts[seat] <= 2) { key = 'iAmClose'; urgent = true; }
    else if (others.some((s) => counts[s] === 1)) { key = 'opponentOne'; urgent = true; }
    else if (mult >= 8) key = 'highStakes';
  } else if (landlordCount === 1) { key = 'landlordOne'; urgent = true; }
  else if (teammateCount === 1) { key = 'teammateOne'; urgent = true; }
  else if (counts[seat] <= 2) { key = 'iAmClose'; urgent = true; }
  else if (landlordCount <= 5) key = 'landlordClosing';
  else if (mult >= 8) key = 'highStakes';

  const bullets = [
    `你是${isLandlord ? '地主' : '农民'}`,
    `你的手牌 ${counts[seat]} 张`,
    `地主（${names[landlordSeat]}）剩 ${landlordCount} 张`,
    teammate >= 0 ? `你的农民搭档 ${names[teammate]} 剩 ${teammateCount} 张` : '',
    others.map((s) => `${names[s]} 剩 ${counts[s]} 张`).join('，'),
    `当前倍数 ×${mult}`,
    game.lastPlay
      ? `上一手是 ${names[game.lastPlay.seat]} 出的 ${handToString(game.lastPlay.play.cards)}`
      : '本轮你是首出',
  ].filter(Boolean);

  return {
    key,
    urgent,
    counts,
    isLandlord,
    landlordCount,
    teammateCount,
    mult,
    text: bullets.join('；'),
  };
}

/**
 * 决定这次要不要说话、用哪个场景
 * @returns {string|null} 场景名，null = 这次不说话
 */
export function pickScene(kind, detail, sit, chance) {
  switch (kind) {
    case 'greeting':
      return 'greeting';
    case 'bid':
    case 'rob':
      // 叫 / 不叫 都要表态（PRD §2.8：AI 每次叫抢地主都必须说一句）
      if (detail.call) return kind === 'rob' ? 'rob' : 'bid';
      return 'passBid';
    case 'play': {
      if (detail.bomb) return 'bomb'; // 炸弹必说（而且不止出牌的人说，见 ai/events.js）
      // 长牌型（连对 / 长顺子 / 飞机 / 四带二）也是必说：这么大的牌值得开口
      if (isLongCombo(detail.type, detail.size)) return 'longCombo';
      if (sit.urgent) return sit.isLandlord ? 'playBig' : 'suppressed';
      if (detail.big) return Math.random() < chance.bigPlay ? 'playBig' : null;
      // 普通牌（单张 / 对子 / 三带一…）：脚本先掷 50%，掷中了才真的去调大模型
      return Math.random() < chance.play ? 'playSmall' : null;
    }
    case 'pass':
      if (sit.urgent && sit.key === 'landlordOne') return Math.random() < 0.5 ? 'suppressed' : null;
      return Math.random() < chance.pass ? 'suppressed' : null;
    case 'spring':
      return 'bomb';
    case 'idle':
      return 'idle';
    case 'win':
      return 'win';
    case 'lose':
      return 'lose';
    case 'praised':
      return 'praised';
    case 'egged':
      return 'egged';
    default:
      return null;
  }
}
