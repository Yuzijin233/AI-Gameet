/**
 * 好友对话的“线上”冒烟测试（可选，需要网络与可用 Key）
 * 默认跑的是本地兜底路径；设置 DDZ_LIVE=1 才会真的调用模型。
 *   node tools/test-friend-live.mjs
 */
import { PERSONAS } from '../src/data/personas.js';
import { defaultSave } from '../src/store/storage.js';
import { addFriend, adjustAffinity, addMemory, findFriend, appendChat } from '../src/store/friends.js';
import { friendReply, analyzeMessage, buildFriendMessages, buildAnalyzeMessages } from '../src/ai/friend.js';
import { CONFIG } from '../src/config.js';

const LIVE = process.env.DDZ_LIVE === '1';
const save = defaultSave();
const persona = PERSONAS[0];
addFriend(save, persona);
adjustAffinity(save, persona.id, 20);
addMemory(save, persona.id, '称呼：阿伟');
addMemory(save, persona.id, '偏好：喝奶茶');
const friend = findFriend(save, persona.id);
appendChat(save, persona.id, 'me', '在吗');
appendChat(save, persona.id, 'ai', '在的，怎么了');

console.log(`模式：${LIVE ? '真实调用模型' : '仅构造提示词（不联网）'}`);
console.log(`模型：${CONFIG.model}，思考模式：${CONFIG.thinking ? '开' : '关'}`);

const replyMsgs = buildFriendMessages({ persona, friend, text: '我今天有点累' });
const analyzeMsgs = buildAnalyzeMessages({ persona, friend, text: '我今天有点累', reply: '那就早点休息' });
const replyAll = replyMsgs.map((m) => m.content).join('\n');
const analyzeAll = analyzeMsgs.map((m) => m.content).join('\n');
console.log(`\n回复提示词 ${replyAll.length} 字｜含 memory：${replyAll.includes('称呼：阿伟')}｜含好感度：${replyAll.includes(`${friend.affinity}/100`)}`);
console.log(`分析提示词 ${analyzeAll.length} 字｜要求 JSON：${analyzeAll.includes('JSON')}｜列了 6 类：${['称呼', '偏好', '约定', '性格', '身份', '习惯'].every((x) => analyzeAll.includes(x))}`);

if (!LIVE) {
  console.log('\n提示：设置 DDZ_LIVE=1 可以真的调一次模型验证链路。');
  process.exit(0);
}

const t0 = Date.now();
const reply = await friendReply({ persona, friend, text: '我今天有点累' });
console.log(`\n回复（${Date.now() - t0}ms，offline=${reply.offline}）：${reply.text}`);
console.log(`长度 ${reply.text.length} 字（要求不超过 ${25} 字左右）`);

const t1 = Date.now();
const res = await analyzeMessage({ persona, friend, text: '我叫阿伟，我喜欢喝奶茶', reply: reply.text });
console.log(`分析（${Date.now() - t1}ms，offline=${res.offline}）：delta=${res.delta}  memory=${JSON.stringify(res.memory)}`);
