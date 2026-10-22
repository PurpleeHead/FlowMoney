import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeListCursor, listAfterCursor, parseListPageQuery } from './list-pagination.js';

describe('list pagination helpers', () => {
  it('keeps legacy list requests unpaged unless pagination is explicitly requested', () => {
    assert.deepEqual(parseListPageQuery({}), {
      requested: false, error: false, limit: 100, cursor: null,
    });
  });

  it('validates bounded page sizes and rejects malformed cursors', () => {
    assert.equal(parseListPageQuery({ limit: '0' }).error, true);
    assert.equal(parseListPageQuery({ limit: '501' }).error, true);
    assert.equal(parseListPageQuery({ cursor: 'not-a-cursor' }).error, true);
    assert.equal(parseListPageQuery({ cursor: 'e30=' }).error, true);
  });

  it('encodes and parses a stable timestamp/id cursor', () => {
    const timestamp = new Date('2026-10-19T10:30:00.000Z');
    const cursor = encodeListCursor(timestamp, 'expense_123');
    assert.deepEqual(parseListPageQuery({ limit: '25', cursor }), {
      requested: true,
      error: false,
      limit: 25,
      cursor: { timestamp: timestamp.toISOString(), id: 'expense_123' },
    });
  });

  it('creates a timestamp-first continuation filter with deterministic ID tie-break', () => {
    const cursor = { timestamp: '2026-10-19T10:30:00.000Z', id: 'expense_123' };
    assert.deepEqual(listAfterCursor('date', cursor), {
      OR: [
        { date: { lt: new Date(cursor.timestamp) } },
        { date: new Date(cursor.timestamp), id: { gt: cursor.id } },
      ],
    });
    assert.deepEqual(listAfterCursor('createdAt', null), {});
  });
});
