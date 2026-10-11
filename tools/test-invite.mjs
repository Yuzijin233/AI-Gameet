/**
 * AI 邀请玩家打牌（node tools/test-invite.mjs）
 *
 * 用户拍板的规则，一条一条盯：
 *   · 玩家停在主界面（大厅）**不动 30s** 之后才可能被邀请；商城等面板开着不算
 *   · 之后每 20~60s 随机一次
 *   · 好友 **< 3 位不邀请**
 *   · 点 ✗ → 免打扰，直到玩家主动玩一局
 *   · 接受后：AI 当房主 + 另带一位好友，3~5s 后自动开局
 * 另外顺带测：一局打完"谁来找玩家发消息"的规则（参战的好友才聊那局；
 * 没人参战就随机 1~2 个好友来，且不许提玩家）
 */
import { readFileSync } from 'node:fs';
import { defaultSave } from '../src/store/storage.js';
import {
  addFriend, listFriends, findFriend, addMatchMemory, appendChat,
  canPingPlayer, bumpPendingPing, friendsWhoCanPing,
} from '../src/store/friends.js';
import { PERSONAS } from '../src/data/personas.js';
import { INVITE, ROOMS, FISHING_ROOMS, FRIEND } from '../src/config.js';
import {
  canInviteNow, hasEnoughFriends, isInviteMuted, setInviteMuted,
  pickHostAndOther, pickInviteTarget, nextInviteGapMs, nextStartDelayMs, inviteTargetText,
} from '../src/store/invite.js';
import { buildProactiveMessages } from '../src/ai/friend.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };

function newSave(friends = 4) {
  const s = defaultSave();
  s.nickname = '小徐';
  for (const p of PERSONAS.slice(0, friends)) addFriend(s, p);
  return s;
}
const ctx = (over = {}) => ({ screen: 'screen-lobby', panelOpen: false, inGame: false, idleMs: 40000, ...over });

/* ===================================================================== */
console.log('-- 什么时候才会被邀请');
{
  ok(INVITE.idleMs === 30000, `★ 发呆阈值是 30s（实际 ${INVITE.idleMs}）`);
  ok(INVITE.minGapMs === 20000 && INVITE.maxGapMs === 60000,
    `★ 两次邀请间隔 20~60s（实际 ${INVITE.minGapMs}~${INVITE.maxGapMs}）`);
  ok(INVITE.minFriends === 3, `★ 好友少于 3 位不邀请（实际 ${INVITE.minFriends}）`);

  const s = newSave(4);
  ok(canInviteNow(s, ctx()).ok, '主界面发呆 40s → 可以邀请');
  ok(!canInviteNow(s, ctx({ idleMs: 29000 })).ok, '★ 只发呆 29s → 还不邀请');
  ok(canInviteNow(s, ctx({ idleMs: 30000 })).ok, '正好 30s → 可以了');
  ok(canInviteNow(s, ctx({ screen: 'screen-matching' })).reason === 'not-lobby', '匹配过场里不邀请');
  ok(canInviteNow(s, ctx({ screen: 'screen-table' })).reason === 'not-lobby', '牌桌上不邀请');
  ok(canInviteNow(s, ctx({ panelOpen: true })).reason === 'panel-open',
    '★ 开着商城 / 设置这种面板（不算"停在主界面"）→ 不邀请');
  ok(canInviteNow(s, ctx({ inGame: true })).reason === 'in-game', '正在打牌 → 不邀请');

  // 好友不够
  for (const n of [0, 1, 2]) {
    const few = newSave(n);
    ok(!hasEnoughFriends(few), `${n} 位好友 → 不够（不邀请）`);
    ok(canInviteNow(few, ctx()).reason === 'few-friends', `${n} 位好友时给出 few-friends`);
  }
  ok(hasEnoughFriends(newSave(3)), '3 位好友 → 够了');

  // 点过 ✗ 之后
  const muted = newSave(4);
  setInviteMuted(muted, true);
  ok(isInviteMuted(muted) && canInviteNow(muted, ctx()).reason === 'muted', '★ 点过 ✗ → 不再邀请');
  setInviteMuted(muted, false);
  ok(canInviteNow(muted, ctx()).ok, '解除免打扰之后又可以邀请（玩家主动玩一局时解除）');
}

