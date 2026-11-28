-- ExamFlow Pro: PostgreSQL Schema & Initial Seed for Supabase
-- Jalankan melalui Supabase CLI (`supabase db push`) atau SQL Editor di Dashboard Supabase.

CREATE TABLE IF NOT EXISTS system_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teachers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  nip TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'TEACHER' CHECK (role IN ('TEACHER', 'ADMIN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subjects (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS classes (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  grade_level INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teacher_assignments (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  UNIQUE(teacher_id, subject_id, class_id)
);

CREATE TABLE IF NOT EXISTS students (
  id BIGSERIAL PRIMARY KEY,
  nis TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL,
  pin_encrypted TEXT NOT NULL DEFAULT '',
  pin_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_packages (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  proctor_id BIGINT REFERENCES teachers(id) ON DELETE SET NULL,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  exam_date TEXT NOT NULL DEFAULT '',
  kkm INTEGER NOT NULL DEFAULT 75,
  schedule_group TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  is_active INTEGER NOT NULL DEFAULT 0,
  max_violations INTEGER NOT NULL DEFAULT 3,
  shuffle_questions INTEGER NOT NULL DEFAULT 1,
  shuffle_options INTEGER NOT NULL DEFAULT 1,
  current_token TEXT NOT NULL,
  token_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id BIGSERIAL PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  package_id BIGINT NOT NULL REFERENCES exam_packages(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  question_type TEXT NOT NULL DEFAULT 'MULTIPLE_CHOICE',
  options_json TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_sessions (
  id BIGSERIAL PRIMARY KEY,
  package_id BIGINT NOT NULL REFERENCES exam_packages(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL DEFAULT 'WEB-SIMULATOR',
  session_info TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'LOCKED_VIOLATION', 'SUBMITTED')),
  question_order_json TEXT NOT NULL,
  option_orders_json TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  submitted_at BIGINT,
  violation_count INTEGER NOT NULL DEFAULT 0,
  unlock_bonus INTEGER NOT NULL DEFAULT 0,
  score DOUBLE PRECISION,
  correct_count INTEGER,
  total_questions INTEGER NOT NULL DEFAULT 0,
  UNIQUE(package_id, student_id)
);

CREATE TABLE IF NOT EXISTS student_answers (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_option TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(session_id, question_id)
);

CREATE TABLE IF NOT EXISTS violation_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  package_id BIGINT NOT NULL REFERENCES exam_packages(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  violation_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_students_class_id ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_exam_packages_teacher_id ON exam_packages(teacher_id);
CREATE INDEX IF NOT EXISTS idx_questions_package_id ON questions(package_id);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_package_id ON exam_sessions(package_id);
CREATE INDEX IF NOT EXISTS idx_student_answers_session_id ON student_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_violation_logs_package_created ON violation_logs(package_id, created_at DESC);

-- Aktifkan Row Level Security di seluruh tabel.
-- Semua akses data dikontrol melalui Supabase Edge Function menggunakan service_role key
-- sehingga kunci jawaban, token ujian aktif, session_token, dan hash kredensial tidak pernah terekspos ke klien anon.
ALTER TABLE system_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE violation_logs ENABLE ROW LEVEL SECURITY;

-- Seed awal idempoten (hanya dijalankan jika tabel teachers masih kosong)
DO $$
DECLARE
  t1 BIGINT;
  t2 BIGINT;
  s_mat BIGINT;
  s_ipa BIGINT;
  s_inf BIGINT;
  c_8a BIGINT;
  c_8b BIGINT;
  c_9a BIGINT;
  p1 BIGINT;
  p2 BIGINT;
  p3 BIGINT;
  p4 BIGINT;
  st_nadia BIGINT;
  st_rizky BIGINT;
  st_zahra BIGINT;
  q_m1 BIGINT;
  q_m2 BIGINT;
  q_m3 BIGINT;
  q_m4 BIGINT;
  q_m5 BIGINT;
  ses_nadia BIGINT;
  ses_rizky BIGINT;
  ses_zahra BIGINT;
  now_ms BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
  budi_hash TEXT := '1054e2e19fc591cd3701f76a97f1aed1:2cf1cd79c51ba17a8e1aec3eb349c7fedb1a45bdb00974dc7f34779bef58d89e39904d1acd03e29da11527d0ca010203e4a7e8373441c759f7eabe38de69f71a';
  siti_hash TEXT := '63a19183a71c33ba1c0cc6cb4b70d701:d258024ef1db65df26b3fb5f25771e0bfc2f6891feddb867f4ab62ac456118963aedf831b745575a429240364779de5529b457c7436562dc7d16148a47caff1a';
  pin_hash TEXT := 'a18e47fdcbb06e52bba4d614ab84c498:dd02ae0cae08e5c6bb66baf4edeb8c45be5b99a210496a2d97e5cb7af595767c133701716579b97296416df392a7d22f9aba1afd655ba69b1481c5b3bbffb3cf';
  opt_orders TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM teachers) THEN
    RETURN;
  END IF;

  INSERT INTO teachers (name, nip, password_hash, role)
  VALUES ('Budi Santoso, S.Pd.', '252500', budi_hash, 'ADMIN')
  RETURNING id INTO t1;

  INSERT INTO teachers (name, nip, password_hash, role)
  VALUES ('Siti Aminah, M.Pd.', '252501', siti_hash, 'TEACHER')
  RETURNING id INTO t2;

  INSERT INTO subjects (code, name, description)
  VALUES ('MTK', 'Matematika', 'Aljabar, Geometri, Persamaan Linear, dan Statistika')
  RETURNING id INTO s_mat;

  INSERT INTO subjects (code, name, description)
  VALUES ('IPA', 'Ilmu Pengetahuan Alam', 'Fisika Dasar, Biologi Sel, dan Kimia Terapan')
  RETURNING id INTO s_ipa;

  INSERT INTO subjects (code, name, description)
  VALUES ('INF', 'Informatika', 'Algoritma, Logika Pemrograman, dan Jaringan Komputer')
  RETURNING id INTO s_inf;

  INSERT INTO classes (name, grade_level) VALUES ('8A', 8) RETURNING id INTO c_8a;
  INSERT INTO classes (name, grade_level) VALUES ('8B', 8) RETURNING id INTO c_8b;
  INSERT INTO classes (name, grade_level) VALUES ('9A', 9) RETURNING id INTO c_9a;

  INSERT INTO teacher_assignments (teacher_id, subject_id, class_id) VALUES
    (t1, s_mat, c_8a),
    (t1, s_mat, c_8b),
    (t1, s_inf, c_8a),
    (t1, s_inf, c_9a),
    (t2, s_ipa, c_8a),
    (t2, s_ipa, c_8b);

  -- Siswa Kelas 8A (PIN default 123456; pin_encrypted akan diisi otomatis saat Edge Function membaca)
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES ('20260801', 'Ahmad Fauzi', c_8a, pin_hash, '');
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES ('20260802', 'Nadia Putri Rahayu', c_8a, pin_hash, '') RETURNING id INTO st_nadia;
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES ('20260803', 'Rizky Pratama', c_8a, pin_hash, '') RETURNING id INTO st_rizky;
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES ('20260804', 'Zahra Aulia Kusuma', c_8a, pin_hash, '') RETURNING id INTO st_zahra;
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES ('20260805', 'Bagas Dwi Saputra', c_8a, pin_hash, '');
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES ('20260806', 'Salsa Nabila', c_8a, pin_hash, '');

  -- Siswa Kelas 8B
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES
    ('20260811', 'Dimas Anggara', c_8b, pin_hash, ''),
    ('20260812', 'Kirana Dewi Lestari', c_8b, pin_hash, ''),
    ('20260813', 'Fajar Ramadhan', c_8b, pin_hash, ''),
    ('20260814', 'Melati Ayu Permata', c_8b, pin_hash, '');

  -- Siswa Kelas 9A
  INSERT INTO students (nis, name, class_id, pin_hash, pin_encrypted) VALUES
    ('20260901', 'Hendra Wijaya', c_9a, pin_hash, ''),
    ('20260902', 'Tiara Maharani', c_9a, pin_hash, ''),
    ('20260903', 'Galih Permana', c_9a, pin_hash, '');

  -- Paket Ujian
  INSERT INTO exam_packages (teacher_id, subject_id, class_id, title, duration_minutes, is_active, max_violations, shuffle_questions, shuffle_options, current_token)
  VALUES (t1, s_mat, c_8a, 'UAS Matematika Kelas 8A — Semester Ganjil', 60, 1, 3, 1, 1, 'MTK8A1')
  RETURNING id INTO p1;

  INSERT INTO exam_packages (teacher_id, subject_id, class_id, title, duration_minutes, is_active, max_violations, shuffle_questions, shuffle_options, current_token)
  VALUES (t1, s_mat, c_8b, 'UAS Matematika Kelas 8B — Semester Ganjil', 60, 0, 3, 1, 1, 'MTK8B2')
  RETURNING id INTO p2;

  INSERT INTO exam_packages (teacher_id, subject_id, class_id, title, duration_minutes, is_active, max_violations, shuffle_questions, shuffle_options, current_token)
  VALUES (t1, s_inf, c_9a, 'PTS Informatika Kelas 9A — Algoritma & Jaringan', 45, 1, 3, 1, 1, 'INF9A3')
  RETURNING id INTO p3;

  INSERT INTO exam_packages (teacher_id, subject_id, class_id, title, duration_minutes, is_active, max_violations, shuffle_questions, shuffle_options, current_token)
  VALUES (t2, s_ipa, c_8a, 'Ujian Harian IPA Terpadu Kelas 8A', 40, 1, 2, 1, 1, 'IPA8A4')
  RETURNING id INTO p4;

  -- Soal Matematika Paket 1 & klon Paket 2
  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
  VALUES (s_mat, p1, 'Diketahui sistem persamaan linear dua variabel 2x + 3y = 12 dan x - y = 1. Nilai dari x + y adalah...', 'MULTIPLE_CHOICE',
    '[{"key":"A","text":"5"},{"key":"B","text":"4"},{"key":"C","text":"6"},{"key":"D","text":"7"}]', 'A', 20)
  RETURNING id INTO q_m1;

  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
  VALUES (s_mat, p1, 'Sebuah tangga sepanjang 10 meter disandarkan pada dinding vertikal. Jika jarak ujung bawah tangga ke dinding adalah 6 meter, tinggi dinding yang dicapai ujung atas tangga adalah...', 'MULTIPLE_CHOICE',
    '[{"key":"A","text":"7 meter"},{"key":"B","text":"8 meter"},{"key":"C","text":"9 meter"},{"key":"D","text":"12 meter"}]', 'B', 20)
  RETURNING id INTO q_m2;

  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
  VALUES (s_mat, p1, 'Gradien garis yang melalui titik A(2, -3) dan titik B(6, 5) adalah...', 'MULTIPLE_CHOICE',
    '[{"key":"A","text":"1/2"},{"key":"B","text":"-2"},{"key":"C","text":"2"},{"key":"D","text":"4"}]', 'C', 20)
  RETURNING id INTO q_m3;

  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
  VALUES (s_mat, p1, 'Suatu fungsi dirumuskan dengan f(x) = 3x - 5. Jika f(k) = 13, maka nilai k yang memenuhi adalah...', 'MULTIPLE_CHOICE',
    '[{"key":"A","text":"4"},{"key":"B","text":"5"},{"key":"C","text":"6"},{"key":"D","text":"8"}]', 'C', 20)
  RETURNING id INTO q_m4;

  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
  VALUES (s_mat, p1, 'Keliling sebuah persegi panjang adalah 54 cm. Jika panjangnya 5 cm lebih panjang dari lebarnya, luas persegi panjang tersebut adalah...', 'MULTIPLE_CHOICE',
    '[{"key":"A","text":"164 cm²"},{"key":"B","text":"176 cm²"},{"key":"C","text":"180 cm²"},{"key":"D","text":"192 cm²"}]', 'B', 20)
  RETURNING id INTO q_m5;

  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points)
  SELECT subject_id, p2, question_text, question_type, options_json, correct_option, points
  FROM questions WHERE package_id = p1 ORDER BY id ASC;

  -- Soal Informatika Paket 3
  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points) VALUES
    (s_inf, p3, 'Struktur data yang bekerja dengan prinsip LIFO (Last In, First Out) adalah...', 'MULTIPLE_CHOICE', '[{"key":"A","text":"Queue (Antrean)"},{"key":"B","text":"Stack (Tumpukan)"},{"key":"C","text":"Linked List"},{"key":"D","text":"Binary Tree"}]', 'B', 25),
    (s_inf, p3, 'Protokol standar yang mengenkripsi komunikasi antara aplikasi Exambro Android dan server ujian adalah...', 'MULTIPLE_CHOICE', '[{"key":"A","text":"HTTP"},{"key":"B","text":"FTP"},{"key":"C","text":"HTTPS / TLS"},{"key":"D","text":"Telnet"}]', 'C', 25),
    (s_inf, p3, 'Hasil konversi bilangan biner 10110₂ ke dalam sistem bilangan desimal adalah...', 'MULTIPLE_CHOICE', '[{"key":"A","text":"20"},{"key":"B","text":"22"},{"key":"C","text":"24"},{"key":"D","text":"26"}]', 'B', 25),
    (s_inf, p3, 'Dalam algoritma pencarian biner (Binary Search), syarat mutlak yang harus dipenuhi oleh data array adalah...', 'MULTIPLE_CHOICE', '[{"key":"A","text":"Data harus dalam keadaan terurut"},{"key":"B","text":"Jumlah elemen harus ganjil"},{"key":"C","text":"Semua nilai harus bilangan bulat"},{"key":"D","text":"Tidak boleh ada angka nol"}]', 'A', 25);

  -- Soal IPA Paket 4
  INSERT INTO questions (subject_id, package_id, question_text, question_type, options_json, correct_option, points) VALUES
    (s_ipa, p4, 'Organel sel yang berfungsi sebagai pusat respirasi seluler dan penghasil energi (ATP) adalah...', 'MULTIPLE_CHOICE', '[{"key":"A","text":"Ribosom"},{"key":"B","text":"Mitokondria"},{"key":"C","text":"Lisosom"},{"key":"D","text":"Badan Golgi"}]', 'B', 50),
    (s_ipa, p4, 'Sebuah benda bermassa 4 kg bergerak dengan percepatan 3 m/s². Besar gaya resultan yang bekerja pada benda tersebut adalah...', 'MULTIPLE_CHOICE', '[{"key":"A","text":"7 N"},{"key":"B","text":"12 N"},{"key":"C","text":"1,33 N"},{"key":"D","text":"24 N"}]', 'B', 50);

  opt_orders := json_build_object(
    q_m1::TEXT, ARRAY['B','A','D','C'],
    q_m2::TEXT, ARRAY['B','A','D','C'],
    q_m3::TEXT, ARRAY['B','A','D','C'],
    q_m4::TEXT, ARRAY['B','A','D','C'],
    q_m5::TEXT, ARRAY['B','A','D','C']
  )::TEXT;

  -- Seed sesi ujian agar Live Monitoring & Rekap langsung terisi
  INSERT INTO exam_sessions (package_id, student_id, session_token, device_id, session_info, status, question_order_json, option_orders_json, started_at, expires_at, submitted_at, violation_count, score, correct_count, total_questions)
  VALUES (p1, st_nadia, 'demo-session-nadia-8a', 'ANDROID-EXAMBRO-8A02', 'Xiaomi Redmi Note 12 · Exambro v2.4', 'SUBMITTED',
    json_build_array(q_m3, q_m1, q_m5, q_m2, q_m4)::TEXT, opt_orders,
    now_ms - 42*60*1000, now_ms + 18*60*1000, now_ms - 12*60*1000, 0, 100, 5, 5)
  RETURNING id INTO ses_nadia;

  INSERT INTO student_answers (session_id, question_id, selected_option, updated_at) VALUES
    (ses_nadia, q_m1, 'A', now_ms - 15*60*1000),
    (ses_nadia, q_m2, 'B', now_ms - 15*60*1000),
    (ses_nadia, q_m3, 'C', now_ms - 15*60*1000),
    (ses_nadia, q_m4, 'C', now_ms - 15*60*1000),
    (ses_nadia, q_m5, 'B', now_ms - 15*60*1000);

  INSERT INTO exam_sessions (package_id, student_id, session_token, device_id, session_info, status, question_order_json, option_orders_json, started_at, expires_at, submitted_at, violation_count, score, correct_count, total_questions)
  VALUES (p1, st_rizky, 'demo-session-rizky-8a', 'ANDROID-EXAMBRO-8A03', 'Samsung Galaxy A15 · Exambro v2.4', 'IN_PROGRESS',
    json_build_array(q_m5, q_m2, q_m1, q_m4, q_m3)::TEXT, opt_orders,
    now_ms - 24*60*1000, now_ms + 36*60*1000, NULL, 1, NULL, NULL, 5)
  RETURNING id INTO ses_rizky;

  INSERT INTO student_answers (session_id, question_id, selected_option, updated_at) VALUES
    (ses_rizky, q_m5, 'B', now_ms - 10*60*1000),
    (ses_rizky, q_m2, 'B', now_ms - 7*60*1000),
    (ses_rizky, q_m1, 'A', now_ms - 4*60*1000);

  INSERT INTO violation_logs (session_id, package_id, student_id, violation_type, detail, created_at)
  VALUES (ses_rizky, p1, st_rizky, 'FOCUS_LOST', 'Notifikasi sistem atau pop-up menginterupsi fokus jendela', now_ms - 8*60*1000);

  INSERT INTO exam_sessions (package_id, student_id, session_token, device_id, session_info, status, question_order_json, option_orders_json, started_at, expires_at, submitted_at, violation_count, score, correct_count, total_questions)
  VALUES (p1, st_zahra, 'demo-session-zahra-8a', 'ANDROID-EXAMBRO-8A04', 'OPPO A58 · Exambro v2.4', 'LOCKED_VIOLATION',
    json_build_array(q_m2, q_m4, q_m3, q_m1, q_m5)::TEXT, opt_orders,
    now_ms - 31*60*1000, now_ms + 29*60*1000, NULL, 3, NULL, NULL, 5)
  RETURNING id INTO ses_zahra;

  INSERT INTO student_answers (session_id, question_id, selected_option, updated_at) VALUES
    (ses_zahra, q_m2, 'B', now_ms - 20*60*1000),
    (ses_zahra, q_m4, 'C', now_ms - 16*60*1000);

  INSERT INTO violation_logs (session_id, package_id, student_id, violation_type, detail, created_at) VALUES
    (ses_zahra, p1, st_zahra, 'FOCUS_LOST', 'Berpindah dari jendela ujian', now_ms - 18*60*1000),
    (ses_zahra, p1, st_zahra, 'SPLIT_SCREEN', 'Deteksi mode layar terpisah pada Android', now_ms - 12*60*1000),
    (ses_zahra, p1, st_zahra, 'EXIT_LOCK_TASK', 'Siswa melepas Lock Task / Pinning Mode Exambro', now_ms - 5*60*1000);
END $$;
