/**
 * 好友私聊专用语料（PRD §2.12）
 *
 * 为什么单独一套：personas.js 里的 15 个场景全是**牌桌台词**（"我来了，直接开局""要不起"），
 * 一旦把它当成好友聊天的兜底，就会出现"好友在微信里喊开局"这种穿帮。
 * 这里只放**私聊口气**的话，按人设风格分档，并按语义分桶。
 */

/** 主动开场（每局结束后好友来搭话、以及刚加好友时的第一句） */
export const CHAT_OPENERS = {
  aggressive: ['在干嘛呢', '上号吗，我等你', '刚那把我不服，再来一局', '今天手气怎么样', '忙完了没'],
  balanced: ['在忙吗？', '刚打完一局，歇会儿', '今天过得咋样', '有空聊两句吗', '刚那局有点可惜'],
  cautious: ['在吗，不打扰你吧', '刚那局我打得不怎么样', '你今天还好吗', '有空的话聊会儿', '我是不是拖后腿了'],
};

/** 通用回应（不知道说什么时的自然接话） */
export const CHAT_REPLIES = {
  aggressive: ['行，听你的', '哈哈可以', '我就随口一说', '你这话我爱听', '等着，我记下了'],
  balanced: ['嗯嗯，我在听', '是这样啊', '原来如此', '挺好的', '然后呢？'],
  cautious: ['啊，是这样', '我不太懂，你多说点', '嗯…我想想', '好，我知道了', '抱歉，刚走神了'],
};

/** 按语义分桶的回应，更贴题 */
export const CHAT_BUCKETS = {
  // 刚被加为好友时的第一句（由对方先开口）
  added: {
    aggressive: ['哟，找我打牌？', '行，加我就常来', '谁啊，报个名'],
    balanced: ['嗯？你加我啦', '嗨，认识一下', '呀，好久没人加我了'],
    cautious: ['你…你好', '是我吗？有点意外', '啊，谢谢你加我'],
  },
  praise: {
    aggressive: ['少来，我本来就强', '行，你眼光不错', '这话我收下了'],
    balanced: ['谢谢，你也挺好的', '你人真好', '被你这么一说还挺开心'],
    cautious: ['别夸我，我会飘', '谢谢…有点不好意思', '哪有，我还差得远'],
  },
  insult: {
    aggressive: ['你再说一遍试试', '行，你赢了', '火气这么大？'],
    balanced: ['你今天心情不好？', '有话好好说', '我哪惹你了'],
    cautious: ['对不起…是我不好', '我是不是惹你生气了', '那我先不说了'],
  },
  question: {
    aggressive: ['你猜', '这个嘛，得看情况', '问这么多干嘛'],
    balanced: ['我想想啊', '不太好说，看你怎么看', '你怎么突然问这个'],
    cautious: ['我也说不好', '这个…你觉得呢', '我可能帮不上忙'],
  },
  greeting: {
    aggressive: ['在，有事说', '来了来了', '哟，稀客'],
    balanced: ['在的，你好呀', '嗨，好久没聊了', '在呢，正好闲着'],
    cautious: ['在…你好', '你好，我在的', '嗯，我在'],
  },
  emoji: {
    aggressive: ['哈哈，你够了', '这表情绝了', '发这个什么意思'],
    balanced: ['哈哈可爱', '你发这个我懂了', '哈哈，我笑了'],
    cautious: ['嘿嘿', '你开心就好', '……嗯'],
  },
  news: {
    aggressive: ['真的假的', '那你可得请客', '厉害啊你'],
    balanced: ['挺好的呀', '那不错', '替你高兴'],
    cautious: ['哇…', '那你要注意身体', '嗯，挺好的'],
  },
  /**
   * ★ 恋人专属的主动搭话（用户拍板）：
   *   模型不可用时，恋人不能还是那句"在忙吗？" —— 允许表达想念、说一句心事，
   *   但**别腻、别每句都提关系**（所以这里也只放"想你了 / 今天有点累"这种程度的话）。
   *   只有真恋人（save.loverId）走得到这个桶，普通好友拿不到（见 ai/friend.js 的 localGreeting）。
   */
  lover: {
    aggressive: ['想你了，什么时候上线', '今天有点烦，想跟你说说话', '在忙吗，我想你了', '刚看到个东西就想起你'],
    balanced: ['想你了', '今天有点累，想跟你说说话', '刚忙完，突然很想你', '你最近怎么样，我有点想你'],
    cautious: ['…想你了', '今天心里有点乱，想跟你聊聊', '你在的话，回我一句好不好', '有点想你了，没别的事'],
  },
  // 房间里等人开局的弹幕（游戏还没开始，聊的是人、约战和等待）
  room: {
    aggressive: ['人齐了就开，别磨蹭', '就差你一个了', '来啊，谁怕谁', '今天我要把上次的赢回来'],
    balanced: ['二缺一，来一个', '人齐了叫我一声', '等你们好久了', '开局前先聊两句'],
    cautious: ['人还没齐吗', '你们先聊，我在的', '我都准备好了', '还差一个人'],
  },
};

