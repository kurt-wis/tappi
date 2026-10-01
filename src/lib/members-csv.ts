import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { createMemberSchema } from "@/lib/members";

export const IMPORT_REQUIRED_COLUMNS = ["student_number", "full_name", "member_role"] as const;
export const IMPORT_OPTIONAL_COLUMNS = ["email", "course"] as const;
export const IMPORT_COLUMNS = [...IMPORT_REQUIRED_COLUMNS, ...IMPORT_OPTIONAL_COLUMNS] as const;

export const EXPORT_COLUMNS = [
  "student_number", "full_name", "email", "course", "member_role",
  "status", "card_uid", "card_linked_at", "created_at",
] as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += char; i++; continue;
    }
    if (char === '"') { inQuotes = true; i++; continue; }
    if (char === ",") { pushField(); i++; continue; }
    if (char === "\r") { i++; continue; }
    if (char === "\n") { pushRow(); i++; continue; }
    field += char; i++;
  }
  if (inQuotes) throw new ApiError("validation_error", "CSV contains an unterminated quoted field", 422);
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function serializeCsvField(value: string): string {
  if (/^[\t\r\n ]*[=+@-]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value)) value = "'" + value;
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(serializeCsvField).join(",")).join("\r\n") + "\r\n";
}

export type ImportRowResult =
  | { row: number; student_number: string | null; result: "created" }
  | { row: number; student_number: string | null; result: "updated" }
  | { row: number; student_number: string | null; result: "skipped"; reason: string };

export type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  rows: ImportRowResult[];
};

export async function importMembers(ctx: AuthContext, csvText: string): Promise<ImportSummary> {
  requireRole(ctx, ["officer"]);

  const rows = parseCsv(csvText.trim());
  if (rows.length === 0) throw new ApiError("validation_error", "CSV is empty", 422);

  const [header, ...dataRows] = rows;
  const missing = IMPORT_REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new ApiError("validation_error", `CSV is missing required column(s): ${missing.join(", ")}`, 422);
  }

  const summary: ImportSummary = { created: 0, updated: 0, skipped: 0, rows: [] };

  for (const [index, raw] of dataRows.entries()) {
    const rowNumber = index + 2;
    const record: Record<string, string> = {};
    header.forEach((column, columnIndex) => { record[column] = raw[columnIndex] ?? ""; });

    const candidate = {
      student_number: (record.student_number ?? "").trim(),
      full_name: (record.full_name ?? "").trim(),
      member_role: (record.member_role ?? "").trim(),
      email: record.email?.trim() ? record.email.trim() : null,
      course: record.course?.trim() ? record.course.trim() : null,
    };
    const parsed = createMemberSchema.safeParse(candidate);
    if (!parsed.success) {
      summary.skipped++;
      summary.rows.push({
        row: rowNumber,
        student_number: candidate.student_number || null,
        result: "skipped",
        reason: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
      continue;
    }
    const member = parsed.data;

    const { data: existing, error: lookupError } = await ctx.supabase.from("members")
      .select("id").eq("org_id", ctx.orgId).eq("student_number", member.student_number).maybeSingle();
    if (lookupError) throw lookupError;

    if (existing) {
      const { error } = await ctx.supabase.from("members")
        .update({ full_name: member.full_name, email: member.email, course: member.course, member_role: member.member_role })
        .eq("org_id", ctx.orgId).eq("id", existing.id);
      if (error) {
        summary.skipped++;
        summary.rows.push({ row: rowNumber, student_number: member.student_number, result: "skipped", reason: error.message });
        continue;
      }
      summary.updated++;
      summary.rows.push({ row: rowNumber, student_number: member.student_number, result: "updated" });
    } else {
      const { error } = await ctx.supabase.from("members").insert({ ...member, org_id: ctx.orgId });
      if (error) {
        summary.skipped++;
        summary.rows.push({ row: rowNumber, student_number: member.student_number, result: "skipped", reason: error.message });
        continue;
      }
      summary.created++;
      summary.rows.push({ row: rowNumber, student_number: member.student_number, result: "created" });
    }
  }

  return summary;
}

export async function exportMembersCsv(ctx: AuthContext): Promise<string> {
  const data: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: page, error } = await ctx.supabase.from("members")
      .select(EXPORT_COLUMNS.join(","))
      .eq("org_id", ctx.orgId)
      .order("full_name").order("id").range(offset, offset + 999);
    if (error) throw error;
    data.push(...((page ?? []) as unknown as Record<string, unknown>[]));
    if ((page ?? []).length < 1000) break;
  }

  const body = (data ?? []).map((row) => EXPORT_COLUMNS.map((column) => {
    const value = (row as unknown as Record<string, unknown>)[column];
    return value === null || value === undefined ? "" : String(value);
  }));
  return toCsv([[...EXPORT_COLUMNS], ...body]);
}
