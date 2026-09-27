import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@/lib/supabase/server";
import { exportMembersCsv, importMembers, parseCsv, toCsv } from "@/lib/members-csv";

const orgId = "e030dfb1-3186-493b-b58f-705603329231";
const userId = "9c6a2b1e-4f2a-4a2f-9a34-7b2f0e9a1234";

// ---------------------------------------------------------------
// A minimal fake PostgREST-style query builder, general enough to satisfy
// both the select().eq().eq().maybeSingle() shape and the
// update().eq().eq() / select().eq().order().order() "await the chain
// directly" shape members-csv.ts relies on.
// ---------------------------------------------------------------
type Filters = Record<string, unknown>;
type Handlers = {
  onSelectMaybeSingle?: (table: string, filters: Filters) => { data: unknown; error: unknown };
  onSelectMulti?: (table: string, filters: Filters) => { data: unknown; error: unknown };
  onUpdate?: (table: string, payload: unknown, filters: Filters) => { error: unknown };
  onInsert?: (table: string, payload: unknown) => { error: unknown };
};

function fakeSupabase(handlers: Handlers) {
  const calls: { table: string; op: string; payload?: unknown; filters: Filters }[] = [];

  function chain(state: { table: string; op: "select" | "update"; payload?: unknown; filters: Filters }): any {
    return {
      select: () => chain({ ...state, op: "select" }),
      eq: (key: string, value: unknown) => chain({ ...state, filters: { ...state.filters, [key]: value } }),
      order: () => chain(state),
      maybeSingle: async () => {
        calls.push({ ...state, op: "maybeSingle" });
        return handlers.onSelectMaybeSingle?.(state.table, state.filters) ?? { data: null, error: null };
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        calls.push({ ...state });
        const result = state.op === "update"
          ? handlers.onUpdate?.(state.table, state.payload, state.filters) ?? { error: null }
          : handlers.onSelectMulti?.(state.table, state.filters) ?? { data: [], error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  }

  return {
    calls,
    from(table: string) {
      return {
        select: () => chain({ table, op: "select", filters: {} }),
        update: (payload: unknown) => chain({ table, op: "update", payload, filters: {} }),
        insert: async (payload: unknown) => {
          calls.push({ table, op: "insert", payload, filters: {} });
          return handlers.onInsert?.(table, payload) ?? { error: null };
        },
      };
    },
  };
}

function context(handlers: Handlers, role: AuthContext["role"] = "officer") {
  const supabase = fakeSupabase(handlers);
  return { ctx: { supabase, orgId, userId, role } as unknown as AuthContext, supabase };
}

describe("parseCsv / toCsv", () => {
  it("splits header + rows on plain fields", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6")).toEqual([["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]]);
  });

  it("handles quoted fields with embedded commas, quotes, and newlines, and CRLF line endings", () => {
    const text = 'name,note\r\n"Reyes, Marco","said ""hi""\nagain"\r\n';
    expect(parseCsv(text)).toEqual([
      ["name", "note"],
      ["Reyes, Marco", 'said "hi"\nagain'],
    ]);
  });

  it("round-trips values that need quoting", () => {
    const csv = toCsv([["a", "b"], ['has,comma', 'has"quote']]);
    expect(parseCsv(csv)).toEqual([["a", "b"], ["has,comma", 'has"quote']]);
  });
});

