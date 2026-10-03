/**
 * 卡牌渲染（PRD §7.8）
 * 贴图优先；贴图缺失或是空图时自动回退矢量绘制，绝不裂图
 */
import { cardTexture, rankLabel, SUIT_GLYPH, isRed, isJoker } from '../core/cards.js';
import { ASSETS } from '../../assets/manifest.js';

const texCache = new Map();

/** 探测贴图是否真的有内容（空图 → 回退矢量） */
export function probeTexture(url) {
  if (!texCache.has(url)) {
    texCache.set(url, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 8;
          c.height = 12;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 8, 12);
          const data = ctx.getImageData(0, 0, 8, 12).data;
          let opaque = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 16) opaque += 1;
          resolve(opaque > 6);
        } catch {
          resolve(true);
        }
      };
      img.onerror = () => resolve(false);
      img.src = url;
    }));
  }
  return texCache.get(url);
}

let texEnabled = true;
export function setTextureEnabled(v) { texEnabled = !!v; }

function applyTexture(el, url) {
  if (!texEnabled) return;
  probeTexture(url).then((ok) => {
    if (!ok) { el.dataset.tex = '0'; return; }
    const tex = el.querySelector('.card-tex');
    if (tex) tex.style.backgroundImage = `url("${url}")`;
    el.dataset.tex = '1';
  });
}

export function createCard(card, opts = {}) {
  const { size = 'normal', selected = false, onToggle } = opts;
  const el = document.createElement('div');
  el.className = 'card';
  if (size && size !== 'normal') el.classList.add(size);
  if (isRed(card)) el.classList.add('red');
  if (isJoker(card)) el.classList.add('joker');
  if (selected) el.classList.add('is-selected');
  el.dataset.id = String(card.id);
  el.dataset.tex = '0';

  const tex = document.createElement('div');
  tex.className = 'card-tex';
  const vec = document.createElement('div');
  vec.className = 'card-vec';
  const joker = isJoker(card);

  if (joker) {
    // 大小王：直接用 🤡（大王常规彩色，小王黑白）
    el.dataset.tex = '0';
    el.classList.add(card.rank === 17 ? 'joker-big' : 'joker-small');
    for (const pos of ['tl', 'br']) {
      const corner = document.createElement('span');
      corner.className = `corner ${pos} joker-corner`;
      corner.textContent = '🤡';
      vec.append(corner);
    }
    const center = document.createElement('span');
    center.className = 'joker-center';
    center.textContent = '🤡';
    vec.append(center);
  } else {
    // 标准扑克版式：左上角 + 右下角（镜像），中间留白
    for (const pos of ['tl', 'br']) {
      const corner = document.createElement('span');
      corner.className = `corner ${pos}`;
      const b = document.createElement('b');
      b.textContent = rankLabel(card.rank);
      const i = document.createElement('i');
      i.textContent = SUIT_GLYPH[card.suit];
      corner.append(b, i);
      vec.append(corner);
    }
  }
  el.append(tex, vec);

  if (onToggle) {
    el.addEventListener('click', () => onToggle(card, el));
  }
  if (!joker) applyTexture(el, cardTexture(card));
  return el;
}

export function createBack(size = 'mini', backId = 'back_01') {
  const el = document.createElement('div');
  el.className = 'card card-back';
  if (size && size !== 'normal') el.classList.add(size);
  el.dataset.tex = '1';
  const tex = document.createElement('div');
  tex.className = 'card-tex';
  tex.style.backgroundImage = `url("${ASSETS.cardBack(backId)}")`;
  el.append(tex);
  return el;
}

export function renderPlayCards(container, play, size = 'mini') {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'play-cards';
  for (const card of play.cards) wrap.append(createCard(card, { size }));
  container.append(wrap);
}
