/**
 * 新手引导（用户拍板）
 * =====================================================================
 * 交互：**用遮罩压暗其他部分、把要讲的那一块挖出来**（四块拼出一个矩形空洞），
 * 洞里可以直接操作真实界面，洞外点一下就"跳过这一步"。
 *
 * 三段引导，各自只需要跑一次（存在 localStorage 的 `ddz_onboard_v1` 里）：
 *   · `main`    确认进入游戏后自动开始：设置 API → 社交 → 发现 → 遇见 → 选条件 → 开始匹配 →
 *               聊天 → 相聚 → 右侧选游戏
 *   · `shop`    **首次**点「商城」触发：充值 → 商城页签
 *   · `profile` **首次**点「我的主页」触发：改名 / 上传 → 称号 → 标签（装饰 / 背包）
 *
 * 设计要点：
 *   · 每一步都能被"点遮罩"跳过，也能点「跳过引导」整段结束 —— 绝不卡住玩家
 *   · `setup(el, api)` 由**调用方**决定（因为要打开对应的面板 / 切到对应的标签页），
 *     引导本身不猜界面，只负责挖洞、放文案、等条件
 *   · `done()` 决定这一步什么时候算完成（默认：点一下「下一步」）
 *   · 目标可以是选择器，也可以是一个**虚拟锚点**（返回 rect 的函数）——
 *     用来处理"遇见"里那些没有稳定 id 的元素
 */
import { toast } from './fx.js';

const STORE_KEY = 'ddz_onboard_v1';

/* ------------------------------------------------------------------ */
/*                          进度存取                                    */
/* ------------------------------------------------------------------ */
function readProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

function markDone(id) {
  const p = readProgress();
  p[id] = true;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* 存不下也不影响玩 */ }
}

/** 这一段跑过了吗（跑过就不再自动触发） */
export function onboardDone(id) { return !!readProgress()[id]; }

/** 重置存档时把引导进度也清掉（下次进来重新走） */
export function resetOnboard() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*                          几何工具                                    */
/* ------------------------------------------------------------------ */
const clampBox = (r) => {
  const pad = 6;
  const left = Math.max(4, r.left - pad);
  const top = Math.max(4, r.top - pad);
  const right = Math.min(window.innerWidth - 4, r.right + pad);
  const bottom = Math.min(window.innerHeight - 4, r.bottom + pad);
  return { left, top, width: Math.max(24, right - left), height: Math.max(24, bottom - top) };
};

/** 空一帧（DOM 已经更新、但还没绘制） */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * 等一个元素出现（最多 tries 次，每次一帧）
 * ★ 面板是**同步渲染**的，但为了稳，还是给它几帧机会 —— 元素没出来就量不到洞。
 */
async function waitFor(fn, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    const got = fn();
    if (got) return got;
    // eslint-disable-next-line no-await-in-loop
    await nextFrame();
  }
  return fn() || null;
}

/** 选择器 → 可见元素的矩形（不可见返回 null） */
function rectOfSelector(sel, root) {
  const el = (root || document).querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return clampBox(r);
}

/* ------------------------------------------------------------------ */
/*                          引导本体                                    */
/* ------------------------------------------------------------------ */
export class OnboardTour {
  /**
   * @param {object} app
   * @param {string} id 这一段的标识（main / shop / profile）
   * @param {Array} steps 步骤表
   */
  constructor(app, id, steps) {
    this.app = app;
    this.id = id;
    this.steps = Array.isArray(steps) ? steps.filter(Boolean) : [];
    this.index = -1;
    this.active = false;
    this.current = null;
    this.refreshing = false;
    this.onResize = () => this.refresh();
    this.layer = null;
  }

  /** 这一段跑过了吗 */
  get done() { return onboardDone(this.id); }

