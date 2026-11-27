import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashSecret, verifySecret, generateExamToken, encryptTextWithKey } from './security.ts';

const customDbPath = process.env.EXAMFLOW_DB_PATH?.trim();
const dbPath = customDbPath ? path.resolve(customDbPath) : path.resolve(process.cwd(), 'data', 'examflow.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

let cachedPinKeyMaterial: string | null = null;

export function getPinKeyMaterial(): string {
  const envSecret = process.env.EXAMFLOW_QR_SECRET?.trim();
  if (envSecret) return `pin:${envSecret}`;
  if (cachedPinKeyMaterial) return cachedPinKeyMaterial;

  const existing = db
    .prepare('SELECT meta_value FROM system_meta WHERE meta_key = ?')
    .get('pin_cipher_seed') as { meta_value: string } | undefined;

  if (existing?.meta_value) {
    cachedPinKeyMaterial = `pin:${existing.meta_value}`;
    return cachedPinKeyMaterial;
  }

  const generatedSeed = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR IGNORE INTO system_meta (meta_key, meta_value) VALUES (?, ?)').run(
    'pin_cipher_seed',
    generatedSeed
  );
  const saved = db
    .prepare('SELECT meta_value FROM system_meta WHERE meta_key = ?')
    .get('pin_cipher_seed') as { meta_value: string };
  cachedPinKeyMaterial = `pin:${saved.meta_value}`;
  return cachedPinKeyMaterial;
}

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'TEACHER',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      grade_level INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teacher_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      UNIQUE(teacher_id, subject_id, class_id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nis TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      class_id INTEGER NOT NULL,
      pin_hash TEXT NOT NULL,
      pin_encrypted TEXT NOT NULL DEFAULT '',
      pin_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS exam_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      is_active INTEGER NOT NULL DEFAULT 0,
      max_violations INTEGER NOT NULL DEFAULT 3,
      shuffle_questions INTEGER NOT NULL DEFAULT 1,
      shuffle_options INTEGER NOT NULL DEFAULT 1,
      current_token TEXT NOT NULL,
      token_rotated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      package_id INTEGER NOT NULL,
      question_text TEXT NOT NULL,
      question_type TEXT NOT NULL DEFAULT 'MULTIPLE_CHOICE',
      options_json TEXT NOT NULL,
      correct_option TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY (package_id) REFERENCES exam_packages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS exam_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL DEFAULT 'WEB-SIMULATOR',
      session_info TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
      question_order_json TEXT NOT NULL,
      option_orders_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      submitted_at INTEGER,
      violation_count INTEGER NOT NULL DEFAULT 0,
      unlock_bonus INTEGER NOT NULL DEFAULT 0,
      score REAL,
      correct_count INTEGER,
      total_questions INTEGER NOT NULL DEFAULT 0,
      UNIQUE(package_id, student_id),
      FOREIGN KEY (package_id) REFERENCES exam_packages(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS student_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      selected_option TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, question_id),
      FOREIGN KEY (session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS violation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      package_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      violation_type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (package_id) REFERENCES exam_packages(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );
  `);

  // Ensure existing DBs have pin_encrypted column
  const studentColumns = db.prepare(`PRAGMA table_info(students)`).all() as Array<{ name: string }>;
  if (!studentColumns.some((col) => col.name === 'pin_encrypted')) {
    db.exec(`ALTER TABLE students ADD COLUMN pin_encrypted TEXT NOT NULL DEFAULT ''`);
  }

  const teacherCount = (db.prepare('SELECT COUNT(*) as cnt FROM teachers').get() as { cnt: number }).cnt;
  if (teacherCount === 0) {
    seedInitialData();
  } else {
    // Backfill pin_encrypted for seeded students whose PIN is '123456' when migrating existing DB
    const unencrypted = db
      .prepare(`SELECT id, pin_hash FROM students WHERE pin_encrypted = ''`)
      .all() as Array<{ id: number; pin_hash: string }>;
    if (unencrypted.length > 0) {
      const keyMaterial = getPinKeyMaterial();
      const updateEnc = db.prepare(`UPDATE students SET pin_encrypted = ? WHERE id = ?`);
      for (const st of unencrypted) {
        if (verifySecret('123456', st.pin_hash)) {
          updateEnc.run(encryptTextWithKey('123456', keyMaterial), st.id);
        }
      }
    }
  }
}

function seedInitialData(): void {
  const insertTeacher = db.prepare('INSERT INTO teachers (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  const t1 = Number(insertTeacher.run('Budi Santoso, S.Pd.', 'budi.santoso@examflow.sch.id', hashSecret('guru123'), 'ADMIN').lastInsertRowid);
  const t2 = Number(insertTeacher.run('Siti Aminah, M.Pd.', 'siti.aminah@examflow.sch.id', hashSecret('guru123'), 'TEACHER').lastInsertRowid);

  const insertSubject = db.prepare('INSERT INTO subjects (code, name, description) VALUES (?, ?, ?)');
  const sMat = Number(insertSubject.run('MTK', 'Matematika', 'Aljabar, Geometri, Persamaan Linear, dan Statistika').lastInsertRowid);
  const sIpa = Number(insertSubject.run('IPA', 'Ilmu Pengetahuan Alam', 'Fisika Dasar, Biologi Sel, dan Kimia Terapan').lastInsertRowid);
  const sInf = Number(insertSubject.run('INF', 'Informatika', 'Algoritma, Logika Pemrograman, dan Jaringan Komputer').lastInsertRowid);

  const insertClass = db.prepare('INSERT INTO classes (name, grade_level) VALUES (?, ?)');
  const c8a = Number(insertClass.run('8A', 8).lastInsertRowid);
  const c8b = Number(insertClass.run('8B', 8).lastInsertRowid);
  const c9a = Number(insertClass.run('9A', 9).lastInsertRowid);

  // Teacher 1 holds 2 subjects (Matematika & Informatika) across 3 classes (8A, 8B, 9A)
  const insertAssign = db.prepare('INSERT INTO teacher_assignments (teacher_id, subject_id, class_id) VALUES (?, ?, ?)');
  insertAssign.run(t1, sMat, c8a);
  insertAssign.run(t1, sMat, c8b);
  insertAssign.run(t1, sInf, c8a);
  insertAssign.run(t1, sInf, c9a);
  insertAssign.run(t2, sIpa, c8a);
  insertAssign.run(t2, sIpa, c8b);

  // Seed students with hashed semester PINs (Demo PIN: 123456 for quick testing)
  const insertStudent = db.prepare('INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES (?, ?, ?, ?, ?)');
  const demoPinHash = hashSecret('123456');
  const demoPinEncrypted = encryptTextWithKey('123456', getPinKeyMaterial());

  const students8A = [
    ['20260801', 'Ahmad Fauzi'],
    ['20260802', 'Nadia Putri Rahayu'],
    ['20260803', 'Rizky Pratama'],
    ['20260804', 'Zahra Aulia Kusuma'],
    ['20260805', 'Bagas Dwi Saputra'],
    ['20260806', 'Salsa Nabila'],
  ];
  const student8AIds: number[] = [];
  for (const [nis, name] of students8A) {
    student8AIds.push(Number(insertStudent.run(nis, name, c8a, demoPinHash, demoPinEncrypted).lastInsertRowid));
  }

  const students8B = [
    ['20260811', 'Dimas Anggara'],
    ['20260812', 'Kirana Dewi Lestari'],
    ['20260813', 'Fajar Ramadhan'],
    ['20260814', 'Melati Ayu Permata'],
  ];
  for (const [nis, name] of students8B) {
    insertStudent.run(nis, name, c8b, demoPinHash, demoPinEncrypted);
  }

  const students9A = [
    ['20260901', 'Hendra Wijaya'],
    ['20260902', 'Tiara Maharani'],
    ['20260903', 'Galih Permana'],
  ];
  for (const [nis, name] of students9A) {
    insertStudent.run(nis, name, c9a, demoPinHash, demoPinEncrypted);
  }

  // Seed Exam Packages
  const insertPkg = db.prepare(`
    INSERT INTO exam_packages (teacher_id, subject_id, class_id, title, duration_minutes, is_active, max_violations, shuffle_questions, shuffle_options, current_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const p1 = Number(insertPkg.run(t1, sMat, c8a, 'UAS Matematika Kelas 8A — Semester Ganjil', 60, 1, 3, 1, 1, 'MTK8A1').lastInsertRowid);
  const p2 = Number(insertPkg.run(t1, sMat, c8b, 'UAS Matematika Kelas 8B — Semester Ganjil', 60, 0, 3, 1, 1, 'MTK8B2').lastInsertRowid);
  const p3 = Number(insertPkg.run(t1, sInf, c9a, 'PTS Informatika Kelas 9A — Algoritma & Jaringan', 45, 1, 3, 1, 1, 'INF9A3').lastInsertRowid);
  const p4 = Number(insertPkg.run(t2, sIpa, c8a, 'Ujian Harian IPA Terpadu Kelas 8A', 40, 1, 2, 1, 1, generateExamToken()).lastInsertRowid);

  // Seed Question Bank for UAS Matematika 8A (6 rich questions) & cloned to 8B
  const insertQ = db.prepare(`
    INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
    VALUES (?, ?, ?, 'MULTIPLE_CHOICE', ?, ?, ?)
  `);

  const mathQuestions = [
    {
      text: 'Diketahui sistem persamaan linear dua variabel 2x + 3y = 12 dan x - y = 1. Nilai dari x + y adalah...',
      options: [
        { key: 'A', text: '5' },
        { key: 'B', text: '4' },
        { key: 'C', text: '6' },
        { key: 'D', text: '7' },
      ],
      correct: 'A',
      points: 20,
    },
    {
      text: 'Sebuah tangga sepanjang 10 meter disandarkan pada dinding vertikal. Jika jarak ujung bawah tangga ke dinding adalah 6 meter, tinggi dinding yang dicapai ujung atas tangga adalah...',
      options: [
        { key: 'A', text: '7 meter' },
        { key: 'B', text: '8 meter' },
        { key: 'C', text: '9 meter' },
        { key: 'D', text: '12 meter' },
      ],
      correct: 'B',
      points: 20,
    },
    {
      text: 'Gradien garis yang melalui titik A(2, -3) dan titik B(6, 5) adalah...',
      options: [
        { key: 'A', text: '1/2' },
        { key: 'B', text: '-2' },
        { key: 'C', text: '2' },
        { key: 'D', text: '4' },
      ],
      correct: 'C',
      points: 20,
    },
    {
      text: 'Suatu fungsi dirumuskan dengan f(x) = 3x - 5. Jika f(k) = 13, maka nilai k yang memenuhi adalah...',
      options: [
        { key: 'A', text: '4' },
        { key: 'B', text: '5' },
        { key: 'C', text: '6' },
        { key: 'D', text: '8' },
      ],
      correct: 'C',
      points: 20,
    },
    {
      text: 'Keliling sebuah persegi panjang adalah 54 cm. Jika panjangnya 5 cm lebih panjang dari lebarnya, luas persegi panjang tersebut adalah...',
      options: [
        { key: 'A', text: '164 cm²' },
        { key: 'B', text: '176 cm²' },
        { key: 'C', text: '180 cm²' },
        { key: 'D', text: '192 cm²' },
      ],
      correct: 'B',
      points: 20,
    },
  ];

  const mathQIdsP1: number[] = [];
  for (const q of mathQuestions) {
    mathQIdsP1.push(Number(insertQ.run(sMat, p1, q.text, JSON.stringify(q.options), q.correct, q.points).lastInsertRowid));
    insertQ.run(sMat, p2, q.text, JSON.stringify(q.options), q.correct, q.points);
  }

  const infQuestions = [
    {
      text: 'Struktur data yang bekerja dengan prinsip LIFO (Last In, First Out) adalah...',
      options: [
        { key: 'A', text: 'Queue (Antrean)' },
        { key: 'B', text: 'Stack (Tumpukan)' },
        { key: 'C', text: 'Linked List' },
        { key: 'D', text: 'Binary Tree' },
      ],
      correct: 'B',
      points: 25,
    },
    {
      text: 'Protokol standar yang mengenkripsi komunikasi antara aplikasi Exambro Android dan server ujian adalah...',
      options: [
        { key: 'A', text: 'HTTP' },
        { key: 'B', text: 'FTP' },
        { key: 'C', text: 'HTTPS / TLS' },
        { key: 'D', text: 'Telnet' },
      ],
      correct: 'C',
      points: 25,
    },
    {
      text: 'Hasil konversi bilangan biner 10110₂ ke dalam sistem bilangan desimal adalah...',
      options: [
        { key: 'A', text: '20' },
        { key: 'B', text: '22' },
        { key: 'C', text: '24' },
        { key: 'D', text: '26' },
      ],
      correct: 'B',
      points: 25,
    },
    {
      text: 'Dalam algoritma pencarian biner (Binary Search), syarat mutlak yang harus dipenuhi oleh data array adalah...',
      options: [
        { key: 'A', text: 'Data harus dalam keadaan terurut' },
        { key: 'B', text: 'Jumlah elemen harus ganjil' },
        { key: 'C', text: 'Semua nilai harus bilangan bulat' },
        { key: 'D', text: 'Tidak boleh ada angka nol' },
      ],
      correct: 'A',
      points: 25,
    },
  ];

  for (const q of infQuestions) {
    insertQ.run(sInf, p3, q.text, JSON.stringify(q.options), q.correct, q.points);
  }

  const ipaQuestions = [
    {
      text: 'Organel sel yang berfungsi sebagai pusat respirasi seluler dan penghasil energi (ATP) adalah...',
      options: [
        { key: 'A', text: 'Ribosom' },
        { key: 'B', text: 'Mitokondria' },
        { key: 'C', text: 'Lisosom' },
        { key: 'D', text: 'Badan Golgi' },
      ],
      correct: 'B',
      points: 50,
    },
    {
      text: 'Sebuah benda bermassa 4 kg bergerak dengan percepatan 3 m/s². Besar gaya resultan yang bekerja pada benda tersebut adalah...',
      options: [
        { key: 'A', text: '7 N' },
        { key: 'B', text: '12 N' },
        { key: 'C', text: '1,33 N' },
        { key: 'D', text: '24 N' },
      ],
      correct: 'B',
      points: 50,
    },
  ];
  for (const q of ipaQuestions) {
    insertQ.run(sIpa, p4, q.text, JSON.stringify(q.options), q.correct, q.points);
  }

  // Seed realistic initial exam sessions for Paket 1 (UAS Matematika 8A) so Live Monitoring & Recap immediately look alive
  const now = Date.now();
  const insertSession = db.prepare(`
    INSERT INTO exam_sessions (package_id, student_id, session_token, device_id, session_info, status, question_order_json, option_orders_json, started_at, expires_at, submitted_at, violation_count, score, correct_count, total_questions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAnswer = db.prepare(`
    INSERT INTO student_answers (session_id, question_id, selected_option, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertViolation = db.prepare(`
    INSERT INTO violation_logs (session_id, package_id, student_id, violation_type, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const defaultOptOrders = Object.fromEntries(mathQIdsP1.map((qId) => [String(qId), ['B', 'A', 'D', 'C']]));

  // Student 2 (Nadia): SUBMITTED (Score 100)
  const sesNadia = Number(
    insertSession.run(
      p1,
      student8AIds[1],
      'demo-session-nadia-8a',
      'ANDROID-EXAMBRO-8A02',
      'Xiaomi Redmi Note 12 · Exambro v2.4',
      'SUBMITTED',
      JSON.stringify([mathQIdsP1[2], mathQIdsP1[0], mathQIdsP1[4], mathQIdsP1[1], mathQIdsP1[3]]),
      JSON.stringify(defaultOptOrders),
      now - 42 * 60 * 1000,
      now + 18 * 60 * 1000,
      now - 12 * 60 * 1000,
      0,
      100,
      5,
      5
    ).lastInsertRowid
  );
  mathQuestions.forEach((q, idx) => {
    insertAnswer.run(sesNadia, mathQIdsP1[idx], q.correct, now - 15 * 60 * 1000);
  });

  // Student 3 (Rizky): IN_PROGRESS (3/5 answered, 1 minor warning)
  const sesRizky = Number(
    insertSession.run(
      p1,
      student8AIds[2],
      'demo-session-rizky-8a',
      'ANDROID-EXAMBRO-8A03',
      'Samsung Galaxy A15 · Exambro v2.4',
      'IN_PROGRESS',
      JSON.stringify([mathQIdsP1[4], mathQIdsP1[1], mathQIdsP1[0], mathQIdsP1[3], mathQIdsP1[2]]),
      JSON.stringify(defaultOptOrders),
      now - 24 * 60 * 1000,
      now + 36 * 60 * 1000,
      null,
      1,
      null,
      null,
      5
    ).lastInsertRowid
  );
  insertAnswer.run(sesRizky, mathQIdsP1[4], 'B', now - 10 * 60 * 1000);
  insertAnswer.run(sesRizky, mathQIdsP1[1], 'B', now - 7 * 60 * 1000);
  insertAnswer.run(sesRizky, mathQIdsP1[0], 'A', now - 4 * 60 * 1000);
  insertViolation.run(sesRizky, p1, student8AIds[2], 'FOCUS_LOST', 'Notifikasi sistem atau pop-up menginterupsi fokus jendela', now - 8 * 60 * 1000);

  // Student 4 (Zahra): LOCKED_VIOLATION (3/3 violations, waiting for teacher unlock!)
  const sesZahra = Number(
    insertSession.run(
      p1,
      student8AIds[3],
      'demo-session-zahra-8a',
      'ANDROID-EXAMBRO-8A04',
      'OPPO A58 · Exambro v2.4',
      'LOCKED_VIOLATION',
      JSON.stringify([mathQIdsP1[1], mathQIdsP1[3], mathQIdsP1[2], mathQIdsP1[0], mathQIdsP1[4]]),
      JSON.stringify(defaultOptOrders),
      now - 31 * 60 * 1000,
      now + 29 * 60 * 1000,
      null,
      3,
      null,
      null,
      5
    ).lastInsertRowid
  );
  insertAnswer.run(sesZahra, mathQIdsP1[1], 'B', now - 20 * 60 * 1000);
  insertAnswer.run(sesZahra, mathQIdsP1[3], 'C', now - 16 * 60 * 1000);
  insertViolation.run(sesZahra, p1, student8AIds[3], 'FOCUS_LOST', 'Berpindah dari jendela ujian', now - 18 * 60 * 1000);
  insertViolation.run(sesZahra, p1, student8AIds[3], 'SPLIT_SCREEN', 'Deteksi mode layar terpisah pada Android', now - 12 * 60 * 1000);
  insertViolation.run(sesZahra, p1, student8AIds[3], 'EXIT_LOCK_TASK', 'Siswa melepas Lock Task / Pinning Mode Exambro', now - 5 * 60 * 1000);
}
