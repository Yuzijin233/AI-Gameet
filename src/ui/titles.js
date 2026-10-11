/**
 * 称号徽章渲染
 */
import { equippedTitle } from '../store/titles.js';
import { titleGradient } from '../data/titles.js';

import { badgeContent } from './titleBadge.js';
export { titleBadgeHTML } from './titleBadge.js';

export function renderTitleBadge(el, title) {
  if (!el) return;
  const t = title === undefined ? null : title;
  if (!t) {
    el.hidden = true;
    el.textContent = '';
    el.style.background = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = badgeContent(t);
  el.style.background = titleGradient(t);
  el.title = `${t.name} · ${t.desc || ''}`;
}

/** 从存档里取当前佩戴的称号并渲染 */
export function renderEquippedBadge(el, save) {
  renderTitleBadge(el, equippedTitle(save));
}
