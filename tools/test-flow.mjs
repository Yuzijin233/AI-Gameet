/**
 * 抢地主/出牌流程回归测试（node tools/test-flow.mjs）
 * 复现并防止：重复点击、超时与点击同时发生、过期点击导致的“又问我抢不抢又在出牌 / 卡死”
 * 这里用与 TableController.waitHuman / settleHuman 相同的“询问-应答”协议驱动引擎。
 */
import { Game, PHASE } from '../src/game/engine.js';
import { PERSONAS } from '../src/data/personas.js';
import { ROOMS } from '../src/config.js';
import { findPlays } from '../src/core/rules.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };

/** 模拟控制器的询问-应答协议 */
class Driver {
  constructor(game, script) {
    this.game = game;
    this.script = script; // { bid, rob, play } => 决策
    this.asks = [];       // 记录每一次询问
    this.pending = null;
    this.settled = 0;
    this.turns = 0;
  }

  ask(kind) {
    // 只能在 BID/ROB 询问叫抢，在 PLAY 询问出牌 —— 三者互斥
    const g = this.game;
    ok(
      (kind === 'bid' && g.phase === PHASE.BID)
      || (kind === 'rob' && g.phase === PHASE.ROB)
      || (kind === 'play' && g.phase === PHASE.PLAY),
      `询问 ${kind} 时阶段应当匹配，实际 ${g.phase}`,
    );
    this.asks.push({ kind, phase: g.phase });
    this.pending = { kind, settled: false };
  }

  settle() {
    if (!this.pending || this.pending.settled) return false;
    this.pending.settled = true;
    this.pending = null;
    this.settled += 1;
    return true;
  }

  /** 人类玩家动作；重复/过期调用一律无效 */
  act(kind, value) {
    if (!this.pending || this.pending.kind !== kind || this.pending.settled) return false;
    const g = this.game;
    if (kind === 'bid') { if (g.currentBidder !== 0) return false; g.applyBid(0, value); }
    else if (kind === 'rob') { if (g.seatToAsk !== 0) return false; g.applyRob(0, value); }
    else {
      if (!g.canPlayAt(0)) return false;
      const cards = value === null ? [] : value;
      const res = g.applyPlay(0, cards);
      if (!res.ok) return false;
    }
    this.settle();
    return true;
  }

  run() {
    const g = this.game;
    while (g.phase !== PHASE.OVER && this.turns < 3000) {
      this.turns += 1;
      if (g.phase === PHASE.BID) {
        const seat = g.currentBidder;
        if (seat === 0) {
          this.ask('bid');
          this.script.onBid(this, g);
        } else g.applyBid(seat, g.decideBid(seat, false));
      } else if (g.phase === PHASE.ROB) {
        const seat = g.seatToAsk;
        if (seat === 0) {
          this.ask('rob');
          this.script.onRob(this, g);
        } else g.applyRob(seat, g.decideBid(seat, true));
      } else if (g.phase === PHASE.PLAY) {
        const seat = g.turnSeat;
        if (seat === 0) {
          this.ask('play');
          const plays = findPlays(g.hands[0], g.lastPlay ? g.lastPlay.play : null);
          if (!plays.length) this.act('play', null);
          else this.act('play', plays[0].cards);
        } else {
          const p = g.decidePlay(seat);
          g.applyPlay(seat, p ? p.cards : []);
        }
      } else break;
    }
    return this.turns;
  }
}

const room = ROOMS[1];

/* ---------------- 场景 1：正常应答 ---------------- */
console.log('── 场景 1：正常应答');
{
  let games = 0;
  for (let i = 0; i < 60; i += 1) {
    const game = new Game({ room, personas: [null, PERSONAS[i % PERSONAS.length], PERSONAS[(i + 5) % PERSONAS.length]], names: ['你', '右', '左'], avatars: ['a', 'b', 'c'], beans: [100000, 100000, 100000] });
    const d = new Driver(game, {
      onBid: (drv) => drv.act('bid', true),
      onRob: (drv) => drv.act('rob', Math.random() < 0.5),
    });
    d.run();
    ok(game.phase === PHASE.OVER, `第 ${i + 1} 局应当结束，实际 ${game.phase}`);
    ok(d.asks.length === d.settled, `询问数 ${d.asks.length} 应当等于应答数 ${d.settled}`);
    games += 1;
  }
  console.log(`  完成 ${games} 局，询问/应答一一对应`);
}

