alter table public.otp_codes add column attempts integer not null default 0;
alter table public.otp_codes add column verified_at timestamptz;
alter table public.otp_codes add column token_hash text unique;
alter table public.persons add column activation_approved_at timestamptz;

create or replace function public.current_person_id()
returns uuid language sql stable security definer set search_path=public as $$
  select person_id from logins where user_id=auth.uid()
$$;
revoke all on function public.current_person_id() from public,anon;
grant execute on function public.current_person_id() to authenticated,service_role;
create policy logins_self on public.logins for select to authenticated using(user_id=auth.uid());
create policy persons_self on public.persons for select to authenticated using(id=current_person_id());
create policy members_self on public.members for select to authenticated using(person_id=current_person_id());
create policy attendance_self on public.attendance for select to authenticated using(person_id=current_person_id());
create policy credits_self on public.points_ledger for select to authenticated using(person_id=current_person_id());
create policy certificates_self on public.certificates for select to authenticated using(person_id=current_person_id());
create policy org_people_self on public.org_people for select to authenticated using(person_id=current_person_id());
create policy cards_self on public.cards for select to authenticated using(person_id=current_person_id());
create policy organizations_student on public.organizations for select to authenticated
using(exists(select 1 from members m where m.org_id=organizations.id and m.person_id=current_person_id()));
create policy events_student on public.events for select to authenticated using(
  status<>'draft' and exists(select 1 from members m where m.org_id=events.org_id and m.person_id=current_person_id())
);

create or replace function public.issue_auth_otp(p_email citext,p_purpose text,p_person_id uuid,p_code_hash text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(lower(p_email::text)||':'||p_purpose,0));
  if exists(select 1 from otp_codes where email=p_email and purpose=p_purpose and created_at>now()-interval '1 minute') then return null; end if;
  update otp_codes set consumed_at=now() where email=p_email and purpose=p_purpose and consumed_at is null;
  insert into otp_codes(email,purpose,person_id,code_hash,expires_at)
  values(p_email,p_purpose,p_person_id,p_code_hash,now()+interval '10 minutes') returning id into v_id;
  return v_id;
end $$;

