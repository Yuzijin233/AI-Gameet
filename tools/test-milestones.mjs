/**
 * 里程碑测试（node tools/test-milestones.mjs）
 *
 * 钉住用户这一轮拍板的东西：
 *   · 33 条 / 340 分，三组（社交 19 · 对局 9 · 财富 5），四档 20 / 40 / 100 / 200
 *   · **未达成时不告诉触发条件**（界面拿到的是 `？？？`），达成之后才写出来
 *   · 积分 = 已解锁条目之和；领奖按档位、不能重复领、奖励**进邮箱**
 *   · 每条都能被触发一次（用夹具存档），而且不会无缘无故触发
 *   · 老存档 / 脏数据都能安全补齐（不炸、不留脏 id）
 *   · 「永结同心」是时间型的：恋人满 7 天才算，分手后计时清零
 *   · 「鎏金」是里程碑奖励：商城不卖、`th_gilded` 在主题表里
 */
import { defaultSave, normalize } from '../src/store/storage.js';
import { readFileSync } from 'node:fs';
import { MILESTONES, MILESTONE_TOTAL, MILESTONE_TIERS } from '../src/data/milestones.js';
import {
  ensureMilestones, syncMilestones, milestonePoints, milestoneList, tierStates,
  claimTier, flagMilestone, markLoverSince, clearLoverSince, LOVER_DAYS,
} from '../src/store/milestones.js';
import { addFriend, adjustAffinity, setLover, breakUp, listFriends } from '../src/store/friends.js';
import { PERSONAS } from '../src/data/personas.js';
import { createGroup, appendGroupChat } from '../src/store/groups.js';
import { addMoment, addMomentLike, addMomentComment } from '../src/store/moments.js';
import { recordPayment } from '../src/store/activity.js';
import { THEMES, THEMES_FOR_SALE, themeById } from '../src/data/cosmetics.js';
import { titleById } from '../src/data/titles.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const fresh = () => { const s = defaultSave(); s.nickname = '测试玩家'; return s; };
const pointOf = (id) => MILESTONES.find((m) => m.id === id).points;
/** addFriend 收的是人设对象，不是 id（见 store/friends.js 的签名） */
const persona = (i) => PERSONAS[i - 1];

/* ===================================================================== */
console.log('-- 数据表：条数 / 分值 / 分组');
ok(MILESTONES.length === 33, `一共 33 条（实际 ${MILESTONES.length}）`);
ok(MILESTONE_TOTAL === 340, `总分 340（实际 ${MILESTONE_TOTAL}）`);
{
  const by = (g) => MILESTONES.filter((m) => m.group === g);
  ok(by('social').length === 19 && by('social').reduce((s, m) => s + m.points, 0) === 175, '社交 19 条 / 175 分');
  ok(by('match').length === 9 && by('match').reduce((s, m) => s + m.points, 0) === 80, '对局 9 条 / 80 分');
  ok(by('wealth').length === 5 && by('wealth').reduce((s, m) => s + m.points, 0) === 85, '财富 5 条 / 85 分');
  ok(new Set(MILESTONES.map((m) => m.id)).size === 33, 'id 不重复');
  ok(new Set(MILESTONES.map((m) => m.name)).size === 33, '名字不重复');
  ok(MILESTONES.every((m) => m.points > 0 && m.condition && m.checkKey), '每条都有分值 / 条件 / 判定键');
  ok(MILESTONE_TIERS.map((t) => t.at).join() === '20,40,100,200', '四档阈值 20 / 40 / 100 / 200');
  ok(MILESTONE_TIERS.every((t) => Array.isArray(t.rewards) && t.rewards.length && t.mailTitle), '每一档都有奖励与邮件标题');
}
// 用户点名的几条必须在
{
  const names = MILESTONES.map((m) => m.name);
  ['初次相遇', '高朋满座', '点头之交', '熟客', '无话不谈', '真爱至上', '一别两宽', '无疾而终',
    '刮目相看', '熟人组局', '相亲相爱一家人', '一呼百应', '友圈', '点赞评论', '社牛',
    '豆子大亨', '氪金玩家', '礼赠友人', '礼尚往来', '永结同心', '开门红', '春天',
    '初次遇见', '再见一面', '蹦蹦炸弹', '钓鱼高手', '倾家荡产', '下棋爱好者', '妙手',
    '超级欧皇', '赌怪', '空军', '天下首富'].forEach((n) => {
    ok(names.includes(n), `清单里有「${n}」`);
  });
  // 合并要求：遇见 2 条 + 见证 → 社交；赌怪 → 对局；欧皇 → 财富；熟人组局 → 对局
  const g = (n) => (MILESTONES.find((m) => m.name === n) || {}).group;
  ok(g('初次遇见') === 'social' && g('再见一面') === 'social', '「遇见」两条并进了社交');
  ok(g('永结同心') === 'social' && g('一别两宽') === 'social' && g('无疾而终') === 'social', '「见证」并进了社交');
  ok(g('赌怪') === 'match', '「赌怪」并进了对局');
  ok(g('超级欧皇') === 'wealth', '「超级欧皇」并进了财富');
  ok(g('熟人组局') === 'match', '「熟人组局」移到了对局');
}

