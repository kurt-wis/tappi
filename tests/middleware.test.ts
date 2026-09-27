import { beforeEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
import { middleware } from "@/middleware";

type CookieBridge = { getAll: () => unknown[]; setAll: (values: { name: string; value: string; options?: object }[]) => void };
let cookieBridge: CookieBridge;
let getUser: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  getUser = vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mocks.createServerClient.mockImplementation((_url, _key, options) => {
    cookieBridge = options.cookies;
    return { auth: { getUser } };
  });
});

test("refresh updates request and response cookies and preserves multiple cookie writes", async () => {
  const request = new NextRequest("http://localhost/dashboard", { headers: { cookie: "session=old" } });
  getUser.mockImplementation(async () => {
    expect(cookieBridge.getAll()).toContainEqual({ name: "session", value: "old" });
    cookieBridge.setAll([{ name: "session", value: "fresh", options: { httpOnly: true } }]);
    cookieBridge.setAll([{ name: "second", value: "fresh-too" }]);
    return { data: { user: { id: "user-1" } }, error: null };
  });
  const response = await middleware(request);
  expect(request.cookies.get("session")?.value).toBe("fresh");
  expect(response.cookies.get("session")?.value).toBe("fresh");
  expect(response.cookies.get("second")?.value).toBe("fresh-too");
  expect(response.headers.get("x-middleware-request-cookie")).toContain("session=fresh");
});

test("missing session redirects a protected page while preserving cookie cleanup", async () => {
  getUser.mockImplementation(async () => {
    cookieBridge.setAll([{ name: "session", value: "", options: { maxAge: 0 } }]);
    return { data: { user: null }, error: null };
  });
  const response = await middleware(new NextRequest("http://localhost/dashboard?tab=members"));
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location")!);
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("next")).toBe("/dashboard?tab=members");
  expect(response.cookies.get("session")?.maxAge).toBe(0);
});

test("expired sessions get API 401 with cookie cleanup preserved", async () => {
  getUser.mockImplementation(async () => {
    cookieBridge.setAll([{ name: "session", value: "", options: { maxAge: 0 } }]);
    return { data: { user: null }, error: { message: "expired" } };
  });
  const response = await middleware(new NextRequest("http://localhost/api/members"));
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("unauthorized");
  expect(response.cookies.get("session")?.maxAge).toBe(0);
});

test.each(["/api/auth/login", "/api/auth/me", "/api/public/events", "/login", "/signup"])("public path %s bypasses middleware authentication", async (path) => {
  expect((await middleware(new NextRequest(`http://localhost${path}`))).status).toBe(200);
  expect(mocks.createServerClient).not.toHaveBeenCalled();
});

test.each(["/api/authentication", "/api/publicity"])("similar path prefix %s cannot bypass authentication", async (path) => {
  getUser.mockResolvedValue({ data: { user: null }, error: null });
  expect((await middleware(new NextRequest(`http://localhost${path}`))).status).toBe(401);
  expect(getUser).toHaveBeenCalledOnce();
});
