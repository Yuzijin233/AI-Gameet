/**
 * AI 记忆本地化测试（node tools/test-savefile.mjs）
 *
 * 盯三件事：
 *  1. `memoryDigest` / `memoryJson` 这两个纯函数：分类标签、自设、空存档都得对
 *  2. 本地服务真的会写文件：起一个真服务器 → POST 存档 → 检查
 *     save/ddz_save.json + save/AI记忆.md + save/AI记忆.json 有没有生成、内容对不对
 *  3. GET /api/save 能把文件读回来（浏览器存档丢了就靠它恢复）
 *
 * 注意：起服务器用 `stdio: 'ignore'`（沙箱里管道通信会被拦），只通过 HTTP 交互。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryDigest, memoryJson, tagMemory } from '../src/data/memoryDigest.js';
import { PERSONAS } from '../src/data/personas.js';
import { defaultSave, normalize, shouldRestoreFromFile } from '../src/store/storage.js';
import { SELF_PREFIX } from '../src/data/memory.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

/* ===================================================================== */
console.log('-- 老存档自愈：对局记忆要补上玩法名（用户报的"不知道上一局打的是什么"）');
{
  const s = defaultSave();
  s.nickname = '羽子衿';
  s.friends = [{
    personaId: 'p05',
    name: '春和景明',
    affinity: 40,
    memory: [
      '对局：[9/20 23:02] 这局你执黑先手，和玩家羽子衿下了 24 手，最后你输了，低级场不涉及开心豆。',
      '对局：[9/20 21:59] 这局我输得挺干脆，鱼篓 11 比 38 落后羽子衿 27 张，还赔了 2586 豆。',
      '对局：[9/19 20:00] 斗地主：这局玩家输了 1000 豆',
      '偏好：爱喝奶茶',
    ],
  }];
  s.recentHands = [
    { kind: 'gomoku', at: Date.now(), summary: '这局玩家执黑先手，和对手下了 24 手，最后输了。' },
    { kind: 'fishing', at: Date.now(), summary: '小猫钓鱼：玩家输了 2,586 豆' },
  ];
  const out = normalize(s);
  const mem = out.friends[0].memory.join('\n');
  ok(/对局：\[9\/20 23:02\] 五子棋：这局你执黑先手/.test(mem), '★ 没写玩法的五子棋记忆补上了"五子棋："');
  ok(/对局：\[9\/20 21:59\] 小猫钓鱼：这局我输得挺干脆/.test(mem), '★ 钓鱼记忆（有"鱼篓"）补上"小猫钓鱼："');
  ok(/对局：\[9\/19 20:00\] 斗地主：这局玩家输了 1000 豆/.test(mem), '已经点明玩法的原样不动');
  ok(mem.includes('偏好：爱喝奶茶'), '非对局记忆一个字都不动');
  ok(/^五子棋：/.test(out.recentHands[0].summary), '★ 最近几局的概括也补玩法名');
  ok(out.recentHands[1].summary === '小猫钓鱼：玩家输了 2,586 豆', '已经有了就不重复加');
}

/**
 * 造一条好友记录。
 * ★ 一定要带 `name`：真实存档里 `addFriend` 会把人名抄一份进来，而且服务端现在
 *   **只从存档取名字**（分发版里人设表是加密的，Node 读不了）——
 *   少了这个字段，记忆文件里就会显示成冷冰冰的 `p05`。
 */
const NAME_OF = { p05: '春和景明', p14: '笑看风云', p07: '凌晨三点', p01: '不吃香菜' };
const friend = (id, affinity, memory) => ({ personaId: id, name: NAME_OF[id] || id, affinity, memory, chat: [] });

