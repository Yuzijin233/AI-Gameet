/**
 * 排行榜面板（PRD §2.19）
 *
 * 玩家和 AI **用同一套行样式、同一个排序规则**：
 * 不给自己加"我"的标记、不加高亮、不换颜色 —— 想找自己就在前十名里找。
 * 只有进不了前十时才在下面单独列一行（那是"名次信息"，不是特权）。
 */
import { openDrawer, drawerShell } from './panels.js';
import { wealthRanking, medalOf, beanText, RANK_SIZE } from '../store/rank.js';
import { titleById, titleGradient } from '../data/titles.js';

/**
 * 一行（玩家与 AI 完全共用；`e.avatar` 在 store 里就已经是可直接用的 src）
 *
 * 称号徽章必须**自己带底色** —— `.title-badge` 的文字是深紫色（配浅色徽章用的），
 * 排行榜底色是深色，不画底色就成了"深色字压深色底"，等于看不见。
 */
function rowHtml(e) {
  const medal = medalOf(e.rank);
  const title = e.title ? (titleById(e.titleId) || { name: e.title }) : null;
  return `
    <div class="rank-row">
      <span class="rank-no" ${medal.tone ? `style="color:${medal.tone}"` : ''}>
        ${medal.emoji || e.rank}
      </span>
      <img class="rank-avatar" src="${e.avatar}" alt="" />
      <div class="rank-meta">
        <div class="rank-name">
          <span>${e.name}</span>
          ${title ? `<span class="title-badge" style="background:${titleGradient(title)}">${e.title}</span>` : ''}
        </div>
        <div class="rank-beans">💰 ${beanText(e.beans)}</div>
      </div>
    </div>`;
}

export function openRank(app) {
  const data = wealthRanking(app.save, RANK_SIZE);
  openDrawer(drawerShell('排行榜', `
    <div class="rank-hero">
      <div class="rank-hero-title">财富榜</div>
      <div class="rank-hero-sub">按身家（开心豆）排名 · 只排前 ${RANK_SIZE} 名</div>
    </div>
    <div class="rank-list">${data.top.map(rowHtml).join('')}</div>
    ${data.inTop ? `
      <div class="rank-foot">你在前 ${RANK_SIZE} 名之内，就在上面这张榜里。</div>
    ` : `
      <div class="rank-cut"><span>未 上 榜</span></div>
      <div class="rank-list is-out">${rowHtml(data.me)}</div>
      <div class="rank-foot">共 ${data.total} 位玩家在榜外比较，前 ${RANK_SIZE} 名才会上榜。</div>
    `}
  `));
}
