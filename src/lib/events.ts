import { z } from "zod";
import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { memberId as memberIdSchema } from "@/lib/members";
import type { Event, EventMasterListEntry } from "@/types/domain";

export const eventColumns =
  "id,org_id,title,description,venue,starts_at,ends_at,grace_period_minutes,slots,walk_in_policy,status,points_value,certificate_enabled,published_at,cancelled_at,created_by,created_at,updated_at";

const title = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().min(1).max(2000).nullable().optional();
/** Supabase/Postgres timestamptz columns round-trip as full ISO-8601 with an offset. */
const isoDateTime = z.string().datetime({ offset: true });

export const eventStatus = z.enum(["draft", "published", "cancelled", "completed"]);
export const walkInPolicy = z.enum(["open", "approval", "closed"]);
export const eventId = z.string().uuid();

export const createEventSchema = z.object({
  title,
  description: optionalText,
  venue: optionalText,
  starts_at: isoDateTime,
  ends_at: isoDateTime.nullable().optional(),
  grace_period_minutes: z.coerce.number().int().min(0).default(15),
  slots: z.coerce.number().int().min(0).nullable().optional(),
  walk_in_policy: walkInPolicy.default("closed"),
  points_value: z.coerce.number().int().min(0).default(0),
  certificate_enabled: z.boolean().default(false),
}).strict();

export const updateEventSchema = z.object({
  title: title.optional(),
  description: optionalText,
  venue: optionalText,
  starts_at: isoDateTime.optional(),
  ends_at: isoDateTime.nullable().optional(),
  grace_period_minutes: z.coerce.number().int().min(0).optional(),
  slots: z.coerce.number().int().min(0).nullable().optional(),
  walk_in_policy: walkInPolicy.optional(),
  points_value: z.coerce.number().int().min(0).optional(),
  certificate_enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

export const eventQuerySchema = z.object({
  status: eventStatus.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  per_page: z.coerce.number().int().min(1).max(1_000_000).default(50).transform((n) => Math.min(n, 200)),
}).strict();

export const addMasterListSchema = z.object({
  member_ids: z.array(z.string().uuid()).min(1).max(500),
}).strict();

/** Postgres error shape returned by supabase-js for both RPC calls and REST queries. */
type PgError = { code?: string; message: string };

/**
 * Custom SQLSTATEs raised by the publish_event/cancel_event RPCs (see the
 * 20260928130000_events_publish_cancel migration), plus the CHECK-constraint
 * violation Postgres raises naturally when ends_at <= starts_at.
 */
function throwForEventRpcError(error: PgError): never {
  switch (error.code) {
    case "TP010":
      throw ApiError.notFound("Event not found");
    case "TP011":
      throw ApiError.conflict("Event cannot transition from its current status");
    case "TP014":
      throw new ApiError("validation_error", "Cannot publish an event with an empty master list", 400);
    default:
      throw error;
  }
}

function throwOnEndsAtViolation(error: PgError): never {
  if (error.code === "23514") {
    throw new ApiError("validation_error", "ends_at must be after starts_at", 422);
  }
  throw error;
}

/** Scoped existence + status check shared by update/delete/duplicate/master-list mutations. */
async function fetchEventForMutation(ctx: AuthContext, id: string): Promise<Pick<Event, "id" | "status">> {
  const { data, error } = await ctx.supabase.from("events").select("id,status")
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Event not found");
  return data as Pick<Event, "id" | "status">;
}

export async function listEvents(ctx: AuthContext, input: unknown) {
  const { page, per_page, status, from, to } = eventQuerySchema.parse(input);
  let query = ctx.supabase.from("events").select(eventColumns, { count: "exact" })
    .eq("org_id", ctx.orgId);
  if (status) query = query.eq("status", status);
  if (from) query = query.gte("starts_at", from);
  if (to) query = query.lte("starts_at", to);
  const { data, error, count } = await query.order("starts_at", { ascending: false }).order("id")
    .range((page - 1) * per_page, page * per_page - 1);
  if (error) throw error;
  return { events: data ?? [], pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) } };
}

export async function getEvent(ctx: AuthContext, id: string) {
  eventId.parse(id);
  const { data, error } = await ctx.supabase.from("events").select(eventColumns)
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Event not found");

  const { count, error: countError } = await ctx.supabase.from("event_master_list")
    .select("member_id", { count: "exact", head: true }).eq("event_id", id);
  if (countError) throw countError;

  return { ...data, master_list_count: count ?? 0 };
}

export async function createEvent(ctx: AuthContext, input: unknown) {
  requireRole(ctx, ["officer"]);
  const event = createEventSchema.parse(input);
  const { data, error } = await ctx.supabase.from("events")
    .insert({ ...event, org_id: ctx.orgId, created_by: ctx.userId, status: "draft" })
    .select(eventColumns).single();
  if (error) throwOnEndsAtViolation(error);
  return data;
}

export async function updateEvent(ctx: AuthContext, id: string, input: unknown) {
  requireRole(ctx, ["officer"]);
  eventId.parse(id);
  const changes = updateEventSchema.parse(input);
  const existing = await fetchEventForMutation(ctx, id);
  if (existing.status !== "draft") throw ApiError.conflict("Only a draft event can be edited");

  const { data, error } = await ctx.supabase.from("events").update(changes)
    .eq("org_id", ctx.orgId).eq("id", id).select(eventColumns).maybeSingle();
  if (error) throwOnEndsAtViolation(error);
  if (!data) throw ApiError.notFound("Event not found");
  return data;
}

