export interface TeacherProfile {
  id: number;
  name: string;
  email: string;
  role: 'TEACHER' | 'ADMIN';
}

export interface TeacherAssignment {
  id: number;
  subject_id: number;
  class_id: number;
  subject_code: string;
  subject_name: string;
  class_name: string;
  grade_level: number;
}

export interface SubjectItem {
  id: number;
  code: string;
  name: string;
  description: string;
}

export interface ClassItem {
  id: number;
  name: string;
  grade_level: number;
}

export interface ExamPackage {
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
  subject_name: string;
  subject_code: string;
  class_name: string;
  question_count: number;
  class_student_count: number;
  active_count: number;
  locked_count: number;
  submitted_count: number;
}

export interface QrPayloadResponse {
  packageId: number;
  title: string;
  className: string;
  subjectName: string;
  isActive: boolean;
  currentToken: string;
  studentExamUrl: string;
  encryptedPayload: string;
  exambroDeepLink: string;
  qrDataUrl: string;
}

export interface StudentExamRouteParams {
  token?: string;
  nis?: string;
  pin?: string;
  hasExplicitParams: boolean;
}

export interface ResolvedExamPackage {
  id: number;
  title: string;
  subjectName: string;
  className: string;
  durationMinutes: number;
  isActive: boolean;
  maxViolations: number;
  questionCount: number;
}

export interface QuestionOption {
  key: string;
  text: string;
}

export interface TeacherQuestion {
  id: number;
  subject_id: number;
  package_id: number;
  question_text: string;
  question_type: string;
  options: QuestionOption[];
  correct_option: string;
  points: number;
  created_at: string;
}

export interface StudentRecord {
  id: number;
  nis: string;
  name: string;
  class_id: number;
  class_name: string;
  pin_updated_at: string;
  semester_pin?: string | null;
}

export interface ImportStudentsResult {
  summary: {
    totalRows: number;
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    errorCount: number;
  };
  importedPins: Array<{
    nis: string;
    name: string;
    className: string;
    pin: string;
    action: 'CREATED' | 'UPDATED';
  }>;
  skipped: Array<{
    lineNumber: number;
    nis: string;
    name: string;
    reason: string;
  }>;
  errors: Array<{
    lineNumber: number;
    raw: string;
    reason: string;
  }>;
}

export interface ImportQuestionsResult {
  summary: {
    totalRows: number;
    createdCount: number;
    errorCount: number;
  };
  errors: Array<{
    lineNumber: number;
    raw: string;
    reason: string;
  }>;
}

export type SessionStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'LOCKED_VIOLATION' | 'SUBMITTED';

export interface MonitoringStudentRow {
  studentId: number;
  nis: string;
  name: string;
  className: string;
  sessionId: number | null;
  status: SessionStatus;
  deviceId: string | null;
  sessionInfo: string | null;
  startedAt: number | null;
  expiresAt: number | null;
  submittedAt: number | null;
  remainingSeconds: number | null;
  answeredCount: number;
  totalQuestions: number;
  violationCount: number;
  maxViolationsAllowed: number;
  score: number | null;
  correctCount: number | null;
}

export interface ViolationLogRow {
  id: number;
  session_id: number;
  violation_type: string;
  detail: string;
  created_at: number;
  nis: string;
  student_name: string;
}

export interface MonitoringPayload {
  package: {
    id: number;
    title: string;
    subjectName: string;
    className: string;
    durationMinutes: number;
    isActive: boolean;
    maxViolations: number;
    currentToken: string;
    tokenRotatedAt: string;
    totalQuestions: number;
  };
  students: MonitoringStudentRow[];
  recentViolations: ViolationLogRow[];
}

export interface RecapRow {
  nis: string;
  name: string;
  class_name: string;
  status: SessionStatus;
  correct_count: number | null;
  total_questions: number;
  score: number | null;
  violation_count: number;
  submitted_at: number | null;
}

export interface PublicActivePackage {
  id: number;
  title: string;
  durationMinutes: number;
  subjectName: string;
  className: string;
  questionCount: number;
  qrPayload: string;
}

export interface StudentExamQuestion {
  id: number;
  displayNumber: number;
  questionText: string;
  questionType: string;
  points: number;
  options: Array<{
    originalKey: string;
    displayLabel: string;
    text: string;
  }>;
}

export interface StudentExamSessionData {
  status: SessionStatus;
  remainingSeconds: number;
  startedAt?: number;
  expiresAt?: number;
  violationCount: number;
  maxViolationsAllowed: number;
  student: {
    id: number;
    nis: string;
    name: string;
    className?: string;
    class_name?: string;
  };
  package: {
    id: number;
    title: string;
    subjectName: string;
    className: string;
    durationMinutes: number;
    maxViolationsAllowed: number;
  };
  questions: StudentExamQuestion[];
  answers: Record<string, string>;
  result?: {
    score: number;
    correctCount: number;
    totalQuestions: number;
    submittedAt: number;
  };
}
