import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc }) }));

const { linkCard, replaceCard, unlinkCard, getCardHistory } = await import("@/lib/member-cards");

const orgId = "e030dfb1-3186-493b-b58f-705603329231";
const userId = "9c6a2b1e-4f2a-4a2f-9a34-7b2f0e9a1234";
const id = "b2cf1e73-8d36-4a4b-86b7-b559ce4c4530";

const memberRow = {
  id, org_id: orgId, student_number: "2026-1", full_name: "Test Student",
  email: null, course: null, member_role: "member", status: "active",
  card_uid: "2035787938", card_linked_at: "2026-09-28T00:00:00.000Z", card_linked_by: userId,
  created_at: "2026-01-01T00:00:00.000Z",
};

function context(body: unknown = [], status = 200, role: AuthContext["role"] = "officer") {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Content-Range": "0-0/1" },
  }));
  const supabase = createClient("https://test.supabase.co", "test-anon-key", {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  });
  return { ctx: { supabase, orgId, userId, role } satisfies AuthContext, fetch };
}

beforeEach(() => {
  mocks.rpc.mockReset();
});

describe("linkCard", () => {
  it("rejects non-officers before touching the service role", async () => {
    const { ctx } = context([], 200, "scanner_operator");
    await expect(linkCard(ctx, id, { card_uid: "123" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("validates the id and card_uid before calling the RPC", async () => {
    const { ctx } = context();
    await expect(linkCard(ctx, "not-a-uuid", { card_uid: "123" })).rejects.toThrow();
    await expect(linkCard(ctx, id, { card_uid: "abc" })).rejects.toThrow();
    await expect(linkCard(ctx, id, { card_uid: "" })).rejects.toThrow();
    await expect(linkCard(ctx, id, {})).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calls link_member_card scoped to the session org/officer and returns the updated member", async () => {
    mocks.rpc.mockResolvedValue({ data: memberRow, error: null });
    const { ctx } = context();
    const result = await linkCard(ctx, id, { card_uid: "2035787938" });
    expect(mocks.rpc).toHaveBeenCalledWith("link_member_card", {
      p_org_id: orgId, p_member_id: id, p_card_uid: "2035787938", p_officer_id: userId,
    });
    expect(result).toMatchObject({ id, card_uid: "2035787938", card_linked_by: userId });
  });

  it("maps a not-found RPC error to 404", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP003", message: "Member not found" } });
    const { ctx } = context();
    await expect(linkCard(ctx, id, { card_uid: "123" })).rejects.toMatchObject({ status: 404 });
  });

  it("maps an already-linked RPC error to 409", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP001", message: "Member already has a linked card" } });
    const { ctx } = context();
    await expect(linkCard(ctx, id, { card_uid: "123" })).rejects.toMatchObject({ status: 409 });
  });

  it("maps a unique-violation RPC error (UID taken) to 409", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key" } });
    const { ctx } = context();
    await expect(linkCard(ctx, id, { card_uid: "123" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("replaceCard", () => {
  it("rejects non-officers", async () => {
    const { ctx } = context([], 200, "scanner_operator");
    await expect(replaceCard(ctx, id, { new_card_uid: "123" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calls replace_member_card and returns the updated member", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...memberRow, card_uid: "999" }, error: null });
    const { ctx } = context();
    const result = await replaceCard(ctx, id, { new_card_uid: "999" });
    expect(mocks.rpc).toHaveBeenCalledWith("replace_member_card", {
      p_org_id: orgId, p_member_id: id, p_new_card_uid: "999", p_officer_id: userId,
    });
    expect(result.card_uid).toBe("999");
  });

  it("maps a no-card RPC error to 409", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP002", message: "Member has no linked card" } });
    const { ctx } = context();
    await expect(replaceCard(ctx, id, { new_card_uid: "123" })).rejects.toMatchObject({ status: 409 });
  });

  it("maps a not-found RPC error to 404", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP003", message: "Member not found" } });
    const { ctx } = context();
    await expect(replaceCard(ctx, id, { new_card_uid: "123" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("unlinkCard", () => {
  it("rejects non-officers", async () => {
    const { ctx } = context([], 200, "scanner_operator");
    await expect(unlinkCard(ctx, id)).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calls unlink_member_card and returns the cleared member", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ...memberRow, card_uid: null, card_linked_at: null, card_linked_by: null }, error: null,
    });
    const { ctx } = context();
    const result = await unlinkCard(ctx, id);
    expect(mocks.rpc).toHaveBeenCalledWith("unlink_member_card", {
      p_org_id: orgId, p_member_id: id, p_officer_id: userId,
    });
    expect(result.card_uid).toBeNull();
  });

  it("maps a no-card RPC error to 409", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP002", message: "Member has no linked card" } });
    const { ctx } = context();
    await expect(unlinkCard(ctx, id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("getCardHistory", () => {
  it("returns 404 when the member isn't visible in the session org", async () => {
    const { ctx } = context([]);
    await expect(getCardHistory(ctx, id)).rejects.toMatchObject({ status: 404 });
  });

  it("is readable without an officer role and returns newest-first audit rows", async () => {
    const auditRows = [
      { id: "a1", org_id: orgId, member_id: id, old_uid: "111", new_uid: "222", action: "relink", officer_id: userId, created_at: "2026-02-01T00:00:00.000Z" },
      { id: "a0", org_id: orgId, member_id: id, old_uid: null, new_uid: "111", action: "link", officer_id: userId, created_at: "2026-01-01T00:00:00.000Z" },
    ];
    let call = 0;
    const responses: unknown[] = [[{ id }], auditRows];
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(responses[call++]), {
      status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/1" },
    }));
    const supabase = createClient("https://test.supabase.co", "test-anon-key", {
      global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const ctx = { supabase, orgId, userId, role: "scanner_operator" } satisfies AuthContext;

    const result = await getCardHistory(ctx, id);
    expect(result).toEqual(auditRows);
    const historyUrl = new URL(String(fetch.mock.calls[1][0]));
    expect(historyUrl.pathname).toContain("card_link_audit");
    expect(historyUrl.searchParams.get("org_id")).toBe(`eq.${orgId}`);
    expect(historyUrl.searchParams.get("member_id")).toBe(`eq.${id}`);
    expect(historyUrl.searchParams.get("order")).toBe("created_at.desc");
  });
});
