import { describe, expect, it, vi } from "vitest";
import {
  buildAnswersSchema, customFields, formFieldDefinitionSchema, formFieldListSchema, parseStoredFields,
  resolveFormSchema, type FormFieldDefinition,
} from "@/lib/registration-form";

const field = (overrides: Partial<FormFieldDefinition> & Pick<FormFieldDefinition, "key" | "type">): FormFieldDefinition =>
  formFieldDefinitionSchema.parse({ label: overrides.key, ...overrides });

describe("form field definitions", () => {
  it("accepts the documented field types with type-appropriate rules", () => {
    expect(formFieldListSchema.parse([
      { key: "year_level", label: "Year level", type: "select", required: true, options: ["1", "2", "3", "4"] },
      { key: "dietary_notes", label: "Dietary notes", type: "textarea", validation: { max_length: 300 } },
      { key: "age", label: "Age", type: "number", validation: { min: 15, max: 99, integer: true } },
      { key: "birthday", label: "Birthday", type: "date", validation: { min_date: "1990-01-01", max_date: "2015-12-31" } },
      { key: "workshops", label: "Workshops", type: "multiselect", options: ["A", "B", "C"], validation: { max_items: 2 } },
      { key: "consent", label: "I agree", type: "checkbox", required: true },
    ])).toHaveLength(6);
  });

  it("defaults required to false", () => {
    expect(field({ key: "notes", type: "text" }).required).toBe(false);
  });

  it.each([
    [{ key: "Year", label: "x", type: "text" }, "uppercase key"],
    [{ key: "1year", label: "x", type: "text" }, "key starting with a digit"],
    [{ key: "email", label: "x", type: "text" }, "reserved base key"],
    [{ key: "student_number", label: "x", type: "text" }, "reserved base key"],
    [{ key: "year", label: "", type: "text" }, "empty label"],
    [{ key: "year", label: "x", type: "color" }, "unknown type"],
    [{ key: "year", label: "x", type: "select" }, "select without options"],
    [{ key: "year", label: "x", type: "text", options: ["a"] }, "options on a text field"],
    [{ key: "year", label: "x", type: "select", options: ["A", "a"] }, "duplicate options"],
    [{ key: "year", label: "x", type: "text", validation: { min: 1 } }, "numeric rule on text"],
    [{ key: "year", label: "x", type: "text", validation: { min_length: 5, max_length: 2 } }, "min_length > max_length"],
    [{ key: "year", label: "x", type: "number", validation: { min: 1.2, max: 1.8, integer: true } }, "no integer in range"],
    [{ key: "year", label: "x", type: "date", validation: { min_date: "2026-02-30" } }, "impossible date"],
    [{ key: "year", label: "x", type: "multiselect", options: ["a"], validation: { min_items: 2 } }, "min_items > options"],
    [{ key: "year", label: "x", type: "text", pattern: ".*" }, "unknown property"],
  ])("rejects %j (%s)", (input, _reason) => {
    expect(formFieldDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate keys and more than 30 fields", () => {
    expect(formFieldListSchema.safeParse([
      { key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" },
    ]).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: "text" }));
    expect(formFieldListSchema.safeParse(many).success).toBe(false);
    expect(formFieldListSchema.safeParse(many.slice(0, 30)).success).toBe(true);
  });
});

