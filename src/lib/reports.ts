import { z } from "zod";
import type { AuthContext } from "@/lib/supabase/server";
import { requireRole } from "@/lib/supabase/server";
import { ApiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { memberId as memberIdSchema, memberStatus } from "@/lib/members";
import { toCsv } from "@/lib/members-csv";
import { renderTablePdf, type PdfColumn } from "@/lib/pdf";
import type { AttendanceReportRow, MemberSummary } from "@/types/domain";

const isoDateTime = z.string().datetime({ offset: true });
const optionalText = z.string().trim().min(1).max(200).optional();

/** Exports ignore pagination but are capped; above this, the caller must narrow filters. */
export const EXPORT_ROW_LIMIT = 10_000;

export const reportFormat = z.enum(["json", "csv", "pdf"]).default("json");

const pagination = {
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  per_page: z.coerce.number().int().min(1).max(1_000_000).default(50).transform((n) => Math.min(n, 200)),
};

export const reportAttendanceStatus = z.enum(["present", "late", "walk_in", "absent", "not_scanned"]);

export const attendanceReportQuerySchema = z.object({
  event_id: z.string().uuid().optional(),
  /** Comma-separated, e.g. "present,late". */
  status: z.string().optional()
    .transform((value) => value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined)
    .pipe(z.array(reportAttendanceStatus).min(1).optional()),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  search: optionalText,
  course: optionalText,
  format: reportFormat,
  ...pagination,
}).strict();

export const memberReportQuerySchema = z.object({
  status: memberStatus.optional(),
  search: optionalText,
  course: optionalText,
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  format: reportFormat,
  ...pagination,
}).strict();

type WithTotal<T> = T & { total_count: number };

type ReportFile = { filename: string; contentType: string; body: string | Uint8Array };
export type ReportResult<Row> =
  | { kind: "json"; data: { rows: Row[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } }
  | { kind: "file"; file: ReportFile };

function paged<Row>(rows: Row[], total: number, page: number, per_page: number) {
  return { rows, pagination: { page, per_page, total, total_pages: Math.ceil(total / per_page) } };
}

function stripTotal<T>(rows: WithTotal<T>[]): { rows: T[]; total: number } {
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(({ total_count: _total, ...row }) => row as T), total };
}

function assertExportable(total: number) {
  if (total > EXPORT_ROW_LIMIT) {
    throw new ApiError(
      "validation_error",
      `Export would contain ${total} rows (max ${EXPORT_ROW_LIMIT}); narrow the filters`,
      422,
    );
  }
}

function cell(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// Attendance report
// ---------------------------------------------------------------

const ATTENDANCE_COLUMNS: Array<PdfColumn & { key: keyof AttendanceReportRow; csv: string }> = [
  { key: "event_title", csv: "event_title", header: "Event", width: 2.6 },
  { key: "event_starts_at", csv: "event_starts_at", header: "Event date", width: 1.7 },
  { key: "student_number", csv: "student_number", header: "Student #", width: 1.3 },
  { key: "full_name", csv: "full_name", header: "Name", width: 2.5 },
  { key: "course", csv: "course", header: "Course", width: 1.1 },
  { key: "status", csv: "status", header: "Status", width: 1.2 },
  { key: "time_in", csv: "time_in", header: "Time in", width: 1.7 },
  { key: "method", csv: "method", header: "Method", width: 0.8 },
  { key: "certificate_eligible", csv: "certificate_eligible", header: "Eligible", width: 0.9 },
  { key: "certificate_code", csv: "certificate_code", header: "Certificate", width: 3 },
];

function certificateCell(row: AttendanceReportRow): string {
  if (!row.certificate_code) return "";
  return row.certificate_revoked_at ? `${row.certificate_code} (revoked)` : row.certificate_code;
}

async function fetchAttendanceReport(
  ctx: AuthContext,
  query: z.infer<typeof attendanceReportQuerySchema>,
  limit: number,
  offset: number,
) {
  const { data, error } = await supabaseAdmin().rpc("report_attendance", {
    p_org_id: ctx.orgId,
    p_event_id: query.event_id ?? null,
    p_statuses: query.status ?? null,
    p_from: query.from ?? null,
    p_to: query.to ?? null,
    p_search: query.search ?? null,
    p_course: query.course ?? null,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return stripTotal((data ?? []) as WithTotal<AttendanceReportRow>[]);
}

/** Officer-gated: the report spans the whole org's attendance history. */
export async function attendanceReport(ctx: AuthContext, input: unknown): Promise<ReportResult<AttendanceReportRow>> {
  requireRole(ctx, ["officer"]);
  const query = attendanceReportQuerySchema.parse(input);

  if (query.format === "json") {
    const { rows, total } = await fetchAttendanceReport(ctx, query, query.per_page, (query.page - 1) * query.per_page);
    return { kind: "json", data: paged(rows, total, query.page, query.per_page) };
  }

  const { rows, total } = await fetchAttendanceReport(ctx, query, EXPORT_ROW_LIMIT + 1, 0);
  assertExportable(total);
  const values = (row: AttendanceReportRow) => ATTENDANCE_COLUMNS.map((column) =>
    column.key === "certificate_code" ? certificateCell(row) : cell(row[column.key]));
  const filename = `attendance-${dateStamp()}`;

  if (query.format === "csv") {
    return { kind: "file", file: {
      filename: `${filename}.csv`, contentType: "text/csv; charset=utf-8",
      body: toCsv([ATTENDANCE_COLUMNS.map((c) => c.csv), ...rows.map(values)]),
    } };
  }

  const body = await renderTablePdf({
    title: "Attendance report",
    subtitle: describeFilters(query),
    columns: ATTENDANCE_COLUMNS,
    rows: rows.map((row) => values({
      ...row,
      event_starts_at: formatDateTime(row.event_starts_at),
      time_in: row.time_in ? formatDateTime(row.time_in) : null,
      certificate_eligible: (row.certificate_eligible ? "Yes" : "No") as never,
    })),
  });
  return { kind: "file", file: { filename: `${filename}.pdf`, contentType: "application/pdf", body } };
}

// ---------------------------------------------------------------
// Member summary report (credits + Tappies)
// ---------------------------------------------------------------

type MemberSummaryRow = Omit<MemberSummary, "attended" | "attendance_rate">;

const MEMBER_COLUMNS: Array<PdfColumn & { key: keyof MemberSummary; csv: string }> = [
  { key: "student_number", csv: "student_number", header: "Student #", width: 1.6 },
  { key: "full_name", csv: "full_name", header: "Name", width: 3 },
  { key: "course", csv: "course", header: "Course", width: 1.6 },
  { key: "status", csv: "status", header: "Status", width: 1.1 },
  { key: "credits", csv: "credits", header: "Credits", width: 1, align: "right" },
  { key: "attended", csv: "attended", header: "Attended", width: 1, align: "right" },
  { key: "late", csv: "late", header: "Late", width: 0.8, align: "right" },
  { key: "walk_in", csv: "walk_in", header: "Walk-in", width: 0.9, align: "right" },
  { key: "absent", csv: "absent", header: "Absent", width: 0.9, align: "right" },
  { key: "attendance_rate", csv: "attendance_rate", header: "Rate", width: 0.9, align: "right" },
  { key: "current_tappies", csv: "current_tappies", header: "Tappies", width: 1, align: "right" },
  { key: "longest_tappies", csv: "longest_tappies", header: "Best", width: 0.8, align: "right" },
  { key: "certificates_issued", csv: "certificates_issued", header: "Certs", width: 0.8, align: "right" },
];

/** bigint columns arrive as numbers from PostgREST; derive attended + rate here. */
export function toMemberSummary(row: MemberSummaryRow): MemberSummary {
  const n = (value: unknown) => Number(value ?? 0);
  const present = n(row.present), late = n(row.late), walkIn = n(row.walk_in), absent = n(row.absent);
  const attended = present + late + walkIn;
  return {
    ...row,
    credits: n(row.credits),
    present, late, walk_in: walkIn, absent,
    attended,
    attendance_rate: attended + absent > 0 ? Math.round((attended / (attended + absent)) * 10_000) / 10_000 : null,
    current_tappies: n(row.current_tappies),
    longest_tappies: n(row.longest_tappies),
    certificates_issued: n(row.certificates_issued),
  };
}

async function fetchMemberSummaries(
  params: {
    orgId: string; memberId?: string; status?: string; search?: string; course?: string;
    from?: string; to?: string;
  },
  limit: number,
  offset: number,
) {
  const { data, error } = await supabaseAdmin().rpc("report_member_summary", {
    p_org_id: params.orgId,
    p_member_id: params.memberId ?? null,
    p_status: params.status ?? null,
    p_search: params.search ?? null,
    p_course: params.course ?? null,
    p_from: params.from ?? null,
    p_to: params.to ?? null,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  const { rows, total } = stripTotal((data ?? []) as WithTotal<MemberSummaryRow>[]);
  return { rows: rows.map(toMemberSummary), total };
}

export async function memberSummaryReport(ctx: AuthContext, input: unknown): Promise<ReportResult<MemberSummary>> {
  requireRole(ctx, ["officer"]);
  const query = memberReportQuerySchema.parse(input);
  const params = { orgId: ctx.orgId, ...query };

  if (query.format === "json") {
    const { rows, total } = await fetchMemberSummaries(params, query.per_page, (query.page - 1) * query.per_page);
    return { kind: "json", data: paged(rows, total, query.page, query.per_page) };
  }

  const { rows, total } = await fetchMemberSummaries(params, EXPORT_ROW_LIMIT + 1, 0);
  assertExportable(total);
  const filename = `member-summary-${dateStamp()}`;

  if (query.format === "csv") {
    return { kind: "file", file: {
      filename: `${filename}.csv`, contentType: "text/csv; charset=utf-8",
      body: toCsv([MEMBER_COLUMNS.map((c) => c.csv), ...rows.map((row) => MEMBER_COLUMNS.map((c) => cell(row[c.key])))]),
    } };
  }

  const body = await renderTablePdf({
    title: "Member credits & Tappies",
    subtitle: describeFilters(query),
    columns: MEMBER_COLUMNS,
    rows: rows.map((row) => MEMBER_COLUMNS.map((c) => c.key === "attendance_rate"
      ? (row.attendance_rate === null ? "" : `${Math.round(row.attendance_rate * 100)}%`)
      : cell(row[c.key]))),
  });
  return { kind: "file", file: { filename: `${filename}.pdf`, contentType: "application/pdf", body } };
}

/** Lifetime summary for one member. Readable by any signed-in org user, like getMember. */
export async function getMemberSummary(ctx: AuthContext, id: string): Promise<MemberSummary> {
  memberIdSchema.parse(id);
  const { rows } = await fetchMemberSummaries({ orgId: ctx.orgId, memberId: id }, 1, 0);
  if (rows.length === 0) throw ApiError.notFound("Member not found");
  return rows[0];
}

// ---------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------

/** PDF cells only; the subtitle states "times in UTC" once. Fixed UTC keeps exports server-locale independent. */
function formatDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

function describeFilters(query: Record<string, unknown>): string {
  const parts: string[] = [];
  const labels: Record<string, string> = {
    event_id: "Event", status: "Status", from: "From", to: "To", search: "Search", course: "Course",
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    parts.push(`${label}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  }
  return `Generated ${formatDateTime(new Date().toISOString())} · Times in UTC` +
    (parts.length > 0 ? ` · ${parts.join(" · ")}` : "");
}
