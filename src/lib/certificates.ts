import { z } from "zod";
import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { memberId as memberIdSchema } from "@/lib/members";
import { eventId as eventIdSchema } from "@/lib/events";
import type { Certificate } from "@/types/domain";

export const certificateColumns =
  "id,org_id,event_id,member_id,code,issued_by,issued_at,revoked_at,revoked_by,revoke_reason";

const uuid = z.string().uuid();

export const issueCertificatesSchema = z.object({
  member_ids: z.array(uuid).min(1).max(500).optional(),
}).strict();

export const revokeCertificateSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export type IssueCertificatesSummary = {
  issued: number;
  reinstated: number;
  skipped: Array<{ member_id: string; reason: "not_eligible" }>;
};

type PgError = { code?: string; message: string };

function throwForCertificateRpcError(error: PgError): never {
  switch (error.code) {
    case "TP040":
      throw ApiError.notFound("Event not found");
    case "TP041":
      throw ApiError.conflict("Certificates are not enabled for this event");
    case "TP042":
      throw ApiError.conflict("Event must be finalized before issuing certificates");
    case "TP043":
      throw ApiError.notFound("Certificate not found");
    case "TP044":
      throw ApiError.conflict("Certificate is already revoked");
    default:
      throw error;
  }
}

export async function issueCertificates(ctx: AuthContext, eventId: string, input: unknown): Promise<IssueCertificatesSummary> {
  requireRole(ctx, ["officer"]);
  eventIdSchema.parse(eventId);
  const { member_ids } = issueCertificatesSchema.parse(input ?? {});

  const { data, error } = await supabaseAdmin().rpc("issue_certificates", {
    p_org_id: ctx.orgId,
    p_event_id: eventId,
    p_officer_id: ctx.userId,
    p_member_ids: member_ids ?? null,
  });
  if (error) throwForCertificateRpcError(error);
  if (!data) throw new Error("issue_certificates returned no data");
  return data as IssueCertificatesSummary;
}

export async function revokeCertificate(ctx: AuthContext, certificateId: string, input: unknown): Promise<Certificate> {
  requireRole(ctx, ["officer"]);
  uuid.parse(certificateId);
  const { reason } = revokeCertificateSchema.parse(input ?? {});

  const { data, error } = await supabaseAdmin().rpc("revoke_certificate", {
    p_org_id: ctx.orgId,
    p_certificate_id: certificateId,
    p_officer_id: ctx.userId,
    p_reason: reason ?? null,
  });
  if (error) throwForCertificateRpcError(error);
  if (!data) throw new Error("revoke_certificate returned no row");
  return data as Certificate;
}

const certificateWithMember = `${certificateColumns},members(id,full_name,student_number)`;
const certificateWithEvent = `${certificateColumns},events(id,title,starts_at)`;

export async function listEventCertificates(ctx: AuthContext, eventId: string) {
  eventIdSchema.parse(eventId);
  const { data: event, error: eventError } = await ctx.supabase.from("events").select("id")
    .eq("org_id", ctx.orgId).eq("id", eventId).maybeSingle();
  if (eventError) throw eventError;
  if (!event) throw ApiError.notFound("Event not found");

  const { data, error } = await ctx.supabase.from("certificates").select(certificateWithMember)
    .eq("org_id", ctx.orgId).eq("event_id", eventId)
    .order("issued_at").order("id");
  if (error) throw error;
  return data ?? [];
}

export async function listMemberCertificates(ctx: AuthContext, memberId: string) {
  memberIdSchema.parse(memberId);
  const { data: member, error: memberError } = await ctx.supabase.from("members").select("id")
    .eq("org_id", ctx.orgId).eq("id", memberId).maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw ApiError.notFound("Member not found");

  const { data, error } = await ctx.supabase.from("certificates").select(certificateWithEvent)
    .eq("org_id", ctx.orgId).eq("member_id", memberId)
    .order("issued_at", { ascending: false }).order("id");
  if (error) throw error;
  return data ?? [];
}

export function normalizeCertificateCode(raw: string): string | null {
  const hex = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[0-9A-F]{16}$/.test(hex)) return null;
  return hex.match(/.{4}/g)!.join("-");
}

export type CertificateVerification = {
  code: string;
  valid: boolean;
  recipient: string;
  event: { title: string; starts_at: string };
  organization: string;
  issued_at: string;
  revoked_at: string | null;
};

type VerificationRow = {
  code: string;
  issued_at: string;
  revoked_at: string | null;
  members: { full_name: string } | null;
  events: { title: string; starts_at: string } | null;
  organizations: { name: string } | null;
};

export async function verifyCertificate(rawCode: string): Promise<CertificateVerification> {
  const code = normalizeCertificateCode(rawCode);
  if (!code) throw ApiError.notFound("Certificate not found");

  const { data, error } = await supabaseAdmin().from("certificates")
    .select("code,issued_at,revoked_at,members(full_name),events(title,starts_at),organizations(name)")
    .eq("code", code).maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound("Certificate not found");

  const row = data as unknown as VerificationRow;
  return {
    code: row.code,
    valid: row.revoked_at === null,
    recipient: row.members?.full_name ?? "",
    event: { title: row.events?.title ?? "", starts_at: row.events?.starts_at ?? "" },
    organization: row.organizations?.name ?? "",
    issued_at: row.issued_at,
    revoked_at: row.revoked_at,
  };
}
