import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), requireAuth: vi.fn(), recordAudit: vi.fn(), enforceRateLimit: vi.fn(),
  tables: {} as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "order", "returns"]) chain[method] = () => chain;
      chain.maybeSingle = async () => ({ data: mocks.tables[table] ?? null, error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/supabase/server")>(),
  requireAuth: mocks.requireAuth,
}));
vi.mock("@/lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  enforceRateLimit: mocks.enforceRateLimit,
}));

const { GET: getSettings, PUT: putSettings } = await import("@/app/api/settings/registration-form/route");
const { PUT: putEventForm } = await import("@/app/api/events/[id]/form/route");
const { POST: register } = await import("@/app/api/public/events/[id]/register/route");
const { GET: publicEvent } = await import("@/app/api/public/events/[id]/route");

const orgId = "e030dfb1-3186-493b-b58f-705603329231";
const userId = "9c6a2b1e-4f2a-4a2f-9a34-7b2f0e9a1234";
const eventId = "b2cf1e73-8d36-4a4b-86b7-b559ce4c4530";

const yearLevel = { key: "year_level", label: "Year level", type: "select", required: true, options: ["1", "2", "3", "4"] };
const dietary = { key: "dietary_notes", label: "Dietary notes", type: "textarea", required: false };

function ctx(role: AuthContext["role"]) {
  return { supabase: {} as AuthContext["supabase"], orgId, userId, role } satisfies AuthContext;
}
const json = (method: string, body: unknown) => ({
  method, body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
});
const eventRoute = () => ({ params: Promise.resolve({ id: eventId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tables = {};
  mocks.enforceRateLimit.mockResolvedValue(undefined);
});

describe("org default registration fields", () => {
  it("returns the stored org defaults", async () => {
    mocks.requireAuth.mockResolvedValue(ctx("scanner_operator"));
    mocks.tables.organizations = { settings: { registration_fields: [yearLevel], other: true } };
    const response = await getSettings();
    expect(await response.json()).toEqual({ ok: true, data: { fields: [yearLevel] } });
  });

  it("only lets org admins change them", async () => {
    mocks.requireAuth.mockResolvedValue(ctx("officer"));
    const response = await putSettings(new Request("http://localhost/api/settings/registration-form", json("PUT", { fields: [] })));
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("validates definitions before saving", async () => {
    mocks.requireAuth.mockResolvedValue(ctx("org_admin"));
    const response = await putSettings(new Request("http://localhost/x",
      json("PUT", { fields: [{ key: "year", label: "Year", type: "select" }] })));
    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("saves normalized definitions atomically and audits the change", async () => {
    mocks.requireAuth.mockResolvedValue(ctx("org_admin"));
    const fields = [{ key: "dietary_notes", label: " Dietary notes ", type: "textarea" }];
    mocks.rpc.mockResolvedValue({ data: [dietary], error: null });
    const response = await putSettings(new Request("http://localhost/x", json("PUT", { fields })));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("set_org_registration_fields", { p_org_id: orgId, p_fields: [dietary] });
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ orgId, userId }), expect.objectContaining({
      action: "org.registration_form_updated", metadata: { field_keys: ["dietary_notes"] },
    }));
  });
});

describe("per-event form fields", () => {
  it("rejects scanner operators", async () => {
    mocks.requireAuth.mockResolvedValue(ctx("scanner_operator"));
    const response = await putEventForm(new Request("http://localhost/x", json("PUT", { fields: [] })), eventRoute());
    expect(response.status).toBe(403);
  });

  it("maps a locked event to 409", async () => {
    mocks.requireAuth.mockResolvedValue(ctx("officer"));
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP071", message: "locked" } });
    const response = await putEventForm(new Request("http://localhost/x", json("PUT", { fields: [yearLevel] })), eventRoute());
    expect(response.status).toBe(409);
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("saves the event fields and returns the merged form", async () => {
    mocks.requireAuth.mockResolvedValue(ctx("officer"));
    mocks.tables.organizations = { settings: { registration_fields: [dietary] } };
    mocks.rpc.mockResolvedValue({ data: { id: eventId, form_fields: [yearLevel] }, error: null });
    const response = await putEventForm(new Request("http://localhost/x", json("PUT", { fields: [yearLevel] })), eventRoute());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("set_event_form_fields", { p_org_id: orgId, p_event_id: eventId, p_fields: [yearLevel] });
    expect(body.data.fields.map((f: { key: string }) => f.key))
      .toEqual(["full_name", "student_number", "email", "dietary_notes", "year_level"]);
  });
});

describe("public registration with a custom form", () => {
  const publishedEvent = {
    id: eventId, org_id: orgId, status: "published", slots: null, walk_in_policy: "closed", form_fields: [yearLevel],
  };
  const base = { full_name: "Ana Cruz", student_number: "2026-0001", email: "ana@example.edu" };
  const post = (body: unknown) => register(new Request(`http://localhost/api/public/events/${eventId}/register`, json("POST", body)), eventRoute());

  beforeEach(() => {
    mocks.tables.events = publishedEvent;
    mocks.tables.organizations = { settings: { registration_fields: [dietary] } };
  });

  it("rejects answers that fail the event's validation without registering", async () => {
    const response = await post({ ...base, answers: { year_level: "5" } });
    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects missing required answers", async () => {
    const response = await post({ ...base, answers: { dietary_notes: "none" } });
    expect(response.status).toBe(422);
  });

  it("stores validated answers with a snapshot of the custom fields", async () => {
    mocks.rpc.mockResolvedValue({ data: { id: "reg-1", status: "pending" }, error: null });
    const response = await post({ ...base, answers: { year_level: "2", dietary_notes: "  " } });
    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledWith("register_for_event", expect.objectContaining({
      p_student_number: "20260001",
      p_answers: { year_level: "2" },
      p_form_snapshot: [{ ...dietary, source: "org_default" }, { ...yearLevel, source: "event_extra" }],
    }));
  });

  it("applies per-IP and per-student rate limits", async () => {
    mocks.rpc.mockResolvedValue({ data: { id: "reg-1" }, error: null });
    await post({ ...base, answers: { year_level: "1" } });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({ name: "public.register.ip" }), "203.0.113.9");
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({ name: "public.register.student" }), eventId, "20260001");
  });

  it("rejects a student number that is empty after normalization", async () => {
    const response = await post({ ...base, student_number: " - - ", answers: { year_level: "1" } });
    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed event id instead of a database error", async () => {
    const response = await register(new Request("http://localhost/x", json("POST", { ...base, answers: {} })),
      { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(404);
  });

  it("serves the merged form on the public event page", async () => {
    mocks.tables.events = { ...publishedEvent, title: "Orientation", certificate_enabled: false, points_value: 0 };
    const response = await publicEvent(new Request("http://localhost/x"), eventRoute());
    const body = await response.json();
    expect(body.data).not.toHaveProperty("org_id");
    expect(body.data.form_fields.map((f: { key: string; source: string }) => `${f.key}:${f.source}`)).toEqual([
      "full_name:base", "student_number:base", "email:base", "dietary_notes:org_default", "year_level:event_extra",
    ]);
  });
});
