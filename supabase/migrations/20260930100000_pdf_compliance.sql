create or replace function public.normalize_student_number(value text)
returns text language sql immutable strict set search_path = public as $$
  select nullif(regexp_replace(upper(trim(value)), '[-[:space:]]', '', 'g'), '')
$$;

create table if not exists public.persons (
  id                        uuid primary key default gen_random_uuid(),
  student_number            text,
  student_number_normalized text unique,
  full_name                 text not null,
  email                     citext,
  email_verified            boolean not null default false,
  person_type               text not null default 'guest' check (person_type in ('verified', 'guest')),
  photo_url                  text,
  merged_into                uuid references public.persons(id) on delete restrict,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (student_number_normalized is null or student_number_normalized = public.normalize_student_number(student_number))
);

create unique index if not exists persons_email_verified_uq
  on public.persons(email) where email_verified and email is not null and merged_into is null;

create table if not exists public.logins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(person_id)
);

alter table public.members add column if not exists person_id uuid references public.persons(id) on delete restrict;
alter table public.members alter column student_number drop not null;
alter table public.members add column if not exists lost_card_flag boolean not null default false;
alter table public.members add column if not exists committee text;

update public.members
set student_number = public.normalize_student_number(student_number)
where student_number is distinct from public.normalize_student_number(student_number);

insert into public.persons(student_number, student_number_normalized, full_name, email, person_type)
select min(m.student_number), public.normalize_student_number(m.student_number),
       min(m.full_name), min(m.email::text)::citext,
       case when bool_or(m.user_id is not null) then 'verified' else 'guest' end
from public.members m
where m.student_number is not null
group by public.normalize_student_number(m.student_number)
on conflict (student_number_normalized) do nothing;

update public.members m
set person_id = p.id
from public.persons p
where m.person_id is null
  and p.student_number_normalized = public.normalize_student_number(m.student_number);

insert into public.persons(full_name, email, person_type)
select m.full_name, m.email, case when m.user_id is not null then 'verified' else 'guest' end
from public.members m where m.person_id is null;

with unlinked as (
  select m.id as member_id, p.id as person_id,
         row_number() over (partition by m.id order by p.created_at desc, p.id) as rn
  from public.members m
  join public.persons p on p.student_number is null and p.full_name = m.full_name
    and p.email is not distinct from m.email
  where m.person_id is null
)
update public.members m set person_id = u.person_id
from unlinked u where u.member_id = m.id and u.rn = 1;

alter table public.members alter column person_id set not null;
create unique index if not exists members_org_person_uq on public.members(org_id, person_id);
insert into public.logins(user_id,person_id)
select user_id,person_id from public.members where user_id is not null
on conflict do nothing;

create or replace function public.prepare_member_identity()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_person persons;
begin
  new.student_number := normalize_student_number(new.student_number);
  if new.person_id is null then
    if new.student_number is null then
      insert into persons(full_name,email,person_type) values(new.full_name,new.email,'guest') returning * into v_person;
    else
      insert into persons(student_number,student_number_normalized,full_name,email,person_type)
      values(new.student_number,new.student_number,new.full_name,new.email,case when new.user_id is null then 'guest' else 'verified' end)
      on conflict(student_number_normalized) do update set student_number=excluded.student_number
      returning * into v_person;
    end if;
    new.person_id:=v_person.id;
  end if;
  return new;
end $$;

create trigger trg_members_prepare_identity before insert or update of student_number on public.members
for each row execute function public.prepare_member_identity();

create or replace function public.sync_org_person()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into org_people(org_id,person_id,directory_role,lost_card_flag)
  values(new.org_id,new.person_id,case when new.member_role='attendee' then 'attendee' else 'member' end,new.lost_card_flag)
  on conflict(org_id,person_id) do update set directory_role=excluded.directory_role,lost_card_flag=excluded.lost_card_flag,updated_at=now();
  return new;
end $$;

create trigger trg_members_sync_org_person after insert or update of member_role,lost_card_flag on public.members
for each row execute function public.sync_org_person();

create table if not exists public.org_people (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  person_id      uuid not null references public.persons(id) on delete restrict,
  directory_role text not null default 'attendee' check (directory_role in ('member', 'attendee')),
  lost_card_flag boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(org_id, person_id)
);

