'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, next, describe, toLaunchd, CronError, LAUNCHD_MAX } = require('../lib/cron.js');

const sets = (c) => ({ minute: [...c.minute], hour: [...c.hour], dom: [...c.dom], month: [...c.month], dow: [...c.dow] });

test('parse: every field form', () => {
  const c = parse('0,30 7-9 * * 1-5');
  assert.deepEqual(sets(c).minute, [0, 30]);
  assert.deepEqual(sets(c).hour, [7, 8, 9]);
  assert.deepEqual(sets(c).dow, [1, 2, 3, 4, 5]);
  assert.deepEqual(c.restricted, { dom: false, dow: true });
  assert.deepEqual(sets(parse('*/15 9 * * *')).minute, [0, 15, 30, 45]);
  assert.deepEqual(sets(parse('0 8-20/4 * * *')).hour, [8, 12, 16, 20]);
  assert.deepEqual(sets(parse('5/20 9 * * *')).minute, [5, 25, 45]);
  assert.deepEqual(sets(parse('0 9 1,15 * *')).dom, [1, 15]);
  assert.deepEqual(sets(parse('0 9 * jan,jul *')).month, [1, 7]);
  assert.deepEqual(sets(parse('0 9 * * sun,SAT')).dow, [0, 6]);
  assert.deepEqual(sets(parse('0 9 * * 7')).dow, [0]);
  assert.equal(parse('  0   9 * * *  ').raw, '0 9 * * *');
});

test('parse: a full range means unrestricted', () => {
  assert.deepEqual(parse('0 9 1-31 * *').restricted, { dom: false, dow: false });
  assert.deepEqual(parse('0 9 * * 0-6').restricted, { dom: false, dow: false });
  assert.equal(parse('0 9 * * 0-7').restricted.dow, false);
});

test('parse: rejects malformed input with a CronError', () => {
  for (const bad of ['', '0 9 * *', '0 9 * * * *', '60 9 * * *', '0 24 * * *', '0 9 0 * *', '0 9 32 * *',
    '0 9 * 13 *', '0 9 * * 8', '0 9 * * mon-fri-sun', 'a 9 * * *', '0 9 * * mond', '*/0 * * * *', '10-5 * * * *',
    '0 9 1 * 1', '0,,5 * * * *']) {
    assert.throws(() => parse(bad), CronError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parse(42), CronError);
});

test('parse: cap boundary', () => {
  assert.throws(() => parse('*/15 * * * *'), /expands to 96/);
  assert.equal(toLaunchd('0 * * * *').length, 24);
  assert.equal(toLaunchd('0,30 0-23 * * *').length, 48);
  assert.throws(() => parse('0,15,30 * * * *'), /expands to 72/);
});

test('next: weekdays at 07:45 from a Friday evening skips the weekend', () => {
  const fri = new Date(2026, 8, 18, 20, 0);   // Fri 2026-09-18 20:00 local
  const [n1, n2] = next('45 7 * * 1-5', fri, 2);
  assert.deepEqual([n1.getDay(), n1.getHours(), n1.getMinutes(), n1.getDate()], [1, 7, 45, 21]);
  assert.deepEqual([n2.getDay(), n2.getDate()], [2, 22]);
});

test('next: strictly after, minute resolution, same-day earlier times skipped', () => {
  const at = new Date(2026, 8, 21, 13, 0, 30);
  const [n] = next('0 13 * * *', at);
  assert.equal(n.getDate(), 22);
  const [same] = next('0 13 * * *', new Date(2026, 8, 21, 12, 59));
  assert.equal(same.getDate(), 21);
});

test('next: month and year boundaries', () => {
  const [n] = next('0 9 1 * *', new Date(2026, 11, 31, 10, 0));   // Dec 31 → Jan 1 next year
  assert.deepEqual([n.getFullYear(), n.getMonth(), n.getDate()], [2027, 0, 1]);
  const [feb] = next('0 9 31 * *', new Date(2027, 0, 31, 10, 0));   // no Feb 31 → Mar 31
  assert.deepEqual([feb.getMonth(), feb.getDate()], [2, 31]);
  const [jul] = next('0 9 * jul *', new Date(2026, 8, 21));
  assert.deepEqual([jul.getFullYear(), jul.getMonth(), jul.getDate()], [2027, 6, 1]);
});

test('next: an impossible date returns an empty list rather than looping', () => {
  assert.deepEqual(next('0 9 30 feb *', new Date(2026, 0, 1)), []);
});

test('next: count and ordering', () => {
  const list = next('0 9,17 * * *', new Date(2026, 8, 21, 0, 0), 4);
  assert.equal(list.length, 4);
  for (let i = 1; i < list.length; i++) assert.ok(list[i] > list[i - 1]);
  assert.deepEqual(list.map(d => d.getHours()), [9, 17, 9, 17]);
});

test('describe: the common shapes', () => {
  assert.equal(describe('0 13 * * *'), 'Every day at 13:00');
  assert.equal(describe('45 7 * * 1-5'), 'Weekdays at 07:45');
  assert.equal(describe('0 18 * * 0'), 'Sundays at 18:00');
  assert.equal(describe('0 10 * * 6,0'), 'Weekends at 10:00');
  assert.equal(describe('0 9 * * 1,3,5'), 'Mon, Wed, Fri at 09:00');
  assert.equal(describe('0 9,17 * * *'), 'Every day at 09:00, 17:00');
  assert.equal(describe('0 9 1 * *'), 'Monthly on day 1 at 09:00');
  assert.equal(describe('0 9 1,15 * *'), 'Monthly on days 1, 15 at 09:00');
  assert.equal(describe('*/30 * * * *'), 'Every 30 minutes');
  assert.equal(describe('0 */6 * * *'), 'Every 6 hours');
  assert.equal(describe('15 * * * *'), 'Hourly at :15');
  assert.equal(describe('0 9 * jan *'), '0 9 * jan *');
  assert.equal(describe('not a cron'), 'not a cron');
});

test('toLaunchd: cross product of restricted fields, unrestricted keys omitted', () => {
  assert.deepEqual(toLaunchd('45 7 * * 1-5'), [1, 2, 3, 4, 5].map(Weekday => ({ Minute: 45, Hour: 7, Weekday })));
  assert.deepEqual(toLaunchd('0 13 * * *'), [{ Minute: 0, Hour: 13 }]);
  assert.deepEqual(toLaunchd('0 9 1,15 jan *'), [
    { Minute: 0, Hour: 9, Day: 1, Month: 1 }, { Minute: 0, Hour: 9, Day: 15, Month: 1 },
  ]);
  assert.deepEqual(toLaunchd('0,30 9 * * *'), [{ Minute: 0, Hour: 9 }, { Minute: 30, Hour: 9 }]);
});
