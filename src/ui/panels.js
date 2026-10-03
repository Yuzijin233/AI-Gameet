/**
 * 面板：商城（模拟支付）/ 签到 / 设置 / 聊天 / 结算（PRD §2.2 §2.3 §2.9 §2.7 §7.5）
 */
import { SHOP_ITEMS, ROOMS, DEFAULT_SETTINGS, CONFIG, BEANS_PER_YUAN, ECON, ITEMS, GIFTS, giftById } from '../config.js';
import { ASSETS } from '../../assets/manifest.js';
import { QUICK_PHRASES } from '../data/phrases.js';
import { randomNickname } from '../data/nicknames.js';
import { titleList, equipTitle, buyTitle, equippedTitle, isTitleUnlocked } from '../store/titles.js';
import { titleGradient, titleById } from '../data/titles.js';
import { itemCount, buyItem, addItems } from '../store/items.js';
import { cosmeticList, buyCosmetic, renameCardCount, useRenameCard, equipTheme } from '../store/cosmetics.js';
import { RENAME_CARD } from '../data/cosmetics.js';
import { maskKey } from '../data/secret.js';
import { voice } from './voice.js';
import { isFriend as isFriendAlready, syncPlayerRename } from '../store/friends.js';
import { requestFriend } from './friends.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { setTextureEnabled } from './cardsView.js';

const layer = () => document.getElementById('panel-layer');
let onCloseHook = null;

export function closePanel() {
  const el = layer();
  el.classList.remove('is-open');
  el.innerHTML = '';
  if (onCloseHook) { const fn = onCloseHook; onCloseHook = null; fn(); }
}

export function isPanelOpen() {
  return layer().classList.contains('is-open');
}

export function openDrawer(html, { onClose } = {}) {
  const el = layer();
  onCloseHook = onClose || null;
  el.innerHTML = html;
  el.classList.add('is-open');
  el.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closePanel));
  el.addEventListener('click', (e) => { if (e.target === el) closePanel(); }, { once: true });
  return el;
}

export function drawerShell(title, body, foot = '', cls = '') {
  return `
    <div class="drawer${cls ? ` ${cls}` : ''}" id="drawer-root">
      <div class="drawer-head">
        <h3 class="drawer-title">${title}</h3>
        <button class="drawer-close" data-close type="button">✕</button>
      </div>
      <div class="drawer-body">${body}</div>
      ${foot}
    </div>`;
}

