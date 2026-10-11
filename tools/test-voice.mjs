/**
 * 语音输入测试（node tools/test-voice.mjs）
 * 语音识别本身要在浏览器里跑，这里测的是可离线验证的部分：
 *   · 静音判定（音量阈值 + 持续时长）
 *   · 识别结果拼接、音量 RMS 计算
 *   · 配置基线（3~5 秒内自动发出、持续收音）
 *   · 三个入口（牌桌 / 小猫钓鱼 / 聊天面板）都接的是持续收音模式
 */
import { readFileSync } from 'node:fs';
import { VOICE, CONFIG } from '../src/config.js';
import { mergeTranscript, shouldFlush, rmsOf, isVoiceLevel, barHeights } from '../src/ui/voiceParse.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

/* ---------------- 配置基线 ---------------- */
console.log('-- 持续收音的节奏参数');
{
  // 说话一停就发：0.25s 就算"说完了"（PRD §2.7：说完就能发）
  ok(VOICE.silenceMs >= 150 && VOICE.silenceMs <= 400, `静音判定极短，说完就发（${VOICE.silenceMs}ms）`);
  ok(VOICE.pollMs <= VOICE.silenceMs, `检测间隔（${VOICE.pollMs}ms）不慢于静音阈值，否则抓不住`);
  ok(VOICE.silenceMs >= 150, '留一点点下限，避免把句中换气当成说完');
  ok(VOICE.pollMs > 0 && VOICE.pollMs <= 500, `检测间隔够密（${VOICE.pollMs}ms）`);
  ok(VOICE.levelThreshold > 0 && VOICE.levelThreshold < 0.2, `音量阈值合理（${VOICE.levelThreshold}）`);
  ok(VOICE.lang === 'zh-CN', '识别语言是中文');
  ok(typeof VOICE.useVolume === 'boolean', '音量辅助开关存在（拿不到权限时可关掉）');
}

/* ---------------- 识别结果拼接 ---------------- */
console.log('-- 识别结果拼接');
{
  ok(mergeTranscript('今天天气', '不错') === '今天天气不错', '已确认 + 临时结果要拼起来');
  ok(mergeTranscript('', '你好') === '你好', '只有临时结果也能用');
  ok(mergeTranscript('你好', '') === '你好', '只有已确认结果也能用');
  ok(mergeTranscript('  你好  ', '') === '你好', '两端空白会去掉');
  ok(mergeTranscript(undefined, undefined) === '', '空输入安全');
}

/* ---------------- 静音判定（核心） ---------------- */
console.log('-- 静音判定：安静够久就自动发出');
{
  const base = { buffer: '对2，你还能打过我', quietFor: 0, silenceMs: VOICE.silenceMs };
  ok(!shouldFlush({ ...base, quietFor: 0 }), '刚说完不发');
  ok(!shouldFlush({ ...base, quietFor: VOICE.silenceMs - 1 }), '安静时间不够不发');
  ok(shouldFlush({ ...base, quietFor: VOICE.silenceMs }), '安静到阈值就发出');
  ok(shouldFlush({ ...base, quietFor: VOICE.silenceMs + 5000 }), '一直安静也只会发一次（缓冲已清空）');
  ok(!shouldFlush({ ...base, buffer: '', quietFor: 99999 }), '没有内容就不发');
  ok(!shouldFlush({ ...base, buffer: '   ', quietFor: 99999 }), '空白内容不算');
  ok(!shouldFlush({ buffer: '', quietFor: 0, silenceMs: VOICE.silenceMs }), '空缓冲安全');
}

/* ---------------- 音量 ---------------- */
console.log('-- 麦克风音量');
{
  const silent = new Uint8Array(64).fill(128); // 静音波形
  ok(rmsOf(silent) === 0, '静音（全是 128）音量为 0');

  const loud = new Uint8Array(64);
  for (let i = 0; i < loud.length; i += 1) loud[i] = i % 2 ? 255 : 0;
  ok(rmsOf(loud) > 0.5, `大声说话音量很高（${rmsOf(loud).toFixed(2)}）`);

  ok(rmsOf([]) === 0 && rmsOf(null) === 0, '空数据安全返回 0');

  ok(isVoiceLevel(0.5, VOICE.levelThreshold), '超过阈值算在说话');
  ok(!isVoiceLevel(0.001, VOICE.levelThreshold), '低于阈值算没说话');
  ok(!isVoiceLevel(-1, VOICE.levelThreshold), '-1 表示拿不到音量数据，不算在说话');
}

