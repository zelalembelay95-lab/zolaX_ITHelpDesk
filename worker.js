/**
 * Dispatch — Cloudflare Worker backend
 * -------------------------------------------------
 * Why this file exists: your front end uses Firebase for login and Supabase
 * for data. Those are two different providers, so Supabase's built-in
 * "auth.uid() row security" can't see a Firebase user. The fix is a small
 * trusted backend in between: this Worker verifies the visitor's Firebase ID
 * token, decides what they're allowed to do based on their profile, and only
 * then talks to Supabase using the SERVICE ROLE key (which must never be
 * sent to the browser).
 *
 * Deploy: `wrangler deploy` (see README.md). Set these secrets first:
 *   wrangler secret put SUPABASE_URL
 *   wrangler secret put SUPABASE_SERVICE_ROLE_KEY
 *   wrangler secret put FIREBASE_PROJECT_ID
 *
 * This is a starting skeleton, not a finished API — it shows the pattern
 * (verify token -> look up role -> enforce -> query Supabase) for the
 * three core actions. Extend it with the rest of the endpoints your
 * front end needs (list categories, admin edit weights, etc.) the same way.
 */

async function verifyFirebaseToken(idToken, projectId) {
  // Verifies the token's signature against Google's public keys and checks
  // aud/iss/exp. For production, use a maintained JWT library (e.g. `jose`)
  // rather than hand-rolling verification — this is a minimal illustration
  // of what must be checked, not copy-paste-safe crypto code.
  const [headerB64, payloadB64] = idToken.split('.');
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.aud !== projectId) throw new Error('wrong project');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (payload.exp * 1000 < Date.now()) throw new Error('expired token');
  // TODO: verify the RS256 signature against Google's rotating public certs
  // at https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
  return { uid: payload.user_id || payload.sub };
}

async function supabaseFetch(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getProfile(env, firebaseUid) {
  const rows = await supabaseFetch(env, `profiles?firebase_uid=eq.${firebaseUid}&select=*`);
  return rows[0] || null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        },
      });
    }

    const auth = request.headers.get('Authorization') || '';
    const idToken = auth.replace('Bearer ', '');
    if (!idToken) return json({ error: 'missing Firebase ID token' }, 401);

    let firebaseUser;
    try {
      firebaseUser = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
    } catch (e) {
      return json({ error: 'invalid token: ' + e.message }, 401);
    }

    const profile = await getProfile(env, firebaseUser.uid);
    if (!profile) return json({ error: 'no profile for this account — ask an admin to create one' }, 403);

    const url = new URL(request.url);

    // POST /tickets — create a ticket for the signed-in employee.
    if (url.pathname === '/tickets' && request.method === 'POST') {
      const body = await request.json();
      const categories = await supabaseFetch(env, `categories?id=eq.${body.categoryId}&select=*`);
      const cat = categories[0];
      if (!cat || cat.department !== 'IT') return json({ error: 'not an IT category' }, 400);

      const mult = { low: 0.7, normal: 1, high: 1.4, critical: 1.8 }[body.severity] || 1;
      const score = Math.round(cat.weight * mult);

      const [ticket] = await supabaseFetch(env, 'tickets', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: profile.id,
          category_id: cat.id,
          severity: body.severity,
          description: body.description,
          score,
        }),
      });
      return json(ticket, 201);
    }

    // GET /queue — the live prioritized queue. Anyone signed in can read it;
    // tighten this to IT/Admin only if you don't want employees seeing others' tickets.
    if (url.pathname === '/queue' && request.method === 'GET') {
      const rows = await supabaseFetch(
        env,
        `tickets?status=neq.resolved&select=*&order=score.desc,created_at.asc`
      );
      return json(rows);
    }

    // POST /tickets/:id/start and /resolve — IT only.
    const claimMatch = url.pathname.match(/^\/tickets\/([^/]+)\/(start|resolve)$/);
    if (claimMatch && request.method === 'POST') {
      if (!profile.is_it && !profile.is_admin) return json({ error: 'IT access required' }, 403);
      const [, id, action] = claimMatch;
      const patch = action === 'start'
        ? { status: 'in_progress' }
        : { status: 'resolved', resolved_at: new Date().toISOString() };
      const [ticket] = await supabaseFetch(env, `tickets?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      return json(ticket);
    }

    return json({ error: 'not found' }, 404);
  },
};
