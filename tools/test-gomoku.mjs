/**
 * 五子棋：规则 + 引擎 + 难度（node tools/test-gomoku.mjs）
 *
 * 盯这些：
 *   · 规则：五连即胜（横竖斜）、无禁手（长连也算）、下满=平局、不能重复落子
 *   · 引擎：能赢就赢、该挡就挡、难度越高压着打（用固定随机数做确定断言）
 *   · 难度分配：28 位人设都有档位，场次池不空，且**不给玩家看**
 *   · 场次：低级=新手/入门，中级=入门/熟练/精通，高级=精通/大师（GOMOKU_ROOMS）
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  BOARD_SIZE, EMPTY, BLACK, WHITE, createBoard, place, checkWinAt, findWinner, isFull, moveCount,
  scorePoint, candidates, pickMove, SCORES, boardSituation,
} from '../src/core/gomoku.js';
import { GOMOKU, GOMOKU_ROOMS, FRIEND } from '../src/config.js';
import { PERSONAS } from '../src/data/personas.js';
import { LEVELS, LEVEL_BY_PERSONA, levelOf, levelIndex, levelCounts, botLevelOfRoom, pickByRoom } from '../src/data/gomokuLevels.js';
import { buildMessages, pickLocal } from '../src/ai/chat.js';
import { gomokuView } from '../src/ai/gomokuView.js';
import { GOMOKU_LINES } from '../src/data/gomokuLines.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };
const read = (p) => {
  const u = new URL(p, import.meta.url);
  return existsSync(u) ? readFileSync(u, 'utf8') : '';
};
/** 固定随机数：0.99 → 每次都取最后一个，0 → 每次第一个 */
const rndSeq = (list) => { let i = 0; return () => list[i++ % list.length]; };

/* ===================================================================== */
console.log('-- 规则');
{
  ok(GOMOKU.size === 15 && BOARD_SIZE === 15, '15×15');
  const b = createBoard();
  ok(b.length === 15 && b[0].length === 15, '棋盘是 15×15 的空盘');
  ok(moveCount(b) === 0 && !isFull(b), '空盘：0 手、没满');

  // 横向五连
  for (let x = 3; x < 7; x += 1) place(b, x, 7, BLACK);
  ok(!checkWinAt(b, 6, 7), '只有 4 连时不算赢');
  place(b, 7, 7, BLACK);
  const win = checkWinAt(b, 7, 7);
  ok(win && win.who === BLACK && win.line.length >= 5, '★ 横向五连即胜');
  ok(findWinner(b).who === BLACK, 'findWinner 也能找到赢家');

  // 竖向
  const v = createBoard();
  for (let y = 0; y < 5; y += 1) place(v, 2, y, WHITE);
  ok(checkWinAt(v, 2, 4).who === WHITE, '竖向五连');

  // 两个斜向
  const d1 = createBoard();
  for (let i = 0; i < 5; i += 1) place(d1, i, i, BLACK);
  ok(checkWinAt(d1, 2, 2).who === BLACK, '左上→右下斜五连');
  const d2 = createBoard();
  for (let i = 0; i < 5; i += 1) place(d2, 4 + i, 10 - i, WHITE);
  ok(checkWinAt(d2, 6, 8).who === WHITE, '右上→左下斜五连');

  // 无禁手：长连（6 连）也算赢
  const l = createBoard();
  for (let x = 0; x < 6; x += 1) place(l, x, 0, BLACK);
  ok(checkWinAt(l, 3, 0).who === BLACK, '★ 无禁手：六连照样算赢');

  // 不能重复落子 / 越界
  ok(place(b, 7, 7, WHITE) === false, '已有子的位置不能再下');
  ok(place(b, -1, 0, BLACK) === false && place(b, 15, 0, BLACK) === false, '越界不能下');

  // 下满 = 平局（这里只测 isFull）
  const full = createBoard(3);
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) place(full, x, y, BLACK);
  ok(isFull(full), '下满时 isFull = true（平局判定用它）');
}

