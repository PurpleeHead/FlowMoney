import { describe, it, expect, vi } from 'vitest';
import { fetchAllCursorPages } from './paginated-export';

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
