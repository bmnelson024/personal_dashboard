// GET /api/config: hands the browser the public Supabase settings from
// Netlify environment variables, so no keys live in the repository.
export default async () => {
  const url = process.env.SUPABASE_URL, anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return new Response(JSON.stringify({ error: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in Netlify, then redeploy.' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ url, anonKey }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
};
