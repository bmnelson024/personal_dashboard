// Minimal iCalendar (ICS) reader tuned for Outlook published calendars.
// Handles TZID (Windows and IANA names), all-day events, RRULE (daily, weekly,
// monthly, yearly incl. BYDAY ordinals / BYSETPOS / BYMONTHDAY), COUNT, UNTIL,
// EXDATE and moved occurrences (RECURRENCE-ID).

const WIN_TZ = {
  'Central Standard Time': 'America/Chicago', 'Eastern Standard Time': 'America/New_York',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina', 'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Central America Standard Time': 'America/Guatemala', 'Mexico Standard Time': 'America/Mexico_City',
  'Central Standard Time (Mexico)': 'America/Mexico_City', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Bucharest', 'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'Singapore Standard Time': 'Asia/Singapore'
};
const OFFSET_GUESS = {
  '-0600|-0500': 'America/Chicago', '-0500|-0400': 'America/New_York', '-0700|-0600': 'America/Denver',
  '-0800|-0700': 'America/Los_Angeles', '-0700|': 'America/Phoenix', '+0000|+0100': 'Europe/London',
  '+0100|+0200': 'Europe/Berlin', '+0000|': 'UTC'
};

export const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

let USER_TZ = 'America/Chicago';
const fmtCache = {};
function tzOffset(ms, tz) {
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function toEpoch(w, tz) {
  if (tz === 'UTC') return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (!tz || tz === 'local') tz = USER_TZ;
  const g = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let t = g - tzOffset(g, tz);
  const o2 = tzOffset(t, tz);
  if (g - o2 !== t) t = g - o2;
  return t;
}
const dnOf = (y, mo, d) => Math.round(Date.UTC(y, mo - 1, d) / 864e5);
const ymdOf = dn => { const x = new Date(dn * 864e5); return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const wdOf = dn => new Date(dn * 864e5).getUTCDay();
const unesc = v => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

function parseICS(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [], vtz = {}, stack = [];
  let cur = null, tzCur = null, sub = null;
  for (const line of lines) {
    if (!line) continue;
    let i = -1, q = false;
    for (let j = 0; j < line.length; j++) { const c = line[j]; if (c === '"') q = !q; else if (c === ':' && !q) { i = j; break; } }
    if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const parts = head.split(';'), name = parts[0].toUpperCase(), params = {};
    for (const p of parts.slice(1)) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
    if (name === 'BEGIN') {
      const v = value.toUpperCase(); stack.push(v);
      if (v === 'VEVENT' && stack.length === 2) cur = {};
      else if (v === 'VTIMEZONE') tzCur = { id: '', std: '', dst: '' };
      else if (tzCur && (v === 'STANDARD' || v === 'DAYLIGHT')) sub = v;
      continue;
    }
    if (name === 'END') {
      const v = stack.pop();
      if (v === 'VEVENT' && cur) { events.push(cur); cur = null; }
      else if (v === 'VTIMEZONE' && tzCur) { vtz[tzCur.id] = tzCur; tzCur = null; }
      else if (v === 'STANDARD' || v === 'DAYLIGHT') sub = null;
      continue;
    }
    if (cur && stack[stack.length - 1] === 'VEVENT') (cur[name] = cur[name] || []).push({ params, value });
    else if (tzCur) { if (name === 'TZID') tzCur.id = value; if (name === 'TZOFFSETTO' && sub) tzCur[sub === 'STANDARD' ? 'std' : 'dst'] = value; }
  }
  return { events, vtz };
}
function resolveTz(id, vtz) {
  if (!id) return 'local';
  if (WIN_TZ[id]) return WIN_TZ[id];
  if (/^[A-Za-z]+\/[A-Za-z_\/+-]+$/.test(id) && validTz(id)) return id;
  const v = vtz[id];
  if (v) { const g = OFFSET_GUESS[`${v.std}|${v.dst}`]; if (g) return g; }
  return 'local';
}
function parseDT(prop, vtz) {
  if (!prop) return null;
  const v = prop.value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || prop.params.VALUE === 'DATE') { m = m || v.match(/^(\d{4})(\d{2})(\d{2})/); return { date: true, y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 }; }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?/);
  if (!m) return null;
  return { date: false, y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0), tz: m[7] ? 'UTC' : resolveTz(prop.params.TZID, vtz) };
}
function parseDur(s) {
  const m = (s || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (((+m[2] || 0) * 7 + (+m[3] || 0)) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3);
}
const BYD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function monthDays(y, mo, rule, dt) {
  const first = dnOf(y, mo, 1), len = dnOf(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1) - first;
  let out = [];
  if (rule.BYMONTHDAY) {
    for (const x of rule.BYMONTHDAY.split(',')) { const n = +x; const d = n > 0 ? n : len + n + 1; if (d >= 1 && d <= len) out.push(first + d - 1); }
  } else if (rule.BYDAY) {
    for (const tok of rule.BYDAY.split(',')) {
      const m = tok.match(/^([+-]?\d+)?([A-Z]{2})$/); if (!m) continue;
      const wd = BYD[m[2]], all = [];
      for (let d = 0; d < len; d++) if (wdOf(first + d) === wd) all.push(first + d);
      if (m[1]) { const n = +m[1]; const pick = n > 0 ? all[n - 1] : all[all.length + n]; if (pick !== undefined) out.push(pick); }
      else out.push(...all);
    }
  } else if (dt.d <= len) out.push(first + dt.d - 1);
  out.sort((a, b) => a - b);
  if (rule.BYSETPOS) {
    const sel = [];
    for (const x of rule.BYSETPOS.split(',')) { const n = +x; const v = n > 0 ? out[n - 1] : out[out.length + n]; if (v !== undefined) sel.push(v); }
    out = sel.sort((a, b) => a - b);
  }
  return out;
}
function expandDays(rule, dt, endDn) {
  const startDn = dnOf(dt.y, dt.mo, dt.d), iv = Math.max(1, +rule.INTERVAL || 1), out = [], freq = rule.FREQ;
  let guard = 0;
  const push = list => { for (const dn of list) if (dn >= startDn) out.push(dn); };
  if (freq === 'DAILY') {
    const byd = rule.BYDAY ? rule.BYDAY.split(',').map(t => BYD[t.slice(-2)]) : null;
    for (let dn = startDn; dn <= endDn && guard++ < 60000; dn += iv) { if (!byd || byd.includes(wdOf(dn))) out.push(dn); if (rule._stop && rule._stop(out)) break; }
  } else if (freq === 'WEEKLY') {
    const wk = BYD[rule.WKST || 'MO'];
    const days = rule.BYDAY ? rule.BYDAY.split(',').map(t => BYD[t.slice(-2)]) : [wdOf(startDn)];
    const ws = startDn - ((wdOf(startDn) - wk + 7) % 7);
    for (let w = ws; w <= endDn && guard++ < 20000; w += 7 * iv) { push(days.map(d => w + ((d - wk + 7) % 7)).sort((a, b) => a - b)); if (rule._stop && rule._stop(out)) break; }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    let y = dt.y, mo = dt.mo;
    const months = freq === 'YEARLY' ? (rule.BYMONTH ? rule.BYMONTH.split(',').map(Number) : [dt.mo]) : null;
    while (dnOf(y, freq === 'YEARLY' ? 1 : mo, 1) <= endDn && guard++ < 5000) {
      if (freq === 'MONTHLY') { push(monthDays(y, mo, rule, dt)); mo += iv; while (mo > 12) { mo -= 12; y++; } }
      else { for (const m of months) push(monthDays(y, m, rule, dt)); y += iv; }
      if (rule._stop && rule._stop(out)) break;
    }
  }
  return out.filter(dn => dn <= endDn);
}

// Online meeting links: Teams, Zoom, Google Meet, Webex, GoTo.
const JOIN_HOST = /(^|\.)(teams\.microsoft\.com|teams\.live\.com|zoom\.us|zoomgov\.com|meet\.google\.com|webex\.com|gotomeeting\.com|meet\.goto\.com)$/i;
function findJoin(e, val) {
  const sources = ['X-MICROSOFT-SKYPETEAMSMEETINGURL', 'X-MICROSOFT-ONLINEMEETINGCONFLINK', 'X-MICROSOFT-ONLINEMEETINGEXTERNALLINK', 'URL', 'LOCATION', 'DESCRIPTION'];
  for (const name of sources) {
    const text = (val(e, name) || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
    for (const m of text.matchAll(/https:\/\/[^\s<>"')\]]+/gi)) {
      try { const u = new URL(m[0].replace(/[.,;]+$/, '')); if (JOIN_HOST.test(u.hostname) && u.pathname.length > 1) return u.href; } catch {}
    }
  }
  return '';
}

/** Events from one ICS feed overlapping [fromMs, toMs), with times as epoch ms. */
export function buildEvents(text, calId, fromMs, toMs, tz) {
  USER_TZ = tz && validTz(tz) ? tz : 'America/Chicago';
  const { events, vtz } = parseICS(text);
  const val = (e, n) => (e[n] ? e[n][0].value : '');
  const overrides = new Set(), out = [];
  const endDn = Math.floor((toMs + tzOffset(toMs, USER_TZ)) / 864e5) + 1;
  const keyRid = (uid, w) => uid + '|' + (w.date ? `${w.y}-${w.mo}-${w.d}` : toEpoch(w, w.tz));
  for (const e of events) { const rid = parseDT(e['RECURRENCE-ID'] && e['RECURRENCE-ID'][0], vtz); if (rid) overrides.add(keyRid(val(e, 'UID'), rid)); }
  const emit = (e, w, durMs, durDays) => {
    const title = unesc(val(e, 'SUMMARY')) || '(No title)';
    if (/^(canceled|cancelled):/i.test(title)) return;
    const allDay = !!w.date || /^TRUE$/i.test(val(e, 'X-MICROSOFT-CDO-ALLDAYEVENT'));
    let s, en;
    if (allDay) {
      s = toEpoch({ ...w, h: 0, mi: 0, s: 0 }, 'local');
      const endYmd = ymdOf(dnOf(w.y, w.mo, w.d) + Math.max(1, durDays));
      en = toEpoch({ ...endYmd, h: 0, mi: 0, s: 0 }, 'local');
    } else { s = toEpoch(w, w.tz); en = s + Math.max(0, durMs); }
    if (en <= fromMs && !(en === s && s >= fromMs)) return;
    if (s >= toMs) return;
    // Outlook's "Show as": FREE, TENTATIVE, BUSY or OOF (out of office)
    const status = (val(e, 'X-MICROSOFT-CDO-BUSYSTATUS') || val(e, 'X-MICROSOFT-CDO-INTENDEDSTATUS') || '').toUpperCase();
    const free = status === 'FREE' || (!status && /^TRANSPARENT$/i.test(val(e, 'TRANSP')));
    out.push({ cal: calId, title, loc: unesc(val(e, 'LOCATION')), allDay, s, e: en, free, status, join: findJoin(e, val) });
  };
  for (const e of events) {
    if (/CANCELLED/i.test(val(e, 'STATUS'))) continue;
    const st = parseDT(e.DTSTART && e.DTSTART[0], vtz); if (!st) continue;
    const enW = parseDT(e.DTEND && e.DTEND[0], vtz);
    let durMs = 0, durDays = 1;
    if (st.date) durDays = enW ? Math.max(1, dnOf(enW.y, enW.mo, enW.d) - dnOf(st.y, st.mo, st.d)) : Math.max(1, Math.round(parseDur(val(e, 'DURATION')) / 864e5) || 1);
    else durMs = enW ? toEpoch(enW, enW.tz) - toEpoch(st, st.tz) : parseDur(val(e, 'DURATION'));
    const rr = val(e, 'RRULE');
    if (!rr || e['RECURRENCE-ID']) { emit(e, st, durMs, durDays); continue; }
    const rule = {};
    for (const p of rr.split(';')) { const [k, v] = p.split('='); if (k) rule[k.toUpperCase()] = (v || '').toUpperCase(); }
    const count = rule.COUNT ? +rule.COUNT : 0;
    let untilMs = Infinity;
    if (rule.UNTIL) {
      const u = parseDT({ value: rule.UNTIL, params: {} }, vtz);
      if (u) untilMs = u.date ? toEpoch({ ...ymdOf(dnOf(u.y, u.mo, u.d) + 1), h: 0, mi: 0, s: 0 }, 'local') - 1 : toEpoch(u, u.tz === 'local' ? st.tz : u.tz);
    }
    if (count) rule._stop = list => list.length >= count;
    let days = expandDays(rule, st, endDn);
    if (count) days = days.slice(0, count);
    const ex = new Set();
    for (const x of e.EXDATE || []) for (const v of x.value.split(',')) {
      const w = parseDT({ value: v, params: x.params }, vtz);
      if (w) ex.add(w.date ? `${w.y}-${w.mo}-${w.d}` : String(toEpoch(w, w.tz)));
    }
    const uid = val(e, 'UID');
    for (const dn of days) {
      const w = { ...st, ...ymdOf(dn) };
      const ms = st.date ? toEpoch({ ...w, h: 0, mi: 0, s: 0 }, 'local') : toEpoch(w, w.tz);
      if (ms > untilMs) break;
      if (ex.has(st.date ? `${w.y}-${w.mo}-${w.d}` : String(ms))) continue;
      if (overrides.has(keyRid(uid, w))) continue;
      emit(e, w, durMs, durDays);
    }
  }
  return out;
}
