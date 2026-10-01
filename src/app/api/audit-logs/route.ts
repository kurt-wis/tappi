import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { listAuditLogs } from "@/lib/audit";

export const GET = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await listAuditLogs(ctx, Object.fromEntries(new URL(request.url).searchParams)));
});
