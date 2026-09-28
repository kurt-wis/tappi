import { ApiError } from "@/lib/http";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

type PgError = { code?: string; message: string };

export type FinalizeSummary = {
  already_finalized: boolean;
  absent_marked: number;
  points_awarded: number;
  total_attendees: number;
};

function throwForFinalizeRpcError(error: PgError): never {
  switch (error.code) {
    case "TP030":
      throw ApiError.notFound("Event not found");
    case "TP031":
      throw ApiError.conflict("Only a published event can be finalized");
    case "TP032":
      throw ApiError.conflict("Event has not ended yet");
    default:
      throw error;
  }
}

export async function finalizeEvent(
  ctx: AuthContext,
  eventId: string,
  options: { force?: boolean } = {},
): Promise<FinalizeSummary> {
  requireRole(ctx, ["officer"]);

  const { data, error } = await supabaseAdmin().rpc("finalize_event", {
    p_org_id: ctx.orgId,
    p_event_id: eventId,
    p_officer_id: ctx.userId,
    p_force: options.force ?? false,
  });
  if (error) throwForFinalizeRpcError(error);
  if (!data) throw new Error("finalize_event returned no data");
  return data as FinalizeSummary;
}   