/* ===================================================================== */
/*                                 商城                                  */
/* ===================================================================== */
export function openShop(app) {
  let tab = 'beans';

  const el = openDrawer(drawerShell('商城', `
    <div class="shop-tabs" id="shop-tabs">
      <button class="shop-tab is-active" data-tab="beans" type="button">💰 开心豆</button>
      <button class="shop-tab" data-tab="titles" type="button">🏅 称号</button>
      <button class="shop-tab" data-tab="items" type="button">🎁 道具</button>
      <button class="shop-tab" data-tab="gifts" type="button">💝 礼物</button>
      <button class="shop-tab" data-tab="looks" type="button">✨ 装扮</button>
    </div>
    <div class="shop-wallet">
      当前身家：<b>💰 ${app.economy.beans.toLocaleString()}</b>
      <span class="shop-wallet-tip">称号 / 道具 / 装扮用开心豆购买，豆子包里的是充值</span>
    </div>
    <div id="shop-body"></div>
  `, '', 'is-fixed'));

  const body = el.querySelector('#shop-body');

  /** 开心豆：模拟支付（不接真实支付） */
  function renderBeans() {
    const cards = SHOP_ITEMS.map((it) => `
      <div class="shop-item" data-item="${it.id}">
        ${it.tag ? `<span class="shop-tag">${it.tag}</span>` : ''}
        <div class="shop-beans">💰 ${it.beans.toLocaleString()}</div>
        <div class="shop-name">${it.name} · 开心豆</div>
        <button class="shop-buy" data-buy="${it.id}" type="button">
          <span class="shop-price">¥ ${it.price}</span>
          <span>购买</span>
        </button>
      </div>`).join('');
    body.innerHTML = `
      <p class="center-note" style="margin-top:0">汇率：<b style="color:var(--gold)">1 元 = ${BEANS_PER_YUAN.toLocaleString()} 开心豆</b><br>开心豆用于对局结算，输赢都以豆子结算。</p>
      <div class="shop-grid">${cards}</div>`;

    let busy = false;
    body.querySelectorAll('[data-buy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (busy) return; // 防连点（PRD Q13）
        busy = true;
        btn.disabled = true;
        const item = SHOP_ITEMS.find((i) => i.id === btn.dataset.buy);
        runMockPayment(app, {
          name: item.name,
          price: item.price,
          amountText: `💰 ${item.beans.toLocaleString()} 开心豆`,
          onPaid: () => {
            const { order } = app.economy.purchase(item);
            return { order, bigText: `💰 +${item.beans.toLocaleString()}`, note: '开心豆已到账' };
          },
        }, () => { busy = false; });
      });
    });
  }

  /** 称号：只展示**还没拥有**的商城称号（已有身家/签到档称号去左上角称号面板看） */
  function renderTitles() {
    const locked = titleList(app.save).filter((t) => t.kind === 'shop' && !t.unlocked);
    if (!locked.length) {
      body.innerHTML = '<p class="center-note" style="margin-top:20px">商城称号都已经拿到了，去左上角称号面板佩戴吧 🎉</p>';
      return;
    }
    body.innerHTML = `
      <p class="center-note" style="margin-top:0">花开心豆购买，买到的称号在**左上角称号面板**里佩戴。</p>
      <div class="shop-grid">${locked.map((t) => `
        <div class="shop-item">
          <div class="shop-title-badge"><span class="title-badge large" style="background:${titleGradient(t)}">${t.name}</span></div>
          <div class="shop-name">${t.desc || '商城称号'}</div>
          <button class="shop-buy" data-buy-title="${t.id}" type="button" ${t.affordable ? '' : 'disabled'}>
            <span class="shop-price">💰 ${t.price.toLocaleString()}</span>
            <span>${t.affordable ? '购买' : '豆子不足'}</span>
          </button>
        </div>`).join('')}</div>`;
    body.querySelectorAll('[data-buy-title]').forEach((btn) => btn.addEventListener('click', () => {
      const res = buyTitle(app.economy, btn.dataset.buyTitle);
      if (!res.ok) return toast(res.error, 'bad');
      audio.play('coin');
      toast(`购买成功：${res.title.name}`, 'gold');
      app.refreshLobby();
      app.refreshTitles();
      closePanel();
      setTimeout(() => openShop(app), 180);
    }));
  }

  /** 道具：牌桌上用了表达情绪，买到的进库存；★ 改名卡也算道具（用户拍板：它不是装扮） */
  function renderItems() {
    const list = cosmeticList(app.save);
    const beanRow = (n) => (app.economy.beans >= n ? '' : 'disabled');
    body.innerHTML = `
      <p class="center-note" style="margin-top:0">道具在牌桌上用（每种每局最多 ${CONFIG.toolPerHand} 次），只表达情绪、不影响出牌。</p>
      <div class="shop-grid">${ITEMS.map((it) => `
        <div class="shop-item">
          <div class="shop-item-emoji">${it.emoji}</div>
          <div class="shop-beans">${it.name} <span class="shop-stock">库存 ${itemCount(app.save, it.id)}</span></div>
          <div class="shop-name">${it.desc}</div>
          <button class="shop-buy" data-buy-item="${it.id}" type="button" ${app.economy.beans >= it.price ? '' : 'disabled'}>
            <span class="shop-price">💰 ${it.price.toLocaleString()}</span>
            <span>${app.economy.beans >= it.price ? '购买' : '豆子不足'}</span>
          </button>
        </div>`).join('')}
        <div class="shop-item">
          <div class="shop-item-emoji">${RENAME_CARD.emoji}</div>
          <div class="shop-beans">${RENAME_CARD.name} <span class="shop-stock">持有 ${list.renameCards}</span></div>
          <div class="shop-name">${RENAME_CARD.desc}</div>
          <button class="shop-buy" data-buy-look="renameCard" type="button" ${beanRow(list.renamePrice)}>
            <span class="shop-price">💰 ${list.renamePrice.toLocaleString()}</span>
            <span>购买</span>
          </button>
        </div>
      </div>`;
    body.querySelectorAll('[data-buy-item]').forEach((btn) => btn.addEventListener('click', () => {
      const res = buyItem(app.economy, btn.dataset.buyItem);
      if (!res.ok) return toast(res.error, 'bad');
      audio.play('coin');
      toast(`${res.item.emoji} ${res.item.name} ×1（库存 ${res.count}）`, 'gold');
      render();
    }));
    body.querySelectorAll('[data-buy-look="renameCard"]').forEach((btn) => btn.addEventListener('click', () => {
      const res = buyCosmetic(app.economy, { kind: 'renameCard' });
      if (!res.ok) return toast(res.error, 'bad');
      audio.play('coin');
      toast(`改名卡 ×1（现在有 ${renameCardCount(app.save)} 张）`, 'gold');
      render();
    }));
  }

  /** 装扮：牌背 / 头像框 / 整体风格（全是"看起来"的东西，不影响出牌与结算） */
  function renderLooks() {
    const list = cosmeticList(app.save);
    const beanRow = (n) => (app.economy.beans >= n ? '' : 'disabled');
    body.innerHTML = `
      <p class="center-note" style="margin-top:0">装扮只影响外观，**不影响出牌与结算**。头像框不需要贴图，佩戴后就是头像外面一圈描边与发光。</p>

      <h4 class="shop-sec">🖼️ 头像框</h4>
      <div class="shop-grid">
        ${list.frames.map((f) => `
          <div class="shop-item">
            <div class="look-face">
              <span class="look-ring ${f.owned ? 'is-owned' : ''}" style="box-shadow:0 0 0 3px ${f.color}, 0 0 16px ${f.color}"></span>
            </div>
            <div class="shop-beans">${f.name}${f.only ? ' <span class="shop-tag">活动</span>' : ''}</div>
            <div class="shop-name">${f.desc || ''}</div>
            ${f.forSale ? `
              <button class="shop-buy" data-buy-look="frame" data-look-id="${f.id}" type="button"
                ${f.owned || !f.affordable ? 'disabled' : ''}>
                <span class="shop-price">💰 ${f.price.toLocaleString()}</span>
                <span>${f.owned ? '已拥有' : '购买'}</span>
              </button>
              ${f.owned ? `<button class="mini-btn" data-equip-frame="${f.id}" type="button">${f.equipped ? '卸下' : '佩戴'}</button>` : ''}
            ` : `<div class="shop-name" style="color:var(--ink-faint)">${f.desc}</div>`}
          </div>`).join('')}
      </div>

      <h4 class="shop-sec">🖌️ 风格<small class="prof-hint">换的是整个界面的配色；牌桌那一屏保持深色（毛毡和牌都是照着深色画的）</small></h4>
      <div class="shop-grid">
        ${list.themes.map((t) => `
          <div class="shop-item">
            <div class="look-face">
              <span class="prof-theme-face is-${t.tone}" style="width:74px;height:46px">
                <span class="ptf-bg"></span><span class="ptf-chip"></span>
              </span>
            </div>
            <div class="shop-beans">${t.name}${t.equipped ? ' <span class="shop-stock">使用中</span>' : ''}</div>
            <div class="shop-name">${t.desc || ''}</div>
            ${t.forSale ? `
              <button class="shop-buy" data-buy-look="theme" data-look-id="${t.id}" type="button"
                ${t.owned || !t.affordable ? 'disabled' : ''}>
                <span class="shop-price">💰 ${t.price.toLocaleString()}</span>
                <span>${t.owned ? '已拥有' : '购买'}</span>
              </button>
              ${t.owned && !t.equipped ? `<button class="mini-btn" data-use-theme="${t.id}" type="button">切换</button>` : ''}
            ` : `<button class="mini-btn" data-use-theme="${t.id}" type="button" ${t.equipped ? 'disabled' : ''}>${t.equipped ? '使用中' : '切换'}</button>`}
          </div>`).join('')}
      </div>

      <h4 class="shop-sec">🂠 牌背</h4>
      <div class="shop-grid">
        ${list.cardBacks.map((b) => `
          <div class="shop-item">
            <div class="look-face"><span class="look-back" style="background-image:url('${ASSETS.cardBack(b.id)}')"></span></div>
            <div class="shop-beans">${b.name}${b.inUse ? ' <span class="shop-stock">使用中</span>' : ''}</div>
            <div class="shop-name">${b.desc || ''}</div>
            ${b.forSale ? `
              <button class="shop-buy" data-buy-look="cardBack" data-look-id="${b.id}" type="button"
                ${b.owned || !b.affordable ? 'disabled' : ''}>
                <span class="shop-price">💰 ${b.price.toLocaleString()}</span>
                <span>${b.owned ? '已拥有' : '购买'}</span>
              </button>
              ${b.owned && !b.inUse ? `<button class="mini-btn" data-use-back="${b.id}" type="button">使用</button>` : ''}
            ` : `<button class="mini-btn" data-use-back="${b.id}" type="button" ${b.inUse ? 'disabled' : ''}>${b.inUse ? '使用中' : '使用'}</button>`}
          </div>`).join('')}
      </div>`;

    body.querySelectorAll('[data-buy-look]').forEach((btn) => btn.addEventListener('click', () => {
      const res = buyCosmetic(app.economy, { kind: btn.dataset.buyLook, id: btn.dataset.lookId });
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('cosmetic');
      audio.play('coin');
      toast(res.kind === 'renameCard' ? `购买成功：改名卡 ×1（持有 ${res.count}）` : `购买成功：${res.name}`, 'gold');
      app.refreshLobby();
      render();
    }));
    body.querySelectorAll('[data-equip-frame]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.equipFrame;
      const cur = equippedFrame(app.save);
      const res = equipFrame(app.save, cur === id ? '' : id);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('cosmetic');
      audio.play('select');
      toast(res.frame ? '已佩戴头像框' : '已卸下头像框');
      app.refreshLobby();
      render();
    }));
    body.querySelectorAll('[data-use-back]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.useBack;
      if (!ownsCardBack(app.save, id)) return toast('还没有这个牌背', 'bad');
      app.save.settings.cardBack = id;
      app.persist('settings');
      app.applySettings();
      audio.play('select');
      toast('已切换牌背');
      render();
    }));
    // 风格：换的是整个界面的配色（见 styles/theme-light.css）
    body.querySelectorAll('[data-use-theme]').forEach((btn) => btn.addEventListener('click', () => {
      const res = equipTheme(app.save, btn.dataset.useTheme);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('cosmetic');
      app.applyTheme();
      audio.play('select');
      toast(res.theme ? '已切换风格' : '已回到默认风格（霓虹夜）');
      render();
    }));
  }

  /**
   * 礼物：买来送给好友的（用户拍板：💝 礼物 是独立一类）
   * 和"道具"分开：道具是牌桌上扔给对手的（鲜花/番茄/鸡蛋），礼物是好友界面送的。
   */
  function renderGifts() {
    body.innerHTML = `
      <p class="center-note" style="margin-top:0">礼物在**好友界面**送给好友（点头像旁的「🎁 赠送礼物」），
      每位好友**每天最多收 3 次**。送出去会加好感度、写进 TA 的记忆，而且几乎一定会收到一句回应。</p>
      <div class="shop-grid">${GIFTS.map((g) => `
        <div class="shop-item">
          <div class="shop-item-emoji">${g.emoji}</div>
          <div class="shop-beans">${g.name} <span class="shop-stock">持有 ${itemCount(app.save, g.id)}</span></div>
          <div class="shop-name">${g.desc}<br><b style="color:var(--gold)">好感度 +${g.affinity}</b></div>
          <button class="shop-buy" data-buy-gift="${g.id}" type="button" ${app.economy.beans >= g.price ? '' : 'disabled'}>
            <span class="shop-price">💰 ${g.price.toLocaleString()}</span>
            <span>${app.economy.beans >= g.price ? '购买' : '豆子不足'}</span>
          </button>
        </div>`).join('')}</div>`;
    body.querySelectorAll('[data-buy-gift]').forEach((btn) => btn.addEventListener('click', () => {
      const g = giftById(btn.dataset.buyGift);
      if (!g) return;
      if (app.economy.beans < g.price) return toast(`开心豆不足，需要 💰${g.price.toLocaleString()}`, 'bad');
      app.economy.addBeans(-g.price, 'gift');
      addItems(app.save, g.id, 1);
      app.persist('giftBuy');
      audio.play('coin');
      toast(`${g.emoji} ${g.name} ×1（持有 ${itemCount(app.save, g.id)}）—— 去好友界面送给 TA 吧`, 'gold');
      render();
    }));
  }

  function render() {
    el.querySelectorAll('.shop-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    const wallet = el.querySelector('.shop-wallet b');
    if (wallet) wallet.textContent = `💰 ${app.economy.beans.toLocaleString()}`;
    if (tab === 'beans') renderBeans();
    else if (tab === 'titles') renderTitles();
    else if (tab === 'looks') renderLooks();
    else if (tab === 'gifts') renderGifts();
    else renderItems();
  }

  el.querySelectorAll('.shop-tab').forEach((btn) => btn.addEventListener('click', () => {
    tab = btn.dataset.tab;
    render();
  }));
  render();
}

