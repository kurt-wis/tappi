alter table events add column published_at timestamptz null;
alter table events add column cancelled_at timestamptz null;

alter table events
  add constraint events_ends_after_starts_chk
  check (ends_at is null or ends_at > starts_at);

alter table event_master_list
  add column added_by uuid references profiles(id) on delete set null;

create or replace function public.publish_event(
  p_org_id uuid, p_event_id uuid, p_officer_id uuid
) returns events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event events;
  v_master_list_count integer;
begin
  select * into v_event from events
    where id = p_event_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Event not found' using errcode = 'TP010';
  end if;
  if v_event.status <> 'draft' then
    raise exception 'Only a draft event can be published' using errcode = 'TP011';
  end if;

  select count(*) into v_master_list_count
    from event_master_list where event_id = p_event_id;
  if v_master_list_count = 0 then
    raise exception 'Cannot publish an event with an empty master list' using errcode = 'TP014';
  end if;

  update events
    set status = 'published', published_at = now(), updated_at = now()
    where id = p_event_id and org_id = p_org_id
    returning * into v_event;

  return v_event;
end;
$$;

create or replace function public.cancel_event(
  p_org_id uuid, p_event_id uuid, p_officer_id uuid
) returns events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event events;
begin
  select * into v_event from events
    where id = p_event_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Event not found' using errcode = 'TP010';
  end if;
  if v_event.status in ('cancelled', 'completed') then
    raise exception 'Event is already cancelled or completed' using errcode = 'TP011';
  end if;

  update events
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where id = p_event_id and org_id = p_org_id
    returning * into v_event;

  return v_event;
end;
$$;

revoke all on function public.publish_event(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_event(uuid, uuid, uuid) from public, anon, authenticated;
