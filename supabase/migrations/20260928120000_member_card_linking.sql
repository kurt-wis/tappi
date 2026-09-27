-- =============================================================
-- Tappi — member card linking (link / replace / unlink)
-- =============================================================

-- card_link_audit.new_uid was NOT NULL, but the 'unlink' action has no new
-- uid to record. Resolve by making new_uid nullable and enforcing, via a
-- check constraint, that it is null exactly when action = 'unlink'.
alter table card_link_audit alter column new_uid drop not null;
alter table card_link_audit
  add constraint card_link_audit_new_uid_action_chk
  check (
    (action = 'unlink' and new_uid is null) or
    (action <> 'unlink' and new_uid is not null)
  );

-- ---------------------------------------------------------------
-- Card mutations must keep members.card_* and card_link_audit
-- consistent, and must not be reachable through the generic Data
-- API (the accounts_members_access migration already blocks
-- authenticated UPDATE of card_uid / card_linked_at / card_linked_by).
-- These SECURITY DEFINER RPCs are the only path that writes those
-- columns. Application code (src/lib/member-cards.ts) calls them
-- with the service-role client, only after its own requireAuth() +
-- requireRole() checks — the RPCs trust p_org_id / p_officer_id as
-- given, they do not re-derive them from auth.uid().
--
-- Custom SQLSTATEs let the API layer map errors without parsing
-- messages:
--   TP001  member already has a linked card       (link)
--   TP002  member has no linked card               (replace / unlink)
--   TP003  member not found in this organization
--   23505  card UID already linked to a different member in this
--          org — raised naturally by uq_members_org_card_uid
-- ---------------------------------------------------------------

create or replace function public.link_member_card(
  p_org_id uuid, p_member_id uuid, p_card_uid text, p_officer_id uuid
) returns members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member members;
begin
  select * into v_member from members
    where id = p_member_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Member not found' using errcode = 'TP003';
  end if;
  if v_member.card_uid is not null then
    raise exception 'Member already has a linked card' using errcode = 'TP001';
  end if;

  update members
    set card_uid = p_card_uid, card_linked_at = now(), card_linked_by = p_officer_id
    where id = p_member_id and org_id = p_org_id
    returning * into v_member;

  insert into card_link_audit (org_id, member_id, old_uid, new_uid, action, officer_id)
    values (p_org_id, p_member_id, null, p_card_uid, 'link', p_officer_id);

  return v_member;
end;
$$;

create or replace function public.replace_member_card(
  p_org_id uuid, p_member_id uuid, p_new_card_uid text, p_officer_id uuid
) returns members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member members;
  v_old_uid text;
begin
  select * into v_member from members
    where id = p_member_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Member not found' using errcode = 'TP003';
  end if;
  if v_member.card_uid is null then
    raise exception 'Member has no linked card' using errcode = 'TP002';
  end if;
  v_old_uid := v_member.card_uid;

  update members
    set card_uid = p_new_card_uid, card_linked_at = now(), card_linked_by = p_officer_id
    where id = p_member_id and org_id = p_org_id
    returning * into v_member;

  insert into card_link_audit (org_id, member_id, old_uid, new_uid, action, officer_id)
    values (p_org_id, p_member_id, v_old_uid, p_new_card_uid, 'relink', p_officer_id);

  return v_member;
end;
$$;

create or replace function public.unlink_member_card(
  p_org_id uuid, p_member_id uuid, p_officer_id uuid
) returns members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member members;
  v_old_uid text;
begin
  select * into v_member from members
    where id = p_member_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Member not found' using errcode = 'TP003';
  end if;
  if v_member.card_uid is null then
    raise exception 'Member has no linked card' using errcode = 'TP002';
  end if;
  v_old_uid := v_member.card_uid;

  update members
    set card_uid = null, card_linked_at = null, card_linked_by = null
    where id = p_member_id and org_id = p_org_id
    returning * into v_member;

  insert into card_link_audit (org_id, member_id, old_uid, new_uid, action, officer_id)
    values (p_org_id, p_member_id, v_old_uid, null, 'unlink', p_officer_id);

  return v_member;
end;
$$;

-- These RPCs are invoked only via the service-role client from
-- src/lib/member-cards.ts, after application-level auth + role checks.
-- Revoke Data API execute access so they can't be called directly by an
-- authenticated/anon session, bypassing that authorization.
revoke all on function public.link_member_card(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.replace_member_card(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.unlink_member_card(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------
-- card_link_audit was previously `for all` for any same-org authenticated
-- user, which would let any member forge audit history directly through
-- the Data API. Writes now happen only inside the RPCs above (service
-- role, bypasses RLS); ordinary sessions get read-only access.
-- ---------------------------------------------------------------
drop policy card_audit_all on public.card_link_audit;
create policy card_audit_select on public.card_link_audit
  for select to authenticated
  using (org_id = public.current_org_id());
revoke insert, update, delete on public.card_link_audit from public, anon, authenticated;