/**
 * 模拟支付流程（PRD Q13）：四步动画走完才算成功
 * 商城的豆子包、活动里的限时充值礼包**共用这一套**，仪式感保持一致。
 * @param {{name:string, price:number, amountText:string, note?:string, onPaid:Function}} opts
 *   onPaid() 在这一步真正扣款/发货，返回 { bigText, note } 用于成功页
 */
export function runMockPayment(app, opts, done) {
  const { name, price, amountText, onPaid } = opts;
  const el = layer();
  el.innerHTML = drawerShell('订单确认', `
    <div class="pay-box">
      <div class="pay-item">${name} · ${amountText}</div>
      <div class="pay-amount">¥ ${price}</div>
      <ul class="pay-steps" id="pay-steps">
        <li class="is-active"><span class="step-dot">1</span>确认订单信息</li>
        <li><span class="step-dot">2</span>选择支付方式</li>
        <li><span class="step-dot">3</span>支付处理中</li>
        <li><span class="step-dot">4</span>奖励到账</li>
      </ul>
      <div id="pay-stage"></div>
    </div>
  `);

  const steps = [...el.querySelectorAll('#pay-steps li')];
  const stage = el.querySelector('#pay-stage');
  let i = 0;
  const advance = () => {
    if (i > 0) { steps[i - 1].classList.remove('is-active'); steps[i - 1].classList.add('is-done'); steps[i - 1].querySelector('.step-dot').textContent = '✓'; }
    if (i >= steps.length) return finish();
    steps[i].classList.add('is-active');
    if (i === 2) stage.innerHTML = '<div class="pay-spinner"></div>';
    if (i === 1) {
      stage.innerHTML = `<div class="chip-group" style="justify-content:center;margin-top:12px">
        <span class="chip is-active">💳 银行卡</span><span class="chip">📱 扫码</span><span class="chip">🪙 零钱</span></div>`;
    }
    i += 1;
    setTimeout(advance, i === 3 ? 900 : 700);
  };

  const finish = () => {
    const res = (onPaid && onPaid()) || {};
    audio.play('coin');
    stage.innerHTML = `
      <div class="pay-done-emoji">🎉</div>
      <div style="font-size:15px;font-weight:700">支付成功${res.note ? `，${res.note}` : ''}</div>
      <div style="font-size:30px;font-weight:900;color:var(--gold);margin-top:6px">${res.bigText || ''}</div>
      <div class="center-note" style="font-size:11.5px;margin-top:6px">订单号 ${(res.order && res.order.id) || '-'}</div>
      <div style="margin-top:16px"><button class="btn primary" data-close type="button">完成</button></div>`;
    layer().querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
    app.refreshLobby();
    if (done) done(res);
  };

  setTimeout(advance, 500);
}

