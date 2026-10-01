alter table members
  add column if not exists lost_card_flag boolean not null default false;

create index if not exists idx_members_lost_card
  on members(org_id, lost_card_flag)
  where lost_card_flag = true;

create table if not exists otp_codes (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null,
  code_hash   text not null,
  purpose     text not null check (purpose in ('signup', 'activation', 'autofill')),
  member_id   uuid references members(id) on delete cascade,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_otp_codes_email_purpose
  on otp_codes(email, purpose, expires_at);

create or replace function public.report_lost_card(p_member_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old_uid text;
  v_org_id  uuid;
begin
  select card_uid, org_id into v_old_uid, v_org_id
  from public.members
  where id = p_member_id;

  if not found then
    raise exception 'Member not found';
  end if;

  update public.members
  set card_uid = null, lost_card_flag = true
  where id = p_member_id;

  if v_old_uid is not null then
    insert into public.card_link_audit (org_id, member_id, old_uid, new_uid, action)
    values (v_org_id, p_member_id, v_old_uid, null, 'unlink');
  end if;

  insert into public.audit_logs (org_id, action, entity, entity_id, metadata)
  values (v_org_id, 'REPORT_LOST_CARD', 'members', p_member_id::text, jsonb_build_object('old_uid', v_old_uid));
end;
$$;

create or replace function public.resolve_lost_card(p_member_id uuid, p_officer_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org_id uuid;
begin
  select org_id into v_org_id
  from public.members
  where id = p_member_id;

  if not found then
    raise exception 'Member not found';
  end if;

  update public.members
  set lost_card_flag = false
  where id = p_member_id;

  insert into public.audit_logs (org_id, actor_id, action, entity, entity_id)
  values (v_org_id, p_officer_id, 'RESOLVE_LOST_CARD', 'members', p_member_id::text);
end;
$$;

alter table public.otp_codes enable row level security;
