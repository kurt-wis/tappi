import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const db = new PGlite({ extensions: { pgcrypto, citext } });
const migrationsDir = resolve(process.cwd(), "supabase/migrations");

beforeAll(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  `);
  for (const filename of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(resolve(migrationsDir, filename), "utf8"));
  }
}, 60_000);

afterAll(async () => db.close());

describe("database migrations and PDF attendance invariants", () => {
  it("applies every migration to a blank database", async () => {
    const result = await db.query<{ name: string }>(`
      select table_name as name from information_schema.tables
      where table_schema='public' and table_name in ('persons','org_people','cards','registration_lookup_sessions')
      order by table_name
    `);
    expect(result.rows.map((row) => row.name)).toEqual(["cards", "org_people", "persons", "registration_lookup_sessions"]);
  });

  it("records time-out on a later tap, requires reconciliation, and keeps Tappies as a lifetime count", async () => {
    await db.exec(`
      insert into auth.users(id,email) values ('10000000-0000-4000-8000-000000000001','officer@test.local');
      insert into organizations(id,name,slug) values ('20000000-0000-4000-8000-000000000001','Test Org','test-org');
      insert into profiles(id,org_id,email,full_name,role) values
        ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','officer@test.local','Officer','org_admin');
      insert into persons(id,student_number,student_number_normalized,full_name,email) values
        ('30000000-0000-4000-8000-000000000001','A-1','A1','Alice','alice@test.local');
      insert into members(id,org_id,person_id,student_number,full_name,email,member_role) values
        ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','A1','Alice','alice@test.local','member');
      select link_member_card('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','2035787938','10000000-0000-4000-8000-000000000001');
      insert into events(id,org_id,title,starts_at,ends_at,status,walk_in_policy,timeout_gap_minutes) values
        ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Event 1','2026-01-01 09:00Z','2026-01-01 11:00Z','published','closed',15);
      insert into event_master_list(event_id,member_id) values
        ('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001');
      select record_scan('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','2035787938','2026-01-01 09:05Z');
      select record_scan('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','2035787938','2026-01-01 09:25Z');
    `);
    const attendance = await db.query<{ time_out: Date | null; registration_type: string; timing: string }>(`
      select time_out,registration_type,timing from attendance where event_id='50000000-0000-4000-8000-000000000001'
    `);
    expect(attendance.rows[0].time_out).not.toBeNull();
    expect(attendance.rows[0]).toMatchObject({ registration_type: "pre_registered", timing: "on_time" });

    await expect(db.query(`select finalize_event(
      '20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',false)`)).rejects.toMatchObject({ code: "TP033" });
    await db.exec(`
      select reconcile_event('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
      select finalize_event('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',false);
      insert into events(id,org_id,title,starts_at,ends_at,status) values
        ('50000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','Event 2','2026-02-01 09:00Z','2026-02-01 11:00Z','completed');
      insert into attendance(event_id,org_id,member_id,person_id,status,registration_type,timing,method)
        values('50000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','absent','pre_registered','on_time','manual');
    `);
    const summary = await db.query<{ current_tappies: number }>(`
      select current_tappies from report_member_summary('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001')
    `);
    expect(Number(summary.rows[0].current_tappies)).toBe(1);
  });

  it("enforces slots atomically and creates the attendee only when approved", async () => {
    await db.exec(`
      insert into events(id,org_id,title,starts_at,ends_at,status,slots,walk_in_policy) values
        ('50000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','Limited','2026-03-01 09:00Z','2026-03-01 11:00Z','published',1,'open');
      select register_for_event('50000000-0000-4000-8000-000000000003','Bob','B-2','bob@test.local','{}',false);
    `);
    await expect(db.query(`select register_for_event(
      '50000000-0000-4000-8000-000000000003','Carol','C-3','carol@test.local','{}',false)`))
      .rejects.toMatchObject({ code: "TP052" });
    const before = await db.query<{ count: number }>("select count(*)::int count from members where student_number='B2'");
    expect(before.rows[0].count).toBe(0);
    await db.exec(`select review_registration(
      '20000000-0000-4000-8000-000000000001',
      (select id from registrations where student_number='B2'),'approve','10000000-0000-4000-8000-000000000001')`);
    const after = await db.query<{ members: number; listed: number }>(`
      select (select count(*)::int from members where student_number='B2') members,
             (select count(*)::int from event_master_list eml join members m on m.id=eml.member_id where m.student_number='B2') listed
    `);
    expect(after.rows[0]).toEqual({ members: 1, listed: 1 });
  });
});