/* ---------------- 场景 2：重复点击（同一次询问点两次） ---------------- */
console.log('── 场景 2：重复点击');
{
  let dupBlocked = 0;
  for (let i = 0; i < 60; i += 1) {
    const game = new Game({ room, personas: [null, PERSONAS[i % PERSONAS.length], PERSONAS[(i + 9) % PERSONAS.length]], names: ['你', '右', '左'], avatars: ['a', 'b', 'c'], beans: [100000, 100000, 100000] });
    const d = new Driver(game, {
      onBid: (drv) => { drv.act('bid', true); if (!drv.act('bid', true)) dupBlocked += 1; if (!drv.act('bid', false)) dupBlocked += 1; },
      onRob: (drv) => { drv.act('rob', true); if (!drv.act('rob', true)) dupBlocked += 1; },
    });
    d.run();
    ok(game.phase === PHASE.OVER, `重复点击后第 ${i + 1} 局仍应正常结束，实际 ${game.phase}`);
    ok(d.asks.length === d.settled, '重复点击不应产生多余的挂起询问');
  }
  console.log(`  拦截重复点击 ${dupBlocked} 次，对局全部正常结束`);
}

/* ---------------- 场景 3：点击与超时同时发生 ---------------- */
console.log('── 场景 3：点击与超时同时发生');
{
  for (let i = 0; i < 60; i += 1) {
    const game = new Game({ room, personas: [null, PERSONAS[i % PERSONAS.length], PERSONAS[(i + 3) % PERSONAS.length]], names: ['你', '右', '左'], avatars: ['a', 'b', 'c'], beans: [100000, 100000, 100000] });
    const d = new Driver(game, {
      // 先按超时逻辑自动作答，紧接着模拟“玩家也点了一下”
      onBid: (drv) => { if (Math.random() < 0.5) drv.act('bid', false); else { drv.act('bid', false); drv.act('bid', true); } },
      onRob: (drv) => { if (Math.random() < 0.5) drv.act('rob', false); else { drv.act('rob', false); drv.act('rob', true); } },
    });
    d.run();
    ok(game.phase === PHASE.OVER, `第 ${i + 1} 局应当结束`);
    const robTotal = game.result ? game.result.robs : 0;
    ok(robTotal <= 3, `抢地主次数不得超过 3，实际 ${robTotal}`);
  }
  console.log('  超时与点击竞争后，倍数与流程均正常');
}

/* ---------------- 场景 4：询问时阶段绝不错位 ---------------- */
console.log('── 场景 4：询问阶段互斥');
{
  let mismatched = 0;
  for (let i = 0; i < 80; i += 1) {
    const game = new Game({ room, personas: [null, PERSONAS[i % PERSONAS.length], PERSONAS[(i + 11) % PERSONAS.length]], names: ['你', '右', '左'], avatars: ['a', 'b', 'c'], beans: [100000, 100000, 100000] });
    const d = new Driver(game, {
      onBid: (drv) => drv.act('bid', true),
      onRob: (drv) => drv.act('rob', true),
    });
    d.run();
    for (const a of d.asks) {
      if (a.kind === 'bid' && a.phase !== PHASE.BID) mismatched += 1;
      if (a.kind === 'rob' && a.phase !== PHASE.ROB) mismatched += 1;
      if (a.kind === 'play' && a.phase !== PHASE.PLAY) mismatched += 1;
    }
  }
  ok(mismatched === 0, `询问与阶段错位次数应为 0，实际 ${mismatched}`);
  console.log(`  80 局共检查询问阶段，错位 ${mismatched} 次`);
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '流程回归测试全部通过'}`);
process.exit(fail ? 1 : 0);
