/**
 * 语音输入（PRD §2.7 / Q10）
 * ---------------------------------------------------------------
 * 点一下麦克风 → 进入**持续收音模式**（像真人开着语音在聊天）：
 *   · 可以一直说、连着说几句；
 *   · 说完停一下（音量低于阈值并持续 VOICE.silenceMs，或一段时间没有新识别结果）
 *     → **直接把这一句发出去**（不落在输入框里）；
 *   · 发完**仍然保持收音**，接着说下一句；
 *   · 再点一下麦克风（或离开牌桌）才退出。
 * 浏览器不支持 / 麦克风被拒时静默降级，不影响文字输入。
 */
import { VOICE } from '../config.js';
import { mergeTranscript, shouldFlush, rmsOf, isVoiceLevel, barHeights } from './voiceParse.js';

class Voice {
  constructor() {
    const SR = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;
    this.supported = !!SR;
    this.live = false;
    this.rec = null;
    this.finalText = ''; // 本次会话里已确认的文本
    this.interimText = ''; // 正在识别中的临时文本
    this.buffer = ''; // 当前这一句（final + interim）
    this.lastVoiceAt = 0; // 最近一次"检测到有人在说话"
    this.ticker = null;
    this.audio = null; // 音量检测（可选）
    this.analyser = null;
    this.levels = null;
    this.volumeReady = false;
    this.restartTimer = null;
    this.hintEl = null; // 屏幕下方的"正在听…"提示（只闪一下）
    this.hintTimer = null;
    this.meterEl = null; // 当前挂着音量柱的麦克风按钮
    this.bars = [];
    this.level = 0; // 最近一次音量（0~1）
    this.history = []; // 最近几帧音量，用来画音量柱
    if (!SR) return;

    const rec = new SR();
    rec.lang = VOICE.lang;
    rec.interimResults = true; // 需要临时结果才能判断"还在说话"
    rec.maxAlternatives = 1;
    rec.continuous = true; // 持续收音
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        const t = (r[0] && r[0].transcript) || '';
        if (r.isFinal) this.finalText += t;
        else interim += t;
      }
      this.interimText = interim;
      const cur = mergeTranscript(this.finalText, this.interimText);
      if (cur) {
        // 只累积在缓冲里：说完（静音）才一次性发出去，不在输入框里显示草稿
        this.buffer = cur;
        this.lastVoiceAt = Date.now();
      }
    };
    rec.onerror = (e) => {
      const err = (e && e.error) || 'error';
      // no-speech / aborted 是持续收音时的正常现象，不当作错误
      if (err === 'no-speech' || err === 'aborted') return;
      if (this.onState) this.onState(this.live, err);
      if (err === 'not-allowed' || err === 'service-not-allowed') this.stop();
    };
    rec.onend = () => {
      // 连续模式也会被浏览器在长时间静音后掐断：先把这句发掉，再自动续上
      if (!this.live) return;
      this.flush('end');
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.live) return;
        try { this.rec.start(); } catch { /* 稍后由下一次 onend 再试 */ }
      }, VOICE.restartMs);
    };
    this.rec = rec;
  }

  /**
   * 开麦（进入持续收音模式）
   * @param {{onText?:Function, onState?:Function}} handlers
   *   onText(text, reason) 一句话说完了（reason: 'silence' | 'end' | 'stop'）
   *   onState(live, reason)
   */
  start({ onText, onState } = {}) {
    if (!this.supported || !this.rec) return false;
    if (this.live) return true;
    this.onText = onText;
    this.onState = onState;
    this.finalText = '';
    this.interimText = '';
    this.buffer = '';
    try {
      this.rec.start();
    } catch {
      if (onState) onState(false, 'fail');
      return false;
    }
    this.live = true;
    this.lastVoiceAt = Date.now();
    this.level = 0;
    this.history = [];
    this.ticker = setInterval(() => this.tick(), VOICE.pollMs);
    // 音量检测是"加分项"：拿不到权限就退回"识别结果超时"判定
    void this.enableVolume();
    this.showHint();
    if (onState) onState(true, 'start');
    return true;
  }

  /** 退出收音（退出前把还没发出去的一句发掉） */
  stop() {
    const was = this.live;
    this.live = false;
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (was) this.flush('stop');
    if (this.rec) { try { this.rec.stop(); } catch { /* ignore */ } }
    this.releaseVolume();
    this.hideHint();
    this.detachMeter();
    if (this.onState) this.onState(false, 'stop');
  }
  /** 把当前这一句发出去，并清空缓冲（保持收音状态不变） */
  flush(reason = 'silence') {
    const text = String(this.buffer || '').trim();
    this.buffer = '';
    this.finalText = '';
    this.interimText = '';
    if (!text) return false;
    if (this.onText) this.onText(text, reason);
    return true;
  }

  /** 每 VOICE.pollMs 检查一次静音，同时刷新音量柱 */
  tick(now = Date.now()) {
    if (!this.live) return;
    const level = this.readLevel();
    if (isVoiceLevel(level, VOICE.levelThreshold)) this.lastVoiceAt = now;
    // 拿不到麦克风音量时，用"最近有没有识别出内容"当作音量，音量柱照样会动
    const shown = level >= 0 ? level : (now - this.lastVoiceAt < 500 ? 0.55 : 0.06);
    this.level = shown;
    this.history.push(shown);
    if (this.history.length > 8) this.history.shift();
    this.paintMeter();

    if (shouldFlush({
      buffer: this.buffer,
      quietFor: now - this.lastVoiceAt,
      silenceMs: VOICE.silenceMs,
    })) {
      this.flush('silence');
    }
  }

  /* -------------------- 屏幕下方的提示（只闪 3~5 秒） -------------------- */
  showHint() {
    if (typeof document === 'undefined') return;
    this.hideHint();
    const el = document.createElement('div');
    el.className = 'voice-hint';
    el.textContent = VOICE.hintText;
    document.body.append(el);
    this.hintEl = el;
    const ms = VOICE.hintMinMs + Math.random() * Math.max(0, VOICE.hintMaxMs - VOICE.hintMinMs);
    this.hintTimer = setTimeout(() => this.hideHint(), ms);
  }

  hideHint() {
    if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = null; }
    if (this.hintEl) {
      const el = this.hintEl;
      this.hintEl = null;
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 260);
    }
  }

  /* -------------------- 麦克风按钮里的音量柱 -------------------- */
  attachMeter(el) {
    if (!el || typeof document === 'undefined') return;
    if (this.meterEl === el && this.bars.length) return;
    this.detachMeter();
    const box = document.createElement('span');
    box.className = 'mic-bars';
    this.bars = [];
    for (let i = 0; i < VOICE.bars; i += 1) {
      const bar = document.createElement('i');
      box.append(bar);
      this.bars.push(bar);
    }
    el.append(box);
    this.meterEl = el;
    this.paintMeter();
  }

  detachMeter() {
    if (this.meterEl) {
      const box = this.meterEl.querySelector('.mic-bars');
      if (box) box.remove();
    }
    this.meterEl = null;
    this.bars = [];
  }

  paintMeter() {
    if (!this.bars.length) return;
    const heights = barHeights(this.history, this.bars.length);
    for (let i = 0; i < this.bars.length; i += 1) {
      this.bars[i].style.height = `${Math.round(heights[i] * 100)}%`;
    }
  }

  /* -------------------- 音量检测（可选） -------------------- */
  async enableVolume() {
    if (!VOICE.useVolume) return false;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!Ctx) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.live) { stream.getTracks().forEach((t) => t.stop()); return false; }
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.audio = { stream, ctx };
      this.analyser = analyser;
      this.levels = new Uint8Array(analyser.fftSize);
      this.volumeReady = true;
      return true;
    } catch {
      this.volumeReady = false; // 没权限也不影响：靠识别结果判断静音
      return false;
    }
  }

  readLevel() {
    if (!this.analyser || !this.levels) return -1;
    try {
      this.analyser.getByteTimeDomainData(this.levels);
    } catch {
      return -1;
    }
    return rmsOf(this.levels);
  }

  releaseVolume() {
    this.analyser = null;
    this.levels = null;
    this.volumeReady = false;
    if (!this.audio) return;
    try { this.audio.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { this.audio.ctx.close(); } catch { /* ignore */ }
    this.audio = null;
  }

  /** 牌桌/聊天面板通用的按钮状态（收音时按钮里长出音量柱） */
  applyButtonState(el, live) {
    if (!el) return;
    el.classList.toggle('is-live', !!live);
    el.title = live
      ? '正在听…（说完停一下会自动发出，再点一下结束）'
      : '点一下开始语音输入（可以连续说话）';
    if (live) this.attachMeter(el);
    else this.detachMeter();
  }
}

export const voice = new Voice();
