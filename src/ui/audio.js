/**
 * 音效与 BGM（零素材：WebAudio 合成，PRD §2.9 音量分轨）
 *
 * BGM 是一段手写的循环小曲（C 大调 · 96BPM · **16 小节两段式** ≈ 40 秒一轮）：
 *   A 段（1~8）卡农式下行低音：C – G/B – Am – Am/G – F – C/E – Dm7 – G7
 *   B 段（9~16）情绪抬起来：    F – G – Em7 – Am – Dm7 – G7 – C – G7（末小节停在导音，顺势接回 A 段）
 *   · **七个声部**：和弦铺底（整小节按住，和声听得见）＋行走贝斯（根音 + 五度）
 *     ＋琶音（八分音符分解和弦）＋主旋律 ＋底鼓（1、3 拍）＋轻沙锤（八分音符）
 *   · 主旋律走**附点八分延迟**（DelayNode，反馈 0.22）→ 自带残响般的层次，听感更"制作过"
 *   · 前瞻调度（每 25ms 排未来 0.6 秒的音符，按绝对时间起音）→ 节奏稳不飘；停止先淡出再清调度
 * 乐谱是纯数据（BGM），换风格只改这里；`bgmTimeline()` 可导出"第几秒、什么音、多长"的时间线。
 */

/* ---------------- 乐谱数据 ---------------- */
/** 音名升八度（用于生成琶音的高声部） */
const upOctave = (name) => name.replace(/(-?\d)$/, (m) => String(Number(m) + 1));

/** 由和弦音生成一小节 8 个八分音符的琶音（低八度上行 + 高八度下行，流动感好） */
function arpFromChord(chord) {
  const low = chord.slice();
  const high = chord.map(upOctave);
  const shape = [0, 1, 2, 1, 0, 1, 2, 1];
  return shape.map((i, k) => (k < 3 ? low[i % low.length] : high[i % high.length]));
}

/**
 * 每小节：
 *   chord  和弦音（和弦铺底 + 轻点 + 琶音都用它；加七音就是七和弦）
 *   bass   [[音名, 起始拍], …]（只写和弦音，保证撞不到和声）
 *   melody [音名, 起始拍, 时值拍]
 *   kick   底鼓落在第几拍（默认 1、3 拍）
 *   hat    沙锤落在第几拍（默认八分音符）
 */