const POSITIVE = ['谢谢', '厉害', '好棒', '喜欢', '可爱', '佩服', '辛苦', '加油', '真好', '开心', '爱你'];
const NEGATIVE = ['笨', '滚', '讨厌', '闭嘴', '垃圾', '蠢', '烦', '差劲', '废物', '恶心'];
const QUESTION = ['？', '?', '吗', '呢', '多少', '怎么', '为啥', '为什么', '什么时候'];
const GREETING = ['你好', '在吗', '嗨', '哈喽', '早', '晚安', '在不在'];
const NEWS = ['我考上', '我赢了', '我输了', '我今天', '我昨天', '刚吃', '我刚', '我买了', '放假', '加班', '出差', '生病'];

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;

/** 判断这句话属于哪个语义桶 */
export function chatBucket(text) {
  const t = String(text || '').trim();
  if (!t) return 'generic';
  if (EMOJI_ONLY.test(t)) return 'emoji';
  if (NEGATIVE.some((w) => t.includes(w))) return 'insult';
  if (POSITIVE.some((w) => t.includes(w))) return 'praise';
  if (QUESTION.some((w) => t.includes(w))) return 'question';
  if (GREETING.some((w) => t.includes(w))) return 'greeting';
  if (NEWS.some((w) => t.includes(w))) return 'news';
  return 'generic';
}

const recent = new Map();

/**
 * 取一句私聊台词
 * @param {'opener'|'generic'|'praise'|'insult'|'question'|'greeting'|'emoji'|'news'} kind
 * @param {'aggressive'|'balanced'|'cautious'} style
 * @param {number} memoryLimit 最近说过的不重复记几句
 * @param {Function|null} filter 可选：过滤掉不合适的句子（例如"没一起打过那局"时不许提牌局）
 */
export function pickChatLine(kind, style = 'balanced', memoryLimit = 14, filter = null) {
  const key = `${kind}:${style}`;
  let pool;
  if (kind === 'opener') pool = CHAT_OPENERS[style];
  else if (kind === 'generic') pool = CHAT_REPLIES[style];
  else pool = (CHAT_BUCKETS[kind] || {})[style];
  if (!pool || !pool.length) pool = CHAT_REPLIES[style] || ['嗯嗯'];
  // 过滤后一句不剩就退回原池：宁可说一句不完全贴题的，也不能哑巴
  if (typeof filter === 'function') {
    const kept = pool.filter(filter);
    if (kept.length) pool = kept;
  }
  const used = recent.get(key) || [];
  const fresh = pool.filter((l) => !used.includes(l));
  const list = fresh.length ? fresh : pool;
  const line = list[Math.floor(Math.random() * list.length)];
  const nextUsed = fresh.length ? [...used, line] : [line];
  recent.set(key, nextUsed.slice(-memoryLimit));
  return line;
}
