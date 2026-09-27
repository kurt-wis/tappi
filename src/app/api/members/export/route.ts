import { handler } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { exportMembersCsv } from "@/lib/members-csv";

// Unlike the rest of the members API, a successful export is a downloadable
// CSV file, not an { ok, data } envelope — that's the expected shape for an
// "export" endpoint. Errors (auth, etc.) still flow through the normal
// ApiError -> handler() -> fail() path like every other route.
export const GET = handler(async () => {
  const ctx = await requireAuth();
  const csv = await exportMembersCsv(ctx);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="members.csv"',
      "Cache-Control": "private, no-store",
    },
  });
});
