export type CursorPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

/**
 * Read every page from a cursor-paginated endpoint.
 * Fails closed if the server claims more rows but cannot provide a usable cursor.
 */
export async function fetchAllCursorPages<T>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>,
  maxPages = 10_000,
): Promise<T[]> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('Maximum page count must be a positive safe integer.');
  }

  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(cursor);
    items.push(...page.items);

    if (!page.hasMore) return items;
    if (!page.nextCursor) {
      throw new Error('Export stopped because the API did not return a continuation cursor.');
    }
    if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) {
      throw new Error('Export stopped because the API returned a repeated continuation cursor.');
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new Error(`Export stopped after reaching the safety limit of ${maxPages} pages.`);
}

/** Quote a CSV cell and neutralize spreadsheet formula prefixes in untrusted text. */
export function toSafeCsvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const safeText = /^\s*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}
