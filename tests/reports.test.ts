import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { ZodError } from "zod";
import type { AuthContext } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc, from: mocks.from }) }));

const { attendanceReport, memberSummaryReport, getMemberSummary, toMemberSummary, EXPORT_ROW_LIMIT } =
  await import("@/lib/reports");
const { issueCertificates, revokeCertificate, verifyCertificate, normalizeCertificateCode } =
  await import("@/lib/certificates");
const { adjustCredits, getMemberCredits } = await import("@/lib/credits");
const { renderTablePdf, toWinAnsi } = await import("@/lib/pdf");
const { readOptionalJson } = await import("@/lib/http");

const orgId = "e030dfb1-3186-493b-b58f-705603329231";
const userId = "9c6a2b1e-4f2a-4a2f-9a34-7b2f0e9a1234";
const eventId = "b2cf1e73-8d36-4a4b-86b7-b559ce4c4530";
const memberId = "1e9c9a1a-1111-4a4b-86b7-b559ce4c4530";
const certId = "3e9c9a1a-3333-4a4b-86b7-b559ce4c4530";

/** Same fetch-queue pattern as tests/events.test.ts. */
function context(bodies: unknown[] = [], role: AuthContext["role"] = "officer") {
  let call = 0;
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const body = bodies[Math.min(call, bodies.length - 1)] ?? [];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/1" },
    });
  });
  const supabase = createClient("https://test.supabase.co", "test-anon-key", {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  });
  return { ctx: { supabase, orgId, userId, role } satisfies AuthContext, fetch };
}

const attendanceRow = {
  event_id: eventId, event_title: "Orientation, Day 1", event_starts_at: "2026-01-01T09:00:00+00:00",
  event_status: "completed", member_id: memberId, student_number: "S-1", full_name: "Alice Peña",
  course: "BSCS", status: "late", time_in: "2026-01-01T09:30:00+00:00", time_out: null, method: "tap",
  certificate_eligible: true, certificate_id: certId, certificate_code: "AAAA-BBBB-CCCC-DDDD",
  certificate_revoked_at: "2026-02-01T00:00:00+00:00", total_count: 7,
};

const summaryRow = {
  member_id: memberId, student_number: "S-1", full_name: "Alice Peña", course: "BSCS", status: "active",
  credits: 15, present: 2, late: 1, walk_in: 1, absent: 1, current_tappies: 3, longest_tappies: 4,
  certificates_issued: 2, total_count: 1,
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.from.mockReset();
});