/* ===================================================================== */
console.log('-- 打分：认得活四 / 冲四 / 活三');
{
  const b = createBoard();
  // 黑：_XXX_  →  两端落子都能成活四
  for (let x = 5; x < 8; x += 1) place(b, x, 7, BLACK);
  const s1 = scorePoint(b, 4, 7, BLACK).score;
  const s2 = scorePoint(b, 8, 7, BLACK).score;
  ok(s1 >= SCORES.openFour && s2 >= SCORES.openFour, `★ 活四的分很高（${s1} / ${s2}）`);
  // 白先堵一头 → 黑再下另一头只有冲四的分（成不了活四）
  place(b, 4, 7, WHITE);
  const s3 = scorePoint(b, 8, 7, BLACK).score;
  ok(s3 >= SCORES.four && s3 < SCORES.openFour, `一头被堵 → 冲四（${s3}）`);
  // 能把"对手下这里有多大"算出来（AI 靠它挡）
  ok(scorePoint(b, 8, 7, BLACK).score >= SCORES.four, '对手的成五威胁算得出来');
  // 空点没有分
  ok(scorePoint(b, 0, 0, BLACK).score <= 0, '离得远的空点没有分');
}

/* ===================================================================== */
console.log('-- 引擎：能赢就赢 / 该挡就挡 / 难度有梯度');
{
  // ① 能赢就赢（所有难度）
  for (const lv of LEVELS) {
    const b = createBoard();
    for (let x = 3; x < 7; x += 1) place(b, x, 5, BLACK); // 黑四连，两端空
    const mv = pickMove(b, BLACK, lv, { rnd: () => 0.5 });
    ok(!!mv && (mv.x === 2 || mv.x === 7) && mv.y === 5, `${lv}：有四连时会补成五（${mv && mv.x},${mv && mv.y}）`);
  }

  // ② 对手四连：**所有难度都会挡**（用户拍板：最弱的一档也不能乱下）
  for (const lv of LEVELS) {
    const b = createBoard();
    for (let x = 3; x < 7; x += 1) place(b, x, 5, WHITE); // 白四连，轮到黑
    const mv = pickMove(b, BLACK, lv, { rnd: () => 0.99 });
    ok(!!mv && (mv.x === 2 || mv.x === 7) && mv.y === 5, `★ ${lv}：会挡对手的"马上成五"（${mv && mv.x},${mv && mv.y}）`);
  }

  /**
   * ★ 新手**不再乱下**（用户报的问题："最弱的敌人档次太弱了，完全是乱下"）
   *   旧实现：rank 0 走到最后是"候选点里随机挑一个"（reason = novice-random）。
   *   新口径：新手也按分数挑（自己的进攻优先），只是**几乎不看对手的威胁**（最弱）。
   *   这里用"多次随机取样"验证：它选的点必须一直是"自己这边分数最高的前几名"之一。
   */
  {
    const b = createBoard();
    place(b, 7, 7, BLACK); place(b, 8, 8, BLACK); // 黑有个活二
    place(b, 3, 3, WHITE); place(b, 10, 10, WHITE);
    const mineScores = new Map();
    for (const c of candidates(b, 2)) mineScores.set(c.y * 15 + c.x, scorePoint(b, c.x, c.y, BLACK).score);
    const ranked = [...mineScores.entries()].sort((a, c) => c[1] - a[1]);
    const top3 = new Set(ranked.slice(0, 3).map(([k]) => k));
    let allInTop3 = true;
    let badReason = '';
    for (let i = 0; i < 60; i += 1) {
      const mv = pickMove(b, BLACK, '新手');
      if (!mv) { allInTop3 = false; break; }
      if (!top3.has(mv.y * 15 + mv.x)) { allInTop3 = false; badReason = `${mv.x},${mv.y}`; break; }
      if (mv.reason === 'novice-random') { badReason = '还在用旧的随机策略'; allInTop3 = false; break; }
    }
    ok(allInTop3, `★ 新手只从"自己分数最高的前 3 个点"里挑（不是全盘随机）${badReason ? `：异常 ${badReason}` : ''}`);

    // 老口径的复核：新手**仍然看不出对手的活三**（这是它最弱的地方，保留）
    const trap = createBoard();
    place(trap, 5, 7, WHITE); place(trap, 6, 7, WHITE); place(trap, 7, 7, WHITE); // 白活三
    place(trap, 0, 0, BLACK); place(trap, 1, 1, BLACK);
    const mvNewbie = pickMove(trap, BLACK, '新手', { rnd: () => 0.99 });
    ok(!!mvNewbie && !(mvNewbie.y === 7 && (mvNewbie.x === 4 || mvNewbie.x === 8)),
      `★ 新手还是看不出活三（保留最弱的地方）：下了 (${mvNewbie && mvNewbie.x},${mvNewbie && mvNewbie.y})`);
  }

  // ③ 活三（白三连两头空 = 下一步能成活四）：新手/入门会漏，精通必挡
  const liveThreeBoard = () => {
    const b = createBoard();
    place(b, 5, 7, WHITE); place(b, 6, 7, WHITE); place(b, 7, 7, WHITE); // 白活三
    place(b, 0, 0, BLACK); place(b, 1, 1, BLACK); // 黑自己有两个子（不影响判断）
    return b;
  };
  const blocksLiveThree = (lv, rnd) => {
    const mv = pickMove(liveThreeBoard(), BLACK, lv, { rnd });
    // 白活三的必挡点：x=4 或 x=8（y=7）
    return !!mv && mv.y === 7 && (mv.x === 4 || mv.x === 8);
  };
  ok(blocksLiveThree('精通', () => 0.9) && blocksLiveThree('大师', () => 0.9), '★ 精通 / 大师：活三必挡');
  ok(blocksLiveThree('新手', () => 0.9) === false, '新手看不出活三（不会挡）');
  // 入门 45% 会漏：rnd 小 → 漏；rnd 大 → 挡
  ok(blocksLiveThree('入门', rndSeq([0.9, 0.9, 0.9, 0.9])) , '入门：多数时候还是会挡');
  ok(blocksLiveThree('入门', rndSeq([0.1, 0.1, 0.1, 0.1])) === false, '★ 入门：45% 的概率会看漏');
  // 熟练 15% 会漏
  ok(blocksLiveThree('熟练', rndSeq([0.9, 0.9, 0.9, 0.9])), '熟练：基本都挡得住');
  ok(blocksLiveThree('熟练', rndSeq([0.1, 0.1, 0.1, 0.1])) === false, '★ 熟练：偶尔漏一手');
  // 精通不靠随机：给最小的随机数也照样挡
  ok(blocksLiveThree('精通', () => 0) && blocksLiveThree('大师', () => 0), '精通 / 大师 不会漏（与随机数无关）');

  // ④ 空盘第一手：天元
  {
    const mv = pickMove(createBoard(), BLACK, '大师', { rnd: () => 0.5 });
    ok(mv && mv.x === 7 && mv.y === 7, '空盘第一手下天元');
  }

  // ⑤ 候选点只在棋子附近（不会满盘乱下）
  {
    const b = createBoard();
    place(b, 7, 7, BLACK);
    const list = candidates(b);
    ok(list.length > 0 && list.every((c) => Math.abs(c.x - 7) <= 2 && Math.abs(c.y - 7) <= 2),
      `候选点限制在棋子 2 格内（${list.length} 个）`);
  }

  // ⑥ 大师 vs 新手：让大师执黑、新手执白，大师该赢（多跑几局）
  {
    let masterWins = 0;
    const games = 5;
    for (let g = 0; g < games; g += 1) {
      const b = createBoard();
      let who = BLACK;
      let moves = 0;
      let winner = null;
      while (moves < 80 && !winner) {
        const lv = who === BLACK ? '大师' : '新手';
        const mv = pickMove(b, who, lv, { rnd: rndSeq([0.2 + g * 0.1, 0.5, 0.8]) });
        if (!mv) break;
        place(b, mv.x, mv.y, who);
        moves += 1;
        const w = checkWinAt(b, mv.x, mv.y);
        if (w) winner = w.who;
        who = who === BLACK ? WHITE : BLACK;
      }
      if (winner === BLACK) masterWins += 1;
    }
    ok(masterWins >= games - 1, `★ 大师执黑对新手执白：${games} 局赢 ${masterWins} 局`);
  }
}

