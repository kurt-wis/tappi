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
  created_at: string;
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