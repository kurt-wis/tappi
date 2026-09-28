import { handler, ok, readOptionalJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { issueCertificates, listEventCertificates } from "@/lib/certificates";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await listEventCertificates(ctx, (await route.params).id));
});

// Empty body issues to every eligible attendee; { member_ids } targets specific members.
export const POST = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();
  return ok(await issueCertificates(ctx, (await route.params).id, await readOptionalJson(request)));
});
