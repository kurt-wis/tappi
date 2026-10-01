import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { seed, seedAccounts, seedId, seedMembers } from "../scripts/seed";

type Row = Record<string, unknown>;

function database() {
  const tables: Record<string, Row[]> = Object.fromEntries(
    ["organizations", "profiles", "members", "events", "event_master_list"].map((name) => [name, []]),
  );
  const users: User[] = [];
  const admin = {
    listUsers: vi.fn(async ({ page, perPage }: { page: number; perPage: number }) => ({
      data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null,
    })),
    createUser: vi.fn(async (input: { email: string; app_metadata: Record<string, unknown> }) => {
      const user = { id: `user-${users.length}`, email: input.email, app_metadata: input.app_metadata } as User;
      users.push(user);
      return { data: { user }, error: null };
    }),
    updateUserById: vi.fn(async () => ({ error: null })),
  };
  const client = {
    auth: { admin },
    async rpc(name: string, input: { p_member_id: string; p_card_uid: string }) {
      expect(name).toBe("link_member_card");
      const row = tables.members.find((m) => m.id === input.p_member_id);
      if (row) row.card_uid = input.p_card_uid;
      return { data: row, error: null };
    },
    from(table: string) {
      return {
        update(changes: Row) {
          const filters: Array<[string, unknown]> = [];
          return {
            eq(key: string, value: unknown) { filters.push([key, value]); return this; },
            select() { return this; },
            async maybeSingle() {
              const row = tables[table].find((candidate) => filters.every(([key, value]) => candidate[key] === value));
              if (row) Object.assign(row, changes);
              return { data: row ?? null, error: null };
            },
          };
        },
        select() {
          const filters: Array<[string, unknown]> = [];
          return {
            eq(key: string, value: unknown) { filters.push([key, value]); return this; },
            async maybeSingle() {
              return { data: tables[table].find((row) => filters.every(([key, value]) => row[key] === value)) ?? null, error: null };
            },
          };
        },
        async upsert(input: Row | Row[], options: { onConflict: string; ignoreDuplicates: boolean }) {
          expect(options.ignoreDuplicates).toBe(true);
          for (const row of Array.isArray(input) ? input : [input]) {
            const keys = options.onConflict.split(",");
            if (!tables[table].some((existing) => keys.every((key) => existing[key] === row[key]))) {
              tables[table].push({ ...row });
            }
          }
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, tables, users, admin };
}

describe("test data seed", () => {
  it("creates the full requested dataset and does not duplicate it on rerun", async () => {
    const db = database();
    await seed(db.client);
    await seed(db.client);

    expect(db.users).toHaveLength(3);
    expect(db.users.map((user) => user.email)).toEqual(seedAccounts.map((account) => account.email));
    expect(db.tables.organizations).toHaveLength(1);
    expect(db.tables.organizations[0]).toMatchObject({ name: "Test Org", slug: "test-org" });
    expect(db.tables.profiles.map((profile) => profile.role)).toEqual(["org_admin", "officer", "scanner_operator"]);
    expect(db.tables.members).toHaveLength(10);
    expect(new Set(db.tables.members.map((member) => member.student_number)).size).toBe(10);
    expect(db.tables.members.every((member) => member.full_name && member.course)).toBe(true);
    const cards = db.tables.members.filter((member) => member.card_uid);
    expect(cards).toHaveLength(5);
    expect(new Set(cards.map((member) => member.card_uid)).size).toBe(5);
    expect(cards.every((member) => /^\d+$/.test(String(member.card_uid)))).toBe(true);
    expect(db.tables.events.map((event) => event.status)).toEqual(["draft", "published"]);
    expect(db.tables.event_master_list).toHaveLength(10);
    expect(db.tables.event_master_list.map((entry) => entry.member_id)).toEqual(seedMembers.map((member) => member.id));
    expect(db.tables.event_master_list.every((entry) => entry.event_id === seedId("published-event"))).toBe(true);
    expect(db.admin.createUser).toHaveBeenCalledTimes(3);
    expect(db.admin.createUser.mock.calls[0][0]).toMatchObject({ email: "admin@test.local", password: "password123", email_confirm: true });
  });

  it("preserves tester edits to existing member and event fixtures", async () => {
    const db = database();
    await seed(db.client);
    db.tables.members[0].full_name = "Edited name";
    db.tables.members[0].status = "archived";
    db.tables.events[0].title = "Edited title";
    await seed(db.client);
    expect(db.tables.members[0]).toMatchObject({ full_name: "Edited name", status: "archived" });
    expect(db.tables.events[0].title).toBe("Edited title");
  });

  it("reactivates owned test profiles without resetting their other edits", async () => {
    const db = database();
    await seed(db.client);
    for (const profile of db.tables.profiles) profile.is_active = false;
    db.tables.profiles[0].full_name = "Edited administrator name";
    await seed(db.client);
    expect(db.tables.profiles.every((profile) => profile.is_active === true)).toBe(true);
    expect(db.tables.profiles[0].full_name).toBe("Edited administrator name");
    expect(db.tables.profiles.map((profile) => profile.role)).toEqual(["org_admin", "officer", "scanner_operator"]);
  });

  it("does not reactivate a profile whose role has changed", async () => {
    const db = database();
    await seed(db.client);
    db.tables.profiles[0].is_active = false;
    db.tables.profiles[0].role = "officer";
    await expect(seed(db.client)).rejects.toThrow("Refusing to overwrite a changed or unrelated profile");
    expect(db.tables.profiles[0]).toMatchObject({ is_active: false, role: "officer" });
  });

  it("recovers a partially completed seed without duplicating earlier records", async () => {
    const db = database();
    await seed(db.client);
    db.tables.profiles.pop();
    db.tables.members.splice(4);
    db.tables.events.splice(1);
    db.tables.event_master_list.length = 0;
    await seed(db.client);
    expect(db.users).toHaveLength(3);
    expect(db.tables.profiles).toHaveLength(3);
    expect(db.tables.members).toHaveLength(10);
    expect(db.tables.events).toHaveLength(2);
    expect(db.tables.event_master_list).toHaveLength(10);
  });

  it("rejects an unrelated existing auth account before changing its password", async () => {
    const db = database();
    db.users.push({ id: "unrelated", email: "admin@test.local", app_metadata: {} } as User);
    await expect(seed(db.client)).rejects.toThrow("Refusing to modify existing account");
    expect(db.admin.updateUserById).not.toHaveBeenCalled();
    expect(db.tables.organizations).toHaveLength(0);
  });

  it("rejects an existing organization using the reserved slug", async () => {
    const db = database();
    db.tables.organizations.push({ id: "unrelated", slug: "test-org", settings: {} });
    await expect(seed(db.client)).rejects.toThrow("Refusing to modify test-org");
    expect(db.admin.createUser).not.toHaveBeenCalled();
  });

  it("rejects a seeded user whose profile has moved to another organization", async () => {
    const db = database();
    await seed(db.client);
    db.tables.profiles[0].org_id = "unrelated";
    db.admin.updateUserById.mockClear();
    await expect(seed(db.client)).rejects.toThrow("Refusing to overwrite a changed or unrelated profile");
    expect(db.admin.updateUserById).not.toHaveBeenCalled();
    expect(db.tables.profiles[0].org_id).toBe("unrelated");
  });

  it("rejects member IDs that now belong to a different organization", async () => {
    const db = database();
    await seed(db.client);
    db.tables.members[0].org_id = "unrelated";
    await expect(seed(db.client)).rejects.toThrow("Seed member ID conflict");
    expect(db.tables.members[0].org_id).toBe("unrelated");
  });

  it("rejects event IDs belonging to a different organization", async () => {
    const db = database();
    await seed(db.client);
    db.tables.events[0].org_id = "unrelated";
    await expect(seed(db.client)).rejects.toThrow("event ID belongs to another organization");
    expect(db.tables.events[0].org_id).toBe("unrelated");
  });
});