/* ===================================================================== */
console.log('-- 存档补齐：老存档 / 脏数据都不能炸');
{
  const s = fresh();
  delete s.milestones;
  const m = ensureMilestones(s);
  ok(m && m.unlocked && Array.isArray(m.claimed) && m.flags, '缺字段时自动补齐');
  syncMilestones(s);
  ok(milestonePoints(s) === 0, '新号 0 分（不会凭空解锁）');

  // 脏数据：不存在的 id / 不存在的档位
  s.milestones.unlocked = { m_not_exist: 1, m_first_friend: 123 };
  s.milestones.claimed = [20, 999];
  const clean = ensureMilestones(s);
  ok(!('m_not_exist' in clean.unlocked), '不存在的里程碑 id 会被清掉');
  ok(clean.claimed.join() === '20', '不存在的档位会被清掉');
  ok(milestonePoints(s) === pointOf('m_first_friend'), '积分只算存在的条目');
}

/* ===================================================================== */
console.log('-- 未达成时不告诉触发条件');
{
  const s = fresh();
  const list = milestoneList(s);
  ok(list.every((x) => !x.unlocked), '新号一条都没解锁');
  ok(list.every((x) => x.shownCondition === '？？？'), '★ 未达成时条件全部显示为 ？？？');
  addFriend(s, persona(1));
  syncMilestones(s);
  const one = milestoneList(s).find((x) => x.id === 'm_first_friend');
  ok(one.unlocked && one.shownCondition === '第一次加好友', '★ 达成后才写出真实条件');
  ok(one.at > 0, '记下了达成时间');
}

