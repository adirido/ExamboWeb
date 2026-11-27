import React, { useEffect, useRef, useState } from 'react';
import {
  KeyRound,
  Plus,
  Search,
  X,
  Copy,
  Check,
  Users,
  Upload,
  Download,
  FileSpreadsheet,
  Sparkles,
  Info,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Lock,
  RefreshCw,
} from 'lucide-react';
import { teacherApi } from '../api';
import type { ClassItem, ImportStudentsResult, StudentRecord } from '../types';

interface StudentsViewProps {
  token: string;
  classes: ClassItem[];
  teacherRole: 'ADMIN' | 'TEACHER';
  onClassesChanged?: () => Promise<void>;
}

const TEACHER_SAMPLE_ROWS = [
  '20260106,Budi Santoso,7A',
  '20260107,Citra Dewi Lestari,7B',
  '20260108,Dian Kusuma,8A',
  '20260109,Eko Prasetyo,8B',
].join('\n');

const TEACHER_TEMPLATE_CSV = [
  'NIS,Nama Lengkap,Kelas',
  '20260106,Budi Santoso,7A',
  '20260107,Citra Dewi Lestari,7B',
  '20260108,Dian Kusuma,8A',
  '20260109,Eko Prasetyo,8B',
].join('\n');

const ADMIN_SAMPLE_ROWS = [
  '20260106,Budi Santoso,7A',
  '20260107,Citra Dewi Lestari,7B,458210',
  '20260108,Dian Kusuma,8A',
  '20260109,Eko Prasetyo,8B,772190',
].join('\n');

const ADMIN_TEMPLATE_CSV = [
  'NIS,Nama Lengkap,Kelas,PIN Semester (Opsional)',
  '20260106,Budi Santoso,7A,',
  '20260107,Citra Dewi Lestari,7B,458210',
  '20260108,Dian Kusuma,8A,',
  '20260109,Eko Prasetyo,8B,772190',
].join('\n');

