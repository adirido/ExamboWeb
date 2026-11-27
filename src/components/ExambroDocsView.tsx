import React, { useState } from 'react';
import { Plus, Smartphone, Shield, Server } from 'lucide-react';
import { teacherApi } from '../api';
import type { ClassItem, SubjectItem, TeacherAssignment } from '../types';

interface ExambroDocsViewProps {
  token: string;
  assignments: TeacherAssignment[];
  subjects: SubjectItem[];
  classes: ClassItem[];
  onRefreshContext: () => Promise<void>;
}

export const ExambroDocsView: React.FC<ExambroDocsViewProps> = ({
  token,
  assignments,
  subjects,
  classes,
  onRefreshContext,
}) => {
  const [subjectId, setSubjectId] = useState<number>(subjects[0]?.id || 1);
  const [classId, setClassId] = useState<number>(classes[0]?.id || 1);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function handleAddAssignment(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await teacherApi.addAssignment(token, subjectId, classId);
      await onRefreshContext();
      setMsg('Penugasan mata pelajaran & kelas berhasil ditambahkan.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal menambah penugasan.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Multi-Mapel Multi-Kelas Assignment Panel */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-display text-lg font-bold text-slate-900">Penugasan Multi-Mapel & Multi-Kelas</h2>
        <p className="text-xs text-slate-500 mt-1">
          Satu akun guru dapat mengampu lebih dari 1 mata pelajaran dan lebih dari 1 kelas secara bersamaan.
        </p>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <div className="text-xs font-semibold text-slate-700 mb-2">Penugasan Aktif Anda</div>
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
              {assignments.map((a) => (
                <div key={a.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-900">{a.subject_name}</span>
                  <span className="text-slate-500 font-mono">Kelas {a.class_name}</span>
                </div>
              ))}
            </div>
          </div>

          <form onSubmit={handleAddAssignment} className="space-y-3">
            <div className="text-xs font-semibold text-slate-700">Tambah Penugasan Mapel / Kelas</div>
            <div className="grid grid-cols-2 gap-3">
              <select
                value={subjectId}
                onChange={(e) => setSubjectId(Number(e.target.value))}
                className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                value={classId}
                onChange={(e) => setClassId(Number(e.target.value))}
                className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    Kelas {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              {saving ? 'Menyimpan...' : 'Tambahkan Penugasan'}
            </button>
            {msg && <p className="text-xs text-slate-700 font-medium">{msg}</p>}
          </form>
        </div>
      </div>

      {/* APK Exambro Android Integration Spec */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Smartphone className="w-5 h-5 text-blue-700" />
            <h3 className="font-display text-base font-bold text-slate-900">Konfigurasi Header APK Exambro Android</h3>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Seluruh endpoint ujian siswa dilindungi oleh pengecekan header klien dan <span className="font-mono">Authorization: Bearer &lt;session_token&gt;</span>. Atur interceptor OkHttp/Retrofit pada APK Exambro Anda agar mengirim header berikut:
          </p>
          <pre className="p-4 bg-slate-900 text-slate-100 rounded-lg text-xs overflow-x-auto leading-relaxed">
{`X-Exambro-Client: ExambroPro-Android-v1   # atau ExamFlow-Exambro-Android/2.4
X-Exambro-Key: <wajib jika EXAMBRO_STRICT_HEADER=true>
Authorization: Bearer <session_token_dari_verify>
# Khusus backend Supabase Edge Function, kirim juga:
# apikey: <SUPABASE_ANON_KEY> & X-ExamFlow-Token: <session_token>
Content-Type: application/json`}
          </pre>
          <div className="text-xs text-slate-600">
            Format Deep Link QR Code: <span className="font-mono text-slate-900">examflow://join?payload=ef1....</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Server className="w-5 h-5 text-blue-700" />
            <h3 className="font-display text-base font-bold text-slate-900">Ringkasan Endpoint API Utama</h3>
          </div>
          <div className="divide-y divide-slate-100 text-xs">
            <div className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-blue-700">POST /api/exambro/decode-qr</span>
              <span className="text-slate-600 text-right">Dekode payload QR terenkripsi</span>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-blue-700">POST /api/exambro/verify</span>
              <span className="text-slate-600 text-right">Validasi Token, NIS, PIN & terbit session_token</span>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-emerald-700">GET /api/exam/session</span>
              <span className="text-slate-600 text-right">Soal acak terkunci + sisa waktu server</span>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-blue-700">POST /api/exam/answer</span>
              <span className="text-slate-600 text-right">Auto-save berdasarkan ID soal asli</span>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-red-700">POST /api/exam/violation</span>
              <span className="text-slate-600 text-right">Catat pelanggaran & kunci otomatis</span>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-blue-700">POST /api/exam/submit</span>
              <span className="text-slate-600 text-right">Submit akhir & hitung skor otomatis</span>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-slate-900">POST /api/sessions/:id/unlock</span>
              <span className="text-slate-600 text-right">Guru membuka kunci sesi terkunci</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6 flex items-start gap-3">
        <Shield className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
        <div className="text-xs text-slate-600 leading-relaxed">
          <strong className="text-slate-900">Jaminan Keamanan Kunci Jawaban:</strong> Kolom <span className="font-mono">correct_option</span> tidak pernah disertakan pada payload JSON endpoint <span className="font-mono">/api/exam/session</span> selama ujian berlangsung. Penilaian dilakukan sepenuhnya di server saat waktu habis atau siswa menekan tombol Submit.
        </div>
      </div>
    </div>
  );
};
