import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createMemberSchema } from "@/lib/members";
import { normalizeStudentNumber } from "@/lib/registration-form";
import { replaceCardSchema } from "@/lib/member-cards";

describe("PDF identity rules", () => {
  it("normalizes student numbers and permits guests without one", () => {
    expect(normalizeStudentNumber(" ab-12 34 ")).toBe("AB1234");
    expect(createMemberSchema.parse({
      student_number: " ab-12 34 ", full_name: "Guest", member_role: "attendee",
    }).student_number).toBe("AB1234");
    expect(createMemberSchema.parse({
      student_number: null, full_name: "Faculty Guest", member_role: "attendee",
    }).student_number).toBeNull();
  });

  it("requires a reason for card replacement", () => {
    expect(replaceCardSchema.safeParse({ new_card_uid: "123" }).success).toBe(false);
    expect(replaceCardSchema.parse({ new_card_uid: "123", reason: "lost card" }).reason).toBe("lost card");
  });
});
