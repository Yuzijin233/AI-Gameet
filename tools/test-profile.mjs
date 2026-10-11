/**
 * 玩家档案测试（node tools/test-profile.mjs）
 *
 * 覆盖用户这轮提的第一条：
 *   · 首次进入 / **重置存档后**必须先设"性别 + 姓名"，确认了才能进游戏
 *   · 默认性别男；姓名默认随机一个，可以自己改
 *   · 性别不是摆设：要真的进到 AI 的提示词里（牌桌 / 私聊 / 群聊 / 弹幕）
 * 另外顺带盯住：老存档不能被这道门拦住（没有 profileSet 字段但有昵称 = 早就设过）
 */
import { defaultSave, normalize } from '../src/store/storage.js';
import { readFileSync } from 'node:fs';
import { PERSONAS } from '../src/data/personas.js';
import { addFriend, findFriend } from '../src/store/friends.js';
import { NICKNAMES, randomNickname } from '../src/data/nicknames.js';
import {
  GENDERS, DEFAULT_GENDER, PLAYER_NAME_MAX, genderById, playerGenderOf, playerGenderLabel,
  playerGenderLine, needsProfileSetup, cleanPlayerName,
} from '../src/data/player.js';
import { buildFriendMessages, buildProactiveMessages } from '../src/ai/friend.js';
import { buildGroupReplyMessages } from '../src/ai/group.js';
import { buildDanmakuMessages } from '../src/ai/danmaku.js';
import { buildMessages } from '../src/ai/chat.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

const withFriend = (gender = 'male') => {
  const s = defaultSave();
  s.gender = gender;
  s.nickname = '测试玩家';
  addFriend(s, PERSONAS[0]);
  return { save: s, friend: findFriend(s, PERSONAS[0].id) };
};

/* ===================================================================== */
console.log('-- 性别：默认男、可选女');
{
  ok(GENDERS.length === 2, `就两个选项（男 / 女），实际 ${GENDERS.length}`);
  ok(GENDERS.some((g) => g.id === 'male' && g.label === '男'), '有"男"');
  ok(GENDERS.some((g) => g.id === 'female' && g.label === '女'), '有"女"');
  ok(DEFAULT_GENDER === 'male', '★ 默认性别是男');
  ok(GENDERS.every((g) => g.sign && g.emoji && g.desc && g.call), '每个选项都有符号 / 表情 / 说明 / 称呼示例');

  const s = defaultSave();
  ok(s.gender === 'male', '新存档默认就是男');
  ok(playerGenderOf(s) === 'male' && playerGenderLabel(s) === '男', '取出来的也是男');
  s.gender = 'female';
  ok(playerGenderOf(s) === 'female' && playerGenderLabel(s) === '女', '改成女之后取到女');
  s.gender = '外星人';
  ok(playerGenderOf(s) === 'male', '非法值落回默认（不崩）');
  ok(playerGenderOf({}) === 'male' && playerGenderOf(null) === 'male', '缺字段也算男');
  ok(!!genderById('male') && !genderById('nope'), 'genderById 认得的只有预设那两个');
}

/* ===================================================================== */
console.log('-- 性别要真的进提示词（AI 不能叫错）');
{
  const male = playerGenderLine({ gender: 'male' });
  const female = playerGenderLine({ gender: 'female' });
  ok(/男/.test(male), '男：提示词里写明是男生');
  ok(/女/.test(female), '女：提示词里写明是女生');
  ok(/称呼/.test(male) && /称呼/.test(female), '都提醒"别叫错称呼"');
  ok(male !== female, '两种性别给 AI 的话不一样');
  ok(/兄弟|老哥|小哥/.test(male), '男生的称呼示例给的是"兄弟 / 老哥"这类');
  ok(/姐妹|小姐姐/.test(female), '女生的称呼示例给的是"姐妹 / 小姐姐"这类');
  ok(playerGenderLine({}) === male, '没设过性别时按默认（男）给，不会少这一句');

  // 私聊
  const { save, friend } = withFriend('female');
  const line = playerGenderLine(save);
  const chat = buildFriendMessages({ persona: PERSONAS[0], friend, text: '在吗', playerGender: line })
    .map((m) => m.content).join('\n');
  ok(chat.includes(line), '★ 私聊提示词带上了性别');
  const proactive = buildProactiveMessages({ persona: PERSONAS[0], friend, playerGender: line })
    .map((m) => m.content).join('\n');
  ok(proactive.includes(line), '★ 主动搭话的提示词也带上了性别');
  const noGender = buildFriendMessages({ persona: PERSONAS[0], friend, text: '在吗' })
    .map((m) => m.content).join('\n');
  ok(!noGender.includes('玩家是女生'), '不传就不加（老调用点不会莫名多一句）');

  // 群聊
  const group = { id: 'g1', name: '测试群', members: [PERSONAS[0].id], chat: [] };
  const grp = buildGroupReplyMessages({
    persona: PERSONAS[0], group, members: [PERSONAS[0]], recentLines: [], playerText: '在吗',
    replyTo: null, friends: [friend], playerName: '测试玩家', playerGender: line,
  }).map((m) => m.content).join('\n');
  ok(grp.includes(line), '★ 群聊提示词带上了性别');

  // 房间弹幕
  const dm = buildDanmakuMessages({
    persona: PERSONAS[0], friend, situation: '房间里 2 个人', recent: [], playerName: '测试玩家', playerGender: line,
  }).map((m) => m.content).join('\n');
  ok(dm.includes(line), '★ 弹幕提示词带上了性别');

  // 牌桌台词（走 view.playerGender）
  const view = {
    isLandlord: true,
    handReportLine: '你的手牌：17 张',
    countsText: '你 17 张，玩家 17 张',
    multiplier: 1,
    bombs: 0,
    lastText: '',
    historyText: '',
    friendLines: [],
    playerGender: line,
    playerText: '',
  };
  const table = buildMessages({ persona: PERSONAS[0], scene: 'play', view }).map((m) => m.content).join('\n');
  ok(table.includes(line), '★ 牌桌台词提示词带上了性别');
}

