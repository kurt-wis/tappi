import { z } from "zod";
import { ApiError } from "@/lib/http";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const uuid = z.string().uuid();

export const approveSchema = z.object({
  action: z.enum(["approve", "deny"]),
}).strict();

export const registrationsQuerySchema = z.object({
  event_id: uuid.optional(),
  status: z.enum(["pending", "approved", "denied"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

type PgError = { code?: string; message: string };

type RegistrationRow = {
  id: string;
  event_id: string;
  org_id: string;
  member_id: string | null;
  full_name: string;
  student_number: string;
  email: string | null;
  status: "pending" | "approved" | "denied";
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  autofill_used: boolean;
  source: string;
};

export async function listRegistrations(ctx: AuthContext, input: unknown) {
  const { event_id, status, page, per_page } = registrationsQuerySchema.parse(input);

  let query = ctx.supabase
    .from("registrations")
    .select("*", { count: "exact" })
    .eq("org_id", ctx.orgId);

  if (event_id) query = query.eq("event_id", event_id);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range((page - 1) * per_page, page * per_page - 1)
    .returns<RegistrationRow[]>();

  if (error) throw error;

  return {
    registrations: data ?? [],
    pagination: {
      page,
      per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page),
    },
  };
}

export async function reviewRegistration(
  ctx: AuthContext,
  registrationId: string,
  input: unknown,
) {
  requireRole(ctx, ["officer"]);
  uuid.parse(registrationId);
  const { action } = approveSchema.parse(input);

  const { data, error } = await supabaseAdmin().rpc("review_registration", {
    p_org_id: ctx.orgId,
    p_registration_id: registrationId,
    p_action: action,
    p_officer_id: ctx.userId,
  });
  if (error?.code === "TP053") throw ApiError.notFound("Registration not found");
  if (error?.code === "TP054") throw ApiError.conflict("This registration has already been reviewed");
  if (error?.code === "TP051") throw ApiError.conflict("Event is not open for registration");
  if (error) throw error;
  return data as RegistrationRow;
}
