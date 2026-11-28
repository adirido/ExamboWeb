import React, { useEffect, useState } from 'react';
import {
  QrCode,
  RefreshCw,
  Plus,
  Power,
  Copy,
  Check,
  Activity,
  FileText,
  Trash2,
  X,
  ShieldAlert,
  BookOpen,
  Pencil,
  Search,
} from 'lucide-react';
import { teacherApi } from '../api';
import type {
  ClassItem,
  ExamPackage,
  ProctorOption,
  QrPayloadResponse,
  SubjectItem,
  TeacherAssignment,
} from '../types';

interface PackagesViewProps {
  token: string;
  teacherRole: 'ADMIN' | 'TEACHER';
  packages: ExamPackage[];
  assignments: TeacherAssignment[];
  subjects: SubjectItem[];
  classes: ClassItem[];
  teachers: ProctorOption[];
  onRefresh: () => Promise<void>;
  onOpenMonitoring: (packageId: number) => void;
  onOpenQuestions: (packageId: number) => void;
  onOpenRecap: (packageId: number) => void;
}

export const PackagesView: React.FC<PackagesViewProps> = ({
  token,
  teacherRole,
  packages,
  assignments,
  subjects,
  classes,
  teachers,
  onRefresh,
  onOpenMonitoring,
  onOpenQuestions,
  onOpenRecap,
}) => {
  const isAdmin = teacherRole === 'ADMIN';
  const canCreatePackage = isAdmin || assignments.length > 0;
  const [filterClass, setFilterClass] = useState<string>('ALL');
  const [filterSubject, setFilterSubject] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [qrModalData, setQrModalData] = useState<QrPayloadResponse | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmRotateId, setConfirmRotateId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const filterSubjects: SubjectItem[] = isAdmin
    ? subjects
    : Array.from(
        new Map<number, SubjectItem>([
          ...subjects.map((s) => [s.id, s] as const),
          ...packages.map((p) => [
            p.subject_id,
            { id: p.subject_id, code: p.subject_code, name: p.subject_name, description: '' },
          ] as const),
        ]).values()
      ).sort((a, b) => a.name.localeCompare(b.name));

  const filterClasses: ClassItem[] = isAdmin
    ? classes
    : Array.from(
        new Map<number, ClassItem>([
          ...classes.map((c) => [c.id, c] as const),
          ...packages.map((p) => [
            p.class_id,
            { id: p.class_id, name: p.class_name, grade_level: 8 },
          ] as const),
        ]).values()
      ).sort((a, b) => a.grade_level - b.grade_level || a.name.localeCompare(b.name));

  // Create form state
  const defaultSubjectId = assignments[0]?.subject_id || subjects[0]?.id || 0;
  const defaultClassId =
    assignments.find((a) => a.subject_id === defaultSubjectId)?.class_id || classes[0]?.id || 0;
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState<number>(defaultSubjectId);
  const [selectedClassIds, setSelectedClassIds] = useState<number[]>(defaultClassId ? [defaultClassId] : []);
  const [examDate, setExamDate] = useState('');
  const [kkm, setKkm] = useState(75);
  const [proctorsByClass, setProctorsByClass] = useState<Record<string, number | null>>({});
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [maxViolations, setMaxViolations] = useState(3);
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [cloneFromPackageId, setCloneFromPackageId] = useState<number | ''>('');
  const [creating, setCreating] = useState(false);

  // Edit form state
  const [editingPackage, setEditingPackage] = useState<ExamPackage | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSubjectId, setEditSubjectId] = useState<number>(1);
  const [editClassId, setEditClassId] = useState<number>(1);
  const [editProctorId, setEditProctorId] = useState<number | null>(null);
  const [editExamDate, setEditExamDate] = useState('');
  const [editKkm, setEditKkm] = useState(75);
  const [editDurationMinutes, setEditDurationMinutes] = useState(60);
  const [editMaxViolations, setEditMaxViolations] = useState(3);
  const [editShuffleQuestions, setEditShuffleQuestions] = useState(true);
  const [editShuffleOptions, setEditShuffleOptions] = useState(true);
  const [editIsActive, setEditIsActive] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);

  const createModalClasses = isAdmin
    ? classes
    : classes.filter((c) => assignments.some((a) => a.subject_id === subjectId && a.class_id === c.id));

  const editModalClasses = isAdmin
    ? classes
    : classes.filter((c) => assignments.some((a) => a.subject_id === editSubjectId && a.class_id === c.id));

  useEffect(() => {
    if (!showCreateModal && !editingPackage && !qrModalData && confirmDeleteId === null && confirmRotateId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (creating || savingEdit) return;
        if (showCreateModal) {
          setShowCreateModal(false);
          return;
        }
        if (editingPackage) {
          setEditingPackage(null);
          return;
        }
        if (qrModalData) {
          setQrModalData(null);
          return;
        }
        setConfirmDeleteId(null);
        setConfirmRotateId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showCreateModal, editingPackage, qrModalData, creating, savingEdit, confirmDeleteId, confirmRotateId]);

  const filtered = packages.filter((p) => {
    if (filterClass !== 'ALL' && String(p.class_id) !== filterClass) return false;
    if (filterSubject !== 'ALL' && String(p.subject_id) !== filterSubject) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        p.title.toLowerCase().includes(q) ||
        p.current_token.toLowerCase().includes(q) ||
        p.subject_name.toLowerCase().includes(q) ||
        p.class_name.toLowerCase().includes(q)
      );
    }
    return true;
  });

  async function handleToggleActive(pkg: ExamPackage) {
    if (busyId !== null) return;
    setBusyId(pkg.id);
    setFeedback(null);
    try {
      await teacherApi.togglePackageActive(token, pkg.id);
      await onRefresh();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Gagal mengubah status paket.' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleRotateToken(pkg: ExamPackage) {
    if (busyId !== null) return;
    setBusyId(pkg.id);
    setFeedback(null);
    try {
      const res = await teacherApi.rotateToken(token, pkg.id);
      setConfirmRotateId(null);
      await onRefresh();
      setFeedback({
        type: 'ok',
        text: `Token untuk "${pkg.title}" berhasil dirotasi menjadi ${res.currentToken}. Token lama otomatis tidak berlaku.`,
      });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Gagal merotasi token.' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleOpenQr(pkg: ExamPackage) {
    if (qrLoading) return;
    setQrLoading(true);
    setFeedback(null);
    try {
      const portalBaseUrl = `${window.location.origin}${window.location.pathname}`;
      const data = await teacherApi.getPackageQr(token, pkg.id, portalBaseUrl);
      setQrModalData(data);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Gagal membuat QR Code.' });
    } finally {
      setQrLoading(false);
    }
  }

  async function handleDelete(pkgId: number) {
    if (busyId !== null) return;
    setBusyId(pkgId);
    try {
      await teacherApi.deletePackage(token, pkgId);
      setConfirmDeleteId(null);
      await onRefresh();
      setFeedback({ type: 'ok', text: 'Paket ujian telah dihapus.' });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menghapus paket.' });
    } finally {
      setBusyId(null);
    }
  }

  function openCreateModal() {
    if (!canCreatePackage) {
      setFeedback({
        type: 'err',
        text: 'Akun Anda belum memiliki penugasan mata pelajaran & kelas dari Admin Sekolah.',
      });
      return;
    }
    const initialSubject = assignments[0]?.subject_id || subjects[0]?.id || 0;
    const initialClass =
      assignments.find((a) => a.subject_id === initialSubject)?.class_id || classes[0]?.id || 0;
    setSubjectId(initialSubject);
    setSelectedClassIds(initialClass ? [initialClass] : []);
    setExamDate('');
    setKkm(75);
    setProctorsByClass({});
    setCloneFromPackageId('');
    setShowCreateModal(true);
  }

  function toggleTargetClass(cid: number) {
    setSelectedClassIds((prev) =>
      prev.includes(cid) ? prev.filter((id) => id !== cid) : [...prev, cid]
    );
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    if (selectedClassIds.length === 0) {
      setFeedback({ type: 'err', text: 'Pilih minimal satu kelas target ujian.' });
      return;
    }
    setCreating(true);
    setFeedback(null);
    try {
      const payloadProctors: Record<string, number | null> = {};
      if (isAdmin) {
        for (const cid of selectedClassIds) {
          payloadProctors[String(cid)] = proctorsByClass[String(cid)] ?? null;
        }
      }
      const res = await teacherApi.createPackage(token, {
        title,
        subjectId,
        classIds: selectedClassIds,
        examDate: examDate.trim(),
        kkm,
        ...(isAdmin ? { proctorsByClass: payloadProctors } : {}),
        durationMinutes,
        maxViolations,
        shuffleQuestions,
        shuffleOptions,
        isActive,
        cloneFromPackageId: cloneFromPackageId ? Number(cloneFromPackageId) : undefined,
      });
      const createdCount = res.packages?.length || 1;
      setShowCreateModal(false);
      setTitle('');
      setCloneFromPackageId('');
      setProctorsByClass({});
      await onRefresh();
      setFeedback({
        type: 'ok',
        text:
          createdCount > 1
            ? `${createdCount} paket ujian kelas paralel berhasil dibuat dalam jadwal bersamaan dan Bank Soal otomatis tersinkron.`
            : 'Paket ujian baru berhasil dibuat dan siap digunakan.',
      });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Gagal membuat paket ujian.' });
    } finally {
      setCreating(false);
    }
  }

  function openEditModal(pkg: ExamPackage) {
    setConfirmDeleteId(null);
    setConfirmRotateId(null);
    setEditingPackage(pkg);
    setEditTitle(pkg.title);
    setEditSubjectId(pkg.subject_id);
    setEditClassId(pkg.class_id);
    setEditProctorId(pkg.proctor_id ?? null);
    setEditExamDate(pkg.exam_date || '');
    setEditKkm(pkg.kkm ?? 75);
    setEditDurationMinutes(pkg.duration_minutes);
    setEditMaxViolations(pkg.max_violations);
    setEditShuffleQuestions(pkg.shuffle_questions === 1);
    setEditShuffleOptions(pkg.shuffle_options === 1);
    setEditIsActive(pkg.is_active === 1);
    setFeedback(null);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPackage || savingEdit) return;
    setSavingEdit(true);
    setFeedback(null);
    try {
      await teacherApi.updatePackage(token, editingPackage.id, {
        title: editTitle.trim(),
        subjectId: editSubjectId,
        classId: editClassId,
        ...(isAdmin ? { proctorId: editProctorId } : {}),
        examDate: editExamDate.trim(),
        kkm: editKkm,
        durationMinutes: editDurationMinutes,
        maxViolations: editMaxViolations,
        shuffleQuestions: editShuffleQuestions,
        shuffleOptions: editShuffleOptions,
        isActive: editIsActive,
      });
      setEditingPackage(null);
      await onRefresh();
      setFeedback({ type: 'ok', text: `Paket ujian "${editTitle.trim()}" berhasil diperbarui.` });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Gagal memperbarui paket ujian.' });
    } finally {
      setSavingEdit(false);
    }
  }

  function copyText(text: string, id: number) {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  }

  return (
    <div className="space-y-6">
      {/* Top Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white border border-slate-200 rounded-xl p-5">
        <div>
          <h2 className="font-display text-lg font-bold text-slate-900">Paket Ujian & Kendali Token</h2>
          <p className="text-xs text-slate-500 mt-1">
            Aktifkan sesi per kelas, tampilkan QR Code terenkripsi untuk APK Exambro, dan rotasi token saat berpindah kelas.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-full sm:w-44">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari paket / token..."
              className="w-full pl-8 pr-7 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="p-0.5 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer"
                aria-label="Hapus pencarian paket"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <select
            aria-label="Filter Mata Pelajaran"
            value={filterSubject}
            onChange={(e) => setFilterSubject(e.target.value)}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
          >
            <option value="ALL">Semua Mapel</option>
            {filterSubjects.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter Kelas"
            value={filterClass}
            onChange={(e) => setFilterClass(e.target.value)}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
          >
            <option value="ALL">Semua Kelas</option>
            {filterClasses.map((c) => (
              <option key={c.id} value={String(c.id)}>
                Kelas {c.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={!canCreatePackage}
            onClick={openCreateModal}
            title={!canCreatePackage ? 'Hubungi Admin Sekolah untuk menetapkan penugasan mengajar Anda' : undefined}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            Buat Paket Ujian
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-4 ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <span>{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)} className="text-slate-500 hover:text-slate-800 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Package Grid */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <BookOpen className="w-8 h-8 text-slate-400 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-800">Belum ada paket ujian pada filter ini</p>
          <p className="text-xs text-slate-500 mt-1 mb-4">Buat paket ujian baru atau ubah filter mata pelajaran dan kelas.</p>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Buat Paket Pertama
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          {filtered.map((pkg) => {
            const isPkgActive = pkg.is_active === 1;
            const isBusy = busyId === pkg.id;
            const isProctorOnly = pkg.access_role === 'PROCTOR';
            return (
              <div key={pkg.id} className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between gap-5">
                <div>
                  {/* Quiet text metadata header (Zero-Pill Discipline) */}
                  <div className="flex items-center justify-between gap-4 mb-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">{pkg.subject_name}</span>
                      <span aria-hidden="true">·</span>
                      <span>Kelas {pkg.class_name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{pkg.duration_minutes} menit</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">Maks {pkg.max_violations}x pelanggaran</span>
                      {isProctorOnly && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-blue-700">Tugas Mengawas</span>
                        </>
                      )}
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 ${
                        isPkgActive ? 'text-emerald-700' : 'text-slate-500'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" aria-hidden="true" />
                      {isPkgActive ? 'Aktif' : 'Nonaktif'}
                    </span>
                  </div>

                  <h3 className="font-display text-base font-bold text-slate-900">{pkg.title}</h3>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                    <span>
                      Guru Mapel: <strong className="font-semibold text-slate-700">{pkg.teacher_name || '-'}</strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Pengawas:{' '}
                      <strong className={`font-semibold ${pkg.proctor_name ? 'text-slate-700' : 'text-amber-700'}`}>
                        {pkg.proctor_name || 'Belum ditugaskan'}
                      </strong>
                    </span>
                    {pkg.exam_date && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">Tanggal: {pkg.exam_date}</span>
                      </>
                    )}
                    {pkg.schedule_group && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-blue-700 font-medium">Jadwal Paralel</span>
                      </>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600 tabular-nums">
                    <span>{pkg.question_count} Soal</span>
                    <span>{pkg.class_student_count} Siswa Terdaftar</span>
                    <span>{pkg.active_count} Sedang Ujian</span>
                    {pkg.locked_count > 0 && (
                      <span className="font-semibold text-red-700 inline-flex items-center gap-1">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        {pkg.locked_count} Terkunci
                      </span>
                    )}
                    <span>{pkg.submitted_count} Selesai</span>
                  </div>
                </div>

                {/* Token & QR Control Row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-slate-100">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="text-[11px] text-slate-500">Token Masuk Ujian</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-lg font-bold tracking-wider text-slate-900 tabular-nums">
                          {pkg.current_token}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyText(pkg.current_token, pkg.id)}
                          className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                          title="Salin Token"
                        >
                          {copiedId === pkg.id ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {!isProctorOnly && (
                      confirmRotateId === pkg.id ? (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 rounded-lg">
                          <span className="text-[11px] font-semibold text-slate-700">Rotasi token?</span>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleRotateToken(pkg)}
                            className="px-2 py-0.5 text-[11px] font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
                          >
                            {isBusy ? '...' : 'Ya'}
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setConfirmRotateId(null)}
                            className="px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer"
                          >
                            Batal
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            setConfirmDeleteId(null);
                            setConfirmRotateId(pkg.id);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
                          Acak / Rotate Token
                        </button>
                      )
                    )}

                    <button
                      type="button"
                      disabled={qrLoading}
                      onClick={() => handleOpenQr(pkg)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
                      Tampilkan QR
                    </button>

                    {!isProctorOnly && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleToggleActive(pkg)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          isPkgActive
                            ? 'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100'
                            : 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
                        }`}
                      >
                        <Power className="w-3.5 h-3.5" aria-hidden="true" />
                        {isPkgActive ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Action Footer */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenMonitoring(pkg.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Activity className="w-3.5 h-3.5" aria-hidden="true" />
                      Live Monitoring
                    </button>
                    {!isProctorOnly && (
                      <button
                        type="button"
                        onClick={() => onOpenQuestions(pkg.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                        Bank Soal ({pkg.question_count})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenRecap(pkg.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                      {isProctorOnly ? 'Status Selesai' : 'Rekap Nilai'}
                    </button>
                  </div>

                  {!isProctorOnly && (
                    confirmDeleteId === pkg.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-red-700 font-medium">Hapus paket?</span>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDelete(pkg.id)}
                          className="px-2.5 py-1 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                        >
                          {isBusy ? '...' : 'Ya'}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer"
                        >
                          Batal
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => openEditModal(pkg)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                          title="Edit Paket Ujian"
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            setConfirmRotateId(null);
                            setConfirmDeleteId(pkg.id);
                          }}
                          className="p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-50 transition-colors cursor-pointer"
                          title="Hapus Paket Ujian"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Package Modal */}
      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Buat Paket Ujian Baru"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !creating && !title.trim() && !cloneFromPackageId) {
              setShowCreateModal(false);
            }
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-bold text-slate-900">Buat Paket Ujian Baru</h3>
              <button
                type="button"
                disabled={creating}
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-50 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Judul Paket Ujian</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Contoh: UAS Matematika Semester Ganjil"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Mata Pelajaran</label>
                  <select
                    value={subjectId}
                    onChange={(e) => {
                      const nextSub = Number(e.target.value);
                      setSubjectId(nextSub);
                      if (!isAdmin) {
                        const validIds = classes
                          .filter((c) => assignments.some((a) => a.subject_id === nextSub && a.class_id === c.id))
                          .map((c) => c.id);
                        setSelectedClassIds((prev) => {
                          const kept = prev.filter((id) => validIds.includes(id));
                          return kept.length > 0 ? kept : validIds[0] ? [validIds[0]] : [];
                        });
                      }
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tanggal Ujian</label>
                  <input
                    type="date"
                    value={examDate}
                    onChange={(e) => setExamDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">KKM</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={kkm}
                    onChange={(e) => setKkm(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold text-slate-700">
                    Kelas Target ({selectedClassIds.length} dipilih)
                  </label>
                  <span className="text-[11px] text-slate-500">
                    Pilih &ge; 2 kelas untuk ujian paralel serentak
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  {createModalClasses.map((c) => {
                    const checked = selectedClassIds.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-colors ${
                          checked
                            ? 'bg-blue-50 border-blue-300 text-blue-900 font-semibold'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleTargetClass(c.id)}
                          className="rounded border-slate-300 text-blue-700"
                        />
                        <span>Kelas {c.name}</span>
                      </label>
                    );
                  })}
                </div>
                {selectedClassIds.length > 1 && (
                  <p className="text-[11px] text-blue-700 mt-1.5">
                    Sistem akan membuat paket terpisah per kelas (dengan token &amp; QR masing-masing) dalam satu jadwal paralel, serta menyinkronkan soal otomatis.
                  </p>
                )}
              </div>

              {isAdmin && selectedClassIds.length > 0 && (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800">
                      Penugasan Guru Pengawas (Khusus Admin)
                    </span>
                    <span className="text-[11px] text-slate-500">Pengawas hanya memantau sesi &amp; token</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {selectedClassIds.map((cid) => {
                      const cls = classes.find((c) => c.id === cid);
                      return (
                        <div key={cid}>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            Pengawas Kelas {cls?.name || cid}
                          </label>
                          <select
                            value={proctorsByClass[String(cid)] ?? ''}
                            onChange={(e) => {
                              const val = e.target.value ? Number(e.target.value) : null;
                              setProctorsByClass((prev) => ({ ...prev, [String(cid)]: val }));
                            }}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="">Belum ditugaskan</option>
                            {teachers.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name} ({t.nip})
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Durasi (Menit)</label>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(Number(e.target.value))}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Batas Pelanggaran Terkunci</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={maxViolations}
                    onChange={(e) => setMaxViolations(Number(e.target.value))}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Salin Bank Soal dari Paket Lain (Opsional)
                </label>
                <select
                  value={cloneFromPackageId}
                  onChange={(e) => setCloneFromPackageId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Kosongkan (buat soal manual)</option>
                  {packages
                    .filter((p) => p.access_role !== 'PROCTOR')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({p.question_count} soal)
                      </option>
                    ))}
                </select>
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shuffleQuestions}
                    onChange={(e) => setShuffleQuestions(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Acak urutan nomor soal per siswa (dikunci di server)
                </label>
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shuffleOptions}
                    onChange={(e) => setShuffleOptions(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Acak urutan pilihan jawaban (A/B/C/D) per siswa
                </label>
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Langsung aktifkan paket ujian setelah disimpan
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={creating || selectedClassIds.length === 0}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60 cursor-pointer"
                >
                  {creating ? 'Menyimpan...' : selectedClassIds.length > 1 ? `Simpan ${selectedClassIds.length} Paket` : 'Simpan Paket Ujian'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Package Modal */}
      {editingPackage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit Paket Ujian"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            const isDirty =
              editTitle.trim() !== editingPackage.title ||
              editSubjectId !== editingPackage.subject_id ||
              editClassId !== editingPackage.class_id ||
              editProctorId !== (editingPackage.proctor_id ?? null) ||
              editExamDate !== (editingPackage.exam_date || '') ||
              editKkm !== (editingPackage.kkm ?? 75) ||
              editDurationMinutes !== editingPackage.duration_minutes ||
              editMaxViolations !== editingPackage.max_violations ||
              editShuffleQuestions !== (editingPackage.shuffle_questions === 1) ||
              editShuffleOptions !== (editingPackage.shuffle_options === 1) ||
              editIsActive !== (editingPackage.is_active === 1);
            if (e.target === e.currentTarget && !savingEdit && !isDirty) setEditingPackage(null);
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-bold text-slate-900">Edit Paket Ujian</h3>
              <button
                type="button"
                disabled={savingEdit}
                onClick={() => setEditingPackage(null)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-50 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Judul Paket Ujian</label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Mata Pelajaran</label>
                  <select
                    value={editSubjectId}
                    onChange={(e) => {
                      const nextSub = Number(e.target.value);
                      setEditSubjectId(nextSub);
                      if (!isAdmin) {
                        const validClasses = classes.filter((c) =>
                          assignments.some((a) => a.subject_id === nextSub && a.class_id === c.id)
                        );
                        if (!validClasses.some((c) => c.id === editClassId) && validClasses[0]) {
                          setEditClassId(validClasses[0].id);
                        }
                      }
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Kelas Target</label>
                  <select
                    value={editClassId}
                    onChange={(e) => setEditClassId(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {editModalClasses.map((c) => (
                      <option key={c.id} value={c.id}>
                        Kelas {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tanggal Ujian</label>
                  <input
                    type="date"
                    value={editExamDate}
                    onChange={(e) => setEditExamDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">KKM</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={editKkm}
                    onChange={(e) => setEditKkm(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              {isAdmin && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Guru Pengawas (Ditentukan Admin)
                  </label>
                  <select
                    value={editProctorId ?? ''}
                    onChange={(e) => setEditProctorId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">Belum ditugaskan</option>
                    {teachers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.nip})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Durasi (Menit)</label>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    value={editDurationMinutes}
                    onChange={(e) => setEditDurationMinutes(Number(e.target.value))}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Batas Pelanggaran Terkunci</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={editMaxViolations}
                    onChange={(e) => setEditMaxViolations(Number(e.target.value))}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editShuffleQuestions}
                    onChange={(e) => setEditShuffleQuestions(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Acak urutan nomor soal per siswa (dikunci di server)
                </label>
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editShuffleOptions}
                    onChange={(e) => setEditShuffleOptions(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Acak urutan pilihan jawaban (A/B/C/D) per siswa
                </label>
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editIsActive}
                    onChange={(e) => setEditIsActive(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Status paket ujian aktif
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  disabled={savingEdit}
                  onClick={() => setEditingPackage(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60 cursor-pointer"
                >
                  {savingEdit ? 'Menyimpan...' : 'Simpan Perubahan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Direct Student Exam QR Modal */}
      {qrModalData && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`QR Code Ujian ${qrModalData.title}`}
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setQrModalData(null);
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <p className="text-xs text-slate-500">
                  {qrModalData.subjectName} · Kelas {qrModalData.className}
                  {qrModalData.examDate ? ` · ${qrModalData.examDate}` : ''}
                </p>
                <h3 className="font-display text-base font-bold text-slate-900 mt-0.5">{qrModalData.title}</h3>
                {(qrModalData.teacherName || qrModalData.proctorName) && (
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {qrModalData.teacherName ? `Guru: ${qrModalData.teacherName}` : ''}
                    {qrModalData.teacherName && qrModalData.proctorName ? ' · ' : ''}
                    {qrModalData.proctorName ? `Pengawas: ${qrModalData.proctorName}` : ''}
                  </p>
                )}
              </div>
              <button type="button" onClick={() => setQrModalData(null)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 flex flex-col items-center">
              <img
                src={qrModalData.qrDataUrl}
                alt={`QR Code untuk ${qrModalData.title}`}
                className="w-56 h-56 rounded-lg bg-white p-2 border border-slate-200"
                referrerPolicy="no-referrer"
              />

              <div className="mt-4 w-full bg-white border border-slate-200 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-medium text-slate-500">Token Ujian (Ketik Manual)</div>
                  <div className="font-mono text-2xl font-bold tracking-widest text-slate-900 tabular-nums mt-0.5">
                    {qrModalData.currentToken}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copyText(qrModalData.currentToken, -98)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedId === -98 ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedId === -98 ? 'Tersalin' : 'Salin Token'}
                </button>
              </div>

              <p className="text-xs font-semibold text-slate-800 mt-3 text-center">
                Pindai QR untuk Membuka Langsung Ruang Soal Siswa
              </p>
              <p className="text-[11px] text-slate-500 text-center mt-1 leading-relaxed">
                QR mengarahkan siswa langsung ke halaman ujian dengan Token terisi otomatis. Siswa cukup memasukkan NIS dan PIN Semester untuk masuk ke soal.
              </p>
            </div>

            <div className="mt-4 space-y-2">
              <div className="text-[11px] font-semibold text-slate-600">Link Langsung Ruang Soal Siswa</div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={qrModalData.studentExamUrl}
                  className="flex-1 px-3 py-1.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-700 truncate"
                />
                <button
                  type="button"
                  onClick={() => copyText(qrModalData.studentExamUrl, -99)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedId === -99 ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedId === -99 ? 'Tersalin' : 'Salin Link'}
                </button>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setQrModalData(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
