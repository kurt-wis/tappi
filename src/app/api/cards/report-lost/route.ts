import { handler, ok, readJson, ApiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { z } from "zod";

const bodySchema = z.object({
  memberId: z.string().uuid(),
}).strict();

export const POST = handler(async (req: Request) => {
  const { memberId } = bodySchema.parse(await readJson(req));

  const supabase = await createClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) throw ApiError.unauthorized();

  // Ownership check: the caller must own this member row.
  const { data: member } = await supabase
    .from("members")
    .select("id, user_id")
    .eq("id", memberId)
    .maybeSingle();
  if (!member) throw ApiError.notFound("Member not found");
  if (member.user_id !== userData.user.id) throw ApiError.forbidden();

  // Service-role call: the RPC needs to bypass RLS to revoke the card +
  // insert into card_link_audit / audit_logs atomically.
  const admin = supabaseAdmin();
  const { error: rpcErr } = await admin.rpc("report_lost_card", { p_member_id: memberId });
  if (rpcErr) {
    console.error("[report-lost] RPC error", rpcErr);
    throw new ApiError("internal_error", "Could not report lost card", 500);
  }

  return ok({ reported: true });
});