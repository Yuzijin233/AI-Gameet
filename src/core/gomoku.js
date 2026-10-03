/**
 * 五子棋规则 + 本地引擎（零依赖、可测）
 *
 * 规则：15×15、**无禁手**、横竖斜任意方向连成 5 子（或更多）即胜；棋盘下满为平局。
 * 落子由这里算 —— **大模型只负责说话**（和斗地主"引擎保证合法"一个思路）。
 *
 * 引擎分五档（新手 / 入门 / 熟练 / 精通 / 大师，见 data/gomokuLevels.js）：
 *   新手 ：只会占自己附近的空位 + 能赢就赢，**不会挡**（用户拍板的口径）
 *   入门 ：会赢、会挡"马上成五"和冲四，看不出活三
 *   熟练 ：会挡活三（有 25% 会漏），其余按启发式挑点
 *   精通 ：活三必挡，按"我的收益 + 对手收益"综合挑点，偏好一子双威胁
 *   大师 ：在精通基础上再看一步（我下完他最好的应手有多大）
 * 所有随机都走传入的 `rnd`，测试可以完全确定。
 *
 * 棋盘坐标：`board[y][x]`，y 是行、x 是列（0 起）。
 */

export const BOARD_SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1; // 先手
export const WHITE = 2; // 后手
export const other = (who) => (who === BLACK ? WHITE : BLACK);
export const inBoard = (board, x, y) => y >= 0 && y < board.length && x >= 0 && x < board.length;

export function createBoard(size = BOARD_SIZE) {
  return Array.from({ length: size }, () => new Array(size).fill(EMPTY));
}

export const cloneBoard = (board) => board.map((row) => row.slice());

/** 落子（不合法返回 false；这里不改"谁赢"的判断） */
export function place(board, x, y, who) {
  if (!inBoard(board, x, y) || board[y][x] !== EMPTY) return false;
  board[y][x] = who;
  return true;
}

/** 有没有棋子（空盘时第一手要下天元） */
export function isEmptyBoard(board) {
  return !board.some((row) => row.some((v) => v !== EMPTY));
}

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/**
 * (x,y) 这一手是否连成五子
 * @returns {{who:number, line:{x:number,y:number}[]}|null}
 */
export function checkWinAt(board, x, y) {
  if (!inBoard(board, x, y)) return null;
  const who = board[y][x];
  if (!who) return null;
  for (const [dx, dy] of DIRS) {
    const line = [{ x, y }];
    for (const sign of [1, -1]) {
      for (let k = 1; k < board.length; k += 1) {
        const nx = x + dx * k * sign;
        const ny = y + dy * k * sign;
        if (!inBoard(board, nx, ny) || board[ny][nx] !== who) break;
        line.push({ x: nx, y: ny });
      }
    }
    if (line.length >= 5) {
      line.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      return { who, line };
    }
  }
  return null;
}

/** 全盘找赢家（复盘 / 兜底用） */
export function findWinner(board) {
  for (let y = 0; y < board.length; y += 1) {
    for (let x = 0; x < board.length; x += 1) {
      if (!board[y][x]) continue;
      const win = checkWinAt(board, x, y);
      if (win) return win;
    }
  }
  return null;
}

export const isFull = (board) => !board.some((row) => row.some((v) => v === EMPTY));

/** 已经下了几手 */
export const moveCount = (board) => board.reduce((n, row) => n + row.filter((v) => v !== EMPTY).length, 0);

/**
 * 手数的"阶段"（**不报具体手数** —— 用户拍板：谁记得住）
 * 场上形势与复盘都只用这个分档，全项目一个口径。
 *   opening  开局：双方合计 ≤ 6 手
 *   mid      中盘：≤ 30 手
 *   late     后半盘：≤ 80 手
 *   endgame  残局：再多就是快下满了
 */
export function movePhase(moves) {
  const n = Number(moves) || 0;
  if (n <= 6) return 'opening';
  if (n <= 30) return 'mid';
  if (n <= 80) return 'late';
  return 'endgame';
}

/** 阶段 → 场上形势里给 AI 看的说法（只说阶段，不给数字） */
export const MOVE_PHASE_TEXT = {
  opening: '刚开局，没下几手',
  mid: '已经下到中盘',
  late: '进入后半盘，下了挺久',
  endgame: '已经是残局，棋盘快满了',
};

/* ===================================================================== */
/*                            打分（启发式）                              */
/* ===================================================================== */
/**
 * 把以 (x,y) 为中心、某方向上的 9 格（-4..+4）编成字符串：
 *   '1' = 自己的子，'0' = 空，'2' = 对手的子或棋盘外（都算"堵住"）
 * 然后按经典棋型给分（取该方向上最高的那个棋型）。
 */
