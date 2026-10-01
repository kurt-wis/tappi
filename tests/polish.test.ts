import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), insert: vi.fn(), requireAuth: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc, from: () => ({ insert: mocks.insert }) }),
}));
vi.mock("@/lib/supabase/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/supabase/server")>(),
  requireAuth: mocks.requireAuth,
}));

const { enforceRateLimit, clientIp, rateLimitKey, RATE_LIMITS } = await import("@/lib/rate-limit");
const { handler } = await import("@/lib/http");
const { recordAudit, listAuditLogs } = await import("@/lib/audit");
const { createDevice, deleteDevice, updateDevice } = await import("@/lib/devices");
const { recordScan, recordScanBatch } = await import("@/lib/scan");
const { POST: restore } = await import("@/app/api/backup/restore/route");
const { GET: exportBackup } = await import("@/app/api/backup/route");

const orgId = "e030dfb1-3186-493b-b58f-705603329231";
const userId = "9c6a2b1e-4f2a-4a2f-9a34-7b2f0e9a1234";
const eventId = "b2cf1e73-8d36-4a4b-86b7-b559ce4c4530";

function context(role: AuthContext["role"], body: unknown = [], status = 200) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Content-Range": "0-0/1" },
  }));
  const supabase = createClient("https://test.supabase.co", "test-anon-key", {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  });
  return { ctx: { supabase, orgId, userId, role } satisfies AuthContext, fetch };
}

/** Routes rpc calls by function name; consume_rate_limit always allows unless overridden. */
function routeRpc(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  mocks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (handlers[fn]) return handlers[fn](args);
    if (fn === "consume_rate_limit") return { data: { allowed: true, remaining: 1, retry_after: 1 }, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insert.mockResolvedValue({ error: null });
});

describe("rate limiting", () => {
  it("derives the client IP from proxy headers", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } }))).toBe("203.0.113.5");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "198.51.100.7" } }))).toBe("198.51.100.7");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });

  it("hashes identifiers so raw IPs are never stored", () => {
    const key = rateLimitKey(RATE_LIMITS.loginIp, ["203.0.113.5"]);
    expect(key).toMatch(/^auth\.login\.ip:[0-9a-f]{64}$/);
    expect(key).not.toContain("203.0.113.5");
    expect(rateLimitKey(RATE_LIMITS.loginIp, ["a", "bc"])).not.toBe(rateLimitKey(RATE_LIMITS.loginIp, ["ab", "c"]));
  });

  it("passes when the bucket allows the request", async () => {
    routeRpc({});
    await expect(enforceRateLimit(RATE_LIMITS.loginIp, "203.0.113.5")).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_key: rateLimitKey(RATE_LIMITS.loginIp, ["203.0.113.5"]), p_limit: 30, p_window_seconds: 300,
    });
  });

  it("responds 429 with Retry-After when the limit is exceeded", async () => {
    routeRpc({ consume_rate_limit: () => ({ data: { allowed: false, remaining: 0, retry_after: 42 }, error: null }) });
    const route = handler(async () => {
      await enforceRateLimit(RATE_LIMITS.loginIp, "203.0.113.5");
      return new Response("unreachable");
    });
    const response = await route();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "rate_limited", details: { retry_after: 42 } } });
  });

  it("fails closed when the limiter cannot be consulted", async () => {
    routeRpc({ consume_rate_limit: () => ({ data: null, error: { message: "db down" } }) });
    await expect(enforceRateLimit(RATE_LIMITS.loginIp, "x")).rejects.toMatchObject({ message: "db down" });
  });
});