/* ===================================================================== */
console.log('-- 逐条触发（每条都能被解锁一次）');
{
  // ① 社交：加好友 + 好感 + 恋人 + 群聊 + 友圈 + 礼物 + 遇见
  const s = fresh();
  ok(flagMilestone(s, 'giftSent') && flagMilestone(s, 'giftBack'), '礼物标记可写');
  flagMilestone(s, 'aiRenamed');
  flagMilestone(s, 'groupMentioned');
  for (let i = 1; i <= 10; i += 1) addFriend(s, persona(i));
  ok(listFriends(s).length === 10, '加了 10 位好友（高朋满座）');
  /**
   * 档位阈值（见 store/friends.js 的 AFFINITY_TIERS）：
   *   20 点头之交 / 40 朋友 / 60 密友 / 80 挚友
   * ★ 用**两个不同的人**分别踩这两档，否则第一个人一路涨上去会同时满足两档，
   *   测不出"40 那一档是不是真的认 40"。
   */
  const fA = persona(1);
  const fB = persona(2);
  adjustAffinity(s, fA.id, 20);
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_nodding, '好感 20 → 点头之交');
  ok(!s.milestones.unlocked.m_friend_tier, '刚 20 还不算「朋友」档');
  adjustAffinity(s, fA.id, 20); // → 40
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_friend_tier, '好感 40 → 熟客');
  ok(!s.milestones.unlocked.m_close_tier, '40 还不算「挚友」');
  adjustAffinity(s, fB.id, 80);
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_close_tier, '好感 80 → 无话不谈');
  setLover(s, fA.id);
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_lover, '成为恋人 → 真爱至上');
  ok(s.milestones.loverSinceAt > 0, '恋人计时起点记下了');
  breakUp(s, fA.id);
  flagMilestone(s, 'brokeUp');
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_breakup, '分手 → 一别两宽');
  flagMilestone(s, 'refusedConfess');
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_refused, '表白被拒 → 无疾而终');

  const g = createGroup(s, '测试群', ['p01', 'p02']);
  ok(!!g, '建群成功');
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_group_create, '建群 → 相亲相爱一家人');

  // addMoment 返回的是 { ok, moment }（不是 moment 本身）——踩过一次，记在这
  const mo = addMoment(s, '今天天气不错').moment;
  addMomentLike(s, mo.id, 'p01');
  addMomentLike(s, mo.id, 'p02');
  addMomentLike(s, mo.id, 'p03');
  const mo2 = addMoment(s, 'AI 发的', { by: 'p04' }).moment;
  addMomentComment(s, mo2.id, { by: 'me', text: '还行' });
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_moment_post, '发说说 → 友圈');
  ok(!!s.milestones.unlocked.m_moment_liked3, '被 3 人点赞 → 社牛');
  ok(!!s.milestones.unlocked.m_moment_comment, '评论别人 → 点赞评论');

  // ② 遇见：走一遍真流程（首次匹配 → 初次遇见）
  const { previewMatch, commitMatch } = await import('../src/store/encounters.js');
  const s3 = fresh();
  const base = Date.now();
  const first = commitMatch(s3, previewMatch(s3, { at: base }), { now: base });
  ok(first.ok, '第一次匹配成功（初次遇见）');
  syncMilestones(s3);
  ok(!!s3.milestones.unlocked.m_encounter_first, '完成一次匹配 → 初次遇见');
  ok(!s3.milestones.unlocked.m_encounter_again, '只见过一次 → 还没到「再见一面」');
  /**
   * ★ 「同一个人遇见 2 次」：**直接用第一次匹配的返回值**再落一次会话。
   *   为什么不用 `previewMatch` 反复抽同一个人：它是在"同龄窗"里随机挑的，
   *   而且 `candidatesFor` 有当天 + 48 小时冷却（见 store/encounters.js），
   *   靠随机撞同一个人的做法又慢又飘 —— 这里要验的是**里程碑判定**，
   *   不是遇见自身的冷却，所以把它已经在用的事实（`record.encounterCount`）摆成 2 即可。
   */
  const again = commitMatch(s3, { ...previewMatch(s3, { at: base }), persona: first.persona },
    { now: base + 49 * 60 * 60 * 1000 });
  if (!again.ok) {
    // 兜底：commit 被冷却/池子规则挡掉时，直接按遇见自己的结构补一条会话
    const rec = s3.encounters.records[first.persona.id]
      || (s3.encounters.records[first.persona.id] = { personaId: first.persona.id, encounterCount: 0, sessions: [] });
    rec.sessions.push({ id: `encounter-${first.persona.id}-2`, number: 2, messages: [], status: 'ended' });
    rec.encounterCount = 2;
  }
  syncMilestones(s3);
  ok(!!s3.milestones.unlocked.m_encounter_again, '同一个人遇见 2 次 → 再见一面');

  // ③ 对局：胜负统计 + 各种标记
  s.stats = s.stats || {};
  s.stats.wins = 1;
  flagMilestone(s, 'spring');
  flagMilestone(s, 'bombs');
  flagMilestone(s, 'highMulti');
  flagMilestone(s, 'roomFull');
  flagMilestone(s, 'gomokuNormal');
  flagMilestone(s, 'gomokuMaster');
  flagMilestone(s, 'fishingLose');
  flagMilestone(s, 'fishingLead');
  syncMilestones(s);
  ['m_first_win', 'm_spring', 'm_bombs', 'm_high_multi', 'm_room_full',
    'm_gomoku_normal', 'm_gomoku_master', 'm_fishing_lose', 'm_fishing_lead']
    .forEach((id) => ok(!!s.milestones.unlocked[id], `对局里程碑 ${id} 已解锁`));

  // ④ 财富：充值 / 破产 / 欧皇 / 榜首
  const s2 = fresh();
  recordPayment(s2, { price: 6, label: '开心豆' });
  syncMilestones(s2);
  ok(!!s2.milestones.unlocked.m_paid, '充值过 → 氪金玩家');
  s2.beans = 50;
  syncMilestones(s2);
  ok(!!s2.milestones.unlocked.m_broke, '豆子 <100 → 倾家荡产');
  flagMilestone(s2, 'lucky');
  syncMilestones(s2);
  ok(!!s2.milestones.unlocked.m_lucky, '抽中欧皇 → 超级欧皇');
  s2.beans = 10 ** 9;
  syncMilestones(s2);
  ok(!!s2.milestones.unlocked.m_rank_first, '豆子第一 → 天下首富');
  ok(!!s2.milestones.unlocked.m_rank_top10, '进前 10 → 豆子大亨');
}

