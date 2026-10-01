import { z } from "zod";
import { ApiError } from "@/lib/http";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import type { Device, DeviceStatus } from "@/types/domain";

export const deviceColumns = "id,org_id,device_id,label,kind,status,notes,last_seen_at,registered_by,created_at,updated_at";

export const deviceKind = z.enum(["tapper", "linking_station", "spare"]);
export const deviceStatus = z.enum(["active", "maintenance", "retired", "lost"]);
/** Same shape as the device_id accepted by the scan endpoints. */
export const deviceIdentifier = z.string().trim().min(1).max(100);
export const deviceRowId = z.string().uuid();

/** Scans from these devices are rejected; maintenance devices may still scan. */
export const BLOCKED_DEVICE_STATUSES: readonly DeviceStatus[] = ["retired", "lost"];

const label = z.string().trim().min(1).max(100).nullable().optional();
const notes = z.string().trim().min(1).max(1000).nullable().optional();

export const createDeviceSchema = z.object({
  device_id: deviceIdentifier,
  label,
  kind: deviceKind.default("tapper"),
  status: deviceStatus.default("active"),
  notes,
}).strict();

export const updateDeviceSchema = z.object({
  label,
  kind: deviceKind.optional(),
  status: deviceStatus.optional(),
  notes,
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

export const deviceQuerySchema = z.object({
  kind: deviceKind.optional(),
  status: deviceStatus.optional(),
  search: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  per_page: z.coerce.number().int().min(1).max(1_000_000).default(50).transform((n) => Math.min(n, 200)),
}).strict();

function deviceSearchFilter(search: string): string {
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const quoted = `"${pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `device_id.ilike.${quoted},label.ilike.${quoted}`;
}

export async function listDevices(ctx: AuthContext, input: unknown) {
  const { kind, status, search, page, per_page } = deviceQuerySchema.parse(input);
  let query = ctx.supabase.from("devices").select(deviceColumns, { count: "exact" }).eq("org_id", ctx.orgId);
  if (kind) query = query.eq("kind", kind);
  if (status) query = query.eq("status", status);
  if (search) query = query.or(deviceSearchFilter(search));
  const { data, error, count } = await query.order("device_id").order("id")
    .range((page - 1) * per_page, page * per_page - 1);
  if (error) throw error;
  return {
    devices: (data ?? []) as Device[],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  };
}

export async function getDevice(ctx: AuthContext, id: string): Promise<Device> {
  deviceRowId.parse(id);
  const { data, error } = await ctx.supabase.from("devices").select(deviceColumns)
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Device not found");
  return data as Device;
}

export async function createDevice(ctx: AuthContext, input: unknown): Promise<Device> {
  requireRole(ctx, ["officer"]);
  const device = createDeviceSchema.parse(input);
  const { data, error } = await ctx.supabase.from("devices")
    .insert({ ...device, org_id: ctx.orgId, registered_by: ctx.userId }).select(deviceColumns).single();
  if (error?.code === "23505") throw ApiError.conflict("A device with this device_id is already registered");
  if (error) throw error;
  const created = data as Device;
  await recordAudit(ctx, {
    action: "device.registered", entity: "devices", entity_id: created.id,
    metadata: { device_id: created.device_id, kind: created.kind, status: created.status },
  });
  return created;
}

export async function updateDevice(ctx: AuthContext, id: string, input: unknown): Promise<Device> {
  requireRole(ctx, ["officer"]);
  deviceRowId.parse(id);
  const changes = updateDeviceSchema.parse(input);
  const { data, error } = await ctx.supabase.from("devices").update(changes)
    .eq("org_id", ctx.orgId).eq("id", id).select(deviceColumns).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Device not found");
  const updated = data as Device;
  await recordAudit(ctx, {
    action: "device.updated", entity: "devices", entity_id: id,
    metadata: { device_id: updated.device_id, changes },
  });
  return updated;
}

export async function deleteDevice(ctx: AuthContext, id: string) {
  requireRole(ctx, []);
  deviceRowId.parse(id);
  const { data, error } = await ctx.supabase.from("devices").delete()
    .eq("org_id", ctx.orgId).eq("id", id).select("id,device_id").maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Device not found");
  await recordAudit(ctx, { action: "device.deleted", entity: "devices", entity_id: id, metadata: { device_id: data.device_id } });
  return { id };
}

/**
 * Marks registered devices as seen and returns their statuses. Devices that are not registered
 * are absent from the result and may still scan, so existing scanners keep working.
 */
export async function touchScanDevices(ctx: AuthContext, deviceIds: string[]): Promise<Map<string, DeviceStatus>> {
  const unique = Array.from(new Set(deviceIds));
  if (unique.length === 0) return new Map();
  const { data, error } = await supabaseAdmin().rpc("touch_devices", { p_org_id: ctx.orgId, p_device_ids: unique });
  if (error) throw error;
  return new Map(((data ?? []) as Array<{ device_id: string; status: DeviceStatus }>)
    .map((row) => [row.device_id, row.status]));
}