describe("audit logging", () => {
  it("records the actor, org, and entry", async () => {
    await recordAudit({ orgId, userId }, { action: "event.created", entity: "events", entity_id: eventId, metadata: { title: "T" } });
    expect(mocks.insert).toHaveBeenCalledWith({
      org_id: orgId, actor_id: userId, action: "event.created", entity: "events", entity_id: eventId,
      metadata: { title: "T" }, ip: null, user_agent: null,
    });
  });

  it("never turns a committed action into an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.insert.mockResolvedValue({ error: { message: "insert failed" } });
    await expect(recordAudit({ orgId, userId }, { action: "x", entity: "y" })).resolves.toBeUndefined();
    mocks.insert.mockRejectedValue(new Error("network"));
    await expect(recordAudit({ orgId, userId }, { action: "x", entity: "y" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("is readable by org admins only, with filters", async () => {
    await expect(listAuditLogs(context("officer").ctx, {})).rejects.toMatchObject({ status: 403 });
    const { ctx, fetch } = context("org_admin");
    await listAuditLogs(ctx, { action: "event.created", entity_id: eventId, from: "2026-01-01T00:00:00Z", per_page: "500" });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toContain("audit_logs");
    expect(url.searchParams.get("org_id")).toBe(`eq.${orgId}`);
    expect(url.searchParams.get("action")).toBe("eq.event.created");
    expect(url.searchParams.get("entity_id")).toBe(`eq.${eventId}`);
    expect(url.searchParams.get("created_at")).toBe("gte.2026-01-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("200");
  });

  it("rejects unknown filters", async () => {
    await expect(listAuditLogs(context("org_admin").ctx, { sql: "1" })).rejects.toHaveProperty("issues");
  });
});

describe("device inventory", () => {
  it("registers a device for the caller's org", async () => {
    const device = { id: "11111111-1111-4111-8111-111111111111", device_id: "TAP-01", kind: "tapper", status: "active" };
    const { ctx, fetch } = context("officer", device);
    await createDevice(ctx, { device_id: " TAP-01 ", label: "Front door" });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      device_id: "TAP-01", label: "Front door", kind: "tapper", status: "active", org_id: orgId, registered_by: userId,
    });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ action: "device.registered" }));
  });

  it("maps duplicate device ids to 409", async () => {
    const { ctx } = context("officer", { code: "23505", message: "duplicate" }, 409);
    await expect(createDevice(ctx, { device_id: "TAP-01" })).rejects.toMatchObject({ status: 409 });
  });

  it("restricts writes by role", async () => {
    await expect(createDevice(context("scanner_operator").ctx, { device_id: "TAP-01" })).rejects.toMatchObject({ status: 403 });
    await expect(deleteDevice(context("officer").ctx, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ status: 403 });
  });

  it("does not allow renaming the device id that scans reference", async () => {
    await expect(updateDevice(context("officer").ctx, "11111111-1111-4111-8111-111111111111", { device_id: "NEW" }))
      .rejects.toHaveProperty("issues");
  });
});

describe("scans from inventoried devices", () => {
  const attendance = { id: "a1", event_id: eventId, status: "present" };
  const scan = (device_id: string, extra: Record<string, unknown> = {}) => ({ event_id: eventId, card_uid: "123", device_id, ...extra });

  it("rejects a lost or retired device before recording and audits it", async () => {
    routeRpc({ touch_devices: () => ({ data: [{ device_id: "TAP-LOST", status: "lost" }], error: null }) });
    await expect(recordScan(context("scanner_operator").ctx, scan("TAP-LOST"))).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalledWith("record_scan", expect.anything());
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ action: "scan.device_blocked", entity_id: "TAP-LOST" }));
  });

  it("lets unregistered and maintenance devices scan", async () => {
    routeRpc({
      touch_devices: () => ({ data: [{ device_id: "TAP-M", status: "maintenance" }], error: null }),
      record_scan: () => ({ data: attendance, error: null }),
    });
    await expect(recordScan(context("scanner_operator").ctx, scan("TAP-M"))).resolves.toEqual(attendance);
    await expect(recordScan(context("scanner_operator").ctx, scan("UNKNOWN"))).resolves.toEqual(attendance);
  });

  it("checks devices once per batch and rejects only the blocked scans", async () => {
    routeRpc({
      touch_devices: () => ({ data: [{ device_id: "TAP-OLD", status: "retired" }, { device_id: "TAP-OK", status: "active" }], error: null }),
      record_scan: () => ({ data: attendance, error: null }),
    });
    const at = { scanned_at: "2026-10-01T09:00:00Z" };
    const result = await recordScanBatch(context("officer").ctx, { scans: [
      scan("TAP-OK", { ...at, client_scan_id: "1" }),
      scan("TAP-OLD", { ...at, client_scan_id: "2" }),
      scan("TAP-OLD", { ...at, client_scan_id: "3" }),
      scan("TAP-OK", { ...at, client_scan_id: "4" }),
    ] });
    expect(result.summary).toEqual({ total: 4, succeeded: 2, failed: 2 });
    expect(result.results[1]).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const touches = mocks.rpc.mock.calls.filter(([fn]) => fn === "touch_devices");
    expect(touches).toEqual([["touch_devices", { p_org_id: orgId, p_device_ids: ["TAP-OK", "TAP-OLD"] }]]);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      action: "scan.device_blocked", metadata: expect.objectContaining({ rejected_scans: 2 }),
    }));
  });
});