/* ===================================================================== */
console.log('-- 不该误触发');
{
  const s = fresh();
  syncMilestones(s);
  ok(milestonePoints(s) === 0, '空存档一条都不解锁（尤其是破产 / 欧皇这种）');
  // 有钱就不算破产
  s.beans = 5000;
  syncMilestones(s);
  ok(!s.milestones.unlocked.m_broke, '豆子够多不算倾家荡产');
  // 没充过钱就不是氪金玩家
  ok(!s.milestones.unlocked.m_paid, '没充过钱不算氪金玩家');
  // 一个人都没遇见
  ok(!s.milestones.unlocked.m_encounter_first, '没匹配过不算初次遇见');
}

/* ===================================================================== */
console.log('-- 永结同心：时间型');
{
  const s = fresh();
  addFriend(s, persona(1));
  setLover(s, 'p01');
  markLoverSince(s, Date.now());
  syncMilestones(s);
  ok(!s.milestones.unlocked.m_lover_7d, `刚在一起不算（要 ${LOVER_DAYS} 天）`);
  s.milestones.loverSinceAt = Date.now() - (LOVER_DAYS + 1) * DAY;
  syncMilestones(s);
  ok(!!s.milestones.unlocked.m_lover_7d, `满 ${LOVER_DAYS} 天 → 永结同心`);
  // 分手后重新计时
  breakUp(s, 'p01');
  clearLoverSince(s);
  ok(s.milestones.loverSinceAt === 0, '分手后计时清零');
}

/* ===================================================================== */
console.log('-- 档位领奖 → 进邮箱');
{
  const s = fresh();
  const mails = [];
  const pushMail = (save, mail) => { mails.push(mail); save.mail = save.mail || []; save.mail.unshift({ ...mail, at: Date.now() }); };

  // 0 分：一档都领不了
  ok(claimTier(s, 20, pushMail).ok === false, '没到 20 分领不了');
  ok(claimTier(s, 999, pushMail).ok === false, '不存在的档位领不了');

  // 凑到 20 分（初次相遇 10 + 高朋满座 10）
  for (let i = 1; i <= 10; i += 1) addFriend(s, persona(i));
  syncMilestones(s);
  const pts = milestonePoints(s);
  ok(pts >= 20, `10 位好友后积分 ≥20（实际 ${pts}）`);
  const states = tierStates(s);
  ok(states[0].reached && states[0].claimable, '20 分那档变成可领取');
  const r1 = claimTier(s, 20, pushMail);
  ok(r1.ok, '领 20 分档成功');
  ok(mails.length === 1 && mails[0].rewards.length, '奖励写进邮箱了');
  ok(s.mail && s.mail.length === 1, '存档的邮箱里也有一条');
  ok(claimTier(s, 20, pushMail).ok === false, '★ 同一档不能重复领');
  ok(tierStates(s)[0].claimed === true, '状态变成已领取');
}

/* ===================================================================== */
console.log('-- 鎏金风格：里程碑专属');
{
  ok(!!themeById('th_gilded'), '主题表里有 th_gilded');
  const g = themeById('th_gilded');
  ok(g.name === '鎏金' && g.tone === 'gilded', '名字叫「鎏金」、tone = gilded');
  ok(g.only === 'milestone' && g.price === 0 && !g.cashPrice, '只能靠里程碑拿（不标价）');
  ok(!THEMES_FOR_SALE.some((t) => t.id === 'th_gilded'), '★ 商城在售列表里没有鎏金');
  ok(THEMES_FOR_SALE.some((t) => t.id === 'th_dark'), '霓虹夜还在卖（没被误删）');
  const css = read('../styles/theme-gilded.css');
  ok(css.includes('data-theme="gilded"'), '鎏金样式表用的是 data-theme="gilded"');
  ok(!/data-theme="social"/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), '鎏金样式表里没有残留的 social 选择器');
  // 亮金系：不该再有"绿系"颜色（G 明显高于 R 与 B）
  const greens = [...new Set(css.match(/#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g) || [])].filter((c) => {
    const r = parseInt(c.slice(1, 3), 16); const gg = parseInt(c.slice(3, 5), 16); const b = parseInt(c.slice(5, 7), 16);
    return gg > r + 6 && gg > b + 6;
  });
  ok(greens.length === 0, `鎏金里没有残留绿色（${greens.slice(0, 4).join(' ') || '干净'}）`);
  const idx = read('../index.html');
  ok(/styles\/theme-gilded\.css/.test(idx), 'index.html 加载了鎏金样式表');
  // 里程碑 200 分那档给的就是它
  const tier200 = MILESTONE_TIERS.find((t) => t.at === 200);
  ok(tier200.rewards.some((x) => x.kind === 'theme' && x.id === 'th_gilded'), '★ 200 分那档发的是鎏金');
  ok(!tier200.rewards.some((x) => x.kind === 'theme' && x.id === 'th_dark'), '不再发霓虹夜');
  const tier100 = MILESTONE_TIERS.find((t) => t.at === 100);
  ok(tier100.rewards.some((x) => x.kind === 'title' && x.id === 't_socialite'), '100 分那档发「社交达人」称号');
  ok(!!titleById('t_socialite') && titleById('t_socialite').name === '社交达人', '「社交达人」这个称号真的存在');
  ok(THEMES.length === 4, `主题一共 4 套（实际 ${THEMES.length}）`);
}

