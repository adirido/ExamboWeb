import React, { useEffect, useState } from 'react';
import {
  Download,
  CheckCircle2,
  ShieldAlert,
  Clock,
  CircleDashed,
  Search,
  Printer,
  BarChart3,
  FileText,
  Eye,
  X,
  Check,
} from 'lucide-react';
import { teacherApi } from '../api';
import type {
  ExamPackage,
  QuestionAnalyticRow,
  RecapRow,
  SessionReviewPayload,
} from '../types';

interface GradeRecapViewProps {
  token: string;
  packages: ExamPackage[];
  selectedPackageId: number | null;
  onSelectPackage: (id: number) => void;
}

type RecapSubTab = 'scores' | 'analytics';
type RecapFilterMode = 'ALL' | 'PASSED' | 'REMEDIAL' | 'INCOMPLETE' | 'VIOLATION';
type RecapSortMode = 'name' | 'nis' | 'score-desc' | 'score-asc';

const KKM_STORAGE_KEY = 'examflow_recap_kkm';

function readInitialKkm(): number {
  try {
    const raw = window.localStorage.getItem(KKM_STORAGE_KEY);
    const num = raw ? Number(raw) : 75;
    if (Number.isFinite(num) && num >= 0 && num <= 100) return num;
  } catch {
    // ignore storage errors
  }
  return 75;
}

