/**
 * BGM 乐谱测试（node tools/test-audio.mjs）
 * 音乐好不好听得靠耳朵，但"写得对不对"完全可以用数据盯住：
 *   · 音名解析正确（A4 = 440）
 *   · 旋律全在调内（C 大调自然音阶），不出现跑调音
 *   · 每小节的强拍落在该小节的和弦音上（和声对得上）
 *   · 循环长度、小节数、音符不越界、时值合理
 *   · 调度器的时间推进是均匀的（不会忽快忽慢）
 */
import { readFileSync, existsSync } from 'node:fs';
import { freqOf, pitchClassOf, bgmTimeline, BGM_META } from '../src/ui/audio.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);
/** 16 小节的和弦（按音级；G/B、Am/G、C/E 这些转位和弦的音级与原型一致） */
const PROGRESSION = [
  'C', 'G', 'Am', 'Am7', 'F', 'C', 'Dm7', 'G7',
  'F', 'G', 'Em7', 'Am', 'Dm7', 'G7', 'C', 'G7',
];
const CHORD_PC = {
  C: [0, 4, 7], G: [7, 11, 2], Am: [9, 0, 4], Am7: [9, 0, 4, 7],
  Em: [4, 7, 11], Em7: [4, 7, 11, 2], F: [5, 9, 0], Dm7: [2, 5, 9, 0], G7: [7, 11, 2, 5],
};

/* ---------------- 音名 → 频率 ---------------- */
console.log('-- 音名解析');
{
  ok(Math.abs(freqOf('A4') - 440) < 0.01, `A4 = 440（实际 ${freqOf('A4')}）`);
  ok(Math.abs(freqOf('C4') - 261.63) < 0.05, `C4 ≈ 261.63（实际 ${freqOf('C4').toFixed(2)}）`);
  ok(Math.abs(freqOf('C5') - 523.25) < 0.1, `C5 ≈ 523.25（八度翻倍）`);
  ok(freqOf('B4') < freqOf('C5'), 'B4 < C5（相邻半音）');
  ok(freqOf('') === 0 && freqOf('XX') === 0, '非法音名安全返回 0');
  ok(pitchClassOf('C4') === 0 && pitchClassOf('B4') === 11, '音级换算正确');
}

