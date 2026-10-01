import { handler, ok, ApiError } from "@/lib/http";
import { requireAuth, requireRole } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const POST = handler(
  async (_req: Request, { params }: { params: { id: string } }) => {
    const ctx = await requireAuth();
    requireRole(ctx, ["org_admin", "officer"]);

    // Ensure the member belongs to the caller's org before resolving.
    const { data: member } = await ctx.supabase
      .from("members")
      .select("id, org_id")
      .eq("id", params.id)
      .maybeSingle();
    if (!member) throw ApiError.notFound("Member not found");
    if (member.org_id !== ctx.orgId) throw ApiError.forbidden();

    const admin = supabaseAdmin();
    const { error } = await admin.rpc("resolve_lost_card", {
      p_member_id: params.id,
      p_officer_id: ctx.userId,
    });
    if (error) {
      console.error("[resolve-lost] RPC error", error);
      throw new ApiError("internal_error", "Could not resolve lost card", 500);
    }

    return ok({ resolved: true });
  },
);