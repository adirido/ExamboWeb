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
  subject_id: number;
  class_id: number;
  title: string;
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
  router.post('/auth/login', (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: 'Email dan kata sandi wajib diisi.' });
      return;
    }

    const teacher = db
      .prepare('SELECT id, name, email, password_hash, role FROM teachers WHERE email = ?')
      .get(email.trim().toLowerCase()) as
      | { id: number; name: string; email: string; password_hash: string; role: 'TEACHER' | 'ADMIN' }
      | undefined;

    if (!teacher || !verifySecret(password, teacher.password_hash)) {
      res.status(401).json({ error: 'Email atau kata sandi tidak sesuai.' });
      return;
    }

    const token = createTeacherToken({
      teacherId: teacher.id,
      email: teacher.email,
      name: teacher.name,
      role: teacher.role,
    });

    res.json({
      token,
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
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

  router.get('/teacher/context', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacherId = req.teacher!.teacherId;
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
      .all(teacherId);

    const allSubjects = db.prepare('SELECT * FROM subjects ORDER BY name ASC').all();
    const allClasses = db.prepare('SELECT * FROM classes ORDER BY name ASC').all();

    res.json({
      teacher: req.teacher,
      assignments,
      subjects: allSubjects,
      classes: allClasses,
    });
  });

  router.post('/teacher/assignments', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
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
  // 2. EXAM PACKAGES & TOKEN ROTATION & QR
  // ==========================
  router.get('/packages', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacher = req.teacher!;
    const rows = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, s.code AS subject_code, c.name AS class_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS question_count,
               (SELECT COUNT(*) FROM students st WHERE st.class_id = ep.class_id) AS class_student_count,
               (SELECT COUNT(*) FROM exam_sessions es WHERE es.package_id = ep.id AND es.status = 'IN_PROGRESS') AS active_count,
               (SELECT COUNT(*) FROM exam_sessions es WHERE es.package_id = ep.id AND es.status = 'LOCKED_VIOLATION') AS locked_count,
               (SELECT COUNT(*) FROM exam_sessions es WHERE es.package_id = ep.id AND es.status = 'SUBMITTED') AS submitted_count
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE (? = 'ADMIN' OR ep.teacher_id = ?)
        ORDER BY ep.is_active DESC, ep.id DESC
      `)
      .all(teacher.role, teacher.teacherId);

    res.json({ packages: rows });
  });

  router.post('/packages', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const teacherId = req.teacher!.teacherId;
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
    } = req.body as {
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
    };

    if (!title?.trim() || !subjectId || (!classId && !className?.trim())) {
      res.status(400).json({ error: 'Judul paket, mata pelajaran, dan kelas wajib diisi.' });
      return;
    }

    let resolvedClassId = classId ? Number(classId) : 0;
    if (!resolvedClassId && className?.trim()) {
      const cleanClassName = className.replace(/^kelas\s+/i, '').trim().toUpperCase();
      const foundClass = db
        .prepare('SELECT id FROM classes WHERE LOWER(name) = LOWER(?)')
        .get(cleanClassName) as { id: number } | undefined;
      if (foundClass) {
        resolvedClassId = foundClass.id;
      } else {
        const matchGrade = cleanClassName.match(/^(\d+)/);
        const gradeLevel = matchGrade ? Number(matchGrade[1]) : 8;
        const clsRes = db.prepare('INSERT INTO classes (name, grade_level) VALUES (?, ?)').run(cleanClassName, gradeLevel);
        resolvedClassId = Number(clsRes.lastInsertRowid);
      }
    }

    const cleanedInitialToken = initialToken?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleanedInitialToken && (cleanedInitialToken.length < 4 || cleanedInitialToken.length > 12)) {
      res.status(400).json({ error: 'Token ujian awal harus terdiri dari 4–12 karakter huruf/angka.' });
      return;
    }

    const token = cleanedInitialToken || generateExamToken();
    const result = db
      .prepare(`
        INSERT INTO exam_packages (teacher_id, subject_id, class_id, title, duration_minutes, is_active, max_violations, shuffle_questions, shuffle_options, current_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        teacherId,
        Number(subjectId),
        resolvedClassId,
        title.trim(),
        Math.max(5, Math.min(300, Number(durationMinutes) || 60)),
        isActive ? 1 : 0,
        Math.max(1, Math.min(20, Number(maxViolations) || 3)),
        shuffleQuestions ? 1 : 0,
        shuffleOptions ? 1 : 0,
        token
      );

    const newPackageId = Number(result.lastInsertRowid);

    // Optional: clone questions from another package (great when switching/copying UAS 8A -> 8B)
    if (cloneFromPackageId) {
      const sourceQuestions = db
        .prepare('SELECT question_text, question_type, options_json, correct_option, points FROM questions WHERE package_id = ?')
        .all(Number(cloneFromPackageId)) as Array<{
        question_text: string;
        question_type: string;
        options_json: string;
        correct_option: string;
        points: number;
      }>;

      const insertQ = db.prepare(`
        INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const q of sourceQuestions) {
        insertQ.run(Number(subjectId), newPackageId, q.question_text, q.question_type, q.options_json, q.correct_option, q.points);
      }
    }

    const created = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, s.code AS subject_code, c.name AS class_name
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.id = ?
      `)
      .get(newPackageId);

    res.status(201).json({ package: created });
  });

  router.put('/packages/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const { title, classId, durationMinutes, maxViolations, shuffleQuestions, shuffleOptions, isActive } = req.body as {
      title?: string;
      classId?: number;
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

    db.prepare(`
      UPDATE exam_packages
      SET title = ?,
          class_id = ?,
          duration_minutes = ?,
          max_violations = ?,
          shuffle_questions = ?,
          shuffle_options = ?,
          is_active = ?
      WHERE id = ?
    `).run(
      title?.trim() || existing.title,
      classId ? Number(classId) : existing.class_id,
      durationMinutes ? Math.max(5, Math.min(300, Number(durationMinutes))) : existing.duration_minutes,
      maxViolations ? Math.max(1, Math.min(20, Number(maxViolations))) : existing.max_violations,
      typeof shuffleQuestions === 'boolean' ? (shuffleQuestions ? 1 : 0) : existing.shuffle_questions,
      typeof shuffleOptions === 'boolean' ? (shuffleOptions ? 1 : 0) : existing.shuffle_options,
      typeof isActive === 'boolean' ? (isActive ? 1 : 0) : existing.is_active,
      pkgId
    );

    res.json({ success: true });
  });

  router.delete('/packages/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const info = db.prepare('DELETE FROM exam_packages WHERE id = ?').run(pkgId);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }
    res.json({ success: true });
  });

  router.post('/packages/:id/toggle-active', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db.prepare('SELECT * FROM exam_packages WHERE id = ?').get(pkgId) as PackageRow | undefined;
    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
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
        SELECT ep.*, s.name AS subject_name, s.code AS subject_code, c.name AS class_name
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as PackageRow | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
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
      'https://proforkoc.github.io/exambro/';

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
      isActive: pkg.is_active === 1,
      currentToken: pkg.current_token,
      studentExamUrl,
      encryptedPayload,
      exambroDeepLink,
      qrDataUrl,
    });
  });

  // ==========================
  // 3. QUESTION BANK CRUD (TEACHER ONLY)
  // ==========================
  router.get('/packages/:id/questions', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
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
    const pkg = db.prepare('SELECT id, subject_id FROM exam_packages WHERE id = ?').get(pkgId) as
      | { id: number; subject_id: number }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const { questionText, options, correctOption, points = 20 } = req.body as {
      questionText?: string;
      options?: OptionItem[];
      correctOption?: string;
      points?: number;
    };

    if (!questionText?.trim() || !Array.isArray(options) || options.length < 2 || !correctOption) {
      res.status(400).json({ error: 'Teks soal, minimal 2 pilihan jawaban, dan kunci jawaban wajib diisi.' });
      return;
    }

    const info = db
      .prepare(`
        INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
        VALUES (?, ?, ?, 'MULTIPLE_CHOICE', ?, ?, ?)
      `)
      .run(
        pkg.subject_id,
        pkgId,
        questionText.trim(),
        JSON.stringify(options),
        correctOption.trim().toUpperCase(),
        Math.max(1, Number(points) || 10)
      );

    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  router.post('/packages/:id/questions/import', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db.prepare('SELECT id, subject_id FROM exam_packages WHERE id = ?').get(pkgId) as
      | { id: number; subject_id: number }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const { rawText, replaceExisting = false } = req.body as {
      rawText?: string;
      replaceExisting?: boolean;
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
    let createdCount = 0;
    let totalRows = 0;

    const deleteOldStmt = db.prepare('DELETE FROM questions WHERE package_id = ?');
    const insertQStmt = db.prepare(`
      INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
      VALUES (?, ?, ?, 'MULTIPLE_CHOICE', ?, ?, ?)
    `);

    const runImport = db.transaction(() => {
      if (replaceExisting) {
        deleteOldStmt.run(pkgId);
      }

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

        insertQStmt.run(pkg.subject_id, pkgId, qText, JSON.stringify(options), correctKey, points);
        createdCount++;
      }
    });

    runImport();

    res.json({
      summary: {
        totalRows,
        createdCount,
        errorCount: errors.length,
      },
      errors,
    });
  });

  router.put('/questions/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const qId = Number(req.params.id);
    const { questionText, options, correctOption, points } = req.body as {
      questionText?: string;
      options?: OptionItem[];
      correctOption?: string;
      points?: number;
    };

    const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(qId) as QuestionRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Soal tidak ditemukan.' });
      return;
    }

    db.prepare(`
      UPDATE questions
      SET question_text = ?, options_json = ?, correct_option = ?, points = ?
      WHERE id = ?
    `).run(
      questionText?.trim() || existing.question_text,
      Array.isArray(options) ? JSON.stringify(options) : existing.options_json,
      correctOption ? correctOption.trim().toUpperCase() : existing.correct_option,
      points ? Math.max(1, Number(points)) : existing.points,
      qId
    );

    res.json({ success: true });
  });

  router.delete('/questions/:id', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const qId = Number(req.params.id);
    const info = db.prepare('DELETE FROM questions WHERE id = ?').run(qId);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Soal tidak ditemukan.' });
      return;
    }
    res.json({ success: true });
  });

  // ==========================
  // 4. STUDENTS & SEMESTER PIN MANAGEMENT
  // ==========================
  router.get('/students', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const classId = req.query.classId ? Number(req.query.classId) : null;
    const rows = db
      .prepare(`
        SELECT st.id, st.nis, st.name, st.class_id, st.pin_encrypted, st.pin_updated_at, c.name AS class_name
        FROM students st
        JOIN classes c ON c.id = st.class_id
        WHERE (? IS NULL OR st.class_id = ?)
        ORDER BY c.name ASC, st.nis ASC
      `)
      .all(classId, classId) as Array<{
      id: number;
      nis: string;
      name: string;
      class_id: number;
      pin_encrypted: string;
      pin_updated_at: string;
      class_name: string;
    }>;

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
    const findStudentStmt = db.prepare('SELECT id, nis, name, pin_encrypted FROM students WHERE nis = ?');
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
          const matchGrade = rawClass.match(/^(\d+)/);
          const gradeLevel = matchGrade ? Number(matchGrade[1]) : 8;
          const clsRes = insertClassStmt.run(rawClass.toUpperCase(), gradeLevel);
          classRow = { id: Number(clsRes.lastInsertRowid), name: rawClass.toUpperCase() };
        }

        const existingStudent = findStudentStmt.get(nis) as
          | { id: number; nis: string; name: string; pin_encrypted: string }
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
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS total_questions
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as (PackageRow & { total_questions: number }) | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

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
        score: r.score,
        correctCount: r.correct_count,
      };
    });

    res.json({
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
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

  router.post('/sessions/:id/unlock', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const sessionId = Number(req.params.id);
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;

    if (!session) {
      res.status(404).json({ error: 'Sesi ujian siswa tidak ditemukan.' });
      return;
    }

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

    const pkg = db.prepare('SELECT max_violations FROM exam_packages WHERE id = ?').get(session.package_id) as {
      max_violations: number;
    };

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

  router.get('/packages/:id/recap', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db
      .prepare(`
        SELECT ep.*, s.name AS subject_name, c.name AS class_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS total_questions
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as (PackageRow & { total_questions: number }) | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

    const rows = db
      .prepare(`
        SELECT st.nis, st.name, c.name AS class_name,
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
      .all(pkg.total_questions, pkgId, pkg.class_id);

    res.json({
      package: {
        id: pkg.id,
        title: pkg.title,
        subjectName: pkg.subject_name,
        className: pkg.class_name,
        totalQuestions: pkg.total_questions,
      },
      records: rows,
    });
  });

  router.get('/packages/:id/recap/csv', requireTeacherAuth, (req: AuthenticatedTeacherRequest, res: Response) => {
    const pkgId = Number(req.params.id);
    const pkg = db
      .prepare(`
        SELECT ep.id, ep.title, ep.class_id, s.name AS subject_name, c.name AS class_name,
               (SELECT COUNT(*) FROM questions q WHERE q.package_id = ep.id) AS total_questions
        FROM exam_packages ep
        JOIN subjects s ON s.id = ep.subject_id
        JOIN classes c ON c.id = ep.class_id
        WHERE ep.id = ?
      `)
      .get(pkgId) as
      | { id: number; title: string; class_id: number; subject_name: string; class_name: string; total_questions: number }
      | undefined;

    if (!pkg) {
      res.status(404).json({ error: 'Paket ujian tidak ditemukan.' });
      return;
    }

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
        ORDER BY st.nis ASC
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

    const header = ['NIS', 'Nama Siswa', 'Kelas', 'Benar', 'Total Soal', 'Nilai Akhir', 'Status', 'Jumlah Pelanggaran'];
    const lines = [header.join(',')];

    for (const r of rows) {
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
