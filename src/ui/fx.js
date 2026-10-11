/**
 * 视觉特效与氛围（PRD §7.1 粒子 / §7.3 节奏 / §7.5 反馈）
 */
import { ASSETS } from '../../assets/manifest.js';

/* ------------------------------ 粒子背景 ------------------------------ */
export class Particles {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.running = false;
    this.speed = 1;
    this.images = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
    ['particle_01', 'particle_02'].forEach((k) => {
      const img = new Image();
      img.src = ASSETS.fx[k];
      img.onload = () => this.images.push(img);
    });
    this.seed();
  }

  seed() {
    const { width: w, height: h } = this.canvas;
    const count = Math.min(60, Math.max(28, Math.round((w * h) / 34000)));
    this.items = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + Math.random() * 2.4,
      vx: (Math.random() - 0.5) * 0.22,
      vy: 0.12 + Math.random() * 0.4,
      a: 0.15 + Math.random() * 0.45,
      sway: Math.random() * Math.PI * 2,
      kind: Math.random() < 0.5 ? 0 : 1,
    }));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seed();
  }

  setSpeed(speed) {
    this.speed = speed;
    if (speed <= 0) this.stop();
    else this.start();
  }

  start() {
    if (this.running || this.speed <= 0) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  draw() {
    const { ctx, canvas } = this;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    for (const p of this.items) {
      p.sway += 0.01 * this.speed;
      p.x += p.vx * this.speed + Math.sin(p.sway) * 0.12;
      p.y += p.vy * this.speed;
      if (p.y > h + 10) { p.y = -10; p.x = Math.random() * w; }
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      const img = this.images[p.kind];
      ctx.globalAlpha = p.a;
      /**
       * ★ 用户拍板：**浅色背景也要有泡泡**（以前浅色主题直接把这个 canvas 关了）。
       *   浅底上不能再用"淡粉/淡蓝实心点"（看不见），改成画**泡泡**：
       *   一点点填充 + 一圈描边（rose / blue），在灰白底上很轻但看得清。
       */
      const light = typeof document !== 'undefined'
        && document.documentElement
        && document.documentElement.dataset
        && document.documentElement.dataset.theme === 'light';
      if (img && !light) {
        const size = p.r * 9;
        ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
      } else if (light) {
        const r = p.r * 2.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.kind ? 'rgba(233, 84, 138, 0.10)' : 'rgba(95, 150, 210, 0.10)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = p.kind ? 'rgba(233, 84, 138, 0.35)' : 'rgba(95, 150, 210, 0.32)';
        ctx.stroke();
        // 高光一点，像泡泡
        ctx.beginPath();
        ctx.arc(p.x - r * 0.3, p.y - r * 0.32, Math.max(0.6, r * 0.18), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.fillStyle = p.kind ? '#ffd8ec' : '#cfefff';
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    void canvas;
  }
}

/* ------------------------------ Toast ------------------------------ */
export function toast(message, kind = '') {
  const layer = document.getElementById('toast-layer');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  layer.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    setTimeout(() => el.remove(), 320);
  }, 1900);
}

/* ------------------------------ 牌桌特效 ------------------------------ */
function effectLayer() { return document.getElementById('effect-layer'); }

export function fxBomb() {
  const layer = effectLayer();
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'fx-bomb';
  layer.append(el);
  setTimeout(() => el.remove(), 760);
  shakeTable();
}

export function fxBanner() {
  const layer = effectLayer();
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'fx-banner';
  layer.append(el);
  setTimeout(() => el.remove(), 960);
}

export function floatText(text, x = '50%', y = '42%') {
  const layer = effectLayer();
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = text;
  el.style.left = typeof x === 'number' ? `${x}px` : x;
  el.style.top = typeof y === 'number' ? `${y}px` : y;
  layer.append(el);
  setTimeout(() => el.remove(), 1150);
}

export function shakeTable() {
  const screen = document.getElementById('screen-table');
  if (!screen) return;
  screen.classList.remove('is-shaking');
  void screen.offsetWidth;
  screen.classList.add('is-shaking');
  setTimeout(() => screen.classList.remove('is-shaking'), 480);
}

export function handOverTip(text) {
  const el = document.getElementById('hand-over-tip');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 1100);
}