/* ===================================================================== */
console.log('-- ★ 回归：解锁必须当场发生（用户报的"加了好友完全没完成成就"）');
{
  /**
   * 那个 bug 的本质：里程碑是"全量同步"判定的，但只有**回到大厅**才会同步一次
   * （app.showScreen），所以站在社交面板里加完好友、配完遇见，什么都没解锁。
   * 修法是三处：加好友后 / 遇见匹配后 / refreshLobby 兜底（去抖）。
   */
  const friendsSrc = read('../src/ui/friends.js');
  const appSrc = read('../src/ui/app.js');

  const afterAdd = friendsSrc.split('migrateEncounterToFriend(app.save, persona.id, res.friend)')[1] || '';
  ok(/syncMilestones/.test(afterAdd.slice(0, 700)), '★ 加好友之后立刻同步里程碑');
  const afterPick = friendsSrc.split('migrateEncounterToFriend(app.save, p.id, res.friend)')[1] || '';
  ok(/syncMilestones/.test(afterPick.slice(0, 700)), '★ 推荐页加好友之后也立刻同步');
  const afterMatch = friendsSrc.split('encounterSession = committed.session')[1] || '';
  ok(/syncMilestones/.test(afterMatch.slice(0, 600)), '★ 遇见匹配成功后立刻同步');
  ok(/refreshLobby\(\)[\s\S]{0,900}scheduleMilestoneSync/.test(appSrc), '★ refreshLobby 里挂了兜底同步');
  ok(/scheduleMilestoneSync\(delay = 600\)/.test(appSrc), '兜底同步是去抖的（不会每次点都全量跑）');
}

/* ===================================================================== */
console.log('-- 面板与入口接线');
{
  const ui = read('../src/ui/milestones.js');
  ok(/export function openMilestones/.test(ui), '面板导出 openMilestones');
  ok(/一行 2 个|grid-template-columns: repeat\(2/.test(read('../styles/milestones.css')), '样式里是一行两个');
  ok(/ms-claim/.test(ui) && /claimTier/.test(ui), '进度条节点可点领奖');
  ok(/pushMail/.test(ui), '奖励走邮箱');
  ok(/shownCondition/.test(ui), '界面用的是"藏条件的那个字段"');
  const app = read('../src/ui/app.js');
  ok(/nav-milestones/.test(app), '大厅导航接上了 nav-milestones');
  ok(/syncMilestones\(\)/.test(app) && /flagMilestone\(/.test(app), 'app 上有同步与打标两个入口');
  ok(/解锁里程碑：\$\{item\.name\}/.test(app), '★ toast 文案是「解锁里程碑：<名字>」');
  const idx = read('../index.html');
  ok(/id="nav-milestones"/.test(idx), '底部导航有里程碑按钮');
  ok(/data-proxy="nav-milestones"/.test(idx), '社交侧栏也有里程碑入口');
  ok(/icons-social\.svg#milestone/.test(idx), '用了新增的奖章图标');
  const sprite = read('../assets/ui/icons-social.svg');
  ok(/id="milestone"/.test(sprite), '图标雪碧图里有 milestone');
}

console.log(fail ? `\n失败 ${fail} 项` : '\n里程碑检查通过');
process.exit(fail ? 1 : 0);