const PATTERNS = [
  { re: /11111/, score: 10000000, kind: 'five' },
  { re: /011110/, score: 1000000, kind: 'openFour' }, // 活四
  { re: /211110|011112|11011|10111|11101/, score: 100000, kind: 'four' }, // 冲四 / 跳四
  { re: /011100|001110|011010|010110/, score: 12000, kind: 'openThree' }, // 活三（含跳活三）
  { re: /211100|001112|211010|010112|210110|011012|10011|11001|10101/, score: 1200, kind: 'three' }, // 眠三
  { re: /001100|011000|000110|010100|001010/, score: 300, kind: 'openTwo' }, // 活二
  { re: /211000|000112|010010|10010/, score: 60, kind: 'two' },
];

/** 某方向上的棋型分（假设 (x,y) 已经落了 who 的子） */
function directionScore(board, x, y, dx, dy, who) {
  const opp = other(who);
  let s = '';
  for (let k = -4; k <= 4; k += 1) {
    const nx = x + dx * k;
    const ny = y + dy * k;
    if (!inBoard(board, nx, ny)) { s += '2'; continue; }
    const v = board[ny][nx];
    s += v === who ? '1' : (v === opp ? '2' : '0');
  }
  let best = 0;
  let kind = '';
  for (const p of PATTERNS) {
    if (p.re.test(s) && p.score > best) { best = p.score; kind = p.kind; }
  }
  return { score: best, kind, text: s };
}

export const SCORES = {
  five: 10000000, openFour: 1000000, four: 100000, openThree: 12000, three: 1200,
};

/**
 * 在 (x,y) 落 who 这一子的价值（四个方向里最高的那个棋型 + 次要方向的加成）
 * 一子双威胁（两个方向都是活三以上）会有额外加成 —— 这是五子棋的关键。
 */
export function scorePoint(board, x, y, who) {
  if (!inBoard(board, x, y) || board[y][x] !== EMPTY) return { score: -1, kinds: [] };
  board[y][x] = who;
  const parts = DIRS.map(([dx, dy]) => directionScore(board, x, y, dx, dy, who));
  board[y][x] = EMPTY;
  parts.sort((a, b) => b.score - a.score);
  const top = parts[0] ? parts[0].score : 0;
  const second = parts[1] ? parts[1].score : 0;
  let score = top;
  // 双活三 / 活三+冲四 这种"一子两威胁"，比单纯一个大棋型更值钱
  if (top >= SCORES.openThree && second >= SCORES.openThree) score += top * 1.5;
  else if (top >= SCORES.four && second >= SCORES.openThree) score += top * 1.2;
  else if (second >= SCORES.openThree) score += second * 0.6;
  return { score, kinds: parts.map((p) => p.kind).filter(Boolean) };
}

/** 候选点：已有棋子周围 2 格内的空位（空盘给天元） */
export function candidates(board, radius = 2) {
  if (isEmptyBoard(board)) {
    const c = Math.floor(board.length / 2);
    return [{ x: c, y: c }];
  }
  const n = board.length;
  const out = [];
  const seen = new Set();
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (board[y][x] === EMPTY) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inBoard(board, nx, ny) || board[ny][nx] !== EMPTY) continue;
          const key = ny * n + nx;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ x: nx, y: ny });
        }
      }
    }
  }
  return out;
}

/**
 * 算出这一步（用户/AI 落子前的判断用）
 *
 * 五档的区别（这就是"难度"的全部实现）：
 *   新手      会赢、会挡"马上连成五"、会做活四/活三，**但是只看自己的进攻** ——
 *             对手的活三/冲四它不管（所以还是明显最弱）。**不再整盘随机下**（用户拍板）
 *   入门      会挡"成五"和"活四级威胁"，但**有 30% 会漏**；进攻照做
 *   熟练      同上，漏的概率降到 15%；活三以上会主动做
 *   精通      不漏、会做活三、会算"我下完他最好的应手"（半步预判）
 *   大师      预判权重更高（相当于多算一层），偏好一子双威胁
 *
 * 用户的原始反馈："最弱的敌人档次太弱了，完全是乱下" ——
 * 以前 rank 0 走到最后是 `randOf(pool)`（候选点里随便挑一个），
 * 现在最低档也**按分数挑前几名**，只是防守几乎不看、漏招概率最高。
 *
 * @param {number[][]} board
 * @param {number} who 轮到谁
 * @param {string} level 新手/入门/熟练/精通/大师
 * @param {{rnd?:Function, radius?:number}} [opts]
 * @returns {{x:number, y:number, level:string, reason:string}|null}
 */