/* ===================================================================== */
console.log('-- 难度分配与场次池');
{
  ok(LEVELS.length === 5, '五档难度：新手 / 入门 / 熟练 / 精通 / 大师');
  ok(GOMOKU.levels.join() === LEVELS.join(), 'config 里的档位和 data 层一致');
  for (const p of PERSONAS) {
    const lv = levelOf(p.id);
    ok(LEVELS.includes(lv), `${p.id}（${p.name}）的难度合法：${lv}`);
  }
  ok(Object.keys(LEVEL_BY_PERSONA).length === PERSONAS.length,
    `28 位人设都分配了难度（${Object.keys(LEVEL_BY_PERSONA).length} 个）`);
  const counts = levelCounts();
  for (const lv of LEVELS) ok(counts[lv] >= 3, `「${lv}」至少有 3 个人（实际 ${counts[lv]}）`);
  ok(levelIndex('新手') === 0 && levelIndex('大师') === 4, '难度序号：新手 0 … 大师 4');
  ok(levelOf('不存在的人') === '熟练', '认不出的 personaId 兜底"熟练"');

  // 场次池
  ok(GOMOKU_ROOMS.length === 3, '五子棋三个场次：低级 / 中级 / 高级');
  ok(GOMOKU_ROOMS[0].levels.join() === '新手,入门', '低级场 → 新手 / 入门');
  ok(GOMOKU_ROOMS[1].levels.join() === '入门,熟练,精通', '中级场 → 入门 / 熟练 / 精通');
  ok(GOMOKU_ROOMS[2].levels.join() === '精通,大师', '★ 高级场 → 精通 / 大师');
  ok(GOMOKU_ROOMS.every((r) => r.minBeans === undefined), '★ 五子棋场次**没有门槛**（不涉及豆子）');
  ok(GOMOKU_ROOMS.every((r) => !/新手|入门|熟练|精通|大师/.test(`${r.name}${r.desc}`)),
    '★ 场次名字和说明里不暴露难度档位（难度是隐性的）');

  // 按场次挑人设：只从池子里出
  for (const room of GOMOKU_ROOMS) {
    for (let i = 0; i < 20; i += 1) {
      const p = pickByRoom(room.id, { rnd: Math.random });
      ok(room.levels.includes(levelOf(p.id)), `${room.name} 匹配到的人难度在池子里（${p.name}/${levelOf(p.id)}）`);
    }
  }
  // 机器模式：从池子随机取一档
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(botLevelOfRoom('high'));
  ok([...seen].every((lv) => ['精通', '大师'].includes(lv)), '机器模式在高级场只出精通/大师');
  ok(seen.size === 2, '机器模式的难度确实在池子里随机（两档都出现过）');
}

