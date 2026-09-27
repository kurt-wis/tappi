import { describe, it, expect, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/lib/supabase/server";
import { archiveMember, createMember, getMember, listMembers, updateMember } from "@/lib/members";
import { handler, readJson } from "@/lib/http";

const orgId = "e030dfb1-3186-493b-b58f-705603329231";
const id = "b2cf1e73-8d36-4a4b-86b7-b559ce4c4530";
const member = { id, org_id: orgId, full_name: "Test Student", student_number: "2026-1" };

function context(body: unknown = [member], status = 200, role: AuthContext["role"] = "officer") {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Content-Range": "0-0/1" },
  }));
  const supabase = createClient("https://test.supabase.co", "test-anon-key", {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  });
  return { ctx: { supabase, orgId, userId: id, role } satisfies AuthContext, fetch };
}

describe("organization-scoped member operations", () => {
  it("caps pagination, filters status/search, and always scopes list queries to the session org", async () => {
    const { ctx, fetch } = context();
    const result = await listMembers(ctx, { page: "2", per_page: "1000", search: "Student", status: "active" });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get("org_id")).toBe(`eq.${orgId}`);
    expect(url.searchParams.get("status")).toBe("eq.active");
    expect(url.searchParams.get("or")).toContain('full_name.ilike."%Student%"');
    expect(url.searchParams.get("offset")).toBe("200");
    expect(url.searchParams.get("limit")).toBe("200");
    expect(result.pagination).toEqual({ page: 2, per_page: 200, total: 1, total_pages: 1 });
  });

  it("defaults to 50 and rejects invalid pagination before querying", async () => {
    const { ctx, fetch } = context();
    expect((await listMembers(ctx, {})).pagination.per_page).toBe(50);
    fetch.mockClear();
    await expect(listMembers(ctx, { page: "0" })).rejects.toThrow();
    await expect(listMembers(ctx, { per_page: "NaN" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps PostgREST metacharacters inside a quoted search value", async () => {
    const { ctx, fetch } = context();
    await listMembers(ctx, { search: 'A,B).status.eq.active,"_%' });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get("org_id")).toBe(`eq.${orgId}`);
    expect(url.searchParams.get("or")).toContain('\\"');
    expect(url.searchParams.get("or")).toContain('\\\\_');
    expect(url.searchParams.get("or")).toContain('\\\\%');
  });

  it("reports duplicate student numbers as a conflict", async () => {
    const { ctx } = context({ code: "23505", message: "duplicate key" }, 409);
    await expect(createMember(ctx, { student_number: "2026-1", full_name: "Student", member_role: "member" }))
      .rejects.toMatchObject({ status: 409, message: "Student number already exists in this organization" });
  });

  it("rejects scanner writes and caller-supplied tenant/card/student-number edits", async () => {
    const scanner = context([], 200, "scanner_operator");
    await expect(createMember(scanner.ctx, {})).rejects.toMatchObject({ status: 403 });
    await expect(updateMember(scanner.ctx, id, { full_name: "Changed" })).rejects.toMatchObject({ status: 403 });
    await expect(archiveMember(scanner.ctx, id)).rejects.toMatchObject({ status: 403 });
    expect(scanner.fetch).not.toHaveBeenCalled();
    const { ctx, fetch } = context();
    for (const input of [{ student_number: "other" }, { card_uid: "123" }, { org_id: id }, {}]) {
      await expect(updateMember(ctx, id, input)).rejects.toThrow();
    }
    await expect(createMember(ctx, { ...member, member_role: "member" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 404 for another organization's member on read/update/archive", async () => {
    const { ctx, fetch } = context([]);
    await expect(getMember(ctx, id)).rejects.toMatchObject({ status: 404 });
    await expect(updateMember(ctx, id, { full_name: "Changed" })).rejects.toMatchObject({ status: 404 });
    await expect(archiveMember(ctx, id)).rejects.toMatchObject({ status: 404 });
    for (const call of fetch.mock.calls) {
      const url = new URL(String(call[0]));
      expect(url.searchParams.get("org_id")).toBe(`eq.${orgId}`);
      expect(url.searchParams.get("id")).toBe(`eq.${id}`);
    }
  });

  it("archives via PATCH without deleting the member", async () => {
    const { ctx, fetch } = context([{ ...member, status: "archived" }], 200, "org_admin");
    expect(await archiveMember(ctx, id)).toMatchObject({ status: "archived" });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ status: "archived" });
  });

  it("returns 422 for malformed JSON", async () => {
    const response = await handler(async (request: Request) => {
      await readJson(request);
      return new Response();
    })(new Request("http://localhost/api/members", { method: "POST", body: "{" }));
    expect(response.status).toBe(422);
  });
});
