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

  it('rejects fractional, non-finite, empty, and whitespace-only page limits', () => {
    for (const limit of ['1.5', 'Infinity', '', '   ', '-1']) {
      const result = parseListPageQuery({ limit });
      assert.equal(result.requested, true, `limit ${JSON.stringify(limit)} requests pagination`);
      assert.equal(result.error, true, `limit ${JSON.stringify(limit)} must be rejected`);
    }
  });

  it('rejects oversized, non-canonical, and structurally invalid cursors', () => {
    const valid = encodeListCursor(new Date('2026-10-19T10:30:00.000Z'), 'expense_123');
    const invalidPayloads = [
      JSON.stringify({ timestamp: 'not-a-date', id: 'expense_123' }),
      JSON.stringify({ timestamp: '2026-10-19T10:30:00.000Z', id: '' }),
      JSON.stringify({ timestamp: '2026-10-19T10:30:00.000Z', id: 'expense_123', extra: true }),
    ];
    for (const payload of invalidPayloads) {
      const cursor = Buffer.from(payload, 'utf8').toString('base64url');
      assert.equal(parseListPageQuery({ cursor }).error, true);
    }
    assert.equal(parseListPageQuery({ cursor: `${valid}${'a'.repeat(513)}` }).error, true);
    assert.equal(parseListPageQuery({ cursor: `${valid}=` }).error, true);
  });

  it('rejects duplicate pagination query values instead of coercing arrays', () => {
    assert.equal(parseListPageQuery({ limit: ['10', '20'] }).error, true);
    assert.equal(parseListPageQuery({ cursor: [encodeListCursor(new Date(), 'expense_123')] }).error, true);
  });

  it('accepts both documented limit boundaries', () => {
    assert.deepEqual(parseListPageQuery({ limit: '1' }), {
      requested: true, error: false, limit: 1, cursor: null,
    });
    assert.deepEqual(parseListPageQuery({ limit: '500' }), {
      requested: true, error: false, limit: 500, cursor: null,
    });
  });
});
