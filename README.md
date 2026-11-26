# Day Book

Brian's personal dashboard: to-dos for every business plus personal, all of his Outlook calendars, and a built-in Personal calendar on one screen. It installs as an app on a computer or phone.

## What it does
- **Dashboard:** today's schedule, the next 5 workdays, and to-dos grouped by business (overdue, today, this week, later). Quick add understands `#n6`, `!` and trailing dates like `fri` or `12/3`.
- **Calendar:** day, week and month views from 6 am to 8 pm, weekends optional, calendars you can show or hide, meeting hours per calendar, and Join buttons for Teams, Zoom, Meet and Webex links.
- **Unavailable blocks:** "Unavailable" holds are hidden from the dashboard, and any booking missing a matching hold on the calendars you check is flagged with a red **!**. Out-of-office and whole-day holds don't count as meetings.
- **Find open time:** free slots across all calendars for a chosen length and week, with a Copy for email button.
- **Personal calendar:** stored in Day Book, with weekly repeats, skip one date, and a private subscribe link for your phone, Outlook, Google or the Skylight.
- **To-dos:** repeating to-dos (daily to yearly), high priority, notes, undo, and Block time to put a to-do on the calendar.
- **New events for Outlook calendars:** fill in the event in Day Book and it opens in the right Outlook account to save.
- **Backup:** Settings > Download backup saves everything as a JSON file.

## How it's built
- **Front end:** plain HTML, CSS and JavaScript in `public/`. No build step. The Supabase library is a bundled copy in `public/vendor/` so the app doesn't depend on a public CDN and can open offline.
- **Hosting:** Netlify. Server functions download the Outlook ICS feeds (so the browser never runs into cross-site blocks) and publish the Personal calendar feed.
- **Data and sign-in:** Supabase. Every table is locked to your login by row level security. To-dos and personal events sync live between devices.
- **Security headers:** a Content Security Policy in `netlify.toml` lets the page load code only from this site, Google Fonts and Supabase.

```
public/                        the app (index.html, app.js, style.css, icons, service worker)
public/vendor/                 bundled @supabase/supabase-js 2.45.4
netlify/functions/config.mjs   hands the browser the public Supabase settings
netlify/functions/calendars.mjs  fetches and expands your Outlook calendars (8 s per feed; Netlify stops functions at 10 s)
netlify/functions/personal-ics.mjs  the Personal calendar subscribe feed at /cal/<token>.ics
netlify/lib/ical.mjs           the Outlook calendar reader
tests/ical.test.mjs            tests for the calendar reader (npm test)
supabase/schema.sql            all tables, security rules and functions (safe to run again)
netlify.toml                   Netlify settings and security headers
```

## Setup (about 15 minutes)

### 1. Supabase
1. Create a project, or use an existing one.
2. Open **SQL Editor**, click **New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Go to **Authentication > Users > Add user > Create new user**. Enter your email and a password, and check **Auto Confirm User**.
4. Go to **Authentication > Sign In / Providers** and turn off **Allow new users to sign up**. This keeps the app to just you.
5. Go to **Project Settings > API** (labeled **Data API / API Keys** in newer dashboards) and copy two values: the **Project URL** and the **anon public** key. The anon key is meant to be public. Never use the `service_role` key here.

### 2. GitHub
1. Create a new **private** repository, for example `day-book`.
2. Upload the contents of this folder: drag the files into the GitHub web page, or run:
   ```
   git init && git add . && git commit -m "Day Book"
   git branch -M main
   git remote add origin https://github.com/<you>/day-book.git
   git push -u origin main
   ```

### 3. Netlify
1. Click **Add new site > Import an existing project > GitHub** and pick the repository. Netlify reads `netlify.toml`, so leave the build settings as they are.
2. Before or after the first deploy, go to **Site configuration > Environment variables** and add:
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = your anon public key
3. Go to **Deploys > Trigger deploy > Deploy site** so the variables take effect.
4. Optional: rename the site under **Site configuration > Change site name**, for example `brian-daybook.netlify.app`.

### 4. Use it
1. Open the site and sign in.
2. Click **Settings > Add calendar** and paste the ICS link for each Outlook calendar. To get a link: in Outlook on the web, go to Settings > Calendar > Shared calendars > Publish a calendar, choose "Can view all details", click Publish, and copy the **ICS** link.
3. Install it:
   - **Windows or Mac, Chrome or Edge:** click the install icon at the right end of the address bar.
   - **iPhone:** in Safari, tap Share > Add to Home Screen.
   - **Android:** in Chrome, tap the menu > Install app.

## Database updates
`supabase/schema.sql` always holds the full, current setup and is safe to run again on an existing project: it only adds what's missing. After pulling a change that touches it, paste the whole file into the Supabase SQL Editor and run it.

## Making changes
Edit the files, commit, and push. Netlify redeploys on its own. After changing anything in `public/`, raise `VERSION` in `public/sw.js` so installed copies pick up the update.

- **Run the tests:** `npm test` (needs Node 18 or newer).
- **Update the bundled Supabase library:** in an empty folder run `npm i @supabase/supabase-js@<version> esbuild`, then `echo "export { createClient } from '@supabase/supabase-js';" > entry.js && npx esbuild entry.js --bundle --format=esm --minify --outfile=supabase-<version>.js`. Copy the file into `public/vendor/` and update the import at the top of `public/app.js` and the list in `public/sw.js`.

## Notes
- Calendars refresh when the app opens, every 15 minutes, and when you click **Refresh calendars**. Outlook updates published feeds on its own schedule, often every 15 to 30 minutes, so a brand-new meeting can take a little while to appear.
- A published ICS link gives read access to anyone who has it. The app keeps the links in your Supabase account and only sends them to the server function. If one ever leaks, unpublish and republish that calendar in Outlook to get a new link.
- If a work account has no Publish option, IT has turned off publishing for that account. That calendar would need a Microsoft Graph connection instead.
