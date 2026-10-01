import { handler, ok, ApiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";
import { getAccount } from "@/lib/auth/account";

export const GET = handler(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw ApiError.unauthorized();
  return ok(await getAccount(supabase, data.user));
});
