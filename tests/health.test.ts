import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: mocks.from }) }));

const { GET } = await import("@/app/api/health/route");

describe("health endpoint", () => {
  beforeEach(() => mocks.from.mockReset());

  it("reports success only when the database query succeeds", async () => {
    const select = vi.fn().mockResolvedValue({ count: 2, error: null });
    mocks.from.mockReturnValue({ select });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { db: "ok", orgs: 2 } });
  });

  it("returns 503 when the database is unavailable", async () => {
    const select = vi.fn().mockResolvedValue({ count: null, error: { message: "offline" } });
    mocks.from.mockReturnValue({ select });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
  });
});
