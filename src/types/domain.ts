import type { FormFieldDefinition } from "@/lib/registration-form";

export type OrgRole = "org_admin" | "officer" | "scanner_operator";
export type MemberStatus = "active" | "inactive" | "archived";
export type EventStatus = "draft" | "published" | "cancelled" | "completed";
export type WalkInPolicy = "open" | "approval" | "closed";
export type RegistrationStatus = "pending" | "approved" | "denied";
export type AttendanceStatus = "present" | "late" | "walk_in" | "absent";
export type ScanMethod = "tap" | "manual" | "offline_sync";
export type NotificationType =
  | "event_reminder"
  | "absentee_alert"
  | "late_alert"
  | "officer_alert";

export type CardUid = string;

export type Member = {
  id: string;
  org_id: string;
  student_number: string | null;
  full_name: string;
  email: string | null;
  course: string | null;
  member_role: string;
  status: MemberStatus;
  card_uid: CardUid | null;
  card_linked_at: string | null;

  card_linked_by?: string | null;
  created_at: string;
  lost_card_flag: boolean;
};

export type CardLinkAction = "link" | "relink" | "unlink";

export type CardLinkAudit = {
  id: string;
  org_id: string;
  member_id: string;
  old_uid: CardUid | null;
  new_uid: CardUid | null;
  action: CardLinkAction;
  officer_id: string | null;
  created_at: string;
};

export type Event = {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  venue: string | null;
  starts_at: string;
  ends_at: string | null;
  grace_period_minutes: number;
  slots: number | null;
  walk_in_policy: WalkInPolicy;
  status: EventStatus;
  points_value: number;
  certificate_enabled: boolean;
  form_fields: FormFieldDefinition[];
  published_at: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type EventMasterListEntry = {
  member_id: string;
  added_at: string;
  added_by: string | null;
};

export type EventMasterListEntryWithMember = EventMasterListEntry & {
  members: Pick<Member, "id" | "full_name" | "student_number" | "email" | "course" | "member_role" | "status">;
};

export type Attendance = {
  id: string;
  event_id: string;
  org_id: string;
  member_id: string;
  status: AttendanceStatus;
  time_in: string | null;
  time_out: string | null;
  method: ScanMethod;
  scan_uid: CardUid | null;
  device_id: string | null;
  client_scan_id: string | null;
  created_at: string;
};

export type ScanResult =
  | { outcome: "present" | "late" | "walk_in"; member: Pick<Member, "id" | "full_name" | "student_number">; at: string }
  | { outcome: "duplicate"; member: Pick<Member, "id" | "full_name" | "student_number">; first_seen_at: string }
  | { outcome: "unknown_card"; card_uid: CardUid }
  | { outcome: "not_on_master_list"; member: Pick<Member, "id" | "full_name" | "student_number"> };

export type CreditEntry = {
  id: string;
  member_id: string;
  event_id: string | null;
  points: number;
  reason: string;
  awarded_by: string | null;
  created_at: string;
};

export type Certificate = {
  id: string;
  org_id: string;
  event_id: string;
  member_id: string;
  code: string;
  issued_by: string | null;
  issued_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
};

export type ReportAttendanceStatus = AttendanceStatus | "not_scanned";

export type AttendanceReportRow = {
  event_id: string;
  event_title: string;
  event_starts_at: string;
  event_status: EventStatus;
  member_id: string;
  student_number: string;
  full_name: string;
  course: string | null;
  status: ReportAttendanceStatus;
  time_in: string | null;
  time_out: string | null;
  method: ScanMethod | null;
  certificate_eligible: boolean;
  certificate_id: string | null;
  certificate_code: string | null;
  certificate_revoked_at: string | null;
};

export type MemberSummary = {
  member_id: string;
  student_number: string;
  full_name: string;
  course: string | null;
  status: MemberStatus;
  credits: number;
  present: number;
  late: number;
  walk_in: number;
  absent: number;

  attended: number;

  attendance_rate: number | null;
  current_tappies: number;
  longest_tappies: number;
  certificates_issued: number;
};

export type OtpCode = {
  id: string;
  email: string;
  purpose: "signup" | "activation" | "autofill";
  person_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

export type StudentOrgSummary = {
  org_id: string;
  org_name: string;
  org_slug: string;
  member_id: string;
  student_number: string | null;
  full_name: string;
  email: string | null;
  lost_card_flag: boolean;
  tappies: number;
  credits: number;
  attendance_summary: {
    present: number;
    late: number;
    walk_in: number;
    absent: number;
    attended: number;
  };
  attendance_history: Array<{
    event_id: string;
    event_title: string;
    event_starts_at: string;
    status: string;
    time_in: string | null;
    time_out: string | null;
  }>;
  certificates: Array<{
    id: string;
    event_id: string;
    event_title: string;
    code: string;
    issued_at: string;
  }>;
};

export type StudentMeResponse = {
  user_id: string;
  person_id: string;
  orgs: StudentOrgSummary[];
};

export type DeviceKind = "tapper" | "linking_station" | "spare";
export type DeviceStatus = "active" | "maintenance" | "retired" | "lost";

export type Device = {
  id: string;
  org_id: string;
  device_id: string;
  label: string | null;
  kind: DeviceKind;
  status: DeviceStatus;
  notes: string | null;
  last_seen_at: string | null;
  registered_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditLogEntry = {
  id: number;
  org_id: string;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
};
