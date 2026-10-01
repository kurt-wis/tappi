import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "@/lib/http";

export const signupSchema = z.object({
  mode: z.literal("org").optional(),
  org_name: z.string().trim().min(1).max(200),
  org_slug: z.string().trim().toLowerCase().min(2).max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens"),
  full_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254).toLowerCase(),
  password: z.string().min(8).max(128),
}).strict();

export async function signupOrganization(
  admin: SupabaseClient,
  input: z.infer<typeof signupSchema>,
) {
  let userId: string | undefined;
  let orgId: string | undefined;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
    });
    if (error) {
      if (error.code === "email_exists" || error.code === "user_already_exists") {
        throw ApiError.conflict("An account with this email already exists");
      }
      if (error.code === "weak_password" || error.code === "email_address_invalid") {
        throw new ApiError("validation_error", "Email or password does not meet account requirements", 422);
      }
      throw error;
    }
    if (!data.user) throw new Error("Account creation returned no user");
    userId = data.user.id;

    const { data: org, error: orgError } = await admin.from("organizations")
      .insert({ name: input.org_name, slug: input.org_slug })
      .select("id").single();
    if (orgError?.code === "23505") throw ApiError.conflict("Organization slug is already taken");
    if (orgError) throw orgError;
    if (!org) throw new Error("Organization creation returned no organization");
    orgId = org.id as string;

    const { error: profileError } = await admin.from("profiles").insert({
      id: userId,
      org_id: orgId,
      email: input.email,
      full_name: input.full_name,
      role: "org_admin",
      is_active: true,
    });
    if (profileError) throw profileError;

    return { user_id: userId, org_id: orgId, role: "org_admin" as const };
  } catch (error) {

    const cleanupErrors: unknown[] = [];
    if (orgId) {
      try {
        const { error: cleanupError } = await admin.from("organizations").delete().eq("id", orgId);
        if (cleanupError) cleanupErrors.push(cleanupError);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (userId) {
      try {
        const { error: cleanupError } = await admin.auth.admin.deleteUser(userId);
        if (cleanupError) cleanupErrors.push(cleanupError);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) {
      console.error("[signup] Rollback failed", { userId, orgId, cleanupErrors });
      throw new ApiError("internal_error", "Account setup could not be completed. Contact support before retrying.", 500);
    }
    throw error;
  }
}
