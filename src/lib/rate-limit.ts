import { createHash } from "node:crypto";
import { ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type RateLimitPolicy = {
  name: string;
  limit: number;
  windowSeconds: number;
};

/**
 * Limits are counted in Postgres so they hold across serverless instances. Per-IP limits are
 * deliberately generous because a campus network can put many students behind one address;
 * the tighter limits are keyed by the targeted account or record.
 */
export const RATE_LIMITS = {
  loginIp: { name: "auth.login.ip", limit: 30, windowSeconds: 300 },
  loginAccount: { name: "auth.login.account", limit: 10, windowSeconds: 900 },
  signupIp: { name: "auth.signup.ip", limit: 10, windowSeconds: 3600 },
  otpSendIp: { name: "auth.otp_send.ip", limit: 20, windowSeconds: 900 },
  otpVerifyIp: { name: "auth.otp_verify.ip", limit: 30, windowSeconds: 900 },
  activateIp: { name: "auth.activate.ip", limit: 20, windowSeconds: 900 },
  lookupIp: { name: "public.lookup.ip", limit: 30, windowSeconds: 900 },
  lookupStudent: { name: "public.lookup.student", limit: 5, windowSeconds: 900 },
  verifyOtpIp: { name: "public.verify_otp.ip", limit: 30, windowSeconds: 900 },
  autofillIp: { name: "public.autofill.ip", limit: 30, windowSeconds: 900 },
  registerIp: { name: "public.register.ip", limit: 60, windowSeconds: 600 },
  registerStudent: { name: "public.register.student", limit: 5, windowSeconds: 600 },
  certificateVerifyIp: { name: "public.certificate_verify.ip", limit: 60, windowSeconds: 60 },
  backupExport: { name: "backup.export", limit: 10, windowSeconds: 3600 },
  backupRestore: { name: "backup.restore", limit: 10, windowSeconds: 3600 },
} satisfies Record<string, RateLimitPolicy>;

type HeaderSource = { get(name: string): string | null };

export function clientIpFromHeaders(headers: HeaderSource): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const real = headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "unknown";
}

export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}

/** Identifiers are hashed so raw IPs and emails are never stored in the limiter table. */
export function rateLimitKey(policy: RateLimitPolicy, identifiers: string[]): string {
  const digest = createHash("sha256").update(identifiers.join("\u0000")).digest("hex");
  return `${policy.name}:${digest}`;
}

type ConsumeResult = { allowed: boolean; remaining: number; retry_after: number };

export async function enforceRateLimit(policy: RateLimitPolicy, ...identifiers: string[]): Promise<void> {
  const { data, error } = await supabaseAdmin().rpc("consume_rate_limit", {
    p_key: rateLimitKey(policy, identifiers),
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
  });
  if (error) throw error;
  const result = data as ConsumeResult | null;
  if (!result) throw new Error("consume_rate_limit returned no data");
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil(Number(result.retry_after) || policy.windowSeconds));
    throw new ApiError("rate_limited", "Too many requests. Try again later.", 429, { retry_after: retryAfter }, {
      "Retry-After": String(retryAfter),
    });
  }
}