export async function deleteEvent(ctx: AuthContext, id: string) {
  requireRole(ctx, ["officer"]);
  eventId.parse(id);
  const existing = await fetchEventForMutation(ctx, id);
  if (existing.status !== "draft") throw ApiError.conflict("Only a draft event can be deleted");

  const { error } = await ctx.supabase.from("events").delete()
    .eq("org_id", ctx.orgId).eq("id", id);
  if (error) throw error;
  return { id };
}

/** Clones an event's fields and master list into a new draft event; published_at/cancelled_at are cleared. */
export async function duplicateEvent(ctx: AuthContext, id: string) {
  requireRole(ctx, ["officer"]);
  eventId.parse(id);

  const { data: original, error } = await ctx.supabase.from("events").select(eventColumns)
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!original) throw ApiError.notFound("Event not found");

  const { data: created, error: insertError } = await ctx.supabase.from("events").insert({
    org_id: ctx.orgId,
    title: original.title,
    description: original.description,
    venue: original.venue,
    starts_at: original.starts_at,
    ends_at: original.ends_at,
    grace_period_minutes: original.grace_period_minutes,
    slots: original.slots,
    walk_in_policy: original.walk_in_policy,
    points_value: original.points_value,
    certificate_enabled: original.certificate_enabled,
    status: "draft",
    created_by: ctx.userId,
  }).select(eventColumns).single();
  if (insertError) throw insertError;

  const { data: masterList, error: listError } = await ctx.supabase.from("event_master_list")
    .select("member_id,added_by").eq("event_id", id);
  if (listError) throw listError;

  if (masterList && masterList.length > 0) {
    const rows = masterList.map((row) => ({
      event_id: created.id, member_id: row.member_id, added_by: row.added_by,
    }));
    const { error: cloneListError } = await ctx.supabase.from("event_master_list").insert(rows);
    if (cloneListError) throw cloneListError;
  }

  return { ...created, master_list_count: masterList?.length ?? 0 };
}

export async function publishEvent(ctx: AuthContext, id: string): Promise<Event> {
  requireRole(ctx, ["officer"]);
  eventId.parse(id);

  const { data, error } = await supabaseAdmin().rpc("publish_event", {
    p_org_id: ctx.orgId, p_event_id: id, p_officer_id: ctx.userId,
  });
  if (error) throwForEventRpcError(error);
  if (!data) throw ApiError.notFound("Event not found");
  return data as Event;
}

export async function cancelEvent(ctx: AuthContext, id: string): Promise<Event> {
  requireRole(ctx, ["officer"]);
  eventId.parse(id);

  const { data, error } = await supabaseAdmin().rpc("cancel_event", {
    p_org_id: ctx.orgId, p_event_id: id, p_officer_id: ctx.userId,
  });
  if (error) throwForEventRpcError(error);
  if (!data) throw ApiError.notFound("Event not found");
  return data as Event;
}

/** Bulk add; members must belong to the caller's org; already-listed members are skipped, not errored. */
export async function addToMasterList(ctx: AuthContext, id: string, input: unknown) {
  requireRole(ctx, ["officer"]);
  eventId.parse(id);
  const { member_ids } = addMasterListSchema.parse(input);
  await fetchEventForMutation(ctx, id);

  const uniqueIds = Array.from(new Set(member_ids));

  const { data: validMembers, error: memberError } = await ctx.supabase.from("members")
    .select("id").eq("org_id", ctx.orgId).in("id", uniqueIds);
  if (memberError) throw memberError;
  if ((validMembers?.length ?? 0) !== uniqueIds.length) {
    throw new ApiError("validation_error", "One or more members do not belong to this organization", 422);
  }

  const { data: existing, error: existingError } = await ctx.supabase.from("event_master_list")
    .select("member_id").eq("event_id", id).in("member_id", uniqueIds);
  if (existingError) throw existingError;
  const existingIds = new Set((existing ?? []).map((row) => row.member_id as string));
  const newIds = uniqueIds.filter((memberIdValue) => !existingIds.has(memberIdValue));

  let added: EventMasterListEntry[] = [];
  if (newIds.length > 0) {
    const rows = newIds.map((memberIdValue) => ({ event_id: id, member_id: memberIdValue, added_by: ctx.userId }));
    const { data: inserted, error: insertError } = await ctx.supabase.from("event_master_list")
      .insert(rows).select("member_id,added_at,added_by");
    if (insertError) throw insertError;
    added = (inserted ?? []) as EventMasterListEntry[];
  }

  return { added, skipped: uniqueIds.filter((memberIdValue) => existingIds.has(memberIdValue)) };
}

export async function listMasterList(ctx: AuthContext, id: string) {
  eventId.parse(id);
  await fetchEventForMutation(ctx, id);

  const { data, error } = await ctx.supabase.from("event_master_list")
    .select("member_id,added_at,added_by,members(id,full_name,student_number,email,course,member_role,status)")
    .eq("event_id", id).order("added_at");
  if (error) throw error;
  return data ?? [];
}

export async function removeFromMasterList(ctx: AuthContext, id: string, targetMemberId: string) {
  requireRole(ctx, ["officer"]);
  eventId.parse(id);
  memberIdSchema.parse(targetMemberId);
  await fetchEventForMutation(ctx, id);

  const { error } = await ctx.supabase.from("event_master_list").delete()
    .eq("event_id", id).eq("member_id", targetMemberId);
  if (error) throw error;
  return { event_id: id, member_id: targetMemberId };
}