/* ---------------- 乐谱结构 ---------------- */
console.log('-- 乐谱结构');
{
  const tl = bgmTimeline();
  const bars = tl.filter((e) => e.layer === 'melody');
  ok(BGM_META.bars === 16, `16 小节两段式（实际 ${BGM_META.bars}）`);
  ok(BGM_META.bpm === 96, `速度 96 BPM（实际 ${BGM_META.bpm}）`);
  ok(Math.abs(BGM_META.loopSeconds - 40) < 0.01, `一轮 ${BGM_META.loopSeconds.toFixed(1)} 秒`);
  ok(bars.length >= 60, `主旋律有足够多的音（${bars.length} 个）`);
  const layers = [...new Set(tl.map((e) => e.layer))].sort();
  ok(layers.length === 7, `七个声部都在（${layers.join('/')}）`);
  ok(tl.length >= 400, `整体音数足够丰富（${tl.length} 个事件）`);
  ok(tl.every((e) => e.time >= 0 && e.time < BGM_META.loopSeconds), '所有音都落在循环长度以内');
  ok(tl.every((e) => e.dur > 0 && e.dur <= 3), '时值合理（0~3 秒）');
  ok(tl.filter((e) => e.freq > 0).every((e) => e.freq >= 60 && e.freq <= 1400),
    '音高落在人耳舒适的音域内');

  /* 和弦铺底：这是"有没有和弦"的关键 —— 每小节都要有一整小节持续的和弦 */
  const pads = tl.filter((e) => e.layer === 'pad');
  ok(pads.length >= 48, `和弦铺底音数够（${pads.length} 个音）`);
  const spb = 60 / BGM_META.bpm;
  for (let i = 0; i < BGM_META.bars; i += 1) {
    const inBar = pads.filter((e) => e.bar === i);
    ok(inBar.length >= 3, `第 ${i + 1} 小节的和弦至少 3 个音（实际 ${inBar.length}）`);
    ok(inBar.every((e) => Math.abs(e.time - i * 4 * spb) < 1e-6), `第 ${i + 1} 小节的和弦是整小节按住（从第一拍起）`);
    ok(inBar.every((e) => e.dur > 4 * spb * 0.9), `第 ${i + 1} 小节和弦持续到小节末（${inBar[0].dur.toFixed(2)}s）`);
    const pcs = new Set(inBar.map((e) => pitchClassOf(e.note)));
    ok(pcs.size === inBar.length, `第 ${i + 1} 小节和弦里没有重复音`);
    // 铺底的音级必须正好等于这一小节声明的和弦
    const want = CHORD_PC[PROGRESSION[i]];
    ok(want.every((pc) => pcs.has(pc)) && pcs.size <= want.length,
      `第 ${i + 1} 小节（${PROGRESSION[i]}）铺底音级与和弦一致（${[...pcs].join(',')}）`);
  }
  ok(pads.every((e) => C_MAJOR.has(pitchClassOf(e.note))), '和弦音也都在调内');

  /* 琶音 / 贝斯 / 鼓点 */
  const arp = tl.filter((e) => e.layer === 'arp');
  ok(arp.length === BGM_META.bars * 8, `每小节 8 个八分音符琶音（${arp.length}）`);
  const arpBad = arp.filter((e) => !CHORD_PC[PROGRESSION[e.bar]].includes(pitchClassOf(e.note)));
  ok(arpBad.length === 0, `琶音全是当小节的和弦音（越界：${arpBad.length}）`);
  const bass = tl.filter((e) => e.layer === 'bass');
  ok(bass.length === BGM_META.bars * 2, '贝斯每小节两下（根音 + 五度）');
  const bassBad = bass.filter((e) => !CHORD_PC[PROGRESSION[e.bar]].includes(pitchClassOf(e.note)));
  ok(bassBad.length === 0, `贝斯也只用和弦音（越界：${bassBad.length}）`);
  const kick = tl.filter((e) => e.layer === 'kick');
  ok(kick.length === BGM_META.bars * 2, '底鼓每小节两下（1、3 拍）');
  const hat = tl.filter((e) => e.layer === 'hat');
  ok(hat.length === BGM_META.bars * 7, `沙锤走八分音符（${hat.length}）`);
}

/* ---------------- 调性与和声 ---------------- */
console.log('-- 调性与和声');
{
  const tl = bgmTimeline();
  const melody = tl.filter((e) => e.layer === 'melody');
  const offKey = melody.filter((e) => !C_MAJOR.has(pitchClassOf(e.note)));
  ok(offKey.length === 0, `旋律没有跑调音（C 大调外：${offKey.map((e) => e.note).join(',') || '无'}）`);

  const chords = PROGRESSION;
  const beatOf = (e) => Math.round((e.time / (60 / BGM_META.bpm)) * 1000) / 1000 % 4;
  for (let i = 0; i < chords.length; i += 1) {
    const name = chords[i];
    const tones = CHORD_PC[name];
    // 规则：每小节**第一拍**必须落在该小节的和弦音上（换和弦时和声要锁得住）
    const downbeat = melody.filter((e) => e.bar === i && Math.abs(beatOf(e)) < 0.01);
    ok(downbeat.length > 0, `第 ${i + 1} 小节（${name}）第一拍有旋律`);
    const badDown = downbeat.filter((e) => !tones.includes(pitchClassOf(e.note)));
    ok(badDown.length === 0, `第 ${i + 1} 小节（${name}）第一拍是和弦音（越界：${badDown.map((e) => e.note).join(',') || '无'}）`);
  }
  // 整体：强拍（1、3 拍）上大部分音是和谐音即可 —— 允许经过音、倚音存在，否则旋律会很呆
  const strongAll = melody.filter((e) => [0, 2].includes(Math.round(beatOf(e))));
  const hit = strongAll.filter((e) => CHORD_PC[chords[e.bar]].includes(pitchClassOf(e.note)));
  const ratio = hit.length / Math.max(1, strongAll.length);
  ok(ratio >= 0.6, `强拍上 ${(ratio * 100).toFixed(0)}% 是和弦音（允许少量经过音）`);

  // 每小节都有贝斯；最后一小节停在导音，接回开头更顺
  const bassBars = [...new Set(tl.filter((e) => e.layer === 'bass').map((e) => e.bar))];
  ok(bassBars.length === BGM_META.bars, `每小节都有贝斯（${bassBars.length}/${BGM_META.bars}）`);
  const lastBar = melody.filter((e) => e.bar === BGM_META.bars - 1);
  const lastNote = lastBar[lastBar.length - 1];
  ok(pitchClassOf(lastNote.note) === 11, `结尾停在导音（B）好接回开头（实际 ${lastNote.note}）`);
  const firstNote = melody.find((e) => e.bar === 0);
  ok([0, 4, 7].includes(pitchClassOf(firstNote.note)), `开头落在主和弦音上（${firstNote.note}）`);
  // 两段式：B 段的音区要明显抬起来，听感才有"发展"而不是原地循环
  const avgOf = (list) => list.reduce((s, e) => s + e.freq, 0) / Math.max(1, list.length);
  const aPart = melody.filter((e) => e.bar < 8);
  const bPart = melody.filter((e) => e.bar >= 8);
  ok(avgOf(bPart) > avgOf(aPart), `B 段旋律音区更高（${avgOf(bPart).toFixed(0)}Hz > ${avgOf(aPart).toFixed(0)}Hz）`);
}

