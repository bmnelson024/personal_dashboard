// GET /cal/<token>.ics  (route set by config.path below)
// Publishes the built-in Personal calendar as a read-only iCalendar feed that
// phones, Outlook, Google Calendar or a Skylight can subscribe to.
// The token is a long random secret stored in settings.feed_token; the
// personal_feed() database function returns events only for a matching token.

const ZONES = {
  // US zones with the current US daylight-saving rule
  'America/Chicago': ['-0600', '-0500', 'CST', 'CDT'],
  'America/New_York': ['-0500', '-0400', 'EST', 'EDT'],
  'America/Denver': ['-0700', '-0600', 'MST', 'MDT'],
  'America/Los_Angeles': ['-0800', '-0700', 'PST', 'PDT'],
  'America/Phoenix': ['-0700', null, 'MST', null]
};
const vtimezone = tz => {
  const z = ZONES[tz]; if (!z) return [];
  const [std, dst, sn, dn] = z;
  const out = ['BEGIN:VTIMEZONE', `TZID:${tz}`, 'BEGIN:STANDARD', 'DTSTART:19701101T020000', `TZOFFSETFROM:${dst || std}`, `TZOFFSETTO:${std}`, `TZNAME:${sn}`];
  if (dst) out.push('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU');
  out.push('END:STANDARD');
  if (dst) out.push('BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', `TZOFFSETFROM:${std}`, `TZOFFSETTO:${dst}`, `TZNAME:${dn}`, 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT');
  out.push('END:VTIMEZONE');
  return out;
};
const text = v => String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
const d8 = iso => String(iso).slice(0, 10).replace(/[^0-9]/g, '');  // 2026-12-01 -> 20261201
const t6 = hm => (/^([01]\d|2[0-3]):[0-5]\d$/.test(hm || '') ? hm : '09:00').replace(':', '') + '00';    // 18:30 -> 183000
const addDay = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// Lines longer than 75 bytes are folded, as the iCalendar format requires.
const fold = line => { const out = []; let cur = '', bytes = 0; for (const ch of line) { const n = Buffer.byteLength(ch); if (bytes + n > 74) { out.push(cur); cur = ' '; bytes = 1; } cur += ch; bytes += n; } out.push(cur); return out.join('\r\n'); };

export default async (req) => {
  const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
  const url = new URL(req.url);
  const m = url.pathname.match(/\/cal\/([a-f0-9]{48,128})\.ics$/i);
  if (!m || !URL_ || !KEY) return new Response('Not found', { status: 404 });
  const tz = ZONES[url.searchParams.get('tz')] ? url.searchParams.get('tz') : 'America/Chicago';

  const r = await fetch(`${URL_}/rest/v1/rpc/personal_feed`, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }) });
  if (!r.ok) return new Response('Not found', { status: 404 });
  const rows = await r.json();

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Day Book//Personal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Personal (Day Book)', `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...vtimezone(tz)];
  for (const v of rows) {
    lines.push('BEGIN:VEVENT', `UID:${v.id}@daybook`, `DTSTAMP:${stamp}`, `SUMMARY:${text(v.title)}`);
    if (v.location) lines.push(`LOCATION:${text(v.location)}`);
    if (v.notes) lines.push(`DESCRIPTION:${text(v.notes)}`);
    let endDate = v.start_date;
    if (v.all_day) lines.push(`DTSTART;VALUE=DATE:${d8(v.start_date)}`, `DTEND;VALUE=DATE:${d8(addDay(v.start_date))}`);
    else {
      if ((v.end_time || '') <= (v.start_time || '')) endDate = addDay(v.start_date); // runs past midnight
      lines.push(`DTSTART;TZID=${tz}:${d8(v.start_date)}T${t6(v.start_time)}`, `DTEND;TZID=${tz}:${d8(endDate)}T${t6(v.end_time)}`);
    }
    const days = Array.isArray(v.repeat_days) ? v.repeat_days.filter(d => BYDAY[d]) : [];
    if (days.length) {
      lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${days.map(d => BYDAY[d]).join(',')}${v.repeat_until ? `;UNTIL=${v.all_day ? d8(v.repeat_until) : d8(addDay(v.repeat_until)) + 'T115959Z'}` : ''}`);
      for (const sk of v.skip_dates || []) lines.push(v.all_day ? `EXDATE;VALUE=DATE:${d8(sk)}` : `EXDATE;TZID=${tz}:${d8(sk)}T${t6(v.start_time)}`);
    }
    lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300', 'content-disposition': 'inline; filename="personal.ics"' }
  });
};

export const config = { path: '/cal/*' };
