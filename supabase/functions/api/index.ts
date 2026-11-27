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
  email: string;
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
    if (method === 'POST' && path === '/auth/login') {
      const { email, password } = await readJsonBody<{ email?: string; password?: string }>(req);
      if (!email || !password) {
        return jsonResponse(req, { error: 'Email dan kata sandi wajib diisi.' }, 400);
      }

      const { data: teacher, error: teacherErr } = await supabase
        .from('teachers')
        .select('id, name, email, password_hash, role')
        .eq('email', email.trim().toLowerCase())
        .maybeSingle();

      if (teacherErr) {
        return jsonResponse(
          req,
          { error: `Kesalahan koneksi database: ${teacherErr.message}` },
          500
        );
      }

      if (!teacher || !verifySecret(password, teacher.password_hash)) {
        return jsonResponse(req, { error: 'Email atau kata sandi tidak sesuai.' }, 401);
      }

      const masterKey = await getMasterSecret(supabase);
      const token = createTeacherToken(
        {
          teacherId: teacher.id,
          email: teacher.email,
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
          email: teacher.email,
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

    if (method === 'GET' && path === '/teacher/context') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const teacherId = auth.teacher!.teacherId;

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

      const [{ data: subjects }, { data: classes }] = await Promise.all([
        supabase.from('subjects').select('*').order('name', { ascending: true }),
        supabase.from('classes').select('*').order('name', { ascending: true }),
      ]);

      return jsonResponse(req, {
        teacher: auth.teacher,
        assignments,
        subjects: subjects || [],
        classes: classes || [],
      });
    }

    if (method === 'POST' && path === '/teacher/assignments') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
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
        query = query.eq('teacher_id', teacher.teacherId);
      }

      const { data: pkgRows } = await query;
      const pkgs = pkgRows || [];
      if (pkgs.length === 0) {
        return jsonResponse(req, { packages: [] });
      }

      const pkgIds = pkgs.map((p: { id: number }) => p.id);
      const classIds = [...new Set(pkgs.map((p: { class_id: number }) => p.class_id))];

      const [{ data: qRows }, { data: stRows }, { data: sesRows }] = await Promise.all([
        supabase.from('questions').select('package_id').in('package_id', pkgIds),
        supabase.from('students').select('class_id').in('class_id', classIds),
        supabase.from('exam_sessions').select('package_id, status').in('package_id', pkgIds),
      ]);

      const packages = pkgs.map((ep: Record<string, unknown>) => {
        const subj = ep.subjects as { name: string; code: string } | null;
        const cls = ep.classes as { name: string } | null;
        const pkgId = ep.id as number;
        const classId = ep.class_id as number;

        const qCount = (qRows || []).filter((q: { package_id: number }) => q.package_id === pkgId).length;
        const stCount = (stRows || []).filter((s: { class_id: number }) => s.class_id === classId).length;
        const pkgSessions = (sesRows || []).filter((s: { package_id: number }) => s.package_id === pkgId);

        const { subjects: _s, classes: _c, ...rest } = ep;
        return {
          ...rest,
          subject_name: subj?.name || '',
          subject_code: subj?.code || '',
          class_name: cls?.name || '',
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

      const {
        title,
        subjectId,
        classId,
        className,
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
        className?: string;
        durationMinutes?: number;
        maxViolations?: number;
        shuffleQuestions?: boolean;
        shuffleOptions?: boolean;
        isActive?: boolean;
        initialToken?: string;
        cloneFromPackageId?: number;
      }>(req);

      if (!title?.trim() || !subjectId || (!classId && !className?.trim())) {
        return jsonResponse(req, { error: 'Judul paket, mata pelajaran, dan kelas wajib diisi.' }, 400);
      }

      let resolvedClassId = classId ? Number(classId) : 0;
      if (!resolvedClassId && className?.trim()) {
        const cleanClassName = className.replace(/^kelas\s+/i, '').trim().toUpperCase();
        const { data: foundClass } = await supabase
          .from('classes')
          .select('id')
          .ilike('name', cleanClassName)
          .maybeSingle();

        if (foundClass) {
          resolvedClassId = foundClass.id;
        } else {
          const matchGrade = cleanClassName.match(/^(\d+)/);
          const gradeLevel = matchGrade ? Number(matchGrade[1]) : 8;
          const { data: createdCls } = await supabase
            .from('classes')
            .insert({ name: cleanClassName, grade_level: gradeLevel })
            .select('id')
            .single();
          resolvedClassId = createdCls!.id;
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

      const token = cleanedInitialToken || generateExamToken();
      const { data: insertedPkg, error: insertErr } = await supabase
        .from('exam_packages')
        .insert({
          teacher_id: teacherId,
          subject_id: Number(subjectId),
          class_id: resolvedClassId,
          title: title.trim(),
          duration_minutes: Math.max(5, Math.min(300, Number(durationMinutes) || 60)),
          is_active: isActive ? 1 : 0,
          max_violations: Math.max(1, Math.min(20, Number(maxViolations) || 3)),
          shuffle_questions: shuffleQuestions ? 1 : 0,
          shuffle_options: shuffleOptions ? 1 : 0,
          current_token: token,
        })
        .select('id')
        .single();

      if (insertErr || !insertedPkg) {
        return jsonResponse(req, { error: 'Gagal membuat paket ujian baru.' }, 500);
      }

      const newPackageId = insertedPkg.id;

      if (cloneFromPackageId) {
        const { data: sourceQuestions } = await supabase
          .from('questions')
          .select('question_text, question_type, options_json, correct_option, points')
          .eq('package_id', Number(cloneFromPackageId));

        if (sourceQuestions && sourceQuestions.length > 0) {
          await supabase.from('questions').insert(
            sourceQuestions.map(
              (q: {
                question_text: string;
                question_type: string;
                options_json: string;
                correct_option: string;
                points: number;
              }) => ({
                subject_id: Number(subjectId),
                package_id: newPackageId,
                question_text: q.question_text,
                question_type: q.question_type,
                options_json: q.options_json,
                correct_option: q.correct_option,
                points: q.points,
              })
            )
          );
        }
      }

      const { data: created } = await supabase
        .from('exam_packages')
        .select('*, subjects(name, code), classes(name)')
        .eq('id', newPackageId)
        .single();

      const subj = created?.subjects as { name: string; code: string } | null;
      const cls = created?.classes as { name: string } | null;
      const { subjects: _s, classes: _c, ...rest } = (created || {}) as Record<string, unknown>;

      return jsonResponse(
        req,
        {
          package: {
            ...rest,
            subject_name: subj?.name || '',
            subject_code: subj?.code || '',
            class_name: cls?.name || '',
          },
        },
        201
      );
    }

    const pkgMatch = path.match(/^\/packages\/(\d+)$/);
    if (pkgMatch) {
      const pkgId = Number(pkgMatch[1]);
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;

      if (method === 'PUT') {
        const {
          title,
          classId,
          durationMinutes,
          maxViolations,
          shuffleQuestions,
          shuffleOptions,
          isActive,
        } = await readJsonBody<{
          title?: string;
          classId?: number;
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

        await supabase
          .from('exam_packages')
          .update({
            title: title?.trim() || existing.title,
            class_id: classId ? Number(classId) : existing.class_id,
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

        return jsonResponse(req, { success: true });
      }

      if (method === 'DELETE') {
        const { data: deleted } = await supabase
          .from('exam_packages')
          .delete()
          .eq('id', pkgId)
          .select('id');

        if (!deleted || deleted.length === 0) {
          return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
        }
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
        .select('id, is_active')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
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
        .select('id, current_token')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
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
        'https://proforkoc.github.io/exambro/';

      const studentExamUrl = `${portalBaseUrl}#/exam?token=${encodeURIComponent(pkg.current_token)}`;
      const exambroDeepLink = `examflow://join?payload=${encodeURIComponent(encryptedPayload)}`;
      const qrDataUrl = await generateQrDataUrl(studentExamUrl);

      return jsonResponse(req, {
        packageId: pkg.id,
        title: pkg.title,
        className: cls?.name || '',
        subjectName: subj?.name || '',
        isActive: pkg.is_active === 1,
        currentToken: pkg.current_token,
        studentExamUrl,
        encryptedPayload,
        exambroDeepLink,
        qrDataUrl,
      });
    }

    // 3. QUESTION BANK CRUD
    const pkgQuestionsMatch = path.match(/^\/packages\/(\d+)\/questions$/);
    if (pkgQuestionsMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgQuestionsMatch[1]);

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
        const { data: pkg } = await supabase
          .from('exam_packages')
          .select('id, subject_id')
          .eq('id', pkgId)
          .maybeSingle();

        if (!pkg) {
          return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
        }

        const { questionText, options, correctOption, points = 20 } = await readJsonBody<{
          questionText?: string;
          options?: OptionItem[];
          correctOption?: string;
          points?: number;
        }>(req);

        if (!questionText?.trim() || !Array.isArray(options) || options.length < 2 || !correctOption) {
          return jsonResponse(
            req,
            { error: 'Teks soal, minimal 2 pilihan jawaban, dan kunci jawaban wajib diisi.' },
            400
          );
        }

        const { data: insertedQ, error } = await supabase
          .from('questions')
          .insert({
            subject_id: pkg.subject_id,
            package_id: pkgId,
            question_text: questionText.trim(),
            question_type: 'MULTIPLE_CHOICE',
            options_json: JSON.stringify(options),
            correct_option: correctOption.trim().toUpperCase(),
            points: Math.max(1, Number(points) || 10),
          })
          .select('id')
          .single();

        if (error || !insertedQ) {
          return jsonResponse(req, { error: 'Gagal menyimpan soal.' }, 500);
        }

        return jsonResponse(req, { id: insertedQ.id }, 201);
      }
    }

    const pkgImportQMatch = path.match(/^\/packages\/(\d+)\/questions\/import$/);
    if (method === 'POST' && pkgImportQMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgImportQMatch[1]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, subject_id')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

      const { rawText, replaceExisting = false } = await readJsonBody<{
        rawText?: string;
        replaceExisting?: boolean;
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

      if (replaceExisting) {
        await supabase.from('questions').delete().eq('package_id', pkgId);
      }

      if (toInsert.length > 0) {
        await supabase.from('questions').insert(toInsert);
      }

      return jsonResponse(req, {
        summary: {
          totalRows,
          createdCount: toInsert.length,
          errorCount: errors.length,
        },
        errors,
      });
    }

    const qMatch = path.match(/^\/questions\/(\d+)$/);
    if (qMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const qId = Number(qMatch[1]);

      if (method === 'PUT') {
        const { questionText, options, correctOption, points } = await readJsonBody<{
          questionText?: string;
          options?: OptionItem[];
          correctOption?: string;
          points?: number;
        }>(req);

        const { data: existing } = await supabase
          .from('questions')
          .select('*')
          .eq('id', qId)
          .maybeSingle();

        if (!existing) {
          return jsonResponse(req, { error: 'Soal tidak ditemukan.' }, 404);
        }

        await supabase
          .from('questions')
          .update({
            question_text: questionText?.trim() || existing.question_text,
            options_json: Array.isArray(options)
              ? JSON.stringify(options)
              : existing.options_json,
            correct_option: correctOption
              ? correctOption.trim().toUpperCase()
              : existing.correct_option,
            points: points ? Math.max(1, Number(points)) : existing.points,
          })
          .eq('id', qId);

        return jsonResponse(req, { success: true });
      }

      if (method === 'DELETE') {
        const { data: deleted } = await supabase
          .from('questions')
          .delete()
          .eq('id', qId)
          .select('id');

        if (!deleted || deleted.length === 0) {
          return jsonResponse(req, { error: 'Soal tidak ditemukan.' }, 404);
        }
        return jsonResponse(req, { success: true });
      }
    }

    // 4. STUDENTS & SEMESTER PIN MANAGEMENT
    if (method === 'GET' && path === '/students') {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;

      const classIdParam = url.searchParams.get('classId');
      const classId = classIdParam ? Number(classIdParam) : null;

      let query = supabase
        .from('students')
        .select('id, nis, name, class_id, pin_hash, pin_encrypted, pin_updated_at, classes(name)');

      if (classId) {
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

        const { data: existingStudent } = await supabase
          .from('students')
          .select('id, nis, name, pin_hash, pin_encrypted')
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
            score: es?.score ?? null,
            correctCount: es?.correct_count ?? null,
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

      const { data: session } = await supabase
        .from('exam_sessions')
        .select('*')
        .eq('id', sessionId)
        .maybeSingle();

      if (!session) {
        return jsonResponse(req, { error: 'Sesi ujian siswa tidak ditemukan.' }, 404);
      }

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

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('max_violations')
        .eq('id', session.package_id)
        .single();

      const maxViolationsAllowed = (pkg?.max_violations || 3) + newBonus;

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

    const pkgRecapMatch = path.match(/^\/packages\/(\d+)\/recap(\/csv)?$/);
    if (method === 'GET' && pkgRecapMatch) {
      const auth = await requireTeacherAuth(req, supabase);
      if (auth.errorResponse) return auth.errorResponse;
      const pkgId = Number(pkgRecapMatch[1]);
      const isCsv = Boolean(pkgRecapMatch[2]);

      const { data: pkg } = await supabase
        .from('exam_packages')
        .select('id, title, class_id, subjects(name), classes(name)')
        .eq('id', pkgId)
        .maybeSingle();

      if (!pkg) {
        return jsonResponse(req, { error: 'Paket ujian tidak ditemukan.' }, 404);
      }

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
          nis: st.nis as string,
          name: st.name as string,
          class_name: cls?.name || '',
          status: es?.status || 'NOT_STARTED',
          correct_count: es?.correct_count ?? null,
          total_questions: es?.total_questions ?? totalQuestions,
          score: es?.score ?? null,
          violation_count: es?.violation_count ?? 0,
          submitted_at: es?.submitted_at ?? null,
        };
      });

      if (isCsv) {
        const header = [
          'NIS',
          'Nama Siswa',
          'Kelas',
          'Benar',
          'Total Soal',
          'Nilai Akhir',
          'Status',
          'Jumlah Pelanggaran',
        ];
        const lines = [header.join(',')];
        for (const r of records) {
          lines.push(
            [
              escapeCsvField(r.nis),
              escapeCsvField(r.name),
              escapeCsvField(r.class_name),
              escapeCsvField(r.correct_count ?? 0),
              escapeCsvField(r.total_questions),
              escapeCsvField(r.score ?? 0),
              escapeCsvField(r.status),
              escapeCsvField(r.violation_count),
            ].join(',')
          );
        }
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

      const subj = pkg.subjects as unknown as { name: string } | null;
      const cls = pkg.classes as unknown as { name: string } | null;

      return jsonResponse(req, {
        package: {
          id: pkg.id,
          title: pkg.title,
          subjectName: subj?.name || '',
          className: cls?.name || '',
          totalQuestions,
        },
        records,
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
