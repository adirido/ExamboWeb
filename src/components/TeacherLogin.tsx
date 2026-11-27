import React, { useState } from 'react';
import { ShieldCheck, Lock, Mail, ArrowRight, Smartphone, Eye, EyeOff } from 'lucide-react';
import { teacherApi } from '../api';
import type { TeacherProfile } from '../types';

interface TeacherLoginProps {
  onSuccess: (token: string, teacher: TeacherProfile) => void;
  onOpenStudentPortal: () => void;
}

export const TeacherLogin: React.FC<TeacherLoginProps> = ({ onSuccess, onOpenStudentPortal }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await teacherApi.login(email, password);
      onSuccess(res.token, res.teacher);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal masuk ke sistem.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Bar Contract: 3 clean zones */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-8">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <ShieldCheck className="w-5 h-5 text-blue-700" aria-hidden="true" />
          <span className="font-display text-lg font-bold tracking-tight text-slate-900">
            ExamFlow Pro
          </span>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <span className="text-slate-900 whitespace-nowrap shrink-0">Portal Guru & Pengawas</span>
          <span className="text-slate-300" aria-hidden="true">/</span>
          <button
            type="button"
            onClick={onOpenStudentPortal}
            className="hover:text-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Simulasi APK Exambro Siswa
          </button>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onOpenStudentPortal}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Smartphone className="w-4 h-4" aria-hidden="true" />
            Masuk Portal Ujian Siswa
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Institutional Summary */}
          <div className="lg:col-span-6 flex flex-col justify-between bg-white border border-slate-200 rounded-xl p-8">
            <div>
              <p className="text-xs font-medium text-blue-700 mb-3">
                Sistem Asesmen Terpadu · Integrasi Android Exambro
              </p>
              <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight mb-4" style={{ textWrap: 'balance' }}>
                Kendali Penuh Ujian Sekolah, Token Dinamis, dan Pengawasan Real-Time
              </h1>
              <p className="text-sm text-slate-600 leading-relaxed mb-8">
                Kelola beberapa mata pelajaran dan kelas dalam satu dasbor. Aktifkan paket ujian dengan QR Code terenkripsi, rotasi token instan, soal acak konsisten per siswa, dan buka kunci pelanggaran secara langsung.
              </p>

              <div className="space-y-4 border-t border-slate-100 pt-6 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <span className="font-medium text-slate-800">Multi-Mapel & Multi-Kelas</span>
                  <span className="text-xs text-slate-500 text-right">Matematika, IPA, Informatika</span>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <span className="font-medium text-slate-800">Keamanan PIN & QR</span>
                  <span className="text-xs text-slate-500 text-right">Hash scrypt · AES-256-GCM</span>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <span className="font-medium text-slate-800">Live Proctoring</span>
                  <span className="text-xs text-slate-500 text-right">WebSocket + Buka Kunci Instan</span>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-700 mb-1.5">Akses Resmi Pengawas & Guru</p>
              <p className="text-xs text-slate-500 leading-relaxed">
                Masuk menggunakan akun guru atau admin semester yang telah ditetapkan oleh operator sekolah. Segera perbarui kata sandi melalui menu <span className="font-semibold text-slate-700">Ubah Kata Sandi</span> di dasbor setelah login pertama.
              </p>
            </div>
          </div>

          {/* Right Sign-in Form */}
          <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-8 flex flex-col justify-center">
            <h2 className="font-display text-xl font-bold text-slate-900 mb-1">Masuk Dasbor Guru</h2>
            <p className="text-sm text-slate-500 mb-6">
              Gunakan akun guru terdaftar untuk mengelola paket ujian dan memantau sesi siswa.
            </p>

            {error && (
              <div className="mb-5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="teacher-email" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Email Guru
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
                  <input
                    id="teacher-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    placeholder="nama@examflow.sch.id"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="teacher-password" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Kata Sandi
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
                  <input
                    id="teacher-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-10 pr-10 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 absolute right-2 top-1/2 -translate-y-1/2 rounded-md transition-colors cursor-pointer"
                    aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
                    title={showPassword ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" aria-hidden="true" />
                    ) : (
                      <Eye className="w-4 h-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-60 transition-colors cursor-pointer"
              >
                {loading ? 'Memverifikasi...' : 'Masuk ke Dasbor'}
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </form>

            <div className="mt-6 pt-5 border-t border-slate-100 text-xs text-slate-500">
              Hubungi Admin Penanggung Jawab Ujian apabila Anda belum memiliki kredensial akses atau lupa kata sandi.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
