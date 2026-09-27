import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { createMemberSchema } from "@/lib/members";

/**
 * CSV columns for /api/members/import. Identity fields only — card linking
 * always goes through the audited link/replace/unlink endpoints, never
 * through import, so card_uid is intentionally not one of these.
 */
export const IMPORT_REQUIRED_COLUMNS = ["student_number", "full_name", "member_role"] as const;
export const IMPORT_OPTIONAL_COLUMNS = ["email", "course"] as const;
export const IMPORT_COLUMNS = [...IMPORT_REQUIRED_COLUMNS, ...IMPORT_OPTIONAL_COLUMNS] as const;

/** CSV columns for /api/members/export. Read-only reference fields, including card state. */
export const EXPORT_COLUMNS = [
  "student_number", "full_name", "email", "course", "member_role",
  "status", "card_uid", "card_linked_at", "created_at",
] as const;

// ---------------------------------------------------------------
// Minimal RFC 4180 CSV parsing/serializing. No dependency: import files are
// roster-sized (tens to low thousands of rows), so a streaming/library
// parser isn't warranted. Supports quoted fields, embedded commas/quotes/
// newlines (doubled-quote escaping), and CRLF or LF line endings.
// ---------------------------------------------------------------

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
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop wholly-blank rows (e.g. a trailing newline) but keep intentional single-empty-field rows.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function serializeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(serializeCsvField).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------
// Import
// ---------------------------------------------------------------

export type ImportRowResult =
  | { row: number; student_number: string; result: "created" }
  | { row: number; student_number: string; result: "updated" }
  | { row: number; student_number: string | null; result: "skipped"; reason: string };

export type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  rows: ImportRowResult[];
};

/**
 * Upsert key is student_number within the caller's org. A matching row
 * updates full_name/email/course/member_role (full replace of those
 * fields); no match creates a new member. Per-row validation or database
 * errors are recorded as "skipped" rather than failing the whole import —
 * one bad row in a roster shouldn't block the rest.
 */
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
    const rowNumber = index + 2; // +1 for the header row, +1 for 1-indexing
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

// ---------------------------------------------------------------
// Export
// ---------------------------------------------------------------

/** Readable by any authenticated org member (not officer-gated) — see prompt's suggested behavior. */
export async function exportMembersCsv(ctx: AuthContext): Promise<string> {
  const { data, error } = await ctx.supabase.from("members")
    .select(EXPORT_COLUMNS.join(","))
    .eq("org_id", ctx.orgId)
    .order("full_name").order("id");
  if (error) throw error;

  const body = (data ?? []).map((row) => EXPORT_COLUMNS.map((column) => {
    const value = (row as unknown as Record<string, unknown>)[column];
    return value === null || value === undefined ? "" : String(value);
  }));
  return toCsv([[...EXPORT_COLUMNS], ...body]);
}
