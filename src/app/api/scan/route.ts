import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { recordScan } from "@/lib/scan";

export const POST = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await recordScan(ctx, await readJson(request)), { status: 201 });
});