export function pickMove(board, who, level = '熟练', { rnd = Math.random, radius = 2 } = {}) {
  const list = candidates(board, radius);
  if (!list.length) return null;
  const opp = other(who);
  const rank = Math.max(0, ['新手', '入门', '熟练', '精通', '大师'].indexOf(level));

  /**
   * 每一档的参数（改难度就改这张表）：
   *   defWeight ：对手收益算进总分的权重（越小越不防守）
   *   slip      ：漏掉对手威胁的概率
   *   topN      ：最终从"分数最高的前 N 个点"里随机挑（1 = 只挑最好的）
   *   lookahead ：半步预判的权重（0 = 不预判）
   *   defFloor  ：只把"对手威胁分 ≥ 这个值"的点当回事（新手只看冲四级以上，看不出活三）
   *   onlyFive  ：只看对手"马上连成五"，其余威胁一律不管
   */
  const TIERS = [
    // 新手：会赢、会挡成五、会做活四/活三、**也看得见冲四**（用户："好歹别乱下"），
    //       但看不出活三（12000）这种"还差一步"的威胁 —— 所以仍然明显最弱
    { name: '新手', defWeight: 0.9, slip: 0.3, topN: 3, lookahead: 0, defFloor: SCORES.four },
    { name: '入门', defWeight: 0.85, slip: 0.3, topN: 2, lookahead: 0, defFloor: 0 },
    { name: '熟练', defWeight: 0.9, slip: 0.15, topN: 1, lookahead: 0, defFloor: 0 },
    { name: '精通', defWeight: 1.0, slip: 0, topN: 1, lookahead: 0.5, defFloor: 0 },
    { name: '大师', defWeight: 1.0, slip: 0, topN: 1, lookahead: 0.85, defFloor: 0 },
  ];
  const tier = TIERS[rank];
  const slip = tier.slip;

  const scored = list.map((c) => {
    const mine = scorePoint(board, c.x, c.y, who).score;
    const theirsRaw = scorePoint(board, c.x, c.y, opp).score;
    // 新手只把"冲四以上"当威胁（活三看不见）—— 这是它最弱的地方，刻意保留
    const theirs = theirsRaw >= tier.defFloor ? theirsRaw : 0;
    return { ...c, mine, theirs, total: mine + theirs * tier.defWeight };
  });
  const pick = (c, reason) => ({ x: c.x, y: c.y, level, reason });
  const randOf = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const bestOf = (arr, w = (c) => c.total) => arr.slice().sort((a, b) => (w(b) - w(a)) || (b.mine - a.mine))[0];
  /** 从"最好的前 N 个"里随机挑一个（N=1 就是挑最好的） */
  const pickTop = (arr, n, reason) => {
    const sorted = arr.slice().sort((a, b) => (b.total - a.total) || (b.mine - a.mine));
    const pool = sorted.slice(0, Math.max(1, Math.min(n, sorted.length)));
    return pick(randOf(pool), reason);
  };

  // ① 能赢就赢（所有难度都会）
  const winNow = scored.filter((c) => c.mine >= SCORES.five);
  if (winNow.length) return pick(randOf(winNow), 'five');

  /**
   * "看漏"的实现：漏掉的时候要**真的当那些点不存在**，
   * 否则下面的启发式分数还是会被对手的巨大威胁拉过去，等于没漏。
   */
  const key = (c) => c.y * board.length + c.x;
  const ignored = new Set();
  const rest = () => scored.filter((c) => !ignored.has(key(c)));

  // ② 对手马上成五 → 挡（**所有难度都会**，包括新手：这是"不要乱下"的底线）
  const mustBlock = scored.filter((c) => c.theirs >= SCORES.five);
  if (mustBlock.length) {
    const skip = slip > 0 && rnd() < slip * 0.5; // 连"挡成五"都偶尔漏（新手/入门）
    if (!skip) return pick(bestOf(mustBlock), 'block-five');
    mustBlock.forEach((c) => ignored.add(key(c)));
  }

  // ③ 自己能做活四 → 直接做（所有难度都会：进攻是本能）
  const makeFour = scored.filter((c) => c.mine >= SCORES.openFour);
  if (makeFour.length) return pick(randOf(makeFour), 'make-open-four');

  // ④ 对手有活四级威胁（活四 / 活三）→ 挡（新手只看冲四，会漏活三）
  if (!tier.defFloor) {
    const blockFour = scored.filter((c) => c.theirs >= SCORES.openFour);
    if (blockFour.length) {
      const skip = slip > 0 && rnd() < slip;
      if (!skip) return pick(bestOf(blockFour), 'block-four');
      blockFour.forEach((c) => ignored.add(key(c))); // 漏了：这些点当没看见
    }
  }

  const pool = rest().length ? rest() : scored;

  // ⑤ 自己能做活三（含跳活三）→ 主动进攻比被动挡好（所有难度都会）
  const liveThree = pool.filter((c) => c.mine >= SCORES.openThree);
  if (liveThree.length) return pickTop(liveThree, tier.topN, 'make-open-three');

  // ⑥ 按综合分挑：**从最好的前 N 个里随机**（N=1 就是最优解）
  //    —— 以前新手这一步是全盘随机（'novice-random'），用户反馈"完全是乱下"，已改掉
  if (rank >= 3) {
    // 精通 / 大师：再看一步 —— 我下完，他最好的应手有多大
    const sorted = pool.slice().sort((a, b) => (b.total - a.total) || (b.mine - a.mine));
    const top = sorted.slice(0, 8);
    let best = null;
    for (const c of top) {
      board[c.y][c.x] = who;
      let replyBest = 0;
      for (const r of candidates(board, 2)) {
        const s = scorePoint(board, r.x, r.y, opp).score;
        if (s > replyBest) replyBest = s;
      }
      board[c.y][c.x] = EMPTY;
      const value = c.mine * 1.0 + c.theirs * 0.9 - replyBest * tier.lookahead;
      if (!best || value > best.value) best = { c, value };
    }
    if (best) return pick(best.c, 'lookahead');
  }
  return pickTop(pool, tier.topN, rank === 0 ? 'novice-heuristic' : 'heuristic');
}

