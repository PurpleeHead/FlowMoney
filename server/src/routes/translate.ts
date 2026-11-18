import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { auth } from '../middleware/auth.js';

const router = Router();
router.use(auth);
router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
}));

const MAX_TRANSLATION_LINES = 80;
const translationRequest = z.object({
  text: z.string().min(1).max(12000),
  source: z.string().default('vi'),
  target: z.string().default('ru'),
}).superRefine(({ text }, context) => {
  const nonEmptyLines = text.split(/\r?\n/).filter(line => line.trim()).length;
  if (nonEmptyLines > MAX_TRANSLATION_LINES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['text'],
      message: \`Text must contain no more than \${MAX_TRANSLATION_LINES} non-empty lines.\`,
    });
  }
});

async function translateWithConfiguredProvider(text: string, source: string, target: string): Promise<string> {
  const endpoint = process.env.TRANSLATE_URL;
  if (!endpoint) throw new Error('No configured provider');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.TRANSLATE_API_KEY ? { 'Authorization': \`Bearer \${process.env.TRANSLATE_API_KEY}\` } : {}),
    },
    body: JSON.stringify({ q: text, source, target, format: 'text', api_key: process.env.TRANSLATE_API_KEY || undefined }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Translation provider returned an error');
  const data = await response.json() as { translatedText?: string };
  if (!data.translatedText) throw new Error('Unexpected translation provider response');
  return data.translatedText;
}

function splitLine(line: string, maxLength = 450): string[] {
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < Math.floor(maxLength / 2)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\s+/, '');
  }
  chunks.push(remaining);
  return chunks;
}

async function translateWithFreeFallback(text: string, source: string, target: string): Promise<string> {
  const lines = text.split(/\r?\n/);
  const chunksByLine = lines.map(line => line.trim() ? splitLine(line) : null);
  const tasks = chunksByLine.flatMap(chunks => chunks ?? []);
  const translatedChunks = new Array<string>(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const taskIndex = cursor++;
      const chunk = tasks[taskIndex];
      const url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', chunk);
      url.searchParams.set('langpair', \`\${source}|\${target}\`);
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Free translation fallback is unavailable');
      const data = await response.json() as { responseStatus?: number; responseData?: { translatedText?: string } };
      const value = data.responseData?.translatedText;
      if (!value || data.responseStatus !== 200) throw new Error('Free translation fallback returned no translation');
      translatedChunks[taskIndex] = value.replace(/\r?\n/g, ' ').trim();
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()));

  let translatedIndex = 0;
  return chunksByLine.map((chunks, lineIndex) => {
    if (!chunks) return lines[lineIndex];
    const translatedLine = translatedChunks.slice(translatedIndex, translatedIndex + chunks.length).join(' ');
    translatedIndex += chunks.length;
    return translatedLine;
  }).join('\n');
}

router.post('/', async (req, res) => {
  const parsed = translationRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Provide text to translate (up to 12,000 characters and 80 non-empty lines).' });
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
  } catch {
    res.status(502).json({ message: 'Translation failed. Check the connection and try again; the original text and prices have not been changed.' });
  }
});

export default router;
