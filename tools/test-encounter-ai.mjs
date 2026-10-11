import assert from 'node:assert/strict';
import {
  buildEncounterOpenerMessages,
  buildEncounterReplyMessages,
  encounterOpener,
  encounterReply,
} from '../src/ai/encounter.js';
import { FRIEND } from '../src/config.js';

const persona = {
  name: '小夏', gender: 'f', age: 24, style: 'balanced',
  tags: ['摄影', '随和'], prompt: '随和的摄影爱好者，喜欢留意日常的小细节。',
  lines: { greeting: ['开局啦！', '嗨，今天光线挺好。'], idle: ['要不起了', '路边的云挺好看。'] },
};

const opener = buildEncounterOpenerMessages({ persona, number: 2, previousSummary: '上次聊到雨天散步', playerName: '阿北', playerGender: '男' });
assert.match(opener[0].content, /第 2 次通过「遇见」匹配/);
assert.match(opener[0].content, /尚未互加好友/);
assert.match(opener[0].content, /匹配筛选/);
assert.match(opener[0].content, /不要机械地说/);

const reply = buildEncounterReplyMessages({
  persona, number: 2, previousSummary: '雨天散步', playerText: '我今天去看展了',
  messages: [{ role: 'me', text: '上次那场雨真大' }, { role: 'ai', text: '但空气很清新' }],
});
assert.match(reply[1].content, /玩家：上次那场雨真大/);
assert.match(reply[1].content, /你：但空气很清新/);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
try {
  const first = await encounterOpener({ persona, number: 1 });
  assert.equal(first.offline, true);
  assert.ok(first.text.length <= FRIEND.maxReplyChars);
  assert.doesNotMatch(first.text, /(在吗|你多大|哪里人|兴趣爱好是什么|开局|要不起)/);

  const again = await encounterOpener({ persona, number: 2 });
  assert.equal(again.offline, true);
  assert.match(again.text, /^又遇见你了/);

  const answer = await encounterReply({ persona, number: 1, playerText: '你好' });
  assert.equal(answer.offline, true);
  assert.ok(answer.text.length <= FRIEND.maxReplyChars);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('遇见 AI 测试通过');
