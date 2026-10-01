-- Part 13: rate limiting, audit logging, device inventory, and backup/restore.

-------------------------------------------------------------------------------
-- Rate limiting: fixed-window counters shared by every app instance.
-------------------------------------------------------------------------------
create table public.rate_limit_buckets (
  bucket_key   text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket_key, window_start)
);
create index idx_rate_limit_buckets_window on public.rate_limit_buckets(window_start);
alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from public, anon, authenticated;

create or replace function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_window timestamptz; v_hits integer;
begin
  if p_key is null or length(p_key) not between 1 and 200 or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit parameters' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into rate_limit_buckets(bucket_key, window_start, hits) values (p_key, v_window, 1)
  on conflict (bucket_key, window_start) do update set hits = rate_limit_buckets.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then
    delete from rate_limit_buckets where window_start < now() - interval '2 days';
  end if;
  return jsonb_build_object(
    'allowed', v_hits <= p_limit,
    'remaining', greatest(p_limit - v_hits, 0),
    'retry_after', greatest(ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds)) - now()))::integer, 1)
  );
end $$;
revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

-------------------------------------------------------------------------------
-- Audit logging: request origin, org-admin-only reads, append-only rows.
-------------------------------------------------------------------------------
alter table public.audit_logs add column ip text, add column user_agent text;
create index idx_audit_logs_org_action on public.audit_logs(org_id, action, created_at desc);
create index idx_audit_logs_org_entity on public.audit_logs(org_id, entity, entity_id, created_at desc);

drop policy audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (org_id = public.current_org_id() and public.current_org_role() = 'org_admin');
revoke insert, update, delete, truncate on public.audit_logs from public, anon, authenticated;

-- Rows are immutable. The only permitted update is the actor_id -> null performed by the
-- profiles foreign key (on delete set null), so deleting a staff account keeps working.
create or replace function public.prevent_audit_log_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.actor_id is null and old.actor_id is not null
     and (new.id, new.org_id, new.action, new.entity, new.entity_id, new.metadata, new.created_at, new.ip, new.user_agent)
         is not distinct from
         (old.id, old.org_id, old.action, old.entity, old.entity_id, old.metadata, old.created_at, old.ip, old.user_agent) then
    return new;
  end if;
  raise exception 'Audit log entries cannot be modified' using errcode = '42501';
end $$;
create trigger trg_audit_logs_immutable before update on public.audit_logs
for each row execute function public.prevent_audit_log_update();

-------------------------------------------------------------------------------
-- Device inventory.
-------------------------------------------------------------------------------
alter table public.devices
  add column status        text        not null default 'active',
  add column notes         text,
  add column registered_by uuid        references public.profiles(id) on delete set null,
  add column updated_at    timestamptz not null default now();
alter table public.devices
  add constraint devices_status_chk check (status in ('active', 'maintenance', 'retired', 'lost')),
  add constraint devices_device_id_chk check (length(device_id) between 1 and 100 and device_id = btrim(device_id)),
  add constraint devices_label_chk check (label is null or length(label) between 1 and 100),
  add constraint devices_notes_chk check (notes is null or length(notes) between 1 and 1000);
create index idx_devices_org_status on public.devices(org_id, status);

create trigger trg_devices_updated_at before update on public.devices
for each row execute function public.set_updated_at();

-- Marks registered devices as seen (at most every 30 seconds per device) and reports their status.
create or replace function public.touch_devices(p_org_id uuid, p_device_ids text[])
returns table(device_id text, status text) language plpgsql security definer set search_path = public as $$
begin
  update devices d set last_seen_at = now()
   where d.org_id = p_org_id and d.device_id = any(p_device_ids)
     and (d.last_seen_at is null or d.last_seen_at < now() - interval '30 seconds');
  return query
    select d.device_id, d.status from devices d where d.org_id = p_org_id and d.device_id = any(p_device_ids);
end $$;
revoke all on function public.touch_devices(uuid, text[]) from public, anon, authenticated;
grant execute on function public.touch_devices(uuid, text[]) to service_role;

