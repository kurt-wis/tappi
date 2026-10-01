-- =============================================================
-- Tappi — 20261001000100_fix_otp_person_id
-- Corrects otp_codes to reference persons(id) instead of persons(person_id),
-- and updates report_lost_card to operate per-person.
-- =============================================================

-- 1. Ensure lost_card_flag exists on members (idempotent)
alter table members 
  add column if not exists lost_card_flag boolean not null default false;

create index if not exists idx_members_lost_card 
  on members(org_id, lost_card_flag) 
  where lost_card_flag = true;

-- 2. Fix otp_codes: drop member_id, add person_id → persons(id)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'otp_codes' and column_name = 'member_id'
  ) then
    alter table otp_codes drop constraint if exists otp_codes_member_id_fkey;
    alter table otp_codes drop column member_id;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'otp_codes' and column_name = 'person_id'
  ) then
    alter table otp_codes 
      add column person_id uuid references persons(id) on delete cascade;
  end if;
end $$;

-- 3. Drop old RPCs
drop function if exists public.report_lost_card(uuid);
drop function if exists public.resolve_lost_card(uuid, uuid);

-- 4. report_lost_card — per-person across all orgs
create or replace function public.report_lost_card(p_person_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  for r in
    select id, org_id, card_uid
    from public.members
    where person_id = p_person_id
      and card_uid is not null
  loop
    insert into public.card_link_audit (org_id, member_id, old_uid, new_uid, action)
    values (r.org_id, r.id, r.card_uid, null, 'unlink');
  end loop;

  update public.members
  set card_uid = null, lost_card_flag = true
  where person_id = p_person_id;

  insert into public.audit_logs (org_id, action, entity, entity_id, metadata)
  select distinct org_id, 'REPORT_LOST_CARD', 'persons', p_person_id::text,
         jsonb_build_object('person_id', p_person_id)
  from public.members
  where person_id = p_person_id;
end;
$$;

-- 5. resolve_lost_card — per-org resolve (staff)
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

-- 6. RLS on otp_codes
alter table public.otp_codes enable row level security;