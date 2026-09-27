import { handler, ok } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";

export const POST = handler(async () => {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw error;
  return ok({ signed_out: true });
});
