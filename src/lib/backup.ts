import { z } from "zod";
import { ApiError } from "@/lib/http";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";

export const BACKUP_FORMAT = "tappi.org-backup";
export const BACKUP_VERSION = 1;

export const BACKUP_SECTIONS = [
  "persons", "org_people", "members", "cards", "events", "event_master_list", "registrations",
  "attendance", "points_ledger", "certificates", "devices", "card_link_audit",
] as const;

export const restoreRequestSchema = z.object({
  backup: z.object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_VERSION),
    org_id: z.string().uuid(),
    data: z.object(Object.fromEntries(
      BACKUP_SECTIONS.map((section) => [section, z.array(z.record(z.unknown())).optional()]),
    )).passthrough(),
  }).passthrough(),
  dry_run: z.boolean().default(true),
  restore_settings: z.boolean().default(false),
}).strict();

export type RestoreSummary = {
  dry_run: boolean;
  settings_restored: boolean;
  in_backup: Record<string, number>;
  inserted: Record<string, number>;
};

type PgError = { code?: string; message: string };

const INVALID_DATA_CODES = new Set(["22023", "22P02", "22007", "22008", "23502", "23503", "23505", "23514", "22001", "22003"]);

function throwForBackupRpcError(error: PgError): never {
  if (error.code === "TP080") throw ApiError.notFound("Organization not found");
  if (error.code === "TP081") throw new ApiError("validation_error", "Unsupported or malformed backup file", 422);
  if (error.code === "TP082") throw new ApiError("validation_error", "This backup belongs to a different organization", 422);
  if (error.code && INVALID_DATA_CODES.has(error.code)) {
    throw new ApiError("validation_error", "The backup contains invalid data; nothing was restored", 422, { reason: error.message });
  }
  throw error;
}

export async function exportOrgBackup(ctx: AuthContext) {
  requireRole(ctx, []);
  const { data, error } = await supabaseAdmin().rpc("export_org_backup", { p_org_id: ctx.orgId });
  if (error) throwForBackupRpcError(error);
  if (!data) throw new Error("export_org_backup returned no data");
  const backup = data as { organization?: { slug?: string }; data: Record<string, unknown[]> };
  await recordAudit(ctx, {
    action: "backup.exported", entity: "organizations", entity_id: ctx.orgId,
    metadata: { counts: Object.fromEntries(BACKUP_SECTIONS.map((section) => [section, backup.data?.[section]?.length ?? 0])) },
  });
  const slug = (backup.organization?.slug ?? "org").replace(/[^a-zA-Z0-9_-]/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { filename: `tappi-backup-${slug}-${stamp}.json`, body: JSON.stringify(backup) };
}

/**
 * Restores records that are missing from the organization. Existing rows are never modified or
 * deleted, so a restore cannot overwrite newer data. Runs as a dry run unless dry_run is false.
 */
export async function restoreOrgBackup(ctx: AuthContext, input: unknown): Promise<RestoreSummary> {
  requireRole(ctx, []);
  const { backup, dry_run, restore_settings } = restoreRequestSchema.parse(input);
  if (backup.org_id !== ctx.orgId) {
    throw new ApiError("validation_error", "This backup belongs to a different organization", 422);
  }
  const { data, error } = await supabaseAdmin().rpc("restore_org_backup", {
    p_org_id: ctx.orgId,
    p_backup: backup,
    p_dry_run: dry_run,
    p_restore_settings: restore_settings,
  });
  if (error) throwForBackupRpcError(error);
  if (!data) throw new Error("restore_org_backup returned no data");
  const summary = data as RestoreSummary;
  await recordAudit(ctx, {
    action: dry_run ? "backup.restore_previewed" : "backup.restored", entity: "organizations", entity_id: ctx.orgId,
    metadata: { exported_at: (backup as { exported_at?: unknown }).exported_at ?? null, ...summary },
  });
  return summary;
}
