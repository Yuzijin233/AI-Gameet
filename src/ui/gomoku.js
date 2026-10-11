/**
 * 五子棋牌桌（用户拍板的功能：替代原来占位的"掼蛋"）
 *
 * 规则与引擎在 core/gomoku.js；这里只负责界面与流程：
 *   · 每局**随机决定谁先手**（黑先），玩家执黑的颜色固定为"玩家=黑"？
 *     —— 不：随机的是"谁先走"，颜色跟着走子顺序（先手执黑），玩家可能是黑也可能是白
 *   · 落子：点格子 → 落子 → 判断胜负 → 换手 → 轮到 AI 时按难度思考一下再落
 *   · 认输 = 直接输；下满 = 平局
 *   · 结算：不走豆子，只加好感度 + 写对局记忆（见 app.finishGomoku）
 *   · 说话：气泡 + 快捷聊天 + 道具 + 语音，和钓鱼那边共用 app 的方法
 */
import { ASSETS } from '../../assets/manifest.js';
import { playerAvatarSrc } from '../data/avatar.js';
import { audio, } from './audio.js';
import { floatText, toast } from './fx.js';
import { voice } from './voice.js';
import { GOMOKU, GOMOKU_ROOMS } from '../config.js';
import * as panels from './panels.js';
import { levelOfPersona, levelIndex } from '../data/gomokuLevels.js';
import { renderEquippedBadge } from './titles.js';
import {
  BOARD_SIZE, BLACK, WHITE, other, createBoard, place, checkWinAt, isFull, moveCount, pickMove,
} from '../core/gomoku.js';

/**
 * 棋盘坐标 → 百分比（三个图层共用这一套，保证线与棋子严丝合缝）
 *   外圈留半格 PAD，交叉点间距 STEP：
 *   PAD  = 100/15/2 = 3.3333%    STEP = (100 - 2*PAD)/14 = 6.6667%
 */
const PAD = 100 / BOARD_SIZE / 2;
const STEP = (100 - PAD * 2) / (BOARD_SIZE - 1);
const posOf = (i) => PAD + i * STEP;
const STAR_POINTS = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]]; // 星位（含天元）

