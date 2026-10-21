import { describe, it, expect, vi } from 'vitest';
import { fetchAllCursorPages, toSafeCsvCell } from './paginated-export';

describe('fetchAllCursorPages', () => {
  it('loads every page, including histories larger than one API page', async () => {
    const fetchPage = vi.fn(async (cursor: string | null) => {
      if (cursor === null) return { items: Array.from({ length: 500 }, (_, i) => i), hasMore: true, nextCursor: 'page-2' };
      if (cursor === 'page-2') return { items: Array.from({ length: 125 }, (_, i) => i + 500), hasMore: false, nextCursor: null };
      throw new Error('Unexpected cursor');
    });

    const result = await fetchAllCursorPages(fetchPage);

    expect(result).toHaveLength(625);
    expect(result[0]).toBe(0);
    expect(result[624]).toBe(624);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, null);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'page-2');
  });

  it('fails closed if hasMore is true without a continuation cursor', async () => {
    await expect(fetchAllCursorPages(async () => ({
      items: [1], hasMore: true, nextCursor: null,
    }))).rejects.toThrow('did not return a continuation cursor');
  });

  it('stops if the API repeats a cursor', async () => {
    await expect(fetchAllCursorPages(async () => ({
      items: [1], hasMore: true, nextCursor: 'same',
    }))).rejects.toThrow('repeated continuation cursor');
  });

  it('enforces a maximum page count against broken pagination loops', async () => {
    const fetchPage = vi.fn(async (cursor: string | null) => ({
      items: [cursor ?? 'first'], hasMore: true, nextCursor: cursor === null ? 'next' : `next-${cursor}`,
    }));

    await expect(fetchAllCursorPages(fetchPage, 2)).rejects.toThrow('safety limit of 2 pages');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe('toSafeCsvCell', () => {
  it('quotes commas and doubles embedded quotes', () => {
    expect(toSafeCsvCell('Cafe, "Da Nang"')).toBe('"Cafe, ""Da Nang"""');
  });

  it.each(['=1+1', '+cmd|/C calc', '-1+1', '@SUM(A1:A2)', '  =HYPERLINK("https://example.invalid")'])(
    'neutralizes spreadsheet formula prefix %s',
    value => {
      expect(toSafeCsvCell(value).startsWith('"\'')).toBe(true);
    },
  );

  it('keeps ordinary values and empty cells unchanged', () => {
    expect(toSafeCsvCell('Groceries')).toBe('"Groceries"');
    expect(toSafeCsvCell(null)).toBe('""');
  });
});


describe('fetchAllCursorPages failure boundaries', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid maximum page count: %s',
    async maxPages => {
      const fetchPage = vi.fn(async () => ({ items: [1], hasMore: false, nextCursor: null }));
      await expect(fetchAllCursorPages(fetchPage, maxPages)).rejects.toThrow(
        'Maximum page count must be a positive safe integer.',
      );
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  it('propagates page-fetch failures without silently exporting partial data', async () => {
    const failure = new Error('network unavailable');
    const fetchPage = vi.fn(async (cursor: string | null) => {
      if (cursor === null) return { items: [1, 2], hasMore: true, nextCursor: 'page-2' };
      throw failure;
    });

    await expect(fetchAllCursorPages(fetchPage)).rejects.toBe(failure);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('returns an empty result when the first page is empty and terminal', async () => {
    const fetchPage = vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null }));
    await expect(fetchAllCursorPages(fetchPage)).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe('toSafeCsvCell control-character prefixes', () => {
  it.each(['\t=1+1', '\r@SUM(A1:A2)', '\n+cmd'])(
    'neutralizes formula-like content after leading control whitespace',
    value => {
      expect(toSafeCsvCell(value).startsWith('"\\'')).toBe(true);
    },
  );
});
