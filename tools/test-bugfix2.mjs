/**
 * 两个用户报的 bug + 两条规则的回归测试（node tools/test-bugfix2.mjs）
 *
 * 1) **输入法被锁**：AI 回复刷新时正好在打字 → 中文输入法唤不起来。
 *    根因：整面板 `innerHTML` 重画会销毁**正在组词的 input**，composition 状态挂在
 *    已经不存在的节点上，之后这个页面就再也调不出中文输入法。
 *    修法：组词期间不重画（ui/imeGuard.js），等这一字上屏再补。
 *
 * 2) **表白判定**（用户拍板，两轮改下来最终口径）：
 *    · 不让 AI 自由婉拒 —— 系统按**三条硬规则**判：
 *      ① 必须异性 ② 它必须单身（之前聊过"有对象"就不算；**没提过视为单身**）
 *      ③ 它没有明确拒绝（傲娇的嘴硬否认不算拒绝）
 *    · 判不通过：好感 **-10**，想再表白必须重新刷满 100
 *    · 傲娇人设单独判断
 * 3) **斜杠指令「/happy」**：给好友发它，直接把好感拉满。
 */
import { readFileSync } from 'node:fs';
import { createImeGuard } from '../src/ui/imeGuard.js';
import { FRIEND } from '../src/config.js';
import { defaultSave } from '../src/store/storage.js';
import { addFriend, findFriend, canConfess, refuseConfess, setLover, isLover, listFriends, removeFriend, breakUp } from '../src/store/friends.js';
import {
  buildAnalyzeMessages, buildFriendMessages, reviewConfess, partnerEvidenceOf,
  isExplicitRefuse, localAcceptConfess,
} from '../src/ai/friend.js';
import { applyCheat, parseCheat } from '../src/store/cheats.js';
import { PERSONAS, isTsundere } from '../src/data/personas.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ===================================================================== */
console.log('-- bug 1：输入法保护（组词期间不重画）');
{
  // 极简假元素：只记监听与值，够验证守卫的行为
  const makeEl = () => {
    const listeners = {};
    return {
      value: '',
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      fire(type) { (listeners[type] || []).forEach((fn) => fn()); },
      count(type) { return (listeners[type] || []).length; },
    };
  };

  let renders = 0;
  const ime = createImeGuard({ onFlush: () => { renders += 1; } });
  const input = makeEl();
  ime.bind(input);

  ok(input.count('compositionstart') === 1 && input.count('compositionend') === 1 && input.count('blur') === 1,
    '组词开始/结束/失焦三个监听都挂上了');
  ok(ime.shouldDefer() === false, '没在组词时照常重画');

  input.fire('compositionstart');
  ok(ime.isComposing() === true, 'compositionstart 之后进入组词状态');
  ok(ime.shouldDefer() === true, '★ 组词期间**拒绝重画**（这就是输入法不被锁的关键）');
  ok(ime.shouldDefer() === true, '再问一次还是拒绝');
  ok(ime.isPending() === true, '被拒的那次重画被记下来了');
  ok(renders === 0, '组词期间一次都没真的重画');

  input.fire('compositionend');
  ok(ime.isComposing() === false, 'compositionend 之后退出组词状态');
  await new Promise((r) => setTimeout(r, 5)); // 补画是 setTimeout(0)
  ok(renders === 1, '★ 上屏之后自动补画一次（挂起的那次不会丢）');
  ok(ime.isPending() === false, '补画之后不再挂起');

  // 兜底：组词后直接点走（没触发 compositionend）→ 失焦也要补画
  renders = 0;
  input.fire('compositionstart');
  ok(ime.shouldDefer() === true, '又组词了');
  input.fire('blur');
  await new Promise((r) => setTimeout(r, 5));
  ok(renders === 1, '★ 失焦兜底也会补画（不会一直停在旧画面）');

  // flushNow：发消息之后立刻补画
  renders = 0;
  input.fire('compositionstart');
  ime.shouldDefer();
  ime.flushNow();
  ok(renders === 1 && ime.isComposing() === false, 'flushNow 能立刻补画（发消息场景）');

  // 三个面板都真的接上了守卫
  for (const [file, note] of [
    ['../src/ui/friends.js', '私聊'],
    ['../src/ui/groups.js', '群聊'],
    ['../src/ui/moments.js', '友圈评论'],
  ]) {
    const src = read(file);
    ok(/createImeGuard\(\{ onFlush:/.test(src), `★ ${note}面板建了输入法守卫`);
    ok(/ime\.shouldDefer\(\)\) return;/.test(src), `★ ${note}的重画会先问守卫`);
    ok(/ime\.bind\(/.test(src), `★ ${note}每次重画后重新挂组词监听`);
  }
  const css = '';
  void css;
}

console.log('-- bug 2：表白按三条硬规则判（不允许 AI 自由婉拒）');
{
  // ① 审查提示词：模型只判"是不是表白"，不再决定"答不答应"
  const persona = PERSONAS.find((p) => p.gender === 'f');
  const sys = buildAnalyzeMessages({
    persona,
    friend: { affinity: 100, memory: [], name: persona.name },
    text: '我喜欢你，我们在一起吧',
    reply: '好呀，那我们在一起吧',
    allowConfess: true,
  })[0].content;
  ok(/"confess"/.test(sys), '审查里还是问 confess（玩家是不是在表白）');
  ok(!/"accept"/.test(sys), '★ 不再让模型决定"答不答应"（改由系统按规则判）');
  ok(/答不答应由系统按规则来判/.test(sys), '提示词里说明了这一点');

  // ② 规则引擎：异性 + 单身 + 没有明确拒绝 → 同意
  const 男玩家 = 'male';
  const 女玩家 = 'female';
  const 男性人设 = PERSONAS.find((p) => p.gender === 'm');
  const 单身好友 = { affinity: 100, memory: [], chat: [] };

  ok(reviewConfess({ persona, playerGender: 男玩家, friend: 单身好友, reply: '好呀' }).accept === true,
    '★ 异性 + 单身 + 没拒绝 → 同意');
  ok(reviewConfess({ persona, playerGender: 女玩家, friend: 单身好友, reply: '好呀' }).reason === 'same-gender',
    '★ 同性 → 不同意（same-gender）');
  ok(reviewConfess({ persona: 男性人设, playerGender: 男玩家, friend: 单身好友, reply: '好呀' }).reason === 'same-gender',
    '男玩家 + 男性人设也判同性');
  ok(reviewConfess({ persona: 男性人设, playerGender: 女玩家, friend: 单身好友, reply: '好呀' }).accept === true,
    '女玩家 + 男性人设 → 同意');

  // 没提过有对象 = 单身（用户口径）
  const 有对象好友 = { affinity: 100, memory: ['自设：感情状况=有男朋友了'], chat: [] };
  const v = reviewConfess({ persona, playerGender: 男玩家, friend: 有对象好友, reply: '好呀' });
  ok(v.accept === false && v.reason === 'has-partner', '★ 记忆里提到过有对象 → 不同意');
  ok(/有男朋友/.test(v.evidence || ''), '并把证据带回来（说了是哪一句）');
  const 聊天里说过 = { affinity: 100, memory: [], chat: [{ role: 'ai', text: '我心里已经有人了' }] };
  ok(reviewConfess({ persona, playerGender: 男玩家, friend: 聊天里说过, reply: '好呀' }).reason === 'has-partner',
    '★ 它自己聊天里说过"心里有人" → 也算有对象');
  ok(partnerEvidenceOf(单身好友) === '', '★ 从没提过 → 视为单身');

  // 明确拒绝才算拒；傲娇的"才不是"不算
  ok(reviewConfess({ persona, playerGender: 男玩家, friend: 单身好友, reply: '对不起，我们做朋友吧' }).reason === 'refused',
    '★ 回复里明确拒绝 → 不同意');
  const tsun = PERSONAS.find((p) => isTsundere(p)) || { gender: 'f', tags: ['傲娇'] };
  ok(isTsundere(tsun) === true, `傲娇人设能被认出来（${tsun.name}）`);
  const t1 = reviewConfess({ persona: tsun, playerGender: 男玩家, friend: 单身好友, reply: '才、才不是呢！谁要跟你在一起，笨蛋' });
  ok(t1.accept === true, '★ 傲娇的嘴硬否认（"才不是""谁要跟你在一起"）→ 仍然判定为成功');
  const t2 = reviewConfess({ persona: tsun, playerGender: 男玩家, friend: 单身好友, reply: '对不起，我有喜欢的人了' });
  ok(t2.accept === false && t2.reason === 'refused', '傲娇说出真实理由（有喜欢的人）→ 才算拒绝');
  ok(isExplicitRefuse('', tsun) === false, '没回复不算拒绝');
  ok(localAcceptConfess('才不是呢，笨蛋', { persona: tsun }) === true, '本地兜底同样认傲娇的嘴硬');

  // ③ 拒绝的代价：好感 -10；想再表白必须重新刷满
  const save = defaultSave();
  const p = PERSONAS[1];
  addFriend(save, p);
  findFriend(save, p.id).affinity = 100;
  ok(canConfess(save, findFriend(save, p.id)) === true, '好感满 → 会审查表白');
  const r = refuseConfess(save, p.id);
  ok(r.ok && r.penalty === 10 && r.affinity === 90, `★ 拒绝扣 10 好感（100 → ${r.affinity}）`);
  ok(/婉拒/.test(r.memory), '拒绝会写一条记忆');
  ok(findFriend(save, p.id).refusedCount === 1, '记下被拒次数');
  ok(canConfess(save, findFriend(save, p.id)) === false, '★ 好感退回 90 → 不再触发审查（想再表白得刷回来）');
  findFriend(save, p.id).affinity = 100;
  ok(canConfess(save, findFriend(save, p.id)) === true, '★ 重新刷满 100 → 可以再表白一次');
  ok(!isLover(save, p.id), '★ 全程都没有被设成恋人');
  ok(setLover(save, p.id).ok && isLover(save, p.id), '规则判定通过时才确立关系');
  ok(findFriend(save, p.id).refusedAt === 0, '确立关系时清掉"拒绝过"的痕迹');
  ok(FRIEND.confessRefusePenalty === 10, 'config 里写着拒绝代价 = 10');

  // ④ 接线 + 回复口径
  const app = read('../src/ui/app.js');
  ok(/reviewConfess\(\{/.test(app), '★ app 用规则引擎裁定表白');
  ok(/verdict\.reason === 'same-gender'/.test(app) && /has-partner/.test(app), '不同原因给不同提示');
  ok(/好感 -\$\{r\.penalty\}/.test(app), '提示里报出扣了多少好感');
  const replyPrompt = buildFriendMessages({
    persona, friend: 单身好友, text: '我喜欢你，我们在一起吧', joined: false,
  }).map((m) => m.content).join('\n');
  ok(/别故意拒绝/.test(replyPrompt), '★ 回复提示词里也写了"别动不动婉拒"（口径一致）');
  const plainPrompt = buildFriendMessages({ persona, friend: 单身好友, text: '今天天气不错', joined: false })
    .map((m) => m.content).join('\n');
  ok(!/别故意拒绝/.test(plainPrompt), '普通聊天不会加这句');

  // ⑤ /happy 指令：直接满好感
  ok(parseCheat('/happy') && parseCheat('/happy').key === 'happy', '/happy 能被识别');
  ok(parseCheat('  /HAPPY ') !== null, '大小写与空格都能容错');
  ok(parseCheat('／happy') !== null, '全角斜杠也认');
  ok(parseCheat('happy') === null && parseCheat('/nope') === null, '不是指令的就不拦');
  const s2 = defaultSave();
  addFriend(s2, p);
  findFriend(s2, p.id).affinity = 12;
  findFriend(s2, p.id).refusedAt = Date.now();
  const c = applyCheat(s2, p.id, '/happy');
  ok(c.handled === true && c.after === FRIEND.maxAffinity, `★ /happy 直接把好感拉满（${c.before} → ${c.after}）`);
  ok(findFriend(s2, p.id).affinity === 100 && findFriend(s2, p.id).refusedAt === 0,
    '顺便清掉"拒绝过"的痕迹（满好感当然可以再表白）');
  ok(applyCheat(s2, p.id, '你好呀').handled === false, '普通消息不会被当成指令');
  const ui = read('../src/ui/friends.js');
  ok(/applyCheat\(app\.save/.test(ui), '★ 私聊发送前先过一遍指令判断');
  ok(/cheat\.handled/.test(ui), '指令不会发给 AI、也不进聊天记录');
  ok(listFriends(s2).length === 1, '（前置检查）好友还在');

  // ⑥ 恋人保护：恋人不能直接删好友，除非先分手
  const s3 = defaultSave();
  addFriend(s3, p);
  findFriend(s3, p.id).affinity = 100;
  ok(setLover(s3, p.id).ok, '先确立恋人关系');
  const delLover = removeFriend(s3, p.id);
  ok(delLover.ok === false && delLover.needBreakup === true, '★ 恋人删不掉（返回 needBreakup）');
  ok(/分手/.test(delLover.error || ''), '错误信息里指路"先分手"');
  ok(isLover(s3, p.id) && listFriends(s3).some((f) => f.personaId === p.id), '★ 恋人还在，好友关系没被删掉');
  ok(breakUp(s3, p.id).ok, '先分手');
  ok(removeFriend(s3, p.id).ok, '★ 分手之后就能删了');
  ok(!listFriends(s3).some((f) => f.personaId === p.id), '删掉之后不在好友列表里');
  ok(/needBreakup/.test(ui), '界面会把"先分手"这条提示出来');
  ok(/is-locked/.test(ui), '恋人时删除按钮变暗（有视觉提示）');
  const css = read('../styles/friends.css');
  ok(/\.mini-btn\.is-locked/.test(css), '变暗的样式在 CSS 里');
}
console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '输入法保护 / 表白是否答应 检查通过'}`);
process.exit(fail ? 1 : 0);
