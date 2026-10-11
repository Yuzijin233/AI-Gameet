/**
 * 语音输入的纯逻辑（放在单独文件里，方便在 Node 里测试）
 */

/** 把"已确认 + 临时"的识别结果拼成当前这一句 */
export function mergeTranscript(finalText, interimText) {
  return `${finalText || ''}${interimText || ''}`.trim();
}

/**
 * 该不该把当前这句发出去？
 * 规则：缓冲区里有内容，且"安静"已经持续够久（没人在说话）→ 发
 * @param {{buffer:string, quietFor:number, silenceMs:number}} p
 */
export function shouldFlush({ buffer, quietFor, silenceMs }) {
  return !!String(buffer || '').trim() && quietFor >= silenceMs;
}

/**
 * 时域 PCM 数据的音量（RMS，0~1）
 * @param {Uint8Array|number[]} bytes getByteTimeDomainData 的原始数据（无符号 8 位，静音=128）
 */
export function rmsOf(bytes, center = 128) {
  if (!bytes || !bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const v = (bytes[i] - center) / center;
    sum += v * v;
  }
  return Math.sqrt(sum / bytes.length);
}

/** 音量是否达到"有人在说话"的阈值 */
export function isVoiceLevel(level, threshold) {
  return level >= 0 && level >= threshold;
}

/**
 * 音量柱高度（4 根竖条）：把最近几帧的音量映射成每根柱子的高度百分比
 * - 越靠右的柱子越灵敏（放大系数更大），看起来像真实的音频条
 * - 每帧留一点抖动，静止时也有呼吸感
 * @param {number[]} history 最近的音量（0~1），越靠后越新
 * @param {number} count 柱子数量
 * @param {Function} rnd 随机源（便于测试）
 * @returns {number[]} 每根柱子的高度百分比（0.12~1）
 */
export function barHeights(history, count = 4, rnd = Math.random) {
  const h = Array.isArray(history) && history.length ? history : [0];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    // 右边更灵敏：0.55 → 1.0
    const gain = 0.55 + (0.45 * i) / Math.max(1, count - 1);
    const level = h[Math.min(h.length - 1, Math.max(0, h.length - count + i))] || 0;
    const jitter = 0.9 + rnd() * 0.2;
    const v = Math.min(1, Math.max(0.12, level * gain * jitter * 2.2));
    out.push(Number(v.toFixed(3)));
  }
  return out;
}
