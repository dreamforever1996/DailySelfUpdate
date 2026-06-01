import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { getDailyRecords } from '../recordsService';
import { getSavedExtras } from '../analysisService';
import { OpenAiCompatibleProvider } from './openaiProvider';
import { ClaudeProvider } from './claudeProvider';
import type { AiProvider, ProviderName } from './types';
import { BOOKS } from './books';
import {
  QUOTE_SYSTEM_PROMPT,
  buildQuoteUserPrompt,
  parseQuote,
  type CandidateBook,
} from './quotePrompt';

export type UserTier = 'free' | 'vip';

export interface DailyQuote {
  quote: string;
  book: string;
  author: string;
  source: 'ai' | 'fallback';
}

// ---- provider selection (mirrors ai/index.ts, kept local for decoupling) ----
function makeProvider(name: ProviderName): AiProvider {
  if (name === 'claude') return new ClaudeProvider();
  return new OpenAiCompatibleProvider(name);
}
function providerForTier(tier: UserTier): AiProvider {
  const name = tier === 'vip' ? env.AI_VIP_PROVIDER : env.AI_FREE_PROVIDER;
  return makeProvider(name);
}

// ---- date helpers ----
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function yesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDate(d);
}
function thisMondayIso(): string {
  const d = new Date();
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return isoDate(d);
}

// ---- fallback quote pool (from our vetted BOOKS[].quotes) ----
interface FallbackQuote { quote: string; book: string; author: string }
const FALLBACK_QUOTES: FallbackQuote[] = (() => {
  const out: FallbackQuote[] = [];
  for (const b of BOOKS) {
    for (const c of b.concepts) {
      for (const q of c.quotes ?? []) {
        // Strip any trailing "——作者《书》" so we present cleanly.
        const clean = q.replace(/——.*$/, '').replace(/[“”]/g, '').trim();
        if (clean) out.push({ quote: clean, book: b.title, author: b.author });
      }
    }
  }
  return out;
})();

function pickFallback(): DailyQuote {
  const f =
    FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)] ?? {
      quote: '决定我们自身的不是过去的经历，而是我们自己赋予经历的意义。',
      book: '《被讨厌的勇气》',
      author: '岸见一郎',
    };
  return { ...f, source: 'fallback' };
}

// ---- yesterday summary for personalization ----
async function buildYesterdaySummary(userId: string): Promise<string> {
  try {
    const d = await getDailyRecords(userId, yesterdayIso());
    const parts: string[] = [];
    if (d.work.length) {
      const emotions = d.work.map((w) => w.emotion).filter(Boolean);
      parts.push(`工作 ${d.work.length} 条${emotions.length ? `（情绪：${[...new Set(emotions)].join('/')}）` : ''}`);
    }
    if (d.friends.length) parts.push(`朋友互动 ${d.friends.length} 条`);
    if (d.partner.length) {
      const unresolved = d.partner.filter((p) => p.interactionType === 'argument' && !p.resolved).length;
      parts.push(`伴侣互动 ${d.partner.length} 条${unresolved ? `（${unresolved} 次未解决争论）` : ''}`);
    }
    if (d.gratitude.length) parts.push(`感恩 ${d.gratitude.length} 条`);
    if (d.reflection) {
      const r = d.reflection;
      if (typeof r.overallRating === 'number') parts.push(`昨日整体评分 ${r.overallRating}/5`);
      const reflTexts = [r.morningGoal, r.noonCheck, r.eveningReflection].filter(Boolean);
      if (reflTexts.length) parts.push(`三省：${reflTexts.join('；').slice(0, 120)}`);
    }
    return parts.join('，');
  } catch (err) {
    logger.warn(`buildYesterdaySummary failed: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/**
 * Build the full book library for the prompt: every book in BOOKS with its
 * intro + the moods/scenes it fits (aggregated from concept.appliesTo), and a
 * `reading` flag for books the user's recent weekly summary referenced
 * (≈ books they're currently engaging with).
 */
async function candidateBooks(userId: string): Promise<CandidateBook[]> {
  let readingTitles = new Set<string>();
  try {
    const extras = await getSavedExtras(userId, thisMondayIso());
    readingTitles = new Set(
      (extras.referencedBooks as Array<{ title?: string }>)
        .map((b) => b?.title)
        .filter((t): t is string => !!t)
    );
  } catch {
    /* ignore — fall back to no "reading" marks */
  }

  return BOOKS.map((b) => {
    // Aggregate a few distinct moods/scenes this book speaks to.
    const moods = Array.from(
      new Set(b.concepts.flatMap((c) => c.appliesTo.split(/[、,，]/).map((s) => s.trim())))
    )
      .filter(Boolean)
      .slice(0, 6)
      .join('、');
    return {
      title: b.title,
      author: b.author,
      intro: (b.intro ?? '').slice(0, 120),
      moods,
      reading: readingTitles.has(b.title),
    };
  });
}

/**
 * Generate today's book quote, personalized to yesterday's records + recent
 * summary books. Never throws: any failure / AI disabled → vetted fallback.
 */
export async function generateDailyQuote(userId: string, tier: UserTier): Promise<DailyQuote> {
  if (!env.AI_ENABLED) return pickFallback();

  const provider = providerForTier(tier);
  if (!provider.isConfigured()) return pickFallback();

  const [yesterdaySummary, books] = await Promise.all([
    buildYesterdaySummary(userId),
    candidateBooks(userId),
  ]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);
  try {
    const raw = await provider.generate(
      {
        system: QUOTE_SYSTEM_PROMPT,
        user: buildQuoteUserPrompt({ yesterdaySummary, candidateBooks: books }),
      },
      controller.signal
    );
    // provider.generate returns string[] (parsed insights); join back to text.
    const text = Array.isArray(raw) ? raw.join('\n') : String(raw);
    const parsed = parseQuote(text);
    if (parsed) return { ...parsed, source: 'ai' };
    return pickFallback();
  } catch (err) {
    logger.warn(`Daily quote generation failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
    return pickFallback();
  } finally {
    clearTimeout(timer);
  }
}

// ---- in-process daily cache (per user, per UTC date) ----
const cache = new Map<string, { date: string; payload: DailyQuote }>();

export async function getDailyQuoteCached(
  userId: string,
  tier: UserTier,
  refresh: boolean
): Promise<DailyQuote> {
  const today = isoDate(new Date());
  const hit = cache.get(userId);
  if (!refresh && hit && hit.date === today) return hit.payload;
  const payload = await generateDailyQuote(userId, tier);
  cache.set(userId, { date: today, payload });
  return payload;
}
