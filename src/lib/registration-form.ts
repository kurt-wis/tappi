import { z } from "zod";

export const FORM_FIELD_TYPES = [
  "text", "textarea", "email", "number", "select", "multiselect", "checkbox", "date",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const MAX_FORM_FIELDS = 30;
export const MAX_FIELD_OPTIONS = 50;
const DEFAULT_MAX_LENGTH: Record<"text" | "textarea" | "email", number> = { text: 500, textarea: 2000, email: 254 };

export const BASE_FIELD_KEYS = ["full_name", "student_number", "email"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

export const fieldValidationSchema = z.object({
  min_length: z.number().int().min(0).max(2000).optional(),
  max_length: z.number().int().min(1).max(2000).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  integer: z.boolean().optional(),
  min_date: isoDate.optional(),
  max_date: isoDate.optional(),
  min_items: z.number().int().min(0).max(MAX_FIELD_OPTIONS).optional(),
  max_items: z.number().int().min(1).max(MAX_FIELD_OPTIONS).optional(),
}).strict();
export type FieldValidation = z.infer<typeof fieldValidationSchema>;

const RULES_BY_TYPE: Record<FormFieldType, Array<keyof FieldValidation>> = {
  text: ["min_length", "max_length"],
  textarea: ["min_length", "max_length"],
  email: ["max_length"],
  number: ["min", "max", "integer"],
  select: [],
  multiselect: ["min_items", "max_items"],
  checkbox: [],
  date: ["min_date", "max_date"],
};

export const formFieldDefinitionSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,49}$/,
    "key must start with a letter and contain only lowercase letters, digits, and underscores (max 50)")
    .refine((key) => !(BASE_FIELD_KEYS as readonly string[]).includes(key), "key is reserved for a built-in field"),
  label: z.string().trim().min(1).max(120),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean().default(false),
  help_text: z.string().trim().min(1).max(300).optional(),
  options: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_FIELD_OPTIONS).optional(),
  validation: fieldValidationSchema.optional(),
}).strict().superRefine((field, issue) => {
  const choice = field.type === "select" || field.type === "multiselect";
  if (choice && !field.options) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: `options are required for ${field.type} fields` });
  }
  if (!choice && field.options) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: `options are only allowed on select and multiselect fields` });
  }
  if (field.options && new Set(field.options.map((o) => o.toLowerCase())).size !== field.options.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "options must be unique" });
  }
  const rules = field.validation ?? {};
  for (const rule of Object.keys(rules) as Array<keyof FieldValidation>) {
    if (!RULES_BY_TYPE[field.type].includes(rule)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ["validation", rule], message: `${rule} does not apply to ${field.type} fields` });
    }
  }
  const pairs: Array<[keyof FieldValidation, keyof FieldValidation]> = [
    ["min_length", "max_length"], ["min", "max"], ["min_date", "max_date"], ["min_items", "max_items"],
  ];
  for (const [lower, upper] of pairs) {
    const low = rules[lower];
    const high = rules[upper];
    if (low !== undefined && high !== undefined && low > high) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ["validation", lower], message: `${lower} must not exceed ${upper}` });
    }
  }
  if (field.type === "email" && rules.max_length !== undefined && rules.max_length > DEFAULT_MAX_LENGTH.email) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["validation", "max_length"], message: "max_length for email fields cannot exceed 254" });
  }
  if (field.options && rules.min_items !== undefined && rules.min_items > field.options.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["validation", "min_items"], message: "min_items cannot exceed the number of options" });
  }
  if (field.type === "number" && rules.integer && rules.min !== undefined && rules.max !== undefined
    && Math.ceil(rules.min) > Math.floor(rules.max)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["validation"], message: "No integer satisfies min and max" });
  }
});

export const formFieldListSchema = z.array(formFieldDefinitionSchema).max(MAX_FORM_FIELDS)
  .superRefine((fields, issue) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: [index, "key"], message: `Duplicate field key "${field.key}"` });
      }
      seen.add(field.key);
    });
  });

export type FormFieldDefinition = z.infer<typeof formFieldDefinitionSchema>;

export type BaseFormField = {
  key: (typeof BASE_FIELD_KEYS)[number];
  label: string;
  type: "text" | "email";
  required: true;
  source: "base";
};
export type CustomFormField = FormFieldDefinition & { source: "org_default" | "event_extra" };
export type FormField = BaseFormField | CustomFormField;