/* ===================================================================== */
/*                                 签到                                  */
/* ===================================================================== */
export function openSignIn(app) {
  const st = app.economy.signInState();
  const days = st.rewards.map((reward, idx) => {
    const dayNo = idx + 1;
    const done = st.signedToday ? dayNo <= st.dayIndex : dayNo < st.dayIndex;
    const today = !st.signedToday && dayNo === st.dayIndex;
    const cls = ['signin-day'];
    if (done) cls.push('is-done');
    if (today) cls.push('is-today');
    return `<div class="${cls.join(' ')}">
      ${done ? '<span class="sd-check">✓</span>' : ''}
      <div class="sd-title">第 ${dayNo} 天</div>
      <div class="sd-beans">${reward.toLocaleString()}</div>
    </div>`;
  }).join('');

  // 连续签到 8 天额外赠送称号「劳模」（拿到就永久拥有）
  const labor = titleById('t_labor') || { name: '劳模', days: 8, color: ['#ffd6a5', '#ff8f3f'] };
  const laborOwned = isTitleUnlocked(app.save, 't_labor');
  const laborDays = labor ? Math.min(st.streak, labor.days) : 0;
  const laborNote = laborOwned
    ? '已获得「劳模」称号，去左上角称号里佩戴'
    : `再连续签到 <b style="color:var(--gold)">${labor.days - laborDays}</b> 天就能拿到（断签从第 1 天重算）`;

  openDrawer(drawerShell('每日签到', `
    <p class="center-note" style="margin-top:0">连续签到奖励递增，断签会从第 1 天重新开始（以本地时间 00:00 为界）。</p>
    <div class="signin-grid">${days}</div>
    <div class="signin-labor ${laborOwned ? 'is-owned' : ''}">
      <span class="title-badge" style="background:${titleGradient(labor)}">${labor.name}</span>
      <span class="sl-text">连续签到 ${laborDays}/${labor.days} 天 · ${laborNote}</span>
    </div>
    <div class="signin-foot">
      <span style="font-size:13px;color:var(--ink-soft)">已连续签到 <b style="color:var(--gold)">${st.signedToday ? st.streak : st.streak - 1 < 0 ? 0 : st.streak - 1}</b> 天</span>
      <button class="btn primary" id="btn-do-signin" type="button" ${st.signedToday ? 'disabled' : ''}>
        ${st.signedToday ? '今天已签到' : `签到领 💰${st.reward.toLocaleString()}`}
      </button>
    </div>
  `));

  const btn = document.getElementById('btn-do-signin');
  if (btn && !st.signedToday) {
    btn.addEventListener('click', () => {
      const res = app.economy.signIn();
      if (!res.ok) return toast(res.error, 'bad');
      audio.play('coin');
      toast(`签到成功 💰 +${res.reward.toLocaleString()}`, 'gold');
      app.refreshLobby();
      closePanel();
      setTimeout(() => openSignIn(app), 220);
    });
  }
}

