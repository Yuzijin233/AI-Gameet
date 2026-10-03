/**
 * 首次进入 / 重置存档后的「设置性别 + 姓名」那一屏
 *
 * 规则（用户拍板）：
 *   · **默认性别男**；姓名默认**随机给一个**，可以自己改，也可以点「换一个」
 *   · 必须点「确认进入游戏」才进大厅 —— 不点就停在这一屏
 *
 * 性别不是摆设：会写进 AI 的提示词（见 data/player.js 的 playerGenderLine），
 * 免得 AI 对着男生喊"小姐姐"。之后在「我的形象」面板里也能改。
 */
import { GENDERS, DEFAULT_GENDER, PLAYER_NAME_MAX, cleanPlayerName } from '../data/player.js';
import { randomNickname } from '../data/nicknames.js';
import { toast } from './fx.js';
import { audio } from './audio.js';

/**
 * 渲染并绑定这一屏
 * @param {object} app
 * @param {{onDone?:Function, keepName?:string}} opts onDone() 在确认之后调用（负责切到大厅）
 */
export function openSetup(app, { onDone, keepName = '' } = {}) {
  const box = document.getElementById('setup-box');
  if (!box) return;
  let gender = DEFAULT_GENDER;
  let name = keepName || randomNickname();

  function render() {
    box.innerHTML = `
      <h1 class="setup-title">先认识一下 👋</h1>
      <p class="setup-sub">告诉牌桌上的人你是谁 —— 之后随时能在「我的形象」里改。</p>

      <div class="setup-label">性别<small>影响 AI 怎么称呼你</small></div>
      <div class="setup-genders" id="setup-genders">
        ${GENDERS.map((g) => `
          <button class="setup-gender ${g.id === gender ? 'is-active' : ''}" data-gender="${g.id}" type="button">
            <span class="sg-emoji">${g.emoji}</span>
            <b>${g.sign} ${g.label}</b>
            <i>${g.desc}</i>
          </button>`).join('')}
      </div>

      <div class="setup-label">姓名<small>最多 ${PLAYER_NAME_MAX} 个字</small></div>
      <div class="setup-name-row">
        <input type="text" id="setup-name" maxlength="${PLAYER_NAME_MAX}" value="${name}"
          placeholder="给自己起个名字" autocomplete="off" spellcheck="false" />
        <button class="mini-btn" id="setup-roll" type="button" title="随机换一个">🎲 换一个</button>
      </div>

      <button class="act-btn go big" id="setup-ok" type="button">确认进入游戏</button>
      <p class="setup-tip">这个名字会显示在牌桌、好友列表和排行榜上。</p>
    `;

    const input = box.querySelector('#setup-name');
    input.focus();
    input.select();

    box.querySelectorAll('[data-gender]').forEach((btn) => btn.addEventListener('click', () => {
      gender = btn.dataset.gender;
      audio.play('select');
      render();
    }));
    box.querySelector('#setup-roll').addEventListener('click', () => {
      name = randomNickname();
      audio.play('select');
      const cur = box.querySelector('#setup-name');
      cur.value = name;
      cur.focus();
      cur.select();
    });
    const commit = () => {
      const typed = cleanPlayerName(input.value);
      if (!typed) return toast('先给自己起个名字吧', 'bad');
      name = typed;
      input.value = typed;
      const res = app.completeSetup({ gender, name: typed });
      if (!res.ok) return toast(res.error, 'bad');
      toast(`欢迎，${typed}！`, 'gold');
      if (onDone) onDone();
    };
    box.querySelector('#setup-ok').addEventListener('click', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  }

  render();
  app.showScreen('screen-setup');
}
