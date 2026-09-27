-- =============================================================
-- Tappi — events publish / cancel (Part 4)
-- =============================================================
-- events and event_master_list already exist (see 0001_init). This
-- migration only adds the columns/constraints Part 4 needs and the
-- publish/cancel RPCs — it does not recreate either table.

-- ---------------------------------------------------------------
-- events: track when a draft was published / when an event was
-- cancelled, and guard against an end time before the start time.
-- ---------------------------------------------------------------
alter table events add column published_at timestamptz null;
alter table events add column cancelled_at timestamptz null;

alter table events
  add constraint events_ends_after_starts_chk
  check (ends_at is null or ends_at > starts_at);

-- ---------------------------------------------------------------
-- event_master_list: record who added each attendee. Nullable +
-- ON DELETE SET NULL so removing the officer's profile doesn't
-- cascade into deleting master-list rows (same shape as
-- members.card_linked_by). The existing (event_id, member_id)
-- primary key already enforces uniqueness and already gives an
-- index with event_id as the leading column, so no separate
-- index on event_id is added — it would be redundant.
-- ---------------------------------------------------------------
alter table event_master_list
  add column added_by uuid references profiles(id) on delete set null;

-- ---------------------------------------------------------------
-- publish_event / cancel_event must keep events.status consistent
-- with published_at/cancelled_at and must not be reachable through
-- the generic Data API (events_all / eml_all stay as broad
-- same-org policies; this pair of SECURITY DEFINER RPCs is the
-- only path that performs a status transition). Application code
-- (src/lib/events.ts) calls them with the service-role client,
-- only after its own requireAuth() + requireRole(["officer"])
-- checks — the RPCs trust p_org_id / p_officer_id as given, they
-- do not re-derive them from auth.uid().
--
-- Custom SQLSTATEs let the API layer map errors without parsing
-- messages:
--   TP010  event not found in this organization
--   TP011  invalid status transition (publish/cancel not allowed
--          from the event's current status)
--   TP012  reserved (not raised by these two RPCs; ends_at/starts_at
--          ordering is enforced by events_ends_after_starts_chk
--          instead, which the API maps to 400 on 23514)
--   TP013  reserved (not raised by these two RPCs; addToMasterList
--          enforces "member must belong to the same org" at the
--          application layer before insert)
--   TP014  cannot publish an event with an empty master list
-- ---------------------------------------------------------------

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

-- p_officer_id isn't read inside either function body (there's no
-- per-event "published_by"/"cancelled_by" column yet), but it's kept
-- in the signature to match the card-RPC calling convention and to
-- make room for an audit column later without an API-layer change.

revoke all on function public.publish_event(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_event(uuid, uuid, uuid) from public, anon, authenticated;
