import { z } from "zod";
import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { normalizeStudentNumber } from "@/lib/registration-form";

export const memberColumns = "id,org_id,full_name,student_number,email,course,member_role,card_uid,card_linked_at,status,created_at";
const text = z.string().trim().min(1).max(200);
const optionalEmail = z.string().trim().email().max(254).nullable().optional();
const optionalCourse = text.nullable().optional();
export const memberStatus = z.enum(["active", "inactive", "archived"]);
export const memberId = z.string().uuid();
export const createMemberSchema = z.object({
  student_number: z.string().trim().min(1).max(100).nullable()
    .transform((value) => value === null ? null : normalizeStudentNumber(value)),
  full_name: text,
  email: optionalEmail,
  course: optionalCourse,
  member_role: text.max(100),
}).strict();
export const updateMemberSchema = z.object({
  full_name: text.optional(),
  email: optionalEmail,
  course: optionalCourse,
  member_role: text.max(100).optional(),
  status: memberStatus.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");
export const memberQuerySchema = z.object({
  search: z.string().trim().max(200).default(""),
  status: memberStatus.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  per_page: z.coerce.number().int().min(1).max(1_000_000).default(50).transform((n) => Math.min(n, 200)),
}).strict();

/** Quote filter syntax; escape SQL wildcards. PostgREST's * wildcard is supported. */
export function memberSearchFilter(search: string): string {
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const quoted = `"${pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `full_name.ilike.${quoted},student_number.ilike.${quoted}`;
}

export async function listMembers(ctx: AuthContext, input: unknown) {
  const { page, per_page, search, status } = memberQuerySchema.parse(input);
  let query = ctx.supabase.from("members").select(memberColumns, { count: "exact" })
    .eq("org_id", ctx.orgId);
  if (search) query = query.or(memberSearchFilter(search));
  if (status) query = query.eq("status", status);
  const { data, error, count } = await query.order("full_name").order("id")
    .range((page - 1) * per_page, page * per_page - 1);
  if (error) throw error;
  return { members: data ?? [], pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) } };
}

export async function getMember(ctx: AuthContext, id: string) {
  memberId.parse(id);
  const { data, error } = await ctx.supabase.from("members").select(memberColumns)
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Member not found");
  return data;
}

export async function createMember(ctx: AuthContext, input: unknown) {
  requireRole(ctx, ["officer"]);
  const member = createMemberSchema.parse(input);
  const { data, error } = await ctx.supabase.from("members")
    .insert({ ...member, org_id: ctx.orgId }).select(memberColumns).single();
  if (error?.code === "23505") throw ApiError.conflict("Student number already exists in this organization");
  if (error) throw error;
  return data;
}

export async function updateMember(ctx: AuthContext, id: string, input: unknown) {
  requireRole(ctx, ["officer"]);
  memberId.parse(id);
  const changes = updateMemberSchema.parse(input);
  const { data, error } = await ctx.supabase.from("members").update(changes)
    .eq("org_id", ctx.orgId).eq("id", id).select(memberColumns).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Member not found");
  return data;
}

export async function archiveMember(ctx: AuthContext, id: string) {
  return updateMember(ctx, id, { status: "archived" });
}
