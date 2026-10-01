import { z } from "zod";
import { handler, ok, readOptionalJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { finalizeEvent } from "@/lib/finalize";

type Context = { params: Promise<{ id: string }> };

const finalizeSchema = z.object({ force: z.boolean().default(false) }).strict();

export const POST = handler(async (request: Request, route: Context) => {
  const ctx = await requireAuth();

  const { force } = finalizeSchema.parse(await readOptionalJson(request));

  return ok(await finalizeEvent(ctx, (await route.params).id, { force }));
});