describe("attendanceReport", () => {
  it("rejects non-officers before calling the RPC", async () => {
    const { ctx } = context([], "scanner_operator");
    await expect(attendanceReport(ctx, {})).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes org-scoped filters and paginates, stripping total_count from rows", async () => {
    mocks.rpc.mockResolvedValue({ data: [attendanceRow], error: null });
    const { ctx } = context();
    const result = await attendanceReport(ctx, {
      event_id: eventId, status: "late, absent", course: "BSCS", search: "peña", page: "2", per_page: "5",
    });

    expect(mocks.rpc).toHaveBeenCalledWith("report_attendance", expect.objectContaining({
      p_org_id: orgId, p_event_id: eventId, p_statuses: ["late", "absent"], p_course: "BSCS",
      p_search: "peña", p_limit: 5, p_offset: 5,
    }));
    expect(result.kind).toBe("json");
    if (result.kind !== "json") return;
    expect(result.data.pagination).toEqual({ page: 2, per_page: 5, total: 7, total_pages: 2 });
    expect(result.data.rows[0]).not.toHaveProperty("total_count");
  });

  it("rejects unknown statuses and unknown query params", async () => {
    const { ctx } = context();
    await expect(attendanceReport(ctx, { status: "present,teleported" })).rejects.toBeInstanceOf(ZodError);
    await expect(attendanceReport(ctx, { nope: "1" })).rejects.toBeInstanceOf(ZodError);
  });

  it("exports CSV without pagination, quoting commas and marking revoked certificates", async () => {
    mocks.rpc.mockResolvedValue({ data: [attendanceRow], error: null });
    const { ctx } = context();
    const result = await attendanceReport(ctx, { format: "csv" });

    expect(mocks.rpc).toHaveBeenCalledWith("report_attendance", expect.objectContaining({
      p_limit: EXPORT_ROW_LIMIT + 1, p_offset: 0,
    }));
    if (result.kind !== "file") throw new Error("expected a file");
    expect(result.file.contentType).toBe("text/csv; charset=utf-8");
    const [header, line] = String(result.file.body).trim().split("\r\n");
    expect(header).toBe("event_title,event_starts_at,student_number,full_name,course,status,time_in,method,certificate_eligible,certificate_code");
    expect(line).toContain('"Orientation, Day 1"');
    expect(line).toContain("AAAA-BBBB-CCCC-DDDD (revoked)");
  });

  it("exports a PDF", async () => {
    mocks.rpc.mockResolvedValue({ data: [attendanceRow], error: null });
    const { ctx } = context();
    const result = await attendanceReport(ctx, { format: "pdf" });
    if (result.kind !== "file") throw new Error("expected a file");
    expect(result.file.filename).toMatch(/^attendance-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(Buffer.from(result.file.body as Uint8Array).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses an export larger than the row cap", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ ...attendanceRow, total_count: EXPORT_ROW_LIMIT + 1 }], error: null });
    const { ctx } = context();
    await expect(attendanceReport(ctx, { format: "csv" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("member summaries (credits + Tappies)", () => {
  it("derives attended and attendance_rate", () => {
    const summary = toMemberSummary(summaryRow as never);
    expect(summary.attended).toBe(4);
    expect(summary.attendance_rate).toBe(0.8);
    expect(toMemberSummary({ ...summaryRow, present: 0, late: 0, walk_in: 0, absent: 0 } as never).attendance_rate).toBeNull();
  });

  it("returns one member's summary, or 404 when the member isn't in the org", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [summaryRow], error: null });
    const { ctx } = context([], "scanner_operator");
    const summary = await getMemberSummary(ctx, memberId);
    expect(summary).toMatchObject({ credits: 15, current_tappies: 3, longest_tappies: 4 });
    expect(mocks.rpc).toHaveBeenCalledWith("report_member_summary", expect.objectContaining({ p_org_id: orgId, p_member_id: memberId }));

    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(getMemberSummary(ctx, memberId)).rejects.toMatchObject({ status: 404 });
  });

  it("exports the org-wide summary as CSV", async () => {
    mocks.rpc.mockResolvedValue({ data: [summaryRow], error: null });
    const { ctx } = context();
    const result = await memberSummaryReport(ctx, { format: "csv", status: "active" });
    if (result.kind !== "file") throw new Error("expected a file");
    const [header, line] = String(result.file.body).trim().split("\r\n");
    expect(header.split(",")).toContain("current_tappies");
    expect(line).toBe("S-1,Alice Peña,BSCS,active,15,4,1,1,1,0.8,3,4,2");
  });
});

describe("certificates", () => {
  it("issues via the RPC as the calling officer, and gates by role", async () => {
    mocks.rpc.mockResolvedValue({ data: { issued: 2, reinstated: 0, skipped: [] }, error: null });
    const { ctx } = context();
    expect(await issueCertificates(ctx, eventId, {})).toEqual({ issued: 2, reinstated: 0, skipped: [] });
    expect(mocks.rpc).toHaveBeenCalledWith("issue_certificates", {
      p_org_id: orgId, p_event_id: eventId, p_officer_id: userId, p_member_ids: null,
    });

    const { ctx: scanner } = context([], "scanner_operator");
    await expect(issueCertificates(scanner, eventId, {})).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ["TP040", 404], ["TP041", 409], ["TP042", 409],
  ])("maps issue_certificates %s to HTTP %i", async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "x" } });
    const { ctx } = context();
    await expect(issueCertificates(ctx, eventId, { member_ids: [memberId] })).rejects.toMatchObject({ status });
  });

  it.each([["TP043", 404], ["TP044", 409]])("maps revoke_certificate %s to HTTP %i", async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "x" } });
    const { ctx } = context();
    await expect(revokeCertificate(ctx, certId, { reason: "typo" })).rejects.toMatchObject({ status });
  });

  it("normalizes codes as typed by a verifier", () => {
    expect(normalizeCertificateCode("aaaa bbbb-cccc dddd")).toBe("AAAA-BBBB-CCCC-DDDD");
    expect(normalizeCertificateCode("AAAABBBBCCCCDDDD")).toBe("AAAA-BBBB-CCCC-DDDD");
    expect(normalizeCertificateCode("not-a-code")).toBeNull();
    expect(normalizeCertificateCode("AAAA-BBBB-CCCC-DDDD-EEEE")).toBeNull();
  });

  it("verifies publicly without leaking student data; revoked certificates verify as invalid", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: {
        code: "AAAA-BBBB-CCCC-DDDD", issued_at: "2026-01-02T00:00:00+00:00", revoked_at: "2026-02-01T00:00:00+00:00",
        members: { full_name: "Alice Peña" }, events: { title: "Orientation", starts_at: "2026-01-01T09:00:00+00:00" },
        organizations: { name: "Org" },
      }, error: null }),
    };
    mocks.from.mockReturnValue(query);

    const result = await verifyCertificate("aaaabbbbccccdddd");
    expect(query.eq).toHaveBeenCalledWith("code", "AAAA-BBBB-CCCC-DDDD");
    expect(query.select.mock.calls[0][0]).not.toMatch(/student_number|email/);
    expect(result).toMatchObject({ valid: false, recipient: "Alice Peña", organization: "Org" });
  });

  it("404s a malformed code without querying", async () => {
    await expect(verifyCertificate("../../etc")).rejects.toMatchObject({ status: 404 });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("credits", () => {
  it("validates manual adjustments before touching the database", async () => {
    const { ctx, fetch } = context();
    await expect(adjustCredits(ctx, memberId, { points: 0, reason: "x" })).rejects.toBeInstanceOf(ZodError);
    await expect(adjustCredits(ctx, memberId, { points: 5, reason: "event_attendance" })).rejects.toBeInstanceOf(ZodError);
    const { ctx: scanner } = context([], "scanner_operator");
    await expect(adjustCredits(scanner, memberId, { points: 5, reason: "bonus" })).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("writes through the service-role client, attributed to the officer", async () => {
    const entry = { id: "x", member_id: memberId, event_id: null, points: -3, reason: "penalty", awarded_by: userId, created_at: "now" };
    const single = vi.fn().mockResolvedValue({ data: entry, error: null });
    const insert = vi.fn(() => ({ select: () => ({ single }) }));
    mocks.from.mockReturnValue({ insert });
    const { ctx } = context([[{ id: memberId }]]);

    expect(await adjustCredits(ctx, memberId, { points: -3, reason: "penalty" })).toEqual(entry);
    expect(mocks.from).toHaveBeenCalledWith("points_ledger");
    expect(insert).toHaveBeenCalledWith({ org_id: orgId, member_id: memberId, event_id: null, points: -3, reason: "penalty", awarded_by: userId });
  });

  it("404s adjusting a member outside the org", async () => {
    const { ctx } = context([[]]);
    await expect(adjustCredits(ctx, memberId, { points: 5, reason: "bonus" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("reports the SQL-summed balance alongside the ledger page", async () => {
    mocks.rpc.mockResolvedValue({ data: [summaryRow], error: null });
    const { ctx, fetch } = context([[{ id: "e1", points: 10 }]]);
    const result = await getMemberCredits(ctx, memberId, { per_page: "10" });
    expect(result.balance).toBe(15);
    expect(result.entries).toHaveLength(1);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/rest/v1/points_ledger");
    expect(url.searchParams.get("org_id")).toBe(`eq.${orgId}`);
  });
});

describe("pdf + request helpers", () => {
  it("replaces characters the standard fonts cannot encode", () => {
    expect(toWinAnsi("Peña 李 🎉\nx")).toBe("Peña ? ?? x");
  });

  it("paginates long tables", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`Row ${i}`, "x".repeat(300)]);
    const bytes = await renderTablePdf({ title: "T", columns: [{ header: "A", width: 1 }, { header: "B", width: 1 }], rows });
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });

  it("readOptionalJson: empty body is {}, malformed JSON is a 422 (never silently {})", async () => {
    expect(await readOptionalJson(new Request("http://x", { method: "POST", body: "" }))).toEqual({});
    expect(await readOptionalJson(new Request("http://x", { method: "POST", body: '{"a":1}' }))).toEqual({ a: 1 });
    await expect(readOptionalJson(new Request("http://x", { method: "POST", body: "{member_ids:" })))
      .rejects.toMatchObject({ status: 422 });
  });
});
