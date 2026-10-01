import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), requireAuth: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/supabase/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/supabase/server")>(),
  requireAuth: mocks.requireAuth,
}));

const { POST: finalize } = await import("@/app/api/events/[id]/finalize/route");

const {
  listEvents, getEvent, createEvent, updateEvent, deleteEvent, duplicateEvent,
  publishEvent, cancelEvent, addToMasterList, removeFromMasterList, listMasterList,
} = await import("@/lib/events");

const orgId = "e030dfb1-3186-493b-b58f-705603329231";
const userId = "9c6a2b1e-4f2a-4a2f-9a34-7b2f0e9a1234";
const eventId = "b2cf1e73-8d36-4a4b-86b7-b559ce4c4530";
const memberA = "1e9c9a1a-1111-4a4b-86b7-b559ce4c4530";
const memberB = "2e9c9a1a-2222-4a4b-86b7-b559ce4c4530";

const draftEvent = {
  id: eventId, org_id: orgId, title: "Orientation", description: null, venue: null,
  starts_at: "2026-10-01T09:00:00.000Z", ends_at: "2026-10-01T12:00:00.000Z",
  grace_period_minutes: 15, slots: null, walk_in_policy: "closed", status: "draft",
  points_value: 0, certificate_enabled: false, published_at: null, cancelled_at: null,
  created_by: userId, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
};

type MockResponse = { body: unknown; headers?: Record<string, string> };
const res = (body: unknown, headers?: Record<string, string>): MockResponse => ({ body, headers });

function context(responses: MockResponse[], role: AuthContext["role"] = "officer") {
  let call = 0;
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const entry = responses[Math.min(call, responses.length - 1)] ?? res([]);
    call += 1;
    return new Response(JSON.stringify(entry.body), {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Range": "0-0/1", ...entry.headers },
    });
  });
  const supabase = createClient("https://test.supabase.co", "test-anon-key", {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  });
  return { ctx: { supabase, orgId, userId, role } satisfies AuthContext, fetch };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.requireAuth.mockReset();
});

describe("event finalization request", () => {
  const summary = { already_finalized: false, absent_marked: 0, points_awarded: 0, total_attendees: 0 };
  const route = () => ({ params: Promise.resolve({ id: eventId }) });
  const request = (body?: string) => new Request(`http://localhost/api/events/${eventId}/finalize`, {
    method: "POST", body,
  });

  beforeEach(() => {
    mocks.requireAuth.mockResolvedValue(context([]).ctx);
    mocks.rpc.mockResolvedValue({ data: summary, error: null });
  });

  it.each([undefined, "", "   ", "{}"])("defaults force to false for an omitted option: %s", async (body) => {
    const response = await finalize(request(body), route());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: summary });
    expect(mocks.rpc).toHaveBeenCalledWith("finalize_event", {
      p_org_id: orgId, p_event_id: eventId, p_officer_id: userId, p_force: false,
    });
  });

  it.each([true, false])("preserves the boolean force value %s", async (force) => {
    const response = await finalize(request(JSON.stringify({ force })), route());
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("finalize_event", expect.objectContaining({ p_force: force }));
  });

  it.each([
    '{"force":', '{"force":"false"}', '{"force":"true"}', '{"force":0}',
    '{"force":1}', '{"force":null}', '{"force":[]}', '{"force":{}}',
    "null", "[]", "false", '{"unexpected":true}',
  ])("rejects invalid input before finalizing: %s", async (body) => {
    const response = await finalize(request(body), route());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "validation_error" } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects scanner operators before finalizing", async () => {
    mocks.requireAuth.mockResolvedValue(context([], "scanner_operator").ctx);
    const response = await finalize(request(), route());
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("listEvents", () => {
  it("scopes to the org and applies status + date range filters", async () => {
    const { ctx, fetch } = context([res([draftEvent])]);
    const result = await listEvents(ctx, {
      status: "draft", from: "2026-09-01T00:00:00Z", to: "2026-12-01T00:00:00Z", page: "1", per_page: "10",
    });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get("org_id")).toBe(`eq.${orgId}`);
    expect(url.searchParams.get("status")).toBe("eq.draft");
    expect(url.searchParams.getAll("starts_at")).toEqual(["gte.2026-09-01T00:00:00Z", "lte.2026-12-01T00:00:00Z"]);
    expect(result.events).toEqual([draftEvent]);
  });
});