const BGM = {
  bpm: 96,
  beatsPerBar: 4,
  bars: [
    /* ---------- A 段：卡农式下行低音 C–B–A–G–F–E–D–G ---------- */
    {
      chord: ['C4', 'E4', 'G4'], bass: [['C3', 0], ['G3', 2]], melody: [['E5', 0, 0.5], ['G5', 0.5, 0.5], ['A5', 1, 1], ['G5', 2, 0.5], ['E5', 2.5, 0.5], ['C5', 3, 1]],
    },
    {
      chord: ['G3', 'B3', 'D4'], bass: [['B2', 0], ['D3', 2]], melody: [['D5', 0, 0.5], ['G5', 0.5, 0.5], ['B5', 1, 1], ['A5', 2, 1], ['G5', 3, 1]],
    },
    {
      chord: ['A3', 'C4', 'E4'], bass: [['A2', 0], ['E3', 2]], melody: [['A5', 0, 0.5], ['C6', 0.5, 0.5], ['B5', 1, 1], ['A5', 2, 0.5], ['E5', 2.5, 0.5], ['A5', 3, 1]],
    },
    {
      // Am7（低音走 G，接上行下行的卡农低音线 C–B–A–G）
      chord: ['A3', 'C4', 'E4', 'G4'], bass: [['G2', 0], ['A2', 2]], melody: [['G5', 0, 1], ['E5', 1, 0.5], ['G5', 1.5, 0.5], ['B5', 2, 2]],
    },
    {
      chord: ['F3', 'A3', 'C4'], bass: [['F2', 0], ['C3', 2]], melody: [['A5', 0, 0.5], ['F5', 0.5, 0.5], ['C6', 1, 1], ['A5', 2, 1], ['F5', 3, 1]],
    },
    {
      chord: ['C4', 'E4', 'G4'], bass: [['E3', 0], ['G3', 2]], melody: [['E5', 0, 0.5], ['G5', 0.5, 0.5], ['E5', 1, 1], ['C5', 2, 1], ['E5', 3, 0.5], ['G5', 3.5, 0.5]],
    },
    {
      chord: ['D4', 'F4', 'A4', 'C5'], bass: [['D3', 0], ['A3', 2]], melody: [['F5', 0, 0.5], ['A5', 0.5, 0.5], ['D5', 1, 1], ['F5', 2, 1], ['A5', 3, 1]],
    },
    {
      chord: ['G3', 'B3', 'D4', 'F4'], bass: [['G2', 0], ['D3', 2]], melody: [['B5', 0, 0.5], ['A5', 0.5, 0.5], ['G5', 1, 1], ['D5', 2, 1], ['B4', 3, 1]],
    },
    /* ---------- B 段：情绪抬起来，旋律走高 ---------- */
    {
      chord: ['F3', 'A3', 'C4'], bass: [['F2', 0], ['C3', 2]], melody: [['C6', 0, 1], ['A5', 1, 0.5], ['C6', 1.5, 0.5], ['D6', 2, 1], ['C6', 3, 1]],
    },
    {
      chord: ['G3', 'B3', 'D4'], bass: [['G2', 0], ['D3', 2]], melody: [['B5', 0, 1], ['D6', 1, 0.5], ['B5', 1.5, 0.5], ['A5', 2, 1], ['G5', 3, 1]],
    },
    {
      chord: ['E3', 'G3', 'B3', 'D4'], bass: [['E3', 0], ['B3', 2]], melody: [['E5', 0, 1], ['G5', 1, 1], ['B5', 2, 1], ['D6', 3, 1]],
    },
    {
      chord: ['A3', 'C4', 'E4'], bass: [['A2', 0], ['E3', 2]], melody: [['A5', 0, 1], ['C6', 1, 0.5], ['B5', 1.5, 0.5], ['A5', 2, 1], ['E5', 3, 1]],
    },
    {
      chord: ['D4', 'F4', 'A4', 'C5'], bass: [['D3', 0], ['A3', 2]], melody: [['F5', 0, 0.5], ['A5', 0.5, 0.5], ['D6', 1, 1], ['A5', 2, 1], ['F5', 3, 1]],
    },
    {
      chord: ['G3', 'B3', 'D4', 'F4'], bass: [['G2', 0], ['D3', 2]], melody: [['B5', 0, 0.5], ['D6', 0.5, 0.5], ['B5', 1, 1], ['G5', 2, 1], ['D5', 3, 1]],
    },
    {
      chord: ['C4', 'E4', 'G4'], bass: [['C3', 0], ['G3', 2]], melody: [['E5', 0, 0.5], ['C6', 0.5, 0.5], ['G5', 1, 1], ['E5', 2, 1], ['C5', 3, 1]],
    },
    {
      chord: ['G3', 'B3', 'D4', 'F4'], bass: [['G2', 0], ['D3', 2]], melody: [['G5', 0, 1], ['B5', 1, 1], ['D6', 2, 1], ['B4', 3, 1]],
    },
  ],
};

/**
 * 各层的相对音量（最终还会乘上 BGM 总音量）
 * 和弦铺底用的是正弦波，泛音少、听感比三角波"虚"，所以数值要给得比主旋律还高才听得见
 * ——pad 0.26 ≈ 主旋律 0.30 的量感，但因为有 3~4 个音叠着，整体和声是垫在最下面的
 */
const MIX = {
  pad: 0.26, // 和弦铺底：和声要靠它撑起来（正弦波，给小了整首就只剩旋律和鼓）
  melody: 0.30,
  arp: 0.105, // 琶音：只要流动感，不能盖过主旋律
  bass: 0.40,
  stab: 0.085,
  kick: 0.5,
  hat: 0.045,
};

/** 主旋律的附点八分延迟（自带层次感） */
const DELAY = { beats: 0.75, feedback: 0.22, wet: 0.2 };

