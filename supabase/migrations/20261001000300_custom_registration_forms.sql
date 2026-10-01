-- Part 12: custom per-event registration forms.
-- Org-level default fields live in organizations.settings->'registration_fields' and
-- per-event extra fields in events.form_fields; both are jsonb arrays of field definitions
-- validated by the API (src/lib/registration-form.ts). Answers are stored on the registration
-- together with a snapshot of the field definitions they were validated against.

alter table public.events add column form_fields jsonb not null default '[]'::jsonb;

update public.organizations o
set settings = jsonb_set(
  case when jsonb_typeof(o.settings) = 'object' then o.settings else '{}'::jsonb end,
  '{registration_fields}', f.fields, true)
from (
  select org_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'key', key, 'label', label, 'type', type, 'required', required, 'options', options)) order by rn) as fields
  from (select *, row_number() over (partition by org_id order by position, key) as rn from public.org_form_fields) ranked
  where rn <= 30
  group by org_id
) f
where f.org_id = o.id;

update public.events e
set form_fields = f.fields
from (
  select event_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'key', key, 'label', label, 'type', type, 'required', required, 'options', options)) order by rn) as fields
  from (select *, row_number() over (partition by event_id order by position, key) as rn from public.event_form_fields) ranked
  where rn <= 30
  group by event_id
) f
where f.event_id = e.id;

drop table public.org_form_fields;
drop table public.event_form_fields;

alter table public.events add constraint events_form_fields_chk check (
  case when jsonb_typeof(form_fields) = 'array' then jsonb_array_length(form_fields) <= 30 else false end
);

alter table public.registrations add column form_snapshot jsonb not null default '[]'::jsonb;
alter table public.registrations add constraint registrations_answers_object_chk
  check (jsonb_typeof(answers) = 'object');
alter table public.registrations add constraint registrations_form_snapshot_array_chk
  check (jsonb_typeof(form_snapshot) = 'array');

create or replace function public.set_org_registration_fields(p_org_id uuid, p_fields jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_fields jsonb;
begin
  if jsonb_typeof(p_fields) is distinct from 'array' then
    raise exception 'Registration fields must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_fields) > 30 then
    raise exception 'Too many registration fields' using errcode = '22023';
  end if;
  update organizations
     set settings = jsonb_set(
           case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end,
           '{registration_fields}', p_fields, true)
   where id = p_org_id
  returning settings->'registration_fields' into v_fields;
  if not found then raise exception 'Organization not found' using errcode = 'TP070'; end if;
  return v_fields;
end $$;

create or replace function public.set_event_form_fields(p_org_id uuid, p_event_id uuid, p_fields jsonb)
returns events language plpgsql security definer set search_path = public as $$
declare v_event events;
begin
  if jsonb_typeof(p_fields) is distinct from 'array' then
    raise exception 'Form fields must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_fields) > 30 then
    raise exception 'Too many form fields' using errcode = '22023';
  end if;
  select * into v_event from events where id = p_event_id and org_id = p_org_id for update;
  if not found then raise exception 'Event not found' using errcode = 'TP010'; end if;
  if v_event.status not in ('draft', 'published') then
    raise exception 'The registration form of a cancelled or completed event is locked' using errcode = 'TP071';
  end if;
  update events set form_fields = p_fields, updated_at = now()
   where id = p_event_id
  returning * into v_event;
  return v_event;
end $$;

revoke all on function public.set_org_registration_fields(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_event_form_fields(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_org_registration_fields(uuid, jsonb),
  public.set_event_form_fields(uuid, uuid, jsonb) to service_role;

drop function public.register_for_event(uuid, text, text, citext, jsonb, boolean, text);
create or replace function public.register_for_event(
  p_event_id uuid, p_full_name text, p_student_number text, p_email citext, p_answers jsonb,
  p_autofill_used boolean, p_autofill_token_hash text default null, p_form_snapshot jsonb default '[]'::jsonb
) returns registrations language plpgsql security definer set search_path = public as $$
declare v_event events; v_row registrations; v_number text; v_session registration_lookup_sessions;
begin
  select * into v_event from events where id = p_event_id for update;
  if not found then raise exception 'Event not found' using errcode = 'TP050'; end if;
  if v_event.status <> 'published' then raise exception 'Event is not open' using errcode = 'TP051'; end if;
  if v_event.slots is not null and (select count(*) from registrations where event_id = p_event_id and status in ('pending', 'approved')) >= v_event.slots
    then raise exception 'Event is full' using errcode = 'TP052'; end if;
  v_number := normalize_student_number(p_student_number);
  if p_autofill_used or p_autofill_token_hash is not null then
    select * into v_session from registration_lookup_sessions
      where autofill_token_hash = p_autofill_token_hash and event_id = p_event_id and org_id = v_event.org_id
        and student_number_normalized = v_number and verified and autofill_token_expires_at > now() and expires_at > now()
      for update;
    if not found then raise exception 'Invalid autofill verification' using errcode = 'TP055'; end if;
  end if;
  insert into registrations(event_id, org_id, full_name, student_number, email, answers, form_snapshot, autofill_used, source, status)
  values (p_event_id, v_event.org_id, p_full_name, v_number, p_email, coalesce(p_answers, '{}'),
          coalesce(p_form_snapshot, '[]'), p_autofill_used, 'public_form', 'pending')
  returning * into v_row;
  if v_session.id is not null then
    update registration_lookup_sessions set autofill_token_hash = null, autofill_token_expires_at = null where id = v_session.id;
  end if;
  return v_row;
end $$;
revoke all on function public.register_for_event(uuid, text, text, citext, jsonb, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_for_event(uuid, text, text, citext, jsonb, boolean, text, jsonb) to service_role;
