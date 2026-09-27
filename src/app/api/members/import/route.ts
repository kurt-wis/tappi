import { z } from "zod";
import { handler, ok, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/supabase/server";
import { importMembers } from "@/lib/members-csv";

const importBodySchema = z.object({ csv: z.string().min(1, "csv must not be empty") }).strict();

export const POST = handler(async (request: Request) => {
  const ctx = await requireAuth();
  const { csv } = importBodySchema.parse(await readJson(request));
  return ok(await importMembers(ctx, csv));
});
