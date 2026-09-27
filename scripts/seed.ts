import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

const SEED_MARKER = 'tappi-test-org-v1';
const PASSWORD = 'password123';

// Fixed IDs make retries safe, including a retry after a partially failed run.
export function seedId(name: string): string {
  const hex = createHash('sha256').update(`${SEED_MARKER}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const seedAccounts = [
  { email: 'admin@test.local', full_name: 'Test Administrator', role: 'org_admin' },
  { email: 'officer@test.local', full_name: 'Test Officer', role: 'officer' },
  { email: 'scanner@test.local', full_name: 'Test Scanner Operator', role: 'scanner_operator' },
] as const;

export const seedMembers = [
  ['Alyssa Santos', 'BS Computer Science'],
  ['Marco Reyes', 'BS Information Technology'],
  ['Isabella Cruz', 'BS Business Administration'],
  ['Gabriel Garcia', 'BS Computer Science'],
  ['Sofia Mendoza', 'BS Psychology'],
  ['Daniel Ramos', 'BS Information Technology'],
  ['Camille Flores', 'BS Accountancy'],
  ['Joshua Torres', 'BS Civil Engineering'],
  ['Bianca Dela Cruz', 'BS Psychology'],
  ['Nathan Villanueva', 'BS Business Administration'],
].map(([full_name, course], index) => ({
  id: seedId(`member-${index + 1}`),
  student_number: `2026-${String(index + 1).padStart(4, '0')}`,
  full_name,
  email: `student${index + 1}@test.local`,
  course,
  member_role: 'member',
  status: 'active',
  card_uid: index < 5 ? String(2035787938 + index) : null,
}));

function check(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`${action}: ${error.message}`);
}

async function existingAccounts(client: SupabaseClient): Promise<Map<string, User>> {
  const wanted = new Set<string>(seedAccounts.map((account) => account.email));
  const users = new Map<string, User>();
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    check(error, 'Read existing login accounts');
    for (const user of data.users) {
      const email = user.email?.toLowerCase();
      if (email && wanted.has(email)) {
        if (user.app_metadata.tappi_seed !== SEED_MARKER) {
          throw new Error(`Refusing to modify existing account ${email}: it was not created by this seed.`);
        }
        users.set(email, user);
      }
    }
    if (data.users.length < 1000) return users;
  }
}

export async function seed(client: SupabaseClient): Promise<void> {
  const orgId = seedId('org');
  const accounts = await existingAccounts(client);
  const { data: existingOrg, error: orgLookupError } = await client
    .from('organizations').select('id, settings').eq('slug', 'test-org').maybeSingle();
  check(orgLookupError, 'Look up Test Org');
  if (existingOrg && (existingOrg.id !== orgId || existingOrg.settings?.tappi_seed !== SEED_MARKER)) {
    throw new Error('Refusing to modify test-org: it was not created by this seed. Use an empty test database or rename the existing organization.');
  }
  const { data: orgById, error: orgIdError } = await client
    .from('organizations').select('slug, settings').eq('id', orgId).maybeSingle();
  check(orgIdError, 'Check organization ID');
  if (orgById && (orgById.slug !== 'test-org' || orgById.settings?.tappi_seed !== SEED_MARKER)) {
    throw new Error('Seed organization ID belongs to an unrelated organization.');
  }
  const { error: orgError } = await client.from('organizations').upsert({
    id: orgId, name: 'Test Org', slug: 'test-org', settings: { tappi_seed: SEED_MARKER },
  }, { onConflict: 'id', ignoreDuplicates: true });
  check(orgError, 'Create Test Org');

  let adminId = '';
  for (const account of seedAccounts) {
    let user = accounts.get(account.email);
    if (!user) {
      const { data, error } = await client.auth.admin.createUser({
        email: account.email,
        password: PASSWORD,
        email_confirm: true,
        app_metadata: { tappi_seed: SEED_MARKER },
        user_metadata: { full_name: account.full_name },
      });
      check(error, `Create ${account.role} account`);
      if (!data.user) throw new Error(`No user returned for ${account.email}`);
      user = data.user;
    }
    const { data: profile, error: profileLookupError } = await client
      .from('profiles').select('org_id, role, email, is_active').eq('id', user.id).maybeSingle();
    check(profileLookupError, `Look up ${account.role} profile`);
    if (profile && (profile.org_id !== orgId || profile.email.toLowerCase() !== account.email || profile.role !== account.role)) {
      throw new Error(`Refusing to overwrite a changed or unrelated profile for ${account.email}.`);
    }
    const { error: profileError } = await client.from('profiles').upsert({
      id: user.id, org_id: orgId, ...account, is_active: true,
    }, { onConflict: 'id', ignoreDuplicates: true });
    check(profileError, `Create ${account.role} profile`);
    if (profile && !profile.is_active) {
      // Restore access only for this verified fixture; preserve its other edits.
      const { data: reactivated, error: activationError } = await client.from('profiles')
        .update({ is_active: true }).eq('id', user.id).eq('org_id', orgId)
        .eq('role', account.role).eq('email', account.email).select('id').maybeSingle();
      check(activationError, `Reactivate ${account.role} test profile`);
      if (!reactivated) throw new Error(`Profile ownership changed while reactivating ${account.email}.`);
    }
    // These are dedicated test accounts; ensure the printed credentials work on reruns.
    const { error: passwordError } = await client.auth.admin.updateUserById(user.id, {
      password: PASSWORD, email_confirm: true,
    });
    check(passwordError, `Set ${account.role} test password`);
    if (account.role === 'org_admin') adminId = user.id;
  }

  for (const member of seedMembers) {
    const { data: existing, error: lookupError } = await client.from('members')
      .select('org_id, student_number').eq('id', member.id).maybeSingle();
    check(lookupError, `Look up member ${member.student_number}`);
    if (existing && (existing.org_id !== orgId || existing.student_number !== member.student_number)) {
      throw new Error(`Seed member ID conflict for ${member.student_number}.`);
    }
    const { error } = await client.from('members').upsert({
      ...member,
      org_id: orgId,
      card_linked_at: member.card_uid ? '2026-09-01T00:00:00.000Z' : null,
      card_linked_by: member.card_uid ? adminId : null,
    }, { onConflict: 'id', ignoreDuplicates: true });
    check(error, `Create member ${member.student_number}`);
  }

  const eventIds = { draft: seedId('draft-event'), published: seedId('published-event') };
  for (const status of ['draft', 'published'] as const) {
    const { data: existing, error: lookupError } = await client.from('events')
      .select('org_id').eq('id', eventIds[status]).maybeSingle();
    check(lookupError, `Look up ${status} event`);
    if (existing && existing.org_id !== orgId) throw new Error(`Seed ${status} event ID belongs to another organization.`);
    const { error } = await client.from('events').upsert({
      id: eventIds[status], org_id: orgId,
      title: status === 'draft' ? 'Planning Workshop' : 'Student Welcome Assembly',
      description: 'Sample event created by the Tappi test seed.',
      venue: status === 'draft' ? 'Meeting Room A' : 'Main Auditorium',
      starts_at: status === 'draft' ? '2026-10-15T01:00:00.000Z' : '2026-10-10T01:00:00.000Z',
      ends_at: status === 'draft' ? '2026-10-15T03:00:00.000Z' : '2026-10-10T03:00:00.000Z',
      status, walk_in_policy: 'closed', created_by: adminId, slots: 50,
    }, { onConflict: 'id', ignoreDuplicates: true });
    check(error, `Create ${status} event`);
  }
  const { error: masterListError } = await client.from('event_master_list').upsert(
    seedMembers.map((member) => ({ event_id: eventIds.published, member_id: member.id })),
    { onConflict: 'event_id,member_id', ignoreDuplicates: true },
  );
  check(masterListError, 'Populate published event master list');
}

async function main(): Promise<void> {
  // Existing shell variables win; .env.local takes precedence over .env.
  for (const filename of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), filename);
    if (existsSync(path)) process.loadEnvFile(path);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local before seeding.');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await seed(client);
  console.log('Seed complete: Test Org, 3 accounts, 10 members (5 cards), and 2 events.');
  console.log('Admin login: admin@test.local / password123');
}

// Works with tsx's CommonJS mode as well as ESM, while allowing test imports.
if (process.argv[1] && /(?:^|[\\/])scripts[\\/]seed\.(?:ts|js)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode = 1;
  });
}
