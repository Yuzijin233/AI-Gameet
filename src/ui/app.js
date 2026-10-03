/**
 * 应用外壳：状态、路由、存档、AI 编排（PRD §2.1 §2.8 §5-Q4 §7.4）
 */
import { CONFIG, ROOMS, DEFAULT_SETTINGS, FISHING_ROOMS, FISHING, DANMAKU, ECON, ITEMS, AI_ECON, MATCH, FRIEND, INVITE, RETURN_PING, GROUP_IDLE, MOMENT_FEED, MOMENTS, ONLINE_MOMENT } from '../config.js';
import { loadSave, writeSave, defaultSave, RECENT_HANDS, pullSaveFromServer, pushSaveNow } from '../store/storage.js';
import { Economy } from '../store/economy.js';
import { PERSONAS } from '../data/personas.js';
import { ASSETS } from '../../assets/manifest.js';
import { randomNickname } from '../data/nicknames.js';
import { handToString } from '../core/cards.js';
import { ChatBrain } from '../ai/chat.js';
import { buildSituation, pickScene } from '../ai/scene.js';
import {
  bombPlan, bombBrief, springPlan, springBrief, greetingPlan, metFriendBrief, metAgainBrief,
} from '../ai/events.js';
import { Game } from '../game/engine.js';
import { Particles, toast, floatText } from './fx.js';
import { audio } from './audio.js';
import { setTextureEnabled } from './cardsView.js';
import { renderLobby } from './lobby.js';
import { TableController } from './table.js';
import { FishingTable } from './fishing.js';
import { GomokuTable } from './gomoku.js';
import { levelOfPersona, pickByRoom, botLevelOfRoom } from '../data/gomokuLevels.js';
import { moveCount } from '../core/gomoku.js';
import { GOMOKU, GOMOKU_ROOMS } from '../config.js';
import { renderTitleBadge } from './titles.js';
import { syncBeanTitles, equippedTitle, awardTitle } from '../store/titles.js';
import {
  ensureAiEcon, aiBeansOf, aiTitleOf, pickEligiblePersonas, topUpForRoom,
  applyAiSettlement, pulseIdleAi, grantAiRelief, addAiBeans,
} from '../store/aiBeans.js';
import { ensureItems, toolLeft, consumeItem } from '../store/items.js';
import {
  listFriends, findFriend, isFriend, appendChat, bumpUnread, clearUnread, unreadTotal, addMatchMemory, adjustAffinity,
  addMemory, setSelfMemories, canConfess, canBreakup, setLover, breakUp, isLover, friendContextLines, refuseConfess,
  ensureOwnership, memoryNeedsCompress, listFriendsNeedingCompress, applyCompressedMemory,
  addMomentMemory, syncFriendIdentities, addRenameMemory, callNameOf, bumpPendingPing, canPingPlayer,
  pickPingTargets,
} from '../store/friends.js';
import {
  applyAiNames, renameAi, resetAiNames, renameMemoryLine, aiNameOf, ensureAiNames,
} from '../store/aiNames.js';
import { groupUnreadTotal } from '../store/groups.js';
import {
  findMoment, findMomentComment, toggleMomentLike, hasLiked, addMomentComment, recentMomentComments, ensureMoments,
  addMoment, addMomentLike, listMoments,
} from '../store/moments.js';
import {
  chooseCommenters, momentComment, commentSchedule, replyDelayMs, momentPost, localMomentComment, pickMomentScene,
} from '../ai/moments.js';
import { proactiveMessage, analyzeMessage, compressMemory, reviewConfess } from '../ai/friend.js';
import {
  summarizeMatch, fitSummary, ddzFacts, fishingFacts, gomokuFacts, MODE_NAME, ensureModeNamed,
} from '../ai/matchSummary.js';
import { fishingView } from '../ai/fishingView.js';
import { gomokuView } from '../ai/gomokuView.js';
// 注意：斗地主出牌已经不走大模型了（见下面 decideAiPlay）——
// `ai/playBrain.js` 的 decidePlayWithLLM 保留着并有自己的单测，只是不再被本文件 import。
import { danmakuLine, pickSpeaker, danmakuReplyDelay, danmakuSituationText } from '../ai/danmaku.js';
import { DanmakuLayer } from './danmaku.js';
import * as panels from './panels.js';
import * as friendsPanel from './friends.js';
import { openActivity } from './activity.js';
import { openRank } from './rank.js';
import { openMail } from './mailbox.js';
import { openProfile } from './profile.js';
import { openSetup } from './setup.js';
import { showInvite } from './invite.js';
import {
  canInviteNow, pickHostAndOther, pickInviteTarget, nextInviteGapMs, nextStartDelayMs,
  inviteTargetText, setInviteMuted,
} from '../store/invite.js';
import { cleanPlayerName, needsProfileSetup, playerGenderLine, playerIdentityLines } from '../data/player.js';
// ★ 离线补发：按人设在他不在的那段时间里模拟一个"发送时刻"
import { simulatedSendAt } from '../data/clock.js';
// ★ 离线补群聊（超过 20 分钟 → 群里 AI 连着聊 5~10 条，计入未读）
import { scheduleReturnGroupChat } from './returnGroup.js';
import { giftOptionsForAi, aiGiftsLeft, sendGiftToPlayer } from '../store/gifts.js';
import { aiGiftLine } from '../data/giftLines.js';
import { ensureActivity, activityOverview } from '../store/activity.js';
import { ensureCosmetics, frameClassOf, themeNameOf } from '../store/cosmetics.js';
import { claimableMailCount, unreadMailCount, pruneMail } from '../store/rewards.js';
// ★ 玩家头像：**上传的照片优先**（`save.avatar` 只是没上传时的预设 id）——
//   匹配动画 / 座位原来直接用了 save.avatar，所以上传过照片的玩家在这儿会显示默认头像
import { playerAvatarSrc } from '../data/avatar.js';

