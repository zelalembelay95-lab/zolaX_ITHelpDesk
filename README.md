# Dispatch — IT Helpdesk Queue

A ticketing system where employees submit issues, requests get auto-prioritized
by weight (a dead server outranks a stuck media player), and everyone can see
their place in line and an estimated wait time. Admins create accounts and set
each person's title; IT works one sorted queue.

## What's in this folder

- **`index.html`** — the whole front end. Open it directly in a browser and
  it works right now in **demo mode** (sample data in this browser's local
  storage) — no setup needed. Fill in the `CONFIG` object near the top of
  its `<script>` with your real Firebase project and your deployed Render
  API URL, and it automatically switches to **live mode**: real accounts,
  real Postgres data, the same UI.
- **`server/`** — the backend API, ready to deploy to **Render**
  (`server.js`, `package.json`, `.env.example`).
- **`supabase-schema.sql`** — the production database schema.
- **`worker.js`** — an alternative backend for **Cloudflare Workers**
  instead of Render, if you'd rather run on the edge. Same routes, same
  behavior; pick one or the other, not both.
- **`README.md`** — this file.

## Try it now

Just open `index.html` in a browser. Demo logins:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Administrator |
| `it` | `it123` | IT Support |
| `ceo` | `ceo123` | CEO (employee view) |
| `manager` | `manager123` | Manager (employee view) |
| `store` | `store123` | Store (employee view) |
| `hr` | `hr123` | HR (employee view) |
| `finance` | `finance123` | Finance (employee view) |

Try: log in as `ceo`, submit a "Printer not working" request, then a "Media
player issue" request. Log in as `it` and watch the printer request rank
above the media one automatically. Log in as `admin` to add a person or
change a category's weight.

## How priority actually works

Every ticket gets a **score = category weight × urgency multiplier**
(urgency: Low ×0.7, Normal ×1, High ×1.4, Critical ×1.8). The queue is sorted
by score, highest first, ties broken by whoever asked first. Estimated wait
time adds up the average fix time of everyone ranked ahead of you. Admins can
edit any category's weight and average fix time — the whole queue re-ranks
immediately.

Non-IT categories (Payroll, Leave, Inventory, etc.) have weight 0 and never
enter the IT queue — picking one shows a redirect message instead of a
submit button.

## Going live: one important design note first

You asked for Firebase (auth) + Supabase (database). That's a fine choice,
but worth knowing up front: **Firebase Auth and Supabase are two separate
identity systems.** Supabase's own security model (Row Level Security) is
built around *its own* auth — it can't natively recognize a Firebase login.
The standard fix is a thin trusted backend in between that checks the
Firebase login, then talks to Supabase on the user's behalf — that's what
`server/` (deployed to Render) does. The alternative — simpler, one fewer
moving part — is to drop Firebase and use **Supabase Auth** instead, since
Supabase already includes auth for free and RLS then works natively. Say
the word if you'd rather I rebuild it that way; it removes this backend
service entirely.

If you'd rather keep Firebase + Supabase as you specified, here's the setup:

### 1. Firebase (authentication)

1. Console → [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Build → Authentication → **Get started** → enable **Email/Password**.
3. Project settings → your web app → copy the `firebaseConfig` object.
4. Employees can't self-register — only Admin creates accounts (per your
   spec). The Worker's `POST /admin/people` endpoint handles this correctly:
   it creates the Firebase account server-side (via the public sign-up REST
   endpoint, using only the Web API key) so the admin's own browser session
   is never touched, then creates the matching Supabase profile in the same
   call. Removing someone (`DELETE /admin/people/:id`) uses Firebase's
   OAuth-authenticated admin endpoint instead, since deleting *another*
   user's account requires a real admin credential, not just an API key —
   that's what the service-account secrets are for.

### 2. Supabase (database)

