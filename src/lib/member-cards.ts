import { z } from "zod";
import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { memberId } from "@/lib/members";
import type { CardLinkAudit, Member } from "@/types/domain";

/** Raw decimal string the USB RFID wedge reader types, e.g. "2035787938". */
export const cardUid = z.string().trim().regex(/^\d+$/, "card_uid must be a decimal digit string").min(1).max(32);

export const linkCardSchema = z.object({ card_uid: cardUid }).strict();
export const replaceCardSchema = z.object({ new_card_uid: cardUid }).strict();

const cardHistoryColumns = "id,org_id,member_id,old_uid,new_uid,action,officer_id,created_at";

/** Postgres error shape returned by supabase-js for both RPC calls and REST queries. */
type PgError = { code?: string; message: string };

/**
 * Custom SQLSTATEs raised by the link/replace/unlink RPCs (see the
 * 20260928120000_member_card_linking migration) plus the unique-violation
 * Postgres raises naturally for a UID already taken in the org.
 */
function throwForCardRpcError(error: PgError): never {
  switch (error.code) {
    case "TP003":
      throw ApiError.notFound("Member not found");
    case "TP001":
      throw ApiError.conflict("Member already has a linked card");
    case "TP002":
      throw ApiError.conflict("Member has no linked card");
    case "23505":
      throw ApiError.conflict("Card UID is already linked to another member in this organization");
    default:
      throw error;
  }
}

/** Shape a members-table row (as returned by the card RPCs) into the member fields relevant to a card response. */
function toCardMember(row: Record<string, unknown>): Member {
  const {
    id, org_id, student_number, full_name, email, course, member_role,
    status, card_uid: uid, card_linked_at, card_linked_by, created_at,
  } = row;
  return {
    id, org_id, student_number, full_name, email, course, member_role,
    status, card_uid: uid, card_linked_at, card_linked_by, created_at,
  } as Member;
}

export async function linkCard(ctx: AuthContext, id: string, input: unknown): Promise<Member> {
  requireRole(ctx, ["officer"]);
  memberId.parse(id);
  const { card_uid } = linkCardSchema.parse(input);

  const { data, error } = await supabaseAdmin().rpc("link_member_card", {
    p_org_id: ctx.orgId,
    p_member_id: id,
    p_card_uid: card_uid,
    p_officer_id: ctx.userId,
  });
  if (error) throwForCardRpcError(error);
  if (!data) throw ApiError.notFound("Member not found");
  return toCardMember(data);
}

export async function replaceCard(ctx: AuthContext, id: string, input: unknown): Promise<Member> {
  requireRole(ctx, ["officer"]);
  memberId.parse(id);
  const { new_card_uid } = replaceCardSchema.parse(input);

  const { data, error } = await supabaseAdmin().rpc("replace_member_card", {
    p_org_id: ctx.orgId,
    p_member_id: id,
    p_new_card_uid: new_card_uid,
    p_officer_id: ctx.userId,
  });
  if (error) throwForCardRpcError(error);
  if (!data) throw ApiError.notFound("Member not found");
  return toCardMember(data);
}

export async function unlinkCard(ctx: AuthContext, id: string): Promise<Member> {
  requireRole(ctx, ["officer"]);
  memberId.parse(id);

  const { data, error } = await supabaseAdmin().rpc("unlink_member_card", {
    p_org_id: ctx.orgId,
    p_member_id: id,
    p_officer_id: ctx.userId,
  });
  if (error) throwForCardRpcError(error);
  if (!data) throw ApiError.notFound("Member not found");
  return toCardMember(data);
}

/** Readable by any authenticated org member (not officer-gated) — see prompt's suggested behavior. */
export async function getCardHistory(ctx: AuthContext, id: string): Promise<CardLinkAudit[]> {
  memberId.parse(id);

  const { data: member, error: memberError } = await ctx.supabase.from("members").select("id")
    .eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw ApiError.notFound("Member not found");

  const { data, error } = await ctx.supabase.from("card_link_audit").select(cardHistoryColumns)
    .eq("org_id", ctx.orgId).eq("member_id", id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CardLinkAudit[];
}
