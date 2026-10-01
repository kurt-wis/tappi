create or replace function public.finalize_event(
  p_org_id     uuid,
  p_event_id   uuid,
  p_officer_id uuid default null,
  p_force      boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event            events;
  v_absent_marked    integer := 0;
  v_points_awarded   integer := 0;
  v_total_attendees  integer := 0;
begin
  select * into v_event from events
    where id = p_event_id and org_id = p_org_id
    for update;
  if not found then
    raise exception 'Event not found' using errcode = 'TP030';
  end if;

  if v_event.status = 'completed' then
    select count(*) into v_total_attendees
      from attendance
      where event_id = p_event_id and status <> 'absent';

    select coalesce(sum(points), 0) into v_points_awarded
      from points_ledger
      where event_id = p_event_id;

    select count(*) into v_absent_marked
      from attendance
      where event_id = p_event_id and status = 'absent';

    return jsonb_build_object(
      'already_finalized', true,
      'absent_marked', v_absent_marked,
      'points_awarded', v_points_awarded,
      'total_attendees', v_total_attendees
    );
  end if;

  if v_event.status <> 'published' then
    raise exception 'Only a published event can be finalized' using errcode = 'TP031';
  end if;

  if not p_force and v_event.ends_at is not null and v_event.ends_at > now() then
    raise exception 'Event has not ended yet' using errcode = 'TP032';
  end if;

  with inserted as (
    insert into attendance (event_id, org_id, member_id, status, method)
    select p_event_id, p_org_id, eml.member_id, 'absent', 'manual'
      from event_master_list eml
      where eml.event_id = p_event_id
        and not exists (
          select 1 from attendance a
          where a.event_id = p_event_id and a.member_id = eml.member_id
        )
    returning 1
  )
  select count(*) into v_absent_marked from inserted;

  if v_event.points_value > 0 then
    with awarded as (
      insert into points_ledger (org_id, member_id, event_id, points, reason, awarded_by)
      select p_org_id, a.member_id, p_event_id, v_event.points_value,
             'event_attendance', p_officer_id
        from attendance a
        where a.event_id = p_event_id
          and a.status in ('present', 'late', 'walk_in')
      returning 1
    )
    select count(*) into v_points_awarded from awarded;

    v_points_awarded := v_points_awarded * v_event.points_value;
  end if;

  select count(*) into v_total_attendees
    from attendance
    where event_id = p_event_id
      and status in ('present', 'late', 'walk_in');

  update events
    set status = 'completed', updated_at = now()
    where id = p_event_id and org_id = p_org_id;

  return jsonb_build_object(
    'already_finalized', false,
    'absent_marked', v_absent_marked,
    'points_awarded', v_points_awarded,
    'total_attendees', v_total_attendees
  );
end;
$$;

revoke all on function public.finalize_event(uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
