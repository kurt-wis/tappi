drop policy points_all on public.points_ledger;
create policy points_select on public.points_ledger
  for select to authenticated using (org_id = public.current_org_id());
revoke insert, update, delete on public.points_ledger from public, anon, authenticated;

drop policy certificates_all on public.certificates;
create policy certificates_select on public.certificates
  for select to authenticated using (org_id = public.current_org_id());
revoke insert, update, delete on public.certificates from public, anon, authenticated;

alter table points_ledger
  add constraint points_ledger_nonzero_chk check (points <> 0);

create unique index uq_points_event_attendance
  on points_ledger(event_id, member_id)
  where reason = 'event_attendance';

create index idx_points_org_member on points_ledger(org_id, member_id, created_at desc);

alter table certificates
  add column revoked_by    uuid references profiles(id) on delete set null,
  add column revoke_reason text;

create index idx_certificates_member on certificates(member_id);

create or replace function public.generate_certificate_code()
returns text language sql volatile set search_path = public as $$
  select upper(substr(h, 1, 4) || '-' || substr(h, 5, 4) || '-' ||
               substr(h, 9, 4) || '-' || substr(h, 21, 4))
    from (select replace(gen_random_uuid()::text, '-', '') as h) s
$$;

create or replace function public.issue_certificates(
  p_org_id     uuid,
  p_event_id   uuid,
  p_officer_id uuid   default null,
  p_member_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event      events;
  v_issued     integer := 0;
  v_reinstated integer := 0;
  v_skipped    jsonb   := '[]'::jsonb;
begin
  select * into v_event from events
    where id = p_event_id and org_id = p_org_id
    for share;
  if not found then
    raise exception 'Event not found' using errcode = 'TP040';
  end if;
  if not v_event.certificate_enabled then
    raise exception 'Certificates are not enabled for this event' using errcode = 'TP041';
  end if;
  if v_event.status <> 'completed' then
    raise exception 'Event must be finalized before issuing certificates' using errcode = 'TP042';
  end if;

  if p_member_ids is not null then
    select coalesce(jsonb_agg(jsonb_build_object('member_id', ids.id, 'reason', 'not_eligible')), '[]'::jsonb)
      into v_skipped
      from (select distinct unnest(p_member_ids) as id) ids
      where not exists (
        select 1 from attendance a
        where a.event_id = p_event_id and a.member_id = ids.id
          and a.status in ('present', 'late', 'walk_in')
      );

    with reinstated as (
      update certificates c
        set revoked_at = null, revoked_by = null, revoke_reason = null,
            code = generate_certificate_code(),
            issued_by = p_officer_id, issued_at = now()
        where c.org_id = p_org_id and c.event_id = p_event_id
          and c.revoked_at is not null
          and c.member_id = any(p_member_ids)
          and exists (
            select 1 from attendance a
            where a.event_id = p_event_id and a.member_id = c.member_id
              and a.status in ('present', 'late', 'walk_in')
          )
      returning 1
    )
    select count(*) into v_reinstated from reinstated;
  end if;

  with inserted as (
    insert into certificates (org_id, event_id, member_id, code, issued_by)
    select p_org_id, p_event_id, a.member_id, generate_certificate_code(), p_officer_id
      from attendance a
      where a.event_id = p_event_id
        and a.status in ('present', 'late', 'walk_in')
        and (p_member_ids is null or a.member_id = any(p_member_ids))
    on conflict (event_id, member_id) do nothing
    returning 1
  )
  select count(*) into v_issued from inserted;

  return jsonb_build_object(
    'issued', v_issued,
    'reinstated', v_reinstated,
    'skipped', v_skipped
  );
end;
$$;

create or replace function public.revoke_certificate(
  p_org_id         uuid,
  p_certificate_id uuid,
  p_officer_id     uuid default null,
  p_reason         text default null
) returns certificates
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cert certificates;
begin
  select * into v_cert from certificates
    where id = p_certificate_id and org_id = p_org_id
    for update;
  if not found then
    raise exception 'Certificate not found' using errcode = 'TP043';
  end if;
  if v_cert.revoked_at is not null then
    raise exception 'Certificate is already revoked' using errcode = 'TP044';
  end if;

  update certificates
    set revoked_at = now(), revoked_by = p_officer_id, revoke_reason = p_reason
    where id = p_certificate_id
    returning * into v_cert;

  return v_cert;
end;
$$;

create or replace function public.report_attendance(
  p_org_id   uuid,
  p_event_id uuid        default null,
  p_statuses text[]      default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  p_search   text        default null,
  p_course   text        default null,
  p_limit    integer     default 50,
  p_offset   integer     default 0
) returns table (
  event_id               uuid,
  event_title            text,
  event_starts_at        timestamptz,
  event_status           event_status,
  member_id              uuid,
  student_number         text,
  full_name              text,
  course                 text,
  status                 text,
  time_in                timestamptz,
  time_out               timestamptz,
  method                 text,
  certificate_eligible   boolean,
  certificate_id         uuid,
  certificate_code       text,
  certificate_revoked_at timestamptz,
  total_count            bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with pattern as (
    select '%' || replace(replace(replace(p_search, chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_') || '%' as p
  ),
  base as (
    select a.event_id, a.member_id, a.status::text as status,
           a.time_in, a.time_out, a.method::text as method
      from attendance a
      where a.org_id = p_org_id
    union all
    select eml.event_id, eml.member_id, 'not_scanned', null, null, null
      from event_master_list eml
      join events e on e.id = eml.event_id
      where e.org_id = p_org_id and e.status = 'published'
        and not exists (
          select 1 from attendance a
          where a.event_id = eml.event_id and a.member_id = eml.member_id
        )
  )
  select e.id, e.title, e.starts_at, e.status,
         m.id, m.student_number, m.full_name, m.course,
         b.status, b.time_in, b.time_out, b.method,
         (e.certificate_enabled and e.status = 'completed'
           and b.status in ('present', 'late', 'walk_in')),
         c.id, c.code, c.revoked_at,
         count(*) over ()
    from base b
    join events  e on e.id = b.event_id and e.org_id = p_org_id
    join members m on m.id = b.member_id and m.org_id = p_org_id
    left join certificates c on c.event_id = b.event_id and c.member_id = b.member_id
    cross join pattern
    where e.status <> 'draft'
      and (p_event_id is null or e.id = p_event_id)
      and (p_statuses is null or b.status = any(p_statuses))
      and (p_from is null or e.starts_at >= p_from)
      and (p_to   is null or e.starts_at <= p_to)
      and (p_search is null or m.full_name ilike pattern.p or m.student_number ilike pattern.p)
      and (p_course is null or m.course ilike p_course)
    order by e.starts_at desc, e.id, m.full_name, m.id
    limit p_limit offset p_offset
$$;

create or replace function public.report_member_summary(
  p_org_id    uuid,
  p_member_id uuid          default null,
  p_status    member_status default null,
  p_search    text          default null,
  p_course    text          default null,
  p_from      timestamptz   default null,
  p_to        timestamptz   default null,
  p_limit     integer       default 50,
  p_offset    integer       default 0
) returns table (
  member_id           uuid,
  student_number      text,
  full_name           text,
  course              text,
  status              member_status,
  credits             bigint,
  present             bigint,
  late                bigint,
  walk_in             bigint,
  absent              bigint,
  current_tappies     bigint,
  longest_tappies     bigint,
  certificates_issued bigint,
  total_count         bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with pattern as (
    select '%' || replace(replace(replace(p_search, chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_') || '%' as p
  ),
  selected as (
    select m.* from members m cross join pattern
      where m.org_id = p_org_id
        and (p_member_id is null or m.id = p_member_id)
        and (p_status is null or m.status = p_status)
        and (p_search is null or m.full_name ilike pattern.p or m.student_number ilike pattern.p)
        and (p_course is null or m.course ilike p_course)
  ),
  history as (
    select a.member_id, e.id as event_id, e.starts_at, a.status,
           a.status <> 'absent' as attended
      from attendance a
      join events e on e.id = a.event_id
      where a.org_id = p_org_id and e.status = 'completed'
        and a.member_id in (select id from selected)
        and (p_from is null or e.starts_at >= p_from)
        and (p_to   is null or e.starts_at <= p_to)
  ),
  numbered as (
    select h.*,
           row_number() over (partition by h.member_id order by h.starts_at, h.event_id)
         - row_number() over (partition by h.member_id, h.attended order by h.starts_at, h.event_id) as grp,
           row_number() over (partition by h.member_id order by h.starts_at desc, h.event_id desc) as rn_desc
      from history h
  ),
  runs as (
    select n.member_id, n.attended, count(*) as len, bool_or(n.rn_desc = 1) as is_latest
      from numbered n
      group by n.member_id, n.attended, n.grp
  ),
  streaks as (
    select r.member_id,
           coalesce(max(r.len) filter (where r.attended and r.is_latest), 0) as current_tappies,
           coalesce(max(r.len) filter (where r.attended), 0) as longest_tappies
      from runs r
      group by r.member_id
  ),
  counts as (
    select h.member_id,
           count(*) filter (where h.status = 'present') as present,
           count(*) filter (where h.status = 'late')    as late,
           count(*) filter (where h.status = 'walk_in') as walk_in,
           count(*) filter (where h.status = 'absent')  as absent
      from history h
      group by h.member_id
  ),
  credits as (
    select pl.member_id, sum(pl.points)::bigint as credits
      from points_ledger pl
      left join events e on e.id = pl.event_id
      where pl.org_id = p_org_id
        and pl.member_id in (select id from selected)
        and (p_from is null or coalesce(e.starts_at, pl.created_at) >= p_from)
        and (p_to   is null or coalesce(e.starts_at, pl.created_at) <= p_to)
      group by pl.member_id
  ),
  certs as (
    select c.member_id, count(*) as certificates_issued
      from certificates c
      join events e on e.id = c.event_id
      where c.org_id = p_org_id and c.revoked_at is null
        and c.member_id in (select id from selected)
        and (p_from is null or e.starts_at >= p_from)
        and (p_to   is null or e.starts_at <= p_to)
      group by c.member_id
  )
  select s.id, s.student_number, s.full_name, s.course, s.status,
         coalesce(cr.credits, 0),
         coalesce(ct.present, 0), coalesce(ct.late, 0),
         coalesce(ct.walk_in, 0), coalesce(ct.absent, 0),
         coalesce(st.current_tappies, 0), coalesce(st.longest_tappies, 0),
         coalesce(ce.certificates_issued, 0),
         count(*) over ()
    from selected s
    left join credits cr on cr.member_id = s.id
    left join counts  ct on ct.member_id = s.id
    left join streaks st on st.member_id = s.id
    left join certs   ce on ce.member_id = s.id
    order by s.full_name, s.id
    limit p_limit offset p_offset
$$;

revoke all on function public.generate_certificate_code() from public, anon, authenticated;
revoke all on function public.issue_certificates(uuid, uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.revoke_certificate(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.report_attendance(
  uuid, uuid, text[], timestamptz, timestamptz, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.report_member_summary(
  uuid, uuid, member_status, text, text, timestamptz, timestamptz, integer, integer
) from public, anon, authenticated;
