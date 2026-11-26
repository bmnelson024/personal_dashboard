import { createClient } from '/vendor/supabase-2.45.4.js'; // bundled copy of @supabase/supabase-js 2.45.4 (see README)

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_AREAS = [
  { id: 'wo', name: 'White Oak', color: '#2e6f8e' },
  { id: 'n6', name: 'N6 Consulting', color: '#e3120b' },
  { id: 'orion', name: 'LVC Consulting', color: '#6a4fb0' },
  { id: 'fx', name: 'FolioExcel', color: '#0f8a8a' },
  { id: 'me', name: 'Personal', color: '#5b6670' }
];
const CAL_COLORS = ['#2e6f8e', '#e3120b', '#6a4fb0', '#b4681c', '#0f8a8a', '#5b6670'];
const S = { pev: [], remote: [], tasks: [], areas: DEFAULT_AREAS, filter: 'all', search: '', cals: [], events: [], calState: 'init', calErr: {}, calAt: null, tasksState: 'loading', session: null, lastArea: null };
let sb = null;

/* ---------- local cache, for instant paint and offline viewing ---------- */
const cache = {
  get(k) { try { return JSON.parse(localStorage.getItem('db:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('db:' + k, JSON.stringify(v)); } catch {} }
};

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const todayD = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const todayK = () => keyOf(todayD());
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dueLabel(k) {
  const diff = Math.round((fromKey(k) - todayD()) / 864e5);
  if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow'; if (diff === -1) return 'Yesterday';
  const d = fromKey(k);
  if (diff > 1 && diff < 7) return WD[d.getDay()];
  return `${MO[d.getMonth()]} ${d.getDate()}`;
}
function timeParts(ms) {
  const d = new Date(ms); let h = d.getHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
  return [`${h}:${pad(d.getMinutes())}`, ap];
}
const timeStr = ms => timeParts(ms).join(' ');
// Hold blocks Brian adds so one company can't book over another's meeting. Hidden from the dashboard's upcoming list only.
const isBlocker = e => /^\s*unavailable\b/i.test(e.title || '');
// Out-of-office and whole-day holds aren't meetings: Outlook "Show as: Out of office", or a block of 10+ hours.
const isLong = e => !e.allDay && e.e - e.s >= 10 * 36e5;
const isAway = e => e.status === 'OOF' || isLong(e) || /^\s*(out of (the )?office|ooo|pto|vacation|holiday)\b/i.test(e.title || '');
const dayLevel = e => e.allDay || isLong(e);
// Calendars Brian uses Unavailable blocks on. Remembered across loads so a quiet week doesn't drop one.
const blockCals = new Set(JSON.parse(localStorage.getItem('db:blockCals') || '[]'));
/* Returns Map(event -> [calendar ids missing an Unavailable]) for bookings that still need one. */
function findGaps(events) {
  let grew = false;
  for (const e of events) if (isBlocker(e)) for (const c of e.cals) if (!blockCals.has(c)) { blockCals.add(c); grew = true; }
  if (grew) { try { localStorage.setItem('db:blockCals', JSON.stringify([...blockCals])); } catch {} }
  const cover = {};
  for (const e of events) if (isBlocker(e) && !e.allDay) for (const c of e.cals) (cover[c] = cover[c] || []).push([e.s, e.e]);
  for (const c in cover) { // merge back-to-back blocks so two half-hour holds cover an hour meeting
    const l = cover[c].sort((x, y) => x[0] - y[0]), m = [];
    for (const r of l) { const t = m[m.length - 1]; if (t && r[0] <= t[1] + 60000) t[1] = Math.max(t[1], r[1]); else m.push([...r]); }
    cover[c] = m;
  }
  const covered = (c, s, e) => (cover[c] || []).some(([a, b]) => a <= s + 60000 && b >= e - 60000);
  const gaps = new Map(), now = Date.now();
  for (const e of events) {
    if (e.personal || isBlocker(e) || isAway(e) || e.allDay || e.free || e.e <= now) continue;
    // a calendar is checked only if it's shown and its 'Check for Unavailable blocks' switch is on
    const miss = [...blockCals].filter(c => !e.cals.includes(c) && S.cals.some(x => x.id === c && x.on !== false && x.needs !== false) && !covered(c, e.s, e.e));
    if (miss.length) gaps.set(e, miss);
  }
  return gaps;
}

/* ---------- calendars ---------- */
function dedupe(list) {
  const seen = new Map();
  for (const ev of list) {
    const k = ev.title.toLowerCase() + '|' + ev.s + '|' + ev.e;
    if (seen.has(k)) { const m = seen.get(k); if (!m.cals.includes(ev.cal)) m.cals.push(ev.cal); }
    else seen.set(k, { ...ev, cals: [ev.cal] });
  }
  return [...seen.values()].sort((a, b) => a.s - b.s);
}
/* ---------- built-in Personal calendar (stored in Supabase) ---------- */
const PERSONAL = { id: 'personal', name: 'Personal', color: '#d9480f', builtin: true };
const allCals = () => [PERSONAL, ...S.cals];
const hasCals = () => S.cals.length > 0 || S.pev.length > 0;
const pevFromRow = r => ({ id: r.id, title: r.title, loc: r.location || '', notes: r.notes || '', allDay: !!r.all_day, date: r.start_date, start: r.start_time || '09:00', end: r.end_time || '10:00', days: r.repeat_days || null, until: r.repeat_until || null, skip: r.skip_dates || [] });
const pevToRow = v => ({ id: v.id, title: v.title, location: v.loc, notes: v.notes, all_day: v.allDay, start_date: v.date, start_time: v.allDay ? null : v.start, end_time: v.allDay ? null : v.end, repeat_days: v.days && v.days.length ? v.days : null, repeat_until: v.until || null, skip_dates: v.skip || [] });
/* Occurrences of personal events overlapping [from, to), shaped like calendar events. */
function expandPersonal(from, to) {
  const out = [];
  for (const v of S.pev) {
    const first = fromKey(v.date), last = v.days ? (v.until ? fromKey(v.until) : new Date(to)) : first;
    for (let d = new Date(Math.max(first, addDays(new Date(from), -1))); d <= last && d < new Date(to); d = addDays(d, 1)) {
      const k = keyOf(d);
      if (v.days ? !v.days.includes(d.getDay()) : k !== v.date) continue;
      if (v.skip.includes(k)) continue;
      let s, e;
      if (v.allDay) { s = d.getTime(); e = addDays(d, 1).getTime(); }
      else {
        const [sh, sm] = v.start.split(':').map(Number), [eh, em] = v.end.split(':').map(Number);
        s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm).getTime();
        e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em).getTime(); if (e <= s) e += 864e5;
      }
      if (e <= +from || s >= +to) continue;
      out.push({ cal: 'personal', cals: ['personal'], title: v.title, loc: v.loc, allDay: v.allDay, s, e, free: false, status: '', personal: true, pid: v.id, occ: k });
    }
  }
  return out;
}
function rebuildEvents() {
  const a = todayD(), b = addDays(a, 8);
  S.events = [...S.remote, ...expandPersonal(a, b)].sort((x, y) => x.s - y.s);
}
async function loadPersonal() {
  const { data, error } = await sb.from('personal_events').select('*').order('start_date');
  if (error) { S.pevMissing = /personal_events|PGRST205|42P01|does not exist|schema cache/i.test(error.message + ' ' + error.code); return; }
  S.pevMissing = false; S.pev = data.map(pevFromRow); cache.set('pev', S.pev);
}
function personalChanged() { cache.set('pev', S.pev); rebuildEvents(); renderAll(); renderCal(); }
async function savePersonal(v) {
  const i = S.pev.findIndex(x => x.id === v.id); const before = i >= 0 ? S.pev[i] : null;
  if (i >= 0) S.pev[i] = v; else S.pev.push(v);
  personalChanged();
  const { error } = await sb.from('personal_events').upsert(pevToRow(v));
  if (error) { if (before) S.pev[i] = before; else S.pev = S.pev.filter(x => x.id !== v.id); personalChanged(); banner(/personal_events|schema cache/i.test(error.message) ? 'The Personal calendar table is not set up yet. Run the SQL from the setup notes in Supabase.' : 'Could not save: ' + error.message); return false; }
  return true;
}
async function deletePersonal(id) {
  const v = S.pev.find(x => x.id === id); if (!v) return;
  S.pev = S.pev.filter(x => x.id !== id); personalChanged();
  const { error } = await sb.from('personal_events').delete().eq('id', id);
  if (error) { S.pev.push(v); personalChanged(); banner('Could not delete: ' + error.message); return; }
  toast('Event deleted.', () => savePersonal(v));
}

async function fetchEvents(from, to) {
  if (!S.cals.length) return { events: [], errors: {}, at: Date.now() };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  const { data } = await sb.auth.getSession();
  const r = await fetch(`/api/calendars?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`, { headers: { Authorization: 'Bearer ' + data.session.access_token } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Calendar service error ' + r.status);
  return { events: dedupe(body.events || []), errors: body.errors || {}, at: body.fetchedAt || Date.now() };
}
async function refreshCalendars() {
  if (!S.session) return;
  if (!S.cals.length) { S.remote = []; rebuildEvents(); S.calState = 'ready'; renderAll(); return; }
  S.calState = 'loading'; renderAgenda();
  const from = todayD().getTime(), to = addDays(todayD(), 8).getTime();
  try {
    const res = await fetchEvents(from, to);
    S.calErr = res.errors;
    S.remote = res.events; rebuildEvents();
    S.calAt = res.at;
    cache.set('events', { events: S.remote, at: S.calAt, day: todayK() });
    S.calState = 'ready';
  } catch (e) {
    S.calState = S.events.length ? 'ready' : 'error';
    S.calFail = String(e.message || e);
    banner('Calendars could not refresh: ' + S.calFail);
  }
  renderAll();
}

/* ---------- rendering ---------- */
const areaById = id => S.areas.find(a => a.id === id) || { id: '', name: 'Unfiled', color: '#8a949c' };
const calById = id => allCals().find(c => c.id === id) || { name: 'Calendar', color: '#8a949c' };
const openTasks = () => S.tasks.filter(t => !t.done);
function renderHeader() {
  $('today').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const tk = todayK(), t1 = addDays(todayD(), 1).getTime();
  const left = S.events.filter(e => !e.allDay && !isBlocker(e) && !isAway(e) && e.e > Date.now() && e.s < t1).length;
  const gapN = S.cals.length ? findGaps(S.events).size : 0;
  const ot = openTasks(), due = ot.filter(t => t.due === tk).length, late = ot.filter(t => t.due && t.due < tk).length;
  const bits = [];
  if (hasCals()) bits.push(`<b>${left}</b> ${left === 1 ? 'meeting' : 'meetings'} left today`);
  bits.push(`<b>${due}</b> ${due === 1 ? 'to-do' : 'to-dos'} due today`);
  if (late) bits.push(`<b class="late">${late} overdue</b>`);
  if (gapN) bits.push(`<button type="button" class="lnk late" id="gapLink">${gapN} ${gapN === 1 ? 'booking needs' : 'bookings need'} an Unavailable</button>`);
  bits.push(`${ot.length} open in all`);
  $('sum').innerHTML = bits.join(', ');
  document.title = due + late ? `(${due + late}) Day Book` : 'Day Book';
  if ('setAppBadge' in navigator) { (due + late ? navigator.setAppBadge(due + late) : navigator.clearAppBadge()).catch(() => {}); }
}
const calNames = ids => ids.map(c => calById(c).name).join(', ');
const joinUrl = e => (e && /^https:\/\//i.test(e.join || '')) ? e.join : '';
function evRow(ev, now, miss) {
  const [t, ap] = ev.allDay ? ['All', 'day'] : timeParts(ev.s);
  const cls = ev.e <= now ? 'past' : (ev.s <= now ? 'live' : '');
  const dots = ev.cals.map(id => `<span class="dot" style="--c:${esc(calById(id).color)}"></span>`).join('');
  const names = ev.cals.map(id => esc(calById(id).name)).join(' + ');
  const sub = [ev.allDay ? '' : `until ${esc(timeStr(ev.e))}`, ev.loc ? esc(ev.loc) : '', ev.free ? 'free' : ''].filter(Boolean).join(' · ');
  return `<div class="ev ${cls}"><div class="t">${esc(t)}<small>${esc(ap)}</small></div><div><div class="ttl">${esc(ev.title)}</div><div class="sub"><span class="cals">${dots}</span>${names}${sub ? ' · ' + sub : ''}</div>${miss ? `<div class="gapw">No Unavailable on ${esc(calNames(miss))}</div>` : ''}</div>${joinUrl(ev) && ev.e > now ? `<a class="join${ev.s - now < 10 * 60000 ? ' soon' : ''}" href="${esc(joinUrl(ev))}" target="_blank" rel="noopener">Join</a>` : ''}</div>`;
}
function renderAgenda() {
  const el = $('agenda');
  $('calNote').textContent = S.calAt ? `Updated ${timeStr(S.calAt)}` : '';
  if (!hasCals()) {
    el.innerHTML = `<div class="empty"><p>No calendars yet. Add the ICS link from each of your Outlook calendars and they'll show here together, color-coded.</p><p><button class="btn pri" id="addCals" type="button">Add calendars</button></p></div>`;
    $('addCals').addEventListener('click', () => openSettings('cal'));
    return;
  }
  if (S.calState === 'loading' && !S.events.length) { el.innerHTML = '<p class="note">Loading calendars…</p>'; return; }
  if (S.calState === 'error') { el.innerHTML = `<div class="empty"><p>Calendars couldn't load: ${esc(S.calFail)}</p></div>`; return; }
  const errs = Object.keys(S.calErr).length;
  const t0 = todayD().getTime(), t1 = addDays(todayD(), 1).getTime(), now = Date.now();
  const day = S.events.filter(e => e.s < t1 && e.e > t0 && !isBlocker(e));
  const gaps = findGaps(S.events);
  const ad = day.filter(dayLevel), tm = day.filter(e => !dayLevel(e));
  let html = errs ? `<p class="banner">${errs} ${errs === 1 ? 'calendar' : 'calendars'} couldn't refresh. Check Settings.</p>` : '';
  if (ad.length) html += `<div class="allday">${ad.map(e => `<span class="ad${isAway(e) ? ' away' : ''}"><span class="dot" style="--c:${esc(calById(e.cal).color)}"></span>${esc(e.title)}${e.status === 'OOF' && !/out of|ooo/i.test(e.title) ? ' · Out of office' : ''}</span>`).join('')}</div>`;
  if (!tm.length) html += `<div class="empty"><p>${ad.some(isAway) ? 'No meetings today. You\'re marked out of office.' : 'Nothing on the calendar today.'}</p></div>`;
  let placed = false;
  for (const ev of tm) {
    if (!placed && ev.s > now) { html += `<div class="now">Now ${esc(timeStr(now))}</div>`; placed = true; }
    html += evRow(ev, now, gaps.get(ev));
  }
  if (!placed && tm.length) html += `<div class="now">Now ${esc(timeStr(now))}</div>`;
  el.innerHTML = html;
}
function renderWeek() {
  const rows = [], wk = CV.weekends;
  $('wkH').textContent = wk ? 'Next 7 days' : 'Next 5 workdays';
  for (let i = 1, n = 0; n < (wk ? 7 : 5) && i < 14; i++) {
    const d = addDays(todayD(), i), k = keyOf(d), a = d.getTime(), b = addDays(d, 1).getTime();
    if (!wk && (d.getDay() === 0 || d.getDay() === 6)) continue;
    n++;
    const evs = S.events.filter(e => e.s < b && e.e > a && !isBlocker(e));
    const due = openTasks().filter(t => t.due === k).length;
    const items = evs.slice(0, 6).map(e => `<li><span class="tm">${dayLevel(e) ? 'All day' : esc(timeStr(e.s))}</span><span class="dot" style="--c:${esc(calById(e.cal).color)}"></span><span class="nm">${esc(e.title)}</span></li>`);
    if (evs.length > 6) items.push(`<li class="note">${evs.length - 6} more</li>`);
    if (due) items.push(`<li class="due">${due} ${due === 1 ? 'to-do' : 'to-dos'} due</li>`);
    if (!items.length) items.push(`<li class="note">${hasCals() ? 'Open' : 'No to-dos due'}</li>`);
    rows.push(`<div class="day"><div class="dl">${WD[d.getDay()]}<span>${d.getDate()}</span></div><ul>${items.join('')}</ul></div>`);
  }
  $('week').innerHTML = rows.join('');
}
function areaOptions(sel) {
  return S.areas.map(a => `<option value="${esc(a.id)}"${a.id === sel ? ' selected' : ''}>${esc(a.name)}</option>`).join('') + `<option value=""${sel === '' ? ' selected' : ''}>Unfiled</option>`;
}
function renderChips() {
  const ot = openTasks();
  const chip = (id, name, n, color) => `<button class="chip" type="button" data-f="${esc(id)}" aria-pressed="${S.filter === id}">${color ? `<span class="dot" style="--c:${esc(color)}"></span>` : ''}${esc(name)} <span class="n">${n}</span></button>`;
  const list = [chip('all', 'All', ot.length)].concat(S.areas.map(a => chip(a.id, a.name, ot.filter(t => t.area === a.id).length, a.color)));
  const unf = ot.filter(t => !S.areas.some(a => a.id === t.area)).length;
  if (unf) list.push(chip('', 'Unfiled', unf, '#8a949c'));
  $('chips').innerHTML = list.join('');
  const cur = $('qArea').value;
  $('qArea').innerHTML = areaOptions(S.filter !== 'all' ? S.filter : (cur || S.lastArea || 'me'));
}
function taskRow(t) {
  const a = areaById(t.area), late = !t.done && t.due && t.due < todayK();
  return `<li class="task${t.pri ? ' hi' : ''}${t.done ? ' done' : ''}" data-id="${esc(t.id)}"><button class="chk" type="button" data-act="toggle" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}"></button><div class="tb"><div class="tt">${esc(t.title)}</div><div class="meta"><span class="tag"><span class="dot" style="--c:${esc(a.color)}"></span>${esc(a.name)}</span>${t.due ? `<span class="dd${late ? ' late' : ''}">${esc(dueLabel(t.due))}</span>` : ''}${t.pri && !t.done ? '<span class="flag">High</span>' : ''}${t.repeat && REPEATS[t.repeat] && !t.done ? `<span class="rep">&#8635; ${REPEATS[t.repeat]}</span>` : ''}${t.notes ? `<span>${esc(t.notes.split('\n')[0].slice(0, 60))}</span>` : ''}</div></div></li>`;
}
function renderTodos() {
  const el = $('todos');
  if (S.tasksState === 'loading' && !S.tasks.length) { el.innerHTML = '<p class="note">Loading to-dos…</p>'; return; }
  const q = S.search.toLowerCase();
  const inF = t => (S.filter === 'all' || t.area === S.filter || (S.filter === '' && !S.areas.some(a => a.id === t.area))) && (!q || (t.title + ' ' + (t.notes || '')).toLowerCase().includes(q));
  const tk = todayK(), wk = keyOf(addDays(todayD(), 7));
  const sort = (a, b) => (b.pri | 0) - (a.pri | 0) || (a.due || '9999').localeCompare(b.due || '9999') || (a.created || 0) - (b.created || 0);
  const open = openTasks().filter(inF).sort(sort);
  const groups = [
    ['over', 'Overdue', open.filter(t => t.due && t.due < tk)],
    ['', 'Today', open.filter(t => t.due === tk)],
    ['', 'Next 7 days', open.filter(t => t.due && t.due > tk && t.due <= wk)],
    ['', 'Later', open.filter(t => t.due && t.due > wk)],
    ['', 'No date', open.filter(t => !t.due)]
  ].filter(g => g[2].length);
  let html = groups.map(([c, n, l]) => `<div class="grp ${c}"><h3>${n} <span class="n">${l.length}</span></h3><ul class="tasks">${l.map(taskRow).join('')}</ul></div>`).join('');
  if (!open.length) html = `<div class="empty grp"><p>${q ? 'No to-dos match that search.' : S.tasks.length ? 'Nothing open here. Nice work.' : 'Your to-do list is empty. Type one above and press Enter; tag it with a business so it shows up under the right filter.'}</p></div>`;
  const done = S.tasks.filter(t => t.done && inF(t)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  if (done.length) html += `<details class="done"><summary>Completed (${done.length}) <button class="btn" type="button" id="clearDone">Clear completed</button></summary><ul class="tasks">${done.slice(0, 50).map(taskRow).join('')}</ul></details>`;
  const wasOpen = el.querySelector('details.done')?.open;
  el.innerHTML = html;
  if (wasOpen) el.querySelector('details.done').open = true;
  $('clearDone')?.addEventListener('click', ev => { ev.preventDefault(); clearDone(done); });
}
function renderAll() { renderHeader(); renderAgenda(); renderWeek(); renderChips(); renderTodos(); }

/* ---------- data: tasks ---------- */
const fromRow = r => ({ id: r.id, title: r.title, area: r.area ?? '', due: r.due, pri: !!r.pri, notes: r.notes || '', repeat: r.repeat || '', done: !!r.done, doneAt: r.done_at ? Date.parse(r.done_at) : null, created: r.created_at ? Date.parse(r.created_at) : Date.now() });
const toRow = t => ({ id: t.id, title: t.title, area: t.area || null, due: t.due || null, pri: !!t.pri, notes: t.notes || '', done: !!t.done, done_at: t.doneAt ? new Date(t.doneAt).toISOString() : null, ...(S.repeatCol === false ? {} : { repeat: t.repeat || null }) });
// Until the 'repeat' column exists in Supabase, retry once without it.
const missingRepeat = err => err && /repeat/i.test(err.message || '') && /column|schema/i.test(err.message || '');
function save(q, retry) { q().then(({ error }) => { if (missingRepeat(error) && S.repeatCol !== false) { S.repeatCol = false; banner('Repeating to-dos need a one-time Supabase update (see setup notes). Saved without repeating.'); retry(); } else if (error) fail(error); }); }
function upsertLocal(t) { const i = S.tasks.findIndex(x => x.id === t.id); if (i >= 0) S.tasks[i] = t; else S.tasks.push(t); }
function changed() { cache.set('tasks', S.tasks); renderHeader(); renderWeek(); renderChips(); renderTodos(); if (CV.view === 'month') renderCal(); }
function fail(e) { console.error(e); banner('A change could not be saved. Check your connection and try again.'); loadTasks(); }
async function loadTasks() {
  const { data, error } = await sb.from('tasks').select('*').order('created_at');
  if (error) { banner('To-dos could not load: ' + error.message); return; }
  S.tasks = data.map(fromRow); S.tasksState = 'ready'; changed();
}
function addTask(t) {
  const task = { ...t, id: crypto.randomUUID(), done: false, doneAt: null, created: Date.now() };
  upsertLocal(task); changed();
  const go = () => save(() => sb.from('tasks').insert(toRow(task)), go); go();
  return task;
}
function patchTask(id, patch) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  const next = { ...t, ...patch }; upsertLocal(next); changed();
  const go = () => save(() => sb.from('tasks').update(toRow(next)).eq('id', id), go); go();
}
function restoreTask(t) { upsertLocal(t); changed(); const go = () => save(() => sb.from('tasks').upsert(toRow(t)), go); go(); }
function delTasks(ids) {
  S.tasks = S.tasks.filter(t => !ids.includes(t.id)); changed();
  sb.from('tasks').delete().in('id', ids).then(({ error }) => error && fail(error));
}
let toastT = null, undoFn = null;
function toast(msg, undo) { $('toastMsg').textContent = msg; undoFn = undo; $('toastUndo').hidden = !undo; $('toast').classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => $('toast').classList.remove('on'), 6000); }
function banner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = !msg; clearTimeout(banner.t); if (msg) banner.t = setTimeout(() => { b.hidden = true; }, 8000); }
const REPEATS = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
// Next due date for a repeating to-do, counted from its due date (or today if it had none).
function nextDue(t) {
  const base = t.due ? fromKey(t.due) : todayD();
  const addMonths = n => { const d = new Date(base.getFullYear(), base.getMonth() + n, 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(base.getDate(), last)); return d; };
  const d = { daily: addDays(base, 1), weekly: addDays(base, 7), biweekly: addDays(base, 14), monthly: addMonths(1), quarterly: addMonths(3), yearly: addMonths(12) }[t.repeat];
  return d ? keyOf(d) : null;
}
function toggle(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  const was = t.done;
  patchTask(id, { done: !was, doneAt: !was ? Date.now() : null });
  if (was) return;
  if (t.repeat && REPEATS[t.repeat]) {
    // the finished one stays in Completed and loses its repeat; the next one carries it forward
    patchTask(id, { repeat: '' });
    const nx = addTask({ title: t.title, area: t.area, pri: t.pri, notes: t.notes, due: nextDue(t), repeat: t.repeat });
    toast(`Done. Next one is due ${fromKey(nx.due).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`, () => { delTasks([nx.id]); patchTask(id, { done: false, doneAt: null, repeat: t.repeat }); });
  } else toast('Marked done.', () => patchTask(id, { done: false, doneAt: null }));
}
function clearDone(list) {
  const copies = list.map(t => ({ ...t }));
  delTasks(list.map(t => t.id));
  toast(`Cleared ${list.length} completed.`, () => copies.forEach(restoreTask));
}

/* ---------- data: settings and calendars ---------- */
async function loadSettings() {
  const [{ data: st }, { data: cals, error }] = await Promise.all([
    sb.from('settings').select('*').maybeSingle(),
    sb.from('calendars').select('*').order('sort')
  ]);
  S.areas = st && Array.isArray(st.areas) && st.areas.length ? st.areas : DEFAULT_AREAS;
  S.feedToken = st ? st.feed_token || '' : ''; S.feedCol = !st || 'feed_token' in st;
  if (!error) { S.cals = cals.map(c => ({ id: c.id, name: c.name, url: c.url, color: c.color, on: c.enabled, needs: c.needs_blocks !== false })); S.needsCol = cals.length === 0 || 'needs_blocks' in cals[0]; }
  cache.set('areas', S.areas); cache.set('cals', S.cals.map(({ url, ...rest }) => rest));
}

/* ---------- quick add ---------- */
function parseQuick(raw) {
  let words = raw.trim().split(/\s+/); let area = null, pri = false, due = null;
  words = words.filter(w => {
    if (/^#\S+/.test(w)) { const k = w.slice(1).toLowerCase(); const a = S.areas.find(a => a.name.toLowerCase().replace(/\s+/g, '').startsWith(k) || a.id === k); if (a) { area = a.id; return false; } }
    if (w === '!' || w === '!!') { pri = true; return false; }
    return true;
  });
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dateWord = w => {
    const l = w.toLowerCase().replace(/[.,]$/, ''), t = todayD();
    if (l === 'today' || l === 'tod') return keyOf(t);
    if (l === 'tomorrow' || l === 'tmr' || l === 'tom') return keyOf(addDays(t, 1));
    const i = dayNames.indexOf(l.slice(0, 3));
    if (i >= 0 && /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.test(l)) return keyOf(addDays(t, (i - t.getDay() + 7) % 7));
    const m = l.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (m) { const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : t.getFullYear(); let d = new Date(y, +m[1] - 1, +m[2]); if (!m[3] && d < addDays(t, -60)) d = new Date(y + 1, +m[1] - 1, +m[2]); return keyOf(d); }
    return null;
  };
  while (words.length > 1) { const k = dateWord(words[words.length - 1]); if (!k) break; due = due || k; words.pop(); if (words.length > 1 && /^(on|by|due)$/i.test(words[words.length - 1])) words.pop(); }
  return { title: words.join(' '), area, pri, due };
}

/* ---------- dialogs ---------- */
let editing = null;
function openEditor(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return; editing = id;
  $('edTitle').value = t.title; $('edArea').innerHTML = areaOptions(t.area || ''); $('edDue').value = t.due || ''; $('edPri').checked = !!t.pri; $('edNotes').value = t.notes || ''; $('edRepeat').value = t.repeat || '';
  $('edOv').classList.add('open'); setTimeout(() => $('edTitle').focus(), 0);
}
const closeEditor = () => { $('edOv').classList.remove('open'); editing = null; };
let draftCals = [], draftAreas = [];
async function openSettings(tab) {
  renderFeed();
  draftCals = S.cals.map(c => ({ ...c })); draftAreas = S.areas.map(a => ({ ...a }));
  showTab(tab || 'cal'); renderCalRows(); renderAreaRows(); $('setOv').classList.add('open');
}
function showTab(t) { $('tabCal').setAttribute('aria-pressed', t === 'cal'); $('tabArea').setAttribute('aria-pressed', t === 'area'); $('paneCal').hidden = t !== 'cal'; $('paneArea').hidden = t !== 'area'; }
function renderCalRows() {
  $('needsNote').hidden = S.needsCol !== false;
  $('calRows').innerHTML = draftCals.map((c, i) => `<div class="crow" data-i="${i}"><input type="color" value="${esc(c.color)}" data-k="color" aria-label="Color"><div class="urls"><input type="text" value="${esc(c.name)}" data-k="name" placeholder="Name, e.g. White Oak" aria-label="Calendar name"><input type="url" value="${esc(c.url)}" data-k="url" placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" aria-label="ICS link"><div class="st${S.calErr[c.id] ? ' err' : ''}">${S.calErr[c.id] ? esc(S.calErr[c.id]) : (c.url && S.cals.some(x => x.id === c.id) ? 'Saved' : '')}</div></div><div><label class="chkl"><input type="checkbox" data-k="on"${c.on !== false ? ' checked' : ''}> Show</label><label class="chkl" title="Turn off for calendars people can't book you on directly. Meetings on this calendar still need Unavailable blocks on the others."><input type="checkbox" data-k="needs"${c.needs !== false ? ' checked' : ''}${S.needsCol === false ? ' disabled' : ''}> Check for Unavailable</label><button class="btn warn" type="button" data-rm="${i}">Remove</button></div></div>`).join('') || '<p class="note">No calendars yet.</p>';
}
function renderAreaRows() {
  $('areaRows').innerHTML = draftAreas.map((a, i) => `<div class="crow" data-i="${i}"><input type="color" value="${esc(a.color)}" data-k="color" aria-label="Color"><input type="text" value="${esc(a.name)}" data-k="name" aria-label="Business name"><button class="btn warn" type="button" data-rm="${i}">Remove</button></div>`).join('');
}
function bindRows(container, arr, rerender) {
  container.addEventListener('input', e => { const row = e.target.closest('.crow'); const k = e.target.dataset.k; if (!row || !k) return; arr()[+row.dataset.i][k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
  container.addEventListener('click', e => { const i = e.target.dataset.rm; if (i === undefined) return; arr().splice(+i, 1); rerender(); });
}

/* ---------- calendar view ---------- */
// Day and week grids show 6 am to 8 pm. Hour height stretches so the whole range fits the window.
const GRID_START = 6, GRID_END = 20, GRID_HOURS = GRID_END - GRID_START;
let HH = 48;
let gridTop = 330; // measured distance from the top of the page to the grid, updated after each render
const fitHourHeight = () => { HH = Math.floor(Math.min(72, Math.max(innerWidth < 700 ? 40 : 32, (innerHeight - gridTop - 32) / GRID_HOURS))); };
const CV = { view: innerWidth < 700 ? 'day' : 'week', date: todayD(), weekends: cache.get('weekends') === true, hidden: new Set(cache.get('hiddenCals') || []), store: {}, list: [], loading: false };
function cvRange() {
  const d = CV.date;
  if (CV.view === 'day') return [d, addDays(d, 1)];
  if (CV.view === 'week') { if (CV.weekends) { const a = addDays(d, -d.getDay()); return [a, addDays(a, 7)]; } const a = addDays(d, -((d.getDay() + 6) % 7)); return [a, addDays(a, 5)]; }
  const first = new Date(d.getFullYear(), d.getMonth(), 1), a = addDays(first, -first.getDay());
  return [a, addDays(a, 42)];
}
function cvTitle() {
  const d = CV.date;
  if (CV.view === 'day') return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (CV.view === 'month') return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const [a, b] = cvRange(), e = addDays(b, -1);
  return a.getMonth() === e.getMonth() ? `${MO[a.getMonth()]} ${a.getDate()} to ${e.getDate()}, ${e.getFullYear()}` : `${MO[a.getMonth()]} ${a.getDate()} to ${MO[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
}
// Feeds are downloaded once per six-week month window; day and week views reuse it.
function cvWindow() { const first = new Date(CV.date.getFullYear(), CV.date.getMonth(), 1), a = addDays(first, -first.getDay()); return [a, addDays(a, 42)]; }
function cvHit() { const [a, b] = cvWindow(); return CV.store[a.getTime() + '-' + b.getTime()]; }
const inView = list => { const [a, b] = cvRange(); return list.filter(e => e.s < b.getTime() && e.e > a.getTime()); };
async function cvLoad(force) {
  const [a, b] = cvWindow(), key = a.getTime() + '-' + b.getTime(), hit = CV.store[key];
  if (!S.cals.length) { CV.store[key] = { events: [], at: 0, errors: {} }; renderCal(); return; } // at: 0 so it refetches once calendars load
  if (hit && !force && Date.now() - hit.at < 10 * 60000) { renderCal(); return; }
  CV.loading = true; renderCal();
  try { const res = await fetchEvents(a.getTime(), b.getTime()); CV.store[key] = { events: res.events, at: Date.now(), errors: res.errors }; CV.err = ''; }
  catch (e) { CV.err = String(e.message || e); }
  CV.loading = false; renderCal();
}
function cvEvents() {
  const [a, b] = cvRange(), hit = cvHit();
  return [...(hit ? inView(hit.events) : []), ...expandPersonal(a, b)].sort((x, y) => x.s - y.s).filter(e => e.cals.some(c => !CV.hidden.has(c)));
}
const evColor = e => calById(e.cals.find(c => !CV.hidden.has(c)) || e.cal).color;
function evBtn(cls, e, inner, style) {
  CV.list.push(e);
  if (joinUrl(e)) cls += ' hasjoin';
  if (CV.gaps && CV.gaps.has(e)) { cls += ' gap'; inner = '<i class="gi" aria-label="Needs an Unavailable">!</i>' + inner; }
  return `<button type="button" class="${cls}" data-k="${CV.list.length - 1}" style="--c:${esc(evColor(e))};${style || ''}">${inner}</button>`;
}
function layoutDay(evs) {
  // assign overlapping events to side-by-side columns
  const out = []; let group = [], end = -1;
  const flush = () => {
    const cols = [];
    for (const e of group) { let i = cols.findIndex(t => t <= e.s); if (i < 0) { i = cols.length; cols.push(0); } cols[i] = e.e; e._col = i; }
    for (const e of group) { e._n = cols.length; out.push(e); }
    group = []; end = -1;
  };
  for (const e of evs) { if (group.length && e.s >= end) flush(); group.push(e); end = Math.max(end, e.e); }
  if (group.length) flush();
  return out;
}
function renderTimeGrid(days) {
  const evs = cvEvents(), now = Date.now(), tk = todayK();
  const head = days.map(d => `<div class="${keyOf(d) === tk ? 'td' : ''}"><button type="button" data-day="${keyOf(d)}">${WD[d.getDay()]}<b>${d.getDate()}</b></button></div>`).join('');
  const all = days.map(d => {
    const a = d.getTime(), b = addDays(d, 1).getTime();
    return `<div>${evs.filter(e => dayLevel(e) && e.s < b && e.e > a).map(e => evBtn('ab', e, esc(e.title))).join('')}</div>`;
  }).join('');
  fitHourHeight();
  const hours = Array.from({ length: GRID_HOURS + 1 }, (_, i) => { const h = GRID_START + i; return `<span style="top:${i * HH}px">${h % 12 || 12} ${h < 12 || h === 24 ? 'am' : 'pm'}</span>`; }).join('');
  const cols = days.map(d => {
    const a = d.getTime(), b = addDays(d, 1).getTime();
    const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate(), GRID_START).getTime(), we = new Date(d.getFullYear(), d.getMonth(), d.getDate(), GRID_END).getTime();
    // events before 6 am or after 10 pm are pinned to the top or bottom edge instead of disappearing
    const minMs = 22 / HH * 36e5; // shortest block we draw, in time
    const items = layoutDay(evs.filter(e => !dayLevel(e) && e.s < b && e.e > a).map(e => { const st = Math.min(Math.max(e.s, ws), we - minMs); return { ...e, s: st, e: Math.min(Math.max(e.e, st + minMs), we), orig: e }; }));
    const blocks = items.map(x => {
      const top = (x.s - ws) / 36e5 * HH, h = Math.max(20, (x.e - x.s) / 36e5 * HH - 2);
      const w = 100 / x._n, l = x._col * w;
      const o = x.orig;
      return evBtn(`eb${h > 44 ? ' tall' : ''}${o.e <= now ? ' past' : ''}`, o, `<b>${esc(o.title)}</b>${h > 30 ? `${esc(timeStr(o.s))}${o.loc && h > 58 ? ' · ' + esc(o.loc) : ''}` : ''}`, `top:${top}px;height:${h}px;left:calc(${l}% + 2px);width:calc(${w}% - 4px)`);
    }).join('');
    const nowl = keyOf(d) === tk && now >= ws && now <= we ? `<div class="nowl" style="top:${(now - ws) / 36e5 * HH}px"></div>` : '';
    return `<div class="dcol${keyOf(d) === tk ? ' td' : ''}" data-date="${keyOf(d)}" title="Click to add an event">${blocks}${nowl}</div>`;
  }).join('');
  return `<div class="tg" style="--days:${days.length};--hh:${HH}px;--hrs:${GRID_HOURS}"><div class="tg-head"><div></div>${head}</div><div class="tg-all"><div class="lab">All day</div>${all}</div><div class="tg-scroll" id="tgScroll"><div class="tg-grid"><div class="hours">${hours}</div>${cols}</div></div></div>`;
}
function renderMonth() {
  const [a] = cvRange(), evs = cvEvents(), tk = todayK(), m = CV.date.getMonth();
  const cells = [], ncol = CV.weekends ? 7 : 5;
  for (let i = 0; i < 42; i++) {
    const d = addDays(a, i), k = keyOf(d), s = d.getTime(), e = addDays(d, 1).getTime();
    if (!CV.weekends && (d.getDay() === 0 || d.getDay() === 6)) continue;
    const pos = cells.length, rc = `${pos % ncol === 0 ? ' c0' : ''}${pos < ncol ? ' r0' : ''}`;
    const day = evs.filter(x => x.s < e && x.e > s).sort((x, y) => (dayLevel(y) - dayLevel(x)) || x.s - y.s);
    const shown = day.slice(0, 3).map(x => evBtn(`me${dayLevel(x) ? ' alld' : ''}`, x, `<span class="dot" style="--c:${esc(evColor(x))}"></span>${dayLevel(x) ? '' : `<span class="tm">${esc(timeStr(x.s).replace(':00', ''))}</span>`}<span class="nm">${esc(x.title)}</span>`)).join('');
    const more = day.length > 3 ? `<button type="button" class="more" data-day="${k}"><span class="ml">${day.length - 3} more</span><span class="ms">+${day.length - 3}</span></button>` : '';
    const due = openTasks().filter(t => t.due === k).length;
    cells.push(`<div class="mc${rc}${d.getMonth() !== m ? ' oth' : ''}${k === tk ? ' td' : ''}"><button type="button" class="dn" data-day="${k}" aria-label="${esc(d.toDateString())}">${d.getDate()}</button>${shown}${more}${due ? `<span class="mtd">${due} ${due === 1 ? 'to-do' : 'to-dos'}</span>` : ''}</div>`);
  }
  const wds = CV.weekends ? WD : WD.slice(1, 6);
  return `<div class="mg" style="grid-template-columns:repeat(${ncol},minmax(0,1fr))">${wds.map(w => `<div class="wd">${w}</div>`).join('')}${cells.join('')}</div>`;
}
function renderCal() {
  if ($('calView').hidden) return;
  CV.list = [];
  { const gh = cvHit(); CV.gaps = gh && S.cals.length ? findGaps(gh.events) : new Map(); for (const e of [...CV.gaps.keys()]) if (!inView([e]).length) CV.gaps.delete(e); }
  $('cTitle').textContent = cvTitle();
  for (const b of $('cViews').querySelectorAll('[data-v]')) b.setAttribute('aria-pressed', b.dataset.v === CV.view);
  $('cWeekends').setAttribute('aria-pressed', CV.weekends);
  $('cLegend').innerHTML = allCals().filter(c => !c.builtin || S.pev.length).map(c => `<button class="chip${CV.hidden.has(c.id) ? ' off' : ''}" type="button" data-cal="${esc(c.id)}" aria-pressed="${!CV.hidden.has(c.id)}"><span class="dot" style="--c:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('');
  const [a, b] = cvRange(), hit = cvHit();
  const errs = hit ? Object.keys(hit.errors || {}).length : 0;
  const gn = CV.gaps.size;
  $('cStatus').textContent = !hasCals() ? 'No calendars yet. Add them in Settings, or add a Personal event.' : CV.loading ? 'Loading…' : CV.err ? 'Could not load: ' + CV.err : errs ? `${errs} ${errs === 1 ? 'calendar' : 'calendars'} couldn't refresh.` : gn ? `${gn} ${gn === 1 ? 'booking is' : 'bookings are'} missing an Unavailable block (marked with !).` : '';
  $('cStatus').classList.toggle('warnt', !!gn && !CV.loading && !CV.err && !errs);
  const prevScroll = $('tgScroll')?.scrollTop;
  if (CV.view === 'month') $('cBody').innerHTML = renderMonth();
  else {
    const n = CV.view === 'day' ? 1 : CV.weekends ? 7 : 5;
    $('cBody').innerHTML = renderTimeGrid(Array.from({ length: n }, (_, i) => addDays(a, i)));
    let sc = $('tgScroll');
    const top = Math.round(sc.getBoundingClientRect().top + scrollY);
    if (Math.abs(top - gridTop) > 4) { gridTop = top; $('cBody').innerHTML = renderTimeGrid(Array.from({ length: n }, (_, i) => addDays(a, i))); sc = $('tgScroll'); }
    if (prevScroll != null && CV.keepScroll) sc.scrollTop = prevScroll;
    else { const inRange = Date.now() >= a.getTime() && Date.now() < b.getTime(); const h = inRange ? new Date().getHours() - 1.5 - GRID_START : 1; sc.scrollTop = Math.max(0, h) * HH; }
    CV.keepScroll = true;
  }
  renderHours();
}
function cvGo(view, date) { if (view) CV.view = view; if (date) CV.date = date; CV.keepScroll = false; cvLoad(); }
function cvStep(dir) {
  const d = CV.date;
  let nd = addDays(d, dir); if (CV.view === 'day' && !CV.weekends) while (nd.getDay() === 0 || nd.getDay() === 6) nd = addDays(nd, dir);
  cvGo(null, CV.view === 'day' ? nd : CV.view === 'week' ? addDays(d, 7 * dir) : new Date(d.getFullYear(), d.getMonth() + dir, 1));
}
function showEvent(e) {
  $('evH').textContent = e.title;
  const sameDay = keyOf(new Date(e.s)) === keyOf(new Date(e.e - 1));
  const dstr = ms => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  $('evWhen').textContent = e.allDay ? (sameDay ? dstr(e.s) + ', all day' : `${dstr(e.s)} to ${dstr(e.e - 1)}, all day`) : sameDay ? `${dstr(e.s)}, ${timeStr(e.s)} to ${timeStr(e.e)}` : `${dstr(e.s)} ${timeStr(e.s)} to ${dstr(e.e)} ${timeStr(e.e)}`;
  $('evLoc').textContent = e.loc || ''; $('evLoc').hidden = !e.loc;
  const miss = CV.gaps && CV.gaps.get(e);
  $('evWarn').textContent = miss ? `No Unavailable block on ${calNames(miss)} for this time.` : ''; $('evWarn').hidden = !miss;
  $('evCal').textContent = e.cals.map(c => calById(c).name).join(' + ') + (e.status === 'OOF' ? ' · Out of office' : e.status === 'TENTATIVE' ? ' · Tentative' : e.free ? ' · shown as free' : '');
  const ju = joinUrl(e); $('evJoin').hidden = !ju; if (ju) $('evJoin').href = ju;
  $('evEdit').hidden = !e.personal; $('evSkip').hidden = !(e.personal && S.pev.find(v => v.id === e.pid)?.days);
  CV.cur = e;
  $('evOv').classList.add('open');
}
function setView(v) {
  const cal = v === 'calendar';
  $('dash').hidden = cal; $('calView').hidden = !cal;
  $('navDash').setAttribute('aria-pressed', !cal); $('navCal').setAttribute('aria-pressed', cal);
  if (cal) { CV.keepScroll = false; cvLoad(); }
}
const route = () => setView(location.hash === '#calendar' ? 'calendar' : 'dash');

/* ---------- hours by business ---------- */
// Meeting hours per calendar for what's on screen. Overlaps on one calendar count once;
// Unavailable holds, out-of-office, Free and all-day items don't count.
function hoursByCal(events, a, b) {
  const per = {};
  for (const e of events) {
    if (dayLevel(e) || isBlocker(e) || isAway(e) || e.free) continue;
    const s = Math.max(e.s, a), en = Math.min(e.e, b); if (en <= s) continue;
    for (const c of e.cals) (per[c] = per[c] || []).push([s, en]);
  }
  const out = {};
  for (const c in per) {
    const l = per[c].sort((x, y) => x[0] - y[0]); let tot = 0, cs = -1, ce = -1;
    for (const [s, e] of l) { if (s > ce) { if (ce > cs) tot += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e); }
    if (ce > cs) tot += ce - cs;
    out[c] = tot / 36e5;
  }
  return out;
}
function renderHours() {
  const el = $('cHours'); if (!el) return;
  let [a, b] = cvRange();
  if (CV.view === 'month') { a = new Date(CV.date.getFullYear(), CV.date.getMonth(), 1); b = new Date(CV.date.getFullYear(), CV.date.getMonth() + 1, 1); }
  const hit = cvHit();
  const evs = [...(hit ? hit.events : []), ...expandPersonal(a, b)].filter(e => e.cals.some(c => !CV.hidden.has(c)));
  const h = hoursByCal(evs, a.getTime(), b.getTime());
  const ids = allCals().map(c => c.id).filter(id => h[id] && !CV.hidden.has(id));
  const label = CV.view === 'day' ? 'Meetings this day' : CV.view === 'week' ? 'Meetings this week' : `Meetings in ${MO[a.getMonth()]}`;
  const fmt = n => (Math.round(n * 4) / 4).toString().replace(/\.0+$/, '');
  el.innerHTML = ids.length ? `<b>${label}:</b>` + ids.map(id => `<span class="h"><span class="dot" style="--c:${esc(calById(id).color)}"></span>${esc(calById(id).name)} <span>${fmt(h[id])} h</span></span>`).join('') : '';
}

/* ---------- find open time ---------- */
function ftRange() {
  const t = todayD(), mon = addDays(t, -((t.getDay() + 6) % 7)), v = $('ftRange').value;
  if (v === 'this') return [t, addDays(mon, 7)];
  if (v === 'next') return [addDays(mon, 7), addDays(mon, 14)];
  return [t, addDays(mon, 14)];
}
function openFind() {
  const saved = cache.get('ftPrefs2') || {};
  for (const k of ['ftLen', 'ftRange', 'ftGap', 'ftFrom', 'ftTo']) if (saved[k]) $(k).value = saved[k];
  const off = new Set(saved.off || []);
  $('ftCals').innerHTML = allCals().filter(c => !c.builtin || S.pev.length).map(c => `<label><input type="checkbox" value="${esc(c.id)}"${off.has(c.id) ? '' : ' checked'}><span>${esc(c.name)}</span></label>`).join('');
  $('ftOut').innerHTML = ''; $('ftCopy').hidden = true;
  $('ftOv').classList.add('open');
}
let ftText = '';
$('ftForm').addEventListener('submit', async e => {
  e.preventDefault();
  const len = +$('ftLen').value * 60000, gap = +$('ftGap').value * 60000;
  const [fh, fm] = $('ftFrom').value.split(':').map(Number), [th, tm] = $('ftTo').value.split(':').map(Number);
  const busyCals = new Set([...$('ftCals').querySelectorAll('input:checked')].map(b => b.value));
  cache.set('ftPrefs2', { ftLen: $('ftLen').value, ftRange: $('ftRange').value, ftGap: $('ftGap').value, ftFrom: $('ftFrom').value, ftTo: $('ftTo').value, off: allCals().map(c => c.id).filter(id => !busyCals.has(id)) });
  const [a, b] = ftRange();
  $('ftOut').innerHTML = '<p class="none">Checking your calendars…</p>';
  let events;
  try { events = [...(await fetchEvents(a.getTime(), b.getTime())).events, ...expandPersonal(a, b)]; }
  catch (err) { $('ftOut').innerHTML = `<p class="none">Could not load calendars: ${esc(err.message)}</p>`; return; }
  const now = Date.now(), days = [], lines = [];
  for (let d = new Date(a); d < b; d = addDays(d, 1)) {
    if (!CV.weekends && (d.getDay() === 0 || d.getDay() === 6)) continue;
    const ds = d.getTime(), de = addDays(d, 1).getTime();
    let start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), fh, fm).getTime(), end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), th, tm).getTime();
    start = Math.max(start, Math.ceil((now + 15 * 60000) / 9e5) * 9e5); // nothing in the past; round to the next quarter hour
    if (end - start < len) continue;
    const dayEvs = events.filter(x => x.s < de && x.e > ds && !x.free && x.cals.some(c => busyCals.has(c)));
    if (dayEvs.some(x => isAway(x) && (x.allDay || x.e - x.s >= 6 * 36e5))) continue; // out of office that day
    const busy = dayEvs.filter(x => !x.allDay).map(x => [x.s - gap, x.e + gap]).sort((p, q) => p[0] - q[0]);
    const free = []; let cur = start;
    for (const [s0, e0] of busy) { if (s0 > cur) free.push([cur, Math.min(s0, end)]); cur = Math.max(cur, e0); if (cur >= end) break; }
    if (cur < end) free.push([cur, end]);
    const ok = free.filter(([s0, e0]) => e0 - s0 >= len);
    if (!ok.length) continue;
    const name = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const spans = ok.map(([s0, e0]) => `${timeStr(s0)} to ${timeStr(e0)}`);
    days.push(`<h3>${esc(name)}</h3><ul>${spans.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
    lines.push(`- ${name}: ${spans.join(', ')}`);
  }
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'my time';
  ftText = lines.length ? `Here are some times that work for me (${zone.replace(/ Standard| Daylight/, '')}):\n${lines.join('\n')}` : '';
  $('ftOut').innerHTML = days.length ? days.join('') : '<p class="none">No open slots that long in that range. Try a shorter length, a later end time, or a different week.</p>';
  $('ftCopy').hidden = !lines.length;
});
$('ftCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ftText); toast('Copied. Paste it into your email.'); }
  catch { toast('Copy was blocked by the browser. Select the times and copy them by hand.'); }
});
$('ftClose').addEventListener('click', () => $('ftOv').classList.remove('open'));
$('cFind').addEventListener('click', openFind);
$('findDash').addEventListener('click', openFind);

/* ---------- new event (hands off to Outlook on the web) ---------- */
const isPersonal = c => /outlook\.live\.com|hotmail|live\.com/i.test(c.url || '');
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = v => { const [h, m] = (v || '0:0').split(':').map(Number); return h * 60 + m; };
const fromMin = n => { n = ((n % 1440) + 1440) % 1440; return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`; };
function isoLocal(dateKey, time) {
  const [y, mo, d] = dateKey.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const dt = new Date(y, mo - 1, d, h, mi), off = -dt.getTimezoneOffset();
  return `${dateKey}T${pad(h)}:${pad(mi)}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
let neEditing = null;
function neHelp() {
  const pers = $('neCal').value === 'personal';
  $('neRep').hidden = !pers; $('neSubmit').textContent = pers ? 'Save' : 'Open in Outlook';
  $('neDays').hidden = $('neRepeat').value !== 'weekly'; $('neUntilF').hidden = !$('neRepeat').value;
  $('neDel').hidden = !neEditing;
  if (pers) { $('neHelp').textContent = S.pevMissing ? 'One-time setup needed: run the Personal calendar SQL in Supabase first.' : 'Saved in Day Book only. It will not appear in Outlook, and it is never checked for Unavailable blocks.'; return; }
  const c = S.cals.find(x => x.id === $('neCal').value);
  $('neHelp').textContent = !c ? '' : isPersonal(c)
    ? 'Opens Outlook.com (outlook.live.com) with the event filled in. Click Save there.'
    : `Opens Outlook on the web (outlook.office.com) with the event filled in. Check that the account in the top right is ${c.name} before you click Save.`;
}
function setDays(days) { for (const b of $('neDays').querySelectorAll('input')) b.checked = days.includes(+b.value); }
function openNewEvent(start, editId) {
  const v = editId ? S.pev.find(x => x.id === editId) : null; neEditing = v ? v.id : null;
  const now = new Date(), d = start || new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() < 30 ? 30 : 60);
  $('neH').textContent = v ? 'Edit personal event' : 'New event';
  $('neCal').innerHTML = (v ? [PERSONAL] : allCals()).map(c => `<option value="${esc(c.id)}">${esc(c.builtin ? 'Personal (Day Book only)' : c.name)}</option>`).join('');
  $('neCal').disabled = !!v;
  const last = cache.get('lastEvCal'); if (!v && last && allCals().some(c => c.id === last)) $('neCal').value = last;
  $('neTitle').value = v ? v.title : ''; $('neLoc').value = v ? v.loc : ''; $('neNotes').value = v ? v.notes : ''; $('neAll').checked = v ? v.allDay : false;
  $('neDate').value = v ? v.date : keyOf(d); $('neStart').value = v ? v.start : hm(d); $('neEnd').value = v ? v.end : fromMin(toMin(hm(d)) + 60);
  const days = v && v.days ? v.days : [];
  $('neRepeat').value = !days.length ? '' : days.length === 7 ? 'daily' : days.join() === '1,2,3,4,5' ? 'weekdays' : 'weekly';
  setDays(days.length ? days : [fromKey($('neDate').value).getDay()]); daysTouched = !!days.length; $('neUntil').value = v && v.until ? v.until : '';
  for (const el of document.querySelectorAll('.neT')) el.hidden = $('neAll').checked;
  neHelp(); $('neOv').classList.add('open'); setTimeout(() => $('neTitle').focus(), 0);
}
let daysTouched = false;
$('neDays').addEventListener('change', () => { daysTouched = true; });
$('neRepeat').addEventListener('change', () => { if ($('neRepeat').value === 'weekly' && !daysTouched && $('neDate').value) setDays([fromKey($('neDate').value).getDay()]); neHelp(); });
$('neDate').addEventListener('change', () => { if (!daysTouched && $('neDate').value) setDays([fromKey($('neDate').value).getDay()]); });
$('neDel').addEventListener('click', () => { const id = neEditing; $('neOv').classList.remove('open'); deletePersonal(id); });
$('evEdit').addEventListener('click', () => { const e = CV.cur; $('evOv').classList.remove('open'); if (e && e.personal) openNewEvent(null, e.pid); });
$('evSkip').addEventListener('click', () => {
  const e = CV.cur; const v = e && S.pev.find(x => x.id === e.pid); if (!v) return;
  $('evOv').classList.remove('open');
  const before = { ...v, skip: [...v.skip] };
  savePersonal({ ...v, skip: [...v.skip, e.occ] }).then(ok => ok && toast(`Removed the ${fromKey(e.occ).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} one only.`, () => savePersonal(before)));
});
let neDur = 60;
$('neStart').addEventListener('focus', () => { neDur = Math.max(15, toMin($('neEnd').value) - toMin($('neStart').value)); });
$('neStart').addEventListener('change', () => { $('neEnd').value = fromMin(toMin($('neStart').value) + neDur); });
$('neAll').addEventListener('change', () => { for (const el of document.querySelectorAll('.neT')) el.hidden = $('neAll').checked; });
$('neCal').addEventListener('change', neHelp);
$('neCancel').addEventListener('click', () => $('neOv').classList.remove('open'));
$('neForm').addEventListener('submit', async e => {
  e.preventDefault();
  const date = $('neDate').value; if (!date) return;
  if ($('neCal').value === 'personal') {
    const rep = $('neRepeat').value;
    const days = rep === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : rep === 'weekdays' ? [1, 2, 3, 4, 5] : rep === 'weekly' ? [...$('neDays').querySelectorAll('input:checked')].map(b => +b.value) : null;
    if (rep === 'weekly' && !days.length) { $('neHelp').textContent = 'Pick at least one day for it to repeat on.'; return; }
    const old = neEditing ? S.pev.find(x => x.id === neEditing) : null;
    const v = { id: neEditing || crypto.randomUUID(), title: $('neTitle').value.trim() || 'Untitled', loc: $('neLoc').value.trim(), notes: $('neNotes').value.trim(), allDay: $('neAll').checked, date, start: $('neStart').value || '09:00', end: $('neEnd').value || '10:00', days, until: days ? ($('neUntil').value || null) : null, skip: old ? old.skip : [] };
    cache.set('lastEvCal', 'personal');
    $('neOv').classList.remove('open');
    if (await savePersonal(v)) toast(old ? 'Event updated.' : 'Added to your Personal calendar.');
    return;
  }
  const c = S.cals.find(x => x.id === $('neCal').value); if (!c) return;
  const q = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: $('neTitle').value.trim() });
  if ($('neAll').checked) {
    q.set('startdt', date); q.set('enddt', keyOf(addDays(fromKey(date), 1))); q.set('allday', 'true');
  } else {
    let endDate = date; if (toMin($('neEnd').value) <= toMin($('neStart').value)) endDate = keyOf(addDays(fromKey(date), 1));
    q.set('startdt', isoLocal(date, $('neStart').value)); q.set('enddt', isoLocal(endDate, $('neEnd').value));
  }
  if ($('neLoc').value.trim()) q.set('location', $('neLoc').value.trim());
  if ($('neNotes').value.trim()) q.set('body', $('neNotes').value.trim());
  const host = isPersonal(c) ? 'https://outlook.live.com' : 'https://outlook.office.com';
  cache.set('lastEvCal', c.id);
  window.open(`${host}/calendar/0/deeplink/compose?${q}`, '_blank', 'noopener');
  $('neOv').classList.remove('open');
  toast('Opened in Outlook. Save it there; it will show here after the next refresh.');
});
$('cNew').addEventListener('click', () => openNewEvent(CV.view === 'day' && keyOf(CV.date) !== todayK() ? new Date(CV.date.getFullYear(), CV.date.getMonth(), CV.date.getDate(), 9) : null));
$('addEvDash').addEventListener('click', () => openNewEvent());

/* ---------- subscribe link and backup ---------- */
const userTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
const feedUrl = () => S.feedToken ? `${location.origin}/cal/${S.feedToken}.ics?tz=${encodeURIComponent(userTz())}` : '';
function renderFeed() {
  const u = feedUrl();
  $('feedUrl').value = u; $('feedUrl').hidden = !u;
  $('feedCopy').hidden = !u; $('feedReset').hidden = !u; $('feedMake').hidden = !!u;
  $('feedHelp').hidden = !u;
  $('feedNote').textContent = S.feedCol === false ? 'Run the one-time Supabase update from the setup notes to turn this on.' : '';
}
async function makeFeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const { error } = await sb.from('settings').upsert({ user_id: S.session.user.id, feed_token: token, updated_at: new Date().toISOString() });
  if (error) { S.feedCol = !/feed_token/i.test(error.message) ? S.feedCol : false; $('feedNote').textContent = /feed_token/i.test(error.message) ? 'Run the one-time Supabase update from the setup notes to turn this on.' : 'Could not create the link: ' + error.message; return; }
  S.feedToken = token; renderFeed();
}
$('feedMake').addEventListener('click', makeFeed);
$('feedReset').addEventListener('click', async () => {
  if ($('feedReset').dataset.armed !== '1') { $('feedReset').dataset.armed = '1'; $('feedReset').textContent = 'Click again: the old link stops working'; return; }
  $('feedReset').dataset.armed = ''; $('feedReset').textContent = 'Reset link'; await makeFeed(); toast('New link made. Update it anywhere you subscribed.');
});
$('feedCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(feedUrl()); toast('Link copied.'); } catch { $('feedUrl').select(); toast('Press Ctrl+C or Cmd+C to copy.'); } });
$('backup').addEventListener('click', async () => {
  const [t, p, c, st] = await Promise.all([sb.from('tasks').select('*'), sb.from('personal_events').select('*'), sb.from('calendars').select('*'), sb.from('settings').select('*').maybeSingle()]);
  const data = { app: 'Day Book', exported: new Date().toISOString(), tasks: t.data || [], personal_events: p.data || [], calendars: c.data || [], settings: st.data || null };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `daybook-backup-${todayK()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Backup downloaded: ${data.tasks.length} to-dos, ${data.personal_events.length} personal events. It includes your calendar links, so keep the file private.`);
});

// Restore: adds or updates rows from a backup file. Nothing that exists now is deleted.
let restoreData = null;
$('restore').addEventListener('click', () => { $('restoreFile').value = ''; $('restoreFile').click(); });
$('restoreFile').addEventListener('change', async () => {
  const f = $('restoreFile').files[0]; if (!f) return;
  let d; try { d = JSON.parse(await f.text()); } catch { d = null; }
  const box = $('restoreBox'); box.hidden = false;
  if (!d || d.app !== 'Day Book' || !Array.isArray(d.tasks)) { restoreData = null; $('restoreMsg').textContent = 'That file is not a Day Book backup.'; $('restoreGo').hidden = true; return; }
  restoreData = d; $('restoreGo').hidden = false;
  const when = d.exported ? new Date(d.exported).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'an unknown date';
  $('restoreMsg').textContent = `Backup from ${when}: ${d.tasks.length} to-dos, ${(d.personal_events || []).length} personal events, ${(d.calendars || []).length} calendars${d.settings ? ', and your businesses' : ''}. Restoring adds anything missing and puts changed items back the way they were in the backup. Nothing you have now is deleted.`;
});
$('restoreCancel').addEventListener('click', () => { restoreData = null; $('restoreBox').hidden = true; });
$('restoreGo').addEventListener('click', async () => {
  const d = restoreData; if (!d) return;
  const uid = S.session.user.id, mine = r => ({ ...r, user_id: uid }); // works even if restored into a new account
  $('restoreGo').disabled = true; $('restoreMsg').textContent = 'Restoring…';
  const steps = [['tasks', d.tasks], ['personal_events', d.personal_events || []], ['calendars', d.calendars || []]];
  try {
    for (const [table, rows] of steps) for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(table).upsert(rows.slice(i, i + 500).map(mine));
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    if (d.settings) { const { error } = await sb.from('settings').upsert(mine(d.settings)); if (error) throw new Error('settings: ' + error.message); }
  } catch (e) { $('restoreMsg').textContent = 'Restore stopped: ' + e.message + '. Anything before that point was restored.'; $('restoreGo').disabled = false; return; }
  $('restoreGo').disabled = false; $('restoreBox').hidden = true; restoreData = null;
  await Promise.all([loadSettings(), loadTasks(), loadPersonal()]);
  rebuildEvents(); CV.store = {}; renderAll(); refreshCalendars(); $('setOv').classList.remove('open');
  toast('Backup restored.');
});

/* ---------- events ---------- */
$('addForm').addEventListener('submit', e => {
  e.preventDefault(); const raw = $('q').value; if (!raw.trim()) return;
  const p = parseQuick(raw); if (!p.title) return;
  const area = p.area ?? $('qArea').value; S.lastArea = area;
  addTask({ title: p.title, area, pri: p.pri, due: p.due || $('qDue').value || null, notes: '' });
  $('q').value = ''; $('qDue').value = '';
});
$('chips').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; S.filter = b.dataset.f; renderChips(); renderTodos(); });
$('search').addEventListener('input', e => { S.search = e.target.value; renderTodos(); });
$('todos').addEventListener('click', e => {
  const li = e.target.closest('.task'); if (!li) return;
  if (e.target.closest('[data-act=toggle]')) toggle(li.dataset.id); else openEditor(li.dataset.id);
});
$('edForm').addEventListener('submit', e => {
  e.preventDefault(); if (!editing) return;
  const rp = $('edRepeat').value; let due = $('edDue').value || null; if (rp && !due) due = todayK(); // a repeating to-do needs a due date to count from
  patchTask(editing, { title: $('edTitle').value.trim() || 'Untitled', area: $('edArea').value, due, pri: $('edPri').checked, notes: $('edNotes').value, repeat: rp });
  closeEditor();
});
$('edCancel').addEventListener('click', closeEditor);
$('edBlock').addEventListener('click', () => {
  const t = S.tasks.find(x => x.id === editing); if (!t) return;
  closeEditor();
  const now = new Date(), day = t.due && t.due > todayK() ? fromKey(t.due) : todayD();
  const start = keyOf(day) === todayK() ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() < 30 ? 30 : 60) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
  openNewEvent(start);
  $('neCal').value = 'personal'; $('neTitle').value = t.title; $('neNotes').value = 'To-do: ' + t.title; neHelp();
});
$('navDash').addEventListener('click', () => { if (location.hash) history.pushState(null, '', location.pathname); route(); });
$('navCal').addEventListener('click', () => { location.hash = 'calendar'; });
$('sum').addEventListener('click', e => { if (e.target.id === 'gapLink') { CV.view = innerWidth < 700 ? 'day' : 'week'; CV.date = todayD(); location.hash = 'calendar'; route(); } });
$('expandCal').addEventListener('click', () => { location.hash = 'calendar'; });
window.addEventListener('hashchange', route);
let rsT; window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if (!$('calView').hidden && CV.view !== 'month') { CV.keepScroll = true; renderCal(); } }, 150); });
$('cPrev').addEventListener('click', () => cvStep(-1));
$('cNext').addEventListener('click', () => cvStep(1));
$('cToday').addEventListener('click', () => cvGo(null, todayD()));
$('cWeekends').addEventListener('click', () => { CV.weekends = !CV.weekends; cache.set('weekends', CV.weekends); cvGo(); renderWeek(); });
$('cViews').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) cvGo(b.dataset.v); });
$('cLegend').addEventListener('click', e => {
  const b = e.target.closest('[data-cal]'); if (!b) return;
  const id = b.dataset.cal; CV.hidden.has(id) ? CV.hidden.delete(id) : CV.hidden.add(id);
  cache.set('hiddenCals', [...CV.hidden]); renderCal();
});
$('cBody').addEventListener('click', e => {
  const ev = e.target.closest('[data-k]'); if (ev) { showEvent(CV.list[+ev.dataset.k]); return; }
  const d = e.target.closest('[data-day]'); if (d) { cvGo('day', fromKey(d.dataset.day)); return; }
  if (e.target.classList.contains('dcol')) { const r = e.target.getBoundingClientRect(); const mins = GRID_START * 60 + Math.max(0, Math.min(GRID_HOURS * 60 - 30, Math.floor((e.clientY - r.top) / HH * 2) * 30)); const day = fromKey(e.target.dataset.date); openNewEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60)); }
});
$('evClose').addEventListener('click', () => $('evOv').classList.remove('open'));

$('edDel').addEventListener('click', () => {
  const t = S.tasks.find(x => x.id === editing); if (!t) return;
  const copy = { ...t }; delTasks([t.id]); closeEditor();
  toast('To-do deleted.', () => restoreTask(copy));
});
$('toastUndo').addEventListener('click', () => { undoFn?.(); undoFn = null; $('toast').classList.remove('on'); });
$('openSettings').addEventListener('click', () => openSettings('cal'));
$('setClose').addEventListener('click', () => $('setOv').classList.remove('open'));
$('tabCal').addEventListener('click', () => showTab('cal'));
$('tabArea').addEventListener('click', () => showTab('area'));
bindRows($('calRows'), () => draftCals, renderCalRows);
bindRows($('areaRows'), () => draftAreas, renderAreaRows);
$('calAdd').addEventListener('click', () => { draftCals.push({ id: crypto.randomUUID(), name: '', url: '', color: CAL_COLORS[draftCals.length % CAL_COLORS.length], on: true }); renderCalRows(); });
$('calSave').addEventListener('click', async () => {
  const keep = draftCals.filter(c => c.url.trim()).map((c, i) => ({ id: c.id, name: c.name.trim() || 'Calendar', url: c.url.trim(), color: c.color, enabled: c.on !== false, sort: i, ...(S.needsCol === false ? {} : { needs_blocks: c.needs !== false }) }));
  const removed = S.cals.filter(c => !keep.some(k => k.id === c.id)).map(c => c.id);
  $('calSetNote').textContent = 'Saving…';
  if (removed.length) { const { error } = await sb.from('calendars').delete().in('id', removed); if (error) { $('calSetNote').textContent = 'Could not save: ' + error.message; return; } }
  if (keep.length) { const { error } = await sb.from('calendars').upsert(keep); if (error) { $('calSetNote').textContent = 'Could not save: ' + error.message; return; } }
  S.cals = keep.map(c => ({ id: c.id, name: c.name, url: c.url, color: c.color, on: c.enabled, needs: c.needs_blocks !== false }));
  cache.set('cals', S.cals.map(({ url, ...rest }) => rest));
  draftCals = S.cals.map(c => ({ ...c }));
  $('calSetNote').textContent = 'Refreshing…';
  CV.store = {};
  await refreshCalendars(); renderCalRows(); renderCal();
  $('calSetNote').textContent = Object.keys(S.calErr).length ? 'Saved. Some calendars had problems; see above.' : 'Saved and refreshed.';
});
$('areaAdd').addEventListener('click', () => { draftAreas.push({ id: 'a' + Date.now().toString(36), name: 'New business', color: '#2e6f8e' }); renderAreaRows(); });
$('areaSave').addEventListener('click', async () => {
  const areas = draftAreas.filter(a => a.name.trim()).map(a => ({ id: a.id, name: a.name.trim(), color: a.color }));
  const { error } = await sb.from('settings').upsert({ user_id: S.session.user.id, areas, updated_at: new Date().toISOString() });
  if (error) { banner('Businesses could not be saved: ' + error.message); return; }
  S.areas = areas.length ? areas : DEFAULT_AREAS; cache.set('areas', S.areas);
  $('setOv').classList.remove('open'); renderAll();
});
$('signOut').addEventListener('click', async () => { await sb.auth.signOut(); try { localStorage.clear(); } catch {} location.reload(); });
$('refresh').addEventListener('click', () => { refreshCalendars(); if (!$('calView').hidden) { CV.store = {}; CV.keepScroll = true; cvLoad(true); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeEditor(); $('setOv').classList.remove('open'); $('evOv').classList.remove('open'); $('neOv').classList.remove('open'); $('ftOv').classList.remove('open'); }
  if (!$('calView').hidden && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !e.metaKey && !e.ctrlKey && !document.querySelector('.ov.open')) {
    if (e.key === 'ArrowLeft') cvStep(-1); else if (e.key === 'ArrowRight') cvStep(1); else if (e.key === 't') cvGo(null, todayD()); else if (e.key === 'd') cvGo('day'); else if (e.key === 'w') cvGo('week'); else if (e.key === 'm') cvGo('month');
  }
  if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('app').hidden) { e.preventDefault(); $('q').focus(); }
});
for (const ov of ['edOv', 'setOv', 'evOv', 'neOv', 'ftOv']) $(ov).addEventListener('click', e => { if (e.target.id === ov) { $(ov).classList.remove('open'); if (ov === 'edOv') editing = null; } });
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('lgErr').hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email: $('lgEmail').value.trim(), password: $('lgPass').value });
  if (error) { $('lgErr').textContent = error.message; $('lgErr').hidden = false; }
});

/* ---------- boot ---------- */
let started = false;
async function start(session) {
  S.session = session;
  if (!session) { $('app').hidden = true; $('login').hidden = false; return; }
  $('login').hidden = true; $('app').hidden = false;
  if (started) return; started = true;
  S.tasks = cache.get('tasks') || []; if (S.tasks.length) S.tasksState = 'cached';
  S.areas = cache.get('areas') || DEFAULT_AREAS;
  S.cals = cache.get('cals') || [];
  S.pev = cache.get('pev') || [];
  const ev = cache.get('events'); if (ev && ev.day === todayK()) { S.remote = ev.events; S.calAt = ev.at; S.calState = 'ready'; }
  rebuildEvents();
  renderAll();
  route();
  await Promise.all([loadSettings(), loadTasks(), loadPersonal()]);
  rebuildEvents();
  renderAll();
  if (!$('calView').hidden) cvLoad();
  refreshCalendars();
  sb.channel('tasks-live').on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, p => {
    if (p.eventType === 'DELETE') S.tasks = S.tasks.filter(t => t.id !== p.old.id);
    else upsertLocal(fromRow(p.new));
    changed();
  }).on('postgres_changes', { event: '*', schema: 'public', table: 'personal_events' }, p => {
    if (p.eventType === 'DELETE') S.pev = S.pev.filter(v => v.id !== p.old.id);
    else { const v = pevFromRow(p.new), i = S.pev.findIndex(x => x.id === v.id); if (i >= 0) S.pev[i] = v; else S.pev.push(v); }
    personalChanged();
  }).subscribe();
  setInterval(() => { renderHeader(); renderAgenda(); renderCal(); }, 60000);
  setInterval(() => refreshCalendars(), 15 * 60000);
  let lastDay = todayK();
  setInterval(() => { if (todayK() !== lastDay) { lastDay = todayK(); refreshCalendars(); } }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadTasks(); loadPersonal().then(personalChanged); if (Date.now() - (S.calAt || 0) > 5 * 60000) refreshCalendars(); } });
}

(async () => {
  try {
    let cfg;
    try {
      const r = await fetch('/api/config');
      cfg = await r.json();
      if (!r.ok) throw new Error(cfg.error || 'Config missing');
      cache.set('cfg', cfg);
    } catch (e) {
      cfg = cache.get('cfg'); // offline: reuse the last settings so cached to-dos and calendar still show
      if (!cfg) throw e;
    }
    sb = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  } catch (e) {
    document.body.innerHTML = `<div class="login"><div><span class="tab">Day book</span><h1>Setup needed</h1><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  const { data } = await sb.auth.getSession();
  start(data.session);
  sb.auth.onAuthStateChange((_ev, session) => start(session));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
