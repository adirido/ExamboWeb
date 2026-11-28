import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import QRCode from 'npm:qrcode@1.5.4';

interface OptionItem {
  key: string;
  text: string;
}

interface TeacherTokenClaims {
  teacherId: number;
  nip: string;
  name: string;
  role: 'TEACHER' | 'ADMIN';
  exp: number;
}

interface QrPackagePayload {
  packageId: number;
  classId: number;
  subjectCode: string;
  title: string;
  issuedAt: number;
  nonce: string;
}

interface SessionRow {
  id: number;
  package_id: number;
  student_id: number;
  session_token: string;
  device_id: string;
  session_info: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'LOCKED_VIOLATION' | 'SUBMITTED';
  question_order_json: string;
  option_orders_json: string;
  started_at: number;
  expires_at: number;
  submitted_at: number | null;
  violation_count: number;
  unlock_bonus: number;
  score: number | null;
  correct_count: number | null;
  total_questions: number;
}

interface PackageEventPayload {
  type:
    | 'session:updated'
    | 'violation:alert'
    | 'session:unlocked'
    | 'package:status_changed'
    | 'package:token_rotated';
  packageId: number;
  studentId?: number;
  sessionId?: number;
  payload: Record<string, unknown>;
  timestamp: number;
}

type PackageAccessRole = 'ADMIN' | 'OWNER' | 'PROCTOR' | 'NONE';

function getPackageAccess(
  pkg: { teacher_id: number; proctor_id?: number | null },
  teacher: { teacherId: number; role: 'ADMIN' | 'TEACHER' }
): PackageAccessRole {
  if (teacher.role === 'ADMIN') return 'ADMIN';
  if (pkg.teacher_id === teacher.teacherId) return 'OWNER';
  if (pkg.proctor_id !== null && pkg.proctor_id !== undefined && Number(pkg.proctor_id) === teacher.teacherId) {
    return 'PROCTOR';
  }
  return 'NONE';
}

async function getEligibleSyncSiblings(
  supabase: SupabaseClient,
  pkgId: number,
  scheduleGroup: string
): Promise<Array<{ id: number; subject_id: number }>> {
  if (!scheduleGroup) return [];
  const { data: siblings } = await supabase
    .from('exam_packages')
    .select('id, subject_id')
    .eq('schedule_group', scheduleGroup)
    .neq('id', pkgId);

  const list = (siblings || []) as Array<{ id: number; subject_id: number }>;
  if (list.length === 0) return [];

  const sibIds = list.map((s) => s.id);
  const { data: sesRows } = await supabase
    .from('exam_sessions')
    .select('package_id')
    .in('package_id', sibIds);
  const busyPkgIds = new Set((sesRows || []).map((r: { package_id: number }) => r.package_id));

  return list.filter((s) => !busyPkgIds.has(s.id));
}