insert into public.org_people(org_id, person_id, directory_role, lost_card_flag)
select org_id, person_id,
       case when member_role = 'attendee' then 'attendee' else 'member' end,
       lost_card_flag
from public.members
on conflict (org_id, person_id) do update
set directory_role = excluded.directory_role, lost_card_flag = excluded.lost_card_flag;

create table if not exists public.cards (
  id         uuid primary key default gen_random_uuid(),
  uid        text not null unique check (uid ~ '^[0-9]+$'),
  person_id  uuid not null references public.persons(id) on delete restrict,
  active     boolean not null default true,
  linked_at  timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((active and revoked_at is null) or not active)
);
create unique index if not exists cards_one_active_per_person_uq on public.cards(person_id) where active;

insert into public.cards(uid, person_id, active, linked_at)
select m.card_uid, m.person_id, true, coalesce(m.card_linked_at, now())
from public.members m where m.card_uid is not null
on conflict (uid) do nothing;

alter table public.attendance add column if not exists person_id uuid references public.persons(id) on delete restrict;
alter table public.attendance add column if not exists registration_type text
  check (registration_type in ('pre_registered', 'walk_in'));
alter table public.attendance add column if not exists timing text
  check (timing in ('on_time', 'late'));
alter table public.attendance add column if not exists raw_timestamp timestamptz;
update public.attendance a set person_id = m.person_id from public.members m
where a.member_id = m.id and a.person_id is null;
update public.attendance set
  registration_type = case when status = 'walk_in' then 'walk_in' else 'pre_registered' end,
  timing = case when status = 'late' then 'late' else 'on_time' end,
  raw_timestamp = coalesce(raw_timestamp, time_in)
where registration_type is null or timing is null or raw_timestamp is null;
alter table public.attendance alter column person_id set not null;

alter table public.points_ledger add column if not exists person_id uuid references public.persons(id) on delete restrict;
update public.points_ledger pl set person_id = m.person_id from public.members m
where pl.member_id = m.id and pl.person_id is null;
alter table public.points_ledger alter column person_id set not null;

alter table public.certificates add column if not exists person_id uuid references public.persons(id) on delete restrict;
update public.certificates c set person_id = m.person_id from public.members m
where c.member_id = m.id and c.person_id is null;
alter table public.certificates alter column person_id set not null;

alter table public.events add column if not exists duplicate_window_seconds integer not null default 8
  check (duplicate_window_seconds between 1 and 300);
alter table public.events add column if not exists timeout_gap_minutes integer not null default 15
  check (timeout_gap_minutes between 1 and 1440);
alter table public.events add column if not exists reconciled_at timestamptz;
alter table public.events add column if not exists reconciled_by uuid references public.profiles(id) on delete set null;

alter table public.registrations add column if not exists answers jsonb not null default '{}'::jsonb;
alter table public.registrations add column if not exists autofill_used boolean not null default false;
alter table public.registrations add column if not exists source text not null default 'public_form';

create table if not exists public.org_form_fields (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null, label text not null, type text not null, required boolean not null default false,
  options jsonb, position integer not null default 0, unique(org_id, key)
);
create table if not exists public.event_form_fields (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  key text not null, label text not null, type text not null, required boolean not null default false,
  options jsonb, position integer not null default 0, unique(event_id, key)
);
create table if not exists public.registration_lookup_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  student_number_normalized text not null,
  masked_first_name text not null, masked_email text not null,
  otp_code_hash text not null, otp_expires_at timestamptz not null,
  otp_attempts integer not null default 0, verified boolean not null default false,
  autofill_token_hash text unique, autofill_token_expires_at timestamptz,
  expires_at timestamptz not null default (now() + interval '20 minutes'),
  created_at timestamptz not null default now()
);
alter table public.registration_lookup_sessions add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.registration_lookup_sessions add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.registration_lookup_sessions add column if not exists person_id uuid references public.persons(id) on delete cascade;
delete from public.registration_lookup_sessions where event_id is null or org_id is null or person_id is null;
alter table public.registration_lookup_sessions alter column event_id set not null;
alter table public.registration_lookup_sessions alter column org_id set not null;
alter table public.registration_lookup_sessions alter column person_id set not null;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid references public.members(id) on delete cascade, endpoint text not null unique,
  p256dh text not null, auth text not null, created_at timestamptz not null default now()
);
alter table public.notifications add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.notifications add column if not exists channel text not null default 'email'
  check (channel in ('email', 'push'));
