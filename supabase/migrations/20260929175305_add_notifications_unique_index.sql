-- =============================================================
-- Tappi — fix: unique index on notifications
-- =============================================================
-- The compliance migration added event_id, channel, recipient,
-- scheduled_for, sent_at, failed_at, failure_reason to notifications
-- but did not add the composite unique index that queueAttendance
-- Notifications() and deliverDueNotifications() rely on for upsert
-- idempotency. Without it, upsert fails with SQLSTATE 42P10.
--
-- Applied to staging and production on 2026-09-30.

create unique index if not exists uq_notifications_event_member_type_channel
  on public.notifications (event_id, member_id, type, channel);