-------------------------------------------------------------------------------
-- Backup / restore.
-------------------------------------------------------------------------------
create or replace function public.export_org_backup(p_org_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_org organizations;
begin
  select * into v_org from organizations where id = p_org_id;
  if not found then raise exception 'Organization not found' using errcode = 'TP080'; end if;
  return (
    with org_persons as (
      select person_id from members where org_id = p_org_id
      union
      select person_id from org_people where org_id = p_org_id
    )
    select jsonb_build_object(
      'format', 'tappi.org-backup',
      'version', 1,
      'exported_at', now(),
      'org_id', v_org.id,
      'organization', jsonb_build_object('id', v_org.id, 'name', v_org.name, 'slug', v_org.slug,
                                         'logo_url', v_org.logo_url, 'settings', v_org.settings),
      'profiles', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name,
                     'role', p.role, 'is_active', p.is_active) order by p.id), '[]'::jsonb)
                   from profiles p where p.org_id = p_org_id),
      'data', jsonb_build_object(
        'persons', (select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb)
                    from persons p where p.id in (select person_id from org_persons)),
        'org_people', (select coalesce(jsonb_agg(to_jsonb(op) order by op.id), '[]'::jsonb)
                       from org_people op where op.org_id = p_org_id),
        'members', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)
                    from members m where m.org_id = p_org_id),
        'cards', (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]'::jsonb)
                  from cards c where c.person_id in (select person_id from org_persons)),
        'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb)
                   from events e where e.org_id = p_org_id),
        'event_master_list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.event_id, l.member_id), '[]'::jsonb)
                              from event_master_list l join events e on e.id = l.event_id where e.org_id = p_org_id),
        'registrations', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb)
                          from registrations r where r.org_id = p_org_id),
        'attendance', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
                       from attendance a where a.org_id = p_org_id),
        'points_ledger', (select coalesce(jsonb_agg(to_jsonb(pl) order by pl.id), '[]'::jsonb)
                          from points_ledger pl where pl.org_id = p_org_id),
        'certificates', (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]'::jsonb)
                         from certificates c where c.org_id = p_org_id),
        'devices', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb)
                    from devices d where d.org_id = p_org_id),
        'card_link_audit', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb)
                            from card_link_audit x where x.org_id = p_org_id)
      )
    )
  );
end $$;