/* ===================================================================== */
/* ===================================================================== */
console.log('-- 场上形势（给 AI 说话用）：只给客观事实、不泄露意图');
{
  const b = createBoard();
  // 黑：三个连子两头空（活三）；白：四连（马上成五）
  place(b, 5, 7, BLACK); place(b, 6, 7, BLACK); place(b, 7, 7, BLACK);
  place(b, 3, 9, WHITE); place(b, 4, 9, WHITE); place(b, 5, 9, WHITE); place(b, 6, 9, WHITE);
  const text = boardSituation(b, {
    playerColor: BLACK, aiColor: WHITE, moves: moveCount(b), last: { x: 6, y: 9, who: WHITE },
  });
  // ★ 不报具体手数（用户拍板：谁记得住），只说阶段
  ok(/棋局阶段：/.test(text), `形势里给的是"阶段"：${text}`);
  ok(!/\d+\s*手/.test(text), '★ 形势里不出现"下了 N 手"这种数字（只分档）');
  ok(/你（执白）这边：/.test(text) && /玩家（执黑）那边：/.test(text), '★ 双方各有一栏形势');
  {
    const [mine, his] = text.split('玩家（执黑）那边：');
    ok(/能直接连成五/.test(mine), '★ 白这边四连（下一步就能连五）数得出来');
    ok(/能做出活四/.test(his), '★ 黑那三个连子（能做活四）也数得出来');
  }
  ok(/最后一手落在第 10 行第 7 列/.test(text), '报出最后一手的位置');
  // ★ 不能泄露意图（用户要求）
  ok(!/我要|我打算|拦你|防你|进攻|防守/.test(text), '★ 形势里没有任何"意图"措辞，只有客观事实');
  const empty = boardSituation(createBoard(), { playerColor: BLACK, aiColor: WHITE, moves: 0 });
  ok(/暂时没有明显的好点/.test(empty), '空盘时如实说"没有明显好点"');
}