/* ===================================================================== */
/*                                 设置                                  */
/* ===================================================================== */
export function openSettings(app) {
  const s = app.save.settings;
  const speedChips = ['slow', 'normal', 'fast', 'off'].map((k) => {
    const label = { slow: '慢', normal: '标准', fast: '快', off: '关闭' }[k];
    return `<button class="chip ${s.animSpeed === k ? 'is-active' : ''}" data-speed="${k}" type="button">${label}</button>`;
  }).join('');
  // 牌背、头像、头像框都搬到「我的形象」面板了（点大厅左上角头像进入），
  // 设置里只留系统设置 —— 入口唯一，不重复。

  openDrawer(drawerShell('设置', `
    <div class="set-row">
      <div class="set-label">BGM 音量<small>背景音乐</small></div>
      <div class="set-control"><input type="range" id="set-bgm" min="0" max="100" value="${s.bgmVolume}" /></div>
    </div>
    <div class="set-row">
      <div class="set-label">音效音量<small>出牌 / 炸弹 / 到账</small></div>
      <div class="set-control"><input type="range" id="set-sfx" min="0" max="100" value="${s.sfxVolume}" /></div>
    </div>
    <div class="set-row">
      <div class="set-label">动画速度<small>影响发牌、出牌与结算演出</small></div>
      <div class="set-control chip-group" id="set-speed">${speedChips}</div>
    </div>
    <div class="set-row">
      <div class="set-label">牌面使用 PNG 贴图<small>默认用 emoji 渲染；放入自己的牌面美术后再打开</small></div>
      <div class="set-control chip-group" id="set-tex">
        <button class="chip ${s.useTextures ? 'is-active' : ''}" data-tex="1" type="button">贴图</button>
        <button class="chip ${!s.useTextures ? 'is-active' : ''}" data-tex="0" type="button">矢量</button>
      </div>
    </div>
    <div class="set-row">
      <div class="set-label">大模型<small>仅 AI 模式使用，也可直接填其它模型名</small></div>
      <div class="set-control">
        <input type="text" id="set-model" list="model-list" value="${s.model}" style="min-width:170px" />
        <datalist id="model-list">
          <option value="deepseek-flash"></option>
          <option value="deepseek-chat"></option>
          <option value="deepseek-reasoner"></option>
        </datalist>
      </div>
    </div>
    <div class="set-row">
      <div class="set-label">思考模式<small>关闭后回复更快、更贴合出牌节奏（默认关闭）</small></div>
      <div class="set-control chip-group" id="set-thinking">
        <button class="chip ${!CONFIG.thinking ? 'is-active' : ''}" data-thinking="0" type="button">关闭</button>
        <button class="chip ${CONFIG.thinking ? 'is-active' : ''}" data-thinking="1" type="button">开启</button>
      </div>
    </div>
    <div class="set-row" style="flex-direction:column;align-items:stretch;gap:8px">
      <div class="set-label">DeepSeek API Key<small>存在本机存档里（不会进版本库），填一次以后都记得</small></div>
      <div class="key-now">当前：<b id="key-mask">${maskKey(CONFIG.apiKey)}</b><small>（中间用 ** 藏住了）</small></div>
      <div class="set-control" style="width:100%">
        <input type="password" id="set-key" value="${CONFIG.apiKey}" placeholder="粘贴新的 Key 覆盖（sk-…）" style="flex:1;min-width:0" />
        <button class="btn ghost" id="btn-toggle-key" type="button">👁 显示</button>
        <button class="btn ghost" id="btn-test-key" type="button">测试连通</button>
      </div>
      <div class="key-status" id="key-status"></div>
    </div>
    <div class="set-row">
      <div class="set-label">重置存档<small>清空豆子、签到与设置，重新发放新手豆</small></div>
      <div class="set-control"><button class="btn danger" id="btn-reset-save" type="button">重置</button></div>
    </div>
  `));

  const el = layer();
  el.querySelector('#set-bgm').addEventListener('input', (e) => {
    app.save.settings.bgmVolume = Number(e.target.value);
    audio.setVolumes({ bgm: app.save.settings.bgmVolume });
    app.persist('settings');
  });
  el.querySelector('#set-sfx').addEventListener('input', (e) => {
    app.save.settings.sfxVolume = Number(e.target.value);
    audio.setVolumes({ sfx: app.save.settings.sfxVolume });
    app.persist('settings');
    audio.play('select');
  });
  el.querySelectorAll('#set-speed .chip').forEach((chip) => chip.addEventListener('click', () => {
    app.save.settings.animSpeed = chip.dataset.speed;
    app.applySettings();
    app.persist('settings');
    el.querySelectorAll('#set-speed .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
  }));
  el.querySelectorAll('#set-tex .chip').forEach((chip) => chip.addEventListener('click', () => {
    app.save.settings.useTextures = chip.dataset.tex === '1';
    setTextureEnabled(app.save.settings.useTextures);
    app.persist('settings');
    el.querySelectorAll('#set-tex .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    toast(app.save.settings.useTextures ? '已切换为 PNG 贴图' : '已切换为矢量绘制');
  }));
  el.querySelector('#set-model').addEventListener('change', (e) => {
    const model = e.target.value.trim() || 'deepseek-flash';
    app.save.settings.model = model;
    CONFIG.model = model;
    app.persist('settings');
    toast(`模型已切换为 ${model}`);
  });
  el.querySelectorAll('#set-thinking .chip').forEach((chip) => chip.addEventListener('click', () => {
    CONFIG.thinking = chip.dataset.thinking === '1';
    app.save.settings.thinking = CONFIG.thinking;
    app.persist('settings');
    el.querySelectorAll('#set-thinking .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    toast(CONFIG.thinking ? '已开启思考模式（回复会变慢）' : '已关闭思考模式');
  }));
  /** Key 的显示/隐藏 + 中间打码（发出去的永远是完整 Key，这里只管显示） */
  const keyInput = el.querySelector('#set-key');
  const keyMask = el.querySelector('#key-mask');
  el.querySelector('#btn-toggle-key').addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    el.querySelector('#btn-toggle-key').textContent = show ? '🙈 隐藏' : '👁 显示';
  });
  const refreshKeyMask = () => { keyMask.textContent = maskKey(CONFIG.apiKey); };
  /**
   * ★ 把 Key 落进**存档**（用户拍板）：存 localStorage + save/ddz_save.json，
   *   这两个地方都被 .gitignore 排除（见 save/*），所以
   *   "仓库里不出现 Key" 和 "本机填一次就够" 可以同时成立。
   *   读到 CONFIG 的优先级见 app.js 的 applySettings：存档有就用存档，没有才用源码默认值。
   */
  const saveKey = (silent = false) => {
    const key = keyInput.value.trim();
    if (key === app.save.settings.apiKey) { CONFIG.apiKey = key || CONFIG.apiKey; return; }
    CONFIG.apiKey = key || CONFIG.apiKey;
    app.save.settings.apiKey = key;
    app.persist('settings');
    refreshKeyMask();
    if (!silent) toast(key ? '已保存 Key（存在本机存档里）' : '已清空存档里的 Key', key ? 'good' : 'bad');
  };
  keyInput.addEventListener('change', () => saveKey());
  el.querySelector('#btn-test-key').addEventListener('click', async () => {
    const status = el.querySelector('#key-status');
    // 点"测试连通"就等于确认要用这个 Key：先落进存档，不然一刷新又没了
    saveKey(true);
    status.className = 'key-status';
    status.textContent = '正在测试连通性…';
    const res = await app.chat.testConnection();
    if (res.ok) {
      status.className = 'key-status ok';
      status.textContent = `连通正常（${res.ms}ms）：${res.text}`;
    } else {
      status.className = 'key-status bad';
      status.textContent = `连接失败：${res.error}（将使用本地语气兜底，游戏照常可玩）`;
    }
  });
  el.querySelector('#btn-reset-save').addEventListener('click', async () => {
    const yes = await confirmDialog('重置存档', `将清空豆子、签到、设置与战绩，并重新发放 ${ECON.newPlayerBeans.toLocaleString()} 新手豆（性别和姓名要重新设一次）。确定继续？`, '确定重置');
    if (!yes) return;
    app.resetSave();
    closePanel();
    toast('存档已重置，已补发新手豆', 'good');
  });
}

/* ===================================================================== */
/*                                 聊天                                  */
/* ===================================================================== */
export function openChat(app) {
  const quick = QUICK_PHRASES.map((p) => `<button class="chip" data-phrase="${p}" type="button">${p}</button>`).join('');
  openDrawer(drawerShell('聊天', `
    <div class="chat-drawer">
      <div class="chat-log" id="chat-log"></div>
      <div class="quick-phrases">${quick}</div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" maxlength="${CONFIG.chatMaxChars}" placeholder="说点什么…（最多 ${CONFIG.chatMaxChars} 字）" />
        <button class="icon-btn ico-mic mic-btn" id="btn-mic" title="语音输入" type="button"></button>
        <button class="btn primary" id="btn-send" type="button">发送</button>
      </div>
      <div class="tool-row">
        <span>鲜花 / 鸡蛋每局各 ${CONFIG.toolPerHand} 次，仅表达情绪、不影响出牌</span>
        <!-- ★ 数字取"本局还剩几次"：以前这里写的是 app.tools.flowerLeft，
             app.tools 根本不存在 → 一开聊天面板就 TypeError（面板打不开） -->
        <span><button class="chip" id="btn-flower-panel" type="button">🌸 鲜花 ${app.toolLeft('flower')}</button>
        <button class="chip" id="btn-egg-panel" type="button">🥚 鸡蛋 ${app.toolLeft('egg')}</button></span>
      </div>
    </div>
  `));

  const log = document.getElementById('chat-log');
  const render = () => {
    log.innerHTML = app.chatLog.slice(-60).map((m) => `
      <div class="chat-msg ${m.kind}">
        ${m.who ? `<span class="cm-who">${m.who}</span>` : ''}${m.emoji ? `<span class="bubble-emoji">${m.emoji}</span>` : ''}${m.text}
      </div>`).join('');
    log.scrollTop = log.scrollHeight;
  };
  render();
  app.chatRenderers.add(render);
  onCloseHook = () => app.chatRenderers.delete(render);

  const input = document.getElementById('chat-input');
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    app.sendHumanChat(text);
  };
  document.getElementById('btn-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  log.parentElement.querySelectorAll('[data-phrase]').forEach((b) => b.addEventListener('click', () => app.sendHumanChat(b.dataset.phrase)));
  document.getElementById('btn-flower-panel').addEventListener('click', () => { app.sendTool('flower'); render(); });
  document.getElementById('btn-egg-panel').addEventListener('click', () => { app.sendTool('egg'); render(); });

  /* 语音输入（PRD §2.7 / Q10：不可用时隐藏入口；点一下进入持续收音模式） */
  const micBtn = document.getElementById('btn-mic');
  if (!voice.supported) {
    micBtn.style.display = 'none';
  } else {
    micBtn.addEventListener('click', () => {
      if (voice.live) { voice.stop(); return; }
      const ok = voice.start({
        onText: (text) => {
          const t = String(text).trim().slice(0, CONFIG.chatMaxChars);
          if (!t) return;
          // 说完直接发出去：不落在输入框里，也不再弹"已发送"提示
          input.value = '';
          app.sendHumanChat(t);
          render();
        },
        onState: (live, reason) => {
          voice.applyButtonState(micBtn, live);
          if (!live) input.value = '';
          if (reason === 'not-allowed' || reason === 'service-not-allowed') toast('麦克风被拒绝，请改用文字输入', 'bad');
        },
      });
      if (!ok) toast('语音输入启动失败，请改用手动输入', 'bad');
    });
  }
}

/* ===================================================================== */
/*                                 结算                                  */
/* ===================================================================== */
export function showResult(app, result, room, { onAgain, onQuit }) {
  const humanWin = (result.landlordSeat === 0) === result.landlordWin;
  const role = result.landlordSeat === 0 ? '地主' : '农民';
  const names = app.seatNames;
  const avatars = app.seatAvatars;

  const factors = result.factors.length
    ? result.factors.map((f) => `<span>${f.label}</span>`).join('')
    : '<span>基础倍数 ×1</span>';

  const caps = [];
  if (result.spring) caps.push('春天 ×2');
  if (result.antiSpring) caps.push('反春 ×2');
  if (result.bombs) caps.push(`炸弹 ×2^${result.bombs}`);
  if (result.rockets) caps.push(`王炸 ×2^${result.rockets}`);
  if (result.robs) caps.push(`抢地主 ×2^${result.robs}`);

  // 本局对手：可以顺手加好友（AI 模式下才有）
  const opponents = (app.seatPersonas || []).filter(Boolean);
  /**
   * ★ 用户拍板：**加好友与收益变动合并到同一行**，不再单独占一块。
   *   所以按钮直接挂在对手那一行的收益后面；已经是好友就什么都不显示。
   */
  const addBtnOf = (persona) => (isFriendAlready(app.save, persona.id)
    ? ''
    : `<button class="btn primary mini-add" data-add-friend="${persona.id}" type="button">加好友</button>`);
  const seatPersona = (seat) => (app.aiEnabled && seat > 0 ? (app.seatPersonas || [])[seat - 1] : null);

  const rows = [0, 1, 2].map((seat) => {
    const d = result.deltas[seat];
    const cls = d > 0 ? 'plus' : d < 0 ? 'minus' : '';
    const sign = d > 0 ? '+' : '';
    const persona = seatPersona(seat);
    return `<div class="result-row ${seat === 0 ? 'is-me' : ''}">
      <span class="rr-who"><img src="${ASSETS.avatar(avatars[seat])}" alt="" />${names[seat]}${seat === result.landlordSeat ? ' <b style="color:var(--gold)">地主</b>' : ''}</span>
      <span style="color:var(--ink-faint);font-size:12px">💰${result.beansBefore[seat].toLocaleString()}</span>
      <span class="rr-delta ${cls}">${sign}${d.toLocaleString()}</span>
      ${persona ? addBtnOf(persona) : ''}
    </div>`;
  }).join('');

  openDrawer(`
    <div class="drawer result-drawer">
      <div class="drawer-head">
        <h3 class="drawer-title">本局结算</h3>
        <button class="drawer-close" data-close type="button">✕</button>
      </div>
      <div class="result-banner ${humanWin ? '' : 'lose'}">${humanWin ? '胜 利' : '失 败'}</div>
      <div class="result-sub">你是${role} · 底分 ${room.base} · 封顶 💰${room.cap.toLocaleString()}</div>
      <div class="result-multi">
        <span style="font-size:12px;color:var(--ink-faint)">倍数</span>
        <span class="rm-value">×${result.multiplier}</span>
      </div>
      <div class="result-factors">${factors}</div>
      <div class="result-rows">${rows}</div>
      <div class="result-beans">当前身家 <b>💰 ${result.beansAfter[0].toLocaleString()}</b></div>
      <div class="result-cap">
        ${caps.length ? `本局加成：${caps.join('、')}` : ''}
      </div>
      <div class="result-actions">
        <button class="btn primary" id="btn-again" type="button">再来一场</button>
        <button class="btn ghost" id="btn-back-lobby" type="button">返回大厅</button>
      </div>
    </div>
  `, { onClose: onQuit });

  // 加好友：和牌桌外一样，加完对方会主动打个招呼
  layer().querySelectorAll('[data-add-friend]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const persona = opponents.find((p) => p.id === btn.dataset.addFriend);
      if (!persona) return;
      // 从**结算面板**加的：你们刚一起打完，把它陪你打的那几局补进记忆（fromMatch）
      void requestFriend({
        app,
        persona: persona,
        host: layer(),
        fromMatch: true,
        onPending: () => { btn.disabled = true; btn.textContent = '等待通过…'; },
        onAdded: () => { btn.outerHTML = '<span class="fr-added">已是好友</span>'; },
      });
    });
  });

  document.getElementById('btn-again').addEventListener('click', () => { closePanel(); onAgain && onAgain(); });
  document.getElementById('btn-back-lobby').addEventListener('click', () => { closePanel(); onQuit && onQuit(); });
}

