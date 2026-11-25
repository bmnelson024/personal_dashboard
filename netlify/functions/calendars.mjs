// GET /api/calendars?from=<ms>&to=<ms>&tz=<IANA zone>
// Reads the signed-in user's calendar links from Supabase (row level security
// limits it to their own rows), downloads each ICS feed server-side, and
// returns only the events in the requested window.
import { buildEvents, validTz } from '../lib/ical.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const BLOCKED_HOST = /^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|::1)/i;

export default async (req) => {
  const SUPABASE_URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !KEY) return json({ error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY.' }, 500);
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Not signed in.' }, 401);

  const q = new URL(req.url).searchParams;
  const now = Date.now();
  const from = Number(q.get('from')) || now - 864e5;
  const to = Math.min(Number(q.get('to')) || now + 8 * 864e5, from + 62 * 864e5);
  const tz = validTz(q.get('tz') || '') ? q.get('tz') : 'America/Chicago';

  const r = await fetch(`${SUPABASE_URL}/rest/v1/calendars?select=id,url,enabled`, { headers: { apikey: KEY, Authorization: auth } });
  if (r.status === 401) return json({ error: 'Session expired. Sign in again.' }, 401);
  if (!r.ok) return json({ error: 'Could not read your calendar list.' }, 502);
  const cals = (await r.json()).filter(c => c.enabled !== false && c.url);

  const events = [], errors = {};
  await Promise.all(cals.map(async c => {
    try {
      const url = new URL(c.url.trim().replace(/^webcal:\/\//i, 'https://'));
      if (url.protocol !== 'https:' || BLOCKED_HOST.test(url.hostname)) throw new Error('Link must be a public https:// or webcal:// address.');
      const res = await fetch(url, { headers: { 'user-agent': 'PersonalDashboard/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`The calendar server answered ${res.status}. The link may have been unpublished.`);
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar. Use the ICS link, not the HTML one.');
      events.push(...buildEvents(text, c.id, from, to, tz));
    } catch (e) {
      errors[c.id] = e.name === 'TimeoutError' ? 'The calendar took too long to respond.' : String(e.message || e).slice(0, 200);
    }
  }));
  events.sort((a, b) => a.s - b.s);
  return json({ events, errors, fetchedAt: now });
};