console.log('-- 复盘（对局记忆）不报具体手数，只说分档');
{
  const { gomokuFacts, moveCountBand } = await import('../src/ai/matchSummary.js');
  const { movePhase } = await import('../src/core/gomoku.js');

  // 分档边界
  ok(movePhase(0) === 'opening' && movePhase(6) === 'opening', '≤6 手算开局');
  ok(movePhase(7) === 'mid' && movePhase(30) === 'mid', '7~30 手算中盘');
  ok(movePhase(31) === 'late' && movePhase(80) === 'late', '31~80 手算后半盘');
  ok(movePhase(81) === 'endgame', '80 手以上算残局');
  ok(moveCountBand(6) === '没几手就分出了胜负', '开局的说法');
  ok(moveCountBand(20) === '中盘缠斗了一阵', '中盘的说法');

  // 事实清单里**不能出现"下了 24 手"这种数字**
  for (const moves of [5, 24, 60, 150]) {
    const facts = gomokuFacts({
      winner: 'ai', first: 'player', moves, room: { name: '低级场' }, personaName: '羽子衿', playerName: '小徐',
    });
    ok(!/\d+\s*手/.test(facts), `★ 手数 ${moves} 的复盘里没有具体手数（${facts.slice(0, 40)}…）`);
    ok(/下了/.test(facts), `手数 ${moves}：写了"大概下了多久"`);
  }
  const facts24 = gomokuFacts({
    winner: 'player', first: 'ai', moves: 24, room: { name: '低级场' }, personaName: '羽子衿', playerName: '小徐',
  });
  ok(/中盘缠斗了一阵/.test(facts24), `★ 24 手被写成"中盘缠斗了一阵"：${facts24}`);
  ok(/别写具体手数/.test(facts24), '事实清单里还额外叮嘱模型"别写具体手数"');

  // 概括提示词里也加了这条口径
  const { buildSummaryMessages } = await import('../src/ai/matchSummary.js');
  const sys = buildSummaryMessages({ kind: 'gomoku', room: { name: '低级场' }, facts: 'x', names: ['小徐'], selfName: '羽子衿' })[0].content;
  ok(/不要写具体手数/.test(sys), '★ 概括提示词里明确禁止写具体手数/步数');
}

