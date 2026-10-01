import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { createDevice, listDevices } from "@/lib/devices";

export const GET = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await listDevices(ctx, Object.fromEntries(new URL(request.url).searchParams)));
});

export const POST = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await createDevice(ctx, await readJson(request)), { status: 201 });
});
