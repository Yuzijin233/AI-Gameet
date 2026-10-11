/** Shared title markup, separate from the live equipment renderer. */
import { titleGradient } from '../data/titles.js';

const escapeTitle = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function badgeContent(title) {
  return `<svg class="title-emblem" viewBox="0 0 64 64" aria-hidden="true"><use href="assets/ui/item-art.svg#art-${escapeTitle(title.id)}" /></svg><span class="title-name">${escapeTitle(title.name)}</span>`;
}
export function titleBadgeHTML(title, large = false) {
  if (!title) return '';
  return `<span class="title-badge${large ? ' large' : ''}" style="background:${titleGradient(title)}" title="${escapeTitle(title.desc)}">${badgeContent(title)}</span>`;
}
