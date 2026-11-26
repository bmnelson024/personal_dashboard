// GET /api/calendars?from=<ms>&to=<ms>&tz=<IANA zone>
// Reads the signed-in user's calendar links from Supabase (row level security
// limits it to their own rows), downloads each ICS feed server-side, and
// returns only the events in the requested window.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { buildEvents, validTz } from '../lib/ical.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Netlify ends synchronous functions at 10 seconds, so every feed must finish well inside that.
const FEED_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

// Refuse addresses inside private, loopback, link-local or cloud-metadata ranges.
function isPrivateAddress(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
}
async function assertPublicUrl(url) {
  if (url.protocol !== 'https:') throw new Error('Link must be a public https:// or webcal:// address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new Error('That calendar address could not be found.'); });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw new Error('Link must be a public https:// or webcal:// address.');
}
// Follow redirects by hand so every hop is checked, not just the first.
async function fetchFeed(raw, signal) {
  let url = new URL(raw.trim().replace(/^webcal:\/\//i, 'https://'));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { headers: { 'user-agent': 'PersonalDashboard/1.0' }, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url); continue; }
    return res;
  }
  throw new Error('The calendar link redirected too many times.');
}

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
      const res = await fetchFeed(c.url, AbortSignal.timeout(FEED_TIMEOUT_MS));
      if (!res.ok) throw new Error(`The calendar server answered ${res.status}. The link may have been unpublished.`);
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar. Use the ICS link, not the HTML one.');
      events.push(...buildEvents(text, c.id, from, to, tz));
    } catch (e) {
      errors[c.id] = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Outlook took too long to send this calendar. It will try again on the next refresh.' : String(e.message || e).slice(0, 200);
    }
  }));
  events.sort((a, b) => a.s - b.s);
  return json({ events, errors, fetchedAt: now });
};