console.log('-- 静态契约：不按豆子结算、不给玩家看难度');
{
  const lobby = read('../src/ui/lobby.js');
  const app = read('../src/ui/app.js');
  const friends = read('../src/ui/friends.js');
  const idx = read('../index.html');
  const uiSrc = read('../src/ui/gomoku.js');
  ok(/五子棋/.test(idx), '★ 大厅里有五子棋这张卡');
  ok(!/掼蛋/.test(idx), '★ 掼蛋那张占位卡已经删掉');
  ok(GOMOKU.affinityPerGame === 2 && FRIEND.playAffinityGomoku === 2,
    '★ 一局 +2 好感度（config 两处口径一致）');
  ok(/GOMOKU_ROOMS/.test(app) || /GOMOKU_ROOMS/.test(lobby), '场次用的是 GOMOKU_ROOMS');
  ok(!/minBeans/.test(uiSrc), '★ 五子棋界面/流程里完全不涉及豆子门槛');
  ok(!/新手|入门|熟练|精通|大师/.test(uiSrc), '★ 五子棋界面文案里不出现任何难度档位名（难度是隐性的）');

  // 房间模式：只要 1 位对手，且不显示场次（用户拍板）
  ok(/const need = \(game === 'fishing' \|\| gomoku\) \? 1 : 2/.test(friends),
    '★ 房间模式五子棋只要 1 位好友入座');
  ok(/if \(gomoku\) app\.startGomoku\(roomId, seats\.slice\(\)\)/.test(friends),
    '★ 房间模式开始的是五子棋，对手就是邀请的那位好友');
  // ★ 场次卡片**任何时候都不能被藏掉**（用户报的 bug：房间模式打完一局回大厅，
  //   右侧的"低级场/中级场/高级场"全没了 —— 而那张卡上的「开始游戏」正是进房间的唯一入口）
  ok(!/roomBlock\s*\.\s*hidden/.test(lobby), '★ 五子棋的场次列表不再被隐藏（房间模式也显示）');
  ok(/roomMode \? '开始房间（五子棋）'/.test(lobby), '★ 房间模式下标题改成"开始房间（五子棋）"');
  ok(/class="room-note"/.test(lobby), '★ 房间模式下加一句"难度跟着邀请的好友走"的提示');
  // 门槛那句只在"这个场次真有 minBeans"时才拼出来（五子棋场次没有这个字段）
  ok(/\(room && room\.minBeans\) \? `，门槛 \$\{beanLabel\(room\.minBeans\)\}` : ''/.test(friends),
    '★ 房间模式的门槛文案对五子棋自动省略');

  // 结算：加好感 + 写对局记忆，但**不动豆子**
  ok(/rewardGomokuFriend\(persona\)/.test(app), '★ 结算时给参战好友加好感度');
  ok(/recordGomokuMemory\(/.test(app) && /kind: 'gomoku'/.test(app), '★ 结算时写「对局」记忆（kind=gomoku）');
  ok(/delta: 0,\s*\n\s*deltas,/.test(app) || /delta: 0/.test(app), '★ 对局记录里的 delta 是 0（不涉及豆子）');
  ok(!/economy\.addBeans/.test(read('../src/ui/gomoku.js')), '★ 五子棋里没有任何"加豆/扣豆"的调用');
  ok(/export function showGomokuResult/.test(read('../src/ui/panels.js')), '有本局结算面板');
  ok(/MODE_NAME = \{ ddz: '斗地主', fishing: '小猫钓鱼', gomoku: '五子棋' \}/.test(read('../src/ai/matchSummary.js')),
    '玩法名表里有五子棋（概括不会写成斗地主）');
}

console.log('-- 提示词 / 台词不能串台（用户报的 bug：棋盘上说"出一张牌""出个3探探路"）');
{
  const board = createBoard();
  place(board, 7, 7, BLACK);
  place(board, 7, 8, WHITE);
  place(board, 8, 8, BLACK);
  const view = gomokuView({
    board, moves: 3, last: { x: 8, y: 8, who: BLACK }, playerColor: BLACK, turn: WHITE, over: false,
  });
  ok(view.mode === 'gomoku', '★ 五子棋的视图自带 mode=gomoku');
  ok(/五子棋/.test(view.situationText) === false && view.situationText.length > 0,
    '形势只讲棋（没有"打法/牌"这类说法）');

  // 提示词 / 台词不能串台（用户报的 bug：棋盘上说"出一张牌""出个3探探路"）
  const text = buildMessages({ persona: PERSONAS[0], scene: 'playSmall', view }).map((m) => m.content).join('\n');
  const firstLine = buildMessages({ persona: PERSONAS[0], scene: 'playSmall', view })[0].content.split('\n')[0];
  ok(/五子棋/.test(firstLine) && !/斗地主/.test(firstLine),
    '★ 提示词第一句就说"这是五子棋"（以前写死"你在玩三人斗地主"）');
  ok(/五子棋/.test(text), '提示词通篇是五子棋口径');
  ok(!/三人斗地主|你的身份：地主|你的手牌|上一手出牌|各家剩余张数|当前倍数/.test(text),
    '★ 不再给五子棋塞"地主/手牌/出牌/倍数"这些字段');
  ok(/不许出现"出牌""手牌"/.test(text), '★ 明确禁止牌桌词（出牌 / 手牌 / 叫地主）');
  ok(/别把意图直说/.test(text), '仍然不许把"我要拦你"这种意图直说');

  // 本地兜底台词：所有场景 × 所有人设，一个牌桌词都不许有
  const CARD_WORDS = /地主|手牌|要不起|出牌|出张|出一张|炸弹|王炸|倍数|豆子|顺子|连对|飞机|叫牌|牌桌|一手牌/;
  const bad = [];
  for (const p of PERSONAS) {
    for (const scene of Object.keys(GOMOKU_LINES)) {
      for (let i = 0; i < 6; i += 1) {
        const line = pickLocal(p, scene, new Set(), 'gomoku');
        if (CARD_WORDS.test(line)) bad.push(`${p.name}/${scene}: ${line}`);
      }
    }
  }
  ok(bad.length === 0, `★ 五子棋兜底台词里没有牌桌词（检查了 ${PERSONAS.length} 人 × ${Object.keys(GOMOKU_LINES).length} 场景）`, bad.slice(0, 3).join(' | '));
  // 每个场景都得有词，不能出现空池
  const emptyScene = Object.entries(GOMOKU_LINES)
    .filter(([, byStyle]) => !['aggressive', 'balanced', 'cautious'].every((s) => (byStyle[s] || []).length >= 3))
    .map(([k]) => k);
  ok(emptyScene.length === 0, '每个场景的三种口吻都至少 3 句', emptyScene.join(','));

  // 静态契约：五子棋说话时确实带上了 mode，而且视图不再走斗地主那套
  const app = read('../src/ui/app.js');
  ok(/mode: 'gomoku'/.test(app), '★ gomokuSpeak 把 mode=gomoku 交给对话层');
  ok(/gameKind === 'gomoku' && this\.gomoku/.test(app) && /gomokuView\(/.test(app),
    '★ viewFor 给五子棋用自己的视图（不再落到斗地主的 buildView）');
  ok(/mode: 'fishing'/.test(app), '小猫钓鱼同样标明 mode=fishing');

  /* ★ 用户报的 bug：有时候看不到对手刚下的是哪一手 */
  const gmk = read('../src/ui/gomoku.js');
  ok(!/const cur = box\.lastElementChild/.test(gmk),
    '★ 不再用 lastElementChild 认"最后一手"（那是最靠右下的那颗，不是刚下的）');
  ok(/const lastMove = Array\.isArray\(this\.history\)[\s\S]{0,130}this\.history\[this\.history\.length - 1\]/.test(gmk),
    '★ 改成从 history 里取真正的最后一手');
  ok(/lastMove && lastMove\.x === x && lastMove\.y === y\) el\.classList\.add\('is-last'\)/.test(gmk),
    '★ 标记打在"那一颗"棋子上（玩家和对手都适用）');
  ok(/\.gmk-stone\.is-last \{/.test(read('../styles/gomoku.css')), 'is-last 有可见的高亮样式');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '五子棋规则 / 引擎 / 难度检查通过'}`);
process.exit(fail ? 1 : 0);
