/**
 * 小猫钓鱼 牌桌控制器（休闲模式，不计豆子）
 *  · 钓到之后由玩家决定「收下」还是「先不收」（攒大鱼）
 *  · 双方牌堆 / 鱼篓都用真实牌堆展示
 */
import { FishingGame, settleFishing } from '../games/fishing.js';
import { createCard, createBack } from './cardsView.js';
import { ASSETS } from '../../assets/manifest.js';
import { playerAvatarSrc } from '../data/avatar.js';
import { cardName } from '../core/cards.js';
import { audio } from './audio.js';
import { floatText } from './fx.js';
import { PERSONAS } from '../data/personas.js';
import { formatBeans } from '../core/settle.js';
import { FISHING } from '../config.js';
import { voice } from './voice.js';
import { toast } from './fx.js';
import * as panels from './panels.js';

const PILE_SHOW = 3; // 每个牌堆最多画几张

export class FishingTable {
  constructor(app, opts = {}) {
    this.app = app;
    this.room = app.currentFishRoom || { name: '低级场', perCard: 12, quad: 3, cube: 0 };
    this.round = 0;
    this.wins = 0;
    this.losses = 0;
    this.auto = false;
    this.alive = true;
    this.persona = app.fishPersona || PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
    this.bindDom();
    /**
     * ★ AI 房主邀请进来的房间：先等几秒再发牌
     * （用户拍板：3~5 秒后自动开局，这期间玩家退出就不开局）
     */
    const delay = Number(opts.startDelayMs) || 0;
    if (delay > 0) {
      this.setTip(opts.waitText || '房主正在发牌，马上开始…');
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        if (!this.alive) return;
        this.startRound();
      }, delay);
      this.renderCounts();
    } else {
      this.startRound();
    }
  }

  bindDom() {
    const $ = (id) => document.getElementById(id);
    this.dom = {
      round: $('fish-round'),
      title: $('fish-title'),
      score: $('fish-score'),
      multi: $('fish-multi'),
      beans: $('fish-beans'),
      aiAvatar: $('fish-ai-avatar'),
      aiCount: $('fish-ai-count'),
      aiName: $('fish-ai-name'),
      aiScore: $('fish-ai-score'),
      aiHand: $('fish-ai-hand'),
      aiCatch: $('fish-ai-catch'),
      aiBubble: $('fish-ai-bubble'),
      meAvatar: $('fish-me-avatar'),
      meCount: $('fish-me-count'),
      meName: $('fish-me-name'),
      meScore: $('fish-me-score'),
      meHand: $('fish-me-hand'),
      meCatch: $('fish-me-catch'),
      meBubble: $('fish-me-bubble'),
      table: $('fish-table'),
      tip: $('fish-tip'),
      play: $('btn-fish-play'),
      auto: $('btn-fish-auto'),
      again: $('btn-fish-again'),
      back: $('btn-fish-back'),
      settings: $('btn-fish-settings'),
      quit: $('btn-fish-quit'),
      catchBar: $('fish-catch-bar'),
      catchText: $('fish-catch-text'),
      take: $('btn-fish-take'),
      skip: $('btn-fish-skip'),
      quickInput: $('fish-quick-input'),
      emoji: $('fish-emoji'),
      emojiPop: $('fish-emoji-pop'),
      mic: $('fish-mic'),
      counter: $('fish-counter'),
      counterList: $('fish-counter-list'),
    };
    this.dom.title.textContent = `🐱 小猫钓鱼 · ${this.room.name}`;
    this.dom.aiAvatar.src = ASSETS.avatar(this.app.fishAvatar);
    this.dom.aiName.textContent = this.persona ? this.persona.name : '对手';
    this.dom.meAvatar.src = playerAvatarSrc(this.app.save);
    this.dom.meName.textContent = this.app.playerName;
    this.dom.beans.textContent = `💰 ${formatBeans(this.app.economy.beans)}`;

    this.dom.play.addEventListener('click', () => this.onPlay());
    this.dom.again.addEventListener('click', () => this.startRound());
    this.dom.back.addEventListener('click', () => this.app.quitFishing());
    this.dom.quit.addEventListener('click', () => this.app.quitFishing());
    this.dom.settings.addEventListener('click', () => this.app.openSettings());
    this.dom.auto.addEventListener('click', () => this.toggleAuto());
    this.dom.take.addEventListener('click', () => this.playerCatch(true));
    this.dom.skip.addEventListener('click', () => this.playerCatch(false));
    this.bindChat();
    this.onKey = (e) => {
      if (!this.app.isFishingActive()) return;
      if (e.code !== 'Space') return;
      e.preventDefault();
      const a = this.game.awaiting;
      if (a && a.seat === 0 && !this.auto) this.playerCatch(true);
      else this.onPlay();
    };
    window.addEventListener('keydown', this.onKey);
  }

  /** 右下角发言区：输入框 / 表情道具 / 麦克风 */
  bindChat() {
    const d = this.dom;
    d.quickInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = d.quickInput.value.trim();
      if (!text) return;
      d.quickInput.value = '';
      this.app.sendHumanChat(text);
    });
    d.emoji.addEventListener('click', (e) => {
      e.stopPropagation();
      this.updateToolCounts();
      d.emojiPop.hidden = !d.emojiPop.hidden;
    });
    d.emojiPop.addEventListener('click', (e) => {
      const tool = e.target.closest('[data-fish-tool]');
      if (tool) { this.app.sendTool(tool.dataset.fishTool); d.emojiPop.hidden = true; return; }
      const emo = e.target.closest('[data-fish-emoji]');
      if (emo) { this.app.sendHumanChat(emo.dataset.fishEmoji); d.emojiPop.hidden = true; return; }
      if (e.target.closest('#fish-open-chat')) { d.emojiPop.hidden = true; this.app.openChat(); }
    });
    this.onDocClick = (e) => {
      if (!d.emojiPop.hidden && !e.target.closest('#fish-emoji-pop') && !e.target.closest('#fish-emoji')) {
        d.emojiPop.hidden = true;
      }
    };
    document.addEventListener('click', this.onDocClick);
    if (d.mic) {
      if (!voice.supported) d.mic.hidden = true;
      d.mic.addEventListener('click', () => {
        if (!voice.supported) return;
        if (voice.live) { voice.stop(); return; }
        const ok = voice.start({
          onText: (text) => {
            const t = String(text).trim().slice(0, 30);
            if (!t) return;
            // 说完直接发出去：不落在输入框里，也不再弹"已发送"提示
            this.app.sendHumanChat(t);
          },
          onState: (live, reason) => {
            voice.applyButtonState(d.mic, live);
            if (!live && d.quickInput) d.quickInput.value = '';
            if (reason === 'not-allowed' || reason === 'service-not-allowed') toast('麦克风被拒绝，请改用文字输入', 'bad');
          },
        });
        if (!ok) toast('开麦失败，请检查麦克风权限', 'bad');
      });
    }
  }

  updateToolCounts() {
    for (const it of this.app.toolState()) {
      const el = document.getElementById(`fish-tool-left-${it.id}`);
      if (el) el.textContent = String(it.left);
      const btn = document.getElementById(`fish-tool-btn-${it.id}`);
      if (btn) btn.classList.toggle('is-empty', it.left <= 0);
    }
  }

  destroy() {
    this.alive = false;
    // AI 房主邀请进来的那一局还没发牌就退出：把开局的定时器也停掉
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    // 离开牌桌就别继续占着麦克风了
    if (voice.live) voice.stop();
    window.removeEventListener('keydown', this.onKey);
    if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
  }

  toggleAuto() {
    this.auto = !this.auto;
    this.dom.auto.textContent = `自动翻牌：${this.auto ? '开' : '关'}`;
    this.updateButtons();
    if (this.auto && !this.game.over) {
      const a = this.game.awaiting;
      if (a && a.seat === 0) this.autoResolve(0);
      else if (this.game.turn === 0) this.scheduleNext();
    }
  }

  startRound() {
    this.game = new FishingGame();
    this.round += 1;
    this.app.resetToolUsage();
    this.updateToolCounts();
    this.dom.round.textContent = `第 ${this.round} 局`;
    this.dom.again.hidden = true;
    this.dom.play.hidden = false;
    this.hideCatchBar();
    this.renderAll();
    this.setTip(`一次钓到 ${FISHING.bigCatchMin} 张以上，本局倍数翻倍；最后按鱼篓差距 × 倍数结算豆子`);
    if (this.persona && this.round === 1) this.app.fishSpeak('greeting');
    if (this.auto) this.scheduleNext();
  }

  /* ------------------------------ 渲染 ------------------------------ */
  renderAll() {
    this.renderCounts();
    this.renderTable();
    this.renderPiles();
    this.updateButtons();
  }

  /** 左上角记牌器：每个点数在牌堆里还剩几张（双方没翻的牌） */
  renderCounter() {
    const box = this.dom.counterList;
    if (!box) return;
    const rows = this.game.remainingByRank();
    box.innerHTML = rows.map(({ rank, left }) => {
      const label = rank >= 11 ? { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' }[rank] : String(rank);
      const cls = left === 0 ? 'is-empty' : (left === 1 ? 'is-last' : '');
      return `<span class="fc-item ${cls}" title="${label} 还剩 ${left} 张">${label}<b>${left}</b></span>`;
    }).join('');
    if (this.dom.counter) {
      const totalLeft = rows.reduce((s, r) => s + r.left, 0);
      this.dom.counter.title = `牌堆里还剩 ${totalLeft} 张没翻`;
    }
  }

  renderCounts() {
    const g = this.game;
    this.dom.aiCount.textContent = String(g.piles[1].length);
    this.dom.meCount.textContent = String(g.piles[0].length);
    this.dom.aiScore.textContent = String(g.score[1]);
    this.dom.meScore.textContent = String(g.score[0]);
    this.dom.score.textContent = `${g.score[0]} : ${g.score[1]}`;
    this.dom.multi.textContent = `×${g.multiplier}`;
    this.dom.multi.classList.toggle('is-hot', g.multiplier > 1);
    this.dom.beans.textContent = `💰 ${formatBeans(this.app.economy.beans)}`;
    this.dom.aiCount.parentElement.classList.toggle('danger', g.piles[1].length <= 3);
    this.dom.meCount.parentElement.classList.toggle('danger', g.piles[0].length <= 3);
    // 记牌器并在这里刷新：凡是会改动牌堆的地方都会调 renderCounts，
    // 单独调用（比如翻牌后只调 renderCounts）也不会漏更新
    this.renderCounter();
  }

  /** 倍数变化时的反馈 */
  bumpMultiplier() {
    const el = this.dom.multi;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  /** 牌堆（背面）与鱼篓（正面）都用真实牌堆画出来 */
  renderPiles() {
    const g = this.game;
    const draw = (box, count, faces, faceUp) => {
      box.innerHTML = '';
      const n = Math.min(PILE_SHOW, count);
      for (let i = 0; i < n; i += 1) {
        const card = faceUp ? faces[faces.length - 1 - i] : null;
        const node = card
          ? createCard(card, { size: 'tiny' })
          : createBack('tiny', this.app.save.settings.cardBack);
        node.style.setProperty('--pile-i', String(i));
        box.append(node);
      }
    };
    draw(this.dom.aiHand, g.piles[1].length, [], false);
    draw(this.dom.aiCatch, g.score[1], g.bucket[1], true);
    draw(this.dom.meHand, g.piles[0].length, [], false);
    draw(this.dom.meCatch, g.score[0], g.bucket[0], true);
  }

  bumpScore(seat) {
    const el = seat === 0 ? this.dom.meScore.parentElement : this.dom.aiScore.parentElement;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  renderTable() {
    const box = this.dom.table;
    const g = this.game;
    box.innerHTML = '';
    const all = g.table;
    const shown = all.slice(-10);
    const offset = all.length - shown.length;
    const a = g.awaiting;
    shown.forEach((c, i) => {
      const idx = offset + i; // 在整副中央牌堆里的下标
      const el = createCard(c, { size: 'mini' });
      if (idx === all.length - 1) el.classList.add('is-top');
      if (a && idx >= a.idx) el.classList.add('is-catch');
      box.append(el);
    });
    if (offset > 0) {
      const more = document.createElement('span');
      more.textContent = `+${offset}`;
      more.style.cssText = 'align-self:center;margin-left:8px;font-size:12px;color:var(--ink-faint)';
      box.prepend(more);
    }
  }

  setTip(text) { this.dom.tip.textContent = text; }

  showCatchBar(count) {
    this.dom.catchText.textContent = `钓到了！现在收能得 ${count} 张`;
    this.dom.take.textContent = `收下 ${count} 张`;
    this.dom.catchBar.hidden = false;
  }

  hideCatchBar() { this.dom.catchBar.hidden = true; }

  updateButtons() {
    const g = this.game;
    if (g.over) { this.dom.play.disabled = true; return; }
    const awaitingMe = g.awaiting && g.awaiting.seat === 0;
    const myTurn = !g.awaiting && g.turn === 0;
    this.dom.play.disabled = !myTurn || this.auto;
    this.dom.play.textContent = awaitingMe ? '请选择…' : (myTurn ? '翻 牌' : '对手回合…');
    if (!awaitingMe) this.hideCatchBar();
  }

  /* ------------------------------ 流程 ------------------------------ */
  onPlay() {
    if (!this.alive || this.game.over || this.auto) return;
    if (this.game.awaiting || this.game.turn !== 0) return;
    this.step();
  }

  step() {
    const g = this.game;
    if (!this.alive || g.over || g.awaiting) return;
    const res = g.play();
    if (!res) return;
    if (res.type === 'play') {
      audio.play('select');
      this.renderTable();
      this.animateTop(res.seat);
      const who = res.seat === 0 ? '你' : '对手';
      if (!res.pending) this.setTip(`${who}翻出 ${cardName(res.card)}，中央共 ${g.table.length} 张`);
    }
    this.renderCounts();
    this.renderPiles();
    if (g.awaiting) return this.handleAwaiting();
    this.afterMove();
  }

  /** 出现「钓」的机会：等决定 */
  handleAwaiting() {
    const g = this.game;
    const a = g.awaiting;
    this.renderTable();
    this.updateButtons();
    if (!a) return;
    if (a.seat === 0) {
      this.showCatchBar(a.count);
      this.setTip(`钓到了！收下得 ${a.count} 张；「先不收」就留在中间继续攒，可能钓更大——但对手也可能抢走`);
      if (this.auto) this.autoResolve(0);
    } else {
      this.setTip(`对手钓到了 ${a.count} 张，正在犹豫收不收…`);
      setTimeout(() => { if (this.alive) this.aiResolve(); }, 950);
    }
  }

  playerCatch(collect) {
    if (!this.alive || !this.game.awaiting || this.game.awaiting.seat !== 0) return;
    this.resolve(collect, 0);
  }

  aiResolve() {
    const g = this.game;
    const a = g.awaiting;
    if (!a || a.seat !== 1) return;
    const left = g.piles[1].length;
    // 简单策略：够大就收；牌快出完就收；否则有一定概率再攒攒
    const collect = a.count >= 5 || left <= 3 || Math.random() < 0.45;
    this.resolve(collect, 1);
  }

  autoResolve(seat) {
    const g = this.game;
    const a = g.awaiting;
    if (!a || a.seat !== seat) return;
    setTimeout(() => {
      if (!this.alive) return;
      const cur = this.game.awaiting;
      if (!cur || cur.seat !== seat) return;
      const collect = cur.count >= 5 || this.game.piles[seat].length <= 3 || Math.random() < 0.5;
      this.resolve(collect, seat);
    }, 420);
  }

  resolve(collect, seat) {
    const g = this.game;
    const a = g.awaiting;
    if (!a) return;
    // 收牌前先抓住要飞走的那几张 DOM，收完再让它们飞进鱼篓
    const flying = collect ? [...this.dom.table.querySelectorAll('.card.is-catch')] : [];
    const res = g.resolveCatch(collect);
    if (!res) return;
    this.hideCatchBar();
    const who = seat === 0 ? '你' : '对手';

    if (collect) {
      audio.play('flower');
      const doubled = !!(res.doubled || (g.lastCatch && g.lastCatch.seat === seat && g.lastCatch.doubled));
      this.setTip(`${who}收下 ${res.count} 张，鱼篓共 ${g.score[seat]} 张${doubled ? `　倍数翻倍 → ×${g.multiplier}！` : (g.multiplier > 1 ? `　当前倍数 ×${g.multiplier}` : '')}`);
      if (doubled) {
        // 一次钓 6 张以上：倍数翻倍，给足反馈
        audio.play('rob');
        this.bumpMultiplier();
        floatText(`×${g.multiplier} 大丰收！`, '50%', '32%');
      }
      this.app.fishSayCatch(seat, res.count); // 按“鱼的大小”决定对手说不说
      floatText(seat === 0 ? `🎣 收下 ${res.count} 张` : `对手收下 ${res.count} 张`, '50%', '44%');
      const wait = this.flyToBucket(flying, seat);
      // 牌飞进鱼篓之后，再更新中央与双方牌堆（数字与牌堆同时变化，更直观）
      setTimeout(() => {
        if (!this.alive) return;
        this.renderAll();
        this.bumpScore(seat);
        this.afterMove();
      }, wait);
      return;
    }

    audio.play('pass');
    this.setTip(`${who}先不收，想钓个大的！`);
    if (Math.random() < 0.3) this.app.fishSpeak('idle'); // 偶尔念叨一句，不刷屏
    this.renderAll();
    this.afterMove();
  }

  /** 把中央那几张牌飞向鱼篓并缩小；返回动画总时长 */
  flyToBucket(nodes, seat) {
    if (!nodes.length) return 0;
    const bucket = seat === 0 ? this.dom.meCatch : this.dom.aiCatch;
    const target = bucket.getBoundingClientRect();
    const tx = target.left + target.width / 2;
    const ty = target.top + target.height / 2;
    nodes.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const dx = tx - (r.left + r.width / 2);
      const dy = ty - (r.top + r.height / 2);
      el.style.zIndex = '80';
      el.style.pointerEvents = 'none';
      el.style.transition = 'none';
      el.style.transform = 'none';
      void el.offsetWidth; // 强制重排后再启动过渡
      const delay = i * 45;
      el.style.transition = `transform 460ms cubic-bezier(.35,.7,.4,1) ${delay}ms, opacity 460ms ease ${delay}ms`;
      el.style.transform = `translate(${dx}px, ${dy}px) scale(0.3) rotate(${seat === 0 ? -22 : 22}deg)`;
      el.style.opacity = '0.15';
    });
    return 460 + nodes.length * 45 + 60;
  }

  afterMove() {
    const g = this.game;
    if (g.over) return this.finish();
    this.updateButtons();
    this.scheduleNext();
  }

  scheduleNext() {
    const g = this.game;
    if (!this.alive || g.over) return;
    if (g.awaiting) return;
    if (g.turn === 1) {
      setTimeout(() => { if (this.alive && !this.game.over && !this.game.awaiting) this.step(); }, 780);
    } else if (this.auto) {
      setTimeout(() => { if (this.alive && !this.game.over && !this.game.awaiting) this.step(); }, 650);
    }
  }

  animateTop(seat) {
    const el = this.dom.table.querySelector('.card.is-top');
    if (!el) return;
    const src = (seat === 0 ? this.dom.meAvatar : this.dom.aiAvatar).getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const dx = (src.left + src.width / 2) - (r.left + r.width / 2);
    const dy = (src.top + src.height / 2) - (r.top + r.height / 2);
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(0.6) rotate(${seat === 0 ? -12 : 12}deg)`;
    el.style.opacity = '0.2';
    void el.offsetWidth;
    el.style.transition = 'transform 300ms cubic-bezier(.2,.9,.25,1), opacity 200ms ease';
    el.style.transform = 'none';
    el.style.opacity = '1';
  }

  finish() {
    const g = this.game;
    const draw = g.winner === -1;
    const win = g.winner === 0;
    if (win) this.wins += 1;
    else if (!draw) this.losses += 1;
    this.hideCatchBar();
    this.dom.play.hidden = true;
    this.dom.again.hidden = false;

    // 按鱼篓差结算豆子（倍率与曲线看场次，再乘本局倍数）
    const pay = settleFishing(g.score[0], g.score[1], this.room, undefined, g.multiplier);
    if (pay.delta !== 0) this.app.economy.addBeans(pay.delta, 'fishing');
    // 对手的身家同步变化（全局共享），其他 AI 照常浮动（机器模式不动 AI 身家）
    if (this.app.aiEnabled) {
      this.app.settleFishingAi(this.persona && this.persona.id, -pay.delta);
      // 这一局的概括进记忆（只记参战的那位，没打的好友不会"假装打过"）
      this.app.recordFishingMemory({
        pay, score: g.score, multiplier: g.multiplier, room: this.room, persona: this.persona,
      });
      // 陪打一局也加好感（房间模式邀请的 +3，随机匹配碰上的 +1）
      this.app.rewardFriendPlay(this.persona ? [this.persona] : [], !!(this.app.lastRoomFriends && this.app.lastRoomFriends.length));
    }
    this.renderCounts();

    const gap = pay.diff === 0 ? '五五开' : `差 ${pay.diff > 0 ? '+' : ''}${pay.diff} 张`;
    const multTxt = g.multiplier > 1 ? `　倍数 ×${g.multiplier}` : '';
    const money = pay.delta === 0 ? '不输不赢' : `${pay.delta > 0 ? '+' : ''}💰${pay.delta}`;
    const head = draw ? '平局！' : win ? '你赢了！' : '你输了';
    const tail = `（本次共 ${this.wins} 胜 ${this.losses} 负）`;
    this.setTip(`${head}鱼篓 ${g.score[0]} : ${g.score[1]}（${gap}）${multTxt}　${money} ${tail}`);

    if (pay.delta > 0) {
      floatText(`🎣 ${gap}　+💰${pay.delta}`, '50%', '38%');
      audio.play('coin');
    } else if (pay.delta < 0) {
      floatText(`🎣 ${gap}　-💰${Math.abs(pay.delta)}`, '50%', '38%');
    }
    audio.play(win ? 'win' : draw ? 'pass' : 'lose');
    this.app.fishSpeak(win ? 'lose' : 'win');
    this.app.persist('fishing');
    // 打完一局，好友可能来找你聊两句
    void this.app.pingFriendsAfterGame();

    // 单独的本局结算页：看比分/输赢，可以加好友、再来一局、返回主界面
    const self = this;
    setTimeout(() => {
      if (self.game !== g) return; // 期间已经开了新的一局
      panels.showFishingResult(this.app, {
        pay,
        score: g.score,
        multiplier: g.multiplier,
        room: this.room,
        persona: this.persona,
        wins: this.wins,
        losses: this.losses,
        onAgain: () => self.startRound(),
        onQuit: () => self.app.quitFishing(),
      });
    }, win ? 900 : 700);
  }
}
