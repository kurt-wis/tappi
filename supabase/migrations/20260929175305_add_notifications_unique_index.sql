alter table public.notifications add column if not exists event_id uuid references public.events(id) on delete cascade;
alter table public.notifications add column if not exists channel text not null default 'email' check (channel in ('email', 'push'));

create unique index if not exists uq_notifications_event_member_type_channel
  on public.notifications (event_id, member_id, type, channel);
