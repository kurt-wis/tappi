alter table card_link_audit alter column new_uid drop not null;
alter table card_link_audit
  add constraint card_link_audit_new_uid_action_chk
  check (
    (action = 'unlink' and new_uid is null) or
    (action <> 'unlink' and new_uid is not null)
  );

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

revoke all on function public.link_member_card(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.replace_member_card(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.unlink_member_card(uuid, uuid, uuid) from public, anon, authenticated;

drop policy card_audit_all on public.card_link_audit;
create policy card_audit_select on public.card_link_audit
  for select to authenticated
  using (org_id = public.current_org_id());
revoke insert, update, delete on public.card_link_audit from public, anon, authenticated;
