# ExamFlow Pro

Sistem manajemen ujian sekolah terpadu (Dasbor Guru/Admin, Portal Ujian Siswa, REST API, Live Monitoring Realtime, dan integrasi APK Exambro Android).

ExamFlow Pro mendukung **dua mode deployment**:
1. **Mode Lokal / Server Sekolah (Express + SQLite + WebSocket)** — langsung berjalan di port `3000` tanpa layanan eksternal.
2. **Mode Cloud Gratis (GitHub Pages + Supabase PostgreSQL + Edge Functions + Realtime)** — frontend di-host gratis di GitHub Pages (`username.github.io`), seluruh backend & database berjalan di Supabase.

---

## Mode 1: Menjalankan di Lokal / VPS / Server Sekolah

### Prasyarat
- **Node.js `>= 22.18.0`**
- **npm**

```bash
# 1. Install dependensi
npm install

# 2. Salin konfigurasi environment (isi EXAMFLOW_QR_SECRET untuk produksi)
cp .env.example .env

# 3. Mode pengembangan (dev)
npm run dev

# 4. Mode produksi (build frontend + jalankan server Node.js)
npm run build
NODE_ENV=production npm start
```

Server berjalan pada port `3000` (atau sesuai variabel `PORT`) dengan endpoint health check `/api/health`. Data lokal tersimpan di `./data/examflow.db` (SQLite mode WAL).

---

## Mode 2: Deploy ke GitHub Pages + Supabase (Cloud)

Dengan arsitektur ini, Anda dapat membuka web langsung dari tautan `https://<username>.github.io/<nama-repo>/` sementara database PostgreSQL, API, dan Realtime monitoring berjalan di Supabase.

### Langkah 1 — Siapkan Proyek Supabase
1. Buat proyek baru di [Supabase](https://supabase.com) dan catat **Project Reference ID**, **Project URL** (`https://<ref>.supabase.co`), **Database Password**, dan **anon public key**.
2. Jalankan migrasi SQL (`supabase/migrations/001_initial_schema.sql`) melalui salah satu cara:
   - **Cara Termudah (Dashboard)**: buka **SQL Editor** di dashboard Supabase, tempel isi file `supabase/migrations/001_initial_schema.sql`, lalu klik **Run**.
   - **Atau otomatis lewat GitHub Actions**: sertakan `SUPABASE_DB_PASSWORD` pada langkah di bawah.

### Langkah 2 — Deploy Edge Function `api`
Anda bisa memilih **Otomatis lewat GitHub Actions** (tanpa install CLI di laptop) atau lewat terminal lokal:

**Opsi A — Otomatis via GitHub Actions (`.github/workflows/deploy-supabase.yml`):**
1. Buka **Settings → Secrets and variables → Actions → Secrets** di repository GitHub Anda.
2. Tambahkan repository secrets berikut:
   - `SUPABASE_ACCESS_TOKEN` (buat di [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens))
   - `SUPABASE_PROJECT_REF` (ID proyek Supabase Anda)
   - `EXAMFLOW_QR_SECRET` (string acak minimal 32 karakter untuk enkripsi QR, PIN, & sesi)
   - `SUPABASE_DB_PASSWORD` *(opsional, jika ingin `supabase db push` berjalan otomatis dari GitHub)*
3. Buka tab **Actions → Deploy Supabase Backend → Run workflow**.

**Opsi B — Manual via Terminal Lokal:**
```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
npx supabase secrets set EXAMFLOW_QR_SECRET="ganti-dengan-secret-acak-minimal-32-karakter"
npx supabase secrets set ALLOWED_ORIGIN="https://<username>.github.io"
npx supabase functions deploy api --no-verify-jwt
```

### Langkah 3 — Aktifkan GitHub Pages & Variables
1. Push repository ke GitHub (`main` atau `master`).
2. Buka **Settings → Pages** di repository GitHub Anda, lalu set **Source** ke **GitHub Actions**.
3. Buka **Settings → Secrets and variables → Actions → Variables**, lalu tambahkan 3 repository variables berikut:
   - `VITE_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `<supabase-anon-public-key>`
   - `VITE_API_BASE_URL` = `https://<project-ref>.supabase.co/functions/v1/api`
4. Jalankan workflow **Deploy to GitHub Pages** (atau push commit baru). Setelah selesai, aplikasi aktif di `https://<username>.github.io/<nama-repo>/`.

---

## Ringkasan Variabel Environment

| Variabel | Lokasi | Keterangan |
| --- | --- | --- |
| `EXAMFLOW_QR_SECRET` | Server / Supabase Secrets | Secret enkripsi AES-256-GCM & HMAC untuk QR, PIN, dan token guru |
| `EXAMFLOW_DB_PATH` | Server Node.js | Path kustom file SQLite (opsional, default `./data/examflow.db`) |
| `EXAMBRO_STRICT_HEADER` | Server / Supabase Secrets | Set `true` untuk wajib memvalidasi `X-Exambro-Key` |
| `EXAMBRO_CLIENT_KEY` | Server / Supabase Secrets | Kunci rahasia klien APK Exambro jika mode ketat aktif |
| `ALLOWED_ORIGIN` | Supabase Secrets | Origin CORS yang diizinkan (misal `https://<username>.github.io`) |
| `VITE_SUPABASE_URL` | Frontend Build (GitHub Vars) | URL proyek Supabase (kosongkan untuk mode Express lokal) |
| `VITE_SUPABASE_ANON_KEY` | Frontend Build (GitHub Vars) | Public anon key Supabase |
| `VITE_API_BASE_URL` | Frontend Build (GitHub Vars) | URL Edge Function (`https://<ref>.supabase.co/functions/v1/api`) |
| `VITE_BASE_PATH` | Frontend Build (GitHub Actions) | Subpath GitHub Pages (otomatis `/<nama-repo>/` di workflow) |

## Akun Uji Coba Awal (Seed Data)

- **Admin Semester**: `budi.santoso@examflow.sch.id` / `guru123`
- **Guru Mapel**: `siti.aminah@examflow.sch.id` / `guru123`
- **PIN Semester Siswa Default**: `123456` (NIS contoh kelas 8A: `20260801` – `20260806`)

> Segera ubah kata sandi default, atur `EXAMFLOW_QR_SECRET`, dan reset PIN siswa sebelum digunakan pada ujian sekolah resmi.
