import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  SCAN_DUPLICATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(8),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  CRON_SECRET: z.string().min(16).optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;

/** Server-only guard — call this inside any route that touches the service role. */
export function requireServiceRoleKey(): string {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return env.SUPABASE_SERVICE_ROLE_KEY;
}
