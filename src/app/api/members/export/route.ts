import { handler } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { exportMembersCsv } from "@/lib/members-csv";

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