describe("importMembers", () => {
  it("rejects non-officers before reading the CSV", async () => {
    const { ctx, supabase } = context({}, "scanner_operator");
    await expect(importMembers(ctx, "student_number,full_name,member_role\n1,A,member")).rejects.toMatchObject({ status: 403 });
    expect(supabase.calls).toHaveLength(0);
  });

  it("rejects an empty CSV", async () => {
    const { ctx } = context({});
    await expect(importMembers(ctx, "")).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a CSV missing required columns", async () => {
    const { ctx } = context({});
    await expect(importMembers(ctx, "student_number,full_name\n1,A")).rejects.toMatchObject({ status: 422 });
  });

  it("creates new members and updates existing ones, keyed by student_number within the org", async () => {
    const existing = new Set(["2026-0001"]);
    const { ctx, supabase } = context({
      onSelectMaybeSingle: (table, filters) => {
        expect(table).toBe("members");
        expect(filters.org_id).toBe(orgId);
        return existing.has(String(filters.student_number))
          ? { data: { id: "existing-id" }, error: null }
          : { data: null, error: null };
      },
      onUpdate: () => ({ error: null }),
      onInsert: () => ({ error: null }),
    });

    const csv = [
      "student_number,full_name,email,course,member_role",
      "2026-0001,Alyssa Santos,alyssa@test.local,BS CS,member",
      "2026-0002,New Student,,,officer",
    ].join("\n");

    const summary = await importMembers(ctx, csv);

    expect(summary).toEqual({
      created: 1,
      updated: 1,
      skipped: 0,
      rows: [
        { row: 2, student_number: "2026-0001", result: "updated" },
        { row: 3, student_number: "2026-0002", result: "created" },
      ],
    });

    const updateCall = supabase.calls.find((c) => c.op === "update");
    expect(updateCall?.payload).toEqual({
      full_name: "Alyssa Santos", email: "alyssa@test.local", course: "BS CS", member_role: "member",
    });
    const insertCall = supabase.calls.find((c) => c.op === "insert");
    expect(insertCall?.payload).toMatchObject({
      student_number: "2026-0002", full_name: "New Student", email: null, course: null,
      member_role: "officer", org_id: orgId,
    });
  });

  it("never links or changes card_uid via import — card_uid isn't a recognized import field", async () => {
    const { ctx, supabase } = context({
      onSelectMaybeSingle: () => ({ data: null, error: null }),
      onInsert: (_table, payload) => {
        expect(payload).not.toHaveProperty("card_uid");
        return { error: null };
      },
    });
    const csv = "student_number,full_name,member_role,card_uid\n2026-0003,Someone,member,2035787938";
    const summary = await importMembers(ctx, csv);
    expect(summary.created).toBe(1);
    expect(supabase.calls.some((c) => c.op === "insert")).toBe(true);
  });

  it("skips invalid rows with a reason instead of failing the whole import", async () => {
    const { ctx } = context({
      onSelectMaybeSingle: () => ({ data: null, error: null }),
      onInsert: () => ({ error: null }),
    });
    const csv = [
      "student_number,full_name,member_role",
      ",Missing Student Number,member",
      "2026-0005,Valid Student,member",
    ].join("\n");
    const summary = await importMembers(ctx, csv);
    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.rows[0]).toMatchObject({ row: 2, result: "skipped" });
    expect(summary.rows[1]).toMatchObject({ row: 3, result: "created" });
  });

  it("skips a row whose insert fails at the database (e.g. a conflict) without aborting the import", async () => {
    let insertCount = 0;
    const { ctx } = context({
      onSelectMaybeSingle: () => ({ data: null, error: null }),
      onInsert: () => {
        insertCount++;
        return insertCount === 1 ? { error: { code: "23505", message: "duplicate key" } } : { error: null };
      },
    });
    const csv = [
      "student_number,full_name,member_role",
      "2026-0006,First,member",
      "2026-0007,Second,member",
    ].join("\n");
    const summary = await importMembers(ctx, csv);
    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.rows[0]).toMatchObject({ result: "skipped" });
    expect(summary.rows[1]).toMatchObject({ result: "created" });
  });
});

describe("exportMembersCsv", () => {
  it("requires no officer role and scopes the query to the session org", async () => {
    const rows = [
      {
        student_number: "2026-0001", full_name: "Alyssa Santos", email: "alyssa@test.local", course: "BS CS",
        member_role: "member", status: "active", card_uid: "2035787938", card_linked_at: "2026-09-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        student_number: "2026-0002", full_name: "No Card", email: null, course: null,
        member_role: "member", status: "active", card_uid: null, card_linked_at: null,
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    let seenFilters: Filters = {};
    const { ctx } = context({
      onSelectMulti: (table, filters) => {
        seenFilters = filters;
        expect(table).toBe("members");
        return { data: rows, error: null };
      },
    }, "scanner_operator");

    const csv = await exportMembersCsv(ctx);
    expect(seenFilters.org_id).toBe(orgId);

    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual([
      "student_number", "full_name", "email", "course", "member_role",
      "status", "card_uid", "card_linked_at", "created_at",
    ]);
    expect(parsed[1]).toEqual([
      "2026-0001", "Alyssa Santos", "alyssa@test.local", "BS CS", "member",
      "active", "2035787938", "2026-09-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    ]);
    // null fields serialize to empty CSV cells
    expect(parsed[2]).toEqual([
      "2026-0002", "No Card", "", "", "member", "active", "", "", "2026-01-02T00:00:00.000Z",
    ]);
  });
});
