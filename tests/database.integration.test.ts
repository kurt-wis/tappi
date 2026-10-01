import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openTestDb } from "./helpers/pglite";

let db: PGlite;

beforeAll(async () => {
  db = await openTestDb();
});

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

  it("limits OTP attempts, prevents replay, and provisions an independent student identity", async () => {
    await db.exec("insert into auth.users(id,email) values('10000000-0000-4000-8000-000000000002','student@test.local')");
    const issued = await db.query("select issue_auth_otp('student@test.local','signup',null,'code') id");
    expect(issued.rows[0]).toHaveProperty("id");
    const throttled = await db.query("select issue_auth_otp('student@test.local','signup',null,'other') id");
    expect(throttled.rows[0]).toEqual({ id: null });
    const wrong = await db.query<{ result: { verified: boolean } }>("select verify_auth_otp('student@test.local','wrong','signup','bad-token') result");
    expect(wrong.rows[0].result.verified).toBe(false);
    const verified = await db.query<{ result: { verified: boolean } }>("select verify_auth_otp('student@test.local','code','signup','token') result");
    expect(verified.rows[0].result.verified).toBe(true);
    const replay = await db.query<{ result: { verified: boolean } }>("select verify_auth_otp('student@test.local','code','signup','token2') result");
    expect(replay.rows[0].result.verified).toBe(false);
    await db.exec("select provision_student_login('10000000-0000-4000-8000-000000000002','student@test.local','token','signup','Student','S-1',false)");
    const dashboard = await db.query<{ data: { orgs: unknown[]; person_id: string } }>("select student_dashboard('10000000-0000-4000-8000-000000000002') data");
    expect(dashboard.rows[0].data.orgs).toEqual([]);
    expect(dashboard.rows[0].data.person_id).toBeTruthy();
    await expect(db.query("select provision_student_login('10000000-0000-4000-8000-000000000002','student@test.local','token','signup','Student','S1',false)"))
      .rejects.toMatchObject({ code: "TP060" });
    await db.exec("select issue_auth_otp('blocked@test.local','signup',null,'code')");
    for (let i = 0; i < 5; i++) await db.exec("select verify_auth_otp('blocked@test.local','wrong','signup','bad')");
    const exhausted = await db.query<{ result: { verified: boolean } }>("select verify_auth_otp('blocked@test.local','code','signup','token') result");
    expect(exhausted.rows[0].result.verified).toBe(false);
  });

  it("requires officer approval for unverified activation and preserves attendance history", async () => {
    await db.exec(`
      insert into auth.users(id,email) values('10000000-0000-4000-8000-000000000003','alice@test.local');
      select issue_auth_otp('alice@test.local','activation','30000000-0000-4000-8000-000000000001','alice-code');
      select verify_auth_otp('alice@test.local','alice-code','activation','alice-token');
    `);
    const provision = "select provision_student_login('10000000-0000-4000-8000-000000000003','alice@test.local','alice-token','activation',null,'A-1',false)";
    await expect(db.query(provision)).rejects.toMatchObject({ code: "TP061" });
    await db.exec(`
      select approve_student_activation('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
      ${provision};
    `);
    const dashboard = await db.query<{ data: { orgs: Array<{ tappies: number; attendance_history: unknown[] }> } }>(
      "select student_dashboard('10000000-0000-4000-8000-000000000003') data");
    expect(dashboard.rows[0].data.orgs[0].tappies).toBe(1);
    expect(dashboard.rows[0].data.orgs[0].attendance_history).toHaveLength(2);
  });

  it("grants students their own records but no staff writes or other students' records", async () => {
    await db.exec(`
      grant usage on schema public,auth to authenticated;
      grant select on all tables in schema public to authenticated;
      create or replace function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('test.user_id',true),'')::uuid
      $$;
      select set_config('test.user_id','10000000-0000-4000-8000-000000000003',false);
      set role authenticated;
    `);
    try {
      const people = await db.query("select student_number from persons order by student_number");
      expect(people.rows).toEqual([{ student_number: "A-1" }]);
      const members = await db.query("select full_name from members");
      expect(members.rows).toEqual([{ full_name: "Alice" }]);
      const attendance = await db.query("select id from attendance");
      expect(attendance.rows).toHaveLength(2);
      await expect(db.query("select report_lost_card('30000000-0000-4000-8000-000000000001')")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select student_dashboard('10000000-0000-4000-8000-000000000002')")).rejects.toMatchObject({ code: "42501" });
      const update = await db.query("update members set full_name='Changed' returning id");
      expect(update.rows).toHaveLength(0);
    } finally { await db.exec("reset role"); }
  });

  it("revokes lost cards globally, rejects their scans, and supports a replacement across orgs", async () => {
    await db.exec(`
      insert into organizations(id,name,slug) values('20000000-0000-4000-8000-000000000002','Second','second');
      insert into members(id,org_id,person_id,student_number,full_name,member_role)
      values('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','A1','Alice','attendee');
      select report_lost_card('30000000-0000-4000-8000-000000000001');
    `);
    const flags = await db.query("select card_uid,lost_card_flag,user_id from members where person_id='30000000-0000-4000-8000-000000000001'");
    expect(flags.rows).toHaveLength(2);
    for (const flag of flags.rows) expect(flag).toMatchObject({ card_uid: null, lost_card_flag: true, user_id: "10000000-0000-4000-8000-000000000003" });
    await expect(db.query("select record_scan('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003','2035787938')"))
      .rejects.toMatchObject({ code: "TP026" });
    await expect(db.query("select resolve_lost_card('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001')"))
      .rejects.toMatchObject({ code: "TP002" });
    await db.exec("select replace_member_card('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','999999','10000000-0000-4000-8000-000000000001','Lost ID')");
    const replacement = await db.query("select card_uid,lost_card_flag from members where person_id='30000000-0000-4000-8000-000000000001'");
    expect(replacement.rows).toEqual([{ card_uid: "999999", lost_card_flag: false }, { card_uid: "999999", lost_card_flag: false }]);
    const audit = await db.query("select reason from card_link_audit where new_uid='999999'");
    expect(audit.rows).toEqual([{ reason: "Lost ID" }]);
  });

  it("records offline method, deduplicates timeout retries, and invalidates stale reconciliation", async () => {
    const scan = (time: string, key: string) => `select record_scan('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003','999999','${time}',null,'device','${key}','offline_sync')`;
    await db.exec(scan("2026-03-01 09:05Z", "scan-1"));
    await db.exec(scan("2026-03-01 09:25Z", "scan-2"));
    await db.exec("select reconcile_event('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001')");
    await db.exec(scan("2026-03-01 10:25Z", "scan-2"));
    const row = await db.query<{ time_out: Date; method: string }>("select time_out,method from attendance where client_scan_id='scan-1'");
    expect(new Date(row.rows[0].time_out).toISOString()).toBe("2026-03-01T09:25:00.000Z");
    expect(row.rows[0].method).toBe("offline_sync");
    await db.exec(scan("2026-03-01 10:30Z", "scan-3"));
    const event = await db.query("select reconciled_at from events where id='50000000-0000-4000-8000-000000000003'");
    expect(event.rows).toEqual([{ reconciled_at: null }]);
  });

  it("retains autofill proof until registration and rejects cross-event and replay use", async () => {
    await db.exec(`
      insert into events(id,org_id,title,starts_at,status,walk_in_policy) values
      ('50000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','Autofill','2026-03-01 09:00Z','published','open');
      insert into registration_lookup_sessions(id,event_id,org_id,person_id,student_number_normalized,masked_first_name,masked_email,otp_code_hash,otp_expires_at)
      values('60000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','A1','A***','a***@test.local','lookup-code',now()+interval '10 minutes');
    `);
    const verified = await db.query("select verify_registration_lookup('60000000-0000-4000-8000-000000000001','lookup-code','lookup-token') verified");
    expect(verified.rows).toEqual([{ verified: true }]);
    const proof = await db.query("select autofill_token_hash from registration_lookup_sessions where id='60000000-0000-4000-8000-000000000001'");
    expect(proof.rows).toEqual([{ autofill_token_hash: "lookup-token" }]);
    await expect(db.query("select register_for_event('50000000-0000-4000-8000-000000000004','Alice','WRONG','alice@test.local','{}',true,'lookup-token')"))
      .rejects.toMatchObject({ code: "TP055" });
    await db.exec("select register_for_event('50000000-0000-4000-8000-000000000004','Alice','A-1','alice@test.local','{}',true,'lookup-token')");
    const used = await db.query("select autofill_token_hash from registration_lookup_sessions where id='60000000-0000-4000-8000-000000000001'");
    expect(used.rows).toEqual([{ autofill_token_hash: null }]);
    await expect(db.query("select register_for_event('50000000-0000-4000-8000-000000000004','Alice','A1','alice@test.local','{}',true,'lookup-token')"))
      .rejects.toMatchObject({ code: "TP055" });
  });

  it("queues finalized alerts only, deduplicates them, and leases work to one cron invocation", async () => {
    await db.exec("select enqueue_due_notifications(now())");
    expect((await db.query("select id from notifications")).rows).toHaveLength(0);
    await db.exec("update events set reconciled_at=now() where id='50000000-0000-4000-8000-000000000002'");
    await db.exec("select enqueue_due_notifications(now()); select enqueue_due_notifications(now());");
    const notices = await db.query<{ event_id: string; type: string; channel: string }>("select event_id,type,channel from notifications order by type,channel");
    expect(notices.rows).toHaveLength(2);
    expect(notices.rows.every((r) => r.event_id === "50000000-0000-4000-8000-000000000002")).toBe(true);
    expect(notices.rows.every((r) => r.type === "absentee_alert")).toBe(true);
    const claimed = await db.query("select id from claim_due_notifications(now())");
    const claimedAgain = await db.query("select id from claim_due_notifications(now())");
    expect(claimed.rows).toHaveLength(2);
    expect(claimedAgain.rows).toHaveLength(0);
  });

  it("lets students subscribe across their organizations without taking another person's endpoint", async () => {
    const user = "10000000-0000-4000-8000-000000000003";
    await db.exec(`select subscribe_push('${user}','40000000-0000-4000-8000-000000000001','https://fcm.googleapis.com/push/test','key','auth');
      select subscribe_push('${user}','40000000-0000-4000-8000-000000000003','https://fcm.googleapis.com/push/test','key','auth');`);
    const subscriptions = await db.query("select id from push_subscriptions");
    expect(subscriptions.rows).toHaveLength(2);
    await expect(db.query("select subscribe_push('10000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','https://fcm.googleapis.com/push/test','key','auth')"))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("locks completed master lists and never marks a published event certificate-eligible", async () => {
    await expect(db.query("delete from event_master_list where event_id='50000000-0000-4000-8000-000000000001'"))
      .rejects.toMatchObject({ code: "TP011" });
    await db.exec("update events set certificate_enabled=true where id='50000000-0000-4000-8000-000000000003'");
    const report = await db.query<{ certificate_eligible: boolean }>("select certificate_eligible from report_attendance('20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003')");
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.every((row) => row.certificate_eligible === false)).toBe(true);
  });

  it("prevents direct staff requests from bypassing event finalization or changing attendance", async () => {
    await db.exec(`
      grant insert,update,delete on events to authenticated;
      select set_config('test.user_id','10000000-0000-4000-8000-000000000001',false);
      set role authenticated;
    `);
    try {
      const update = await db.query("update events set status='completed' where id='50000000-0000-4000-8000-000000000003' returning id");
      expect(update.rows).toHaveLength(0);
      await expect(db.query("update attendance set status='present'")).rejects.toMatchObject({ code: "42501" });
    } finally { await db.exec("reset role"); }
  });

  it("rejects ledger entries that mix one organization's member with another person's identity", async () => {
    await expect(db.query(`insert into points_ledger(org_id,member_id,person_id,points,reason)
      select '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',id,1,'invalid'
      from persons where student_number_normalized='S1'`)).rejects.toMatchObject({ code: "23503" });
  });
});