function generateRandomSixDigits(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export const StudentsView: React.FC<StudentsViewProps> = ({
  token,
  classes,
  teacherRole,
  onClassesChanged,
}) => {
  const isAdmin = teacherRole === 'ADMIN';

  const [selectedClassId, setSelectedClassId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [showPins, setShowPins] = useState(true);
  const [copiedRowId, setCopiedRowId] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [revealedPin, setRevealedPin] = useState<{
    nis: string;
    name: string;
    pin: string;
    title: string;
  } | null>(null);
  const [copiedPin, setCopiedPin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add single student state
  const [nis, setNis] = useState('');
  const [name, setName] = useState('');
  const [classId, setClassId] = useState<number>(classes[0]?.id || 1);
  const [customPin, setCustomPin] = useState('');
  const [saving, setSaving] = useState(false);

  // Admin PIN Edit / Reset Modal state
  const [pinTargetStudent, setPinTargetStudent] = useState<StudentRecord | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [updatingPin, setUpdatingPin] = useState(false);
  const [pinModalError, setPinModalError] = useState<string | null>(null);

  // Import students modal state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importModalTab, setImportModalTab] = useState<'input' | 'result'>('input');
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportStudentsResult | null>(null);
  const [copiedBatchPins, setCopiedBatchPins] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    loadStudents();
  }, [selectedClassId]);

  async function loadStudents() {
    setLoading(true);
    setError(null);
    try {
      const res = await teacherApi.getStudents(
        token,
        selectedClassId === 'ALL' ? undefined : Number(selectedClassId)
      );
      setStudents(res.students);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data siswa.');
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }

  function openPinModal(student: StudentRecord) {
    if (!isAdmin) return;
    setPinTargetStudent(student);
    setPinInput('');
    setPinModalError(null);
  }

  async function handleSaveAdminPin(e: React.FormEvent) {
    e.preventDefault();
    if (!isAdmin || !pinTargetStudent) return;
    const trimmed = pinInput.trim();
    if (trimmed && !/^\d{4,6}$/.test(trimmed)) {
      setPinModalError('PIN Semester harus terdiri dari 4–6 digit angka.');
      return;
    }

    setUpdatingPin(true);
    setPinModalError(null);
    try {
      const res = await teacherApi.resetStudentPin(token, pinTargetStudent.id, trimmed || undefined);
      setPinTargetStudent(null);
      setRevealedPin({
        nis: res.nis,
        name: res.name,
        pin: res.newPin,
        title: 'PIN Semester Diperbarui',
      });
      await loadStudents();
    } catch (err) {
      setPinModalError(err instanceof Error ? err.message : 'Gagal memperbarui PIN semester.');
    } finally {
      setUpdatingPin(false);
    }
  }

  async function handleQuickGeneratePin() {
    if (!isAdmin || !pinTargetStudent) return;
    setUpdatingPin(true);
    setPinModalError(null);
    try {
      const res = await teacherApi.resetStudentPin(token, pinTargetStudent.id);
      setPinTargetStudent(null);
      setRevealedPin({
        nis: res.nis,
        name: res.name,
        pin: res.newPin,
        title: 'PIN Semester Baru Berhasil Di-generate',
      });
      await loadStudents();
    } catch (err) {
      setPinModalError(err instanceof Error ? err.message : 'Gagal meng-generate PIN semester.');
    } finally {
      setUpdatingPin(false);
    }
  }

  async function handleAddStudent(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await teacherApi.createStudent(token, {
        nis,
        name,
        classId,
        ...(isAdmin && customPin.trim() ? { customPin: customPin.trim() } : {}),
      });
      setShowAddModal(false);
      setNis('');
      setName('');
      setCustomPin('');
      setRevealedPin({
        nis: res.student.nis,
        name: res.student.name,
        pin: res.generatedPin,
        title: 'Siswa Ditambahkan & PIN Awal Aktif',
      });
      await loadStudents();
      if (onClassesChanged) {
        await onClassesChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menambahkan siswa.');
    } finally {
      setSaving(false);
    }
  }

  function handleCopyRowPin(student: StudentRecord) {
    if (!student.semester_pin) return;
    navigator.clipboard?.writeText(`NIS: ${student.nis}\nPIN Semester: ${student.semester_pin}`);
    setCopiedRowId(student.id);
    setTimeout(() => setCopiedRowId(null), 1600);
  }

  function openImportModal() {
    setImportError(null);
    setImportResult(null);
    setImportFileName(null);
    setImportModalTab('input');
    setShowImportModal(true);
  }

  function handleLoadSample() {
    setImportText(isAdmin ? ADMIN_SAMPLE_ROWS : TEACHER_SAMPLE_ROWS);
    setImportFileName(null);
    setImportError(null);
    setImportResult(null);
  }

  function handleDownloadTemplate() {
    const content = isAdmin ? ADMIN_TEMPLATE_CSV : TEACHER_TEMPLATE_CSV;
    const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isAdmin ? 'template-import-siswa.csv' : 'template-import-siswa-guru.csv';
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
      const content = typeof reader.result === 'string' ? reader.result : '';
      setImportText(content);
    };
    reader.onerror = () => {
      setImportError('Gagal membaca file CSV dari perangkat.');
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  }

  async function handleSubmitImport(e: React.FormEvent) {
    e.preventDefault();
    if (!importText.trim()) {
      setImportError('Silakan tempel data siswa, klik Muat Contoh, atau pilih file .CSV terlebih dahulu.');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const res = await teacherApi.importStudents(token, {
        rawText: importText,
        updateExisting,
      });
      setImportResult(res);
      setImportModalTab('result');
      await loadStudents();
      if (onClassesChanged) {
        await onClassesChanged();
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Gagal mengimpor data siswa.');
    } finally {
      setImporting(false);
    }
  }

  function handleCopyImportedPins() {
    if (!importResult || importResult.importedPins.length === 0) return;
    const text = importResult.importedPins
      .map((p) => `${p.nis}\t${p.name}\tKelas ${p.className}\tPIN: ${p.pin}`)
      .join('\n');
    navigator.clipboard?.writeText(text);
    setCopiedBatchPins(true);
    setTimeout(() => setCopiedBatchPins(false), 2000);
  }

  function handleDownloadImportedPinsCsv() {
    if (!importResult || importResult.importedPins.length === 0) return;
    const escapeCell = (val: string) =>
      val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
    const rows = [
      'NIS,Nama Lengkap,Kelas,PIN Semester,Status Impor',
      ...importResult.importedPins.map((p) =>
        [
          escapeCell(p.nis),
          escapeCell(p.name),
          escapeCell(p.className),
          escapeCell(p.pin),
          escapeCell(p.action === 'UPDATED' ? 'Diperbarui' : 'Baru'),
        ].join(',')
      ),
    ];
    const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hasil-import-pin-siswa.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const parsedPreviewCount = importText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;

  const filteredStudents = students.filter((s) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return s.nis.toLowerCase().includes(q) || s.name.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold text-slate-900">Manajemen Siswa & PIN Semester</h2>
          <p className="text-xs text-slate-500 mt-1">
            {isAdmin
              ? 'Mode Admin Semester: Anda dapat melihat, menetapkan, dan mereset PIN Semester yang berlaku universal lintas seluruh mapel & paket ujian.'
              : 'Mode Guru: Anda dapat melihat PIN Semester aktif serta menambah/mengimpor siswa (NIS, Nama, Kelas). Pengubahan atau reset PIN hanya dapat dilakukan oleh Admin Semester.'}
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 shrink-0">
          <div className="relative w-full sm:w-44 shrink-0">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari NIS atau nama..."
              className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
            />
          </div>

          <select
            aria-label="Filter Kelas Siswa"
            value={selectedClassId}
            onChange={(e) => setSelectedClassId(e.target.value)}
            className="w-full sm:w-36 px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700 truncate shrink-0"
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
            onClick={() => setShowPins((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
            title={showPins ? 'Sembunyikan PIN di layar' : 'Tampilkan PIN di layar'}
          >
            {showPins ? <EyeOff className="w-3.5 h-3.5 text-slate-600" /> : <Eye className="w-3.5 h-3.5 text-blue-700" />}
            {showPins ? 'Sembunyikan PIN' : 'Tampilkan PIN'}
          </button>

          <button
            type="button"
            onClick={openImportModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
            Import Siswa
          </button>

          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Tambah Siswa
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700">{error}</div>
      )}

      <div
        className={`bg-white border border-slate-200 rounded-xl overflow-hidden min-h-[420px] transition-opacity duration-150 ${
          loading && hasLoaded ? 'opacity-60' : 'opacity-100'
        }`}
      >
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[880px] lg:min-w-0 table-fixed text-left border-collapse">
            <colgroup>
              <col className="w-[100px]" />
              <col />
              <col className="w-[82px]" />
              <col className="w-[136px]" />
              <col className="w-[250px]" />
              <col className="w-[156px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                <th className="py-3 pl-5 pr-3 whitespace-nowrap">NIS</th>
                <th className="py-3 px-3 whitespace-nowrap">Nama Siswa</th>
                <th className="py-3 px-2.5 whitespace-nowrap">Kelas</th>
                <th className="py-3 px-3 whitespace-nowrap">PIN Semester</th>
                <th className="py-3 px-3 whitespace-nowrap">Pembaruan PIN</th>
                <th className="py-3 pl-3 pr-5 text-right whitespace-nowrap">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {!hasLoaded && loading ? (
                <tr>
                  <td colSpan={6} className="py-12 px-5 text-center text-slate-500">
                    Memuat data siswa...
                  </td>
                </tr>
              ) : filteredStudents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 px-5 text-center text-slate-500">
                    <Users className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                    Tidak ada siswa yang sesuai dengan filter.
                  </td>
                </tr>
              ) : (
                filteredStudents.map((st) => (
                  <tr key={st.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 pl-5 pr-3 font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {st.nis}
                    </td>
                    <td className="py-3 px-3 font-medium text-slate-900 truncate" title={st.name}>
                      {st.name}
                    </td>
                    <td className="py-3 px-2.5 text-slate-700 whitespace-nowrap">Kelas {st.class_name}</td>
                    <td className="py-3 px-3 whitespace-nowrap">
                      {st.semester_pin ? (
                        <div className="inline-flex items-center gap-2">
                          <span className="font-mono font-bold text-blue-700 tabular-nums tracking-wider">
                            {showPins ? st.semester_pin : '••••••'}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyRowPin(st)}
                            className="p-1 text-slate-400 hover:text-slate-700 rounded transition-colors cursor-pointer"
                            title="Salin NIS & PIN Semester"
                            aria-label={`Salin PIN ${st.name}`}
                          >
                            {copiedRowId === st.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-emerald-700 font-medium">Terproteksi Hash</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-[11px] text-slate-500 font-mono tabular-nums whitespace-nowrap">
                      {st.pin_updated_at}
                    </td>
                    <td className="py-3 pl-3 pr-5 text-right whitespace-nowrap">
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => openPinModal(st)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <KeyRound className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          Ubah / Reset PIN
                        </button>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 whitespace-nowrap"
                          title="Hanya Admin Penanggung Jawab Ujian Semester yang dapat mengubah atau mereset PIN"
                        >
                          <Lock className="w-3 h-3 shrink-0" aria-hidden="true" />
                          Khusus Admin
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Import Data Siswa Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl h-[84vh] max-h-[720px] min-h-[520px] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
              <div className="min-w-0">
                <h3 className="font-display text-lg font-bold text-slate-900 truncate">Import Data Siswa</h3>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  {isAdmin
                    ? 'Tambahkan atau perbarui daftar siswa secara massal dari Excel, CSV, atau teks terstruktur.'
                    : 'Tambahkan daftar siswa (NIS, Nama, Kelas) secara massal; PIN awal dibuat otomatis oleh server.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="text-slate-400 hover:text-slate-700 shrink-0 cursor-pointer"
                aria-label="Tutup modal import"
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
                  Input & Tempel Data (<span className="tabular-nums">{parsedPreviewCount}</span>)
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
                  Hasil Impor & PIN
                  {importResult ? ` (${importResult.importedPins.length})` : ''}
                </button>
              </div>
              <span className="text-[11px] font-mono text-slate-500 whitespace-nowrap shrink-0 tabular-nums hidden sm:inline">
                {parsedPreviewCount} baris siap
              </span>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 min-h-0 p-6 overflow-y-auto overflow-x-hidden scrollbar-stable">
              {importModalTab === 'input' ? (
                <div className="space-y-4">
                  {/* Toolbar Atas */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        onClick={handleLoadSample}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-blue-700 shrink-0" aria-hidden="true" />
                        Muat Contoh
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadTemplate}
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

                  {/* Petunjuk Format */}
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-xs text-slate-700">
                    <div className="flex items-center gap-2 font-semibold text-slate-900">
                      <Info className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
                      {isAdmin
                        ? 'Aturan Urutan Kolom (Salin-Tempel Excel / CSV)'
                        : 'Aturan Urutan 3 Kolom Wajib (Salin-Tempel Excel / CSV)'}
                    </div>
                    {isAdmin ? (
                      <p className="leading-relaxed text-slate-600">
                        Susun setiap baris dengan urutan:{' '}
                        <strong className="text-slate-900">1. NIS / No. Ujian</strong>,{' '}
                        <strong className="text-slate-900">2. Nama Lengkap</strong>,{' '}
                        <strong className="text-slate-900">3. Kelas</strong> (misal: <span className="font-mono">7A</span>, <span className="font-mono">8A</span>), dan{' '}
                        <strong className="text-slate-900">4. PIN Semester</strong> (opsional 4–6 digit; jika kosong, server menetapkan PIN awal otomatis dan menyimpan hash <span className="font-mono">scrypt</span>).
                      </p>
                    ) : (
                      <p className="leading-relaxed text-slate-600">
                        Susun setiap baris dengan urutan:{' '}
                        <strong className="text-slate-900">1. NIS / No. Ujian</strong>,{' '}
                        <strong className="text-slate-900">2. Nama Lengkap</strong>, dan{' '}
                        <strong className="text-slate-900">3. Kelas</strong> (misal: <span className="font-mono">7A</span>, <span className="font-mono">8A</span>, <span className="font-mono">8B</span>). PIN Semester awal untuk siswa baru dibuat otomatis oleh server dan disimpan dengan hash <span className="font-mono">scrypt</span>.
                      </p>
                    )}
                    <p className="text-[11px] text-slate-500">
                      Parser mendukung salin-tempel langsung dari tabel Excel (pemisah <span className="font-mono">Tab</span>), koma (<span className="font-mono">,</span>), atau titik koma (<span className="font-mono">;</span>). Baris kosong dan baris header otomatis diabaikan.
                    </p>
                  </div>

                  {importError && (
                    <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{importError}</span>
                    </div>
                  )}

                  {/* Area Teks Paste / Pratinjau CSV */}
                  <form id="import-students-form" onSubmit={handleSubmitImport} className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label htmlFor="students-import-textarea" className="text-xs font-semibold text-slate-700">
                          Data Siswa (Tempel dari Excel / CSV)
                        </label>
                        <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                          {parsedPreviewCount} baris terdeteksi
                        </span>
                      </div>
                      <textarea
                        id="students-import-textarea"
                        rows={7}
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        placeholder={
                          isAdmin
                            ? `20260106,Budi Santoso,7A\n20260107,Citra Dewi Lestari,7B,458210`
                            : `20260106,Budi Santoso,7A\n20260107,Citra Dewi Lestari,7B`
                        }
                        className="w-full px-3.5 py-2.5 text-xs font-mono leading-relaxed bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                      />
                    </div>

                    <label className="flex items-center gap-2.5 text-xs font-medium text-slate-800 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={updateExisting}
                        onChange={(e) => setUpdateExisting(e.target.checked)}
                        className="rounded border-slate-300 text-blue-700"
                      />
                      {isAdmin
                        ? 'Perbarui nama & kelas (serta PIN jika kolom ke-4 diisi) bila NIS sudah ada'
                        : 'Perbarui nama dan kelas jika NIS sudah ada di Daftar Siswa (PIN Semester tidak diubah)'}
                    </label>
                  </form>
                </div>
              ) : (
                <div className="space-y-4">
                  {!importResult ? (
                    <div className="py-12 text-center border border-dashed border-slate-200 rounded-xl">
                      <FileSpreadsheet className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-slate-800">Belum ada hasil impor</p>
                      <p className="text-xs text-slate-500 mt-1 mb-4">
                        Isi atau tempel data siswa pada tab Input Data, lalu klik Simpan / Import Data Siswa.
                      </p>
                      <button
                        type="button"
                        onClick={() => setImportModalTab('input')}
                        className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 whitespace-nowrap cursor-pointer"
                      >
                        Kembali ke Input Data
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                        Ringkasan Hasil Impor
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                          <div className="text-[11px] text-emerald-800">Ditambahkan</div>
                          <div className="font-mono text-xl font-bold text-emerald-900 tabular-nums mt-0.5">
                            {importResult.summary.createdCount}
                          </div>
                        </div>
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                          <div className="text-[11px] text-blue-800">Diperbarui</div>
                          <div className="font-mono text-xl font-bold text-blue-900 tabular-nums mt-0.5">
                            {importResult.summary.updatedCount}
                          </div>
                        </div>
                        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                          <div className="text-[11px] text-amber-800">Dilewati (Duplikat)</div>
                          <div className="font-mono text-xl font-bold text-amber-900 tabular-nums mt-0.5">
                            {importResult.summary.skippedCount}
                          </div>
                        </div>
                        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                          <div className="text-[11px] text-red-800">Baris Gagal</div>
                          <div className="font-mono text-xl font-bold text-red-900 tabular-nums mt-0.5">
                            {importResult.summary.errorCount}
                          </div>
                        </div>
                      </div>

                      {importResult.importedPins.length > 0 && (
                        <div className="border border-slate-200 rounded-xl overflow-hidden">
                          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-bold text-slate-900">
                                Daftar Siswa & PIN Semester (<span className="tabular-nums">{importResult.importedPins.length}</span> siswa)
                              </div>
                              <div className="text-[11px] text-slate-500">
                                PIN tersimpan dengan hash scrypt dan berlaku universal lintas seluruh mapel & paket ujian.
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={handleCopyImportedPins}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                {copiedBatchPins ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                                {copiedBatchPins ? 'Tersalin' : 'Salin Semua'}
                              </button>
                              <button
                                type="button"
                                onClick={handleDownloadImportedPinsCsv}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                                Unduh CSV PIN
                              </button>
                            </div>
                          </div>

                          <div className="max-h-52 overflow-y-auto scrollbar-stable">
                            <table className="w-full text-left border-collapse text-xs">
                              <thead>
                                <tr className="border-b border-slate-200 bg-white text-[11px] font-semibold text-slate-500">
                                  <th className="py-2 px-4">NIS</th>
                                  <th className="py-2 px-4">Nama Lengkap</th>
                                  <th className="py-2 px-4">Kelas</th>
                                  <th className="py-2 px-4">PIN Semester</th>
                                  <th className="py-2 px-4 text-right">Status</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {importResult.importedPins.map((p) => (
                                  <tr key={`${p.nis}-${p.action}`}>
                                    <td className="py-2 px-4 font-mono font-semibold text-slate-900 tabular-nums">{p.nis}</td>
                                    <td className="py-2 px-4 text-slate-800">{p.name}</td>
                                    <td className="py-2 px-4 text-slate-600">Kelas {p.className}</td>
                                    <td className="py-2 px-4 font-mono font-bold text-blue-700 tabular-nums">{p.pin}</td>
                                    <td className="py-2 px-4 text-right text-[11px] font-semibold text-slate-600">
                                      {p.action === 'UPDATED' ? 'Diperbarui' : 'Baru'}
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
                            <div key={`${s.lineNumber}-${s.nis}`} className="font-mono text-[11px]">
                              Baris {s.lineNumber} ({s.nis} · {s.name}): {s.reason}
                            </div>
                          ))}
                        </div>
                      )}

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

            {/* Pinned Modal Footer Action Buttons */}
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11px] text-slate-500">
                {importModalTab === 'result' && importResult
                  ? 'Semua PIN siswa tersimpan aman dengan hash scrypt di server.'
                  : isAdmin
                    ? 'Format: NIS, Nama, Kelas, PIN (opsional)'
                    : 'Format wajib: NIS, Nama, Kelas (PIN awal otomatis)'}
              </span>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {importResult ? 'Tutup' : 'Batal'}
                </button>
                <button
                  type="submit"
                  form="import-students-form"
                  disabled={importing || !importText.trim() || importModalTab !== 'input'}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {importing ? 'Mengimpor...' : 'Simpan / Import Data Siswa'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Student Modal (Teacher: NIS, Nama, Kelas only; Admin: + optional PIN) */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-bold text-slate-900">Tambah Siswa Baru</h3>
              <button type="button" onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddStudent} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">NIS</label>
                <input
                  type="text"
                  required
                  value={nis}
                  onChange={(e) => setNis(e.target.value)}
                  placeholder="Contoh: 20260807"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Lengkap Siswa</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Contoh: Raka Pratama"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Kelas</label>
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

              {isAdmin ? (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    PIN Semester 4–6 Digit (Opsional — kosongkan untuk otomatis)
                  </label>
                  <input
                    type="text"
                    pattern="\d{4,6}"
                    maxLength={6}
                    value={customPin}
                    onChange={(e) => setCustomPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="Otomatis 6 digit acak"
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
              ) : (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-600 leading-relaxed">
                  PIN Semester awal akan dibuat otomatis oleh server (terproteksi hash <span className="font-mono">scrypt</span>) dan berlaku untuk seluruh mata pelajaran serta paket ujian di semester ini.
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
                >
                  {saving ? 'Menyimpan...' : 'Simpan Siswa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin-Only Edit / Reset Semester PIN Modal */}
      {isAdmin && pinTargetStudent && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-base font-bold text-slate-900">Ubah / Reset PIN Semester</h3>
              <button
                type="button"
                onClick={() => setPinTargetStudent(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-500 mb-4">
              PIN Semester bersifat universal untuk semua mata pelajaran dan paket ujian siswa ini sepanjang semester berjalan.
            </p>

            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg mb-4 text-xs space-y-1">
              <div className="font-semibold text-slate-900">{pinTargetStudent.name}</div>
              <div className="text-slate-600 font-mono tabular-nums">
                NIS: {pinTargetStudent.nis} · Kelas {pinTargetStudent.class_name}
              </div>
              <div className="text-slate-600">
                PIN Aktif Saat Ini:{' '}
                <strong className="font-mono text-blue-700 tabular-nums">
                  {pinTargetStudent.semester_pin || 'Terproteksi Hash'}
                </strong>
              </div>
            </div>

            {pinModalError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {pinModalError}
              </div>
            )}

            <form onSubmit={handleSaveAdminPin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  PIN Semester Baru (4–6 digit angka)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
                    placeholder="Kosongkan untuk acak otomatis"
                    className="flex-1 px-3.5 py-2 text-sm font-mono font-bold tracking-widest border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={() => setPinInput(generateRandomSixDigits())}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg shrink-0 cursor-pointer"
                    title="Isi PIN acak 6 digit"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Acak
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  disabled={updatingPin}
                  onClick={handleQuickGeneratePin}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  Reset Acak Otomatis
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPinTargetStudent(null)}
                    className="px-3 py-2 text-xs font-semibold text-slate-600 cursor-pointer"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    disabled={updatingPin}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                  >
                    {updatingPin ? 'Menyimpan...' : 'Simpan PIN Baru'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Revealed PIN Confirmation Modal */}
      {revealedPin && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-6">
            <h3 className="font-display text-base font-bold text-slate-900">{revealedPin.title}</h3>
            <p className="text-xs text-slate-500 mt-1">
              PIN Semester ini tersimpan dengan hash scrypt dan berlaku universal untuk seluruh ujian siswa pada semester berjalan.
            </p>

            <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-xl text-center">
              <div className="text-xs font-semibold text-slate-800">{revealedPin.name}</div>
              <div className="text-xs text-slate-500 font-mono mt-0.5">NIS: {revealedPin.nis}</div>
              <div className="mt-3 font-mono text-3xl font-bold tracking-[0.25em] text-blue-700 tabular-nums">
                {revealedPin.pin}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(`NIS: ${revealedPin.nis}\nPIN Semester: ${revealedPin.pin}`);
                  setCopiedPin(true);
                  setTimeout(() => setCopiedPin(false), 1800);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                {copiedPin ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                Salin Kredensial
              </button>
              <button
                type="button"
                onClick={() => setRevealedPin(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                Selesai
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
