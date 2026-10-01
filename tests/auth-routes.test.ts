import { beforeEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  enforceRateLimit: vi.fn(async () => undefined),
}));

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(() => [{ name: "session", value: "old" }]),
  cookieSet: vi.fn(),
  createServerClient: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: mocks.cookieGet, set: mocks.cookieSet }) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";

const orgId = "11111111-1111-4111-8111-111111111111";
const activeProfile = { org_id: orgId, role: "org_admin", is_active: true };
type CookieBridge = { getAll: () => unknown[]; setAll: (values: { name: string; value: string; options?: object }[]) => void };
let cookieBridge: CookieBridge;
let query: ReturnType<typeof makeQuery>;
let auth: { signInWithPassword: ReturnType<typeof vi.fn>; signOut: ReturnType<typeof vi.fn>; getUser: ReturnType<typeof vi.fn> };
let studentLogin: { person_id: string } | null = null;

function makeQuery() {
  return {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: activeProfile, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: activeProfile, error: null }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  studentLogin = null;
  query = makeQuery();
  auth = {
    signInWithPassword: vi.fn(async () => {
      cookieBridge.setAll([{ name: "session", value: "new", options: { httpOnly: true } }]);
      return { data: { user: { id: "user-1" } }, error: null };
    }),
    signOut: vi.fn(async () => {
      cookieBridge.setAll([{ name: "session", value: "", options: { maxAge: 0 } }]);
      return { error: null };
    }),
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }),
  };
  mocks.createServerClient.mockImplementation((_url, _key, options) => {
    cookieBridge = options.cookies;
    return { auth, from: vi.fn((table: string) => {
      if (table === "profiles") return query;
      if (table === "logins") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: studentLogin, error: null }) }) }) };
      if (table === "organizations") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: orgId, name: "Test Org" }, error: null }) }) }) };
      if (table === "members") return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      throw new Error("Unexpected table " + table);
    }) };
  });
});

const loginRequest = () => new Request("http://localhost/api/auth/login", {
  method: "POST", body: JSON.stringify({ email: "admin@test.local", password: "password123" }),
});

test("login forwards Supabase cookies to the response cookie store and returns account context", async () => {
  const response = await login(loginRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, data: { user_id: "user-1", org_id: orgId, role: "org_admin", person_id: null } });
  expect(mocks.cookieSet).toHaveBeenCalledWith("session", "new", { httpOnly: true });
  expect(cookieBridge.getAll()).toEqual([{ name: "session", value: "old" }]);
});

test.each([null, { ...activeProfile, is_active: false }])("login rejects missing or inactive profiles and clears the new session", async (profile) => {
  query.maybeSingle.mockResolvedValue({ data: profile, error: null });
  const response = await login(loginRequest());
  expect(response.status).toBe(403);
  expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(mocks.cookieSet).toHaveBeenLastCalledWith("session", "", { maxAge: 0 });
});

test("invalid login credentials produce 401", async () => {
  auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: "bad password" } });
  expect((await login(loginRequest())).status).toBe(401);
  expect(query.select).not.toHaveBeenCalled();
});

test("malformed login JSON produces 422 before Supabase is called", async () => {
  expect((await login(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(422);
  expect(mocks.createServerClient).not.toHaveBeenCalled();
});

test("logout clears local session cookies", async () => {
  expect((await logout()).status).toBe(200);
  expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(mocks.cookieSet).toHaveBeenCalledWith("session", "", { maxAge: 0 });
});

test.each([null, { message: "expired refresh token" }])("me returns 401 without a verified session", async (error) => {
  auth.getUser.mockResolvedValue({ data: { user: null }, error });
  expect((await me()).status).toBe(401);
  expect(query.select).not.toHaveBeenCalled();
});

test("me returns the signed-in profile with organization", async () => {
  const profile = { id: "user-1", ...activeProfile, org: { id: orgId, name: "Test Org" } };
  query.maybeSingle.mockResolvedValue({ data: profile, error: null });
  const response = await me();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, data: { ...profile, is_staff: true, is_student: false, profile } });
  expect(query.eq).toHaveBeenCalledWith("id", "user-1");
  expect(response.headers.get("Cache-Control")).toContain("no-store");
});

test("students without organization profiles can log in and view account context", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  studentLogin = { person_id: "student-person" };
  const response = await login(loginRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { role: "student", person_id: "student-person", org_id: null } });
  const account = await me();
  expect(await account.json()).toMatchObject({ data: { is_student: true, is_staff: false, members: [] } });
});

test("me rejects inactive staff profiles even with a valid session", async () => {
  query.maybeSingle.mockResolvedValue({ data: { ...activeProfile, is_active: false }, error: null });
  expect((await me()).status).toBe(403);
});
