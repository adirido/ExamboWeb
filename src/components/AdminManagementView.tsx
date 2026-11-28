import React, { useEffect, useRef, useState } from 'react';
import {
  UserCog,
  Plus,
  Search,
  Pencil,
  KeyRound,
  Trash2,
  X,
  Copy,
  Check,
  Upload,
  Download,
  BookOpen,
  FileSpreadsheet,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Users,
  Link2,
  GraduationCap,
} from 'lucide-react';
import { teacherApi } from '../api';
import type {
  ClassItem,
  ImportTeachersResult,
  SubjectItem,
  TeacherAccountRecord,
} from '../types';

interface AdminManagementViewProps {
  token: string;
  currentTeacherId: number;
  subjects: SubjectItem[];
  classes: ClassItem[];
  onContextChanged: () => Promise<void>;
}

const TEACHER_CSV_SAMPLE = [
  'Ahmad Fauzi,ahmad.fauzi@examflow.sch.id,TEACHER,',
  'Dewi Kartika,dewi.kartika@examflow.sch.id,TEACHER,guru2026',
  'Rizky Pratama,rizky.pratama@examflow.sch.id,ADMIN,',
].join('\n');

const TEACHER_CSV_TEMPLATE = [
  'Nama Lengkap,Email,Role,Password (Opsional)',
  'Ahmad Fauzi,ahmad.fauzi@examflow.sch.id,TEACHER,',
  'Dewi Kartika,dewi.kartika@examflow.sch.id,TEACHER,guru2026',
  'Rizky Pratama,rizky.pratama@examflow.sch.id,ADMIN,',
].join('\n');

