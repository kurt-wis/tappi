import { z } from "zod";
import { handler, ok, readJson, ApiError } from "@/lib/http";
import { requireAuth, requireRole } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const subscriptionSchema = z.object({
  member_id: z.string().uuid(),
  endpoint: z.string().url().max(4000),
  keys: z.object({ p256dh: z.string().min(1).max(1000), auth: z.string().min(1).max(1000) }).strict(),
}).strict();

const removeSchema = z.object({ endpoint: z.string().url().max(4000) }).strict();

export const POST = handler(async (request: Request) => {
  const ctx = await requireAuth();
  requireRole(ctx, ["officer"]);
  const input = subscriptionSchema.parse(await readJson(request));
  const admin = supabaseAdmin();
  const { data: member, error: memberError } = await admin.from("members").select("id")
    .eq("id", input.member_id).eq("org_id", ctx.orgId).maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw ApiError.notFound("Member not found");
  const { error } = await admin.from("push_subscriptions").upsert({
    org_id: ctx.orgId, member_id: input.member_id, endpoint: input.endpoint,
    p256dh: input.keys.p256dh, auth: input.keys.auth,
  }, { onConflict: "endpoint" });
  if (error) throw error;
  return ok({ subscribed: true }, { status: 201 });
});

export const DELETE = handler(async (request: Request) => {
  const ctx = await requireAuth();
  const { endpoint } = removeSchema.parse(await readJson(request));
  const { error } = await supabaseAdmin().from("push_subscriptions").delete()
    .eq("org_id", ctx.orgId).eq("endpoint", endpoint);
  if (error) throw error;
  return ok({ subscribed: false });
});
