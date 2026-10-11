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
import { signupAvatarSrc } from '../data/avatar.js';
import { readAvatarFile, clearAvatarUpload } from './avatarUpload.js';
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
  let busy = false; // 正在读图 / 压缩

  function render() {
    /**
     * ★ 用户拍板：注册这一屏要**显示头像**，点一下就能上传替换 ——
     *   没上传时用 `image/001.png`（见 data/avatar.js 的 signupAvatarSrc）。
     */
    const avatarSrc = signupAvatarSrc(app.save);
    const uploaded = !!(app.save && app.save.avatarUpload);
    box.innerHTML = `
      <h1 class="setup-title">先认识一下 👋</h1>
      <p class="setup-sub">告诉牌桌上的人你是谁 —— 之后随时能在「我的形象」里改。</p>

      <div class="setup-avatar-row">
        <button class="setup-avatar" id="setup-avatar" type="button" title="点一下换一张头像">
          <img src="${avatarSrc}" alt="我的头像" />
          <span class="setup-avatar-cam" aria-hidden="true">📷</span>
        </button>
        <div class="setup-avatar-meta">
          <b>头像</b>
          <small>点左侧头像即可从本机上传一张照片（任意尺寸，自动裁成圆形）</small>
          ${uploaded ? '<button class="mini-btn" id="setup-avatar-reset" type="button">恢复默认头像</button>' : ''}
        </div>
      </div>
      <input type="file" id="setup-file" accept="image/*" hidden />

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

    /* 头像：点一下选图 → 居中裁剪成方形 → 存进存档 */
    const file = box.querySelector('#setup-file');
    box.querySelector('#setup-avatar').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f || busy) return;
      busy = true;
      const res = await readAvatarFile(f);
      busy = false;
      if (!res.ok) return toast(res.error, 'bad');
      app.save.avatarUpload = res.dataUrl;
      app.persist('avatarUpload');
      audio.play('select');
      toast('头像已更新');
      render();
    });
    box.querySelector('#setup-avatar-reset')?.addEventListener('click', () => {
      clearAvatarUpload(app.save);
      app.persist('avatarUpload');
      audio.play('select');
      toast('已恢复默认头像');
      render();
    });

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