-- Staff references (created_by, issued_by, ...) are kept only when the profile still belongs to the org.
create or replace function public.org_profile_or_null(p_org_id uuid, p_profile_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from profiles where id = p_profile_id and org_id = p_org_id
$$;

-- Non-destructive restore: inserts rows from the backup that are missing, never deletes rows or
-- overwrites existing values (the one update re-fills event references cleared by an event's
-- deletion), and forces every row into p_org_id. Global identities (persons) are
-- matched the same way member creation matches them: an existing person is reused only when it
-- is already linked to this org or has the same student number; otherwise a new unverified guest
-- person is created. With p_dry_run the work is rolled back and only the counts are returned.
create or replace function public.restore_org_backup(
  p_org_id uuid, p_backup jsonb, p_dry_run boolean default true, p_restore_settings boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sections constant text[] := array['persons', 'org_people', 'members', 'cards', 'events', 'event_master_list',
    'registrations', 'attendance', 'points_ledger', 'certificates', 'devices', 'card_link_audit'];
  v_section text;
  v_data jsonb;
  v_in_backup jsonb := '{}'::jsonb;
  v_inserted jsonb := '{}'::jsonb;
  v_settings_restored boolean := false;
  v_n integer;
  v_count integer;
  v_person persons;
  v_member members;
  v_number text;
  v_person_id uuid;
  v_target uuid;
begin
  if jsonb_typeof(p_backup) is distinct from 'object'
     or p_backup->>'format' is distinct from 'tappi.org-backup'
     or p_backup->'version' is distinct from '1'::jsonb then
    raise exception 'Unsupported backup format' using errcode = 'TP081';
  end if;
  if p_backup->>'org_id' is distinct from p_org_id::text then
    raise exception 'Backup belongs to a different organization' using errcode = 'TP082';
  end if;
  perform 1 from organizations where id = p_org_id for update;
  if not found then raise exception 'Organization not found' using errcode = 'TP080'; end if;

  v_data := p_backup->'data';
  if jsonb_typeof(v_data) is distinct from 'object' then
    raise exception 'Backup data is malformed' using errcode = 'TP081';
  end if;
  foreach v_section in array v_sections loop
    if jsonb_typeof(coalesce(v_data->v_section, '[]'::jsonb)) <> 'array' then
      raise exception 'Backup section % is malformed', v_section using errcode = 'TP081';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(v_data->v_section, '[]'::jsonb)) x where jsonb_typeof(x) <> 'object') then
      raise exception 'Backup section % is malformed', v_section using errcode = 'TP081';
    end if;
    v_in_backup := v_in_backup || jsonb_build_object(v_section, jsonb_array_length(coalesce(v_data->v_section, '[]'::jsonb)));
  end loop;

  begin
    create temp table if not exists restore_person_map (old_id uuid primary key, new_id uuid not null) on commit drop;
    create temp table if not exists restore_member_map (old_id uuid primary key, new_id uuid not null, person_id uuid not null) on commit drop;
    create temp table if not exists restore_event_state (
      id uuid primary key, status event_status not null, reconciled_at timestamptz, reconciled_by uuid
    ) on commit drop;
    truncate pg_temp.restore_person_map, pg_temp.restore_member_map, pg_temp.restore_event_state;

    -- persons
    v_count := 0;
    for v_person in select * from jsonb_populate_recordset(null::persons, coalesce(v_data->'persons', '[]'::jsonb)) loop
      continue when v_person.id is null;
      v_number := normalize_student_number(v_person.student_number);
      v_target := null;
      select coalesce(p.merged_into, p.id) into v_target from persons p
       where p.id = v_person.id
         and (exists (select 1 from org_people op where op.org_id = p_org_id and op.person_id = p.id)
              or exists (select 1 from members m where m.org_id = p_org_id and m.person_id = p.id)
              or (v_number is not null and p.student_number_normalized = v_number));
      if v_target is null and v_number is not null then
        select coalesce(p.merged_into, p.id) into v_target from persons p where p.student_number_normalized = v_number;
      end if;
      if v_target is null then
        v_target := case when exists (select 1 from persons p where p.id = v_person.id) then gen_random_uuid() else v_person.id end;
        insert into persons(id, student_number, student_number_normalized, full_name, email, email_verified, person_type, photo_url, created_at)
        values (v_target, case when v_number is null then null else v_person.student_number end, v_number, v_person.full_name,
                v_person.email, false, 'guest', v_person.photo_url, coalesce(v_person.created_at, now()));
        v_count := v_count + 1;
      end if;
      insert into pg_temp.restore_person_map(old_id, new_id) values (v_person.id, v_target) on conflict do nothing;
    end loop;
    v_inserted := v_inserted || jsonb_build_object('persons', v_count);

    -- members
    v_count := 0;
    for v_member in select * from jsonb_populate_recordset(null::members, coalesce(v_data->'members', '[]'::jsonb)) loop
      continue when v_member.id is null;
      select pm.new_id into v_person_id from pg_temp.restore_person_map pm where pm.old_id = v_member.person_id;
      continue when v_person_id is null;
      v_target := null;
      select m.id into v_target from members m where m.id = v_member.id and m.org_id = p_org_id;
      if v_target is null then
        select m.id into v_target from members m where m.org_id = p_org_id and m.person_id = v_person_id;
      end if;
      if v_target is null then
        insert into members(id, org_id, person_id, student_number, full_name, email, course, member_role, status,
                            committee, lost_card_flag, created_at)
        values (case when exists (select 1 from members m where m.id = v_member.id) then gen_random_uuid() else v_member.id end,
                p_org_id, v_person_id, v_member.student_number, v_member.full_name, v_member.email, v_member.course,
                coalesce(v_member.member_role, 'member'), coalesce(v_member.status, 'active'), v_member.committee,
                coalesce(v_member.lost_card_flag, false), coalesce(v_member.created_at, now()))
        on conflict do nothing
        returning id into v_target;
        if v_target is not null then v_count := v_count + 1; end if;
      end if;
      if v_target is not null then
        insert into pg_temp.restore_member_map(old_id, new_id, person_id)
        select v_member.id, m.id, m.person_id from members m where m.id = v_target
        on conflict do nothing;
      end if;
    end loop;
    v_inserted := v_inserted || jsonb_build_object('members', v_count);

    -- org_people
    insert into org_people(org_id, person_id, directory_role, lost_card_flag, created_at)
    select p_org_id, pm.new_id, coalesce(op.directory_role, 'attendee'), coalesce(op.lost_card_flag, false), coalesce(op.created_at, now())
      from jsonb_populate_recordset(null::org_people, coalesce(v_data->'org_people', '[]'::jsonb)) op
      join pg_temp.restore_person_map pm on pm.old_id = op.person_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('org_people', v_n);

    -- cards
    insert into cards(id, uid, person_id, active, linked_at, revoked_at, created_at)
    select coalesce(c.id, gen_random_uuid()), c.uid, pm.new_id, coalesce(c.active, false),
           coalesce(c.linked_at, now()), c.revoked_at, coalesce(c.created_at, now())
      from jsonb_populate_recordset(null::cards, coalesce(v_data->'cards', '[]'::jsonb)) c
      join pg_temp.restore_person_map pm on pm.old_id = c.person_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('cards', v_n);

    -- events: inserted as draft (or published) so their master lists can be restored, then given back their status.
    insert into pg_temp.restore_event_state(id, status, reconciled_at, reconciled_by)
    select e.id, coalesce(e.status, 'draft'), e.reconciled_at, org_profile_or_null(p_org_id, e.reconciled_by)
      from jsonb_populate_recordset(null::events, coalesce(v_data->'events', '[]'::jsonb)) e
     where e.id is not null and not exists (select 1 from events x where x.id = e.id)
    on conflict do nothing;
    insert into events(id, org_id, title, description, venue, starts_at, ends_at, grace_period_minutes, slots,
                       walk_in_policy, status, points_value, certificate_enabled, created_by, created_at, updated_at,
                       published_at, cancelled_at, duplicate_window_seconds, timeout_gap_minutes, form_fields)
    select e.id, p_org_id, e.title, e.description, e.venue, e.starts_at, e.ends_at, coalesce(e.grace_period_minutes, 15), e.slots,
           coalesce(e.walk_in_policy, 'closed'),
           case when s.status in ('draft', 'published') then s.status else 'draft'::event_status end,
           coalesce(e.points_value, 0), coalesce(e.certificate_enabled, false), org_profile_or_null(p_org_id, e.created_by),
           coalesce(e.created_at, now()), coalesce(e.updated_at, now()), e.published_at, e.cancelled_at,
           coalesce(e.duplicate_window_seconds, 8), coalesce(e.timeout_gap_minutes, 15), coalesce(e.form_fields, '[]'::jsonb)
      from jsonb_populate_recordset(null::events, coalesce(v_data->'events', '[]'::jsonb)) e
      join pg_temp.restore_event_state s on s.id = e.id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('events', v_n);

    -- event_master_list (only rows that are actually missing, so existing events are not un-reconciled needlessly)
    insert into event_master_list(event_id, member_id, added_at, added_by)
    select distinct on (l.event_id, mm.new_id) l.event_id, mm.new_id, coalesce(l.added_at, now()), org_profile_or_null(p_org_id, l.added_by)
      from jsonb_populate_recordset(null::event_master_list, coalesce(v_data->'event_master_list', '[]'::jsonb)) l
      join pg_temp.restore_member_map mm on mm.old_id = l.member_id
      join events e on e.id = l.event_id and e.org_id = p_org_id and e.status in ('draft', 'published')
     where not exists (select 1 from event_master_list x where x.event_id = l.event_id and x.member_id = mm.new_id)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('event_master_list', v_n);

    update events e set status = s.status, reconciled_at = s.reconciled_at, reconciled_by = s.reconciled_by
      from pg_temp.restore_event_state s
     where e.id = s.id and e.org_id = p_org_id;

    -- registrations
    insert into registrations(id, event_id, org_id, member_id, full_name, student_number, email, status, reviewed_by,
                              reviewed_at, created_at, updated_at, answers, autofill_used, source, form_snapshot)
    select coalesce(r.id, gen_random_uuid()), r.event_id, p_org_id, mm.new_id, r.full_name, r.student_number, r.email,
           coalesce(r.status, 'pending'), org_profile_or_null(p_org_id, r.reviewed_by), r.reviewed_at,
           coalesce(r.created_at, now()), coalesce(r.updated_at, now()), coalesce(r.answers, '{}'::jsonb),
           coalesce(r.autofill_used, false), coalesce(r.source, 'public_form'), coalesce(r.form_snapshot, '[]'::jsonb)
      from jsonb_populate_recordset(null::registrations, coalesce(v_data->'registrations', '[]'::jsonb)) r
      join events e on e.id = r.event_id and e.org_id = p_org_id
      left join pg_temp.restore_member_map mm on mm.old_id = r.member_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('registrations', v_n);

    -- attendance
    insert into attendance(id, event_id, org_id, member_id, person_id, status, time_in, time_out, method, scan_uid,
                           device_id, scanned_by, client_scan_id, created_at, updated_at, registration_type, timing, raw_timestamp)
    select coalesce(a.id, gen_random_uuid()), a.event_id, p_org_id, mm.new_id, mm.person_id, a.status, a.time_in, a.time_out,
           coalesce(a.method, 'tap'), a.scan_uid, a.device_id, org_profile_or_null(p_org_id, a.scanned_by), a.client_scan_id,
           coalesce(a.created_at, now()), coalesce(a.updated_at, now()), a.registration_type, a.timing, a.raw_timestamp
      from jsonb_populate_recordset(null::attendance, coalesce(v_data->'attendance', '[]'::jsonb)) a
      join pg_temp.restore_member_map mm on mm.old_id = a.member_id
      join events e on e.id = a.event_id and e.org_id = p_org_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('attendance', v_n);

    -- points_ledger (event reference is dropped when the event is not in this org, matching on delete set null)
    insert into points_ledger(id, org_id, member_id, person_id, event_id, points, reason, awarded_by, created_at)
    select coalesce(pl.id, gen_random_uuid()), p_org_id, mm.new_id, mm.person_id,
           (select e.id from events e where e.id = pl.event_id and e.org_id = p_org_id),
           pl.points, pl.reason, org_profile_or_null(p_org_id, pl.awarded_by), coalesce(pl.created_at, now())
      from jsonb_populate_recordset(null::points_ledger, coalesce(v_data->'points_ledger', '[]'::jsonb)) pl
      join pg_temp.restore_member_map mm on mm.old_id = pl.member_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('points_ledger', v_n);

    -- Deleting an event clears points_ledger.event_id (on delete set null) instead of deleting the
    -- points, so re-link surviving ledger rows to their restored event. This is the only update a
    -- restore performs, and it only fills a reference that is currently empty.
    update points_ledger pl set event_id = b.event_id
      from jsonb_populate_recordset(null::points_ledger, coalesce(v_data->'points_ledger', '[]'::jsonb)) b
     where pl.id = b.id and pl.org_id = p_org_id and pl.event_id is null and b.event_id is not null
       and exists (select 1 from events e where e.id = b.event_id and e.org_id = p_org_id)
       and not (pl.reason = 'event_attendance' and exists (
         select 1 from points_ledger x where x.event_id = b.event_id and x.member_id = pl.member_id and x.reason = 'event_attendance'));
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('points_ledger_relinked', v_n);

    -- certificates
    insert into certificates(id, org_id, event_id, member_id, person_id, code, issued_by, issued_at, revoked_at, revoked_by, revoke_reason)
    select coalesce(c.id, gen_random_uuid()), p_org_id, c.event_id, mm.new_id, mm.person_id, c.code,
           org_profile_or_null(p_org_id, c.issued_by), coalesce(c.issued_at, now()), c.revoked_at,
           org_profile_or_null(p_org_id, c.revoked_by), c.revoke_reason
      from jsonb_populate_recordset(null::certificates, coalesce(v_data->'certificates', '[]'::jsonb)) c
      join pg_temp.restore_member_map mm on mm.old_id = c.member_id
      join events e on e.id = c.event_id and e.org_id = p_org_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('certificates', v_n);

    -- devices
    insert into devices(id, org_id, device_id, label, kind, status, notes, last_seen_at, registered_by, created_at, updated_at)
    select coalesce(d.id, gen_random_uuid()), p_org_id, d.device_id, d.label, coalesce(d.kind, 'tapper'),
           coalesce(d.status, 'active'), d.notes, d.last_seen_at, org_profile_or_null(p_org_id, d.registered_by),
           coalesce(d.created_at, now()), coalesce(d.updated_at, now())
      from jsonb_populate_recordset(null::devices, coalesce(v_data->'devices', '[]'::jsonb)) d
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('devices', v_n);

    -- card_link_audit
    insert into card_link_audit(id, org_id, member_id, old_uid, new_uid, action, officer_id, created_at, reason)
    select coalesce(x.id, gen_random_uuid()), p_org_id, mm.new_id, x.old_uid, x.new_uid, x.action,
           org_profile_or_null(p_org_id, x.officer_id), coalesce(x.created_at, now()), x.reason
      from jsonb_populate_recordset(null::card_link_audit, coalesce(v_data->'card_link_audit', '[]'::jsonb)) x
      join pg_temp.restore_member_map mm on mm.old_id = x.member_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_inserted := v_inserted || jsonb_build_object('card_link_audit', v_n);

    if p_restore_settings then
      if jsonb_typeof(p_backup->'organization'->'settings') is distinct from 'object' then
        raise exception 'Backup settings are malformed' using errcode = 'TP081';
      end if;
      update organizations set settings = p_backup->'organization'->'settings' where id = p_org_id;
      v_settings_restored := true;
    end if;

    if p_dry_run then
      raise exception 'dry run' using errcode = 'TP0DR';
    end if;
  exception when sqlstate 'TP0DR' then
    null;
  end;

  return jsonb_build_object('dry_run', p_dry_run, 'settings_restored', v_settings_restored,
                            'in_backup', v_in_backup, 'inserted', v_inserted);
end $$;

revoke all on function public.export_org_backup(uuid) from public, anon, authenticated;
revoke all on function public.org_profile_or_null(uuid, uuid) from public, anon, authenticated;
revoke all on function public.restore_org_backup(uuid, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.export_org_backup(uuid), public.org_profile_or_null(uuid, uuid),
  public.restore_org_backup(uuid, jsonb, boolean, boolean) to service_role;
