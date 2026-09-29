import { z } from "zod";
import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { memberId as memberIdSchema } from "@/lib/members";
import { getMemberSummary } from "@/lib/reports";
import type { CreditEntry } from "@/types/domain";

export const creditColumns = "id,member_id,event_id,points,reason,awarded_by,created_at";

export const creditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  per_page: z.coerce.number().int().min(1).max(1_000_000).default(50).transform((n) => Math.min(n, 200)),
}).strict();

/** Manual adjustment. Negative points deduct. "event_attendance" is reserved for finalize_event. */
export const adjustCreditsSchema = z.object({
  points: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, "points must be non-zero"),
  reason: z.string().trim().min(1).max(200)
    .refine((r) => r !== "event_attendance", "reason \"event_attendance\" is reserved for event finalization"),
}).strict();

async function assertMemberInOrg(ctx: AuthContext, id: string): Promise<{ person_id: string }> {
  const { data, error } = await ctx.supabase.from("members").select("id,person_id")
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Member not found");
  return { person_id: data.person_id as string };
}

/** Balance is summed over the whole ledger, not just the returned page. */
export async function getMemberCredits(ctx: AuthContext, id: string, input: unknown) {
  memberIdSchema.parse(id);
  const { page, per_page } = creditQuerySchema.parse(input);

  // Also the org-scoped existence check (404s for another org's member).
  // Summed in SQL: a client-side sum over PostgREST rows would silently stop at its row cap.
  const { credits: balance } = await getMemberSummary(ctx, id);

  const { data, error, count } = await ctx.supabase.from("points_ledger")
    .select(creditColumns, { count: "exact" })
    .eq("org_id", ctx.orgId).eq("member_id", id)
    .order("created_at", { ascending: false }).order("id")
    .range((page - 1) * per_page, page * per_page - 1);
  if (error) throw error;

  return {
    balance,
    entries: (data ?? []) as unknown as CreditEntry[],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  };
}

/**
 * Writes go through the service-role client: authenticated users have no
 * INSERT grant on points_ledger (Part 7 migration), so the officer check
 * here is the only path that can mint or deduct credits.
 */
export async function adjustCredits(ctx: AuthContext, id: string, input: unknown): Promise<CreditEntry> {
  requireRole(ctx, ["officer"]);
  memberIdSchema.parse(id);
  const { points, reason } = adjustCreditsSchema.parse(input);
  const { person_id } = await assertMemberInOrg(ctx, id);

  const { data, error } = await supabaseAdmin().from("points_ledger")
    .insert({ org_id: ctx.orgId, member_id: id, person_id, event_id: null, points, reason, awarded_by: ctx.userId })
    .select(creditColumns).single();
  if (error) throw error;
  return data as unknown as CreditEntry;
}
