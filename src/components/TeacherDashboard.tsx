import React, { useEffect, useState } from 'react';
import {
  ShieldCheck,
  Layers,
  Activity,
  BookOpen,
  Users,
  FileSpreadsheet,
  Smartphone,
  LogOut,
  ExternalLink,
  KeyRound,
  X,
  UserCog,
  Eye,
  EyeOff,
} from 'lucide-react';
import { teacherApi } from '../api';
import type {
  ClassItem,
  ExamPackage,
  SubjectItem,
  TeacherAssignment,
  TeacherProfile,
} from '../types';
import { PackagesView } from './PackagesView';
import { LiveMonitoringView } from './LiveMonitoringView';
import { QuestionBankView } from './QuestionBankView';
import { StudentsView } from './StudentsView';
import { GradeRecapView } from './GradeRecapView';
import { ExambroDocsView } from './ExambroDocsView';
import { AdminManagementView } from './AdminManagementView';

type DashboardTab = 'packages' | 'monitoring' | 'questions' | 'students' | 'recap' | 'exambro' | 'admin';

interface TeacherDashboardProps {
  token: string;
  teacher: TeacherProfile;
  onLogout: () => void;
  onOpenStudentPortal: () => void;
}

const TAB_LABELS: Record<DashboardTab, string> = {
  packages: 'Paket Ujian & Token',
  monitoring: 'Live Monitoring',
  questions: 'Bank Soal',
  students: 'Siswa & PIN Semester',
  recap: 'Rekap Nilai & CSV',
  exambro: 'Penugasan & API Exambro',
  admin: 'Master Data Sekolah',
};

const DASHBOARD_STATE_KEY = 'examflow_dashboard_state';

function readStoredDashboardState(role: 'ADMIN' | 'TEACHER'): {
  tab: DashboardTab;
  packageId: number | null;
} {
  try {
    const raw = window.sessionStorage.getItem(DASHBOARD_STATE_KEY);
    if (!raw) return { tab: 'packages', packageId: null };
    const parsed = JSON.parse(raw) as { tab?: DashboardTab; packageId?: number | null };
    const allowedTabs: DashboardTab[] =
      role === 'ADMIN'
        ? ['packages', 'monitoring', 'questions', 'students', 'recap', 'admin', 'exambro']
        : ['packages', 'monitoring', 'questions', 'students', 'recap'];
    const tab = parsed?.tab && allowedTabs.includes(parsed.tab) ? parsed.tab : 'packages';
    const packageId = typeof parsed?.packageId === 'number' ? parsed.packageId : null;
    return { tab, packageId };
  } catch {
    return { tab: 'packages', packageId: null };
  }
}

