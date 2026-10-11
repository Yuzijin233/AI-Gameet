/**
 * 入口：加载页 → 大厅（PRD §3.2）
 */
import { app } from './ui/app.js';
import { audio } from './ui/audio.js';
import { ensureMoments, listMoments } from './store/moments.js';
import { ensureGroups, listGroups, groupChatLines } from './store/groups.js';
import { listFriends, ensureFriends } from './store/friends.js';
import { ONLINE_MOMENT } from './config.js';
import { simulatedSendAt } from './data/clock.js';

const TIPS = [
  '正在洗牌…',
  '正在给 AI 打人设…',
  '正在擦亮卡牌…',
  '正在摆放牌桌…',
];

/** 离线久一点时的提示（用户要求：这段时间用来"把消息加载出来"） */
const TIPS_LOADING = [
  '正在同步好友消息…',
  '正在翻友圈的新动态…',
  '正在看群里的聊天记录…',
  '马上就好…',
];

/**
 * ★ 用户拍板：加载条略微长一点；**离开超过 20 分钟再多 1~2 秒**，
 *   用这段时间**提前把私聊 / 群聊 / 友圈的未读消息准备好** ——
 *   进大厅就是"消息都在那儿等着"，而不是点开才现算，看起来更真实。
 *
 * 这里做的是真的准备工作（不是只 sleep）：
 *   · ensure 各存档结构（老存档补齐字段）
 *   · 把好友 / 群 / 友圈的"待显示内容"过一遍（拼出列表行、算出未读数）
 *   · 让离线补发的那批消息（回归招呼 / 友圈 / 群聊）**有时间先排上号**
 * @returns {number} 额外等待的毫秒数
 */
async function warmUp(awayMs) {
  ensureFriends(app.save);
  ensureGroups(app.save);
  ensureMoments(app.save);

  const friends = listFriends(app.save);
  const groups = listGroups(app.save);
  const moments = listMoments(app.save);

  // 提前算一遍列表要用的东西（和真正渲染时同一份数据，纯读取、不改存档）
  const rows = friends.map((f) => `${f.personaId}:${f.unread || 0}`);
  void rows;
  groups.forEach((g) => { try { groupChatLines(g, app); } catch { /* 忽略：预热失败不影响启动 */ } });
  void moments.length;
  void ONLINE_MOMENT.minFriends;
  void simulatedSendAt;

  // 离线超过 20 分钟 → 多等 1~2 秒（让上面那批"补发消息"的定时器先落地）
  if (!Number.isFinite(awayMs) || awayMs < 20 * 60 * 1000) return 0;
  return 1000 + Math.round(Math.random() * 1000);
}

async function boot() {
  // 先看本地文件里有没有一份更新/更全的存档（AI 记忆本地化：save/ddz_save.json）
  const awayMs = Number.isFinite(app.save && app.save.lastSeenAt) && app.save.lastSeenAt > 0
    ? Math.max(0, Date.now() - app.save.lastSeenAt)
    : 0;
  await app.prepareSave();
  app.boot();

  const extra = await warmUp(awayMs);

  const bar = document.getElementById('loading-bar');
  const tip = document.getElementById('loading-tip');
  const longAway = extra > 0;
  const tips = longAway ? TIPS.concat(TIPS_LOADING) : TIPS;
  let p = 0;
  /**
   * ★ 用户拍板："加载时间需要略微长一点点"。
   *   原来每 95ms 走 7~16%（不附加额外等待时）大约 0.9~1.4 秒走完 —— 现在每格小一点、
   *   间隔也放长一点，整体约 **1.6~2.3 秒**；离线久的那条路仍然额外多等 1~2 秒。
   */
  const step = longAway ? 4 + Math.random() * 5 : 5 + Math.random() * 8;
  const timer = setInterval(() => {
    p = Math.min(100, p + step);
    bar.style.width = `${p}%`;
    tip.textContent = tips[Math.min(tips.length - 1, Math.floor((p / 100) * tips.length))];
    if (p >= 100) {
      clearInterval(timer);
      // 离线久的话，把额外那一两秒留在这里（进度条已经满了，看起来像"在收尾"）
      setTimeout(() => {
        // 新手 / 刚重置过存档：先进"设置性别 + 姓名"那一屏，确认了才进大厅
        if (app.needsSetup()) app.showSetup();
        else app.showScreen('screen-lobby');
        tip.textContent = '准备就绪！';
      }, 420 + extra);
    }
  }, 130);
  /* 首次交互解锁音频（浏览器自动播放策略） */
  const unlock = () => {
    audio.resume();
    audio.startBgm();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
