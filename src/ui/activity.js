/**
 * 活动中心面板（PRD §2.16）
 *
 * 布局和「好友」「房间」一致：**左边活动列表 / 右边选中活动的详情**
 *   · 左侧每一项：图标 + 名字 + 状态角标（可领 / 已领 / 限时 / 锁），能领的带红点
 *   · 右侧是详情：花字标题 + 倒计时 + 奖励清单 + 操作按钮（转盘那一页就是整个转盘）
 *
 * 两个刻意的设计：
 *  1. **只有首充礼包走邮箱**（仪式感 + 让邮箱有存在意义）；
 *     免费礼包、限时礼包、累计充值、折扣、转盘**全部直接到账**（点了立刻看到豆子涨）
 *  2. 活动标题用"花字"（渐变 + 发光 + 斜切），不用最普通的黑体一行 —— 这是游戏不是设置页
 */
import { openDrawer, closePanel, drawerShell, openShop, openSignIn, runMockPayment } from './panels.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { WHEEL, formatLeft, msUntilTomorrow, msUntilNextWeek, rewardLabel, DISCOUNT_RATE, wheelSeg, wheelTargetAngle } from '../data/activities.js';
import {
  activityOverview, claimFreeGift, claimFirstPay, buyDailyPack, claimPayTier, buyDiscount, spinWheel,
} from '../store/activity.js';
import { unreadMailCount } from '../store/rewards.js';
import { FRAMES } from '../data/cosmetics.js';

const TONE = { neon: 'act-title-neon', gold: 'act-title-gold', fire: 'act-title-fire', royal: 'act-title-royal' };

const rewardChips = (list) => (list || []).map((r) => {
  const { emoji, text } = rewardLabel(r);
  return `<span class="act-reward"><i>${emoji}</i>${text}</span>`;
}).join('');

const cd = (kind) => `<span data-cd="${kind}">--:--:--</span>`;

/* ===================================================================== */
/*                              大转盘                                   */
/* ===================================================================== */
const SEG = wheelSeg();
/** 转动时长（毫秒）—— 必须和 styles/activity.css 里 .wheel 的 transition 一致 */
const SPIN_MS = 4200;

function wheelFace() {
  const segs = WHEEL.prizes.map((p, i) => {
    const color = p.jackpot ? '#7a4a00' : (i % 2 ? '#2a1a44' : '#3d2a68');
    return `${color} ${i * SEG}deg ${(i + 1) * SEG}deg`;
  }).join(', ');
  return `conic-gradient(from 0deg, ${segs})`;
}

function wheelLabels() {
  return WHEEL.prizes.map((p, i) => {
    const mid = i * SEG + SEG / 2;
    const cls = ['wheel-label'];
    if (p.jackpot) cls.push('is-jackpot');
    if (p.limited) cls.push('is-limited');
    return `<span class="${cls.join(' ')}" style="transform: rotate(${mid}deg) translateY(-96px) rotate(${-mid}deg)">
      <i>${p.emoji}</i><b>${p.short || p.label}</b>
    </span>`;
  }).join('');
}

