import { Resend } from "resend";
import webpush from "web-push";
import { ApiError } from "@/lib/http";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireRole, type AuthContext } from "@/lib/supabase/server";

type AttendanceNotice = {
  member_id: string;
  status: "late" | "absent" | "walk_in";
  members: { email: string | null; full_name: string } | null;
};

export async function queueAttendanceNotifications(ctx: AuthContext, eventId: string) {
  requireRole(ctx, ["officer"]);
  const admin = supabaseAdmin();
  const { data: event, error: eventError } = await admin.from("events")
    .select("id,title,status,reconciled_at").eq("id", eventId).eq("org_id", ctx.orgId).maybeSingle();
  if (eventError) throw eventError;
  if (!event) throw ApiError.notFound("Event not found");
  if (event.status !== "completed" || !event.reconciled_at) {
    throw ApiError.conflict("Finalize reconciliation before queuing attendance alerts");
  }

  const { data, error } = await admin.from("attendance")
    .select("member_id,status,members(email,full_name)").eq("event_id", eventId).or("status.eq.late,status.eq.absent,timing.eq.late");
  if (error) throw error;
  const rows = (data ?? []) as unknown as AttendanceNotice[];
  const notices = rows.flatMap((row) => {
    const type = row.status === "absent" ? "absentee_alert" : "late_alert";
    const title = row.status === "absent" ? `Absence recorded: ${event.title}` : `Late arrival recorded: ${event.title}`;
    const body = `${row.members?.full_name ?? "Attendee"}, your attendance record for ${event.title} is ${row.status}.`;
    const base = { org_id: ctx.orgId, event_id: eventId, member_id: row.member_id, type, title, body };
    return [
      ...(row.members?.email ? [{ ...base, channel: "email", recipient: row.members.email }] : []),
      { ...base, channel: "push", recipient: null },
    ];
  });
  if (notices.length === 0) return { queued: 0 };
  const { count, error: insertError } = await admin.from("notifications").upsert(notices, {
    onConflict: "event_id,member_id,type,channel", ignoreDuplicates: true, count: "exact",
  });
  if (insertError) throw insertError;
  if (count === null) throw new Error("Notification insert returned no count");
  return { queued: count };
}

export async function deliverDueNotifications(now = new Date()) {
  const admin = supabaseAdmin();
  const { error: queueError } = await admin.rpc("enqueue_due_notifications", { p_now: now.toISOString() });
  if (queueError) throw queueError;
  const { data, error } = await admin.rpc("claim_due_notifications", { p_now: now.toISOString() });
  if (error) throw error;

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  }
  const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
  let sent = 0, failed = 0;
  for (const notice of data ?? []) {
    try {
      if (notice.channel === "email") {
        if (!resend || !env.EMAIL_FROM || !notice.recipient) throw new Error("Email delivery is not configured");
        const result = await resend.emails.send({ from: env.EMAIL_FROM, to: notice.recipient, subject: notice.title, text: notice.body ?? "" }, { idempotencyKey: `notification-${notice.id}` });
        if (result.error) throw result.error;
      } else {
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error("Push delivery is not configured");
        const { data: subscriptions, error: subscriptionError } = await admin.from("push_subscriptions")
          .select("endpoint,p256dh,auth").eq("member_id", notice.member_id);
        if (subscriptionError) throw subscriptionError;
        if (!subscriptions?.length) throw new Error("No push subscription for this member");
        await Promise.all((subscriptions ?? []).map((subscription: { endpoint: string; p256dh: string; auth: string }) => webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, JSON.stringify({ title: notice.title, body: notice.body, type: notice.type }))));
      }
      const { error: saveError } = await admin.from("notifications").update({ sent_at: new Date().toISOString(), claimed_at: null }).eq("id", notice.id);
      if (saveError) throw saveError;
      sent++;
    } catch (deliveryError) {
      const { error: saveError } = await admin.from("notifications").update({
        failed_at: new Date().toISOString(),
        claimed_at: null,
        failure: deliveryError instanceof Error ? deliveryError.message.slice(0, 1000) : "Delivery failed",
      }).eq("id", notice.id);
      if (saveError) throw saveError;
      failed++;
    }
  }
  return { processed: (data ?? []).length, sent, failed };
}
