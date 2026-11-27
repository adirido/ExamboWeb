import React, { useEffect, useState } from 'react';
import { Download, CheckCircle2, ShieldAlert, Clock, CircleDashed } from 'lucide-react';
import { teacherApi } from '../api';
import type { ExamPackage, RecapRow } from '../types';

interface GradeRecapViewProps {
  token: string;
  packages: ExamPackage[];
  selectedPackageId: number | null;
  onSelectPackage: (id: number) => void;
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
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const submittedRecords = records.filter((r) => r.status === 'SUBMITTED' && r.score !== null);
  const avgScore =
    submittedRecords.length > 0
      ? (submittedRecords.reduce((acc, r) => acc + (r.score || 0), 0) / submittedRecords.length).toFixed(1)
      : '-';

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold text-slate-900">Rekap Nilai & Ekspor CSV</h2>
          <p className="text-xs text-slate-500 mt-1">
            Skor otomatis dihitung server berdasarkan bobot soal pilihan ganda beserta catatan pelanggaran siswa.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 shrink-0">
          <select
            aria-label="Pilih Paket Ujian Rekap"
            value={activePkgId || ''}
            onChange={(e) => onSelectPackage(Number(e.target.value))}
            className="w-full sm:w-64 px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-800 truncate shrink-0"
          >
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.class_name})
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={!activePkgId || downloading}
            onClick={handleExportCsv}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            {downloading ? 'Mengunduh...' : 'Unduh Rekap CSV'}
          </button>
        </div>
      </div>

      <div className="min-h-[24px] flex items-center justify-between gap-4 px-1 text-xs text-slate-600 tabular-nums overflow-x-hidden">
        {pkgInfo ? (
          <div className="flex items-center gap-4 overflow-x-hidden min-w-0">
            <span className="whitespace-nowrap truncate">Mapel: <strong className="text-slate-900">{pkgInfo.subjectName}</strong></span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="whitespace-nowrap shrink-0">Kelas: <strong className="text-slate-900">{pkgInfo.className}</strong></span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="whitespace-nowrap shrink-0">Sudah Selesai: <strong className="text-slate-900">{submittedRecords.length}/{records.length}</strong></span>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="whitespace-nowrap shrink-0">Rata-rata Nilai: <strong className="text-slate-900">{avgScore}</strong></span>
          </div>
        ) : (
          <span className="text-slate-400">Memuat ringkasan paket...</span>
        )}
        <span className="w-24 text-right font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0">
          {loading && hasLoaded ? 'Memuat...' : ''}
        </span>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700">{error}</div>
      )}

      <div className={`bg-white border border-slate-200 rounded-xl overflow-hidden min-h-[420px] transition-opacity duration-150 ${loading && hasLoaded ? 'opacity-60' : 'opacity-100'}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] table-fixed text-left border-collapse">
            <colgroup>
              <col className="w-[13%]" />
              <col className="w-[24%]" />
              <col className="w-[11%]" />
              <col className="w-[15%]" />
              <col className="w-[10%]" />
              <col className="w-[16%]" />
              <col className="w-[11%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                <th className="py-3 px-5 whitespace-nowrap">NIS</th>
                <th className="py-3 px-5 whitespace-nowrap">Nama Siswa</th>
                <th className="py-3 px-5 whitespace-nowrap">Kelas</th>
                <th className="py-3 px-5 whitespace-nowrap">Benar / Total Soal</th>
                <th className="py-3 px-5 whitespace-nowrap">Nilai Akhir</th>
                <th className="py-3 px-5 whitespace-nowrap">Status</th>
                <th className="py-3 px-5 text-right whitespace-nowrap">Pelanggaran</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {!hasLoaded && loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    Memuat rekap nilai...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    Belum ada data peserta pada paket ujian ini.
                  </td>
                </tr>
              ) : (
                records.map((r) => (
                  <tr key={r.nis} className="hover:bg-slate-50/80">
                    <td className="py-3 px-5 font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">{r.nis}</td>
                    <td className="py-3 px-5 font-medium text-slate-900 truncate" title={r.name}>{r.name}</td>
                    <td className="py-3 px-5 text-slate-700 whitespace-nowrap">Kelas {r.class_name}</td>
                    <td className="py-3 px-5 font-mono text-slate-800 tabular-nums whitespace-nowrap">
                      {r.status === 'SUBMITTED' ? `${r.correct_count ?? 0}/${r.total_questions}` : `-/${r.total_questions}`}
                    </td>
                    <td className="py-3 px-5 font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
                      {r.status === 'SUBMITTED' && r.score !== null ? r.score : '-'}
                    </td>
                    <td className="py-3 px-5 whitespace-nowrap">
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
                    <td className="py-3 px-5 text-right font-mono tabular-nums whitespace-nowrap">
                      <span className={r.violation_count > 0 ? 'font-bold text-red-700' : 'text-slate-500'}>
                        {r.violation_count}x
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