/** 等一会儿（友圈回复要空 3~10s，模拟真人看到消息再打字） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


class App {
  constructor() {
    const { save, fresh, corrupted } = loadSave();
    this.save = save;
    this.fresh = fresh;
    this.corrupted = corrupted;
    this.economy = new Economy(save, (reason) => this.persist(reason));
    this.mode = 'ai';
    this.chatLog = [];
    this.chatRenderers = new Set();
    this.friendRenderers = new Set();
    /**
     * 拍一拍的节流表（用户拍板：双击头像拍一拍，同一个人 4 秒内只生效一次）。
     * 键 = personaId，值 = 上次真的拍到的时刻。
     * 挂在 app 上（不是面板闭包）——关掉社交面板再打开，节流仍然有效。
     * 见 src/ai/nudge.js 的 allowNudge()。
     */
    this.nudgeAt = new Map();
    this.danmaku = new DanmakuLayer();
    this.danmakuTimer = null;
    this.danmakuActive = false;
    this.lastDanmakuSpeaker = null;
    this.danmakuKickoffTimer = null; // 开场 5s 静默计时
    this.danmakuReplyTimer = null; // 玩家发弹幕后的"真人打字"延迟
    this.danmakuPlayerSpoke = false;
    this.danmakuAiSpoke = false;
    this.roomDanmakuSeats = []; // 房间界面里已邀请的好友 id（决定弹幕说话人）
    this.roomNeedFriends = null; // 当前房间需要几位好友（弹幕提示词里要报"还缺几个"）
    /**
     * ★ 在线定时发友圈（用户拍板，见 ONLINE_MOMENT）：
     *   · onlineMomentOn = 这个会话要不要安排（切后台 / 退出登录界面 / 进牌桌时停）
     *   · onlineMomentTimer = 当前那一个 setTimeout（收尾时要清）
     *   · onlineMomentSkips = 连着跳过了几次（一直不满足条件就收手，别空转）
     */
    this.onlineMomentOn = false;
    this.onlineMomentTimer = null;
    this.onlineMomentSkips = 0;
    this.toolUsed = {}; // 本局每种道具用了几次（上限 CONFIG.toolPerHand）
    this.seatPersonas = [null, null]; // 这一局两个对手的人设（机器模式为 null）
    this.lastAiChanges = null;
    this.urgentSaid = new Set();
    this.seatNames = ['你', '下家', '上家'];
    this.seatAvatars = ['avatar_01', 'avatar_02', 'avatar_03'];
    this.game = null;
    this.table = null;
    this.fishing = null;
    this.gameKind = 'ddz'; // 'ddz' | 'fishing' | 'gomoku'
    /**
     * ★ 「这一局」写对局记忆的任务（异步：要等模型写 50~100 字概括）。
     *   开局时清空、结束时赋值。好友主动搭话**必须等它**再决定"刚打完的是哪一局"——
     *   以前不等，于是刚下完五子棋，好友来聊的却是上一局的小猫钓鱼（用户报的 bug）。
     */
    this.matchWrite = null;
    this.lobbyGame = 'ddz'; // 大厅里当前选中的游戏
    this.currentFishRoom = FISHING_ROOMS[0];
    this.fishAvatar = 'avatar_05';
    this.particles = null;
    this.currentRoom = null;

    if (!this.save.nickname) this.save.nickname = randomNickname();

    this.chat = new ChatBrain({
      getView: (seat, scene, extra) => this.viewFor(seat, scene, extra),
      onLine: (seat, text) => this.onAiLine(seat, text),
      onMode: (mode) => this.onAiMode(mode),
    });
  }

  get playerName() { return this.save.nickname || '玩家'; }

  /** AI 模式与房间模式都要让对手说话；只有机器模式闭嘴 */
  get aiEnabled() { return this.mode !== 'bot'; }

  /**
   * AI 出牌决策（★ 用户拍板：**出牌一律走规则引擎**，大模型只负责说话）
   * ------------------------------------------------------------------
   *  - 出牌：core/bot.js 的 choosePlay —— 从**合法牌型**里按这个人设的**牌技档位**
   *    （data/ddzLevels.js：新手 / 熟练 / 高手 / 大师）打分挑牌，四档强度不同；
   *  - 说话：还是老那套（ai/scene.js 决定说不说、ai/chat.js 生成台词），一个字没动。
   *
   *  为什么改：以前这里是"先问大模型出哪几张牌、失败/超时才退回引擎"，
   *  那正是 AI 打得蠢的原因（模型经常出次优牌，还得等十几秒）。
   *  decidePlayWithLLM 本身保留在 ai/playBrain.js（单测还在跑它），只是斗地主不再调用。
   *  假装思考的 1~5 秒延迟在 ui/table.js 里（thinkDelay），不在这个函数里。
   */
  async decideAiPlay(seat) {
    const g = this.game;
    if (!g) return null;
    const play = g.decidePlay(seat);
    this.lastPlayDecision = { play, source: 'engine' }; // 保留原来的字段，方便调试
    return play;
  }

  /** 房间模式：对手用弹幕交流，且可邀请好友 */
  get isRoomMode() { return this.mode === 'room'; }

  /* ------------------------------ 房间弹幕 ------------------------------ */
  /**
   * 房间里已邀请的好友（邀请顺序 = 座位顺序）。
   * 弹幕只在"房间/等人"界面里飘，说话人只取自这里，和牌局无关。
   */
  get roomSeatPersonas() {
    return (this.roomDanmakuSeats || [])
      .map((id) => PERSONAS.find((p) => p.id === id))
      .filter(Boolean);
  }

  startDanmaku(containerId) {
    this.stopDanmaku();
    const el = document.getElementById(containerId);
    if (!el) return;
    this.danmaku.mount(el);
    this.danmakuActive = true;
    this.danmakuPlayerSpoke = false;
    this.danmakuAiSpoke = false;
    this.refreshDanmakuTimer();
  }

  stopDanmaku() {
    this.danmakuActive = false;
    this.lastDanmakuSpeaker = null;
    if (this.danmakuTimer) { clearTimeout(this.danmakuTimer); this.danmakuTimer = null; }
    if (this.danmakuKickoffTimer) { clearTimeout(this.danmakuKickoffTimer); this.danmakuKickoffTimer = null; }
    if (this.danmakuReplyTimer) { clearTimeout(this.danmakuReplyTimer); this.danmakuReplyTimer = null; }
    this.danmaku.unmount();
  }

  /**
   * 房间人数变化后重排定时器
   *  - 2 个好友：两人自己就能聊起来（3~5 秒一条）
   *  - 1 个好友：平时不主动发，但**开场 5 秒玩家不说话时它会先开口**
   */
  refreshDanmakuTimer() {
    if (this.danmakuTimer) { clearTimeout(this.danmakuTimer); this.danmakuTimer = null; }
    if (!this.danmakuActive) return;
    if (this.roomSeatPersonas.length >= 2) this.scheduleDanmaku();
    this.armDanmakuKickoff();
  }

  /** 开场兜底：进房后玩家 5 秒不发弹幕，就让 AI 先开口（1 个好友也会开口） */
  armDanmakuKickoff() {
    if (this.danmakuKickoffTimer) { clearTimeout(this.danmakuKickoffTimer); this.danmakuKickoffTimer = null; }
    if (!this.danmakuActive) return;
    if (this.danmakuPlayerSpoke || this.danmakuAiSpoke) return;
    if (!this.roomSeatPersonas.length) return; // 还没人入座，等有人了再重新武装
    this.danmakuKickoffTimer = setTimeout(() => {
      this.danmakuKickoffTimer = null;
      if (!this.danmakuActive || this.danmakuPlayerSpoke || this.danmakuAiSpoke) return;
      if (!this.roomSeatPersonas.length) return;
      void this.emitAiDanmaku(null, { opener: true });
    }, DANMAKU.kickoffGap);
  }

  /** 玩家发完弹幕：AI 先"打字" 3~5 秒再回（真人延迟） */
  scheduleDanmakuReply(text) {
    if (this.danmakuReplyTimer) { clearTimeout(this.danmakuReplyTimer); this.danmakuReplyTimer = null; }
    // 自动聊天的那一条往后让一让，别和回复挤在一起
    if (this.danmakuTimer) { clearTimeout(this.danmakuTimer); this.danmakuTimer = null; }
    const gap = danmakuReplyDelay();
    this.danmakuReplyTimer = setTimeout(() => {
      this.danmakuReplyTimer = null;
      if (!this.danmakuActive) return;
      void this.emitAiDanmaku(text).then(() => {
        if (this.danmakuActive) this.refreshDanmakuTimer();
      });
    }, gap);
  }

  /**
   * 聊完一句之后的"沉淀"：好感度 / memory / 自设 / 表白 / 分手
   *
   * **只有私聊走这里**（房间弹幕只读不写，见 emitAiDanmaku）。
   * 读写的是同一个 `friend` 记录，所以私聊记下的东西房间那边也看得到。
   * @param {string} personaId
   * @param {{text:string, reply:string}} payload 玩家说的话 + AI 回的那句
   */
  async settleFriendChat(personaId, { text, reply }) {
    const persona = PERSONAS.find((p) => p.id === personaId);
    const friend = findFriend(this.save, personaId);
    if (!persona || !friend) return null;
    // 表白 / 分手只在满足条件时才让模型顺便审一下
    const allowConfess = canConfess(this.save, friend);
    const askBreakup = canBreakup(this.save, friend);
    /**
     * ★ 送礼（用户要求：审查 AI 多判一层"这次要不要送点什么"，送礼是 AI 可执行的操作）
     *   清单是"关系够 + 今天还有次数 + 它自己买得起"筛出来的 —— 不可能强行送最贵的。
     */
    const giftOptions = giftOptionsForAi(this.save, personaId);
    const giftLeft = aiGiftsLeft(this.save, personaId);
    const res = await analyzeMessage({
      persona, friend, text, reply, allowConfess, askBreakup,
      // 玩家昵称：用来挡住"自设：称呼对方=玩家的名字"这类假自设
      playerName: this.playerName,
      giftOptions, giftLeft, myBeans: aiBeansOf(this.save, personaId),
    });
    if (!res) return null;
    if (res.delta) adjustAffinity(this.save, personaId, res.delta);
    if (res.memory) addMemory(this.save, personaId, res.memory);
    // 它自己顺口补充的"人设里没写"的设定：记下来，下次不能矛盾
    if (res.self) setSelfMemories(this.save, personaId, res.self);
    // ★ 它决定回赠一件礼物：从它身家里扣钱，东西进玩家库存（牌桌上能当道具用）
    if (res.gift) {
      const sent = sendGiftToPlayer(this.save, personaId, res.gift);
      if (sent.ok) {
        appendChat(this.save, personaId, 'ai', aiGiftLine(persona, sent.gift), { gift: sent.gift });
        setTimeout(() => {
          audio.play('coin');
          toast(`🎁 「${persona.name}」送了你 ${sent.gift.emoji}${sent.gift.name}（已进你的道具库存）`, 'gold');
        }, 700);
      }
    }

    /**
     * ★ 表白（用户拍板的口径：**不让 AI 自由婉拒**，按三条硬规则判）
     *   ① 必须异性  ② 它必须单身（之前聊过"有对象"就不算；**没提过视为单身**）
     *   ③ 它没有明确拒绝（傲娇的嘴硬否认不算拒绝）
     *   三条都过 → 同意（成为恋人）；否则按原因给出提示，并**扣 10 好感**
     */
    if (allowConfess && res.confess) {
      // 前置条件：还没有恋人（全局只能有一个，已经有了就不再换人）
      const canSet = !this.save.loverId || this.save.loverId === personaId;
      const verdict = reviewConfess({
        persona,
        playerGender: this.save.gender,
        friend: findFriend(this.save, personaId),
        reply,
      });
      if (verdict.accept && canSet) {
        setLover(this.save, personaId);
        addMemory(this.save, personaId, '关系：和玩家成了恋人');
        audio.play('win');
        toast(`💞 「${persona.name}」答应你了 —— 你们现在是恋人`, 'gold');
        /**
         * ★ 用户拍板：**刚确定关系，恋人自己也会发一条友圈**（含蓄、不指名道姓），
         *   随后其他好友陆续来点赞 + 评论（评论不含恋人自己）。
         *   不 await：它要调模型，不能挡着聊天结算；失败也只是没有这条动态。
         */
        void this.deliverLoverMoment(personaId);
        // ★ 第一次成为恋人 → 称号「神仙眷侣」（用户拍板）
        const got = awardTitle(this.save, 't_lovers');
        if (got.isNew) {
          setTimeout(() => {
            audio.play('coin');
            toast(`🏅 获得称号「${got.title.name}」：${got.title.desc}`, 'gold');
          }, 900);
        }
      } else {
        // 没成：好感 -10（退回 90，想再表白得重新刷满）
        const r = refuseConfess(this.save, personaId);
        audio.play('pass');
        const why = verdict.reason === 'same-gender' ? '把你当同性朋友，没往那方面想'
          : verdict.reason === 'has-partner' ? '心里已经有人了'
            : '婉拒了你的表白';
        toast(`💔 「${persona.name}」${why} —— 好感 -${r.penalty}（现在 ${r.affinity}），`
          + '想再试就要先把好感刷回来', 'bad');
      }
    } else if (askBreakup && res.breakup && breakUp(this.save, personaId).ok) {
      addMemory(this.save, personaId, '关系：和玩家分开了，还是朋友');
      audio.play('lose');
      toast(`💔 你和「${persona.name}」分手了，关系回到「朋友」`, 'bad');
    }
    /**
     * ★ 改名（用户拍板）：审查判定"真的聊到改名、而且它自己答应了"才会走到这里。
     *   改完把自己从旧名改成新名写进记忆（多次改名 → 「旧名→新名，又改名更新的名」）。
     */
    if (res.rename) this.applyRename(personaId, res.rename);
    this.persist('settleChat');
    this.refreshLobby();
    // 记忆写满 16 条了？→ 让 AI 把相似的合并（不丢最旧的），不挡聊天
    void this.compressMemoryIfNeeded(personaId);
    return res;
  }

  /**
   * AI 改名落地：改数据 → 写记忆 → 刷各处显示
   *   · 名字贴回 PERSONAS（界面 / 提示词 / 牌桌都读它）+ 刷新好友记录里的名字副本
   *   · 记忆：`改名：旧名→新名`（再改就接着写「又改名…」，始终是同一条）
   * @returns {{ok:boolean, from?:string, to?:string, reason?:string}}
   */
  applyRename(personaId, newName) {
    const res = renameAi(this.save, personaId, newName, { playerName: this.playerName });
    if (!res.ok) return res;
    addRenameMemory(this.save, personaId, renameMemoryLine(this.save, personaId));
    syncFriendIdentities(this.save);
    this.persist('aiRename');
    audio.play('select');
    toast(`「${res.from}」改名了 —— 以后叫「${res.to}」`, 'gold');
    this.refreshLobby();
    this.refreshFriendsPanel();
    return res;
  }

  /**
   * 记忆超上限 → 让 AI 把相似的合并成一条（对局记忆不动）
   * 例：`偏好：喝奶茶` + `偏好：爱吃辣` → `偏好：喝奶茶、爱吃辣`
   * 模型不可用时用本地合并兜底（见 data/memory.js 的 mergeMemoryLocally）。
   */
  async compressMemoryIfNeeded(personaId) {
    const f = findFriend(this.save, personaId);
    if (!f || !memoryNeedsCompress(f)) return null;
    const persona = PERSONAS.find((p) => p.id === personaId) || null;
    const { memory, source } = await compressMemory({ persona, friend: f });
    if (!Array.isArray(memory) || !memory.length) return null;
    const res = applyCompressedMemory(findFriend(this.save, personaId), memory);
    if (!res) return null;
    this.persist('memoryCompress');
    this.refreshFriendsPanel();
    console.debug(`[memory] ${persona ? persona.name : personaId} 记忆合并：${res.before} → ${res.after} 条（${source}）`);
    return { ...res, source };
  }

  /** 启动时扫一遍：老存档里超上限的、或上次没合完的，顺手合并 */
  async compressAllMemories() {
    for (const f of listFriendsNeedingCompress(this.save)) {
      // eslint-disable-next-line no-await-in-loop
      await this.compressMemoryIfNeeded(f.personaId);
    }
  }

  /** 3~5 秒一条 */
  scheduleDanmaku() {
    if (!this.danmakuActive) return;
    const gap = DANMAKU.minGap + Math.random() * (DANMAKU.maxGap - DANMAKU.minGap);
    this.danmakuTimer = setTimeout(async () => {
      if (!this.danmakuActive) return;
      await this.emitAiDanmaku();
      this.scheduleDanmaku();
    }, gap);
  }

  /** 让房间里某位好友发一条弹幕（两个 AI 互相接话，避免连续同一个人） */
  async emitAiDanmaku(target, { opener = false } = {}) {
    if (!this.danmakuActive) return;
    const personas = this.roomSeatPersonas;
    let seat;
    if (personas.length >= 2) seat = pickSpeaker([1, 2], this.lastDanmakuSpeaker);
    else if (personas.length === 1 && (target || opener)) seat = 1; // 开场第一句 / 玩家搭话
    else return; // 只有一个好友且玩家没开口：不主动发
    if (seat == null) return;

    const persona = personas[seat - 1];
    if (!persona) return;
    this.lastDanmakuSpeaker = seat;
    const friend = findFriend(this.save, persona.id);
    const title = equippedTitle(this.save);
    const { text } = await danmakuLine({
      persona,
      friend,
      situation: this.danmakuSituation(),
      recent: this.danmaku.recentLines(),
      target,
      opener,
      // 恋人关系也要共享：房间里不能把它当普通朋友
      lover: isLover(this.save, persona.id),
      // 名字与称号都只作背景知识：聊天要围绕人和游戏，不要围着称号做文章
      playerName: this.playerName,
      playerTitle: title ? title.name : '',
      // 玩家性别：别把称呼叫错（见 data/player.js）
      playerGender: playerGenderLine(this.save),
      // ★ 玩家是谁：整段背景知识（昵称 + 性别 + 该怎么叫他），别回头问"你是谁"
      playerIdentity: playerIdentityLines(this.save, { callName: callNameOf(friend), selfId: persona.id }),
      // ★ 它自己的身家与称号（实时现算；背景知识，房间弹幕里也不许围着称号做文章）
      myBeans: aiBeansOf(this.save, persona.id),
      myTitle: (aiTitleOf(this.save, persona.id) || {}).name || '',
    });
    if (!text || !this.danmakuActive) return;
    this.danmakuAiSpoke = true;
    this.danmaku.push({ seat, name: persona.name, text });
    // 注意：房间弹幕**只读不写** —— 它能读到记忆和好感度（上面传了 friend / lover），
    // 但**不写记忆、也不动好感度**。要不要沉淀只由私聊那条路决定（见 settleFriendChat）。
  }

  /** 弹幕提示词里的场景：房间里的人 + 还缺几个（背景知识，不是话题本身） */
  danmakuSituation() {
    return danmakuSituationText({
      seated: this.roomSeatPersonas.length,
      needFriends: this.roomNeedFriends != null
        ? this.roomNeedFriends
        : (this.gameKind === 'fishing' ? 1 : 2),
      game: this.lobbyGame,
    });
  }

  /** 玩家在房间里发一条弹幕：自己飘一条，AI 打字 3~5 秒后接话 */
  sendRoomDanmaku(text) {
    const t = String(text || '').trim().slice(0, DANMAKU.maxChars);
    if (!t) return;
    this.danmaku.push({ seat: 0, name: this.playerName, text: t, self: true });
    this.danmakuPlayerSpoke = true;
    if (this.danmakuKickoffTimer) { clearTimeout(this.danmakuKickoffTimer); this.danmakuKickoffTimer = null; }
    this.scheduleDanmakuReply(t);
  }

  /* ------------------------------ 启动 ------------------------------ */
  /**
   * 启动前先问问本地服务要一份存档（save/ddz_save.json）：
   *   · 浏览器存档没了（换浏览器 / 清了数据）→ 直接用文件里的，进度不丢
   *   · 文件比浏览器里的新（手改过文件）→ 用文件里的
   * 全程失败都不影响启动，拿不到就照旧用 localStorage 那份。
   */
  async prepareSave() {
    try {
      const res = await pullSaveFromServer(this.save, { localFresh: this.fresh });
      if (res && res.restored && res.save) {
        this.save = res.save;
        this.economy = new Economy(this.save, (reason) => this.persist(reason));
        this.restoredFromFile = true;
        this.fresh = false;
      }
    } catch (err) {
      console.warn('[save] 本地文件读取失败（继续用浏览器存档）：', err);
    }
  }

  boot() {
    this.applySettings();
    /**
     * ★ 离线多久了？（用户拍板：超过 2 分钟 → 随机 1~3 位好友来打招呼）
     *   要在写入新的 lastSeenAt 之前读，否则永远是 0。
     */
    const awayMs = Number.isFinite(this.save.lastSeenAt) && this.save.lastSeenAt > 0
      ? Math.max(0, Date.now() - this.save.lastSeenAt)
      : 0;
    this.save.lastSeenAt = Date.now();
    this.particles = new Particles(document.getElementById('particles'));
    this.particles.setSpeed(CONFIG.animSpeed[this.save.settings.animSpeed] > 0 ? 1 : 0);
    // AI 身家：首次读取时按幂律分配（小身家多），并给穷到没法玩的 AI 发今天的低保
    ensureAiEcon(this.save);
    ensureItems(this.save);
    ensureActivity(this.save);
    ensureCosmetics(this.save);
    ensureMoments(this.save);
    // 老存档里可能把"AI 自己说的"记到了玩家名下（例如 身份：山东临沂人）
    // → 拿聊天记录当证据搬回自设，免得它下次把自己的老家说成玩家的
    this.ownershipFixed = ensureOwnership(this.save);
    /**
     * AI 改过的名字：先把存档里的自定义名字贴回人设（界面、提示词、牌桌都读它），
     * 再把好友记录里那份名字副本刷一遍（老存档才不会显示旧名字）
     */
    ensureAiNames(this.save);
    applyAiNames(this.save);
    this.identitiesSynced = syncFriendIdentities(this.save);
    pruneMail(this.save);
    const relief = grantAiRelief(this.save);
    const got = syncBeanTitles(this.save);
    writeSave(this.save);
    renderLobby(this);
    this.bindGlobal();
    this.refreshTitles();
    this.updateFriendDot();
    this.updateMailDot();
    this.updateActivityDot();
    this.applyFrameClass();
    if (got.length) setTimeout(() => toast(`解锁称号：${got[got.length - 1].name}`, 'gold'), 1500);
    if (relief.length) setTimeout(() => toast(`${relief.length} 位 AI 领了低保 💰${AI_ECON.reliefBeans.toLocaleString()}`, 'good'), 2200);
    if (this.corrupted) toast('存档已损坏，已重置并补发新手豆', 'bad');
    // 分发包里 Key 是空的：提醒一句怎么填（填上之后 AI 才会真的开口）
    if (!CONFIG.apiKey) {
      setTimeout(() => toast('还没填 DeepSeek API Key：AI 会先用本地语气兜底，点右上角「⚙️ 设置」里填上', 'bad'), 600);
    }
    // AI 邀请打牌：先记一次"活跃时间"，之后只在主界面发呆够久才会被邀请
    this.lastActivityAt = Date.now();
    this.bindIdleTracking();
    this.bindAwayTracking();
    this.scheduleInviteCheck();
    // 离线回来（超过 2 分钟）→ 随机 1~3 位好友主动来打招呼
    this.scheduleReturnPing(awayMs);
    // 离线更久（超过 20 分钟）→ 好友还会**自己发友圈**（带赞与共同好友的评论）
    this.scheduleReturnMoments(awayMs);
    // 同样超过 20 分钟 → 随机挑一个群，让群里的 AI **连着聊 5~10 条**（计入未读，见 returnGroup.js）
    scheduleReturnGroupChat(this, awayMs);
    /**
     * ★ 在线期间也会自己发友圈（用户拍板，见 ONLINE_MOMENT）：
     *   好友 > 2 人时，每 10~30 分钟随机让一位好友发一条（吐槽游戏 / 吐槽生活 / 分享心情），
     *   带随机点赞 + 1~3 条共同好友评论（评论之间只错开 1~3 秒）。
     *   切后台 / 退出登录界面 / 进牌桌 / 会话结束都会把它停下来（见 stopOnlineMoments）。
     */
    this.startOnlineMoments();
    this.bindOnlineMomentTracking();
    if (this.restoredFromFile) {
      setTimeout(() => toast('已从 save/ddz_save.json 恢复存档（AI 记忆也在 save/AI记忆.md）', 'good'), 900);
    }
    // 进去之后把当前存档（含记忆）镜像成文件：save/ddz_save.json + save/AI记忆.md
    void pushSaveNow(this.save);
    // 记忆超过 16 条的老存档：启动后慢慢合并（AI 优先，失败走本地合并）
    setTimeout(() => { void this.compressAllMemories(); }, 2500);
  }

  /**
   * 离线回来打招呼（用户拍板）：
   *   退出到下次进来超过 2 分钟 → 随机 1~3 位好友主动发消息（日常话题，
   *   或者编一局**它自己**的游戏 —— **不许提和玩家一起玩**）。
   *   前提：玩家至少 2 位好友；仍然受"连发 2 条没人回就不再打扰"的节流约束。
   *
   * ★ 消息时间（用户拍板）：**不是"玩家刚上线那一刻"**，而是按人设在这段
   *   离线时间里模拟出来的时刻 —— 熬夜型可能在凌晨 2:23，大学生型可能中午 12:47。
   *   所以每条都要带自己的 `at`：提示词用它决定语气，聊天记录按它排序显示。
   * @param {number} awayMs 这次离线了多久
   */
  scheduleReturnPing(awayMs) {
    if (!Number.isFinite(awayMs) || awayMs < RETURN_PING.minAwayMs) return 0;
    const friends = listFriends(this.save).filter((f) => canPingPlayer(this.save, f.personaId));
    if (friends.length < RETURN_PING.minFriends) return 0; // 只有 0~1 位好友就没人来
    const n = Math.min(friends.length, 1 + Math.floor(Math.random() * RETURN_PING.maxPing), RETURN_PING.maxPing);
    /**
     * ★ 恋人优先（用户拍板）：有恋人时，恋人被选中的概率**明显更大**
     *   —— 两道叠加（保送 loverSureChance + 权重 loverWeight），实现在
     *   store/friends.js 的 pickPingTargets；参数在 config 的 RETURN_PING 里。
     *   恋人必须是**这次还能主动发消息的好友**（被删好友 / 被"连发 2 条没人回"挡住
     *   就按普通好友挑，绝不硬塞）。
     */
    const loverId = (this.save.loverId && friends.some((f) => f.personaId === this.save.loverId))
      ? this.save.loverId
      : '';
    const picks = pickPingTargets(friends, { loverId, count: n });
    const backAt = Date.now();
    const leftAt = Math.max(0, backAt - awayMs);
    picks.forEach((f, idx) => {
      const persona = PERSONAS.find((p) => p.id === f.personaId);
      if (!persona) return;
      // ★ 它在玩家不在的这段时间里，按自己的作息挑了个时刻发这条
      const sentAt = simulatedSendAt(persona, leftAt, backAt);
      const wait = RETURN_PING.firstMinMs
        + Math.random() * (RETURN_PING.firstMaxMs - RETURN_PING.firstMinMs)
        + idx * RETURN_PING.gapMs;
      // 只有恋人本人这一条带 loverTone（非恋人好友拿不到"可以说想他"那行提示词）
      const isLoverPick = !!loverId && f.personaId === loverId;
      setTimeout(() => {
        // lastHand = null：这不是刚打完的一局，让它聊日常或**编一局自己的**（不提玩家）
        // loverTone：恋人这一条允许表达想念 / 说心事（见 ai/friend.js 的 buildProactiveMessages）
        void this.deliverFriendPing(persona, f.personaId, null, { selfMatch: true, sentAt, loverTone: isLoverPick });
      }, wait);
    });
    return picks.length;
  }

  /**
   * 离线期间好友自己发友圈（用户拍板）：
   *   离线 **超过 20 分钟** → 随机挑 **1~2 位**好友，各发 **1~2 条**说说；
   *   每条带**随机数量的赞（最多 10 个）**和 **1~3 条评论**，
   *   评论**只由玩家的好友来发**（绝不出现非好友 —— 用户明确要求）；
   *   说说与评论的时间都落在"玩家不在线"的那段时间里（按人设作息模拟）。
   * @param {number} awayMs 这次离线了多久
   */
  scheduleReturnMoments(awayMs) {
    if (!Number.isFinite(awayMs) || awayMs < MOMENT_FEED.minAwayMs) return 0;
    const friends = listFriends(this.save);
    if (friends.length < MOMENT_FEED.minFriends) return 0; // 好友太少：没人发也没人评
    const backAt = Date.now();
    const leftAt = Math.max(0, backAt - awayMs);
    // 随机挑 1~2 位当作者
    const pool = friends.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const authorCount = 1 + Math.floor(Math.random() * MOMENT_FEED.maxAuthors);
    const authors = pool.slice(0, Math.min(authorCount, MOMENT_FEED.maxAuthors, pool.length));
    let n = 0;
    authors.forEach((f) => {
      const persona = PERSONAS.find((p) => p.id === f.personaId);
      if (!persona) return;
      const count = 1 + Math.floor(Math.random() * MOMENT_FEED.maxPostsEach);
      for (let k = 0; k < count; k += 1) {
        n += 1;
        const wait = MOMENT_FEED.staggerMs * n;
        setTimeout(() => {
          void this.deliverFriendMoment(persona, f.personaId, { leftAt, backAt });
        }, wait);
      }
    });
    return n;
  }

  /**
   * 真的发一条：生成说说 → 落库 → 补赞 → 补评论（评论者只从**好友**里挑）
   */
  async deliverFriendMoment(persona, personaId, { leftAt, backAt }) {
    if (!isFriend(this.save, personaId)) return;
    const friend = findFriend(this.save, personaId);
    const at = simulatedSendAt(persona, leftAt, backAt);
    const title = aiTitleOf(this.save, personaId);
    const { text } = await momentPost({
      persona,
      friend,
      myBeans: aiBeansOf(this.save, personaId),
      myTitle: title ? title.name : '',
      playerName: this.playerName,
      playerGender: playerGenderLine(this.save),
      playerIdentity: playerIdentityLines(this.save, { callName: callNameOf(friend), selfId: personaId }),
      now: new Date(at),
    });
    if (!text || !isFriend(this.save, personaId)) return;
    const res = addMoment(this.save, text, { at, by: personaId });
    if (!res.ok) return;
    const momentId = res.moment.id;
    // ① 随机点赞：0 ~ 10 位**好友**（作者自己不给自己的说说点赞）
    const others = listFriends(this.save).filter((f) => f.personaId !== personaId);
    const shuffled = others.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const likeCap = Math.min(MOMENT_FEED.maxLikes, shuffled.length);
    const likeCount = Math.floor(Math.random() * (likeCap + 1));
    shuffled.slice(0, likeCount).forEach((f) => addMomentLike(this.save, momentId, f.personaId));
    // ② 评论：1~3 条，只由**玩家的好友**发（作者除外），时间在说说之后、玩家回来之前
    const maxC = Math.min(MOMENT_FEED.maxComments, shuffled.length);
    const cCount = maxC > 0 ? 1 + Math.floor(Math.random() * maxC) : 0;
    const commenters = shuffled.slice(0, cCount);
    let cursor = at;
    for (const f of commenters) {
      const p = PERSONAS.find((x) => x.id === f.personaId);
      if (!p) continue;
      // 每条评论比上一条晚 2~40 分钟，但都落在窗口内
      cursor = Math.min(
        backAt,
        cursor + MOMENT_FEED.commentGapMinMs
          + Math.random() * (MOMENT_FEED.commentGapMaxMs - MOMENT_FEED.commentGapMinMs),
      );
      /**
       * ★ 修复（用户报的 bug：离线补的友圈评论全是"原来如此""你这话我爱听"这种兜底话）：
       *   这里原来是直接调 `localMomentComment(p, text)` —— 那是**纯本地语料**，
       *   压根不问模型，所以离线补的评论永远是从私聊台词池里随手抓的一句，
       *   跟这条说说毫无关系（在线那条路走的是 deliverMomentComment，所以在线是正常的）。
       *   现在离线也走**同一个出口**：真让模型按说说内容写评论，
       *   模型不可用时的兜底也换成 aiPost 专用的那套（见 ai/moments.js 的 localAiMomentComment）。
       *   `at` 传模拟时刻，评论时间仍然落在玩家离线的那段窗口里。
       */
      await this.deliverMomentComment(momentId, f.personaId, {
        text,
        aiMoment: true,
        at: Math.round(cursor),
      });
      addMomentLike(this.save, momentId, f.personaId); // 评论的人顺手点个赞（和玩家发说说时一个口径）
    }
    this.persist('momentAi');
    this.updateFriendDot();
    this.refreshFriendsPanel();
  }

  /* =====================================================================
   * ★ 另两个"AI 自己发友圈"的场景（用户拍板）
   * ---------------------------------------------------------------------
   *   ① 表白成功、关系变成恋人 → **恋人自己发一条**（含蓄、不指名道姓），
   *      随后其他好友陆续来点赞 + 评论（评论不含恋人自己）；
   *   ② 玩家**在线**时：好友 > 2 人 → 每 10~30 分钟随机让一位好友发一条
   *      （吐槽游戏 / 吐槽生活 / 分享心情），同样带赞与共同好友的评论。
   *
   *   两条路都复用同一个"发一条 + 补赞 + 补评论"的写入器（deliverOnlinePost），
   *   评论直接走已有的 deliverMomentComment（**会写友圈记忆**，只留最近 2 条、
   *   不占常规记忆，所以定时发也不会把记忆挤爆）。
   * ===================================================================== */

  /**
   * 场景①：表白成功 → 恋人自己发一条友圈（**真实时间**，不是模拟时刻）
   *
   * 用户口径：不要"我们在一起了@玩家"这种公告，要**她自己也发了条动态**的感觉 ——
   * 可以含蓄，但要让别的 AI 一眼看出来（提示词见 ai/moments.js 的 SCENE_RULES.confession）。
   * 发完照旧补赞 + 补评论（评论的人**不含恋人自己**，只由玩家的好友发）。
   */
  async deliverLoverMoment(personaId, { reason = 'lover' } = {}) {
    if (!isLover(this.save, personaId)) return null; // 还没成 / 已经分手了
    if (!isFriend(this.save, personaId)) return null; // 好友被删了
    const persona = PERSONAS.find((p) => p.id === personaId);
    if (!persona) return null;
    const text = await this.composeAiPost(persona, personaId, { scene: 'confession' });
    return this.deliverOnlinePost(persona, personaId, {
      text,
      // 这条是"刚确定关系"，别的 AI 会一眼看出来 → 点赞的人更多一点（仍然 ≤10）
      likeRatio: 0.4 + Math.random() * 0.6,
      reason,
    });
  }

  /**
   * 场景②：到点了，随机让**一位好友**自己发一条友圈
   *   · 好友必须**多于 2 人**（≥3）—— 人太少没人来评，硬发很假
   *   · 说说条数保护：MOMENTS.maxPosts（30）快满、或"玩家的说说"占了大头只剩几条时
   *     **直接跳过这一次**（宁可少发，也绝不把玩家自己的说说挤出上限）；见 minFreeSlots
   *   · 三类话题随机（吐槽游戏 / 吐槽生活 / 分享心情）
   * @returns {Promise<object|null>} 没发返回 null
   */
  async maybeOnlineMoment() {
    const friends = listFriends(this.save);
    if (friends.length <= ONLINE_MOMENT.minFriends) {
      console.debug(`[moment] 在线发友圈跳过：好友只有 ${friends.length} 位（要 > ${ONLINE_MOMENT.minFriends}）`);
      return null;
    }
    // ★ 上限保护：别把玩家的说说挤掉（见 config.js 的 minFreeSlots 注释）
    const all = listMoments(this.save);
    const freeSlots = MOMENTS.maxPosts - all.length;
    if (freeSlots <= ONLINE_MOMENT.minFreeSlots) {
      console.debug(`[moment] 在线发友圈跳过：说说已 ${all.length}/${MOMENTS.maxPosts} 条，剩 ${freeSlots} 条（保护玩家自己的说说）`);
      return null;
    }
    // 随机挑一位当作者
    const f = friends[Math.floor(Math.random() * friends.length)];
    const persona = f && PERSONAS.find((p) => p.id === f.personaId);
    if (!persona) return null;
    const scene = pickMomentScene(ONLINE_MOMENT.kinds);
    const text = await this.composeAiPost(persona, f.personaId, { scene });
    if (!text) return null;
    // 发之前再看一眼：期间可能被删好友 / 说说被清 / 条数又满了
    if (!isFriend(this.save, f.personaId)) return null;
    if (MOMENTS.maxPosts - listMoments(this.save).length <= 0) return null;
    return this.deliverOnlinePost(persona, f.personaId, { text, scene, reason: 'online' });
  }

  /**
   * 生成一条 AI 自己的说说（模型不可用时用本地兜底 —— 三类话题都有语料）
   * @returns {Promise<string>} 空串 = 生成不出来（调用方直接放弃这一次）
   */
  async composeAiPost(persona, personaId, { scene = '' } = {}) {
    const friend = findFriend(this.save, personaId);
    const title = aiTitleOf(this.save, personaId);
    const { text } = await momentPost({
      persona,
      friend,
      scene,
      myBeans: aiBeansOf(this.save, personaId),
      myTitle: title ? title.name : '',
      playerName: this.playerName,
      playerGender: playerGenderLine(this.save),
      playerIdentity: playerIdentityLines(this.save, { callName: callNameOf(friend), selfId: personaId }),
      now: new Date(), // ★ 在线/当下发的那条用**真实时间**（离线补发才按人设作息模拟）
    });
    return text || '';
  }

  /**
   * 发一条"好友自己的"说说 → 落库 → 随机点赞（≤10，只从玩家好友里挑）→
   * 1~3 条共同好友评论（**不含作者**，评论之间只错开 1~3 秒真实时间）。
   *
   * 与离线那条路（deliverFriendMoment）的区别只在**时间**与评论节奏：
   *   离线 = 说说与评论的时间落回"玩家不在线"的那段窗口里（按人设作息模拟）；
   *   这里 = 就是当下，评论 1~3 秒一条地冒出来。
   * @returns {object|null} 落库成功返回写好的说说
   */
  deliverOnlinePost(persona, personaId, { text, likeRatio = 0, reason = 'online' } = {}) {
    if (!isFriend(this.save, personaId)) return null;
    const t = String(text || '').trim();
    if (!t) return null;
    const at = Date.now(); // 真实时间（用户拍板）
    const res = addMoment(this.save, t, { at, by: personaId });
    if (!res.ok || !res.moment) return null;
    this.afterFriendMoment(res.moment.id, personaId, { likeRatio, reason });
    return res.moment;
  }

  /**
   * 一条好友说说落库之后：随机点赞 + 让别的共同好友来评论
   *   · 赞与评论都**只从玩家的好友里挑**（绝不出现非好友 —— 用户明确要求）
   *   · 作者本人不点赞、不评论自己的说说；`extraExclude` 还能再排掉一个
   *     （表白那条要排掉**恋人自己**）
   *   · 评论通过已有的 deliverMomentComment 落库 → **顺带写友圈记忆**
   *     （友圈记忆是"额外记忆"，只留最近 2 条，不占常规的 16 条）
   * @returns {{likes:number, commenters:number}}
   */
  afterFriendMoment(momentId, authorId, { likeRatio = 0, extraExclude = [], reason = 'moment' } = {}) {
    const out = { likes: 0, commenters: 0 };
    if (!momentId || !findMoment(this.save, momentId)) return out;
    const skip = new Set([authorId, ...(extraExclude || [])].filter(Boolean));
    const others = listFriends(this.save).filter((f) => !skip.has(f.personaId));
    if (!others.length) { this.persist('momentAi'); return out; }
    // 洗牌
    for (let i = others.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }
    const likeCap = Math.min(ONLINE_MOMENT.maxLikes, others.length);
    const skew = Math.max(0, Math.min(1, Number(likeRatio) || 0));
    /**
     * 点赞人数：随机 ≤ maxLikes（和离线那套一个口径）。
     *   · skew > 0（表白那条）：**至少 1 个赞**，终点抬到 `likesAtMost` ——
     *     "刚确定关系"这种动态没人赞很假
     *   · skew = 0（在线定时那条）：就是 0 ~ maxLikes 随机
     */
    const likesAtMost = skew > 0
      ? Math.max(1, Math.round(likeCap * (0.55 + 0.45 * skew)))
      : likeCap;
    const likeCount = likeCap > 0
      ? Math.min(likeCap, Math.floor(Math.random() * (likesAtMost + 1)))
      : 0;
    others.slice(0, likeCount).forEach((f) => addMomentLike(this.save, momentId, f.personaId));
    out.likes = likeCount;
    // 评论：1~3 条，只由**玩家的好友**发（作者除外），每条错开 1~3 秒真实时间
    const maxC = Math.min(ONLINE_MOMENT.maxComments, others.length);
    const cCount = maxC > 0 ? 1 + Math.floor(Math.random() * maxC) : 0;
    let cursor = 0;
    others.slice(0, cCount).forEach((f) => {
      cursor += ONLINE_MOMENT.commentMinMs
        + Math.random() * Math.max(0, ONLINE_MOMENT.commentMaxMs - ONLINE_MOMENT.commentMinMs);
      const wait = Math.round(cursor);
      setTimeout(() => {
        // 点赞比第一条评论早一点点，像"先划到、后留言"
        if (!hasLiked(this.save, momentId, f.personaId)) addMomentLike(this.save, momentId, f.personaId);
        this.persist('momentLike');
        this.refreshFriendsPanel();
      }, Math.max(120, wait - (ONLINE_MOMENT.likeLeadMinMs
        + Math.random() * Math.max(0, ONLINE_MOMENT.likeLeadMaxMs - ONLINE_MOMENT.likeLeadMinMs))));
      setTimeout(() => this.deliverMomentComment(momentId, f.personaId, {
        text: this.momentTextOf(momentId),
        aiMoment: true,
      }), wait);
      out.commenters += 1;
    });
    this.persist('momentAi');
    this.updateFriendDot();
    this.refreshFriendsPanel();
    console.debug(`[moment] 「${(PERSONAS.find((p) => p.id === authorId) || {}).name || authorId}」`
      + `发了一条说说（${reason}）：${out.likes} 赞 / ${out.commenters} 位好友会来评论`);
    return out;
  }

  /** 说说此刻的文字（评论时当上下文；被删了就返回空串，调用方会用说说本身的） */
  momentTextOf(momentId) {
    const m = findMoment(this.save, momentId);
    return m ? m.text : '';
  }

  /* ------------------------- 在线发友圈的定时器 ------------------------- */
  /**
   * 起这个会话的"在线发友圈"定时器（重复调用是安全的：先清旧的）
   *   · 第一次 2~5 分钟就来一条（不然玩家一直在玩却永远看不到），之后每 10~30 分钟
   */
  startOnlineMoments() {
    if (this.onlineMomentTimer) { clearTimeout(this.onlineMomentTimer); this.onlineMomentTimer = null; }
    /**
     * 人都没落在大厅（还在加载页 / 匹配中 / 设置向导）就先不排，等回到大厅再说。
     * 注意：这里**不看** `document.hidden` —— "切后台"由 pauseOnlineMoments 管。
     * 两条路混在一起会互相打架：浏览器里 pagehide 里 quitGame 清了定时器，
     * visibilitychange 再回来时一开一关，定时器就再也起不来了。
     */
    const active = document.querySelector ? document.querySelector('.screen.is-active') : null;
    const id = (active && active.id) || '';
    if (id && id !== 'screen-lobby') { this.onlineMomentOn = false; return; }
    this.onlineMomentOn = true;
    this.onlineMomentSkips = 0;
    this.scheduleOnlineMoment(ONLINE_MOMENT.firstMinMs
      + Math.random() * Math.max(0, ONLINE_MOMENT.firstMaxMs - ONLINE_MOMENT.firstMinMs));
  }

  /** 排下一次（到点了走 maybeOnlineMoment，然后接着排） */
  scheduleOnlineMoment(delayMs) {
    if (!this.onlineMomentOn) return;
    if (this.onlineMomentTimer) clearTimeout(this.onlineMomentTimer);
    const wait = Number.isFinite(delayMs) && delayMs > 0
      ? delayMs
      : ONLINE_MOMENT.minGapMs
        + Math.random() * Math.max(0, ONLINE_MOMENT.maxGapMs - ONLINE_MOMENT.minGapMs);
    this.onlineMomentTimer = setTimeout(() => {
      this.onlineMomentTimer = null;
      if (!this.onlineMomentOn) return;
      void this.onlineMomentRound();
    }, Math.max(1000, wait));
  }

  /** 到点了：满足条件就发一条，然后排下一次。任何异常都不许把定时器链条打断 */
  async onlineMomentRound() {
    if (!this.onlineMomentOn) return;
    // 玩家在打牌 / 开着面板 / 不在大厅 → 这一轮不打扰，直接往后排
    if (!this.canOnlineMoment()) {
      this.scheduleOnlineMoment();
      return;
    }
    let posted = null;
    try {
      posted = await this.maybeOnlineMoment();
    } catch (err) {
      console.warn('[moment] 在线发友圈失败：', err);
    }
    if (!this.onlineMomentOn) return;
    /**
     * 连着跳过（在打牌 / 开着面板 / 好友不够 / 说说快满）就慢慢等：
     * 只是不满足条件，不是出错，所以隔 10~30 分钟再试，不空转。
     */
    this.onlineMomentSkips = posted ? 0 : (this.onlineMomentSkips || 0) + 1;
    if (this.onlineMomentSkips >= ONLINE_MOMENT.maxSkips) {
      // 长时间都不满足（比如好友被删到只剩 1 个）：直接收手，别一直挂着定时器
      this.stopOnlineMoments();
      return;
    }
    this.scheduleOnlineMoment();
  }

  /**
   * 停下来：切后台 / 退出登录界面 / 进牌桌 / 会话结束都走这里
   *   · 清掉那一个 setTimeout，并且不再续排（和群聊挂机的 alive 一个口径）
   * @param {{resume?:boolean}} [opts] resume = 只是"暂时"停（切后台），回来还能再开
   */
  stopOnlineMoments({ resume = false } = {}) {
    if (this.onlineMomentTimer) { clearTimeout(this.onlineMomentTimer); this.onlineMomentTimer = null; }
    this.onlineMomentOn = false;
    if (resume) this.onlineMomentResumable = true;
  }

  /** 页面隐藏 / 切后台 → 先停；回到前台且还停在大厅 → 接着来 */
  bindOnlineMomentTracking() {
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.pauseOnlineMoments();
        else this.resumeOnlineMoments();
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', () => this.pauseOnlineMoments());
    }
  }

  /**
   * 暂停（切后台）：和 stopOnlineMoments 一样会清定时器，但**不会被"有没有在牌桌上"挡住** ——
   * 它只是暂时收手，回前台时由 resumeOnlineMoments 再排一次。
   */
  pauseOnlineMoments() {
    if (this.onlineMomentTimer) { clearTimeout(this.onlineMomentTimer); this.onlineMomentTimer = null; }
    if (!this.onlineMomentOn) return;
    this.onlineMomentOn = false;
    this.onlineMomentPaused = true;
  }

  /**
   * 恢复：回到前台 / 回到大厅 → 重新排一次（2~5 分钟后那档）
   * @param {{restart?:boolean}} [opts] restart = 不是"从暂停里恢复"，而是"回到大厅了，
   *   重新起一个会话"（例如刚打完一局回大厅）
   */
  resumeOnlineMoments({ restart = false } = {}) {
    if (this.onlineMomentOn) return; // 已经在跑，别重置它的计时
    if (!this.onlineMomentPaused && !restart) return;
    this.onlineMomentPaused = false;
    this.startOnlineMoments();
  }

  /**
   * 现在该不该让好友自己发友圈（只在"玩家真的闲着在大厅"时才发）：
   *   · 在牌桌上 / 钓鱼 / 五子棋 → 不发（别打断玩家）
   *   · 开着面板（好友 / 设置 / 商城…）→ 不发
   *   · 当前界面不是大厅（加载页 / 匹配中 / 设置向导）→ 不发
   */
  canOnlineMoment() {
    if (this.table || this.fishing || this.gomoku) return false;
    if (this.isPanelOpen()) return false;
    const active = document.querySelector ? document.querySelector('.screen.is-active') : null;
    const id = (active && active.id) || '';
    if (!id) return true; // 拿不到界面（老代码 / 测试桩）→ 不挡
    return id === 'screen-lobby';
  }

  /**
   * 记下"最后一次在"的时间：关掉页面 / 切到后台时写一次。   * 下次进来看离上次多久，决定要不要让好友来打招呼（见 scheduleReturnPing）。
   */
  bindAwayTracking() {
    const mark = () => {
      this.save.lastSeenAt = Date.now();
      writeSave(this.save);
    };
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', mark);
      window.addEventListener('beforeunload', mark);
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => { if (document.hidden) mark(); });
    }
  }

  bindGlobal() {
    document.getElementById('nav-friends').addEventListener('click', () => { audio.resume(); friendsPanel.openFriends(this); });
    // 称号入口在左上角（点头像旁的称号，或未佩戴时的占位）
    document.getElementById('btn-lobby-titles').addEventListener('click', () => { audio.resume(); panels.openTitles(this); });
    document.getElementById('nav-shop').addEventListener('click', () => { audio.resume(); panels.openShop(this); });
    // 签到收进了「活动」里（活动中心 → 每日/每周礼包那一栏就有签到入口）
    document.getElementById('nav-activity').addEventListener('click', () => { audio.resume(); openActivity(this); });
    document.getElementById('nav-rank').addEventListener('click', () => { audio.resume(); openRank(this); });
    document.getElementById('btn-mail').addEventListener('click', () => { audio.resume(); openMail(this); });
    // 设置入口在大厅右上角（底部导航已去掉设置按钮）
    document.getElementById('game-ddz').addEventListener('click', () => this.selectLobbyGame('ddz'));
    document.getElementById('game-fishing').addEventListener('click', () => this.selectLobbyGame('fishing'));
    const gmkCard = document.getElementById('game-gomoku');
    if (gmkCard) gmkCard.addEventListener('click', () => this.selectLobbyGame('gomoku'));
    document.getElementById('btn-table-settings').addEventListener('click', () => panels.openSettings(this));
    document.getElementById('btn-edit-name').addEventListener('click', () => panels.openRename(this));
    // 头像即入口：点左上角头像进来改头像 / 头像框（设置里已经不再放这两项）
    document.getElementById('btn-lobby-avatar').addEventListener('click', () => { audio.resume(); openProfile(this); });
    document.getElementById('btn-lobby-settings').addEventListener('click', () => { audio.resume(); panels.openSettings(this); });
    document.getElementById('btn-quit').addEventListener('click', () => this.quitGame());

    document.getElementById('mode-switch').addEventListener('change', (e) => {
      this.mode = e.target.value || 'ai';
      const tips = {
        ai: 'AI 模式：对手会说话、会怼人',
        bot: '机器模式：安静快速对局，对手不说话',
        room: '房间模式：点场次的「开始游戏」后邀请好友，人满才能开局',
      };
      toast(tips[this.mode] || tips.ai);
      // ★ 换了模式要重画大厅：右侧那一栏的标题/提示跟着模式变
      //   （以前不重画，五子棋的房间模式提示要等下一局打完才出现）
      this.refreshLobby();
    });

    // 发牌开关：洗牌 / 不洗牌
    document.getElementById('deal-switch').addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('[data-shuffle]') : null;
      if (!btn) return;
      const on = btn.dataset.shuffle === '1';
      this.save.settings.shuffle = on;
      this.persist('settings');
      this.applySettings();
      toast(on ? '已开启洗牌：每局重新洗牌' : '已关闭洗牌：接着上一局的牌序，只做切牌');
    });

    document.addEventListener('pointerdown', () => audio.resume(), { once: true });
  }

  persist(reason) {
    void reason;
    // 豆子变化可能解锁新称号
    const got = syncBeanTitles(this.save);
    writeSave(this.save);
    if (got.length) {
      this.refreshTitles();
      toast(`解锁称号：${got[got.length - 1].name}`, 'gold');
    }
  }

  /** 刷新所有称号徽章 */
  refreshTitles() {
    const t = equippedTitle(this.save);
    renderTitleBadge(document.getElementById('lobby-title'), t);
    renderTitleBadge(document.getElementById('me-title'), t);
    renderTitleBadge(document.getElementById('fish-me-title'), t);
  }

  openSettings() {
    audio.resume();
    panels.openSettings(this);
  }

  /* ------------------------------ 五子棋 / 大厅游戏切换 ------------------------------ */
  /** 大厅里切换游戏：场次列表跟着切（斗地主 / 小猫钓鱼 / 五子棋） */
  selectLobbyGame(kind) {
    this.lobbyGame = kind === 'fishing' ? 'fishing' : (kind === 'gomoku' ? 'gomoku' : 'ddz');
    this.refreshLobby();
  }

  /** 小猫钓鱼的入场校验（门槛按场次，输光即止不会负豆） */
  canEnterFishing(room) {
    if (this.save.beans < room.minBeans) {
      return { ok: false, reason: `身家不足，${room.name}需要 💰${room.minBeans.toLocaleString()}` };
    }
    return { ok: true };
  }

  /**
   * @param {{invited?:boolean, startDelayMs?:number, waitText?:string}} [opts]
   *   invited = AI 房主邀请进来的（等几秒才发牌）
   */
  startFishing(roomId, roomFriendIds, opts = {}) {
    // 玩家自己开的局（不是被邀请的）→ 解除"点过 ✗"的免打扰
    if (!opts.invited) this.clearInviteMute();
    const room = FISHING_ROOMS.find((r) => r.id === roomId) || FISHING_ROOMS[0];
    const can = this.canEnterFishing(room);
    if (!can.ok) {
      toast(can.reason, 'bad');
      panels.openShop(this);
      return;
    }
    // 房间模式：先开房间邀请好友
    if (this.mode === 'room' && !roomFriendIds) {
      panels.closePanel();
      friendsPanel.openRoom(this, roomId);
      return;
    }
    panels.closePanel();
    audio.resume();
    this.gameKind = 'fishing';
    this.currentFishRoom = room;
    this.matchWrite = null; // 新的一局：上一局的对局记忆任务作废（见 playedHandForPing）
    // 邀请了好友就用它的 人设，否则随机
    this.fishPersona = (roomFriendIds && roomFriendIds.length)
      ? (PERSONAS.find((p) => p.id === roomFriendIds[0]) || null)
      : null;
    // 房间模式里手动邀请的好友，身家不够门槛就先补足
    if (this.fishPersona) topUpForRoom(this.save, this.fishPersona.id, room);
    this.fishAvatar = (this.fishPersona && this.fishPersona.avatar)
      || PERSONAS[Math.floor(Math.random() * PERSONAS.length)].avatar;
    if (this.fishing) this.fishing.destroy();
    this.showScreen('screen-fishing');
    this.fishing = new FishingTable(this, {
      startDelayMs: opts.startDelayMs || 0,
      waitText: opts.waitText || '',
    });
    this.refreshTitles();
    audio.startBgm();
  }

  /**
   * 小猫钓鱼一局结束：对手身家同步输赢，其余 AI 按身家浮动，再发低保
   * （退出不算，所以只有正常打完才会调到这里）
   */
  settleFishingAi(personaId, aiDelta) {
    if (personaId && aiDelta) addAiBeans(this.save, personaId, aiDelta);
    const idle = pulseIdleAi(this.save, personaId ? [personaId] : []);
    const relief = grantAiRelief(this.save);
    this.lastAiChanges = { changes: [], idle, relief };
    this.persist('aiEcon');
  }

  /** 小猫钓鱼一局结束：写对局记忆（同样只记参战的那位） */
  recordFishingMemory({ pay, score, multiplier, room, persona }) {
    const facts = fishingFacts({
      pay,
      score,
      multiplier,
      room,
      personaName: persona ? persona.name : '',
      // 玩家的昵称写进事实里，概括就不会用"你"（否则 AI 会把输赢记成自己的）
      playerName: this.playerName,
    });
    this.matchWrite = this.recordMatchMemory({
      kind: 'fishing',
      facts,
      seatIds: persona ? [persona.id] : [],
      room,
      humanWin: pay.delta > 0,
      delta: pay.delta,
      // 座位 0 = 玩家，座位 1 = 这位 AI：它自己的输赢正好和玩家相反
      deltas: [pay.delta, -pay.delta],
    });
    return this.matchWrite;
  }

  /**
   * 五子棋：开一局
   *   · 不检查任何门槛（不涉及豆子）
   *   · AI 模式 / 机器模式都能选场次，场次只决定**匹配难度池**（见 data/gomokuLevels.js）
   *   · 房间模式（roomFriendIds）用被邀请好友自己的固定难度，且不显示场次
   * @param {{invited?:boolean, startDelayMs?:number, waitText?:string}} [opts]
   */
  startGomoku(roomId, roomFriendIds, opts = {}) {
    if (!opts.invited) this.clearInviteMute();
    const room = GOMOKU_ROOMS.find((r) => r.id === roomId) || GOMOKU_ROOMS[0];
    const friendIds = (roomFriendIds || []).filter(Boolean);
    // 房间模式：先开房间邀请好友（和钓鱼一致）
    if (this.mode === 'room' && !friendIds.length) {
      panels.closePanel();
      friendsPanel.openRoom(this, roomId);
      return;
    }
    panels.closePanel();
    audio.resume();
    this.gameKind = 'gomoku';
    this.currentGomokuRoom = room;
    this.matchWrite = null; // 新的一局：上一局的对局记忆任务作废（见 playedHandForPing）
    this.resetToolUsage();

    // ★ 对手：房间模式用邀请的好友；AI 模式从场次池里随机抽一位；机器模式没有人设
    if (friendIds.length) {
      this.gomokuPersona = PERSONAS.find((p) => p.id === friendIds[0]) || null;
      this.gomokuBotLevel = this.gomokuPersona ? levelOfPersona(this.gomokuPersona) : botLevelOfRoom(room.id);
    } else if (this.mode === 'ai') {
      this.gomokuPersona = pickByRoom(room.id);
      this.gomokuBotLevel = levelOfPersona(this.gomokuPersona);
    } else {
      this.gomokuPersona = null; // 机器模式：匿名对手
      this.gomokuBotLevel = botLevelOfRoom(room.id);
    }
    // 房间弹幕的说话人（五子棋用不到弹幕，但保持和钓鱼一致的口径）
    this.roomDanmakuSeats = this.gomokuPersona ? [this.gomokuPersona.id] : [];

    if (this.gomoku) this.gomoku.destroy();
    this.showScreen('screen-gomoku');
    this.gomoku = new GomokuTable(this, {
      startDelayMs: opts.startDelayMs || 0,
      waitText: opts.waitText || '',
    });
    this.refreshTitles();
    audio.startBgm();
  }

  /** 五子棋的场次没有门槛：永远进得去（不涉及豆子） */
  canEnterGomoku() { return { ok: true }; }

  quitGomoku() {
    this.gameKind = 'ddz';
    if (this.gomoku) { this.gomoku.destroy(); this.gomoku = null; }
    this.showScreen('screen-lobby');
    this.refreshLobby();
  }

  isGomokuActive() {
    const el = document.getElementById('screen-gomoku');
    return !!el && el.classList.contains('is-active');
  }

  /**
   * 五子棋里对手的台词（复用同一套对话层与节流）
   *
   * ★ 场上形势**告诉它**（用户要求），但只说客观事实（手数 / 双方各有几个能成威胁的点 /
   *   最后一手在哪），**不说"这一手是在拦你"这种意图**，让它按人设自己表达。
   * ★ 视图由 `ai/gomokuView.js` 提供，并且**标明这是五子棋**（mode）——
   *   以前借用斗地主的视图，模型张口就是"出一张牌""出个 3 探探路"（用户报的 bug）。
   */
  gomokuSpeak(scene, extra = {}) {
    if (!this.aiEnabled || !this.gomoku) return;
    const g = this.gomoku;
    const { mine, ...rest } = extra; // mine 只是给调用方留的口子，不进提示词
    void mine;
    this.chat.speak(1, scene, g.persona, {
      mode: 'gomoku', minGap: CONFIG.ai.fishMinGap, ...rest,
    });
  }

  /** 五子棋：陪下一局 +2 好感度（无论输赢，只给参战好友） */
  rewardGomokuFriend(persona) {
    if (!persona) return null;
    const friend = findFriend(this.save, persona.id);
    if (!friend || !isFriend(this.save, persona.id)) return null;
    const before = friend.affinity;
    adjustAffinity(this.save, persona.id, FRIEND.playAffinityGomoku);
    this.persist('affinityGomoku');
    const after = findFriend(this.save, persona.id).affinity;
    if (after > before) {
      setTimeout(() => toast(`「${persona.name}」好感度 +${after - before}（一起下了盘棋）`, 'gold'), 1200);
    }
    return { before, after };
  }

  /** 五子棋一局结束：写对局记忆（只记参战的那位好友） */
  recordGomokuMemory({ winner, first, moves, room, persona }) {
    const facts = gomokuFacts({
      winner, first, moves, room,
      personaName: persona ? persona.name : '',
      playerName: this.playerName,
    });
    /**
     * deltas 只用来让"每个参战 AI 各写一份自己视角的概括"分清输赢
     * （+1 = 那个人赢了）；`delta` 保持 0：**五子棋不涉及豆子**。
     */
    const deltas = winner === 'player' ? [1, -1] : winner === 'ai' ? [-1, 1] : [0, 0];
    // 返回 promise：界面不等它，测试可以 await（★ 同时记成"这局的对局记忆任务"，
    // 好友搭话要等它写完才知道"刚刚那局"是哪一局）
    this.matchWrite = this.recordMatchMemory({
      kind: 'gomoku',
      facts,
      seatIds: persona ? [persona.id] : [],
      room,
      humanWin: winner === 'player',
      delta: 0,
      deltas,
    });
    return this.matchWrite;
  }

  quitFishing() {
    this.gameKind = 'ddz';
    if (this.fishing) { this.fishing.destroy(); this.fishing = null; }
    this.showScreen('screen-lobby');
    this.refreshLobby();
  }

  isFishingActive() {
    const el = document.getElementById('screen-fishing');
    return !!el && el.classList.contains('is-active');
  }

  /** 小猫钓鱼的 AI 发言（复用同一套对话层与节流） */
  fishSpeak(scene, extra = {}) {
    if (!this.aiEnabled || !this.fishing) return;
    const g = this.fishing.game;
    // 座位约定：索引 0 = 玩家，索引 1 = AI 自己（写反会穿帮，见 ai/fishingView.js）
    const mine = g.score[1];
    const yours = g.score[0];
    const lead = mine === yours ? '现在打平'
      : mine > yours ? `你现在领先 ${mine - yours} 张` : `你现在落后 ${yours - mine} 张`;
    const parts = [
      '你在玩小猫钓鱼休闲局',
      `你（AI）的鱼篓 ${mine} 张，玩家鱼篓 ${yours} 张，${lead}`,
      `你手上还有 ${g.piles[1].length} 张牌没翻，玩家手上还有 ${g.piles[0].length} 张`,
    ];
    if (extra.catchCount) {
      parts.push(extra.catchSeat === 1
        ? `你刚才一次钓走了 ${extra.catchCount} 张`
        : `玩家刚才一次钓走了 ${extra.catchCount} 张`);
    }
    const situation = { key: extra.situationKey || 'normal', urgent: false, text: parts.join('；') };
    const { catchSeat, catchCount, ...rest } = extra;
    void catchSeat;
    void catchCount;
    // 小猫钓鱼要求"每次收牌都说话"，用更短的间隔；mode 让提示词知道这是钓鱼、不是斗地主
    this.chat.speak(1, scene, this.fishing.persona, {
      mode: 'fishing', situation, minGap: CONFIG.ai.fishMinGap, ...rest,
    });
  }

  resetSave() {
    /**
     * ★ 重置存档 = 这一局会话结束：先把在线发友圈的定时器收掉
     *   （好友都清空了，再挂着只会空转；重设完档案回到大厅时 showScreen 会重新起）
     */
    this.stopOnlineMoments();
    this.save = Object.assign(defaultSave(), { avatar: this.save.avatar, avatarUpload: this.save.avatarUpload });
    this.economy = new Economy(this.save, (r) => this.persist(r));
    // ★ 重置 → AI 改过的名字一起回出厂名（PERSONAS 是被就地改过的，必须显式还原）
    resetAiNames(this.save);
    this.persist('reset');
    this.applySettings();
    renderLobby(this);
    // 重置存档 = 重新开始：性别与姓名要重新设一次（存档里 profileSet 已经回到 false）
    if (this.needsSetup()) this.showSetup();
  }

  /** 要不要先设置性别 + 姓名（新手存档 / 刚重置过存档） */
  needsSetup() { return needsProfileSetup(this.save); }

  /** 弹出"设置性别 + 姓名"那一屏（不确认就不进大厅） */
  showSetup() { openSetup(this, { onDone: () => this.showScreen('screen-lobby') }); }

  /** 确认档案：写进存档并放行（返回 { ok } 便于界面提示） */
  completeSetup({ gender, name } = {}) {
    const typed = cleanPlayerName(name);
    if (!typed) return { ok: false, error: '先给自己起个名字吧' };
    this.save.gender = gender === 'female' ? 'female' : 'male';
    this.save.nickname = typed;
    this.save.profileSet = true;
    this.persist('profile');
    this.refreshLobby();
    return { ok: true, name: typed, gender: this.save.gender };
  }

  applySettings() {
    const s = this.save.settings;
    setTextureEnabled(s.useTextures);
    document.documentElement.dataset.anim = s.animSpeed === 'off' ? 'off' : 'on';
    document.documentElement.style.setProperty('--anim', String(CONFIG.animSpeed[s.animSpeed] || 1));
    audio.setVolumes({ bgm: s.bgmVolume, sfx: s.sfxVolume });
    CONFIG.model = s.model || DEFAULT_SETTINGS.model;
    CONFIG.thinking = !!s.thinking;
    /**
     * ★ API Key：**存档优先、源码默认兜底**。
     *   存档里填过就用存档那份（存在 localStorage + save/ddz_save.json，都不进仓库）；
     *   没填才回落到 src/config.js 里的 CONFIG.apiKey（公开仓库里是空串）。
     *   以前这里没同步，所以设置面板里粘的 Key 一刷新就没了。
     */
    CONFIG.apiKey = s.apiKey || CONFIG.apiKey;
    if (this.particles) this.particles.setSpeed(s.animSpeed === 'off' ? 0 : 1);
    // 风格（整体配色）：'light' 才会打标记，深色（默认）就是不加 data-theme
    this.applyTheme();
    // 发牌开关：把状态刷到大厅按钮上（按需求不写额外提示文案）
    const on = s.shuffle !== false;
    document.querySelectorAll('#deal-switch [data-shuffle]').forEach((b) => {
      b.classList.toggle('is-active', (b.dataset.shuffle === '1') === on);
    });
  }

  /**
   * 把当前佩戴的"风格"落到 <html data-theme> 上。
   * 只有浅色要打标记（'light'），深色是默认值 = 不加这个属性；
   * 具体配色见 styles/theme-light.css（只换设计令牌，牌桌那一屏永远是深色）
   */
  applyTheme() {
    const name = themeNameOf(this.save);
    if (name) document.documentElement.dataset.theme = name;
    else delete document.documentElement.dataset.theme;
  }

  /* ------------------------------ AI 邀请玩家打牌 ------------------------------ */
  /**
   * 记录"玩家在动"：只有在**主界面发呆够久**（默认 30s）才可能被邀请。
   * 任何点击/按键/界面切换都算活动，会把计时重置。
   */
  bindIdleTracking() {
    const touch = () => { this.lastActivityAt = Date.now(); };
    window.addEventListener('pointerdown', touch, { passive: true });
    window.addEventListener('keydown', touch);
    window.addEventListener('wheel', touch, { passive: true });
  }

  /** 现在算不算"停在主界面发呆" */
  inviteIdleMs() { return Date.now() - (this.lastActivityAt || Date.now()); }

  isPanelOpen() {
    const layerEl = document.getElementById('panel-layer');
    return !!(layerEl && layerEl.classList.contains('is-open'));
  }

  /** 定一个"检查点"：到点再看能不能邀请，不能就再往后排 */
  scheduleInviteCheck(delayMs) {
    if (this.inviteTimer) clearTimeout(this.inviteTimer);
    const wait = Number.isFinite(delayMs) ? delayMs : 5000;
    this.inviteTimer = setTimeout(() => this.maybeInvite(), Math.max(1000, wait));
  }

  /** 到点了：满足条件就弹一张邀请卡，否则继续等下一次 */
  maybeInvite() {
    const ctx = {
      screen: (document.querySelector('.screen.is-active') || {}).id || '',
      panelOpen: this.isPanelOpen(),
      inGame: this.gameKind === 'fishing' ? !!this.fishing : !!this.table,
      idleMs: this.inviteIdleMs(),
    };
    const verdict = canInviteNow(this.save, ctx);
    if (!verdict.ok) {
      // 还没发呆够 → 等够再来；其他原因 → 20~60s 后再看
      this.scheduleInviteCheck(verdict.reason === 'not-idle'
        ? Math.max(1500, INVITE.idleMs - ctx.idleMs + 1500)
        : nextInviteGapMs());
      return null;
    }
    const friends = listFriends(this.save);
    const pair = pickHostAndOther(friends);
    const target = pickInviteTarget(this.save, {
      canEnterDdz: (r) => this.economy.canEnter(r),
      canEnterFishing: (r) => this.canEnterFishing(r),
      // 五子棋没有门槛：永远能进
      canEnterGomoku: () => this.canEnterGomoku(),
    });
    // ★ 挑出来的是**好友记录**（字段是 personaId），得先换算成人设（字段是 id）
    //   以前直接把 host.id 传下去 → undefined → 开局时退化成"随机 AI"，于是
    //   "好友拉我进游戏，对面的 AI 却不是他"（用户报的 bug）
    const host = this.invitePersonaOf(pair && pair.host);
    const other = this.invitePersonaOf(pair && pair.other);
    if (!host || !other || !target) { this.scheduleInviteCheck(nextInviteGapMs()); return null; }

    const seconds = Math.round(INVITE.countdownMs / 1000);
    return showInvite({
      persona: host,
      targetText: inviteTargetText(target),
      seconds,
      onAccept: () => {
        this.lastActivityAt = Date.now();
        this.startInvitedMatch({ host, other }, target);
      },
      onDecline: () => {
        // 点了 ✗ → 之后不再打扰，直到玩家主动玩一局
        setInviteMuted(this.save, true);
        this.persist('inviteMuted');
        toast('好，那不打扰你了～（你打完一局我再来约）');
        this.scheduleInviteCheck(nextInviteGapMs());
      },
      onTimeout: () => this.scheduleInviteCheck(nextInviteGapMs()),
    });
  }

  /**
   * 邀请里挑出来的可能是**好友记录**（`personaId`）也可能是**人设对象**（`id`）：
   * 统一换算成人设，别让 `undefined` 混进去（否则开局会退化成随机 AI）。
   */
  invitePersonaOf(x) {
    if (!x) return null;
    const id = x.personaId || x.id;
    return PERSONAS.find((p) => p.id === id) || null;
  }

  /** 接受邀请：等同于房间模式，AI 是房主；3~5 秒后自动开局（期间退出就不开局） */
  startInvitedMatch(pair, target) {
    const host = this.invitePersonaOf(pair && pair.host);
    const other = this.invitePersonaOf(pair && pair.other);
    if (!host) return; // 好友没了（比如邀请卡显示期间被删）→ 当作没这回事
    const delay = nextStartDelayMs();
    const waitText = `「${host.name}」是房主 · ${Math.max(1, Math.round(delay / 1000))} 秒后开局（退出就不打了）`;
    this.clearInviteMute();
    audio.play('select');
    if (target.kind === 'fishing') {
      this.mode = 'room';
      this.startFishing(target.room.id, [host.id], { invited: true, startDelayMs: delay, waitText });
      this.hostInviteLine('fishing', delay);
      return;
    }
    if (target.kind === 'gomoku') {
      this.mode = 'room';
      this.startGomoku(target.room.id, [host.id], { invited: true, startDelayMs: delay, waitText });
      this.hostInviteLine('gomoku', delay);
      return;
    }
    this.mode = 'room';
    // 房主坐 1 号位（seat 1 = picks[0]），另一位好友坐 2 号位；不够就按场次门槛补
    this.startGame(target.room.id, other ? [host.id, other.id] : [host.id], {
      invited: true, startDelayMs: delay, waitText,
    });
    this.hostInviteLine('ddz', delay);
  }

  /**
   * ★ 用户拍板：被邀请进游戏后，**邀请玩家的那位（房主）主动说一句** ——
   *   由模型生成（大意"总算把你拉来了"），失败就用本地台词兜底。
   *   提示词里写死：**不许提系统/规则/AI/模型**，也不许说教，要符合它自己的身份。
   * @param {'ddz'|'fishing'|'gomoku'} kind
   * @param {number} startDelayMs 开局还要等多久（等它真开局了再说话）
   */
  hostInviteLine(kind, startDelayMs) {
    const hint = '你好不容易把玩家拉来一起玩（约了好几回终于答应了），说一句"总算把你拉来了"这种意思的话 —— '
      + '符合你自己的身份、性别与说话风格，**别用"系统/规则/AI/模型/算法"这类词**，也别说教、别报数据。';
    setTimeout(() => {
      // 中途退出就不说了
      if (kind === 'ddz' && (!this.game || this.gameKind !== 'ddz')) return;
      if (kind === 'fishing' && (!this.fishing || this.gameKind !== 'fishing')) return;
      if (kind === 'gomoku' && (!this.gomoku || this.gameKind !== 'gomoku')) return;
      const extra = { eventText: hint, priority: true, forceSituation: true, situationKey: 'invited' };
      if (kind === 'fishing') this.fishSpeak('greeting', extra);
      else if (kind === 'gomoku') this.gomokuSpeak('greeting', extra);
      else this.aiScene(1, 'greeting', extra);
    }, Math.max(400, startDelayMs) + 900);
  }

  /** 玩家主动玩一局了 → 解除"点过 ✗"的免打扰 */
  clearInviteMute() {
    if (!this.save.inviteMuted) return false;
    setInviteMuted(this.save, false);
    this.persist('inviteMuted');
    return true;
  }

  refreshLobby() {
    renderLobby(this);
    // 头像框是贴在头像 img 上的，大厅重绘后要重新贴一遍
    this.applyFrameClass();
  }

  /**
   * 每局结束（正常打完才算）：把这局浓缩成 50~100 字概括
   *  - 写进**参战双方**的 memory（没参战的好友不会记住这局，避免"没打却说打了"）
   *  - 记进 save.recentHands（最多 3 局），聊天时用来回忆
   *
   * ★ 视角（用户报的 bug）：记忆是存进 AI 脑子里的，所以**每个参战 AI 各写一份，
   *   站在它自己的角度**（它自己 = "你"）。以前是把"给玩家看的那份"（"你输了…"）
   *   直接塞给 AI，结果它以为输的是它自己。
   *   `deltas` 按座位给输赢（下标 0 = 玩家），用来判断"这个 AI 自己是赢还是输"。
   */
  async recordMatchMemory({
    kind, facts, seatIds, room, humanWin, delta, deltas = null,
  }) {
    const ids = (seatIds || []).filter(Boolean);
    const selfWonOf = (i) => {
      if (!Array.isArray(deltas)) return null;
      const seat = i + 1; // seatIds[i] 对应座位 i+1（0 号位永远是玩家）
      const v = Number(deltas[seat]);
      return Number.isFinite(v) ? v > 0 : null;
    };
    // ① 中立版（进 recentHands：任何 AI 读它都不会认错主角）
    const neutralRes = await summarizeMatch({
      kind, room, facts, names: this.seatNames, perspective: 'neutral',
    });
    // ★ 概括里必须点明玩法（五子棋/小猫钓鱼/斗地主）：不然 AI 以后读这条记忆
    //   根本不知道那局玩的是什么（用户报的"还是不清楚上一局打的是什么"）
    const summary = ensureModeNamed(fitSummary(neutralRes.text), kind) || '';
    if (!summary) return null;
    // ② 每个参战 AI 各一份"以它为视角"的（它自己用"你"）
    const perAi = await Promise.all(ids.map(async (id, i) => {
      const persona = PERSONAS.find((p) => p.id === id) || null;
      const res = await summarizeMatch({
        kind,
        room,
        facts,
        names: this.seatNames,
        selfName: persona ? persona.name : '',
        selfWon: selfWonOf(i),
        perspective: 'ai',
      });
      return { id, text: ensureModeNamed(fitSummary(res.text), kind) || '' };
    }));
    for (const { id, text } of perAi) if (text) addMatchMemory(this.save, id, text);
    const hand = {
      kind, roomId: room ? room.id : '', at: Date.now(), seatIds: ids, summary, humanWin, delta,
    };
    this.save.recentHands = [hand, ...(this.save.recentHands || [])].slice(0, RECENT_HANDS);
    this.persist('matchMemory');
    this.refreshFriendsPanel();
    // ★ 返回这一局的记录（好友搭话要用它判断"刚刚那局"，见 playedHandForPing）
    return hand;
  }

  /**
   * 「刚刚那局」到底是哪一局 —— 好友主动搭话前必须问这一句
   *
   * 为什么不能直接取 `recentHands[0]`：写对局记忆是**异步**的（要等模型写概括），
   * 一局刚打完时那条记录还没落盘，取到的会是**上一局**。
   * 用户就是在这里踩的坑：刚下完五子棋，好友来聊的却是小猫钓鱼。
   *
   * @returns {Promise<object|null>} 这局的对局记录；这局没写记忆（比如机器模式）就返回 null
   */
  async playedHandForPing() {
    const job = this.matchWrite;
    if (!job) return null; // 这局没有"和对局记忆"（机器模式 / 没好友）→ 没有"刚刚那局"
    try {
      return (await job) || null;
    } catch {
      return null;
    }
  }

  /**
   * 这一局某个 AI 有没有参加（聊天时用来决定"能不能聊这局"）
   * ★ 还要满足"那时候**已经是好友**"：用「添加好友」冷加的人，
   *   哪怕那局正好是它陪你打的，也不该一上来就说"刚刚那局你…"（用户报的 bug）。
   */
  matchJoinedBy(hand, personaId) {
    if (!hand || !Array.isArray(hand.seatIds) || !hand.seatIds.includes(personaId)) return false;
    const f = findFriend(this.save, personaId);
    if (!f) return false;
    return !f.addedAt || !hand.at || hand.at >= f.addedAt;
  }

  /**
   * 一起打了一局 → 加好感度（PRD §2.12）
   *   · **自己邀请的好友**（房间模式挑的人）:+3 —— 是你主动找它玩
   *   · **随机匹配正好碰上好友**:+1 —— 缘分，但不算你主动
   *   · 没加好友的对手:不加（本来也不是好友）
   * @param {Array<{id:string}>} personas 本局座位人设
   * @param {boolean} invited 是不是玩家自己邀请的
   * @returns {string[]} 加了好感的好友名字（用来弹一句轻提示）
   */
  rewardFriendPlay(personas, invited) {
    // ★ 这里以前写的是 AFFINITY_PLAY_INVITED / AFFINITY_PLAY_MATCHED —— 两个**从没定义过**的常量，
    //   一调用就 ReferenceError。钓鱼结算时它排在"打开结算面板"之前抛错，
    //   于是**小猫钓鱼打完了没有结算页面**（用户报的 bug）；斗地主的结算面板也受同一处影响。
    //   数值本来就在 config 的 FRIEND 里，直接用那份。
    const delta = invited ? FRIEND.playAffinityInvited : FRIEND.playAffinityMatched;
    const names = [];
    for (const p of personas || []) {
      if (!p || !p.id) continue;
      if (!isFriend(this.save, p.id)) continue;
      adjustAffinity(this.save, p.id, delta);
      names.push(p.name || p.id);
    }
    if (names.length) {
      this.persist('affinityPlay');
      toast(`${names.join('、')} 陪你打了一局，好感 +${delta}`, 'good');
    }
    return names;
  }

  /** 某个 AI 参与过的最近一局 */
  lastMatchOf(personaId) {
    return (this.save.recentHands || []).find((h) => this.matchJoinedBy(h, personaId)) || null;
  }

  /* ------------------------------ 好友主动搭话 ------------------------------ */
  /** 好友面板打开时把刷新函数注册进来，主动消息到了能实时更新 */
  refreshFriendsPanel() {
    this.friendRenderers.forEach((fn) => { try { fn(); } catch { /* 面板可能已关 */ } });
  }

  /** 好友红点：私聊未读 + 群聊未读 */
  /**
   * 好友红点 → **红色圆圈 + 数字**（用户要求）：
   *   数字 = 未读消息**总数**（好友私聊未读 + 群聊未读），超过 99 显示 99+
   *   数字用正常字体（不斜体）
   *
   * ★ 友圈的评论**不算进这个数字**（用户拍板）：它只在点开「社交」之后，
   *   友圈那个标签旁边亮一个小红点（见 ui/friends.js 的 #moment-dot），
   *   不打扰大厅界面的数字。
   */
  updateFriendDot() {
    const dot = document.getElementById('friend-dot');
    if (!dot) return;
    const total = unreadTotal(this.save) + groupUnreadTotal(this.save);
    // 没有未读 → 什么都不显示（连"0"都不显示）
    dot.hidden = total === 0;
    dot.textContent = total === 0 ? '' : (total > 99 ? '99+' : String(total));
  }
  /** 邮箱红点：有可领的邮件就亮（未读也算，提醒去看） */
  updateMailDot() {
    const dot = document.getElementById('mail-dot');
    if (!dot) return;
    const n = claimableMailCount(this.save) || unreadMailCount(this.save);
    dot.hidden = n === 0;
  }

  /** 活动红点：有能领的免费礼包 / 首充礼包 / 累计充值档位 */
  updateActivityDot() {
    const dot = document.getElementById('act-dot');
    if (!dot) return;
    const o = activityOverview(this.save);
    const can = o.daily.canClaim || o.weekly.canClaim || o.first.canClaim
      || o.tiers.tiers.some((t) => t.canClaim);
    dot.hidden = !can;
  }

  /** 头像框：把当前佩戴的框类名贴到所有"我的头像"上（没有就清掉） */
  applyFrameClass() {
    const cls = frameClassOf(this.save);
    document.querySelectorAll('.user-avatar, .me-avatar, #prof-preview-img').forEach((img) => {
      const old = [...img.classList].filter((c) => c.startsWith('frame-'));
      old.forEach((c) => img.classList.remove(c));
      if (cls) img.classList.add(cls);
    });
  }

  /**
   * 每局结束后，随机让 1~2 个好友主动来搭话开启话题
   * 结合 memory 与好感度生成（模型不可用时用本地问候语），并计入未读红点
   */
  /**
   * 一局打完，谁来找玩家发消息（用户拍板的规则）：
   *   ① 上局**没有好友**参加 → 随机挑 **1~2 位好友**来发消息；
   *      它们可以编一段"自己刚打完的一局"（**不许提玩家**），也可以聊别的话题
   *   ② 上局**有好友**参加 → **只有参战的那几位**来聊刚刚那一局，其他好友**不发消息**
   */
  async pingFriendsAfterGame() {
    /**
     * ★ 用户拍板的节流规则：连着发满 2 条、玩家一句没回的 AI 不再主动发；
     *   所有好友都被挡住时，这局就谁都不发（玩家一回复就自动恢复）。
     *   新加的好友计数从 0 开始，不受影响。
     */
    const friends = listFriends(this.save).filter((f) => canPingPlayer(this.save, f.personaId));
    if (!friends.length) return;
    /**
     * ★ 等"这局的对局记忆"写完再问"刚打完的是哪一局"。
     *   不等的话这里读到的是 recentHands[0] = **上一局**，
     *   于是刚下完五子棋，好友来说的却是小猫钓鱼（用户报的 bug）。
     */
    const lastHand = await this.playedHandForPing();
    const participated = friends.filter((f) => this.matchJoinedBy(lastHand, f.personaId));

    let picks = [];
    let selfMatch = false; // true = 让 AI 编一段"自己的"对局（玩家没参加）
    if (participated.length) {
      // ② 只有参战的 AI 开口，聊刚打完那局
      picks = participated;
    } else {
      // ① 没人参战 → 随机 1~2 位（可以是没一起打的好友）
      selfMatch = true;
      const count = friends.length === 1 ? 1 : (Math.random() < 0.5 ? 1 : 2);
      picks = friends.slice();
      for (let i = picks.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [picks[i], picks[j]] = [picks[j], picks[i]];
      }
      picks = picks.slice(0, count);
    }

    picks.forEach((f, idx) => {
      const persona = PERSONAS.find((p) => p.id === f.personaId);
      if (!persona) return;
      // 隔一会儿再来消息，别和结算面板撞在一起；两位好友之间也错开
      const wait = 2200 + Math.random() * 1800 + idx * 2600;
      setTimeout(() => {
        void this.deliverFriendPing(persona, f.personaId, lastHand, { selfMatch });
      }, wait);
    });
  }

  /**
   * 发一条"主动搭话"
   * @param {number} [sentAt] 这条消息**模拟出来的发送时刻**（离线补发用）：
   *   给了它就按这个时间落库、并让提示词按这个时间说话；不给就是现在。
   * @param {boolean} [loverTone] ★ 恋人这一次可以**表达想念 / 倾诉**（用户拍板）：
   *   由"离线回来主动发消息"那条路径传进来；**只有真恋人**才吃得到（这里再用 isLover 兜一道）。
   */
  async deliverFriendPing(persona, personaId, lastHand, { selfMatch = false, sentAt, loverTone = false } = {}) {
    const friend = findFriend(this.save, personaId);
    if (!friend) return; // 期间被删了好友就跳过
    /**
     * ★ 恋人关系（用户拍板）：先确认"他现在还是不是我的恋人"——
     *   loverTone 只对真恋人放行，非恋人好友**永远**拿不到"可以说想他"那行提示词，
     *   也拿不到恋爱口吻的本地兜底（见 ai/friend.js 的 proactiveMessage）。
     */
    const lover = isLover(this.save, personaId);
    const tone = lover && !!loverTone;
    const title = aiTitleOf(this.save, personaId);
    const hand = lastHand === undefined ? (this.save.recentHands || [])[0] || null : lastHand;
    // ★ 模拟时刻：让 AI 知道"我这条是凌晨 2 点写的"，语气才对得上
    const at = Number.isFinite(Number(sentAt)) ? Number(sentAt) : Date.now();
    const { text } = await proactiveMessage({
      persona,
      friend,
      myBeans: aiBeansOf(this.save, personaId),
      myTitle: title ? title.name : '',
      // 参加了才允许聊这一局；没参加只能"听说/问问"
      lastMatch: hand,
      joined: this.matchJoinedBy(hand, personaId),
      // 上局没好友参加：允许它编一段"自己刚打完的局"（但**不许提玩家**）
      selfMatch,
      modeName: hand ? MODE_NAME[hand.kind] || '' : '',
      playerGender: playerGenderLine(this.save),
      // 玩家是谁：对局概括里的昵称就是他本人
      playerName: this.playerName,
      playerIdentity: playerIdentityLines(this.save, { callName: callNameOf(findFriend(this.save, personaId)), selfId: personaId }),
      // ★ 恋人关系要共享：关系档位、提示词、兜底问候都跟着它走
      lover,
      loverTone: tone,
      // ★ 用模拟出来的时刻当"现在"，所以它会说"这点还没睡？"而不是按上线时刻说话
      now: new Date(at),
    });
    if (!text) return;
    if (!findFriend(this.save, personaId)) return;
    appendChat(this.save, personaId, 'ai', text, { at });
    // ★ 记一次"主动发消息"：连着 2 条没人回就不再发（见 canPingPlayer）
    bumpPendingPing(this.save, personaId);
    /**
     * ★ 玩家此刻正开着这个人的聊天 → **不要点红点**（用户报的 bug：
     *   刚加好友时明明停在聊天界面，对方那条还是亮着未读）。
     *   人就在看，直接算已读。
     */
    if (this.friendsActiveWith === personaId) {
      clearUnread(this.save, personaId);
      this.persist('friendRead');
    } else {
      bumpUnread(this.save, personaId);
    }
    this.persist('friendPing');
    this.updateFriendDot();
    this.refreshFriendsPanel();
    toast(`「${persona.name}」给你发了条消息`, 'gold');
  }

  /* ------------------------------ 友圈 ------------------------------ */
  /**
   * 玩家发了一条说说 → 挑几位好友陆续来点赞 + 评论（用户拍板的节奏）
   *   · 先让审查 AI 挑人（失败用本地规则：@ 谁谁来 + 随机 2~4 位；好友 <3 全来）
   *   · 第一条评论 10~30s，之后每条 2~30s —— 不会一窝蜂
   *   · 点赞比评论早一点点，像"先划到、后留言"
   *   · ★ 好友自己发的说说（`by` = personaId）会自动排掉**作者本人**；
   *     表白那条（恋人发的）还会排掉**恋人自己**（用户拍板：评论不含作者 / 不含恋人）
   */
  async scheduleMomentCommenters(momentId, text) {
    const moment0 = findMoment(this.save, momentId);
    const skip = new Set();
    if (moment0 && moment0.by && moment0.by !== 'me') {
      skip.add(moment0.by);
      if (isLover(this.save, moment0.by)) skip.add(this.save.loverId);
    }
    const friends = listFriends(this.save).map((f) => ({
      ...f, persona: PERSONAS.find((p) => p.id === f.personaId) || null,
    })).filter((f) => f.persona && !skip.has(f.personaId));
    if (!friends.length) return; // 一个好友都没有 → 没人评论
    const { ids } = await chooseCommenters({ text, friends, playerName: this.playerName });
    const picks = ids.map((id) => friends.find((f) => f.personaId === id)).filter(Boolean);
    if (!picks.length) return;
    const moment = findMoment(this.save, momentId);
    if (!moment) return; // 期间说说被清了

    const schedule = commentSchedule(picks.length);
    picks.forEach((f, idx) => {
      const wait = schedule[idx] || 10000;
      // 先点赞（提前 600~2000ms），评论再跟上
      setTimeout(() => {
        const m = findMoment(this.save, momentId);
        if (!m || !isFriend(this.save, f.personaId)) return;
        if (!hasLiked(this.save, momentId, f.personaId)) toggleMomentLike(this.save, momentId, f.personaId);
        this.persist('momentLike');
        this.refreshFriendsPanel();
      }, Math.max(1200, wait - (600 + Math.random() * 1400)));
      setTimeout(() => {
        // 返回 promise：浏览器里没用，测试里可以 await 到"评论真的写完了"
        return this.deliverMomentComment(momentId, f.personaId, { text });
      }, wait);
    });
  }

  /**
   * 某位好友来评论一条说说（模型不可用时走本地语料）
   * @param {{aiMoment?:boolean, at?:number}} [opts]
   *   ★ aiMoment = 这条说说**是好友自己发的**（不是玩家发的）：
   *     提示词与兜底都按"评论朋友的动态"来（见 ai/moments.js 的 aiPost 分支），
   *     免得它对着朋友的说说用"你"称呼玩家、或者说得像在回玩家。
   *   ★ at = 这条评论**应该显示成什么时候**（毫秒时间戳）；
   *     离线补发的那批要把时间落回"玩家不在线"的那段窗口里（不传就是此刻）。
   */
  async deliverMomentComment(momentId, personaId, {
    text = '', replyTo = null, replyText = '', aiMoment = false, at = 0,
  } = {}) {
    const backfilled = Number(at) > 0;
    const stamp = backfilled ? Number(at) : Date.now();
    const friend = findFriend(this.save, personaId);
    const persona = PERSONAS.find((p) => p.id === personaId);
    if (!friend || !persona || !isFriend(this.save, personaId)) return; // 期间被删好友就跳过
    const moment = findMoment(this.save, momentId);
    if (!moment) return;
    const { text: line } = await momentComment({
      persona,
      friend,
      text: text || moment.text,
      aiPost: aiMoment || (moment.by && moment.by !== 'me'),
      authorName: (PERSONAS.find((p) => p.id === moment.by) || {}).name || '',
      comments: recentMomentComments(moment, 6),
      replyTo,
      replyText,
      playerName: this.playerName,
      playerGender: playerGenderLine(this.save),
      playerIdentity: playerIdentityLines(this.save, { callName: callNameOf(friend), selfId: personaId }),
      // 基本信息：它自己的身家与称号（和私聊一个口径）
      myBeans: aiBeansOf(this.save, personaId),
      myTitle: (aiTitleOf(this.save, personaId) || {}).name || '',
    });
    if (!line) return;
    if (!findMoment(this.save, momentId) || !isFriend(this.save, personaId)) return;
    addMomentComment(this.save, momentId, { by: personaId, text: line, at: stamp });
    // 评论的时候也顺手点个赞
    if (!hasLiked(this.save, momentId, personaId)) toggleMomentLike(this.save, momentId, personaId);
    /**
     * ★ 友圈也会进记忆（用户要求，和对局一样**不占常规记忆**）：
     *   记下**说说内容 + 我的评论 + 评论区里我和他最后 3 轮对话**，
     *   只留它评论过的**最新 2 条**，同一条说说再评论就覆盖旧的那条。
     */
    const latest = findMoment(this.save, momentId);
    addMomentMemory(this.save, personaId, {
      text: text || moment.text,
      comment: line,
      comments: (latest && latest.comments) || [],
    });
    this.persist('momentComment');
    this.refreshFriendsPanel();
    this.updateFriendDot();
    const onMoments = !document.getElementById('moments-body')?.hidden;
    // ★ 离线补发的那批**不弹提示**：那是"你不在的时候"发生的事，回来再弹一串金框很吵
    if (onMoments && !backfilled) toast(`「${persona.name}」评论了你的说说`, 'gold');
  }

  /**
   * 玩家在友圈里**回复**了某位好友的评论 → 那位好友接着回一条
   * （放在 app 里而不是界面里：回复同样要写进记忆，只留一个出口）
   *
   * ★ 中间空 **1~5 秒**再回（用户拍板）：太快像机器人，太慢玩家以为它不理人。
   *   等完再确认一次好友/说说还在（期间可能被删好友 / 清存档）。
   *
   * @param {string} commentId 玩家回复的**那条 AI 评论**的 id
   * @param {string} replyText 玩家说的那句
   * @param {{playerCommentId?:string}} [opts] 玩家这条回复自己的 id
   *   ★ 它回的那条要挂在**玩家这句**下面（"回复 玩家"），
   *     以前错挂在自己的评论下面，看着像"AI 回它自己"（用户报的 bug）
   */
  async replyToMomentComment(momentId, commentId, replyText, opts = {}) {
    const moment = findMoment(this.save, momentId);
    if (!moment) return null;
    const target = findMomentComment(moment, commentId);
    if (!target || target.by === 'me') return null;
    const persona = PERSONAS.find((p) => p.id === target.by);
    const friend = findFriend(this.save, target.by);
    if (!persona || !friend || !isFriend(this.save, target.by)) return null;
    // 玩家那句（优先用界面传进来的 id；没传就找最近一条"回复了这条评论"的玩家评论）
    const playerComment = opts.playerCommentId
      ? findMomentComment(moment, opts.playerCommentId)
      : moment.comments.filter((c) => c.by === 'me' && c.replyTo === commentId).pop() || null;
    await sleep(replyDelayMs());
    // 等完再看一眼：删了好友 / 清了存档就别回了
    const stillMoment = findMoment(this.save, momentId);
    if (!stillMoment || !isFriend(this.save, target.by)) return null;
    const { text: line } = await momentComment({
      persona,
      friend: findFriend(this.save, target.by) || friend,
      text: stillMoment.text,
      comments: recentMomentComments(stillMoment, 6),
      replyTo: target,
      replyText,
      playerName: this.playerName,
      playerGender: playerGenderLine(this.save),
      playerIdentity: playerIdentityLines(this.save, { callName: callNameOf(findFriend(this.save, target.by)), selfId: target.by }),
      myBeans: aiBeansOf(this.save, target.by),
      myTitle: (aiTitleOf(this.save, target.by) || {}).name || '',
    });
    if (!line) return null;
    if (!isFriend(this.save, target.by)) return null;
    // 挂在**玩家那句**下面；玩家那句要是已经被删了，就不带引用
    const playerLine = playerComment ? findMomentComment(findMoment(this.save, momentId) || stillMoment, playerComment.id) : null;
    const added = addMomentComment(this.save, momentId, {
      by: target.by, text: line, replyTo: playerLine ? playerLine.id : '',
    });
    if (!added.ok) return null;
    if (!hasLiked(this.save, momentId, target.by)) toggleMomentLike(this.save, momentId, target.by);
    // 回复也算这次友圈互动 → 覆盖那条「友圈」记忆（带上评论区最后 3 轮对话）
    const latest = findMoment(this.save, momentId);
    addMomentMemory(this.save, target.by, {
      text: stillMoment.text,
      comment: line,
      comments: (latest && latest.comments) || [],
    });
    this.persist('momentReply');
    this.refreshFriendsPanel();
    this.updateFriendDot();
    return line;
  }

  openChat() {
    audio.resume();
    panels.openChat(this);
  }

  /**
   * 从别处（比如友圈评论里蓝色的名字）**直接跳到和某位好友的私聊**
   * 面板本身就是"社交"，只是把左侧选中的人切过去。
   */
  openFriendChat(personaId) {
    if (!personaId) return;
    if (!isFriend(this.save, personaId)) { toast('这位现在不是你的好友了'); return; }
    audio.resume();
    friendsPanel.openFriends(this, { personaId });
  }

  claimRelief() {
    const res = this.economy.claimRelief();
    if (!res.ok) return toast(res.error, 'bad');
    audio.play('coin');
    toast(`救济金到账 💰 +${res.amount.toLocaleString()}`, 'good');
    this.refreshLobby();
  }

  /* ------------------------------ 路由 ------------------------------ */
  /**
   * 切界面 —— 顺手把 BGM 场景也切了（用户拍板）：
   *   · 牌桌 / 小猫钓鱼 / 五子棋 → music/battle.mp3
   *   · 加载页 / 大厅 / 其他所有场景 → music/background.mp3
   * 文件不存在时自动退回原来那套合成 BGM（见 ui/audio.js）。
   */
  showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('is-active', el.id === id));
    const inGame = id === 'screen-table' || id === 'screen-fishing' || id === 'screen-gomoku';
    audio.setScene(inGame ? 'battle' : 'background');
    audio.startBgm(); // 没有用户在播放时才会真的开始（浏览器自动播放策略）
    /**
     * ★ 在线定时发友圈（用户拍板）：只在**停在大厅**时才让它继续
     *   · 进牌桌 / 钓鱼 / 五子棋 / 匹配中 / 设置向导 → 先停下（别打断玩家）
     *   · 回到大厅 → 重新排一次（2~5 分钟后那档）
     *   注意：这里不判断 `document.hidden`（那是"切后台"，见 bindOnlineMomentTracking）——
     *   混在一起会让"切后台再回来"永远起不来。
     */
    if (id === 'screen-lobby') this.resumeOnlineMoments({ restart: true });
    else this.stopOnlineMoments({ resume: true });
  }

  isTableActive() { return document.getElementById('screen-table').classList.contains('is-active'); }

  /* ------------------------------ 开局 ------------------------------ */
  /**
   * @param {string} roomId
   * @param {string[]} [roomFriendIds] 房间模式的好友
   * @param {{invited?:boolean, startDelayMs?:number, waitText?:string}} [opts]
   *   invited = 这是**AI 房主邀请**进来的（3~5 秒后才真正开局）
   */
  startGame(roomId, roomFriendIds, opts = {}) {
    // 玩家自己开的局（不是被邀请的）→ 解除"点过 ✗"的免打扰
    if (!opts.invited) this.clearInviteMute();
    const room = ROOMS.find((r) => r.id === roomId) || ROOMS[0];
    const can = this.economy.canEnter(room);
    if (!can.ok) {
      toast(can.reason, 'bad');
      panels.openShop(this);
      return;
    }
    // 房间模式：先开房间邀请好友，人满才真正开局
    if (this.mode === 'room' && !roomFriendIds) {
      panels.closePanel();
      friendsPanel.openRoom(this, roomId);
      return;
    }
    panels.closePanel();
    this.currentRoom = room;
    this.gameKind = 'ddz';
    this.matchWrite = null; // 新的一局：上一局的对局记忆任务作废（见 playedHandForPing）
    if (roomFriendIds) this.lastRoomFriends = roomFriendIds.slice();
    this.resetToolUsage();
    this.urgentSaid = new Set();
    this.chatLog = [];
    this.quittingAsLoss = false;

    /* 座位信息 + 人设（PRD Q17/Q19）：房间模式用你邀请的好友 */
    const picks = this.pickSeatPersonas(roomFriendIds, room);
    const isRoom = !!(roomFriendIds && roomFriendIds.length);
    // AI 模式的随机匹配：先走一段"正在匹配…"的过场再进桌
    // （房间模式已经在房间里等人了；机器模式保持"安静快速"，都不做过场）
    if (this.mode === 'ai' && !isRoom) {
      this.openMatching(picks, () => this.enterTable(picks, room, false));
      return;
    }
    this.enterTable(picks, room, isRoom);
  }

  /**
   * 真正进桌：建 Game + Table，并安排开局问候
   * @param {{startDelayMs?:number, waitText?:string, hostName?:string}} opts
   *   startDelayMs > 0 = AI 房主邀请进来的房间：先不开始，等几秒（期间退出就不开局）
   */
  enterTable(picks, room, isRoom, opts = {}) {
    // 只有 AI 模式的对手才吃"全局 AI 身家"；机器模式的对手是匿名机器人
    this.seatPersonas = this.aiEnabled ? picks : [null, null];
    this.seatNames = [this.playerName, picks[0]?.name || '机器人·右', picks[1]?.name || '机器人·左'];
    this.seatAvatars = [playerAvatarSrc(this.save), picks[0]?.avatar || 'avatar_02', picks[1]?.avatar || 'avatar_03'];
    const personas = [null, this.aiEnabled ? picks[0] : null, this.aiEnabled ? picks[1] : null];

    if (this.table) this.table.destroy();

    this.game = new Game({
      room,
      personas,
      names: this.seatNames,
      avatars: this.seatAvatars,
      // 座位 0 用玩家真实身家；两个 AI 用它们在存档里的**全局身家**
      // （机器模式下人设不参与，但仍按场次门槛抽身家合格的 AI）
      beans: [
        this.save.beans,
        this.aiBeansFor(picks[0], room),
        this.aiBeansFor(picks[1], room),
      ],
      mode: this.mode,
      // 洗牌开关（只对斗地主生效；小猫钓鱼固定每局洗牌）
      shuffleOn: this.save.settings.shuffle !== false,
    });

    this.showScreen('screen-table');
    this.table = new TableController(this, this.game, {
      startDelayMs: opts.startDelayMs || 0,
      waitText: opts.waitText || '',
    });
    audio.startBgm();
    this.scheduleOpeningLines(picks, isRoom);
    if (this.save.isNewbie) {
      this.save.isNewbie = false;
      this.persist('newbie');
      toast(`欢迎！已赠送 💰 ${ECON.newPlayerBeans.toLocaleString()} 开心豆`, 'gold');
    }
  }

  /**
   * 开局问候（连续记忆的轻量版）
   *  - AI 模式随机匹配：碰到**好友**就打招呼；碰到**上一局刚打过的对手**就提一句上一局
   *    （只认"上一局"，再早的就不提了，免得 AI 负担太重、也免得记错）
   *  - 都轮不到，就回到原来的行为：随机一位 AI 说句开场白
   *  - 房间模式是你自己请进来的，不做"偶遇"那套
   */
  scheduleOpeningLines(picks, isRoom) {
    if (!this.aiEnabled) return;
    if (isRoom) {
      const seat = 1 + Math.floor(Math.random() * 2);
      setTimeout(() => this.aiScene(seat, 'greeting'), 700);
      return;
    }
    const prevHand = this.prevHand || (this.save.recentHands || [])[0] || null;
    const plans = [];
    for (let i = 0; i < 2; i += 1) {
      const p = picks[i];
      if (!p) continue;
      // 注意：这里不能写成 `const isFriend = isFriend(...)` —— 右侧会解析到正在
      // 声明的局部常量（TDZ），直接抛 ReferenceError，整段问候都跑不到
      const alreadyFriend = isFriend(this.save, p.id);
      const metLastHand = this.matchJoinedBy(prevHand, p.id);
      if (!alreadyFriend && !metLastHand) continue;
      plans.push({ seat: i + 1, persona: p, isFriend: alreadyFriend, metLastHand });
    }
    if (!plans.length) {
      const seat = 1 + Math.floor(Math.random() * 2);
      setTimeout(() => this.aiScene(seat, 'greeting'), 700);
      return;
    }
    plans.forEach((plan, idx) => {
      setTimeout(() => {
        if (!this.game || this.gameKind !== 'ddz') return;
        const p = greetingPlan({ isFriend: plan.isFriend, metLastHand: plan.metLastHand });
        const last = this.lastMatchOf(plan.persona.id);
        this.aiScene(plan.seat, p.scene, {
          eventText: plan.isFriend
            ? metFriendBrief(plan.persona.name)
            : metAgainBrief(plan.persona.name, last ? last.summary : ''),
          priority: true,
          forceSituation: true,
          situationKey: p.situationKey,
        });
      }, 900 + idx * (CONFIG.ai.eventStaggerMs || 0));
    });
  }

  /**
   * AI 模式的"匹配"界面：三个座位（头像 + 昵称）
   * 第 1 位默认就是你自己；`正在匹配…` → `已找到 1/3` → `2/3` → `3/3`，
   * 每报一个数就把对应座位的头像与昵称填上，同时"叮"一声。
   * 只有"填满"这一种状态变化，没有动画；点一下可以跳过，不用干等。
   * @param {{name:string, avatar:string}[]} picks 这一局的两个人设（进桌前就抽好了）
   */
  openMatching(picks, done) {
    const screen = document.getElementById('screen-matching');
    const list = document.getElementById('match-seats');
    const tip = document.getElementById('match-tip');
    if (!screen || !list || !tip) { done(); return; }

    const need = MATCH.needs || 3;
    const names = [this.playerName, picks[0]?.name || '对手', picks[1]?.name || '对手'];
    // ★ 自己那一格用 playerAvatarSrc（上传的照片），不是预设 id —— 否则上传过照片的玩家
    //   在匹配动画里还是默认头像（用户报的问题）。对手用 ASSETS.avatar 映射人设头像。
    const avatars = [
      playerAvatarSrc(this.save),
      ASSETS.avatar(picks[0]?.avatar || 'avatar_02'),
      ASSETS.avatar(picks[1]?.avatar || 'avatar_03'),
    ];
    // 三个座位：第 1 个（你自己）直接就是填好的（金色描边），另外两个先放"?"
    list.innerHTML = names.map((_, i) => {
      const mine = i === 0;
      return `
      <div class="match-seat ${mine ? 'is-me' : ''}" data-slot="${i}">
        <div class="match-seat-face">${mine ? `<img src="${ASSETS.avatar(avatars[i])}" alt="" />` : '?'}</div>
        <span class="match-seat-name">${mine ? names[i] : '匹配中…'}</span>
      </div>`;
    }).join('');
    tip.textContent = '正在匹配…';
    this.showScreen('screen-matching');

    /** 把某个对手位的头像与昵称填上 */
    const fill = (slot) => {
      const node = list.querySelector(`[data-slot="${slot}"]`);
      if (!node) return;
      node.classList.add('is-in');
      node.querySelector('.match-seat-face').innerHTML = `<img src="${ASSETS.avatar(avatars[slot])}" alt="" />`;
      node.querySelector('.match-seat-name').textContent = names[slot];
    };

    const timers = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      screen.removeEventListener('click', finish);
      done();
    };
    // 点一下跳过（过场只是气氛，不该拦着玩家）
    screen.addEventListener('click', finish);

    const t0 = MATCH.introMs || 400;
    const gap = MATCH.seatMs || 800;
    // 第 1/3 是你自己（早就坐好了、不打"叮"），后面两个才是真的"匹配到了"
    timers.push(setTimeout(() => { tip.textContent = `已找到 1/${need}`; }, t0));
    timers.push(setTimeout(() => {
      fill(1);
      audio.play('ding');
      tip.textContent = `已找到 2/${need}`;
    }, t0 + gap));
    timers.push(setTimeout(() => {
      fill(2);
      audio.play('ding');
      tip.textContent = `已找到 ${need}/${need}`;
    }, t0 + 2 * gap));
    timers.push(setTimeout(finish, t0 + 2 * gap + (MATCH.settleMs || 600)));
  }

  pickPersonas() {
    const pool = [...PERSONAS];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return [pool[0], pool[1]];
  }

  /**
   * 抽这一局的对手：只从**身家达到本场次门槛**的 AI 里随机抽（PRD §2.14）
   * 一个能打的都没有时，会自动给几个非好友 AI 输血（极端兜底）
   */
  pickPersonasByRoom(room) {
    const { picks, rescued } = pickEligiblePersonas(this.save, room, 2);
    if (picks.length < 2) return { picks: this.pickPersonas(), rescued };
    if (rescued) this.persist('aiRescue');
    return { picks, rescued };
  }

  /** 座位人设：房间模式优先用邀请的好友（身家不足先补到门槛），缺位用能打的 AI 补上 */
  pickSeatPersonas(friendIds, room) {
    const r = room || this.currentRoom || ROOMS[0];
    if (!friendIds || !friendIds.length) return this.pickPersonasByRoom(r).picks;
    const picked = friendIds
      .map((id) => PERSONAS.find((p) => p.id === id))
      .filter(Boolean);
    for (const p of picked) {
      if (topUpForRoom(this.save, p.id, r).topped) this.persist('aiTopUp');
    }
    const fallback = this.pickPersonasByRoom(r).picks;
    while (picked.length < 2) picked.push(fallback[picked.length] || fallback[0]);
    return picked.slice(0, 2);
  }

  /** 该座位带进本局的身家：真实 AI 用存档里的全局身家，匿名机器人给足额虚拟身家 */
  aiBeansFor(persona, room) {
    if (!persona) return Math.max(room.minBeans, room.cap) * 2;
    return Math.max(1, aiBeansOf(this.save, persona.id));
  }

  quitGame() {
    if (!this.game) return;
    const quitting = this.game.phase !== 'over';
    if (quitting && CONFIG.exitRule === 'lose') {
      // EXIT_RULE='lose' 时：中途退出按“认输”结算（当前默认为 'void'，本局作废）
      this.quittingAsLoss = true;
      const landlord = this.game.landlordSeat;
      this.game.finish(landlord === 0 ? [1, 2][0] : landlord);
      return;
    }
    if (this.table) this.table.destroy();
    this.game = null;
    this.table = null;
    /**
     * ★ 退出登录界面（用户拍板）：在线发友圈的定时器也要收掉 ——
     *   人都不在大厅了，不该再往后堆说说。下次回大厅时 showScreen 会重新起。
     */
    this.stopOnlineMoments({ resume: true });
    this.showScreen('screen-lobby');
    this.refreshLobby();
    /**
     * ★ 用户报的 bug：在**结算面板**上点「返回大厅」也会弹"本局作废，不结算"。
     *   只有"牌还没打完就退出"才是作废；这一局已经打完、钱也结过了，
     *   这时候不该再报"不结算"（看着像白打了一局）。
     */
    if (quitting) toast('已退出本局（本局作废，不结算）');
  }

  /* ------------------------------ 结算 ------------------------------ */
  /**
   * AI 身家结算（PRD §2.14）
   * - 参战的两个 AI 按本局 deltas 增减
   * - 其他 AI 按当前身家随机 +0~20% / -0~10%
   * - 顺带给身家过低的 AI 发低保（每个 AI 每日一次）
   * 中途退出（本局作废）不调用这里：AI 的身家一分不动
   */
  settleAiEcon(result) {
    const seatIds = [null, ...(this.seatPersonas || []).map((p) => (p && p.id) || null)];
    const changes = applyAiSettlement(this.save, seatIds, result.deltas);
    const idle = pulseIdleAi(this.save, seatIds.filter(Boolean));
    const relief = grantAiRelief(this.save);
    this.lastAiChanges = { changes, idle, relief };
    this.persist('aiEcon');
    return this.lastAiChanges;
  }

  onGameOver(result) {
    // 记下这一局的实例：结算面板要延迟弹，期间玩家可能已经退出或又开了一局
    const gameAtOver = this.game;
    this.economy.applySettlement(result, this.currentRoom);
    // 退出认输的局：本局作废，AI 身家不变（"必须要正常打完"）
    if (!this.quittingAsLoss) {
      this.settleAiEcon(result);
      const seatIds = (this.seatPersonas || []).map((p) => (p && p.id) || null).filter(Boolean);
      // 记下"上一局跟谁打的"：下一局的"又碰上了"要用它（内存里立刻就有，
      // 不等异步的 50~100 字概括写完，否则点了「再来一局」会漏掉）
      this.prevHand = {
        seatIds, humanWin: (result.landlordSeat === 0) === result.landlordWin, delta: result.deltas[0], at: Date.now(),
      };
      // 把这局浓缩成 50~100 字概括，写进参战双方的记忆（异步，不挡结算面板）
      const facts = ddzFacts(result, {
        room: this.currentRoom,
        names: this.seatNames,
        seatPersonas: this.seatPersonas,
      });
      this.matchWrite = this.recordMatchMemory({
        kind: 'ddz',
        facts,
        seatIds,
        room: this.currentRoom,
        humanWin: (result.landlordSeat === 0) === result.landlordWin,
        delta: result.deltas[0],
        // 每个座位的输赢（两个 AI 可能一个赢一个输，各自的记忆要分开写）
        deltas: result.deltas,
      });
    }
    const springy = !!(result.spring || result.antiSpring);
    let springDone = null;
    if (this.aiEnabled) {
      if (springy) {
        // 春天 / 被反杀（反春）：**每个 AI 都要说一句**，赢的那侧欢呼、输的那侧懵
        springDone = this.aiSpringSpeak(result);
      } else {
        for (const seat of [1, 2]) {
          const won = (seat === result.landlordSeat) === result.landlordWin;
          this.aiScene(seat, won ? 'win' : 'lose');
        }
      }
      // 陪打一局也加好感：自己邀请的 +3，随机匹配碰上的 +1（没加好友的不算）
      this.rewardFriendPlay(this.seatPersonas, this.isRoomMode && !!this.lastRoomFriends);
    }
    this.refreshLobby();

    if (this.quittingAsLoss) {
      this.quittingAsLoss = false;
      if (this.table) this.table.destroy();
      this.game = null;
      this.table = null;
        this.showScreen('screen-lobby');
      this.refreshLobby();
      toast('已认输，本局按当前倍数结算', 'bad');
      return;
    }

    const openResult = () => {
      // 期间玩家可能已经退出 / 又开了一局，这时不要再弹上一个结算
      if (this.game !== gameAtOver) return;
      panels.showResult(this, result, this.currentRoom, {
        onAgain: () => this.startGame(this.currentRoom.id, this.mode === 'room' ? this.lastRoomFriends : undefined),
        onQuit: () => this.quitGame(),
      });
    };
    if (springy && springDone) {
      // 等两位 AI 把春天/被反杀的话说完再弹面板（超时由 springGateMs 兜住）
      springDone.then(() => setTimeout(openResult, 420));
    } else {
      setTimeout(openResult, 700);
    }
    // 打完了，好友可能来找你聊两句（要等这局的对局记忆写完，见 playedHandForPing）
    void this.pingFriendsAfterGame();
  }

  /* ------------------------------ AI 编排 ------------------------------ */
  /** 视图分发：斗地主 / 小猫钓鱼 / 五子棋 各有一套（模式写在 view.mode 里） */
  viewFor(seat, scene, extra) {
    if (this.gameKind === 'fishing' && this.fishing) {
      // 钓鱼视图抽在 ai/fishingView.js 里（纯函数，带座位约定的说明与测试）
      return fishingView({
        game: this.fishing.game,
        seat,
        extra: { ...(extra || {}), friendLines: this.friendLinesFor(this.fishing.persona) },
      });
    }
    if (this.gameKind === 'gomoku' && this.gomoku) {
      // ★ 五子棋**有自己的视图**：以前落到下面 buildView()（那是斗地主的），
      //   提示词里写着"你在玩三人斗地主""你的身份：地主/农民"，
      //   于是 AI 在棋盘上说"出一张牌"（用户报的 bug）
      const g = this.gomoku;
      return gomokuView({
        board: g.board,
        moves: moveCount(g.board),
        last: g.history[g.history.length - 1] || null,
        playerColor: g.playerColor,
        turn: g.turn,
        over: g.over,
        winner: g.winner || null,
        extra: {
          ...(extra || {}),
          friendLines: this.friendLinesFor(g.persona),
          playerGender: playerGenderLine(this.save),
        },
      });
    }
    return this.buildView(seat, scene, extra);
  }

  /**
   * 这个 AI 该知道的"和玩家是什么关系"（好感度 / 关系 / 称呼 / 记忆）
   * 私聊、房间弹幕、牌桌台词、小猫钓鱼都走这一份，保证到处共享
   */
  friendLinesFor(persona, opts) {
    const p = persona || null;
    if (!p || !this.aiEnabled) return [];
    return friendContextLines(this.save, findFriend(this.save, p.id), opts);
  }

  buildView(seat, scene, extra) {
    const g = this.game;
    const rel = (s) => (s === seat ? '你' : s === 0 ? '玩家' : `${this.seatNames[s]}`);
    // 最近 5 手出牌（从早到晚）：AI 能"接着刚才那几手"说，而不是只看最后一张
    const recent = g.history.slice(-5)
      .map((h) => `${rel(h.seat)}${h.play ? `出 ${handToString(h.play.cards)}` : '不出'}`);
    const base = {
      isLandlord: g.landlordSeat === seat,
      // 只给张数：具体是什么牌留在自己心里（提示词里明令"不要报牌"）
      handReportLine: `你的手牌：${g.hands[seat].length} 张（具体是什么牌只有你知道，**不要念出来**）`,
      countsText: [0, 1, 2].map((s) => `${rel(s)} ${g.hands[s].length} 张`).join('，'),
      multiplier: 2 ** (g.robs + g.bombs + g.rockets),
      bombs: g.bombs + g.rockets,
      lastText: g.lastPlay ? `${rel(g.lastPlay.seat)} 出了 ${handToString(g.lastPlay.play.cards)}` : '',
      historyLabel: '最近 5 手出牌（从早到晚）',
      historyText: recent.join('；'),
      situationText: extra && extra.situation ? extra.situation.text : '',
      // 大事件（炸弹 / 春天 / 碰到熟人）的背景说明：让模型知道"发生了什么、我该什么态度"
      eventText: extra && extra.eventText ? extra.eventText : '',
      // ★ 和玩家的关系（好感度 / 关系 / 称呼 / 记忆）：牌桌台词也照这个口气说
      friendLines: this.friendLinesFor(g.personas[seat], { table: true }),
      // 玩家性别：牌桌上叫错称呼最出戏（见 data/player.js）
      playerGender: playerGenderLine(this.save),
      playerText: extra && extra.playerText ? extra.playerText : '',
    };
    void scene;
    return base;
  }

  /** 明确要求说一句（问候 / 胜负 / 道具等）；返回台词 Promise，方便"等两位 AI 都说完" */
  aiScene(seat, scene, extra) {
    if (!this.aiEnabled || this.gameKind !== 'ddz' || !this.game) return null;
    if (seat === 0) return null;
    const persona = this.game.personas[seat];
    if (!persona) return null;
    const situation = buildSituation(this.game, seat, this.seatNames);
    return this.chat.speak(seat, scene, persona, { ...(extra || {}), situation });
  }

  /**
   * 按局势决定要不要说话（出牌 / 过牌 / 叫抢地主）
   * AI 不再每出一手牌都开口，只在关键节点或一定概率下发言，且说的是当前局势
   */
  aiReact(seat, kind, detail = {}) {
    if (!this.aiEnabled || this.gameKind !== 'ddz' || !this.game) return;
    if (seat === 0) return;
    const persona = this.game.personas[seat];
    if (!persona) return;
    const situation = buildSituation(this.game, seat, this.seatNames);
    // 关键局势（地主快走完、搭档剩一张…）每位 AI 每种局势只强调一次
    const ukey = `${seat}:${situation.key}`;
    const firstTime = situation.urgent && !this.urgentSaid.has(ukey);
    if (situation.urgent) this.urgentSaid.add(ukey);
    const scene = pickScene(kind, detail, { ...situation, urgent: firstTime }, CONFIG.ai.chance);
    if (!scene) return;
    // 让大部分台词都贴着局势说，而不是泛泛而谈
    const hasKey = situation.key && situation.key !== 'normal';
    const forceSituation = !!hasKey && (firstTime || Math.random() < 0.5);
    // 出牌 / 叫抢地主必说：绕过全局间隔，用很短的间隔，保证"每次都有话"
    const mustSpeak = kind === 'play' || kind === 'bid' || kind === 'rob';
    this.chat.speak(seat, scene, persona, {
      situation,
      priority: mustSpeak || firstTime,
      minGap: mustSpeak ? CONFIG.ai.playMinGap : CONFIG.ai.minGap,
      forceSituation,
      situationKey: forceSituation ? situation.key : null,
    });
  }

  /**
   * 大事件：桌上**每个 AI 都开口**，而且是按"自己和出牌者什么关系"换口吻
   *   · bomb：炸弹 / 王炸 —— 本人得意、同伙叫好、对手惊讶
   * 两位 AI 错开 `eventStaggerMs` 开口：同一瞬间弹两条气泡太假。
   * 返回每个 AI 的台词 Promise（春天局要等它们说完再弹结算面板）。
   */
  aiEventSpeak(event, actorSeat, extra = {}) {
    if (!this.aiEnabled || this.gameKind !== 'ddz' || !this.game) return [];
    const landlordSeat = this.game.landlordSeat;
    if (landlordSeat == null) return [];
    const jobs = [];
    const stagger = CONFIG.ai.eventStaggerMs || 0;
    let i = 0;
    for (const seat of [1, 2]) {
      const persona = this.game.personas[seat];
      if (!persona) continue;
      const plan = event === 'bomb'
        ? bombPlan(seat, actorSeat, landlordSeat)
        : null;
      if (!plan) continue;
      const actorName = this.seatNames[actorSeat];
      const eventText = bombBrief({
        relation: plan.relation,
        actorName,
        isRocket: !!(extra && extra.isRocket),
      });
      const delay = i * stagger;
      i += 1;
      jobs.push(new Promise((resolve) => {
        setTimeout(() => {
          resolve(this.aiScene(seat, plan.scene, {
            eventText,
            priority: true,
            forceSituation: true,
            situationKey: plan.situationKey,
          }));
        }, delay);
      }));
    }
    return jobs;
  }

  /**
   * 春天 / 被反杀：赢的那侧欢呼、输的那侧懵，也是每个 AI 一句
   * 把"每个 AI 都说完"做成 Promise，结算面板等它（最多等 `gateMs`）
   */
  aiSpringSpeak(result) {
    if (!this.aiEnabled || !this.game) return Promise.resolve();
    const stagger = CONFIG.ai.eventStaggerMs || 0;
    const jobs = [1, 2].map((seat, i) => new Promise((resolve) => {
      setTimeout(() => {
        const plan = springPlan(seat, result.landlordSeat, result.landlordWin);
        const eventText = springBrief({
          spring: !!result.spring,
          antiSpring: !!result.antiSpring,
          won: plan.won,
        });
        resolve(this.aiScene(seat, plan.scene, {
          eventText,
          priority: true, // 绕开全局间隔，保证两个人都能开口
          forceSituation: true,
          situationKey: plan.situationKey,
        }));
      }, i * stagger);
    }));
    // 模型可能慢或超时，最多等这么久，别让玩家盯着空桌子
    return Promise.race([
      Promise.all(jobs),
      new Promise((r) => { setTimeout(r, CONFIG.ai.springGateMs || 4000); }),
    ]);
  }

  /**
   * 玩家出牌后，其他 AI 的反应（大牌 / 长牌型）
   * 炸弹不走这里：它由 aiEventSpeak 让每个 AI 都开口
   * @param {{big?:boolean, goodCombo?:boolean}} detail
   */
  aiReactToHuman(detail = {}) {
    if (!this.aiEnabled || this.gameKind !== 'ddz' || !this.game) return;
    const landlordSeat = this.game.landlordSeat;
    if (landlordSeat === null) return;
    const humanIsLandlord = landlordSeat === 0;
    // 被压得最直接的一方更可能开口：地主出牌→两个农民；农民出牌→地主优先
    const farmers = [1, 2];
    const candidates = humanIsLandlord
      ? farmers
      : [landlordSeat, farmers.find((s) => s !== landlordSeat) ?? 1];
    const seat = Math.random() < (humanIsLandlord ? 0.5 : 0.75) ? candidates[0] : candidates[1];
    const persona = this.game.personas[seat];
    if (!persona) return;

    // 炸弹不走这里（aiEventSpeak 已经让桌上每个 AI 都开过口），这里只剩"大牌 / 长牌型"
    const chance = detail.big ? 0.7 : detail.goodCombo ? 0.45 : CONFIG.ai.chance.reactHuman;
    if (Math.random() > chance) return;

    const situation = buildSituation(this.game, seat, this.seatNames);
    const situationKey = detail.goodCombo || detail.big ? 'humanBig' : null;
    this.chat.speak(seat, 'suppressed', persona, {
      situation,
      priority: !!detail.big,
      forceSituation: !!situationKey,
      situationKey,
    });
  }

  /**
   * 小猫钓鱼：只要收牌就会说一句
   * 收得多是"大丰收"（得意 / 酸），收得少也有话说；
   * priority 让它绕过全局间隔，保证"每次都开口"（仍受同一 AI 2 秒最小间隔约束）
   */
  fishSayCatch(catchSeat, count) {
    if (!this.aiEnabled || !this.fishing) return;
    const big = count >= FISHING.bigCatchMin;
    const self = catchSeat === 1; // 1 = 对手（AI）自己
    const situationKey = self
      ? (big ? 'fishBigSelf' : 'fishSmallSelf')
      : (big ? 'fishBigOther' : 'fishSmallOther');
    this.fishSpeak(self ? 'playBig' : 'suppressed', {
      catchSeat, catchCount: count, forceSituation: true, situationKey, priority: true,
    });
  }

  onAiLine(seat, text) {
    // 弹幕只属于房间界面；牌桌上 AI 说话就是气泡
    this.showBubble(seat, text);
    this.pushChat({ kind: 'other', who: this.seatNames[seat], text });
  }

  onAiMode(mode) {
    // 不再弹提示：模型偶尔抖动就弹一次"连接失败"很吵，玩家也不需要知道。
    // 真出问题时看控制台（会带上失败原因）。
    console.debug(mode === 'offline' ? '[ai] 已切到本地语气' : '[ai] 大模型已连接');
  }

  showBubble(seat, text, emoji) {
    // 气泡停留时长：比原来多 1.6 秒（自己 4.2s / AI 4.4s），保证来得及读完
    const hold = seat === 0 ? 4200 : 4400;
    const html = `${emoji ? `<span class="bubble-emoji">${emoji}</span>` : ''}${text}`;
    if (this.gameKind === 'fishing') {
      const el = document.getElementById(seat === 0 ? 'fish-me-bubble' : 'fish-ai-bubble');
      if (!el) return;
      el.innerHTML = html;
      el.hidden = false;
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.hidden = true; }, hold);
      return;
    }
    if (this.gameKind === 'gomoku') {
      const el = document.getElementById(seat === 0 ? 'gmk-me-bubble' : 'gmk-ai-bubble');
      if (!el) return;
      el.innerHTML = html;
      el.hidden = false;
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.hidden = true; }, hold);
      return;
    }
    if (seat === 0) {
      const el = document.getElementById('bubble-0');
      el.innerHTML = html;
      el.hidden = false;
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.hidden = true; }, hold);
      return;
    }
    if (!this.table || !this.table.seats[seat]) return;
    const el = this.table.seats[seat].bubble;
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, hold);
  }

  pushChat(msg) {
    this.chatLog.push(msg);
    if (this.chatLog.length > 200) this.chatLog.shift();
    this.chatRenderers.forEach((fn) => fn());
  }

  /* ------------------------------ 聊天与道具 ------------------------------ */
  sendHumanChat(text) {
    const t = String(text).slice(0, CONFIG.chatMaxChars);
    if (!t) return;
    this.showBubble(0, t);
    this.pushChat({ kind: 'self', who: this.playerName, text: t });
    if (!this.aiEnabled) return;
    if (this.gameKind === 'fishing') {
      // 小猫钓鱼里玩家搭话，对手一定回应，而且可以插队（不等任何间隔）
      this.fishSpeak('idle', { playerText: t, priority: true, minGap: CONFIG.ai.playerReplyGap });
      return;
    }
    if (this.gameKind === 'gomoku') {
      // 五子棋：玩家说话，对手**隔 0.5~2 秒**接一句（用户要求，别像机器人一样秒回）
      setTimeout(() => {
        if (!this.gomoku || this.gameKind !== 'gomoku') return;
        this.gomokuSpeak('idle', { playerText: t, priority: true, minGap: 0 });
      }, 500 + Math.round(Math.random() * 1500));
      return;
    }
    // 玩家发言必须有人接话：随机先问一位，被占线就立刻换另一位；
    // 并且允许插队（playerReplyGap = 0），保证"每次发言至少有一个 AI 回应"
    const first = [1, 2][Math.floor(Math.random() * 2)];
    const order = [first, first === 1 ? 2 : 1];    let picked = null;
    for (const seat of order) {
      if (!this.game.personas[seat]) continue;
      if (this.chat.canSpeak(seat, true, Date.now(), CONFIG.ai.playerReplyGap)) { picked = seat; break; }
    }
    if (picked == null) picked = order.find((s) => this.game.personas[s]);
    if (picked == null) return;
    this.aiScene(picked, 'idle', {
      playerText: t, priority: true, minGap: CONFIG.ai.playerReplyGap,
    });
  }

  /* ------------------------------ 道具 ------------------------------ */
  /** 新一局：清空本局的道具使用计数（库存是全局的，不清） */
  resetToolUsage() {
    this.toolUsed = {};
    for (const it of ITEMS) this.toolUsed[it.id] = 0;
  }

  /** 某种道具本局还能用几次（受库存 + 每局上限双重限制） */
  toolLeft(id) {
    return toolLeft(this.save, id, (this.toolUsed && this.toolUsed[id]) || 0);
  }

  /** 道具的库存总数（商城买来的） */
  itemCount(id) {
    ensureItems(this.save);
    return this.save.items[id] || 0;
  }

  /** 牌桌/钓鱼桌上的道具按钮数据 */
  toolState() {
    return ITEMS.map((it) => ({ ...it, stock: this.itemCount(it.id), left: this.toolLeft(it.id) }));
  }

  sendTool(kind) {
    if (this.gameKind === 'fishing') return this.sendFishTool(kind);
    if (this.gameKind === 'gomoku') return this.sendGomokuTool(kind);
    if (!this.game) { toast('先开一局再用道具吧'); return; }
    const item = ITEMS.find((it) => it.id === kind);
    if (!item) return;
    if (this.itemCount(kind) <= 0) { toast(`「${item.name}」用完了，去商城买一些吧`, 'bad'); return; }
    if (this.toolLeft(kind) <= 0) { toast(`本局「${item.name}」已经用完啦`, 'bad'); return; }
    if (!consumeItem(this.save, kind)) return;
    this.toolUsed[kind] += 1;
    this.persist('item');

    const seat = [1, 2][Math.floor(Math.random() * 2)];
    const lines = {
      flower: ['送你一朵小花！', '谢谢，你人真好～'],
      tomato: ['吃我一个番茄！', '呸，偷袭是吧'],
      egg: ['吃我一个鸡蛋！', '哼，鸡蛋我收下了'],
      cappuccino: ['给阿姨倒一杯卡布奇诺！', '……谢谢阿姨'],
    }[kind] || ['接招！', '……'];
    audio.play(kind === 'egg' ? 'egg' : kind === 'flower' ? 'flower' : 'select');
    this.showBubble(0, lines[0], item.emoji);
    this.pushChat({ kind: 'self', who: this.playerName, text: lines[0], emoji: item.emoji });
    setTimeout(() => this.showBubble(seat, lines[1], item.emoji), 400);
    if (this.aiEnabled) this.aiScene(seat, kind === 'flower' ? 'praised' : 'egged');
    if (this.table) this.table.updateToolCounts();
    floatText(`${item.emoji} ${item.name}`, '50%', '52%');
  }

  /** 小猫钓鱼里的道具（同样是"库存 + 每局限次"，只表达情绪） */
  sendFishTool(kind) {
    const item = ITEMS.find((it) => it.id === kind);
    if (!item) return;
    if (this.itemCount(kind) <= 0) { toast(`「${item.name}」用完了，去商城买一些吧`, 'bad'); return; }
    if (this.toolLeft(kind) <= 0) { toast(`本局「${item.name}」已经用完啦`, 'bad'); return; }
    if (!consumeItem(this.save, kind)) return;
    this.toolUsed[kind] += 1;
    this.persist('item');
    const text = kind === 'flower' ? '送你一朵小花！' : kind === 'cappuccino' ? '请你喝杯咖啡～' : `接我一个${item.name}！`;
    const reply = kind === 'flower' ? '谢谢，你人真好～' : '哼，我记下了';
    audio.play(kind === 'egg' ? 'egg' : kind === 'flower' ? 'flower' : 'select');
    this.showBubble(0, text, item.emoji);
    setTimeout(() => this.showBubble(1, reply, item.emoji), 400);
    if (this.aiEnabled) this.fishSpeak(kind === 'flower' ? 'praised' : 'egged', { forceSituation: true, situationKey: kind === 'flower' ? 'praise' : 'tease', priority: true });
    if (this.fishing) this.fishing.updateToolCounts();
    floatText(`${item.emoji} ${item.name}`, '50%', '50%');
  }

  /** 五子棋里的道具（和钓鱼同一套：库存 + 每局限次，只表达情绪） */
  sendGomokuTool(kind) {
    const item = ITEMS.find((it) => it.id === kind);
    if (!item) return;
    if (this.itemCount(kind) <= 0) { toast(`「${item.name}」用完了，去商城买一些吧`, 'bad'); return; }
    if (this.toolLeft(kind) <= 0) { toast(`本局「${item.name}」已经用完啦`, 'bad'); return; }
    if (!consumeItem(this.save, kind)) return;
    this.toolUsed[kind] += 1;
    this.persist('item');
    const text = kind === 'flower' ? '送你一朵小花！' : kind === 'cappuccino' ? '请你喝杯咖啡～' : `接我一个${item.name}！`;
    const reply = kind === 'flower' ? '谢谢，你人真好～' : '哼，我记下了';
    audio.play(kind === 'egg' ? 'egg' : kind === 'flower' ? 'flower' : 'select');
    this.showBubble(0, text, item.emoji);
    this.pushChat({ kind: 'self', who: this.playerName, text, emoji: item.emoji });
    setTimeout(() => this.showBubble(1, reply, item.emoji), 400);
    if (this.aiEnabled) {
      this.gomokuSpeak(kind === 'flower' ? 'praised' : 'egged', {
        forceSituation: true, situationKey: kind === 'flower' ? 'praise' : 'tease', priority: true,
      });
    }
    if (this.gomoku) this.gomoku.updateToolCounts();
    floatText(`${item.emoji} ${item.name}`, '50%', '50%');
  }
}

export const app = new App();
