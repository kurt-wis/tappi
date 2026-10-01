import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Booting PGlite (initdb inside wasm) costs ~1.5s per instance, so the migrated databases are built
// once, cached on disk keyed by the migration contents, and each test file loads a copy (~0.3s).

const migrationsDir = resolve(process.cwd(), "supabase/migrations");
const cacheRoot = resolve(process.cwd(), "node_modules/.cache/tappi-pglite");

export const FORMS_MIGRATION = "20261001000300_custom_registration_forms.sql";
export const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
`;

/** "beforeForms": every migration before FORMS_MIGRATION. "full": every migration. */
export type Snapshot = "beforeForms" | "full";

const extensions = { pgcrypto, citext };

export async function migrate(db: PGlite, filter: (name: string) => boolean) {
  for (const filename of migrations.filter(filter)) {
    await db.exec(readFileSync(resolve(migrationsDir, filename), "utf8"));
  }
}

function snapshotDir() {
  const hash = createHash("sha256");
  hash.update(readFileSync(resolve(process.cwd(), "node_modules/@electric-sql/pglite/package.json")));
  hash.update(BOOTSTRAP);
  for (const filename of migrations) hash.update(filename).update(readFileSync(resolve(migrationsDir, filename)));
  return resolve(cacheRoot, hash.digest("hex").slice(0, 16));
}

async function writeSnapshot(db: PGlite, path: string) {
  const dump = await db.dumpDataDir("none");
  writeFileSync(`${path}.tmp`, Buffer.from(await dump.arrayBuffer()));
  renameSync(`${path}.tmp`, path);
}

/** Builds the snapshots unless the cache already holds them for the current migrations. */
export async function buildSnapshots() {
  const dir = snapshotDir();
  if (existsSync(resolve(dir, "full.tar")) && existsSync(resolve(dir, "beforeForms.tar"))) return;
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = new PGlite({ extensions });
  try {
    await db.exec(BOOTSTRAP);
    await migrate(db, (name) => name < FORMS_MIGRATION);
    await writeSnapshot(db, resolve(dir, "beforeForms.tar"));
    await migrate(db, (name) => name >= FORMS_MIGRATION);
    await writeSnapshot(db, resolve(dir, "full.tar"));
  } finally {
    await db.close();
  }
}

export async function openTestDb(snapshot: Snapshot = "full"): Promise<PGlite> {
  const path = resolve(snapshotDir(), `${snapshot}.tar`);
  if (!existsSync(path)) await buildSnapshots();
  const db = new PGlite({ loadDataDir: new Blob([readFileSync(path)]), extensions });
  await db.waitReady;
  return db;
}