  /* ---------------- DOM ---------------- */
  ensureLayer() {
    if (this.layer) return this.layer;
    const el = document.createElement('div');
    el.className = 'ob-layer';
    /**
     * ★ 这个标记很关键：收银台 / 确认弹窗会把 `document.body` 的其他子节点设成 `inert`，
     *   引导层要**被排除在外** —— 否则遮罩和气泡都点不动，玩家被卡死在收银台里。
     *   见 ui/panels.js 的 backgrounds 过滤。
     */
    el.setAttribute('data-onboard-layer', '');
    el.innerHTML = `
      <div class="ob-shade ob-shade-top" data-ob-skip></div>
      <div class="ob-shade ob-shade-bottom" data-ob-skip></div>
      <div class="ob-shade ob-shade-left" data-ob-skip></div>
      <div class="ob-shade ob-shade-right" data-ob-skip></div>
      <div class="ob-ring" hidden></div>
      <div class="ob-bubble" hidden>
        <div class="ob-arrow" hidden></div>
        <div class="ob-title"></div>
        <div class="ob-text"></div>
        <div class="ob-foot">
          <span class="ob-step"></span>
          <button class="ob-btn" data-ob-skip type="button">跳过引导</button>
          <button class="ob-btn primary" data-ob-next type="button">下一步</button>
        </div>
      </div>`;
    // 点遮罩 = 跳过**这一步**（继续下一步）；点「跳过引导」= 整段不看（下次还会出现）
    el.addEventListener('click', (event) => {
      const t = event.target;
      if (t.closest('[data-ob-next]')) { this.advance(); return; }
      if (t.closest('.ob-shade')) { this.advance(); return; }
      if (t.closest('[data-ob-skip]')) { this.stop(); }
    });
    document.body.append(el);
    this.layer = el;
    this.shades = {
      top: el.querySelector('.ob-shade-top'),
      bottom: el.querySelector('.ob-shade-bottom'),
      left: el.querySelector('.ob-shade-left'),
      right: el.querySelector('.ob-shade-right'),
    };
    this.ring = el.querySelector('.ob-ring');
    this.bubble = el.querySelector('.ob-bubble');
    this.arrow = el.querySelector('.ob-arrow');
    this.elTitle = el.querySelector('.ob-title');
    this.elText = el.querySelector('.ob-text');
    this.elStep = el.querySelector('.ob-step');
    return el;
  }

  /* ---------------- 生命周期 ---------------- */
  start(force = false) {
    if (this.active) return;
    if (!force && this.done) return;
    if (!this.steps.length) return;
    // ★ 先关掉上一次的残留监听（重复 start 时不至于叠起来）
    this.unbindStepEvents();
    this.active = true;
    this.ensureLayer();
    this.layer.classList.add('is-open');
    window.addEventListener('resize', this.onResize);
    document.addEventListener('click', this.onResize, true);
    this.open(0);
  }

  /**
   * 中止这一段（点遮罩 / 跳过引导）
   * ★ 只在**跑完最后一步**时才记"已完成"（`finish()` 里记）——
   *   中途点遮罩只是跳过当前这一步的说明，引导会继续；真的想整段不看就点「跳过引导」，
   *   那样下次进大厅还会再出现一次（"跳过"不等于"走完了"）。
   */
  stop() {
    if (!this.active) return;
    this.active = false;
    this.current = null;
    this.index = -1;
    this.unbindStepEvents();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('click', this.onResize, true);
    if (this.layer) this.layer.classList.remove('is-open');
    if (this.onEnd) { const fn = this.onEnd; this.onEnd = null; fn(); }
  }

  finish() {
    markDone(this.id);
    this.active = false;
    this.current = null;
    this.unbindStepEvents();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('click', this.onResize, true);
    if (this.layer) this.layer.classList.remove('is-open');
    toast('新手引导完成，玩得开心！', 'gold');
    if (this.onEnd) { const fn = this.onEnd; this.onEnd = null; fn(); }
  }

