import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), getUser: vi.fn(), createUser: vi.fn(), deleteUser: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  enforceRateLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: mocks.from, rpc: mocks.rpc,
    auth: { admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser } },
  }),
}));
const { POST: reportLost } = await import("@/app/api/cards/report-lost/route");
const { GET: dashboard } = await import("@/app/api/students/me/route");
const { provisionStudent, verifyOtp } = await import("@/lib/auth/student");
const { POST: autofill } = await import("@/app/api/public/autofill/route");

function query(data: unknown, error: unknown = null): any {
  const result = { data, error };
  const chain: Record<string, unknown> = { then: (resolve: (r: unknown) => void) => Promise.resolve(result).then(resolve) };
  for (const method of ["select", "eq", "is", "gt", "order"]) chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => result);
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "current-user" } }, error: null });
  mocks.rpc.mockResolvedValue({ data: {}, error: null });
  mocks.deleteUser.mockResolvedValue({ error: null });
  mocks.createUser.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
});

describe("student endpoints", () => {
  it("reports loss using the authenticated person's identity", async () => {
    mocks.from.mockReturnValue(query({ person_id: "person" }));
    const result = await reportLost(new Request("http://localhost/api/cards/report-lost", { method: "POST" }));
    expect(result.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("report_lost_card", { p_person_id: "person" });
  });

  it("rejects another student's member ID before revoking a card", async () => {
    mocks.from.mockImplementation((table: string) => query(table === "logins" ? { person_id: "person" } : null));
    const result = await reportLost(new Request("http://localhost", { method: "POST", body: JSON.stringify({ memberId: "40000000-0000-4000-8000-000000000099" }) }));
    expect(result.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("denies anonymous dashboard and loss requests", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await dashboard()).status).toBe(401);
    expect((await reportLost(new Request("http://localhost", { method: "POST" }))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("propagates a failed dashboard query rather than returning empty history", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await dashboard()).status).toBe(500);
    log.mockRestore();
  });
});

describe("student provisioning", () => {
  const input = { email: "student@test.local", password: "strong-password", verificationToken: "a".repeat(64), full_name: "Student", student_number: "S1" };
  it("requires current verification before creating an auth account", async () => {
    mocks.from.mockReturnValue(query(null));
    await expect(provisionStudent(input, "signup")).rejects.toMatchObject({ status: 409 });
    expect(mocks.createUser).not.toHaveBeenCalled();
  });
  it("links the new login to a person and returns student context", async () => {
    mocks.from.mockReturnValue(query({ id: "proof" }));
    mocks.rpc.mockResolvedValue({ data: "person-id", error: null });
    await expect(provisionStudent(input, "signup")).resolves.toEqual({ user_id: "new-user", person_id: "person-id", role: "student" });
    expect(mocks.rpc).toHaveBeenCalledWith("provision_student_login", expect.objectContaining({ p_purpose: "signup", p_student_number: "S1" }));
  });
  it("rolls back the auth user when activation approval is missing", async () => {
    mocks.from.mockReturnValue(query({ id: "proof" }));
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP061" } });
    await expect(provisionStudent(input, "activation")).rejects.toMatchObject({ status: 403 });
    expect(mocks.deleteUser).toHaveBeenCalledWith("new-user");
  });
  it("reports cleanup failure rather than leaving an unexplained orphan account", async () => {
    mocks.from.mockReturnValue(query({ id: "proof" }));
    mocks.rpc.mockResolvedValue({ error: { code: "TP060" } });
    mocks.deleteUser.mockResolvedValue({ error: { message: "unavailable" } });
    await expect(provisionStudent(input, "signup")).rejects.toMatchObject({ status: 500 });
  });
  it("rejects invalid OTP results without issuing verification tokens", async () => {
    mocks.rpc.mockResolvedValue({ data: { verified: false }, error: null });
    await expect(verifyOtp(input.email, "123456", "signup")).rejects.toMatchObject({ status: 409 });
  });
});

it("autofill reads verified details without consuming the registration proof", async () => {
  mocks.from.mockImplementation((table: string) => {
    if (table === "registration_lookup_sessions") return query({ id: "session", org_id: "org", person_id: "person", autofill_token_expires_at: new Date(Date.now() + 60000).toISOString() });
    if (table === "events") return query({ id: "event", org_id: "org" });
    if (table === "members") return query({ full_name: "Student", student_number: "S1", email: "student@test.local", course: "CS" });
    return query([]);
  });
  const response = await autofill(new Request("http://localhost", {
    method: "POST", body: JSON.stringify({ autofillToken: "a".repeat(64), eventId: "50000000-0000-4000-8000-000000000001" }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { member: { student_number: "S1" } } });
});
