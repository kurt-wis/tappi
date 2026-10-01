create or replace function public.record_scan(
  p_org_id         uuid,
  p_event_id       uuid,
  p_card_uid       text,
  p_scanned_at     timestamptz default now(),
  p_officer_id     uuid        default null,
  p_device_id      text        default null,
  p_client_scan_id text        default null,
  p_method         scan_method default 'tap'
) returns attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member       members;
  v_event        events;
  v_existing     attendance;
  v_on_list      boolean;
  v_status       attendance_status;
  v_grace_cutoff timestamptz;
  v_row          attendance;
begin
  select * into v_member from members
    where org_id = p_org_id and card_uid = p_card_uid
    for share;
  if not found then
    raise exception 'Card is not linked to any member' using errcode = 'TP020';
  end if;
  if v_member.status <> 'active' then
    raise exception 'Member is not active' using errcode = 'TP025';
  end if;

  select * into v_event from events
    where id = p_event_id and org_id = p_org_id
    for share;
  if not found then
    raise exception 'Event not found' using errcode = 'TP021';
  end if;
  if v_event.status <> 'published' then
    raise exception 'Event is not published' using errcode = 'TP022';
  end if;

  if p_client_scan_id is not null then
    select * into v_existing from attendance
      where event_id = p_event_id and client_scan_id = p_client_scan_id;
    if found then return v_existing; end if;
  end if;

  select * into v_existing from attendance
    where event_id = p_event_id and member_id = v_member.id;
  if found then return v_existing; end if;

  select exists(
    select 1 from event_master_list
    where event_id = p_event_id and member_id = v_member.id
  ) into v_on_list;

  if v_on_list then
    v_grace_cutoff := v_event.starts_at
                    + make_interval(mins => v_event.grace_period_minutes);
    if p_scanned_at <= v_grace_cutoff then
      v_status := 'present';
    else
      v_status := 'late';
    end if;
  else
    if v_event.walk_in_policy = 'open' then
      v_status := 'walk_in';
    elsif v_event.walk_in_policy = 'closed' then
      raise exception 'Walk-ins are not allowed for this event' using errcode = 'TP023';
    else
      raise exception 'Walk-ins require approval for this event' using errcode = 'TP024';
    end if;
  end if;

  insert into attendance (
    event_id, org_id, member_id, status, time_in, method,
    scan_uid, device_id, scanned_by, client_scan_id
  ) values (
    p_event_id, p_org_id, v_member.id, v_status, p_scanned_at, p_method,
    p_card_uid, p_device_id, p_officer_id, p_client_scan_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_scan(
  uuid, uuid, text, timestamptz, uuid, text, text, scan_method
) from public, anon, authenticated;
