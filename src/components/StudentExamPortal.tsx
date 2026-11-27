import React, { useEffect, useRef, useState } from 'react';
import {
  ShieldCheck,
  QrCode,
  ArrowLeft,
  Clock,
  CheckCircle2,
  ShieldAlert,
  Send,
  AlertTriangle,
  Smartphone,
  Save,
  KeyRound,
  Loader2,
} from 'lucide-react';
import { exambroApi } from '../api';
import { subscribeStudentUnlock } from '../realtimeClient';
import type {
  PublicActivePackage,
  ResolvedExamPackage,
  StudentExamRouteParams,
  StudentExamSessionData,
} from '../types';

interface StudentExamPortalProps {
  routeParams: StudentExamRouteParams;
  onBackToTeacher: () => void;
}

function formatTimer(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export const StudentExamPortal: React.FC<StudentExamPortalProps> = ({
  routeParams,
  onBackToTeacher,
}) => {
  const isDirectStudentMode = routeParams.hasExplicitParams;

  // Entry / QR Verification state
  const [activePackages, setActivePackages] = useState<PublicActivePackage[]>([]);
  const [qrPayloadInput, setQrPayloadInput] = useState('');
  const [decodedPackage, setDecodedPackage] = useState<ResolvedExamPackage | null>(null);
  const [resolvingToken, setResolvingToken] = useState(false);

  const [tokenUjian, setTokenUjian] = useState(routeParams.token || '');
  const [nis, setNis] = useState(routeParams.nis ?? (isDirectStudentMode ? '' : '20260801'));
  const [pinSemester, setPinSemester] = useState(
    routeParams.pin ?? (isDirectStudentMode ? '' : '123456')
  );
  const [deviceId, setDeviceId] = useState(() =>
    isDirectStudentMode ? 'WEB-STUDENT-DIRECT' : 'ANDROID-EXAMBRO-SIM-01'
  );
  const [entryError, setEntryError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Active Exam Session state (session_token kept strictly in React memory)
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [examData, setExamData] = useState<StudentExamSessionData | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [savingAnswer, setSavingAnswer] = useState(false);
  const [lastSavedText, setLastSavedText] = useState<string | null>(null);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [autoTabGuard, setAutoTabGuard] = useState(isDirectStudentMode);
  const [examAlert, setExamAlert] = useState<string | null>(null);

  const autoVerifyAttemptRef = useRef<string | null>(null);

  async function loadExamSession(tok: string) {
    const data = await exambroApi.getExamSession(tok);
    setExamData(data);
    setAnswers(data.answers || {});
    setRemainingSeconds(data.remainingSeconds);
  }

  // Sync URL hash params (#/exam?token=...&nis=...&pin=...) when opening or changing hash
  useEffect(() => {
    const nextToken = routeParams.token || '';
    const nextNis = routeParams.nis ?? (routeParams.hasExplicitParams ? '' : '20260801');
    const nextPin = routeParams.pin ?? (routeParams.hasExplicitParams ? '' : '123456');

    setTokenUjian(nextToken);
    setNis(nextNis);
    setPinSemester(nextPin);
    setEntryError(null);
    setDecodedPackage(null);
    setQrPayloadInput('');
    setAutoTabGuard(routeParams.hasExplicitParams);
    setDeviceId(routeParams.hasExplicitParams ? 'WEB-STUDENT-DIRECT' : 'ANDROID-EXAMBRO-SIM-01');

    if (routeParams.hasExplicitParams) {
      // Reset active session if navigating to a fresh exam link
      setSessionToken(null);
      setExamData(null);
    }

    let cancelled = false;

    async function initRoute() {
      if (nextToken) {
        setResolvingToken(true);
        try {
          const resolved = await exambroApi.resolveToken(nextToken);
          if (!cancelled) {
            setDecodedPackage(resolved.package);
          }
        } catch (err) {
          if (!cancelled) {
            setDecodedPackage(null);
            setEntryError(
              err instanceof Error
                ? err.message
                : 'Token ujian tidak valid atau paket ujian tidak aktif.'
            );
          }
        } finally {
          if (!cancelled) {
            setResolvingToken(false);
          }
        }
      }

      // If token, nis, AND pin are all supplied in URL, verify immediately and open exam sheet
      if (nextToken && routeParams.nis && routeParams.pin) {
        const attemptKey = `${nextToken}|${routeParams.nis}|${routeParams.pin}`;
        if (autoVerifyAttemptRef.current === attemptKey) return;
        autoVerifyAttemptRef.current = attemptKey;

        setVerifying(true);
        try {
          const res = await exambroApi.verifyEntry({
            tokenUjian: nextToken,
            nis: routeParams.nis,
            pinSemester: routeParams.pin,
            deviceId: 'WEB-STUDENT-DIRECT',
            sessionInfo: 'ExamFlow Web Student Direct',
          });
          if (cancelled) return;
          setSessionToken(res.sessionToken);
          await loadExamSession(res.sessionToken);
          setCurrentIdx(0);
          setEntryError(null);
          // Scrub PIN from visible URL hash after successful direct login
          window.history.replaceState(
            null,
            '',
            `#/exam?token=${encodeURIComponent(nextToken)}`
          );
        } catch (err) {
          if (!cancelled) {
            setEntryError(
              err instanceof Error ? err.message : 'Verifikasi masuk ujian gagal.'
            );
          }
        } finally {
          if (!cancelled) {
            setVerifying(false);
          }
        }
      }
    }

    initRoute();

    return () => {
      cancelled = true;
    };
  }, [routeParams.token, routeParams.nis, routeParams.pin, routeParams.hasExplicitParams]);

  // Load simulator active packages only when opened in bare simulator mode (#/exam without params)
  useEffect(() => {
    if (routeParams.hasExplicitParams) return;
    exambroApi
      .getPublicActivePackages()
      .then((res) => {
        setActivePackages(res.packages);
        if (res.packages.length > 0 && !qrPayloadInput) {
          handleSelectQrPackage(res.packages[0].qrPayload);
        }
      })
      .catch(() => {
        // ignore initial fetch error
      });
  }, [routeParams.hasExplicitParams]);

  async function handleSelectQrPackage(payload: string) {
    setQrPayloadInput(payload);
    setEntryError(null);
    if (!payload.trim()) {
      setDecodedPackage(null);
      return;
    }
    try {
      const res = await exambroApi.decodeQr(payload);
      setDecodedPackage(res.package);
    } catch (err) {
      setDecodedPackage(null);
      setEntryError(err instanceof Error ? err.message : 'Payload QR tidak valid.');
    }
  }

  async function handleVerifyEntry(e: React.FormEvent) {
    e.preventDefault();
    setEntryError(null);
    setVerifying(true);
    try {
      const cleanedToken = tokenUjian.trim().toUpperCase();
      const usingQrSimulator = !isDirectStudentMode && Boolean(qrPayloadInput.trim());

      const res = await exambroApi.verifyEntry({
        ...(usingQrSimulator
          ? {
              qrPayload: qrPayloadInput.trim(),
              packageId: decodedPackage?.id,
            }
          : {}),
        tokenUjian: cleanedToken,
        nis: nis.trim(),
        pinSemester: pinSemester.trim(),
        deviceId: deviceId.trim() || 'WEB-STUDENT-DIRECT',
        sessionInfo: isDirectStudentMode
          ? 'ExamFlow Web Student Direct'
          : 'Exambro Web Simulator v2.4',
      });
      setSessionToken(res.sessionToken);
      await loadExamSession(res.sessionToken);
      setCurrentIdx(0);
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : 'Verifikasi masuk ujian gagal.');
    } finally {
      setVerifying(false);
    }
  }

  // Server-synced countdown timer + auto-submit when 0
  useEffect(() => {
    if (!sessionToken || !examData || examData.status !== 'IN_PROGRESS') return;

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          loadExamSession(sessionToken);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [sessionToken, examData?.status]);

  // Realtime listener for instant Teacher Unlock push + fallback polling while locked
  useEffect(() => {
    if (!sessionToken) return;
    return subscribeStudentUnlock(
      {
        sessionToken,
        packageId: examData?.package.id,
        studentId: examData?.student.id,
      },
      () => {
        setExamAlert('Sesi Anda telah dibuka kembali oleh pengawas. Silakan lanjutkan ujian.');
        loadExamSession(sessionToken);
      }
    );
  }, [sessionToken, examData?.package.id, examData?.student.id]);

  useEffect(() => {
    if (!sessionToken || examData?.status !== 'LOCKED_VIOLATION') return;
    const poll = setInterval(() => {
      loadExamSession(sessionToken);
    }, 4000);
    return () => clearInterval(poll);
  }, [sessionToken, examData?.status]);

  // Optional browser visibilitychange detector (simulates APK focus loss)
  useEffect(() => {
    if (!autoTabGuard || !sessionToken || examData?.status !== 'IN_PROGRESS') return;
    function onVisibilityChange() {
      if (document.hidden && sessionToken) {
        triggerViolation('FOCUS_LOST', 'Siswa berpindah tab atau meminimalkan jendela browser');
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [autoTabGuard, sessionToken, examData?.status]);

  async function handleSelectAnswer(questionId: number, originalKey: string) {
    if (!sessionToken || !examData || examData.status !== 'IN_PROGRESS') return;
    setAnswers((prev) => ({ ...prev, [String(questionId)]: originalKey }));
    setSavingAnswer(true);
    try {
      const res = await exambroApi.saveAnswer(sessionToken, questionId, originalKey);
      setRemainingSeconds(res.remainingSeconds);
      setLastSavedText(
        `Tersimpan ${new Date().toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}`
      );
    } catch (err) {
      setExamAlert(err instanceof Error ? err.message : 'Gagal menyimpan jawaban.');
      await loadExamSession(sessionToken);
    } finally {
      setSavingAnswer(false);
    }
  }

  async function triggerViolation(violationType: string, detail: string) {
    if (!sessionToken || !examData || examData.status !== 'IN_PROGRESS') return;
    try {
      const res = await exambroApi.reportViolation(sessionToken, violationType, detail);
      setExamData((prev) =>
        prev
          ? {
              ...prev,
              status: res.status as StudentExamSessionData['status'],
              violationCount: res.violationCount,
              maxViolationsAllowed: res.maxViolationsAllowed,
            }
          : prev
      );
      if (res.locked) {
        setExamAlert('Batas pelanggaran terlampaui. Sesi ujian dikunci otomatis oleh server.');
      } else {
        setExamAlert(
          `Peringatan Pelanggaran (${res.violationCount}/${res.maxViolationsAllowed}): ${detail}.`
        );
      }
    } catch (err) {
      setExamAlert(err instanceof Error ? err.message : 'Gagal mencatat pelanggaran.');
    }
  }

  async function handleFinalSubmit() {
    if (!sessionToken) return;
    setSubmitting(true);
    try {
      await exambroApi.submitExam(sessionToken);
      setShowSubmitConfirm(false);
      await loadExamSession(sessionToken);
    } catch (err) {
      setExamAlert(err instanceof Error ? err.message : 'Gagal mengumpulkan ujian.');
    } finally {
      setSubmitting(false);
    }
  }

  // ==========================
  // VIEW 1A: DIRECT STUDENT ENTRY (ARRIVED VIA QR / #/exam?token=...)
  // ==========================
  if ((!sessionToken || !examData) && isDirectStudentMode) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-6">
          <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
            <ShieldCheck className="w-5 h-5 text-blue-700" aria-hidden="true" />
            <span className="font-display text-lg font-bold text-slate-900">
              ExamFlow Pro · Ruang Ujian Siswa
            </span>
          </div>
          <span className="text-xs font-medium text-slate-500 whitespace-nowrap">
            Akses Langsung Peserta
          </span>
        </header>

        <main className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 sm:p-7">
            <div className="mb-5">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 mb-1.5">
                <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                Masuk Ruang Soal Ujian
              </div>

              {resolvingToken ? (
                <div className="flex items-center gap-2 text-sm text-slate-600 py-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
                  Memeriksa paket ujian untuk token {tokenUjian}...
                </div>
              ) : decodedPackage ? (
                <>
                  <h1 className="font-display text-xl font-bold text-slate-900">
                    {decodedPackage.title}
                  </h1>
                  <p className="text-xs text-slate-500 mt-1 tabular-nums">
                    {decodedPackage.subjectName} · Kelas {decodedPackage.className} ·{' '}
                    {decodedPackage.durationMinutes} menit · {decodedPackage.questionCount} soal
                  </p>
                </>
              ) : (
                <>
                  <h1 className="font-display text-xl font-bold text-slate-900">
                    Verifikasi Peserta Ujian
                  </h1>
                  <p className="text-xs text-slate-500 mt-1">
                    Masukkan Token Ujian aktif, NIS, dan PIN Semester Anda untuk mulai mengerjakan soal.
                  </p>
                </>
              )}
            </div>

            {entryError && (
              <div
                role="alert"
                className="mb-4 p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700 leading-relaxed"
              >
                {entryError}
              </div>
            )}

            <form onSubmit={handleVerifyEntry} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Token Ujian
                </label>
                <input
                  type="text"
                  required
                  value={tokenUjian}
                  onChange={(e) => setTokenUjian(e.target.value.toUpperCase())}
                  placeholder="Contoh: MTK8A1"
                  className="w-full px-3.5 py-2.5 text-sm font-mono font-bold tracking-wider uppercase border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  NIS Siswa
                </label>
                <input
                  type="text"
                  required
                  autoFocus={!routeParams.nis}
                  value={nis}
                  onChange={(e) => setNis(e.target.value)}
                  placeholder="Masukkan NIS Anda"
                  className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  PIN Semester
                </label>
                <input
                  type="password"
                  required
                  value={pinSemester}
                  onChange={(e) => setPinSemester(e.target.value)}
                  placeholder="Masukkan PIN Semester (4–6 digit)"
                  className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  PIN Semester berlaku universal untuk seluruh mata pelajaran pada semester ini.
                </p>
              </div>

              <button
                type="submit"
                disabled={verifying || !tokenUjian.trim()}
                className="w-full mt-2 py-3 px-4 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {verifying ? 'Memvalidasi Data Ujian...' : 'Masuk ke Soal'}
              </button>
            </form>
          </div>
        </main>
      </div>
    );
  }

  // ==========================
  // VIEW 1B: EXAMBRO SIMULATOR & QR SCAN (BARE #/exam ROUTE)
  // ==========================
  if (!sessionToken || !examData) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-6">
          <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
            <Smartphone className="w-5 h-5 text-blue-700" aria-hidden="true" />
            <span className="font-display text-lg font-bold text-slate-900">Exambro Student Portal</span>
          </div>
          <button
            type="button"
            onClick={onBackToTeacher}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Kembali ke Dasbor Guru
          </button>
        </header>

        <main className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            {/* Left: QR Scanner Simulator */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-700 mb-2">
                  <QrCode className="w-4 h-4" />
                  Langkah 1 · Pilih Paket atau Pindai QR
                </div>
                <h2 className="font-display text-lg font-bold text-slate-900">Simulasi Scan QR Exambro</h2>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  Pilih paket aktif di bawah untuk menguji masuk ujian, atau langsung isi Token Ujian pada formulir di samping.
                </p>

                <div className="mt-5 space-y-2.5">
                  <label className="block text-xs font-semibold text-slate-700">Paket Ujian Aktif Tersedia</label>
                  {activePackages.length === 0 ? (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-500">
                      Belum ada paket ujian yang diaktifkan guru.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {activePackages.map((pkg) => {
                        const selected = decodedPackage?.id === pkg.id;
                        return (
                          <button
                            key={pkg.id}
                            type="button"
                            onClick={() => handleSelectQrPackage(pkg.qrPayload)}
                            className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                              selected
                                ? 'bg-blue-50 border-blue-300 text-slate-900'
                                : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
                            }`}
                          >
                            <div className="text-xs font-bold text-slate-900">{pkg.title}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                              {pkg.subjectName} · Kelas {pkg.className} · {pkg.durationMinutes} menit · {pkg.questionCount} soal
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Atau Tempel Payload QR Terenkripsi (ef1...)
                  </label>
                  <input
                    type="text"
                    value={qrPayloadInput}
                    onChange={(e) => handleSelectQrPackage(e.target.value)}
                    placeholder="ef1...."
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-slate-50"
                  />
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-slate-100 text-[11px] text-slate-500 space-y-1">
                <div className="font-semibold text-slate-700">Data Uji Coba Siswa (Kelas 8A):</div>
                <div>NIS: <span className="font-mono text-slate-800">20260801</span> (Ahmad Fauzi) · PIN: <span className="font-mono text-slate-800">123456</span></div>
                <div>NIS: <span className="font-mono text-slate-800">20260804</span> (Zahra — Terkunci Pelanggaran) · PIN: <span className="font-mono text-slate-800">123456</span></div>
                <div>Token Ujian lihat di Dasbor Guru (seed awal: <span className="font-mono text-slate-800">MTK8A1</span>)</div>
              </div>
            </div>

            {/* Right: Exambro Entry Verification Form */}
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-center">
              <div className="mb-5">
                <div className="text-xs font-semibold text-blue-700 mb-1">Langkah 2 · Verifikasi Peserta & Token</div>
                <h2 className="font-display text-xl font-bold text-slate-900">
                  {decodedPackage ? decodedPackage.title : 'Masuk Menggunakan Token Ujian'}
                </h2>
                {decodedPackage && (
                  <p className="text-xs text-slate-500 mt-1 tabular-nums">
                    {decodedPackage.subjectName} · Kelas {decodedPackage.className} · Durasi {decodedPackage.durationMinutes} menit · Maks {decodedPackage.maxViolations}x pelanggaran
                  </p>
                )}
              </div>

              {entryError && (
                <div className="mb-4 p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                  {entryError}
                </div>
              )}

              <form onSubmit={handleVerifyEntry} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Token Ujian (Diberikan Guru / Pengawas)
                  </label>
                  <input
                    type="text"
                    required
                    value={tokenUjian}
                    onChange={(e) => setTokenUjian(e.target.value.toUpperCase())}
                    placeholder="Contoh: MTK8A1"
                    className="w-full px-3.5 py-2.5 text-sm font-mono font-bold tracking-wider uppercase border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">NIS Siswa</label>
                    <input
                      type="text"
                      required
                      value={nis}
                      onChange={(e) => setNis(e.target.value)}
                      placeholder="20260801"
                      className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">PIN Semester (6 Digit)</label>
                    <input
                      type="password"
                      required
                      value={pinSemester}
                      onChange={(e) => setPinSemester(e.target.value)}
                      placeholder="••••••"
                      className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Device ID (Dikirim APK Exambro)</label>
                  <input
                    type="text"
                    required
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    className="w-full px-3.5 py-2 text-xs font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded-lg"
                  />
                </div>

                <button
                  type="submit"
                  disabled={verifying || !tokenUjian.trim()}
                  className="w-full mt-2 py-3 px-4 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {verifying ? 'Memverifikasi Akses Ujian...' : 'Masuk ke Soal'}
                </button>
              </form>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ==========================
  // VIEW 2: SUBMITTED SUMMARY
  // ==========================
  if (examData.status === 'SUBMITTED') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-8 text-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto mb-4" />
          <h1 className="font-display text-2xl font-bold text-slate-900">Ujian Telah Dikumpulkan</h1>
          <p className="text-sm text-slate-600 mt-2">
            {examData.package.title} · {examData.student.name} ({examData.student.nis})
          </p>

          <div className="mt-6 grid grid-cols-3 gap-4 border-y border-slate-100 py-5">
            <div>
              <div className="text-xs text-slate-500">Nilai Akhir</div>
              <div className="font-mono text-2xl font-bold text-blue-700 mt-1 tabular-nums">
                {examData.result?.score ?? '-'}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Jawaban Benar</div>
              <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                {examData.result?.correctCount ?? 0}/{examData.result?.totalQuestions ?? 0}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Pelanggaran</div>
              <div className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                {examData.violationCount}x
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                setSessionToken(null);
                setExamData(null);
                if (isDirectStudentMode) {
                  setNis('');
                  setPinSemester('');
                }
              }}
              className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              {isDirectStudentMode ? 'Ganti Peserta / Keluar' : 'Uji Siswa Lain'}
            </button>
            {!isDirectStudentMode && (
              <button
                type="button"
                onClick={onBackToTeacher}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                Kembali ke Dasbor Guru
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==========================
  // VIEW 3: LOCKED VIOLATION OVERLAY
  // ==========================
  if (examData.status === 'LOCKED_VIOLATION') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
        <div className="bg-white border border-red-300 rounded-xl w-full max-w-md p-8 text-center">
          <ShieldAlert className="w-12 h-12 text-red-700 mx-auto mb-4" />
          <h1 className="font-display text-xl font-bold text-slate-900">Sesi Ujian Terkunci</h1>
          <p className="text-sm text-slate-600 mt-2 leading-relaxed">
            Sistem mendeteksi pelanggaran berulang ({examData.violationCount}/{examData.maxViolationsAllowed}). Hubungi guru atau pengawas untuk melakukan <strong className="text-slate-900">Buka Kunci Sesi</strong> dari Dasbor Live Monitoring.
          </p>

          <div className="mt-6 p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 space-y-1">
            <div className="font-semibold text-slate-900">{examData.student.name} ({examData.student.nis})</div>
            <div>{examData.package.title}</div>
            <div className="text-blue-700 font-medium pt-1">Menunggu sinyal pembukaan kunci secara otomatis...</div>
          </div>

          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => loadExamSession(sessionToken)}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
            >
              Cek Status Buka Kunci
            </button>
            {!isDirectStudentMode && (
              <button
                type="button"
                onClick={onBackToTeacher}
                className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Ke Dasbor Guru
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==========================
  // VIEW 4: ACTIVE EXAM WORKSPACE
  // ==========================
  const currentQuestion = examData.questions[currentIdx];
  const answeredCount = Object.keys(answers).length;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Exam Top Bar */}
      <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0" />
            <span className="font-semibold text-slate-900 truncate">{examData.package.title}</span>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap">{examData.student.name} ({examData.student.nis})</span>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <Save className="w-3.5 h-3.5 text-emerald-600" />
            <span>{savingAnswer ? 'Menyimpan...' : lastSavedText || 'Auto-save aktif'}</span>
          </div>

          <div className="px-3 py-1.5 bg-slate-100 rounded-lg font-mono text-sm font-bold text-slate-900 flex items-center gap-2 tabular-nums">
            <Clock className="w-4 h-4 text-blue-700" />
            {formatTimer(remainingSeconds)}
          </div>

          {!isDirectStudentMode && (
            <button
              type="button"
              onClick={onBackToTeacher}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              Dasbor Guru
            </button>
          )}
        </div>
      </header>

      {/* Proctoring Bar (real guard in direct mode, simulation controls in simulator mode) */}
      <div className="bg-slate-900 text-slate-100 px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-semibold text-slate-200">
            Pelanggaran Tercatat: <span className="font-mono text-amber-400 tabular-nums">{examData.violationCount}/{examData.maxViolationsAllowed}</span>
          </span>
          {!isDirectStudentMode && (
            <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={autoTabGuard}
                onChange={(e) => setAutoTabGuard(e.target.checked)}
                className="rounded border-slate-600"
              />
              Deteksi Pindah Tab Otomatis
            </label>
          )}
        </div>

        {isDirectStudentMode ? (
          <span className="text-[11px] text-slate-300">
            Mode Pengawasan Aktif · Tetap berada di halaman ujian ini
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => triggerViolation('FOCUS_LOST', 'Siswa keluar dari fokus aplikasi ujian')}
              className="px-3 py-1 text-[11px] font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded cursor-pointer"
            >
              Simulasikan Pindah Fokus
            </button>
            <button
              type="button"
              onClick={() => triggerViolation('EXIT_LOCK_TASK', 'Siswa melepas Lock Task APK Exambro')}
              className="px-3 py-1 text-[11px] font-semibold bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer"
            >
              Simulasikan Lepas Lock Task
            </button>
          </div>
        )}
      </div>

      {examAlert && (
        <div className="max-w-6xl w-full mx-auto px-6 pt-4">
          <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs font-medium text-amber-900 flex items-center justify-between gap-4">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              {examAlert}
            </span>
            <button type="button" onClick={() => setExamAlert(null)} className="text-amber-800 font-semibold cursor-pointer">
              Tutup
            </button>
          </div>
        </div>
      )}

      {/* Main 2-Zone Exam Stage */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Question Card */}
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-7">
          {currentQuestion ? (
            <>
              <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100 text-xs text-slate-500">
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  Soal Nomor {currentQuestion.displayNumber} dari {examData.questions.length}
                </span>
                <span className="tabular-nums">Bobot {currentQuestion.points} poin</span>
              </div>

              <p className="mt-5 text-base font-medium text-slate-900 leading-relaxed">
                {currentQuestion.questionText}
              </p>

              <div className="mt-6 space-y-3">
                {currentQuestion.options.map((opt) => {
                  const selected = answers[String(currentQuestion.id)] === opt.originalKey;
                  return (
                    <button
                      key={opt.originalKey}
                      type="button"
                      onClick={() => handleSelectAnswer(currentQuestion.id, opt.originalKey)}
                      className={`w-full text-left p-4 rounded-xl border transition-colors flex items-start gap-3.5 cursor-pointer ${
                        selected
                          ? 'bg-blue-50 border-blue-600 text-slate-900'
                          : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-800'
                      }`}
                    >
                      <span
                        className={`w-7 h-7 rounded-lg font-mono text-xs font-bold flex items-center justify-center shrink-0 ${
                          selected ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {opt.displayLabel}
                      </span>
                      <span className="text-sm leading-relaxed pt-0.5">{opt.text}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-8 pt-5 border-t border-slate-100 flex items-center justify-between">
                <button
                  type="button"
                  disabled={currentIdx === 0}
                  onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                >
                  Sebelumnya
                </button>
                <button
                  type="button"
                  disabled={currentIdx >= examData.questions.length - 1}
                  onClick={() => setCurrentIdx((i) => Math.min(examData.questions.length - 1, i + 1))}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                >
                  Soal Berikutnya
                </button>
              </div>
            </>
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">Tidak ada soal tersedia.</div>
          )}
        </div>

        {/* Right: Question Navigator & Submit */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div>
            <h3 className="font-display text-sm font-bold text-slate-900">Navigasi Nomor Soal</h3>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              Terjawab {answeredCount} dari {examData.questions.length} soal (Urutan acak terkunci di server)
            </p>
          </div>

          <div className="grid grid-cols-5 gap-2">
            {examData.questions.map((q, idx) => {
              const isAnswered = Boolean(answers[String(q.id)]);
              const isCurrent = idx === currentIdx;
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setCurrentIdx(idx)}
                  className={`h-10 rounded-lg font-mono text-xs font-bold border transition-colors tabular-nums cursor-pointer ${
                    isCurrent
                      ? 'bg-blue-700 text-white border-blue-700'
                      : isAnswered
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {q.displayNumber}
                </button>
              );
            })}
          </div>

          <div className="pt-4 border-t border-slate-100">
            {!showSubmitConfirm ? (
              <button
                type="button"
                onClick={() => setShowSubmitConfirm(true)}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                Submit Akhir Ujian
              </button>
            ) : (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <p className="text-xs font-medium text-slate-800">
                  Yakin mengumpulkan ujian sekarang? ({answeredCount}/{examData.questions.length} soal terjawab)
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={handleFinalSubmit}
                    className="flex-1 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
                  >
                    {submitting ? 'Mengirim...' : 'Ya, Kumpulkan'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSubmitConfirm(false)}
                    className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
