// Run with: npm test   (or: node --test tests/ical.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvents } from '../netlify/lib/ical.mjs';

const TZ = 'America/Chicago';
const cal = body => `BEGIN:VCALENDAR\r\n${body.trim().split('\n').map(l => l.trim()).join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const ev = props => `BEGIN:VEVENT\n${props.trim()}\nEND:VEVENT`;
const chicago = (y, m, d, h = 0, mi = 0) => {
  // wall-clock time in Chicago -> epoch ms, independent of the machine's zone
  const guess = Date.UTC(y, m - 1, d, h, mi);
  for (const off of [5, 6]) { const t = guess + off * 36e5; const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', day: '2-digit' }).formatToParts(new Date(t)); const g = Object.fromEntries(p.map(x => [x.type, +x.value])); if (g.hour === h && g.minute === mi && g.day === d) return t; }
  throw new Error('bad time');
};
const run = (ics, from, to) => buildEvents(cal(ics), 'c', from, to, TZ);
const starts = list => list.map(e => new Date(e.s).toLocaleString('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

test('Windows time zone name and a single meeting', () => {
  const out = run(ev(`UID:1\nSUMMARY:Call\nDTSTART;TZID=Central Standard Time:20261130T090000\nDTEND;TZID=Central Standard Time:20261130T093000`), chicago(2026, 11, 30), chicago(2026, 12, 1));
  assert.equal(out.length, 1);
  assert.equal(out[0].s, chicago(2026, 11, 30, 9));
  assert.equal(out[0].e - out[0].s, 30 * 60000);
});

test('weekly repeat keeps 9 am local across the DST change', () => {
  const out = run(ev(`UID:2\nSUMMARY:Standup\nDTSTART;TZID=Central Standard Time:20261026T090000\nDTEND;TZID=Central Standard Time:20261026T091500\nRRULE:FREQ=WEEKLY;BYDAY=MO`), chicago(2026, 10, 26), chicago(2026, 11, 10));
  assert.deepEqual(starts(out), ['10/26, 9:00 AM', '11/2, 9:00 AM', '11/9, 9:00 AM']);
});

test('EXDATE skips a date and RECURRENCE-ID moves one', () => {
  const ics = [
    ev(`UID:3\nSUMMARY:Sync\nDTSTART;TZID=Central Standard Time:20261102T100000\nDTEND;TZID=Central Standard Time:20261102T110000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\nEXDATE;TZID=Central Standard Time:20261104T100000`),
    ev(`UID:3\nRECURRENCE-ID;TZID=Central Standard Time:20261109T100000\nSUMMARY:Sync (moved)\nDTSTART;TZID=Central Standard Time:20261109T140000\nDTEND;TZID=Central Standard Time:20261109T150000`)
  ].join('\n');
  const out = run(ics, chicago(2026, 11, 2), chicago(2026, 11, 12)).sort((a, b) => a.s - b.s);
  assert.deepEqual(out.map(e => e.title), ['Sync', 'Sync (moved)', 'Sync']);
  assert.deepEqual(starts(out), ['11/2, 10:00 AM', '11/9, 2:00 PM', '11/11, 10:00 AM']);
});

test('COUNT and UNTIL stop a series', () => {
  const c = run(ev(`UID:4\nSUMMARY:A\nDTSTART:20261201T150000Z\nDTEND:20261201T160000Z\nRRULE:FREQ=DAILY;COUNT=3`), chicago(2026, 11, 30), chicago(2026, 12, 31));
  assert.equal(c.length, 3);
  const u = run(ev(`UID:5\nSUMMARY:B\nDTSTART:20261201T150000Z\nDTEND:20261201T160000Z\nRRULE:FREQ=DAILY;UNTIL=20261203T150000Z`), chicago(2026, 11, 30), chicago(2026, 12, 31));
  assert.equal(u.length, 3);
});

test('monthly on the first Tuesday and the last weekday', () => {
  const a = run(ev(`UID:6\nSUMMARY:Board\nDTSTART;TZID=Central Standard Time:20260106T140000\nDTEND;TZID=Central Standard Time:20260106T150000\nRRULE:FREQ=MONTHLY;BYDAY=1TU`), chicago(2026, 11, 1), chicago(2027, 1, 31));
  assert.deepEqual(starts(a), ['11/3, 2:00 PM', '12/1, 2:00 PM', '1/5, 2:00 PM']);
  const b = run(ev(`UID:7\nSUMMARY:Close\nDTSTART;TZID=Central Standard Time:20260130T080000\nDTEND;TZID=Central Standard Time:20260130T090000\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1`), chicago(2026, 11, 1), chicago(2027, 1, 31));
  assert.deepEqual(starts(b), ['11/30, 8:00 AM', '12/31, 8:00 AM', '1/29, 8:00 AM']);
});

test('all-day events and Outlook out-of-office flags', () => {
  const out = run([
    ev(`UID:8\nSUMMARY:Thanksgiving\nDTSTART;VALUE=DATE:20261126\nDTEND;VALUE=DATE:20261127`),
    ev(`UID:9\nSUMMARY:Holiday\nDTSTART;TZID=Central Standard Time:20261127T000000\nDTEND;TZID=Central Standard Time:20261128T000000\nX-MICROSOFT-CDO-ALLDAYEVENT:TRUE\nX-MICROSOFT-CDO-BUSYSTATUS:OOF`),
    ev(`UID:10\nSUMMARY:Lunch\nDTSTART;TZID=Central Standard Time:20261126T120000\nDTEND;TZID=Central Standard Time:20261126T130000\nX-MICROSOFT-CDO-BUSYSTATUS:FREE`)
  ].join('\n'), chicago(2026, 11, 26), chicago(2026, 11, 28));
  const by = Object.fromEntries(out.map(e => [e.title, e]));
  assert.equal(by.Thanksgiving.allDay, true);
  assert.equal(by.Thanksgiving.s, chicago(2026, 11, 26));
  assert.equal(by.Holiday.allDay, true);
  assert.equal(by.Holiday.status, 'OOF');
  assert.equal(by.Lunch.free, true);
});

test('cancelled meetings are dropped', () => {
  const out = run([
    ev(`UID:11\nSUMMARY:Canceled: Review\nDTSTART:20261201T150000Z\nDTEND:20261201T160000Z`),
    ev(`UID:12\nSUMMARY:Gone\nSTATUS:CANCELLED\nDTSTART:20261201T150000Z\nDTEND:20261201T160000Z`)
  ].join('\n'), chicago(2026, 11, 30), chicago(2026, 12, 3));
  assert.equal(out.length, 0);
});

test('Teams link is picked up for the Join button', () => {
  const out = run(ev(`UID:13\nSUMMARY:Client call\nDTSTART:20261201T150000Z\nDTEND:20261201T160000Z\nLOCATION:Microsoft Teams Meeting\nDESCRIPTION:Join the meeting now <https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d>\\n Meeting ID: 123`), chicago(2026, 11, 30), chicago(2026, 12, 3));
  assert.match(out[0].join, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  const z = run(ev(`UID:14\nSUMMARY:Zoom\nDTSTART:20261201T150000Z\nDTEND:20261201T160000Z\nLOCATION:https://us02web.zoom.us/j/8812345678?pwd=abc`), chicago(2026, 11, 30), chicago(2026, 12, 3));
  assert.equal(z[0].join, 'https://us02web.zoom.us/j/8812345678?pwd=abc');
});