/* ===================================================================== */
console.log('-- 姓名：默认随机、可改、长度受控');
{
  ok(NICKNAMES.length >= 400, `昵称库够大（${NICKNAMES.length} 个组合）`);
  const a = randomNickname();
  ok(typeof a === 'string' && a.length >= 2 && NICKNAMES.includes(a), '随机昵称取自昵称库');
  // 用固定随机数注入，确认是"按随机数取"
  ok(randomNickname(() => 0) === NICKNAMES[0], '随机函数注入后取第一个');
  ok(randomNickname(() => 0.999999) === NICKNAMES[NICKNAMES.length - 1], '取最后一个也对');
  const many = new Set(Array.from({ length: 60 }, () => randomNickname()));
  ok(many.size > 30, `随机不重复（60 次出了 ${many.size} 个不同的）`);

  ok(PLAYER_NAME_MAX === 12, '姓名上限 12 个字（和"改名"一致）');
  ok(cleanPlayerName('  小明  ') === '小明', '去掉首尾空白');
  ok(cleanPlayerName('小\n明') === '小 明', '换行被压成空格（不会破坏界面）');
  ok(cleanPlayerName('') === '' && cleanPlayerName('   ') === '', '空 / 全空白 → 空串（由调用方提示）');
  ok(cleanPlayerName(null) === '' && cleanPlayerName(undefined) === '', 'null / undefined 也不报错');
  ok(cleanPlayerName('一'.repeat(30)).length === PLAYER_NAME_MAX, `超长被截到 ${PLAYER_NAME_MAX} 个字`);
  ok([...cleanPlayerName('😀'.repeat(20))].length === PLAYER_NAME_MAX, 'emoji 按"一个字"算，不会被截成半个');
}

/* ===================================================================== */
console.log('-- 谁需要先设置档案（新手 / 刚重置过存档）');
{
  const fresh = defaultSave();
  ok(fresh.profileSet === false, '新存档：profileSet = false');
  ok(needsProfileSetup(fresh), '★ 新手必须先设置性别 + 姓名');
  ok(fresh.nickname === '', '新存档昵称为空（等着设置界面填）');
  ok(fresh.gender === 'male', '新存档性别默认男');

  fresh.nickname = '小明';
  fresh.profileSet = true;
  ok(!needsProfileSetup(fresh), '设置过之后就不再拦人');
  ok(needsProfileSetup(null), '存档都没有时也算"需要设置"（防御性）');

  // 重置存档：昵称清空 + profileSet 回到 false（性别也回到默认）
  const reset = Object.assign(defaultSave(), { avatar: 'avatar_01' });
  ok(needsProfileSetup(reset), '★ 重置存档后要重新设置一次');
  ok(reset.nickname === '' && reset.gender === 'male', '重置后昵称空、性别回到默认男');

  // 老存档：没有 profileSet 字段，但已经有昵称 → 视为早就设过，别把人拦在门外
  const oldSave = { version: 1, nickname: '老王', beans: 5000, friends: [] };
  const normalized = normalize(oldSave);
  ok(normalized.profileSet === true, '★ 老存档（有昵称）不会被拦在设置界面');
  ok(normalized.gender === 'male', '老存档没有性别字段 → 补默认男');
  ok(normalized.nickname === '老王', '昵称原样保留');

  const oldEmpty = normalize({ version: 1, nickname: '', beans: 5000, friends: [] });
  ok(oldEmpty.profileSet === false, '老存档但昵称为空 → 还是要设置');

  const dirty = normalize({ version: 1, nickname: '小王', gender: '猫', profileSet: 'yes' });
  ok(dirty.gender === 'male', '非法性别被纠正');
  ok(dirty.profileSet === true, 'profileSet 非布尔值时按"有昵称"推断');
}

