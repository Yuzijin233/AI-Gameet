/**
 * 房间模式的弹幕层（DOM）
 * 纯逻辑部分（轨道分配、颜色、截断）单独导出，便于在 Node 里测试。
 */
import { DANMAKU } from '../config.js';

/** 不同角色的弹幕颜色：玩家=金，下家=粉，上家=蓝 */
export const DANMAKU_COLORS = {
  0: '#FFD166',
  1: '#FF9EC4',
  2: '#6FD6FF',
};

export function colorOfSeat(seat) {
  return DANMAKU_COLORS[seat] || '#FFFFFF';
}

/**
 * 选一条轨道：优先选已经空出来的，否则选最早空出来的那条（纯函数，便于测试）
 * @param {number[]} laneFreeAt 每条轨道预计空出的时间戳
 * @param {number} now
 * @returns {{lane:number, freeAt:number}}
 */
export function pickLane(laneFreeAt, now) {
  let best = -1;
  let bestAt = Infinity;
  for (let i = 0; i < laneFreeAt.length; i += 1) {
    if (laneFreeAt[i] <= now) return { lane: i, freeAt: now };
    if (laneFreeAt[i] < bestAt) { bestAt = laneFreeAt[i]; best = i; }
  }
  return { lane: best < 0 ? 0 : best, freeAt: bestAt === Infinity ? now : bestAt };
}

/** 弹幕文案统一裁一下，避免一条飘很久 */
export function clipDanmaku(text, name) {
  const body = String(text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, DANMAKU.maxChars);
  return { name: String(name || '').slice(0, 8), body };
}

export class DanmakuLayer {
  constructor() {
    this.el = null;
    this.laneFreeAt = [];
    this.items = [];
    this.recent = []; // 最近几条，供 AI 互相接话
  }

  mount(el) {
    this.el = el;
    if (!el) return;
    this.laneFreeAt = new Array(DANMAKU.lanes).fill(0);
    el.innerHTML = '';
    this.items = [];
    this.recent = [];
  }

  unmount() {
    if (this.el) this.el.innerHTML = '';
    this.items.forEach((it) => { if (it.timer) clearTimeout(it.timer); });
    this.items = [];
    this.el = null;
  }

  /**
   * 发一条弹幕
   * @param {{seat:number, name:string, text:string, self?:boolean}} msg
   */
  push({ seat, name, text, self = false }) {
    if (!this.el) return null;
    const { name: n, body } = clipDanmaku(text, name);
    if (!body) return null;

    const now = Date.now();
    const { lane, freeAt } = pickLane(this.laneFreeAt, now);
    const chat = this.el.dataset?.presentation === 'chat';

    const node = document.createElement('div');
    node.className = `${chat ? 'room-chat-item' : 'danmaku-item'}${self ? ' is-self' : ''}`;
    const author = document.createElement('span');
    author.className = 'dm-name'; author.textContent = n;
    const message = document.createElement('span');
    message.className = 'dm-text'; message.textContent = body;
    node.append(author, message);
    if (!chat) { node.style.top = `${6 + lane * 32}px`; node.style.color = colorOfSeat(seat); }
    else {
      const stamp = document.createElement('time'); stamp.className = 'room-chat-time';
      stamp.textContent = new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      node.append(stamp);
    }
    const wasNearBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 48;
    this.el.append(node);
    if (chat) {
      while (this.el.children.length > 80) this.el.firstElementChild.remove();
      const hint = this.el.parentElement?.querySelector('.room-dm-tip');
      if (hint) hint.hidden = true;
      if (self || wasNearBottom) this.el.scrollTop = this.el.scrollHeight;
      const entry = { at: now, name: n, text: body, seat };
      this.recent.push(entry);
      if (this.recent.length > DANMAKU.recent) this.recent.shift();
      return entry;
    }

    // 依据实际宽度算飞行时长，保证速度一致
    const width = node.offsetWidth || 160;
    const layerWidth = this.el.clientWidth || window.innerWidth;
    const travel = layerWidth + width + 24;
    const dur = Math.max(4, travel / DANMAKU.speed);
    node.style.setProperty('--travel', `-${travel}px`);
    node.style.animationDuration = `${dur}s`;

    this.laneFreeAt[lane] = now + Math.min(dur * 1000, DANMAKU.life) * 0.55;
    const entry = { lane, at: now, name: n, text: body, seat };
    this.items.push(entry);
    this.recent.push(entry);
    if (this.recent.length > DANMAKU.recent) this.recent.shift();

    const timer = setTimeout(() => {
      node.remove();
      this.items = this.items.filter((x) => x !== entry);
    }, Math.min(DANMAKU.life, dur * 1000 + 400));
    entry.timer = timer;
    void freeAt;
    return entry;
  }

  /** 最近几条弹幕（给提示词用，含"谁说的"与时间，时间用来避免"刚聊完说好久不见"） */
  recentLines(n = DANMAKU.recent) {
    return this.recent.slice(-n).map((x) => ({
      name: x.name, text: x.text, seat: x.seat, at: x.at,
    }));
  }
}