/* ===================================================================== */
/*                          小猫钓鱼结算                                  */
/* ===================================================================== */
/**
 * 小猫钓鱼一局结束的结算页（PRD §2.11）
 *  - 显示鱼篓比分 / 差距 / 倍数 / 本局输赢 / 当前身家
 *  - 可以加好友（对手就是这一局的 AI，人设相同）、再来一局、返回主界面
 *  - 豆子在这一局结束时就已经结算，这里只做展示
 */
export function showFishingResult(app, {
  pay, score, multiplier, room, persona, wins = 0, losses = 0, onAgain, onQuit,
}) {
  const kind = pay.kind; // win | lose | draw
  const head = kind === 'win' ? '你赢了' : kind === 'lose' ? '你输了' : '平局';
  const diff = pay.diff;
  const gap = diff === 0 ? '五五开' : `差 ${diff > 0 ? '+' : ''}${diff} 张`;
  const money = pay.delta === 0
    ? '<span class="fr-money is-draw">不输不赢</span>'
    : `<span class="fr-money ${pay.delta > 0 ? 'is-win' : 'is-lose'}">${pay.delta > 0 ? '+' : '-'}💰${Math.abs(pay.delta).toLocaleString()}</span>`;

  const isFriend = persona ? isFriendAlready(app.save, persona.id) : true;
  // ★ 用户拍板：加好友不再单独占一行 —— 直接并进上面那行收益里（见模板里的 fr-money-row）

  openDrawer(`
    <div class="drawer result-drawer">
      <div class="drawer-head">
        <h3 class="drawer-title">本局结算</h3>
        <button class="drawer-close" data-close type="button">✕</button>
      </div>
      <div class="result-banner ${kind === 'win' ? '' : 'lose'}">${kind === 'draw' ? '平 局' : (kind === 'win' ? '胜 利' : '失 败')}</div>
      <div class="result-sub">${room.name} · 鱼篓 ${score[0]} : ${score[1]}（${gap}）</div>
      <div class="result-multi">
        <span style="font-size:12px;color:var(--ink-faint)">本局倍数</span>
        <span class="rm-value">×${multiplier || 1}</span>
        <span style="font-size:11.5px;color:var(--ink-faint);margin-left:auto">
          ${score[0] > score[1] ? '你的鱼篓更多' : score[0] < score[1] ? '对手鱼篓更多' : '两边一样多'}
        </span>
      </div>
      <div class="fr-money-row">${money}${isFriend
    ? ''
    : '<button class="btn primary mini-add" id="fr-add-friend" type="button">加好友</button>'}</div>
      <div class="result-beans">当前身家 <b>💰 ${app.save.beans.toLocaleString()}</b></div>
      <div class="result-cap">本次共 ${wins} 胜 ${losses} 负。<br>差距越大赔率越陡，倍数按一次钓到大鱼翻倍。</div>
      <div class="result-actions">
        <button class="btn primary" id="fr-again" type="button">再来一局</button>
        <button class="btn ghost" id="fr-quit" type="button">返回主界面</button>
      </div>
    </div>
  `);

  const el = layer();
  const addBtn = el.querySelector('#fr-add-friend');
  if (addBtn && persona) {
    addBtn.addEventListener('click', () => {
      // 从**结算面板**加的：你们刚一起打完，把它陪你打的那几局补进记忆（fromMatch）
      // 流程和好友面板一致：编辑申请 → 延迟 1~5 秒通过 → 我发申请 + TA 回这条
      void requestFriend({
        app,
        persona,
        host: el,
        fromMatch: true,
        onPending: () => { addBtn.disabled = true; addBtn.textContent = '等待通过…'; },
        onAdded: () => { addBtn.outerHTML = '<span class="fr-added">已是好友</span>'; },
      });
    });
  }
  el.querySelector('#fr-again').addEventListener('click', () => { closePanel(); onAgain && onAgain(); });
  el.querySelector('#fr-quit').addEventListener('click', () => { closePanel(); onQuit && onQuit(); });
}