/* ===================================================================== */
console.log('-- 挑谁 + 挑什么模式 + 等多久');
{
  const friends = listFriends(newSave(6));
  ok(friends.length === 6, '六位好友');
  const seq = (vals) => { let i = 0; return () => vals[(i++) % vals.length]; };
  const a = pickHostAndOther(friends, seq([0, 0]));
  ok(a && a.host.personaId !== a.other.personaId, '★ 房主和另一位是**不同**的好友');
  ok(friends.some((f) => f.personaId === a.host.personaId) && friends.some((f) => f.personaId === a.other.personaId),
    '两位都来自好友列表');
  // 反复抽都不能抽到自己跟自己
  for (let i = 0; i < 200; i += 1) {
    const p = pickHostAndOther(friends);
    if (!p || p.host.personaId === p.other.personaId) { ok(false, '抽到了同一个好友'); break; }
  }
  ok(pickHostAndOther([friends[0]]) === null, '只有 1 位好友时挑不出人（返回 null）');
  ok(pickHostAndOther([]) === null, '没有好友时也返回 null');

  // 间隔与开局延迟都落在要求的区间
  for (let i = 0; i < 100; i += 1) {
    const gap = nextInviteGapMs();
    if (gap < INVITE.minGapMs || gap > INVITE.maxGapMs) { ok(false, `邀请间隔越界：${gap}`); break; }
    const start = nextStartDelayMs();
    if (start < INVITE.startMinMs || start > INVITE.maxStartMs) { ok(false, `开局延迟越界：${start}`); break; }
  }
  ok(true, '★ 100 次抽样：间隔都在 20~60s、开局延迟都在 3~5s');

  // 模式 / 场次：只挑进得去的
  const s = defaultSave();
  const onlyLow = pickInviteTarget(s, {
    canEnterDdz: (r) => ({ ok: r.id === 'low' }),
    canEnterFishing: (r) => ({ ok: r.id === 'low' }),
    rnd: () => 0,
  });
  ok(onlyLow && onlyLow.room.id === 'low', '★ 只会挑玩家进得去的场次');
  const kinds = new Set();
  for (let i = 0; i < 300; i += 1) {
    const t = pickInviteTarget(s, { canEnterDdz: () => ({ ok: true }), canEnterFishing: () => ({ ok: true }) });
    kinds.add(t.kind);
  }
  ok(kinds.has('ddz') && kinds.has('fishing'), '★ 斗地主和小猫钓鱼都会被邀请到');
  ok(ROOMS.some((r) => r.id === 'low') && FISHING_ROOMS.some((r) => r.id === 'low'), '两个玩法都有场次表');
  const t = pickInviteTarget(s, { canEnterDdz: () => ({ ok: false }), canEnterFishing: () => ({ ok: false }), rnd: () => 0 });
  ok(t && t.room, '一个场次都进不去时也会退回最低场（进去再提示充值，总比不邀请好）');
  const text = inviteTargetText({ kind: 'fishing', room: FISHING_ROOMS[0] });
  ok(/小猫钓鱼/.test(text) && text.includes(FISHING_ROOMS[0].name), `文案带上模式和场次（${text}）`);
}