async function checkSupabaseSessionManageAccess(
  supabase: SupabaseClient,
  sessionId: number,
  teacher: { teacherId: number; role: 'ADMIN' | 'TEACHER' }
): Promise<{
  session?: SessionRow;
  pkg?: { id: number; teacher_id: number; proctor_id: number | null; max_violations: number };
  access?: PackageAccessRole;
  errorStatus?: number;
  errorMessage?: string;
}> {
  const { data: session } = await supabase
    .from('exam_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session) {
    return { errorStatus: 404, errorMessage: 'Sesi ujian siswa tidak ditemukan.' };
  }

  const { data: pkg } = await supabase
    .from('exam_packages')
    .select('id, teacher_id, proctor_id, max_violations')
    .eq('id', session.package_id)
    .maybeSingle();

  if (!pkg) {
    return { errorStatus: 404, errorMessage: 'Paket ujian tidak ditemukan.' };
  }

  const access = getPackageAccess(pkg, teacher);
  if (access === 'NONE') {
    return { errorStatus: 403, errorMessage: 'Anda tidak memiliki akses mengelola sesi peserta ini.' };
  }

  return { session: session as SessionRow, pkg, access };
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '';

function getAdminClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia di Edge Function.');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let cachedMasterSecretHex: string | null = null;
let cachedPinKeyMaterial: string | null = null;

async function getSystemMetaSeed(supabase: SupabaseClient, metaKey: string): Promise<string> {
  const { data: existing } = await supabase
    .from('system_meta')
    .select('meta_value')
    .eq('meta_key', metaKey)
    .maybeSingle();

  if (existing?.meta_value) {
    return existing.meta_value;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  await supabase
    .from('system_meta')
    .upsert({ meta_key: metaKey, meta_value: generated }, { onConflict: 'meta_key', ignoreDuplicates: true });

  const { data: saved } = await supabase
    .from('system_meta')
    .select('meta_value')
    .eq('meta_key', metaKey)
    .single();

  return saved?.meta_value || generated;
}

async function getMasterSecret(supabase: SupabaseClient): Promise<Buffer> {
  const envSecret = Deno.env.get('EXAMFLOW_QR_SECRET')?.trim();
  if (envSecret) {
    return crypto.createHash('sha256').update(envSecret).digest();
  }
  if (!cachedMasterSecretHex) {
    cachedMasterSecretHex = await getSystemMetaSeed(supabase, 'master_cipher_seed');
  }
  return crypto.createHash('sha256').update(cachedMasterSecretHex).digest();
}

async function getPinKeyMaterial(supabase: SupabaseClient): Promise<string> {
  const envSecret = Deno.env.get('EXAMFLOW_QR_SECRET')?.trim();
  if (envSecret) return `pin:${envSecret}`;
  if (cachedPinKeyMaterial) return cachedPinKeyMaterial;
  const seed = await getSystemMetaSeed(supabase, 'pin_cipher_seed');
  cachedPinKeyMaterial = `pin:${seed}`;
  return cachedPinKeyMaterial;
}

function hashSecret(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifySecret(plain: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(plain, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function encryptTextWithKey(plain: string, keyMaterial: string): string {
  const key = crypto.createHash('sha256').update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    'p1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

function decryptTextWithKey(cipherText: string, keyMaterial: string): string | null {
  try {
    const parts = cipherText.trim().split('.');
    if (parts.length !== 4 || parts[0] !== 'p1') return null;
    const iv = Buffer.from(parts[1], 'base64url');
    const authTag = Buffer.from(parts[2], 'base64url');
    const encrypted = Buffer.from(parts[3], 'base64url');
    const key = crypto.createHash('sha256').update(keyMaterial).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function encryptQrPayload(
  payload: Omit<QrPackagePayload, 'issuedAt' | 'nonce'>,
  masterKey: Buffer
): string {
  const fullPayload: QrPackagePayload = {
    ...payload,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const plaintext = JSON.stringify(fullPayload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    'ef1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

function decryptQrPayload(token: string, masterKey: Buffer): QrPackagePayload | null {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 4 || parts[0] !== 'ef1') return null;
    const iv = Buffer.from(parts[1], 'base64url');
    const authTag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted) as QrPackagePayload;
    if (!parsed || typeof parsed.packageId !== 'number' || typeof parsed.classId !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function createTeacherToken(claims: Omit<TeacherTokenClaims, 'exp'>, masterKey: Buffer): string {
  const payload: TeacherTokenClaims = {
    ...claims,
    exp: Date.now() + 1000 * 60 * 60 * 12,
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', masterKey).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyTeacherToken(token: string, masterKey: Buffer): TeacherTokenClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [data, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', masterKey).update(data).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as TeacherTokenClaims;
    if (!parsed || typeof parsed.teacherId !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function generateExamToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[crypto.randomInt(0, chars.length)];
  }
  return result;
}

function generateSemesterPin(): string {
  return String(crypto.randomInt(100000, 999999));
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function constantTimeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function cryptoShuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function escapeCsvField(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeStudentPortalBaseUrl(rawBaseUrl?: string | null): string | null {
  if (!rawBaseUrl || typeof rawBaseUrl !== 'string') return null;
  try {
    const parsed = new URL(rawBaseUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function splitDelimitedLine(line: string): string[] {
  let delimiter = ',';
  if (line.includes('\t')) {
    delimiter = '\t';
  } else if (line.includes(';')) {
    delimiter = ';';
  }

  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

async function generateQrDataUrl(text: string): Promise<string> {
  try {
    return await QRCode.toDataURL(text, {
      width: 320,
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    });
  } catch {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      width: 320,
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

function resolveAllowedOrigin(req: Request): string {
  const reqOrigin = req.headers.get('origin')?.trim() || '';
  const configured = (Deno.env.get('ALLOWED_ORIGIN') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    if (reqOrigin && configured.includes(reqOrigin)) {
      return reqOrigin;
    }
    return configured[0];
  }

  if (reqOrigin) {
    try {
      const parsed = new URL(reqOrigin);
      const host = parsed.hostname.toLowerCase();
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.endsWith('.github.io') ||
        host.endsWith('.vercel.app') ||
        host.endsWith('.pages.dev') ||
        host.endsWith('.run.app')
      ) {
        return reqOrigin;
      }
    } catch {
      // ignore invalid Origin header
    }
  }

  return 'http://localhost:3000';
}

function buildCorsHeaders(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': resolveAllowedOrigin(req),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-examflow-token, x-exambro-client, x-exambro-key',
    'Access-Control-Expose-Headers': 'Content-Disposition',
    Vary: 'Origin',
  };
}

function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...buildCorsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function extractAppToken(req: Request): string | null {
  const customToken = req.headers.get('x-examflow-token')?.trim();
  if (customToken) return customToken;
  const authHeader = req.headers.get('authorization')?.trim();
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function requireTeacherAuth(
  req: Request,
  supabase: SupabaseClient
): Promise<{ teacher?: TeacherTokenClaims; errorResponse?: Response }> {
  const token = extractAppToken(req);
  if (!token) {
    return { errorResponse: jsonResponse(req, { error: 'Autentikasi guru diperlukan.' }, 401) };
  }
  const masterKey = await getMasterSecret(supabase);
  const claims = verifyTeacherToken(token, masterKey);
  if (!claims) {
    return {
      errorResponse: jsonResponse(req, { error: 'Sesi guru tidak valid atau telah berakhir.' }, 401),
    };
  }
  return { teacher: claims };
}

function checkExambroClient(req: Request): Response | null {
  const clientHeader = (req.headers.get('x-exambro-client') || '').trim();
  const allowedPrefixes = ['ExamFlow-Exambro-Android/', 'ExambroPro-Android-', 'ExamFlow-Web-Portal/'];
  const hasValidClientHeader = allowedPrefixes.some((prefix) => clientHeader.startsWith(prefix));

  if (!hasValidClientHeader) {
    return jsonResponse(
      req,
      {
        error:
          'Akses ditolak. Endpoint ini hanya menerima permintaan dari klien APK Exambro atau Portal Ujian terverifikasi.',
        code: 'INVALID_EXAMBRO_CLIENT',
      },
      403
    );
  }

  const strictMode = Deno.env.get('EXAMBRO_STRICT_HEADER') === 'true';
  const configuredKey = Deno.env.get('EXAMBRO_CLIENT_KEY')?.trim();
  if (strictMode && configuredKey) {
    const providedKey = (req.headers.get('x-exambro-key') || '').trim();
    if (!providedKey || !constantTimeEqualText(providedKey, configuredKey)) {
      return jsonResponse(
        req,
        {
          error: 'Kunci aplikasi Exambro (X-Exambro-Key) tidak valid.',
          code: 'INVALID_EXAMBRO_KEY',
        },
        403
      );
    }
  }

  return null;
}

async function broadcastPackageEvent(
  supabase: SupabaseClient,
  event: PackageEventPayload
): Promise<void> {
  try {
    const channel = supabase.channel(`examflow-package-${event.packageId}`);
    await channel.httpSend(event.type, event);
    supabase.removeChannel(channel);
  } catch {
    // Non-fatal: polling fallback tetap menyinkronkan data
  }
}

async function gradeAndFinalizeSession(
  supabase: SupabaseClient,
  sessionId: number,
  packageId: number
): Promise<{ score: number; correctCount: number; totalQuestions: number }> {
  const { data: questions } = await supabase
    .from('questions')
    .select('id, correct_option, points')
    .eq('package_id', packageId);

  const { data: answers } = await supabase
    .from('student_answers')
    .select('question_id, selected_option')
    .eq('session_id', sessionId);

  const answerMap = new Map(
    (answers || []).map((a: { question_id: number; selected_option: string }) => [
      a.question_id,
      a.selected_option,
    ])
  );

  let totalPoints = 0;
  let earnedPoints = 0;
  let correctCount = 0;

  for (const q of questions || []) {
    totalPoints += q.points;
    if (answerMap.get(q.id) === q.correct_option) {
      earnedPoints += q.points;
      correctCount += 1;
    }
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 100 : 0;
  const totalQuestions = (questions || []).length;
  const now = Date.now();

  const { data: currentSes } = await supabase
    .from('exam_sessions')
    .select('submitted_at')
    .eq('id', sessionId)
    .single();

  await supabase
    .from('exam_sessions')
    .update({
      status: 'SUBMITTED',
      submitted_at: currentSes?.submitted_at ?? now,
      score,
      correct_count: correctCount,
      total_questions: totalQuestions,
    })
    .eq('id', sessionId);

  return { score, correctCount, totalQuestions };
}

async function requireStudentSession(
  req: Request,
  supabase: SupabaseClient
): Promise<{ session?: SessionRow; errorResponse?: Response }> {
  const sessionToken = extractAppToken(req);
  if (!sessionToken) {
    return {
      errorResponse: jsonResponse(
        req,
        { error: 'Token sesi ujian (session_token) diperlukan.' },
        401
      ),
    };
  }

  const { data: session } = await supabase
    .from('exam_sessions')
    .select('*')
    .eq('session_token', sessionToken)
    .maybeSingle();

  if (!session) {
    return {
      errorResponse: jsonResponse(
        req,
        { error: 'Session token tidak valid atau tidak ditemukan.' },
        401
      ),
    };
  }

  if (session.status === 'IN_PROGRESS' && Date.now() >= session.expires_at) {
    await gradeAndFinalizeSession(supabase, session.id, session.package_id);
    const { data: refreshed } = await supabase
      .from('exam_sessions')
      .select('*')
      .eq('id', session.id)
      .single();

    const finalSession = (refreshed || session) as SessionRow;
    await broadcastPackageEvent(supabase, {
      type: 'session:updated',
      packageId: finalSession.package_id,
      studentId: finalSession.student_id,
      sessionId: finalSession.id,
      payload: { status: 'SUBMITTED', reason: 'TIME_EXPIRED' },
      timestamp: Date.now(),
    });
    return { session: finalSession };
  }

  return { session: session as SessionRow };
}

async function readJsonBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function normalizeRoutePath(rawPathname: string): string {
  let path = rawPathname.replace(/^\/functions\/v1\/api(?=\/|$)/, '');
  path = path.replace(/^\/api(?=\/|$)/, '');
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: buildCorsHeaders(req) });
  }

  const url = new URL(req.url);
  const path = normalizeRoutePath(url.pathname);
  const method = req.method.toUpperCase();

  let supabase: SupabaseClient;
  try {
    supabase = getAdminClient();
  } catch (err) {
    return jsonResponse(
      req,
      { error: err instanceof Error ? err.message : 'Konfigurasi server tidak lengkap.' },
      500
    );
  }

  try {
    // 0. HEALTH CHECK
    if (method === 'GET' && path === '/health') {
      const { error } = await supabase.from('teachers').select('id').limit(1);
      if (error) {
        return jsonResponse(
          req,
          { status: 'error', service: 'ExamFlow Pro', detail: error.message, code: error.code },
          503
        );
      }
      return jsonResponse(req, {
        status: 'ok',
        service: 'ExamFlow Pro',
        database: 'supabase-postgres',
        timestamp: Date.now(),
      });
    }

    // 1. TEACHER AUTH & CONTEXT
    const normalizeTeacherNip = (raw?: string): string => (raw || '').trim().toLowerCase();
    const isValidTeacherNip = (nip: string): boolean =>
      nip.length >= 2 && nip.length <= 64 && /^[a-z0-9._-]+$/i.test(nip);

    if (method === 'POST' && path === '/auth/login') {
      const { nip, email, password } = await readJsonBody<{ nip?: string; email?: string; password?: string }>(req);
      const cleanNip = normalizeTeacherNip(nip ?? email);
      if (!cleanNip || !password) {
        return jsonResponse(req, { error: 'NIP / ID Login dan kata sandi wajib diisi.' }, 400);
      }

      const { data: teacher, error: teacherErr } = await supabase
        .from('teachers')
        .select('id, name, nip, password_hash, role')
        .eq('nip', cleanNip)
        .maybeSingle();

      if (teacherErr) {
        return jsonResponse(
          req,
          { error: `Kesalahan koneksi database: ${teacherErr.message}` },
          500
        );
      }

      if (!teacher || !verifySecret(password, teacher.password_hash)) {
        return jsonResponse(req, { error: 'NIP / ID Login atau kata sandi tidak sesuai.' }, 401);
      }

      const masterKey = await getMasterSecret(supabase);
      const token = createTeacherToken(
        {
          teacherId: teacher.id,
          nip: teacher.nip,
          name: teacher.name,
          role: teacher.role as 'TEACHER' | 'ADMIN',
        },
        masterKey
      );

      return jsonResponse(req, {
        token,
        teacher: {
          id: teacher.id,
          name: teacher.name,
          nip: teacher.nip,
          role: teacher.role,
        },
      });
    }

    if (method === 'POST' && path === '/auth/change-password') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;

      const { currentPassword, newPassword } = await readJsonBody<{
        currentPassword?: string;
        newPassword?: string;
      }>(req);

      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
        return jsonResponse(req, { error: 'Kata sandi saat ini dan kata sandi baru wajib diisi.' }, 400);
      }

      if (newPassword.length < 6 || newPassword.length > 128) {
        return jsonResponse(req, { error: 'Kata sandi baru harus terdiri dari 6–128 karakter.' }, 400);
      }

      if (newPassword === currentPassword) {
        return jsonResponse(req, { error: 'Kata sandi baru harus berbeda dari kata sandi saat ini.' }, 400);
      }

      const { data: teacher } = await supabase
        .from('teachers')
        .select('id, password_hash')
        .eq('id', auth.teacher!.teacherId)
        .maybeSingle();

      if (!teacher || !verifySecret(currentPassword, teacher.password_hash)) {
        return jsonResponse(req, { error: 'Kata sandi saat ini tidak sesuai.' }, 401);
      }

      const nextHash = hashSecret(newPassword);
      const { error: updateErr } = await supabase
        .from('teachers')
        .update({ password_hash: nextHash })
        .eq('id', auth.teacher!.teacherId);

      if (updateErr) {
        return jsonResponse(req, { error: `Gagal memperbarui kata sandi: ${updateErr.message}` }, 500);
      }

      return jsonResponse(req, { success: true, message: 'Kata sandi berhasil diperbarui.' });
    }

    const getTeacherAssignmentScope = async (teacherId: number) => {
      const { data: assignRows } = await supabase
        .from('teacher_assignments')
        .select('subject_id, class_id')
        .eq('teacher_id', teacherId);
      const pairs = new Set<string>();
      const subjectSet = new Set<number>();
      const classSet = new Set<number>();
      for (const r of (assignRows || []) as Array<{ subject_id: number; class_id: number }>) {
        pairs.add(`${r.subject_id}:${r.class_id}`);
        subjectSet.add(r.subject_id);
        classSet.add(r.class_id);
      }
      return {
        pairs,
        subjectIds: Array.from(subjectSet),
        classIds: Array.from(classSet),
      };
    };

    if (method === 'GET' && path === '/teacher/context') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const teacherId = auth.teacher!.teacherId;
      const isAdmin = auth.teacher!.role === 'ADMIN';

      const { data: rawAssignments } = await supabase
        .from('teacher_assignments')
        .select('id, subject_id, class_id, subjects(code, name), classes(name, grade_level)')
        .eq('teacher_id', teacherId);

      const assignments = (rawAssignments || [])
        .map((row: Record<string, unknown>) => {
          const subj = row.subjects as { code: string; name: string } | null;
          const cls = row.classes as { name: string; grade_level: number } | null;
          return {
            id: row.id as number,
            subject_id: row.subject_id as number,
            class_id: row.class_id as number,
            subject_code: subj?.code || '',
            subject_name: subj?.name || '',
            class_name: cls?.name || '',
            grade_level: cls?.grade_level || 8,
          };
        })
        .sort((a, b) =>
          a.subject_name.localeCompare(b.subject_name) || a.class_name.localeCompare(b.class_name)
        );

      const assignedSubjectIds = Array.from(new Set(assignments.map((a) => a.subject_id)));
      const assignedClassIds = Array.from(new Set(assignments.map((a) => a.class_id)));

      const [subjectsRes, classesRes, teachersRes] = await Promise.all([
        isAdmin
          ? supabase.from('subjects').select('*').order('name', { ascending: true })
          : assignedSubjectIds.length > 0
            ? supabase.from('subjects').select('*').in('id', assignedSubjectIds).order('name', { ascending: true })
            : Promise.resolve({ data: [] }),
        isAdmin
          ? supabase.from('classes').select('*').order('grade_level', { ascending: true }).order('name', { ascending: true })
          : assignedClassIds.length > 0
            ? supabase
                .from('classes')
                .select('*')
                .in('id', assignedClassIds)
                .order('grade_level', { ascending: true })
                .order('name', { ascending: true })
            : Promise.resolve({ data: [] }),
        isAdmin
          ? supabase.from('teachers').select('id, name, nip, role').order('name', { ascending: true })
          : Promise.resolve({ data: [] }),
      ]);

      return jsonResponse(req, {
        teacher: auth.teacher,
        assignments,
        subjects: subjectsRes.data || [],
        classes: classesRes.data || [],
        teachers: teachersRes.data || [],
      });
    }

    if (method === 'POST' && path === '/teacher/assignments') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }
      const teacherId = auth.teacher!.teacherId;
      const { subjectId, classId } = await readJsonBody<{ subjectId?: number; classId?: number }>(
        req
      );
      if (!subjectId || !classId) {
        return jsonResponse(req, { error: 'subjectId dan classId wajib dipilih.' }, 400);
      }

      const { data, error } = await supabase
        .from('teacher_assignments')
        .insert({ teacher_id: teacherId, subject_id: Number(subjectId), class_id: Number(classId) })
        .select('id')
        .single();

      if (error || !data) {
        return jsonResponse(
          req,
          { error: 'Penugasan mata pelajaran & kelas tersebut sudah terdaftar.' },
          409
        );
      }

      return jsonResponse(
        req,
        { id: data.id, subjectId: Number(subjectId), classId: Number(classId) },
        201
      );
    }

    // 1B. ADMIN: TEACHERS & SUBJECTS MANAGEMENT
    if (method === 'GET' && path === '/subjects') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const isAdmin = auth.teacher!.role === 'ADMIN';

      if (!isAdmin) {
        const scope = await getTeacherAssignmentScope(auth.teacher!.teacherId);
        if (scope.subjectIds.length === 0) {
          return jsonResponse(req, { subjects: [] });
        }
        const [{ data: subjects }, { data: pkgRows }] = await Promise.all([
          supabase.from('subjects').select('*').in('id', scope.subjectIds).order('name', { ascending: true }),
          supabase.from('exam_packages').select('id, subject_id').eq('teacher_id', auth.teacher!.teacherId),
        ]);
        const ownedPkgIds = (pkgRows || []).map((p: { id: number }) => p.id);
        const { data: qRows } =
          ownedPkgIds.length > 0
            ? await supabase.from('questions').select('subject_id').in('package_id', ownedPkgIds)
            : { data: [] };

        const list = (subjects || []).map((s: { id: number; code: string; name: string; description: string }) => ({
          ...s,
          package_count: (pkgRows || []).filter((p: { subject_id: number }) => p.subject_id === s.id).length,
          question_count: (qRows || []).filter((q: { subject_id: number }) => q.subject_id === s.id).length,
        }));
        return jsonResponse(req, { subjects: list });
      }

      const [{ data: subjects }, { data: pkgRows }, { data: qRows }] = await Promise.all([
        supabase.from('subjects').select('*').order('name', { ascending: true }),
        supabase.from('exam_packages').select('subject_id'),
        supabase.from('questions').select('subject_id'),
      ]);

      const list = (subjects || []).map((s: { id: number; code: string; name: string; description: string }) => ({
        ...s,
        package_count: (pkgRows || []).filter((p: { subject_id: number }) => p.subject_id === s.id).length,
        question_count: (qRows || []).filter((q: { subject_id: number }) => q.subject_id === s.id).length,
      }));

      return jsonResponse(req, { subjects: list });
    }

    if (method === 'POST' && path === '/subjects') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }

      const { code, name, description = '' } = await readJsonBody<{
        code?: string;
        name?: string;
        description?: string;
      }>(req);

      const cleanCode = (code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      const cleanName = (name || '').trim();
      if (!cleanCode || cleanCode.length < 2 || cleanCode.length > 16 || !cleanName) {
        return jsonResponse(
          req,
          { error: 'Kode mapel (2–16 huruf/angka) dan nama mata pelajaran wajib diisi.' },
          400
        );
      }

      const { data: created, error } = await supabase
        .from('subjects')
        .insert({ code: cleanCode, name: cleanName, description: description.trim() })
        .select('*')
        .single();

      if (error || !created) {
        return jsonResponse(req, { error: `Kode mata pelajaran "${cleanCode}" sudah terdaftar.` }, 409);
      }
      return jsonResponse(req, { subject: created }, 201);
    }

    const subjectMatch = path.match(/^\/subjects\/(\d+)$/);
    if (subjectMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }
      const subjectId = Number(subjectMatch[1]);

      if (method === 'PUT') {
        const { data: existing } = await supabase
          .from('subjects')
          .select('*')
          .eq('id', subjectId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Mata pelajaran tidak ditemukan.' }, 404);
        }

        const { code, name, description } = await readJsonBody<{
          code?: string;
          name?: string;
          description?: string;
        }>(req);

        const nextCode =
          code !== undefined ? code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') : existing.code;
        const nextName = name !== undefined ? name.trim() : existing.name;
        const nextDesc = description !== undefined ? description.trim() : existing.description;

        if (!nextCode || nextCode.length < 2 || nextCode.length > 16 || !nextName) {
          return jsonResponse(
            req,
            { error: 'Kode mapel (2–16 huruf/angka) dan nama mata pelajaran wajib diisi.' },
            400
          );
        }

        const { data: updated, error } = await supabase
          .from('subjects')
          .update({ code: nextCode, name: nextName, description: nextDesc })
          .eq('id', subjectId)
          .select('*')
          .single();

        if (error || !updated) {
          return jsonResponse(req, { error: `Kode mata pelajaran "${nextCode}" sudah digunakan mapel lain.` }, 409);
        }
        return jsonResponse(req, { subject: updated });
      }

      if (method === 'DELETE') {
        const { count: usedPackages } = await supabase
          .from('exam_packages')
          .select('id', { count: 'exact', head: true })
          .eq('subject_id', subjectId);

        if ((usedPackages || 0) > 0) {
          return jsonResponse(
            req,
            {
              error: `Mata pelajaran tidak dapat dihapus karena masih digunakan oleh ${usedPackages} paket ujian.`,
            },
            409
          );
        }

        const { data: deleted } = await supabase.from('subjects').delete().eq('id', subjectId).select('id');
        if (!deleted || deleted.length === 0) {
          return jsonResponse(req, { error: 'Mata pelajaran tidak ditemukan.' }, 404);
        }
        return jsonResponse(req, { success: true });
      }
    }

    if (method === 'GET' && path === '/classes') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const isAdmin = auth.teacher!.role === 'ADMIN';

      if (!isAdmin) {
        const scope = await getTeacherAssignmentScope(auth.teacher!.teacherId);
        if (scope.classIds.length === 0) {
          return jsonResponse(req, { classes: [] });
        }
        const [{ data: classes }, { data: stRows }, { data: pkgRows }] = await Promise.all([
          supabase
            .from('classes')
            .select('id, name, grade_level')
            .in('id', scope.classIds)
            .order('grade_level', { ascending: true })
            .order('name', { ascending: true }),
          supabase.from('students').select('class_id').in('class_id', scope.classIds),
          supabase
            .from('exam_packages')
            .select('class_id')
            .or(`teacher_id.eq.${auth.teacher!.teacherId},proctor_id.eq.${auth.teacher!.teacherId}`),
        ]);

        const stCounts = new Map<number, number>();
        for (const r of stRows || []) {
          stCounts.set(r.class_id, (stCounts.get(r.class_id) || 0) + 1);
        }
        const pkgCounts = new Map<number, number>();
        for (const r of pkgRows || []) {
          pkgCounts.set(r.class_id, (pkgCounts.get(r.class_id) || 0) + 1);
        }

        const result = (classes || []).map((c: { id: number; name: string; grade_level: number }) => ({
          ...c,
          student_count: stCounts.get(c.id) || 0,
          package_count: pkgCounts.get(c.id) || 0,
        }));
        return jsonResponse(req, { classes: result });
      }

      const [{ data: classes }, { data: stRows }, { data: pkgRows }] = await Promise.all([
        supabase
          .from('classes')
          .select('id, name, grade_level')
          .order('grade_level', { ascending: true })
          .order('name', { ascending: true }),
        supabase.from('students').select('class_id'),
        supabase.from('exam_packages').select('class_id'),
      ]);

      const stCounts = new Map<number, number>();
      for (const r of stRows || []) {
        stCounts.set(r.class_id, (stCounts.get(r.class_id) || 0) + 1);
      }
      const pkgCounts = new Map<number, number>();
      for (const r of pkgRows || []) {
        pkgCounts.set(r.class_id, (pkgCounts.get(r.class_id) || 0) + 1);
      }

      const result = (classes || []).map((c: { id: number; name: string; grade_level: number }) => ({
        ...c,
        student_count: stCounts.get(c.id) || 0,
        package_count: pkgCounts.get(c.id) || 0,
      }));
      return jsonResponse(req, { classes: result });
    }

    const normalizeClassInput = (name?: string, gradeLevel?: number) => {
      const cleanName = (name || '')
        .trim()
        .toUpperCase()
        .replace(/^KELAS\s+/i, '')
        .replace(/\s+/g, ' ');
      let resolvedGrade = Number(gradeLevel);
      if (!Number.isFinite(resolvedGrade) || resolvedGrade < 1 || resolvedGrade > 12) {
        const m = cleanName.match(/^(\d{1,2})/);
        const parsed = m ? Number(m[1]) : 8;
        resolvedGrade = Math.min(12, Math.max(1, Number.isFinite(parsed) ? parsed : 8));
      } else {
        resolvedGrade = Math.round(resolvedGrade);
      }
      return { cleanName, resolvedGrade };
    };

    if (method === 'POST' && path === '/classes') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }

      const { name, gradeLevel } = await readJsonBody<{ name?: string; gradeLevel?: number }>(req);
      const { cleanName, resolvedGrade } = normalizeClassInput(name, gradeLevel);

      if (!cleanName || cleanName.length > 24) {
        return jsonResponse(
          req,
          { error: 'Nama kelas wajib diisi (maks. 24 karakter, misal: 7A, 8B, 10 IPA 1).' },
          400
        );
      }

      const { data: created, error } = await supabase
        .from('classes')
        .insert({ name: cleanName, grade_level: resolvedGrade })
        .select('id, name, grade_level')
        .single();

      if (error || !created) {
        return jsonResponse(req, { error: `Kelas "${cleanName}" sudah terdaftar.` }, 409);
      }

      return jsonResponse(
        req,
        { class: { ...created, student_count: 0, package_count: 0 } },
        201
      );
    }

    const classMatch = path.match(/^\/classes\/(\d+)$/);
    if (classMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }
      const classId = Number(classMatch[1]);

      if (method === 'PUT') {
        const { data: existing } = await supabase
          .from('classes')
          .select('id, name, grade_level')
          .eq('id', classId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Kelas tidak ditemukan.' }, 404);
        }

        const { name, gradeLevel } = await readJsonBody<{ name?: string; gradeLevel?: number }>(req);
        const { cleanName, resolvedGrade } = normalizeClassInput(
          name !== undefined ? name : existing.name,
          gradeLevel !== undefined ? gradeLevel : existing.grade_level
        );

        if (!cleanName || cleanName.length > 24) {
          return jsonResponse(req, { error: 'Nama kelas wajib diisi (maks. 24 karakter).' }, 400);
        }

        const { data: updated, error } = await supabase
          .from('classes')
          .update({ name: cleanName, grade_level: resolvedGrade })
          .eq('id', classId)
          .select('id, name, grade_level')
          .single();

        if (error || !updated) {
          return jsonResponse(req, { error: `Nama kelas "${cleanName}" sudah digunakan kelas lain.` }, 409);
        }

        const [{ count: studentCount }, { count: packageCount }] = await Promise.all([
          supabase.from('students').select('id', { count: 'exact', head: true }).eq('class_id', classId),
          supabase.from('exam_packages').select('id', { count: 'exact', head: true }).eq('class_id', classId),
        ]);

        return jsonResponse(req, {
          class: {
            ...updated,
            student_count: studentCount || 0,
            package_count: packageCount || 0,
          },
        });
      }

      if (method === 'DELETE') {
        const { data: existing } = await supabase
          .from('classes')
          .select('id')
          .eq('id', classId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Kelas tidak ditemukan.' }, 404);
        }

        const [{ count: usedStudents }, { count: usedPackages }] = await Promise.all([
          supabase.from('students').select('id', { count: 'exact', head: true }).eq('class_id', classId),
          supabase.from('exam_packages').select('id', { count: 'exact', head: true }).eq('class_id', classId),
        ]);

        if ((usedStudents || 0) > 0 || (usedPackages || 0) > 0) {
          return jsonResponse(
            req,
            {
              error: `Kelas tidak dapat dihapus karena masih memiliki ${usedStudents || 0} siswa dan ${usedPackages || 0} paket ujian.`,
            },
            409
          );
        }

        await supabase.from('classes').delete().eq('id', classId);
        return jsonResponse(req, { success: true });
      }
    }

    if (method === 'GET' && path === '/admin/teachers') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }

      const [{ data: teachers }, { data: pkgRows }, { data: rawAssignments }] = await Promise.all([
        supabase
          .from('teachers')
          .select('id, name, nip, role, created_at')
          .order('role', { ascending: true })
          .order('name', { ascending: true }),
        supabase.from('exam_packages').select('teacher_id'),
        supabase
          .from('teacher_assignments')
          .select('id, teacher_id, subject_id, class_id, subjects(code, name), classes(name, grade_level)'),
      ]);

      const mappedAssignments = (rawAssignments || []).map((row: Record<string, unknown>) => {
        const subj = row.subjects as { code: string; name: string } | null;
        const cls = row.classes as { name: string; grade_level: number } | null;
        return {
          id: row.id as number,
          teacher_id: row.teacher_id as number,
          subject_id: row.subject_id as number,
          class_id: row.class_id as number,
          subject_code: subj?.code || '',
          subject_name: subj?.name || '',
          class_name: cls?.name || '',
          grade_level: cls?.grade_level || 8,
        };
      });

      const list = (teachers || []).map((t: Record<string, unknown>) => ({
        ...t,
        package_count: (pkgRows || []).filter((p: { teacher_id: number }) => p.teacher_id === t.id).length,
        assignments: mappedAssignments.filter((a) => a.teacher_id === t.id),
      }));

      return jsonResponse(req, { teachers: list });
    }

    if (method === 'POST' && path === '/admin/teachers') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }

      const { name, nip, email, password, role = 'TEACHER' } = await readJsonBody<{
        name?: string;
        nip?: string;
        email?: string;
        password?: string;
        role?: 'TEACHER' | 'ADMIN';
      }>(req);

      const cleanName = (name || '').trim();
      const cleanNip = normalizeTeacherNip(nip ?? email);
      const cleanRole = role === 'ADMIN' ? 'ADMIN' : 'TEACHER';

      if (!cleanName || !isValidTeacherNip(cleanNip)) {
        return jsonResponse(
          req,
          { error: 'Nama lengkap dan NIP / ID Login (2–64 karakter huruf/angka/._- tanpa spasi) wajib diisi.' },
          400
        );
      }
      if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
        return jsonResponse(req, { error: 'Kata sandi awal harus terdiri dari 6–128 karakter.' }, 400);
      }

      const { data: created, error } = await supabase
        .from('teachers')
        .insert({ name: cleanName, nip: cleanNip, password_hash: hashSecret(password), role: cleanRole })
        .select('id, name, nip, role, created_at')
        .single();

      if (error || !created) {
        return jsonResponse(req, { error: `NIP / ID Login "${cleanNip}" sudah terdaftar.` }, 409);
      }
      return jsonResponse(req, { teacher: created }, 201);
    }

    if (method === 'POST' && path === '/admin/teachers/import') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }

      const { rawText, updateExisting = false } = await readJsonBody<{
        rawText?: string;
        updateExisting?: boolean;
      }>(req);

      if (!rawText || !rawText.trim()) {
        return jsonResponse(req, { error: 'Data teks atau file CSV guru tidak boleh kosong.' }, 400);
      }

      const lines = rawText
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length === 0) {
        return jsonResponse(req, { error: 'Tidak ada baris data guru yang ditemukan.' }, 400);
      }

      function splitDelimitedLine(line: string): string[] {
        let delimiter = ',';
        if (line.includes('\t')) delimiter = '\t';
        else if (line.includes(';')) delimiter = ';';
        const cells: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
              current += '"';
              i++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (ch === delimiter && !inQuotes) {
            cells.push(current.trim());
            current = '';
          } else {
            current += ch;
          }
        }
        cells.push(current.trim());
        return cells;
      }

      function generateTeacherPass(length = 8): string {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        let out = '';
        for (let i = 0; i < length; i++) out += chars[crypto.randomInt(0, chars.length)];
        return out;
      }

      const importedCredentials: Array<{
        name: string;
        nip: string;
        role: 'TEACHER' | 'ADMIN';
        password: string;
        action: 'CREATED' | 'UPDATED';
      }> = [];
      const skipped: Array<{ lineNumber: number; nip: string; name: string; reason: string }> = [];
      const errors: Array<{ lineNumber: number; raw: string; reason: string }> = [];
      let totalRows = 0;

      for (let idx = 0; idx < lines.length; idx++) {
        const lineNumber = idx + 1;
        const line = lines[idx];
        const cols = splitDelimitedLine(line);

        if (idx === 0) {
          const c0 = (cols[0] || '').toLowerCase();
          const c1 = (cols[1] || '').toLowerCase();
          if (c0.includes('nama') || c0 === 'name' || c1.includes('nip') || c1.includes('email') || c1 === 'id') {
            continue;
          }
        }

        totalRows++;
        if (cols.length < 2) {
          errors.push({ lineNumber, raw: line, reason: 'Minimal harus memiliki 2 kolom (Nama Lengkap, NIP / ID Login).' });
          continue;
        }

        const name = cols[0].trim();
        const nip = normalizeTeacherNip(cols[1]);
        const rawRole = (cols[2] || 'TEACHER').trim().toUpperCase();
        const rawPass = (cols[3] || '').trim();

        if (!name || !isValidTeacherNip(nip)) {
          errors.push({
            lineNumber,
            raw: line,
            reason: 'Nama lengkap atau format NIP / ID Login (2–64 karakter tanpa spasi) tidak valid.',
          });
          continue;
        }
        if (rawRole && !['TEACHER', 'GURU', 'ADMIN'].includes(rawRole)) {
          errors.push({ lineNumber, raw: line, reason: 'Kolom Role harus berupa TEACHER (atau GURU) atau ADMIN.' });
          continue;
        }

        const role: 'TEACHER' | 'ADMIN' = rawRole === 'ADMIN' ? 'ADMIN' : 'TEACHER';
        if (rawPass && (rawPass.length < 6 || rawPass.length > 128)) {
          errors.push({
            lineNumber,
            raw: line,
            reason: 'Password harus terdiri dari 6–128 karakter (atau kosongkan untuk otomatis).',
          });
          continue;
        }

        const { data: existing } = await supabase
          .from('teachers')
          .select('id, role')
          .eq('nip', nip)
          .maybeSingle();

        if (existing && !updateExisting) {
          skipped.push({ lineNumber, nip, name, reason: 'NIP / ID Login sudah terdaftar (lewati duplikat).' });
          continue;
        }

        if (existing && updateExisting) {
          if (existing.role === 'ADMIN' && role !== 'ADMIN') {
            const { count: adminCount } = await supabase
              .from('teachers')
              .select('id', { count: 'exact', head: true })
              .eq('role', 'ADMIN');
            if ((adminCount || 0) <= 1) {
              errors.push({ lineNumber, raw: line, reason: 'Tidak dapat menurunkan peran Admin terakhir di sistem.' });
              continue;
            }
          }

          if (rawPass) {
            await supabase
              .from('teachers')
              .update({ name, role, password_hash: hashSecret(rawPass) })
              .eq('id', existing.id);
            importedCredentials.push({ name, nip, role, password: rawPass, action: 'UPDATED' });
          } else {
            await supabase.from('teachers').update({ name, role }).eq('id', existing.id);
            importedCredentials.push({ name, nip, role, password: 'Tetap (Tersimpan)', action: 'UPDATED' });
          }
        } else {
          const plainPass = rawPass || generateTeacherPass(8);
          await supabase
            .from('teachers')
            .insert({ name, nip, password_hash: hashSecret(plainPass), role });
          importedCredentials.push({ name, nip, role, password: plainPass, action: 'CREATED' });
        }
      }

      return jsonResponse(req, {
        summary: {
          totalRows,
          createdCount: importedCredentials.filter((c) => c.action === 'CREATED').length,
          updatedCount: importedCredentials.filter((c) => c.action === 'UPDATED').length,
          skippedCount: skipped.length,
          errorCount: errors.length,
        },
        importedCredentials,
        skipped,
        errors,
      });
    }

    const adminTeacherMatch = path.match(/^\/admin\/teachers\/(\d+)$/);
    if (adminTeacherMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }
      const targetId = Number(adminTeacherMatch[1]);

      if (method === 'PUT') {
        const { data: existing } = await supabase
          .from('teachers')
          .select('id, name, nip, role, password_hash')
          .eq('id', targetId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Akun guru tidak ditemukan.' }, 404);
        }

        const { name, nip, email, role, newPassword } = await readJsonBody<{
          name?: string;
          nip?: string;
          email?: string;
          role?: 'TEACHER' | 'ADMIN';
          newPassword?: string;
        }>(req);

        const rawNip = nip !== undefined ? nip : email;
        const nextName = name !== undefined ? name.trim() : existing.name;
        const nextNip = rawNip !== undefined ? normalizeTeacherNip(rawNip) : existing.nip;
        const nextRole = role === 'ADMIN' || role === 'TEACHER' ? role : existing.role;

        if (!nextName || !isValidTeacherNip(nextNip)) {
          return jsonResponse(
            req,
            { error: 'Nama lengkap dan NIP / ID Login (2–64 karakter huruf/angka/._- tanpa spasi) wajib diisi.' },
            400
          );
        }

        if (existing.role === 'ADMIN' && nextRole !== 'ADMIN') {
          const { count: adminCount } = await supabase
            .from('teachers')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'ADMIN');
          if ((adminCount || 0) <= 1) {
            return jsonResponse(req, { error: 'Tidak dapat menurunkan peran Admin terakhir di sistem.' }, 400);
          }
        }

        let nextHash = existing.password_hash;
        if (typeof newPassword === 'string' && newPassword.length > 0) {
          if (newPassword.length < 6 || newPassword.length > 128) {
            return jsonResponse(req, { error: 'Kata sandi baru harus terdiri dari 6–128 karakter.' }, 400);
          }
          nextHash = hashSecret(newPassword);
        }

        const { data: updated, error } = await supabase
          .from('teachers')
          .update({ name: nextName, nip: nextNip, role: nextRole, password_hash: nextHash })
          .eq('id', targetId)
          .select('id, name, nip, role, created_at')
          .single();

        if (error || !updated) {
          return jsonResponse(req, { error: `NIP / ID Login "${nextNip}" sudah digunakan akun lain.` }, 409);
        }
        return jsonResponse(req, { teacher: updated });
      }

      if (method === 'DELETE') {
        if (targetId === auth.teacher!.teacherId) {
          return jsonResponse(req, { error: 'Anda tidak dapat menghapus akun yang sedang digunakan login.' }, 400);
        }

        const { data: target } = await supabase
          .from('teachers')
          .select('id, role')
          .eq('id', targetId)
          .maybeSingle();

        if (!target) {
          return jsonResponse(req, { error: 'Akun guru tidak ditemukan.' }, 404);
        }

        if (target.role === 'ADMIN') {
          const { count: adminCount } = await supabase
            .from('teachers')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'ADMIN');
          if ((adminCount || 0) <= 1) {
            return jsonResponse(req, { error: 'Tidak dapat menghapus satu-satunya akun Admin.' }, 400);
          }
        }

        await supabase.from('teachers').delete().eq('id', targetId);
        return jsonResponse(req, { success: true });
      }
    }

    const adminTeacherResetMatch = path.match(/^\/admin\/teachers\/(\d+)\/reset-password$/);
    if (method === 'POST' && adminTeacherResetMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }
      const targetId = Number(adminTeacherResetMatch[1]);

      const { data: teacher } = await supabase
        .from('teachers')
        .select('id, name, nip')
        .eq('id', targetId)
        .maybeSingle();

      if (!teacher) {
        return jsonResponse(req, { error: 'Akun guru tidak ditemukan.' }, 404);
      }

      const { customPassword } = await readJsonBody<{ customPassword?: string }>(req);
      const trimmed = (customPassword || '').trim();
      if (trimmed && (trimmed.length < 6 || trimmed.length > 128)) {
        return jsonResponse(req, { error: 'Kata sandi khusus harus terdiri dari 6–128 karakter.' }, 400);
      }

      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      let generated = '';
      for (let i = 0; i < 8; i++) generated += chars[crypto.randomInt(0, chars.length)];
      const newPassword = trimmed || generated;

      await supabase
        .from('teachers')
        .update({ password_hash: hashSecret(newPassword) })
        .eq('id', targetId);

      return jsonResponse(req, {
        teacherId: teacher.id,
        name: teacher.name,
        nip: teacher.nip,
        newPassword,
      });
    }

    const adminTeacherAssignMatch = path.match(/^\/admin\/teachers\/(\d+)\/assignments$/);
    if (method === 'POST' && adminTeacherAssignMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }
      const targetId = Number(adminTeacherAssignMatch[1]);
      const { subjectId, classId } = await readJsonBody<{ subjectId?: number; classId?: number }>(req);
      if (!subjectId || !classId) {
        return jsonResponse(req, { error: 'Mata pelajaran dan kelas wajib dipilih.' }, 400);
      }

      const { data, error } = await supabase
        .from('teacher_assignments')
        .insert({ teacher_id: targetId, subject_id: Number(subjectId), class_id: Number(classId) })
        .select('id')
        .single();

      if (error || !data) {
        return jsonResponse(
          req,
          { error: 'Penugasan mata pelajaran & kelas tersebut sudah terdaftar untuk guru ini.' },
          409
        );
      }
      return jsonResponse(req, { id: data.id }, 201);
    }

    const adminAssignDeleteMatch = path.match(/^\/admin\/assignments\/(\d+)$/);
    if (method === 'DELETE' && adminAssignDeleteMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(req, { error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' }, 403);
      }
      const assignmentId = Number(adminAssignDeleteMatch[1]);
      const { data: deleted } = await supabase
        .from('teacher_assignments')
        .delete()
        .eq('id', assignmentId)
        .select('id');

      if (!deleted || deleted.length === 0) {
        return jsonResponse(req, { error: 'Penugasan tidak ditemukan.' }, 404);
      }
      return jsonResponse(req, { success: true });
    }

    // 2. EXAM PACKAGES, ROTATION & QR
    if (method === 'GET' && path === '/packages') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const teacher = auth.teacher!;

      let query = supabase
        .from('exam_packages')
        .select('*, subjects(name, code), classes(name)')
        .order('is_active', { ascending: false })
        .order('id', { ascending: false });

      if (teacher.role !== 'ADMIN') {
        query = query.or(`teacher_id.eq.${teacher.teacherId},proctor_id.eq.${teacher.teacherId}`);
      }

      const { data: pkgRows } = await query;
      const pkgs = pkgRows || [];
      if (pkgs.length === 0) {
        return jsonResponse(req, { packages: [] });
      }

      const pkgIds = pkgs.map((p: { id: number }) => p.id);
      const classIds = [...new Set(pkgs.map((p: { class_id: number }) => p.class_id))];
      const teacherIds = [
        ...new Set(
          pkgs
            .flatMap((p: { teacher_id: number; proctor_id?: number | null }) => [p.teacher_id, p.proctor_id])
            .filter((id): id is number => typeof id === 'number' && id > 0)
        ),
      ];

      const [{ data: qRows }, { data: stRows }, { data: sesRows }, { data: tRows }] = await Promise.all([
        supabase.from('questions').select('package_id').in('package_id', pkgIds),
        supabase.from('students').select('class_id').in('class_id', classIds),
        supabase.from('exam_sessions').select('package_id, status').in('package_id', pkgIds),
        teacherIds.length > 0
          ? supabase.from('teachers').select('id, name').in('id', teacherIds)
          : Promise.resolve({ data: [] }),
      ]);

      const teacherNameMap = new Map(
        ((tRows || []) as Array<{ id: number; name: string }>).map((t) => [t.id, t.name])
      );

      const packages = pkgs.map((ep: Record<string, unknown>) => {
        const subj = ep.subjects as { name: string; code: string } | null;
        const cls = ep.classes as { name: string } | null;
        const pkgId = ep.id as number;
        const classId = ep.class_id as number;
        const ownerId = ep.teacher_id as number;
        const proctorId = (ep.proctor_id as number | null | undefined) ?? null;

        const qCount = (qRows || []).filter((q: { package_id: number }) => q.package_id === pkgId).length;
        const stCount = (stRows || []).filter((s: { class_id: number }) => s.class_id === classId).length;
        const pkgSessions = (sesRows || []).filter((s: { package_id: number }) => s.package_id === pkgId);

        const { subjects: _s, classes: _c, ...rest } = ep;
        return {
          ...rest,
          subject_name: subj?.name || '',
          subject_code: subj?.code || '',
          class_name: cls?.name || '',
          teacher_name: teacherNameMap.get(ownerId) || '',
          proctor_id: proctorId,
          proctor_name: proctorId ? teacherNameMap.get(proctorId) || null : null,
          access_role: getPackageAccess({ teacher_id: ownerId, proctor_id: proctorId }, teacher),
          question_count: qCount,
          class_student_count: stCount,
          active_count: pkgSessions.filter((s: { status: string }) => s.status === 'IN_PROGRESS').length,
          locked_count: pkgSessions.filter((s: { status: string }) => s.status === 'LOCKED_VIOLATION').length,
          submitted_count: pkgSessions.filter((s: { status: string }) => s.status === 'SUBMITTED').length,
        };
      });

      return jsonResponse(req, { packages });
    }

    if (method === 'POST' && path === '/packages') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const teacherId = auth.teacher!.teacherId;
      const isAdmin = auth.teacher!.role === 'ADMIN';

      const {
        title,
        subjectId,
        classId,
        classIds,
        className,
        examDate = '',
        kkm = 75,
        proctorId,
        proctorsByClass,
        durationMinutes = 60,
        maxViolations = 3,
        shuffleQuestions = true,
        shuffleOptions = true,
        isActive = false,
        initialToken,
        cloneFromPackageId,
      } = await readJsonBody<{
        title?: string;
        subjectId?: number;
        classId?: number;
        classIds?: number[];
        className?: string;
        examDate?: string;
        kkm?: number;
        proctorId?: number | null;
        proctorsByClass?: Record<string, number | null>;
        durationMinutes?: number;
        maxViolations?: number;
        shuffleQuestions?: boolean;
        shuffleOptions?: boolean;
        isActive?: boolean;
        initialToken?: string;
        cloneFromPackageId?: number;
      }>(req);

      const hasClassIds = Array.isArray(classIds) && classIds.filter((id) => Number(id) > 0).length > 0;
      if (!title?.trim() || !subjectId || (!hasClassIds && !classId && !className?.trim())) {
        return jsonResponse(req, { error: 'Judul paket, mata pelajaran, dan minimal satu kelas wajib diisi.' }, 400);
      }

      const hasNonAdminProctorAttempt =
        !isAdmin &&
        ((proctorId !== undefined && proctorId !== null) ||
          (proctorsByClass && Object.values(proctorsByClass).some((v) => v !== null && v !== undefined)));
      if (hasNonAdminProctorAttempt) {
        return jsonResponse(req, { error: 'Hanya Admin Sekolah yang dapat menentukan Guru Pengawas.' }, 403);
      }

      const targetClassIds: number[] = [];
      if (hasClassIds) {
        for (const cid of classIds!) {
          const num = Number(cid);
          if (Number.isFinite(num) && num > 0 && !targetClassIds.includes(num)) {
            targetClassIds.push(num);
          }
        }
      } else if (classId) {
        targetClassIds.push(Number(classId));
      } else if (className?.trim()) {
        const cleanClassName = className.replace(/^kelas\s+/i, '').trim().toUpperCase();
        const { data: foundClass } = await supabase
          .from('classes')
          .select('id')
          .ilike('name', cleanClassName)
          .maybeSingle();

        if (foundClass) {
          targetClassIds.push(foundClass.id);
        } else if (!isAdmin) {
          return jsonResponse(
            req,
            { error: `Akses ditolak. Kelas "${cleanClassName}" tidak ditemukan atau bukan bagian dari penugasan mengajar Anda.` },
            403
          );
        } else {
          const matchGrade = cleanClassName.match(/^(\d+)/);
          const gradeLevel = matchGrade ? Number(matchGrade[1]) : 8;
          const { data: createdCls } = await supabase
            .from('classes')
            .insert({ name: cleanClassName, grade_level: gradeLevel })
            .select('id')
            .single();
          targetClassIds.push(createdCls!.id);
        }
      }

      if (targetClassIds.length === 0) {
        return jsonResponse(req, { error: 'Kelas target tidak valid.' }, 400);
      }

      if (!isAdmin) {
        const scope = await getTeacherAssignmentScope(teacherId);
        const unauthorizedClass = targetClassIds.find((cid) => !scope.pairs.has(`${Number(subjectId)}:${cid}`));
        if (unauthorizedClass !== undefined) {
          return jsonResponse(
            req,
            { error: 'Akses ditolak. Anda hanya dapat membuat paket ujian sesuai penugasan mata pelajaran dan kelas Anda.' },
            403
          );
        }
      }

      const cleanedInitialToken = initialToken?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleanedInitialToken && (cleanedInitialToken.length < 4 || cleanedInitialToken.length > 12)) {
        return jsonResponse(
          req,
          { error: 'Token ujian awal harus terdiri dari 4–12 karakter huruf/angka.' },
          400
        );
      }

      let sourceQuestions: Array<{
        question_text: string;
        question_type: string;
        options_json: string;
        correct_option: string;
        points: number;
      }> = [];

      if (cloneFromPackageId) {
        const { data: sourcePkg } = await supabase
          .from('exam_packages')
          .select('id, teacher_id, proctor_id')
          .eq('id', Number(cloneFromPackageId))
          .maybeSingle();
        if (!sourcePkg) {
          return jsonResponse(req, { error: 'Paket sumber salinan soal tidak ditemukan.' }, 404);
        }
        const sourceAccess = getPackageAccess(sourcePkg, auth.teacher!);
        if (sourceAccess !== 'ADMIN' && sourceAccess !== 'OWNER') {
          return jsonResponse(req, { error: 'Anda tidak memiliki akses menyalin soal dari paket tersebut.' }, 403);
        }
        const { data: srcQs } = await supabase
          .from('questions')
          .select('question_text, question_type, options_json, correct_option, points')
          .eq('package_id', Number(cloneFromPackageId));
        sourceQuestions = (srcQs || []) as typeof sourceQuestions;
      }

      const scheduleGroup = targetClassIds.length > 1 ? `grp-${crypto.randomBytes(6).toString('hex')}` : '';
      const cleanExamDate = (examDate || '').trim();
      const cleanKkm = Math.max(0, Math.min(100, Math.round(Number(kkm) || 75)));
      const cleanDuration = Math.max(5, Math.min(300, Number(durationMinutes) || 60));
      const cleanMaxViolations = Math.max(1, Math.min(20, Number(maxViolations) || 3));
      const baseTitle = title.trim();

      const { data: classRows } = await supabase
        .from('classes')
        .select('id, name')
        .in('id', targetClassIds);
      const classNameMap = new Map(
        ((classRows || []) as Array<{ id: number; name: string }>).map((c) => [c.id, c.name])
      );

      const rowsToInsert = targetClassIds.map((cid, idx) => {
        const clsName = classNameMap.get(cid) || String(cid);
        const resolvedTitle =
          targetClassIds.length > 1
            ? baseTitle.toLowerCase().includes(clsName.toLowerCase())
              ? baseTitle
              : `${baseTitle} — Kelas ${clsName}`
            : baseTitle;

        const rawProctor = isAdmin
          ? proctorsByClass && Object.prototype.hasOwnProperty.call(proctorsByClass, String(cid))
            ? proctorsByClass[String(cid)]
            : proctorId ?? null
          : null;
        const resolvedProctorId = rawProctor ? Number(rawProctor) : null;
        const token = idx === 0 && cleanedInitialToken ? cleanedInitialToken : generateExamToken();

        return {
          teacher_id: teacherId,
          proctor_id: resolvedProctorId,
          subject_id: Number(subjectId),
          class_id: cid,
          title: resolvedTitle,
          exam_date: cleanExamDate,
          kkm: cleanKkm,
          schedule_group: scheduleGroup,
          duration_minutes: cleanDuration,
          is_active: isActive ? 1 : 0,
          max_violations: cleanMaxViolations,
          shuffle_questions: shuffleQuestions ? 1 : 0,
          shuffle_options: shuffleOptions ? 1 : 0,
          current_token: token,
        };
      });

      const { data: insertedPkgs, error: insertErr } = await supabase
        .from('exam_packages')
        .insert(rowsToInsert)
        .select('*, subjects(name, code), classes(name)');

      if (insertErr || !insertedPkgs || insertedPkgs.length === 0) {
        return jsonResponse(req, { error: 'Gagal membuat paket ujian baru.' }, 500);
      }

      if (sourceQuestions.length > 0) {
        const cloneRows = insertedPkgs.flatMap((pkgRow: { id: number }) =>
          sourceQuestions.map((q) => ({
            subject_id: Number(subjectId),
            package_id: pkgRow.id,
            question_text: q.question_text,
            question_type: q.question_type,
            options_json: q.options_json,
            correct_option: q.correct_option,
            points: q.points,
          }))
        );
        await supabase.from('questions').insert(cloneRows);
      }

      const enriched = insertedPkgs.map((ep: Record<string, unknown>) => {
        const subj = ep.subjects as { name: string; code: string } | null;
        const cls = ep.classes as { name: string } | null;
        const { subjects: _s, classes: _c, ...rest } = ep;
        return {
          ...rest,
          subject_name: subj?.name || '',
          subject_code: subj?.code || '',
          class_name: cls?.name || '',
          access_role: getPackageAccess(
            { teacher_id: ep.teacher_id as number, proctor_id: (ep.proctor_id as number | null) ?? null },
            auth.teacher!
          ),
        };
      });

      return jsonResponse(req, { package: enriched[0], packages: enriched }, 201);
    }

    const pkgMatch = path.match(/^\/packages\/(\d+)$/);
    if (pkgMatch) {
      const pkgId = Number(pkgMatch[1]);
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;

      if (method === 'PUT') {
        const {
          title,
          subjectId,
          classId,
          proctorId,
          examDate,
          kkm,
          durationMinutes,
          maxViolations,
          shuffleQuestions,
          shuffleOptions,
          isActive,
        } = await readJsonBody<{
          title?: string;
          subjectId?: number;
          classId?: number;
          proctorId?: number | null;
          examDate?: string;
          kkm?: number;
          durationMinutes?: number;
          maxViolations?: number;
          shuffleQuestions?: boolean;
          shuffleOptions?: boolean;
          isActive?: boolean;
        }>(req);

        const { data: existing } = await supabase
          .from('exam_packages')
          .select('*')
          .eq('id', pkgId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
        }

        const access = getPackageAccess(existing, auth.teacher!);
        if (access !== 'ADMIN' && access !== 'OWNER') {
          return jsonResponse(req, { error: 'Anda tidak memiliki akses untuk mengubah paket ujian ini.' }, 403);
        }

        if (proctorId !== undefined && auth.teacher!.role !== 'ADMIN') {
          return jsonResponse(req, { error: 'Hanya Admin Sekolah yang dapat menentukan Guru Pengawas.' }, 403);
        }

        let nextProctorId = existing.proctor_id ?? null;
        if (proctorId !== undefined && auth.teacher!.role === 'ADMIN') {
          if (proctorId === null || Number(proctorId) === 0) {
            nextProctorId = null;
          } else {
            const { data: foundProctor } = await supabase
              .from('teachers')
              .select('id')
              .eq('id', Number(proctorId))
              .maybeSingle();
            if (!foundProctor) {
              return jsonResponse(req, { error: 'Akun Guru Pengawas tidak ditemukan.' }, 400);
            }
            nextProctorId = foundProctor.id;
          }
        }

        const nextSubjectId = subjectId ? Number(subjectId) : existing.subject_id;
        const nextClassId = classId ? Number(classId) : existing.class_id;
        if (auth.teacher!.role !== 'ADMIN') {
          const scope = await getTeacherAssignmentScope(auth.teacher!.teacherId);
          if (!scope.pairs.has(`${nextSubjectId}:${nextClassId}`)) {
            return jsonResponse(
              req,
              { error: 'Akses ditolak. Mata pelajaran dan kelas paket ujian harus sesuai penugasan Anda.' },
              403
            );
          }
        }
        const nextExamDate = examDate !== undefined ? examDate.trim() : existing.exam_date || '';
        const nextKkm =
          kkm !== undefined ? Math.max(0, Math.min(100, Math.round(Number(kkm)))) : existing.kkm ?? 75;

        await supabase
          .from('exam_packages')
          .update({
            title: title?.trim() || existing.title,
            subject_id: nextSubjectId,
            class_id: nextClassId,
            proctor_id: nextProctorId,
            exam_date: nextExamDate,
            kkm: nextKkm,
            duration_minutes: durationMinutes
              ? Math.max(5, Math.min(300, Number(durationMinutes)))
              : existing.duration_minutes,
            max_violations: maxViolations
              ? Math.max(1, Math.min(20, Number(maxViolations)))
              : existing.max_violations,
            shuffle_questions:
              typeof shuffleQuestions === 'boolean'
                ? shuffleQuestions
                  ? 1
                  : 0
                : existing.shuffle_questions,
            shuffle_options:
              typeof shuffleOptions === 'boolean'
                ? shuffleOptions
                  ? 1
                  : 0
                : existing.shuffle_options,
            is_active:
              typeof isActive === 'boolean' ? (isActive ? 1 : 0) : existing.is_active,
          })
          .eq('id', pkgId);

        if (nextSubjectId !== existing.subject_id) {
          await supabase.from('questions').update({ subject_id: nextSubjectId }).eq('package_id', pkgId);
        }

        return jsonResponse(req, { success: true });
      }

      if (method === 'DELETE') {
        const { data: existing } = await supabase
          .from('exam_packages')
          .select('id, teacher_id, proctor_id')
          .eq('id', pkgId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
        }

        const access = getPackageAccess(existing, auth.teacher!);
        if (access !== 'ADMIN' && access !== 'OWNER') {
          return jsonResponse(req, { error: 'Anda tidak memiliki akses untuk menghapus paket ujian ini.' }, 403);
        }

        await supabase.from('exam_packages').delete().eq('id', pkgId);
        return jsonResponse(req, { success: true });
      }
    }

    const pkgToggleMatch = path.match(/^\/packages\/(\d+)\/toggle-active$/);
    if (method === 'POST' && pkgToggleMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgToggleMatch[1]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, teacher_id, proctor_id, is_active')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access !== 'ADMIN' && access !== 'OWNER') {
        return jsonResponse(
          req,
          { error: 'Hanya Admin atau Guru Mapel pembuat paket yang dapat mengaktifkan/menonaktifkan ujian.' },
          403
        );
      }

      const nextActive = pkg.is_active ? 0 : 1;
      await supabase.from('exam_packages').update({ is_active: nextActive }).eq('id', pkgId);

      await broadcastPackageEvent(supabase, {
        type: 'package:status_changed',
        packageId: pkgId,
        payload: { isActive: nextActive === 1 },
        timestamp: Date.now(),
      });

      return jsonResponse(req, { packageId: pkgId, isActive: nextActive === 1 });
    }

    const pkgRotateMatch = path.match(/^\/packages\/(\d+)\/rotate-token$/);
    if (method === 'POST' && pkgRotateMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgRotateMatch[1]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, teacher_id, proctor_id, current_token')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access !== 'ADMIN' && access !== 'OWNER') {
        return jsonResponse(
          req,
          { error: 'Hanya Admin atau Guru Mapel pembuat paket yang dapat merotasi token.' },
          403
        );
      }

      let nextToken = generateExamToken();
      while (nextToken === pkg.current_token) {
        nextToken = generateExamToken();
      }

      const rotatedAt = new Date().toISOString();
      await supabase
        .from('exam_packages')
        .update({ current_token: nextToken, token_rotated_at: rotatedAt })
        .eq('id', pkgId);

      await broadcastPackageEvent(supabase, {
        type: 'package:token_rotated',
        packageId: pkgId,
        payload: { rotatedAt },
        timestamp: Date.now(),
      });

      return jsonResponse(req, {
        packageId: pkgId,
        currentToken: nextToken,
        tokenRotatedAt: rotatedAt,
      });
    }

    const pkgQrMatch = path.match(/^\/packages\/(\d+)\/qr$/);
    if (method === 'GET' && pkgQrMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgQrMatch[1]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('*, subjects(name, code), classes(name)')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access === 'NONE') {
        return jsonResponse(req, { error: 'Anda tidak memiliki akses melihat QR paket ujian ini.' }, 403);
      }

      const teacherIds = [pkg.teacher_id, pkg.proctor_id].filter(
        (id): id is number => typeof id === 'number' && id > 0
      );
      const { data: tRows } =
        teacherIds.length > 0
          ? await supabase.from('teachers').select('id, name').in('id', teacherIds)
          : { data: [] };
      const tMap = new Map(((tRows || []) as Array<{ id: number; name: string }>).map((t) => [t.id, t.name]));

      const subj = pkg.subjects as { name: string; code: string } | null;
      const cls = pkg.classes as { name: string } | null;
      const masterKey = await getMasterSecret(supabase);

      const encryptedPayload = encryptQrPayload(
        {
          packageId: pkg.id,
          classId: pkg.class_id,
          subjectCode: subj?.code || 'MAPEL',
          title: pkg.title,
        },
        masterKey
      );

      const requestedBase = url.searchParams.get('baseUrl');
      const originHeader = req.headers.get('origin') ? `${req.headers.get('origin')}/` : null;
      const portalBaseUrl =
        normalizeStudentPortalBaseUrl(requestedBase) ||
        normalizeStudentPortalBaseUrl(originHeader) ||
        'https://examboweb.pages.dev/';

      const studentExamUrl = `${portalBaseUrl}#/exam?token=${encodeURIComponent(pkg.current_token)}`;
      const exambroDeepLink = `examflow://join?payload=${encodeURIComponent(encryptedPayload)}`;
      const qrDataUrl = await generateQrDataUrl(studentExamUrl);

      return jsonResponse(req, {
        packageId: pkg.id,
        title: pkg.title,
        className: cls?.name || '',
        subjectName: subj?.name || '',
        teacherName: tMap.get(pkg.teacher_id) || '',
        proctorName: pkg.proctor_id ? tMap.get(pkg.proctor_id) || null : null,
        examDate: pkg.exam_date || '',
        isActive: pkg.is_active === 1,
        currentToken: pkg.current_token,
        studentExamUrl,
        encryptedPayload,
        exambroDeepLink,
        qrDataUrl,
      });
    }

    // 3. QUESTION BANK CRUD (OWNER / ADMIN ONLY — PROCTOR DENIED)
    const pkgQuestionsMatch = path.match(/^\/packages\/(\d+)\/questions$/);
    if (pkgQuestionsMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgQuestionsMatch[1]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, subject_id, teacher_id, proctor_id, schedule_group')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access !== 'ADMIN' && access !== 'OWNER') {
        return jsonResponse(
          req,
          { error: 'Akses ditolak. Guru Pengawas tidak diperkenankan membuka atau mengubah Bank Soal.' },
          403
        );
      }

      if (method === 'GET') {
        const { data: questions } = await supabase
          .from('questions')
          .select('*')
          .eq('package_id', pkgId)
          .order('id', { ascending: true });

        return jsonResponse(req, {
          questions: (questions || []).map((q: Record<string, unknown>) => ({
            ...q,
            options: JSON.parse(q.options_json as string) as OptionItem[],
          })),
        });
      }

      if (method === 'POST') {
        const { questionText, options, correctOption, points = 20, syncSiblings = true } = await readJsonBody<{
          questionText?: string;
          options?: OptionItem[];
          correctOption?: string;
          points?: number;
          syncSiblings?: boolean;
        }>(req);

        if (!questionText?.trim() || !Array.isArray(options) || options.length < 2 || !correctOption) {
          return jsonResponse(
            req,
            { error: 'Teks soal, minimal 2 pilihan jawaban, dan kunci jawaban wajib diisi.' },
            400
          );
        }

        const cleanText = questionText.trim();
        const optionsJson = JSON.stringify(options);
        const cleanCorrect = correctOption.trim().toUpperCase();
        const cleanPoints = Math.max(1, Number(points) || 10);

        const { data: insertedQ, error } = await supabase
          .from('questions')
          .insert({
            subject_id: pkg.subject_id,
            package_id: pkgId,
            question_text: cleanText,
            question_type: 'MULTIPLE_CHOICE',
            options_json: optionsJson,
            correct_option: cleanCorrect,
            points: cleanPoints,
          })
          .select('id')
          .single();

        if (error || !insertedQ) {
          return jsonResponse(req, { error: 'Gagal menyimpan soal.' }, 500);
        }

        let syncedPackageCount = 0;
        if (syncSiblings && pkg.schedule_group) {
          const siblings = await getEligibleSyncSiblings(supabase, pkgId, pkg.schedule_group);
          if (siblings.length > 0) {
            await supabase.from('questions').insert(
              siblings.map((sib) => ({
                subject_id: sib.subject_id,
                package_id: sib.id,
                question_text: cleanText,
                question_type: 'MULTIPLE_CHOICE',
                options_json: optionsJson,
                correct_option: cleanCorrect,
                points: cleanPoints,
              }))
            );
            syncedPackageCount = siblings.length;
          }
        }

        return jsonResponse(req, { id: insertedQ.id, syncedPackageCount }, 201);
      }
    }

    const pkgImportQMatch = path.match(/^\/packages\/(\d+)\/questions\/import$/);
    if (method === 'POST' && pkgImportQMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgImportQMatch[1]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, subject_id, teacher_id, proctor_id, schedule_group')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access !== 'ADMIN' && access !== 'OWNER') {
        return jsonResponse(
          req,
          { error: 'Akses ditolak. Guru Pengawas tidak diperkenankan mengimpor soal.' },
          403
        );
      }

      const { rawText, replaceExisting = false, syncSiblings = true } = await readJsonBody<{
        rawText?: string;
        replaceExisting?: boolean;
        syncSiblings?: boolean;
      }>(req);

      if (!rawText || !rawText.trim()) {
        return jsonResponse(
          req,
          { error: 'Data teks atau file CSV soal tidak boleh kosong.' },
          400
        );
      }

      const lines = rawText
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length === 0) {
        return jsonResponse(req, { error: 'Tidak ada baris soal yang ditemukan.' }, 400);
      }

      const errors: Array<{ lineNumber: number; raw: string; reason: string }> = [];
      const toInsert: Array<{
        subject_id: number;
        package_id: number;
        question_text: string;
        question_type: string;
        options_json: string;
        correct_option: string;
        points: number;
      }> = [];
      let totalRows = 0;

      for (let idx = 0; idx < lines.length; idx++) {
        const lineNumber = idx + 1;
        const line = lines[idx];
        const cols = splitDelimitedLine(line);

        if (idx === 0) {
          const c0 = (cols[0] || '').toLowerCase();
          const c5 = (cols[5] || '').toLowerCase();
          if (c0.includes('pertanyaan') || c0 === 'soal' || c5.includes('kunci')) {
            continue;
          }
        }

        totalRows++;

        if (cols.length < 6) {
          errors.push({
            lineNumber,
            raw: line,
            reason:
              'Minimal harus memiliki 6 kolom (Pertanyaan, Opsi A, Opsi B, Opsi C, Opsi D, Kunci Jawaban).',
          });
          continue;
        }

        const qText = cols[0].trim();
        const optA = cols[1].trim();
        const optB = cols[2].trim();
        const optC = cols[3].trim();
        const optD = cols[4].trim();
        const correctKey = cols[5].trim().toUpperCase();
        const rawPoints = (cols[6] || '').trim();
        const points = rawPoints ? Math.max(1, Math.min(100, Number(rawPoints) || 20)) : 20;

        if (!qText || !optA || !optB || !optC || !optD) {
          errors.push({
            lineNumber,
            raw: line,
            reason: 'Pertanyaan dan seluruh Opsi A–D tidak boleh kosong.',
          });
          continue;
        }

        if (!['A', 'B', 'C', 'D'].includes(correctKey)) {
          errors.push({
            lineNumber,
            raw: line,
            reason: 'Kunci jawaban harus berupa huruf A, B, C, atau D.',
          });
          continue;
        }

        const options: OptionItem[] = [
          { key: 'A', text: optA },
          { key: 'B', text: optB },
          { key: 'C', text: optC },
          { key: 'D', text: optD },
        ];

        toInsert.push({
          subject_id: pkg.subject_id,
          package_id: pkgId,
          question_text: qText,
          question_type: 'MULTIPLE_CHOICE',
          options_json: JSON.stringify(options),
          correct_option: correctKey,
          points,
        });
      }

      const eligibleSiblings =
        syncSiblings && pkg.schedule_group
          ? await getEligibleSyncSiblings(supabase, pkgId, pkg.schedule_group)
          : [];

      if (replaceExisting) {
        const delIds = [pkgId, ...eligibleSiblings.map((s) => s.id)];
        await supabase.from('questions').delete().in('package_id', delIds);
      }

      if (toInsert.length > 0) {
        const sibInserts = eligibleSiblings.flatMap((sib) =>
          toInsert.map((item) => ({
            ...item,
            subject_id: sib.subject_id,
            package_id: sib.id,
          }))
        );
        await supabase.from('questions').insert([...toInsert, ...sibInserts]);
      }

      return jsonResponse(req, {
        summary: {
          totalRows,
          createdCount: toInsert.length,
          errorCount: errors.length,
          syncedPackageCount: eligibleSiblings.length,
        },
        errors,
      });
    }

    const qMatch = path.match(/^\/questions\/(\d+)$/);
    if (qMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const qId = Number(qMatch[1]);

      const { data: existing } = await supabase
        .from('questions')
        .select('*')
        .eq('id', qId)
        .maybeSingle();

      if (!existing) {
        return jsonResponse(req, { error: 'Soal tidak ditemukan.' }, 404);
      }

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, teacher_id, proctor_id, schedule_group')
        .eq('id', existing.package_id)
        .maybeSingle();

      if (pkg) {
        const access = getPackageAccess(pkg, auth.teacher!);
        if (access !== 'ADMIN' && access !== 'OWNER') {
          return jsonResponse(
            req,
            { error: 'Akses ditolak. Guru Pengawas tidak diperkenankan mengubah atau menghapus soal.' },
            403
          );
        }
      }

      if (method === 'PUT') {
        const { questionText, options, correctOption, points, syncSiblings = true } = await readJsonBody<{
          questionText?: string;
          options?: OptionItem[];
          correctOption?: string;
          points?: number;
          syncSiblings?: boolean;
        }>(req);

        const nextText = questionText?.trim() || existing.question_text;
        const nextOpts = Array.isArray(options) ? JSON.stringify(options) : existing.options_json;
        const nextCorrect = correctOption ? correctOption.trim().toUpperCase() : existing.correct_option;
        const nextPoints = points ? Math.max(1, Number(points)) : existing.points;

        await supabase
          .from('questions')
          .update({
            question_text: nextText,
            options_json: nextOpts,
            correct_option: nextCorrect,
            points: nextPoints,
          })
          .eq('id', qId);

        if (syncSiblings && pkg?.schedule_group) {
          const siblings = await getEligibleSyncSiblings(supabase, pkg.id, pkg.schedule_group);
          if (siblings.length > 0) {
            await supabase
              .from('questions')
              .update({
                question_text: nextText,
                options_json: nextOpts,
                correct_option: nextCorrect,
                points: nextPoints,
              })
              .in(
                'package_id',
                siblings.map((s) => s.id)
              )
              .eq('question_text', existing.question_text);
          }
        }

        return jsonResponse(req, { success: true });
      }

      if (method === 'DELETE') {
        await supabase.from('questions').delete().eq('id', qId);

        if (pkg?.schedule_group) {
          const siblings = await getEligibleSyncSiblings(supabase, pkg.id, pkg.schedule_group);
          if (siblings.length > 0) {
            await supabase
              .from('questions')
              .delete()
              .in(
                'package_id',
                siblings.map((s) => s.id)
              )
              .eq('question_text', existing.question_text);
          }
        }

        return jsonResponse(req, { success: true });
      }
    }

    // 4. STUDENTS & SEMESTER PIN MANAGEMENT
    if (method === 'GET' && path === '/students') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const isAdmin = auth.teacher!.role === 'ADMIN';

      const classIdParam = url.searchParams.get('classId');
      const classId = classIdParam ? Number(classIdParam) : null;

      let query = supabase
        .from('students')
        .select('id, nis, name, class_id, pin_hash, pin_encrypted, pin_updated_at, classes(name)');

      if (!isAdmin) {
        const scope = await getTeacherAssignmentScope(auth.teacher!.teacherId);
        if (scope.classIds.length === 0) {
          return jsonResponse(req, { students: [] });
        }
        if (classId) {
          if (!scope.classIds.includes(classId)) {
            return jsonResponse(
              req,
              { error: 'Akses ditolak. Anda hanya dapat melihat data siswa pada kelas penugasan Anda.' },
              403
            );
          }
          query = query.eq('class_id', classId);
        } else {
          query = query.in('class_id', scope.classIds);
        }
      } else if (classId) {
        query = query.eq('class_id', classId);
      }

      const { data: rows } = await query;
      const keyMaterial = await getPinKeyMaterial(supabase);

      const students = [];
      for (const row of rows || []) {
        const cls = row.classes as unknown as { name: string } | null;
        let decryptedPin: string | null = null;
        if (row.pin_encrypted) {
          decryptedPin = decryptTextWithKey(row.pin_encrypted, keyMaterial);
        } else if (row.pin_hash && verifySecret('123456', row.pin_hash)) {
          decryptedPin = '123456';
          const enc = encryptTextWithKey('123456', keyMaterial);
          await supabase.from('students').update({ pin_encrypted: enc }).eq('id', row.id);
        }

        students.push({
          id: row.id,
          nis: row.nis,
          name: row.name,
          class_id: row.class_id,
          class_name: cls?.name || '',
          pin_updated_at: row.pin_updated_at,
          semester_pin: decryptedPin,
        });
      }

      students.sort(
        (a, b) => a.class_name.localeCompare(b.class_name) || a.nis.localeCompare(b.nis)
      );

      return jsonResponse(req, { students });
    }

    if (method === 'POST' && path === '/students') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const isAdmin = auth.teacher!.role === 'ADMIN';

      const { nis, name, classId, customPin } = await readJsonBody<{
        nis?: string;
        name?: string;
        classId?: number;
        customPin?: string;
      }>(req);

      if (!nis?.trim() || !name?.trim() || !classId) {
        return jsonResponse(req, { error: 'NIS, nama siswa, dan kelas wajib diisi.' }, 400);
      }

      if (!isAdmin) {
        const scope = await getTeacherAssignmentScope(auth.teacher!.teacherId);
        if (!scope.classIds.includes(Number(classId))) {
          return jsonResponse(
            req,
            { error: 'Akses ditolak. Anda hanya dapat menambahkan siswa ke kelas penugasan Anda.' },
            403
          );
        }
      }

      const trimmedCustomPin = customPin?.trim() || '';
      if (trimmedCustomPin && !isAdmin) {
        return jsonResponse(
          req,
          {
            error:
              'Akses ditolak. Guru hanya dapat menambahkan siswa (NIS, Nama, Kelas); PIN awal dibuat otomatis oleh sistem.',
          },
          403
        );
      }

      if (trimmedCustomPin && !/^\d{4,6}$/.test(trimmedCustomPin)) {
        return jsonResponse(
          req,
          { error: 'PIN Semester khusus harus terdiri dari 4–6 digit angka.' },
          400
        );
      }

      const rawPin = isAdmin && trimmedCustomPin ? trimmedCustomPin : generateSemesterPin();
      const pinHash = hashSecret(rawPin);
      const pinEncrypted = encryptTextWithKey(rawPin, await getPinKeyMaterial(supabase));

      const { data: inserted, error } = await supabase
        .from('students')
        .insert({
          nis: nis.trim(),
          name: name.trim(),
          class_id: Number(classId),
          pin_hash: pinHash,
          pin_encrypted: pinEncrypted,
        })
        .select('id')
        .single();

      if (error || !inserted) {
        return jsonResponse(req, { error: 'NIS siswa sudah terdaftar.' }, 409);
      }

      return jsonResponse(
        req,
        {
          student: {
            id: inserted.id,
            nis: nis.trim(),
            name: name.trim(),
            classId: Number(classId),
            semester_pin: rawPin,
          },
          generatedPin: rawPin,
        },
        201
      );
    }

    const studentMatch = path.match(/^\/students\/(\d+)$/);
    if (studentMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const studentId = Number(studentMatch[1]);

      if (method === 'PUT') {
        const { data: existing } = await supabase
          .from('students')
          .select('id, class_id')
          .eq('id', studentId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Siswa tidak ditemukan.' }, 404);
        }

        const { nis, name, classId } = await readJsonBody<{
          nis?: string;
          name?: string;
          classId?: number;
        }>(req);

        const cleanNis = (nis || '').trim();
        const cleanName = (name || '').trim();
        const cleanClassId = Number(classId);

        if (!cleanNis || !cleanName || !Number.isFinite(cleanClassId) || cleanClassId <= 0) {
          return jsonResponse(req, { error: 'NIS, nama siswa, dan kelas wajib diisi.' }, 400);
        }

        if (auth.teacher!.role !== 'ADMIN') {
          const scope = await getTeacherAssignmentScope(auth.teacher!.teacherId);
          if (!scope.classIds.includes(existing.class_id) || !scope.classIds.includes(cleanClassId)) {
            return jsonResponse(
              req,
              { error: 'Akses ditolak. Anda hanya dapat mengubah data siswa pada kelas penugasan Anda.' },
              403
            );
          }
        }

        const { data: cls } = await supabase
          .from('classes')
          .select('id, name')
          .eq('id', cleanClassId)
          .maybeSingle();
        if (!cls) {
          return jsonResponse(req, { error: 'Kelas yang dipilih tidak valid.' }, 400);
        }

        const { data: updated, error } = await supabase
          .from('students')
          .update({ nis: cleanNis, name: cleanName, class_id: cleanClassId })
          .eq('id', studentId)
          .select('id, nis, name, class_id, pin_updated_at')
          .single();

        if (error || !updated) {
          return jsonResponse(req, { error: `NIS "${cleanNis}" sudah digunakan siswa lain.` }, 409);
        }

        return jsonResponse(req, {
          student: {
            ...updated,
            class_name: cls.name,
          },
        });
      }

      if (method === 'DELETE') {
        const { data: existing } = await supabase
          .from('students')
          .select('id, class_id')
          .eq('id', studentId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Siswa tidak ditemukan.' }, 404);
        }

        if (auth.teacher!.role !== 'ADMIN') {
          const scope = await getTeacherAssignmentScope(auth.teacher!.teacherId);
          if (!scope.classIds.includes(existing.class_id)) {
            return jsonResponse(
              req,
              { error: 'Akses ditolak. Anda hanya dapat menghapus data siswa pada kelas penugasan Anda.' },
              403
            );
          }
        }

        const { data: deleted } = await supabase
          .from('students')
          .delete()
          .eq('id', studentId)
          .select('id');

        if (!deleted || deleted.length === 0) {
          return jsonResponse(req, { error: 'Siswa tidak ditemukan.' }, 404);
        }
        return jsonResponse(req, { success: true });
      }
    }

    const pinResetMatch = path.match(/^\/students\/(\d+)\/(?:reset-pin|pin)$/);
    if (pinResetMatch && (method === 'POST' || method === 'PUT')) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;

      if (auth.teacher!.role !== 'ADMIN') {
        return jsonResponse(
          req,
          {
            error:
              'Akses ditolak (HTTP 403). Hanya Admin Penanggung Jawab Ujian Semester yang dapat mengubah, meng-generate ulang, atau mereset PIN Semester.',
          },
          403
        );
      }

      const studentId = Number(pinResetMatch[1]);
      const { customPin } = await readJsonBody<{ customPin?: string }>(req);

      const { data: student } = await supabase
        .from('students')
        .select('id, nis, name')
        .eq('id', studentId)
        .maybeSingle();

      if (!student) {
        return jsonResponse(req, { error: 'Siswa tidak ditemukan.' }, 404);
      }

      const trimmedCustom = customPin?.trim() || '';
      if (trimmedCustom && !/^\d{4,6}$/.test(trimmedCustom)) {
        return jsonResponse(req, { error: 'PIN Semester harus terdiri dari 4–6 digit angka.' }, 400);
      }

      const newPin = trimmedCustom || generateSemesterPin();
      const pinHash = hashSecret(newPin);
      const pinEncrypted = encryptTextWithKey(newPin, await getPinKeyMaterial(supabase));

      await supabase
        .from('students')
        .update({
          pin_hash: pinHash,
          pin_encrypted: pinEncrypted,
          pin_updated_at: new Date().toISOString(),
        })
        .eq('id', studentId);

      return jsonResponse(req, {
        studentId: student.id,
        nis: student.nis,
        name: student.name,
        newPin,
      });
    }

    if (method === 'POST' && path === '/students/import') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const isAdmin = auth.teacher!.role === 'ADMIN';
      const teacherScope = isAdmin ? null : await getTeacherAssignmentScope(auth.teacher!.teacherId);
      if (teacherScope && teacherScope.classIds.length === 0) {
        return jsonResponse(
          req,
          { error: 'Akun Anda belum memiliki penugasan kelas mengajar dari Admin Sekolah.' },
          403
        );
      }

      const { rawText, updateExisting = false } = await readJsonBody<{
        rawText?: string;
        updateExisting?: boolean;
      }>(req);

      if (!rawText || !rawText.trim()) {
        return jsonResponse(
          req,
          { error: 'Data teks atau file CSV siswa tidak boleh kosong.' },
          400
        );
      }

      const lines = rawText
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length === 0) {
        return jsonResponse(req, { error: 'Tidak ada baris data siswa yang ditemukan.' }, 400);
      }

      const keyMaterial = await getPinKeyMaterial(supabase);
      const importedPins: Array<{
        nis: string;
        name: string;
        className: string;
        pin: string;
        action: 'CREATED' | 'UPDATED';
      }> = [];
      const skipped: Array<{ lineNumber: number; nis: string; name: string; reason: string }> = [];
      const errors: Array<{ lineNumber: number; raw: string; reason: string }> = [];

      const { data: allClasses } = await supabase.from('classes').select('id, name');
      const classMap = new Map(
        (allClasses || []).map((c: { id: number; name: string }) => [c.name.toLowerCase(), c])
      );

      let totalRows = 0;

      for (let idx = 0; idx < lines.length; idx++) {
        const lineNumber = idx + 1;
        const line = lines[idx];
        const cols = splitDelimitedLine(line);

        if (idx === 0) {
          const c0 = (cols[0] || '').toLowerCase();
          const c1 = (cols[1] || '').toLowerCase();
          if (
            c0 === 'nis' ||
            c0 === 'no' ||
            c0 === 'no.' ||
            c0.includes('no. ujian') ||
            c0.includes('no ujian') ||
            c1.includes('nama')
          ) {
            continue;
          }
        }

        totalRows++;

        if (cols.length < 3) {
          errors.push({
            lineNumber,
            raw: line,
            reason: 'Minimal harus memiliki 3 kolom (NIS, Nama Lengkap, Kelas).',
          });
          continue;
        }

        const nis = cols[0].trim();
        const name = cols[1].trim();
        const rawClass = cols[2].replace(/^kelas\s+/i, '').trim();
        const rawPinInput = isAdmin ? (cols[3] || '').trim() : '';

        if (!nis || !name || !rawClass) {
          errors.push({
            lineNumber,
            raw: line,
            reason: 'Kolom NIS, Nama Lengkap, dan Kelas tidak boleh kosong.',
          });
          continue;
        }

        if (isAdmin && rawPinInput && !/^\d{4,6}$/.test(rawPinInput)) {
          errors.push({
            lineNumber,
            raw: line,
            reason: 'PIN Semester harus berupa 4–6 digit angka (atau kosongkan untuk otomatis).',
          });
          continue;
        }

        let classRow = classMap.get(rawClass.toLowerCase());
        if (!classRow) {
          if (!isAdmin) {
            errors.push({
              lineNumber,
              raw: line,
              reason: `Kelas "${rawClass}" tidak ditemukan atau bukan bagian dari penugasan mengajar Anda.`,
            });
            continue;
          }
          const matchGrade = rawClass.match(/^(\d+)/);
          const gradeLevel = matchGrade ? Number(matchGrade[1]) : 8;
          const upperName = rawClass.toUpperCase();
          const { data: newCls } = await supabase
            .from('classes')
            .insert({ name: upperName, grade_level: gradeLevel })
            .select('id, name')
            .single();
          if (newCls) {
            classRow = newCls;
            classMap.set(upperName.toLowerCase(), newCls);
          }
        }

        if (!classRow) {
          errors.push({ lineNumber, raw: line, reason: 'Gagal memproses data kelas.' });
          continue;
        }

        if (teacherScope && !teacherScope.classIds.includes(classRow.id)) {
          errors.push({
            lineNumber,
            raw: line,
            reason: `Kelas "${classRow.name}" bukan bagian dari penugasan mengajar Anda.`,
          });
          continue;
        }

        const { data: existingStudent } = await supabase
          .from('students')
          .select('id, nis, name, class_id, pin_hash, pin_encrypted')
          .eq('nis', nis)
          .maybeSingle();

        if (existingStudent && !updateExisting) {
          skipped.push({
            lineNumber,
            nis,
            name,
            reason: 'NIS sudah terdaftar (lewati duplikat).',
          });
          continue;
        }

        if (existingStudent && updateExisting && teacherScope && !teacherScope.classIds.includes(existingStudent.class_id)) {
          errors.push({
            lineNumber,
            raw: line,
            reason: `Siswa NIS "${nis}" terdaftar di kelas di luar penugasan mengajar Anda.`,
          });
          continue;
        }

        if (existingStudent && updateExisting) {
          if (isAdmin && rawPinInput) {
            const pinHash = hashSecret(rawPinInput);
            const pinEncrypted = encryptTextWithKey(rawPinInput, keyMaterial);
            await supabase
              .from('students')
              .update({
                name,
                class_id: classRow.id,
                pin_hash: pinHash,
                pin_encrypted: pinEncrypted,
                pin_updated_at: new Date().toISOString(),
              })
              .eq('id', existingStudent.id);
            importedPins.push({
              nis,
              name,
              className: classRow.name,
              pin: rawPinInput,
              action: 'UPDATED',
            });
          } else {
            await supabase
              .from('students')
              .update({ name, class_id: classRow.id })
              .eq('id', existingStudent.id);
            let preservedPin = existingStudent.pin_encrypted
              ? decryptTextWithKey(existingStudent.pin_encrypted, keyMaterial)
              : null;
            if (!preservedPin && existingStudent.pin_hash && verifySecret('123456', existingStudent.pin_hash)) {
              preservedPin = '123456';
            }
            importedPins.push({
              nis,
              name,
              className: classRow.name,
              pin: preservedPin || 'Tetap (Tersimpan)',
              action: 'UPDATED',
            });
          }
        } else {
          const plainPin = rawPinInput || generateSemesterPin();
          const pinHash = hashSecret(plainPin);
          const pinEncrypted = encryptTextWithKey(plainPin, keyMaterial);
          await supabase.from('students').insert({
            nis,
            name,
            class_id: classRow.id,
            pin_hash: pinHash,
            pin_encrypted: pinEncrypted,
          });
          importedPins.push({
            nis,
            name,
            className: classRow.name,
            pin: plainPin,
            action: 'CREATED',
          });
        }
      }

      return jsonResponse(req, {
        summary: {
          totalRows,
          createdCount: importedPins.filter((p) => p.action === 'CREATED').length,
          updatedCount: importedPins.filter((p) => p.action === 'UPDATED').length,
          skippedCount: skipped.length,
          errorCount: errors.length,
        },
        importedPins,
        skipped,
        errors,
      });
    }

    // 5. LIVE MONITORING, UNLOCK & GRADE RECAP
    const pkgMonitoringMatch = path.match(/^\/packages\/(\d+)\/monitoring$/);
    if (method === 'GET' && pkgMonitoringMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgMonitoringMatch[1]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('*, subjects(name), classes(name)')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access === 'NONE') {
        return jsonResponse(req, { error: 'Anda tidak memiliki akses memantau paket ujian ini.' }, 403);
      }
      const isProctorOnly = access === 'PROCTOR';

      const teacherIds = [pkg.teacher_id, pkg.proctor_id].filter(
        (id): id is number => typeof id === 'number' && id > 0
      );
      const { data: tRows } =
        teacherIds.length > 0
          ? await supabase.from('teachers').select('id, name').in('id', teacherIds)
          : { data: [] };
      const tMap = new Map(((tRows || []) as Array<{ id: number; name: string }>).map((t) => [t.id, t.name]));

      const { count: totalQuestionsCount } = await supabase
        .from('questions')
        .select('id', { count: 'exact', head: true })
        .eq('package_id', pkgId);
      const totalQuestions = totalQuestionsCount || 0;

      const now = Date.now();
      const { data: overdue } = await supabase
        .from('exam_sessions')
        .select('id')
        .eq('package_id', pkgId)
        .eq('status', 'IN_PROGRESS')
        .lte('expires_at', now);

      for (const s of overdue || []) {
        await gradeAndFinalizeSession(supabase, s.id, pkgId);
      }

      const [{ data: classStudents }, { data: sessions }, { data: rawViolations }] =
        await Promise.all([
          supabase
            .from('students')
            .select('id, nis, name, classes(name)')
            .eq('class_id', pkg.class_id)
            .order('nis', { ascending: true }),
          supabase.from('exam_sessions').select('*').eq('package_id', pkgId),
          supabase
            .from('violation_logs')
            .select('id, session_id, violation_type, detail, created_at, students(nis, name)')
            .eq('package_id', pkgId)
            .order('created_at', { ascending: false })
            .limit(30),
        ]);

      const sessionIds = (sessions || []).map((s: { id: number }) => s.id);
      const answerCountMap = new Map<number, number>();
      if (sessionIds.length > 0) {
        const { data: answers } = await supabase
          .from('student_answers')
          .select('session_id')
          .in('session_id', sessionIds);
        for (const a of answers || []) {
          answerCountMap.set(a.session_id, (answerCountMap.get(a.session_id) || 0) + 1);
        }
      }

      const sessionByStudent = new Map(
        (sessions || []).map((s: SessionRow) => [s.student_id, s])
      );

      const statusPriority: Record<string, number> = {
        LOCKED_VIOLATION: 0,
        IN_PROGRESS: 1,
        SUBMITTED: 2,
        NOT_STARTED: 3,
      };

      const students = (classStudents || [])
        .map((st: Record<string, unknown>) => {
          const cls = st.classes as { name: string } | null;
          const es = sessionByStudent.get(st.id as number);
          const status = es?.status || 'NOT_STARTED';
          const remainingSeconds =
            status === 'IN_PROGRESS' && es?.expires_at
              ? Math.max(0, Math.floor((es.expires_at - now) / 1000))
              : null;

          return {
            studentId: st.id as number,
            nis: st.nis as string,
            name: st.name as string,
            className: cls?.name || '',
            sessionId: es?.id ?? null,
            status,
            deviceId: es?.device_id ?? null,
            sessionInfo: es?.session_info ?? null,
            startedAt: es?.started_at ?? null,
            expiresAt: es?.expires_at ?? null,
            submittedAt: es?.submitted_at ?? null,
            remainingSeconds,
            answeredCount: es ? answerCountMap.get(es.id) || 0 : 0,
            totalQuestions,
            violationCount: es?.violation_count ?? 0,
            maxViolationsAllowed: pkg.max_violations + (es?.unlock_bonus || 0),
            score: isProctorOnly ? null : (es?.score ?? null),
            correctCount: isProctorOnly ? null : (es?.correct_count ?? null),
          };
        })
        .sort(
          (a, b) =>
            (statusPriority[a.status] ?? 3) - (statusPriority[b.status] ?? 3) ||
            a.nis.localeCompare(b.nis)
        );

      const recentViolations = (rawViolations || []).map((v: Record<string, unknown>) => {
        const st = v.students as { nis: string; name: string } | null;
        return {
          id: v.id,
          session_id: v.session_id,
          violation_type: v.violation_type,
          detail: v.detail,
          created_at: v.created_at,
          nis: st?.nis || '',
          student_name: st?.name || '',
        };
      });

      const subj = pkg.subjects as { name: string } | null;
      const cls = pkg.classes as { name: string } | null;

      return jsonResponse(req, {
        package: {
          id: pkg.id,
          title: pkg.title,
          subjectName: subj?.name || '',
          className: cls?.name || '',
          teacherName: tMap.get(pkg.teacher_id) || '',
          proctorName: pkg.proctor_id ? tMap.get(pkg.proctor_id) || null : null,
          examDate: pkg.exam_date || '',
          accessRole: access,
          durationMinutes: pkg.duration_minutes,
          isActive: pkg.is_active === 1,
          maxViolations: pkg.max_violations,
          currentToken: pkg.current_token,
          tokenRotatedAt: pkg.token_rotated_at,
          totalQuestions,
        },
        students,
        recentViolations,
      });
    }

    const unlockMatch = path.match(/^\/sessions\/(\d+)\/unlock$/);
    if (method === 'POST' && unlockMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const sessionId = Number(unlockMatch[1]);

      const check = await checkSupabaseSessionManageAccess(supabase, sessionId, auth.teacher!);
      if (!check.session || !check.pkg) {
        return jsonResponse(req, { error: check.errorMessage }, check.errorStatus || 404);
      }
      const { session, pkg } = check;

      if (session.status !== 'LOCKED_VIOLATION') {
        return jsonResponse(
          req,
          { error: 'Sesi ini tidak berada dalam status terkunci pelanggaran.' },
          400
        );
      }

      const newBonus = (session.unlock_bonus || 0) + 2;
      await supabase
        .from('exam_sessions')
        .update({ status: 'IN_PROGRESS', unlock_bonus: newBonus })
        .eq('id', sessionId);

      const maxViolationsAllowed = (pkg.max_violations || 3) + newBonus;

      await broadcastPackageEvent(supabase, {
        type: 'session:unlocked',
        packageId: session.package_id,
        studentId: session.student_id,
        sessionId: session.id,
        payload: {
          status: 'IN_PROGRESS',
          maxViolationsAllowed,
        },
        timestamp: Date.now(),
      });

      return jsonResponse(req, {
        success: true,
        sessionId,
        status: 'IN_PROGRESS',
        maxViolationsAllowed,
      });
    }

    const resetDeviceMatch = path.match(/^\/sessions\/(\d+)\/reset-device$/);
    if (method === 'POST' && resetDeviceMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const sessionId = Number(resetDeviceMatch[1]);

      const check = await checkSupabaseSessionManageAccess(supabase, sessionId, auth.teacher!);
      if (!check.session) {
        return jsonResponse(req, { error: check.errorMessage }, check.errorStatus || 404);
      }
      const { session } = check;

      if (session.status === 'SUBMITTED') {
        return jsonResponse(
          req,
          { error: 'Sesi ujian yang sudah selesai tidak dapat direset perangkatnya.' },
          400
        );
      }

      const nextSessionToken = generateSessionToken();
      await supabase
        .from('exam_sessions')
        .update({
          session_token: nextSessionToken,
          device_id: '',
          session_info: 'Diizinkan ganti perangkat oleh pengawas',
        })
        .eq('id', sessionId);

      await broadcastPackageEvent(supabase, {
        type: 'session:updated',
        packageId: session.package_id,
        studentId: session.student_id,
        sessionId: session.id,
        payload: { status: session.status, deviceReset: true },
        timestamp: Date.now(),
      });

      return jsonResponse(req, { success: true, sessionId, status: session.status });
    }

    const forceSubmitMatch = path.match(/^\/sessions\/(\d+)\/force-submit$/);
    if (method === 'POST' && forceSubmitMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const sessionId = Number(forceSubmitMatch[1]);

      const check = await checkSupabaseSessionManageAccess(supabase, sessionId, auth.teacher!);
      if (!check.session) {
        return jsonResponse(req, { error: check.errorMessage }, check.errorStatus || 404);
      }
      const { session, access } = check;

      if (session.status === 'SUBMITTED') {
        return jsonResponse(
          req,
          { error: 'Sesi ujian ini sudah berstatus selesai/dikumpulkan.' },
          400
        );
      }

      const finalized = await gradeAndFinalizeSession(supabase, session.id, session.package_id);

      await broadcastPackageEvent(supabase, {
        type: 'session:updated',
        packageId: session.package_id,
        studentId: session.student_id,
        sessionId: session.id,
        payload: { status: 'SUBMITTED', reason: 'FORCE_SUBMITTED' },
        timestamp: Date.now(),
      });

      const isProctorOnly = access === 'PROCTOR';
      return jsonResponse(req, {
        success: true,
        sessionId,
        status: 'SUBMITTED',
        score: isProctorOnly ? null : finalized.score,
        correctCount: isProctorOnly ? null : finalized.correctCount,
        totalQuestions: finalized.totalQuestions,
      });
    }

    const extendTimeMatch = path.match(/^\/sessions\/(\d+)\/extend-time$/);
    if (method === 'POST' && extendTimeMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const sessionId = Number(extendTimeMatch[1]);

      const { extraMinutes = 10 } = await readJsonBody<{ extraMinutes?: number }>(req);
      const cleanMinutes = Math.max(1, Math.min(60, Math.round(Number(extraMinutes) || 10)));

      const check = await checkSupabaseSessionManageAccess(supabase, sessionId, auth.teacher!);
      if (!check.session) {
        return jsonResponse(req, { error: check.errorMessage }, check.errorStatus || 404);
      }
      const { session } = check;

      if (session.status === 'SUBMITTED') {
        return jsonResponse(
          req,
          { error: 'Tidak dapat menambah waktu untuk sesi yang sudah selesai.' },
          400
        );
      }

      const nextExpiresAt = Math.max(session.expires_at, Date.now()) + cleanMinutes * 60 * 1000;
      await supabase
        .from('exam_sessions')
        .update({ expires_at: nextExpiresAt })
        .eq('id', sessionId);

      await broadcastPackageEvent(supabase, {
        type: 'session:updated',
        packageId: session.package_id,
        studentId: session.student_id,
        sessionId: session.id,
        payload: { status: session.status, extraMinutes: cleanMinutes },
        timestamp: Date.now(),
      });

      return jsonResponse(req, {
        success: true,
        sessionId,
        expiresAt: nextExpiresAt,
        extraMinutes: cleanMinutes,
      });
    }

    const pkgRecapMatch = path.match(/^\/packages\/(\d+)\/recap(\/csv)?$/);
    if (method === 'GET' && pkgRecapMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgRecapMatch[1]);
      const isCsv = Boolean(pkgRecapMatch[2]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, title, class_id, teacher_id, proctor_id, exam_date, kkm, subjects(name), classes(name)')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access === 'NONE') {
        return jsonResponse(req, { error: 'Anda tidak memiliki akses melihat rekap paket ujian ini.' }, 403);
      }
      const isProctorOnly = access === 'PROCTOR';

      if (isCsv && isProctorOnly) {
        return jsonResponse(
          req,
          { error: 'Guru Pengawas hanya dapat memantau status penyelesaian peserta dan tidak dapat mengunduh rekap nilai.' },
          403
        );
      }

      const teacherIds = [pkg.teacher_id, pkg.proctor_id].filter(
        (id): id is number => typeof id === 'number' && id > 0
      );
      const { data: tRows } =
        teacherIds.length > 0
          ? await supabase.from('teachers').select('id, name').in('id', teacherIds)
          : { data: [] };
      const tMap = new Map(((tRows || []) as Array<{ id: number; name: string }>).map((t) => [t.id, t.name]));

      const { count: totalQuestionsCount } = await supabase
        .from('questions')
        .select('id', { count: 'exact', head: true })
        .eq('package_id', pkgId);
      const totalQuestions = totalQuestionsCount || 0;

      const [{ data: classStudents }, { data: sessions }] = await Promise.all([
        supabase
          .from('students')
          .select('id, nis, name, classes(name)')
          .eq('class_id', pkg.class_id)
          .order('nis', { ascending: true }),
        supabase.from('exam_sessions').select('*').eq('package_id', pkgId),
      ]);

      const sessionByStudent = new Map(
        (sessions || []).map((s: SessionRow) => [s.student_id, s])
      );

      const records = (classStudents || []).map((st: Record<string, unknown>) => {
        const cls = st.classes as { name: string } | null;
        const es = sessionByStudent.get(st.id as number);
        return {
          session_id: es?.id ?? null,
          nis: st.nis as string,
          name: st.name as string,
          class_name: cls?.name || '',
          status: es?.status || 'NOT_STARTED',
          correct_count: isProctorOnly ? null : (es?.correct_count ?? null),
          total_questions: es?.total_questions ?? totalQuestions,
          score: isProctorOnly ? null : (es?.score ?? null),
          violation_count: es?.violation_count ?? 0,
          submitted_at: es?.submitted_at ?? null,
        };
      });

      if (isCsv) {
        const reqUrl = new URL(req.url);
        const rawKkmParam = reqUrl.searchParams.get('kkm');
        const parsedKkm = rawKkmParam !== null ? Number(rawKkmParam) : NaN;
        const effectiveKkm =
          Number.isFinite(parsedKkm) && parsedKkm >= 0 && parsedKkm <= 100
            ? Math.round(parsedKkm)
            : pkg.kkm ?? 75;

        const sortedRecords = [...records].sort((a, b) => {
          const sa = a.status === 'SUBMITTED' && a.score !== null ? Number(a.score) : -1;
          const sb = b.status === 'SUBMITTED' && b.score !== null ? Number(b.score) : -1;
          return sb - sa || a.name.localeCompare(b.name);
        });

        const submittedRows = sortedRecords.filter((r) => r.status === 'SUBMITTED' && r.score !== null);
        const scores = submittedRows.map((r) => Number(r.score || 0));
        const avgScore =
          scores.length > 0 ? (scores.reduce((acc, val) => acc + val, 0) / scores.length).toFixed(1) : '-';
        const maxScore = scores.length > 0 ? String(Math.max(...scores)) : '-';
        const minScore = scores.length > 0 ? String(Math.min(...scores)) : '-';
        const passedCount = submittedRows.filter((r) => Number(r.score || 0) >= effectiveKkm).length;
        const remedialCount = submittedRows.filter((r) => Number(r.score || 0) < effectiveKkm).length;
        const passRate = submittedRows.length > 0 ? Math.round((passedCount / submittedRows.length) * 100) : 0;

        const subjName = (pkg.subjects as unknown as { name: string } | null)?.name || '';
        const clsName = (pkg.classes as unknown as { name: string } | null)?.name || '';

        const lines: string[] = [
          [escapeCsvField('Sekolah'), escapeCsvField('MTs Nurul Islam Gunung Sari')].join(','),
          [escapeCsvField('Judul Ujian'), escapeCsvField(pkg.title)].join(','),
          [escapeCsvField('Kelas'), escapeCsvField(clsName)].join(','),
          [escapeCsvField('Mata Pelajaran'), escapeCsvField(subjName)].join(','),
          [escapeCsvField('Guru Mapel'), escapeCsvField(tMap.get(pkg.teacher_id) || '-')].join(','),
          [escapeCsvField('Guru Pengawas'), escapeCsvField(pkg.proctor_id ? tMap.get(pkg.proctor_id) || 'Belum ditugaskan' : 'Belum ditugaskan')].join(','),
          [escapeCsvField('Tanggal Ujian'), escapeCsvField(pkg.exam_date || '-')].join(','),
          [escapeCsvField('KKM'), escapeCsvField(effectiveKkm)].join(','),
          '',
          [escapeCsvField('RINGKASAN HASIL UJIAN'), escapeCsvField('Nilai / Jumlah')].join(','),
          [escapeCsvField('Peserta Selesai'), escapeCsvField(`${submittedRows.length} / ${sortedRecords.length}`)].join(','),
          [escapeCsvField('Rata-rata Nilai'), escapeCsvField(`${avgScore} (Tertinggi: ${maxScore}, Terendah: ${minScore})`)].join(','),
          [escapeCsvField(`Tuntas (>= ${effectiveKkm})`), escapeCsvField(`${passedCount} siswa (${passRate}%)`)].join(','),
          [escapeCsvField(`Remedial (< ${effectiveKkm})`), escapeCsvField(`${remedialCount} siswa`)].join(','),
          '',
          ['No', 'NIS', 'Nama Siswa', 'Kelas', 'Benar', 'Total Soal', 'Nilai Akhir', 'Ketuntasan', 'Status', 'Jumlah Pelanggaran'].join(','),
        ];

        sortedRecords.forEach((r, idx) => {
          const isSubmitted = r.status === 'SUBMITTED' && r.score !== null;
          const ketuntasan = isSubmitted ? (Number(r.score) >= effectiveKkm ? 'Tuntas' : 'Remedial') : '-';
          const statusLabel =
            r.status === 'SUBMITTED'
              ? 'Selesai'
              : r.status === 'IN_PROGRESS'
                ? 'Mengerjakan'
                : r.status === 'LOCKED_VIOLATION'
                  ? 'Terkunci'
                  : 'Belum Mulai';
          lines.push(
            [
              escapeCsvField(idx + 1),
              escapeCsvField(r.nis),
              escapeCsvField(r.name),
              escapeCsvField(r.class_name),
              escapeCsvField(isSubmitted ? (r.correct_count ?? 0) : '-'),
              escapeCsvField(r.total_questions),
              escapeCsvField(isSubmitted ? r.score : '-'),
              escapeCsvField(ketuntasan),
              escapeCsvField(statusLabel),
              escapeCsvField(r.violation_count),
            ].join(',')
          );
        });
        const safeSlug = pkg.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        return new Response('\uFEFF' + lines.join('\n'), {
          status: 200,
          headers: {
            ...buildCorsHeaders(req),
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="rekap-${safeSlug}.csv"`,
          },
        });
      }

      let questionAnalytics: Array<Record<string, unknown>> = [];
      if (!isProctorOnly) {
        const { data: questions } = await supabase
          .from('questions')
          .select('id, question_text, options_json, correct_option, points')
          .eq('package_id', pkgId)
          .order('id', { ascending: true });

        const submittedSessionIds = (sessions || [])
          .filter((s: SessionRow) => s.status === 'SUBMITTED')
          .map((s: SessionRow) => s.id);

        const answerByQuestion = new Map<number, string[]>();
        if (submittedSessionIds.length > 0) {
          const { data: ansRows } = await supabase
            .from('student_answers')
            .select('question_id, selected_option')
            .in('session_id', submittedSessionIds);

          for (const a of (ansRows || []) as Array<{ question_id: number; selected_option: string }>) {
            const list = answerByQuestion.get(a.question_id) || [];
            list.push(a.selected_option);
            answerByQuestion.set(a.question_id, list);
          }
        }

        const totalSubmitted = submittedSessionIds.length;
        questionAnalytics = (questions || []).map(
          (
            q: {
              id: number;
              question_text: string;
              options_json: string;
              correct_option: string;
              points: number;
            },
            index: number
          ) => {
            let parsedOptions: Array<{ key: string; text: string }> = [];
            try {
              parsedOptions = JSON.parse(q.options_json);
            } catch {
              parsedOptions = [];
            }
            const optionDistribution: Record<string, number> = {};
            for (const opt of parsedOptions) {
              optionDistribution[opt.key] = 0;
            }

            const answers = answerByQuestion.get(q.id) || [];
            let correctCount = 0;
            let wrongCount = 0;
            for (const sel of answers) {
              if (sel) {
                optionDistribution[sel] = (optionDistribution[sel] || 0) + 1;
              }
              if (sel === q.correct_option) {
                correctCount++;
              } else if (sel) {
                wrongCount++;
              }
            }
            const blankCount = Math.max(0, totalSubmitted - correctCount - wrongCount);
            const correctRate = totalSubmitted > 0 ? Math.round((correctCount / totalSubmitted) * 100) : 0;

            return {
              questionId: q.id,
              number: index + 1,
              questionText: q.question_text,
              correctOption: q.correct_option,
              points: q.points,
              totalSubmitted,
              correctCount,
              wrongCount,
              blankCount,
              correctRate,
              optionDistribution,
            };
          }
        );
      }

      const subj = pkg.subjects as unknown as { name: string } | null;
      const cls = pkg.classes as unknown as { name: string } | null;

      return jsonResponse(req, {
        package: {
          id: pkg.id,
          title: pkg.title,
          subjectName: subj?.name || '',
          className: cls?.name || '',
          teacherName: tMap.get(pkg.teacher_id) || '',
          proctorName: pkg.proctor_id ? tMap.get(pkg.proctor_id) || null : null,
          examDate: pkg.exam_date || '',
          kkm: pkg.kkm ?? 75,
          accessRole: access,
          totalQuestions,
        },
        records,
        questionAnalytics,
      });
    }

    const sessionReviewMatch = path.match(/^\/sessions\/(\d+)\/review$/);
    if (method === 'GET' && sessionReviewMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const sessionId = Number(sessionReviewMatch[1]);

      const { data: session } = await supabase
        .from('exam_sessions')
        .select('id, package_id, student_id, status, score, correct_count, total_questions, violation_count, started_at, submitted_at')
        .eq('id', sessionId)
        .maybeSingle();

      if (!session) {
        return jsonResponse(req, { error: 'Sesi ujian tidak ditemukan.' }, 404);
      }

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, title, teacher_id, proctor_id, exam_date, kkm, subjects(name), classes(name)')
        .eq('id', session.package_id)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const access = getPackageAccess(pkg, auth.teacher!);
      if (access !== 'ADMIN' && access !== 'OWNER') {
        return jsonResponse(
          req,
          { error: 'Akses ditolak. Guru Pengawas tidak diperkenankan membuka lembar jawaban & kunci soal.' },
          403
        );
      }

      const teacherIds = [pkg.teacher_id, pkg.proctor_id].filter(
        (id): id is number => typeof id === 'number' && id > 0
      );
      const { data: revTeachers } =
        teacherIds.length > 0
          ? await supabase.from('teachers').select('id, name').in('id', teacherIds)
          : { data: [] };
      const revTMap = new Map(((revTeachers || []) as Array<{ id: number; name: string }>).map((t) => [t.id, t.name]));

      const [{ data: student }, { data: questions }, { data: ansRows }] = await Promise.all([
        supabase
          .from('students')
          .select('nis, name, classes(name)')
          .eq('id', session.student_id)
          .maybeSingle(),
        supabase
          .from('questions')
          .select('id, question_text, options_json, correct_option, points')
          .eq('package_id', session.package_id)
          .order('id', { ascending: true }),
        supabase
          .from('student_answers')
          .select('question_id, selected_option')
          .eq('session_id', sessionId),
      ]);

      const ansMap = new Map(
        ((ansRows || []) as Array<{ question_id: number; selected_option: string }>).map((a) => [
          a.question_id,
          a.selected_option,
        ])
      );

      const items = (questions || []).map(
        (
          q: {
            id: number;
            question_text: string;
            options_json: string;
            correct_option: string;
            points: number;
          },
          idx: number
        ) => {
          let options: Array<{ key: string; text: string }> = [];
          try {
            options = JSON.parse(q.options_json);
          } catch {
            options = [];
          }
          const selectedOption = ansMap.get(q.id) || null;
          return {
            questionId: q.id,
            number: idx + 1,
            questionText: q.question_text,
            options,
            correctOption: q.correct_option,
            selectedOption,
            isCorrect: selectedOption === q.correct_option,
            points: q.points,
          };
        }
      );

      const stCls = (student?.classes as unknown as { name: string } | null)?.name || '';
      const pkgSubj = (pkg?.subjects as unknown as { name: string } | null)?.name || '';
      const pkgCls = (pkg?.classes as unknown as { name: string } | null)?.name || '';

      return jsonResponse(req, {
        session: {
          id: session.id,
          status: session.status,
          score: session.score,
          correctCount: session.correct_count,
          totalQuestions: session.total_questions || items.length,
          violationCount: session.violation_count,
          startedAt: session.started_at,
          submittedAt: session.submitted_at,
        },
        student: {
          nis: student?.nis || '',
          name: student?.name || '',
          className: stCls,
        },
        package: {
          id: session.package_id,
          title: pkg?.title || '',
          subjectName: pkgSubj,
          className: pkgCls,
          teacherName: revTMap.get(pkg.teacher_id) || '',
          proctorName: pkg.proctor_id ? revTMap.get(pkg.proctor_id) || null : null,
          examDate: pkg.exam_date || '',
          kkm: pkg.kkm ?? 75,
        },
        items,
      });
    }

    // 6. EXAMBRO APK & STUDENT EXAM ENDPOINTS
    if (method === 'GET' && path === '/public/active-packages') {
      const { data: active } = await supabase
        .from('exam_packages')
        .select('id, title, duration_minutes, class_id, subject_id, subjects(name, code), classes(name)')
        .eq('is_active', 1)
        .order('id', { ascending: true });

      const activeList = active || [];
      const activeIds = activeList.map((p: { id: number }) => p.id);
      const { data: qRows } = activeIds.length
        ? await supabase.from('questions').select('package_id').in('package_id', activeIds)
        : { data: [] };

      const masterKey = await getMasterSecret(supabase);

      const list = activeList.map((pkg: Record<string, unknown>) => {
        const subj = pkg.subjects as { name: string; code: string } | null;
        const cls = pkg.classes as { name: string } | null;
        const qCount = (qRows || []).filter((q: { package_id: number }) => q.package_id === pkg.id).length;

        return {
          id: pkg.id,
          title: pkg.title,
          durationMinutes: pkg.duration_minutes,
          subjectName: subj?.name || '',
          className: cls?.name || '',
          questionCount: qCount,
          qrPayload: encryptQrPayload(
            {
              packageId: pkg.id as number,
              classId: pkg.class_id as number,
              subjectCode: subj?.code || 'MAPEL',
              title: pkg.title as string,
            },
            masterKey
          ),
        };
      });

      return jsonResponse(req, { packages: list });
    }

    if (method === 'POST' && path === '/exambro/decode-qr') {
      const clientErr = checkExambroClient(req);
      if (clientErr) return clientErr;

      const { qrPayload } = await readJsonBody<{ qrPayload?: string }>(req);
      if (!qrPayload?.trim()) {
        return jsonResponse(req, { error: 'Payload QR wajib dikirim.' }, 400);
      }

      let rawToken = qrPayload.trim();
      if (rawToken.startsWith('examflow://')) {
        try {
          const parsedUrl = new URL(rawToken.replace('examflow://', 'https://examflow.local/'));
          rawToken = parsedUrl.searchParams.get('payload') || rawToken;
        } catch {
          // ignore
        }
      }

      const masterKey = await getMasterSecret(supabase);
      const decoded = decryptQrPayload(rawToken, masterKey);
      if (!decoded) {
        return jsonResponse(
          req,
          { error: 'QR Code tidak valid atau tanda tangan keamanan rusak.' },
          400
        );
      }

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, title, duration_minutes, is_active, max_violations, subjects(name), classes(name)')
        .eq('id', decoded.packageId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian dari QR Code tidak ditemukan.' }, 404);
      }

      const { count: qCount } = await supabase
        .from('questions')
        .select('id', { count: 'exact', head: true })
        .eq('package_id', pkg.id);

      const subj = pkg.subjects as unknown as { name: string } | null;
      const cls = pkg.classes as unknown as { name: string } | null;

      return jsonResponse(req, {
        package: {
          id: pkg.id,
          title: pkg.title,
          subjectName: subj?.name || '',
          className: cls?.name || '',
          durationMinutes: pkg.duration_minutes,
          isActive: pkg.is_active === 1,
          maxViolations: pkg.max_violations,
          questionCount: qCount || 0,
        },
      });
    }

    if (method === 'POST' && path === '/exambro/resolve-token') {
      const clientErr = checkExambroClient(req);
      if (clientErr) return clientErr;

      const { tokenUjian } = await readJsonBody<{ tokenUjian?: string }>(req);
      const normalizedToken = tokenUjian?.trim().toUpperCase() || '';
      if (!normalizedToken) {
        return jsonResponse(req, { error: 'Token Ujian wajib diisi.' }, 400);
      }

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, title, duration_minutes, is_active, max_violations, subjects(name), classes(name)')
        .eq('current_token', normalizedToken)
        .order('is_active', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(
          req,
          { error: 'Token Ujian tidak ditemukan atau sudah dirotasi oleh guru.' },
          404
        );
      }

      if (pkg.is_active !== 1) {
        return jsonResponse(
          req,
          { error: 'Paket ujian untuk token ini sedang dinonaktifkan oleh guru/pengawas.' },
          403
        );
      }

      const { count: qCount } = await supabase
        .from('questions')
        .select('id', { count: 'exact', head: true })
        .eq('package_id', pkg.id);

      const subj = pkg.subjects as unknown as { name: string } | null;
      const cls = pkg.classes as unknown as { name: string } | null;

      return jsonResponse(req, {
        package: {
          id: pkg.id,
          title: pkg.title,
          subjectName: subj?.name || '',
          className: cls?.name || '',
          durationMinutes: pkg.duration_minutes,
          isActive: pkg.is_active === 1,
          maxViolations: pkg.max_violations,
          questionCount: qCount || 0,
        },
      });
    }

    if (method === 'POST' && path === '/exambro/verify') {
      const clientErr = checkExambroClient(req);
      if (clientErr) return clientErr;

      const {
        qrPayload,
        packageId: explicitPackageId,
        tokenUjian,
        nis,
        pinSemester,
        deviceId = 'ANDROID-EXAMBRO-DEVICE',
        sessionInfo = 'Exambro Android Client',
      } = await readJsonBody<{
        qrPayload?: string;
        packageId?: number;
        tokenUjian?: string;
        nis?: string;
        pinSemester?: string;
        deviceId?: string;
        sessionInfo?: string;
      }>(req);

      let resolvedPackageId = explicitPackageId ? Number(explicitPackageId) : 0;
      if (qrPayload?.trim()) {
        let rawToken = qrPayload.trim();
        if (rawToken.startsWith('examflow://')) {
          try {
            const u = new URL(rawToken.replace('examflow://', 'https://examflow.local/'));
            rawToken = u.searchParams.get('payload') || rawToken;
          } catch {
            // ignore
          }
        }
        const masterKey = await getMasterSecret(supabase);
        const decoded = decryptQrPayload(rawToken, masterKey);
        if (!decoded) {
          return jsonResponse(req, { error: 'Payload QR terenkripsi tidak valid.' }, 400);
        }
        resolvedPackageId = decoded.packageId;
      }

      const normalizedToken = tokenUjian?.trim().toUpperCase() || '';

      if (!normalizedToken || !nis?.trim() || !pinSemester?.trim()) {
        return jsonResponse(
          req,
          { error: 'Token Ujian, NIS, dan PIN Semester wajib diisi.' },
          400
        );
      }

      const pkgQuery = supabase.from('exam_packages').select('*, subjects(name), classes(name)');
      const { data: pkg } = resolvedPackageId
        ? await pkgQuery.eq('id', resolvedPackageId).maybeSingle()
        : await pkgQuery
            .eq('current_token', normalizedToken)
            .order('is_active', { ascending: false })
            .order('id', { ascending: false })
            .limit(1)
            .maybeSingle();

      if (!pkg) {
        return jsonResponse(
          req,
          {
            error: resolvedPackageId
              ? 'Paket ujian tidak ditemukan.'
              : 'Token Ujian tidak valid atau sudah dirotasi oleh guru. Periksa token terbaru.',
          },
          resolvedPackageId ? 404 : 401
        );
      }

      if (pkg.is_active !== 1) {
        return jsonResponse(
          req,
          { error: 'Paket ujian sedang dinonaktifkan oleh guru/pengawas.' },
          403
        );
      }

      if (!constantTimeEqualText(normalizedToken, pkg.current_token.toUpperCase())) {
        return jsonResponse(
          req,
          { error: 'Token Ujian salah atau sudah dirotasi oleh guru. Periksa token terbaru.' },
          401
        );
      }

      const { data: student } = await supabase
        .from('students')
        .select('id, nis, name, class_id, pin_hash, classes(name)')
        .eq('nis', nis.trim())
        .maybeSingle();

      if (!student) {
        return jsonResponse(req, { error: 'NIS siswa tidak terdaftar dalam sistem.' }, 401);
      }

      const pkgCls = pkg.classes as unknown as { name: string } | null;
      const pkgSubj = pkg.subjects as unknown as { name: string } | null;
      const stCls = student.classes as unknown as { name: string } | null;

      if (student.class_id !== pkg.class_id) {
        return jsonResponse(
          req,
          {
            error: `Siswa kelas ${stCls?.name || ''} tidak terdaftar pada paket ujian untuk kelas ${pkgCls?.name || ''}.`,
          },
          403
        );
      }

      if (!verifySecret(pinSemester.trim(), student.pin_hash)) {
        return jsonResponse(
          req,
          { error: 'PIN Semester tidak cocok. Hubungi guru jika lupa PIN.' },
          401
        );
      }

      const { data: questions } = await supabase
        .from('questions')
        .select('id, options_json')
        .eq('package_id', pkg.id)
        .order('id', { ascending: true });

      if (!questions || questions.length === 0) {
        return jsonResponse(req, { error: 'Paket ujian belum memiliki soal.' }, 400);
      }

      const { data: existingSession } = await supabase
        .from('exam_sessions')
        .select('*')
        .eq('package_id', pkg.id)
        .eq('student_id', student.id)
        .maybeSingle();

      const now = Date.now();

      if (existingSession) {
        if (existingSession.status === 'LOCKED_VIOLATION') {
          return jsonResponse(
            req,
            {
              error:
                'Sesi ujian Anda terkunci karena pelanggaran tata tertib. Minta pengawas membuka kunci sesi Anda.',
              status: 'LOCKED_VIOLATION',
              violationCount: existingSession.violation_count,
            },
            423
          );
        }

        if (existingSession.status === 'SUBMITTED') {
          return jsonResponse(
            req,
            {
              error: 'Anda telah menyelesaikan dan mengumpulkan ujian ini.',
              status: 'SUBMITTED',
              score: existingSession.score,
            },
            409
          );
        }

        if (now >= existingSession.expires_at) {
          const finalized = await gradeAndFinalizeSession(supabase, existingSession.id, pkg.id);
          return jsonResponse(
            req,
            {
              error:
                'Waktu ujian untuk sesi Anda telah habis dan jawaban telah dikumpulkan otomatis.',
              status: 'SUBMITTED',
              score: finalized.score,
            },
            409
          );
        }

        await supabase
          .from('exam_sessions')
          .update({ device_id: deviceId, session_info: sessionInfo })
          .eq('id', existingSession.id);

        await broadcastPackageEvent(supabase, {
          type: 'session:updated',
          packageId: pkg.id,
          studentId: student.id,
          sessionId: existingSession.id,
          payload: { status: 'IN_PROGRESS', resumed: true },
          timestamp: now,
        });

        return jsonResponse(req, {
          sessionToken: existingSession.session_token,
          resumed: true,
          status: existingSession.status,
          remainingSeconds: Math.max(0, Math.floor((existingSession.expires_at - now) / 1000)),
          student: {
            id: student.id,
            nis: student.nis,
            name: student.name,
            className: stCls?.name || '',
          },
          package: {
            id: pkg.id,
            title: pkg.title,
            subjectName: pkgSubj?.name || '',
            className: pkgCls?.name || '',
            durationMinutes: pkg.duration_minutes,
            maxViolationsAllowed: pkg.max_violations + existingSession.unlock_bonus,
          },
        });
      }

      const questionIds = questions.map((q: { id: number }) => q.id);
      const lockedQuestionOrder =
        pkg.shuffle_questions === 1 ? cryptoShuffle(questionIds) : questionIds;

      const lockedOptionOrders: Record<string, string[]> = {};
      for (const q of questions) {
        const opts = JSON.parse(q.options_json) as OptionItem[];
        const keys = opts.map((o) => o.key);
        lockedOptionOrders[String(q.id)] = pkg.shuffle_options === 1 ? cryptoShuffle(keys) : keys;
      }

      const sessionToken = generateSessionToken();
      const startedAt = now;
      const expiresAt = now + pkg.duration_minutes * 60 * 1000;

      const { data: insertedSession } = await supabase
        .from('exam_sessions')
        .insert({
          package_id: pkg.id,
          student_id: student.id,
          session_token: sessionToken,
          device_id: deviceId,
          session_info: sessionInfo,
          status: 'IN_PROGRESS',
          question_order_json: JSON.stringify(lockedQuestionOrder),
          option_orders_json: JSON.stringify(lockedOptionOrders),
          started_at: startedAt,
          expires_at: expiresAt,
          total_questions: questions.length,
        })
        .select('id')
        .single();

      await broadcastPackageEvent(supabase, {
        type: 'session:updated',
        packageId: pkg.id,
        studentId: student.id,
        sessionId: insertedSession?.id,
        payload: { status: 'IN_PROGRESS', started: true },
        timestamp: now,
      });

      return jsonResponse(
        req,
        {
          sessionToken,
          resumed: false,
          status: 'IN_PROGRESS',
          remainingSeconds: Math.floor((expiresAt - now) / 1000),
          student: {
            id: student.id,
            nis: student.nis,
            name: student.name,
            className: stCls?.name || '',
          },
          package: {
            id: pkg.id,
            title: pkg.title,
            subjectName: pkgSubj?.name || '',
            className: pkgCls?.name || '',
            durationMinutes: pkg.duration_minutes,
            maxViolationsAllowed: pkg.max_violations,
          },
        },
        201
      );
    }

    if (method === 'GET' && path === '/exam/session') {
      const clientErr = checkExambroClient(req);
      if (clientErr) return clientErr;
      const sesRes = await requireStudentSession(req, supabase);
      if (sesRes.errorResponse) return sesRes.errorResponse;
      const session = sesRes.session!;

      const [{ data: pkg }, { data: stRow }] = await Promise.all([
        supabase
          .from('exam_packages')
          .select('*, subjects(name), classes(name)')
          .eq('id', session.package_id)
          .single(),
        supabase
          .from('students')
          .select('id, nis, name, classes(name)')
          .eq('id', session.student_id)
          .single(),
      ]);

      const pkgSubj = pkg?.subjects as unknown as { name: string } | null;
      const pkgCls = pkg?.classes as unknown as { name: string } | null;
      const stCls = stRow?.classes as unknown as { name: string } | null;

      const student = {
        id: stRow!.id,
        nis: stRow!.nis,
        name: stRow!.name,
        class_name: stCls?.name || '',
      };

      const maxViolationsAllowed = (pkg?.max_violations || 3) + (session.unlock_bonus || 0);

      if (session.status === 'SUBMITTED') {
        return jsonResponse(req, {
          status: 'SUBMITTED',
          remainingSeconds: 0,
          student,
          package: {
            id: pkg!.id,
            title: pkg!.title,
            subjectName: pkgSubj?.name || '',
            className: pkgCls?.name || '',
            durationMinutes: pkg!.duration_minutes,
            maxViolationsAllowed,
          },
          violationCount: session.violation_count,
          result: {
            score: session.score,
            correctCount: session.correct_count,
            totalQuestions: session.total_questions,
            submittedAt: session.submitted_at,
          },
          questions: [],
          answers: {},
        });
      }

      const questionOrder = JSON.parse(session.question_order_json) as number[];
      const optionOrders = JSON.parse(session.option_orders_json) as Record<string, string[]>;

      // Explicit column selection WITHOUT correct_option!
      const [{ data: rawQuestions }, { data: savedAnswers }] = await Promise.all([
        supabase
          .from('questions')
          .select('id, question_text, question_type, options_json, points')
          .eq('package_id', session.package_id),
        supabase
          .from('student_answers')
          .select('question_id, selected_option')
          .eq('session_id', session.id),
      ]);

      const qMap = new Map(
        (rawQuestions || []).map((q: { id: number }) => [q.id, q])
      );
      const displayLabels = ['A', 'B', 'C', 'D', 'E'];

      const orderedQuestions = questionOrder
        .map((qId, index) => {
          const q = qMap.get(qId) as
            | {
                id: number;
                question_text: string;
                question_type: string;
                options_json: string;
                points: number;
              }
            | undefined;
          if (!q) return null;
          const originalOptions = JSON.parse(q.options_json) as OptionItem[];
          const optMap = new Map(originalOptions.map((o) => [o.key, o.text]));
          const orderForQ = optionOrders[String(q.id)] || originalOptions.map((o) => o.key);

          const mappedOptions = orderForQ
            .filter((origKey) => optMap.has(origKey))
            .map((origKey, optIdx) => ({
              originalKey: origKey,
              displayLabel: displayLabels[optIdx] || origKey,
              text: optMap.get(origKey)!,
            }));

          return {
            id: q.id,
            displayNumber: index + 1,
            questionText: q.question_text,
            questionType: q.question_type,
            points: q.points,
            options: mappedOptions,
          };
        })
        .filter(Boolean);

      const answersObj = Object.fromEntries(
        (savedAnswers || []).map((a: { question_id: number; selected_option: string }) => [
          String(a.question_id),
          a.selected_option,
        ])
      );
      const remainingSeconds = Math.max(0, Math.floor((session.expires_at - Date.now()) / 1000));

      return jsonResponse(req, {
        status: session.status,
        remainingSeconds,
        startedAt: session.started_at,
        expiresAt: session.expires_at,
        violationCount: session.violation_count,
        maxViolationsAllowed,
        student,
        package: {
          id: pkg!.id,
          title: pkg!.title,
          subjectName: pkgSubj?.name || '',
          className: pkgCls?.name || '',
          durationMinutes: pkg!.duration_minutes,
          maxViolationsAllowed,
        },
        questions: orderedQuestions,
        answers: answersObj,
      });
    }

    if (method === 'POST' && path === '/exam/answer') {
      const clientErr = checkExambroClient(req);
      if (clientErr) return clientErr;
      const sesRes = await requireStudentSession(req, supabase);
      if (sesRes.errorResponse) return sesRes.errorResponse;
      const session = sesRes.session!;

      if (session.status === 'LOCKED_VIOLATION') {
        return jsonResponse(
          req,
          {
            error:
              'Sesi terkunci karena pelanggaran. Jawaban tidak dapat disimpan sebelum dibuka guru.',
            status: 'LOCKED_VIOLATION',
          },
          423
        );
      }

      if (session.status === 'SUBMITTED') {
        return jsonResponse(req, { error: 'Ujian telah dikumpulkan.', status: 'SUBMITTED' }, 409);
      }

      const { questionId, selectedOption } = await readJsonBody<{
        questionId?: number;
        selectedOption?: string;
      }>(req);

      if (!questionId || !selectedOption) {
        return jsonResponse(req, { error: 'questionId dan selectedOption wajib dikirim.' }, 400);
      }

      const { data: qExists } = await supabase
        .from('questions')
        .select('id')
        .eq('id', Number(questionId))
        .eq('package_id', session.package_id)
        .maybeSingle();

      if (!qExists) {
        return jsonResponse(req, { error: 'Soal tidak valid untuk paket ujian ini.' }, 404);
      }

      const now = Date.now();
      const normalizedOption = selectedOption.trim().toUpperCase();

      await supabase.from('student_answers').upsert(
        {
          session_id: session.id,
          question_id: Number(questionId),
          selected_option: normalizedOption,
          updated_at: now,
        },
        { onConflict: 'session_id,question_id' }
      );

      const { count: answeredCount } = await supabase
        .from('student_answers')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', session.id);

      await broadcastPackageEvent(supabase, {
        type: 'session:updated',
        packageId: session.package_id,
        studentId: session.student_id,
        sessionId: session.id,
        payload: { answeredCount: answeredCount || 0 },
        timestamp: now,
      });

      return jsonResponse(req, {
        saved: true,
        questionId: Number(questionId),
        selectedOption: normalizedOption,
        answeredCount: answeredCount || 0,
        remainingSeconds: Math.max(0, Math.floor((session.expires_at - now) / 1000)),
      });
    }

    if (method === 'POST' && path === '/exam/violation') {
      const clientErr = checkExambroClient(req);
      if (clientErr) return clientErr;
      const sesRes = await requireStudentSession(req, supabase);
      if (sesRes.errorResponse) return sesRes.errorResponse;
      const session = sesRes.session!;

      if (session.status === 'SUBMITTED') {
        return jsonResponse(req, { error: 'Ujian sudah selesai.' }, 409);
      }

      const {
        violationType = 'FOCUS_LOST',
        detail = 'Aplikasi keluar dari fokus ujian',
      } = await readJsonBody<{ violationType?: string; detail?: string }>(req);

      const [{ data: pkg }, { data: student }] = await Promise.all([
        supabase
          .from('exam_packages')
          .select('max_violations')
          .eq('id', session.package_id)
          .single(),
        supabase.from('students').select('nis, name').eq('id', session.student_id).single(),
      ]);

      const now = Date.now();
      const newViolationCount = session.violation_count + 1;
      const maxAllowed = (pkg?.max_violations || 3) + (session.unlock_bonus || 0);
      const shouldLock = newViolationCount >= maxAllowed;
      const nextStatus = shouldLock ? 'LOCKED_VIOLATION' : session.status;

      await supabase.from('violation_logs').insert({
        session_id: session.id,
        package_id: session.package_id,
        student_id: session.student_id,
        violation_type: violationType.trim(),
        detail: detail.trim(),
        created_at: now,
      });

      await supabase
        .from('exam_sessions')
        .update({ violation_count: newViolationCount, status: nextStatus })
        .eq('id', session.id);

      await broadcastPackageEvent(supabase, {
        type: shouldLock ? 'violation:alert' : 'session:updated',
        packageId: session.package_id,
        studentId: session.student_id,
        sessionId: session.id,
        payload: {
          studentName: student?.name || '',
          nis: student?.nis || '',
          violationType,
          detail,
          violationCount: newViolationCount,
          maxViolationsAllowed: maxAllowed,
          status: nextStatus,
          locked: shouldLock,
        },
        timestamp: now,
      });

      return jsonResponse(req, {
        status: nextStatus,
        violationCount: newViolationCount,
        maxViolationsAllowed: maxAllowed,
        locked: shouldLock,
      });
    }

    if (method === 'POST' && path === '/exam/submit') {
      const clientErr = checkExambroClient(req);
      if (clientErr) return clientErr;
      const sesRes = await requireStudentSession(req, supabase);
      if (sesRes.errorResponse) return sesRes.errorResponse;
      const session = sesRes.session!;

      if (session.status === 'LOCKED_VIOLATION') {
        return jsonResponse(
          req,
          {
            error:
              'Sesi Anda sedang terkunci pelanggaran. Minta guru membuka kunci sebelum melakukan submit.',
            status: 'LOCKED_VIOLATION',
          },
          423
        );
      }

      if (session.status === 'SUBMITTED') {
        return jsonResponse(req, {
          status: 'SUBMITTED',
          score: session.score,
          correctCount: session.correct_count,
          totalQuestions: session.total_questions,
        });
      }

      const result = await gradeAndFinalizeSession(supabase, session.id, session.package_id);

      await broadcastPackageEvent(supabase, {
        type: 'session:updated',
        packageId: session.package_id,
        studentId: session.student_id,
        sessionId: session.id,
        payload: {
          status: 'SUBMITTED',
          score: result.score,
        },
        timestamp: Date.now(),
      });

      return jsonResponse(req, {
        status: 'SUBMITTED',
        ...result,
      });
    }

    return jsonResponse(req, { error: `Endpoint tidak ditemukan: ${method} ${path}` }, 404);
  } catch (err) {
    console.error('Edge Function Error:', err);
    return jsonResponse(req, { error: 'Terjadi kesalahan internal server.' }, 500);
  }
});
