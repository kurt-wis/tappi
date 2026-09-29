import { handler, ok } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { tappiesLeaderboard } from "@/lib/reports";

export const GET = handler(async (request: Request) => {
  const ctx = await requireAuth();
  const limit = new URL(request.url).searchParams.get("limit") ?? "100";
  return ok({ rows: await tappiesLeaderboard(ctx, Number(limit)) });
});
