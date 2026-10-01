create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.current_org_role()
returns org_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or org_id = public.current_org_id());

drop policy members_all on public.members;
create policy members_select on public.members
  for select to authenticated
  using (org_id = public.current_org_id());
create policy members_insert on public.members
  for insert to authenticated
  with check (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'officer')
  );
create policy members_update on public.members
  for update to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'officer')
  )
  with check (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'officer')
  );

revoke insert, update, delete on public.members from public, anon, authenticated;
grant insert (org_id, student_number, full_name, email, course, member_role, status)
  on public.members to authenticated;
grant update (full_name, email, course, member_role, status)
  on public.members to authenticated;
