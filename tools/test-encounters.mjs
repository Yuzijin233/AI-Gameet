import { defaultSave, normalize } from '../src/store/storage.js';
import { addFriend } from '../src/store/friends.js';
import {
  previewMatch, commitMatch, appendEncounterMessage, encounterProgress, markEnded,
  listEncounterHistory, migrateEncounterToFriend, ENCOUNTER_DAILY_LIMIT,
} from '../src/store/encounters.js';

let failures = 0;
const ok = (value, message) => {
  if (!value) { failures += 1; console.error(`  x ${message}`); }
};
const people = [
  { id: 'f20', name: 'F20', gender: 'f', age: 20 },
  { id: 'm24', name: 'M24', gender: 'm', age: 24 },
  { id: 'f24', name: 'F24', gender: 'f', age: 24 },
  { id: 'f31', name: 'F31', gender: 'f', age: 31 },
  { id: 'f32', name: 'F32', gender: 'f', age: 32 },
  { id: 'f33', name: 'F33', gender: 'f', age: 33 },
  { id: 'f39', name: 'F39', gender: 'f', age: 39 },
];
const now = new Date(2026, 4, 20, 12).getTime();
const offer = (save, opts = {}) => previewMatch(save, { personas: people, now, rnd: () => 0, ...opts });

console.log('-- encounters');
{
  const save = defaultSave();
  ok(offer(save, { center: 24, gender: 'f' }).persona.id === 'f24', '精确年龄窗口优先');
  ok(offer(save, { center: 24, gender: 'm' }).persona.id === 'm24', '性别硬条件');
  addFriend(save, people[2]);
  ok(offer(save, { center: 24, gender: 'f' }).persona.id === 'f20', '当前好友绝不匹配');
}
{
  const save = defaultSave();
  const onlyFallback = [{ id: 'near', gender: 'f', age: 29 }];
  const picked = previewMatch(save, { personas: onlyFallback, center: 24, gender: 'f', now, rnd: () => 0 });
  ok(picked.ok && picked.fallback && picked.distance === 3, '空精确窗口时按最近年龄回退');
  ok(previewMatch(save, { personas: [{ id: 'five', gender: 'f', age: 31 }], center: 24, gender: 'f', now }).ok, '容差 5 岁可选');
  ok(!previewMatch(save, { personas: [{ id: 'six', gender: 'f', age: 32 }], center: 24, gender: 'f', now }).ok, '容差 6 岁拒绝');
  ok(!previewMatch(save, { personas: [], center: 24, now }).ok, '无候选返回 no-match');
  ok(!save.encounters.days[`${new Date(now).getFullYear()}-05-20`], '预选/无匹配不扣次数');
}
{
  const save = defaultSave();
  const first = offer(save, { center: 24, gender: 'm' });
  const committed = commitMatch(save, first, { personas: people, now, rnd: () => 0 });
  ok(committed.ok && committed.session.number === 1, 'commit 创建第一独立 session');
  ok(!commitMatch(save, first, { personas: people, now, rnd: () => 0 }).ok, '重复 commit 不消耗');
  ok(!offer(save, { center: 24, gender: 'm' }).ok, '同一天不重复 persona');
  ok(!previewMatch(save, { personas: people, center: 24, gender: 'm', now: now + 47 * 3600000 }).ok, '48 小时内冷却');
  ok(previewMatch(save, { personas: people, center: 24, gender: 'm', now: now + 49 * 3600000 }).ok, '48 小时后可重新匹配');
  const again = previewMatch(save, { personas: people, center: 24, gender: 'm', now: now + 49 * 3600000 });
  const second = commitMatch(save, again, { personas: people, now: now + 49 * 3600000, rnd: () => 0 });
  ok(second.ok && second.session.number === 2 && listEncounterHistory(save, 'm24').length === 2, '角色次数及场次编号递增');
}
{
  const save = defaultSave();
  for (let i = 0; i < ENCOUNTER_DAILY_LIMIT; i += 1) {
    const persona = { id: `p${i}`, gender: 'f', age: 24 };
    const picked = previewMatch(save, { personas: [persona], center: 24, gender: 'f', now });
    ok(commitMatch(save, picked, { personas: [persona], now }).ok, `第 ${i + 1} 次每日提交成功`);
  }
  const last = { id: 'overflow', gender: 'f', age: 24 };
  ok(!commitMatch(save, previewMatch(save, { personas: [last], center: 24, gender: 'f', now }), { personas: [last], now }).ok, '每日第六次被拒绝');
}
{
  const save = defaultSave();
  const persona = { id: 'talk', name: 'Talk', gender: 'f', age: 24 };
  const created = commitMatch(save, previewMatch(save, { personas: [persona], center: 24, now }), { personas: [persona], now });
  const s = created.session;
  appendEncounterMessage(save, persona.id, s.id, 'ai', '你好', { at: now });
  appendEncounterMessage(save, persona.id, s.id, 'ai', '你好', { at: now + 1 });
  appendEncounterMessage(save, persona.id, s.id, 'sys', 'ignore', { at: now + 2 });
  for (let i = 0; i < 4; i += 1) appendEncounterMessage(save, persona.id, s.id, 'me', `玩家${i}`, { at: now + 3 + i });
  for (let i = 0; i < 5; i += 1) appendEncounterMessage(save, persona.id, s.id, 'ai', `AI${i}`, { at: now + 8 + i });
  ok(encounterProgress(s).total === 10 && encounterProgress(s).player === 4 && encounterProgress(s).unlocked, '有效句数：系统/空/连续重复不计，10+玩家4 解锁');
  markEnded(save, persona.id, s.id, now + 30);
  ok(!appendEncounterMessage(save, persona.id, s.id, 'me', '不能续接'), '结束场次不能继续');
  const friend = { personaId: persona.id, chat: [], memory: [] };
  const moved = migrateEncounterToFriend(save, persona.id, friend);
  ok(moved.migrated === 1 && friend.chat[0].text.includes('第 1 次') && friend.chat.at(-1).text.includes('成为了好友'), '迁移按场次与时间写入好友聊天');
  const length = friend.chat.length;
  ok(migrateEncounterToFriend(save, persona.id, friend).migrated === 0 && friend.chat.length === length, '迁移幂等');
}
{
  const normalized = normalize({ encounters: { days: null, records: null, recent: null } });
  ok(normalized.encounters && typeof normalized.encounters.days === 'object' && Array.isArray(normalized.encounters.recent), '存档 normalize 补 encounters 形状');
}

if (failures) process.exitCode = 1;
else console.log('encounter tests passed');
