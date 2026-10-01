import { z } from "zod";
import { headers } from "next/headers";
import { requireRole, type AuthContext } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { clientIpFromHeaders } from "@/lib/rate-limit";

export type AuditEntry = {
  action: string;
  entity: string;
  entity_id?: string | null;
  metadata?: Record<string, unknown>;
};

async function requestOrigin(): Promise<{ ip: string | null; user_agent: string | null }> {
  try {
    const requestHeaders = await headers();
    const ip = clientIpFromHeaders(requestHeaders);
    return {
      ip: ip === "unknown" ? null : ip,
      user_agent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null,
    };
  } catch {
    return { ip: null, user_agent: null };
  }
}

/**
 * Appends an entry to the org audit log after a staff action has succeeded. The action is
 * already committed at this point, so a logging failure is reported to the server log instead
 * of turning a successful request into an error.
 */
export async function recordAudit(ctx: Pick<AuthContext, "orgId" | "userId">, entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from("audit_logs").insert({
      org_id: ctx.orgId,
      actor_id: ctx.userId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entity_id ?? null,
      metadata: entry.metadata ?? {},
      ...(await requestOrigin()),
    });
    if (error) console.error("[audit] failed to record", entry.action, error);
  } catch (error) {
    console.error("[audit] failed to record", entry.action, error);
  }
}

const isoDateTime = z.string().datetime({ offset: true });

export const auditQuerySchema = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  entity: z.string().trim().min(1).max(100).optional(),
  entity_id: z.string().trim().min(1).max(200).optional(),
  actor_id: z.string().uuid().optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  per_page: z.coerce.number().int().min(1).max(1_000_000).default(50).transform((n) => Math.min(n, 200)),
}).strict();

export const auditColumns = "id,org_id,actor_id,action,entity,entity_id,metadata,ip,user_agent,created_at";

export async function listAuditLogs(ctx: AuthContext, input: unknown) {
  requireRole(ctx, []);
  const { action, entity, entity_id, actor_id, from, to, page, per_page } = auditQuerySchema.parse(input);
  let query = ctx.supabase.from("audit_logs").select(auditColumns, { count: "exact" }).eq("org_id", ctx.orgId);
  if (action) query = query.eq("action", action);
  if (entity) query = query.eq("entity", entity);
  if (entity_id) query = query.eq("entity_id", entity_id);
  if (actor_id) query = query.eq("actor_id", actor_id);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  const { data, error, count } = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
    .range((page - 1) * per_page, page * per_page - 1);
  if (error) throw error;
  return {
    entries: data ?? [],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  };
}