export const AdminManagementView: React.FC<AdminManagementViewProps> = ({
  token,
  currentTeacherId,
  subjects: contextSubjects,
  classes,
  onContextChanged,
}) => {
  const [subTab, setSubTab] = useState<'teachers' | 'subjects' | 'classes'>('teachers');

  // Teachers state
  const [teachers, setTeachers] = useState<TeacherAccountRecord[]>([]);
  const [loadingTeachers, setLoadingTeachers] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | 'ADMIN' | 'TEACHER'>('ALL');
  const [teacherFeedback, setTeacherFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteTeacherId, setConfirmDeleteTeacherId] = useState<number | null>(null);
  const [busyTeacherId, setBusyTeacherId] = useState<number | null>(null);

  // Add / Edit Teacher Modal
  const [showTeacherModal, setShowTeacherModal] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState<TeacherAccountRecord | null>(null);
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formRole, setFormRole] = useState<'TEACHER' | 'ADMIN'>('TEACHER');
  const [formPassword, setFormPassword] = useState('');
  const [teacherModalError, setTeacherModalError] = useState<string | null>(null);
  const [savingTeacher, setSavingTeacher] = useState(false);

  // Reset Password Modal
  const [resetTarget, setResetTarget] = useState<TeacherAccountRecord | null>(null);
  const [customResetPassword, setCustomResetPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<{
    name: string;
    email: string;
    password: string;
    title: string;
  } | null>(null);
  const [copiedCredential, setCopiedCredential] = useState(false);

  // Assign Subject/Class Modal
  const [assignTarget, setAssignTarget] = useState<TeacherAccountRecord | null>(null);
  const [assignSubjectId, setAssignSubjectId] = useState<number>(contextSubjects[0]?.id || 1);
  const [assignClassId, setAssignClassId] = useState<number>(classes[0]?.id || 1);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [savingAssign, setSavingAssign] = useState(false);

  // Import CSV Modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importModalTab, setImportModalTab] = useState<'input' | 'result'>('input');
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportTeachersResult | null>(null);
  const [copiedBatchCreds, setCopiedBatchCreds] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Subjects state
  const [subjects, setSubjects] = useState<SubjectItem[]>(contextSubjects);
  const [loadingSubjects, setLoadingSubjects] = useState(true);
  const [subjectFeedback, setSubjectFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteSubjectId, setConfirmDeleteSubjectId] = useState<number | null>(null);
  const [busySubjectId, setBusySubjectId] = useState<number | null>(null);

  // Add / Edit Subject Modal
  const [showSubjectModal, setShowSubjectModal] = useState(false);
  const [editingSubject, setEditingSubject] = useState<SubjectItem | null>(null);
  const [subjCode, setSubjCode] = useState('');
  const [subjName, setSubjName] = useState('');
  const [subjDesc, setSubjDesc] = useState('');
  const [subjectModalError, setSubjectModalError] = useState<string | null>(null);
  const [savingSubject, setSavingSubject] = useState(false);

  // Classes state
  const [classesList, setClassesList] = useState<ClassItem[]>(classes);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [classFeedback, setClassFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteClassId, setConfirmDeleteClassId] = useState<number | null>(null);
  const [busyClassId, setBusyClassId] = useState<number | null>(null);

  // Add / Edit Class Modal
  const [showClassModal, setShowClassModal] = useState(false);
  const [editingClass, setEditingClass] = useState<ClassItem | null>(null);
  const [classNameInput, setClassNameInput] = useState('');
  const [classGradeInput, setClassGradeInput] = useState<number>(8);
  const [classModalError, setClassModalError] = useState<string | null>(null);
  const [savingClass, setSavingClass] = useState(false);

  async function loadTeachers() {
    setLoadingTeachers(true);
    try {
      const res = await teacherApi.getAdminTeachers(token);
      setTeachers(res.teachers);
    } catch (err) {
      setTeacherFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal memuat daftar akun guru.',
      });
    } finally {
      setLoadingTeachers(false);
    }
  }

  async function loadSubjects() {
    setLoadingSubjects(true);
    try {
      const res = await teacherApi.getSubjects(token);
      setSubjects(res.subjects);
    } catch (err) {
      setSubjectFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal memuat daftar mata pelajaran.',
      });
    } finally {
      setLoadingSubjects(false);
    }
  }

  async function loadClasses() {
    setLoadingClasses(true);
    try {
      const res = await teacherApi.getClasses(token);
      setClassesList(res.classes);
    } catch (err) {
      setClassFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal memuat daftar kelas sekolah.',
      });
    } finally {
      setLoadingClasses(false);
    }
  }

  useEffect(() => {
    loadTeachers();
    loadSubjects();
    loadClasses();
  }, [token]);

  useEffect(() => {
    if (subjects.length > 0 && !subjects.some((s) => s.id === assignSubjectId)) {
      setAssignSubjectId(subjects[0].id);
    }
  }, [subjects]);

  useEffect(() => {
    if (classes.length > 0 && !classes.some((c) => c.id === assignClassId)) {
      setAssignClassId(classes[0].id);
    }
  }, [classes]);

  // --- Teacher CRUD Handlers ---
  function openCreateTeacherModal() {
    setEditingTeacher(null);
    setFormName('');
    setFormEmail('');
    setFormRole('TEACHER');
    setFormPassword('');
    setTeacherModalError(null);
    setShowTeacherModal(true);
  }

  function openEditTeacherModal(t: TeacherAccountRecord) {
    setEditingTeacher(t);
    setFormName(t.name);
    setFormEmail(t.email);
    setFormRole(t.role);
    setFormPassword('');
    setTeacherModalError(null);
    setShowTeacherModal(true);
  }

  async function handleSaveTeacher(e: React.FormEvent) {
    e.preventDefault();
    setTeacherModalError(null);
    setSavingTeacher(true);
    try {
      if (editingTeacher) {
        await teacherApi.updateAdminTeacher(token, editingTeacher.id, {
          name: formName.trim(),
          email: formEmail.trim().toLowerCase(),
          role: formRole,
          ...(formPassword.trim() ? { newPassword: formPassword } : {}),
        });
        setShowTeacherModal(false);
        setTeacherFeedback({ type: 'ok', text: `Data akun "${formName.trim()}" berhasil diperbarui.` });
        await loadTeachers();
        await onContextChanged();
      } else {
        if (formPassword.length < 6) {
          setTeacherModalError('Kata sandi awal minimal 6 karakter.');
          setSavingTeacher(false);
          return;
        }
        await teacherApi.createAdminTeacher(token, {
          name: formName.trim(),
          email: formEmail.trim().toLowerCase(),
          password: formPassword,
          role: formRole,
        });
        setShowTeacherModal(false);
        setRevealedCredential({
          name: formName.trim(),
          email: formEmail.trim().toLowerCase(),
          password: formPassword,
          title: 'Akun Guru Baru Berhasil Dibuat',
        });
        await loadTeachers();
      }
    } catch (err) {
      setTeacherModalError(err instanceof Error ? err.message : 'Gagal menyimpan data guru.');
    } finally {
      setSavingTeacher(false);
    }
  }

  async function handleDeleteTeacher(id: number) {
    setBusyTeacherId(id);
    setTeacherFeedback(null);
    try {
      await teacherApi.deleteAdminTeacher(token, id);
      setConfirmDeleteTeacherId(null);
      setTeacherFeedback({ type: 'ok', text: 'Akun guru berhasil dihapus.' });
      await loadTeachers();
    } catch (err) {
      setTeacherFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal menghapus akun guru.',
      });
    } finally {
      setBusyTeacherId(null);
    }
  }

  // --- Password Reset Handlers ---
  function openResetPasswordModal(t: TeacherAccountRecord) {
    setResetTarget(t);
    setCustomResetPassword('');
    setResetError(null);
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    const trimmed = customResetPassword.trim();
    if (trimmed && (trimmed.length < 6 || trimmed.length > 128)) {
      setResetError('Kata sandi khusus harus terdiri dari 6–128 karakter.');
      return;
    }

    setResettingPassword(true);
    setResetError(null);
    try {
      const res = await teacherApi.resetAdminTeacherPassword(token, resetTarget.id, trimmed || undefined);
      setResetTarget(null);
      setRevealedCredential({
        name: res.name,
        email: res.email,
        password: res.newPassword,
        title: 'Kata Sandi Guru Berhasil Direset',
      });
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Gagal mereset kata sandi guru.');
    } finally {
      setResettingPassword(false);
    }
  }

  // --- Assignment Handlers ---
  function openAssignModal(t: TeacherAccountRecord) {
    setAssignTarget(t);
    setAssignError(null);
    if (subjects[0]) setAssignSubjectId(subjects[0].id);
    if (classes[0]) setAssignClassId(classes[0].id);
  }

  async function handleAddAssignment(e: React.FormEvent) {
    e.preventDefault();
    if (!assignTarget) return;
    setSavingAssign(true);
    setAssignError(null);
    try {
      await teacherApi.addTeacherAssignmentFor(token, assignTarget.id, assignSubjectId, assignClassId);
      setAssignTarget(null);
      setTeacherFeedback({
        type: 'ok',
        text: `Penugasan mapel/kelas ditambahkan untuk ${assignTarget.name}.`,
      });
      await loadTeachers();
      await onContextChanged();
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : 'Gagal menambahkan penugasan.');
    } finally {
      setSavingAssign(false);
    }
  }

  async function handleRemoveAssignment(assignmentId: number) {
    setTeacherFeedback(null);
    try {
      await teacherApi.deleteTeacherAssignment(token, assignmentId);
      await loadTeachers();
      await onContextChanged();
    } catch (err) {
      setTeacherFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal menghapus penugasan.',
      });
    }
  }

  // --- CSV Import Handlers ---
  function openImportModal() {
    setImportError(null);
    setImportResult(null);
    setImportFileName(null);
    setImportModalTab('input');
    setShowImportModal(true);
  }

  function handleDownloadTemplate() {
    const blob = new Blob(['\uFEFF' + TEACHER_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'template-import-guru-examflow.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    setImportError(null);
    try {
      const content = await file.text();
      setImportText(content);
    } catch {
      setImportError('Gagal membaca file CSV yang dipilih.');
    } finally {
      e.target.value = '';
    }
  }

  async function handleImportTeachersSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!importText.trim()) {
      setImportError('Tempel data guru atau unggah file CSV terlebih dahulu.');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const res = await teacherApi.importAdminTeachers(token, {
        rawText: importText,
        updateExisting,
      });
      setImportResult(res);
      setImportModalTab('result');
      await loadTeachers();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Gagal mengimpor data guru.');
    } finally {
      setImporting(false);
    }
  }

  function handleCopyBatchCredentials() {
    if (!importResult || importResult.importedCredentials.length === 0) return;
    const text = importResult.importedCredentials
      .map((c) => `${c.name}\t${c.email}\t${c.role}\t${c.password}`)
      .join('\n');
    navigator.clipboard?.writeText(`Nama\tEmail\tRole\tKata Sandi\n${text}`);
    setCopiedBatchCreds(true);
    setTimeout(() => setCopiedBatchCreds(false), 1800);
  }

  function handleDownloadBatchCredentialsCsv() {
    if (!importResult || importResult.importedCredentials.length === 0) return;
    const rows = [
      'Nama Lengkap,Email,Role,Kata Sandi,Status',
      ...importResult.importedCredentials.map((c) =>
        [c.name, c.email, c.role, c.password, c.action]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      ),
    ].join('\n');
    const blob = new Blob(['\uFEFF' + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kredensial-guru-examflow.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // --- Subject CRUD Handlers ---
  function openCreateSubjectModal() {
    setEditingSubject(null);
    setSubjCode('');
    setSubjName('');
    setSubjDesc('');
    setSubjectModalError(null);
    setShowSubjectModal(true);
  }

  function openEditSubjectModal(subj: SubjectItem) {
    setEditingSubject(subj);
    setSubjCode(subj.code);
    setSubjName(subj.name);
    setSubjDesc(subj.description || '');
    setSubjectModalError(null);
    setShowSubjectModal(true);
  }

  async function handleSaveSubject(e: React.FormEvent) {
    e.preventDefault();
    setSubjectModalError(null);
    setSavingSubject(true);
    try {
      if (editingSubject) {
        await teacherApi.updateSubject(token, editingSubject.id, {
          code: subjCode,
          name: subjName,
          description: subjDesc,
        });
        setSubjectFeedback({ type: 'ok', text: `Mata pelajaran "${subjName.trim()}" berhasil diperbarui.` });
      } else {
        await teacherApi.createSubject(token, {
          code: subjCode,
          name: subjName,
          description: subjDesc,
        });
        setSubjectFeedback({ type: 'ok', text: `Mata pelajaran "${subjName.trim()}" berhasil ditambahkan.` });
      }
      setShowSubjectModal(false);
      await loadSubjects();
      await loadTeachers();
      await onContextChanged();
    } catch (err) {
      setSubjectModalError(err instanceof Error ? err.message : 'Gagal menyimpan mata pelajaran.');
    } finally {
      setSavingSubject(false);
    }
  }

  async function handleDeleteSubject(subjId: number) {
    setBusySubjectId(subjId);
    setSubjectFeedback(null);
    try {
      await teacherApi.deleteSubject(token, subjId);
      setConfirmDeleteSubjectId(null);
      setSubjectFeedback({ type: 'ok', text: 'Mata pelajaran telah dihapus.' });
      await loadSubjects();
      await loadTeachers();
      await onContextChanged();
    } catch (err) {
      setSubjectFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal menghapus mata pelajaran.',
      });
    } finally {
      setBusySubjectId(null);
    }
  }

  // --- Class CRUD Handlers ---
  function inferGradeFromClassName(rawName: string): number | null {
    const match = rawName.trim().replace(/^KELAS\s+/i, '').match(/^(\d{1,2})/);
    if (!match) return null;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 12) return null;
    return parsed;
  }

  function openCreateClassModal() {
    setEditingClass(null);
    setClassNameInput('');
    setClassGradeInput(8);
    setClassModalError(null);
    setShowClassModal(true);
  }

  function openEditClassModal(cls: ClassItem) {
    setEditingClass(cls);
    setClassNameInput(cls.name);
    setClassGradeInput(cls.grade_level);
    setClassModalError(null);
    setShowClassModal(true);
  }

  function handleClassNameChange(val: string) {
    const clean = val.toUpperCase();
    setClassNameInput(clean);
    const inferred = inferGradeFromClassName(clean);
    if (inferred !== null) {
      setClassGradeInput(inferred);
    }
  }

  async function handleSaveClass(e: React.FormEvent) {
    e.preventDefault();
    setClassModalError(null);
    setSavingClass(true);
    try {
      const normalizedName = classNameInput.trim().toUpperCase().replace(/^KELAS\s+/i, '');
      if (editingClass) {
        await teacherApi.updateClass(token, editingClass.id, {
          name: normalizedName,
          gradeLevel: classGradeInput,
        });
        setClassFeedback({ type: 'ok', text: `Kelas "${normalizedName}" berhasil diperbarui.` });
      } else {
        await teacherApi.createClass(token, {
          name: normalizedName,
          gradeLevel: classGradeInput,
        });
        setClassFeedback({ type: 'ok', text: `Kelas "${normalizedName}" berhasil ditambahkan.` });
      }
      setShowClassModal(false);
      await loadClasses();
      await loadTeachers();
      await onContextChanged();
    } catch (err) {
      setClassModalError(err instanceof Error ? err.message : 'Gagal menyimpan data kelas.');
    } finally {
      setSavingClass(false);
    }
  }

  async function handleDeleteClass(clsId: number) {
    setBusyClassId(clsId);
    setClassFeedback(null);
    try {
      await teacherApi.deleteClass(token, clsId);
      setConfirmDeleteClassId(null);
      setClassFeedback({ type: 'ok', text: 'Kelas telah dihapus dari daftar master.' });
      await loadClasses();
      await loadTeachers();
      await onContextChanged();
    } catch (err) {
      setClassFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal menghapus kelas.',
      });
    } finally {
      setBusyClassId(null);
    }
  }

  const filteredTeachers = teachers.filter((t) => {
    if (roleFilter !== 'ALL' && t.role !== roleFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q);
    }
    return true;
  });

  const adminCount = teachers.filter((t) => t.role === 'ADMIN').length;
  const teacherCount = teachers.filter((t) => t.role === 'TEACHER').length;

  return (
    <div className="space-y-6">
      {/* Header & Sub-tab Switcher */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-bold text-slate-900">
            Administrasi Guru, Mata Pelajaran &amp; Kelas
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Kelola akun guru secara terpusat (tanpa registrasi terbuka), atur penugasan kelas/mapel, serta perbarui daftar mata pelajaran dan kelas sekolah.
          </p>
        </div>

        <div className="inline-flex flex-wrap items-center bg-slate-100 p-1 rounded-lg shrink-0 self-start lg:self-auto">
          <button
            type="button"
            onClick={() => setSubTab('teachers')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'teachers'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <UserCog className="w-3.5 h-3.5" aria-hidden="true" />
            Akun Guru ({teachers.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('subjects')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'subjects'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
            Mata Pelajaran ({subjects.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('classes')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'classes'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <GraduationCap className="w-3.5 h-3.5" aria-hidden="true" />
            Kelas ({classesList.length})
          </button>
        </div>
      </div>

      {/* ========================== */}
      {/* TAB 1: MANAJEMEN GURU       */}
      {/* ========================== */}
      {subTab === 'teachers' && (
        <div className="space-y-5">
          {/* Summary Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-medium text-slate-500">Total Akun Terdaftar</div>
              <div className="font-mono text-2xl font-bold text-slate-900 tabular-nums mt-1">
                {teachers.length}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-medium text-slate-500">Admin Sekolah</div>
              <div className="font-mono text-2xl font-bold text-blue-700 tabular-nums mt-1">
                {adminCount}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-medium text-slate-500">Guru Mata Pelajaran</div>
              <div className="font-mono text-2xl font-bold text-slate-900 tabular-nums mt-1">
                {teacherCount}
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 flex-1">
              <div className="relative flex-1 min-w-[210px] max-w-sm">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari nama atau email guru..."
                  className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <select
                aria-label="Filter Peran"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as 'ALL' | 'ADMIN' | 'TEACHER')}
                className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
              >
                <option value="ALL">Semua Peran</option>
                <option value="TEACHER">Guru (TEACHER)</option>
                <option value="ADMIN">Admin (ADMIN)</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={openImportModal}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                Import CSV Guru
              </button>
              <button
                type="button"
                onClick={openCreateTeacherModal}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                Tambah Guru
              </button>
            </div>
          </div>

          {teacherFeedback && (
            <div
              className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-4 ${
                teacherFeedback.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-700'
              }`}
            >
              <span>{teacherFeedback.text}</span>
              <button type="button" onClick={() => setTeacherFeedback(null)} className="text-slate-500 hover:text-slate-800 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Teachers Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {loadingTeachers ? (
              <div className="p-8 space-y-3">
                <div className="h-5 bg-slate-100 rounded w-1/3 animate-pulse" />
                <div className="h-24 bg-slate-100 rounded w-full animate-pulse" />
              </div>
            ) : filteredTeachers.length === 0 ? (
              <div className="p-10 text-center">
                <Users className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-800">Tidak ada akun guru yang cocok</p>
                <p className="text-xs text-slate-500 mt-1">Ubah filter pencarian atau tambahkan guru baru.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                      <th className="py-3 px-4">Nama &amp; Email</th>
                      <th className="py-3 px-4">Peran</th>
                      <th className="py-3 px-4">Penugasan Mapel &amp; Kelas</th>
                      <th className="py-3 px-4 text-right">Paket Ujian</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredTeachers.map((t) => {
                      const isSelf = t.id === currentTeacherId;
                      const isBusy = busyTeacherId === t.id;
                      const assignments = t.assignments || [];
                      return (
                        <tr key={t.id} className="hover:bg-slate-50/70 align-top">
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-slate-900 flex items-center gap-2">
                              <span>{t.name}</span>
                              {isSelf && (
                                <span className="text-[10px] font-semibold text-blue-700">
                                  (Akun Anda)
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-slate-500 mt-0.5">{t.email}</div>
                          </td>

                          <td className="py-3.5 px-4 whitespace-nowrap">
                            <span
                              className={`text-xs font-semibold ${
                                t.role === 'ADMIN' ? 'text-blue-700' : 'text-slate-700'
                              }`}
                            >
                              {t.role === 'ADMIN' ? 'Admin Sekolah' : 'Guru Mapel'}
                            </span>
                          </td>

                          <td className="py-3.5 px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {assignments.length === 0 ? (
                                <span className="text-[11px] text-slate-400">Belum ada penugasan</span>
                              ) : (
                                assignments.map((a) => (
                                  <span
                                    key={a.id}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[11px] text-slate-700"
                                  >
                                    <span>
                                      {a.subject_code} · {a.class_name}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveAssignment(a.id)}
                                      className="text-slate-400 hover:text-red-600 cursor-pointer"
                                      title="Hapus penugasan"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </span>
                                ))
                              )}
                              <button
                                type="button"
                                onClick={() => openAssignModal(t)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 rounded cursor-pointer"
                              >
                                <Link2 className="w-3 h-3" />
                                Tugaskan
                              </button>
                            </div>
                          </td>

                          <td className="py-3.5 px-4 text-right font-mono font-semibold text-slate-800 tabular-nums whitespace-nowrap">
                            {t.package_count ?? 0}
                          </td>

                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            {confirmDeleteTeacherId === t.id ? (
                              <div className="inline-flex items-center gap-1.5">
                                <span className="text-[11px] text-red-700 font-semibold">Hapus?</span>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleDeleteTeacher(t.id)}
                                  className="px-2 py-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                                >
                                  Ya
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteTeacherId(null)}
                                  className="px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                                >
                                  Batal
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openEditTeacherModal(t)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                                  title="Edit Data Guru"
                                >
                                  <Pencil className="w-3 h-3" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openResetPasswordModal(t)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-md cursor-pointer"
                                  title="Reset Kata Sandi"
                                >
                                  <KeyRound className="w-3 h-3" />
                                  Reset Sandi
                                </button>
                                {!isSelf && (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteTeacherId(t.id)}
                                    className="p-1.5 text-slate-400 hover:text-red-600 transition-colors cursor-pointer"
                                    title="Hapus Akun Guru"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================== */}
      {/* TAB 2: MASTER MATA PELAJARAN */}
      {/* ========================== */}
      {subTab === 'subjects' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">Daftar Mata Pelajaran Sekolah</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Mata pelajaran yang ditambahkan langsung tersedia saat membuat paket ujian dan menugaskan guru.
              </p>
            </div>
            <button
              type="button"
              onClick={openCreateSubjectModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer self-start sm:self-auto"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              Tambah Mata Pelajaran
            </button>
          </div>

          {subjectFeedback && (
            <div
              className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-4 ${
                subjectFeedback.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-700'
              }`}
            >
              <span>{subjectFeedback.text}</span>
              <button type="button" onClick={() => setSubjectFeedback(null)} className="text-slate-500 hover:text-slate-800 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {loadingSubjects ? (
              <div className="p-8 space-y-3">
                <div className="h-5 bg-slate-100 rounded w-1/3 animate-pulse" />
                <div className="h-20 bg-slate-100 rounded w-full animate-pulse" />
              </div>
            ) : subjects.length === 0 ? (
              <div className="p-10 text-center">
                <BookOpen className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-800">Belum ada mata pelajaran</p>
                <p className="text-xs text-slate-500 mt-1">Tambahkan mata pelajaran pertama untuk mulai membuat paket ujian.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                      <th className="py-3 px-4">Kode</th>
                      <th className="py-3 px-4">Nama Mata Pelajaran</th>
                      <th className="py-3 px-4">Keterangan</th>
                      <th className="py-3 px-4 text-right">Paket Ujian</th>
                      <th className="py-3 px-4 text-right">Total Soal</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {subjects.map((subj) => {
                      const pkgCount = subj.package_count ?? 0;
                      const qCount = subj.question_count ?? 0;
                      const isBusy = busySubjectId === subj.id;
                      return (
                        <tr key={subj.id} className="hover:bg-slate-50/70">
                          <td className="py-3.5 px-4 font-mono font-bold text-blue-700 whitespace-nowrap">
                            {subj.code}
                          </td>
                          <td className="py-3.5 px-4 font-semibold text-slate-900">{subj.name}</td>
                          <td className="py-3.5 px-4 text-slate-500">{subj.description || '—'}</td>
                          <td className="py-3.5 px-4 text-right font-mono font-semibold text-slate-800 tabular-nums">
                            {pkgCount}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono text-slate-600 tabular-nums">
                            {qCount}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            {confirmDeleteSubjectId === subj.id ? (
                              <div className="inline-flex items-center gap-1.5">
                                <span className="text-[11px] text-red-700 font-semibold">Hapus?</span>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleDeleteSubject(subj.id)}
                                  className="px-2 py-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                                >
                                  Ya
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteSubjectId(null)}
                                  className="px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                                >
                                  Batal
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openEditSubjectModal(subj)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                                >
                                  <Pencil className="w-3 h-3" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  disabled={pkgCount > 0}
                                  onClick={() => setConfirmDeleteSubjectId(subj.id)}
                                  className="p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                                  title={
                                    pkgCount > 0
                                      ? `Tidak dapat dihapus karena masih digunakan ${pkgCount} paket ujian`
                                      : 'Hapus Mata Pelajaran'
                                  }
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================== */}
      {/* TAB 3: MASTER KELAS        */}
      {/* ========================== */}
      {subTab === 'classes' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">Daftar Kelas Sekolah</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Kelas yang terdaftar otomatis muncul di filter siswa, formulir tambah/edit siswa, penugasan guru, dan pembuatan paket ujian.
              </p>
            </div>
            <button
              type="button"
              onClick={openCreateClassModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer self-start sm:self-auto"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              Tambah Kelas
            </button>
          </div>

          {classFeedback && (
            <div
              className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-4 ${
                classFeedback.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-700'
              }`}
            >
              <span>{classFeedback.text}</span>
              <button type="button" onClick={() => setClassFeedback(null)} className="text-slate-500 hover:text-slate-800 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {loadingClasses ? (
              <div className="p-8 space-y-3">
                <div className="h-5 bg-slate-100 rounded w-1/3 animate-pulse" />
                <div className="h-20 bg-slate-100 rounded w-full animate-pulse" />
              </div>
            ) : classesList.length === 0 ? (
              <div className="p-10 text-center">
                <GraduationCap className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-800">Belum ada kelas terdaftar</p>
                <p className="text-xs text-slate-500 mt-1">Tambahkan kelas pertama (misal: 7A, 8A, 9A) untuk mengelompokkan siswa.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                      <th className="py-3 px-4">Nama Kelas</th>
                      <th className="py-3 px-4">Tingkat</th>
                      <th className="py-3 px-4 text-right">Jumlah Siswa</th>
                      <th className="py-3 px-4 text-right">Paket Ujian</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {classesList.map((cls) => {
                      const stCount = cls.student_count ?? 0;
                      const pkgCount = cls.package_count ?? 0;
                      const isInUse = stCount > 0 || pkgCount > 0;
                      const isBusy = busyClassId === cls.id;
                      return (
                        <tr key={cls.id} className="hover:bg-slate-50/70">
                          <td className="py-3.5 px-4 font-mono font-bold text-slate-900 whitespace-nowrap">
                            Kelas {cls.name}
                          </td>
                          <td className="py-3.5 px-4 text-slate-600 tabular-nums">
                            Tingkat {cls.grade_level}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono font-semibold text-slate-800 tabular-nums">
                            {stCount}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono text-slate-600 tabular-nums">
                            {pkgCount}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            {confirmDeleteClassId === cls.id ? (
                              <div className="inline-flex items-center gap-1.5">
                                <span className="text-[11px] text-red-700 font-semibold">Hapus?</span>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleDeleteClass(cls.id)}
                                  className="px-2 py-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                                >
                                  Ya
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteClassId(null)}
                                  className="px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                                >
                                  Batal
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openEditClassModal(cls)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                                >
                                  <Pencil className="w-3 h-3" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  disabled={isInUse}
                                  onClick={() => setConfirmDeleteClassId(cls.id)}
                                  className="p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                                  title={
                                    isInUse
                                      ? `Tidak dapat dihapus karena masih memiliki ${stCount} siswa dan ${pkgCount} paket ujian`
                                      : 'Hapus Kelas'
                                  }
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Tambah / Edit Guru */}
      {showTeacherModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-bold text-slate-900">
                {editingTeacher ? 'Edit Akun Guru' : 'Tambah Akun Guru Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowTeacherModal(false)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {teacherModalError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {teacherModalError}
              </div>
            )}

            <form onSubmit={handleSaveTeacher} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Lengkap &amp; Gelar</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Contoh: Siti Aminah, S.Pd."
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Email Login Guru</label>
                <input
                  type="email"
                  required
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="nama.guru@sekolah.sch.id"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Peran Akun</label>
                <select
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value as 'TEACHER' | 'ADMIN')}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="TEACHER">Guru Mapel (TEACHER)</option>
                  <option value="ADMIN">Admin Sekolah (ADMIN)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {editingTeacher ? 'Kata Sandi Baru (Opsional — kosongkan jika tidak diubah)' : 'Kata Sandi Awal'}
                </label>
                <input
                  type="password"
                  required={!editingTeacher}
                  minLength={6}
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  placeholder={editingTeacher ? 'Kosongkan jika tetap' : 'Minimal 6 karakter'}
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowTeacherModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingTeacher}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg cursor-pointer"
                >
                  {savingTeacher ? 'Menyimpan...' : editingTeacher ? 'Simpan Perubahan' : 'Buat Akun Guru'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Reset Kata Sandi Guru */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-base font-bold text-slate-900">Reset Kata Sandi Guru</h3>
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg mb-4 text-xs">
              <div className="font-semibold text-slate-900">{resetTarget.name}</div>
              <div className="font-mono text-slate-500 mt-0.5">{resetTarget.email}</div>
            </div>

            {resetError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {resetError}
              </div>
            )}

            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Kata Sandi Baru (Opsional — kosongkan untuk acak otomatis 8 karakter)
                </label>
                <input
                  type="text"
                  maxLength={128}
                  value={customResetPassword}
                  onChange={(e) => setCustomResetPassword(e.target.value)}
                  placeholder="Kosongkan untuk generate otomatis"
                  className="w-full px-3.5 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={resettingPassword}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg cursor-pointer"
                >
                  {resettingPassword ? 'Memproses...' : 'Reset Kata Sandi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Kredensial Guru Baru / Hasil Reset */}
      {revealedCredential && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="font-display text-base font-bold text-slate-900">{revealedCredential.title}</h3>
            <p className="text-xs text-slate-500 mt-1">
              Berikan kredensial berikut kepada guru yang bersangkutan. Guru dapat mengganti kata sandinya sendiri setelah login.
            </p>

            <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
              <div>
                <div className="text-[11px] text-slate-500">Nama</div>
                <div className="font-semibold text-slate-900">{revealedCredential.name}</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Email</div>
                <div className="font-mono text-slate-800">{revealedCredential.email}</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Kata Sandi</div>
                <div className="font-mono text-lg font-bold text-blue-700 tracking-wide">
                  {revealedCredential.password}
                </div>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(
                    `Email: ${revealedCredential.email}\nKata Sandi: ${revealedCredential.password}`
                  );
                  setCopiedCredential(true);
                  setTimeout(() => setCopiedCredential(false), 1800);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                {copiedCredential ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedCredential ? 'Tersalin' : 'Salin Kredensial'}
              </button>
              <button
                type="button"
                onClick={() => setRevealedCredential(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                Selesai
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Penugasan Mapel & Kelas */}
      {assignTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">Tugaskan Mapel &amp; Kelas</h3>
                <p className="text-xs text-slate-500 mt-0.5">{assignTarget.name}</p>
              </div>
              <button
                type="button"
                onClick={() => setAssignTarget(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {assignError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {assignError}
              </div>
            )}

            <form onSubmit={handleAddAssignment} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Mata Pelajaran</label>
                <select
                  value={assignSubjectId}
                  onChange={(e) => setAssignSubjectId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Kelas</label>
                <select
                  value={assignClassId}
                  onChange={(e) => setAssignClassId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      Kelas {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setAssignTarget(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingAssign}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg cursor-pointer"
                >
                  {savingAssign ? 'Menyimpan...' : 'Simpan Penugasan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Import CSV Guru */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
              <div className="flex items-center gap-2.5">
                <FileSpreadsheet className="w-5 h-5 text-blue-700 shrink-0" />
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">Import Akun Guru via CSV / Excel</h3>
                  <p className="text-xs text-slate-500">
                    Tambah banyak akun guru sekaligus. Jika kolom password dikosongkan, sistem membuatkan kata sandi acak otomatis.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {importResult && (
              <div className="px-6 pt-3 border-b border-slate-200 flex items-center gap-2 bg-slate-50 shrink-0">
                <button
                  type="button"
                  onClick={() => setImportModalTab('input')}
                  className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                    importModalTab === 'input'
                      ? 'border-blue-700 text-blue-700'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Input Data CSV
                </button>
                <button
                  type="button"
                  onClick={() => setImportModalTab('result')}
                  className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                    importModalTab === 'result'
                      ? 'border-blue-700 text-blue-700'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Hasil Import ({importResult.importedCredentials.length} akun)
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto scrollbar-stable p-6">
              {importModalTab === 'input' ? (
                <form id="import-teachers-form" onSubmit={handleImportTeachersSubmit} className="space-y-4">
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 space-y-2">
                    <div className="font-semibold text-slate-800">Format Kolom (koma / titik-koma / tab Excel):</div>
                    <div className="font-mono text-[11px] bg-white border border-slate-200 rounded px-3 py-2 text-slate-700">
                      Nama Lengkap,Email,Role,Password (Opsional)
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleDownloadTemplate}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Unduh Template CSV
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setImportText(TEACHER_CSV_SAMPLE);
                          setImportFileName(null);
                          setImportError(null);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        Muat Contoh Data
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.txt"
                        onChange={handleFileSelect}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        {importFileName ? `File: ${importFileName}` : 'Pilih File .CSV'}
                      </button>
                    </div>
                  </div>

                  {importError && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{importError}</span>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Data Guru (1 baris = 1 akun guru)
                    </label>
                    <textarea
                      rows={7}
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      placeholder={'Ahmad Fauzi,ahmad.fauzi@examflow.sch.id,TEACHER,\nDewi Kartika,dewi.kartika@examflow.sch.id,TEACHER,guru2026'}
                      className="w-full px-3.5 py-2.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={updateExisting}
                      onChange={(e) => setUpdateExisting(e.target.checked)}
                      className="rounded border-slate-300 text-blue-700"
                    />
                    Perbarui nama/peran jika email guru sudah terdaftar (kata sandi hanya diubah jika kolom password diisi)
                  </label>
                </form>
              ) : (
                importResult && (
                  <div className="space-y-4">
                    <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                      <span>
                        Import selesai: <strong>{importResult.summary.createdCount}</strong> akun baru,{' '}
                        <strong>{importResult.summary.updatedCount}</strong> diperbarui,{' '}
                        <strong>{importResult.summary.skippedCount}</strong> dilewati,{' '}
                        <strong>{importResult.summary.errorCount}</strong> gagal.
                      </span>
                    </div>

                    {importResult.importedCredentials.length > 0 && (
                      <div className="border border-slate-200 rounded-xl overflow-hidden">
                        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs font-bold text-slate-900">
                            Daftar Kredensial Akun Guru ({importResult.importedCredentials.length})
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={handleCopyBatchCredentials}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
                            >
                              {copiedBatchCreds ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                              {copiedBatchCreds ? 'Tersalin' : 'Salin Semua'}
                            </button>
                            <button
                              type="button"
                              onClick={handleDownloadBatchCredentialsCsv}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Unduh CSV Kredensial
                            </button>
                          </div>
                        </div>
                        <div className="max-h-56 overflow-y-auto scrollbar-stable">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="border-b border-slate-200 bg-white text-[11px] font-semibold text-slate-500">
                                <th className="py-2 px-4">Nama</th>
                                <th className="py-2 px-4">Email</th>
                                <th className="py-2 px-4">Role</th>
                                <th className="py-2 px-4">Kata Sandi</th>
                                <th className="py-2 px-4 text-right">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {importResult.importedCredentials.map((c) => (
                                <tr key={`${c.email}-${c.action}`}>
                                  <td className="py-2 px-4 font-semibold text-slate-900">{c.name}</td>
                                  <td className="py-2 px-4 font-mono text-slate-600">{c.email}</td>
                                  <td className="py-2 px-4 text-slate-700">{c.role}</td>
                                  <td className="py-2 px-4 font-mono font-bold text-blue-700">{c.password}</td>
                                  <td className="py-2 px-4 text-right text-[11px] font-semibold text-slate-600">
                                    {c.action === 'UPDATED' ? 'Diperbarui' : 'Baru'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {importResult.skipped.length > 0 && (
                      <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
                        <div className="font-semibold">Baris Duplikat Dilewati:</div>
                        {importResult.skipped.map((s) => (
                          <div key={`${s.lineNumber}-${s.email}`} className="font-mono text-[11px]">
                            Baris {s.lineNumber} ({s.email}): {s.reason}
                          </div>
                        ))}
                      </div>
                    )}

                    {importResult.errors.length > 0 && (
                      <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 space-y-1">
                        <div className="font-semibold">Baris Gagal Diproses:</div>
                        {importResult.errors.map((errItem) => (
                          <div key={errItem.lineNumber} className="font-mono text-[11px]">
                            Baris {errItem.lineNumber}: {errItem.reason}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11px] text-slate-500">
                Format: Nama Lengkap, Email, Role (TEACHER/ADMIN), Password (opsional)
              </span>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  {importResult ? 'Tutup' : 'Batal'}
                </button>
                <button
                  type="submit"
                  form="import-teachers-form"
                  disabled={importing || !importText.trim() || importModalTab !== 'input'}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {importing ? 'Mengimpor...' : 'Import Akun Guru'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Tambah / Edit Mata Pelajaran */}
      {showSubjectModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-bold text-slate-900">
                {editingSubject ? 'Edit Mata Pelajaran' : 'Tambah Mata Pelajaran Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowSubjectModal(false)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {subjectModalError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {subjectModalError}
              </div>
            )}

            <form onSubmit={handleSaveSubject} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Kode Mata Pelajaran (2–16 huruf/angka)
                </label>
                <input
                  type="text"
                  required
                  maxLength={16}
                  value={subjCode}
                  onChange={(e) => setSubjCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))}
                  placeholder="Contoh: FIS, KIM, BING"
                  className="w-full px-3.5 py-2 text-sm font-mono font-bold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Mata Pelajaran</label>
                <input
                  type="text"
                  required
                  value={subjName}
                  onChange={(e) => setSubjName(e.target.value)}
                  placeholder="Contoh: Bahasa Inggris"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Keterangan (Opsional)</label>
                <input
                  type="text"
                  value={subjDesc}
                  onChange={(e) => setSubjDesc(e.target.value)}
                  placeholder="Contoh: Mata pelajaran wajib kelas 7–9"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowSubjectModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingSubject}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg cursor-pointer"
                >
                  {savingSubject ? 'Menyimpan...' : editingSubject ? 'Simpan Perubahan' : 'Simpan Mapel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Tambah / Edit Kelas */}
      {showClassModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-bold text-slate-900">
                {editingClass ? 'Edit Data Kelas' : 'Tambah Kelas Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowClassModal(false)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {classModalError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {classModalError}
              </div>
            )}

            <form onSubmit={handleSaveClass} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nama Kelas (tanpa kata &ldquo;Kelas&rdquo;)
                </label>
                <input
                  type="text"
                  required
                  maxLength={24}
                  value={classNameInput}
                  onChange={(e) => handleClassNameChange(e.target.value)}
                  placeholder="Contoh: 7A, 8C, 9B, 10 IPA 1"
                  className="w-full px-3.5 py-2 text-sm font-mono font-bold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Tingkat Kelas (1–12)</label>
                <select
                  value={classGradeInput}
                  onChange={(e) => setClassGradeInput(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
                    <option key={g} value={g}>
                      Tingkat {g}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowClassModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingClass}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg cursor-pointer"
                >
                  {savingClass ? 'Menyimpan...' : editingClass ? 'Simpan Perubahan' : 'Simpan Kelas'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
