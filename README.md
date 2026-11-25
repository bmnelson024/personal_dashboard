# Day Book

Brian's personal dashboard: to-dos for every business plus personal, and all of his Outlook calendars on one screen. It installs as an app on a computer or phone.

- **Front end:** plain HTML, CSS and JavaScript in `public/`. There is no build step.
- **Hosting:** Netlify. The `/api/calendars` function downloads the Outlook ICS feeds on the server, so the browser never runs into cross-site blocks.
- **Data and sign-in:** Supabase. To-dos, calendar links and business settings are tables locked to your login by row level security. To-dos sync live between devices.

```
public/                  the app (index.html, app.js, style.css, icons, service worker)
netlify/functions/       config.mjs (hands the browser the public Supabase settings)
                         calendars.mjs (fetches and expands your calendars)
netlify/lib/ical.mjs     the Outlook calendar reader
supabase/schema.sql      tables and security rules
netlify.toml             Netlify settings
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

## Making changes
Edit the files, commit, and push. Netlify redeploys on its own. After changing anything in `public/`, raise `VERSION` in `public/sw.js` (for example `daybook-v2`) so installed copies pick up the update.

## Notes
- Calendars refresh when the app opens, every 15 minutes, and when you click **Refresh calendars**. Outlook updates published feeds on its own schedule, often every 15 to 30 minutes, so a brand-new meeting can take a little while to appear.
- A published ICS link gives read access to anyone who has it. The app keeps the links in your Supabase account and only sends them to the server function. If one ever leaks, unpublish and republish that calendar in Outlook to get a new link.
- If a work account has no Publish option, IT has turned off publishing for that account. That calendar would need a Microsoft Graph connection instead.
