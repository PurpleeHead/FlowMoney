export type CursorPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

/** Read every page from a cursor-paginated endpoint, stopping safely on malformed pagination. */
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
    const page: unknown = await fetchPage(cursor);
    if (
      page === null ||
      typeof page !== 'object' ||
      !Array.isArray((page as CursorPage<T>).items) ||
      typeof (page as CursorPage<T>).hasMore !== 'boolean' ||
      !(
        (page as CursorPage<T>).nextCursor === null ||
        typeof (page as CursorPage<T>).nextCursor === 'string'
      )
    ) {
      throw new Error('Export stopped because the API returned an invalid page response.');
    }

    const validPage = page as CursorPage<T>;
    items.push(...validPage.items);

    if (!validPage.hasMore) {
      if (validPage.nextCursor !== null) {
        throw new Error('Export stopped because the API returned a cursor for the final page.');
      }
      return items;
    }
    if (!validPage.nextCursor) {
      throw new Error('Export stopped because the API did not return a continuation cursor.');
    }
    if (seenCursors.has(validPage.nextCursor) || validPage.nextCursor === cursor) {
      throw new Error('Export stopped because the API returned a repeated continuation cursor.');
    }

    seenCursors.add(validPage.nextCursor);
    cursor = validPage.nextCursor;
  }

  throw new Error(`Export stopped after reaching the safety limit of ${maxPages} pages.`);
}

/** Quote a CSV cell and neutralize spreadsheet formula prefixes in untrusted text. */
export function toSafeCsvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const safeText = /^\s*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}
