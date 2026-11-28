import React, { useEffect, useState } from 'react';
import {
  ShieldAlert,
  Unlock,
  RefreshCw,
  Clock,
  CheckCircle2,
  CircleDashed,
  PlayCircle,
  Wifi,
  AlertTriangle,
  Search,
  Smartphone,
  CheckSquare,
  X,
} from 'lucide-react';
import { teacherApi } from '../api';
import { isSupabaseMode } from '../lib/supabase';
import { subscribeTeacherMonitoring } from '../realtimeClient';
import type { ExamPackage, MonitoringPayload, MonitoringStudentRow, SessionStatus } from '../types';

interface LiveMonitoringViewProps {
  token: string;
  packages: ExamPackage[];
  selectedPackageId: number | null;
  onSelectPackage: (id: number) => void;
}

type PendingSessionAction = {
  sessionId: number;
  type: 'reset-device' | 'force-submit' | 'extend-time';
  studentName: string;
};

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '-';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTime(ms: number | null): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const LiveMonitoringView: React.FC<LiveMonitoringViewProps> = ({
  token,
  packages,
  selectedPackageId,
  onSelectPackage,
}) => {
  const activePkgId = selectedPackageId || packages[0]?.id || null;
  const activePkg = packages.find((p) => p.id === activePkgId) || null;
  const [data, setData] = useState<MonitoringPayload | null>(null);
  const isProctorOnly = (data?.package.accessRole || activePkg?.access_role) === 'PROCTOR';
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [busySessionId, setBusySessionId] = useState<number | null>(null);
  const [confirmRotateToken, setConfirmRotateToken] = useState(false);
  const [rotatingToken, setRotatingToken] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingSessionAction | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | SessionStatus>('ALL');
  const [liveAlert, setLiveAlert] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchMonitoring(pkgId: number, silent = false) {
    if (!silent) setLoading(true);
    try {
      const payload = await teacherApi.getMonitoring(token, pkgId);
      setData(payload);
      setLastSyncedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat status monitoring.');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function handleManualRefresh() {
    if (!activePkgId || refreshing) return;
    setRefreshing(true);
    await fetchMonitoring(activePkgId, true);
    setRefreshing(false);
  }

  // Initial load + 5s polling resilience + 1s local countdown tick for active students
  useEffect(() => {
    if (!activePkgId) return;
    setPendingAction(null);
    setConfirmRotateToken(false);
    fetchMonitoring(activePkgId);

    const pollInterval = setInterval(() => {
      fetchMonitoring(activePkgId, true);
    }, 5000);

    const tickInterval = setInterval(() => {
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          students: prev.students.map((st) =>
            st.status === 'IN_PROGRESS' && st.remainingSeconds !== null && st.remainingSeconds > 0
              ? { ...st, remainingSeconds: st.remainingSeconds - 1 }
              : st
          ),
        };
      });
    }, 1000);

    return () => {
      clearInterval(pollInterval);
      clearInterval(tickInterval);
    };
  }, [activePkgId]);

  // Real-time WebSocket / Supabase Realtime subscription
  useEffect(() => {
    if (!activePkgId) return;
    return subscribeTeacherMonitoring(
      activePkgId,
      (msg) => {
        if (!msg.packageId || msg.packageId === activePkgId) {
          if (msg.type === 'violation:alert' && msg.payload) {
            setLiveAlert(
              `PERINGATAN PELANGGARAN: ${msg.payload.studentName} (${msg.payload.nis}) terkunci otomatis (${msg.payload.violationType}).`
            );
          }
          fetchMonitoring(activePkgId, true);
        }
      },
      (connected) => setWsConnected(connected)
    );
  }, [activePkgId]);

  useEffect(() => {
    if (!pendingAction && !confirmRotateToken) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busySessionId === null && !rotatingToken) {
        setPendingAction(null);
        setConfirmRotateToken(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingAction, confirmRotateToken, busySessionId, rotatingToken]);

  async function handleUnlock(student: MonitoringStudentRow) {
    if (!student.sessionId || !activePkgId || busySessionId !== null) return;
    setBusySessionId(student.sessionId);
    setError(null);
    try {
      await teacherApi.unlockSession(token, student.sessionId);
      setLiveAlert(null);
      setActionFeedback(`Sesi ujian ${student.name} berhasil dibuka kembali (+2 batas pelanggaran).`);
      await fetchMonitoring(activePkgId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuka kunci sesi siswa.');
    } finally {
      setBusySessionId(null);
    }
  }

  async function handleExecutePendingAction() {
    if (!pendingAction || !activePkgId || busySessionId !== null) return;
    const { sessionId, type, studentName } = pendingAction;
    setBusySessionId(sessionId);
    setError(null);
    try {
      if (type === 'reset-device') {
        await teacherApi.resetSessionDevice(token, sessionId);
        setActionFeedback(
          `Perangkat untuk ${studentName} telah diputus. Siswa kini dapat login ulang di HP baru dengan progres jawaban tetap tersimpan.`
        );
      } else if (type === 'force-submit') {
        const res = await teacherApi.forceSubmitSession(token, sessionId);
        setActionFeedback(
          res.score === null || isProctorOnly
            ? `Ujian ${studentName} berhasil diselesaikan paksa oleh pengawas.`
            : `Ujian ${studentName} berhasil diselesaikan paksa oleh pengawas (Nilai akhir: ${res.score}, Benar: ${res.correctCount}/${res.totalQuestions}).`
        );
      } else if (type === 'extend-time') {
        const res = await teacherApi.extendSessionTime(token, sessionId, 10);
        setActionFeedback(
          `Waktu ujian ${studentName} berhasil ditambah +${res.extraMinutes} menit.`
        );
      }
      setPendingAction(null);
      await fetchMonitoring(activePkgId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menjalankan aksi pengawas.');
    } finally {
      setBusySessionId(null);
    }
  }

  async function handleRotateToken() {
    if (!activePkgId || rotatingToken) return;
    setRotatingToken(true);
    try {
      const res = await teacherApi.rotateToken(token, activePkgId);
      setConfirmRotateToken(false);
      setActionFeedback(`Token masuk ujian berhasil dirotasi menjadi ${res.currentToken}.`);
      await fetchMonitoring(activePkgId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal merotasi token.');
    } finally {
      setRotatingToken(false);
    }
  }

  const allStudents = data?.students || [];
  const lockedStudents = allStudents.filter((s) => s.status === 'LOCKED_VIOLATION');
  const inProgressCount = allStudents.filter((s) => s.status === 'IN_PROGRESS').length;
  const submittedCount = allStudents.filter((s) => s.status === 'SUBMITTED').length;
  const notStartedCount = allStudents.filter((s) => s.status === 'NOT_STARTED').length;

  const filteredStudents = allStudents.filter((st) => {
    if (statusFilter !== 'ALL' && st.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        st.name.toLowerCase().includes(q) ||
        st.nis.toLowerCase().includes(q) ||
        (st.deviceId || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  function toggleStatusCard(target: SessionStatus) {
    setStatusFilter((prev) => (prev === target ? 'ALL' : target));
  }

  return (
    <div className="space-y-6">
      {/* Control Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-display text-lg font-bold text-slate-900">Live Monitoring Pengawas</h2>
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                wsConnected ? 'text-emerald-700' : 'text-slate-500'
              }`}
            >
              <Wifi className="w-3.5 h-3.5" aria-hidden="true" />
              {wsConnected
                ? isSupabaseMode
                  ? 'Realtime Cloud Terhubung'
                  : 'WebSocket Terhubung'
                : 'Polling Sinkron'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Pantau progres pengerjaan, buka kunci pelanggaran, izinkan ganti perangkat, tambah waktu, atau selesaikan sesi siswa secara langsung.
          </p>
          {data && (
            <p className="text-[11px] text-slate-500 mt-1">
              Guru Mapel: <strong className="text-slate-700">{data.package.teacherName || '-'}</strong>
              <span className="mx-1.5" aria-hidden="true">·</span>
              Pengawas: <strong className="text-slate-700">{data.package.proctorName || 'Belum ditugaskan'}</strong>
              {isProctorOnly && (
                <span className="ml-2 font-semibold text-blue-700">· Mode Tugas Mengawas</span>
              )}
            </p>
          )}
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 shrink-0">
          <select
            aria-label="Pilih Paket Ujian Dipantau"
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
            disabled={!activePkgId || refreshing}
            onClick={handleManualRefresh}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            title={lastSyncedAt ? `Terakhir diperbarui pukul ${formatTime(lastSyncedAt)}` : 'Segarkan data monitoring'}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-blue-700' : 'text-slate-600'}`} />
            <span className="hidden sm:inline font-mono tabular-nums">
              {lastSyncedAt ? formatTime(lastSyncedAt) : 'Segarkan'}
            </span>
          </button>

          {data && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-lg text-xs">
              <span className="text-slate-500">Token:</span>
              <span className="font-mono font-bold text-slate-900">{data.package.currentToken}</span>
              {!isProctorOnly && (
                confirmRotateToken ? (
                  <div className="inline-flex items-center gap-1.5 ml-1">
                    <span className="text-[11px] font-semibold text-amber-800">Rotasi?</span>
                    <button
                      type="button"
                      disabled={rotatingToken}
                      onClick={handleRotateToken}
                      className="px-2 py-0.5 text-[11px] font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
                    >
                      {rotatingToken ? '...' : 'Ya'}
                    </button>
                    <button
                      type="button"
                      disabled={rotatingToken}
                      onClick={() => setConfirmRotateToken(false)}
                      className="px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 disabled:opacity-40 cursor-pointer"
                    >
                      Batal
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRotateToken(true)}
                    className="text-blue-700 hover:text-blue-900 font-semibold ml-1 cursor-pointer"
                    title="Acak / Rotate Token"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {/* Prominent Locked Violation Alert Banner */}
      {(lockedStudents.length > 0 || liveAlert) && (
        <div className="bg-red-50 border border-red-300 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h3 className="text-sm font-bold text-red-900">
                Peringatan Pelanggaran: {lockedStudents.length} Sesi Siswa Terkunci
              </h3>
              <p className="text-xs text-red-800 mt-0.5">
                {liveAlert ||
                  `Siswa melebihi batas pelanggaran APK Exambro (${lockedStudents.map((s) => s.name).join(', ')}). Verifikasi kondisi siswa sebelum membuka kunci.`}
              </p>
            </div>
          </div>
          {lockedStudents.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {lockedStudents.slice(0, 3).map((locked) => (
                <button
                  key={locked.studentId}
                  type="button"
                  disabled={busySessionId === locked.sessionId}
                  onClick={() => handleUnlock(locked)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  <Unlock className="w-3.5 h-3.5" />
                  Buka {locked.name.split(' ')[0]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {actionFeedback && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-medium text-emerald-800 flex items-center justify-between gap-4">
          <span>{actionFeedback}</span>
          <button type="button" onClick={() => setActionFeedback(null)} className="text-emerald-700 hover:text-emerald-950 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700 flex items-center justify-between gap-4">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-600 hover:text-red-900 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 4-column Interactive Summary Strip (click to filter) */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <button
            type="button"
            onClick={() => toggleStatusCard('NOT_STARTED')}
            className={`text-left bg-white border rounded-xl p-4 transition-all cursor-pointer ${
              statusFilter === 'NOT_STARTED' ? 'border-slate-900 ring-2 ring-slate-900/10' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="text-xs text-slate-500">Belum Mulai</div>
            <div className="font-mono text-2xl font-bold text-slate-800 mt-1 tabular-nums">{notStartedCount}</div>
          </button>
          <button
            type="button"
            onClick={() => toggleStatusCard('IN_PROGRESS')}
            className={`text-left bg-white border rounded-xl p-4 transition-all cursor-pointer ${
              statusFilter === 'IN_PROGRESS' ? 'border-blue-700 ring-2 ring-blue-700/15' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="text-xs text-slate-500">Sedang Mengerjakan</div>
            <div className="font-mono text-2xl font-bold text-blue-700 mt-1 tabular-nums">{inProgressCount}</div>
          </button>
          <button
            type="button"
            onClick={() => toggleStatusCard('LOCKED_VIOLATION')}
            className={`text-left bg-white border rounded-xl p-4 transition-all cursor-pointer ${
              statusFilter === 'LOCKED_VIOLATION' ? 'border-red-700 ring-2 ring-red-700/15' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="text-xs text-slate-500">Terkunci Pelanggaran</div>
            <div className="font-mono text-2xl font-bold text-red-700 mt-1 tabular-nums">{lockedStudents.length}</div>
          </button>
          <button
            type="button"
            onClick={() => toggleStatusCard('SUBMITTED')}
            className={`text-left bg-white border rounded-xl p-4 transition-all cursor-pointer ${
              statusFilter === 'SUBMITTED' ? 'border-emerald-700 ring-2 ring-emerald-700/15' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="text-xs text-slate-500">Selesai / Dikumpulkan</div>
            <div className="font-mono text-2xl font-bold text-emerald-700 mt-1 tabular-nums">{submittedCount}</div>
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Student Live Status Table */}
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">
                Daftar Peserta Kelas {data?.package.className || ''}
              </h3>
              <span className="text-[11px] text-slate-500 tabular-nums">
                {data ? `Menampilkan ${filteredStudents.length} dari ${allStudents.length} siswa` : ''}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari nama / NIS..."
                  className="pl-8 pr-7 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 w-44"
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
                aria-label="Filter Status Peserta"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'ALL' | SessionStatus)}
                className="px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
              >
                <option value="ALL">Semua Status</option>
                <option value="LOCKED_VIOLATION">Terkunci Pelanggaran</option>
                <option value="IN_PROGRESS">Sedang Mengerjakan</option>
                <option value="NOT_STARTED">Belum Mulai</option>
                <option value="SUBMITTED">Selesai</option>
              </select>
              {(statusFilter !== 'ALL' || searchQuery.trim()) && (
                <button
                  type="button"
                  onClick={() => {
                    setStatusFilter('ALL');
                    setSearchQuery('');
                  }}
                  className="px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  Reset Filter
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">Siswa</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Mulai</th>
                  <th className="py-3 px-4">Progres</th>
                  <th className="py-3 px-4">Sisa Waktu</th>
                  <th className="py-3 px-4">Pelanggaran</th>
                  <th className="py-3 px-4 text-right">Kendali Pengawas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {loading && !data ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      Memuat status peserta...
                    </td>
                  </tr>
                ) : filteredStudents.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      Tidak ada peserta yang cocok dengan pencarian/filter.
                    </td>
                  </tr>
                ) : (
                  filteredStudents.map((st) => {
                    const isBusy = st.sessionId !== null && busySessionId === st.sessionId;
                    const isPendingThisRow =
                      st.sessionId !== null && pendingAction?.sessionId === st.sessionId;
                    const canControlSession =
                      st.sessionId !== null &&
                      (st.status === 'IN_PROGRESS' || st.status === 'LOCKED_VIOLATION');

                    return (
                      <tr
                        key={st.studentId}
                        className={st.status === 'LOCKED_VIOLATION' ? 'bg-red-50/70' : 'hover:bg-slate-50/80'}
                      >
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{st.name}</div>
                          <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                            {st.nis}
                            {st.deviceId ? ` · ${st.deviceId}` : ''}
                          </div>
                        </td>

                        <td className="py-3 px-4 whitespace-nowrap">
                          {st.status === 'LOCKED_VIOLATION' && (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-red-700">
                              <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                              Terkunci Pelanggaran
                            </span>
                          )}
                          {st.status === 'IN_PROGRESS' && (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-blue-700">
                              <PlayCircle className="w-3.5 h-3.5" aria-hidden="true" />
                              Sedang Mengerjakan
                            </span>
                          )}
                          {st.status === 'SUBMITTED' && (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                              {isProctorOnly || st.score === null ? 'Selesai' : `Selesai (Nilai ${st.score})`}
                            </span>
                          )}
                          {st.status === 'NOT_STARTED' && (
                            <span className="inline-flex items-center gap-1.5 font-medium text-slate-500">
                              <CircleDashed className="w-3.5 h-3.5" aria-hidden="true" />
                              Belum Mulai
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-4 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                          {formatTime(st.startedAt)}
                        </td>

                        <td className="py-3 px-4 font-mono text-slate-800 tabular-nums whitespace-nowrap">
                          {st.answeredCount}/{st.totalQuestions}
                        </td>

                        <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                          {st.status === 'IN_PROGRESS' || st.status === 'LOCKED_VIOLATION' ? (
                            <span className="inline-flex items-center gap-1 text-slate-900 font-semibold">
                              <Clock className="w-3.5 h-3.5 text-slate-400" />
                              {formatDuration(st.remainingSeconds)}
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>

                        <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                          <span
                            className={
                              st.violationCount > 0 ? 'font-bold text-red-700' : 'text-slate-500'
                            }
                          >
                            {st.violationCount}/{st.maxViolationsAllowed}
                          </span>
                        </td>

                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {isPendingThisRow && pendingAction ? (
                            <div className="inline-flex items-center gap-1.5">
                              <span className="text-[11px] font-semibold text-slate-800">
                                {pendingAction.type === 'reset-device'
                                  ? 'Ganti HP?'
                                  : pendingAction.type === 'force-submit'
                                    ? 'Paksa Selesai?'
                                    : '+10 menit?'}
                              </span>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={handleExecutePendingAction}
                                className={`px-2 py-1 text-[11px] font-semibold text-white rounded cursor-pointer ${
                                  pendingAction.type === 'force-submit'
                                    ? 'bg-red-600 hover:bg-red-700'
                                    : 'bg-blue-700 hover:bg-blue-800'
                                }`}
                              >
                                {isBusy ? '...' : 'Ya'}
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => setPendingAction(null)}
                                className="px-1.5 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 disabled:opacity-40 cursor-pointer"
                              >
                                Batal
                              </button>
                            </div>
                          ) : canControlSession && st.sessionId ? (
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {st.status === 'LOCKED_VIOLATION' && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleUnlock(st)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                                  title="Buka kunci sesi (+2 toleransi pelanggaran)"
                                >
                                  <Unlock className="w-3 h-3" />
                                  Buka Kunci
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  setPendingAction({
                                    sessionId: st.sessionId!,
                                    type: 'extend-time',
                                    studentName: st.name,
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                                title="Tambah waktu ujian +10 menit"
                              >
                                <Clock className="w-3 h-3" />
                                +10m
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  setPendingAction({
                                    sessionId: st.sessionId!,
                                    type: 'reset-device',
                                    studentName: st.name,
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                                title="Putus HP lama & izinkan siswa login di HP baru"
                              >
                                <Smartphone className="w-3 h-3" />
                                Ganti HP
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  setPendingAction({
                                    sessionId: st.sessionId!,
                                    type: 'force-submit',
                                    studentName: st.name,
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                                title="Paksa selesaikan & hitung nilai ujian sekarang"
                              >
                                <CheckSquare className="w-3 h-3" />
                                Selesai
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-400">-</span>
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

        {/* Recent Violation Event Log */}
        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200">
            <h3 className="font-display text-sm font-bold text-slate-900">Log Pelanggaran Exambro</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">Catatan keluar aplikasi / pindah fokus / lepas lock task</p>
          </div>

          <div className="divide-y divide-slate-100 max-h-[460px] overflow-y-auto">
            {!data || data.recentViolations.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Belum ada catatan pelanggaran pada paket ujian ini.
              </div>
            ) : (
              data.recentViolations.map((v) => (
                <div key={v.id} className="p-4 space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-900">{v.student_name}</span>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums">{formatTime(v.created_at)}</span>
                  </div>
                  <div className="text-[11px] font-mono font-semibold text-red-700">{v.violation_type}</div>
                  <p className="text-xs text-slate-600">{v.detail}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
