/**
 * 牌桌控制器（PRD §5-Q1/Q4/Q6、§7.2~§7.5）
 * 驱动 抢地主 → 出牌 → 结算 的整个流程；人类玩家的输入与倒计时在这里处理
 */
import { Game, PHASE } from '../game/engine.js';
import { findPlays, analyze, canBeat } from '../core/rules.js';
import { formatBeans } from '../core/settle.js';
import { handToString } from '../core/cards.js';
import { CONFIG } from '../config.js';
import { ASSETS } from '../../assets/manifest.js';
import { playerAvatarSrc } from '../data/avatar.js';
import { createCard, createBack, renderPlayCards } from './cardsView.js';
import { voice } from './voice.js';
import { renderEquippedBadge } from './titles.js';
import { audio } from './audio.js';
import { fxBomb, fxBanner, floatText, handOverTip, toast } from './fx.js';
import { thinkDelay, THINK_MAX_MS } from '../core/bot.js';
import { isLover } from '../store/friends.js';

/** 这些状态文案代表"轮到玩家操作"，状态条会描金边发光（稍微醒目一点） */
const TURN_STATUS_RE = /^(轮到你|选好了|请出牌|该你)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RING = 119.4;

export class TableController {
  constructor(app, game, opts = {}) {
    this.app = app;
    this.game = game;
    this.alive = true;
    this.running = false;
    this.pending = null;
    this.selected = new Set();
    this.hintList = [];
    this.hintIndex = 0;
    this.lastActivity = Date.now();
    this.bindDom();
    this.buildSeats();
    game.onEvent = (type, payload) => this.onEvent(type, payload);
    this.renderAll();
    this.startIdleWatcher();
    /**
     * ★ AI 房主邀请进来的房间：先不开始，等几秒再真正开局
     * （用户拍板：3~5 秒后自动开局，这期间玩家退出就不开局）
     */
    const delay = Number(opts.startDelayMs) || 0;
    if (delay > 0) {
      this.waitingStart = true;
      this.setStatus(opts.waitText || '房主正在发牌，马上开始…');
      this.startCountdown(Math.max(1, Math.round(delay / 1000)), () => {
        this.waitingStart = false;
        if (!this.alive) return;
        this.run();
      });
    } else {
      this.run();
    }
  }