/* ===================================================================== */
console.log('-- 记忆 → 人能读的文本（纯函数）');
{
  ok(tagMemory('称呼：阿伟').label === '称呼' && tagMemory('称呼：阿伟').text === '阿伟',
    '「称呼：阿伟」拆成 标签=称呼 / 正文=阿伟（不重复写两遍）');
  ok(tagMemory('对局：低级场赢了').label === '对局', '对局能被认出来');
  const self = tagMemory(`${SELF_PREFIX}老家=杭州`);
  ok(self.label === '自设' && self.aspect === '老家' && self.text === '杭州',
    '「自设：老家=杭州」拆成 方面=老家 / 正文=杭州');
  ok(tagMemory('随便一句话').label === '其他', '认不出的归到"其他"，不丢内容');

  const save = defaultSave();
  save.nickname = '佛系少年';
  save.friends = [
    friend('p05', 88, ['称呼：阿伟', '身份：南京人', `${SELF_PREFIX}老家=杭州`, '对局：低级场，玩家赢了']),
    friend('p14', 50, []),
  ];
  save.recentHands = [{ kind: 'ddz', at: Date.now(), summary: '低级场一局，玩家赢了' }];
  const md = memoryDigest(save, { personas: PERSONAS });
  ok(md.includes('# AI 记忆（自动生成）'), '有标题');
  ok(md.includes('玩家：佛系少年'), '写了玩家是谁');
  ok(md.includes('## 春和景明（p05）'), '★ 按人分节，标题是**人设名字**（不是冷冰冰的 p05）');
  ok(md.includes('好感度：88/100'), '带好感度');
  // ★ 记忆**分三块**写（用户要求）：自设 / 玩家 / 其他（系统记录）
  ok(md.includes('**自设（我自己的设定）**'), '★ 自设单独一块（用户要求写"我自己的设定"）');
  ok(md.includes('**玩家（关于玩家的事）**'), '★ 关于玩家的一块');
  ok(md.includes('- 🏷️ **称呼**：阿伟'), '记忆按分类带图标列出');
  ok(md.includes('- 🧬 **老家**：杭州'), '自设写成「方面：内容」（一眼看出是我自己的设定）');
  ok(md.includes('- 📌 **身份**：南京人') || md.includes('- 🎓 **身份**：南京人'), '★ 玩家的事在玩家的块里');
  {
    // 系统记录（对局 / 友圈 / 改名 / 关系）要单独一块，不能混进"玩家"那栏
    const s2 = defaultSave();
    s2.nickname = '小徐';
    s2.friends = [friend('p05', 60, [
      '称呼：小张', '偏好：爱吃甜品', `${SELF_PREFIX}午饭=泡面`,
      '对局：[9/20 14:43] 这局玩家赢了', '友圈：[9/20 14:43] 说说「你们想改名吗」｜我评论：刚改完就后悔了',
    ])];
    const md2 = memoryDigest(s2, { personas: PERSONAS });
    const playerBlock = md2.slice(md2.indexOf('**玩家（关于玩家的事）**'), md2.indexOf('**其他（系统记的'));
    const otherBlock = md2.slice(md2.indexOf('**其他（系统记的'));
    ok(playerBlock.includes('称呼') && playerBlock.includes('偏好'), '玩家的两块内容在玩家块里');
    ok(!playerBlock.includes('友圈：'), '★ 友圈那种"既有玩家又有它自己"的行**不在**玩家块里');
    ok(otherBlock.includes('**友圈**') && otherBlock.includes('**对局**'), '★ 对局 / 友圈归在"其他（系统记录）"块');
    ok(!otherBlock.includes('**自设（我自己的设定）**'), '自设没有被放进系统块');
  }
  ok(md.includes('还没有记忆'), '没记忆的人明确写"还没有记忆"，不让人以为丢了');
  ok(md.includes('最近几局'), '把最近对局也带上（AI 聊天时会回忆）');
  ok(md.includes('只有**私聊**') || md.includes('只在**私聊**'), '说明记忆只在私聊里沉淀');

  const json = memoryJson(save, { personas: PERSONAS });
  ok(json.friendCount === 2 && json.memoryCount === 4, `JSON 统计对得上（${json.friendCount} 人 / ${json.memoryCount} 条）`);
  ok(json.friends[0].name === '春和景明', 'JSON 里也有名字');
  ok(json.friends[0].memory[2].aspect === '老家', 'JSON 里自设有方面字段');
  ok(json.friends[1].memory.length === 0, '空记忆就是空数组');

  const empty = memoryDigest(defaultSave(), { personas: PERSONAS });
  ok(empty.includes('还没有好友'), '空存档也生成得出来，并说明原因');
  ok(memoryJson(defaultSave()).friends.length === 0, '空存档的 JSON 是空列表');
  ok(memoryDigest(null, { personas: PERSONAS }).includes('# AI 记忆'), 'null 存档也不炸');
}

/* ===================================================================== */
console.log('-- 启动时"用文件还是用浏览器"的判断');
{
  const now = Date.now();
  ok(shouldRestoreFromFile({ localFresh: true, localAt: 0, fileAt: now }), '浏览器里没存档 → 用文件恢复');
  ok(shouldRestoreFromFile({ localFresh: true, localAt: 0, fileAt: 0 }), '浏览器里没存档、文件也没时间戳 → 还是试着恢复');
  ok(!shouldRestoreFromFile({ localAt: now, fileAt: 0 }), '文件不存在 → 用浏览器里的');
  ok(!shouldRestoreFromFile({ localAt: now, fileAt: now - 5000 }), '文件更旧 → 用浏览器里的');
  ok(shouldRestoreFromFile({ localAt: now - 60000, fileAt: now }), '★ 文件更新（手改过）→ 用文件里的');
  ok(!shouldRestoreFromFile({ localAt: now, fileAt: now + 400 }), '刚刚才写的文件不算"更新"（留了 1.5s 宽限）');
  ok(!shouldRestoreFromFile({ localAt: 0, fileAt: now }), '★ 浏览器里是"没有时间戳的老存档"→ 不冲掉它（以浏览器为准）');
}

