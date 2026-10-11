/**
 * 大事件发言编排（纯逻辑、零依赖，界面与测试共用）
 *
 * 规则（用户拍板）：
 *  1. 叫 / 不叫地主：100% 表态（在 ai/scene.js 里）
 *  2. **炸弹 / 王炸**：桌上**每个 AI 都要说一句**，而且按"我和出牌者什么关系"换口吻
 *     —— 本人得意、同伙叫好、对手惊讶
 *  3. **春天 / 被反杀（反春）**：同样是每个 AI 一句，赢的那侧欢呼、输的那侧懵
 *  4. **长牌型**（连对 / 长顺子 / 飞机 / 四带二）：出牌者必说
 *  5. **普通牌**（单张、对子、三带一…）：先掷 50%，掷中了才真的去调大模型（省调用）
 *
 * 这里只做"该说什么"的判断，不发请求、不碰 DOM，所以可以被 node 直接测。
 */

/**
 * 长牌型的最低张数
 * 连对 = 3 对起（6 张），顺子 = 5 张起，飞机 = 2 个三张起（6 张）…
 * 单张 / 对子 / 三张 / 三带一 / 三带二 都不算长牌型（它们走 50% 概率那条路）
 */
export const LONG_COMBO_MIN = {
  straight: 5,
  straightPair: 6,
  plane: 6,
  plane1: 8,
  plane2: 10,
  four2single: 6,
  four2pair: 8,
};

/** 这一手是不是"长牌型"（必说） */
export function isLongCombo(type, size = 0) {
  const min = LONG_COMBO_MIN[String(type || '')];
  return typeof min === 'number' && Number(size) >= min;
}

/** 长牌型的名字，用于提示词 */
export const LONG_COMBO_NAME = {
  straight: '长顺子',
  straightPair: '连对',
  plane: '飞机',
  plane1: '飞机带单',
  plane2: '飞机带对',
  four2single: '四带二',
  four2pair: '四带两对',
};

/**
 * 阵营关系
 * @returns {'self'|'mate'|'foe'} self = 就是他自己出的；mate = 同伙（同是农民）；foe = 敌对
 */
export function relationOf(seat, actorSeat, landlordSeat) {
  if (seat === actorSeat) return 'self';
  if (landlordSeat == null) return 'foe';
  return (seat === landlordSeat) === (actorSeat === landlordSeat) ? 'mate' : 'foe';
}

/** 关系 → 该用什么态度（写进提示词，模型才知道"我该夸还是该惊讶"） */
export const RELATION_VOICE = {
  self: '这一手是**你自己**打出来的，可以得意、可以放句狠话',
  mate: '出牌的是**你的搭档**（你俩都是农民），要替他叫好、夸他这手漂亮',
  foe: '出牌的是**你的对手**，要表现出惊讶、压力或者不服气',
};

export const RELATION_LABEL = { self: '你', mate: '你的搭档', foe: '你的对手' };

/** 炸弹 / 王炸：每个 AI 各自该用哪个场景与哪句局势台词 */
export function bombPlan(seat, actorSeat, landlordSeat) {
  const relation = relationOf(seat, actorSeat, landlordSeat);
  return {
    relation,
    scene: { self: 'bomb', mate: 'bombMate', foe: 'bombFoe' }[relation],
    situationKey: { self: 'bombed', mate: 'bombMate', foe: 'bombFoe' }[relation],
  };
}

/** 炸弹事件的背景说明（喂给提示词） */
export function bombBrief({ relation, actorName, isRocket }) {
  const what = isRocket ? '王炸' : '炸弹';
  const who = actorName ? `「${actorName}」` : '有人';
  return `${who}刚打出${what}。${RELATION_VOICE[relation]}`;
}

/**
 * 春天 / 被反杀
 * @param {boolean} spring 春天：地主赢且两个农民一张没出
 * @param {boolean} antiSpring 反春（被反杀）：农民赢且地主只出了一手
 */
export function springPlan(seat, landlordSeat, landlordWin) {
  const won = (seat === landlordSeat) === !!landlordWin;
  return won
    ? { won, scene: 'win', situationKey: 'spring' }
    : { won, scene: 'lose', situationKey: 'antiSpring' };
}

/** 春天 / 被反杀的背景说明 */
export function springBrief({ spring, antiSpring, won }) {
  if (spring) {
    return won
      ? '这一局是「春天」：对面一张牌都没出完，你们赢得很干脆'
      : '这一局被打了「春天」：你一张牌都没出完就输了，心里不太好受';
  }
  if (antiSpring) {
    return won
      ? '这一局是「反春」：地主被你反杀了，只出了一手就输了'
      : '这一局你被反杀了（反春）：你只出了一手牌就输了，说不出话';
  }
  return won ? '这一局你赢了' : '这一局你输了';
}

/**
 * 开局问候：AI 模式的随机匹配里，碰到好友 / 碰到上一局的对手，说法不一样
 * @returns {{scene:string, situationKey:string|null}}
 */
export function greetingPlan({ isFriend, metLastHand }) {
  if (isFriend) return { scene: 'greeting', situationKey: 'metFriend' };
  if (metLastHand) return { scene: 'greeting', situationKey: 'metAgain' };
  return { scene: 'greeting', situationKey: null };
}

/** 碰到好友的说明 */
export function metFriendBrief(name) {
  return `「${name}」是你已经加过好友的人，这一局正好在牌桌上碰到了，主动打个招呼（别太热情，一句就够）`;
}

/** 碰到上一局对手的说明（有上一局的概括就带上） */
export function metAgainBrief(name, summary) {
  const tail = summary ? `上一局的情况：${summary}` : '你记得上一局就是跟他打的';
  return `「${name}」是你**上一局刚打过**的对手，你又碰上了，提一句上一局（${tail}）`;
}