/**
 * 一句话说明这一步（气泡台词里可以提，也可以不提）
 * 只暴露"进攻/防守"这种模糊说法，**不会泄露难度**。
 */
export function describeMove(board, move, who) {
  if (!move) return '';
  const mine = scorePoint(board, move.x, move.y, who).score;
  const theirs = scorePoint(board, move.x, move.y, other(who)).score;
  if (mine >= SCORES.openFour) return 'attack';
  if (theirs >= SCORES.openFour) return 'block';
  return mine >= theirs ? 'attack' : 'block';
}

/* ===================================================================== */
/*                     场上形势（给 AI 说话当背景）                        */
/* ===================================================================== */
/**
 * 数一数某一方现在**有多少个点能做出威胁**（活三 / 冲四 / 活四）
 * 这只是"客观局面"，不含任何意图说明 —— 用户要求"告诉 AI 形势，但别透露真实意图"。
 */
export function countThreats(board, who) {
  const out = { five: 0, openFour: 0, four: 0, openThree: 0, openTwo: 0 };
  for (const c of candidates(board, 2)) {
    const s = scorePoint(board, c.x, c.y, who).score;
    if (s >= SCORES.five) { out.five += 1; continue; }
    if (s >= SCORES.openFour) { out.openFour += 1; continue; }
    if (s >= SCORES.four) { out.four += 1; continue; }
    if (s >= SCORES.openThree) { out.openThree += 1; continue; }
    if (s >= SCORES.openTwo) out.openTwo += 1;
  }
  return out;
}

/**
 * 把"威胁点"数说成人话（0 的不提）
 * 注意口径：数的是**"某个空点能让这一方做出什么"**，所以措辞是"能做出…"，
 * 不是"盘面上已经有…"（活三会体现在"能做出活四"上，这是对的）。
 */
function threatText(t) {
  const parts = [];
  if (t.five) parts.push(`${t.five} 处能直接连成五`);
  if (t.openFour) parts.push(`${t.openFour} 处能做出活四`);
  if (t.four) parts.push(`${t.four} 处能做出冲四`);
  if (t.openThree) parts.push(`${t.openThree} 处能做出活三`);
  if (t.openTwo) parts.push(`${t.openTwo} 处能做出活二`);
  return parts.length ? parts.join('、') : '暂时没有明显的好点';
}

/**
 * 场上形势（给 AI 说话用）：只给**客观事实** ——
 * 下了多少手、双方各有多少个能成威胁的点、上一手落在哪儿、轮到谁。
 *
 * ★ 故意**不说**"这手是在拦你/在做四"这种意图（用户要求：形势可以给，意图不能露）。
 * @param {number[][]} board
 * @param {{playerColor:number, aiColor:number, moves?:number, last?:{x:number,y:number,who:number}}} p
 * @returns {string}
 */
export function boardSituation(board, {
  playerColor, aiColor, moves = moveCount(board), last = null,
}) {
  const mine = countThreats(board, aiColor);
  const his = countThreats(board, playerColor);
  const parts = [
    // ★ 不报具体手数（用户拍板：谁记得住），只说阶段
    `棋局阶段：${MOVE_PHASE_TEXT[movePhase(moves)]}`,
    `你（${aiColor === BLACK ? '执黑' : '执白'}）这边：${threatText(mine)}`,
    `玩家（${playerColor === BLACK ? '执黑' : '执白'}）那边：${threatText(his)}`,
  ];
  if (last) parts.push(`最后一手落在第 ${last.y + 1} 行第 ${last.x + 1} 列`);
  return parts.join('；');
}