/* ---------------- 调度时间 ---------------- */
console.log('-- 调度时间');
{
  const spb = 60 / BGM_META.bpm;
  const tl = bgmTimeline(3);
  const barTimes = [...new Set(tl.filter((e) => e.layer === 'bass').map((e) => Number(e.time.toFixed(4))))];
  ok(barTimes.length === 6, '3 小节里贝斯每小节两下');
  const gaps = [];
  for (let i = 1; i < barTimes.length; i += 1) gaps.push(Number((barTimes[i] - barTimes[i - 1]).toFixed(4)));
  ok(gaps.every((g) => Math.abs(g - 2 * spb) < 1e-6), `每 2 拍一下、间隔均匀（${gaps[0]}s）`);
  // 旋律不能超过所在小节
  const over = tl.filter((e) => e.layer === 'melody' && e.time + e.dur > (e.bar + 1) * 4 * spb + 1e-6);
  ok(over.length === 0, '旋律不会拖过小节线（换和弦时不打架）');
}

/* ---------------- 音量配比 ---------------- */
console.log('-- 音量配比');
{
  const mix = BGM_META.mix;
  ok(Object.values(mix).every((v) => v > 0 && v < 1), '每层音量都在合理范围（0~1）');
  // 和弦铺底是正弦波、泛音少，听感天生比三角波"虚"，所以数值必须给得足够高
  ok(mix.pad >= 0.2, `和弦铺底够响（${mix.pad}，曾因 0.115 太小几乎听不见）`);
  ok(mix.pad > mix.arp * 2, `和弦铺底明显压过琶音（${mix.pad} > ${mix.arp}）`);
  ok(mix.pad > mix.stab, `和弦铺底比和弦轻点厚（${mix.pad} > ${mix.stab}）`);
  ok(mix.pad <= mix.melody, `和弦不盖过主旋律（${mix.pad} ≤ ${mix.melody}）`);
  const pitched = { pad: mix.pad, melody: mix.melody, arp: mix.arp, bass: mix.bass, stab: mix.stab };
  ok(mix.bass === Math.max(...Object.values(pitched)), '有音高的层里贝斯最响（低音是地基）');
  ok(BGM_META.delay.wet > 0 && BGM_META.delay.feedback < 0.5, '延迟湿度合理且反馈不过量（不会糊成一团）');
}