export const BASE_FIELDS: BaseFormField[] = [
  { key: "full_name", label: "Full Name", type: "text", required: true, source: "base" },
  { key: "student_number", label: "Student Number", type: "text", required: true, source: "base" },
  { key: "email", label: "Email", type: "email", required: true, source: "base" },
];

/**
 * Reads field definitions stored in jsonb. Definitions are validated on write, so an invalid
 * entry means the data was edited out-of-band; it is dropped rather than failing the whole form.
 */
export function parseStoredFields(raw: unknown): FormFieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  const fields: FormFieldDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = formFieldDefinitionSchema.safeParse(entry);
    if (!parsed.success) {
      console.warn("[registration-form] ignoring invalid stored field definition", entry);
      continue;
    }
    if (seen.has(parsed.data.key)) continue;
    seen.add(parsed.data.key);
    fields.push(parsed.data);
  }
  return fields;
}

/** Base fields first, then org defaults, then event extras. An event field with the same key as an org default replaces it in place. */
export function resolveFormSchema(
  orgDefaults: FormFieldDefinition[] = [],
  eventExtras: FormFieldDefinition[] = [],
): FormField[] {
  const merged = new Map<string, FormField>();
  BASE_FIELDS.forEach((field) => merged.set(field.key, field));
  orgDefaults.forEach((field) => merged.set(field.key, { ...field, source: "org_default" }));
  eventExtras.forEach((field) => merged.set(field.key, { ...field, source: "event_extra" }));
  return Array.from(merged.values());
}

export function customFields(fields: FormField[]): CustomFormField[] {
  return fields.filter((field): field is CustomFormField => field.source !== "base");
}

const blankToUndefined = (value: unknown) =>
  value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0)
    ? undefined
    : value;

const numericString = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function answerSchema(field: FormFieldDefinition): z.ZodTypeAny {
  const rules = field.validation ?? {};
  switch (field.type) {
    case "text":
    case "textarea": {
      let schema = z.string().trim().max(rules.max_length ?? DEFAULT_MAX_LENGTH[field.type]);
      if (rules.min_length !== undefined) schema = schema.min(rules.min_length);
      return schema;
    }
    case "email":
      return z.string().trim().email().max(rules.max_length ?? DEFAULT_MAX_LENGTH.email);
    case "number": {
      let schema = z.number().finite();
      if (rules.integer) schema = schema.int();
      if (rules.min !== undefined) schema = schema.min(rules.min);
      if (rules.max !== undefined) schema = schema.max(rules.max);
      return z.preprocess(
        (value) => typeof value === "string" && numericString.test(value.trim()) ? Number(value.trim()) : value,
        schema,
      );
    }
    case "select":
      return z.enum(field.options as [string, ...string[]]);
    case "multiselect": {
      const options = field.options as [string, ...string[]];
      return z.array(z.enum(options))
        .min(Math.max(rules.min_items ?? 0, field.required ? 1 : 0))
        .max(rules.max_items ?? options.length)
        .refine((values) => new Set(values).size === values.length, "Choose each option at most once");
    }
    case "checkbox":
      return field.required ? z.literal(true, { errorMap: () => ({ message: "This box must be checked" }) }) : z.boolean();
    case "date": {
      let schema: z.ZodTypeAny = isoDate;
      if (rules.min_date) schema = schema.refine((value: string) => value >= rules.min_date!, `Date must be on or after ${rules.min_date}`);
      if (rules.max_date) schema = schema.refine((value: string) => value <= rules.max_date!, `Date must be on or before ${rules.max_date}`);
      return schema;
    }
  }
}

/**
 * Builds the validator for the custom answers of a resolved form. Blank values count as
 * unanswered, unknown keys are rejected, and unanswered optional fields are omitted from the result.
 */
export function buildAnswersSchema(fields: FormField[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of customFields(fields)) {
    const inner = answerSchema(field);
    shape[field.key] = z.preprocess(blankToUndefined, field.required ? inner : inner.optional());
  }
  return z.object(shape).strict().transform((answers) =>
    Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== undefined)) as Record<string, unknown>);
}

export function normalizeStudentNumber(s: string): string {
  return s.replace(/[-\s]/g, "").trim().toUpperCase();
}
