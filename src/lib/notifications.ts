import { Resend } from "resend";
import webpush from "web-push";
import { ApiError } from "@/lib/http";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireRole, type AuthContext } from "@/lib/supabase/server";

type AttendanceNotice = {
  member_id: string;
  status: "late" | "absent";
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
    .select("member_id,status,members(email,full_name)").eq("event_id", eventId).in("status", ["late", "absent"]);
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
  const { error: insertError } = await admin.from("notifications").upsert(notices, {
    onConflict: "event_id,member_id,type,channel", ignoreDuplicates: true,
  });
  if (insertError) throw insertError;
  return { queued: notices.length };
}

export async function deliverDueNotifications(now = new Date()) {
  const admin = supabaseAdmin();
  const reminderCutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const { data: upcoming, error: upcomingError } = await admin.from("events")
    .select("id,org_id,title,starts_at").eq("status", "published")
    .gt("starts_at", now.toISOString()).lte("starts_at", reminderCutoff);
  if (upcomingError) throw upcomingError;
  for (const event of upcoming ?? []) {
    const { data: registrations, error: registrationError } = await admin.from("registrations")
      .select("member_id,email,full_name").eq("event_id", event.id).eq("status", "approved");
    if (registrationError) throw registrationError;
    const reminders = (registrations ?? []).filter((row) => row.email && row.member_id).map((row) => ({
      org_id: event.org_id, event_id: event.id, member_id: row.member_id,
      type: "event_reminder", channel: "email", recipient: row.email,
      title: `Reminder: ${event.title}`,
      body: `${row.full_name}, ${event.title} starts at ${new Date(event.starts_at).toISOString()}.`,
    }));
    if (reminders.length > 0) {
      const { error: reminderError } = await admin.from("notifications").upsert(reminders, {
        onConflict: "event_id,member_id,type,channel", ignoreDuplicates: true,
      });
      if (reminderError) throw reminderError;
    }
  }
  const { data, error } = await admin.from("notifications").select("*")
    .is("sent_at", null).is("failed_at", null).lte("scheduled_for", now.toISOString())
    .order("scheduled_for").limit(100);
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
        const result = await resend.emails.send({ from: env.EMAIL_FROM, to: notice.recipient, subject: notice.title, text: notice.body ?? "" });
        if (result.error) throw result.error;
      } else {
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error("Push delivery is not configured");
        const { data: subscriptions, error: subscriptionError } = await admin.from("push_subscriptions")
          .select("endpoint,p256dh,auth").eq("member_id", notice.member_id);
        if (subscriptionError) throw subscriptionError;
        await Promise.all((subscriptions ?? []).map((subscription) => webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, JSON.stringify({ title: notice.title, body: notice.body, type: notice.type }))));
      }
      await admin.from("notifications").update({ sent_at: new Date().toISOString() }).eq("id", notice.id);
      sent++;
    } catch (deliveryError) {
      await admin.from("notifications").update({
        failed_at: new Date().toISOString(),
        failure: deliveryError instanceof Error ? deliveryError.message.slice(0, 1000) : "Delivery failed",
      }).eq("id", notice.id);
      failed++;
    }
  }
  return { processed: (data ?? []).length, sent, failed };
}
