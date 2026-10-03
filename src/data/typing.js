/**
 * 好友的"打字速度"（PRD §2.12）
 * 回复不是瞬间蹦出来的：不同人设打字快慢不同，慢的人会先显示"正在输入…"再发出来。
 * 没配置的人设用默认值。单位毫秒。
 */
export const TYPING_DELAY = {
  p20: [1000, 3000], // 打字很慢
  p24: [700, 1800], // 慢半拍
  p06: [600, 1500], // 不熬夜了（困）
  p07: [500, 1400], // 凌晨三点
  p04: [500, 1300], // 深夜絮语
  p12: [150, 500], // 碎碎念（话多手快）
  p10: [200, 700], // 菜就多练
  p13: [200, 700], // 上分要紧
  p02: [400, 1100], // 小柳先生（古风：一句一顿，打字也慢条斯理）
  p11: [400, 1100], // Helloworld
  p16: [400, 1200], // 冷月
  p29: [250, 900], // 何知非（文科生，打字快、话也不少）
};

export const DEFAULT_TYPING_DELAY = [180, 600];

/** 取这个人的打字延迟（毫秒） */
export function typingDelayOf(persona, rnd = Math.random) {
  const range = (persona && TYPING_DELAY[persona.id]) || DEFAULT_TYPING_DELAY;
  const [min, max] = range;
  return Math.round(min + rnd() * Math.max(0, max - min));
}
