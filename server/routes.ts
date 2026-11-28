import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import QRCode from 'qrcode';
import { db, getPinKeyMaterial } from './db.ts';
import {
  requireTeacherAuth,
  requireExambroClient,
  verifySecret,
  hashSecret,
  encryptTextWithKey,
  decryptTextWithKey,
  createTeacherToken,
  encryptQrPayload,
  decryptQrPayload,
  generateExamToken,
  generateSemesterPin,
  generateSessionToken,
  constantTimeEqualText,
  type AuthenticatedTeacherRequest,
} from './security.ts';
import { broadcastPackageEvent } from './realtime.ts';

interface OptionItem {
  key: string;
  text: string;
}

interface QuestionRow {
  id: number;
  subject_id: number;
  package_id: number;
  question_text: string;
  question_type: string;
  options_json: string;
  correct_option: string;
  points: number;
}

interface PackageRow {
  id: number;
  teacher_id: number;
  proctor_id: number | null;
  subject_id: number;
  class_id: number;
  title: string;
  exam_date: string;
  kkm: number;
  schedule_group: string;
  duration_minutes: number;
  is_active: number;
  max_violations: number;
  shuffle_questions: number;
  shuffle_options: number;
  current_token: string;
  token_rotated_at: string;
  created_at: string;
  subject_name?: string;
  subject_code?: string;
  class_name?: string;
  teacher_name?: string;
  proctor_name?: string | null;
}

type PackageAccessRole = 'ADMIN' | 'OWNER' | 'PROCTOR' | 'NONE';