/* ===================================================================== */
console.log('-- 存档字段：savedAt（用来和本地文件比新旧）');
{
  const s = defaultSave();
  ok(s.savedAt === '', '新存档 savedAt 是空串（还没存过）');
  ok(normalize({ version: 1, nickname: 'x', savedAt: 12345 }).savedAt === '',
    '非法 savedAt 被纠正成空串');
  ok(normalize({ version: 1, nickname: 'x', savedAt: '2026-03-05T10:00:00.000Z' }).savedAt
    === '2026-03-05T10:00:00.000Z', '合法 savedAt 原样保留');
}

/* ===================================================================== */
console.log('-- 重置存档：记忆必须一起清掉');
{
  // 造一份"玩过很久"的存档：好友 + 记忆 + 对局 + 群聊 + 恋人
  const before = defaultSave();
  before.nickname = '我不是赌神';
  before.friends = [
    friend('p05', 70, ['称呼：小徐', '对局：低级场赢了', `${SELF_PREFIX}老家=南京`]),
    friend('p07', 55, ['对局：输了一局']),
  ];
  before.loverId = 'p05';
  before.recentHands = [{ kind: 'ddz', at: Date.now(), summary: '一局' }];
  before.groups = [{ id: 'g1', name: '唠嗑群', members: ['p05', 'p07'], chat: [{ role: 'me', by: 'me', text: '在吗' }] }];
  ok(memoryJson(before).memoryCount === 4, '重置前确实有 4 条记忆');

  // 和 app.resetSave() 里那一行**完全同一个表达式**（头像照片保留，其余重来）
  const after = Object.assign(defaultSave(), { avatar: before.avatar, avatarUpload: before.avatarUpload });
  ok(after.friends.length === 0, '★ 重置后好友清空 → 挂在好友身上的记忆自然也全没了');
  ok(memoryJson(after).memoryCount === 0, '★ 记忆条数归零');
  ok(memoryJson(after).friends.length === 0, '★ 记忆文件里不会再列出任何人');
  ok(after.loverId === '' && !after.groups.length && !after.recentHands.length,
    '恋人 / 群聊 / 最近对局 一起清掉（关系记忆不会残留）');
  ok(!memoryJson(after).recentHands.length, '对局记忆也不会留在文件里');
  ok(memoryDigest(after, { personas: PERSONAS }).includes('还没有好友'), '重置后的记忆文件明确写"还没有好友"');

  const uiApp = readFileSync(join(root, 'src/ui/app.js'), 'utf8');
  const resetFn = (uiApp.match(/resetSave\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/Object\.assign\(defaultSave\(\), \{ avatar: this\.save\.avatar, avatarUpload: this\.save\.avatarUpload \}\)/.test(resetFn),
    '★ resetSave 用的就是 defaultSave()（不保留好友，所以记忆一定被清）');
  ok(/this\.persist\('reset'\)/.test(resetFn), '重置后立刻落库（localStorage + 本地文件都刷成空的）');
}

/* ===================================================================== */
console.log('-- 真起一个服务器：POST 存档 → 落成本地文件 → GET 读回来');
{
  const PORT = 5399;
  // 测试写到**项目里的临时目录**，绝不碰玩家真正的 save/
  // （系统临时目录在沙箱里不可写，所以放工作区里的一个自建目录，跑完就删）
  const saveDir = join(root, 'tmp-test-save');
  const files = ['ddz_save.json', 'AI记忆.md', 'AI记忆.json'];
  rmSync(saveDir, { recursive: true, force: true });
  mkdirSync(saveDir, { recursive: true });

  const child = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DDZ_NO_OPEN: '1', DDZ_SAVE_DIR: saveDir },
    stdio: 'ignore', // 沙箱里不能用管道，服务器日志也不需要看
    windowsHide: true,
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = `http://127.0.0.1:${PORT}`;

  try {
    // 等服务器起来（最多 8 秒）
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await wait(200);
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(`${base}/__ddz`);
        up = r.ok;
      } catch { up = false; }
    }
    ok(up, `服务器在 ${PORT} 起来了`);

    if (up) {
      const save = defaultSave();
      save.nickname = '佛系少年';
      save.friends = [
        friend('p05', 88, ['称呼：阿伟', `${SELF_PREFIX}老家=杭州`]),
        friend('p14', 50, ['对局：这局输了']),
      ];
      save.beans = 18913;
      save.loverId = '';
      save.recentHands = [{ kind: 'ddz', at: Date.now(), summary: '低级场一局' }];

      const post = await fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(save),
      });
      ok(post.ok, 'POST /api/save 成功');
      const posted = await post.json();
      ok(posted.ok && Array.isArray(posted.files) && posted.files.length === 3, '回执里列出写出的三个文件');
      ok(/^\d{4}-/.test(posted.savedAt || ''), '回执带 savedAt（服务端补的）');

      ok(existsSync(join(saveDir, 'ddz_save.json')), '★ 写出 save/ddz_save.json');
      ok(existsSync(join(saveDir, 'AI记忆.md')), '★ 写出 save/AI记忆.md');
      ok(existsSync(join(saveDir, 'AI记忆.json')), '★ 写出 save/AI记忆.json');

      const disk = JSON.parse(readFileSync(join(saveDir, 'ddz_save.json'), 'utf8'));
      ok(disk.nickname === '佛系少年' && disk.beans === 18913, '存档文件里的内容对得上');
      ok(typeof disk.savedAt === 'string' && disk.savedAt.length > 0, '存档文件里带 savedAt');
      ok(readFileSync(join(saveDir, 'ddz_save.json'), 'utf8').includes('\n  "'), '是缩进过的 JSON（人能读）');

      const md = readFileSync(join(saveDir, 'AI记忆.md'), 'utf8');
      ok(md.includes('## 春和景明（p05）') && md.includes('老家'), '★ 记忆文件里能直接看到"春和景明"记了什么');
      // ★ 服务端现在只从存档里取名字（分发版的人设表是加密的，Node 读不了）
      ok(!/## p05（p05）/.test(md), '★ 名字没有退化成 personaId（好友记录里的 name 用上了）');

      const mem = JSON.parse(readFileSync(join(saveDir, 'AI记忆.json'), 'utf8'));
      ok(mem.friends.find((f) => f.personaId === 'p05').memory.length === 2, '记忆 JSON 里也是 2 条');

      // 读回来
      const got = await (await fetch(`${base}/api/save`)).json();
      ok(got.ok && got.save.nickname === '佛系少年', '★ GET /api/save 能把存档读回来');
      ok(typeof got.mtime === 'number' && got.mtime > 0, '带上文件修改时间（比新旧用）');

      // 坏数据要被挡住，不能把存档文件写坏
      const bad = await fetch(`${base}/api/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"nope":1}',
      });
      ok(bad.status === 400, '不是存档的 JSON 会被 400 拒掉');
      const stillGood = JSON.parse(readFileSync(join(saveDir, 'ddz_save.json'), 'utf8'));
      ok(stillGood.nickname === '佛系少年', '被拒之后原文件没被破坏');

      // ★ 重置存档（推一份空的上去）→ 本地文件里的记忆也必须跟着没
      const wiped = defaultSave();
      wiped.nickname = '我不是赌神';
      const wipeRes = await fetch(`${base}/api/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wiped),
      });
      ok(wipeRes.ok, '推一份"重置后"的存档上去');
      const mdAfter = readFileSync(join(saveDir, 'AI记忆.md'), 'utf8');
      ok(!mdAfter.includes('春和景明'), '★ 重置后记忆文件里不再有那位好友');
      ok(mdAfter.includes('还没有好友'), '★ 重置后记忆文件写的是"还没有好友"');
      const memAfter = JSON.parse(readFileSync(join(saveDir, 'AI记忆.json'), 'utf8'));
      ok(memAfter.memoryCount === 0 && memAfter.friends.length === 0, '★ 记忆 JSON 也清空了');
    }
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await wait(300);
    rmSync(saveDir, { recursive: true, force: true }); // 临时目录用完就删，工作区保持干净
  }
}

/* ===================================================================== */
console.log('-- save/ 目录：说明文件在，测试不会碰它');
{
  const saveDir = join(root, 'save');
  ok(existsSync(join(saveDir, 'README.md')), 'save/README.md 在（打包后别人也知道这目录是干嘛的）');
  // 测试用的是临时目录（DDZ_SAVE_DIR），所以这里不会因为跑测试而变脏
  ok(!readFileSync(join(saveDir, 'README.md'), 'utf8').includes('佛系少年'), 'README 是说明文档，不含任何测试数据');
  const serverSrc = readFileSync(join(root, 'server.js'), 'utf8');
  ok(/process\.env\.DDZ_SAVE_DIR/.test(serverSrc), '服务端支持 DDZ_SAVE_DIR（测试写到临时目录，不脏玩家的记忆文件）');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : 'AI 记忆本地化（save/ 文件）检查通过'}`);
process.exit(fail ? 1 : 0);
