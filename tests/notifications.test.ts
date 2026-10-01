import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), upsert: vi.fn(), rpc: vi.fn(), emailSend: vi.fn(), push: vi.fn(), update: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<object>()), recordAudit: vi.fn() }));
vi.mock("resend", () => ({ Resend: class { emails = { send: mocks.emailSend }; } }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: mocks.push } }));
vi.mock("@/lib/env", () => ({ env: { RESEND_API_KEY: "test", EMAIL_FROM: "test@example.test", VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private", VAPID_SUBJECT: "mailto:test@example.test" } }));

const { queueAttendanceNotifications, deliverDueNotifications } = await import("@/lib/notifications");
const ctx = {
  orgId: "20000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000001",
  role: "officer" as const,
  supabase: {} as never,
};

function chain(finalMethod: string, result: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "or", "is", "lte", "gt", "order", "limit"]) {
    query[method] = vi.fn((..._args: unknown[]) => method === finalMethod ? Promise.resolve(result) : query);
  }
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return query;
}

describe("attendance notification queue", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.upsert.mockReset().mockResolvedValue({ count: 3, error: null });
    mocks.from.mockImplementation((table: string) => {
      if (table === "events") return chain("none", {
        data: { id: "event", title: "Orientation", status: "completed", reconciled_at: "2026-01-01T12:00:00Z" }, error: null,
      });
      if (table === "attendance") return chain("or", { data: [
        { member_id: "m1", status: "late", members: { email: "a@test.local", full_name: "Alice" } },
        { member_id: "m2", status: "absent", members: { email: null, full_name: "Bob" } },
      ], error: null });
      if (table === "notifications") return { upsert: mocks.upsert };
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("refuses alerts until an event is reconciled and finalized", async () => {
    mocks.from.mockReturnValue(chain("none", {
      data: { id: "event", title: "Orientation", status: "published", reconciled_at: null }, error: null,
    }));
    await expect(queueAttendanceNotifications(ctx, "event")).rejects.toMatchObject({ status: 409 });
  });

  it("queues email and push alerts idempotently for late and absent attendance", async () => {
    await expect(queueAttendanceNotifications(ctx, "event")).resolves.toEqual({ queued: 3 });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ member_id: "m1", type: "late_alert", channel: "email" }),
      expect.objectContaining({ member_id: "m1", type: "late_alert", channel: "push" }),
      expect.objectContaining({ member_id: "m2", type: "absentee_alert", channel: "push" }),
    ]), { onConflict: "event_id,member_id,type,channel", ignoreDuplicates: true, count: "exact" });
    mocks.upsert.mockResolvedValueOnce({ count: 0, error: null });
    await expect(queueAttendanceNotifications(ctx, "event")).resolves.toEqual({ queued: 0 });
  });

  it("counts only newly inserted notices when some already exist", async () => {
    mocks.upsert.mockResolvedValueOnce({ count: 1, error: null });
    await expect(queueAttendanceNotifications(ctx, "event")).resolves.toEqual({ queued: 1 });
  });

  it("does not report a count when the insert fails", async () => {
    const error = new Error("Insert failed");
    mocks.upsert.mockResolvedValueOnce({ count: null, error });
    await expect(queueAttendanceNotifications(ctx, "event")).rejects.toBe(error);
  });

  it("rejects a missing database count instead of guessing", async () => {
    mocks.upsert.mockResolvedValueOnce({ count: null, error: null });
    await expect(queueAttendanceNotifications(ctx, "event")).rejects.toThrow("Notification insert returned no count");
  });

  it("skips inserting when no attendance needs an alert", async () => {
    mocks.from.mockReturnValueOnce(chain("none", {
      data: { id: "event", title: "Orientation", status: "completed", reconciled_at: "2026-01-01T12:00:00Z" }, error: null,
    })).mockReturnValueOnce(chain("or", { data: [], error: null }));
    await expect(queueAttendanceNotifications(ctx, "event")).resolves.toEqual({ queued: 0 });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("notification delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emailSend.mockResolvedValue({ error: null });
    mocks.push.mockResolvedValue({});
    mocks.update.mockImplementation(() => ({ eq: async () => ({ error: null }) }));
    mocks.from.mockImplementation((table: string) => table === "notifications"
      ? { update: mocks.update }
      : { select: () => ({ eq: async () => ({ data: [], error: null }) }) });
  });

  it("sends leased emails with a stable provider idempotency key", async () => {
    mocks.rpc.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({
      data: [{ id: "notice-1", channel: "email", recipient: "student@example.test", title: "Reminder", body: "Hello" }], error: null,
    });
    await expect(deliverDueNotifications()).resolves.toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(mocks.emailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "student@example.test" }), { idempotencyKey: "notification-notice-1" });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ sent_at: expect.any(String), claimed_at: null }));
  });

  it("records provider delivery failures instead of marking them sent", async () => {
    mocks.rpc.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({
      data: [{ id: "notice-2", channel: "email", recipient: "student@example.test", title: "Reminder" }], error: null,
    });
    mocks.emailSend.mockResolvedValue({ error: new Error("Delivery rejected") });
    await expect(deliverDueNotifications()).resolves.toEqual({ processed: 1, sent: 0, failed: 1 });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ failed_at: expect.any(String), failure: "Delivery rejected" }));
  });

  it("does not report an undelivered push with no subscription as sent", async () => {
    mocks.rpc.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({
      data: [{ id: "notice-3", channel: "push", member_id: "member", title: "Reminder" }], error: null,
    });
    await expect(deliverDueNotifications()).resolves.toEqual({ processed: 1, sent: 0, failed: 1 });
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
