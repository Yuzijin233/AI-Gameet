/**
 * 敏感串的显示处理（纯函数）
 *
 * 用途：设置面板里要显示当前的 DeepSeek API Key，但**不能整串亮出来**——
 * 中间用 `**` 藏住，只留头尾：
 *   sk-1234567890abcdefghij → sk-1234**ghij
 * 真正发给模型的仍然是存档里的完整 Key（这里只管"怎么显示"）。
 */

/**
 * 把中间藏起来
 * @param {string} key 原始 Key
 * @param {{head?:number, tail?:number, mask?:string}} opts head/tail = 保留头尾几个字符
 */
export function maskKey(key, { head = 7, tail = 4, mask = '**' } = {}) {
  const s = String(key == null ? '' : key).trim();
  if (!s) return '（没填）';
  // 太短就没法"藏中间"了，整串打码，免得反而暴露
  if (s.length <= head + tail) return mask.repeat(Math.max(3, Math.ceil(s.length / 2)));
  return `${s.slice(0, head)}${mask}${s.slice(-tail)}`;
}

/** 看起来像不像一个 DeepSeek Key（只做粗校验，不联网） */
export const looksLikeKey = (key) => /^sk-[A-Za-z0-9_-]{16,}$/.test(String(key || '').trim());