export const GradeRecapView: React.FC<GradeRecapViewProps> = ({
  token,
  packages,
  selectedPackageId,
  onSelectPackage,
}) => {
  const activePkgId = selectedPackageId || packages[0]?.id || null;
  const [pkgInfo, setPkgInfo] = useState<{
    id: number;
    title: string;
    subjectName: string;
    className: string;
    totalQuestions: number;
  } | null>(null);
  const [records, setRecords] = useState<RecapRow[]>([]);
  const [questionAnalytics, setQuestionAnalytics] = useState<QuestionAnalyticRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [subTab, setSubTab] = useState<RecapSubTab>('scores');
  const [kkm, setKkm] = useState<number>(() => readInitialKkm());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<RecapFilterMode>('ALL');
  const [sortBy, setSortBy] = useState<RecapSortMode>('name');

  // Student answer sheet review modal
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewData, setReviewData] = useState<SessionReviewPayload | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(KKM_STORAGE_KEY, String(kkm));
    } catch {
      // ignore storage errors
    }
  }, [kkm]);

  useEffect(() => {
    if (!reviewLoading && !reviewData) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setReviewLoading(false);
        setReviewData(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reviewLoading, reviewData]);

  useEffect(() => {
    if (!activePkgId) return;
    loadRecap(activePkgId);
  }, [activePkgId]);

  async function loadRecap(pkgId: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await teacherApi.getRecap(token, pkgId);
      setPkgInfo(res.package);
      setRecords(res.records);
      setQuestionAnalytics(res.questionAnalytics || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat rekap nilai.');
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }

  async function handleExportCsv() {
    if (!activePkgId || !pkgInfo) return;
    setDownloading(true);
    try {
      const slug = pkgInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await teacherApi.downloadRecapCsv(token, activePkgId, `rekap-nilai-${slug}.csv`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengekspor CSV.');
    } finally {
      setDownloading(false);
    }
  }

  function handlePrintRecap() {
    document.body.classList.add('printing-recap');
    const cleanup = () => {
      document.body.classList.remove('printing-recap');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    setTimeout(cleanup, 1200);
  }

  async function handleOpenReview(sessionId: number) {
    setReviewLoading(true);
    setReviewError(null);
    setReviewData(null);
    try {
      const data = await teacherApi.getSessionReview(token, sessionId);
      setReviewData(data);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Gagal memuat lembar jawaban siswa.');
    } finally {
      setReviewLoading(false);
    }
  }

  const submittedRecords = records.filter((r) => r.status === 'SUBMITTED' && r.score !== null);
  const scoresList = submittedRecords.map((r) => Number(r.score || 0));
  const avgScore =
    scoresList.length > 0
      ? (scoresList.reduce((acc, s) => acc + s, 0) / scoresList.length).toFixed(1)
      : '-';
  const maxScore = scoresList.length > 0 ? Math.max(...scoresList).toFixed(1).replace(/\.0$/, '') : '-';
  const minScore = scoresList.length > 0 ? Math.min(...scoresList).toFixed(1).replace(/\.0$/, '') : '-';

  const passedCount = submittedRecords.filter((r) => Number(r.score || 0) >= kkm).length;
  const remedialCount = submittedRecords.filter((r) => Number(r.score || 0) < kkm).length;
  const passRate =
    submittedRecords.length > 0 ? Math.round((passedCount / submittedRecords.length) * 100) : 0;

  const filteredRecords = records
    .filter((r) => {
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        if (!r.nis.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (filterMode === 'PASSED') {
        return r.status === 'SUBMITTED' && r.score !== null && r.score >= kkm;
      }
      if (filterMode === 'REMEDIAL') {
        return r.status === 'SUBMITTED' && r.score !== null && r.score < kkm;
      }
      if (filterMode === 'INCOMPLETE') {
        return r.status !== 'SUBMITTED';
      }
      if (filterMode === 'VIOLATION') {
        return r.violation_count > 0;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'nis') return a.nis.localeCompare(b.nis);
      if (sortBy === 'score-desc') {
        const sa = a.status === 'SUBMITTED' && a.score !== null ? Number(a.score) : -1;
        const sb = b.status === 'SUBMITTED' && b.score !== null ? Number(b.score) : -1;
        return sb - sa || a.name.localeCompare(b.name);
      }
      if (sortBy === 'score-asc') {
        const sa = a.status === 'SUBMITTED' && a.score !== null ? Number(a.score) : 9999;
        const sb = b.status === 'SUBMITTED' && b.score !== null ? Number(b.score) : 9999;
        return sa - sb || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });

  function getDifficultyBadge(rate: number, totalSubmitted: number) {
    if (totalSubmitted === 0) {
      return { label: 'Belum Ada Data', color: 'text-slate-500' };
    }
    if (rate >= 75) {
      return { label: 'Mudah', color: 'text-emerald-700' };
    }
    if (rate >= 40) {
      return { label: 'Sedang', color: 'text-blue-700' };
    }
    return { label: 'Sulit', color: 'text-red-700' };
  }

  return (
    <div className="space-y-6">
      {/* Header & Package Selector */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold text-slate-900">
            Rekap Nilai, Analitik &amp; Lembar Jawaban
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Pantau ketuntasan KKM, analisis tingkat kesulitan butir soal, tinjau jawaban per siswa, dan ekspor ke CSV atau PDF.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 shrink-0">
          <select
            aria-label="Pilih Paket Ujian Rekap"
            value={activePkgId || ''}
            onChange={(e) => onSelectPackage(Number(e.target.value))}
            className="w-full sm:w-60 px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-800 truncate shrink-0"
          >
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.class_name})
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={!activePkgId || records.length === 0 || subTab !== 'scores'}
            onClick={handlePrintRecap}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            title="Cetak daftar nilai ukuran A4 atau simpan sebagai PDF"
          >
            <Printer className="w-3.5 h-3.5" aria-hidden="true" />
            Cetak / PDF
          </button>

          <button
            type="button"
            disabled={!activePkgId || downloading}
            onClick={handleExportCsv}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            {downloading ? 'Mengunduh...' : 'Unduh CSV'}
          </button>
        </div>
      </div>

      {/* 4 Summary Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Peserta Selesai</div>
          <div className="font-mono text-2xl font-bold text-slate-900 tabular-nums mt-1">
            {submittedRecords.length}
            <span className="text-sm font-normal text-slate-400"> / {records.length}</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {pkgInfo ? `${pkgInfo.subjectName} · Kelas ${pkgInfo.className}` : 'Memuat paket...'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">Rata-rata Nilai</div>
          <div className="font-mono text-2xl font-bold text-slate-900 tabular-nums mt-1">
            {avgScore}
          </div>
          <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-1">
            Tertinggi: <strong className="text-slate-800">{maxScore}</strong> · Terendah:{' '}
            <strong className="text-slate-800">{minScore}</strong>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            Tuntas (Nilai &ge; {kkm})
          </div>
          <div className="font-mono text-2xl font-bold text-emerald-700 tabular-nums mt-1">
            {passedCount}
            <span className="text-xs font-semibold text-emerald-600 ml-1.5">({passRate}%)</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Dari peserta berstatus selesai
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            Remedial (Nilai &lt; {kkm})
          </div>
          <div className="font-mono text-2xl font-bold text-amber-700 tabular-nums mt-1">
            {remedialCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Perlu pendampingan / remedial
          </div>
        </div>
      </div>

      {/* Sub-tabs & Filter Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="inline-flex items-center bg-slate-100 p-1 rounded-lg self-start lg:self-auto">
          <button
            type="button"
            onClick={() => setSubTab('scores')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'scores'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            Daftar Nilai ({records.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('analytics')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              subTab === 'analytics'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />
            Analisis Butir Soal ({questionAnalytics.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <span>KKM:</span>
            <input
              type="number"
              min={0}
              max={100}
              value={kkm}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) {
                  setKkm(Math.max(0, Math.min(100, v)));
                }
              }}
              className="w-16 px-2 py-1.5 text-xs font-mono font-bold text-center border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </label>

          {subTab === 'scores' && (
            <>
              <div className="relative min-w-[180px]">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari NIS atau nama..."
                  className="w-full pl-8 pr-7 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="p-0.5 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer"
                    aria-label="Hapus pencarian"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <select
                aria-label="Filter Status Nilai"
                value={filterMode}
                onChange={(e) => setFilterMode(e.target.value as RecapFilterMode)}
                className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
              >
                <option value="ALL">Semua Peserta</option>
                <option value="PASSED">Tuntas (&ge; {kkm})</option>
                <option value="REMEDIAL">Remedial (&lt; {kkm})</option>
                <option value="INCOMPLETE">Belum Selesai</option>
                <option value="VIOLATION">Ada Pelanggaran</option>
              </select>
              <select
                aria-label="Urutkan Daftar Nilai"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as RecapSortMode)}
                className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
              >
                <option value="name">Urutkan: Nama A–Z</option>
                <option value="nis">Urutkan: NIS</option>
                <option value="score-desc">Urutkan: Nilai Tertinggi</option>
                <option value="score-asc">Urutkan: Nilai Terendah</option>
              </select>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700">
          {error}
        </div>
      )}

      {reviewError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700 flex items-center justify-between gap-2">
          <span>{reviewError}</span>
          <button type="button" onClick={() => setReviewError(null)} className="text-red-700 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* TAB 1: DAFTAR NILAI SISWA */}
      {subTab === 'scores' && (
        <div
          id="printable-recap-report"
          className={`bg-white border border-slate-200 rounded-xl overflow-hidden min-h-[400px] transition-opacity duration-150 ${
            loading && hasLoaded ? 'opacity-60' : 'opacity-100'
          }`}
        >
          {/* Print-only header */}
          {pkgInfo && (
            <div className="hidden print:block px-5 py-4 border-b border-slate-300">
              <div className="text-xs font-bold uppercase tracking-wider text-blue-700">ExamFlow Pro · Rekap Nilai Resmi</div>
              <div className="text-base font-bold text-slate-900 mt-0.5">{pkgInfo.title}</div>
              <div className="text-xs text-slate-600 mt-1">
                Mapel: {pkgInfo.subjectName} · Kelas: {pkgInfo.className} · KKM: {kkm} · Rata-rata: {avgScore} · Tuntas: {passedCount}/{submittedRecords.length}
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] lg:min-w-0 table-fixed text-left border-collapse">
              <colgroup>
                <col className="w-[100px]" />
                <col />
                <col className="w-[105px]" />
                <col className="w-[95px]" />
                <col className="w-[105px]" />
                <col className="w-[130px]" />
                <col className="w-[95px]" />
                <col className="w-[125px] no-print" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 pl-5 pr-3 whitespace-nowrap">NIS</th>
                  <th className="py-3 px-3 whitespace-nowrap">Nama Siswa</th>
                  <th className="py-3 px-3 whitespace-nowrap">Benar / Soal</th>
                  <th className="py-3 px-3 whitespace-nowrap">Nilai Akhir</th>
                  <th className="py-3 px-3 whitespace-nowrap">Ketuntasan</th>
                  <th className="py-3 px-3 whitespace-nowrap">Status</th>
                  <th className="py-3 px-3 text-right whitespace-nowrap">Pelanggaran</th>
                  <th className="py-3 pl-3 pr-5 text-right whitespace-nowrap no-print">Jawaban</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {!hasLoaded && loading ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-500">
                      Memuat rekap nilai...
                    </td>
                  </tr>
                ) : filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-500">
                      Tidak ada peserta yang sesuai dengan filter pada paket ujian ini.
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map((r) => {
                    const isSubmitted = r.status === 'SUBMITTED' && r.score !== null;
                    const isPassed = isSubmitted && Number(r.score) >= kkm;
                    return (
                      <tr key={r.nis} className="hover:bg-slate-50/80">
                        <td className="py-3 pl-5 pr-3 font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                          {r.nis}
                        </td>
                        <td className="py-3 px-3 font-medium text-slate-900 truncate" title={r.name}>
                          {r.name}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-800 tabular-nums whitespace-nowrap">
                          {isSubmitted ? `${r.correct_count ?? 0}/${r.total_questions}` : `-/${r.total_questions}`}
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
                          {isSubmitted ? r.score : '-'}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          {isSubmitted ? (
                            isPassed ? (
                              <span className="font-semibold text-emerald-700">Tuntas</span>
                            ) : (
                              <span className="font-semibold text-amber-700">Remedial</span>
                            )
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          {r.status === 'SUBMITTED' && (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Selesai
                            </span>
                          )}
                          {r.status === 'IN_PROGRESS' && (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-blue-700">
                              <Clock className="w-3.5 h-3.5 shrink-0" /> Mengerjakan
                            </span>
                          )}
                          {r.status === 'LOCKED_VIOLATION' && (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-red-700">
                              <ShieldAlert className="w-3.5 h-3.5 shrink-0" /> Terkunci
                            </span>
                          )}
                          {r.status === 'NOT_STARTED' && (
                            <span className="inline-flex items-center gap-1.5 text-slate-500">
                              <CircleDashed className="w-3.5 h-3.5 shrink-0" /> Belum Mulai
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                          <span className={r.violation_count > 0 ? 'font-bold text-red-700' : 'text-slate-500'}>
                            {r.violation_count}x
                          </span>
                        </td>
                        <td className="py-3 pl-3 pr-5 text-right whitespace-nowrap no-print">
                          {r.session_id ? (
                            <button
                              type="button"
                              onClick={() => handleOpenReview(r.session_id!)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-md cursor-pointer"
                            >
                              <Eye className="w-3 h-3 shrink-0" />
                              Lihat
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: ANALISIS BUTIR SOAL */}
      {subTab === 'analytics' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {questionAnalytics.length === 0 ? (
            <div className="p-10 text-center">
              <BarChart3 className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-800">Belum ada butir soal pada paket ini</p>
              <p className="text-xs text-slate-500 mt-1">
                Tambahkan soal terlebih dahulu di menu Bank Soal untuk melihat statistik jawaban.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 pl-5 pr-3 w-14">No.</th>
                    <th className="py-3 px-3">Pertanyaan &amp; Kunci</th>
                    <th className="py-3 px-3 w-48">Tingkat Penguasaan</th>
                    <th className="py-3 px-3 w-36 text-center">Benar / Salah / Kosong</th>
                    <th className="py-3 pl-3 pr-5 w-52">Distribusi Pilihan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {questionAnalytics.map((q) => {
                    const diff = getDifficultyBadge(q.correctRate, q.totalSubmitted);
                    const optEntries = Object.entries(q.optionDistribution);
                    return (
                      <tr key={q.questionId} className="hover:bg-slate-50/70 align-top">
                        <td className="py-3.5 pl-5 pr-3 font-mono font-bold text-slate-700 tabular-nums">
                          #{q.number}
                        </td>
                        <td className="py-3.5 px-3">
                          <div className="font-medium text-slate-900 line-clamp-2" title={q.questionText}>
                            {q.questionText}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1 font-mono">
                            Kunci: <strong className="text-emerald-700">{q.correctOption}</strong> · Bobot: {q.points} poin
                          </div>
                        </td>
                        <td className="py-3.5 px-3">
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="font-mono font-bold text-slate-900 tabular-nums">
                              {q.totalSubmitted > 0 ? `${q.correctRate}%` : '—'}
                            </span>
                            <span className={`font-semibold ${diff.color}`}>{diff.label}</span>
                          </div>
                          <div className="w-full h-2 bg-slate-100 rounded overflow-hidden">
                            <div
                              className={`h-full transition-all ${
                                q.correctRate >= 75
                                  ? 'bg-emerald-600'
                                  : q.correctRate >= 40
                                    ? 'bg-blue-600'
                                    : 'bg-red-600'
                              }`}
                              style={{ width: `${q.totalSubmitted > 0 ? q.correctRate : 0}%` }}
                            />
                          </div>
                        </td>
                        <td className="py-3.5 px-3 text-center font-mono tabular-nums whitespace-nowrap">
                          <span className="font-bold text-emerald-700">{q.correctCount}</span>
                          <span className="text-slate-400"> / </span>
                          <span className="font-bold text-red-700">{q.wrongCount}</span>
                          <span className="text-slate-400"> / </span>
                          <span className="text-slate-500">{q.blankCount}</span>
                        </td>
                        <td className="py-3.5 pl-3 pr-5">
                          <div className="flex flex-wrap gap-1.5">
                            {optEntries.map(([optKey, cnt]) => {
                              const isKey = optKey === q.correctOption;
                              return (
                                <span
                                  key={optKey}
                                  className={`px-2 py-0.5 text-[11px] font-mono rounded border tabular-nums ${
                                    isKey
                                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800 font-bold'
                                      : 'bg-slate-50 border-slate-200 text-slate-600'
                                  }`}
                                >
                                  {optKey}:{cnt}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modal Review Lembar Jawaban Siswa */}
      {(reviewLoading || reviewData) && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setReviewLoading(false);
              setReviewData(null);
            }
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
              {reviewLoading ? (
                <div className="text-sm font-semibold text-slate-700">Memuat lembar jawaban siswa...</div>
              ) : reviewData ? (
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">
                    Lembar Jawaban: {reviewData.student.name}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    NIS: {reviewData.student.nis} · Kelas {reviewData.student.className} ·{' '}
                    {reviewData.package.title}
                  </p>
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => setReviewData(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {reviewLoading ? (
              <div className="p-8 space-y-3">
                <div className="h-5 bg-slate-100 rounded w-1/3 animate-pulse" />
                <div className="h-24 bg-slate-100 rounded w-full animate-pulse" />
                <div className="h-24 bg-slate-100 rounded w-full animate-pulse" />
              </div>
            ) : reviewData ? (
              <>
                <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
                  <div className="flex flex-wrap items-center gap-4">
                    <span>
                      Nilai:{' '}
                      <strong className="font-mono text-sm text-slate-900 tabular-nums">
                        {reviewData.session.score ?? '—'}
                      </strong>
                    </span>
                    <span>
                      Benar:{' '}
                      <strong className="font-mono text-slate-900 tabular-nums">
                        {reviewData.session.correctCount ?? 0}/{reviewData.session.totalQuestions}
                      </strong>
                    </span>
                    <span>
                      Pelanggaran:{' '}
                      <strong
                        className={`font-mono tabular-nums ${
                          reviewData.session.violationCount > 0 ? 'text-red-700' : 'text-slate-700'
                        }`}
                      >
                        {reviewData.session.violationCount}x
                      </strong>
                    </span>
                  </div>
                  <span className="font-semibold text-slate-600">
                    Status: {reviewData.session.status === 'SUBMITTED' ? 'Selesai' : reviewData.session.status}
                  </span>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable p-6 space-y-4">
                  {reviewData.items.map((item) => (
                    <div
                      key={item.questionId}
                      className={`border rounded-xl p-4 space-y-2.5 ${
                        item.isCorrect
                          ? 'border-emerald-200 bg-emerald-50/30'
                          : item.selectedOption
                            ? 'border-red-200 bg-red-50/20'
                            : 'border-slate-200 bg-slate-50/40'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-xs font-semibold text-slate-900 leading-relaxed">
                          <span className="font-mono text-slate-500 mr-2">#{item.number}</span>
                          {item.questionText}
                        </div>
                        <span
                          className={`text-[11px] font-bold shrink-0 ${
                            item.isCorrect
                              ? 'text-emerald-700'
                              : item.selectedOption
                                ? 'text-red-700'
                                : 'text-slate-500'
                          }`}
                        >
                          {item.isCorrect
                            ? `Benar (+${item.points})`
                            : item.selectedOption
                              ? `Salah (Pilih ${item.selectedOption})`
                              : 'Tidak Dijawab'}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {item.options.map((opt) => {
                          const isSelected = opt.key === item.selectedOption;
                          const isCorrectKey = opt.key === item.correctOption;
                          return (
                            <div
                              key={opt.key}
                              className={`px-3 py-2 rounded-lg border flex items-center justify-between gap-2 ${
                                isCorrectKey
                                  ? 'bg-emerald-50 border-emerald-300 text-emerald-900 font-semibold'
                                  : isSelected
                                    ? 'bg-red-50 border-red-300 text-red-900 font-semibold'
                                    : 'bg-white border-slate-200 text-slate-700'
                              }`}
                            >
                              <span className="min-w-0 break-words">
                                <span className="font-mono font-bold mr-1.5">{opt.key}.</span>
                                {opt.text}
                              </span>
                              {isCorrectKey && <Check className="w-3.5 h-3.5 text-emerald-700 shrink-0" />}
                              {!isCorrectKey && isSelected && <X className="w-3.5 h-3.5 text-red-700 shrink-0" />}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex justify-end shrink-0">
                  <button
                    type="button"
                    onClick={() => setReviewData(null)}
                    className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                  >
                    Tutup
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
