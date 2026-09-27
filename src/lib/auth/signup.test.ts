import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signupOrganization, signupSchema } from "./signup";

const input = signupSchema.parse({
  org_name: "Test Org", org_slug: "test-org", full_name: "Test Admin",
  email: "admin@test.local", password: "password123",
});

function mockAdmin(failure?: "account" | "org" | "profile" | "cleanup") {
  const operations: string[] = [];
  const client = {
    auth: { admin: {
      createUser: async (values: { email_confirm: boolean }) => {
        assert.equal(values.email_confirm, true);
        operations.push("create account");
        return failure === "account"
          ? { data: {}, error: { code: "email_exists" } }
          : { data: { user: { id: "new-user" } }, error: null };
      },
      deleteUser: async (id: string) => {
        operations.push(`delete account ${id}`);
        return { error: null };
      },
    } },
    from: (table: string) => ({
      insert: (values: Record<string, unknown>) => {
        operations.push(`insert ${table}`);
        if (table === "profiles") {
          assert.equal(values.id, "new-user");
          assert.equal(values.org_id, "new-org");
          assert.equal(values.role, "org_admin");
          return Promise.resolve({ error: failure === "profile" || failure === "cleanup" ? { message: "profile failed" } : null });
        }
        return { select: () => ({ single: async () => failure === "org"
          ? { data: null, error: { code: "23505" } }
          : { data: { id: "new-org" }, error: null },
        }) };
      },
      delete: () => ({ eq: async (column: string, id: string) => {
        assert.equal(column, "id");
        operations.push(`delete ${table} ${id}`);
        return { error: failure === "cleanup" ? { message: "delete failed" } : null };
      } }),
    }),
  };
  return { client: client as unknown as SupabaseClient, operations };
}

test("signup provisions account, org, and fixed admin profile in order", async () => {
  const { client, operations } = mockAdmin();
  assert.deepEqual(await signupOrganization(client, input), {
    user_id: "new-user", org_id: "new-org", role: "org_admin",
  });
  assert.deepEqual(operations, ["create account", "insert organizations", "insert profiles"]);
});

test("duplicate email never deletes an existing account", async () => {
  const { client, operations } = mockAdmin("account");
  await assert.rejects(signupOrganization(client, input), { status: 409 });
  assert.deepEqual(operations, ["create account"]);
});

test("duplicate slug removes only the newly created login account", async () => {
  const { client, operations } = mockAdmin("org");
  await assert.rejects(signupOrganization(client, input), { status: 409 });
  assert.deepEqual(operations, ["create account", "insert organizations", "delete account new-user"]);
});

test("profile failure rolls back the new org and account", async () => {
  const { client, operations } = mockAdmin("profile");
  await assert.rejects(signupOrganization(client, input));
  assert.deepEqual(operations.slice(-2), ["delete organizations new-org", "delete account new-user"]);
});

test("a failed org rollback still attempts account cleanup and reports failure", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { client, operations } = mockAdmin("cleanup");
  await assert.rejects(signupOrganization(client, input), { status: 500 });
  assert.deepEqual(operations.slice(-2), ["delete organizations new-org", "delete account new-user"]);
  assert.equal(log.mock.calls.length, 1);
  log.mockRestore();
});

test("signup rejects caller-supplied role and unsafe slugs", () => {
  assert.equal(signupSchema.safeParse({ ...input, role: "officer" }).success, false);
  assert.equal(signupSchema.safeParse({ ...input, org_slug: "../admin" }).success, false);
});