  /* ------------------------------ DOM ------------------------------ */
  bindDom() {
    const $ = (id) => document.getElementById(id);
    this.dom = {
      roomPill: $('room-pill'),
      roundPill: $('round-pill'),
      multiValue: $('multi-value'),
      multiFactors: $('multi-factors'),
      beansPill: $('beans-pill'),
      bottomCards: $('bottom-cards'),
      bottomArea: $('bottom-area'),
      statusBar: $('status-bar'),
      play0: $('play-0'),
      play1: $('play-1'),
      play2: $('play-2'),
      handArea: $('hand-area'),
      btnPass: $('btn-pass'),
      btnHint: $('btn-hint'),
      btnReset: $('btn-reset'),
      btnPlay: $('btn-play'),
      actionRow: $('action-row'),
      quickInput: $('quick-input'),
      btnEmoji: $('btn-emoji'),
      btnMic: $('btn-mic'),
      emojiPop: $('emoji-pop'),
      bidBar: $('bid-bar'),
      bidHint: $('bid-hint'),
      btnBidYes: $('btn-bid-yes'),
      btnBidNo: $('btn-bid-no'),
      timer: $('turn-timer'),
      ringFg: $('ring-fg'),
      timerText: $('turn-timer-text'),
      meAvatar: $('me-avatar'),
      meCount: $('me-count'),
      meName: $('me-name'),
      meBeans: $('me-beans'),
      meLandlord: $('me-landlord'),
      bubble0: $('bubble-0'),
    };

    this.dom.roomPill.textContent = `${this.game.room.name} · 底分 ${this.game.room.base}`;
    this.dom.roundPill.textContent = `第 ${this.game.round} 局`;
    this.dom.meAvatar.src = playerAvatarSrc(this.app.save);
    this.dom.meName.textContent = this.app.seatNames[0];
    renderEquippedBadge(document.getElementById('me-title'), this.app.save);

    this.dom.btnPlay.addEventListener('click', () => this.humanPlay());
    this.dom.btnPass.addEventListener('click', () => this.humanPass());
    this.dom.btnHint.addEventListener('click', () => this.humanHint());
    this.dom.btnReset.addEventListener('click', () => { this.selected.clear(); this.renderHand(); audio.play('select'); });
    this.dom.btnBidYes.addEventListener('click', () => this.humanBid(true));
    this.dom.btnBidNo.addEventListener('click', () => this.humanBid(false));

    /* 右下角：快捷输入 + 表情/道具弹层 */
    this.dom.quickInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = this.dom.quickInput.value.trim();
      if (!text) return;
      this.dom.quickInput.value = '';
      this.app.sendHumanChat(text);
    });
    this.dom.btnEmoji.addEventListener('click', (e) => {
      e.stopPropagation();
      this.updateToolCounts();
      this.dom.emojiPop.hidden = !this.dom.emojiPop.hidden;
    });
    this.dom.emojiPop.addEventListener('click', (e) => {
      const tool = e.target.closest('[data-tool]');
      if (tool) { this.app.sendTool(tool.dataset.tool); this.updateToolCounts(); this.dom.emojiPop.hidden = true; return; }
      const emo = e.target.closest('[data-emoji]');
      if (emo) { this.app.sendHumanChat(emo.dataset.emoji); this.dom.emojiPop.hidden = true; return; }
      if (e.target.closest('#pop-open-chat')) { this.dom.emojiPop.hidden = true; this.app.openChat(); }
    });
    this.onDocClick = (e) => {
      if (!this.dom.emojiPop.hidden && !e.target.closest('#emoji-pop') && !e.target.closest('#btn-emoji')) {
        this.dom.emojiPop.hidden = true;
      }
    };
    document.addEventListener('click', this.onDocClick);
    this.updateToolCounts();

    /* 麦克风：点一下开麦，识别后直接发送 */
    if (this.dom.btnMic) {
      if (!voice.supported) this.dom.btnMic.hidden = true;
      this.dom.btnMic.addEventListener('click', () => this.toggleMic());
    }

    /* 手牌：点击切换单张 / 按住拖动连选 */
    this.bindHandDrag();

    this.onKey = (e) => {
      if (!this.app.isTableActive()) return;
      if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); this.humanPlay(); }
      else if (e.key === 'Escape') { this.selected.clear(); this.renderHand(); }
      else if (e.key === 'h' || e.key === 'H') this.humanHint();
      else if (e.key === 'p' || e.key === 'P') this.humanPass();
    };
    window.addEventListener('keydown', this.onKey);
  }

  buildSeats() {
    this.seats = {};
    for (const seat of [1, 2]) {
      const el = document.getElementById(`seat-${seat}`);
      el.innerHTML = `
        <div class="seat-avatar">
          <img alt="" />
          <span class="badge-landlord" hidden>地主</span>
          <span class="seat-count">17</span>
        </div>
        <div class="seat-name"></div>
        <div class="seat-beans"></div>
        <div class="seat-think" hidden>思考中<i></i><i></i><i></i></div>
        <div class="seat-cards"></div>
        <div class="bubble ${seat === 2 ? 'left' : 'right'}" hidden></div>`;
      const refs = {
        root: el,
        avatar: el.querySelector('.seat-avatar img'),
        landlord: el.querySelector('.badge-landlord'),
        count: el.querySelector('.seat-count'),
        name: el.querySelector('.seat-name'),
        beans: el.querySelector('.seat-beans'),
        think: el.querySelector('.seat-think'),
        cards: el.querySelector('.seat-cards'),
        bubble: el.querySelector('.bubble'),
      };
      refs.avatar.src = ASSETS.avatar(this.app.seatAvatars[seat]);
      /**
       * 座位名：恋人挂 💞（用户要求"恋人关系在哪都该看得见"）
       * 座位对应的 personaId 从这一局的人设里取（机器模式没有人设 → 不挂）
       */
      const personaId = this.game && this.game.personas && this.game.personas[seat]
        ? this.game.personas[seat].id : '';
      refs.name.innerHTML = `${this.app.seatNames[seat]}`
        + (personaId && isLover(this.app.save, personaId) ? '<span class="lover-badge" title="你俩是恋人">💞</span>' : '');
      refs.beans.textContent = `💰 ${formatBeans(this.game.beans[seat])}`;
      refs.cards.append(createBack('small', this.app.save.settings.cardBack));
      this.seats[seat] = refs;
    }
  }

  destroy() {
    this.alive = false;
    this.stopCountdown();
    // 解开正在等待的人类操作，避免循环挂在 await 上
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.settled = true;
      p.resolve();
    }
    this.hideBidBar();
    this.hideActionRow();
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
    window.removeEventListener('keydown', this.onKey);
    // 离开牌桌就别继续占着麦克风了
    if (voice.live) voice.stop();
  }

  updateToolCounts() {
    // 道具按"商城库存 + 本局上限"显示（PRD §2.2）
    for (const it of this.app.toolState()) {
      const el = document.getElementById(`tool-left-${it.id}`);
      if (el) el.textContent = String(it.left);
      const btn = document.getElementById(`tool-btn-${it.id}`);
      if (btn) btn.classList.toggle('is-empty', it.left <= 0);
    }
  }

  /* ------------------------------ 事件 ------------------------------ */
  onEvent(type, payload) {
    switch (type) {
      case 'hand:start':
        this.selected.clear();
        this.hintList = [];
        this.clearPlaySlots();
        if (this.app.urgentSaid) this.app.urgentSaid.clear();
        this.hideBidBar();
        this.hideActionRow();
        this.updateToolCounts();
        this.dom.roundPill.textContent = `第 ${this.game.round} 局`;
        this.renderBottom(true);
        this.renderHand(true);
        this.renderSeats();
        this.playSlotsReset();
        this.setStatus('正在发牌…');
        audio.play('deal');
        break;
      case 'phase':
        this.renderSeats();
        this.updateTurnVisual(payload.seat);
        break;
      case 'bid':
        this.showSpeech(payload.seat, payload.call ? '叫地主' : '不叫');
        audio.play(payload.call ? 'bid' : 'pass');
        break;
      case 'rob':
        this.showSpeech(payload.seat, payload.rob ? '抢地主！' : '不抢');
        audio.play(payload.rob ? 'rob' : 'pass');
        if (payload.rob) floatText('抢地主 ×2', '50%', '30%');
        break;
      case 'landlord':
        this.hideBidBar();
        this.showSpeech(payload.seat, '我是地主');
        this.renderBottom(false);
        this.renderSeats();
        this.renderHand();
        floatText(`${this.app.seatNames[payload.seat]} 当地主`, '50%', '26%');
        audio.play('bid');
        break;
      case 'play':
        this.hideBidBar();
        this.renderPlay(payload);
        this.renderSeats();
        this.renderHand();
        this.updateActionState();
        break;
      case 'multiplier':
        this.updateMultiplier(true);
        break;
      case 'redeal':
        toast('三家都不叫，重新发牌', 'gold');
        break;
      case 'over':
        this.handleOver(payload);
        break;
      default:
        break;
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */
  renderAll() {
    this.updateMultiplier(false);
    this.renderBottom(true);
    this.renderSeats();
    this.renderHand(true);
    this.dom.meBeans.textContent = `💰 ${this.game.beans[0].toLocaleString()}`;
    this.dom.beansPill.textContent = `💰 ${this.game.beans[0].toLocaleString()}`;
  }

  renderBottom(hidden) {
    const box = this.dom.bottomCards;
    box.innerHTML = '';
    const reveal = !hidden && this.game.landlordSeat !== null;
    for (const card of this.game.bottom) {
      box.append(reveal ? createCard(card, { size: 'small' }) : createBack('small', this.app.save.settings.cardBack));
    }
    // 叫抢阶段：正常大小展示在中间上方；地主确定（开局）后缩小贴到顶部
    if (this.dom.bottomArea) this.dom.bottomArea.classList.toggle('is-compact', reveal);
  }

  renderSeats() {
    for (const seat of [1, 2]) {
      const refs = this.seats[seat];
      const g = this.game;
      const isLandlord = g.landlordSeat === seat;
      refs.landlord.hidden = !isLandlord;
      refs.count.textContent = String(g.hands[seat].length);
      refs.count.classList.toggle('danger', g.hands[seat].length === 1);
      refs.beans.textContent = `💰 ${formatBeans(g.beans[seat])}`;
      refs.root.classList.toggle('is-turn', (g.phase === PHASE.PLAY || g.phase === PHASE.BID || g.phase === PHASE.ROB) && this.currentActor() === seat);
      refs.root.classList.toggle('is-pass', g.phase === PHASE.PLAY && this.lastActionWasPass(seat));
    }
    const meCount = this.game.hands[0].length;
    this.dom.meCount.textContent = String(meCount);
    this.dom.meLandlord.hidden = this.game.landlordSeat !== 0;
    document.getElementById('me').classList.toggle('landlord', this.game.landlordSeat === 0);
  }

  currentActor() {
    const g = this.game;
    if (g.phase === PHASE.BID) return g.currentBidder;
    if (g.phase === PHASE.ROB) return g.seatToAsk;
    if (g.phase === PHASE.PLAY) return g.turnSeat;
    return null;
  }

  lastActionWasPass(seat) {
    const last = this.game.history[this.game.history.length - 1];
    return !!last && last.seat === seat && !last.play;
  }

  /**
   * 轮到谁 + "思考中"气泡
   * @param {number} seat 轮到谁
   * @param {number} [holdMs] 气泡停留多久。默认取 thinkDelay 的上界（5 秒）——
   *   出牌延迟现在是 1~5 秒，气泡不能再固定 1.4 秒就消失（不然 AI 还在想、动画先没了）
   */
  updateTurnVisual(seat, holdMs) {
    const who = this.app.seatNames[seat] ?? SEAT_FALLBACK[seat];
    this.dom.meLandlord.hidden = this.game.landlordSeat !== 0;
    // 同一时间只有一个人在思考：先把两家的气泡都收掉
    for (const s of [1, 2]) if (this.seats[s]) this.seats[s].think.hidden = true;
    if (seat !== 0) {
      const refs = this.seats[seat];
      if (refs && (this.game.phase === PHASE.PLAY || this.game.phase === PHASE.BID || this.game.phase === PHASE.ROB)) {
        refs.think.hidden = false;
        setTimeout(() => { refs.think.hidden = true; }, holdMs ?? THINK_MAX_MS);
      }
    }
    this.setStatus(this.phaseText(seat, who));
  }

  phaseText(seat, who) {
    const g = this.game;
    if (g.phase === PHASE.BID) return seat === 0 ? '轮到你：叫地主还是不叫？' : `${who} 正在叫地主…`;
    if (g.phase === PHASE.ROB) return seat === 0 ? '轮到你：抢地主 / 反抢？' : `${who} 正在决定抢不抢…`;
    if (g.phase === PHASE.PLAY) {
      if (seat === 0) return g.mustPlay() ? '轮到你出牌（首出必须出牌）' : '轮到你出牌';
      return `${who} 正在出牌…`;
    }
    return '本局结束';
  }

  /** 状态条文案；"轮到你…"这类提示会描金边发光，稍微醒目一点 */
  setStatus(text, { turn } = {}) {
    this.dom.statusBar.textContent = text;
    const isTurn = turn !== undefined ? turn : TURN_STATUS_RE.test(String(text));
    this.dom.statusBar.classList.toggle('is-turn', !!isTurn);
  }

  updateMultiplier(bump) {
    const g = this.game;
    let mult = 1;
    const factors = [];
    const rob = g.landlordSeat === null ? 0 : g.robs;
    if (rob) { mult *= 2 ** rob; factors.push(`抢地主 ×${2 ** rob}`); }
    if (g.bombs) { mult *= 2 ** g.bombs; factors.push(`炸弹 ×${2 ** g.bombs}`); }
    if (g.rockets) { mult *= 2 ** g.rockets; factors.push(`王炸 ×${2 ** g.rockets}`); }
    this.dom.multiValue.textContent = String(mult);
    this.dom.multiFactors.innerHTML = factors.map((f) => `<span>${f}</span>`).join('');
    if (bump) {
      this.dom.multiValue.classList.remove('bump');
      void this.dom.multiValue.offsetWidth;
      this.dom.multiValue.classList.add('bump');
    }
  }

  renderHand(dealing = false) {
    const area = this.dom.handArea;
    area.innerHTML = '';
    const hand = this.game.hands[0];
    const width = area.clientWidth || 720;
    const step = Math.max(24, Math.min(64, (width - 110) / Math.max(1, hand.length - 1)));
    area.style.setProperty('--overlap', `${step - 92}px`);
    area.classList.toggle('dealing', !!dealing);
    hand.forEach((card, idx) => {
      const el = createCard(card, { selected: this.selected.has(card.id) });
      if (dealing) el.style.animationDelay = `${idx * 28}ms`;
      area.append(el);
    });
    this.updateActionState();
  }

  /* ------------------------------ 选牌：点击切换 / 按住拖动连选 ------------------------------ */
  /**
   * 选牌手感要点：
   *  1) **按下就亮**（不等抬起），所以 pointerdown 里立刻切换这一张；
   *     真拖动时再把「锚点→当前」整段刷成同一个状态
   *  2) **任何回合都能选牌**（含别人的回合提前选好），只是轮到别家时不显示出牌按钮
   *  3) 音效只在按下与抬起时响，拖动过程中不响（以前每移过一张牌就响一次，又吵又卡）
   */
  bindHandDrag() {
    const area = this.dom.handArea;
    area.addEventListener('pointerdown', (e) => {
      if (!this.canSelectCards()) return;
      const cardEl = e.target.closest ? e.target.closest('.card') : null;
      if (!cardEl || cardEl.parentElement !== area) return;
      e.preventDefault();
      const id = Number(cardEl.dataset.id);
      const want = !this.selected.has(id);
      this.drag = {
        anchorId: id,
        anchorSelected: !want,
        want,
        moved: false,
        lastId: id,
        base: new Set(this.selected),
      };
      // 立刻给反馈
      this.applyDragRange(id, id, want);
      audio.play('select');
      window.addEventListener('pointermove', this.onDragMove, { passive: false });
      window.addEventListener('pointerup', this.onDragEnd, { once: true });
      window.addEventListener('pointercancel', this.onDragEnd, { once: true });
    });
  }

  /** 现在能不能选牌：牌局进行中都行（别人回合也能提前选），结束后不行 */
  canSelectCards() {
    const g = this.game;
    if (!g || !g.hands || !g.hands[0] || !g.hands[0].length) return false;
    return g.phase !== PHASE.OVER;
  }

  onDragMove = (e) => {
    const d = this.drag;
    if (!d) return;
    if (e.cancelable) e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cardEl = el && el.closest ? el.closest('.card') : null;
    if (!cardEl || cardEl.parentElement !== this.dom.handArea) return;
    const id = Number(cardEl.dataset.id);
    if (!d.moved) d.moved = true;
    if (d.lastId === id) return;
    d.lastId = id;
    this.applyDragRange(d.anchorId, id, d.want);
  };

  /** 把锚点到当前指针之间这一段牌，整段设为「选中」或「取消选中」 */
  applyDragRange(fromId, toId, want) {
    const ids = this.game.hands[0].map((c) => c.id);
    const a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    if (a < 0 || b < 0) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const next = new Set(this.drag ? this.drag.base : this.selected);
    for (let i = lo; i <= hi; i += 1) {
      if (want) next.add(ids[i]);
      else next.delete(ids[i]);
    }
    this.selected = next;
    this.syncHandSelection({ silent: true });
  }

  /** silent = 拖动过程中不播音效（只更新画面） */
  syncHandSelection({ silent = false } = {}) {
    this.dom.handArea.querySelectorAll('.card').forEach((el) => {
      el.classList.toggle('is-selected', this.selected.has(Number(el.dataset.id)));
    });
    this.updateActionState();
    if (!silent) audio.play('select');
  }

  onDragEnd = () => {
    const d = this.drag;
    this.drag = null;
    window.removeEventListener('pointermove', this.onDragMove);
    if (!d) return;
    // 按下时已经切好了，这里只需要收尾（拖动过的话再补一次音效）
    if (d.moved) audio.play('select');
  };

  /** 麦克风：点一下进入持续收音模式（说完立刻发出，再点一下结束） */
  toggleMic() {
    if (!voice.supported) { toast('当前浏览器不支持语音输入，请改用文字', 'bad'); return; }
    if (voice.live) { voice.stop(); return; }
    const ok = voice.start({
      onText: (text) => {
        const t = String(text).trim().slice(0, CONFIG.chatMaxChars);
        if (!t) return;
        // 直接发出去：不落在输入框里，也不再弹"已发送"提示
        this.app.sendHumanChat(t);
      },
      onState: (live, reason) => {
        this.setMicState(live);
        if (reason === 'not-allowed' || reason === 'service-not-allowed') toast('麦克风被拒绝，请改用文字输入', 'bad');
      },
    });
    if (!ok) toast('开麦失败，请检查麦克风权限', 'bad');
  }

  setMicState(live) {
    const el = this.dom.btnMic;
    if (!el) return;
    voice.applyButtonState(el, live);
    // 语音是"说完直接发"：输入框里不留草稿
    if (!live && this.dom.quickInput) this.dom.quickInput.value = '';
  }

  /** 出牌动画：从出牌者位置飞到出牌区（FLIP），一张张错开 */
  animatePlay(seat, slot) {
    const cards = [...slot.querySelectorAll('.card')];
    if (!cards.length) return;
    const origin = this.playOrigin(seat);
    cards.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const dx = origin.x - (r.left + r.width / 2);
      const dy = origin.y - (r.top + r.height / 2);
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px) scale(0.5) rotate(${seat === 0 ? -10 : 10}deg)`;
      el.style.opacity = '0';
      void el.offsetWidth;
      el.style.transition = `transform 320ms cubic-bezier(.2,.9,.25,1) ${i * 45}ms, opacity 200ms ease ${i * 45}ms`;
      el.style.transform = 'none';
      el.style.opacity = '1';
    });
  }

  playOrigin(seat) {
    if (seat === 0) {
      const r = this.dom.handArea.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.4 };
    }
    const refs = this.seats[seat];
    const r = refs.avatar.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  selectedCards() {
    return this.game.hands[0].filter((c) => this.selected.has(c.id));
  }

  updateActionState() {
    const g = this.game;
    const myTurn = !!this.pending && this.pending.kind === 'play' && g.canPlayAt(0);
    if (!myTurn) { this.dom.btnPlay.disabled = true; return; }
    const cards = this.selectedCards();
    const play = cards.length ? analyze(cards) : null;
    const ok = !!play && canBeat(play, g.lastPlay ? g.lastPlay.play : null);
    this.dom.btnPlay.disabled = !(myTurn && ok);
    this.dom.btnPass.disabled = !myTurn || g.mustPlay();
    this.dom.btnHint.disabled = !myTurn;
    this.dom.btnReset.disabled = !myTurn;
    if (myTurn && cards.length && play) {
      // 选牌反馈仍然属于"轮到玩家操作"，保持金边发光
      this.setStatus(ok ? '选好了，点「出牌」' : '这手牌管不上，换个组合吧', { turn: true });
    }
  }

  renderPlay(payload) {
    const slot = this.dom[`play${payload.seat}`];
    slot.innerHTML = '';
    if (!payload.play) {
      const tip = document.createElement('div');
      tip.className = 'pass-tip';
      tip.textContent = '不出';
      slot.append(tip);
      audio.play('pass');
      const seatName = this.app.seatNames[payload.seat];
      if (payload.seat !== 0) this.setStatus(`${seatName} 选择不出`);
      this.app.aiReact(payload.seat, 'pass', {});
      return;
    }
    renderPlayCards(slot, payload.play, 'mini');
    this.animatePlay(payload.seat, slot);

    const { type } = payload.play;
    const isBomb = type === 'bomb' || type === 'rocket';
    const big = payload.play.rank >= 15;
    const goodCombo = isBomb || payload.play.size >= 5
      || ['straight', 'straightPair', 'plane', 'plane1', 'plane2', 'four2single', 'four2pair', 'trio2'].includes(type);
    if (isBomb) {
      audio.play(type === 'rocket' ? 'rocket' : 'bomb');
      fxBomb();
      floatText(type === 'rocket' ? '王炸 ×2' : '炸弹 ×2', '50%', '40%');
      // 炸弹/王炸：桌上**每个 AI** 都要说一句，且按自己和出牌者的关系换口吻
      // （本人得意 / 同伙叫好 / 对手惊讶）——所以这里不走单人 aiReact
      this.app.aiEventSpeak('bomb', payload.seat, { isRocket: type === 'rocket' });
    } else {
      audio.play('play');
      this.app.aiReact(payload.seat, 'play', {
        big, rank: payload.play.rank, type, size: payload.play.size,
      });
    }
    // 玩家出的普通牌 / 长牌型，其他 AI 也可以有反应；
    // 炸弹已经由 aiEventSpeak 让所有人开过口了，再叫一次会重复
    if (payload.seat === 0 && !isBomb) this.app.aiReactToHuman({ big, goodCombo });
    if (payload.seat !== 0) this.setStatus(`${this.app.seatNames[payload.seat]} 出：${handToString(payload.play.cards)}`);
    this.lastActivity = Date.now();
  }

  clearPlaySlots() { this.playSlotsReset(); }

  playSlotsReset() {
    for (const seat of [0, 1, 2]) this.dom[`play${seat}`].innerHTML = '';
  }

  showSpeech(seat, text) {
    if (seat === 0) return;
    this.setStatus(`${this.app.seatNames[seat]}：${text}`);
  }

  /* ------------------------------ 倒计时 ------------------------------ */
  startCountdown(seconds, onTimeout) {
    this.stopCountdown();
    const total = seconds * 1000;
    const t0 = Date.now();
    this.dom.timer.hidden = false;
    const tick = () => {
      const left = Math.max(0, total - (Date.now() - t0));
      const ratio = left / total;
      this.dom.ringFg.style.strokeDashoffset = String(RING * (1 - ratio));
      this.dom.ringFg.style.stroke = ratio < 0.3 ? 'var(--red)' : 'var(--gold)';
      this.dom.timerText.textContent = String(Math.ceil(left / 1000));
      if (left <= 0) {
        this.stopCountdown();
        onTimeout();
        return;
      }
      this.countdownTimer = setTimeout(tick, 120);
    };
    tick();
  }

  stopCountdown() {
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    this.dom.timer.hidden = true;
  }

  /* ------------------------------ 主循环 ------------------------------ */
  /* 单一驱动：整个对局只有这一个循环在跑，杜绝重入导致的“同时抢地主又出牌 / 卡死” */
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.alive) {
        const g = this.game;
        if (g.phase === PHASE.OVER) break;
        if (g.phase === PHASE.BID) {
          const seat = g.currentBidder;
          if (seat == null) break;
          if (seat === 0) { await this.waitHuman('bid'); continue; }
          this.setStatus(`${this.app.seatNames[seat]} 正在叫地主…`);
          {
            // ★ 叫地主也是规则引擎瞬间算出来的：故意延迟 1~5 秒假装在犹豫
            const think = thinkDelay(g.personas[seat]);
            this.updateTurnVisual(seat, think);
            await sleep(think);
          }
          if (!this.alive) break;
          const want = g.decideBid(seat, false);
          this.app.aiReact(seat, 'bid', { call: want });
          g.applyBid(seat, want);
        } else if (g.phase === PHASE.ROB) {
          const seat = g.seatToAsk;
          if (seat == null) break;
          if (seat === 0) { await this.waitHuman('rob'); continue; }
          this.setStatus(`${this.app.seatNames[seat]} 正在决定抢不抢…`);
          {
            const think = thinkDelay(g.personas[seat]);
            this.updateTurnVisual(seat, think);
            await sleep(think);
          }
          if (!this.alive) break;
          const want = g.decideBid(seat, true);
          this.app.aiReact(seat, 'rob', { call: want });
          g.applyRob(seat, want);
        } else if (g.phase === PHASE.PLAY) {
          const seat = g.turnSeat;
          if (seat === 0) { await this.waitHuman('play'); continue; }
          await this.aiTurn(seat);
        } else {
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 等待人类操作：resolve 之后循环继续 */
  waitHuman(kind) {
    return new Promise((resolve) => {
      this.selected.clear();
      this.pending = { kind, resolve, settled: false };
      if (kind === 'play') this.beginHumanTurn();
      else this.showBidBar(kind);
      this.startHumanCountdown(kind);
    });
  }

  /** 结束本次人类等待（一定会 resolve，且只 resolve 一次） */
  settleHuman() {
    const p = this.pending;
    if (!p || p.settled) return;
    p.settled = true;
    this.pending = null;
    this.stopCountdown();
    this.hideBidBar();
    this.hideActionRow();
    p.resolve();
  }

  /** 抢地主 / 出牌 的人类倒计时（超时自动替玩家决定） */
  startHumanCountdown(kind) {
    const secs = kind === 'play' ? CONFIG.turnTimeout.play : CONFIG.turnTimeout.bid;
    this.startCountdown(secs, () => {
      const p = this.pending;
      if (!p || p.settled) return;
      const g = this.game;
      if (p.kind === 'bid') { toast('超时未表态，默认不叫'); g.applyBid(0, false); }
      else if (p.kind === 'rob') { toast('超时未表态，默认不抢'); g.applyRob(0, false); }
      else { toast('超时，已自动替你出牌'); g.autoPlay(0); }
      this.settleHuman();
    });
  }

  async aiTurn(seat) {
    const g = this.game;
    this.setStatus(`${this.app.seatNames[seat]} 正在出牌…`);
    // ★ 选牌是规则引擎瞬间算出来的（core/bot.js），这里**故意延迟 1~5 秒假装在思考**
    const think = thinkDelay(g.personas[seat]);
    this.updateTurnVisual(seat, think);
    await sleep(think);
    if (!this.alive || g.phase !== PHASE.PLAY || g.turnSeat !== seat) return;
    // AI 选牌：纯规则引擎 + 人设牌技档位（大模型只负责说话，不参与选牌）
    const play = await this.app.decideAiPlay(seat);
    if (!this.alive || g.phase !== PHASE.PLAY || g.turnSeat !== seat) return;
    const res = play ? g.applyPlay(seat, play.cards) : g.applyPlay(seat, []);
    if (!res.ok) {
      // 兜底：极端情况下主动过牌，避免卡死
      g.applyPlay(seat, []);
    }
    if (g.phase === PHASE.PLAY && g.hands.some((h) => h.length === 1)) handOverTip('报单!');
    this.lastActivity = Date.now();
  }

  /* ------------------------------ 人类输入 ------------------------------ */
  showBidBar(kind) {
    const isRob = kind === 'rob';
    this.hideActionRow();
    this.dom.bidBar.hidden = false;
    this.dom.bidHint.textContent = isRob ? '抢地主 / 反抢？' : '要叫地主吗？';
    this.dom.btnBidYes.textContent = isRob ? '抢地主' : '叫地主';
    this.dom.btnBidNo.textContent = isRob ? '不抢' : '不叫';
    this.setStatus(isRob ? '轮到你：抢地主 / 反抢？' : '轮到你：叫地主还是不叫？');
    this.updateTurnVisual(0);
  }

  hideBidBar() { this.dom.bidBar.hidden = true; }

  hideActionRow() { this.dom.actionRow.hidden = true; }

  beginHumanTurn() {
    const g = this.game;
    this.hideBidBar();
    this.dom.actionRow.hidden = false;
    this.dom.btnPass.disabled = g.mustPlay();
    this.renderHand();
    this.updateActionState();
    this.updateTurnVisual(0);
    this.setStatus(g.mustPlay() ? '轮到你出牌（首出必须出牌）' : '轮到你出牌');
  }

  humanBid(call) {
    const p = this.pending;
    if (!p || (p.kind !== 'bid' && p.kind !== 'rob')) return;
    const g = this.game;
    if (p.kind === 'bid') {
      if (g.phase !== PHASE.BID || g.currentBidder !== 0) { this.settleHuman(); return; }
      g.applyBid(0, call);
    } else {
      if (g.phase !== PHASE.ROB || g.seatToAsk !== 0) { this.settleHuman(); return; }
      g.applyRob(0, call);
    }
    this.settleHuman();
  }

  humanPlay() {
    const p = this.pending;
    if (!p || p.kind !== 'play') return;
    const g = this.game;
    if (!g.canPlayAt(0)) return;
    const cards = this.selectedCards();
    if (!cards.length) { this.reject('先选牌'); return; }
    const res = g.applyPlay(0, cards);
    if (!res.ok) { this.reject(res.error); return; }
    this.selected.clear();
    this.settleHuman();
  }

  humanPass() {
    const p = this.pending;
    if (!p || p.kind !== 'play') return;
    const g = this.game;
    if (!g.canPlayAt(0)) return;
    if (g.mustPlay()) { this.reject('该你首出，不能不出'); return; }
    const res = g.applyPlay(0, []);
    if (!res.ok) { this.reject(res.error); return; }
    this.selected.clear();
    this.settleHuman();
  }

  humanHint() {
    const p = this.pending;
    if (!p || p.kind !== 'play') return;
    const g = this.game;
    if (!g.canPlayAt(0)) return;
    const last = g.lastPlay ? g.lastPlay.play : null;
    const plays = findPlays(g.hands[0], last);
    if (!plays.length) {
      toast('没有能压过的牌，只能不出', 'bad');
      this.selected.clear();
      this.renderHand();
      return;
    }
    const sig = `${last ? last.type + last.size + last.rank : 'lead'}|${g.hands[0].length}`;
    if (this.hintSig !== sig) { this.hintList = plays; this.hintIndex = 0; this.hintSig = sig; }
    const play = this.hintList[this.hintIndex % this.hintList.length];
    this.hintIndex += 1;
    this.selected = new Set(play.cards.map((c) => c.id));
    this.renderHand();
    audio.play('select');
  }

  reject(reason) {
    audio.play('error');
    toast(reason, 'bad');
    const area = this.dom.handArea;
    area.style.transition = 'transform .08s ease';
    let n = 0;
    const shake = () => {
      area.style.transform = n % 2 ? 'translateX(0)' : `translateX(${n % 4 === 0 ? -8 : 8}px)`;
      n += 1;
      if (n < 6) setTimeout(shake, 60);
      else area.style.transform = '';
    };
    shake();
  }

  /* ------------------------------ 冷场 ------------------------------ */
  startIdleWatcher() {
    this.idleTimer = setInterval(() => {
      if (!this.alive) return;
      if (!this.app.aiEnabled) return;
      if (this.game.phase !== PHASE.PLAY) return;
      if (Date.now() - this.lastActivity < CONFIG.ai.idleGap) return;
      this.lastActivity = Date.now();
      const seat = [1, 2][Math.floor(Math.random() * 2)];
      this.app.aiScene(seat, 'idle');
    }, 3000);
  }

  /* ------------------------------ 结算 ------------------------------ */
  handleOver(result) {
    this.stopCountdown();
    this.hideBidBar();
    this.hideActionRow();
    this.alive = false;
    if (result.spring || result.antiSpring) {
      fxBanner();
      audio.play('bomb');
    }
    const humanWin = (result.landlordSeat === 0) === result.landlordWin;
    audio.play(humanWin ? 'win' : 'lose');
    this.renderSeats();
    this.updateMultiplier(false);
    this.setStatus(humanWin ? '本局胜利！' : '本局失败…');
    this.app.onGameOver(result);
  }
}

const SEAT_FALLBACK = ['你', '下家', '上家'];
export { SEAT_FALLBACK };
