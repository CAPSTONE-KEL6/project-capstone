# PT Indo Buana Berkah: Website dan CRM-lite

Aplikasi web yang berfungsi penuh: situs company profile, formulir inquiry dengan unggah dokumen,
cek status tiket, dan CRM-lite internal (login, scoring, SLA, pipeline, aktivitas, pengingat, email, log audit).

- **Backend:** Node.js + Express, basis data SQLite bawaan Node (satu berkas), tanpa layanan eksternal wajib.
- **Frontend:** `public/index.html` (situs), `public/crm.js` dan `public/crm.css` (CRM).

## 1. Menjalankan (lokal)
Butuh **Node.js 22.13 atau lebih baru** (LTS 22 atau 24). SQLite memakai modul bawaan Node, jadi tidak ada yang perlu dikompilasi.

```bash
npm install
npm start
```

Saat pertama kali dijalankan, akun **administrator** dibuat dan **password-nya dicetak di konsol** (hanya sekali).
Buka `http://localhost:3000`. CRM ada di tautan **Login Staf (CRM)** pada footer, atau `http://localhost:3000/#crm`.

Ingin password sendiri? Set `ADMIN_EMAIL` dan `ADMIN_PASSWORD` sebelum menjalankan pertama kali.

## 2. Pengguna dan peran
| Peran | Hak akses |
|---|---|
| Administrator | Semua: menugaskan PIC, mengubah tahapan, pengaturan skor dan SLA, kelola pengguna, log audit |
| PIC penjualan | Hanya prospek yang ditugaskan kepadanya: ubah tahapan, catat aktivitas, kirim email |
| Manajer | Melihat seluruh prospek, dashboard, dan log audit (hanya baca) |

Tambah pengguna lewat **CRM, Pengaturan, Tambah pengguna**, atau lewat terminal:
`npm run user:add -- "Nama" email@perusahaan.co.id pic "password-minimal-10"`.

## 3. Konfigurasi
Salin `.env.example` dan isi sesuai kebutuhan, lalu jalankan `node --env-file=.env server.js` (Node 20.6 ke atas),
atau set sebagai environment variable. Yang penting:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`: **tanpa SMTP, email tidak terkirim**; isinya hanya dicatat di tabel `outbox`.
- `PUBLIC_URL`: alamat situs pada email konfirmasi.
- `ADMIN_NOTIFY`: email staf yang diberi tahu tiap ada inquiry baru.
- `DATA_DIR`: lokasi basis data dan dokumen unggahan (default `./data`).

## 4. Data contoh (opsional)
Hanya untuk percobaan, pada basis data kosong: `npm run seed:demo`. Password akun contoh dicetak di konsol.
**Jangan jalankan pada data sebenarnya.**

## 5. Pengujian
`npm test` menjalankan 42 pengujian otomatis (validasi, keamanan, hak akses, scoring, SLA, status tiket) dengan basis data sementara.

## 6. Memasang di server (produksi)
1. Siapkan server dengan Node.js 22.13+ dan **HTTPS** (disarankan Caddy atau Nginx sebagai reverse proxy).
2. Set `NODE_ENV=production` dan `TRUST_PROXY=1` (cookie sesi menjadi `Secure`, alamat IP pengunjung dibaca dari proxy).
3. Jalankan dengan pengelola proses, misalnya `pm2 start server.js --name ibb-web` atau layanan systemd.
4. **Cadangkan folder `data/`** (berisi `ibb.db` dan folder `uploads/`) secara berkala.
5. Isi SMTP dan ganti password admin awal.

## 7. Keamanan yang sudah ada
Password di-hash (bcrypt); sesi cookie `HttpOnly` dan `SameSite=Lax` dengan masa berlaku 8 jam; login dikunci setelah 5 kegagalan;
pembatas laju pada inquiry dan cek status; header CSRF pada seluruh permintaan tulis; kueri berparameter; validasi sisi server;
dokumen hanya PDF, DOC, DOCX, XLS, XLSX maksimal 5 MB dengan pemeriksaan isi berkas, disimpan dengan nama acak di luar folder publik;
cek status memakai kode akses acak (disimpan sebagai hash); honeypot anti-bot; header keamanan dan CSP; log audit.

## 8. Batasan yang perlu diketahui
- Node 22 menampilkan peringatan "SQLite is an experimental feature" saat start; ini normal dan tidak memengaruhi fungsi.
- SQLite cocok untuk satu server dengan beban kecil sampai menengah (sesuai volume inquiry PT IBB). Untuk banyak server, ganti ke PostgreSQL.
- Belum ada: lupa password, autentikasi dua langkah, verifikasi email pengunjung, dan penghapusan atau anonimisasi data otomatis.
  Permintaan penghapusan data pribadi (UU PDP) saat ini ditangani manual lewat basis data.
- Pembatas laju disimpan di memori proses (hilang saat restart).
- Jam kerja SLA (Senin sampai Jumat, 09.00 sampai 17.00) mengikuti zona waktu server; atur `TZ=Asia/Jakarta` bila perlu. Hari libur nasional belum diperhitungkan.
- Biaya hosting dan pengelolaan domain di luar cakupan aplikasi.

## 9. Struktur
```
server.js        rute API, autentikasi, keamanan
lib.js           basis data, skor, SLA, email
public/          index.html, crm.js, crm.css
scripts/         test.js, seed-demo.js, user-add.js
data/            (dibuat otomatis) ibb.db dan uploads/
```