describe("resolveFormSchema", () => {
  it("orders base, org defaults, then event extras and lets an event field override an org default in place", () => {
    const resolved = resolveFormSchema(
      [field({ key: "year_level", type: "text" }), field({ key: "course", type: "text" })],
      [field({ key: "year_level", type: "select", options: ["1", "2"], required: true }), field({ key: "diet", type: "textarea" })],
    );
    expect(resolved.map((f) => [f.key, f.source])).toEqual([
      ["full_name", "base"], ["student_number", "base"], ["email", "base"],
      ["year_level", "event_extra"], ["course", "org_default"], ["diet", "event_extra"],
    ]);
    expect(customFields(resolved).map((f) => f.key)).toEqual(["year_level", "course", "diet"]);
  });

  it("drops invalid or duplicate stored definitions instead of failing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseStoredFields([
      { key: "ok", label: "OK", type: "text" },
      { key: "bad", label: "Bad", type: "select" },
      { key: "ok", label: "Again", type: "text" },
      "nonsense",
    ]).map((f) => f.label)).toEqual(["OK"]);
    expect(parseStoredFields(null)).toEqual([]);
    expect(parseStoredFields({})).toEqual([]);
    warn.mockRestore();
  });
});

describe("buildAnswersSchema", () => {
  const schema = buildAnswersSchema(resolveFormSchema([], [
    field({ key: "year_level", type: "select", options: ["1st", "2nd"], required: true }),
    field({ key: "diet", type: "textarea", validation: { max_length: 10 } }),
    field({ key: "age", type: "number", validation: { min: 16, max: 60, integer: true } }),
    field({ key: "birthday", type: "date", validation: { max_date: "2010-12-31" } }),
    field({ key: "workshops", type: "multiselect", options: ["A", "B", "C"], validation: { max_items: 2 } }),
    field({ key: "consent", type: "checkbox", required: true }),
    field({ key: "newsletter", type: "checkbox" }),
    field({ key: "alt_email", type: "email" }),
    field({ key: "nickname", type: "text", validation: { min_length: 2 } }),
  ]));
  const valid = { year_level: "1st", consent: true };

  it("accepts a minimal valid submission and omits unanswered optional fields", () => {
    expect(schema.parse({ ...valid, diet: "  ", age: "", newsletter: false, workshops: [] }))
      .toEqual({ year_level: "1st", consent: true, newsletter: false });
  });

  it("trims text and coerces numeric strings", () => {
    expect(schema.parse({ ...valid, diet: "  vegan ", age: " 21 " })).toMatchObject({ diet: "vegan", age: 21 });
  });

  it.each([
    [{ consent: true }, "missing required select"],
    [{ year_level: "  ", consent: true }, "blank required select"],
    [{ year_level: "3rd", consent: true }, "option not offered"],
    [{ year_level: "1st", consent: false }, "required checkbox unchecked"],
    [{ year_level: "1st" }, "required checkbox missing"],
    [{ ...valid, diet: "more than ten chars" }, "max_length"],
    [{ ...valid, age: 15 }, "below min"],
    [{ ...valid, age: 20.5 }, "not an integer"],
    [{ ...valid, age: "twenty" }, "not numeric"],
    [{ ...valid, age: "" + Number.POSITIVE_INFINITY }, "infinity"],
    [{ ...valid, birthday: "2011-01-01" }, "after max_date"],
    [{ ...valid, birthday: "2010-02-30" }, "impossible date"],
    [{ ...valid, workshops: ["A", "B", "C"] }, "too many items"],
    [{ ...valid, workshops: ["A", "A"] }, "duplicate items"],
    [{ ...valid, workshops: ["D"] }, "unknown item"],
    [{ ...valid, newsletter: "yes" }, "non-boolean checkbox"],
    [{ ...valid, alt_email: "not-an-email" }, "invalid email"],
    [{ ...valid, nickname: "a" }, "min_length"],
    [{ ...valid, unexpected: "x" }, "unknown key"],
    [{ ...valid, full_name: "x" }, "base field inside answers"],
  ])("rejects %j (%s)", (answers, _reason) => {
    expect(schema.safeParse(answers).success).toBe(false);
  });

  it("accepts an empty object when the form has no custom fields", () => {
    expect(buildAnswersSchema(resolveFormSchema()).parse({})).toEqual({});
    expect(buildAnswersSchema(resolveFormSchema()).safeParse({ extra: 1 }).success).toBe(false);
  });
});
