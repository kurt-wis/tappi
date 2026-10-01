import { download, handler } from "@/lib/http";
import { requireAuth, requireRole } from "@/lib/supabase/server";
import { exportOrgBackup } from "@/lib/backup";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const GET = handler(async () => {
  const ctx = await requireAuth();
  requireRole(ctx, []);
  await enforceRateLimit(RATE_LIMITS.backupExport, ctx.orgId);
  const backup = await exportOrgBackup(ctx);
  return download({ filename: backup.filename, contentType: "application/json; charset=utf-8", body: backup.body });
});