  /** 打开第 n 步 */
  async open(n) {
    if (!this.active) return;
    this.index = n;
    if (n >= this.steps.length) { this.finish(); return; }
    const step = this.steps[n];
    this.current = step;
    this.unbindStepEvents();
    const el = this.ensureLayer();
    el.classList.add('is-open');

    /**
     * 1) 先让调用方把界面切到"这一步要看的样子"。
     *    ★ 只等定时器是不够的：面板渲染是同步的，但**量尺寸**必须在下一帧之后 ——
     *      所以这里先 await setup，再等一帧，再等目标元素真的出现（最多 8 帧）。
     */
    if (typeof step.setup === 'function') {
      try { await step.setup(this.app); } catch (err) { console.warn('[onboard] setup 失败：', err); }
      await nextFrame();
    }
    if (!this.active) return;

    // 2) 量一下目标，画洞 + 气泡
    try {
      this.elTitle.textContent = step.title || '';
      this.elText.innerHTML = step.text || '';
      this.elStep.textContent = `${n + 1} / ${this.steps.length}`;
      const nextBtn = el.querySelector('[data-ob-next]');
      const needAction = !!step.done;
      nextBtn.hidden = needAction;
      nextBtn.textContent = step.nextLabel || '下一步';
      this.paint();
    } catch (err) {
      /**
       * ★ 兜底：引导自己出问题（选择器写错、元素结构变了…）**绝不能把界面锁死** ——
       *   遮罩一旦立起来而内部逻辑抛错，玩家就会"什么都点不了"。
       *   所以这里任何异常都直接把整段引导收掉，并记成已完成，别再来一次。
       */
      console.error('[onboard] 渲染这一步失败，已自动结束引导：', err);
      markDone(this.id);
      this.stop();
      return;
    }

    // 3) 绑定"这一步什么时候算完成"
    if (needAction) this.bindStepDone(step);
  }

  /** 位置变了（滚动 / 面板重绘 / 窗口缩放）就重画 */
  refresh() {
    if (!this.active || this.refreshing) return;
    this.refreshing = true;
    // 让 DOM 先稳定一帧再量，避免面板动画中途测到错的位置
    requestAnimationFrame(() => {
      this.refreshing = false;
      if (this.active) this.paint();
    });
  }

