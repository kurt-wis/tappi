import { z } from "zod";
import { ApiError } from "@/lib/http";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import { eventId as eventIdSchema } from "@/lib/events";
import {
  formFieldListSchema, parseStoredFields, resolveFormSchema, type FormFieldDefinition,
} from "@/lib/registration-form";

export const setFormFieldsSchema = z.object({ fields: formFieldListSchema }).strict();

type PgError = { code?: string; message: string };

function throwForFormRpcError(error: PgError): never {
  switch (error.code) {
    case "TP010":
      throw ApiError.notFound("Event not found");
    case "TP070":
      throw ApiError.notFound("Organization not found");
    case "TP071":
      throw ApiError.conflict("The registration form of a cancelled or completed event is locked");
    case "22023":
      throw new ApiError("validation_error", error.message, 422);
    default:
      throw error;
  }
}

/** Org defaults are read with the service role so public registration pages can resolve them too. */
export async function loadOrgFormFields(orgId: string): Promise<FormFieldDefinition[]> {
  const { data, error } = await supabaseAdmin().from("organizations").select("settings")
    .eq("id", orgId).maybeSingle();
  if (error) throw error;
  const settings = data?.settings as Record<string, unknown> | null | undefined;
  return parseStoredFields(settings?.registration_fields);
}

export async function resolveEventForm(orgId: string, eventFormFields: unknown) {
  const orgFields = await loadOrgFormFields(orgId);
  const eventFields = parseStoredFields(eventFormFields);
  return { org_fields: orgFields, event_fields: eventFields, fields: resolveFormSchema(orgFields, eventFields) };
}

export async function getOrgFormFields(ctx: AuthContext) {
  return { fields: await loadOrgFormFields(ctx.orgId) };
}

export async function setOrgFormFields(ctx: AuthContext, input: unknown) {
  requireRole(ctx, []);
  const { fields } = setFormFieldsSchema.parse(input);
  const { data, error } = await supabaseAdmin().rpc("set_org_registration_fields", {
    p_org_id: ctx.orgId, p_fields: fields,
  });
  if (error) throwForFormRpcError(error);
  await recordAudit(ctx, {
    action: "org.registration_form_updated", entity: "organizations", entity_id: ctx.orgId,
    metadata: { field_keys: fields.map((field) => field.key) },
  });
  return { fields: parseStoredFields(data) };
}

export async function getEventForm(ctx: AuthContext, id: string) {
  eventIdSchema.parse(id);
  const { data, error } = await ctx.supabase.from("events").select("id,status,form_fields")
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Event not found");
  return { event_id: data.id as string, ...(await resolveEventForm(ctx.orgId, data.form_fields)) };
}

export async function setEventFormFields(ctx: AuthContext, id: string, input: unknown) {
  requireRole(ctx, ["officer"]);
  eventIdSchema.parse(id);
  const { fields } = setFormFieldsSchema.parse(input);
  const { data, error } = await supabaseAdmin().rpc("set_event_form_fields", {
    p_org_id: ctx.orgId, p_event_id: id, p_fields: fields,
  });
  if (error) throwForFormRpcError(error);
  if (!data) throw ApiError.notFound("Event not found");
  await recordAudit(ctx, {
    action: "event.form_updated", entity: "events", entity_id: id,
    metadata: { field_keys: fields.map((field) => field.key) },
  });
  return { event_id: id, ...(await resolveEventForm(ctx.orgId, (data as { form_fields: unknown }).form_fields)) };
}