/* ===================================================================== */
console.log('-- 存档里的新字段不会影响别的字段');
{
  const s = normalize({
    version: 1,
    nickname: '小明',
    gender: 'female',
    beans: 12345,
    friends: [],
    activity: { packDate: '2026-03-05', packsBought: ['pack_s'], discountDate: '2026-03-05', discountCount: 3 },
  });
  ok(s.gender === 'female', '性别保留');
  ok(s.beans === 12345, '豆子没被动过');
  ok(s.activity.packsBought.length === 1 && s.activity.discountCount === 3, '活动状态原样保留');
  const base = defaultSave();
  ok(Array.isArray(base.activity.packsBought) && base.activity.discountCount === 0,
    '新存档的活动字段是"两款已买列表 + 折扣次数"');
  ok(!('packBought' in base.activity) && !('discountBought' in base.activity),
    '老的两个布尔字段已经从默认存档里去掉');
}

/* ===================================================================== */
console.log('-- ★ 注册界面：默认头像 image/001.png + 点一下就能上传替换');
{
  const avatarSrc = readFileSync(new URL('../src/data/avatar.js', import.meta.url), 'utf8');
  const setupSrc = readFileSync(new URL('../src/ui/setup.js', import.meta.url), 'utf8');
  const panCss = readFileSync(new URL('../styles/panels.css', import.meta.url), 'utf8');

  ok(/SIGNUP_AVATAR_SRC = 'image\/001\.png'/.test(avatarSrc), '★ 注册默认头像是 image/001.png');
  /**
   * ★ 用户拍板（第二轮）：**没上传头像时，进游戏用的也是 001.png** ——
   *   一开始只有注册界面用了它，进大厅还是老默认 avatar_01，看着像"没生效"。
   */
  ok(/export function playerAvatarSrc\(save\)[\s\S]{0,220}return SIGNUP_AVATAR_SRC;/.test(avatarSrc),
    '★ 进游戏（大厅 / 牌桌 / 排行榜…）没上传时也是 001.png');
  {
    const { playerAvatarSrc, signupAvatarSrc, hasUploadedAvatar } = await import('../src/data/avatar.js');
    const base = defaultSave();
    ok(playerAvatarSrc(base) === 'image/001.png', `没上传 → ${playerAvatarSrc(base)}`);
    // 老存档里记着 avatar_05 也算"没上传"：照样用 001.png
    ok(playerAvatarSrc({ ...base, avatar: 'avatar_05' }) === 'image/001.png',
      '老存档的 avatar 预设不再影响默认头像');
    const up = { ...base, avatarUpload: 'data:image/jpeg;base64,AAAA' };
    ok(playerAvatarSrc(up) === 'data:image/jpeg;base64,AAAA', '上传过就用上传的那张');
    ok(hasUploadedAvatar(up) === true && hasUploadedAvatar(base) === false, '上传判定跟着走');
    ok(signupAvatarSrc(base) === playerAvatarSrc(base), '注册界面与游戏里同一份口径');
  }
  ok(/export function signupAvatarSrc\(save\)/.test(avatarSrc)
    && /startsWith\('data:image\/'\)/.test(avatarSrc),
    '上传过就优先用上传的那张');
  ok(/id="setup-avatar"/.test(setupSrc) && /readAvatarFile\(f\)/.test(setupSrc),
    '★ 注册界面显示头像，点一下即可上传替换');
  ok(/id="setup-avatar-reset"/.test(setupSrc) && /clearAvatarUpload\(app\.save\)/.test(setupSrc),
    '上传之后可以恢复默认头像');
  ok(/app\.save\.avatarUpload = res\.dataUrl/.test(setupSrc), '上传结果写进存档');
  ok(/\.setup-avatar \{/.test(panCss) && /\.setup-avatar-cam \{/.test(panCss),
    '注册头像有样式（圆形 + 右下角相机小标）');
  ok(!/\.setup-avatar \{/.test(readFileSync(new URL('../styles/theme-light.css', import.meta.url), 'utf8')),
    '★ 没写进浅色那份（那边只许换颜色）');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '玩家档案（性别 / 姓名 / 注册头像）检查通过'}`);
process.exit(fail ? 1 : 0);
