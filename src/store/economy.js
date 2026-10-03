/**
 * 经济系统（PRD §2.2 / §2.3 / §2.4.4 / §5-Q13~Q16）
 * 豆子、签到（本地日界）、救济金、商城（模拟支付）
 */
import { ECON, ROOMS } from '../config.js';
import { recordPayment } from './activity.js';

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  return Math.round((db - da) / 86400000);
}

export class Economy {
  constructor(save, persist) {
    this.save = save;
    this.persist = persist || (() => {});
  }

  get beans() { return this.save.beans; }

  addBeans(n, reason = '') {
    this.save.beans = Math.max(0, Math.round(this.save.beans + n));
    this.persist(reason);
    return this.save.beans;
  }

  /** 入场校验（PRD Q3） */
  canEnter(room) {
    if (this.save.beans < room.minBeans) {
      return { ok: false, reason: `身家不足，${room.name}需要 💰${room.minBeans.toLocaleString()}` };
    }
    if (this.save.beans < room.base * 2) {
      return { ok: false, reason: `至少需要 💰${room.base * 2} 才能承担一局底分` };
    }
    return { ok: true };
  }

  lowestRoom() {
    return ROOMS.find((r) => this.canEnter(r).ok) || null;
  }

  /* ---------------- 签到 ---------------- */
  signInState() {
    const today = todayStr();
    const { lastDate, streak } = this.save.signIn;
    const signedToday = lastDate === today;
    let nextStreak = streak;
    if (signedToday) {
      nextStreak = streak;
    } else if (lastDate && daysBetween(lastDate, today) === 1) {
      nextStreak = streak + 1;
    } else {
      nextStreak = 1; // 断签重置（PRD Q14）
    }
    const dayIndex = ((nextStreak - 1) % 7) + 1;
    return {
      signedToday,
      streak: nextStreak,
      dayIndex,
      reward: ECON.signInRewards[dayIndex - 1],
      rewards: ECON.signInRewards,
      today,
    };
  }

  signIn() {
    const st = this.signInState();
    if (st.signedToday) return { ok: false, error: '今天已经签过啦，明天再来～' };
    this.save.signIn = { lastDate: st.today, streak: st.streak };
    this.addBeans(st.reward, 'signIn');
    return { ok: true, reward: st.reward, dayIndex: st.dayIndex, streak: st.streak };
  }

  /* ---------------- 救济金 ---------------- */
  reliefState() {
    const today = todayStr();
    const claimedToday = this.save.relief.lastDate === today;
    const eligible = this.save.beans < ECON.reliefThreshold;
    return { claimedToday, eligible, amount: ECON.reliefBeans, today };
  }

  claimRelief() {
    const st = this.reliefState();
    if (st.claimedToday) return { ok: false, error: '今天的救济金已经领过了' };
    if (!st.eligible) return { ok: false, error: `身家高于 💰${ECON.reliefThreshold}，暂时不需要救济` };
    this.save.relief = { lastDate: st.today };
    this.addBeans(st.amount, 'relief');
    return { ok: true, amount: st.amount };
  }

  /* ---------------- 商城（模拟支付，PRD Q13） ---------------- */
  /**
   * 买一袋开心豆：模拟支付（不接真实支付），同时记一笔到钱包
   * —— 累计充值礼包看的就是 `save.wallet.totalYuan`
   */
  purchase(item) {
    const order = recordPayment(this.save, {
      price: item.price, label: item.name, kind: 'beans',
    });
    this.addBeans(item.beans, 'purchase');
    void item;
    return { ok: true, order };
  }

  /* ---------------- 结算 ---------------- */
  applySettlement(result, room) {
    this.save.beans = Math.max(0, Math.round(this.save.beans + result.deltas[0]));
    this.save.stats.hands += 1;
    const humanWin = (result.landlordSeat === 0) === result.landlordWin;
    if (humanWin) this.save.stats.wins += 1;
    else this.save.stats.losses += 1;
    this.save.stats.maxMultiplier = Math.max(this.save.stats.maxMultiplier, result.multiplier);
    this.save.stats.maxWin = Math.max(this.save.stats.maxWin, result.deltas[0]);
    this.persist('settle');
    void room;
    return this.save.beans;
  }

  winRate() {
    const { hands, wins } = this.save.stats;
    if (!hands) return 0;
    return Math.round((wins / hands) * 100);
  }
}