create or replace function public.verify_auth_otp(p_email citext,p_code_hash text,p_purpose text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_otp otp_codes;
begin
  select * into v_otp from otp_codes where email=p_email and purpose=p_purpose and consumed_at is null
    order by created_at desc limit 1 for update;
  if not found or v_otp.expires_at<=now() or v_otp.attempts>=5 or v_otp.verified_at is not null then return '{"verified":false}'; end if;
  update otp_codes set attempts=attempts+1 where id=v_otp.id;
  if v_otp.code_hash<>p_code_hash then return '{"verified":false}'; end if;
  update otp_codes set verified_at=now(),token_hash=p_token_hash where id=v_otp.id;
  return jsonb_build_object('verified',true,'person_id',v_otp.person_id);
end $$;

create or replace function public.provision_student_login(
  p_user_id uuid,p_email citext,p_token_hash text,p_purpose text,p_full_name text,p_student_number text,p_school_email boolean
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_otp otp_codes; v_person persons; v_number text;
begin
  select * into v_otp from otp_codes where email=p_email and purpose=p_purpose and token_hash=p_token_hash
    and verified_at is not null and consumed_at is null and expires_at>now() for update;
  if not found then raise exception 'Invalid verification' using errcode='TP060'; end if;
  if p_purpose='signup' then
    v_number:=normalize_student_number(p_student_number);
    if v_number is null or nullif(btrim(p_full_name),'') is null then raise exception 'Missing student details' using errcode='22023'; end if;
    if exists(select 1 from persons where student_number_normalized=v_number) then
      raise exception 'Student exists; activate the existing record' using errcode='TP060';
    end if;
    insert into persons(student_number,student_number_normalized,full_name,email,email_verified,person_type)
    values(v_number,v_number,p_full_name,p_email,true,'verified') returning * into v_person;
  elsif p_purpose='activation' then
    select * into v_person from persons where id=v_otp.person_id and email=p_email and merged_into is null for update;
    if not found then raise exception 'Person not found' using errcode='TP060'; end if;
    if p_student_number is not null and normalize_student_number(p_student_number) is distinct from v_person.student_number_normalized then
      raise exception 'Student number mismatch' using errcode='TP060';
    end if;
    if not v_person.email_verified and v_person.activation_approved_at is null and not coalesce(p_school_email,false) then
      raise exception 'Officer approval required' using errcode='TP061';
    end if;
    update persons set email_verified=true,person_type='verified' where id=v_person.id;
  else
    raise exception 'Invalid verification purpose' using errcode='TP060';
  end if;
  insert into logins(user_id,person_id) values(p_user_id,v_person.id);
  update members set user_id=p_user_id where person_id=v_person.id;
  update otp_codes set consumed_at=now(),token_hash=null where id=v_otp.id;
  return v_person.id;
end $$;

create or replace function public.approve_student_activation(p_org_id uuid,p_member_id uuid,p_officer_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_person uuid;
begin
  select person_id into v_person from members where id=p_member_id and org_id=p_org_id;
  if not found then raise exception 'Member not found' using errcode='TP003'; end if;
  update persons set activation_approved_at=now() where id=v_person;
  insert into audit_logs(org_id,actor_id,action,entity,entity_id)
  values(p_org_id,p_officer_id,'APPROVE_STUDENT_ACTIVATION','persons',v_person::text);
end $$;

create or replace function public.report_lost_card(p_person_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare r record;
begin
  perform 1 from persons where id=p_person_id for update;
  if not found then raise exception 'Person not found' using errcode='TP003'; end if;
  for r in select m.id,m.org_id,c.uid from members m join cards c on c.person_id=m.person_id and c.active
    where m.person_id=p_person_id loop
    insert into card_link_audit(org_id,member_id,old_uid,new_uid,action,reason)
    values(r.org_id,r.id,r.uid,null,'unlink','Student reported lost card');
  end loop;
  update cards set active=false,revoked_at=now() where person_id=p_person_id and active;
  update members set card_uid=null,card_linked_at=null,card_linked_by=null,lost_card_flag=true where person_id=p_person_id;
  insert into audit_logs(org_id,action,entity,entity_id,metadata)
    select distinct org_id,'REPORT_LOST_CARD','persons',p_person_id::text,jsonb_build_object('person_id',p_person_id)
    from members where person_id=p_person_id;
end $$;

create or replace function public.resolve_lost_card(p_member_id uuid,p_officer_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_member members;
begin
  select * into v_member from members where id=p_member_id for update;
  if not found then raise exception 'Member not found' using errcode='TP003'; end if;
  if not exists(select 1 from cards where person_id=v_member.person_id and active) then
    raise exception 'Link a replacement card before resolving' using errcode='TP002';
  end if;
  update members set lost_card_flag=false where id=p_member_id;
  insert into audit_logs(org_id,actor_id,action,entity,entity_id)
  values(v_member.org_id,p_officer_id,'RESOLVE_LOST_CARD','members',p_member_id::text);
end $$;

create or replace function public.student_dashboard(p_user_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('user_id',p_user_id,'person_id',l.person_id,'orgs',
    coalesce((select jsonb_agg(jsonb_build_object(
      'org_id',m.org_id,'org_name',o.name,'org_slug',o.slug,'member_id',m.id,
      'student_number',m.student_number,'full_name',m.full_name,'email',m.email,'lost_card_flag',m.lost_card_flag,
      'tappies',s.current_tappies,'credits',s.credits,
      'attendance_summary',jsonb_build_object('present',s.present,'late',s.late,'walk_in',s.walk_in,'absent',s.absent,'attended',s.present+s.late+s.walk_in),
      'attendance_history',coalesce((select jsonb_agg(jsonb_build_object(
        'event_id',a.event_id,'event_title',e.title,'event_starts_at',e.starts_at,'status',a.status,
        'registration_type',a.registration_type,'timing',a.timing,'time_in',a.time_in,'time_out',a.time_out,
        'certificate_eligible',e.status='completed' and e.certificate_enabled and a.status in ('present','late','walk_in')
      ) order by e.starts_at desc) from attendance a join events e on e.id=a.event_id where a.member_id=m.id),'[]'),
      'certificates',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'event_id',c.event_id,
        'event_title',e.title,'code',c.code,'issued_at',c.issued_at))
        from certificates c join events e on e.id=c.event_id where c.member_id=m.id and c.revoked_at is null),'[]')
    ) order by o.name) from members m join organizations o on o.id=m.org_id
      cross join lateral report_member_summary(m.org_id,m.id) s where m.person_id=l.person_id),'[]'))
  from logins l where l.user_id=p_user_id
$$;

revoke all on function public.issue_auth_otp(citext,text,uuid,text) from public,anon,authenticated;
revoke all on function public.verify_auth_otp(citext,text,text,text) from public,anon,authenticated;
revoke all on function public.provision_student_login(uuid,citext,text,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.approve_student_activation(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.report_lost_card(uuid) from public,anon,authenticated;
revoke all on function public.resolve_lost_card(uuid,uuid) from public,anon,authenticated;
revoke all on function public.student_dashboard(uuid) from public,anon,authenticated;
grant execute on function public.issue_auth_otp(citext,text,uuid,text),public.verify_auth_otp(citext,text,text,text),
public.provision_student_login(uuid,citext,text,text,text,text,boolean),public.approve_student_activation(uuid,uuid,uuid),
public.report_lost_card(uuid),public.resolve_lost_card(uuid,uuid),public.student_dashboard(uuid) to service_role;
revoke all on function public.register_for_event(uuid,text,text,citext,jsonb,boolean) from anon;
drop function if exists public.replace_member_card(uuid,uuid,text,uuid);

create or replace function public.start_registration_lookup(
  p_event_id uuid,p_person_id uuid,p_number text,p_masked_name text,p_masked_email text,p_code_hash text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_person_id::text,0));
  select org_id into v_org from events where id=p_event_id and status='published';
  if not found then raise exception 'Event not open' using errcode='TP051'; end if;
  if exists(select 1 from registration_lookup_sessions where person_id=p_person_id and created_at>now()-interval '1 minute') then return null; end if;
  insert into registration_lookup_sessions(event_id,org_id,person_id,student_number_normalized,
    masked_first_name,masked_email,otp_code_hash,otp_expires_at)
  values(p_event_id,v_org,p_person_id,p_number,p_masked_name,p_masked_email,p_code_hash,now()+interval '10 minutes')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.verify_registration_lookup(p_session_id uuid,p_code_hash text,p_token_hash text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_session registration_lookup_sessions;
begin
  select * into v_session from registration_lookup_sessions where id=p_session_id for update;
  if not found or v_session.verified or v_session.otp_attempts>=3 or v_session.expires_at<=now() or v_session.otp_expires_at<=now() then return false; end if;
  update registration_lookup_sessions set otp_attempts=otp_attempts+1 where id=p_session_id;
  if v_session.otp_code_hash<>p_code_hash then return false; end if;
  update registration_lookup_sessions set verified=true,autofill_token_hash=p_token_hash,
    autofill_token_expires_at=least(expires_at,now()+interval '15 minutes') where id=p_session_id;
  return true;
end $$;
revoke all on function public.start_registration_lookup(uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.verify_registration_lookup(uuid,text,text) from public,anon,authenticated;
grant execute on function public.start_registration_lookup(uuid,uuid,text,text,text,text),
public.verify_registration_lookup(uuid,text,text) to service_role;

create unique index if not exists attendance_event_person_uq on attendance(event_id,person_id);
create table public.scan_receipts(
  event_id uuid not null references events(id) on delete cascade,
  client_scan_id text not null,
  attendance_id uuid not null references attendance(id) on delete cascade,
  primary key(event_id,client_scan_id)
);
alter table public.scan_receipts enable row level security;

create or replace function public.sync_person_card()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  update members set card_uid=c.uid,card_linked_at=c.linked_at,
    lost_card_flag=case when c.uid is not null then false else lost_card_flag end
  from (select new.person_id person_id,
    (select uid from cards where person_id=new.person_id and active) uid,
    (select linked_at from cards where person_id=new.person_id and active) linked_at) c
  where members.person_id=c.person_id;
  return new;
end $$;
create trigger cards_sync_members after insert or update of active on cards
for each row execute function sync_person_card();

create or replace function public.attach_member_account_card()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  select user_id into new.user_id from logins where person_id=new.person_id;
  select uid,linked_at into new.card_uid,new.card_linked_at from cards where person_id=new.person_id and active;
  return new;
end $$;
create trigger zz_members_attach_identity before insert on members
for each row execute function attach_member_account_card();

create or replace function public.link_member_card(
  p_org_id uuid, p_member_id uuid, p_card_uid text, p_officer_id uuid
) returns public.members language plpgsql security definer set search_path=public as $$
declare v_member public.members;
begin
  select * into v_member from members where id=p_member_id and org_id=p_org_id for update;
  if not found then raise exception 'Member not found' using errcode='TP003'; end if;
  if v_member.card_uid is not null and v_member.card_uid<>p_card_uid then raise exception 'Member already has a linked card' using errcode='TP001'; end if;
  if exists(select 1 from cards where uid=p_card_uid and (person_id<>v_member.person_id or not active)) then
    raise exception 'Card UID is already assigned or revoked' using errcode='23505';
  end if;
  insert into cards(uid,person_id) values(p_card_uid,v_member.person_id) on conflict(uid) do nothing;
  update members set card_uid=p_card_uid,card_linked_at=now(),card_linked_by=p_officer_id
    where id=p_member_id returning * into v_member;
  insert into card_link_audit(org_id,member_id,old_uid,new_uid,action,officer_id)
    values(p_org_id,p_member_id,null,p_card_uid,'link',p_officer_id);
  return v_member;
end $$;
create or replace function public.replace_member_card(
  p_org_id uuid, p_member_id uuid, p_new_card_uid text, p_officer_id uuid, p_reason text default null
) returns public.members language plpgsql security definer set search_path = public as $$
declare v_member public.members; v_old_uid text;
begin
  select * into v_member from public.members where id = p_member_id and org_id = p_org_id for update;
  if not found then raise exception 'Member not found' using errcode = 'TP003'; end if;
  if v_member.card_uid is null and not v_member.lost_card_flag then raise exception 'Member has no linked card' using errcode = 'TP002'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'Replacement reason is required' using errcode = '22023'; end if;
  select uid into v_old_uid from cards where person_id=v_member.person_id order by active desc,linked_at desc limit 1;
  update public.cards set active = false, revoked_at = now() where person_id = v_member.person_id and active;
  insert into public.cards(uid, person_id) values (p_new_card_uid, v_member.person_id);
  update public.members set card_uid = p_new_card_uid, card_linked_at = now(), card_linked_by = p_officer_id,
    lost_card_flag = false where id = p_member_id returning * into v_member;
  update public.org_people set lost_card_flag = false where org_id = p_org_id and person_id = v_member.person_id;
  insert into public.card_link_audit(org_id, member_id, old_uid, new_uid, action, officer_id, reason)
    values (p_org_id, p_member_id, v_old_uid, p_new_card_uid, 'relink', p_officer_id, p_reason);
  return v_member;
end $$;
create or replace function public.record_scan(
  p_org_id uuid, p_event_id uuid, p_card_uid text, p_scanned_at timestamptz default now(),
  p_officer_id uuid default null, p_device_id text default null,
  p_client_scan_id text default null, p_method scan_method default 'tap'
) returns attendance language plpgsql security definer set search_path = public as $$
declare v_member members; v_event events; v_existing attendance; v_on_list boolean;
        v_status attendance_status; v_reg_type text; v_timing text; v_row attendance;
begin
  select * into v_event from events where id=p_event_id and org_id=p_org_id for update;
  if not found then raise exception 'Event not found' using errcode='TP021'; end if;
  if v_event.status<>'published' then raise exception 'Event is not published' using errcode='TP022'; end if;
  if p_client_scan_id is not null then
    select a.* into v_existing from attendance a join scan_receipts r on r.attendance_id=a.id
      where r.event_id=p_event_id and r.client_scan_id=p_client_scan_id;
    if found then return v_existing; end if;
  end if;
  select m.* into v_member from members m join cards c on c.person_id = m.person_id
    where m.org_id = p_org_id and c.uid = p_card_uid and c.active for share;
  if not found then
    if exists(select 1 from cards c join members m on m.person_id=c.person_id
      where m.org_id=p_org_id and c.uid=p_card_uid and not c.active) then
      raise exception 'Card has been revoked' using errcode='TP026';
    end if;
    raise exception 'Card is not linked to any active member' using errcode = 'TP020';
  end if;
  if v_member.status <> 'active' then raise exception 'Member is not active' using errcode = 'TP025'; end if;
  select * into v_event from events where id = p_event_id and org_id = p_org_id for share;
  if not found then raise exception 'Event not found' using errcode = 'TP021'; end if;
  if v_event.status <> 'published' then raise exception 'Event is not published' using errcode = 'TP022'; end if;
  if p_client_scan_id is not null then
    select * into v_existing from attendance where event_id = p_event_id and client_scan_id = p_client_scan_id;
    if found then return v_existing; end if;
  end if;
  select * into v_existing from attendance where event_id = p_event_id and person_id = v_member.person_id for update;
  if found then
    update events set reconciled_at=null,reconciled_by=null where id=p_event_id;
    if p_client_scan_id is not null then insert into scan_receipts(event_id,client_scan_id,attendance_id)
      values(p_event_id,p_client_scan_id,v_existing.id); end if;
    if p_scanned_at >= v_existing.time_in + make_interval(secs => greatest(v_event.timeout_gap_minutes*60,v_event.duplicate_window_seconds)) then
      update attendance set time_out = least(coalesce(time_out, p_scanned_at), p_scanned_at), updated_at = now()
      where id = v_existing.id returning * into v_existing;
    end if;
    return v_existing;
  end if;
  select exists(select 1 from event_master_list where event_id = p_event_id and member_id = v_member.id) into v_on_list;
  v_timing := case when p_scanned_at <= v_event.starts_at + make_interval(mins => v_event.grace_period_minutes)
                   then 'on_time' else 'late' end;
  if v_on_list then v_reg_type := 'pre_registered'; v_status := case when v_timing='late' then 'late'::attendance_status else 'present'::attendance_status end;
  elsif v_event.walk_in_policy = 'open' then v_reg_type := 'walk_in'; v_status := 'walk_in';
  elsif v_event.walk_in_policy = 'closed' then raise exception 'Walk-ins are not allowed' using errcode='TP023';
  else raise exception 'Walk-ins require approval' using errcode='TP024'; end if;
  insert into attendance(event_id, org_id, member_id, person_id, status, registration_type, timing,
    time_in, raw_timestamp, method, scan_uid, device_id, scanned_by, client_scan_id)
  values(p_event_id,p_org_id,v_member.id,v_member.person_id,v_status,v_reg_type,v_timing,
    p_scanned_at,p_scanned_at,p_method,p_card_uid,p_device_id,p_officer_id,p_client_scan_id)
  returning * into v_row;
  if p_client_scan_id is not null then insert into scan_receipts(event_id,client_scan_id,attendance_id)
    values(p_event_id,p_client_scan_id,v_row.id); end if;
  update events set reconciled_at=null,reconciled_by=null where id=p_event_id;
  return v_row;
end $$;
create or replace function public.report_attendance(
  p_org_id uuid,p_event_id uuid default null,p_statuses text[] default null,
  p_from timestamptz default null,p_to timestamptz default null,p_search text default null,
  p_course text default null,p_committee text default null,p_limit integer default 50,p_offset integer default 0
) returns table(
  event_id uuid,event_title text,event_starts_at timestamptz,event_status event_status,
  member_id uuid,student_number text,full_name text,course text,status text,time_in timestamptz,
  time_out timestamptz,method text,certificate_eligible boolean,certificate_id uuid,
  certificate_code text,certificate_revoked_at timestamptz,total_count bigint
) language sql stable security definer set search_path=public as $$
  with rows as (
    select e.id event_id,e.title event_title,e.starts_at event_starts_at,e.status event_status,
      m.id member_id,m.student_number,m.full_name,m.course,a.status::text status,a.time_in,a.time_out,
      a.method::text method,(e.status='completed' and e.certificate_enabled and a.status in ('present','late','walk_in')) certificate_eligible,
      c.id certificate_id,c.code certificate_code,c.revoked_at certificate_revoked_at,m.committee
    from attendance a join events e on e.id=a.event_id join members m on m.id=a.member_id
    left join certificates c on c.event_id=e.id and c.member_id=m.id
    where e.org_id=p_org_id and e.status<>'draft'
    union all
    select e.id,e.title,e.starts_at,e.status,m.id,m.student_number,m.full_name,m.course,'not_scanned',
      null::timestamptz,null::timestamptz,null::text,false,null::uuid,null::text,null::timestamptz,m.committee
    from event_master_list eml join events e on e.id=eml.event_id join members m on m.id=eml.member_id
    where e.org_id=p_org_id and e.status='published'
      and not exists(select 1 from attendance a where a.event_id=e.id and a.person_id=m.person_id)
  ), filtered as (
    select * from rows r where (p_event_id is null or r.event_id=p_event_id)
      and (p_statuses is null or r.status=any(p_statuses))
      and (p_from is null or r.event_starts_at>=p_from) and (p_to is null or r.event_starts_at<=p_to)
      and (p_search is null or r.full_name ilike '%'||p_search||'%' or r.student_number ilike '%'||p_search||'%')
      and (p_course is null or r.course ilike p_course) and (p_committee is null or r.committee ilike p_committee)
  )
  select f.event_id,f.event_title,f.event_starts_at,f.event_status,f.member_id,f.student_number,
    f.full_name,f.course,f.status,f.time_in,f.time_out,f.method,f.certificate_eligible,
    f.certificate_id,f.certificate_code,f.certificate_revoked_at,count(*) over()
  from filtered f order by f.event_starts_at desc,f.event_id,f.full_name,f.member_id limit p_limit offset p_offset
$$;
create or replace function public.review_registration(
  p_org_id uuid,p_registration_id uuid,p_action text,p_officer_id uuid
) returns registrations language plpgsql security definer set search_path=public as $$
declare v_reg registrations; v_person persons; v_member members;
begin
  select * into v_reg from registrations where id=p_registration_id and org_id=p_org_id for update;
  if not found then raise exception 'Registration not found' using errcode='TP053'; end if;
  perform 1 from events where id=v_reg.event_id and status='published' for update;
  if not found then raise exception 'Event is not open' using errcode='TP051'; end if;
  if v_reg.status<>'pending' then raise exception 'Already reviewed' using errcode='TP054'; end if;
  if p_action='deny' then update registrations set status='denied',reviewed_by=p_officer_id,reviewed_at=now() where id=p_registration_id returning * into v_reg; return v_reg; end if;
  if p_action<>'approve' then raise exception 'Invalid action' using errcode='22023'; end if;
  select * into v_person from persons where student_number_normalized=normalize_student_number(v_reg.student_number) for update;
  if not found then insert into persons(student_number,student_number_normalized,full_name,email)
    values(v_reg.student_number,normalize_student_number(v_reg.student_number),v_reg.full_name,v_reg.email) returning * into v_person; end if;
  select * into v_member from members where org_id=p_org_id and person_id=v_person.id;
  if not found then insert into members(org_id,person_id,student_number,full_name,email,member_role,status)
    values(p_org_id,v_person.id,v_person.student_number_normalized,v_reg.full_name,v_reg.email,'attendee','active') returning * into v_member; end if;
  insert into org_people(org_id,person_id,directory_role) values(p_org_id,v_person.id,'attendee') on conflict do nothing;
  insert into event_master_list(event_id,member_id,added_by) values(v_reg.event_id,v_member.id,p_officer_id) on conflict do nothing;
  update registrations set member_id=v_member.id,status='approved',reviewed_by=p_officer_id,reviewed_at=now()
  where id=p_registration_id returning * into v_reg;
  return v_reg;
end $$;
grant execute on function public.link_member_card(uuid,uuid,text,uuid),
public.replace_member_card(uuid,uuid,text,uuid,text),public.unlink_member_card(uuid,uuid,uuid),
public.record_scan(uuid,uuid,text,timestamptz,uuid,text,text,scan_method),
public.finalize_event(uuid,uuid,uuid,boolean),public.reconcile_event(uuid,uuid,uuid),
public.register_for_event(uuid,text,text,citext,jsonb,boolean),public.review_registration(uuid,uuid,text,uuid),
public.report_member_summary(uuid,uuid,member_status,text,text,timestamptz,timestamptz,integer,integer),
public.report_attendance(uuid,uuid,text[],timestamptz,timestamptz,text,text,text,integer,integer),
public.tappies_leaderboard(uuid,integer),
public.issue_certificates(uuid,uuid,uuid,uuid[]),public.revoke_certificate(uuid,uuid,uuid,text) to service_role;

drop function public.register_for_event(uuid,text,text,citext,jsonb,boolean);
create or replace function public.register_for_event(
  p_event_id uuid,p_full_name text,p_student_number text,p_email citext,p_answers jsonb,p_autofill_used boolean,p_autofill_token_hash text default null
) returns registrations language plpgsql security definer set search_path=public as $$
declare v_event events; v_row registrations; v_number text; v_session registration_lookup_sessions;
begin
  select * into v_event from events where id=p_event_id for update;
  if not found then raise exception 'Event not found' using errcode='TP050'; end if;
  if v_event.status<>'published' then raise exception 'Event is not open' using errcode='TP051'; end if;
  if v_event.slots is not null and (select count(*) from registrations where event_id=p_event_id and status in ('pending','approved'))>=v_event.slots
    then raise exception 'Event is full' using errcode='TP052'; end if;
  v_number:=normalize_student_number(p_student_number);
  if p_autofill_used or p_autofill_token_hash is not null then
    select * into v_session from registration_lookup_sessions
      where autofill_token_hash=p_autofill_token_hash and event_id=p_event_id and org_id=v_event.org_id
        and student_number_normalized=v_number and verified and autofill_token_expires_at>now() and expires_at>now()
      for update;
    if not found then raise exception 'Invalid autofill verification' using errcode='TP055'; end if;
  end if;
  insert into registrations(event_id,org_id,full_name,student_number,email,answers,autofill_used,source,status)
  values(p_event_id,v_event.org_id,p_full_name,v_number,p_email,coalesce(p_answers,'{}'),p_autofill_used,'public_form','pending')
  returning * into v_row;
  if v_session.id is not null then update registration_lookup_sessions set autofill_token_hash=null,autofill_token_expires_at=null where id=v_session.id; end if;
  return v_row;
end $$;
revoke all on function public.register_for_event(uuid,text,text,citext,jsonb,boolean,text) from public,anon,authenticated;
grant execute on function public.register_for_event(uuid,text,text,citext,jsonb,boolean,text) to service_role;

alter table notifications add column claimed_at timestamptz;
create or replace function public.enqueue_due_notifications(p_now timestamptz)
returns void language plpgsql security definer set search_path=public as $$
begin
  insert into notifications(org_id,event_id,member_id,type,title,body,channel,recipient)
  select e.org_id,e.id,m.id,'event_reminder','Reminder: '||e.title,
    m.full_name||', '||e.title||' starts at '||e.starts_at::text,c.channel,
    case when c.channel='email' then m.email::text else null end
  from events e join event_master_list eml on eml.event_id=e.id join members m on m.id=eml.member_id
    cross join (values('email'),('push')) c(channel)
  where e.status='published' and e.starts_at>p_now and e.starts_at<=p_now+interval '24 hours'
    and (c.channel='push' or m.email is not null)
  on conflict(event_id,member_id,type,channel) do nothing;
  insert into notifications(org_id,event_id,member_id,type,title,body,channel,recipient)
  select e.org_id,e.id,m.id,
    case when a.status='absent' then 'absentee_alert'::notification_type else 'late_alert'::notification_type end,
    case when a.status='absent' then 'Absence recorded: ' else 'Late arrival recorded: ' end||e.title,
    m.full_name||', your attendance record for '||e.title||' is '||a.status::text||'.',c.channel,
    case when c.channel='email' then m.email::text else null end
  from events e join attendance a on a.event_id=e.id join members m on m.id=a.member_id
    cross join (values('email'),('push')) c(channel)
  where e.status='completed' and e.reconciled_at is not null and (a.status='absent' or a.timing='late')
    and (c.channel='push' or m.email is not null)
  on conflict(event_id,member_id,type,channel) do nothing;
end $$;
create or replace function public.claim_due_notifications(p_now timestamptz)
returns setof notifications language sql security definer set search_path=public as $$
  with due as (
    select id from notifications where sent_at is null and failed_at is null and scheduled_for<=p_now
      and (claimed_at is null or claimed_at<p_now-interval '10 minutes')
    order by scheduled_for,id limit 100 for update skip locked
  )
  update notifications n set claimed_at=p_now from due where n.id=due.id returning n.*
$$;
revoke all on function public.enqueue_due_notifications(timestamptz),public.claim_due_notifications(timestamptz) from public,anon,authenticated;
grant execute on function public.enqueue_due_notifications(timestamptz),public.claim_due_notifications(timestamptz) to service_role;

create or replace function public.guard_master_list()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_event events; v_event_id uuid;
begin
  v_event_id:=case when tg_op='DELETE' then old.event_id else new.event_id end;
  select * into v_event from events where id=v_event_id for update;
  if not found and tg_op='DELETE' then return old; end if;
  if v_event.status not in ('draft','published') then raise exception 'Event master list locked' using errcode='TP011'; end if;
  if tg_op<>'DELETE' and not exists(select 1 from members where id=new.member_id and org_id=v_event.org_id) then
    raise exception 'Member belongs to another organization' using errcode='23514';
  end if;
  update events set reconciled_at=null,reconciled_by=null where id=v_event_id and reconciled_at is not null;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_master_list before insert or update or delete on event_master_list
for each row execute function guard_master_list();

alter table push_subscriptions add column owner_user_id uuid references auth.users(id) on delete cascade;
alter table push_subscriptions drop constraint push_subscriptions_endpoint_key;
alter table push_subscriptions add constraint push_subscriptions_endpoint_member_uq unique(endpoint,member_id);
drop policy push_subscriptions_org on push_subscriptions;
create policy push_subscriptions_read on push_subscriptions for select to authenticated
  using(org_id=current_org_id() or owner_user_id=auth.uid());
revoke insert,update,delete on push_subscriptions from anon,authenticated;
create or replace function public.subscribe_push(p_user_id uuid,p_member_id uuid,p_endpoint text,p_p256dh text,p_auth text)
returns void language plpgsql security definer set search_path=public as $$
declare v_member members;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_endpoint,0));
  select * into v_member from members where id=p_member_id;
  if not found then raise exception 'Member not found' using errcode='TP003'; end if;
  if not exists(select 1 from logins where user_id=p_user_id and person_id=v_member.person_id)
    and not exists(select 1 from profiles where id=p_user_id and org_id=v_member.org_id and is_active and role in ('org_admin','officer')) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if exists(select 1 from push_subscriptions where endpoint=p_endpoint and owner_user_id is distinct from p_user_id) then
    raise exception 'Endpoint already belongs to another account' using errcode='42501';
  end if;
  insert into push_subscriptions(org_id,member_id,endpoint,p256dh,auth,owner_user_id)
  values(v_member.org_id,p_member_id,p_endpoint,p_p256dh,p_auth,p_user_id)
  on conflict(endpoint,member_id) do update set p256dh=excluded.p256dh,auth=excluded.auth;
end $$;
revoke all on function public.subscribe_push(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.subscribe_push(uuid,uuid,text,text,text) to service_role;

drop policy events_write on events;
create policy events_insert on events for insert to authenticated
with check(org_id=current_org_id() and current_org_role() in ('org_admin','officer') and status='draft');
create policy events_update on events for update to authenticated
using(org_id=current_org_id() and current_org_role() in ('org_admin','officer') and status='draft')
with check(org_id=current_org_id() and current_org_role() in ('org_admin','officer') and status='draft');
create policy events_delete on events for delete to authenticated
using(org_id=current_org_id() and current_org_role() in ('org_admin','officer') and status='draft');
revoke insert,update,delete on attendance from public,anon,authenticated;
grant execute on function public.publish_event(uuid,uuid,uuid),public.cancel_event(uuid,uuid,uuid) to service_role;

alter table events add constraint events_id_org_uq unique(id,org_id);
alter table members add constraint members_id_org_person_uq unique(id,org_id,person_id);
alter table attendance add constraint attendance_event_org_fk foreign key(event_id,org_id) references events(id,org_id);
alter table attendance add constraint attendance_member_person_org_fk foreign key(member_id,org_id,person_id) references members(id,org_id,person_id);
alter table points_ledger add constraint points_member_person_org_fk foreign key(member_id,org_id,person_id) references members(id,org_id,person_id);
alter table certificates add constraint certificates_event_org_fk foreign key(event_id,org_id) references events(id,org_id);
alter table certificates add constraint certificates_member_person_org_fk foreign key(member_id,org_id,person_id) references members(id,org_id,person_id);
