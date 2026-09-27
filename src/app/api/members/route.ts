import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { createMember, listMembers } from "@/lib/members";

export const GET = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await listMembers(ctx, Object.fromEntries(new URL(request.url).searchParams)));
});

export const POST = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await createMember(ctx, await readJson(request)), { status: 201 });
});