const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 音名 → 频率（十二平均律，A4 = 440） */
export function freqOf(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(String(name || ''));
  if (!m) return 0;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + SEMITONE[m[1]] + accidental;
  return 440 * (2 ** ((midi - 69) / 12));
}

/** 音名 → 音级（0=C, 1=C#, …, 11=B），用于"是否在调内"这类校验 */
export function pitchClassOf(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(String(name || ''));
  if (!m) return -1;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return ((SEMITONE[m[1]] + accidental) % 12 + 12) % 12;
}

export const BGM_META = {
  bpm: BGM.bpm,
  beatsPerBar: BGM.beatsPerBar,
  bars: BGM.bars.length,
  mix: { ...MIX },
  delay: { ...DELAY },
  get loopSeconds() { return (BGM.bars.length * BGM.beatsPerBar * 60) / BGM.bpm; },
};

/**
 * 把乐谱展开成"第几秒、什么音、多长"的时间线（不含循环重复）
 * @param {number} bars 展开几小节，默认全部
 */
export function bgmTimeline(bars = BGM.bars.length) {
  const spb = 60 / BGM.bpm;
  const out = [];
  BGM.bars.slice(0, bars).forEach((bar, i) => {
    const t0 = i * BGM.beatsPerBar * spb;
    for (const [note, beat, dur] of bar.melody) {
      out.push({ bar: i, layer: 'melody', note, freq: freqOf(note), time: t0 + beat * spb, dur: dur * spb });
    }
    // 和弦铺底：整小节持续（留一点点空隙，换和弦时不会糊在一起）
    for (const note of bar.chord) {
      out.push({
        bar: i, layer: 'pad', note, freq: freqOf(note), time: t0, dur: spb * BGM.beatsPerBar * 0.97,
      });
    }
    // 行走贝斯：根音 + 五度（都是和弦音）
    for (const [note, beat] of bar.bass) {
      out.push({
        bar: i, layer: 'bass', note, freq: freqOf(note), time: t0 + beat * spb, dur: spb * 1.7,
      });
    }
    // 琶音：8 个八分音符
    arpFromChord(bar.chord).forEach((note, k) => {
      out.push({
        bar: i, layer: 'arp', note, freq: freqOf(note), time: t0 + k * spb * 0.5, dur: spb * 0.42,
      });
    });
    // 和弦轻点：2、4 拍
    for (const beat of [1, 3]) {
      for (const note of bar.chord) {
        out.push({ bar: i, layer: 'stab', note, freq: freqOf(note), time: t0 + beat * spb, dur: spb * 0.22 });
      }
    }
    // 底鼓（默认 1、3 拍）
    for (const beat of bar.kick || [0, 2]) {
      out.push({ bar: i, layer: 'kick', note: '-', freq: 0, time: t0 + beat * spb, dur: 0.12 });
    }
    // 沙锤（默认八分音符）
    for (const beat of bar.hat || [0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
      out.push({ bar: i, layer: 'hat', note: '-', freq: 0, time: t0 + beat * spb, dur: 0.05 });
    }
  });
  return out.sort((a, b) => a.time - b.time || a.layer.localeCompare(b.layer));
}

/**
 * BGM 音量系数（★ 用户要求"人为调大一些"）
 *
 *   · file  —— `music/*.mp3` 这条轨：设置里的滑杆 0~100 直接映射成 0~1，
 *              再乘这个系数（=1.0 表示滑杆拉满就是满音量；滑杆 70 → 0.70）
 *   · synth —— 没有音乐文件时的合成 BGM：原来只有 0.16，听着像没开音乐，
 *              现在提到 0.3（再多几层叠起来会糊、还会削顶）
 *
 * 觉得还是小/太大，只改这一行就行。
 */
const BGM_GAIN = { file: 1.0, synth: 0.3 };

class AudioKit {
  constructor() {
    this.ctx = null;
    this.bgmGain = null;
    this.sfxGain = null;
    this.bgmTimer = null;
    this.bgmStep = 0;
    this.bgmNextTime = 0;
    this.bgmVolume = 0.7;
    this.sfxVolume = 0.7;
    this.enabled = true;
    /** 当前场景：'background'（其他所有场景） / 'battle'（对局里） */
    this.scene = 'background';
    /** 两条音乐文件轨（懒加载：用到哪个才建哪个） */
    this.tracks = { background: null, battle: null };
    /** 音乐文件是否存在的探针结果（缓存 Promise，避免反复请求） */
    this.probes = { background: null, battle: null };
    /** 音乐文件不可用（没放文件 / 加载失败）→ 退回合成 BGM */
    this.fileBgmBroken = false;
    this.playing = false;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return null; }
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = this.bgmVolume * BGM_GAIN.synth;
    this.bgmGain.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume * 0.5;
    this.sfxGain.connect(this.master);
    // 主旋律的附点八分延迟：给旋律加一层"残响"，听感更厚（挂在 BGM 轨上）
    this.delayNode = this.ctx.createDelay(1.0);
    this.delayNode.delayTime.value = (60 / BGM.bpm) * DELAY.beats;
    this.delayFb = this.ctx.createGain();
    this.delayFb.gain.value = DELAY.feedback;
    this.delayWet = this.ctx.createGain();
    this.delayWet.gain.value = DELAY.wet;
    this.delayNode.connect(this.delayFb).connect(this.delayNode);
    this.delayNode.connect(this.delayWet).connect(this.bgmGain);
    return this.ctx;
  }

  /** 底鼓：一个很低的短促 sine（1、3 拍） */
  bgmKick(t0, vol) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(48, t0 + 0.1);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    osc.connect(gain).connect(this.bgmGain);
    osc.start(t0);
    osc.stop(t0 + 0.16);
  }

  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    // 浏览器解锁之后，把当前场景的 BGM 补上（第一次点屏幕之前是放不出来的）
    if (this.playing) {
      const el = this.tracks[this.scene];
      if (el && el.paused) {
        el.volume = this.fileVolume();
        const p = el.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    }
  }

  setVolumes({ bgm, sfx }) {
    if (typeof bgm === 'number') {
      this.bgmVolume = bgm / 100;
      if (this.bgmGain) this.bgmGain.gain.value = this.bgmVolume * BGM_GAIN.synth;
      // 音乐文件音量跟着滑杆走
      for (const el of Object.values(this.tracks)) if (el) el.volume = this.fileVolume();
    }
    if (typeof sfx === 'number') {
      this.sfxVolume = sfx / 100;
      if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume * 0.5;
    }
  }

  tone({ freq = 440, dur = 0.12, type = 'sine', vol = 0.5, delay = 0, slide = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq + slide), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  play(name) {
    if (!this.enabled) return;
    try {
      switch (name) {
        case 'deal': this.tone({ freq: 660, dur: 0.05, type: 'triangle', vol: 0.16 }); break;
        case 'select': this.tone({ freq: 880, dur: 0.04, type: 'triangle', vol: 0.2 }); break;
        case 'play': this.tone({ freq: 520, dur: 0.09, type: 'triangle', vol: 0.34 }); this.tone({ freq: 780, dur: 0.07, type: 'sine', vol: 0.2, delay: 0.05 }); break;
        case 'pass': this.tone({ freq: 300, dur: 0.11, type: 'sine', vol: 0.22, slide: -80 }); break;
        case 'bomb':
          this.tone({ freq: 150, dur: 0.36, type: 'sawtooth', vol: 0.42, slide: -90 });
          this.tone({ freq: 70, dur: 0.5, type: 'square', vol: 0.3 });
          break;
        case 'rocket':
          this.tone({ freq: 220, dur: 0.5, type: 'sawtooth', vol: 0.4, slide: 500 });
          break;
        case 'bid': this.tone({ freq: 620, dur: 0.1, type: 'square', vol: 0.24 }); break;
        case 'rob': this.tone({ freq: 740, dur: 0.12, type: 'square', vol: 0.28 }); this.tone({ freq: 990, dur: 0.1, type: 'square', vol: 0.2, delay: 0.08 }); break;
        case 'win':
          [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.24, type: 'sine', vol: 0.34, delay: i * 0.1 }));
          break;
        case 'lose':
          [523, 440, 349, 262].forEach((f, i) => this.tone({ freq: f, dur: 0.28, type: 'sine', vol: 0.28, delay: i * 0.12 }));
          break;
        case 'coin':
          [988, 1318].forEach((f, i) => this.tone({ freq: f, dur: 0.12, type: 'triangle', vol: 0.3, delay: i * 0.07 }));
          break;
        case 'error': this.tone({ freq: 200, dur: 0.18, type: 'square', vol: 0.24 }); break;
        // 匹配界面报数时的"叮"：一个干净的两音小铃（高八度泛音收得快）
        case 'ding':
          this.tone({ freq: 1318, dur: 0.22, type: 'sine', vol: 0.3 });
          this.tone({ freq: 1976, dur: 0.16, type: 'sine', vol: 0.12, delay: 0.02 });
          break;
        case 'flower': [784, 1046, 1318].forEach((f, i) => this.tone({ freq: f, dur: 0.16, type: 'sine', vol: 0.26, delay: i * 0.06 })); break;
        case 'egg': this.tone({ freq: 180, dur: 0.2, type: 'sawtooth', vol: 0.26, slide: -60 }); break;
        default: break;
      }
    } catch { /* 音频失败不影响游戏 */ }
  }

  /* ------------------------------ BGM ------------------------------ */
  /** 一个带包络的音符（BGM 用；可以指定绝对开始时间，避免 setInterval 抖动） */
  bgmNote({
    freq, t0, dur, type = 'triangle', vol = 0.3, attack = 0.02, release = null, send = false,
  }) {
    const ctx = this.ctx;
    if (!ctx || !freq) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    const rel = release || Math.min(0.5, dur * 0.6);
    const end = t0 + dur;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + attack);
    gain.gain.setValueAtTime(vol, Math.max(t0 + attack, end - rel));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(this.bgmGain);
    // send = true 的音符额外送一份给延迟（只有主旋律用，避免整体变糊）
    if (send && this.delayNode) gain.connect(this.delayNode);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(end + 0.03);
  }

  /** 轻"沙锤"：一小段高通噪声，只在 2、4 拍点一下，给一点律动 */
  bgmHat(t0, vol) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 0.08);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      this.noiseBuf = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    src.connect(hp).connect(gain).connect(this.bgmGain);
    src.start(t0);
    src.stop(t0 + 0.09);
  }

  /** 排一小节（起音时间 t0 是绝对时间，由调度器给） */
  scheduleBar(index, t0) {
    const bar = BGM.bars[index % BGM.bars.length];
    const spb = 60 / BGM.bpm;
    const barLen = spb * BGM.beatsPerBar;
    // 和弦铺底：整小节按住，和声听得见（比只点一下就走的"轻点"厚实得多）
    for (const note of bar.chord) {
      this.bgmNote({
        freq: freqOf(note), t0, dur: barLen * 0.97,
        type: 'sine', vol: MIX.pad, attack: 0.07, release: barLen * 0.35,
      });
    }
    // 主旋律（顺带送进延迟，混出层次）
    for (const [note, beat, dur] of bar.melody) {
      this.bgmNote({
        freq: freqOf(note), t0: t0 + beat * spb, dur: dur * spb * 0.96,
        type: 'triangle', vol: MIX.melody, attack: 0.015, release: 0.14, send: true,
      });
    }
    // 行走贝斯（根音 + 五度）
    for (const [note, beat] of bar.bass) {
      this.bgmNote({
        freq: freqOf(note), t0: t0 + beat * spb, dur: spb * 1.7,
        type: 'sine', vol: MIX.bass * (beat === 0 ? 1 : 0.85), attack: 0.03, release: 0.5,
      });
    }
    // 琶音：八分音符分解和弦，流动感
    arpFromChord(bar.chord).forEach((note, k) => {
      this.bgmNote({
        freq: freqOf(note), t0: t0 + k * spb * 0.5, dur: spb * 0.42,
        type: 'triangle', vol: MIX.arp, attack: 0.012, release: 0.12,
      });
    });
    // 和弦轻点 + 沙锤 + 底鼓
    for (const beat of [1, 3]) {
      const at = t0 + beat * spb;
      for (const note of bar.chord) {
        this.bgmNote({ freq: freqOf(note), t0: at, dur: spb * 0.22, type: 'triangle', vol: MIX.stab, attack: 0.01, release: 0.1 });
      }
    }
    for (const beat of bar.kick || [0, 2]) this.bgmKick(t0 + beat * spb, MIX.kick);
    for (const beat of bar.hat || [0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
      // 2、4 拍稍微重一点，听起来更有律动
      this.bgmHat(t0 + beat * spb, MIX.hat * (Number.isInteger(beat) && beat % 2 === 0 ? 1.35 : 1));
    }
  }

  /** 前瞻调度：每 25ms 把未来 0.6 秒该响的小节排进去（音色与节奏比 setInterval 逐音更稳） */
  bgmTick() {
    const ctx = this.ctx;
    if (!ctx) return;
    /**
     * ★ 把 currentTime 强制成数字：正常浏览器里它本来就是数字，
     * 但**万一拿到的是个非数字**（测试桩 / 半残的 AudioContext 实现），
     * `this.bgmNextTime += barSeconds` 会退化成"字符串拼接"，
     * while 条件永远为真 → 死循环把 CPU 打满。这里挡一下。
     */
    const now = Number(ctx.currentTime);
    if (!Number.isFinite(now)) return;
    if (!Number.isFinite(this.bgmNextTime)) this.bgmNextTime = now + 0.12;
    const barSeconds = (BGM.beatsPerBar * 60) / BGM.bpm;
    let guard = 0;
    while (this.bgmNextTime < now + 0.6 && guard < 64) {
      if (this.bgmNextTime < now) this.bgmNextTime = now + 0.05;
      this.scheduleBar(this.bgmStep, this.bgmNextTime);
      this.bgmStep += 1;
      this.bgmNextTime += barSeconds;
      guard += 1; // 双保险：一帧最多排 64 小节
    }
  }

  /**
   * 开始循环播放（重复调用无副作用）
   *
   * ★ 现在优先放**音乐文件**（用户拍板）：
   *     music/battle.mp3     —— 对局里的 BGM（斗地主 / 小猫钓鱼 / 五子棋都用它）
   *     music/background.mp3 —— 其他所有场景（加载页 / 大厅 / 面板…）
   *   文件没放 / 加载失败 → **退回原来那套合成 BGM**，不会变成哑巴。
   */
  startBgm(scene) {
    if (scene) this.scene = scene;
    this.playing = true;
    void this.playSceneBgm();
  }

  /** 切场景：对局音乐 ↔ 其他场景音乐（同一条就什么都不做） */
  setScene(scene) {
    if (!scene || scene === this.scene) return;
    this.scene = scene;
    if (!this.playing) return;
    void this.playSceneBgm();
  }

  /**
   * 放当前场景的 BGM：**先探一下文件在不在**，在就放文件，不在就退回合成。
   *
   * 为什么要先探：直接 `new Audio('music/xxx.mp3')` 的话，文件不存在时浏览器
   * 会把它当成一次"下载/加载媒体"，Chrome 左下角会弹出「从该页面下载 音频」那个小窗口
   * （用户报的问题）。先发一个 HEAD 探针，404 就根本不建 <audio>，自然不会有这个弹窗。
   */
  async playSceneBgm() {
    const scene = this.scene;
    const ok = await this.fileAvailable(scene);
    // 等待期间场景/开关可能又变了
    if (!this.playing || this.scene !== scene) return;
    if (ok && this.playFileBgm()) return;
    this.startSynthBgm();
  }

  /** 音乐文件路径（相对 index.html） */
  fileFor(scene) {
    return scene === 'battle' ? 'music/battle.mp3' : 'music/background.mp3';
  }

  /**
   * 探针：这个场景的音乐文件到底在不在（结果缓存，不会反复请求）
   * 判定标准：HTTP 200 且 Content-Type 是 audio/*（找不到 / 是 HTML 错误页都算没有）
   * @returns {Promise<boolean>}
   */
  fileAvailable(scene) {
    if (this.fileBgmBroken) return Promise.resolve(false);
    if (this.probes[scene]) return this.probes[scene];
    const url = this.fileFor(scene);
    const p = (async () => {
      if (typeof fetch !== 'function') return false;
      try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        const ok = !!res.ok && /^audio\//i.test(type);
        if (!ok) this.fileBgmBroken = true;
        return ok;
      } catch {
        this.fileBgmBroken = true;
        return false;
      }
    })();
    this.probes[scene] = p;
    return p;
  }

  /** 确保某个场景的 <audio> 元素存在（不预加载另一条，省流量） */
  trackOf(scene) {
    if (this.tracks[scene]) return this.tracks[scene];
    if (typeof Audio !== 'function') return null;
    const el = new Audio(this.fileFor(scene));
    el.loop = true;
    // ★ 不要 preload='auto'：那会立刻去拉整个文件（还没播放就先下完，更容易触发浏览器的下载提示）
    el.preload = 'none';
    el.volume = this.fileVolume();
    /** 播放过程中才发现坏了（文件被删 / 解码失败）→ 退回合成 BGM */
    el.addEventListener('error', () => {
      this.fileBgmBroken = true;
      if (this.playing && this.scene === scene) {
        this.stopFileBgm();
        this.startSynthBgm();
      }
    });
    this.tracks[scene] = el;
    return el;
  }

  fileVolume() {
    // mp3 通常比合成音量大，压一点，让滑杆手感一致
    return Math.max(0, Math.min(1, this.bgmVolume * BGM_GAIN.file));
  }

  /**
   * 放文件 BGM
   * @returns {boolean} true = 这条已经在放了（不用退回合成）
   */
  playFileBgm() {
    if (this.fileBgmBroken) return false;
    const el = this.trackOf(this.scene);
    if (!el) return false;
    // 另一条在放 → 停掉（简单切换，不做交叉淡入淡出）
    for (const [name, other] of Object.entries(this.tracks)) {
      if (name !== this.scene && other && !other.paused) {
        try { other.pause(); other.currentTime = 0; } catch { /* ignore */ }
      }
    }
    el.volume = this.fileVolume();
    if (!el.paused) return true;
    const p = el.play();
    // 浏览器可能因为"还没交互"拒绝播放：不算失败，等下一次 resume() 再试
    if (p && typeof p.catch === 'function') p.catch(() => {});
    // 关掉合成 BGM（别两条一起响）
    this.stopSynthBgm();
    return true;
  }

  stopFileBgm() {
    for (const el of Object.values(this.tracks)) {
      if (!el) continue;
      try { el.pause(); } catch { /* ignore */ }
    }
  }

  /** 合成 BGM（原来那套程序化的小曲，作为没有音乐文件时的兜底） */
  startSynthBgm() {
    const ctx = this.ensure();
    if (!ctx || this.bgmTimer) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (this.bgmGain) this.bgmGain.gain.setValueAtTime(this.bgmVolume * BGM_GAIN.synth, ctx.currentTime);
    this.bgmStep = 0;
    this.bgmNextTime = ctx.currentTime + 0.12;
    this.bgmTick();
    this.bgmTimer = setInterval(() => {
      try { this.bgmTick(); } catch { /* 音频失败不影响游戏 */ }
    }, 25);
  }

  /**
   * 停掉合成 BGM（清调度 + 音量淡出后复位）
   * ★ 切到音乐文件时要调它，否则两条会一起响。
   */
  stopSynthBgm() {
    if (this.bgmTimer) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
    const ctx = this.ctx;
    if (!ctx || !this.bgmGain) return;
    try {
      const now = ctx.currentTime;
      this.bgmGain.gain.cancelScheduledValues(now);
      this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, now);
      this.bgmGain.gain.linearRampToValueAtTime(0.0001, now + 0.25);
      setTimeout(() => {
        if (this.bgmGain) this.bgmGain.gain.value = this.bgmVolume * BGM_GAIN.synth;
      }, 320);
    } catch { /* ignore */ }
  }

  /** 停止播放：文件轨直接停；合成轨先快速淡出 */
  stopBgm() {
    this.playing = false;
    this.stopFileBgm();
    this.stopSynthBgm();
  }
}

export const audio = new AudioKit();
