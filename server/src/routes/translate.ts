import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { auth } from '../middleware/auth.js';

const router = Router();
// Translation calls may fan out to external providers; cap requests before auth
// and provider work to limit resource consumption and upstream abuse.
router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many translation requests. Try again later.' },
}));
router.use(auth);

async function fetchTranslation(url: URL): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw lastError instanceof Error ? lastError : new Error('request failed');
}

const translationCache = new Map<string, string>();
function cacheTranslation(key: string, value: string): void {
  if (translationCache.size >= 1000 && !translationCache.has(key)) {
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) translationCache.delete(oldest);
  }
  translationCache.set(key, value);
}

async function translateLineWithFallback(line: string, source: string, target: string, failures: string[]): Promise<string> {
  const lineFailures: string[] = [];
  const cacheKey = `${source}|${target}|${line.trim().toLocaleLowerCase()}`;
  const cached = translationCache.get(cacheKey);
  if (cached) return cached;

  const googleUrl = new URL('https://translate.googleapis.com/translate_a/single');
  googleUrl.searchParams.set('client', 'gtx');
  googleUrl.searchParams.set('sl', source);
  googleUrl.searchParams.set('tl', target);
  googleUrl.searchParams.set('dt', 't');
  googleUrl.searchParams.set('q', line.slice(0, 450));
  try {
    const response = await fetchTranslation(googleUrl);
    const data = await response.json() as unknown[];
    const segments = Array.isArray(data[0]) ? data[0] as unknown[] : [];
    const translated = segments.map(segment => Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '').join('').trim();
    if (translated) {
      cacheTranslation(cacheKey, translated);
      return translated;
    }
    lineFailures.push('Google Translate returned an empty result');
  } catch (error) {
    lineFailures.push(`Google Translate: ${error instanceof Error ? error.message : 'request failed'}`);
  }

  const memorySources = source === 'auto' ? ['vi', 'en'] : [source];
  for (const memorySource of memorySources) {
    try {
      const memoryUrl = new URL('https://api.mymemory.translated.net/get');
      memoryUrl.searchParams.set('q', line.slice(0, 450));
      memoryUrl.searchParams.set('langpair', `${memorySource}|${target}`);
      const response = await fetchTranslation(memoryUrl);
      const data = await response.json() as { responseStatus?: number; responseData?: { translatedText?: string } };
      const value = data.responseData?.translatedText;
      if (value && data.responseStatus === 200 && !/MYMEMORY WARNING|PLEASE SELECT/i.test(value)) {
        const cleaned = value.replace(/\r?\n/g, ' ').trim();
        cacheTranslation(cacheKey, cleaned);
        return cleaned;
      }
      lineFailures.push(`MyMemory (${memorySource}): invalid response`);
    } catch (error) {
      lineFailures.push(`MyMemory (${memorySource}): ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }
  failures.push(...lineFailures);
  throw new Error('No translation provider succeeded');
}

async function translateWithFreeFallback(text: string, source: string, target: string): Promise<string> {
  const lines = text.split(/\r?\n/);
  const translated: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < lines.length; i += 4) {
    const batch = lines.slice(i, i + 4);
    translated.push(...await Promise.all(batch.map(async line =>
      line.trim() ? translateLineWithFallback(line, source, target, failures) : line
    )));
  }
  if (failures.length) throw new Error(failures.slice(0, 8).join('; '));
  return translated.join('\n');
}

async function translateWithConfiguredProvider(text: string, source: string, target: string): Promise<string> {
  const endpoint = process.env.TRANSLATE_URL;
  if (!endpoint) throw new Error('No configured provider');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.TRANSLATE_API_KEY ? { Authorization: `Bearer ${process.env.TRANSLATE_API_KEY}` } : {}) },
    body: JSON.stringify({ q: text, source, target, format: 'text', api_key: process.env.TRANSLATE_API_KEY || undefined }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Configured translation provider returned HTTP ${response.status}`);
  const data = await response.json() as { translatedText?: string };
  if (!data.translatedText) throw new Error('Configured translation provider returned an empty result');
  return data.translatedText;
}

router.post('/', async (req, res) => {
  const parsed = z.object({
    text: z.string().min(1).max(12000),
    source: z.string().default('vi'),
    target: z.string().default('ru'),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Provide text to translate (up to 12,000 characters).' });
    return;
  }
  try {
    let translatedText: string;
    if (process.env.TRANSLATE_URL) {
      try {
        translatedText = await translateWithConfiguredProvider(parsed.data.text, parsed.data.source, parsed.data.target);
      } catch {
        translatedText = await translateWithFreeFallback(parsed.data.text, parsed.data.source, parsed.data.target);
      }
    } else {
      translatedText = await translateWithFreeFallback(parsed.data.text, parsed.data.source, parsed.data.target);
    }
    res.json({ translatedText });
  } catch (error) {
    console.warn('[translate] Translation providers failed:', error instanceof Error ? error.message : 'unknown error');
    res.status(502).json({ message: 'Translation is temporarily unavailable. The original text and prices are unchanged; try again shortly.' });
  }
});

export default router;
