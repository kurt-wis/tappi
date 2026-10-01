import { z } from "zod";
import { handler, ok, readJson, ApiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const endpoint = z.string().url().max(4000).refine((value) => {
  const url = new URL(value);
  const hosts = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
  return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
    (hosts.includes(url.hostname) || url.hostname.endsWith(".notify.windows.com"));
}, "Unsupported push service");
const schema = z.object({
  member_id: z.string().uuid(), endpoint,
  keys: z.object({ p256dh: z.string().min(1).max(1000), auth: z.string().min(1).max(1000) }).strict(),
}).strict();

async function currentUser() {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw ApiError.unauthorized();
  return data.user.id;
}

export const POST = handler(async (request: Request) => {
  const userId = await currentUser();
  const input = schema.parse(await readJson(request));
  const { error } = await supabaseAdmin().rpc("subscribe_push", {
    p_user_id: userId, p_member_id: input.member_id, p_endpoint: input.endpoint,
    p_p256dh: input.keys.p256dh, p_auth: input.keys.auth,
  });
  if (error?.code === "42501") throw ApiError.forbidden();
  if (error?.code === "TP003") throw ApiError.notFound("Member not found");
  if (error) throw error;
  return ok({ subscribed: true }, { status: 201 });
});

export const DELETE = handler(async (request: Request) => {
  const userId = await currentUser();
  const input = z.object({ endpoint }).strict().parse(await readJson(request));
  const { error } = await supabaseAdmin().from("push_subscriptions").delete()
    .eq("owner_user_id", userId).eq("endpoint", input.endpoint);
  if (error) throw error;
  return ok({ subscribed: false });
});