describe("backup and restore", () => {
  const backup = { format: "tappi.org-backup", version: 1, org_id: orgId, data: { members: [] } };
  const restoreRequest = (body: unknown) => restore(new Request("http://localhost/api/backup/restore", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }));

  it("is limited to org admins", async () => {
    mocks.requireAuth.mockResolvedValue(context("officer").ctx);
    expect((await restoreRequest({ backup })).status).toBe(403);
    expect((await exportBackup()).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("defaults to a dry run", async () => {
    mocks.requireAuth.mockResolvedValue(context("org_admin").ctx);
    const summary = { dry_run: true, settings_restored: false, in_backup: { members: 0 }, inserted: { members: 0 } };
    routeRpc({ restore_org_backup: () => ({ data: summary, error: null }) });
    const response = await restoreRequest({ backup });
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("restore_org_backup", {
      p_org_id: orgId, p_backup: backup, p_dry_run: true, p_restore_settings: false,
    });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ action: "backup.restore_previewed" }));
  });

  it("refuses a backup from another organization before touching the database", async () => {
    mocks.requireAuth.mockResolvedValue(context("org_admin").ctx);
    routeRpc({});
    const response = await restoreRequest({ backup: { ...backup, org_id: "11111111-1111-4111-8111-111111111111" }, dry_run: false });
    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalledWith("restore_org_backup", expect.anything());
  });

  it.each([
    [{ ...backup, format: "other" }, "wrong format"],
    [{ ...backup, version: 2 }, "future version"],
    [{ ...backup, data: { members: "x" } }, "section not an array"],
    [{ ...backup, data: { members: [1] } }, "row not an object"],
  ])("rejects a malformed backup: %j (%s)", async (bad, _reason) => {
    mocks.requireAuth.mockResolvedValue(context("org_admin").ctx);
    routeRpc({});
    expect((await restoreRequest({ backup: bad })).status).toBe(422);
  });

  it("reports invalid row data as a validation error", async () => {
    mocks.requireAuth.mockResolvedValue(context("org_admin").ctx);
    routeRpc({ restore_org_backup: () => ({ data: null, error: { code: "23502", message: "null value in column \"title\"" } }) });
    const response = await restoreRequest({ backup, dry_run: false });
    expect(response.status).toBe(422);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("exports a downloadable JSON file", async () => {
    mocks.requireAuth.mockResolvedValue(context("org_admin").ctx);
    routeRpc({ export_org_backup: () => ({ data: { ...backup, organization: { slug: "my org" } }, error: null }) });
    const response = await exportBackup();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="tappi-backup-my-org-.*\.json"$/);
    expect(JSON.parse(await response.text())).toMatchObject({ format: "tappi.org-backup", org_id: orgId });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ action: "backup.exported" }));
  });
});
