import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, isReminderWindow } from './telegramReminders.js';

test('calculates the next calendar date without timezone drift', () => {
  assert.equal(addCalendarDays('2026-11-19', 1), '2026-11-20');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addCalendarDays('2024-02-28', 1), '2024-02-29');
});

test('runs reminders only inside the configured 15-minute window in the personal timezone', () => {
  assert.equal(isReminderWindow(new Date('2026-11-19T06:07:00.000Z'), 'Europe/Moscow', '09:00'), true);
  assert.equal(isReminderWindow(new Date('2026-11-19T06:14:00.000Z'), 'Europe/Moscow', '09:00'), true);
  assert.equal(isReminderWindow(new Date('2026-11-19T06:15:00.000Z'), 'Europe/Moscow', '09:00'), false);
  assert.equal(isReminderWindow(new Date('2026-11-19T05:59:00.000Z'), 'Europe/Moscow', '09:00'), false);
  assert.equal(isReminderWindow(new Date('2026-11-19T08:07:00.000Z'), 'Europe/Berlin', '09:00'), true);
});
