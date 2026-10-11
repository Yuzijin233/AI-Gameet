/**
 * 输入法（IME）保护 —— 用户报的 bug：
 *   "AI 输出刷新的时候我正好在打字，输入法被锁了，唤不起中文输入法"
 *
 * 原因很实在：几个聊天面板（私聊 / 群聊 / 友圈评论）收到新消息时走的是
 * `mainBox.innerHTML = ...` **整块重画**。如果这一瞬间玩家正在用中文输入法**组词**
 * （拼音还没上屏、`compositionstart` 已触发），那个正在组词的 `<input>` 会被直接销毁，
 * 浏览器的 composition 状态就挂在一个已经不在文档里的节点上 —— 之后这个页面就再也
 * 唤不起中文输入法了（只能刷新）。把草稿和光标装回去**救不了**这个，因为节点已经没了。
 *
 * 做法：**组词期间不重画**。把这次重画挂起，等 `compositionend`（这一字上屏）后再补一次。
 * 顺带修掉一个体感问题：挂机群聊每 5~15 秒就会重画一次，正在打字时被反复打断。
 *
 * 用起来就三行：
 *   const ime = createImeGuard({ onFlush: () => render() });
 *   function render() { if (ime.shouldDefer()) return; ...; ime.bind(box.querySelector('#x-input')); }
 */
export function createImeGuard({ onFlush } = {}) {
  let composing = false;
  let pending = false;

  const flush = () => {
    if (!pending) return;
    pending = false;
    if (typeof onFlush === 'function') onFlush();
  };

  return {
    /**
     * 把组词监听挂到当前这个输入框上
     * ★ 每次重画后都要重新挂（旧节点已经被换掉了）
     */
    bind(el) {
      if (!el || typeof el.addEventListener !== 'function') return;
      el.addEventListener('compositionstart', () => { composing = true; });
      el.addEventListener('compositionend', () => {
        composing = false;
        // 推迟一个 tick：让浏览器先把这一字的 compositionend 处理完再重画
        if (pending) setTimeout(flush, 0);
      });
      // 兜底：万一玩家组词后直接点走（没触发 compositionend），失焦时把挂起的重画补上
      el.addEventListener('blur', () => {
        composing = false;
        setTimeout(flush, 0);
      });
    },

    isComposing: () => composing,
    isPending: () => pending,

    /**
     * 重画前先问一句"现在能画吗"
     * @returns {boolean} true = 正在组词，这次先别画（已经记下来了）
     */
    shouldDefer() {
      if (composing) { pending = true; return true; }
      return false;
    },

    /** 立刻把挂起的重画补上（发消息之后之类） */
    flushNow() { composing = false; flush(); },
  };
}
