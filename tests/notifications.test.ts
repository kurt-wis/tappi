import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), upsert: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: mocks.from }) }));
vi.mock("resend", () => ({ Resend: vi.fn() }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

const { queueAttendanceNotifications } = await import("@/lib/notifications");
const ctx = {
  orgId: "20000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000001",
  role: "officer" as const,
  supabase: {} as never,
};

function chain(finalMethod: string, result: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "lte", "gt", "order", "limit"]) {
    query[method] = vi.fn((..._args: unknown[]) => method === finalMethod ? Promise.resolve(result) : query);
  }
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return query;
}

describe("attendance notification queue", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
  });

  it("refuses alerts until an event is reconciled and finalized", async () => {
    mocks.from.mockReturnValue(chain("none", {
      data: { id: "event", title: "Orientation", status: "published", reconciled_at: null }, error: null,
    }));
    await expect(queueAttendanceNotifications(ctx, "event")).rejects.toMatchObject({ status: 409 });
  });

  it("queues email and push alerts idempotently for late and absent attendance", async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === "events") return chain("none", {
        data: { id: "event", title: "Orientation", status: "completed", reconciled_at: "2026-01-01T12:00:00Z" }, error: null,
      });
      if (table === "attendance") return chain("in", { data: [
        { member_id: "m1", status: "late", members: { email: "a@test.local", full_name: "Alice" } },
        { member_id: "m2", status: "absent", members: { email: null, full_name: "Bob" } },
      ], error: null });
      if (table === "notifications") return { upsert: mocks.upsert };
      throw new Error(`Unexpected table ${table}`);
    });
    await expect(queueAttendanceNotifications(ctx, "event")).resolves.toEqual({ queued: 3 });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ member_id: "m1", type: "late_alert", channel: "email" }),
      expect.objectContaining({ member_id: "m1", type: "late_alert", channel: "push" }),
      expect.objectContaining({ member_id: "m2", type: "absentee_alert", channel: "push" }),
    ]), expect.objectContaining({ ignoreDuplicates: true }));
  });
});
