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
} from 'lucide-react';
import { teacherApi } from '../api';
import { isSupabaseMode } from '../lib/supabase';
import { subscribeTeacherMonitoring } from '../realtimeClient';
import type { ExamPackage, MonitoringPayload, MonitoringStudentRow } from '../types';

interface LiveMonitoringViewProps {
  token: string;
  packages: ExamPackage[];
  selectedPackageId: number | null;
  onSelectPackage: (id: number) => void;
}

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
  const [data, setData] = useState<MonitoringPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [unlockingId, setUnlockingId] = useState<number | null>(null);
  const [liveAlert, setLiveAlert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchMonitoring(pkgId: number, silent = false) {
    if (!silent) setLoading(true);
    try {
      const payload = await teacherApi.getMonitoring(token, pkgId);
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat status monitoring.');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Initial load + 5s polling resilience + 1s local countdown tick for active students
  useEffect(() => {
    if (!activePkgId) return;
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

  async function handleUnlock(student: MonitoringStudentRow) {
    if (!student.sessionId || !activePkgId) return;
    setUnlockingId(student.sessionId);
    try {
      await teacherApi.unlockSession(token, student.sessionId);
      setLiveAlert(null);
      await fetchMonitoring(activePkgId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuka kunci sesi siswa.');
    } finally {
      setUnlockingId(null);
    }
  }

  async function handleRotateToken() {
    if (!activePkgId) return;
    try {
      await teacherApi.rotateToken(token, activePkgId);
      await fetchMonitoring(activePkgId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal merotasi token.');
    }
  }

  const lockedStudents = data?.students.filter((s) => s.status === 'LOCKED_VIOLATION') || [];
  const inProgressCount = data?.students.filter((s) => s.status === 'IN_PROGRESS').length || 0;
  const submittedCount = data?.students.filter((s) => s.status === 'SUBMITTED').length || 0;
  const notStartedCount = data?.students.filter((s) => s.status === 'NOT_STARTED').length || 0;

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
            Pantau progres pengerjaan, sisa waktu server, deteksi pelanggaran Exambro, dan buka kunci sesi siswa secara instan.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 shrink-0">
          <select
            aria-label="Pilih Paket Ujian Dipantau"
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

          {data && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-lg text-xs">
              <span className="text-slate-500">Token:</span>
              <span className="font-mono font-bold text-slate-900">{data.package.currentToken}</span>
              <button
                type="button"
                onClick={handleRotateToken}
                className="text-blue-700 hover:text-blue-900 font-semibold ml-1 cursor-pointer"
                title="Acak / Rotate Token"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
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
          {lockedStudents.length === 1 && (
            <button
              type="button"
              disabled={unlockingId === lockedStudents[0].sessionId}
              onClick={() => handleUnlock(lockedStudents[0])}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Unlock className="w-3.5 h-3.5" />
              Buka Kunci {lockedStudents[0].name}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700">{error}</div>
      )}

      {/* 4-column Summary Strip */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500">Belum Mulai</div>
            <div className="font-mono text-2xl font-bold text-slate-800 mt-1 tabular-nums">{notStartedCount}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500">Sedang Mengerjakan</div>
            <div className="font-mono text-2xl font-bold text-blue-700 mt-1 tabular-nums">{inProgressCount}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500">Terkunci Pelanggaran</div>
            <div className="font-mono text-2xl font-bold text-red-700 mt-1 tabular-nums">{lockedStudents.length}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500">Selesai / Dikumpulkan</div>
            <div className="font-mono text-2xl font-bold text-emerald-700 mt-1 tabular-nums">{submittedCount}</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Student Live Status Table */}
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-display text-sm font-bold text-slate-900">
              Daftar Peserta Kelas {data?.package.className || ''}
            </h3>
            <span className="text-xs text-slate-500 tabular-nums">
              {data ? `${data.students.length} siswa` : ''}
            </span>
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
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {loading && !data ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      Memuat status peserta...
                    </td>
                  </tr>
                ) : (
                  data?.students.map((st) => (
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
                            Selesai (Nilai {st.score})
                          </span>
                        )}
                        {st.status === 'NOT_STARTED' && (
                          <span className="inline-flex items-center gap-1.5 font-medium text-slate-500">
                            <CircleDashed className="w-3.5 h-3.5" aria-hidden="true" />
                            Belum Mulai
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-4 font-mono text-slate-600 tabular-nums">{formatTime(st.startedAt)}</td>

                      <td className="py-3 px-4 font-mono text-slate-800 tabular-nums">
                        {st.answeredCount}/{st.totalQuestions}
                      </td>

                      <td className="py-3 px-4 font-mono tabular-nums">
                        {st.status === 'IN_PROGRESS' ? (
                          <span className="inline-flex items-center gap-1 text-slate-900 font-semibold">
                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                            {formatDuration(st.remainingSeconds)}
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>

                      <td className="py-3 px-4 font-mono tabular-nums">
                        <span
                          className={
                            st.violationCount > 0 ? 'font-bold text-red-700' : 'text-slate-500'
                          }
                        >
                          {st.violationCount}/{st.maxViolationsAllowed}
                        </span>
                      </td>

                      <td className="py-3 px-4 text-right">
                        {st.status === 'LOCKED_VIOLATION' && st.sessionId ? (
                          <button
                            type="button"
                            disabled={unlockingId === st.sessionId}
                            onClick={() => handleUnlock(st)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Unlock className="w-3.5 h-3.5" />
                            {unlockingId === st.sessionId ? 'Membuka...' : 'Buka Kunci Sesi'}
                          </button>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))
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