export const TeacherDashboard: React.FC<TeacherDashboardProps> = ({
  token,
  teacher,
  onLogout,
  onOpenStudentPortal,
}) => {
  const [initialUi] = useState(() => readStoredDashboardState(teacher.role));
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => initialUi.tab);
  const [packages, setPackages] = useState<ExamPackage[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [subjects, setSubjects] = useState<SubjectItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<number | null>(() => initialUi.packageId);
  const [loading, setLoading] = useState(true);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        DASHBOARD_STATE_KEY,
        JSON.stringify({ tab: activeTab, packageId: selectedPackageId })
      );
    } catch {
      // Ignore storage errors
    }
  }, [activeTab, selectedPackageId]);

  useEffect(() => {
    if (!showPasswordModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowPasswordModal(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPasswordModal]);

  function openPasswordModal() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowCurrentPw(false);
    setShowNewPw(false);
    setShowConfirmPw(false);
    setPasswordError(null);
    setPasswordSuccess(null);
    setShowPasswordModal(true);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (newPassword.length < 6) {
      setPasswordError('Kata sandi baru minimal 6 karakter.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Konfirmasi kata sandi baru tidak cocok.');
      return;
    }

    setPasswordSaving(true);
    try {
      const res = await teacherApi.changePassword(token, currentPassword, newPassword);
      setPasswordSuccess(res.message || 'Kata sandi berhasil diperbarui.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Gagal memperbarui kata sandi.');
    } finally {
      setPasswordSaving(false);
    }
  }

  async function loadAll() {
    try {
      const [ctx, pkgRes] = await Promise.all([
        teacherApi.getContext(token),
        teacherApi.getPackages(token),
      ]);
      setAssignments(ctx.assignments);
      setSubjects(ctx.subjects);
      setClasses(ctx.classes);
      setPackages(pkgRes.packages);
      if (!selectedPackageId && pkgRes.packages.length > 0) {
        setSelectedPackageId(pkgRes.packages[0].id);
      }
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 401) {
        onLogout();
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, [token]);

  const totalLocked = packages.reduce((acc, p) => acc + (p.locked_count || 0), 0);
  const uniqueSubjects = Array.from(new Set(assignments.map((a) => a.subject_name)));
  const uniqueClasses = Array.from(new Set(assignments.map((a) => a.class_name)));

  const navItems: Array<{ id: DashboardTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'packages', label: 'Paket Ujian', icon: <Layers className="w-4 h-4" /> },
    { id: 'monitoring', label: 'Live Monitoring', icon: <Activity className="w-4 h-4" />, badge: totalLocked > 0 ? totalLocked : undefined },
    { id: 'questions', label: 'Bank Soal', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'students', label: 'Siswa & PIN', icon: <Users className="w-4 h-4" /> },
    { id: 'recap', label: 'Rekap Nilai', icon: <FileSpreadsheet className="w-4 h-4" /> },
    ...(teacher.role === 'ADMIN'
      ? [
          { id: 'admin' as const, label: 'Master Data', icon: <UserCog className="w-4 h-4" /> },
          { id: 'exambro' as const, label: 'API Exambro', icon: <Smartphone className="w-4 h-4" /> },
        ]
      : []),
  ];

  return (
    <div className="h-screen overflow-hidden bg-slate-50 flex">
      {/* Fixed Sidebar (260px on desktop) */}
      <aside className="w-64 bg-white border-r border-slate-200 hidden lg:flex flex-col justify-between shrink-0 overflow-x-hidden">
        <div className="min-w-0">
          <div className="px-6 py-5 border-b border-slate-200 flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-blue-700 shrink-0" aria-hidden="true" />
            <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
              ExamFlow Pro
            </span>
          </div>

          <div className="px-5 py-4 border-b border-slate-100">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-900 truncate">{teacher.name}</div>
              <span className={`text-[10px] font-semibold shrink-0 ${teacher.role === 'ADMIN' ? 'text-blue-700' : 'text-slate-500'}`}>
                {teacher.role === 'ADMIN' ? 'Admin' : 'Guru'}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 truncate">
              {uniqueSubjects.length > 0 ? uniqueSubjects.join(', ') : 'Pengajar'}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 truncate">
              Kelas: {uniqueClasses.length > 0 ? uniqueClasses.join(', ') : '-'}
            </div>
          </div>

          <nav className="p-3 space-y-1 overflow-x-hidden">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-blue-50 text-blue-800'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
                    {item.icon}
                    {item.label}
                  </span>
                  {item.badge !== undefined && (
                    <span className="font-mono text-[11px] font-bold text-red-700 tabular-nums whitespace-nowrap shrink-0">
                      {item.badge} terkunci
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-200 space-y-1.5">
          <button
            type="button"
            onClick={openPasswordModal}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <KeyRound className="w-4 h-4 shrink-0" />
            Ubah Kata Sandi
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            Keluar Akun
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Top Bar Contract */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-6 shrink-0">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="font-semibold text-slate-500 whitespace-nowrap shrink-0 hidden sm:inline">Dasbor Guru</span>
            <span className="text-slate-300 hidden sm:inline shrink-0" aria-hidden="true">/</span>
            <span className="font-display font-bold text-slate-900 truncate whitespace-nowrap">{TAB_LABELS[activeTab]}</span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openPasswordModal}
              className="lg:hidden inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Ubah Kata Sandi"
            >
              <KeyRound className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Sandi</span>
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="lg:hidden inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Keluar Akun"
            >
              <LogOut className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Keluar</span>
            </button>
            <button
              type="button"
              onClick={onOpenStudentPortal}
              className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Portal Ujian Siswa (Exambro)</span>
              <span className="sm:hidden">Portal Siswa</span>
            </button>
          </div>
        </header>

        {/* Mobile/Tablet Tab Strip (no horizontal jump) */}
        <div className="lg:hidden bg-white border-b border-slate-200 px-4 py-2 overflow-x-hidden shrink-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <main className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-stable p-6">
          <div className="max-w-7xl w-full mx-auto">
            {loading ? (
              <div className="bg-white border border-slate-200 rounded-xl p-10 space-y-4">
                <div className="h-6 bg-slate-100 rounded w-1/4 animate-pulse" />
                <div className="h-32 bg-slate-100 rounded w-full animate-pulse" />
              </div>
            ) : (
              <>
              {activeTab === 'packages' && (
                <PackagesView
                  token={token}
                  packages={packages}
                  assignments={assignments}
                  subjects={subjects}
                  classes={classes}
                  onRefresh={loadAll}
                  onOpenMonitoring={(pkgId) => {
                    setSelectedPackageId(pkgId);
                    setActiveTab('monitoring');
                  }}
                  onOpenQuestions={(pkgId) => {
                    setSelectedPackageId(pkgId);
                    setActiveTab('questions');
                  }}
                  onOpenRecap={(pkgId) => {
                    setSelectedPackageId(pkgId);
                    setActiveTab('recap');
                  }}
                />
              )}

              {activeTab === 'monitoring' && (
                <LiveMonitoringView
                  token={token}
                  packages={packages}
                  selectedPackageId={selectedPackageId}
                  onSelectPackage={setSelectedPackageId}
                />
              )}

              {activeTab === 'questions' && (
                <QuestionBankView
                  token={token}
                  packages={packages}
                  subjects={subjects}
                  classes={classes}
                  selectedPackageId={selectedPackageId}
                  onSelectPackage={setSelectedPackageId}
                  onPackagesChanged={loadAll}
                />
              )}

              {activeTab === 'students' && (
                <StudentsView
                  token={token}
                  classes={classes}
                  teacherRole={teacher.role}
                  onClassesChanged={loadAll}
                />
              )}

              {activeTab === 'recap' && (
                <GradeRecapView
                  token={token}
                  packages={packages}
                  selectedPackageId={selectedPackageId}
                  onSelectPackage={setSelectedPackageId}
                />
              )}

              {activeTab === 'exambro' && teacher.role === 'ADMIN' && (
                <ExambroDocsView
                  token={token}
                  assignments={assignments}
                  subjects={subjects}
                  classes={classes}
                  onRefreshContext={loadAll}
                />
              )}

              {activeTab === 'admin' && teacher.role === 'ADMIN' && (
                <AdminManagementView
                  token={token}
                  currentTeacherId={teacher.id}
                  subjects={subjects}
                  classes={classes}
                  onContextChanged={loadAll}
                />
              )}
              </>
            )}
          </div>
        </main>
      </div>

      {/* Modal Ubah Kata Sandi */}
      {showPasswordModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowPasswordModal(false);
          }}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">Ubah Kata Sandi Akun</h3>
                <p className="text-xs text-slate-500 mt-0.5">{teacher.email}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowPasswordModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 cursor-pointer"
                aria-label="Tutup modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {passwordError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {passwordError}
              </div>
            )}

            {passwordSuccess && (
              <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-medium text-emerald-700">
                {passwordSuccess}
              </div>
            )}

            <form onSubmit={handleChangePassword} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Kata Sandi Saat Ini</label>
                <div className="relative">
                  <input
                    type={showCurrentPw ? 'text' : 'password'}
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full pl-3 pr-10 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="Masukkan kata sandi saat ini"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPw((p) => !p)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 rounded cursor-pointer"
                    aria-label={showCurrentPw ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
                  >
                    {showCurrentPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Kata Sandi Baru</label>
                <div className="relative">
                  <input
                    type={showNewPw ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full pl-3 pr-10 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="Minimal 6 karakter"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPw((p) => !p)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 rounded cursor-pointer"
                    aria-label={showNewPw ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
                  >
                    {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Konfirmasi Kata Sandi Baru</label>
                <div className="relative">
                  <input
                    type={showConfirmPw ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full pl-3 pr-10 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="Ulangi kata sandi baru"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPw((p) => !p)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 rounded cursor-pointer"
                    aria-label={showConfirmPw ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
                  >
                    {showConfirmPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  Tutup
                </button>
                <button
                  type="submit"
                  disabled={passwordSaving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg cursor-pointer"
                >
                  {passwordSaving ? 'Menyimpan...' : 'Simpan Kata Sandi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
