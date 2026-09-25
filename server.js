/**
 * Dispatch — API server (deploy to Render)
 * =====================================================================
 * Same job as the earlier Cloudflare Worker version, but as a normal
 * long-running Node server — which means we get to use the official
 * `firebase-admin` SDK instead of hand-verifying JWTs, and the official
 * `@supabase/supabase-js` client instead of raw REST calls. Less code,
 * fewer places to get subtle crypto details wrong.
 *
 * Routes are identical to the Worker version (see README.md for the
 * full table), so index.html doesn't care which one it's talking to.
 * =====================================================================
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key} (see .env.example)`);
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Render's env var UI accepts real newlines, but if yours came through
    // as literal "\n" text, this turns them back into actual newlines.
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SEVERITY_MULT = { low: 0.7, normal: 1, high: 1.4, critical: 1.8 };

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------------------
   AUTH MIDDLEWARE
--------------------------------------------------------------- */
async function requireAuth(req, res, next) {
  const idToken = (req.headers.authorization || '').replace('Bearer ', '');
  if (!idToken) return res.status(401).json({ error: 'missing Firebase ID token' });
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'invalid token: ' + e.message });
  }
  const { data: profile, error } = await supabase
    .from('profiles').select('*').eq('firebase_uid', decoded.uid).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!profile) return res.status(403).json({ error: 'signed in, but no profile exists yet — ask an admin to create your account' });
  req.profile = profile;
  next();
}

function requireRole(check) {
  return (req, res, next) => {
    if (!check(req.profile)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

function scoreFor(category, severity) {
  const mult = SEVERITY_MULT[severity] ?? 1;
  return Math.round((category?.weight || 0) * mult);
}

function sortQueue(tickets) {
  return [...tickets]
    .filter(t => t.status !== 'resolved')
    .sort((a, b) => (b.score - a.score) || (new Date(a.created_at) - new Date(b.created_at)));
}

function rankAndEta(sortedQueue, categoriesById, ticketId) {
  const idx = sortedQueue.findIndex(t => t.id === ticketId);
  if (idx === -1) return null;
  let etaMinutes = 0;
  for (let i = 0; i < idx; i++) etaMinutes += categoriesById[sortedQueue[i].category_id]?.avg_minutes ?? 15;
  etaMinutes += Math.round((categoriesById[sortedQueue[idx].category_id]?.avg_minutes ?? 15) * 0.6);
  return { rank: idx + 1, total: sortedQueue.length, etaMinutes };
}

const bad = (res, e) => res.status(500).json({ error: e.message || 'internal error' });

/* ---------------------------------------------------------------
   ROUTES
--------------------------------------------------------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

// Who am I? Front end calls this right after signing in.
app.get('/me', requireAuth, (req, res) => res.json(req.profile));

app.get('/categories', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('categories').select('*').order('weight', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { bad(res, e); }
});

app.post('/tickets', requireAuth, async (req, res) => {
  try {
    const { categoryId, severity, description } = req.body;
    const { data: category } = await supabase.from('categories').select('*').eq('id', categoryId).maybeSingle();
    if (!category) return res.status(400).json({ error: 'unknown category' });
    if (category.department !== 'IT') {
      return res.status(400).json({ error: `not an IT matter — please contact ${category.department}` });
    }
    const { data, error } = await supabase.from('tickets').insert({
      profile_id: req.profile.id,
      category_id: category.id,
      severity: severity || 'normal',
      description: description || '',
      score: scoreFor(category, severity || 'normal'),
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { bad(res, e); }
});

app.get('/my-tickets', requireAuth, async (req, res) => {
  try {
    const [{ data: allOpen }, { data: categories }, { data: mine }] = await Promise.all([
      supabase.from('tickets').select('*').neq('status', 'resolved'),
      supabase.from('categories').select('*'),
      supabase.from('tickets').select('*').eq('profile_id', req.profile.id).order('created_at', { ascending: false }),
    ]);
    const categoriesById = Object.fromEntries(categories.map(c => [c.id, c]));
    const sorted = sortQueue(allOpen);
    res.json(mine.map(t => ({
      ...t,
      category: categoriesById[t.category_id],
      queue: t.status !== 'resolved' ? rankAndEta(sorted, categoriesById, t.id) : null,
    })));
  } catch (e) { bad(res, e); }
});

app.get('/queue', requireAuth, requireRole(p => p.is_it || p.is_admin), async (req, res) => {
  try {
    const [{ data: tickets }, { data: categories }, { data: people }] = await Promise.all([
      supabase.from('tickets').select('*').neq('status', 'resolved'),
      supabase.from('categories').select('*'),
      supabase.from('profiles').select('id,name,title'),
    ]);
    const categoriesById = Object.fromEntries(categories.map(c => [c.id, c]));
    const peopleById = Object.fromEntries(people.map(p => [p.id, p]));
    const sorted = sortQueue(tickets);
    res.json(sorted.map((t, i) => ({ ...t, rank: i + 1, category: categoriesById[t.category_id], requester: peopleById[t.profile_id] })));
  } catch (e) { bad(res, e); }
});

app.get('/resolved', requireAuth, requireRole(p => p.is_it || p.is_admin), async (req, res) => {
  try {
    const { data, error } = await supabase.from('tickets').select('*').eq('status', 'resolved').order('resolved_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { bad(res, e); }
});

app.post('/tickets/:id/:action(start|resolve)', requireAuth, requireRole(p => p.is_it || p.is_admin), async (req, res) => {
  try {
    const patch = req.params.action === 'start'
      ? { status: 'in_progress' }
      : { status: 'resolved', resolved_at: new Date().toISOString() };
    const { data, error } = await supabase.from('tickets').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { bad(res, e); }
});

app.get('/admin/people', requireAuth, requireRole(p => p.is_admin), async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (e) { bad(res, e); }
});

app.post('/admin/people', requireAuth, requireRole(p => p.is_admin), async (req, res) => {
  try {
    const { name, title, email, password, isIT, isAdmin } = req.body;
    // firebase-admin's createUser runs entirely server-side — it never
    // signs in as the new user, so the admin's own session is untouched.
    const fbUser = await admin.auth().createUser({ email, password, displayName: name });
    const { data, error } = await supabase.from('profiles').insert({
      firebase_uid: fbUser.uid, name, title, is_it: !!isIT, is_admin: !!isAdmin,
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { bad(res, e); }
});

app.delete('/admin/people/:id', requireAuth, requireRole(p => p.is_admin), async (req, res) => {
  try {
    const { data: target } = await supabase.from('profiles').select('*').eq('id', req.params.id).maybeSingle();
    if (!target) return res.status(404).json({ error: 'not found' });
    await admin.auth().deleteUser(target.firebase_uid);
    const { error } = await supabase.from('profiles').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ deleted: true });
  } catch (e) { bad(res, e); }
});

app.patch('/admin/categories/:id', requireAuth, requireRole(p => p.is_admin), async (req, res) => {
  try {
    const patch = {};
    if (req.body.weight !== undefined) patch.weight = Math.max(0, Math.min(100, Number(req.body.weight)));
    if (req.body.avgMinutes !== undefined) patch.avg_minutes = Math.max(0, Number(req.body.avgMinutes));
    const { data, error } = await supabase.from('categories').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { bad(res, e); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Dispatch API listening on :${port}`));
