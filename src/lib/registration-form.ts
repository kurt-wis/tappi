import { z } from "zod";

export type FormFieldType = "text" | "email" | "number" | "select" | "checkbox" | "textarea";

export type FormField = {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  source: "base" | "org_default" | "event_extra";
  options?: string[] | null;
  position?: number;
};

export const BASE_FIELDS: FormField[] = [
  { key: "full_name", label: "Full Name", type: "text", required: true, source: "base" },
  { key: "student_number", label: "Student Number", type: "text", required: true, source: "base" },
  { key: "email", label: "Email", type: "email", required: true, source: "base" },
];

export function resolveFormSchema(
  orgDefaults: FormField[] = [],
  eventExtras: FormField[] = [],
): FormField[] {
  const merged = new Map<string, FormField>();
  [...BASE_FIELDS, ...orgDefaults, ...eventExtras].forEach((f) => merged.set(f.key, f));
  return Array.from(merged.values());
}

export function buildAnswersSchema(fields: FormField[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    if (f.source === "base") continue;
    let fieldSchema: z.ZodTypeAny;
    switch (f.type) {
      case "email":
        fieldSchema = z.string().email().max(254);
        break;
      case "number":
        fieldSchema = z.coerce.number();
        break;
      case "checkbox":
        fieldSchema = z.boolean();
        break;
      case "select":
        fieldSchema = z.string();
        break;
      case "textarea":
        fieldSchema = z.string().max(2000);
        break;
      default:
        fieldSchema = z.string().max(500);
    }
    shape[f.key] = f.required ? fieldSchema : fieldSchema.optional();
  }
  return z.object(shape).strict();
}

export function normalizeStudentNumber(s: string): string {
  return s.replace(/[-\s]/g, "").trim();
}