/* ===================================================================== */
/*                              面板                                     */
/* ===================================================================== */
export function openActivity(app) {
  let pick = 'gift';
  let giftTab = 'daily'; // 免费礼包里的子标签：daily / weekly
  let ticker = null;
  let spinning = false;
  let rotation = 0;

  const el = openDrawer(`
    <div class="drawer act-drawer">
      <div class="drawer-head">
        <h3 class="drawer-title">活动中心</h3>
        <button class="drawer-close" data-close type="button">✕</button>
      </div>
      <div class="act-body">
        <aside class="act-nav" id="act-nav"></aside>
        <section class="act-main" id="act-main"></section>
      </div>
    </div>`, {
    onClose: () => { if (ticker) clearInterval(ticker); ticker = null; },
  });

  const nav = el.querySelector('#act-nav');
  const main = el.querySelector('#act-main');

  /** 倒计时统一在这里刷新：只改文本，不重绘整个面板（否则转盘动画会被掐断） */
  function startTicker() {
    if (ticker) clearInterval(ticker);
    const paint = () => {
      const now = new Date();
      main.querySelectorAll('[data-cd]').forEach((n) => {
        const ms = n.dataset.cd === 'week' ? msUntilNextWeek(now) : msUntilTomorrow(now);
        n.textContent = formatLeft(ms);
      });
    };
    paint();
    ticker = setInterval(paint, 1000);
  }

  /** 左侧列表：状态角标与红点都从这里出 */
  function navItems(o) {
    const si = app.economy.signInState();
    const giftHot = o.daily.canClaim || o.weekly.canClaim;
    return [
      {
        key: 'signin', emoji: '📅', name: '每日签到', badge: si.signedToday ? '已签' : '可领', hot: !si.signedToday,
      },
      {
        // 每日 / 每周合并成一项，里面再分子标签
        key: 'gift',
        emoji: '🎁',
        name: '免费礼包',
        badge: giftHot ? '可领' : '已领',
        hot: giftHot,
      },
      {
        key: 'first',
        emoji: o.first.gift.emoji,
        name: '首充礼包',
        badge: o.first.claimed ? '已领' : (o.first.paid ? '可领' : '未充'),
        hot: o.first.canClaim,
        gold: true,
      },
      {
        // 今日限时礼包现在是**两款**（档位不同）：角标把两个价格都写出来
        key: 'pack',
        emoji: o.pack.packs[0] ? o.pack.packs[0].emoji : '🎁',
        name: '今日限时礼包',
        badge: o.pack.canBuy ? o.pack.packs.map((p) => `¥${p.price}`).join('/') : '已买',
        fire: true,
      },
      {
        key: 'tiers',
        emoji: '💠',
        name: '累计充值礼包',
        badge: o.tiers.tiers.some((t) => t.canClaim) ? `${o.tiers.tiers.filter((t) => t.canClaim).length} 档可领` : `¥${o.tiers.total}`,
        hot: o.tiers.tiers.some((t) => t.canClaim),
      },
      {
        key: 'discount',
        emoji: '⚡',
        name: '今日限时折扣',
        badge: o.discount && o.discount.canBuy ? '5折' : '已购',
        fire: true,
      },
      {
        key: 'wheel', emoji: '🎡', name: '幸运转盘', badge: '抽奖', wheel: true,
      },
    ];
  }

  function renderNav(o) {
    nav.innerHTML = navItems(o).map((it) => `
      <button class="act-nav-item ${it.key === pick ? 'is-active' : ''} ${it.gold ? 'is-gold' : ''} ${it.fire ? 'is-fire' : ''}"
        data-act="${it.key}" type="button">
        <span class="ani-emoji">${it.emoji}</span>
        <span class="ani-meta">
          <span class="ani-name">${it.name}</span>
          <span class="ani-badge">${it.badge}</span>
        </span>
        ${it.hot ? '<i class="ani-dot"></i>' : ''}
      </button>`).join('');
    nav.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
      pick = btn.dataset.act;
      render();
    }));
  }

  /** 详情页头：大图标 + 花字标题 + 副标题 + 倒计时 */
  const detailHead = (emoji, tone, title, sub, ribbon) => `
    <div class="act-detail-head ${ribbon === 'gold' ? 'is-gold' : ribbon === 'fire' ? 'is-fire' : ''}">
      ${ribbon ? `<span class="act-ribbon ${ribbon === 'fire' ? 'is-fire' : ''}">${ribbon === 'fire' ? '限时' : '仅此一次'}</span>` : ''}
      <div class="adh-emoji">${emoji}</div>
      <div class="adh-text">
        <div class="act-title ${TONE[tone]}">${title}</div>
        <div class="act-sub">${sub}</div>
      </div>
    </div>`;

  function renderDetail(o) {
    const si = app.economy.signInState();
    switch (pick) {
      case 'signin':
        return `
          ${detailHead('📅', 'neon', '每日签到', '连续签到奖励递增，断签从第 1 天重算 · 连签 8 天送称号「劳模」')}
          <div class="act-panel">
            <div class="act-rewards">${si.rewards.map((v, i) => `<span class="act-reward ${i + 1 === si.dayIndex ? 'is-today' : ''}"><i>第 ${i + 1} 天</i>💰 ${v.toLocaleString()}</span>`).join('')}</div>
            <div class="act-note">已连续签到 <b style="color:var(--gold)">${si.signedToday ? si.streak : Math.max(0, si.streak - 1)}</b> 天 · 距下次刷新 ${cd('day')}</div>
          </div>
          <div class="act-action">
            <button class="act-btn go big" data-act-open-signin type="button">${si.signedToday ? '查看签到进度' : `签到领 💰${si.reward.toLocaleString()}`}</button>
          </div>`;

      case 'gift': {
        // 每日 / 每周两个子标签，共用一套版式
        const isWeek = giftTab === 'weekly';
        const g = isWeek ? o.weekly : o.daily;
        const other = isWeek ? o.daily : o.weekly;
        return `
          ${detailHead(g.gift.emoji, 'neon', '免费礼包', '不用花钱、不用做任务，到点来领就行')}
          <div class="act-subtabs" id="gift-tabs">
            <button class="act-subtab ${isWeek ? '' : 'is-active'}" data-gift="daily" type="button">
              每日 <i>${o.daily.canClaim ? '可领' : '已领'}</i>
            </button>
            <button class="act-subtab ${isWeek ? 'is-active' : ''}" data-gift="weekly" type="button">
              每周 <i>${o.weekly.canClaim ? '可领' : '已领'}</i>
            </button>
          </div>
          <div class="act-panel">
            <div class="act-gift-title ${TONE.neon}">${g.gift.name}</div>
            <div class="act-sub">${g.gift.sub} · 距刷新 ${cd(isWeek ? 'week' : 'day')}</div>
            <div class="act-rewards">${rewardChips(g.gift.rewards)}</div>
            <div class="act-note">
              ${isWeek
    ? '每周一 0 点刷新，比每日礼包厚得多。'
    : `每天 0 点刷新。${other.canClaim ? '本周的免费礼包也还没领。' : ''}`}
            </div>
          </div>
          <div class="act-action">
            <button class="act-btn go big" data-claim="${isWeek ? 'weekly' : 'daily'}" type="button" ${g.canClaim ? '' : 'disabled'}>
              ${g.canClaim ? '领 取' : (isWeek ? '这周已领，下周再来' : '今天已领，明天再来')}
            </button>
          </div>`;
      }

      case 'first':
        return `
          ${detailHead(o.first.gift.emoji, 'gold', o.first.gift.name, o.first.gift.sub, 'gold')}
          <div class="act-panel">
            <div class="act-rewards">${rewardChips(o.first.gift.rewards)}</div>
            <div class="act-note">
              ${o.first.claimed ? '已经领过啦，奖励在邮箱里。'
    : o.first.paid ? '充值已达成，奖励会发到邮箱 📧'
      : '充值任意金额（商城买任意一袋开心豆）即可领取，奖励发到邮箱 📧'}
            </div>
          </div>
          <div class="act-action">
            ${o.first.claimed
    ? '<button class="act-btn big" type="button" disabled>已领取</button>'
    : o.first.paid
      ? '<button class="act-btn go big" data-claim="first" type="button">领 取</button>'
      : '<button class="act-btn go big" data-go-shop type="button">去充值</button>'}
          </div>`;

      case 'pack': {
        const pk = o.pack;
        return `
          ${detailHead('🎁', 'fire', '今日限时礼包', `今天两款 · 档位不同 · 剩余 ${cd('day')}`, 'fire')}
          <div class="act-panel">
            <div class="act-packs">
              ${pk.packs.map((p) => `
                <div class="act-pack ${p.bought ? 'is-done' : ''}">
                  <div class="ap-head"><span class="ap-emoji">${p.emoji}</span><span class="ap-name">${p.name}</span></div>
                  <div class="act-deal">
                    <span class="act-old">¥ ${p.price * 2}</span>
                    <span class="act-now">¥ ${p.price}</span>
                  </div>
                  <div class="act-rewards small">${rewardChips(p.rewards)}</div>
                  <button class="act-btn go" data-buy-pack="${p.id}" type="button" ${p.canBuy ? '' : 'disabled'}>
                    ${p.canBuy ? `购买 ¥ ${p.price}` : '✓ 今天已买'}
                  </button>
                </div>`).join('')}
            </div>
            <div class="act-note">
              每天 0 点换**两款**：随机挑两个**不同档位**的礼包（¥6 / ¥30 / ¥128 / ¥648 里挑两个），
              各买各的、互不影响。**买完直接到账**（豆子与道具立刻到手）。
            </div>
          </div>`;
      }

      case 'tiers':
        return `
          ${detailHead('💠', 'royal', '累计充值礼包', `已累计充值 <b style="color:var(--gold)">¥ ${o.tiers.total}</b> · 每一档只能领一次`)}
          <div class="act-panel">
            <div class="act-tiers">
              ${o.tiers.tiers.map((t) => `
                <div class="act-tier ${t.claimed ? 'is-done' : t.reached ? 'is-ready' : ''}">
                  <div class="at-head">
                    <span class="at-yuan">¥${t.yuan}</span>
                    ${t.claimed ? '<span class="at-state">✓ 已领</span>'
    : t.reached ? `<button class="act-btn tiny go" data-claim-tier="${t.yuan}" type="button">领取</button>`
      : '<span class="at-state">🔒 未达成</span>'}
                  </div>
                  <div class="act-rewards small">${rewardChips(t.rewards)}</div>
                </div>`).join('')}
            </div>
            <div class="act-note">累计充值看的是**充值总额**（商城买豆子 + 限时礼包都会累加），和身家无关。**领了直接到账**。</div>
          </div>`;

      case 'discount': {
        const d = o.discount;
        if (!d) return '<p class="center-note">今天没有折扣商品</p>';
        return `
          ${detailHead(d.item.emoji, 'fire', `今日折扣 · ${Math.round(DISCOUNT_RATE * 10)} 折`, `${d.item.name} · 剩余 ${cd('day')}`, 'fire')}
          <div class="act-panel">
            <div class="act-deal big">
              <span class="act-old">💰 ${d.item.price.toLocaleString()}</span>
              <span class="act-now">💰 ${d.price.toLocaleString()}</span>
              <span class="act-off">省 ${d.off.toLocaleString()} 豆</span>
            </div>
            <div class="act-rewards"><span class="act-reward"><i>${d.item.emoji}</i>${d.item.name} ×1</span>
              ${d.maxBuys > 1 ? `<span class="act-reward">今日还剩 <b>${d.left}</b> / ${d.maxBuys} 次</span>` : ''}</div>
            <div class="act-note">
              每天随机挑一件打折，0 点换新的。花的是开心豆，不是充值。
              ${d.maxBuys > 1 ? `**道具类是消耗品，今天可以买 ${d.maxBuys} 次**（装扮类只给 1 次）。` : ''}
            </div>
          </div>
          <div class="act-action">
            <button class="act-btn go big" data-buy-discount type="button" ${d.canBuy ? '' : 'disabled'}>
              ${d.canBuy
    ? `抢购 💰 ${d.price.toLocaleString()}${d.maxBuys > 1 ? `（剩 ${d.left} 次）` : ''}`
    : (d.maxBuys > 1 ? `今天已经买满 ${d.maxBuys} 次` : '今天已经抢过了')}
            </button>
          </div>`;
      }

      case 'wheel':
      default:
        return `
          ${detailHead('🎡', 'gold', '幸运转盘', `${(o.wheel.jackpotChance * 100).toFixed(1)}% 概率中 <b style="color:var(--gold)">1,000,000 豆</b> 头奖`)}
          <div class="act-panel is-wheel">
            <div class="wheel-wrap">
              <div class="wheel-ptr"></div>
              <div class="wheel no-anim" id="wheel" style="transform:rotate(${rotation}deg)">
                <div class="wheel-face" style="background:${wheelFace()}"></div>
                <div class="wheel-labels">${wheelLabels()}</div>
              </div>
              <button class="wheel-go" id="wheel-go" type="button" ${o.wheel.affordable ? '' : 'disabled'}>
                <b>${o.wheel.affordable ? '转' : '豆子不足'}</b>
                <i>💰 ${WHEEL.cost.toLocaleString()}</i>
              </button>
            </div>
            <div class="wheel-foot">
              已转 <b>${o.wheel.spins}</b> 次${o.wheel.bestWin ? ` · 最高中过 <b>💰 ${o.wheel.bestWin.toLocaleString()}</b>` : ''}
              <span class="wheel-tip">抽到已经有的头像框 / 称号，会自动折算成 💰 ${WHEEL.duplicateBeans.toLocaleString()} 豆</span>
            </div>
          </div>`;
    }
  }

  function bindDetail() {
    main.querySelector('[data-act-open-signin]')?.addEventListener('click', () => {
      closePanel();
      setTimeout(() => openSignIn(app), 180);
    });
    // 免费礼包的两个子标签
    main.querySelectorAll('#gift-tabs [data-gift]').forEach((btn) => btn.addEventListener('click', () => {
      giftTab = btn.dataset.gift;
      audio.play('select');
      render();
    }));
    main.querySelector('[data-claim="daily"]')?.addEventListener('click', () => {
      const res = claimFreeGift(app.save, 'daily');
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('activity');
      audio.play('coin');
      toast(`每日礼包：${res.got.join('  ')}`, 'gold');
      app.refreshLobby();
      render();
    });
    main.querySelector('[data-claim="weekly"]')?.addEventListener('click', () => {
      const res = claimFreeGift(app.save, 'weekly');
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('activity');
      audio.play('win');
      toast(`每周礼包：${res.got.join('  ')}`, 'gold');
      app.refreshLobby();
      render();
    });
    main.querySelector('[data-claim="first"]')?.addEventListener('click', () => {
      const res = claimFirstPay(app.save);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('activity');
      audio.play('win');
      toast('首充礼包已发到邮箱 📧', 'gold');
      app.refreshLobby();
      render();
    });
    main.querySelector('[data-go-shop]')?.addEventListener('click', () => {
      closePanel();
      setTimeout(() => openShop(app), 180);
    });
    main.querySelectorAll('[data-buy-pack]').forEach((btn) => btn.addEventListener('click', () => {
      // 今天有两款，点到哪款就买哪款
      const pack = activityOverview(app.save).pack.packs.find((p) => p.id === btn.dataset.buyPack);
      if (!pack) return;
      // 和商城买豆子**共用同一套模拟支付仪式**：确认订单 → 选支付方式 → 处理中 → 到账
      runMockPayment(app, {
        name: pack.name,
        price: pack.price,
        amountText: rewardLabel(pack.rewards[0]).text,
        onPaid: () => {
          const res = buyDailyPack(app.save, pack.id);
          if (!res.ok) return { bigText: '—', note: res.error };
          app.persist('activity');
          const got = res.got || [];
          return {
            order: res.order,
            // 直接把到手的东西写出来（现在是**直接到账**，不经过邮箱）
            bigText: got[0] || `¥ ${pack.price} 礼包`,
            note: got.length > 1 ? `奖励已直接到账，还有 ${got.slice(1).join('  ')}` : '奖励已直接到账',
          };
        },
      }, () => { render(); });
    }));
    main.querySelectorAll('[data-claim-tier]').forEach((btn) => btn.addEventListener('click', () => {
      const res = claimPayTier(app.save, Number(btn.dataset.claimTier));
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('activity');
      audio.play('win');
      toast(`累计充值 ¥${res.tier.yuan} 奖励已到账：${(res.got || []).join('  ')}`, 'gold');
      app.refreshLobby();
      render();
    }));
    main.querySelector('[data-buy-discount]')?.addEventListener('click', () => {
      const res = buyDiscount(app.economy);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('activity');
      audio.play('coin');
      const left = res.left ? `，今天还能买 ${res.left} 次` : '';
      toast(`抢到了：${res.item.name}（省 ${(res.item.price - res.price).toLocaleString()} 豆）${left}`, 'gold');
      app.refreshLobby();
      render();
    });
    main.querySelector('#wheel-go')?.addEventListener('click', doSpin);
  }

  function doSpin() {
    if (spinning) return;
    const wheel = main.querySelector('#wheel');
    if (!wheel) return;
    const res = spinWheel(app.economy, Math.random);
    if (!res.ok) return toast(res.error, 'bad');
    spinning = true;
    app.persist('activity');
    const go = main.querySelector('#wheel-go');
    if (go) go.disabled = true;

    // 指针在正上方：把中奖那一格的中心转到 0° 处，外加 5 圈让它转得够久。
    // 转动本身交给 CSS 的 transition（见 styles/activity.css 的 .wheel），这里只负责改角度。
    rotation = wheelTargetAngle(res.index, rotation, 5);
    wheel.classList.remove('no-anim');
    wheel.classList.add('is-spinning');
    wheel.style.transform = `rotate(${rotation}deg)`;
    audio.play('select');
    if (go) go.classList.add('is-busy');

    setTimeout(() => {
      spinning = false;
      wheel.classList.remove('is-spinning');
      if (go) go.classList.remove('is-busy');
      const big = !!(res.prize.jackpot || res.prize.limited);
      audio.play(big ? 'win' : 'coin');
      showPrize(res);
      app.refreshLobby();
    }, SPIN_MS + 120);
  }

  function showPrize(res) {
    const { emoji, text } = rewardLabel(res.reward);
    const big = !!(res.prize.jackpot || res.prize.limited);
    const title = res.prize.jackpot ? '🎉 头 奖 ！' : (res.prize.limited ? '✨ 限 定 ！' : '恭 喜 获 得');
    const overlay = document.createElement('div');
    overlay.className = 'wheel-result';
    overlay.innerHTML = `
      <div class="wr-card ${big ? 'is-big' : ''}">
        <div class="wr-title">${title}</div>
        <div class="wr-emoji">${emoji}</div>
        <div class="wr-text">${text}</div>
        ${res.duplicate ? '<div class="wr-note">已经拥有这件装扮，自动折算成豆子</div>' : ''}
        <div class="wr-actions">
          <button class="btn ghost" data-wr-again type="button">再来一次</button>
          <button class="btn primary" data-wr-ok type="button">收下</button>
        </div>
      </div>`;
    el.append(overlay);
    overlay.querySelector('[data-wr-ok]').addEventListener('click', () => { overlay.remove(); render(); });
    overlay.querySelector('[data-wr-again]').addEventListener('click', () => {
      overlay.remove();
      render();
      setTimeout(doSpin, 60);
    });
  }

  function render() {
    const o = activityOverview(app.save);
    renderNav(o);
    main.innerHTML = renderDetail(o);
    startTicker();
    bindDetail();
    // 重画出来的转盘要先把过渡关掉，否则会把"恢复角度"当成一次转动
    const w = main.querySelector('#wheel');
    if (w) w.offsetHeight; // 强制一次样式计算
    if (w) requestAnimationFrame(() => w.classList.remove('no-anim'));
    void unreadMailCount(app.save);
  }

  render();
}
