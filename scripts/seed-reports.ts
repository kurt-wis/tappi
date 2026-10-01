import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { seedId, seedMembers } from './seed';

const marker = 'tappi-test-org-v1';

async function main(): Promise<void> {
  for (const filename of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), filename);
    if (existsSync(path)) process.loadEnvFile(path);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set Supabase URL and service role key before seeding.');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: org, error: orgError } = await db.from('organizations')
    .select('id, settings').eq('slug', 'test-org').single();
  if (orgError) throw orgError;
  if (org.id !== seedId('org') || org.settings?.tappi_seed !== marker) {
    throw new Error('Refusing to modify an organization not owned by the test seed.');
  }
  const { data: members, error: membersError } = await db.from('members')
    .select('id, org_id, student_number, person_id').in('id', seedMembers.slice(0, 3).map((member) => member.id));
  if (membersError) throw membersError;
  for (const member of seedMembers.slice(0, 3)) {
    if (!members?.some((row) => row.id === member.id && row.org_id === org.id && row.student_number === member.student_number)) {
      throw new Error(`Seed member ${member.student_number} is missing or belongs to another organization. Run db:seed first.`);
    }
  }

  const events = [
    { name: 'reports-event-1', title: 'Reports Test: Community Walk', starts_at: '2026-09-01T01:00:00Z', ends_at: '2026-09-01T03:00:00Z', points_value: 3, certificate_enabled: false },
    { name: 'reports-event-2', title: 'Reports Test: Leadership Workshop', starts_at: '2026-09-08T01:00:00Z', ends_at: '2026-09-08T03:00:00Z', points_value: 5, certificate_enabled: true },
  ];
  const pendingEvents: string[] = [];
  for (const event of events) {
    const id = seedId(event.name);
    const { data: existing, error: lookupError } = await db.from('events')
      .select('org_id, title, status').eq('id', id).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing && (existing.org_id !== org.id || existing.title !== event.title)) {
      throw new Error(`Refusing to modify an unrelated event at ${id}.`);
    }
    if (existing?.status === 'completed') continue;
    if (existing && existing.status !== 'published') throw new Error('Seed event status was changed; refusing to modify it.');
    pendingEvents.push(id);
    const { error } = await db.from('events').upsert({
      id, org_id: org.id, title: event.title, starts_at: event.starts_at,
      ends_at: event.ends_at, points_value: event.points_value,
      certificate_enabled: event.certificate_enabled, status: 'published',
      walk_in_policy: 'open',
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
  }

  const first = seedId(events[0].name);
  const second = seedId(events[1].name);
  const masterList = pendingEvents.flatMap((event_id) =>
    seedMembers.slice(0, 2).map((member) => ({ event_id, member_id: member.id })));
  const { error: masterError } = masterList.length ? await db.from('event_master_list').upsert(masterList,
    { onConflict: 'event_id,member_id', ignoreDuplicates: true }) : { error: null };
  if (masterError) throw masterError;

  const attendance = [
    { event_id: first, member_id: seedMembers[0].id, status: 'present', time_in: '2026-09-01T01:05:00Z' },
    { event_id: first, member_id: seedMembers[1].id, status: 'present', time_in: '2026-09-01T01:08:00Z' },
    { event_id: second, member_id: seedMembers[0].id, status: 'late', time_in: '2026-09-08T01:25:00Z' },
    { event_id: second, member_id: seedMembers[2].id, status: 'walk_in', time_in: '2026-09-08T01:10:00Z' },
  ].filter((row) => pendingEvents.includes(row.event_id)).map((row) => ({
    ...row, org_id: org.id, method: 'manual',
    person_id: members!.find((member) => member.id === row.member_id)!.person_id,
    registration_type: row.status === 'walk_in' ? 'walk_in' : 'pre_registered',
    timing: row.status === 'late' ? 'late' : 'on_time',
  }));
  const { error: attendanceError } = attendance.length ? await db.from('attendance').upsert(attendance,
    { onConflict: 'event_id,member_id', ignoreDuplicates: true }) : { error: null };
  if (attendanceError) throw attendanceError;

  for (const eventId of pendingEvents) {
    const { error: reconcileError } = await db.rpc('reconcile_event', {
      p_org_id: org.id, p_event_id: eventId, p_officer_id: null,
    });
    if (reconcileError) throw new Error(`Reconcile ${eventId}: ${reconcileError.message}`);
    const { error } = await db.rpc('finalize_event', {
      p_org_id: org.id, p_event_id: eventId, p_force: false,
    });
    if (error) throw new Error(`Finalize ${eventId}: ${error.message}`);
  }
  const { data: issued, error: issueError } = await db.rpc('issue_certificates', {
    p_org_id: org.id, p_event_id: second,
  });
  if (issueError?.code === 'PGRST202') {
    console.log('Reports fixture partially ready: attendance and credits exist. Apply the Reports migration, then rerun to issue certificates.');
    return;
  }
  if (issueError) throw new Error(`Issue test certificates: ${issueError.message}`);
  console.log('Reports fixture ready: 2 completed events, present/late/walk-in/absent attendance, credits and certificates.');
  console.log('Certificate issue result:', issued);
}

main().catch((error: unknown) => {
  console.error('Reports seed failed:', error instanceof Error ? error.message : 'Unexpected error');
  process.exitCode = 1;
});