describe("createEvent", () => {
  it("always creates in draft status, tagged with the caller as created_by", async () => {

    const { ctx, fetch } = context([res(draftEvent)]);
    const result = await createEvent(ctx, { title: "Orientation", starts_at: "2026-10-01T09:00:00Z", ends_at: "2026-10-01T12:00:00Z" });
    expect(result.status).toBe("draft");
    const sent = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body));
    expect(sent).toMatchObject({ status: "draft", created_by: userId, org_id: orgId });
  });

  it("rejects non-officers before writing", async () => {
    const { ctx, fetch } = context([res([])], "scanner_operator");
    await expect(createEvent(ctx, { title: "X", starts_at: "2026-10-01T09:00:00Z" })).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps the ends_at > starts_at check violation to a 422 validation error", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: "23514", message: "check violation" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
    const supabase = createClient("https://test.supabase.co", "test-anon-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const ctx = { supabase, orgId, userId, role: "officer" } satisfies AuthContext;
    await expect(createEvent(ctx, { title: "X", starts_at: "2026-10-01T12:00:00Z", ends_at: "2026-10-01T09:00:00Z" }))
      .rejects.toMatchObject({ status: 422 });
  });
});

describe("updateEvent / deleteEvent", () => {
  it("allows updating a draft event", async () => {
    const { ctx } = context([res([{ id: eventId, status: "draft" }]), res([{ ...draftEvent, title: "Updated" }])]);
    const updated = await updateEvent(ctx, eventId, { title: "Updated" });
    expect(updated.title).toBe("Updated");
  });

  it("rejects updating a published event with a conflict", async () => {
    const { ctx } = context([res([{ id: eventId, status: "published" }])]);
    await expect(updateEvent(ctx, eventId, { title: "Nope" })).rejects.toMatchObject({ status: 409 });
  });

  it("deletes only a draft event", async () => {
    const { ctx } = context([res([{ id: eventId, status: "published" }])]);
    await expect(deleteEvent(ctx, eventId)).rejects.toMatchObject({ status: 409 });
  });

  it("returns 404 for another organization's event on get/update/delete", async () => {
    const { ctx } = context([res([])]);
    await expect(getEvent(ctx, eventId)).rejects.toMatchObject({ status: 404 });

    const { ctx: ctx2 } = context([res([])]);
    await expect(updateEvent(ctx2, eventId, { title: "X" })).rejects.toMatchObject({ status: 404 });

    const { ctx: ctx3 } = context([res([])]);
    await expect(deleteEvent(ctx3, eventId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("getEvent", () => {
  it("includes the master-list count", async () => {
    const { ctx } = context([res([draftEvent]), res([], { "Content-Range": "*/2" })]);
    const result = await getEvent(ctx, eventId);
    expect(result.master_list_count).toBe(2);
  });
});

describe("publishEvent / cancelEvent", () => {
  it("rejects non-officers before calling the RPC", async () => {
    const { ctx } = context([], "scanner_operator");
    await expect(publishEvent(ctx, eventId)).rejects.toMatchObject({ status: 403 });
    await expect(cancelEvent(ctx, eventId)).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("publishes a draft event with a non-empty master list", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ...draftEvent, status: "published" }, error: null });
    const { ctx } = context([]);
    const result = await publishEvent(ctx, eventId);
    expect(result.status).toBe("published");
    expect(mocks.rpc).toHaveBeenCalledWith("publish_event", { p_org_id: orgId, p_event_id: eventId, p_officer_id: userId });
  });

  it("maps an empty-master-list publish (TP014) to 400", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "TP014", message: "empty master list" } });
    const { ctx } = context([]);
    await expect(publishEvent(ctx, eventId)).rejects.toMatchObject({ status: 400 });
  });

  it("maps publishing twice (already published, TP011) to 409", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "TP011", message: "invalid transition" } });
    const { ctx } = context([]);
    await expect(publishEvent(ctx, eventId)).rejects.toMatchObject({ status: 409 });
  });

  it("maps a not-found publish/cancel (TP010) to 404", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "TP010", message: "not found" } });
    const { ctx } = context([]);
    await expect(publishEvent(ctx, eventId)).rejects.toMatchObject({ status: 404 });
  });

  it("cancels from draft or published", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ...draftEvent, status: "cancelled" }, error: null });
    const { ctx } = context([]);
    expect((await cancelEvent(ctx, eventId)).status).toBe("cancelled");
    expect(mocks.rpc).toHaveBeenCalledWith("cancel_event", { p_org_id: orgId, p_event_id: eventId, p_officer_id: userId });

    mocks.rpc.mockResolvedValueOnce({ data: { ...draftEvent, status: "cancelled" }, error: null });
    const { ctx: ctx2 } = context([]);
    expect((await cancelEvent(ctx2, eventId)).status).toBe("cancelled");
  });

  it("rejects cancelling an already-completed event (TP011) with 409", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "TP011", message: "already cancelled or completed" } });
    const { ctx } = context([]);
    await expect(cancelEvent(ctx, eventId)).rejects.toMatchObject({ status: 409 });
  });
});

