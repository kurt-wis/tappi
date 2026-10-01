import { z } from "zod";
import { handler, ok, readOptionalJson, ApiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const POST = handler(async (request: Request) => {
  const { memberId } = z.object({ memberId: z.string().uuid().optional() }).strict().parse(await readOptionalJson(request));
  const supabase = await createClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) throw ApiError.unauthorized();
  const { data: login, error: loginError } = await supabase.from("logins").select("person_id")
    .eq("user_id", userData.user.id).maybeSingle();
  if (loginError) throw loginError;
  if (!login) throw ApiError.forbidden("No student account");
  if (memberId) {
    const { data: member, error: memberError } = await supabase.from("members").select("person_id")
      .eq("id", memberId).eq("person_id", login.person_id).maybeSingle();
    if (memberError) throw memberError;
    if (!member) throw ApiError.notFound("Member not found");
  }
  const { error: rpcError } = await supabaseAdmin().rpc("report_lost_card", { p_person_id: login.person_id });
  if (rpcError) throw rpcError;
  return ok({ reported: true });
});
