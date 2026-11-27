# Database access security

nummioX exposes finance operations through its authenticated Express API. The browser must not query the Supabase Data API directly.

- Application tables in `public` have Row Level Security enabled.
- No `anon` or `authenticated` policies are intentionally defined: those roles have no schema/table/sequence access.
- The backend connects through the server-only PostgreSQL connection string. It must never be exposed to the browser.
- The Supabase `service_role` remains privileged and must never be used in the client.
- New public tables must have RLS enabled in their migration. CI checks this invariant.
- If a future feature needs direct Supabase Data API access, add narrowly scoped RLS policies and grants for that feature rather than reopening the whole schema.

The Prisma migration also revokes default privileges so newly created tables and sequences are not automatically exposed to public API roles.