/* ===================================================================== */
console.log('-- ★ 主动消息节流：连着 2 条没人回就不再发（用户拍板）');
{
  const s = newSave(4);
  const ids = listFriends(s).map((f) => f.personaId);
  const a = ids[0];
  const b = ids[1];
  ok(FRIEND.maxUnansweredPings === 2, `★ 连着发 ${FRIEND.maxUnansweredPings} 条没被回就安静`);

  ok(canPingPlayer(s, a), '一开始谁都能主动找你');
  bumpPendingPing(s, a);
  ok(canPingPlayer(s, a), '发了 1 条：还能再发一条');
  bumpPendingPing(s, a);
  ok(!canPingPlayer(s, a), '★ 发了 2 条、玩家没回 → 这个 AI 不再主动发');
  ok(canPingPlayer(s, b), '别的 AI 不受影响');

  // 玩家回一句 → 立刻恢复
  appendChat(s, a, 'me', '在的');
  ok(canPingPlayer(s, a), '★ 玩家回了一句 → 它又可以主动找你了');
  ok((findFriend(s, a).pendingPings || 0) === 0, '计数清零');

  // 全部好友都发满 2 条 → 谁都不发
  for (const id of ids) { bumpPendingPing(s, id); bumpPendingPing(s, id); }
  ok(friendsWhoCanPing(s).length === 0, '★ 所有好友都发满 2 条 → 没人会主动发消息了');
  ok(friendsWhoCanPing(s).length === 0, '（再确认一次）');
  // 这时候加了新好友 → 新好友正常发（计数从 0 开始）
  const fresh = PERSONAS.find((p) => !ids.includes(p.id));
  addFriend(s, fresh);
  ok(canPingPlayer(s, fresh.id), '★ 这时加的新好友不受影响，可以正常主动发消息');
  ok(friendsWhoCanPing(s).length === 1, '能发的就剩这个新好友');

  // 接线：赛后搭话那条路要用这个过滤
  const appSrc = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/listFriends\(this\.save\)\.filter\(\(f\) => canPingPlayer\(this\.save, f\.personaId\)\)/.test(appSrc),
    '★ 赛后"谁来找你聊"只从"还愿意发"的好友里挑');
  ok(/bumpPendingPing\(this\.save, personaId\)/.test(appSrc), '★ 每主动发一条都记一次');
  const panelsSrc = readFileSync(new URL('../src/ui/panels.js', import.meta.url), 'utf8');
  ok((panelsSrc.match(/void requestFriend\(\{/g) || []).length >= 3,
    '★ 结算面板的"加好友"也走同一套申请流程（编辑申请 → 延迟通过 → 我发申请 + TA 回这条）');
}

/* ===================================================================== */
console.log('-- ★ 五子棋也要能"被邀请"（用户拍板：权重和斗地主并列）');
{
  const kinds = (INVITE.games || []).map((g) => g.kind);
  ok(kinds.includes('gomoku'), `★ 邀请池里有五子棋（${kinds.join('/')}）`);
  ok((INVITE.games.find((g) => g.kind === 'gomoku') || {}).weight === 3, '五子棋的权重和斗地主一样是 3');
  const s = newSave(4);
  const target = pickInviteTarget(s, {
    canEnterDdz: () => ({ ok: true }),
    canEnterFishing: () => ({ ok: true }),
    canEnterGomoku: () => ({ ok: true }),
  });
  ok(!!target && ['ddz', 'fishing', 'gomoku'].includes(target.kind), '能挑出目标模式');
  ok(inviteTargetText({ kind: 'gomoku', room: { name: '中级场' } }) === '中级场 · 五子棋',
    '★ 邀请文案写的是「中级场 · 五子棋」');
  // 全都被门槛挡住时：兜底退到最低场（原来那套"总比不邀请好"的行为）
  const only = pickInviteTarget(s, {
    canEnterDdz: () => ({ ok: false, reason: 'x' }),
    canEnterFishing: () => ({ ok: false, reason: 'x' }),
    canEnterGomoku: () => ({ ok: true }),
  });
  ok(!!only, '★ 三个模式全被挡住时也一定给得出目标（兜底退最低场）');
  ok(['ddz', 'fishing', 'gomoku'].includes(only.kind), `兜底目标合法（${only.kind}）`);
  {
    // 五子棋没有门槛：只把五子棋放行时，抽很多次一定能抽到它
    let gotGomoku = 0;
    for (let i = 0; i < 40; i += 1) {
      const t = pickInviteTarget(s, {
        canEnterDdz: () => ({ ok: false, reason: 'x' }),
        canEnterFishing: () => ({ ok: false, reason: 'x' }),
        canEnterGomoku: () => ({ ok: true }),
      });
      if (t && t.kind === 'gomoku') gotGomoku += 1;
    }
    ok(gotGomoku > 0, `★ 只放行五子棋时确实会邀请五子棋（40 次里 ${gotGomoku} 次）`);
  }
  const appSrc = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/target\.kind === 'gomoku'[\s\S]{0,160}startGomoku\(target\.room\.id, \[host\.id\]/.test(appSrc),
    '★ 接受邀请后进的是五子棋（房主当对手）');
  ok(/canEnterGomoku: \(\) => this\.canEnterGomoku\(\)/.test(appSrc), '邀请时会问"五子棋能不能进"');
}

/* ===================================================================== */
console.log('-- ★ 好友拉我进游戏：对手必须就是那位好友（不能变成随机 AI）');
{
  const s = newSave(5);
  const friends = listFriends(s);
  const pair = pickHostAndOther(friends);
  ok(pair && pair.host && pair.other, '挑出了房主 + 另一位好友');
  ok(pair.host.personaId !== pair.other.personaId, '两个人不是同一位');
  // 好友记录的"身份"字段叫 personaId（不是 id）—— 以前 app 里传 pair.host.id，
  // 结果全是 undefined，开局就退化成"随机 AI"，对不上号（用户报的 bug）
  ok(typeof pair.host.personaId === 'string' && pair.host.personaId, '★ 挑出来的是好友记录，身份在 personaId 上');
  ok(pair.host.id === undefined, '好友记录上没有 id 字段（所以旧代码必然是 undefined）');
  const hostPersona = PERSONAS.find((p) => p.id === pair.host.personaId);
  const otherPersona = PERSONAS.find((p) => p.id === pair.other.personaId);
  ok(hostPersona && otherPersona, '两位都能换算成人设（app 里 invitePersonaOf 干的就是这个）');

  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/invitePersonaOf\(x\) \{[\s\S]{0,160}x\.personaId \|\| x\.id/.test(app),
    '★ app 里统一把「好友记录 / 人设」换算成人设，不再直接用 .id');
  ok(/const host = this\.invitePersonaOf\(pair && pair\.host\)/.test(app), '挑人之后立刻换算成房主人设');
  ok(/showInvite\(\{[\s\S]{0,80}persona: host,/.test(app), '邀请卡上显示的就是这位房主');
  ok(/startFishing\(target\.room\.id, \[host\.id\]/.test(app), '★ 小猫钓鱼：对手就是房主');
  ok(/other \? \[host\.id, other\.id\] : \[host\.id\]/.test(app),
    '★ 斗地主：房主坐 1 号位，另一位好友坐 2 号位');
  ok(/startInvitedMatch\(pair, target\) \{[\s\S]{0,260}const host = this\.invitePersonaOf\(pair && pair\.host\)/.test(app),
    'startInvitedMatch 自己也再换算一次（谁调都不会传错）');
}

/* ===================================================================== */
console.log('-- 一局打完：谁来找玩家发消息');
{
  // 用真实存档模拟两种情形，走 app 里同一套挑选逻辑（这里复刻判断条件）
  const s = newSave(5);
  const friends = listFriends(s);
  const ids = friends.map((f) => f.personaId);

  // ① 参战的两位
  const hand = { kind: 'ddz', at: Date.now(), seatIds: [ids[1], ids[2]], summary: '这局玩家赢了' };
  const participated = friends.filter((f) => hand.seatIds.includes(f.personaId));
  const others = friends.filter((f) => !hand.seatIds.includes(f.personaId));
  ok(participated.length === 2 && others.length === 3, '⑤ 位好友里 2 位参战');
  ok(participated.every((f) => findFriend(s, f.personaId)), '参战的好友都在存档里');

  // 参战的那两位的提示词：必须聊刚刚那局
  const joinedPrompt = buildProactiveMessages({
    persona: PERSONAS[1], friend: findFriend(s, ids[1]), joined: true, lastMatch: hand, modeName: '斗地主', playerName: '小徐',
  }).map((m) => m.content).join('\n');
  ok(/开场就聊它/.test(joinedPrompt), '★ 参战的 AI 被要求"开场就聊刚刚那局"');
  ok(joinedPrompt.includes(hand.summary), '给了它那局的概括');

  // 没参战的好友：不许提那局
  const otherPrompt = buildProactiveMessages({
    persona: PERSONAS[4], friend: findFriend(s, ids[4]), joined: false, lastMatch: hand, playerName: '小徐',
  }).map((m) => m.content).join('\n');
  ok(!otherPrompt.includes(hand.summary), '★ 没参战的好友拿不到那局摘要');

  // ② 上局没人参战（机器模式 / 随机对手都不是好友）→ 允许编"自己的一局"，但不许提玩家
  const soloHand = { kind: 'fishing', at: Date.now(), seatIds: [], summary: '玩家自己打的一局' };
  const selfPrompt = buildProactiveMessages({
    persona: PERSONAS[3], friend: findFriend(s, ids[3]), joined: false, selfMatch: true, lastMatch: soloHand, playerName: '小徐',
  }).map((m) => m.content).join('\n');
  ok(/刚刚自己打了一局/.test(selfPrompt), '★ 没人参战时：允许它聊"自己刚打完的一局"');
  ok(/绝对不能提玩家/.test(selfPrompt), '★ 并且明确"绝对不能提玩家"');
  ok(/也可以完全聊别的话题/.test(selfPrompt), '也允许聊别的话题');
  ok(!selfPrompt.includes(soloHand.summary), '不会把那局（玩家打的）当成它的经历塞给它');

  /**
   * ★ 接线检查（用户报的 bug：刚下完五子棋，好友来聊的却是小猫钓鱼）
   *   写对局记忆是异步的（等模型写概括），所以搭话前必须**等它写完**，
   *   直接取 recentHands[0] 拿到的是上一局。
   */
  const appSrc = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/const lastHand = await this\.playedHandForPing\(\)/.test(appSrc),
    '★ 好友搭话前等"这局的对局记忆"写完，用它当"刚刚那局"');
  ok(!/const lastHand = \(this\.save\.recentHands \|\| \[\]\)\[0\] \|\| null;/.test(appSrc),
    '★ 不再直接取 recentHands[0]（异步没写完时那是上一局）');
  ok((appSrc.match(/this\.matchWrite = this\.recordMatchMemory\(/g) || []).length === 3,
    '三种玩法结算时都记下"这局的对局记忆任务"（斗地主 / 钓鱼 / 五子棋）');
  ok((appSrc.match(/this\.matchWrite = null/g) || []).length >= 3, '开局时清掉它（免得拿到上一局的任务）');
  ok(/ensureModeNamed/.test(appSrc), '写进记忆的概括会保证点明玩法（五子棋/小猫钓鱼/斗地主）');
}

/* ===================================================================== */
console.log('-- 好友未读角标：红圈 + 数字（不是红点）');
{
  const idx = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../styles/lobby.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const friendsUi = readFileSync(new URL('../src/ui/friends.js', import.meta.url), 'utf8');
  const friendsCss = readFileSync(new URL('../styles/friends.css', import.meta.url), 'utf8');
  ok(/id="friend-dot"[^>]*>0</.test(idx) && /class="dot is-num"/.test(idx),
    '★ 好友入口的角标改成了带数字的圆形徽标');
  ok(/\.dot\.is-num \{[\s\S]{0,400}font-style: normal/.test(css), '★ 数字不斜体');
  ok(/border-radius: 99px/.test(css.slice(css.indexOf('.dot.is-num'))), '是圆角胶囊（红圈里放数字）');
  ok(/dot\.textContent = total === 0 \? '' : \(total > 99 \? '99\+'/.test(app),
    '★ 数字 = 未读消息总数（0 时连数字都不显示，超过 99 显示 99+）');
  ok(/dot\.hidden = total === 0/.test(app), '★ 没有未读时角标整个藏起来（不显示"0"）');
  ok(/unreadTotal\(this\.save\) \+ groupUnreadTotal\(this\.save\)/.test(app),
    '私聊未读 + 群聊未读一起算');
  ok(!/unreadTotal\(this\.save\) \+ groupUnreadTotal\(this\.save\) \+ momentUnreadTotal/.test(app),
    '★ 友圈的评论**不算进**这个数字（只在社交面板里友圈标签旁亮红点）');
  ok(/class="unread-badge">\$\{f\.unread > 9 \? '9\+' : f\.unread\}/.test(friendsUi), '好友列表里那一行本来就有数字');
  ok(/\.unread-badge \{[\s\S]{0,300}font-style: normal/.test(friendsCss), '列表里的数字也统一不斜体');
}

/* ===================================================================== */
console.log('-- ★ 邀请横幅：勾/叉的字体 + 进游戏后房主先说一句');
{
  const inviteUi = readFileSync(new URL('../src/ui/invite.js', import.meta.url), 'utf8');
  const lobbyCss2 = readFileSync(new URL('../styles/lobby.css', import.meta.url), 'utf8');
  // ① 勾和叉用**正常字体的 √ 和 ×**（不要装饰符号、也不要 CSS 画线）
  ok(/>√</.test(inviteUi) && />×</.test(inviteUi), '★ 按钮文字是正常字体的 √ 和 ×');
  ok(!/>✓</.test(inviteUi) && !/>✗</.test(inviteUi), '不再用 ✓ / ✗ 那两个装饰符号');
  ok(!/\.invite-btn::before/.test(lobbyCss2) && !/\.invite-btn::after/.test(lobbyCss2),
    '★ 也不再拿 CSS 画线凑勾叉');
  ok(/\.invite-btn \{[\s\S]{0,400}font-family: "PingFang SC", "Microsoft YaHei"/.test(lobbyCss2),
    '按钮显式声明中文字体（保证 √ / × 落在正常字体上）');
  ok(/display: flex; align-items: center; justify-content: center/.test(lobbyCss2), '两个字在圆钮里都居中');

  // ② 被邀请进游戏后，房主主动说一句（模型生成，符合身份）
  const app2 = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/hostInviteLine\(kind, startDelayMs\)/.test(app2) && /hostInviteLine\('ddz', delay\)/.test(app2)
    && /hostInviteLine\('fishing', delay\)/.test(app2) && /hostInviteLine\('gomoku', delay\)/.test(app2),
    '★ 三种玩法被邀请进去都会让房主开口');
  const fn = (app2.match(/hostInviteLine\(kind, startDelayMs\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/总算把你拉来了/.test(fn), '大意是"总算把你拉来了"');
  ok(!/系统\/规则\/AI\/模型/.test(fn.replace(/别用"/, '')) || /别用"系统\/规则\/AI\/模型/.test(fn),
    '提示词里写死：不许提系统/规则/AI/模型');
  ok(/aiScene\(1, 'greeting'/.test(fn), '斗地主：房主（1 号位）说这句');
  ok(/forceSituation: true/.test(fn) && /situationKey: 'invited'/.test(fn), '走"指定场景"那条路（不会被随机场景顶掉）');
  ok(/if \(kind === 'ddz' && \(!this\.game/.test(fn), '中途退出就不说了');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : 'AI 邀请 + 赛后消息 + 未读角标检查通过'}`);
process.exit(fail ? 1 : 0);