describe("duplicateEvent", () => {
  it("clones fields and the master list into a new draft, clearing publish/cancel timestamps", async () => {
    const original = { ...draftEvent, status: "published", published_at: "2026-09-15T00:00:00.000Z" };
    const newEvent = { ...draftEvent, id: "9d1c9a1a-3333-4a4b-86b7-b559ce4c4530", status: "draft", published_at: null, cancelled_at: null };
    const masterListRows = [{ member_id: memberA, added_by: userId }, { member_id: memberB, added_by: userId }];

    const { ctx, fetch } = context([res([original]), res(newEvent), res(masterListRows), res(masterListRows)]);

    const result = await duplicateEvent(ctx, eventId);
    expect(result.id).toBe(newEvent.id);
    expect(result.status).toBe("draft");
    expect(result.published_at).toBeNull();
    expect(result.master_list_count).toBe(2);

    const insertedEventBody = JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body));
    expect(insertedEventBody).toMatchObject({ status: "draft", created_by: userId, org_id: orgId });
    expect(insertedEventBody.published_at).toBeUndefined();

    const clonedListBody = JSON.parse(String((fetch.mock.calls[3][1] as RequestInit).body));
    expect(clonedListBody).toEqual([
      { event_id: newEvent.id, member_id: memberA, added_by: userId },
      { event_id: newEvent.id, member_id: memberB, added_by: userId },
    ]);
  });

  it("skips cloning the master list when the original has none", async () => {
    const newEvent = { ...draftEvent, id: "9d1c9a1a-4444-4a4b-86b7-b559ce4c4530" };
    const { ctx, fetch } = context([res([draftEvent]), res(newEvent), res([])]);
    const result = await duplicateEvent(ctx, eventId);
    expect(result.master_list_count).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects non-officers", async () => {
    const { ctx, fetch } = context([], "scanner_operator");
    await expect(duplicateEvent(ctx, eventId)).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("addToMasterList", () => {
  it("adds new members and skips ones already on the list", async () => {
    const insertedRow = { member_id: memberB, added_at: "2026-09-01T00:00:00.000Z", added_by: userId };
    const { ctx } = context([
      res([{ id: eventId, status: "draft" }]),
      res([{ id: memberA }, { id: memberB }]),
      res([{ member_id: memberA }]),
      res([insertedRow]),
    ]);
    const result = await addToMasterList(ctx, eventId, { member_ids: [memberA, memberB] });
    expect(result.added).toEqual([insertedRow]);
    expect(result.skipped).toEqual([memberA]);
  });

  it("skips the insert entirely when every member is already listed (duplicate add)", async () => {
    const { ctx, fetch } = context([
      res([{ id: eventId, status: "draft" }]),
      res([{ id: memberA }]),
      res([{ member_id: memberA }]),
    ]);
    const result = await addToMasterList(ctx, eventId, { member_ids: [memberA] });
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([memberA]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a member that doesn't belong to the organization", async () => {
    const { ctx } = context([
      res([{ id: eventId, status: "draft" }]),
      res([{ id: memberA }]),
    ]);
    await expect(addToMasterList(ctx, eventId, { member_ids: [memberA, memberB] })).rejects.toMatchObject({ status: 422 });
  });

  it("returns 404 for another organization's event", async () => {
    const { ctx, fetch } = context([res([])]);
    await expect(addToMasterList(ctx, eventId, { member_ids: [memberA] })).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-officers before touching the database", async () => {
    const { ctx, fetch } = context([], "scanner_operator");
    await expect(addToMasterList(ctx, eventId, { member_ids: [memberA] })).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("listMasterList / removeFromMasterList", () => {
  it("lists the master list with member details embedded", async () => {
    const rows = [{ member_id: memberA, added_at: "2026-09-01T00:00:00.000Z", added_by: userId, members: { id: memberA, full_name: "A", student_number: "1" } }];
    const { ctx, fetch } = context([res([{ id: eventId, status: "draft" }]), res(rows)]);
    const result = await listMasterList(ctx, eventId);
    expect(result).toEqual(rows);
    const url = new URL(String(fetch.mock.calls[1][0]));
    expect(url.searchParams.get("event_id")).toBe(`eq.${eventId}`);
  });

  it("removes a member from the master list", async () => {
    const { ctx } = context([res([{ id: eventId, status: "draft" }]), res([])]);
    const result = await removeFromMasterList(ctx, eventId, memberA);
    expect(result).toEqual({ event_id: eventId, member_id: memberA });
  });

  it("rejects non-officer removal", async () => {
    const { ctx, fetch } = context([], "scanner_operator");
    await expect(removeFromMasterList(ctx, eventId, memberA)).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 404 for another organization's event", async () => {
    const { ctx } = context([res([])]);
    await expect(listMasterList(ctx, eventId)).rejects.toMatchObject({ status: 404 });
  });
});
