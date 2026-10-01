import { handler, ok, ApiError } from "@/lib/http";
import { requireAuth, requireRole } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { memberId } from "@/lib/members";

export const POST = handler(async (_request: Request, route: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth();
  requireRole(ctx, ["officer"]);
  const id = memberId.parse((await route.params).id);
  const { error } = await supabaseAdmin().rpc("approve_student_activation", {
    p_org_id: ctx.orgId, p_member_id: id, p_officer_id: ctx.userId,
  });
  if (error?.code === "TP003") throw ApiError.notFound("Member not found");
  if (error) throw error;
  return ok({ approved: true });
});
