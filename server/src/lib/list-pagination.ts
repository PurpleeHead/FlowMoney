import { z } from 'zod';

const cursorSchema = z.object({
  timestamp: z.string().datetime(),
  id: z.string().min(1).max(128),
}).strict();

const limitSchema = z.coerce.number().int().min(1).max(500);
export type ListCursor = z.infer<typeof cursorSchema>;

export function parseListPageQuery(query: Record<string, unknown>) {
  const requested = query.limit !== undefined || query.cursor !== undefined;
  let limit = 100;
  if (query.limit !== undefined) {
    const parsedLimit = limitSchema.safeParse(query.limit);
    if (!parsedLimit.success) return { requested, error: true as const };
    limit = parsedLimit.data;
  }

  let cursor: ListCursor | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 512) {
      return { requested, error: true as const };
    }
    try {
      const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8');
      const parsed = cursorSchema.safeParse(JSON.parse(decoded));
      if (!parsed.success || Buffer.from(query.cursor, 'base64url').toString('base64url') !== query.cursor) {
        return { requested, error: true as const };
      }
      cursor = parsed.data;
    } catch {
      return { requested, error: true as const };
    }
  }
  return { requested, error: false as const, limit, cursor };
}

export function encodeListCursor(timestamp: Date, id: string): string {
  return Buffer.from(JSON.stringify({ timestamp: timestamp.toISOString(), id }), 'utf8').toString('base64url');
}

export function listAfterCursor(timestampField: 'date' | 'createdAt', cursor: ListCursor | null) {
  if (!cursor) return {};
  const timestamp = new Date(cursor.timestamp);
  return {
    OR: [
      { [timestampField]: { lt: timestamp } },
      { [timestampField]: timestamp, id: { gt: cursor.id } },
    ],
  };
}