  /** 量目标 → 摆四个色块 + 高亮圈 + 气泡 */
  paint() {
    if (!this.active || !this.current) return;
    const step = this.current;
    let box = null;
    if (typeof step.virtual === 'function') {
      box = step.virtual(this.app);
      if (box) box = clampBox(box);
    } else if (step.target) {
      box = rectOfSelector(step.target, document);
    }
    if (!box) {
      // 目标不在了（面板被关掉 / 元素还没出来）→ 整屏压暗 + 气泡居中，玩家仍可"跳过"
      box = { left: 0, top: 0, width: 0, height: 0 };
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const { left, top, width, height } = box;
    const right = W - (left + width);
    const bottom = H - (top + height);
    this.shades.top.style.cssText = `left:0;top:0;width:${W}px;height:${top}px`;
    this.shades.bottom.style.cssText = `left:0;top:${top + height}px;width:${W}px;height:${bottom}px`;
    this.shades.left.style.cssText = `left:0;top:${top}px;width:${left}px;height:${height}px`;
    this.shades.right.style.cssText = `left:${left + width}px;top:${top}px;width:${right}px;height:${height}px`;

    if (width > 0) {
      this.ring.hidden = false;
      this.ring.style.cssText = `left:${left - 4}px;top:${top - 4}px;width:${width + 8}px;height:${height + 8}px`;
    } else {
      this.ring.hidden = true;
    }

    // 气泡：目标在屏幕下半就放上面，反之放下面；左右夹在视口内
    const bw = Math.min(330, W - 32);
    let bx = Math.round(left + width / 2 - bw / 2);
    bx = Math.max(16, Math.min(W - bw - 16, bx));
    const spaceBelow = H - (top + height);
    const below = spaceBelow >= 190 || spaceBelow > top;
    this.bubble.hidden = false;
    this.bubble.classList.toggle('is-below', below);
    this.bubble.style.width = `${bw}px`;
    this.bubble.style.left = `${bx}px`;
    if (below) {
      this.bubble.style.top = `${Math.min(H - 60, top + height + 16)}px`;
      this.bubble.style.bottom = 'auto';
      this.arrow.hidden = width === 0;
      if (!this.arrow.hidden) this.arrow.style.top = '-7px';
    } else {
      this.bubble.style.bottom = `${Math.min(H - 40, H - (top - 16))}px`;
      this.bubble.style.top = 'auto';
      this.arrow.hidden = width === 0;
      if (!this.arrow.hidden) {
        this.arrow.style.top = 'auto';
        this.arrow.style.bottom = '-7px';
        this.arrow.style.transform = 'translateX(-50%) rotate(225deg)';
      }
    }
    if (below && !this.arrow.hidden) this.arrow.style.transform = 'translateX(-50%) rotate(45deg)';
  }

  advance() {
    if (!this.active) return;
    this.open(this.index + 1);
  }

  /* ---------------- "这一步算完成"的监听 ---------------- */
  bindStepDone(step) {
    const self = this;
    const finish = () => {
      if (!self.active || self.current !== step) return;
      if (step.keepOpen === false && typeof step.cleanup === 'function') step.cleanup(self.app);
      self.advance();
    };
    const handler = (event) => {
      if (!self.active || self.current !== step) return;
      let ok = false;
      try { ok = !!step.done(self.app, event); } catch (err) {
        console.warn('[onboard] done() 抛错：', err); return;
      }
      if (ok) finish();
    };
    self._stepHandler = handler;
    // 用捕获阶段，保证在面板自己的处理逻辑之前就能看到事件
    ['click', 'input', 'change', 'pointerup'].forEach((type) => {
      document.addEventListener(type, handler, true);
    });
    // 有些步骤不是"用户动作"驱动的（比如"聊到 10 条"），给它们一个轮询兜底
    if (step.poll) {
      self._poll = setInterval(() => {
        if (!self.active || self.current !== step) return;
        let ok = false;
        try { ok = !!step.done(self.app, null); } catch { /* ignore */ }
        if (ok) finish();
      }, 500);
    }
  }

  unbindStepEvents() {
    if (this._stepHandler) {
      ['click', 'input', 'change', 'pointerup'].forEach((type) => {
        document.removeEventListener(type, this._stepHandler, true);
      });
      this._stepHandler = null;
    }
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
  }
}

/* ------------------------------------------------------------------ */
/*                          主引导（确认进入游戏后自动跑一次）             */
/* ------------------------------------------------------------------ */
/** 「遇见」里几个没有稳定 id 的元素：按文字找出来量尺寸 */
function byText(selector, text) {
  return [...document.querySelectorAll(selector)]
    .find((el) => String(el.textContent || '').trim() === text) || null;
}

/**
 * 主引导：设置(API) → 社交 → 发现 → 遇见 → 选条件 → 开始匹配 → 聊天 → 相聚 → 右侧选游戏
 * @param {object} app
 * @param {(open:boolean)=>void} [setOn] 让 app 打开 / 收起设置面板
 */
export function startMainTour(app, { setOn } = {}) {
  const tour = new OnboardTour(app, 'main', [
    /* ---- 1) 配置 API Key ---- */
    {
      target: '#set-key',
      title: '先让 AI 开口说话',
      text: '先配置一下 <b>DeepSeek API Key</b>：把 <code>sk-</code> 开头的那串粘进这个输入框，'
        + '再点下面的「<b>测试连通</b>」。<br>'
        + '填一次就够了（存在本机，不进版本库）。<b>没有 Key 也能玩</b>，只是 AI 会改用本地台词。',
      /**
       * ★ 这一步必须**真的把设置面板打开**（上一版没打开，遮罩就罩了个空）。
       *   打开方式按可靠性排序：app.openSettings() → 大厅那个按钮 →
       *   社交侧栏的转发按钮（social → data-proxy="btn-lobby-settings"）。
       *   打开后还要等 `#set-key` 真的出现，量出来的洞才是对的。
       */
      async setup(a) {
        const openPanel = () => {
          if (typeof app.openSettings === 'function') { app.openSettings(); return true; }
          const btn = document.getElementById('btn-lobby-settings');
          if (btn) { btn.click(); return true; }
          const proxy = document.querySelector('[data-proxy="btn-lobby-settings"]');
          if (proxy) { proxy.click(); return true; }
          return false;
        };
        openPanel();
        await nextFrame();
        // 面板已经开着就不用再点（避免重复开 / 关）
        if (!document.querySelector('#set-key')) { openPanel(); }
        await waitFor(() => document.querySelector('#set-key'));
      },
      done(a, ev) {
        if (!ev) return false;
        const el = ev.target;
        return !!(el && el.closest && el.closest('#btn-test-key'));
      },
      keepOpen: true,
    },
    /* ---- 2) 左侧社交 ---- */
    {
      async setup(a) {
        if (setOn) setOn(false);
        await new Promise((r) => setTimeout(r, 220));
      },
      target: '[data-proxy="nav-friends"]',
      title: '这里是社交系统',
      text: '点这里进社交：好友列表、群聊、朋友圈都在里面 —— 你和 AI 好友可以随时聊天。',
    },
    /* ---- 3) 发现好友 ---- */
    {
      async setup() {
        document.querySelector('[data-proxy="nav-friends"]')?.click();
        await new Promise((r) => setTimeout(r, 300));
      },
      target: '.panel-tab[data-ftab="discover"]',
      title: '想认识新朋友就来这',
      text: '「发现好友」里有两种方式：<b>遇见</b>（随机配一个陌生人聊两句）和 <b>发现</b>（一批推荐的人）。',
    },
    /* ---- 4) 遇见 ---- */
    {
      target: virtualDiscoverNav('遇见'),
      title: '「遇见」是什么样的',
      text: '点「遇见」：挑一下希望遇见的性别和年龄，然后开始匹配，<b>不消耗任何东西</b>。',
    },
    /* ---- 5) 选好条件 ---- */
    {
      async setup() {
        byText('.discover-tabs button', '遇见')?.click();
        await new Promise((r) => setTimeout(r, 260));
      },
      target: virtualEncounterSettings,
      title: '选一下希望遇见谁',
      text: '点一下性别、<b>拖一下年龄</b>，然后点下面那个「开始遇见」。',
      // 两个条件都动过（或直接点开始）就算完成；开始匹配由下一步接管
      done(app2, ev) {
        if (ev && ev.target && ev.target.closest && ev.target.closest('#encounter-start')) return true;
        if (ev && ev.target && ev.target.id === 'encounter-age') tour.ageTouched = true;
        if (ev && ev.target && ev.target.closest && ev.target.closest('[data-encounter-gender]')) tour.genderTouched = true;
        return !!(tour.ageTouched && tour.genderTouched);
      },
      poll: false,
    },
    /* ---- 6) 看聊天 ---- */
    {
      target: '.encounter-chat',
      title: '这就是你们的聊天',
      text: '和 TA 聊几句试试：聊够 <b>10 条</b>、点「结束聊天」、或者直接点别处，都可以结束这一步。',
      keepOpen: true,
      done(a, ev) {
        // 三种结束方式都算：聊到 10 条 / 结束聊天 / 玩家点到聊天区以外
        if (!document.querySelector('.encounter-chat')) return true;
        const log = document.getElementById('encounter-log');
        const rows = log ? log.querySelectorAll('.chat-row').length : 0;
        if (rows >= 10) return true;
        if (ev && ev.target && ev.target.closest) {
          // 点聊天记录里 / 输入框 / 发送键都算"还在聊"，点别处就当这一步过了
          const inside = ev.target.closest('#encounter-log')
            || ev.target.closest('.encounter-input')
            || ev.target.closest('.encounter-unlock')
            || ev.target.closest('#encounter-add')
            || ev.target.closest('.ob-layer'); // 引导自己的按钮不算"点别处"
          if (!inside) return true;
        }
        return false;
      },
      poll: true,
    },
    /* ---- 7) 左侧"相聚" ---- */
    {
      async setup() {
        // 把遇见那边收干净，回大厅
        document.getElementById('encounter-exit')?.click();
        await new Promise((r) => setTimeout(r, 200));
        document.querySelector('[data-social-home]')?.click();
        document.querySelector('[data-close]')?.click();
        await new Promise((r) => setTimeout(r, 260));
      },
      target: '[data-social-home]',
      title: '这里可以玩游戏',
      text: '「相聚」是大厅：和好友、遇上的人都从这儿开局。',
    },
    /* ---- 8) 右侧：选游戏 ---- */
    {
      target: '.lobby-main',
      title: '挑一个玩法开始吧',
      text: '右边选<b>玩法与场次</b>（斗地主 / 小猫钓鱼 / 五子棋），点「开始游戏」。<br>玩一局，新手引导就结束啦。',
      async setup() {
        await new Promise((r) => setTimeout(r, 200));
      },
      done() {
        // 真的进桌了就算完成
        const table = document.getElementById('screen-table');
        const fishing = document.getElementById('screen-fishing');
        const gomoku = document.getElementById('screen-gomoku');
        return !!(table && !table.hidden) || !!(fishing && !fishing.hidden) || !!(gomoku && !gomoku.hidden);
      },
      poll: true,
    },
  ]);
  tour.start();
  return tour;
}

/** 虚拟锚点：按文字找「遇见 / 发现」那个页签 */
function virtualDiscoverNav(label) {
  return () => {
    const el = byText('.discover-tabs button', label);
    if (!el) return null;
    return el.getBoundingClientRect();
  };
}

/** 虚拟锚点：遇见那一页的设置区（性别 + 年龄 + 开始按钮） */
function virtualEncounterSettings() {
  const start = document.getElementById('encounter-start');
  const settings = document.querySelector('.encounter-settings');
  const a = settings ? settings.getBoundingClientRect() : null;
  const b = start ? start.getBoundingClientRect() : null;
  if (!a && !b) return null;
  const left = Math.min(a ? a.left : Infinity, b ? b.left : Infinity);
  const top = a ? a.top : b.top;
  const right = Math.max(a ? a.right : -Infinity, b ? b.right : -Infinity);
  const bottom = b ? b.bottom : a.bottom;
  return { left, top, right, bottom };
}
/** 首次进商城 */
export function startShopTour(app) {
  const tour = new OnboardTour(app, 'shop', [
    {
      target: '.shop-tab[data-tab="beans"]',
      title: '这里充值开心豆',
      text: '开心豆是这里的通用货币：对局输赢、买道具与装扮都用它。<br>点左边那个 <b>¥ 6</b> 的套餐试试 —— 是模拟支付，不会真的扣钱。',
      // 收银台走完四步（成功页出现）= 这一步做到了；中途取消就继续等
      done: () => !!document.querySelector('[data-pay-stage] .pay-done-emoji'),
      poll: true,
    },
    {
      target: '.shop-tabs',
      title: '商城里还能买这些',
      text: '上面的页签可以切换：<b>称号 / 道具 / 礼物 / 装扮</b>。道具在牌桌上用，礼物送给好友，装扮换头像框和牌面。',
    },
  ]);
  tour.start();
  return tour;
}

/** 首次进我的主页 */
export function startProfileTour(app) {
  const tour = new OnboardTour(app, 'profile', [
    {
      target: '.prof-preview',
      title: '这里改头像和名字',
      text: '点头像可以<b>上传一张自己的照片</b>；点「改名」会消耗一张<b>改名卡</b>。',
    },
    {
      target: '.prof-pane[data-prof-pane="basic"] .prof-titles',
      title: '这里换称号',
      text: '已解锁的称号都能戴上，它会显示在大厅、牌桌和好友列表里。',
    },
    {
      target: '.prof-tabs',
      title: '装饰与背包',
      text: '「<b>装饰</b>」里装配买到的头像框 / 牌背 / 风格；「<b>背包</b>」里能看到买到的道具、礼物和改名卡。',
    },
  ]);
  tour.start();
  return tour;
}
