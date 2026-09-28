import { download, handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { memberSummaryReport } from "@/lib/reports";

// ?format=csv|pdf returns a file download; the default (json) is paginated.
export const GET = handler(async (request: Request) => {
  const ctx = await requireAuth();
  const result = await memberSummaryReport(ctx, Object.fromEntries(new URL(request.url).searchParams));
  return result.kind === "json" ? ok(result.data) : download(result.file);
});