/* ---------------- 三个入口都接了持续收音 ---------------- */
console.log('-- 牌桌 / 小猫钓鱼 / 聊天面板');
{
  const voice = read('src/ui/voice.js');
  ok(voice.includes('rec.continuous = true'), '识别器开了持续收音');
  ok(voice.includes('rec.interimResults = true'), '要临时结果才能判断"还在说"');
  ok(voice.includes('flush('), '有"把这一句发出去"的动作');
  ok(voice.includes("flush('stop')"), '退出收音时也会把最后一句发掉');
  ok(voice.includes('enableVolume'), '支持用麦克风音量判断静音');
  ok(voice.includes('releaseVolume'), '退出时释放麦克风和音频上下文');
  ok(voice.includes('this.rec.start()'), '被浏览器掐断后会自动续上');
  ok(voice.includes('applyButtonState'), '有统一的按钮状态');
  ok(voice.includes('attachMeter') && voice.includes('paintMeter'), '按钮里有跟着音量起伏的竖条');
  ok(!voice.includes('onDraft'), '识别中的草稿不再外抛（说完直接发）');

  const table = read('src/ui/table.js');
  ok(table.includes('voice.start({'), '牌桌接了持续收音');
  ok(table.includes('this.app.sendHumanChat(t)'), '牌桌把整句直接发出去');
  ok(!table.includes('onDraft'), '牌桌不再把识别中的文字写进输入框');
  ok(table.includes('voice.stop()'), '牌桌离开时会关麦');

  const fish = read('src/ui/fishing.js');
  ok(fish.includes('voice.start({'), '小猫钓鱼接了持续收音');
  ok(!fish.includes('onDraft'), '钓鱼桌也不再往输入框里塞草稿');
  ok(fish.includes('if (voice.live) voice.stop()'), '离开钓鱼桌会关麦');

  const panels = read('src/ui/panels.js');
  ok(panels.includes('voice.start({'), '聊天面板接了持续收音');
  ok(!panels.includes('onDraft'), '聊天面板不显示识别草稿');
  ok(!panels.includes('new SR()'), '聊天面板不再自己造一个一次性的识别器');

  ok(CONFIG.chatMaxChars >= 20, '语音发出去的文字也受聊天长度限制');
}

/* ---------------- 提示条与音量柱 ---------------- */
console.log('-- "正在听…" 提示与音量柱');
{
  ok(VOICE.hintMinMs >= 3000 && VOICE.hintMaxMs <= 5000, `提示只闪 3~5 秒（${VOICE.hintMinMs}~${VOICE.hintMaxMs}ms）`);
  ok(VOICE.hintMaxMs >= VOICE.hintMinMs, '提示时长区间合法');
  ok(VOICE.bars >= 3 && VOICE.bars <= 6, `音量柱数量合理（${VOICE.bars} 根）`);

  const voice = read('src/ui/voice.js');
  ok(voice.includes('showHint()') && voice.includes('hideHint()'), '提示条会自己出现也会自己消失');
  ok(!/voice-live::after/.test(read('styles/panels.css')), '不再是"常驻的 CSS 提示条"');
  ok(read('styles/panels.css').includes('.voice-hint'), '提示条改成了独立元素');

  // 音量柱高度：越小越矮、越大越高，且有上下限
  const flat = barHeights([0, 0, 0, 0], 4, () => 0.5);
  ok(flat.every((h) => h <= 0.13), `没声音时柱子最矮（${flat.join('/')}）`);
  const loud = barHeights([0.5, 0.5, 0.5, 0.8], 4, () => 0.5);
  ok(loud.every((h) => h > flat[0]), '有声音时柱子明显变高');
  ok(loud.every((h) => h >= 0.12 && h <= 1), '柱子高度限制在 12%~100%');
  ok(loud[loud.length - 1] >= loud[0], '越靠右的柱子越灵敏');
  ok(barHeights([], 4).length === 4, '没有历史数据也能画满 4 根');
  ok(barHeights([0.3], 4).length === 4, '历史不足时也画满柱子');

  const css = read('styles/panels.css');
  ok(css.includes('.mic-bars'), '样式里有音量柱');
  ok(/\.mic-bars i[\s\S]{0,200}transition:\s*height/.test(css), '柱子高度变化有过渡（看起来像在起伏）');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '语音输入测试全部通过'}`);
process.exit(fail ? 1 : 0);
