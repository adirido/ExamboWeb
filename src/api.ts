import { buildApiHeaders, resolveApiUrl } from './lib/supabase';

const EXAMBRO_CLIENT_HEADER = 'ExamFlow-Web-Portal/2.4';

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Respon server tidak valid (${res.status}).`);
  }
  if (!res.ok) {
    const errObj = data as { error?: string; status?: string } | null;
    const err = new Error(errObj?.error || `Permintaan gagal (${res.status})`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = errObj?.status;
    throw err;
  }
  return data as T;
}

export const teacherApi = {
  async login(email: string, password: string) {
    const res = await fetch(resolveApiUrl('/api/auth/login'), {
      method: 'POST',
      headers: buildApiHeaders(null, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email, password }),
    });
    return parseJsonResponse<{ token: string; teacher: import('./types').TeacherProfile }>(res);
  },

  async changePassword(token: string, currentPassword: string, newPassword: string) {
    const res = await fetch(resolveApiUrl('/api/auth/change-password'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return parseJsonResponse<{ success: boolean; message: string }>(res);
  },

  async getContext(token: string) {
    const res = await fetch(resolveApiUrl('/api/teacher/context'), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{
      teacher: import('./types').TeacherProfile;
      assignments: import('./types').TeacherAssignment[];
      subjects: import('./types').SubjectItem[];
      classes: import('./types').ClassItem[];
    }>(res);
  },

  async addAssignment(token: string, subjectId: number, classId: number) {
    const res = await fetch(resolveApiUrl('/api/teacher/assignments'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ subjectId, classId }),
    });
    return parseJsonResponse<{ id: number }>(res);
  },

  async getPackages(token: string) {
    const res = await fetch(resolveApiUrl('/api/packages'), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ packages: import('./types').ExamPackage[] }>(res);
  },

  async createPackage(
    token: string,
    body: {
      title: string;
      subjectId: number;
      classId?: number;
      className?: string;
      durationMinutes: number;
      maxViolations: number;
      shuffleQuestions: boolean;
      shuffleOptions: boolean;
      isActive: boolean;
      initialToken?: string;
      cloneFromPackageId?: number;
    }
  ) {
    const res = await fetch(resolveApiUrl('/api/packages'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ package: import('./types').ExamPackage }>(res);
  },

  async updatePackage(
    token: string,
    id: number,
    body: Partial<{
      title: string;
      subjectId: number;
      classId: number;
      durationMinutes: number;
      maxViolations: number;
      shuffleQuestions: boolean;
      shuffleOptions: boolean;
      isActive: boolean;
    }>
  ) {
    const res = await fetch(resolveApiUrl(`/api/packages/${id}`), {
      method: 'PUT',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ success: boolean }>(res);
  },

  async deletePackage(token: string, id: number) {
    const res = await fetch(resolveApiUrl(`/api/packages/${id}`), {
      method: 'DELETE',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ success: boolean }>(res);
  },

  async getSubjects(token: string) {
    const res = await fetch(resolveApiUrl('/api/subjects'), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ subjects: import('./types').SubjectItem[] }>(res);
  },

  async createSubject(token: string, body: { code: string; name: string; description?: string }) {
    const res = await fetch(resolveApiUrl('/api/subjects'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ subject: import('./types').SubjectItem }>(res);
  },

  async updateSubject(token: string, id: number, body: { code?: string; name?: string; description?: string }) {
    const res = await fetch(resolveApiUrl(`/api/subjects/${id}`), {
      method: 'PUT',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ subject: import('./types').SubjectItem }>(res);
  },

  async deleteSubject(token: string, id: number) {
    const res = await fetch(resolveApiUrl(`/api/subjects/${id}`), {
      method: 'DELETE',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ success: boolean }>(res);
  },

  async getAdminTeachers(token: string) {
    const res = await fetch(resolveApiUrl('/api/admin/teachers'), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ teachers: import('./types').TeacherAccountRecord[] }>(res);
  },

  async createAdminTeacher(
    token: string,
    body: { name: string; email: string; password: string; role: 'TEACHER' | 'ADMIN' }
  ) {
    const res = await fetch(resolveApiUrl('/api/admin/teachers'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ teacher: import('./types').TeacherAccountRecord }>(res);
  },

  async updateAdminTeacher(
    token: string,
    id: number,
    body: { name?: string; email?: string; role?: 'TEACHER' | 'ADMIN'; newPassword?: string }
  ) {
    const res = await fetch(resolveApiUrl(`/api/admin/teachers/${id}`), {
      method: 'PUT',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ teacher: import('./types').TeacherAccountRecord }>(res);
  },

  async resetAdminTeacherPassword(token: string, id: number, customPassword?: string) {
    const res = await fetch(resolveApiUrl(`/api/admin/teachers/${id}/reset-password`), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(customPassword ? { customPassword } : {}),
    });
    return parseJsonResponse<{ teacherId: number; name: string; email: string; newPassword: string }>(res);
  },

  async deleteAdminTeacher(token: string, id: number) {
    const res = await fetch(resolveApiUrl(`/api/admin/teachers/${id}`), {
      method: 'DELETE',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ success: boolean }>(res);
  },

  async importAdminTeachers(token: string, body: { rawText: string; updateExisting: boolean }) {
    const res = await fetch(resolveApiUrl('/api/admin/teachers/import'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<import('./types').ImportTeachersResult>(res);
  },

  async addTeacherAssignmentFor(token: string, teacherId: number, subjectId: number, classId: number) {
    const res = await fetch(resolveApiUrl(`/api/admin/teachers/${teacherId}/assignments`), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ subjectId, classId }),
    });
    return parseJsonResponse<{ id: number }>(res);
  },

  async deleteTeacherAssignment(token: string, assignmentId: number) {
    const res = await fetch(resolveApiUrl(`/api/admin/assignments/${assignmentId}`), {
      method: 'DELETE',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ success: boolean }>(res);
  },

  async togglePackageActive(token: string, id: number) {
    const res = await fetch(resolveApiUrl(`/api/packages/${id}/toggle-active`), {
      method: 'POST',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ packageId: number; isActive: boolean }>(res);
  },

  async rotateToken(token: string, id: number) {
    const res = await fetch(resolveApiUrl(`/api/packages/${id}/rotate-token`), {
      method: 'POST',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ packageId: number; currentToken: string; tokenRotatedAt: string }>(res);
  },

  async getPackageQr(token: string, id: number, baseUrl?: string) {
    const resolvedBase =
      baseUrl || (typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '');
    const query = resolvedBase ? `?baseUrl=${encodeURIComponent(resolvedBase)}` : '';
    const res = await fetch(resolveApiUrl(`/api/packages/${id}/qr${query}`), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<import('./types').QrPayloadResponse>(res);
  },

  async getQuestions(token: string, packageId: number) {
    const res = await fetch(resolveApiUrl(`/api/packages/${packageId}/questions`), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ questions: import('./types').TeacherQuestion[] }>(res);
  },

  async createQuestion(
    token: string,
    packageId: number,
    body: {
      questionText: string;
      options: import('./types').QuestionOption[];
      correctOption: string;
      points: number;
    }
  ) {
    const res = await fetch(resolveApiUrl(`/api/packages/${packageId}/questions`), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ id: number }>(res);
  },

  async importQuestions(
    token: string,
    packageId: number,
    body: { rawText: string; replaceExisting: boolean }
  ) {
    const res = await fetch(resolveApiUrl(`/api/packages/${packageId}/questions/import`), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<import('./types').ImportQuestionsResult>(res);
  },

  async updateQuestion(
    token: string,
    questionId: number,
    body: {
      questionText: string;
      options: import('./types').QuestionOption[];
      correctOption: string;
      points: number;
    }
  ) {
    const res = await fetch(resolveApiUrl(`/api/questions/${questionId}`), {
      method: 'PUT',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ success: boolean }>(res);
  },

  async deleteQuestion(token: string, questionId: number) {
    const res = await fetch(resolveApiUrl(`/api/questions/${questionId}`), {
      method: 'DELETE',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ success: boolean }>(res);
  },

  async getStudents(token: string, classId?: number) {
    const url = classId ? `/api/students?classId=${classId}` : '/api/students';
    const res = await fetch(resolveApiUrl(url), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ students: import('./types').StudentRecord[] }>(res);
  },

  async createStudent(token: string, body: { nis: string; name: string; classId: number; customPin?: string }) {
    const res = await fetch(resolveApiUrl('/api/students'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{ student: import('./types').StudentRecord; generatedPin: string }>(res);
  },

  async resetStudentPin(token: string, studentId: number, customPin?: string) {
    const res = await fetch(resolveApiUrl(`/api/students/${studentId}/reset-pin`), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(customPin ? { customPin } : {}),
    });
    return parseJsonResponse<{ studentId: number; nis: string; name: string; newPin: string }>(res);
  },

  async importStudents(token: string, body: { rawText: string; updateExisting: boolean }) {
    const res = await fetch(resolveApiUrl('/api/students/import'), {
      method: 'POST',
      headers: buildApiHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<import('./types').ImportStudentsResult>(res);
  },

  async getMonitoring(token: string, packageId: number) {
    const res = await fetch(resolveApiUrl(`/api/packages/${packageId}/monitoring`), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<import('./types').MonitoringPayload>(res);
  },

  async unlockSession(token: string, sessionId: number) {
    const res = await fetch(resolveApiUrl(`/api/sessions/${sessionId}/unlock`), {
      method: 'POST',
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{ success: boolean; sessionId: number; status: string }>(res);
  },

  async getRecap(token: string, packageId: number) {
    const res = await fetch(resolveApiUrl(`/api/packages/${packageId}/recap`), {
      headers: buildApiHeaders(token),
    });
    return parseJsonResponse<{
      package: { id: number; title: string; subjectName: string; className: string; totalQuestions: number };
      records: import('./types').RecapRow[];
    }>(res);
  },

  async downloadRecapCsv(token: string, packageId: number, filename: string) {
    const res = await fetch(resolveApiUrl(`/api/packages/${packageId}/recap/csv`), {
      headers: buildApiHeaders(token),
    });
    if (!res.ok) throw new Error('Gagal mengunduh file CSV rekap nilai.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

export const exambroApi = {
  async getPublicActivePackages() {
    const res = await fetch(resolveApiUrl('/api/public/active-packages'), {
      headers: buildApiHeaders(null),
    });
    return parseJsonResponse<{ packages: import('./types').PublicActivePackage[] }>(res);
  },

  async decodeQr(qrPayload: string) {
    const res = await fetch(resolveApiUrl('/api/exambro/decode-qr'), {
      method: 'POST',
      headers: buildApiHeaders(null, {
        'Content-Type': 'application/json',
        'X-Exambro-Client': EXAMBRO_CLIENT_HEADER,
      }),
      body: JSON.stringify({ qrPayload }),
    });
    return parseJsonResponse<{
      package: import('./types').ResolvedExamPackage;
    }>(res);
  },

  async resolveToken(tokenUjian: string) {
    const res = await fetch(resolveApiUrl('/api/exambro/resolve-token'), {
      method: 'POST',
      headers: buildApiHeaders(null, {
        'Content-Type': 'application/json',
        'X-Exambro-Client': EXAMBRO_CLIENT_HEADER,
      }),
      body: JSON.stringify({ tokenUjian }),
    });
    return parseJsonResponse<{
      package: import('./types').ResolvedExamPackage;
    }>(res);
  },

  async verifyEntry(body: {
    qrPayload?: string;
    packageId?: number;
    tokenUjian: string;
    nis: string;
    pinSemester: string;
    deviceId: string;
    sessionInfo: string;
  }) {
    const res = await fetch(resolveApiUrl('/api/exambro/verify'), {
      method: 'POST',
      headers: buildApiHeaders(null, {
        'Content-Type': 'application/json',
        'X-Exambro-Client': EXAMBRO_CLIENT_HEADER,
      }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse<{
      sessionToken: string;
      resumed: boolean;
      status: string;
      remainingSeconds: number;
    }>(res);
  },

  async getExamSession(sessionToken: string) {
    const res = await fetch(resolveApiUrl('/api/exam/session'), {
      headers: buildApiHeaders(sessionToken, {
        'X-Exambro-Client': EXAMBRO_CLIENT_HEADER,
      }),
    });
    return parseJsonResponse<import('./types').StudentExamSessionData>(res);
  },

  async saveAnswer(sessionToken: string, questionId: number, selectedOption: string) {
    const res = await fetch(resolveApiUrl('/api/exam/answer'), {
      method: 'POST',
      headers: buildApiHeaders(sessionToken, {
        'Content-Type': 'application/json',
        'X-Exambro-Client': EXAMBRO_CLIENT_HEADER,
      }),
      body: JSON.stringify({ questionId, selectedOption }),
    });
    return parseJsonResponse<{ saved: boolean; answeredCount: number; remainingSeconds: number }>(res);
  },

  async reportViolation(sessionToken: string, violationType: string, detail: string) {
    const res = await fetch(resolveApiUrl('/api/exam/violation'), {
      method: 'POST',
      headers: buildApiHeaders(sessionToken, {
        'Content-Type': 'application/json',
        'X-Exambro-Client': EXAMBRO_CLIENT_HEADER,
      }),
      body: JSON.stringify({ violationType, detail }),
    });
    return parseJsonResponse<{
      status: string;
      violationCount: number;
      maxViolationsAllowed: number;
      locked: boolean;
    }>(res);
  },

  async submitExam(sessionToken: string) {
    const res = await fetch(resolveApiUrl('/api/exam/submit'), {
      method: 'POST',
      headers: buildApiHeaders(sessionToken, {
        'X-Exambro-Client': EXAMBRO_CLIENT_HEADER,
      }),
    });
    return parseJsonResponse<{
      status: string;
      score: number;
      correctCount: number;
      totalQuestions: number;
    }>(res);
  },
};