1. [supabase.com](https://supabase.com) → **New project**.
2. SQL Editor → paste and run all of **`supabase-schema.sql`**.
3. Settings → API → copy the **Project URL** and the **`service_role`**
   key (⚠️ never put the service_role key in the front end — it belongs
   only in the Worker's secrets, step below).

### 3. Render (backend API)

1. [render.com](https://render.com) → **New** → **Web Service** → point it
   at the `server/` folder (push this project to a GitHub repo first, or
   use Render's manual deploy).
2. Build command: `npm install`. Start command: `npm start`.
3. In the service's **Environment** tab, add every variable from
   `server/.env.example`:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from Supabase step 2 above.
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` —
     Firebase console → Project settings → **Service accounts** → **Generate
     new private key**, which downloads a JSON file. Copy `project_id`,
     `client_email`, and `private_key` from it — Render's environment editor
     accepts the private key's real multi-line format, so paste it exactly
     as it appears (including the `-----BEGIN/END PRIVATE KEY-----` lines).
4. Deploy. Render gives you a URL like `https://dispatch-api.onrender.com`
   — that's the value for `apiBase` in `index.html`'s `CONFIG`.
5. Sanity check once it's up: `curl https://your-app.onrender.com/health`
   should return `{"ok":true}`.

Unlike the Cloudflare Worker version, this server uses the official
`firebase-admin` SDK, so creating a user is a single server-side call —
no separate Web API key needed, and no risk of it ever touching an
admin's own session.

### 4. Cloudflare (domain + hosting the front end)

1. Cloudflare dashboard → add `zolaxtech.com.et` (or a subdomain like
   `helpdesk.zolaxtech.com.et`) as a site.
2. Host `index.html` on **Cloudflare Pages** (drag-and-drop deploy, free —
   just this one file) and point your domain's DNS at it; Cloudflare issues
   the SSL certificate automatically. Cloudflare isn't running any of your
   application code here — Render does that — Cloudflare is purely DNS +
   static hosting + SSL for the page itself.

### 5. Fill in `CONFIG` and go live

At the top of `index.html`'s `<script>` block:

```js
const CONFIG = {
  firebase: {
    apiKey: "…",          // Firebase console > Project settings > General
    authDomain: "….firebaseapp.com",
    projectId: "…",
  },
  apiBase: "https://dispatch-api.onrender.com",  // your Render URL from step 3
};
```

The moment `apiKey` and `apiBase` are real values, the app switches from
demo mode to live mode automatically — same UI, same file, now talking to
real accounts and a real database. Note logins become **email addresses**
in live mode (Firebase requires it), so create the admin's first account
directly in the Firebase console with email/password sign-in, add a
matching row in Supabase's `profiles` table with `is_admin = true`, and
they can then use the People screen to add everyone else properly.

## The API (`server/server.js`)

Every route expects `Authorization: Bearer <Firebase ID token>` (get one
client-side with `await firebase.auth().currentUser.getIdToken()`).

| Method & path | Who | What |
|---|---|---|
| `GET /categories` | anyone signed in | list categories, for the request form |
| `POST /tickets` | anyone signed in | submit a ticket (rejected if category isn't IT's) |
| `GET /my-tickets` | anyone signed in | your own tickets, with live rank + ETA |
| `GET /queue` | IT, Admin | the full sorted live queue |
| `GET /resolved` | IT, Admin | resolved-ticket history |
| `POST /tickets/:id/start` | IT, Admin | claim a ticket |
| `POST /tickets/:id/resolve` | IT, Admin | close a ticket |
| `GET /admin/people` | Admin | list everyone |
| `POST /admin/people` | Admin | create a Firebase account + profile |
| `DELETE /admin/people/:id` | Admin | delete the Firebase account + profile |
| `PATCH /admin/categories/:id` | Admin | update a category's weight / avg fix time |

The priority-queue math (score, rank, ETA) is computed here, not trusted
from the client, so nobody can jump the queue by editing front-end code.

## Demo mode vs. live mode

`index.html` already contains both data layers (`DEMO` and `REMOTE`) and
picks between them automatically based on whether `CONFIG` looks filled
in — there's nothing left to wire up. Demo mode needs nothing; live mode
needs steps 1–5 above done and `CONFIG` filled in. Everything else — the
UI, the layout, the priority math shown to the user — is identical between
the two.

## Want me to go further?

I can, in follow-up turns:
- Rebuild this on **Supabase Auth only** (removes the separate backend
  service and the two-identity-system complexity, if you'd rather keep
  it simple).
- Add real-time updates (queue re-ranks live for everyone watching,
  via Supabase Realtime) instead of refresh-to-see.
- Add a proper "forgot password" flow, since Admin-created accounts
  start on a temporary password.