/* ===================================================================== */
console.log('-- ★ 背景音乐文件（music/）：对局用 battle.mp3，其他场景用 background.mp3');
{
  const audioSrc = readFileSync(new URL('../src/ui/audio.js', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const panelsSrc = readFileSync(new URL('../src/ui/panels.js', import.meta.url), 'utf8');
  const idx = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(audioSrc.includes('stopSynthBgm') && /stopSynthBgm\(\) \{/.test(audioSrc),
    '★ 有 stopSynthBgm（切文件 BGM 时要停掉合成轨；曾经漏了这个方法直接报错）');
  ok(/async playSceneBgm\(\)/.test(audioSrc) && /await this\.fileAvailable\(scene\)/.test(audioSrc),
    '★ 先探文件在不在，再决定放文件还是合成（文件不存在时不建 <audio>）');
  ok(/method: 'HEAD'/.test(audioSrc) && /Content-Type|content-type/.test(audioSrc),
    '★ 探针用 HEAD + Content-Type 判断（404/HTML 错误页都算"没有音乐文件"）');
  ok(/el\.preload = 'none'/.test(audioSrc), '★ 不预加载（preload=none，避免还没播就先下整个文件）');
  ok(audioSrc.includes("scene === 'battle' ? 'music/battle.mp3' : 'music/background.mp3'"),
    '★ 两个场景各自对应 music/battle.mp3 与 music/background.mp3');
  ok(/el\.loop = true/.test(audioSrc), '音乐文件是循环播放');
  ok(/addEventListener\('error'[\s\S]{0,220}startSynthBgm\(\)/.test(audioSrc),
    '★ 文件缺失 / 解码失败 → 退回原来的合成 BGM（不会变哑巴）');
  ok(/if \(this\.fileBgmBroken\) return false;/.test(audioSrc), '坏掉之后不再反复重试');
  ok(/el\.volume = this\.fileVolume\(\)/.test(audioSrc) && /bgmVolume \* BGM_GAIN\.file/.test(audioSrc),
    '★ 音乐文件音量跟着设置里的 BGM 滑杆走');
  // ★ 用户要求"人为调大一些"：滑杆 70 时应该明显比以前响（旧系数 0.6 → 0.42）
  {
    const { audio } = await import('../src/ui/audio.js');
    audio.setVolumes({ bgm: 70 });
    ok(audio.fileVolume() >= 0.65,
      `★ 滑杆 70 时 mp3 音量 ${audio.fileVolume()}（旧系数只有 0.42，明显调大了）`);
    audio.setVolumes({ bgm: 100 });
    ok(Math.abs(audio.fileVolume() - 1) < 1e-9, '滑杆拉满 = 1.0（刚好满音量，不爆）');
    audio.setVolumes({ bgm: 0 });
    ok(audio.fileVolume() === 0, '滑杆拉到 0 = 静音');
    audio.setVolumes({ bgm: 70 });
  }
  ok(/const BGM_GAIN = \{ file: [\d.]+, synth: [\d.]+ \}/.test(audioSrc)
    && Number((audioSrc.match(/synth: ([\d.]+)/) || [])[1]) > 0.16,
    '★ 没有音乐文件时的合成 BGM 也调大了（旧值 0.16 太小）');
  ok(/setVolumes\(\{ bgm, sfx \}\)[\s\S]{0,500}el\.volume = this\.fileVolume\(\)/.test(audioSrc),
    '拖动滑杆时立刻更新文件音量');
  ok(/resume\(\) \{[\s\S]{0,500}el\.play\(\)/.test(audioSrc),
    '★ 浏览器解锁音频之后会把 BGM 补上（自动播放策略）');
  // 场景路由：三个对局界面 → battle，其他 → background
  ok(/const inGame = id === 'screen-table' \|\| id === 'screen-fishing' \|\| id === 'screen-gomoku';/.test(appSrc),
    '★ 三个对局界面都算 battle 场景');
  ok(/audio\.setScene\(inGame \? 'battle' : 'background'\)/.test(appSrc), 'showScreen 里切场景');
  ok(!/audio\.stopBgm\(\)/.test(appSrc), '★ 退出对局不再 stopBgm（回大厅应该接着放 background）');
  ok(/id="set-bgm"/.test(panelsSrc) && /id="set-sfx"/.test(panelsSrc), '设置里能调 BGM / 音效音量');
  ok(/AI-Gameet/.test(idx) && /社交-桌游平台/.test(idx), '★ 游戏名是 AI-Gameet，副标题是「社交-桌游平台」');
  ok(!/AI-gameet/.test(idx), '没有残留的小写旧名');
  ok(existsSync(new URL('../music/README.md', import.meta.url)), 'music/ 目录带说明（放哪两个文件）');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : 'BGM 乐谱检查通过'}`);
process.exit(fail ? 1 : 0);