/**
 * 五子棋本局结算（用户拍板：**不涉及豆子**，只说输赢、手数和好感度）
 * 样式与钓鱼那份保持一致：胜负横幅 + 对手信息 + 加好友 + 再来一局/返回。
 */
export function showGomokuResult(app, {
  winner, moves, room, persona, playerFirst = true, wins = 0, losses = 0, affinity = 0, onAgain, onQuit,
}) {
  const kind = winner === 'player' ? 'win' : winner === 'draw' ? 'draw' : 'lose';
  const head = kind === 'win' ? '你赢了' : kind === 'draw' ? '平局' : '你输了';
  const isFriend = persona ? isFriendAlready(app.save, persona.id) : true;
  // ★ 用户拍板：加好友不单独占一行 —— 并进下面那行"结果"里（见模板里的 fr-money-row）

  openDrawer(`
    <div class="drawer result-drawer">
      <div class="drawer-head">
        <h3 class="drawer-title">本局结算</h3>
        <button class="drawer-close" data-close type="button">✕</button>
      </div>
      <div class="result-banner ${kind === 'win' ? '' : 'lose'}">${kind === 'draw' ? '平 局' : (kind === 'win' ? '胜 利' : '失 败')}</div>
      <div class="result-sub">${room.name} · 五子棋 · 共 ${moves} 手（${playerFirst ? '你执黑先手' : '对手执黑先手'}）</div>
      <div class="result-multi">
        <span style="font-size:12px;color:var(--ink-faint)">结果</span>
        <span class="rm-value">${kind === 'draw' ? '五五开' : (kind === 'win' ? '五子连珠' : '被连成五子')}</span>
        <span style="font-size:11.5px;color:var(--ink-faint);margin-left:auto">这局不涉及开心豆</span>
      </div>
      <div class="fr-money-row"><span class="fr-money is-draw">不输不赢 💰0</span>${isFriend
    ? ''
    : '<button class="btn primary mini-add" id="gr-add-friend" type="button">加好友</button>'}</div>
      <div class="result-cap">本次共 ${wins} 胜 ${losses} 负。<br>五子棋只影响好友好感度，不结算开心豆。</div>
      <div class="result-actions">
        <button class="btn primary" id="gr-again" type="button">再来一局</button>
        <button class="btn ghost" id="gr-quit" type="button">返回主界面</button>
      </div>
    </div>
  `);

  const el = layer();
  const addBtn = el.querySelector('#gr-add-friend');
  if (addBtn && persona) {
    addBtn.addEventListener('click', () => {
      void requestFriend({
        app,
        persona: persona,
        host: layer(),
        fromMatch: true,
        onPending: () => { addBtn.disabled = true; addBtn.textContent = '等待通过…'; },
        onAdded: () => { addBtn.outerHTML = '<span class="fr-added">已是好友</span>'; },
      });
    });
  }
  el.querySelector('#gr-again').addEventListener('click', () => { closePanel(); onAgain && onAgain(); });
  el.querySelector('#gr-quit').addEventListener('click', () => { closePanel(); onQuit && onQuit(); });
  void head;
}