function getPackageAccess(
  pkg: { teacher_id: number; proctor_id: number | null },
  teacher: { teacherId: number; role: 'ADMIN' | 'TEACHER' }
): PackageAccessRole {
  if (teacher.role === 'ADMIN') return 'ADMIN';
  if (pkg.teacher_id === teacher.teacherId) return 'OWNER';
  if (pkg.proctor_id !== null && Number(pkg.proctor_id) === teacher.teacherId) return 'PROCTOR';
  return 'NONE';
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

function cryptoShuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function gradeAndFinalizeSession(sessionId: number, packageId: number): {
  score: number;
  correctCount: number;
  totalQuestions: number;
} {
  const questions = db
    .prepare('SELECT id, correct_option, points FROM questions WHERE package_id = ?')
    .all(packageId) as Array<{ id: number; correct_option: string; points: number }>;

  const answers = db
    .prepare('SELECT question_id, selected_option FROM student_answers WHERE session_id = ?')
    .all(sessionId) as Array<{ question_id: number; selected_option: string }>;

  const answerMap = new Map(answers.map((a) => [a.question_id, a.selected_option]));

  let totalPoints = 0;
  let earnedPoints = 0;
  let correctCount = 0;

  for (const q of questions) {
    totalPoints += q.points;
    if (answerMap.get(q.id) === q.correct_option) {
      earnedPoints += q.points;
      correctCount += 1;
    }
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 100 : 0;
  const totalQuestions = questions.length;
  const now = Date.now();

  db.prepare(`
    UPDATE exam_sessions
    SET status = 'SUBMITTED', submitted_at = COALESCE(submitted_at, ?), score = ?, correct_count = ?, total_questions = ?
    WHERE id = ?
  `).run(now, score, correctCount, totalQuestions, sessionId);

  return { score, correctCount, totalQuestions };
}

interface StudentSessionRequest extends Request {
  examSession?: SessionRow;
}

function requireStudentSession(req: StudentSessionRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token sesi ujian (session_token) diperlukan.' });
    return;
  }
  const sessionToken = authHeader.slice(7).trim();
  const session = db
    .prepare('SELECT * FROM exam_sessions WHERE session_token = ?')
    .get(sessionToken) as SessionRow | undefined;

  if (!session) {
    res.status(401).json({ error: 'Session token tidak valid atau tidak ditemukan.' });
    return;
  }

  // Auto-finalize if time expired while in progress
  if (session.status === 'IN_PROGRESS' && Date.now() >= session.expires_at) {
    gradeAndFinalizeSession(session.id, session.package_id);
    const refreshed = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(session.id) as SessionRow;
    req.examSession = refreshed;
    broadcastPackageEvent({
      type: 'session:updated',
      packageId: refreshed.package_id,
      studentId: refreshed.student_id,
      sessionId: refreshed.id,
      payload: { status: 'SUBMITTED', reason: 'TIME_EXPIRED' },
      timestamp: Date.now(),
    });
    next();
    return;
  }

  req.examSession = session;
  next();
}

function escapeCsvField(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeStudentPortalBaseUrl(rawBaseUrl?: string): string | null {
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

export function createApiRouter(): express.Router {
  const router = express.Router();

  router.get('/health', (_req: Request, res: Response) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.json({ status: 'ok', service: 'ExamFlow Pro', database: 'sqlite', timestamp: Date.now() });
    } catch {
      res.status(503).json({ status: 'error', service: 'ExamFlow Pro' });
    }
  });

  // ==========================
  // 1. TEACHER AUTH & CONTEXT
  // ==========================
  function normalizeTeacherNip(raw?: string): string {
    return (raw || '').trim().toLowerCase();
  }

  function isValidTeacherNip(nip: string): boolean {
    return nip.length >= 2 && nip.length <= 64 && /^[a-z0-9._-]+$/i.test(nip);
  }

  router.post('/auth/login', (req: Request, res: Response) => {
    const { nip, email, password } = req.body as { nip?: string; email?: string; password?: string };
    const cleanNip = normalizeTeacherNip(nip ?? email);
    if (!cleanNip || !password) {
      res.status(400).json({ error: 'NIP / ID Login dan kata sandi wajib diisi.' });
      return;
    }

    const teacher = db
      .prepare('SELECT id, name, nip, password_hash, role FROM teachers WHERE LOWER(nip) = ?')
      .get(cleanNip) as
      | { id: number; name: string; nip: string; password_hash: string; role: 'TEACHER' | 'ADMIN' }
      | undefined;

    if (!teacher || !verifySecret(password, teacher.password_hash)) {
      res.status(401).json({ error: 'NIP / ID Login atau kata sandi tidak sesuai.' });
      return;
    }

    const token = createTeacherToken({
      teacherId: teacher.id,
      nip: teacher.nip,
      name: teacher.name,
      role: teacher.role,
    });

    res.json({
      token,
      teacher: {
        id: teacher.id,
        name: teacher.name,
        nip: teacher.nip,
        role: teacher.role,
      },
    });
  });

  router.post('/auth/change-password', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacherId = req.teacher!.teacherId;
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
      res.status(400).json({ error: 'Kata sandi saat ini dan kata sandi baru wajib diisi.' });
      return;
    }

    if (newPassword.length < 6 || newPassword.length > 128) {
      res.status(400).json({ error: 'Kata sandi baru harus terdiri dari 6–128 karakter.' });
      return;
    }

    if (newPassword === currentPassword) {
      res.status(400).json({ error: 'Kata sandi baru harus berbeda dari kata sandi saat ini.' });
      return;
    }

    const teacher = db
      .prepare('SELECT id, password_hash FROM teachers WHERE id = ?')
      .get(teacherId) as { id: number; password_hash: string } | undefined;

    if (!teacher || !verifySecret(currentPassword, teacher.password_hash)) {
      res.status(401).json({ error: 'Kata sandi saat ini tidak sesuai.' });
      return;
    }

    const nextHash = hashSecret(newPassword);
    db.prepare('UPDATE teachers SET password_hash = ? WHERE id = ?').run(nextHash, teacherId);

    res.json({ success: true, message: 'Kata sandi berhasil diperbarui.' });
  });

  function getTeacherAssignmentScope(teacherId: number): {
    pairs: Set<string>;
    subjectIds: number[];
    classIds: number[];
  } {
    const rows = db
      .prepare('SELECT subject_id, class_id FROM teacher_assignments WHERE teacher_id = ?')
      .all(teacherId) as Array<{ subject_id: number; class_id: number }>;
    const pairs = new Set<string>();
    const subjectSet = new Set<number>();
    const classSet = new Set<number>();
    for (const r of rows) {
      pairs.add(`${r.subject_id}:${r.class_id}`);
      subjectSet.add(r.subject_id);
      classSet.add(r.class_id);
    }
    return {
      pairs,
      subjectIds: Array.from(subjectSet),
      classIds: Array.from(classSet),
    };
  }

  router.get('/teacher/context', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacher = req.teacher!;
    const teacherId = teacher.teacherId;
    const isAdmin = teacher.role === 'ADMIN';
    const assignments = db
      .prepare(`
        SELECT ta.id, ta.subject_id, ta.class_id,
               s.code AS subject_code, s.name AS subject_name,
               c.name AS class_name, c.grade_level
        FROM teacher_assignments ta
        JOIN subjects s ON s.id = ta.subject_id
        JOIN classes c ON c.id = ta.class_id
        WHERE ta.teacher_id = ?
        ORDER BY s.name ASC, c.name ASC
      `)
      .all(teacherId) as Array<{
      id: number;
      subject_id: number;
      class_id: number;
      subject_code: string;
      subject_name: string;
      class_name: string;
      grade_level: number;
    }>;

    const assignedSubjectIds = Array.from(new Set(assignments.map((a) => a.subject_id)));
    const assignedClassIds = Array.from(new Set(assignments.map((a) => a.class_id)));

    const subjects = isAdmin
      ? db.prepare('SELECT * FROM subjects ORDER BY name ASC').all()
      : assignedSubjectIds.length > 0
        ? db
            .prepare(`SELECT * FROM subjects WHERE id IN (${assignedSubjectIds.map(() => '?').join(',')}) ORDER BY name ASC`)
            .all(...assignedSubjectIds)
        : [];

    const classes = isAdmin
      ? db.prepare('SELECT * FROM classes ORDER BY grade_level ASC, name ASC').all()
      : assignedClassIds.length > 0
        ? db
            .prepare(
              `SELECT * FROM classes WHERE id IN (${assignedClassIds.map(() => '?').join(',')}) ORDER BY grade_level ASC, name ASC`
            )
            .all(...assignedClassIds)
        : [];

    const proctorTeachers = isAdmin
      ? db.prepare('SELECT id, name, nip, role FROM teachers ORDER BY name ASC').all()
      : [];

    res.json({
      teacher,
      assignments,
      subjects,
      classes,
      teachers: proctorTeachers,
    });
  });

  router.post('/teacher/assignments', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const teacherId = req.teacher!.teacherId;
    const { subjectId, classId } = req.body as { subjectId?: number; classId?: number };
    if (!subjectId || !classId) {
      res.status(400).json({ error: 'subjectId dan classId wajib dipilih.' });
      return;
    }

    try {
      const info = db
        .prepare('INSERT INTO teacher_assignments (teacher_id, subject_id, class_id) VALUES (?, ?, ?)')
        .run(teacherId, Number(subjectId), Number(classId));
      res.status(201).json({ id: Number(info.lastInsertRowid), subjectId: Number(subjectId), classId: Number(classId) });
    } catch {
      res.status(409).json({ error: 'Penugasan mata pelajaran & kelas tersebut sudah terdaftar.' });
    }
  });

  // ==========================
  // 1B. ADMIN: TEACHERS & SUBJECTS MANAGEMENT
  // ==========================
  function generateTeacherPassword(length = 8): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += chars[crypto.randomInt(0, chars.length)];
    }
    return out;
  }

  function requireAdminRole(req: AuthenticatedTeacherRequest, res: Response): boolean {
    if (req.teacher?.role !== 'ADMIN') {
      res.status(403).json({ error: 'Akses ditolak. Fitur ini khusus Admin Sekolah.' });
      return false;
    }
    return true;
  }

  router.get('/subjects', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacher = req.teacher!;
    if (teacher.role !== 'ADMIN') {
      const scope = getTeacherAssignmentScope(teacher.teacherId);
      if (scope.subjectIds.length === 0) {
        res.json({ subjects: [] });
        return;
      }
      const rows = db
        .prepare(`
          SELECT s.id, s.code, s.name, s.description,
                 (SELECT COUNT(*) FROM exam_packages ep WHERE ep.subject_id = s.id AND ep.teacher_id = ?) AS package_count,
                 (SELECT COUNT(*) FROM questions q JOIN exam_packages ep2 ON ep2.id = q.package_id WHERE q.subject_id = s.id AND ep2.teacher_id = ?) AS question_count
          FROM subjects s
          WHERE s.id IN (${scope.subjectIds.map(() => '?').join(',')})
          ORDER BY s.name ASC
        `)
        .all(teacher.teacherId, teacher.teacherId, ...scope.subjectIds);
      res.json({ subjects: rows });
      return;
    }

    const rows = db
      .prepare(`
        SELECT s.id, s.code, s.name, s.description,
               (SELECT COUNT(*) FROM exam_packages ep WHERE ep.subject_id = s.id) AS package_count,
               (SELECT COUNT(*) FROM questions q WHERE q.subject_id = s.id) AS question_count
        FROM subjects s
        ORDER BY s.name ASC
      `)
      .all();
    res.json({ subjects: rows });
  });

  router.post('/subjects', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const { code, name, description = '' } = req.body as {
      code?: string;
      name?: string;
      description?: string;
    };

    const cleanCode = (code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const cleanName = (name || '').trim();
    if (!cleanCode || cleanCode.length < 2 || cleanCode.length > 16 || !cleanName) {
      res.status(400).json({ error: 'Kode mapel (2–16 huruf/angka) dan nama mata pelajaran wajib diisi.' });
      return;
    }

    try {
      const info = db
        .prepare('INSERT INTO subjects (code, name, description) VALUES (?, ?, ?)')
        .run(cleanCode, cleanName, description.trim());
      const created = db.prepare('SELECT * FROM subjects WHERE id = ?').get(Number(info.lastInsertRowid));
      res.status(201).json({ subject: created });
    } catch {
      res.status(409).json({ error: `Kode mata pelajaran "${cleanCode}" sudah terdaftar.` });
    }
  });

  router.put('/subjects/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const subjectId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId) as
      | { id: number; code: string; name: string; description: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
      return;
    }

    const { code, name, description } = req.body as {
      code?: string;
      name?: string;
      description?: string;
    };
    const nextCode =
      code !== undefined ? code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') : existing.code;
    const nextName = name !== undefined ? name.trim() : existing.name;
    const nextDesc = description !== undefined ? description.trim() : existing.description;

    if (!nextCode || nextCode.length < 2 || nextCode.length > 16 || !nextName) {
      res.status(400).json({ error: 'Kode mapel (2–16 huruf/angka) dan nama mata pelajaran wajib diisi.' });
      return;
    }

    try {
      db.prepare('UPDATE subjects SET code = ?, name = ?, description = ? WHERE id = ?').run(
        nextCode,
        nextName,
        nextDesc,
        subjectId
      );
      const updated = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
      res.json({ subject: updated });
    } catch {
      res.status(409).json({ error: `Kode mata pelajaran "${nextCode}" sudah digunakan mapel lain.` });
    }
  });

  router.delete('/subjects/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const subjectId = Number(req.params.id);
    const usedPackages = (
      db.prepare('SELECT COUNT(*) AS cnt FROM exam_packages WHERE subject_id = ?').get(subjectId) as { cnt: number }
    ).cnt;

    if (usedPackages > 0) {
      res.status(409).json({
        error: `Mata pelajaran tidak dapat dihapus karena masih digunakan oleh ${usedPackages} paket ujian.`,
      });
      return;
    }

    const info = db.prepare('DELETE FROM subjects WHERE id = ?').run(subjectId);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
      return;
    }
    res.json({ success: true });
  });

  // ==========================
  // 1C. MASTER CLASSES MANAGEMENT (ADMIN CRUD)
  // ==========================
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

  router.get('/classes', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacher = req.teacher!;
    if (teacher.role !== 'ADMIN') {
      const scope = getTeacherAssignmentScope(teacher.teacherId);
      if (scope.classIds.length === 0) {
        res.json({ classes: [] });
        return;
      }
      const rows = db
        .prepare(`
          SELECT c.id, c.name, c.grade_level,
                 (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id) AS student_count,
                 (SELECT COUNT(*) FROM exam_packages ep WHERE ep.class_id = c.id AND (ep.teacher_id = ? OR ep.proctor_id = ?)) AS package_count
          FROM classes c
          WHERE c.id IN (${scope.classIds.map(() => '?').join(',')})
          ORDER BY c.grade_level ASC, c.name ASC
        `)
        .all(teacher.teacherId, teacher.teacherId, ...scope.classIds);
      res.json({ classes: rows });
      return;
    }

    const rows = db
      .prepare(`
        SELECT c.id, c.name, c.grade_level,
               (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id) AS student_count,
               (SELECT COUNT(*) FROM exam_packages ep WHERE ep.class_id = c.id) AS package_count
        FROM classes c
        ORDER BY c.grade_level ASC, c.name ASC
      `)
      .all();
    res.json({ classes: rows });
  });

  router.post('/classes', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const { name, gradeLevel } = req.body as { name?: string; gradeLevel?: number };
    const { cleanName, resolvedGrade } = normalizeClassInput(name, gradeLevel);

    if (!cleanName || cleanName.length > 24) {
      res.status(400).json({ error: 'Nama kelas wajib diisi (maks. 24 karakter, misal: 7A, 8B, 10 IPA 1).' });
      return;
    }

    try {
      const info = db
        .prepare('INSERT INTO classes (name, grade_level) VALUES (?, ?)')
        .run(cleanName, resolvedGrade);
      const created = db
        .prepare('SELECT id, name, grade_level, 0 AS student_count, 0 AS package_count FROM classes WHERE id = ?')
        .get(Number(info.lastInsertRowid));
      res.status(201).json({ class: created });
    } catch {
      res.status(409).json({ error: `Kelas "${cleanName}" sudah terdaftar.` });
    }
  });

  router.put('/classes/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const classId = Number(req.params.id);
    const existing = db.prepare('SELECT id, name, grade_level FROM classes WHERE id = ?').get(classId) as
      | { id: number; name: string; grade_level: number }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Kelas tidak ditemukan.' });
      return;
    }

    const { name, gradeLevel } = req.body as { name?: string; gradeLevel?: number };
    const { cleanName, resolvedGrade } = normalizeClassInput(
      name !== undefined ? name : existing.name,
      gradeLevel !== undefined ? gradeLevel : existing.grade_level
    );

    if (!cleanName || cleanName.length > 24) {
      res.status(400).json({ error: 'Nama kelas wajib diisi (maks. 24 karakter).' });
      return;
    }

    try {
      db.prepare('UPDATE classes SET name = ?, grade_level = ? WHERE id = ?').run(
        cleanName,
        resolvedGrade,
        classId
      );
      const updated = db
        .prepare(`
          SELECT c.id, c.name, c.grade_level,
                 (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id) AS student_count,
                 (SELECT COUNT(*) FROM exam_packages ep WHERE ep.class_id = c.id) AS package_count
          FROM classes c
          WHERE c.id = ?
        `)
        .get(classId);
      res.json({ class: updated });
    } catch {
      res.status(409).json({ error: `Nama kelas "${cleanName}" sudah digunakan kelas lain.` });
    }
  });

  router.delete('/classes/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const classId = Number(req.params.id);

    const existing = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
    if (!existing) {
      res.status(404).json({ error: 'Kelas tidak ditemukan.' });
      return;
    }

    const usedStudents = (
      db.prepare('SELECT COUNT(*) AS cnt FROM students WHERE class_id = ?').get(classId) as { cnt: number }
    ).cnt;
    const usedPackages = (
      db.prepare('SELECT COUNT(*) AS cnt FROM exam_packages WHERE class_id = ?').get(classId) as { cnt: number }
    ).cnt;

    if (usedStudents > 0 || usedPackages > 0) {
      res.status(409).json({
        error: `Kelas tidak dapat dihapus karena masih memiliki ${usedStudents} siswa dan ${usedPackages} paket ujian.`,
      });
      return;
    }

    db.prepare('DELETE FROM classes WHERE id = ?').run(classId);
    res.json({ success: true });
  });

  router.get('/admin/teachers', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const teachers = db
      .prepare(`
        SELECT t.id, t.name, t.nip, t.role, t.created_at,
               (SELECT COUNT(*) FROM exam_packages ep WHERE ep.teacher_id = t.id) AS package_count
        FROM teachers t
        ORDER BY CASE t.role WHEN 'ADMIN' THEN 0 ELSE 1 END, t.name ASC
      `)
      .all() as Array<{
      id: number;
      name: string;
      nip: string;
      role: 'TEACHER' | 'ADMIN';
      created_at: string;
      package_count: number;
    }>;

    const allAssignments = db
      .prepare(`
        SELECT ta.id, ta.teacher_id, ta.subject_id, ta.class_id,
               s.code AS subject_code, s.name AS subject_name,
               c.name AS class_name, c.grade_level
        FROM teacher_assignments ta
        JOIN subjects s ON s.id = ta.subject_id
        JOIN classes c ON c.id = ta.class_id
        ORDER BY s.name ASC, c.name ASC
      `)
      .all() as Array<{
      id: number;
      teacher_id: number;
      subject_id: number;
      class_id: number;
      subject_code: string;
      subject_name: string;
      class_name: string;
      grade_level: number;
    }>;

    const result = teachers.map((t) => ({
      ...t,
      assignments: allAssignments.filter((a) => a.teacher_id === t.id),
    }));

    res.json({ teachers: result });
  });

  router.post('/admin/teachers', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const { name, nip, email, password, role = 'TEACHER' } = req.body as {
      name?: string;
      nip?: string;
      email?: string;
      password?: string;
      role?: 'TEACHER' | 'ADMIN';
    };

    const cleanName = (name || '').trim();
    const cleanNip = normalizeTeacherNip(nip ?? email);
    const cleanRole = role === 'ADMIN' ? 'ADMIN' : 'TEACHER';

    if (!cleanName || !isValidTeacherNip(cleanNip)) {
      res.status(400).json({
        error: 'Nama lengkap dan NIP / ID Login (2–64 karakter huruf/angka/._- tanpa spasi) wajib diisi.',
      });
      return;
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      res.status(400).json({ error: 'Kata sandi awal harus terdiri dari 6–128 karakter.' });
      return;
    }

    try {
      const info = db
        .prepare('INSERT INTO teachers (name, nip, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(cleanName, cleanNip, hashSecret(password), cleanRole);

      const created = db
        .prepare('SELECT id, name, nip, role, created_at FROM teachers WHERE id = ?')
        .get(Number(info.lastInsertRowid));
      res.status(201).json({ teacher: created });
    } catch {
      res.status(409).json({ error: `NIP / ID Login "${cleanNip}" sudah terdaftar.` });
    }
  });

  router.put('/admin/teachers/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const targetId = Number(req.params.id);
    const existing = db
      .prepare('SELECT id, name, nip, role, password_hash FROM teachers WHERE id = ?')
      .get(targetId) as
      | { id: number; name: string; nip: string; role: 'TEACHER' | 'ADMIN'; password_hash: string }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Akun guru tidak ditemukan.' });
      return;
    }

    const { name, nip, email, role, newPassword } = req.body as {
      name?: string;
      nip?: string;
      email?: string;
      role?: 'TEACHER' | 'ADMIN';
      newPassword?: string;
    };

    const rawNip = nip !== undefined ? nip : email;
    const nextName = name !== undefined ? name.trim() : existing.name;
    const nextNip = rawNip !== undefined ? normalizeTeacherNip(rawNip) : existing.nip;
    const nextRole = role === 'ADMIN' || role === 'TEACHER' ? role : existing.role;

    if (!nextName || !isValidTeacherNip(nextNip)) {
      res.status(400).json({
        error: 'Nama lengkap dan NIP / ID Login (2–64 karakter huruf/angka/._- tanpa spasi) wajib diisi.',
      });
      return;
    }

    if (existing.role === 'ADMIN' && nextRole !== 'ADMIN') {
      const adminCount = (
        db.prepare(`SELECT COUNT(*) AS cnt FROM teachers WHERE role = 'ADMIN'`).get() as { cnt: number }
      ).cnt;
      if (adminCount <= 1) {
        res.status(400).json({ error: 'Tidak dapat menurunkan peran Admin terakhir di sistem.' });
        return;
      }
    }

    let nextHash = existing.password_hash;
    if (typeof newPassword === 'string' && newPassword.length > 0) {
      if (newPassword.length < 6 || newPassword.length > 128) {
        res.status(400).json({ error: 'Kata sandi baru harus terdiri dari 6–128 karakter.' });
        return;
      }
      nextHash = hashSecret(newPassword);
    }

    try {
      db.prepare('UPDATE teachers SET name = ?, nip = ?, role = ?, password_hash = ? WHERE id = ?').run(
        nextName,
        nextNip,
        nextRole,
        nextHash,
        targetId
      );
      const updated = db
        .prepare('SELECT id, name, nip, role, created_at FROM teachers WHERE id = ?')
        .get(targetId);
      res.json({ teacher: updated });
    } catch {
      res.status(409).json({ error: `NIP / ID Login "${nextNip}" sudah digunakan akun lain.` });
    }
  });

  router.post(
    '/admin/teachers/:id/reset-password',
    requireTeacherAuth,
    (req: AuthenticatedTeacherRequest, res: Response) => {
      if (!requireAdminRole(req, res)) return;
      const targetId = Number(req.params.id);
      const teacher = db
        .prepare('SELECT id, name, nip FROM teachers WHERE id = ?')
        .get(targetId) as { id: number; name: string; nip: string } | undefined;

      if (!teacher) {
        res.status(404).json({ error: 'Akun guru tidak ditemukan.' });
        return;
      }

      const { customPassword } = (req.body || {}) as { customPassword?: string };
      const trimmed = (customPassword || '').trim();
      if (trimmed && (trimmed.length < 6 || trimmed.length > 128)) {
        res.status(400).json({ error: 'Kata sandi khusus harus terdiri dari 6–128 karakter.' });
        return;
      }

      const newPassword = trimmed || generateTeacherPassword(8);
      db.prepare('UPDATE teachers SET password_hash = ? WHERE id = ?').run(hashSecret(newPassword), targetId);

      res.json({
        teacherId: teacher.id,
        name: teacher.name,
        nip: teacher.nip,
        newPassword,
      });
    }
  );

  router.delete('/admin/teachers/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const targetId = Number(req.params.id);

    if (targetId === req.teacher!.teacherId) {
      res.status(400).json({ error: 'Anda tidak dapat menghapus akun yang sedang digunakan login.' });
      return;
    }

    const target = db.prepare('SELECT id, role FROM teachers WHERE id = ?').get(targetId) as
      | { id: number; role: string }
      | undefined;
    if (!target) {
      res.status(404).json({ error: 'Akun guru tidak ditemukan.' });
      return;
    }

    if (target.role === 'ADMIN') {
      const adminCount = (
        db.prepare(`SELECT COUNT(*) AS cnt FROM teachers WHERE role = 'ADMIN'`).get() as { cnt: number }
      ).cnt;
      if (adminCount <= 1) {
        res.status(400).json({ error: 'Tidak dapat menghapus satu-satunya akun Admin.' });
        return;
      }
    }

    db.prepare('DELETE FROM teachers WHERE id = ?').run(targetId);
    res.json({ success: true });
  });

  router.post(
    '/admin/teachers/:id/assignments',
    requireTeacherAuth,
    (req: AuthenticatedTeacherRequest, res: Response) => {
      if (!requireAdminRole(req, res)) return;
      const targetId = Number(req.params.id);
      const { subjectId, classId } = req.body as { subjectId?: number; classId?: number };
      if (!subjectId || !classId) {
        res.status(400).json({ error: 'Mata pelajaran dan kelas wajib dipilih.' });
        return;
      }

      try {
        const info = db
          .prepare('INSERT INTO teacher_assignments (teacher_id, subject_id, class_id) VALUES (?, ?, ?)')
          .run(targetId, Number(subjectId), Number(classId));
        res.status(201).json({ id: Number(info.lastInsertRowid) });
      } catch {
        res.status(409).json({ error: 'Penugasan mata pelajaran & kelas tersebut sudah terdaftar untuk guru ini.' });
      }
    }
  );

  router.delete(
    '/admin/assignments/:id',
    requireTeacherAuth,
    (req: AuthenticatedTeacherRequest, res: Response) => {
      if (!requireAdminRole(req, res)) return;
      const assignmentId = Number(req.params.id);
      const info = db.prepare('DELETE FROM teacher_assignments WHERE id = ?').run(assignmentId);
      if (info.changes === 0) {
        res.status(404).json({ error: 'Penugasan tidak ditemukan.' });
        return;
      }
      res.json({ success: true });
    }
  );

  router.post(
    '/admin/teachers/import',
    requireTeacherAuth,
    (req: AuthenticatedTeacherRequest, res: Response) => {
      if (!requireAdminRole(req, res)) return;
      const { rawText, updateExisting = false } = req.body as {
        rawText?: string;
        updateExisting?: boolean;
      };

      if (!rawText || !rawText.trim()) {
        res.status(400).json({ error: 'Data teks atau file CSV guru tidak boleh kosong.' });
        return;
      }

      const lines = rawText
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length === 0) {
        res.status(400).json({ error: 'Tidak ada baris data guru yang ditemukan.' });
        return;
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

      const importedCredentials: Array<{
        name: string;
        nip: string;
        role: 'TEACHER' | 'ADMIN';
        password: string;
        action: 'CREATED' | 'UPDATED';
      }> = [];
      const skipped: Array<{ lineNumber: number; nip: string; name: string; reason: string }> = [];
      const errors: Array<{ lineNumber: number; raw: string; reason: string }> = [];

      const findStmt = db.prepare('SELECT id, name, nip, role FROM teachers WHERE LOWER(nip) = ?');
      const insertStmt = db.prepare(
        'INSERT INTO teachers (name, nip, password_hash, role) VALUES (?, ?, ?, ?)'
      );
      const updateInfoStmt = db.prepare('UPDATE teachers SET name = ?, role = ? WHERE id = ?');
      const updateWithPassStmt = db.prepare(
        'UPDATE teachers SET name = ?, role = ?, password_hash = ? WHERE id = ?'
      );

      const runImport = db.transaction(() => {
        let processedDataRows = 0;

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

          processedDataRows++;

          if (cols.length < 2) {
            errors.push({
              lineNumber,
              raw: line,
              reason: 'Minimal harus memiliki 2 kolom (Nama Lengkap, NIP / ID Login).',
            });
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
            errors.push({
              lineNumber,
              raw: line,
              reason: 'Kolom Role harus berupa TEACHER (atau GURU) atau ADMIN.',
            });
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

          const existing = findStmt.get(nip) as
            | { id: number; name: string; nip: string; role: 'TEACHER' | 'ADMIN' }
            | undefined;

          if (existing && !updateExisting) {
            skipped.push({
              lineNumber,
              nip,
              name,
              reason: 'NIP / ID Login sudah terdaftar (lewati duplikat).',
            });
            continue;
          }

          if (existing && updateExisting) {
            if (existing.role === 'ADMIN' && role !== 'ADMIN') {
              const adminCount = (
                db.prepare(`SELECT COUNT(*) AS cnt FROM teachers WHERE role = 'ADMIN'`).get() as { cnt: number }
              ).cnt;
              if (adminCount <= 1) {
                errors.push({
                  lineNumber,
                  raw: line,
                  reason: 'Tidak dapat menurunkan peran Admin terakhir di sistem.',
                });
                continue;
              }
            }

            if (rawPass) {
              updateWithPassStmt.run(name, role, hashSecret(rawPass), existing.id);
              importedCredentials.push({ name, nip, role, password: rawPass, action: 'UPDATED' });
            } else {
              updateInfoStmt.run(name, role, existing.id);
              importedCredentials.push({
                name,
                nip,
                role,
                password: 'Tetap (Tersimpan)',
                action: 'UPDATED',
              });
            }
          } else {
            const plainPass = rawPass || generateTeacherPassword(8);
            insertStmt.run(name, nip, hashSecret(plainPass), role);
            importedCredentials.push({ name, nip, role, password: plainPass, action: 'CREATED' });
          }
        }

        return processedDataRows;
      });

      const totalRows = runImport();
      const createdCount = importedCredentials.filter((c) => c.action === 'CREATED').length;
      const updatedCount = importedCredentials.filter((c) => c.action === 'UPDATED').length;

      res.json({
        summary: {
          totalRows,
          createdCount,
          updatedCount,
          skippedCount: skipped.length,
          errorCount: errors.length,
        },
        importedCredentials,
        skipped,
        errors,
      });
    }
  );

  // ==========================
  // 2. EXAM PACKAGES & TOKEN ROTATION & QR
  // ==========================
  router.get('/packages', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacher = req.teacher!;
    const rows = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, s.code AS subject_code, c.name AS class_name,
               t_owner.name AS teacher_name,
               t_proctor.name AS proctor_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS question_count,
               (SELECT COUNT(*) FROM students st WHERE st.class_id = ep.class_id) AS class_student_count,
               (SELECT COUNT(*) FROM exam_sessions es WHERE es.package_id = ep.id AND es.status = 'IN_PROGRESS') AS active_count,
               (SELECT COUNT(*) FROM exam_sessions es WHERE es.package_id = ep.id AND es.status = 'LOCKED_VIOLATION') AS locked_count,
               (SELECT COUNT(*) FROM exam_sessions es WHERE es.package_id = ep.id AND es.status = 'SUBMITTED') AS submitted_count
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        JOIN teachers t_owner ON t_owner.id = ep.teacher_id
        LEFT JOIN teachers t_proctor ON t_proctor.id = ep.proctor_id
        WHERE (? = 'ADMIN' OR ep.teacher_id = ? OR ep.proctor_id = ?)
        ORDER BY ep.is_active DESC, ep.id DESC
      `)
      .all(teacher.role, teacher.teacherId, teacher.teacherId) as PackageRow[];

    const packages = rows.map((row) => ({
      ...row,
      access_role: getPackageAccess(row, teacher),
    }));

    res.json({ packages });
  });

  router.post('/packages', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacherId = req.teacher!.teacherId;
    const isAdmin = req.teacher!.role === 'ADMIN';
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
    } = req.body as {
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
    };

    const hasClassIds = Array.isArray(classIds) && classIds.filter((id) => Number(id) > 0).length > 0;
    if (!title?.trim() || !subjectId || (!hasClassIds && !classId && !className?.trim())) {
      res.status(400).json({ error: 'Judul paket, mata pelajaran, dan minimal satu kelas wajib diisi.' });
      return;
    }

    const hasNonAdminProctorAttempt =
      !isAdmin &&
      ((proctorId !== undefined && proctorId !== null) ||
        (proctorsByClass && Object.values(proctorsByClass).some((v) => v !== null && v !== undefined)));
    if (hasNonAdminProctorAttempt) {
      res.status(403).json({ error: 'Hanya Admin Sekolah yang dapat menentukan Guru Pengawas.' });
      return;
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
      const foundClass = db
        .prepare('SELECT id FROM classes WHERE LOWER(name) = LOWER(?)')
        .get(cleanClassName) as { id: number } | undefined;
      if (foundClass) {
        targetClassIds.push(foundClass.id);
      } else if (!isAdmin) {
        res.status(403).json({
          error: `Akses ditolak. Kelas "${cleanClassName}" tidak ditemukan atau bukan bagian dari penugasan mengajar Anda.`,
        });
        return;
      } else {
        const matchGrade = cleanClassName.match(/^(\d+)/);
        const gradeLevel = matchGrade ? Number(matchGrade[1]) : 8;
        const clsRes = db.prepare('INSERT INTO classes (name, grade_level) VALUES (?, ?)').run(cleanClassName, gradeLevel);
        targetClassIds.push(Number(clsRes.lastInsertRowid));
      }
    }

    if (targetClassIds.length === 0) {
      res.status(400).json({ error: 'Kelas target tidak valid.' });
      return;
    }

    if (!isAdmin) {
      const scope = getTeacherAssignmentScope(teacherId);
      const unauthorizedClass = targetClassIds.find((cid) => !scope.pairs.has(`${Number(subjectId)}:${cid}`));
      if (unauthorizedClass !== undefined) {
        res.status(403).json({
          error: 'Akses ditolak. Anda hanya dapat membuat paket ujian sesuai penugasan mata pelajaran dan kelas Anda.',
        });
        return;
      }
    }

    const cleanedInitialToken = initialToken?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleanedInitialToken && (cleanedInitialToken.length < 4 || cleanedInitialToken.length > 12)) {
      res.status(400).json({ error: 'Token ujian awal harus terdiri dari 4–12 karakter huruf/angka.' });
      return;
    }

    let sourceQuestions: Array<{
      question_text: string;
      question_type: string;
      options_json: string;
      correct_option: string;
      points: number;
    }> = [];

    if (cloneFromPackageId) {
      const sourcePkg = db.prepare('SELECT id, teacher_id, proctor_id FROM exam_packages WHERE id = ?').get(Number(cloneFromPackageId)) as
        | { id: number; teacher_id: number; proctor_id: number | null }
        | undefined;
      if (!sourcePkg) {
        res.status(404).json({ error: 'Paket sumber salinan soal tidak ditemukan.' });
        return;
      }
      const sourceAccess = getPackageAccess(sourcePkg, req.teacher!);
      if (sourceAccess !== 'ADMIN' && sourceAccess !== 'OWNER') {
        res.status(403).json({ error: 'Anda tidak memiliki akses menyalin soal dari paket tersebut.' });
        return;
      }
      sourceQuestions = db
        .prepare('SELECT question_text, question_type, options_json, correct_option, points FROM questions WHERE package_id = ?')
        .all(Number(cloneFromPackageId)) as typeof sourceQuestions;
    }

    const scheduleGroup = targetClassIds.length > 1 ? `grp-${crypto.randomBytes(6).toString('hex')}` : '';
    const cleanExamDate = (examDate || '').trim();
    const cleanKkm = Math.max(0, Math.min(100, Math.round(Number(kkm) || 75)));
    const cleanDuration = Math.max(5, Math.min(300, Number(durationMinutes) || 60));
    const cleanMaxViolations = Math.max(1, Math.min(20, Number(maxViolations) || 3));
    const baseTitle = title.trim();

    const classRows = db
      .prepare(`SELECT id, name FROM classes WHERE id IN (${targetClassIds.map(() => '?').join(',')})`)
      .all(...targetClassIds) as Array<{ id: number; name: string }>;
    const classNameMap = new Map(classRows.map((c) => [c.id, c.name]));

    const insertPkgStmt = db.prepare(`
      INSERT INTO exam_packages (teacher_id, proctor_id, subject_id, class_id, title, exam_date, kkm, schedule_group, duration_minutes, is_active, max_violations, shuffle_questions, shuffle_options, current_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertQStmt = db.prepare(`
      INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const createdIds: number[] = [];
    const runCreate = db.transaction(() => {
      targetClassIds.forEach((cid, idx) => {
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

        const info = insertPkgStmt.run(
          teacherId,
          resolvedProctorId,
          Number(subjectId),
          cid,
          resolvedTitle,
          cleanExamDate,
          cleanKkm,
          scheduleGroup,
          cleanDuration,
          isActive ? 1 : 0,
          cleanMaxViolations,
          shuffleQuestions ? 1 : 0,
          shuffleOptions ? 1 : 0,
          token
        );
        const newPackageId = Number(info.lastInsertRowid);
        createdIds.push(newPackageId);

        for (const q of sourceQuestions) {
          insertQStmt.run(
            Number(subjectId),
            newPackageId,
            q.question_text,
            q.question_type,
            q.options_json,
            q.correct_option,
            q.points
          );
        }
      });
    });

    runCreate();

    const createdPackages = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, s.code AS subject_code, c.name AS class_name,
               t_owner.name AS teacher_name, t_proctor.name AS proctor_name
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        JOIN teachers t_owner ON t_owner.id = ep.teacher_id
        LEFT JOIN teachers t_proctor ON t_proctor.id = ep.proctor_id
        WHERE ep.id IN (${createdIds.map(() => '?').join(',')})
        ORDER BY ep.id ASC
      `)
      .all(...createdIds) as PackageRow[];

    const enriched = createdPackages.map((row) => ({
      ...row,
      access_role: getPackageAccess(row, req.teacher!),
    }));

    res.status(201).json({ package: enriched[0], packages: enriched });
  });

  router.put('/packages/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
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
    } = req.body as {
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
    };

    const existing = db.prepare('SELECT * FROM exam_packages WHERE id = ?').get(pkgId) as PackageRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(existing, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Anda tidak memiliki akses untuk mengubah paket ujian ini.' });
      return;
    }

    if (proctorId !== undefined && req.teacher!.role !== 'ADMIN') {
      res.status(403).json({ error: 'Hanya Admin Sekolah yang dapat menentukan Guru Pengawas.' });
      return;
    }

    let nextProctorId = existing.proctor_id;
    if (proctorId !== undefined && req.teacher!.role === 'ADMIN') {
      if (proctorId === null || Number(proctorId) === 0) {
        nextProctorId = null;
      } else {
        const foundProctor = db.prepare('SELECT id FROM teachers WHERE id = ?').get(Number(proctorId)) as
          | { id: number }
          | undefined;
        if (!foundProctor) {
          res.status(400).json({ error: 'Akun Guru Pengawas tidak ditemukan.' });
          return;
        }
        nextProctorId = foundProctor.id;
      }
    }

    const nextSubjectId = subjectId ? Number(subjectId) : existing.subject_id;
    const nextClassId = classId ? Number(classId) : existing.class_id;
    if (req.teacher!.role !== 'ADMIN') {
      const scope = getTeacherAssignmentScope(req.teacher!.teacherId);
      if (!scope.pairs.has(`${nextSubjectId}:${nextClassId}`)) {
        res.status(403).json({
          error: 'Akses ditolak. Mata pelajaran dan kelas paket ujian harus sesuai penugasan Anda.',
        });
        return;
      }
    }
    const nextExamDate = examDate !== undefined ? examDate.trim() : existing.exam_date;
    const nextKkm = kkm !== undefined ? Math.max(0, Math.min(100, Math.round(Number(kkm)))) : existing.kkm;

    db.prepare(`
      UPDATE exam_packages
      SET title = ?,
          subject_id = ?,
          class_id = ?,
          proctor_id = ?,
          exam_date = ?,
          kkm = ?,
          duration_minutes = ?,
          max_violations = ?,
          shuffle_questions = ?,
          shuffle_options = ?,
          is_active = ?
      WHERE id = ?
    `).run(
      title?.trim() || existing.title,
      nextSubjectId,
      nextClassId,
      nextProctorId,
      nextExamDate,
      nextKkm,
      durationMinutes ? Math.max(5, Math.min(300, Number(durationMinutes))) : existing.duration_minutes,
      maxViolations ? Math.max(1, Math.min(20, Number(maxViolations))) : existing.max_violations,
      typeof shuffleQuestions === 'boolean' ? (shuffleQuestions ? 1 : 0) : existing.shuffle_questions,
      typeof shuffleOptions === 'boolean' ? (shuffleOptions ? 1 : 0) : existing.shuffle_options,
      typeof isActive === 'boolean' ? (isActive ? 1 : 0) : existing.is_active,
      pkgId
    );

    if (nextSubjectId !== existing.subject_id) {
      db.prepare('UPDATE questions SET subject_id = ? WHERE package_id = ?').run(nextSubjectId, pkgId);
    }

    res.json({ success: true });
  });

  router.delete('/packages/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const existing = db.prepare('SELECT id, teacher_id, proctor_id FROM exam_packages WHERE id = ?').get(pkgId) as
      | { id: number; teacher_id: number; proctor_id: number | null }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }
    const access = getPackageAccess(existing, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Anda tidak memiliki akses untuk menghapus paket ujian ini.' });
      return;
    }
    db.prepare('DELETE FROM exam_packages WHERE id = ?').run(pkgId);
    res.json({ success: true });
  });

  router.post('/packages/:id/toggle-active', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db.prepare('SELECT * FROM exam_packages WHERE id = ?').get(pkgId) as PackageRow | undefined;
    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Hanya Admin atau Guru Mapel pembuat paket yang dapat mengaktifkan/menonaktifkan ujian.' });
      return;
    }

    const nextActive = pkg.is_active ? 0 : 1;
    db.prepare('UPDATE exam_packages SET is_active = ? WHERE id = ?').run(nextActive, pkgId);

    broadcastPackageEvent({
      type: 'package:status_changed',
      packageId: pkgId,
      payload: { isActive: nextActive === 1 },
      timestamp: Date.now(),
    });

    res.json({ packageId: pkgId, isActive: nextActive === 1 });
  });

  router.post('/packages/:id/rotate-token', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db.prepare('SELECT * FROM exam_packages WHERE id = ?').get(pkgId) as PackageRow | undefined;
    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Hanya Admin atau Guru Mapel pembuat paket yang dapat merotasi token.' });
      return;
    }

    let nextToken = generateExamToken();
    while (nextToken === pkg.current_token) {
      nextToken = generateExamToken();
    }

    db.prepare(`UPDATE exam_packages SET current_token = ?, token_rotated_at = datetime('now') WHERE id = ?`).run(
      nextToken,
      pkgId
    );

    const updated = db.prepare('SELECT current_token, token_rotated_at FROM exam_packages WHERE id = ?').get(pkgId) as {
      current_token: string;
      token_rotated_at: string;
    };

    broadcastPackageEvent({
      type: 'package:token_rotated',
      packageId: pkgId,
      payload: { rotatedAt: updated.token_rotated_at },
      timestamp: Date.now(),
    });

    res.json({
      packageId: pkgId,
      currentToken: updated.current_token,
      tokenRotatedAt: updated.token_rotated_at,
    });
  });

  router.get('/packages/:id/qr', requireTeacherAuth, async (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, s.code AS subject_code, c.name AS class_name,
               t_owner.name AS teacher_name, t_proctor.name AS proctor_name
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        JOIN teachers t_owner ON t_owner.id = ep.teacher_id
        LEFT JOIN teachers t_proctor ON t_proctor.id = ep.proctor_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as PackageRow | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access === 'NONE') {
      res.status(403).json({ error: 'Anda tidak memiliki akses melihat QR paket ujian ini.' });
      return;
    }

    // Encrypted & signed payload still generated for Exambro APK compatibility
    const encryptedPayload = encryptQrPayload({
      packageId: pkg.id,
      classId: pkg.class_id,
      subjectCode: pkg.subject_code || 'MAPEL',
      title: pkg.title,
    });

    const requestedBase = typeof req.query.baseUrl === 'string' ? req.query.baseUrl : undefined;
    const originHeader = typeof req.headers.origin === 'string' ? `${req.headers.origin}/` : undefined;
    const portalBaseUrl =
      normalizeStudentPortalBaseUrl(requestedBase) ||
      normalizeStudentPortalBaseUrl(originHeader) ||
      'https://examboweb.pages.dev/';

    const studentExamUrl = `${portalBaseUrl}#/exam?token=${encodeURIComponent(pkg.current_token)}`;
    const exambroDeepLink = `examflow://join?payload=${encodeURIComponent(encryptedPayload)}`;
    const qrDataUrl = await QRCode.toDataURL(studentExamUrl, {
      width: 320,
      margin: 2,
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
    });

    res.json({
      packageId: pkg.id,
      title: pkg.title,
      className: pkg.class_name,
      subjectName: pkg.subject_name,
      teacherName: pkg.teacher_name,
      proctorName: pkg.proctor_name,
      examDate: pkg.exam_date,
      isActive: pkg.is_active === 1,
      currentToken: pkg.current_token,
      studentExamUrl,
      encryptedPayload,
      exambroDeepLink,
      qrDataUrl,
    });
  });

  // ==========================
  // 3. QUESTION BANK CRUD (OWNER / ADMIN ONLY — PROCTOR DENIED)
  // ==========================
  function getEligibleSyncSiblings(pkgId: number, scheduleGroup: string): Array<{ id: number; subject_id: number }> {
    if (!scheduleGroup) return [];
    return db
      .prepare(`
        SELECT ep.id, ep.subject_id
        FROM exam_packages ep
        WHERE ep.schedule_group = ?
          AND ep.id != ?
          AND NOT EXISTS (SELECT 1 FROM exam_sessions es WHERE es.package_id = ep.id)
      `)
      .all(scheduleGroup, pkgId) as Array<{ id: number; subject_id: number }>;
  }

  router.get('/packages/:id/questions', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db.prepare('SELECT id, teacher_id, proctor_id FROM exam_packages WHERE id = ?').get(pkgId) as
      | { id: number; teacher_id: number; proctor_id: number | null }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Akses ditolak. Guru Pengawas tidak diperkenankan membuka atau mengubah Bank Soal.' });
      return;
    }

    const questions = db
      .prepare('SELECT * FROM questions WHERE package_id = ? ORDER BY id ASC')
      .all(pkgId) as QuestionRow[];

    res.json({
      questions: questions.map((q) => ({
        ...q,
        options: JSON.parse(q.options_json) as OptionItem[],
      })),
    });
  });

  router.post('/packages/:id/questions', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db.prepare('SELECT id, subject_id, teacher_id, proctor_id, schedule_group FROM exam_packages WHERE id = ?').get(pkgId) as
      | { id: number; subject_id: number; teacher_id: number; proctor_id: number | null; schedule_group: string }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Akses ditolak. Guru Pengawas tidak diperkenankan menambah soal.' });
      return;
    }

    const { questionText, options, correctOption, points = 20, syncSiblings = true } = req.body as {
      questionText?: string;
      options?: OptionItem[];
      correctOption?: string;
      points?: number;
      syncSiblings?: boolean;
    };

    if (!questionText?.trim() || !Array.isArray(options) || options.length < 2 || !correctOption) {
      res.status(400).json({ error: 'Teks soal, minimal 2 pilihan jawaban, dan kunci jawaban wajib diisi.' });
      return;
    }

    const cleanQText = questionText.trim();
    const optionsJson = JSON.stringify(options);
    const cleanCorrect = correctOption.trim().toUpperCase();
    const cleanPoints = Math.max(1, Number(points) || 10);

    const insertQStmt = db.prepare(`
      INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
      VALUES (?, ?, ?, 'MULTIPLE_CHOICE', ?, ?, ?)
    `);

    const info = insertQStmt.run(pkg.subject_id, pkgId, cleanQText, optionsJson, cleanCorrect, cleanPoints);

    let syncedPackageCount = 0;
    if (syncSiblings && pkg.schedule_group) {
      const siblings = getEligibleSyncSiblings(pkgId, pkg.schedule_group);
      for (const sib of siblings) {
        insertQStmt.run(sib.subject_id, sib.id, cleanQText, optionsJson, cleanCorrect, cleanPoints);
        syncedPackageCount++;
      }
    }

    res.status(201).json({ id: Number(info.lastInsertRowid), syncedPackageCount });
  });

  router.post('/packages/:id/questions/import', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db.prepare('SELECT id, subject_id, teacher_id, proctor_id, schedule_group FROM exam_packages WHERE id = ?').get(pkgId) as
      | { id: number; subject_id: number; teacher_id: number; proctor_id: number | null; schedule_group: string }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Akses ditolak. Guru Pengawas tidak diperkenankan mengimpor soal.' });
      return;
    }

    const { rawText, replaceExisting = false, syncSiblings = true } = req.body as {
      rawText?: string;
      replaceExisting?: boolean;
      syncSiblings?: boolean;
    };

    if (!rawText || !rawText.trim()) {
      res.status(400).json({ error: 'Data teks atau file CSV soal tidak boleh kosong.' });
      return;
    }

    const lines = rawText
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      res.status(400).json({ error: 'Tidak ada baris soal yang ditemukan.' });
      return;
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

    const errors: Array<{ lineNumber: number; raw: string; reason: string }> = [];
    const parsedRows: Array<{
      questionText: string;
      optionsJson: string;
      correctOption: string;
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
          reason: 'Minimal harus memiliki 6 kolom (Pertanyaan, Opsi A, Opsi B, Opsi C, Opsi D, Kunci Jawaban).',
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

      parsedRows.push({
        questionText: qText,
        optionsJson: JSON.stringify(options),
        correctOption: correctKey,
        points,
      });
    }

    const deleteOldStmt = db.prepare('DELETE FROM questions WHERE package_id = ?');
    const insertQStmt = db.prepare(`
      INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
      VALUES (?, ?, ?, 'MULTIPLE_CHOICE', ?, ?, ?)
    `);

    const eligibleSiblings = syncSiblings && pkg.schedule_group ? getEligibleSyncSiblings(pkgId, pkg.schedule_group) : [];

    const runImport = db.transaction(() => {
      if (replaceExisting) {
        deleteOldStmt.run(pkgId);
        for (const sib of eligibleSiblings) {
          deleteOldStmt.run(sib.id);
        }
      }

      for (const row of parsedRows) {
        insertQStmt.run(pkg.subject_id, pkgId, row.questionText, row.optionsJson, row.correctOption, row.points);
        for (const sib of eligibleSiblings) {
          insertQStmt.run(sib.subject_id, sib.id, row.questionText, row.optionsJson, row.correctOption, row.points);
        }
      }
    });

    runImport();

    res.json({
      summary: {
        totalRows,
        createdCount: parsedRows.length,
        errorCount: errors.length,
        syncedPackageCount: eligibleSiblings.length,
      },
      errors,
    });
  });

  router.put('/questions/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const qId = Number(req.params.id);
    const { questionText, options, correctOption, points, syncSiblings = true } = req.body as {
      questionText?: string;
      options?: OptionItem[];
      correctOption?: string;
      points?: number;
      syncSiblings?: boolean;
    };

    const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(qId) as QuestionRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Soal tidak ditemukan.' });
      return;
    }

    const pkg = db.prepare('SELECT id, teacher_id, proctor_id, schedule_group FROM exam_packages WHERE id = ?').get(existing.package_id) as
      | { id: number; teacher_id: number; proctor_id: number | null; schedule_group: string }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Akses ditolak. Guru Pengawas tidak diperkenankan mengubah soal.' });
      return;
    }

    const nextText = questionText?.trim() || existing.question_text;
    const nextOpts = Array.isArray(options) ? JSON.stringify(options) : existing.options_json;
    const nextCorrect = correctOption ? correctOption.trim().toUpperCase() : existing.correct_option;
    const nextPoints = points ? Math.max(1, Number(points)) : existing.points;

    db.prepare(`
      UPDATE questions
      SET question_text = ?, options_json = ?, correct_option = ?, points = ?
      WHERE id = ?
    `).run(nextText, nextOpts, nextCorrect, nextPoints, qId);

    if (syncSiblings && pkg.schedule_group) {
      const siblings = getEligibleSyncSiblings(pkg.id, pkg.schedule_group);
      const updateSibStmt = db.prepare(`
        UPDATE questions
        SET question_text = ?, options_json = ?, correct_option = ?, points = ?
        WHERE package_id = ? AND question_text = ?
      `);
      for (const sib of siblings) {
        updateSibStmt.run(nextText, nextOpts, nextCorrect, nextPoints, sib.id, existing.question_text);
      }
    }

    res.json({ success: true });
  });

  router.delete('/questions/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const qId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(qId) as QuestionRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Soal tidak ditemukan.' });
      return;
    }

    const pkg = db.prepare('SELECT id, teacher_id, proctor_id, schedule_group FROM exam_packages WHERE id = ?').get(existing.package_id) as
      | { id: number; teacher_id: number; proctor_id: number | null; schedule_group: string }
      | undefined;

    if (pkg) {
      const access = getPackageAccess(pkg, req.teacher!);
      if (access !== 'ADMIN' && access !== 'OWNER') {
        res.status(403).json({ error: 'Akses ditolak. Guru Pengawas tidak diperkenankan menghapus soal.' });
        return;
      }
    }

    const info = db.prepare('DELETE FROM questions WHERE id = ?').run(qId);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Soal tidak ditemukan.' });
      return;
    }

    if (pkg?.schedule_group) {
      const siblings = getEligibleSyncSiblings(pkg.id, pkg.schedule_group);
      const delSibStmt = db.prepare('DELETE FROM questions WHERE package_id = ? AND question_text = ?');
      for (const sib of siblings) {
        delSibStmt.run(sib.id, existing.question_text);
      }
    }

    res.json({ success: true });
  });

  // ==========================
  // 4. STUDENTS & SEMESTER PIN MANAGEMENT
  // ==========================
  router.get('/students', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacher = req.teacher!;
    const isAdmin = teacher.role === 'ADMIN';
    const classId = req.query.classId ? Number(req.query.classId) : null;

    let rows: Array<{
      id: number;
      nis: string;
      name: string;
      class_id: number;
      pin_encrypted: string;
      pin_updated_at: string;
      class_name: string;
    }>;

    if (!isAdmin) {
      const scope = getTeacherAssignmentScope(teacher.teacherId);
      if (scope.classIds.length === 0) {
        res.json({ students: [] });
        return;
      }
      if (classId !== null && Number.isFinite(classId)) {
        if (!scope.classIds.includes(classId)) {
          res.status(403).json({
            error: 'Akses ditolak. Anda hanya dapat melihat data siswa pada kelas penugasan Anda.',
          });
          return;
        }
        rows = db
          .prepare(`
            SELECT st.id, st.nis, st.name, st.class_id, st.pin_encrypted, st.pin_updated_at, c.name AS class_name
            FROM students st
            JOIN classes c ON c.id = st.class_id
            WHERE st.class_id = ?
            ORDER BY c.name ASC, st.nis ASC
          `)
          .all(classId) as typeof rows;
      } else {
        rows = db
          .prepare(`
            SELECT st.id, st.nis, st.name, st.class_id, st.pin_encrypted, st.pin_updated_at, c.name AS class_name
            FROM students st
            JOIN classes c ON c.id = st.class_id
            WHERE st.class_id IN (${scope.classIds.map(() => '?').join(',')})
            ORDER BY c.name ASC, st.nis ASC
          `)
          .all(...scope.classIds) as typeof rows;
      }
    } else {
      rows = db
        .prepare(`
          SELECT st.id, st.nis, st.name, st.class_id, st.pin_encrypted, st.pin_updated_at, c.name AS class_name
          FROM students st
          JOIN classes c ON c.id = st.class_id
          WHERE (? IS NULL OR st.class_id = ?)
          ORDER BY c.name ASC, st.nis ASC
        `)
        .all(classId, classId) as typeof rows;
    }

    const keyMaterial = getPinKeyMaterial();
    const students = rows.map((row) => ({
      id: row.id,
      nis: row.nis,
      name: row.name,
      class_id: row.class_id,
      class_name: row.class_name,
      pin_updated_at: row.pin_updated_at,
      semester_pin: row.pin_encrypted ? decryptTextWithKey(row.pin_encrypted, keyMaterial) : null,
    }));

    res.json({ students });
  });

  router.post('/students', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const isAdmin = req.teacher!.role === 'ADMIN';
    const { nis, name, classId, customPin } = req.body as {
      nis?: string;
      name?: string;
      classId?: number;
      customPin?: string;
    };

    if (!nis?.trim() || !name?.trim() || !classId) {
      res.status(400).json({ error: 'NIS, nama siswa, dan kelas wajib diisi.' });
      return;
    }

    if (!isAdmin) {
      const scope = getTeacherAssignmentScope(req.teacher!.teacherId);
      if (!scope.classIds.includes(Number(classId))) {
        res.status(403).json({
          error: 'Akses ditolak. Anda hanya dapat menambahkan siswa ke kelas penugasan Anda.',
        });
        return;
      }
    }

    const trimmedCustomPin = customPin?.trim() || '';
    if (trimmedCustomPin && !isAdmin) {
      res.status(403).json({
        error: 'Akses ditolak. Guru hanya dapat menambahkan siswa (NIS, Nama, Kelas); PIN awal dibuat otomatis oleh sistem.',
      });
      return;
    }

    if (trimmedCustomPin && !/^\d{4,6}$/.test(trimmedCustomPin)) {
      res.status(400).json({ error: 'PIN Semester khusus harus terdiri dari 4–6 digit angka.' });
      return;
    }

    const rawPin = isAdmin && trimmedCustomPin ? trimmedCustomPin : generateSemesterPin();
    const pinHash = hashSecret(rawPin);
    const pinEncrypted = encryptTextWithKey(rawPin, getPinKeyMaterial());

    try {
      const info = db
        .prepare('INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES (?, ?, ?, ?, ?)')
        .run(nis.trim(), name.trim(), Number(classId), pinHash, pinEncrypted);

      res.status(201).json({
        student: {
          id: Number(info.lastInsertRowid),
          nis: nis.trim(),
          name: name.trim(),
          classId: Number(classId),
          semester_pin: rawPin,
        },
        generatedPin: rawPin,
      });
    } catch {
      res.status(409).json({ error: 'NIS siswa sudah terdaftar.' });
    }
  });

  router.put('/students/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const studentId = Number(req.params.id);
    const existing = db.prepare('SELECT id, class_id FROM students WHERE id = ?').get(studentId) as
      | { id: number; class_id: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Siswa tidak ditemukan.' });
      return;
    }

    const { nis, name, classId } = req.body as {
      nis?: string;
      name?: string;
      classId?: number;
    };

    const cleanNis = (nis || '').trim();
    const cleanName = (name || '').trim();
    const cleanClassId = Number(classId);

    if (!cleanNis || !cleanName || !Number.isFinite(cleanClassId) || cleanClassId <= 0) {
      res.status(400).json({ error: 'NIS, nama siswa, dan kelas wajib diisi.' });
      return;
    }

    if (req.teacher!.role !== 'ADMIN') {
      const scope = getTeacherAssignmentScope(req.teacher!.teacherId);
      if (!scope.classIds.includes(existing.class_id) || !scope.classIds.includes(cleanClassId)) {
        res.status(403).json({
          error: 'Akses ditolak. Anda hanya dapat mengubah data siswa pada kelas penugasan Anda.',
        });
        return;
      }
    }

    const cls = db.prepare('SELECT id, name FROM classes WHERE id = ?').get(cleanClassId) as
      | { id: number; name: string }
      | undefined;
    if (!cls) {
      res.status(400).json({ error: 'Kelas yang dipilih tidak valid.' });
      return;
    }

    try {
      db.prepare('UPDATE students SET nis = ?, name = ?, class_id = ? WHERE id = ?').run(
        cleanNis,
        cleanName,
        cleanClassId,
        studentId
      );
      const updated = db
        .prepare(`
          SELECT st.id, st.nis, st.name, st.class_id, st.pin_updated_at, c.name AS class_name
          FROM students st
          JOIN classes c ON c.id = st.class_id
          WHERE st.id = ?
        `)
        .get(studentId);
      res.json({ student: updated });
    } catch {
      res.status(409).json({ error: `NIS "${cleanNis}" sudah digunakan siswa lain.` });
    }
  });

  router.delete('/students/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    if (!requireAdminRole(req, res)) return;
    const studentId = Number(req.params.id);
    const info = db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Siswa tidak ditemukan.' });
      return;
    }
    res.json({ success: true });
  });

  const handleAdminUpdatePin = (req: AuthenticatedTeacherRequest, res: Response) => {
    if (req.teacher!.role !== 'ADMIN') {
      res.status(403).json({
        error: 'Akses ditolak (HTTP 403). Hanya Admin Penanggung Jawab Ujian Semester yang dapat mengubah, meng-generate ulang, atau mereset PIN Semester.',
      });
      return;
    }

    const studentId = Number(req.params.id);
    const { customPin } = (req.body || {}) as { customPin?: string };

    const student = db
      .prepare('SELECT id, nis, name FROM students WHERE id = ?')
      .get(studentId) as { id: number; nis: string; name: string } | undefined;

    if (!student) {
      res.status(404).json({ error: 'Siswa tidak ditemukan.' });
      return;
    }

    const trimmedCustom = customPin?.trim() || '';
    if (trimmedCustom && !/^\d{4,6}$/.test(trimmedCustom)) {
      res.status(400).json({ error: 'PIN Semester harus terdiri dari 4–6 digit angka.' });
      return;
    }

    const newPin = trimmedCustom || generateSemesterPin();
    const pinHash = hashSecret(newPin);
    const pinEncrypted = encryptTextWithKey(newPin, getPinKeyMaterial());

    db.prepare(`UPDATE students SET pin_hash = ?, pin_encrypted = ?, pin_updated_at = datetime('now') WHERE id = ?`).run(
      pinHash,
      pinEncrypted,
      studentId
    );

    res.json({
      studentId: student.id,
      nis: student.nis,
      name: student.name,
      newPin,
    });
  };

  router.post('/students/:id/reset-pin', requireTeacherAuth, handleAdminUpdatePin);
  router.put('/students/:id/pin', requireTeacherAuth, handleAdminUpdatePin);

  router.post('/students/import', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const isAdmin = req.teacher!.role === 'ADMIN';
    const teacherScope = isAdmin ? null : getTeacherAssignmentScope(req.teacher!.teacherId);
    if (teacherScope && teacherScope.classIds.length === 0) {
      res.status(403).json({
        error: 'Akun Anda belum memiliki penugasan kelas mengajar dari Admin Sekolah.',
      });
      return;
    }
    const { rawText, updateExisting = false } = req.body as {
      rawText?: string;
      updateExisting?: boolean;
    };

    if (!rawText || !rawText.trim()) {
      res.status(400).json({ error: 'Data teks atau file CSV siswa tidak boleh kosong.' });
      return;
    }

    const lines = rawText
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      res.status(400).json({ error: 'Tidak ada baris data siswa yang ditemukan.' });
      return;
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

    const keyMaterial = getPinKeyMaterial();
    const importedPins: Array<{
      nis: string;
      name: string;
      className: string;
      pin: string;
      action: 'CREATED' | 'UPDATED';
    }> = [];
    const skipped: Array<{ lineNumber: number; nis: string; name: string; reason: string }> = [];
    const errors: Array<{ lineNumber: number; raw: string; reason: string }> = [];

    const findClassStmt = db.prepare('SELECT id, name FROM classes WHERE LOWER(name) = LOWER(?)');
    const insertClassStmt = db.prepare('INSERT INTO classes (name, grade_level) VALUES (?, ?)');
    const findStudentStmt = db.prepare('SELECT id, nis, name, class_id, pin_encrypted FROM students WHERE nis = ?');
    const insertStudentStmt = db.prepare(
      'INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES (?, ?, ?, ?, ?)'
    );
    const updateStudentInfoOnlyStmt = db.prepare(`UPDATE students SET name = ?, class_id = ? WHERE id = ?`);
    const updateStudentWithPinStmt = db.prepare(
      `UPDATE students SET name = ?, class_id = ?, pin_hash = ?, pin_encrypted = ?, pin_updated_at = datetime('now') WHERE id = ?`
    );

    const runImport = db.transaction(() => {
      let processedDataRows = 0;

      for (let idx = 0; idx < lines.length; idx++) {
        const lineNumber = idx + 1;
        const line = lines[idx];
        const cols = splitDelimitedLine(line);

        // Skip header row if detected on first non-empty line
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

        processedDataRows++;

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

        let classRow = findClassStmt.get(rawClass) as { id: number; name: string } | undefined;
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
          const clsRes = insertClassStmt.run(rawClass.toUpperCase(), gradeLevel);
          classRow = { id: Number(clsRes.lastInsertRowid), name: rawClass.toUpperCase() };
        }

        if (teacherScope && !teacherScope.classIds.includes(classRow.id)) {
          errors.push({
            lineNumber,
            raw: line,
            reason: `Kelas "${classRow.name}" bukan bagian dari penugasan mengajar Anda.`,
          });
          continue;
        }

        const existingStudent = findStudentStmt.get(nis) as
          | { id: number; nis: string; name: string; class_id: number; pin_encrypted: string }
          | undefined;
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
            updateStudentWithPinStmt.run(name, classRow.id, pinHash, pinEncrypted, existingStudent.id);
            importedPins.push({
              nis,
              name,
              className: classRow.name,
              pin: rawPinInput,
              action: 'UPDATED',
            });
          } else {
            // Preserve existing universal Semester PIN when updating name/class
            updateStudentInfoOnlyStmt.run(name, classRow.id, existingStudent.id);
            const preservedPin = existingStudent.pin_encrypted
              ? decryptTextWithKey(existingStudent.pin_encrypted, keyMaterial)
              : null;
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
          insertStudentStmt.run(nis, name, classRow.id, pinHash, pinEncrypted);
          importedPins.push({
            nis,
            name,
            className: classRow.name,
            pin: plainPin,
            action: 'CREATED',
          });
        }
      }

      return processedDataRows;
    });

    const totalRows = runImport();
    const createdCount = importedPins.filter((p) => p.action === 'CREATED').length;
    const updatedCount = importedPins.filter((p) => p.action === 'UPDATED').length;

    res.json({
      summary: {
        totalRows,
        createdCount,
        updatedCount,
        skippedCount: skipped.length,
        errorCount: errors.length,
      },
      importedPins,
      skipped,
      errors,
    });
  });

  // ==========================
  // 5. LIVE MONITORING, UNLOCK, & GRADE RECAP
  // ==========================
  router.get('/packages/:id/monitoring', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, c.name AS class_name,
               t_owner.name AS teacher_name, t_proctor.name AS proctor_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS total_questions
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        JOIN teachers t_owner ON t_owner.id = ep.teacher_id
        LEFT JOIN teachers t_proctor ON t_proctor.id = ep.proctor_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as (PackageRow & { total_questions: number }) | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access === 'NONE') {
      res.status(403).json({ error: 'Anda tidak memiliki akses memantau paket ujian ini.' });
      return;
    }
    const isProctorOnly = access === 'PROCTOR';

    const now = Date.now();
    // Auto-expire overdue in-progress sessions
    const overdue = db
      .prepare(`SELECT id FROM exam_sessions WHERE package_id = ? AND status = 'IN_PROGRESS' AND expires_at <= ?`)
      .all(pkgId, now) as Array<{ id: number }>;
    for (const s of overdue) {
      gradeAndFinalizeSession(s.id, pkgId);
    }

    const roster = db
      .prepare(`
        SELECT st.id AS student_id, st.nis, st.name, c.name AS class_name,
               es.id AS session_id, es.status, es.device_id, es.session_info,
               es.started_at, es.expires_at, es.submitted_at,
               es.violation_count, es.unlock_bonus, es.score, es.correct_count,
               (SELECT COUNT(*) FROM student_answers sa WHERE sa.session_id = es.id) AS answered_count
        FROM students st
        JOIN classes c ON c.id = st.class_id
        LEFT JOIN exam_sessions es ON es.student_id = st.id AND es.package_id = ?
        WHERE st.class_id = ?
        ORDER BY
          CASE es.status
            WHEN 'LOCKED_VIOLATION' THEN 0
            WHEN 'IN_PROGRESS' THEN 1
            WHEN 'SUBMITTED' THEN 2
            ELSE 3
          END,
          st.nis ASC
      `)
      .all(pkgId, pkg.class_id) as Array<{
      student_id: number;
      nis: string;
      name: string;
      class_name: string;
      session_id: number | null;
      status: string | null;
      device_id: string | null;
      session_info: string | null;
      started_at: number | null;
      expires_at: number | null;
      submitted_at: number | null;
      violation_count: number | null;
      unlock_bonus: number | null;
      score: number | null;
      correct_count: number | null;
      answered_count: number | null;
    }>;

    const violations = db
      .prepare(`
        SELECT vl.id, vl.session_id, vl.violation_type, vl.detail, vl.created_at,
               st.nis, st.name AS student_name
        FROM violation_logs vl
        JOIN students st ON st.id = vl.student_id
        WHERE vl.package_id = ?
        ORDER BY vl.created_at DESC
        LIMIT 30
      `)
      .all(pkgId);

    const students = roster.map((r) => {
      const remainingSeconds =
        r.status === 'IN_PROGRESS' && r.expires_at ? Math.max(0, Math.floor((r.expires_at - now) / 1000)) : null;
      return {
        studentId: r.student_id,
        nis: r.nis,
        name: r.name,
        className: r.class_name,
        sessionId: r.session_id,
        status: r.status || 'NOT_STARTED',
        deviceId: r.device_id,
        sessionInfo: r.session_info,
        startedAt: r.started_at,
        expiresAt: r.expires_at,
        submittedAt: r.submitted_at,
        remainingSeconds,
        answeredCount: r.answered_count || 0,
        totalQuestions: pkg.total_questions,
        violationCount: r.violation_count || 0,
        maxViolationsAllowed: pkg.max_violations + (r.unlock_bonus || 0),
        score: isProctorOnly ? null : r.score,
        correctCount: isProctorOnly ? null : r.correct_count,
      };
    });

    res.json({
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
        teacherName: pkg.teacher_name,
        proctorName: pkg.proctor_name || null,
        examDate: pkg.exam_date,
        accessRole: access,
        durationMinutes: pkg.duration_minutes,
        isActive: pkg.is_active === 1,
        maxViolations: pkg.max_violations,
        currentToken: pkg.current_token,
        tokenRotatedAt: pkg.token_rotated_at,
        totalQuestions: pkg.total_questions,
      },
      students,
      recentViolations: violations,
    });
  });

  function checkSessionManageAccess(sessionId: number, teacher: { teacherId: number; role: 'ADMIN' | 'TEACHER' }): {
    session?: SessionRow;
    pkg?: { id: number; teacher_id: number; proctor_id: number | null; max_violations: number };
    access?: PackageAccessRole;
    errorStatus?: number;
    errorMessage?: string;
  } {
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
    if (!session) {
      return { errorStatus: 404, errorMessage: 'Sesi ujian siswa tidak ditemukan.' };
    }
    const pkg = db
      .prepare('SELECT id, teacher_id, proctor_id, max_violations FROM exam_packages WHERE id = ?')
      .get(session.package_id) as { id: number; teacher_id: number; proctor_id: number | null; max_violations: number } | undefined;
    if (!pkg) {
      return { errorStatus: 404, errorMessage: 'Paket ujian tidak ditemukan.' };
    }
    const access = getPackageAccess(pkg, teacher);
    if (access === 'NONE') {
      return { errorStatus: 403, errorMessage: 'Anda tidak memiliki akses mengelola sesi peserta ini.' };
    }
    return { session, pkg, access };
  }

  router.post('/sessions/:id/unlock', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const sessionId = Number(req.params.id);
    const check = checkSessionManageAccess(sessionId, req.teacher!);
    if (!check.session || !check.pkg) {
      res.status(check.errorStatus || 404).json({ error: check.errorMessage });
      return;
    }
    const { session, pkg } = check;

    if (session.status !== 'LOCKED_VIOLATION') {
      res.status(400).json({ error: 'Sesi ini tidak berada dalam status terkunci pelanggaran.' });
      return;
    }

    // Grant +2 grace buffer so the unlocked student can immediately continue, while preserving violation_count history
    const newBonus = session.unlock_bonus + 2;
    db.prepare(`UPDATE exam_sessions SET status = 'IN_PROGRESS', unlock_bonus = ? WHERE id = ?`).run(
      newBonus,
      sessionId
    );

    broadcastPackageEvent({
      type: 'session:unlocked',
      packageId: session.package_id,
      studentId: session.student_id,
      sessionId: session.id,
      payload: {
        sessionToken: session.session_token,
        status: 'IN_PROGRESS',
        maxViolationsAllowed: pkg.max_violations + newBonus,
      },
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      sessionId,
      status: 'IN_PROGRESS',
      maxViolationsAllowed: pkg.max_violations + newBonus,
    });
  });

  router.post('/sessions/:id/reset-device', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const sessionId = Number(req.params.id);
    const check = checkSessionManageAccess(sessionId, req.teacher!);
    if (!check.session) {
      res.status(check.errorStatus || 404).json({ error: check.errorMessage });
      return;
    }
    const { session } = check;

    if (session.status === 'SUBMITTED') {
      res.status(400).json({ error: 'Sesi ujian yang sudah selesai tidak dapat direset perangkatnya.' });
      return;
    }

    const nextSessionToken = generateSessionToken();
    db.prepare(`UPDATE exam_sessions SET session_token = ?, device_id = '', session_info = ? WHERE id = ?`).run(
      nextSessionToken,
      'Diizinkan ganti perangkat oleh pengawas',
      sessionId
    );

    broadcastPackageEvent({
      type: 'session:updated',
      packageId: session.package_id,
      studentId: session.student_id,
      sessionId: session.id,
      payload: { status: session.status, deviceReset: true },
      timestamp: Date.now(),
    });

    res.json({ success: true, sessionId, status: session.status });
  });

  router.post('/sessions/:id/force-submit', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const sessionId = Number(req.params.id);
    const check = checkSessionManageAccess(sessionId, req.teacher!);
    if (!check.session) {
      res.status(check.errorStatus || 404).json({ error: check.errorMessage });
      return;
    }
    const { session, access } = check;

    if (session.status === 'SUBMITTED') {
      res.status(400).json({ error: 'Sesi ujian ini sudah berstatus selesai/dikumpulkan.' });
      return;
    }

    const finalized = gradeAndFinalizeSession(session.id, session.package_id);

    broadcastPackageEvent({
      type: 'session:updated',
      packageId: session.package_id,
      studentId: session.student_id,
      sessionId: session.id,
      payload: { status: 'SUBMITTED', reason: 'FORCE_SUBMITTED' },
      timestamp: Date.now(),
    });

    const isProctorOnly = access === 'PROCTOR';
    res.json({
      success: true,
      sessionId,
      status: 'SUBMITTED',
      score: isProctorOnly ? null : finalized.score,
      correctCount: isProctorOnly ? null : finalized.correctCount,
      totalQuestions: finalized.totalQuestions,
    });
  });

  router.post('/sessions/:id/extend-time', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const sessionId = Number(req.params.id);
    const { extraMinutes = 10 } = (req.body || {}) as { extraMinutes?: number };
    const cleanMinutes = Math.max(1, Math.min(60, Math.round(Number(extraMinutes) || 10)));

    const check = checkSessionManageAccess(sessionId, req.teacher!);
    if (!check.session) {
      res.status(check.errorStatus || 404).json({ error: check.errorMessage });
      return;
    }
    const { session } = check;

    if (session.status === 'SUBMITTED') {
      res.status(400).json({ error: 'Tidak dapat menambah waktu untuk sesi yang sudah selesai.' });
      return;
    }

    const nextExpiresAt = Math.max(session.expires_at, Date.now()) + cleanMinutes * 60 * 1000;
    db.prepare('UPDATE exam_sessions SET expires_at = ? WHERE id = ?').run(nextExpiresAt, sessionId);

    broadcastPackageEvent({
      type: 'session:updated',
      packageId: session.package_id,
      studentId: session.student_id,
      sessionId: session.id,
      payload: { status: session.status, extraMinutes: cleanMinutes },
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      sessionId,
      expiresAt: nextExpiresAt,
      extraMinutes: cleanMinutes,
    });
  });

  router.get('/packages/:id/recap', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, c.name AS class_name,
               t_owner.name AS teacher_name, t_proctor.name AS proctor_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS total_questions
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        JOIN teachers t_owner ON t_owner.id = ep.teacher_id
        LEFT JOIN teachers t_proctor ON t_proctor.id = ep.proctor_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as (PackageRow & { total_questions: number }) | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access === 'NONE') {
      res.status(403).json({ error: 'Anda tidak memiliki akses melihat rekap paket ujian ini.' });
      return;
    }
    const isProctorOnly = access === 'PROCTOR';

    const rows = db
      .prepare(`
        SELECT es.id AS session_id,
               st.nis, st.name, c.name AS class_name,
               COALESCE(es.status, 'NOT_STARTED') AS status,
               es.correct_count,
               COALESCE(es.total_questions, ?) AS total_questions,
               es.score,
               COALESCE(es.violation_count, 0) AS violation_count,
               es.submitted_at
        FROM students st
        JOIN classes c ON c.id = st.class_id
        LEFT JOIN exam_sessions es ON es.student_id = st.id AND es.package_id = ?
        WHERE st.class_id = ?
        ORDER BY st.nis ASC
      `)
      .all(pkg.total_questions, pkgId, pkg.class_id) as Array<{
      session_id: number | null;
      nis: string;
      name: string;
      class_name: string;
      status: string;
      correct_count: number | null;
      total_questions: number;
      score: number | null;
      violation_count: number;
      submitted_at: number | null;
    }>;

    const sanitizedRows = isProctorOnly
      ? rows.map((r) => ({
          ...r,
          correct_count: null,
          score: null,
        }))
      : rows;

    let questionAnalytics: Array<Record<string, unknown>> = [];
    if (!isProctorOnly) {
      const questions = db
        .prepare(`
          SELECT id, question_text, options_json, correct_option, points
          FROM questions
          WHERE package_id = ?
          ORDER BY id ASC
        `)
        .all(pkgId) as Array<{
        id: number;
        question_text: string;
        options_json: string;
        correct_option: string;
        points: number;
      }>;

      const submittedSessions = db
        .prepare(`SELECT id FROM exam_sessions WHERE package_id = ? AND status = 'SUBMITTED'`)
        .all(pkgId) as Array<{ id: number }>;

      const submittedSessionIds = submittedSessions.map((s) => s.id);
      const answerByQuestion = new Map<number, string[]>();
      if (submittedSessionIds.length > 0) {
        const placeholders = submittedSessionIds.map(() => '?').join(',');
        const ansRows = db
          .prepare(
            `SELECT question_id, selected_option FROM student_answers WHERE session_id IN (${placeholders})`
          )
          .all(...submittedSessionIds) as Array<{ question_id: number; selected_option: string }>;

        for (const a of ansRows) {
          const list = answerByQuestion.get(a.question_id) || [];
          list.push(a.selected_option);
          answerByQuestion.set(a.question_id, list);
        }
      }

      const totalSubmitted = submittedSessionIds.length;
      questionAnalytics = questions.map((q, index) => {
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
      });
    }

    res.json({
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
        teacherName: pkg.teacher_name,
        proctorName: pkg.proctor_name || null,
        examDate: pkg.exam_date,
        kkm: pkg.kkm,
        accessRole: access,
        totalQuestions: pkg.total_questions,
      },
      records: sanitizedRows,
      questionAnalytics,
    });
  });

  router.get('/sessions/:id/review', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const sessionId = Number(req.params.id);
    const session = db
      .prepare(`
        SELECT es.*, st.nis AS student_nis, st.name AS student_name, c.name AS student_class_name,
               ep.title AS pkg_title, ep.teacher_id AS pkg_teacher_id, ep.proctor_id AS pkg_proctor_id,
               ep.exam_date AS pkg_exam_date, ep.kkm AS pkg_kkm,
               t_owner.name AS pkg_teacher_name, t_proctor.name AS pkg_proctor_name,
               s.name AS pkg_subject_name, c2.name AS pkg_class_name
        FROM exam_sessions es
        JOIN students st ON st.id = es.student_id
        JOIN classes c ON c.id = st.class_id
        JOIN exam_packages ep ON ep.id = es.package_id
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c2 ON c2.id = ep.class_id
        JOIN teachers t_owner ON t_owner.id = ep.teacher_id
        LEFT JOIN teachers t_proctor ON t_proctor.id = ep.proctor_id
        WHERE es.id = ?
      `)
      .get(sessionId) as
      | {
          id: number;
          package_id: number;
          status: string;
          score: number | null;
          correct_count: number | null;
          total_questions: number;
          violation_count: number;
          started_at: number;
          submitted_at: number | null;
          student_nis: string;
          student_name: string;
          student_class_name: string;
          pkg_title: string;
          pkg_teacher_id: number;
          pkg_proctor_id: number | null;
          pkg_exam_date: string;
          pkg_kkm: number;
          pkg_teacher_name: string;
          pkg_proctor_name: string | null;
          pkg_subject_name: string;
          pkg_class_name: string;
        }
      | undefined;

    if (!session) {
      res.status(404).json({ error: 'Sesi ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(
      { teacher_id: session.pkg_teacher_id, proctor_id: session.pkg_proctor_id },
      req.teacher!
    );
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Akses ditolak. Guru Pengawas tidak diperkenankan membuka lembar jawaban & kunci soal.' });
      return;
    }

    const questions = db
      .prepare(`
        SELECT id, question_text, options_json, correct_option, points
        FROM questions
        WHERE package_id = ?
        ORDER BY id ASC
      `)
      .all(session.package_id) as Array<{
      id: number;
      question_text: string;
      options_json: string;
      correct_option: string;
      points: number;
    }>;

    const ansRows = db
      .prepare('SELECT question_id, selected_option FROM student_answers WHERE session_id = ?')
      .all(sessionId) as Array<{ question_id: number; selected_option: string }>;
    const ansMap = new Map(ansRows.map((a) => [a.question_id, a.selected_option]));

    const items = questions.map((q, idx) => {
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
    });

    res.json({
      session: {
        id: session.id,
        status: session.status,
        score: session.score,
        correctCount: session.correct_count,
        totalQuestions: session.total_questions || questions.length,
        violationCount: session.violation_count,
        startedAt: session.started_at,
        submittedAt: session.submitted_at,
      },
      student: {
        nis: session.student_nis,
        name: session.student_name,
        className: session.student_class_name,
      },
      package: {
        id: session.package_id,
        title: session.pkg_title,
        subjectName: session.pkg_subject_name,
        className: session.pkg_class_name,
        teacherName: session.pkg_teacher_name,
        proctorName: session.pkg_proctor_name || null,
        examDate: session.pkg_exam_date || '',
        kkm: session.pkg_kkm ?? 75,
      },
      items,
    });
  });

  router.get('/packages/:id/recap/csv', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db
      .prepare(`
        SELECT ep.id, ep.title, ep.class_id, ep.teacher_id, ep.proctor_id, ep.exam_date, ep.kkm,
               t_owner.name AS teacher_name, t_proctor.name AS proctor_name,
               s.name AS subject_name, c.name AS class_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS total_questions
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        JOIN teachers t_owner ON t_owner.id = ep.teacher_id
        LEFT JOIN teachers t_proctor ON t_proctor.id = ep.proctor_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as
      | {
          id: number;
          title: string;
          class_id: number;
          teacher_id: number;
          proctor_id: number | null;
          exam_date: string;
          kkm: number;
          teacher_name: string;
          proctor_name: string | null;
          subject_name: string;
          class_name: string;
          total_questions: number;
        }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const access = getPackageAccess(pkg, req.teacher!);
    if (access !== 'ADMIN' && access !== 'OWNER') {
      res.status(403).json({ error: 'Guru Pengawas hanya dapat memantau status penyelesaian peserta dan tidak dapat mengunduh rekap nilai.' });
      return;
    }

    const rawKkmParam = req.query.kkm !== undefined ? Number(req.query.kkm) : NaN;
    const effectiveKkm =
      Number.isFinite(rawKkmParam) && rawKkmParam >= 0 && rawKkmParam <= 100
        ? Math.round(rawKkmParam)
        : pkg.kkm ?? 75;

    const rows = db
      .prepare(`
        SELECT st.nis, st.name, c.name AS class_name,
               COALESCE(es.status, 'NOT_STARTED') AS status,
               es.correct_count,
               COALESCE(es.total_questions, ?) AS total_questions,
               es.score,
               COALESCE(es.violation_count, 0) AS violation_count
        FROM students st
        JOIN classes c ON c.id = st.class_id
        LEFT JOIN exam_sessions es ON es.student_id = st.id AND es.package_id = ?
        WHERE st.class_id = ?
      `)
      .all(pkg.total_questions, pkgId, pkg.class_id) as Array<{
      nis: string;
      name: string;
      class_name: string;
      status: string;
      correct_count: number | null;
      total_questions: number;
      score: number | null;
      violation_count: number;
    }>;

    // Sort descending by score (largest first), then unfinished by name
    rows.sort((a, b) => {
      const sa = a.status === 'SUBMITTED' && a.score !== null ? Number(a.score) : -1;
      const sb = b.status === 'SUBMITTED' && b.score !== null ? Number(b.score) : -1;
      return sb - sa || a.name.localeCompare(b.name);
    });

    const submittedRows = rows.filter((r) => r.status === 'SUBMITTED' && r.score !== null);
    const scores = submittedRows.map((r) => Number(r.score || 0));
    const avgScore =
      scores.length > 0 ? (scores.reduce((acc, val) => acc + val, 0) / scores.length).toFixed(1) : '-';
    const maxScore = scores.length > 0 ? String(Math.max(...scores)) : '-';
    const minScore = scores.length > 0 ? String(Math.min(...scores)) : '-';
    const passedCount = submittedRows.filter((r) => Number(r.score || 0) >= effectiveKkm).length;
    const remedialCount = submittedRows.filter((r) => Number(r.score || 0) < effectiveKkm).length;
    const passRate = submittedRows.length > 0 ? Math.round((passedCount / submittedRows.length) * 100) : 0;

    const lines: string[] = [
      [escapeCsvField('Sekolah'), escapeCsvField('MTs Nurul Islam Gunung Sari')].join(','),
      [escapeCsvField('Judul Ujian'), escapeCsvField(pkg.title)].join(','),
      [escapeCsvField('Kelas'), escapeCsvField(pkg.class_name)].join(','),
      [escapeCsvField('Mata Pelajaran'), escapeCsvField(pkg.subject_name)].join(','),
      [escapeCsvField('Guru Mapel'), escapeCsvField(pkg.teacher_name || '-')].join(','),
      [escapeCsvField('Guru Pengawas'), escapeCsvField(pkg.proctor_name || 'Belum ditugaskan')].join(','),
      [escapeCsvField('Tanggal Ujian'), escapeCsvField(pkg.exam_date || '-')].join(','),
      [escapeCsvField('KKM'), escapeCsvField(effectiveKkm)].join(','),
      '',
      [escapeCsvField('RINGKASAN HASIL UJIAN'), escapeCsvField('Nilai / Jumlah')].join(','),
      [escapeCsvField('Peserta Selesai'), escapeCsvField(`${submittedRows.length} / ${rows.length}`)].join(','),
      [escapeCsvField('Rata-rata Nilai'), escapeCsvField(`${avgScore} (Tertinggi: ${maxScore}, Terendah: ${minScore})`)].join(','),
      [escapeCsvField(`Tuntas (>= ${effectiveKkm})`), escapeCsvField(`${passedCount} siswa (${passRate}%)`)].join(','),
      [escapeCsvField(`Remedial (< ${effectiveKkm})`), escapeCsvField(`${remedialCount} siswa`)].join(','),
      '',
      ['No', 'NIS', 'Nama Siswa', 'Kelas', 'Benar', 'Total Soal', 'Nilai Akhir', 'Ketuntasan', 'Status', 'Jumlah Pelanggaran'].join(','),
    ];

    rows.forEach((r, idx) => {
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
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rekap-${safeSlug}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  });

  // ==========================
  // 6. EXAMBRO APK & STUDENT EXAM ENDPOINTS
  // ==========================

  // Public helper for built-in Exambro QR Simulator (never exposes secret token or answer keys)
  router.get('/public/active-packages', (_req: Request, res: Response) => {
    const active = db
      .prepare(`
        SELECT ep.id, ep.title, ep.duration_minutes, ep.class_id, ep.subject_id,
               s.name AS subject_name, s.code AS subject_code, c.name AS class_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS question_count
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.is_active = 1
        ORDER BY ep.id ASC
      `)
      .all() as Array<{
      id: number;
      title: string;
      duration_minutes: number;
      class_id: number;
      subject_id: number;
      subject_name: string;
      subject_code: string;
      class_name: string;
      question_count: number;
    }>;

    const list = active.map((pkg) => ({
      id: pkg.id,
      title: pkg.title,
      durationMinutes: pkg.duration_minutes,
      subjectName: pkg.subject_name,
      className: pkg.class_name,
      questionCount: pkg.question_count,
      qrPayload: encryptQrPayload({
        packageId: pkg.id,
        classId: pkg.class_id,
        subjectCode: pkg.subject_code,
        title: pkg.title,
      }),
    }));

    res.json({ packages: list });
  });

  router.post('/exambro/decode-qr', requireExambroClient, (req: Request, res: Response) => {
    const { qrPayload } = req.body as { qrPayload?: string };
    if (!qrPayload?.trim()) {
      res.status(400).json({ error: 'Payload QR wajib dikirim.' });
      return;
    }

    let rawToken = qrPayload.trim();
    if (rawToken.startsWith('examflow://')) {
      try {
        const parsedUrl = new URL(rawToken.replace('examflow://', 'https://examflow.local/'));
        rawToken = parsedUrl.searchParams.get('payload') || rawToken;
      } catch {
        // Ignore URL parse error
      }
    }

    const decoded = decryptQrPayload(rawToken);
    if (!decoded) {
      res.status(400).json({ error: 'QR Code tidak valid atau tanda tangan keamanan rusak.' });
      return;
    }

    const pkg = db
      .prepare(`
        SELECT ep.id, ep.title, ep.duration_minutes, ep.is_active, ep.max_violations,
               s.name AS subject_name, c.name AS class_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS question_count
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.id = ?
      `)
      .get(decoded.packageId) as
      | {
          id: number;
          title: string;
          duration_minutes: number;
          is_active: number;
          max_violations: number;
          subject_name: string;
          class_name: string;
          question_count: number;
        }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian dari QR Code tidak ditemukan.' });
      return;
    }

    res.json({
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
        durationMinutes: pkg.duration_minutes,
        isActive: pkg.is_active === 1,
        maxViolations: pkg.max_violations,
        questionCount: pkg.question_count,
      },
    });
  });

  router.post('/exambro/resolve-token', requireExambroClient, (req: Request, res: Response) => {
    const { tokenUjian } = req.body as { tokenUjian?: string };
    const cleanedToken = tokenUjian?.trim().toUpperCase() || '';
    if (!cleanedToken) {
      res.status(400).json({ error: 'Token Ujian wajib diisi.' });
      return;
    }

    const pkg = db
      .prepare(`
        SELECT ep.id, ep.title, ep.duration_minutes, ep.is_active, ep.max_violations,
               s.name AS subject_name, c.name AS class_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS question_count
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE UPPER(ep.current_token) = ?
        ORDER BY ep.is_active DESC, ep.id DESC
        LIMIT 1
      `)
      .get(cleanedToken) as
      | {
          id: number;
          title: string;
          duration_minutes: number;
          is_active: number;
          max_violations: number;
          subject_name: string;
          class_name: string;
          question_count: number;
        }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Token Ujian tidak ditemukan atau sudah dirotasi oleh guru.' });
      return;
    }

    if (pkg.is_active !== 1) {
      res.status(403).json({ error: 'Paket ujian untuk token ini sedang dinonaktifkan oleh guru/pengawas.' });
      return;
    }

    res.json({
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
        durationMinutes: pkg.duration_minutes,
        isActive: pkg.is_active === 1,
        maxViolations: pkg.max_violations,
        questionCount: pkg.question_count,
      },
    });
  });

  router.post('/exambro/verify', requireExambroClient, (req: Request, res: Response) => {
    const {
      qrPayload,
      packageId: explicitPackageId,
      tokenUjian,
      nis,
      pinSemester,
      deviceId = 'ANDROID-EXAMBRO-DEVICE',
      sessionInfo = 'Exambro Android Client',
    } = req.body as {
      qrPayload?: string;
      packageId?: number;
      tokenUjian?: string;
      nis?: string;
      pinSemester?: string;
      deviceId?: string;
      sessionInfo?: string;
    };

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
      const decoded = decryptQrPayload(rawToken);
      if (!decoded) {
        res.status(400).json({ error: 'Payload QR terenkripsi tidak valid.' });
        return;
      }
      resolvedPackageId = decoded.packageId;
    }

    const normalizedToken = tokenUjian?.trim().toUpperCase() || '';

    if (!normalizedToken || !nis?.trim() || !pinSemester?.trim()) {
      res.status(400).json({ error: 'Token Ujian, NIS, dan PIN Semester wajib diisi.' });
      return;
    }

    const pkg = resolvedPackageId
      ? (db
          .prepare(`
            SELECT ep.*, s.name AS subject_name, c.name AS class_name
            FROM exam_packages ep
            JOIN subjects s ON s.id = ep.subject_id
            JOIN classes c ON c.id = ep.class_id
            WHERE ep.id = ?
          `)
          .get(resolvedPackageId) as PackageRow | undefined)
      : (db
          .prepare(`
            SELECT ep.*, s.name AS subject_name, c.name AS class_name
            FROM exam_packages ep
            JOIN subjects s ON s.id = ep.subject_id
            JOIN classes c ON c.id = ep.class_id
            WHERE UPPER(ep.current_token) = ?
            ORDER BY ep.is_active DESC, ep.id DESC
            LIMIT 1
          `)
          .get(normalizedToken) as PackageRow | undefined);

    if (!pkg) {
      res.status(resolvedPackageId ? 404 : 401).json({
        error: resolvedPackageId
          ? 'Paket ujian tidak ditemukan.'
          : 'Token Ujian tidak valid atau sudah dirotasi oleh guru. Periksa token terbaru.',
      });
      return;
    }

    if (pkg.is_active !== 1) {
      res.status(403).json({ error: 'Paket ujian sedang dinonaktifkan oleh guru/pengawas.' });
      return;
    }

    // Validate active rotated exam token
    if (!constantTimeEqualText(normalizedToken, pkg.current_token.toUpperCase())) {
      res.status(401).json({ error: 'Token Ujian salah atau sudah dirotasi oleh guru. Periksa token terbaru.' });
      return;
    }

    // Validate student exists and belongs to the package's assigned class
    const student = db
      .prepare(`
        SELECT st.*, c.name AS class_name
        FROM students st
        JOIN classes c ON c.id = st.class_id
        WHERE st.nis = ?
      `)
      .get(nis.trim()) as
      | { id: number; nis: string; name: string; class_id: number; pin_hash: string; class_name: string }
      | undefined;

    if (!student) {
      res.status(401).json({ error: 'NIS siswa tidak terdaftar dalam sistem.' });
      return;
    }

    if (student.class_id !== pkg.class_id) {
      res.status(403).json({
        error: `Siswa kelas ${student.class_name} tidak terdaftar pada paket ujian untuk kelas ${pkg.class_name}.`,
      });
      return;
    }

    if (!verifySecret(pinSemester.trim(), student.pin_hash)) {
      res.status(401).json({ error: 'PIN Semester tidak cocok. Hubungi guru jika lupa PIN.' });
      return;
    }

    const questions = db
      .prepare('SELECT id, options_json FROM questions WHERE package_id = ? ORDER BY id ASC')
      .all(pkg.id) as Array<{ id: number; options_json: string }>;

    if (questions.length === 0) {
      res.status(400).json({ error: 'Paket ujian belum memiliki soal.' });
      return;
    }

    const existingSession = db
      .prepare('SELECT * FROM exam_sessions WHERE package_id = ? AND student_id = ?')
      .get(pkg.id, student.id) as SessionRow | undefined;

    const now = Date.now();

    if (existingSession) {
      if (existingSession.status === 'LOCKED_VIOLATION') {
        res.status(423).json({
          error: 'Sesi ujian Anda terkunci karena pelanggaran tata tertib. Minta pengawas membuka kunci sesi Anda.',
          status: 'LOCKED_VIOLATION',
          violationCount: existingSession.violation_count,
        });
        return;
      }

      if (existingSession.status === 'SUBMITTED') {
        res.status(409).json({
          error: 'Anda telah menyelesaikan dan mengumpulkan ujian ini.',
          status: 'SUBMITTED',
          score: existingSession.score,
        });
        return;
      }

      if (now >= existingSession.expires_at) {
        const finalized = gradeAndFinalizeSession(existingSession.id, pkg.id);
        res.status(409).json({
          error: 'Waktu ujian untuk sesi Anda telah habis dan jawaban telah dikumpulkan otomatis.',
          status: 'SUBMITTED',
          score: finalized.score,
        });
        return;
      }

      // Resume active IN_PROGRESS session keeping locked question/option order & remaining server time
      db.prepare('UPDATE exam_sessions SET device_id = ?, session_info = ? WHERE id = ?').run(
        deviceId,
        sessionInfo,
        existingSession.id
      );

      broadcastPackageEvent({
        type: 'session:updated',
        packageId: pkg.id,
        studentId: student.id,
        sessionId: existingSession.id,
        payload: { status: 'IN_PROGRESS', resumed: true },
        timestamp: now,
      });

      res.json({
        sessionToken: existingSession.session_token,
        resumed: true,
        status: existingSession.status,
        remainingSeconds: Math.max(0, Math.floor((existingSession.expires_at - now) / 1000)),
        student: {
          id: student.id,
          nis: student.nis,
          name: student.name,
          className: student.class_name,
        },
        package: {
          id: pkg.id,
          title: pkg.title,
          subjectName: pkg.subject_name,
          className: pkg.class_name,
          durationMinutes: pkg.duration_minutes,
          maxViolationsAllowed: pkg.max_violations + existingSession.unlock_bonus,
        },
      });
      return;
    }

    // Create brand-new exam session and lock randomized question + option orders server-side!
    const questionIds = questions.map((q) => q.id);
    const lockedQuestionOrder = pkg.shuffle_questions === 1 ? cryptoShuffle(questionIds) : questionIds;

    const lockedOptionOrders: Record<string, string[]> = {};
    for (const q of questions) {
      const opts = JSON.parse(q.options_json) as OptionItem[];
      const keys = opts.map((o) => o.key);
      lockedOptionOrders[String(q.id)] = pkg.shuffle_options === 1 ? cryptoShuffle(keys) : keys;
    }

    const sessionToken = generateSessionToken();
    const startedAt = now;
    const expiresAt = now + pkg.duration_minutes * 60 * 1000;

    const insertRes = db
      .prepare(`
        INSERT INTO exam_sessions (
          package_id, student_id, session_token, device_id, session_info, status,
          question_order_json, option_orders_json, started_at, expires_at, total_questions
        )
        VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?, ?)
      `)
      .run(
        pkg.id,
        student.id,
        sessionToken,
        deviceId,
        sessionInfo,
        JSON.stringify(lockedQuestionOrder),
        JSON.stringify(lockedOptionOrders),
        startedAt,
        expiresAt,
        questions.length
      );

    const newSessionId = Number(insertRes.lastInsertRowid);

    broadcastPackageEvent({
      type: 'session:updated',
      packageId: pkg.id,
      studentId: student.id,
      sessionId: newSessionId,
      payload: { status: 'IN_PROGRESS', started: true },
      timestamp: now,
    });

    res.status(201).json({
      sessionToken,
      resumed: false,
      status: 'IN_PROGRESS',
      remainingSeconds: Math.floor((expiresAt - now) / 1000),
      student: {
        id: student.id,
        nis: student.nis,
        name: student.name,
        className: student.class_name,
      },
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
        durationMinutes: pkg.duration_minutes,
        maxViolationsAllowed: pkg.max_violations,
      },
    });
  });

  // Get locked randomized questions + saved answers (NO answer keys!)
  router.get('/exam/session', requireExambroClient, requireStudentSession, (req: StudentSessionRequest, res: Response) => {
    const session = req.examSession!;
    const pkg = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, c.name AS class_name
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.id = ?
      `)
      .get(session.package_id) as PackageRow;

    const student = db
      .prepare(`
        SELECT st.id, st.nis, st.name, c.name AS class_name
        FROM students st
        JOIN classes c ON c.id = st.class_id
        WHERE st.id = ?
      `)
      .get(session.student_id) as { id: number; nis: string; name: string; class_name: string };

    if (session.status === 'SUBMITTED') {
      res.json({
        status: 'SUBMITTED',
        remainingSeconds: 0,
        student,
        package: {
          id: pkg.id,
          title: pkg.title,
          subjectName: pkg.subject_name,
          className: pkg.class_name,
          durationMinutes: pkg.duration_minutes,
          maxViolationsAllowed: pkg.max_violations + session.unlock_bonus,
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
      return;
    }

    const questionOrder = JSON.parse(session.question_order_json) as number[];
    const optionOrders = JSON.parse(session.option_orders_json) as Record<string, string[]>;

    // Explicit column selection WITHOUT correct_option!
    const rawQuestions = db
      .prepare('SELECT id, question_text, question_type, options_json, points FROM questions WHERE package_id = ?')
      .all(session.package_id) as Array<{
      id: number;
      question_text: string;
      question_type: string;
      options_json: string;
      points: number;
    }>;

    const qMap = new Map(rawQuestions.map((q) => [q.id, q]));
    const displayLabels = ['A', 'B', 'C', 'D', 'E'];

    const orderedQuestions = questionOrder
      .map((qId, index) => {
        const q = qMap.get(qId);
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

    const savedAnswers = db
      .prepare('SELECT question_id, selected_option FROM student_answers WHERE session_id = ?')
      .all(session.id) as Array<{ question_id: number; selected_option: string }>;

    const answersObj = Object.fromEntries(savedAnswers.map((a) => [String(a.question_id), a.selected_option]));
    const remainingSeconds = Math.max(0, Math.floor((session.expires_at - Date.now()) / 1000));

    res.json({
      status: session.status,
      remainingSeconds,
      startedAt: session.started_at,
      expiresAt: session.expires_at,
      violationCount: session.violation_count,
      maxViolationsAllowed: pkg.max_violations + session.unlock_bonus,
      student,
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
        durationMinutes: pkg.duration_minutes,
        maxViolationsAllowed: pkg.max_violations + session.unlock_bonus,
      },
      questions: orderedQuestions,
      answers: answersObj,
    });
  });

  // Auto-save answer keyed by original question ID & original option key
  router.post('/exam/answer', requireExambroClient, requireStudentSession, (req: StudentSessionRequest, res: Response) => {
    const session = req.examSession!;

    if (session.status === 'LOCKED_VIOLATION') {
      res.status(423).json({
        error: 'Sesi terkunci karena pelanggaran. Jawaban tidak dapat disimpan sebelum dibuka guru.',
        status: 'LOCKED_VIOLATION',
      });
      return;
    }

    if (session.status === 'SUBMITTED') {
      res.status(409).json({
        error: 'Ujian telah dikumpulkan.',
        status: 'SUBMITTED',
      });
      return;
    }

    const { questionId, selectedOption } = req.body as { questionId?: number; selectedOption?: string };
    if (!questionId || !selectedOption) {
      res.status(400).json({ error: 'questionId dan selectedOption wajib dikirim.' });
      return;
    }

    // Verify question belongs to this session's package
    const qExists = db
      .prepare('SELECT id FROM questions WHERE id = ? AND package_id = ?')
      .get(Number(questionId), session.package_id);
    if (!qExists) {
      res.status(404).json({ error: 'Soal tidak valid untuk paket ujian ini.' });
      return;
    }

    const now = Date.now();
    db.prepare(`
      INSERT INTO student_answers (session_id, question_id, selected_option, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, question_id) DO UPDATE SET selected_option = excluded.selected_option, updated_at = excluded.updated_at
    `).run(session.id, Number(questionId), selectedOption.trim().toUpperCase(), now);

    const answeredCount = (
      db.prepare('SELECT COUNT(*) AS cnt FROM student_answers WHERE session_id = ?').get(session.id) as { cnt: number }
    ).cnt;

    broadcastPackageEvent({
      type: 'session:updated',
      packageId: session.package_id,
      studentId: session.student_id,
      sessionId: session.id,
      payload: { answeredCount },
      timestamp: now,
    });

    res.json({
      saved: true,
      questionId: Number(questionId),
      selectedOption: selectedOption.trim().toUpperCase(),
      answeredCount,
      remainingSeconds: Math.max(0, Math.floor((session.expires_at - now) / 1000)),
    });
  });

  // Record Exambro violation event (focus loss, exit lock task, split screen, etc.)
  router.post('/exam/violation', requireExambroClient, requireStudentSession, (req: StudentSessionRequest, res: Response) => {
    const session = req.examSession!;

    if (session.status === 'SUBMITTED') {
      res.status(409).json({ error: 'Ujian sudah selesai.' });
      return;
    }

    const { violationType = 'FOCUS_LOST', detail = 'Aplikasi keluar dari fokus ujian' } = req.body as {
      violationType?: string;
      detail?: string;
    };

    const pkg = db.prepare('SELECT max_violations FROM exam_packages WHERE id = ?').get(session.package_id) as {
      max_violations: number;
    };
    const student = db.prepare('SELECT nis, name FROM students WHERE id = ?').get(session.student_id) as {
      nis: string;
      name: string;
    };

    const now = Date.now();
    const newViolationCount = session.violation_count + 1;
    const maxAllowed = pkg.max_violations + session.unlock_bonus;
    const shouldLock = newViolationCount >= maxAllowed;
    const nextStatus = shouldLock ? 'LOCKED_VIOLATION' : session.status;

    db.prepare(`
      INSERT INTO violation_logs (session_id, package_id, student_id, violation_type, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.id, session.package_id, session.student_id, violationType.trim(), detail.trim(), now);

    db.prepare('UPDATE exam_sessions SET violation_count = ?, status = ? WHERE id = ?').run(
      newViolationCount,
      nextStatus,
      session.id
    );

    broadcastPackageEvent({
      type: shouldLock ? 'violation:alert' : 'session:updated',
      packageId: session.package_id,
      studentId: session.student_id,
      sessionId: session.id,
      payload: {
        studentName: student.name,
        nis: student.nis,
        violationType,
        detail,
        violationCount: newViolationCount,
        maxViolationsAllowed: maxAllowed,
        status: nextStatus,
        locked: shouldLock,
      },
      timestamp: now,
    });

    res.json({
      status: nextStatus,
      violationCount: newViolationCount,
      maxViolationsAllowed: maxAllowed,
      locked: shouldLock,
    });
  });

  // Final Submit
  router.post('/exam/submit', requireExambroClient, requireStudentSession, (req: StudentSessionRequest, res: Response) => {
    const session = req.examSession!;

    if (session.status === 'LOCKED_VIOLATION') {
      res.status(423).json({
        error: 'Sesi Anda sedang terkunci pelanggaran. Minta guru membuka kunci sebelum melakukan submit.',
        status: 'LOCKED_VIOLATION',
      });
      return;
    }

    if (session.status === 'SUBMITTED') {
      res.json({
        status: 'SUBMITTED',
        score: session.score,
        correctCount: session.correct_count,
        totalQuestions: session.total_questions,
      });
      return;
    }

    const result = gradeAndFinalizeSession(session.id, session.package_id);

    broadcastPackageEvent({
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

    res.json({
      status: 'SUBMITTED',
      ...result,
    });
  });

  return router;
}