alter table public.notifications add column if not exists recipient text;
alter table public.notifications add column if not exists scheduled_for timestamptz not null default now();
alter table public.notifications add column if not exists sent_at timestamptz;
alter table public.notifications add column if not exists failed_at timestamptz;
alter table public.notifications add column if not exists failure text;
create unique index if not exists notifications_delivery_uq
  on public.notifications(event_id, member_id, type, channel) where event_id is not null;

drop policy if exists events_all on public.events;
create policy events_select on public.events for select using (org_id = public.current_org_id());
create policy events_write on public.events for all
  using (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer'))
  with check (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer'));
drop policy if exists registrations_all on public.registrations;
create policy registrations_select on public.registrations for select using (org_id = public.current_org_id());
create policy registrations_write on public.registrations for all
  using (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer'))
  with check (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer'));
drop policy if exists attendance_all on public.attendance;
create policy attendance_select on public.attendance for select using (org_id = public.current_org_id());
create policy attendance_write on public.attendance for all
  using (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer', 'scanner_operator'))
  with check (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer', 'scanner_operator'));

alter table public.persons enable row level security;
alter table public.logins enable row level security;
alter table public.org_people enable row level security;
alter table public.cards enable row level security;
alter table public.org_form_fields enable row level security;
alter table public.event_form_fields enable row level security;
alter table public.registration_lookup_sessions enable row level security;
alter table public.push_subscriptions enable row level security;

create policy org_people_select on public.org_people for select using (org_id = public.current_org_id());
create policy org_people_write on public.org_people for all
  using (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer'))
  with check (org_id = public.current_org_id() and public.current_org_role() in ('org_admin', 'officer'));
create policy persons_via_org on public.persons for select using (exists (
  select 1 from public.org_people op where op.person_id = persons.id and op.org_id = public.current_org_id()
));
create policy cards_via_org on public.cards for select using (exists (
  select 1 from public.org_people op where op.person_id = cards.person_id and op.org_id = public.current_org_id()
));
create policy org_fields_select on public.org_form_fields for select using (org_id = public.current_org_id());
create policy event_fields_select on public.event_form_fields for select using (exists (
  select 1 from public.events e where e.id = event_form_fields.event_id and e.org_id = public.current_org_id()
));
create policy push_subscriptions_org on public.push_subscriptions for all
  using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());

alter table public.card_link_audit add column if not exists reason text;

create or replace function public.link_member_card(
  p_org_id uuid, p_member_id uuid, p_card_uid text, p_officer_id uuid
) returns public.members language plpgsql security definer set search_path=public as $$
declare v_member public.members;
begin
  select * into v_member from members where id=p_member_id and org_id=p_org_id for update;
  if not found then raise exception 'Member not found' using errcode='TP003'; end if;
  if v_member.card_uid is not null then raise exception 'Member already has a linked card' using errcode='TP001'; end if;
  insert into cards(uid,person_id) values(p_card_uid,v_member.person_id);
  update members set card_uid=p_card_uid,card_linked_at=now(),card_linked_by=p_officer_id
    where id=p_member_id returning * into v_member;
  insert into card_link_audit(org_id,member_id,old_uid,new_uid,action,officer_id)
    values(p_org_id,p_member_id,null,p_card_uid,'link',p_officer_id);
  return v_member;
end $$;

create or replace function public.replace_member_card(
  p_org_id uuid, p_member_id uuid, p_new_card_uid text, p_officer_id uuid, p_reason text default null
) returns public.members language plpgsql security definer set search_path = public as $$
declare v_member public.members; v_old_uid text;
begin
  select * into v_member from public.members where id = p_member_id and org_id = p_org_id for update;
  if not found then raise exception 'Member not found' using errcode = 'TP003'; end if;
  if v_member.card_uid is null then raise exception 'Member has no linked card' using errcode = 'TP002'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'Replacement reason is required' using errcode = '22023'; end if;
  v_old_uid := v_member.card_uid;
  update public.cards set active = false, revoked_at = now() where person_id = v_member.person_id and active;
  insert into public.cards(uid, person_id) values (p_new_card_uid, v_member.person_id);
  update public.members set card_uid = p_new_card_uid, card_linked_at = now(), card_linked_by = p_officer_id,
    lost_card_flag = false where id = p_member_id returning * into v_member;
  update public.org_people set lost_card_flag = false where org_id = p_org_id and person_id = v_member.person_id;
  insert into public.card_link_audit(org_id, member_id, old_uid, new_uid, action, officer_id, reason)
    values (p_org_id, p_member_id, v_old_uid, p_new_card_uid, 'relink', p_officer_id, p_reason);
  return v_member;
end $$;

create or replace function public.unlink_member_card(
  p_org_id uuid,p_member_id uuid,p_officer_id uuid
) returns public.members language plpgsql security definer set search_path=public as $$
declare v_member public.members; v_old_uid text;
begin
  select * into v_member from members where id=p_member_id and org_id=p_org_id for update;
  if not found then raise exception 'Member not found' using errcode='TP003'; end if;
  if v_member.card_uid is null then raise exception 'Member has no linked card' using errcode='TP002'; end if;
  v_old_uid:=v_member.card_uid;
  update cards set active=false,revoked_at=now() where person_id=v_member.person_id and active;
  update members set card_uid=null,card_linked_at=null,card_linked_by=null where id=p_member_id returning * into v_member;
  insert into card_link_audit(org_id,member_id,old_uid,new_uid,action,officer_id)
    values(p_org_id,p_member_id,v_old_uid,null,'unlink',p_officer_id);
  return v_member;
end $$;

revoke all on function public.replace_member_card(uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.replace_member_card(uuid,uuid,text,uuid,text) from public,anon,authenticated;

create or replace function public.record_scan(
  p_org_id uuid, p_event_id uuid, p_card_uid text, p_scanned_at timestamptz default now(),
  p_officer_id uuid default null, p_device_id text default null,
  p_client_scan_id text default null, p_method scan_method default 'tap'
) returns attendance language plpgsql security definer set search_path = public as $$
declare v_member members; v_event events; v_existing attendance; v_on_list boolean;
        v_status attendance_status; v_reg_type text; v_timing text; v_row attendance;
begin
  select m.* into v_member from members m join cards c on c.person_id = m.person_id
    where m.org_id = p_org_id and c.uid = p_card_uid and c.active for share;
  if not found then
    if exists(select 1 from cards c join members m on m.person_id=c.person_id
      where m.org_id=p_org_id and c.uid=p_card_uid and not c.active) then
      raise exception 'Card has been revoked' using errcode='TP026';
    end if;
    raise exception 'Card is not linked to any active member' using errcode = 'TP020';
  end if;
  if v_member.status <> 'active' then raise exception 'Member is not active' using errcode = 'TP025'; end if;
  select * into v_event from events where id = p_event_id and org_id = p_org_id for share;
  if not found then raise exception 'Event not found' using errcode = 'TP021'; end if;
  if v_event.status <> 'published' then raise exception 'Event is not published' using errcode = 'TP022'; end if;
  if p_client_scan_id is not null then
    select * into v_existing from attendance where event_id = p_event_id and client_scan_id = p_client_scan_id;
    if found then return v_existing; end if;
  end if;
  select * into v_existing from attendance where event_id = p_event_id and person_id = v_member.person_id for update;
  if found then
    if p_scanned_at >= v_existing.time_in + make_interval(mins => v_event.timeout_gap_minutes) then
      update attendance set time_out = greatest(coalesce(time_out, p_scanned_at), p_scanned_at), updated_at = now()
      where id = v_existing.id returning * into v_existing;
    end if;
    return v_existing;
  end if;
  select exists(select 1 from event_master_list where event_id = p_event_id and member_id = v_member.id) into v_on_list;
  v_timing := case when p_scanned_at <= v_event.starts_at + make_interval(mins => v_event.grace_period_minutes)
                   then 'on_time' else 'late' end;
  if v_on_list then v_reg_type := 'pre_registered'; v_status := case when v_timing='late' then 'late'::attendance_status else 'present'::attendance_status end;
  elsif v_event.walk_in_policy = 'open' then v_reg_type := 'walk_in'; v_status := 'walk_in';
  elsif v_event.walk_in_policy = 'closed' then raise exception 'Walk-ins are not allowed' using errcode='TP023';
  else raise exception 'Walk-ins require approval' using errcode='TP024'; end if;
  insert into attendance(event_id, org_id, member_id, person_id, status, registration_type, timing,
    time_in, raw_timestamp, method, scan_uid, device_id, scanned_by, client_scan_id)
  values(p_event_id,p_org_id,v_member.id,v_member.person_id,v_status,v_reg_type,v_timing,
    p_scanned_at,p_scanned_at,p_method,p_card_uid,p_device_id,p_officer_id,p_client_scan_id)
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.reconcile_event(p_org_id uuid, p_event_id uuid, p_officer_id uuid)
returns events language plpgsql security definer set search_path=public as $$
declare v_event events;
begin
  select * into v_event from events where id=p_event_id and org_id=p_org_id for update;
  if not found then raise exception 'Event not found' using errcode='TP030'; end if;
  if v_event.status <> 'published' then raise exception 'Only published events can be reconciled' using errcode='TP031'; end if;
  if v_event.ends_at is not null and v_event.ends_at > now() then raise exception 'Event has not ended' using errcode='TP032'; end if;
  update events set reconciled_at=now(), reconciled_by=p_officer_id, updated_at=now()
  where id=p_event_id returning * into v_event;
  return v_event;
end $$;

create or replace function public.finalize_event(p_org_id uuid,p_event_id uuid,p_officer_id uuid default null,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_event events; v_absent integer:=0; v_points integer:=0; v_total integer:=0;
begin
  select * into v_event from events where id=p_event_id and org_id=p_org_id for update;
  if not found then raise exception 'Event not found' using errcode='TP030'; end if;
  if v_event.status='completed' then
    select count(*) into v_total from attendance where event_id=p_event_id and status<>'absent';
    select coalesce(sum(points),0) into v_points from points_ledger where event_id=p_event_id;
    select count(*) into v_absent from attendance where event_id=p_event_id and status='absent';
    return jsonb_build_object('already_finalized',true,'absent_marked',v_absent,'points_awarded',v_points,'total_attendees',v_total);
  end if;
  if v_event.status<>'published' then raise exception 'Only published events can be finalized' using errcode='TP031'; end if;
  if v_event.reconciled_at is null then raise exception 'Reconcile all attendance sources before finalizing' using errcode='TP033'; end if;
  with added as (
    insert into attendance(event_id,org_id,member_id,person_id,status,registration_type,timing,method)
    select p_event_id,p_org_id,eml.member_id,m.person_id,'absent','pre_registered','on_time','manual'
    from event_master_list eml join members m on m.id=eml.member_id
    where eml.event_id=p_event_id and not exists(select 1 from attendance a where a.event_id=p_event_id and a.person_id=m.person_id)
    returning 1) select count(*) into v_absent from added;
  if v_event.points_value>0 then
    with awarded as (
      insert into points_ledger(org_id,member_id,person_id,event_id,points,reason,awarded_by)
      select p_org_id,a.member_id,a.person_id,p_event_id,v_event.points_value,'event_attendance',p_officer_id
      from attendance a where a.event_id=p_event_id and a.status in ('present','late','walk_in')
      on conflict (event_id,member_id) where reason='event_attendance' do nothing returning points)
    select coalesce(sum(points),0) into v_points from awarded;
  end if;
  select count(*) into v_total from attendance where event_id=p_event_id and status in ('present','late','walk_in');
  update events set status='completed',updated_at=now() where id=p_event_id;
  return jsonb_build_object('already_finalized',false,'absent_marked',v_absent,'points_awarded',v_points,'total_attendees',v_total);
end $$;

create or replace function public.register_for_event(
  p_event_id uuid,p_full_name text,p_student_number text,p_email citext,p_answers jsonb,p_autofill_used boolean
) returns registrations language plpgsql security definer set search_path=public as $$
declare v_event events; v_row registrations; v_number text;
begin
  select * into v_event from events where id=p_event_id for update;
  if not found then raise exception 'Event not found' using errcode='TP050'; end if;
  if v_event.status<>'published' then raise exception 'Event is not open' using errcode='TP051'; end if;
  if v_event.slots is not null and (select count(*) from registrations where event_id=p_event_id and status in ('pending','approved'))>=v_event.slots
    then raise exception 'Event is full' using errcode='TP052'; end if;
  v_number:=normalize_student_number(p_student_number);
  insert into registrations(event_id,org_id,full_name,student_number,email,answers,autofill_used,source,status)
  values(p_event_id,v_event.org_id,p_full_name,v_number,p_email,coalesce(p_answers,'{}'),p_autofill_used,'public_form','pending')
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.review_registration(
  p_org_id uuid,p_registration_id uuid,p_action text,p_officer_id uuid
) returns registrations language plpgsql security definer set search_path=public as $$
declare v_reg registrations; v_person persons; v_member members;
begin
  select * into v_reg from registrations where id=p_registration_id and org_id=p_org_id for update;
  if not found then raise exception 'Registration not found' using errcode='TP053'; end if;
  if v_reg.status<>'pending' then raise exception 'Already reviewed' using errcode='TP054'; end if;
  if p_action='deny' then update registrations set status='denied',reviewed_by=p_officer_id,reviewed_at=now() where id=p_registration_id returning * into v_reg; return v_reg; end if;
  if p_action<>'approve' then raise exception 'Invalid action' using errcode='22023'; end if;
  select * into v_person from persons where student_number_normalized=normalize_student_number(v_reg.student_number) for update;
  if not found then insert into persons(student_number,student_number_normalized,full_name,email)
    values(v_reg.student_number,normalize_student_number(v_reg.student_number),v_reg.full_name,v_reg.email) returning * into v_person; end if;
  select * into v_member from members where org_id=p_org_id and person_id=v_person.id;
  if not found then insert into members(org_id,person_id,student_number,full_name,email,member_role,status)
    values(p_org_id,v_person.id,v_person.student_number_normalized,v_reg.full_name,v_reg.email,'attendee','active') returning * into v_member; end if;
  insert into org_people(org_id,person_id,directory_role) values(p_org_id,v_person.id,'attendee') on conflict do nothing;
  insert into event_master_list(event_id,member_id,added_by) values(v_reg.event_id,v_member.id,p_officer_id) on conflict do nothing;
  update registrations set member_id=v_member.id,status='approved',reviewed_by=p_officer_id,reviewed_at=now()
  where id=p_registration_id returning * into v_reg;
  return v_reg;
end $$;

revoke all on function public.register_for_event(uuid,text,text,citext,jsonb,boolean) from public,authenticated;
grant execute on function public.register_for_event(uuid,text,text,citext,jsonb,boolean) to anon,service_role;
revoke all on function public.review_registration(uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.reconcile_event(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.report_member_summary(
  p_org_id uuid, p_member_id uuid default null, p_status member_status default null,
  p_search text default null, p_course text default null,
  p_from timestamptz default null, p_to timestamptz default null,
  p_limit integer default 50, p_offset integer default 0
) returns table (
  member_id uuid, student_number text, full_name text, course text, status member_status,
  credits bigint, present bigint, late bigint, walk_in bigint, absent bigint,
  current_tappies bigint, longest_tappies bigint, certificates_issued bigint, total_count bigint
) language sql stable security definer set search_path=public as $$
  with selected as (
    select m.* from members m where m.org_id=p_org_id
      and (p_member_id is null or m.id=p_member_id)
      and (p_status is null or m.status=p_status)
      and (p_search is null or m.full_name ilike '%'||p_search||'%' or m.student_number ilike '%'||p_search||'%')
      and (p_course is null or m.course ilike p_course)
  ), history as (
    select a.member_id,a.status from attendance a join events e on e.id=a.event_id
    where a.org_id=p_org_id and e.status='completed'
      and a.member_id in (select id from selected)
      and (p_from is null or e.starts_at>=p_from) and (p_to is null or e.starts_at<=p_to)
  ), counts as (
    select h.member_id,
      count(*) filter(where h.status='present') present,
      count(*) filter(where h.status='late') late,
      count(*) filter(where h.status='walk_in') walk_in,
      count(*) filter(where h.status='absent') absent,
      count(*) filter(where h.status in ('present','late','walk_in')) tappies
    from history h group by h.member_id
  ), credits as (
    select pl.member_id,sum(pl.points)::bigint credits from points_ledger pl left join events e on e.id=pl.event_id
    where pl.org_id=p_org_id and pl.member_id in(select id from selected)
      and (p_from is null or coalesce(e.starts_at,pl.created_at)>=p_from)
      and (p_to is null or coalesce(e.starts_at,pl.created_at)<=p_to) group by pl.member_id
  ), certs as (
    select c.member_id,count(*) certificates_issued from certificates c join events e on e.id=c.event_id
    where c.org_id=p_org_id and c.revoked_at is null and c.member_id in(select id from selected)
      and (p_from is null or e.starts_at>=p_from) and (p_to is null or e.starts_at<=p_to) group by c.member_id
  )
  select s.id,s.student_number,s.full_name,s.course,s.status,coalesce(cr.credits,0),
    coalesce(ct.present,0),coalesce(ct.late,0),coalesce(ct.walk_in,0),coalesce(ct.absent,0),
    coalesce(ct.tappies,0),coalesce(ct.tappies,0),coalesce(ce.certificates_issued,0),count(*) over()
  from selected s left join credits cr on cr.member_id=s.id left join counts ct on ct.member_id=s.id
  left join certs ce on ce.member_id=s.id order by s.full_name,s.id limit p_limit offset p_offset
$$;

drop function if exists public.report_attendance(uuid,uuid,text[],timestamptz,timestamptz,text,text,integer,integer);
create or replace function public.report_attendance(
  p_org_id uuid,p_event_id uuid default null,p_statuses text[] default null,
  p_from timestamptz default null,p_to timestamptz default null,p_search text default null,
  p_course text default null,p_committee text default null,p_limit integer default 50,p_offset integer default 0
) returns table(
  event_id uuid,event_title text,event_starts_at timestamptz,event_status event_status,
  member_id uuid,student_number text,full_name text,course text,status text,time_in timestamptz,
  time_out timestamptz,method text,certificate_eligible boolean,certificate_id uuid,
  certificate_code text,certificate_revoked_at timestamptz,total_count bigint
) language sql stable security definer set search_path=public as $$
  with rows as (
    select e.id event_id,e.title event_title,e.starts_at event_starts_at,e.status event_status,
      m.id member_id,m.student_number,m.full_name,m.course,a.status::text status,a.time_in,a.time_out,
      a.method::text method,(e.certificate_enabled and a.status in ('present','late','walk_in')) certificate_eligible,
      c.id certificate_id,c.code certificate_code,c.revoked_at certificate_revoked_at,m.committee
    from attendance a join events e on e.id=a.event_id join members m on m.id=a.member_id
    left join certificates c on c.event_id=e.id and c.member_id=m.id
    where e.org_id=p_org_id and e.status<>'draft'
    union all
    select e.id,e.title,e.starts_at,e.status,m.id,m.student_number,m.full_name,m.course,'not_scanned',
      null::timestamptz,null::timestamptz,null::text,false,null::uuid,null::text,null::timestamptz,m.committee
    from event_master_list eml join events e on e.id=eml.event_id join members m on m.id=eml.member_id
    where e.org_id=p_org_id and e.status='published'
      and not exists(select 1 from attendance a where a.event_id=e.id and a.person_id=m.person_id)
  ), filtered as (
    select * from rows r where (p_event_id is null or r.event_id=p_event_id)
      and (p_statuses is null or r.status=any(p_statuses))
      and (p_from is null or r.event_starts_at>=p_from) and (p_to is null or r.event_starts_at<=p_to)
      and (p_search is null or r.full_name ilike '%'||p_search||'%' or r.student_number ilike '%'||p_search||'%')
      and (p_course is null or r.course ilike p_course) and (p_committee is null or r.committee ilike p_committee)
  )
  select f.event_id,f.event_title,f.event_starts_at,f.event_status,f.member_id,f.student_number,
    f.full_name,f.course,f.status,f.time_in,f.time_out,f.method,f.certificate_eligible,
    f.certificate_id,f.certificate_code,f.certificate_revoked_at,count(*) over()
  from filtered f order by f.event_starts_at desc,f.event_id,f.full_name,f.member_id limit p_limit offset p_offset
$$;

create or replace function public.tappies_leaderboard(p_org_id uuid,p_limit integer default 100)
returns table(member_id uuid,student_number text,full_name text,tappies bigint)
language sql stable security definer set search_path=public as $$
  select m.id,m.student_number,m.full_name,count(*)::bigint
  from attendance a join events e on e.id=a.event_id join members m on m.id=a.member_id
  where a.org_id=p_org_id and e.status='completed' and a.status in ('present','late','walk_in')
  group by m.id,m.student_number,m.full_name order by count(*) desc,m.full_name limit least(p_limit,500)
$$;

create or replace function public.issue_certificates(
  p_org_id uuid,p_event_id uuid,p_officer_id uuid default null,p_member_ids uuid[] default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_event events; v_issued integer:=0; v_reinstated integer:=0; v_skipped jsonb:='[]';
begin
  select * into v_event from events where id=p_event_id and org_id=p_org_id for share;
  if not found then raise exception 'Event not found' using errcode='TP040'; end if;
  if not v_event.certificate_enabled then raise exception 'Certificates disabled' using errcode='TP041'; end if;
  if v_event.status<>'completed' then raise exception 'Event not completed' using errcode='TP042'; end if;
  if p_member_ids is not null then
    select coalesce(jsonb_agg(jsonb_build_object('member_id',ids.id,'reason','not_eligible')),'[]') into v_skipped
    from (select distinct unnest(p_member_ids) id) ids where not exists(
      select 1 from attendance a where a.event_id=p_event_id and a.member_id=ids.id and a.status in ('present','late','walk_in'));
    with changed as (update certificates c set revoked_at=null,revoked_by=null,revoke_reason=null,
      code=generate_certificate_code(),issued_by=p_officer_id,issued_at=now()
      where c.org_id=p_org_id and c.event_id=p_event_id and c.revoked_at is not null and c.member_id=any(p_member_ids)
      and exists(select 1 from attendance a where a.event_id=p_event_id and a.member_id=c.member_id and a.status in ('present','late','walk_in')) returning 1)
    select count(*) into v_reinstated from changed;
  end if;
  with added as (insert into certificates(org_id,event_id,member_id,person_id,code,issued_by)
    select p_org_id,p_event_id,a.member_id,a.person_id,generate_certificate_code(),p_officer_id
    from attendance a where a.event_id=p_event_id and a.status in ('present','late','walk_in')
      and (p_member_ids is null or a.member_id=any(p_member_ids)) on conflict(event_id,member_id) do nothing returning 1)
  select count(*) into v_issued from added;
  return jsonb_build_object('issued',v_issued,'reinstated',v_reinstated,'skipped',v_skipped);
end $$;

drop policy if exists eml_all on public.event_master_list;
create policy eml_select on public.event_master_list for select using (exists(
  select 1 from events e where e.id=event_id and e.org_id=current_org_id()));
create policy eml_write on public.event_master_list for all
  using (current_org_role() in ('org_admin','officer') and exists(select 1 from events e where e.id=event_id and e.org_id=current_org_id()))
  with check (current_org_role() in ('org_admin','officer') and exists(select 1 from events e where e.id=event_id and e.org_id=current_org_id()));
drop policy if exists notifications_all on public.notifications;
create policy notifications_select on public.notifications for select using(org_id=current_org_id());
drop policy if exists devices_all on public.devices;
create policy devices_select on public.devices for select using(org_id=current_org_id());
create policy devices_write on public.devices for all
  using(org_id=current_org_id() and current_org_role() in ('org_admin','officer'))
  with check(org_id=current_org_id() and current_org_role() in ('org_admin','officer'));

revoke all on function public.report_attendance(uuid,uuid,text[],timestamptz,timestamptz,text,text,text,integer,integer) from public,anon,authenticated;
revoke all on function public.tappies_leaderboard(uuid,integer) from public,anon,authenticated;
