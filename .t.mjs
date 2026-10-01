import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { readFileSync, readdirSync } from "node:fs";
let t=performance.now(); const lap=(l)=>{const n=performance.now();console.log(l,Math.round(n-t));t=n;};
const db = new PGlite({ extensions: { pgcrypto, citext } }); await db.waitReady; lap("init");
await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`); lap("bootstrap");
for (const f of readdirSync("supabase/migrations").sort()) { await db.exec(readFileSync("supabase/migrations/"+f,"utf8")); lap(f); }
const dump = await db.dumpDataDir("none"); lap("dump "+dump.size);
const db2 = new PGlite({ loadDataDir: dump, extensions: { pgcrypto, citext } }); await db2.waitReady; lap("load");
