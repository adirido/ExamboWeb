import React, { useState } from 'react';
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
} from 'lucide-react';
import { teacherApi } from '../api';
import type { ClassItem, ExamPackage, QrPayloadResponse, SubjectItem, TeacherAssignment } from '../types';

interface PackagesViewProps {
  token: string;
  packages: ExamPackage[];
  assignments: TeacherAssignment[];
  subjects: SubjectItem[];
  classes: ClassItem[];
  onRefresh: () => Promise<void>;
  onOpenMonitoring: (packageId: number) => void;
  onOpenQuestions: (packageId: number) => void;
  onOpenRecap: (packageId: number) => void;
}

export const PackagesView: React.FC<PackagesViewProps> = ({
  token,
  packages,
  assignments,
  subjects,
  classes,
  onRefresh,
  onOpenMonitoring,
  onOpenQuestions,
  onOpenRecap,
}) => {
  const [filterClass, setFilterClass] = useState<string>('ALL');
  const [filterSubject, setFilterSubject] = useState<string>('ALL');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [qrModalData, setQrModalData] = useState<QrPayloadResponse | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Create form state
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState<number>(assignments[0]?.subject_id || subjects[0]?.id || 1);
  const [classId, setClassId] = useState<number>(assignments[0]?.class_id || classes[0]?.id || 1);
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
  const [editDurationMinutes, setEditDurationMinutes] = useState(60);
  const [editMaxViolations, setEditMaxViolations] = useState(3);
  const [editShuffleQuestions, setEditShuffleQuestions] = useState(true);
  const [editShuffleOptions, setEditShuffleOptions] = useState(true);
  const [editIsActive, setEditIsActive] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);

  const filtered = packages.filter((p) => {
    if (filterClass !== 'ALL' && String(p.class_id) !== filterClass) return false;
    if (filterSubject !== 'ALL' && String(p.subject_id) !== filterSubject) return false;
    return true;
  });

  async function handleToggleActive(pkg: ExamPackage) {
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
    setBusyId(pkg.id);
    setFeedback(null);
    try {
      const res = await teacherApi.rotateToken(token, pkg.id);
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

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setFeedback(null);
    try {
      await teacherApi.createPackage(token, {
        title,
        subjectId,
        classId,
        durationMinutes,
        maxViolations,
        shuffleQuestions,
        shuffleOptions,
        isActive,
        cloneFromPackageId: cloneFromPackageId ? Number(cloneFromPackageId) : undefined,
      });
      setShowCreateModal(false);
      setTitle('');
      setCloneFromPackageId('');
      await onRefresh();
      setFeedback({ type: 'ok', text: 'Paket ujian baru berhasil dibuat dan siap digunakan.' });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Gagal membuat paket ujian.' });
    } finally {
      setCreating(false);
    }
  }

  function openEditModal(pkg: ExamPackage) {
    setEditingPackage(pkg);
    setEditTitle(pkg.title);
    setEditSubjectId(pkg.subject_id);
    setEditClassId(pkg.class_id);
    setEditDurationMinutes(pkg.duration_minutes);
    setEditMaxViolations(pkg.max_violations);
    setEditShuffleQuestions(pkg.shuffle_questions === 1);
    setEditShuffleOptions(pkg.shuffle_options === 1);
    setEditIsActive(pkg.is_active === 1);
    setFeedback(null);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPackage) return;
    setSavingEdit(true);
    setFeedback(null);
    try {
      await teacherApi.updatePackage(token, editingPackage.id, {
        title: editTitle.trim(),
        subjectId: editSubjectId,
        classId: editClassId,
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
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter Mata Pelajaran"
            value={filterSubject}
            onChange={(e) => setFilterSubject(e.target.value)}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
          >
            <option value="ALL">Semua Mapel</option>
            {subjects.map((s) => (
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
            {classes.map((c) => (
              <option key={c.id} value={String(c.id)}>
                Kelas {c.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
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
            onClick={() => setShowCreateModal(true)}
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
            return (
              <div key={pkg.id} className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between gap-5">
                <div>
                  {/* Quiet text metadata header (Zero-Pill Discipline) */}
                  <div className="flex items-center justify-between gap-4 mb-2">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">{pkg.subject_name}</span>
                      <span aria-hidden="true">·</span>
                      <span>Kelas {pkg.class_name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{pkg.duration_minutes} menit</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">Maks {pkg.max_violations}x pelanggaran</span>
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
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleRotateToken(pkg)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
                      Acak / Rotate Token
                    </button>

                    <button
                      type="button"
                      disabled={qrLoading}
                      onClick={() => handleOpenQr(pkg)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
                      Tampilkan QR
                    </button>

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
                    <button
                      type="button"
                      onClick={() => onOpenQuestions(pkg.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                      Bank Soal ({pkg.question_count})
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenRecap(pkg.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                      Rekap Nilai
                    </button>
                  </div>

                  {confirmDeleteId === pkg.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-700 font-medium">Hapus paket?</span>
                      <button
                        type="button"
                        onClick={() => handleDelete(pkg.id)}
                        className="px-2.5 py-1 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-700 cursor-pointer"
                      >
                        Ya
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                      >
                        Batal
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditModal(pkg)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors cursor-pointer"
                        title="Edit Paket Ujian"
                      >
                        <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(pkg.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 transition-colors cursor-pointer"
                        title="Hapus Paket Ujian"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Package Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-bold text-slate-900">Buat Paket Ujian Baru</h3>
              <button type="button" onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
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
                  placeholder="Contoh: UAS Matematika Kelas 8B — Semester Ganjil"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Mata Pelajaran</label>
                  <select
                    value={subjectId}
                    onChange={(e) => setSubjectId(Number(e.target.value))}
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
                    value={classId}
                    onChange={(e) => setClassId(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        Kelas {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

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
                  {packages.map((p) => (
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
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60 cursor-pointer"
                >
                  {creating ? 'Menyimpan...' : 'Simpan Paket Ujian'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Package Modal */}
      {editingPackage && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-bold text-slate-900">Edit Paket Ujian</h3>
              <button
                type="button"
                onClick={() => setEditingPackage(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
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
                    onChange={(e) => setEditSubjectId(Number(e.target.value))}
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
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        Kelas {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

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
                  onClick={() => setEditingPackage(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
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
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <p className="text-xs text-slate-500">
                  {qrModalData.subjectName} · Kelas {qrModalData.className}
                </p>
                <h3 className="font-display text-base font-bold text-slate-900 mt-0.5">{qrModalData.title}</h3>
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
