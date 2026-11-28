import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Trash2,
  Edit3,
  CheckCircle2,
  X,
  BookOpen,
  FolderPlus,
  RefreshCw,
  Upload,
  Download,
  FileSpreadsheet,
  Sparkles,
  Info,
  AlertCircle,
  Search,
} from 'lucide-react';
import { teacherApi } from '../api';
import { useToast } from './ToastProvider';
import type {
  ClassItem,
  ExamPackage,
  ImportQuestionsResult,
  QuestionOption,
  SubjectItem,
  TeacherAssignment,
  TeacherQuestion,
} from '../types';

interface QuestionBankViewProps {
  token: string;
  teacherRole?: 'ADMIN' | 'TEACHER';
  assignments?: TeacherAssignment[];
  packages: ExamPackage[];
  subjects: SubjectItem[];
  classes: ClassItem[];
  selectedPackageId: number | null;
  onSelectPackage: (id: number) => void;
  onPackagesChanged: () => Promise<void>;
}

const DEFAULT_OPTIONS: QuestionOption[] = [
  { key: 'A', text: '' },
  { key: 'B', text: '' },
  { key: 'C', text: '' },
  { key: 'D', text: '' },
];

const SAMPLE_QUESTIONS_IMPORT = [
  'Hasil dari 15 + (-8) x 2 adalah...,-1,14,1,-14,A,20',
  'Sebuah segitiga memiliki alas 12 cm dan tinggi 8 cm. Luasnya adalah...,96 cm²,48 cm²,40 cm²,24 cm²,B,20',
  'Nilai x yang memenuhi persamaan 3x - 7 = 14 adalah...,5,6,7,8,C,20',
].join('\n');

const TEMPLATE_QUESTIONS_CSV = [
  'Pertanyaan,Opsi A,Opsi B,Opsi C,Opsi D,Kunci Jawaban,Bobot Poin',
  'Hasil dari 15 + (-8) x 2 adalah...,-1,14,1,-14,A,20',
  'Sebuah segitiga memiliki alas 12 cm dan tinggi 8 cm. Luasnya adalah...,96 cm²,48 cm²,40 cm²,24 cm²,B,20',
].join('\n');

function generateClientToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export const QuestionBankView: React.FC<QuestionBankViewProps> = ({
  token,
  teacherRole = 'TEACHER',
  assignments = [],
  packages,
  subjects,
  classes,
  selectedPackageId,
  onSelectPackage,
  onPackagesChanged,
}) => {
  const toast = useToast();
  const isAdmin = teacherRole === 'ADMIN';
  const canCreatePackage = isAdmin || assignments.length > 0;
  const editablePackages = packages.filter((p) => p.access_role !== 'PROCTOR');
  const activePkgId =
    (selectedPackageId && editablePackages.some((p) => p.id === selectedPackageId)
      ? selectedPackageId
      : editablePackages[0]?.id) || null;
  const activePkg = editablePackages.find((p) => p.id === activePkgId) || null;
  const parallelSiblings = activePkg?.schedule_group
    ? editablePackages.filter((p) => p.schedule_group === activePkg.schedule_group && p.id !== activePkg.id)
    : [];
  const [syncSiblings, setSyncSiblings] = useState(true);

  const [questions, setQuestions] = useState<TeacherQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [questionText, setQuestionText] = useState('');
  const [options, setOptions] = useState<QuestionOption[]>(DEFAULT_OPTIONS);
  const [correctOption, setCorrectOption] = useState('A');
  const [points, setPoints] = useState(20);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // New Package Modal state
  const [showNewPkgModal, setShowNewPkgModal] = useState(false);
  const [pkgTitle, setPkgTitle] = useState('');
  const [pkgSubjectId, setPkgSubjectId] = useState<number>(subjects[0]?.id || 1);
  const [pkgClassName, setPkgClassName] = useState<string>(classes[0]?.name || '');
  const [pkgDuration, setPkgDuration] = useState(60);
  const [pkgToken, setPkgToken] = useState('');
  const [pkgShuffleQ, setPkgShuffleQ] = useState(true);
  const [pkgShuffleOpt, setPkgShuffleOpt] = useState(true);
  const [pkgActive, setPkgActive] = useState(true);
  const [creatingPkg, setCreatingPkg] = useState(false);
  const [pkgError, setPkgError] = useState<string | null>(null);

  const availableModalClasses = isAdmin
    ? classes
    : classes.filter((c) => assignments.some((a) => a.subject_id === pkgSubjectId && a.class_id === c.id));

  // Import Questions Modal state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importModalTab, setImportModalTab] = useState<'input' | 'result'>('input');
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportQuestionsResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!activePkgId) {
      setQuestions([]);
      setHasLoaded(true);
      return;
    }
    setSearchQuery('');
    loadQuestions(activePkgId);
  }, [activePkgId]);

  useEffect(() => {
    if (!showNewPkgModal && !showImportModal && !showEditor && confirmDeleteId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (creatingPkg || importing || saving) return;
        if (showNewPkgModal) {
          setShowNewPkgModal(false);
          return;
        }
        if (showImportModal) {
          setShowImportModal(false);
          return;
        }
        if (showEditor) {
          setShowEditor(false);
          return;
        }
        setConfirmDeleteId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showNewPkgModal, showImportModal, showEditor, creatingPkg, importing, saving, confirmDeleteId]);

  async function loadQuestions(pkgId: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await teacherApi.getQuestions(token, pkgId);
      setQuestions(res.questions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat bank soal.');
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }

  function openNewModal() {
    setEditingId(null);
    setQuestionText('');
    setOptions(DEFAULT_OPTIONS.map((o) => ({ ...o })));
    setCorrectOption('A');
    setPoints(20);
    setShowEditor(true);
  }

  function openEditModal(q: TeacherQuestion) {
    setEditingId(q.id);
    setQuestionText(q.question_text);
    setOptions(q.options.map((o) => ({ ...o })));
    setCorrectOption(q.correct_option);
    setPoints(q.points);
    setShowEditor(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!activePkgId || saving) return;
    setSaving(true);
    setError(null);
    try {
      let syncedCount = 0;
      if (editingId) {
        const res = await teacherApi.updateQuestion(token, editingId, {
          questionText,
          options,
          correctOption,
          points,
          syncSiblings,
        });
        syncedCount = res.syncedPackageCount || 0;
      } else {
        const res = await teacherApi.createQuestion(token, activePkgId, {
          questionText,
          options,
          correctOption,
          points,
          syncSiblings,
        });
        syncedCount = res.syncedPackageCount || 0;
      }
      setShowEditor(false);
      if (syncedCount > 0) {
        toast.success(
          `Soal tersimpan dan otomatis disinkronkan ke ${syncedCount} kelas paralel pada jadwal yang sama.`
        );
      } else {
        toast.success(editingId ? 'Soal berhasil diperbarui.' : 'Soal baru berhasil ditambahkan.');
      }
      await loadQuestions(activePkgId);
      await onPackagesChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Gagal menyimpan soal.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(qId: number) {
    if (!activePkgId || deletingId !== null) return;
    setDeletingId(qId);
    try {
      await teacherApi.deleteQuestion(token, qId);
      setConfirmDeleteId(null);
      toast.success('Soal berhasil dihapus.');
      await loadQuestions(activePkgId);
      await onPackagesChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Gagal menghapus soal.');
    } finally {
      setDeletingId(null);
    }
  }

  function openNewPackageModal() {
    if (!canCreatePackage) {
      toast.error('Akun Anda belum memiliki penugasan mata pelajaran & kelas dari Admin Sekolah.');
      return;
    }
    const initSubject = assignments[0]?.subject_id || subjects[0]?.id || 1;
    const initClass =
      classes.find((c) => assignments.some((a) => a.subject_id === initSubject && a.class_id === c.id))?.name ||
      classes[0]?.name ||
      '';
    setPkgError(null);
    setPkgTitle('');
    setPkgSubjectId(initSubject);
    setPkgClassName(initClass);
    setPkgDuration(60);
    setPkgToken(generateClientToken());
    setPkgShuffleQ(true);
    setPkgShuffleOpt(true);
    setPkgActive(true);
    setShowNewPkgModal(true);
  }

  async function handleCreatePackage(e: React.FormEvent) {
    e.preventDefault();
    if (creatingPkg) return;
    setPkgError(null);
    setCreatingPkg(true);
    try {
      const matchedClass = classes.find(
        (c) => c.name.toLowerCase() === pkgClassName.replace(/^kelas\s+/i, '').trim().toLowerCase()
      );
      const res = await teacherApi.createPackage(token, {
        title: pkgTitle,
        subjectId: pkgSubjectId,
        classId: matchedClass?.id,
        className: matchedClass ? undefined : pkgClassName,
        durationMinutes: pkgDuration,
        maxViolations: 3,
        shuffleQuestions: pkgShuffleQ,
        shuffleOptions: pkgShuffleOpt,
        isActive: pkgActive,
        initialToken: pkgToken.trim() || undefined,
      });

      await onPackagesChanged();
      onSelectPackage(res.package.id);
      setShowNewPkgModal(false);
      toast.success(
        `Paket "${res.package.title}" (Token: ${res.package.current_token}) berhasil dibuat dan dipilih.`
      );
    } catch (err) {
      setPkgError(err instanceof Error ? err.message : 'Gagal membuat paket ujian baru.');
    } finally {
      setCreatingPkg(false);
    }
  }

  function openImportModal() {
    setImportError(null);
    setImportResult(null);
    setImportFileName(null);
    setReplaceExisting(false);
    setImportModalTab('input');
    setShowImportModal(true);
  }

  function handleLoadSampleQuestions() {
    setImportText(SAMPLE_QUESTIONS_IMPORT);
    setImportFileName(null);
    setImportError(null);
    setImportResult(null);
  }

  function handleDownloadTemplateQuestions() {
    const blob = new Blob(['\uFEFF' + TEMPLATE_QUESTIONS_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'template-import-soal.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleCsvFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    setImportError(null);
    setImportResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      setImportError('Gagal membaca file CSV dari perangkat.');
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  }

  async function handleSubmitImportQuestions(e: React.FormEvent) {
    e.preventDefault();
    if (!activePkgId || importing) return;
    if (!importText.trim()) {
      setImportError('Silakan tempel data soal, klik Muat Contoh, atau pilih file .CSV terlebih dahulu.');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const res = await teacherApi.importQuestions(token, activePkgId, {
        rawText: importText,
        replaceExisting,
        syncSiblings,
      });
      setImportResult(res);
      setImportModalTab('result');
      if (res.summary.syncedPackageCount && res.summary.syncedPackageCount > 0) {
        toast.success(
          `${res.summary.createdCount} soal diimpor dan disinkronkan ke ${res.summary.syncedPackageCount} kelas paralel.`
        );
      } else if (res.summary.createdCount > 0) {
        toast.success(`${res.summary.createdCount} soal berhasil diimpor ke Bank Soal.`);
      }
      await loadQuestions(activePkgId);
      await onPackagesChanged();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Gagal mengimpor soal.');
    } finally {
      setImporting(false);
    }
  }

  const parsedPreviewCount = importText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;

  const filteredQuestions = questions.filter((q) => {
    if (!searchQuery.trim()) return true;
    const term = searchQuery.trim().toLowerCase();
    return (
      q.question_text.toLowerCase().includes(term) ||
      q.options.some((o) => o.text.toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold text-slate-900">Bank Soal Paket Ujian</h2>
          <p className="text-xs text-slate-500 mt-1">
            Semua siswa menerima kumpulan soal yang sama. Urutan nomor soal dan opsi jawaban diacak dan dikunci di server per sesi siswa.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 shrink-0">
          <select
            aria-label="Pilih Paket Ujian"
            value={activePkgId || ''}
            onChange={(e) => onSelectPackage(Number(e.target.value))}
            className="w-full sm:w-64 px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-800 truncate shrink-0"
          >
            {editablePackages.length === 0 ? (
              <option value="">Tidak ada paket Bank Soal</option>
            ) : (
              editablePackages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.class_name})
                </option>
              ))
            )}
          </select>

          <button
            type="button"
            disabled={!canCreatePackage}
            onClick={openNewPackageModal}
            title={!canCreatePackage ? 'Hubungi Admin Sekolah untuk menetapkan penugasan mengajar Anda' : undefined}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FolderPlus className="w-4 h-4 text-blue-700" aria-hidden="true" />
            + Paket Baru
          </button>

          <button
            type="button"
            disabled={!activePkgId}
            onClick={openImportModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-4 h-4 text-blue-700" aria-hidden="true" />
            Import Soal
          </button>

          <button
            type="button"
            disabled={!activePkgId}
            onClick={openNewModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            + Tambah Soal
          </button>
        </div>
      </div>

      <div className="min-h-[24px] flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-slate-600 overflow-x-hidden">
        {activePkg ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 overflow-x-hidden min-w-0">
            <span className="whitespace-nowrap truncate">Mapel: <strong className="text-slate-900">{activePkg.subject_name}</strong></span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="whitespace-nowrap shrink-0">Kelas: <strong className="text-slate-900">{activePkg.class_name}</strong></span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="whitespace-nowrap shrink-0">Token: <strong className="font-mono text-slate-900">{activePkg.current_token}</strong></span>
            <span aria-hidden="true" className="hidden md:inline shrink-0">·</span>
            <span className="hidden md:inline whitespace-nowrap shrink-0">Acak Soal: <strong className="text-slate-900">{activePkg.shuffle_questions ? 'Aktif' : 'Tidak'}</strong></span>
            <span aria-hidden="true" className="hidden lg:inline shrink-0">·</span>
            <span className="hidden lg:inline whitespace-nowrap shrink-0">Acak Opsi: <strong className="text-slate-900">{activePkg.shuffle_options ? 'Aktif' : 'Tidak'}</strong></span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="tabular-nums whitespace-nowrap shrink-0">Total Bobot: <strong className="text-slate-900">{questions.reduce((acc, q) => acc + q.points, 0)} poin</strong></span>
          </div>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2 shrink-0">
          {questions.length > 0 && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari teks soal..."
                className="pl-8 pr-7 py-1.5 text-xs bg-white border border-slate-300 rounded-lg w-48 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="p-0.5 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer"
                  aria-label="Hapus pencarian soal"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          {loading && hasLoaded && (
            <span className="font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0">Memuat...</span>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700">{error}</div>
      )}

      {parallelSiblings.length > 0 && (
        <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-blue-900">
          <div>
            <span className="font-semibold">Jadwal Paralel Aktif:</span>{' '}
            Paket ini terhubung dengan kelas{' '}
            <strong>{parallelSiblings.map((s) => s.class_name).join(', ')}</strong>. Perubahan soal dapat disinkronkan otomatis selama kelas paralel belum memiliki sesi ujian berjalan.
          </div>
          <label className="inline-flex items-center gap-2 font-semibold whitespace-nowrap shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={syncSiblings}
              onChange={(e) => setSyncSiblings(e.target.checked)}
              className="rounded border-blue-300 text-blue-700"
            />
            Sinkronkan otomatis
          </label>
        </div>
      )}

      <div className={`min-h-[420px] transition-opacity duration-150 ${loading && hasLoaded ? 'opacity-60' : 'opacity-100'}`}>
        {!hasLoaded && loading ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-4">
            <div className="h-5 bg-slate-100 rounded w-1/3 animate-pulse" />
            <div className="h-16 bg-slate-100 rounded w-full animate-pulse" />
          </div>
        ) : !activePkgId ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center min-h-[260px] flex flex-col items-center justify-center">
            <BookOpen className="w-8 h-8 text-slate-400 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-800">Tidak ada paket Bank Soal yang dapat dikelola</p>
            <p className="text-xs text-slate-500 mt-1 mb-5 max-w-md">
              Paket yang hanya menugaskan Anda sebagai Guru Pengawas tidak membuka akses Bank Soal. Buat paket ujian baru untuk mata pelajaran Anda.
            </p>
            <button
              type="button"
              onClick={openNewPackageModal}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap cursor-pointer"
            >
              <FolderPlus className="w-4 h-4" />
              Buat Paket Ujian Baru
            </button>
          </div>
        ) : questions.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center min-h-[260px] flex flex-col items-center justify-center">
            <BookOpen className="w-8 h-8 text-slate-400 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-800">Belum ada soal pada paket ujian ini</p>
            <p className="text-xs text-slate-500 mt-1 mb-5">
              Tambahkan soal satu per satu atau gunakan fitur Import Soal massal dari Excel/CSV.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={openImportModal}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                <Upload className="w-4 h-4 text-blue-700" />
                Import Soal CSV
              </button>
              <button
                type="button"
                onClick={openNewModal}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Tambah Soal Pertama
              </button>
            </div>
          </div>
        ) : filteredQuestions.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
            <Search className="w-7 h-7 text-slate-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-800">Tidak ada soal yang cocok dengan &ldquo;{searchQuery}&rdquo;</p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="mt-3 px-3.5 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 cursor-pointer"
            >
              Tampilkan Semua Soal ({questions.length})
            </button>
          </div>
        ) : (
          <div className="space-y-4">
          {filteredQuestions.map((q) => {
            const originalNumber = questions.findIndex((item) => item.id === q.id) + 1;
            return (
            <div key={q.id} className="bg-white border border-slate-200 rounded-xl p-6">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
                  <span className="font-mono font-semibold text-slate-800">Soal #{originalNumber}</span>
                  <span aria-hidden="true">·</span>
                  <span>ID Server: {q.id}</span>
                  <span aria-hidden="true">·</span>
                  <span>Bobot {q.points} poin</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={deletingId === q.id}
                    onClick={() => openEditModal(q)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Ubah
                  </button>
                  {confirmDeleteId === q.id ? (
                    <div className="inline-flex items-center gap-1.5">
                      <span className="text-[11px] font-semibold text-red-700">Hapus soal?</span>
                      <button
                        type="button"
                        disabled={deletingId === q.id}
                        onClick={() => handleDelete(q.id)}
                        className="px-2 py-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded cursor-pointer"
                      >
                        {deletingId === q.id ? '...' : 'Ya'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === q.id}
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer"
                      >
                        Batal
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={deletingId === q.id}
                      onClick={() => setConfirmDeleteId(q.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Hapus
                    </button>
                  )}
                </div>
              </div>

              <p className="text-sm font-medium text-slate-900 leading-relaxed mb-4">{q.question_text}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {q.options.map((opt) => {
                  const isCorrect = opt.key === q.correct_option;
                  return (
                    <div
                      key={opt.key}
                      className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border text-xs ${
                        isCorrect
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900 font-semibold'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono font-bold">{opt.key}.</span>
                        <span>{opt.text}</span>
                      </div>
                      {isCorrect && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 shrink-0">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Kunci
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })}
          </div>
        )}
      </div>

      {/* Modal Tambah Paket Baru */}
      {showNewPkgModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Tambah Paket Ujian Baru"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !creatingPkg && !pkgTitle.trim()) {
              setShowNewPkgModal(false);
            }
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">Tambah Paket Ujian Baru</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Paket baru otomatis dipilih pada Bank Soal agar langsung siap diisi soal.
                </p>
              </div>
              <button
                type="button"
                disabled={creatingPkg}
                onClick={() => setShowNewPkgModal(false)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-50 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {pkgError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {pkgError}
              </div>
            )}

            <form onSubmit={handleCreatePackage} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Paket Ujian</label>
                <input
                  type="text"
                  required
                  value={pkgTitle}
                  onChange={(e) => setPkgTitle(e.target.value)}
                  placeholder="Contoh: PTS Matematika Kelas 7A"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Mata Pelajaran</label>
                  <select
                    value={pkgSubjectId}
                    onChange={(e) => {
                      const nextSub = Number(e.target.value);
                      setPkgSubjectId(nextSub);
                      if (!isAdmin) {
                        const validClasses = classes.filter((c) =>
                          assignments.some((a) => a.subject_id === nextSub && a.class_id === c.id)
                        );
                        if (!validClasses.some((c) => c.name === pkgClassName) && validClasses[0]) {
                          setPkgClassName(validClasses[0].name);
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
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAdmin ? 'Kelas (misal: 7A, 8A, 8B)' : 'Kelas Penugasan'}
                  </label>
                  {isAdmin ? (
                    <>
                      <input
                        type="text"
                        required
                        list="examflow-class-list"
                        value={pkgClassName}
                        onChange={(e) => setPkgClassName(e.target.value.toUpperCase())}
                        placeholder="7A / 8A / 8B"
                        className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono uppercase"
                      />
                      <datalist id="examflow-class-list">
                        {classes.map((c) => (
                          <option key={c.id} value={c.name} />
                        ))}
                      </datalist>
                    </>
                  ) : (
                    <select
                      required
                      value={pkgClassName}
                      onChange={(e) => setPkgClassName(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      {availableModalClasses.map((c) => (
                        <option key={c.id} value={c.name}>
                          Kelas {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Durasi (Menit)</label>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    required
                    value={pkgDuration}
                    onChange={(e) => setPkgDuration(Number(e.target.value))}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Token Ujian Awal</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      maxLength={12}
                      value={pkgToken}
                      onChange={(e) => setPkgToken(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                      placeholder="Otomatis jika kosong"
                      className="flex-1 px-3 py-2 text-sm font-mono font-bold tracking-wider uppercase border border-slate-300 rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={() => setPkgToken(generateClientToken())}
                      className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg shrink-0 cursor-pointer"
                      title="Acak Token Baru"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Acak
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5 pt-1">
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pkgShuffleQ}
                    onChange={(e) => setPkgShuffleQ(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Acak Nomor Soal per siswa (dikunci di server)
                </label>
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pkgShuffleOpt}
                    onChange={(e) => setPkgShuffleOpt(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Acak Opsi Jawaban (A/B/C/D) per siswa
                </label>
                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pkgActive}
                    onChange={(e) => setPkgActive(e.target.checked)}
                    className="rounded border-slate-300 text-blue-700"
                  />
                  Langsung aktifkan paket ujian setelah disimpan
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  disabled={creatingPkg}
                  onClick={() => setShowNewPkgModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={creatingPkg}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60 cursor-pointer"
                >
                  {creatingPkg ? 'Menyimpan...' : 'Simpan Paket Baru'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Import Soal (stabil dengan tinggi konsisten, tab, dan footer tetap) */}
      {showImportModal && activePkg && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Import Soal ke Paket Ujian"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !importing && !importText.trim()) {
              setShowImportModal(false);
            }
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl h-[84vh] max-h-[720px] min-h-[520px] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
              <div className="min-w-0">
                <h3 className="font-display text-lg font-bold text-slate-900 truncate">Import Soal ke Paket Ujian</h3>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  Target: <strong className="text-slate-800">{activePkg.title}</strong> ({activePkg.class_name})
                </p>
              </div>
              <button
                type="button"
                disabled={importing}
                onClick={() => setShowImportModal(false)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-50 shrink-0 cursor-pointer"
                aria-label="Tutup modal import soal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Segmented Tab Bar */}
            <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-4 overflow-x-hidden shrink-0">
              <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg overflow-x-hidden">
                <button
                  type="button"
                  onClick={() => setImportModalTab('input')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    importModalTab === 'input'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Input & Tempel Soal (<span className="tabular-nums">{parsedPreviewCount}</span>)
                </button>
                <button
                  type="button"
                  onClick={() => setImportModalTab('result')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    importModalTab === 'result'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Hasil Impor Soal
                  {importResult ? ` (${importResult.summary.createdCount})` : ''}
                </button>
              </div>
              <span className="text-[11px] font-mono text-slate-500 whitespace-nowrap shrink-0 tabular-nums hidden sm:inline">
                {parsedPreviewCount} baris siap
              </span>
            </div>

            <div className="flex-1 min-h-0 p-6 overflow-y-auto overflow-x-hidden scrollbar-stable">
              {importModalTab === 'input' ? (
                <div className="space-y-4">
                  {/* 1. Toolbar Atas */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        onClick={handleLoadSampleQuestions}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-blue-700 shrink-0" aria-hidden="true" />
                        Muat Contoh
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadTemplateQuestions}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5 text-slate-600 shrink-0" aria-hidden="true" />
                        Template CSV
                      </button>

                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        Pilih File .CSV
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.txt,text/csv"
                        onChange={handleCsvFileSelected}
                        className="hidden"
                      />
                    </div>

                    {importFileName && (
                      <span className="text-xs font-mono text-slate-600 truncate max-w-xs">
                        File: {importFileName}
                      </span>
                    )}
                  </div>

                  {/* 2. Petunjuk Format */}
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-xs text-slate-700">
                    <div className="flex items-center gap-2 font-semibold text-slate-900">
                      <Info className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
                      Aturan Urutan 6–7 Kolom (Salin-Tempel Excel / CSV)
                    </div>
                    <p className="leading-relaxed text-slate-600">
                      Susun setiap baris dengan urutan:{' '}
                      <strong className="text-slate-900">1. Pertanyaan</strong>,{' '}
                      <strong className="text-slate-900">2. Opsi A</strong>,{' '}
                      <strong className="text-slate-900">3. Opsi B</strong>,{' '}
                      <strong className="text-slate-900">4. Opsi C</strong>,{' '}
                      <strong className="text-slate-900">5. Opsi D</strong>,{' '}
                      <strong className="text-slate-900">6. Kunci Jawaban</strong> (<span className="font-mono">A/B/C/D</span>), dan{' '}
                      <strong className="text-slate-900">7. Bobot Poin</strong> (opsional, default <span className="font-mono">20</span>).
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Parser mendukung salin-tempel langsung dari tabel Excel (pemisah <span className="font-mono">Tab</span>), koma (<span className="font-mono">,</span>), atau titik koma (<span className="font-mono">;</span>).
                    </p>
                  </div>

                  {importError && (
                    <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{importError}</span>
                    </div>
                  )}

                  <form id="import-questions-form" onSubmit={handleSubmitImportQuestions} className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label htmlFor="questions-import-textarea" className="text-xs font-semibold text-slate-700">
                          Data Soal (Tempel dari Excel / CSV)
                        </label>
                        <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                          {parsedPreviewCount} baris terdeteksi
                        </span>
                      </div>
                      <textarea
                        id="questions-import-textarea"
                        rows={7}
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        placeholder={`Hasil dari 15 + (-8) x 2 adalah...,-1,14,1,-14,A,20\nNilai x pada 3x - 7 = 14 adalah...,5,6,7,8,C`}
                        className="w-full px-3.5 py-2.5 text-xs font-mono leading-relaxed bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                      />
                    </div>

                    <label className="flex items-center gap-2.5 text-xs font-medium text-slate-800 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={replaceExisting}
                        onChange={(e) => setReplaceExisting(e.target.checked)}
                        className="rounded border-slate-300 text-blue-700"
                      />
                      Ganti seluruh soal lama pada paket ini dengan daftar soal hasil impor
                    </label>

                    {replaceExisting && questions.length > 0 && (
                      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>
                          Perhatian: <strong>{questions.length} soal</strong> yang sudah ada di paket ini akan dihapus permanen dan digantikan oleh hasil impor di atas.
                        </span>
                      </div>
                    )}
                  </form>
                </div>
              ) : (
                <div className="space-y-4">
                  {!importResult ? (
                    <div className="py-12 text-center border border-dashed border-slate-200 rounded-xl">
                      <FileSpreadsheet className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-slate-800">Belum ada hasil impor soal</p>
                      <p className="text-xs text-slate-500 mt-1 mb-4">
                        Isi atau tempel data soal pada tab Input Soal, lalu klik Simpan / Import Soal.
                      </p>
                      <button
                        type="button"
                        onClick={() => setImportModalTab('input')}
                        className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 whitespace-nowrap cursor-pointer"
                      >
                        Kembali ke Input Soal
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                        Ringkasan Hasil Impor Soal
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                          <div className="text-[11px] text-slate-600">Total Baris</div>
                          <div className="font-mono text-xl font-bold text-slate-900 tabular-nums mt-0.5">
                            {importResult.summary.totalRows}
                          </div>
                        </div>
                        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                          <div className="text-[11px] text-emerald-800">Soal Ditambahkan</div>
                          <div className="font-mono text-xl font-bold text-emerald-900 tabular-nums mt-0.5">
                            {importResult.summary.createdCount}
                          </div>
                        </div>
                        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                          <div className="text-[11px] text-red-800">Baris Gagal</div>
                          <div className="font-mono text-xl font-bold text-red-900 tabular-nums mt-0.5">
                            {importResult.summary.errorCount}
                          </div>
                        </div>
                      </div>

                      {importResult.errors.length > 0 && (
                        <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 space-y-1">
                          <div className="font-semibold">Baris Gagal Diproses:</div>
                          {importResult.errors.map((errItem) => (
                            <div key={errItem.lineNumber} className="font-mono text-[11px]">
                              Baris {errItem.lineNumber} (&ldquo;{errItem.raw}&rdquo;): {errItem.reason}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11px] text-slate-500">
                Format: Pertanyaan, Opsi A, B, C, D, Kunci, Poin
              </span>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  disabled={importing}
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {importResult ? 'Tutup' : 'Batal'}
                </button>
                <button
                  type="submit"
                  form="import-questions-form"
                  disabled={importing || !importText.trim() || importModalTab !== 'input'}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {importing ? 'Mengimpor...' : 'Simpan / Import Soal'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Tambah / Edit Soal Tunggal */}
      {showEditor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editingId ? 'Ubah Soal Ujian' : 'Tambah Soal Baru'}
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget || saving) return;
            const orig = editingId ? questions.find((item) => item.id === editingId) : null;
            const isDirty = orig
              ? questionText !== orig.question_text ||
                correctOption !== orig.correct_option ||
                points !== orig.points ||
                options.some((o, i) => o.text !== (orig.options[i]?.text || ''))
              : Boolean(questionText.trim() || options.some((o) => o.text.trim()));
            if (!isDirty) setShowEditor(false);
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-bold text-slate-900">
                {editingId ? 'Ubah Soal Ujian' : 'Tambah Soal Baru'}
              </h3>
              <button
                type="button"
                disabled={saving}
                onClick={() => setShowEditor(false)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-50 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Pertanyaan</label>
                <textarea
                  required
                  rows={3}
                  value={questionText}
                  onChange={(e) => setQuestionText(e.target.value)}
                  placeholder="Tuliskan teks pertanyaan secara lengkap..."
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="space-y-2.5">
                <label className="block text-xs font-semibold text-slate-700">Pilihan Jawaban & Kunci Benar</label>
                {options.map((opt, idx) => (
                  <div key={opt.key} className="flex items-center gap-2.5">
                    <input
                      type="radio"
                      name="correct-option"
                      checked={correctOption === opt.key}
                      onChange={() => setCorrectOption(opt.key)}
                      title={`Tandai ${opt.key} sebagai kunci jawaban`}
                      className="text-blue-700 cursor-pointer"
                    />
                    <span className="font-mono text-xs font-bold w-5 text-slate-700">{opt.key}.</span>
                    <input
                      type="text"
                      required
                      value={opt.text}
                      onChange={(e) => {
                        const next = [...options];
                        next[idx] = { ...next[idx], text: e.target.value };
                        setOptions(next);
                      }}
                      placeholder={`Isi jawaban ${opt.key}`}
                      className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                ))}
                <p className="text-[11px] text-slate-500">Pilih tombol radio di sebelah kiri untuk menentukan kunci jawaban benar.</p>
              </div>

              <div className="w-36">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Bobot Poin</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={points}
                  onChange={(e) => setPoints(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setShowEditor(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60 cursor-pointer"
                >
                  {saving ? 'Menyimpan...' : 'Simpan Soal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
