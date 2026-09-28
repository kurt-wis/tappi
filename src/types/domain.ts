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

/** The raw decimal string the USB RFID wedge reader types, e.g. "2035787938". */
export type CardUid = string;

export type Member = {
  id: string;
  org_id: string;
  student_number: string;
  full_name: string;
  email: string | null;
  course: string | null;
  member_role: string;
  status: MemberStatus;
  card_uid: CardUid | null;
  card_linked_at: string | null;
  /** Only populated on responses from the card-linking endpoints; omitted from generic member CRUD. */
  card_linked_by?: string | null;
  created_at: string;
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
  published_at: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** One row of an event's master list (expected attendees), as returned to the API layer. */
export type EventMasterListEntry = {
  member_id: string;
  added_at: string;
  added_by: string | null;
};

/** listMasterList's shape: a master-list row with its member embedded via the Supabase FK join. */
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

/** Result returned by the scan endpoint to the scanner operator screen. */
export type ScanResult =
  | { outcome: "present" | "late" | "walk_in"; member: Pick<Member, "id" | "full_name" | "student_number">; at: string }
  | { outcome: "duplicate"; member: Pick<Member, "id" | "full_name" | "student_number">; first_seen_at: string }
  | { outcome: "unknown_card"; card_uid: CardUid }
  | { outcome: "not_on_master_list"; member: Pick<Member, "id" | "full_name" | "student_number"> };
/** points_ledger row. Credits = sum of points; finalize writes reason "event_attendance". */
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

/** Attendance report rows include master-list members who haven't tapped into a live event yet. */
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

/** Per-member credits + Tappies (consecutive attended events) + attendance counts. */
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
  /** present + late + walk_in */
  attended: number;
  /** attended / (attended + absent), or null when the member has no completed-event history. */
  attendance_rate: number | null;
  current_tappies: number;
  longest_tappies: number;
  certificates_issued: number;
};
