import { handler, ok, readJson } from "@/lib/http";
import { requireAuth, requireRole } from "@/lib/supabase/server";
import { restoreOrgBackup } from "@/lib/backup";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const POST = handler(async (request: Request) => {
  const ctx = await requireAuth();
  requireRole(ctx, []);
  await enforceRateLimit(RATE_LIMITS.backupRestore, ctx.orgId);
  return ok(await restoreOrgBackup(ctx, await readJson(request)));
});
