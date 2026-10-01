import { handler, ok, ApiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";

export const GET = handler(async () => {
  const supabase = await createClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) throw ApiError.unauthorized();

  // 1. Find all member rows linked to this auth user
  const { data: members } = await supabase
    .from("members")
    .select("id, org_id, student_number, full_name, email, lost_card_flag, organizations(name, slug)")
    .eq("user_id", userData.user.id)
    .returns<
      {
        id: string;
        org_id: string;
        student_number: string | null;
        full_name: string;
        email: string | null;
        lost_card_flag: boolean;
        organizations: { name: string; slug: string } | null;
      }[]
    >();

  if (!members || members.length === 0) {
    throw ApiError.forbidden("This account is not linked to any student record");
  }

  const memberIds = members.map((m) => m.id);

  // 2. Fetch attendance, credits, certs in parallel
  const [attendanceRes, creditsRes, certsRes] = await Promise.all([
    supabase
      .from("attendance")
      .select("member_id, event_id, status, time_in, time_out, events(title, starts_at)")
      .in("member_id", memberIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("points_ledger")
      .select("member_id, points, reason, created_at")
      .in("member_id", memberIds),
    supabase
      .from("certificates")
      .select("id, event_id, member_id, code, issued_at, revoked_at, events(title)")
      .in("member_id", memberIds)
      .is("revoked_at", null),
  ]);

  type AttendanceRow = {
    member_id: string;
    event_id: string;
    status: string;
    time_in: string | null;
    time_out: string | null;
    events: { title: string; starts_at: string } | null;
  };
  type CreditRow = { member_id: string; points: number; reason: string; created_at: string };
  type CertRow = {
    id: string;
    event_id: string;
    member_id: string;
    code: string;
    issued_at: string;
    revoked_at: string | null;
    events: { title: string } | null;
  };

  const attendance = (attendanceRes.data ?? []) as unknown as AttendanceRow[];
  const credits = (creditsRes.data ?? []) as CreditRow[];
  const certs = (certsRes.data ?? []) as unknown as CertRow[];

  // 3. Group per org
  const orgs = members.map((m) => {
    const myAtt = attendance.filter((a) => a.member_id === m.id);
    const present = myAtt.filter((a) => a.status === "present").length;
    const late = myAtt.filter((a) => a.status === "late").length;
    const walkIn = myAtt.filter((a) => a.status === "walk_in").length;
    const absent = myAtt.filter((a) => a.status === "absent").length;
    const tappies = present + late + walkIn;
    const myCredits = credits
      .filter((c) => c.member_id === m.id)
      .reduce((sum, c) => sum + c.points, 0);

    return {
      org_id: m.org_id,
      org_name: m.organizations?.name ?? "",
      org_slug: m.organizations?.slug ?? "",
      member_id: m.id,
      student_number: m.student_number,
      full_name: m.full_name,
      email: m.email,
      lost_card_flag: m.lost_card_flag,
      tappies,
      credits: myCredits,
      attendance_summary: { present, late, walk_in: walkIn, absent, attended: tappies },
      attendance_history: myAtt.map((a) => ({
        event_id: a.event_id,
        event_title: a.events?.title ?? "",
        event_starts_at: a.events?.starts_at ?? "",
        status: a.status,
        time_in: a.time_in,
        time_out: a.time_out,
      })),
      certificates: certs
        .filter((c) => c.member_id === m.id)
        .map((c) => ({
          id: c.id,
          event_id: c.event_id,
          event_title: c.events?.title ?? "",
          code: c.code,
          issued_at: c.issued_at,
        })),
    };
  });

  return ok({ user_id: userData.user.id, orgs });
});