/* ===================================================================== */
/*                              称号                                     */
/* ===================================================================== */
export function openTitles(app) {
  const list = titleList(app.save);
  const beansTitles = list.filter((t) => t.kind === 'beans');
  const signTitles = list.filter((t) => t.kind === 'signin');
  // 商城称号只在商城里卖：这里只展示**已经买到**的（没解锁的不占地方）
  const shopOwned = list.filter((t) => t.kind === 'shop' && t.unlocked);
  const shopLockedCount = list.filter((t) => t.kind === 'shop' && !t.unlocked).length;
  const cur = equippedTitle(app.save);

  const card = (t) => {
    const cls = ['title-card'];
    if (!t.unlocked) cls.push('is-locked');
    if (t.equipped) cls.push('is-equipped');
    let foot = '';
    if (t.equipped) {
      foot = `<span class="tc-state">佩戴中</span><button class="tc-btn ghost" data-unequip type="button">卸下</button>`;
    } else if (t.unlocked) {
      foot = `<span class="tc-state">已拥有</span><button class="tc-btn" data-equip="${t.id}" type="button">佩戴</button>`;
    } else if (t.kind === 'signin') {
      foot = `<span class="tc-state">连续签到 ${t.progress}/${t.days} 天</span>`;
    } else {
      foot = `<span class="tc-state">需要身家 💰${t.beans.toLocaleString()}</span>`;
    }
    const tag = t.kind === 'shop' ? ' · 商城称号' : (t.kind === 'signin' ? ' · 签到赠送' : '');
    return `<div class="${cls.join(' ')}">
      <div class="tc-head">
        <span class="title-badge large" style="background:${titleGradient(t)}">${t.name}</span>
      </div>
      <div class="tc-desc">${t.desc}${tag}</div>
      <div class="tc-foot">${foot}</div>
    </div>`;
  };

  openDrawer(drawerShell('我的称号', `
    <div class="title-current">
      <span>当前佩戴</span>
      ${cur ? `<span class="title-badge large" style="background:${titleGradient(cur)}">${cur.name}</span>` : '<span class="tc-state">（未佩戴）</span>'}
      <span style="margin-left:auto;font-size:12px;color:var(--ink-faint)">身家 💰${app.save.beans.toLocaleString()}</span>
    </div>
    <div class="title-section">按身家自动解锁</div>
    <div class="title-grid">${beansTitles.map(card).join('')}</div>
    <div class="title-section" style="margin-top:16px">连续签到赠送</div>
    <div class="title-grid">${signTitles.map(card).join('')}</div>
    <div class="title-section" style="margin-top:16px">商城称号</div>
    ${shopOwned.length
    ? `<div class="title-grid">${shopOwned.map(card).join('')}</div>`
    : '<p class="center-note" style="font-size:12.5px">还没有商城称号。</p>'}
    ${shopLockedCount
    ? `<p class="center-note" style="font-size:12px;margin-top:8px">商城里还有 <b style="color:var(--gold)">${shopLockedCount}</b> 个称号可以买 → 底部「商城」的「🏅 称号」分类</p>`
    : ''}
  `));

  const el = layer();
  el.querySelectorAll('[data-equip]').forEach((btn) => btn.addEventListener('click', () => {
    const res = equipTitle(app.save, btn.dataset.equip);
    if (!res.ok) return toast(res.error, 'bad');
    app.persist('title');
    app.refreshTitles();
    toast('称号已佩戴');
    closePanel();
    setTimeout(() => openTitles(app), 180);
  }));
  el.querySelectorAll('[data-unequip]').forEach((btn) => btn.addEventListener('click', () => {
    equipTitle(app.save, '');
    app.persist('title');
    app.refreshTitles();
    toast('已卸下称号');
    closePanel();
    setTimeout(() => openTitles(app), 180);
  }));
}

/* ===================================================================== */
/*                              改名                                     */
/* ===================================================================== */
export function openRename(app) {
  const cards = renameCardCount(app.save);
  if (cards <= 0) {
    // 改名卡是花钱买的：没卡就去商城 · 装扮
    openDrawer(drawerShell('修改昵称', `
      <p class="center-note" style="margin:6px 0 18px">
        改名需要一张 <b>${RENAME_CARD.emoji} ${RENAME_CARD.name}</b>，你现在有 <b style="color:var(--gold)">0</b> 张。
      </p>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn ghost" data-close type="button">算了</button>
        <button class="btn primary" id="rename-go-shop" type="button">去商城买（💰 ${RENAME_CARD.price.toLocaleString()}）</button>
      </div>
    `));
    const go = document.getElementById('rename-go-shop');
    if (go) go.addEventListener('click', () => { closePanel(); setTimeout(() => openShop(app), 180); });
    return;
  }
  const suggestions = Array.from({ length: 4 }, () => randomNickname());
  openDrawer(drawerShell('修改昵称', `
    <p class="center-note" style="margin-top:0">昵称会显示在牌桌上，最多 12 个字。本次改名会消耗 1 张 ${RENAME_CARD.name}（持有 ${cards} 张）。</p>
    <div class="set-row" style="border:none;flex-direction:column;align-items:stretch;gap:10px">
      <input type="text" id="rename-input" maxlength="12" value="${app.playerName}" />
      <div class="chip-group" id="rename-suggest">
        ${suggestions.map((n) => `<button class="chip" data-nick="${n}" type="button">${n}</button>`).join('')}
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:8px">
      <button class="btn ghost" data-close type="button">取消</button>
      <button class="btn primary" id="rename-ok" type="button">保存（用 1 张改名卡）</button>
    </div>
  `));
  const input = document.getElementById('rename-input');
  const el = layer();
  el.querySelectorAll('#rename-suggest [data-nick]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.nick; }));
  const save = () => {
    const name = input.value.trim().slice(0, 12) || app.playerName;
    if (name === app.playerName) { closePanel(); return; }
    if (!useRenameCard(app.save)) return toast(`没有${RENAME_CARD.name}了，去商城 · 装扮买一张`, 'bad');
    const before = app.playerName;
    app.save.nickname = name;
    /**
     * ★ 用户拍板：改名后要**同步更新所有 AI 的知识** —— 否则它还按旧名字叫你。
     *   每位好友写一条「改名：玩家把昵称从「旧」改成「新」」，且只保留最近 1 条。
     */
    const synced = syncPlayerRename(app.save, before, name);
    app.persist('rename');
    app.refreshLobby();
    closePanel();
    toast(`昵称已改为「${name}」（还剩 ${renameCardCount(app.save)} 张改名卡）`);
    if (synced.updated) setTimeout(() => toast(`${synced.updated} 位好友已经知道你改名了`, 'good'), 700);
  };
  document.getElementById('rename-ok').addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

/* ===================================================================== */
/*                              通用确认框                                */
/* ===================================================================== */
export function confirmDialog(title, text, okText = '确定') {
  return new Promise((resolve) => {
    openDrawer(drawerShell(title, `
      <p class="center-note" style="margin:6px 0 20px">${text}</p>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn ghost" id="cf-no" type="button">取消</button>
        <button class="btn primary" id="cf-yes" type="button">${okText}</button>
      </div>
    `));
    document.getElementById('cf-yes').addEventListener('click', () => { closePanel(); resolve(true); });
    document.getElementById('cf-no').addEventListener('click', () => { closePanel(); resolve(false); });
    layer().querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

void DEFAULT_SETTINGS;
void ROOMS;
