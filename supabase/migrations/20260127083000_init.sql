create extension if not exists "pgcrypto";
create extension if not exists "citext";

create type org_role          as enum ('org_admin', 'officer', 'scanner_operator');
create type member_status     as enum ('active', 'inactive', 'archived');
create type event_status      as enum ('draft', 'published', 'cancelled', 'completed');
create type walk_in_policy    as enum ('open', 'approval', 'closed');
create type registration_status as enum ('pending', 'approved', 'denied');
create type attendance_status as enum ('present', 'late', 'walk_in', 'absent');
create type scan_method       as enum ('tap', 'manual', 'offline_sync');
create type notification_type as enum ('event_reminder', 'absentee_alert', 'late_alert', 'officer_alert');

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        citext not null unique,
  logo_url    text,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_organizations_updated_at
  before update on organizations
  for each row execute function set_updated_at();

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  email       citext not null,
  full_name   text not null,
  role        org_role not null default 'officer',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_profiles_org on profiles(org_id);

create trigger trg_profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

create table members (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  student_number  text not null,
  full_name       text not null,
  email           citext,
  course          text,
  member_role     text not null default 'member',
  status          member_status not null default 'active',
  card_uid        text,
  card_linked_at  timestamptz,
  card_linked_by  uuid references profiles(id) on delete set null,
  user_id         uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, student_number)
);

create unique index uq_members_org_card_uid
  on members(org_id, card_uid)
  where card_uid is not null;

create index idx_members_org_status on members(org_id, status);
create index idx_members_card_uid   on members(card_uid);

create trigger trg_members_updated_at
  before update on members
  for each row execute function set_updated_at();

create table events (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  title                 text not null,
  description           text,
  venue                 text,
  starts_at             timestamptz not null,
  ends_at               timestamptz,
  grace_period_minutes  integer not null default 15 check (grace_period_minutes >= 0),
  slots                 integer check (slots is null or slots >= 0),
  walk_in_policy        walk_in_policy not null default 'closed',
  status                event_status not null default 'draft',
  points_value          integer not null default 0,
  certificate_enabled   boolean not null default false,
  created_by            uuid references profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_events_org_starts on events(org_id, starts_at desc);
create index idx_events_org_status on events(org_id, status);

create trigger trg_events_updated_at
  before update on events
  for each row execute function set_updated_at();

create table event_master_list (
  event_id   uuid not null references events(id) on delete cascade,
  member_id  uuid not null references members(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (event_id, member_id)
);

create index idx_eml_member on event_master_list(member_id);

create table registrations (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events(id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  member_id       uuid references members(id) on delete set null,
  full_name       text not null,
  student_number  text not null,
  email           citext,
  status          registration_status not null default 'pending',
  reviewed_by     uuid references profiles(id) on delete set null,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (event_id, student_number)
);

create index idx_registrations_event_status on registrations(event_id, status);

create trigger trg_registrations_updated_at
  before update on registrations
  for each row execute function set_updated_at();

create table attendance (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references events(id) on delete cascade,
  org_id         uuid not null references organizations(id) on delete cascade,
  member_id      uuid not null references members(id) on delete cascade,
  status         attendance_status not null,
  time_in        timestamptz,
  time_out       timestamptz,
  method         scan_method not null default 'tap',
  scan_uid       text,
  device_id      text,
  scanned_by     uuid references profiles(id) on delete set null,
  client_scan_id text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (event_id, member_id)
);

create unique index uq_attendance_client_scan
  on attendance(event_id, client_scan_id)
  where client_scan_id is not null;

create index idx_attendance_event_status on attendance(event_id, status);
create index idx_attendance_member       on attendance(member_id);

create trigger trg_attendance_updated_at
  before update on attendance
  for each row execute function set_updated_at();

create table card_link_audit (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  member_id   uuid not null references members(id) on delete cascade,
  old_uid     text,
  new_uid     text not null,
  action      text not null check (action in ('link', 'relink', 'unlink')),
  officer_id  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index idx_card_audit_member on card_link_audit(member_id, created_at desc);

create table audit_logs (
  id          bigserial primary key,
  org_id      uuid not null references organizations(id) on delete cascade,
  actor_id    uuid references profiles(id) on delete set null,
  action      text not null,
  entity      text not null,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index idx_audit_logs_org on audit_logs(org_id, created_at desc);

create table points_ledger (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  member_id   uuid not null references members(id) on delete cascade,
  event_id    uuid references events(id) on delete set null,
  points      integer not null,
  reason      text not null,
  awarded_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index idx_points_member on points_ledger(member_id);

create table certificates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  event_id    uuid not null references events(id) on delete cascade,
  member_id   uuid not null references members(id) on delete cascade,
  code        text not null unique,
  issued_by   uuid references profiles(id) on delete set null,
  issued_at   timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (event_id, member_id)
);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  member_id   uuid references members(id) on delete cascade,
  type        notification_type not null,
  title       text not null,
  body        text,
  metadata    jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index idx_notifications_org on notifications(org_id, created_at desc);

create table devices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  device_id    text not null,
  label        text,
  kind         text not null default 'tapper' check (kind in ('tapper', 'linking_station', 'spare')),
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (org_id, device_id)
);

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_org_role()
returns org_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

alter table organizations      enable row level security;
alter table profiles           enable row level security;
alter table members            enable row level security;
alter table events             enable row level security;
alter table event_master_list  enable row level security;
alter table registrations      enable row level security;
alter table attendance         enable row level security;
alter table card_link_audit    enable row level security;
alter table audit_logs         enable row level security;
alter table points_ledger      enable row level security;
alter table certificates       enable row level security;
alter table notifications      enable row level security;
alter table devices            enable row level security;

create policy org_select on organizations
  for select using (id = current_org_id());
create policy org_update on organizations
  for update using (id = current_org_id() and current_org_role() = 'org_admin');

create policy profiles_select on profiles
  for select using (org_id = current_org_id());
create policy profiles_write on profiles
  for all using (org_id = current_org_id() and current_org_role() = 'org_admin')
  with check (org_id = current_org_id() and current_org_role() = 'org_admin');

create policy members_all on members
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy events_all on events
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy eml_all on event_master_list
  for all using (
    exists (select 1 from events e where e.id = event_id and e.org_id = current_org_id())
  ) with check (
    exists (select 1 from events e where e.id = event_id and e.org_id = current_org_id())
  );

create policy registrations_all on registrations
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy attendance_all on attendance
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy card_audit_all on card_link_audit
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy audit_logs_select on audit_logs
  for select using (org_id = current_org_id());

create policy points_all on points_ledger
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy certificates_all on certificates
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy notifications_all on notifications
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy devices_all on devices
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());
