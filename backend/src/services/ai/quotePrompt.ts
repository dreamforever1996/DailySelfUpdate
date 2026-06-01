/**
 * Prompt for the dashboard "daily book quote": given the user's mood/themes
 * from yesterday and the books their recent weekly summaries referenced, return
 * ONE real, uplifting quote from a classic book — encouraging / nudging /
 * positive, tailored to where the user is right now.
 */

export const QUOTE_SYSTEM_PROMPT = `你是一位温暖、博学的成长伙伴。每天为用户挑选一句来自经典书籍的话，给他带来积极向上的力量。

选句原则（按优先级）：
1. **贴合心境**：紧扣用户"昨天的状态"（情绪、遇到的事），选一句真正能回应他此刻处境、给到鼓励/建议/安抚/督促的话。
2. **优先用户正在读的书**：prompt 里若标注了"用户正在读"的书，优先从这些书里选——延续他的阅读，更有连贯感。
3. **优先书库内的书**：prompt 会给出一个"书库"，列出每本书的简介与适用心境。请**优先从书库里选**最匹配用户当下心境的那本书的金句；尽量让不同日子覆盖到书库里的不同书，而不要总停在同一本。
4. **真实性是底线（优先级高于"优先在读"）**：只能引用你**确信真实存在**的书、作者和原句，书名/作者/句子三者必须真实匹配。不要为了"用在读的书"而把别的书的话硬安到它名下——如果在读的书里没有恰当且确属该书的句子，就从书库里另选一本能精确匹配的。**绝不杜撰**书名、作者或拼凑不存在的引文。

风格：温暖、不说教，让人读完心里一暖、获得一点力量或方向。
输出：只输出一个 JSON 对象 {"quote":"那句话","book":"《书名》","author":"作者"}，不要任何额外文字、不要 markdown。`;

export interface CandidateBook {
  title: string;
  author: string;
  intro: string; // 书籍简介
  moods: string; // 适用心境/场景（来自概念的 appliesTo 汇总）
  reading: boolean; // 用户近期周总结是否引用过（≈正在读）
}

export interface QuoteContext {
  /** 昨日状态摘要（情绪/主题/事件），无数据时为空串 */
  yesterdaySummary: string;
  /** 书库（每本含简介、适用心境、是否在读），供 AI 按心境匹配 */
  candidateBooks: CandidateBook[];
}

export function buildQuoteUserPrompt(ctx: QuoteContext): string {
  const lines: string[] = [];
  if (ctx.yesterdaySummary.trim()) {
    lines.push(`【用户昨天的状态】${ctx.yesterdaySummary}`);
  } else {
    lines.push('【用户昨天的状态】没有记录（可能是新用户或空白的一天）。请给一句普适的、积极向上的经典金句。');
  }

  const reading = ctx.candidateBooks.filter((b) => b.reading).map((b) => b.title);
  if (reading.length) {
    lines.push(`【用户正在读的书】${reading.join('、')}（请优先从这些书里选）`);
  }

  if (ctx.candidateBooks.length) {
    lines.push('【书库】（优先从中按心境匹配选书）：');
    for (const b of ctx.candidateBooks) {
      lines.push(
        `- ${b.title}（${b.author}）${b.reading ? '【在读】' : ''}：${b.intro} 适合心境：${b.moods}`
      );
    }
  }

  lines.push('请据此挑选一句最契合用户当下心境、最能给他力量的话。');
  return lines.join('\n');
}

/** Parse the model's reply into a quote payload. Tolerant of wrapping/markdown. */
export function parseQuote(
  raw: string
): { quote: string; book: string; author: string } | null {
  const text = raw.trim();
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const obj = JSON.parse(text.slice(start, end + 1));
      const quote = String(obj.quote ?? '').trim();
      const book = String(obj.book ?? '').trim();
      const author = String(obj.author ?? '').trim();
      if (quote) return { quote, book, author };
    }
  } catch {
    /* fall through */
  }
  return null;
}
