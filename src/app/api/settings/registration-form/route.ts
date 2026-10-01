import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { getOrgFormFields, setOrgFormFields } from "@/lib/event-forms";

export const GET = handler(async () => {
  const ctx = await requireAuth();
  return ok(await getOrgFormFields(ctx));
});

export const PUT = handler(async (request: Request) => {
  const ctx = await requireAuth();
  return ok(await setOrgFormFields(ctx, await readJson(request)));
});
