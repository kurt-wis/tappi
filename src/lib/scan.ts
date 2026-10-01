import { z } from "zod";
import { ApiError } from "@/lib/http";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Attendance } from "@/types/domain";
import { cardUid } from "@/lib/member-cards";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });

export const recordScanSchema = z.object({
  event_id: uuid,
  card_uid: cardUid,
  client_scan_id: z.string().trim().min(1).max(100).optional(),
  device_id: z.string().trim().min(1).max(100).optional(),
  scanned_at: isoDateTime.optional(),
}).strict();

export const batchScanSchema = z.object({
  scans: z.array(recordScanSchema).min(1).max(500),
}).strict();

type PgError = { code?: string; message: string };

function throwForScanRpcError(error: PgError): never {
  switch (error.code) {
    case "TP020":
      throw new ApiError("validation_error", "Card is not linked to any member", 422);
    case "TP021":
      throw ApiError.notFound("Event not found");
    case "TP022":
      throw ApiError.conflict("Event is not published");
    case "TP023":
      throw ApiError.conflict("Walk-ins are not allowed for this event");
    case "TP024":
      throw ApiError.conflict("Walk-ins require approval for this event");
    case "TP025":
      throw ApiError.conflict("Member is not active");
    case "TP026":
      throw ApiError.conflict("This card has been reported lost or revoked");
    default:
      throw error;
  }
}

export async function recordScan(ctx: AuthContext, input: unknown, method: "tap" | "offline_sync" = "tap"): Promise<Attendance> {
  requireRole(ctx, ["officer", "scanner_operator"]);
  const parsed = recordScanSchema.parse(input);

  const { data, error } = await supabaseAdmin().rpc("record_scan", {
    p_org_id: ctx.orgId,
    p_event_id: parsed.event_id,
    p_card_uid: parsed.card_uid,
    p_scanned_at: parsed.scanned_at ?? new Date().toISOString(),
    p_officer_id: ctx.userId,
    p_device_id: parsed.device_id ?? null,
    p_client_scan_id: parsed.client_scan_id ?? null,
    p_method: method,
  });
  if (error?.code === "TP026") {
    await supabaseAdmin().from("audit_logs").insert({
      org_id: ctx.orgId,
      actor_id: ctx.userId,
      action: "revoked_card_scan_rejected",
      entity: "card",
      entity_id: parsed.card_uid,
      metadata: { event_id: parsed.event_id, device_id: parsed.device_id ?? null },
    });
  }
  if (error) throwForScanRpcError(error);
  if (!data) throw new Error("record_scan returned no row");
  return data as Attendance;
}

type BatchOk  = { index: number; ok: true;  data: Attendance };
type BatchErr = { index: number; ok: false; error: { code: string; message: string } };
export type BatchScanResult = BatchOk | BatchErr;

export async function recordScanBatch(ctx: AuthContext, input: unknown) {
  requireRole(ctx, ["officer", "scanner_operator"]);
  const { scans } = batchScanSchema.parse(input);

  const results: BatchScanResult[] = [];
  for (let index = 0; index < scans.length; index++) {
    try {
      if (!scans[index].client_scan_id || !scans[index].scanned_at) {
        throw new ApiError("validation_error", "Offline scans require client_scan_id and scanned_at", 422);
      }
      const data = await recordScan(ctx, scans[index], "offline_sync");
      results.push({ index, ok: true, data });
    } catch (error) {
      if (error instanceof ApiError) {
        results.push({
          index,
          ok: false,
          error: { code: error.code, message: error.message },
        });
      } else {
        results.push({
          index,
          ok: false,
          error: { code: "internal_error", message: "Something went wrong" },
        });
      }
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return {
    results,
    summary: { total: scans.length, succeeded, failed: scans.length - succeeded },
  };
}
