# Dispatch — IT Helpdesk Queue

A ticketing system where employees submit issues, requests get auto-prioritized
by weight (a dead server outranks a stuck media player), and everyone can see
their place in line and an estimated wait time. Admins create accounts and set
each person's title; IT works one sorted queue.

## What's in this folder

- **`index.html`** — the whole app. Open it directly in a browser and it
  works right now, using your browser's local storage as the "database" so
  you can click through every screen (login, submit a request, IT queue,
  admin panel) before wiring up real accounts.
- **`supabase-schema.sql`** — the production database schema.
- **`worker.js`** — a Cloudflare Worker that sits between the front end and
  Supabase (explanation below for why you need this).
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
Firebase login, then talks to Supabase on the user's behalf. That's what
`worker.js` is. The alternative — simpler, one fewer moving part — is to
drop Firebase and use **Supabase Auth** instead, since Supabase already
includes auth for free and RLS then works natively. Say the word if you'd
rather I rebuild it that way; it removes the Worker entirely.

If you'd rather keep Firebase + Supabase as you specified, here's the setup:

### 1. Firebase (authentication)

1. Console → [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Build → Authentication → **Get started** → enable **Email/Password**.
3. Project settings → your web app → copy the `firebaseConfig` object.
4. Employees can't self-register — only Admin creates accounts (per your
   spec) — so **don't** use client-side `createUserWithEmailAndPassword` for
   that (it signs the admin out and logs in as the new user). Instead, the
   Worker should create Firebase users server-side via the [Identity
   Toolkit REST API](https://cloud.google.com/identity-platform/docs/use-rest-api)
   using a Firebase service account. That endpoint isn't stubbed in
   `worker.js` yet — ask and I'll add it.

### 2. Supabase (database)

1. [supabase.com](https://supabase.com) → **New project**.
2. SQL Editor → paste and run all of **`supabase-schema.sql`**.
3. Settings → API → copy the **Project URL** and the **`service_role`**
   key (⚠️ never put the service_role key in the front end — it belongs
   only in the Worker's secrets, step below).

### 3. Cloudflare (Worker backend + domain)

```
npm install -g wrangler
wrangler login
wrangler deploy worker.js
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put FIREBASE_PROJECT_ID
```

Then, for the domain:
1. Cloudflare dashboard → add `zolaxtech.com.et` (or a subdomain like
   `helpdesk.zolaxtech.com.et`) as a site, or a Worker route.
2. Host `index.html` on **Cloudflare Pages** (drag-and-drop deploy, free) and
   point your domain's DNS at it — Cloudflare will issue the SSL cert
   automatically.
3. Point the Worker at a route like `helpdesk.zolaxtech.com.et/api/*`.

### 4. Wire the front end to the real backend

In `index.html`, everything storage-related lives inside the
`DataLayer` object near the top of the `<script>` — that's the only part
that needs to change. Today its methods read/write `localStorage`. Swap
each one for:

- `login()` → Firebase `signInWithEmailAndPassword()`, then call your
  Worker's `/tickets`, `/queue`, etc. with `getIdToken()` as the
  `Authorization: Bearer <token>` header.
- `getTickets()` / `getUsers()` / `getCategories()` → `fetch()` calls to
  the Worker endpoints (`GET /queue`, etc.), which query Supabase for you.
- Ticket creation/claim/resolve buttons already call clearly-named
  functions (`submit-ticket`, `data-action="start"/"resolve"`) — point
  those at `POST /tickets`, `POST /tickets/:id/start`, `POST
  /tickets/:id/resolve` from `worker.js`.

Everything else — the UI, the priority math, the layout — stays exactly
as it is.

## Want me to go further?

I can, in follow-up turns:
- Finish `worker.js` into a complete API (admin add/remove people,
  live category weight edits, the Firebase Admin user-creation endpoint).
- Rebuild this on **Supabase Auth only** (removes the Worker and the
  two-identity-system complexity, if you'd rather keep it simple).
- Add real-time updates (queue re-ranks live for everyone watching,
  via Supabase Realtime) instead of refresh-to-see.
