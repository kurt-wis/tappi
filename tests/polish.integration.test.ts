import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { FORMS_MIGRATION, migrate, openTestDb } from "./helpers/pglite";

const ORG = "20000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "20000000-0000-4000-8000-0000000000b1";
const ADMIN = "10000000-0000-4000-8000-0000000000a1";
const OTHER_ADMIN = "10000000-0000-4000-8000-0000000000b1";
const P1 = "30000000-0000-4000-8000-0000000000a1";
const P2 = "30000000-0000-4000-8000-0000000000a2";
const OUTSIDER = "30000000-0000-4000-8000-0000000000b1";
const M1 = "40000000-0000-4000-8000-0000000000a1";
const M2 = "40000000-0000-4000-8000-0000000000a2";
const DONE = "50000000-0000-4000-8000-0000000000a1";
const DRAFT = "50000000-0000-4000-8000-0000000000a2";

describe("legacy form field tables migrate into jsonb", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await openTestDb("beforeForms");
  });
  afterAll(async () => db.close());

  it("moves org defaults into settings and event extras onto the event, then drops the tables", async () => {
    await db.exec(`
      insert into organizations(id,name,slug,settings) values ('${ORG}','Org','org','{"keep":true}');
      insert into events(id,org_id,title,starts_at) values ('${DRAFT}','${ORG}','E','2026-05-01 09:00Z');
      insert into org_form_fields(org_id,key,label,type,required,options,position) values
        ('${ORG}','year_level','Year level','select',true,'["1","2"]',2),
        ('${ORG}','course','Course','text',false,null,1);
      insert into event_form_fields(event_id,key,label,type,required,position) values
        ('${DRAFT}','diet','Dietary notes','textarea',false,0);
    `);
    await migrate(db, (name) => name >= FORMS_MIGRATION);
    const org = await db.query<{ settings: Record<string, unknown> }>(`select settings from organizations where id='${ORG}'`);
    expect(org.rows[0].settings).toEqual({
      keep: true,
      registration_fields: [
        { key: "course", label: "Course", type: "text", required: false },
        { key: "year_level", label: "Year level", type: "select", required: true, options: ["1", "2"] },
      ],
    });
    const event = await db.query<{ form_fields: unknown }>(`select form_fields from events where id='${DRAFT}'`);
    expect(event.rows[0].form_fields).toEqual([{ key: "diet", label: "Dietary notes", type: "textarea", required: false }]);
    const tables = await db.query(`select 1 from information_schema.tables where table_name in ('org_form_fields','event_form_fields')`);
    expect(tables.rows).toHaveLength(0);
  }, 60_000);
});