export class GomokuTable {
  /**
   * @param {object} app
   * @param {{startDelayMs?:number, waitText?:string}} [opts]
   *   startDelayMs = AI 房主邀请进来的：先等几秒再开局（期间退出就不打了）
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.room = app.currentGomokuRoom || GOMOKU_ROOMS[1] || GOMOKU_ROOMS[0];
    this.persona = app.gomokuPersona || null;
    // ★ 难度：好友用它自己的固定档位；机器模式（没有 persona）用场次池里随机的那一档
    //   （档位名只用在这里算棋力，界面上一个字都不显示）
    this.level = this.persona ? levelOfPersona(this.persona) : (app.gomokuBotLevel || GOMOKU.levels[2]);
    this.alive = true;
    this.round = 0;
    this.wins = 0;
    this.losses = 0;
    this.thinking = false;
    this.over = true;
    this.history = [];

    this.bindDom();
    this.bindChat();
    this.app.gomoku = this;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.alive) this.startRound();
    }, Math.max(0, opts.startDelayMs || 0));
  }

  /* ------------------------------ 界面 ------------------------------ */
  bindDom() {
    const $ = (id) => document.getElementById(id);
    this.dom = {
      title: $('gmk-title'),
      room: $('gmk-room'),
      moves: $('gmk-moves'),
      turn: $('gmk-turn'),
      board: $('gmk-board'),
      lines: $('gmk-lines'),
      cells: $('gmk-cells'),
      stones: $('gmk-stones'),
      tip: $('gmk-tip'),
      aiAvatar: $('gmk-ai-avatar'),
      aiName: $('gmk-ai-name'),
      aiColor: $('gmk-ai-color'),
      aiBubble: $('gmk-ai-bubble'),
      meAvatar: $('gmk-me-avatar'),
      meName: $('gmk-me-name'),
      meColor: $('gmk-me-color'),
      meBubble: $('gmk-me-bubble'),
      meTitle: $('gmk-me-title'),
      resign: $('btn-gmk-resign'),
      again: $('btn-gmk-again'),
      back: $('btn-gmk-back'),
      settings: $('btn-gmk-settings'),
      quit: $('btn-gmk-quit'),
      quickInput: $('gmk-quick-input'),
      emoji: $('gmk-emoji'),
      emojiPop: $('gmk-emoji-pop'),
      mic: $('gmk-mic'),
    };
    const d = this.dom;
    d.title.textContent = '⚫ 五子棋';
    d.room.textContent = this.room.name;
    d.aiAvatar.src = ASSETS.avatar(this.persona ? this.persona.avatar : 'avatar_02');
    d.aiName.textContent = this.persona ? this.persona.name : '对手';
    d.meAvatar.src = playerAvatarSrc(this.app.save);
    d.meName.textContent = this.app.playerName;
    renderEquippedBadge(d.meTitle, this.app.save);
    if (d.meTitle) d.meTitle.hidden = !d.meTitle.textContent;

    d.resign.addEventListener('click', () => this.resign());
    d.again.addEventListener('click', () => this.startRound());
    d.back.addEventListener('click', () => this.app.quitGomoku());
    d.quit.addEventListener('click', () => this.app.quitGomoku());
    d.settings.addEventListener('click', () => this.app.openSettings());
    this.updateToolCounts();

    // ① 网格线（横竖各 15 条 1px 实线，位置和棋子用同一个公式）+ 星位
    d.lines.innerHTML = '';
    for (let i = 0; i < BOARD_SIZE; i += 1) {
      const h = document.createElement('div');
      h.className = 'gmk-line is-h';
      h.style.left = `${posOf(0)}%`;
      h.style.width = `${posOf(BOARD_SIZE - 1) - posOf(0)}%`;
      h.style.top = `${posOf(i)}%`;
      d.lines.append(h);
      const v = document.createElement('div');
      v.className = 'gmk-line is-v';
      v.style.top = `${posOf(0)}%`;
      v.style.height = `${posOf(BOARD_SIZE - 1) - posOf(0)}%`;
      v.style.left = `${posOf(i)}%`;
      d.lines.append(v);
    }
    for (const [x, y] of STAR_POINTS) {
      const dot = document.createElement('div');
      dot.className = 'gmk-star';
      dot.style.left = `${posOf(x)}%`;
      dot.style.top = `${posOf(y)}%`;
      d.lines.append(dot);
    }

    // ② 每格一个点击区（透明按钮）——**这层必须能收到点击**，否则玩家下不了
    d.cells.innerHTML = '';
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gmk-cell';
        btn.dataset.x = String(x);
        btn.dataset.y = String(y);
        btn.style.left = `${posOf(x)}%`;
        btn.style.top = `${posOf(y)}%`;
        btn.addEventListener('click', () => this.onCell(x, y));
        d.cells.append(btn);
      }
    }
  }

  /** 右下角发言区：输入框 / 表情道具 / 麦克风（和钓鱼那边一致） */
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
      const tool = e.target.closest('[data-gmk-tool]');
      if (tool) { this.app.sendTool(tool.dataset.gmkTool); d.emojiPop.hidden = true; return; }
      const emo = e.target.closest('[data-gmk-emoji]');
      if (emo) { this.app.sendHumanChat(emo.dataset.gmkEmoji); d.emojiPop.hidden = true; return; }
      if (e.target.closest('#gmk-open-chat')) { d.emojiPop.hidden = true; this.app.openChat(); }
    });
    this.onDocClick = (e) => {
      if (!d.emojiPop.hidden && !e.target.closest('#gmk-emoji-pop') && !e.target.closest('#gmk-emoji')) {
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
            if (t) this.app.sendHumanChat(t);
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
    for (const it of ['flower', 'tomato', 'egg', 'cappuccino']) {
      const el = document.getElementById(`gmk-tool-left-${it}`);
      if (el) el.textContent = String(this.app.toolLeft(it));
    }
  }

  destroy() {
    this.alive = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.aiTimer) clearTimeout(this.aiTimer);
    if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
    if (voice.live) voice.stop();
    if (this.app.gomoku === this) this.app.gomoku = null;
  }

  /* ------------------------------ 一局 ------------------------------ */
  startRound() {
    this.round += 1;
    this.board = createBoard(BOARD_SIZE);
    this.over = false;
    this.thinking = false;
    this.history = [];
    /** ★ 每局随机决定谁先手（用户拍板）：先手执黑 */
    this.playerFirst = Math.random() < 0.5;
    this.playerColor = this.playerFirst ? BLACK : WHITE;
    this.turn = BLACK;
    this.dom.again.hidden = true;
    this.dom.resign.hidden = false;
    this.dom.resign.disabled = false;
    this.dom.board.classList.remove('is-over');
    this.dom.stones.innerHTML = '';
    this.setTip('开局，' + (this.playerFirst ? '你执黑先手' : `${this.dom.aiName.textContent}执黑先手`));
    this.renderAll();
    if (!this.playerFirst) this.scheduleAi();
  }

  renderAll() {
    this.renderStones();
    const moves = moveCount(this.board);
    this.dom.moves.textContent = String(moves);
    const mine = this.turn === this.playerColor;
    this.dom.turn.textContent = this.over ? '本局结束' : (mine ? '轮到你' : '对手思考中');
    this.dom.meColor.textContent = this.playerColor === BLACK ? '执黑' : '执白';
    this.dom.aiColor.textContent = this.playerColor === BLACK ? '执白' : '执黑';
    this.dom.meColor.dataset.color = this.playerColor === BLACK ? 'black' : 'white';
    this.dom.aiColor.dataset.color = this.playerColor === BLACK ? 'white' : 'black';
    this.dom.meColor.title = this.playerColor === BLACK ? '你是先手（黑）' : '你是后手（白）';
    this.dom.aiColor.title = this.playerColor === BLACK ? '对手是后手（白）' : '对手是先手（黑）';
  }

  renderStones() {
    const box = this.dom.stones;
    box.innerHTML = '';
    const win = this.winLine || [];
    const winSet = new Set(win.map((p) => `${p.x},${p.y}`));
    /**
     * ★ 用户报的 bug：有时候看不到对方刚下的是哪一手。
     *   原因是"最后一颗"用的是 `box.lastElementChild` —— 但这里是**按 y/x 扫描顺序**
     *   把棋子塞进 DOM 的，最后一个元素是"最靠右下角的那颗"，不是最后下的那颗。
     *   改成从 `history` 里取真正的最后一手来打标记。
     */
    const lastMove = Array.isArray(this.history) && this.history.length
      ? this.history[this.history.length - 1]
      : null;
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const v = this.board[y][x];
        if (!v) continue;
        const el = document.createElement('div');
        el.className = `gmk-stone is-${v === BLACK ? 'black' : 'white'}`;
        el.style.left = `${posOf(x)}%`;
        el.style.top = `${posOf(y)}%`;
        if (winSet.has(`${x},${y}`)) el.classList.add('is-win');
        if (lastMove && lastMove.x === x && lastMove.y === y) el.classList.add('is-last');
        box.append(el);
      }
    }
  }

  /** 玩家点格子 */
  onCell(x, y) {
    if (this.over || this.thinking) return;
    if (this.turn !== this.playerColor) return;
    if (!this.canPlace(x, y)) return;
    this.play(x, y, this.playerColor);
  }

  canPlace(x, y) {
    return !!this.board && this.board[y] && this.board[y][x] === 0;
  }

  /** 落一手（玩家与 AI 共用），落完判断胜负并换手 */
  play(x, y, who) {
    if (!place(this.board, x, y, who)) return false;
    this.history.push({ x, y, who });
    audio.play('select');
    const win = checkWinAt(this.board, x, y);
    this.renderAll();
    if (win) { this.finish(win.who === this.playerColor ? 'player' : 'ai', win.line); return true; }
    if (isFull(this.board)) { this.finish('draw'); return true; }
    this.turn = other(who);
    this.renderAll();
    if (this.turn !== this.playerColor) this.scheduleAi();
    else this.maybeSpeak();
    return true;
  }

  /**
   * 过程中的碎嘴（用户要求"AI 要真的接进来"）：
   *   · AI 刚下完一手（这一手是进攻还是防守）→ 有概率说一句
   *   · 玩家刚落子 → 有概率评价一句（不失礼，不像连珠炮）
   * 说话频率由 minGap 兜着，不会刷屏。
   */
  maybeSpeak() {
    if (!this.app.aiEnabled || this.over) return;
    const last = this.history[this.history.length - 1];
    if (!last) return;
    const mine = last.who !== this.playerColor;
    // 每手都有 45% 的概率说一句（真实的"偶尔搭个话"）
    if (Math.random() > 0.45) return;
    const why = this.lastReason || '';
    if (mine) {
      // 它自己这手：做了活三 / 拦了对方 / 平平无奇
      const scene = why === 'make-open-three' || why === 'make-open-four' || why === 'five' ? 'playBig'
        : why === 'block-four' || why === 'block-five' ? 'suppress' : 'playSmall';
      this.app.gomokuSpeak(scene, { mine: why === 'block-five' || why === 'block-four' ? '刚才这手是拦玩家的' : '' });
      return;
    }
    // 玩家这手：夸一句 / 催一下 / 装淡定
    const scene = Math.random() < 0.4 ? 'praised' : 'idle';
    this.app.gomokuSpeak(scene, { playerText: '' });
  }

  /** AI 想一会儿再落子（难度越高想得越久一点点，但差别不大） */
  scheduleAi() {
    if (this.over || !this.alive) return;
    this.thinking = true;
    const rank = levelIndex(this.level);
    const base = GOMOKU.thinkMinMs + Math.random() * (GOMOKU.thinkMaxMs - GOMOKU.thinkMinMs);
    const wait = Math.round(base + Math.max(0, rank) * 120);
    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      if (!this.alive || this.over) { this.thinking = false; return; }
      const mv = pickMove(this.board, this.turn, this.level);
      this.thinking = false;
      if (!mv) { this.finish('draw'); return; }
      this.lastReason = mv.reason; // 记一手"这手是进攻还是防守"，用来挑台词
      this.play(mv.x, mv.y, this.turn);
    }, wait);
  }

  /** 认输：直接判负（正常结算，好感度照给） */
  resign() {
    if (this.over) return;
    toast('你认输了这局');
    this.finish('ai');
  }

  /**
   * 一局结束
   * @param {'player'|'ai'|'draw'} winner
   * @param {{x:number,y:number}[]} [line] 赢的那五子（高亮用）
   */
  finish(winner, line = null) {
    this.over = true;
    this.thinking = false;
    this.winner = winner; // 'player' | 'ai' | 'draw'：提示词视图要用它说"这盘谁赢了"
    this.winLine = line || [];
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    const moves = moveCount(this.board);
    if (winner === 'player') this.wins += 1;
    else if (winner === 'ai') this.losses += 1;
    this.dom.resign.hidden = true;
    this.dom.again.hidden = false;
    this.dom.board.classList.add('is-over');
    this.renderAll();

    const head = winner === 'draw' ? '平局！' : winner === 'player' ? '你赢了！' : '你输了';
    const tail = `（本次共 ${this.wins} 胜 ${this.losses} 负）`;
    this.setTip(`${head}　共 ${moves} 手　这局不涉及开心豆 ${tail}`);
    floatText(winner === 'player' ? '⚫ 五连！' : winner === 'draw' ? '⚫ 平局' : '⚫ 惜败', '50%', '36%');
    audio.play(winner === 'player' ? 'win' : winner === 'draw' ? 'pass' : 'lose');

    // 对手说一句（赢了得瑟 / 输了服气）；这是棋局结束的那一句，允许插队
    this.app.gomokuSpeak(winner === 'player' ? 'lose' : winner === 'ai' ? 'win' : 'idle', {
      priority: true, forceSituation: true,
    });

    // 结算：不加豆、只加好感度 + 写对局记忆（AI 模式且有真人设时）
    if (this.app.aiEnabled && this.persona) {
      this.app.rewardGomokuFriend(this.persona);
      this.app.recordGomokuMemory({
        winner, first: this.playerFirst ? 'player' : 'ai', moves, room: this.room, persona: this.persona,
      });
    }
    /**
     * ★ 里程碑（用户拍板）：赢「普通」难度 → 下棋爱好者；赢最高难度 → 妙手。
     *   难度值来自 `data/gomokuLevels.js` 的内部五档（**界面一个字都不显示**，
     *   见 tools/test-gomoku.mjs 里那条"难度是隐性的"约束 —— 所以这里只做数值比较）。
     */
    if (winner === 'player' && typeof this.app.flagMilestone === 'function') {
      const lv = levelIndex(this.level);
      if (lv >= 2) this.app.flagMilestone('gomokuNormal'); // 中档起算
      if (lv >= 4) this.app.flagMilestone('gomokuMaster'); // 最高档
    }
    this.app.persist('gomoku');
    // ★ 好友搭话前要等"这局的对局记忆"写完（见 app.playedHandForPing）：
    //   recordGomokuMemory 已经把任务记在 app.matchWrite 上了，这里不用 await
    void this.app.pingFriendsAfterGame();

    const self = this;
    setTimeout(() => {
      if (self.app.gomoku !== self || !self.over) return; // 期间又开了新的一局
      panels.showGomokuResult(this.app, {
        winner,
        moves,
        room: self.room,
        persona: self.persona,
        level: self.level,
        playerFirst: self.playerFirst,
        wins: self.wins,
        losses: self.losses,
        affinity: this.app.aiEnabled && self.persona ? GOMOKU.affinityPerGame : 0,
        onAgain: () => self.startRound(),
        onQuit: () => self.app.quitGomoku(),
      });
    }, winner === 'draw' ? 700 : 900);
  }

  setTip(text) { if (this.dom.tip) this.dom.tip.textContent = text; }
}