describe("Part 12 and 13 database functions", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await openTestDb();
    await db.exec(`
      insert into auth.users(id,email) values ('${ADMIN}','admin@a.test'),('${OTHER_ADMIN}','admin@b.test');
      insert into organizations(id,name,slug,settings) values
        ('${ORG}','Org A','org-a','{"theme":"blue"}'),('${OTHER_ORG}','Org B','org-b','{}');
      insert into profiles(id,org_id,email,full_name,role) values
        ('${ADMIN}','${ORG}','admin@a.test','Admin A','org_admin'),
        ('${OTHER_ADMIN}','${OTHER_ORG}','admin@b.test','Admin B','org_admin');
      insert into persons(id,student_number,student_number_normalized,full_name,email,email_verified,person_type) values
        ('${P1}','A-1','A1','Alice','alice@a.test',true,'verified'),
        ('${P2}','B-2','B2','Bob','bob@a.test',false,'guest'),
        ('${OUTSIDER}','Z-9','Z9','Zed','zed@b.test',true,'verified');
      insert into members(id,org_id,person_id,student_number,full_name,email,member_role) values
        ('${M1}','${ORG}','${P1}','A1','Alice','alice@a.test','member'),
        ('${M2}','${ORG}','${P2}','B2','Bob','bob@a.test','member'),
        ('40000000-0000-4000-8000-0000000000b1','${OTHER_ORG}','${OUTSIDER}','Z9','Zed','zed@b.test','member');
      select link_member_card('${ORG}','${M1}','1001','${ADMIN}');
      insert into events(id,org_id,title,starts_at,ends_at,status,walk_in_policy,certificate_enabled,points_value,created_by,form_fields) values
        ('${DONE}','${ORG}','Finished','2026-01-01 09:00Z','2026-01-01 11:00Z','published','closed',true,5,'${ADMIN}',
         '[{"key":"diet","label":"Diet","type":"text","required":false}]'),
        ('${DRAFT}','${ORG}','Planned','2026-12-01 09:00Z','2026-12-01 11:00Z','draft','closed',false,0,'${ADMIN}','[]');
      insert into event_master_list(event_id,member_id,added_by) values
        ('${DONE}','${M1}','${ADMIN}'),('${DONE}','${M2}','${ADMIN}'),('${DRAFT}','${M2}','${ADMIN}');
      select record_scan('${ORG}','${DONE}','1001','2026-01-01 09:05Z','${ADMIN}','TAP-1');
      select reconcile_event('${ORG}','${DONE}','${ADMIN}');
      select finalize_event('${ORG}','${DONE}','${ADMIN}',false);
      select issue_certificates('${ORG}','${DONE}','${ADMIN}');
      insert into devices(org_id,device_id,label,status,registered_by) values ('${ORG}','TAP-1','Door','active','${ADMIN}');
    `);
  }, 60_000);

  afterAll(async () => db.close());

  const count = async (sql: string) => Number((await db.query<{ n: number }>(`select (${sql})::int n`)).rows[0].n);

  describe("registration forms", () => {
    it("stores answers and the field snapshot on the registration", async () => {
      await db.exec(`update events set status='draft' where id='${DRAFT}'`);
      await db.exec(`insert into events(id,org_id,title,starts_at,status) values
        ('50000000-0000-4000-8000-0000000000a9','${ORG}','Open','2026-11-01 09:00Z','published')`);
      const reg = await db.query<{ answers: unknown; form_snapshot: unknown }>(`
        select answers, form_snapshot from register_for_event('50000000-0000-4000-8000-0000000000a9','Cara','C-3','cara@a.test',
          '{"diet":"vegan"}', false, null, '[{"key":"diet","label":"Diet","type":"text","required":false,"source":"event_extra"}]')`);
      expect(reg.rows[0]).toEqual({
        answers: { diet: "vegan" },
        form_snapshot: [{ key: "diet", label: "Diet", type: "text", required: false, source: "event_extra" }],
      });
      await expect(db.query(`select register_for_event('50000000-0000-4000-8000-0000000000a9','Dan','D-4','d@a.test','[]',false)`))
        .rejects.toMatchObject({ code: "23514" });
    });

    it("updates org defaults without clobbering other settings", async () => {
      await db.exec(`select set_org_registration_fields('${ORG}','[{"key":"year","label":"Year","type":"text","required":true}]')`);
      const settings = await db.query<{ settings: Record<string, unknown> }>(`select settings from organizations where id='${ORG}'`);
      expect(settings.rows[0].settings).toEqual({ theme: "blue", registration_fields: [{ key: "year", label: "Year", type: "text", required: true }] });
      await expect(db.query(`select set_org_registration_fields('${ORG}','{}')`)).rejects.toMatchObject({ code: "22023" });
      await expect(db.query(`select set_org_registration_fields('20000000-0000-4000-8000-0000000000ff','[]')`)).rejects.toMatchObject({ code: "TP070" });
    });

    it("locks the event form once the event is completed or cancelled, and scopes it to the org", async () => {
      await expect(db.query(`select set_event_form_fields('${ORG}','${DONE}','[]')`)).rejects.toMatchObject({ code: "TP071" });
      await expect(db.query(`select set_event_form_fields('${OTHER_ORG}','${DRAFT}','[]')`)).rejects.toMatchObject({ code: "TP010" });
      const fields = '[{"key":"shirt","label":"Shirt size","type":"select","required":true,"options":["S","M","L"]}]';
      await db.exec(`select set_event_form_fields('${ORG}','${DRAFT}','${fields}')`);
      expect((await db.query<{ f: unknown }>(`select form_fields f from events where id='${DRAFT}'`)).rows[0].f).toEqual(JSON.parse(fields));
      const tooMany = JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ key: `f${i}` })));
      await expect(db.query(`select set_event_form_fields('${ORG}','${DRAFT}','${tooMany}')`)).rejects.toMatchObject({ code: "22023" });
      await expect(db.query(`update events set form_fields='${tooMany}' where id='${DRAFT}'`)).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("rate limiting", () => {
    it("allows up to the limit per key and window, then denies", async () => {
      const hit = async (key: string) => (await db.query<{ r: { allowed: boolean; remaining: number; retry_after: number } }>(
        `select consume_rate_limit('${key}', 2, 60) r`)).rows[0].r;
      expect(await hit("k1")).toMatchObject({ allowed: true, remaining: 1 });
      expect(await hit("k1")).toMatchObject({ allowed: true, remaining: 0 });
      const denied = await hit("k1");
      expect(denied).toMatchObject({ allowed: false, remaining: 0 });
      expect(denied.retry_after).toBeGreaterThanOrEqual(1);
      expect(denied.retry_after).toBeLessThanOrEqual(60);
      expect(await hit("k2")).toMatchObject({ allowed: true });
      await expect(db.query(`select consume_rate_limit('', 1, 60)`)).rejects.toMatchObject({ code: "22023" });
      await expect(db.query(`select consume_rate_limit('k', 0, 60)`)).rejects.toMatchObject({ code: "22023" });
      await expect(db.query(`select consume_rate_limit('k', 1, 86401)`)).rejects.toMatchObject({ code: "22023" });
    });
  });

  describe("audit log", () => {
    it("is append-only but still lets a staff profile be deleted", async () => {
      await db.exec(`
        insert into auth.users(id,email) values ('10000000-0000-4000-8000-0000000000a9','temp@a.test');
        insert into profiles(id,org_id,email,full_name,role) values ('10000000-0000-4000-8000-0000000000a9','${ORG}','temp@a.test','Temp','officer');
        insert into audit_logs(org_id,actor_id,action,entity,metadata,ip) values
          ('${ORG}','10000000-0000-4000-8000-0000000000a9','event.created','events','{"a":1}','203.0.113.1');
      `);
      await expect(db.query(`update audit_logs set action='tampered' where action='event.created'`)).rejects.toMatchObject({ code: "42501" });
      await expect(db.query(`update audit_logs set actor_id=null, metadata='{}' where action='event.created'`)).rejects.toMatchObject({ code: "42501" });
      await db.exec(`delete from auth.users where id='10000000-0000-4000-8000-0000000000a9'`);
      const row = await db.query<{ actor_id: string | null; metadata: unknown; ip: string }>(
        `select actor_id, metadata, ip from audit_logs where action='event.created'`);
      expect(row.rows).toEqual([{ actor_id: null, metadata: { a: 1 }, ip: "203.0.113.1" }]);
    });
  });

  describe("device inventory", () => {
    it("reports statuses for registered devices of the org only and records last_seen_at", async () => {
      await db.exec(`insert into devices(org_id,device_id,status) values ('${ORG}','TAP-LOST','lost'),('${OTHER_ORG}','TAP-B','active')`);
      const rows = await db.query<{ device_id: string; status: string }>(
        `select * from touch_devices('${ORG}', array['TAP-1','TAP-LOST','TAP-B','NOPE']) order by 1`);
      expect(rows.rows).toEqual([{ device_id: "TAP-1", status: "active" }, { device_id: "TAP-LOST", status: "lost" }]);
      expect(await count(`select count(*) from devices where org_id='${ORG}' and last_seen_at is not null`)).toBe(2);
      expect(await count(`select count(*) from devices where device_id='TAP-B' and last_seen_at is not null`)).toBe(0);
      await expect(db.query(`insert into devices(org_id,device_id,status) values ('${ORG}','X','stolen')`)).rejects.toMatchObject({ code: "23514" });
      await expect(db.query(`insert into devices(org_id,device_id) values ('${ORG}',' padded ')`)).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("backup and restore", () => {
    let backup: Record<string, any>;
    const restoreSql = (payload: unknown, dryRun: boolean, settings = false) =>
      db.query<{ r: { dry_run: boolean; settings_restored: boolean; in_backup: Record<string, number>; inserted: Record<string, number> } }>(
        `select restore_org_backup($1, $2::jsonb, $3, $4) r`, [ORG, JSON.stringify(payload), dryRun, settings]);
    const snapshot = async () => ({
      events: await count(`select count(*) from events where org_id='${ORG}'`),
      eml: await count(`select count(*) from event_master_list l join events e on e.id=l.event_id where e.org_id='${ORG}'`),
      attendance: await count(`select count(*) from attendance where org_id='${ORG}'`),
      certificates: await count(`select count(*) from certificates where org_id='${ORG}'`),
      points: await count(`select count(*) from points_ledger where org_id='${ORG}'`),
      registrations: await count(`select count(*) from registrations where org_id='${ORG}'`),
    });

    it("exports only the org's records", async () => {
      backup = (await db.query<{ b: Record<string, any> }>(`select export_org_backup('${ORG}') b`)).rows[0].b;
      expect(backup).toMatchObject({ format: "tappi.org-backup", version: 1, org_id: ORG });
      expect(backup.organization.settings).toMatchObject({ theme: "blue" });
      expect(backup.data.members.map((m: { id: string }) => m.id).sort()).toEqual([M1, M2]);
      expect(backup.data.persons.map((p: { id: string }) => p.id)).not.toContain(OUTSIDER);
      expect(backup.data.devices.map((d: { device_id: string }) => d.device_id).sort()).toEqual(["TAP-1", "TAP-LOST"]);
      expect(backup.data.attendance).toHaveLength(2);
      expect(backup.data.certificates).toHaveLength(1);
      expect(backup.profiles).toEqual([expect.objectContaining({ id: ADMIN, role: "org_admin" })]);
      await expect(db.query(`select export_org_backup('20000000-0000-4000-8000-0000000000ff')`)).rejects.toMatchObject({ code: "TP080" });
    });

    it("inserts nothing when every record still exists", async () => {
      const before = await snapshot();
      const result = (await restoreSql(backup, false)).rows[0].r;
      expect(Object.values(result.inserted).every((n) => n === 0)).toBe(true);
      expect(await snapshot()).toEqual(before);
    });

    it("previews a restore without changing anything", async () => {
      const before = await snapshot();
      await db.exec(`delete from events where id='${DONE}'`);
      const afterLoss = await snapshot();
      expect(afterLoss.events).toBe(before.events - 1);
      const preview = (await restoreSql(backup, true, true)).rows[0].r;
      expect(preview).toMatchObject({ dry_run: true, settings_restored: true });
      expect(preview.inserted).toMatchObject({
        events: 1, event_master_list: 2, attendance: 2, certificates: 1, points_ledger: 0, points_ledger_relinked: 1,
      });
      expect(await snapshot()).toEqual(afterLoss);
      expect((await db.query<{ s: unknown }>(`select settings s from organizations where id='${ORG}'`)).rows[0].s)
        .toMatchObject({ registration_fields: expect.any(Array) });
    });

    it("restores deleted records with their original state, and is idempotent", async () => {
      const result = (await restoreSql(backup, false)).rows[0].r;
      expect(result.dry_run).toBe(false);
      expect(result.inserted).toMatchObject({
        events: 1, event_master_list: 2, attendance: 2, certificates: 1, points_ledger: 0, points_ledger_relinked: 1,
      });
      expect(await count(`select count(*) from points_ledger where event_id='${DONE}' and member_id='${M1}'`)).toBe(1);
      const event = await db.query<{ status: string; reconciled_by: string; form_fields: unknown }>(
        `select status, reconciled_by, form_fields from events where id='${DONE}'`);
      expect(event.rows[0]).toEqual({ status: "completed", reconciled_by: ADMIN, form_fields: [{ key: "diet", label: "Diet", type: "text", required: false }] });
      expect(await count(`select count(*) from events where id='${DONE}' and reconciled_at is not null`)).toBe(1);
      const summary = await db.query<{ current_tappies: number; credits: number }>(
        `select current_tappies, credits from report_member_summary('${ORG}','${M1}')`);
      expect(summary.rows[0]).toMatchObject({ current_tappies: 1, credits: 5 });
      const again = (await restoreSql(backup, false)).rows[0].r;
      expect(Object.values(again.inserted).every((n) => n === 0)).toBe(true);
    });

    it("does not re-open or un-reconcile existing events", async () => {
      const before = await db.query(`select status, reconciled_at from events where id='${DONE}'`);
      await restoreSql(backup, false);
      expect((await db.query(`select status, reconciled_at from events where id='${DONE}'`)).rows).toEqual(before.rows);
    });

    it("only overwrites settings when asked", async () => {
      await db.exec(`update organizations set settings='{"changed":true}' where id='${ORG}'`);
      await restoreSql(backup, false);
      expect((await db.query<{ s: unknown }>(`select settings s from organizations where id='${ORG}'`)).rows[0].s).toEqual({ changed: true });
      const result = (await restoreSql(backup, false, true)).rows[0].r;
      expect(result.settings_restored).toBe(true);
      expect((await db.query<{ s: unknown }>(`select settings s from organizations where id='${ORG}'`)).rows[0].s)
        .toEqual(backup.organization.settings);
    });

    it("never attaches another organization's person through a crafted backup", async () => {
      const crafted = structuredClone(backup);
      crafted.data = {
        persons: [{ id: OUTSIDER, student_number: "NEW-1", full_name: "Mallory", email: "zed@b.test", email_verified: true }],
        members: [{ id: "40000000-0000-4000-8000-0000000000c1", person_id: OUTSIDER, student_number: "NEW1", full_name: "Mallory", member_role: "member", status: "active" }],
        cards: [{ uid: "777", person_id: OUTSIDER, active: true }],
      };
      const result = (await restoreSql(crafted, false)).rows[0].r;
      expect(result.inserted).toMatchObject({ persons: 1, members: 1, cards: 1 });
      expect(await count(`select count(*) from members where org_id='${ORG}' and person_id='${OUTSIDER}'`)).toBe(0);
      const created = await db.query<{ email_verified: boolean; person_type: string }>(
        `select p.email_verified, p.person_type from members m join persons p on p.id=m.person_id where m.id='40000000-0000-4000-8000-0000000000c1'`);
      expect(created.rows).toEqual([{ email_verified: false, person_type: "guest" }]);
      expect(await count(`select count(*) from cards where uid='777' and person_id='${OUTSIDER}'`)).toBe(0);
      expect((await db.query<{ email: string }>(`select email from persons where id='${OUTSIDER}'`)).rows[0].email).toBe("zed@b.test");
    });

    it("forces rows into the restoring org", async () => {
      const crafted = structuredClone(backup);
      crafted.data = { devices: [{ id: "60000000-0000-4000-8000-0000000000c1", org_id: OTHER_ORG, device_id: "SNEAKY" }] };
      await restoreSql(crafted, false);
      expect((await db.query(`select org_id from devices where device_id='SNEAKY'`)).rows).toEqual([{ org_id: ORG }]);
    });

    it("rejects backups for other orgs and malformed payloads", async () => {
      await expect(restoreSql({ ...backup, org_id: OTHER_ORG }, true)).rejects.toMatchObject({ code: "TP082" });
      await expect(restoreSql({ ...backup, version: 2 }, true)).rejects.toMatchObject({ code: "TP081" });
      await expect(restoreSql({ ...backup, data: { members: {} } }, true)).rejects.toMatchObject({ code: "TP081" });
      await expect(restoreSql({ ...backup, data: { members: [1] } }, true)).rejects.toMatchObject({ code: "TP081" });
      await expect(restoreSql({ ...backup, data: { events: [{ id: "50000000-0000-4000-8000-0000000000d1" }] } }, false))
        .rejects.toMatchObject({ code: "23502" });
      expect(await count(`select count(*) from events where id='50000000-0000-4000-8000-0000000000d1'`)).toBe(0);
    });
  });
});
