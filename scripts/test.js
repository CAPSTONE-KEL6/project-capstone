'use strict';
// Uji otomatis: jalankan dengan  npm test   (memakai basis data sementara)
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibb-test-'));
process.env.ADMIN_EMAIL = 'admin@uji.local'; process.env.ADMIN_PASSWORD = 'password-admin-uji';
const app = require('../server'), bcrypt = require('bcryptjs'), { db } = require('../lib');
const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port;
let n = 0; const ok = (m) => console.log('  ✓ ' + m, ++n && '');
const H = { 'X-Requested-With': 'fetch' };
async function call(method, url, body, cookie, extra) {
  const h = { ...H, ...(cookie ? { Cookie: cookie } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(extra || {}) };
  const r = await fetch(base + url, { method, headers: h, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch (e) { j = t; }
  return { s: r.status, j, c: (r.headers.get('set-cookie') || '').split(';')[0], h: r.headers };
}
const form = (o, file) => { const f = new FormData(); Object.entries(o).forEach(([k, v]) => f.append(k, v)); if (file) f.append('lampiran', new Blob([file.data]), file.name); return f; };
const good = { nama: 'Budi', email: 'budi@bumn.co.id', instansi: 'PT BUMN Uji', jenis: 'BUMN', kategori: 'Kartu dan Chip Uang Elektronik', target: 'Dalam 1 bulan', anggaran: 'Di atas Rp500 juta', keterangan: 'Pengadaan kartu dalam jumlah besar untuk seluruh cabang dengan target mulai bulan depan. '.repeat(2) + 'Mohon penawaran.', jadwal: '', persetujuan: 'true', website: '' };
(async () => {
  try {
    console.log('Keamanan dasar');
    assert.equal((await call('GET', '/api/state')).s, 401); ok('state tanpa login ditolak (401)');
    assert.equal((await fetch(base + '/api/inquiries', { method: 'POST' })).status, 400); ok('permintaan tulis tanpa header CSRF ditolak');
    assert.equal((await call('GET', '/')).h.get('x-frame-options'), 'DENY'); ok('header keamanan terpasang');

    console.log('Inquiry publik');
    assert.equal((await call('POST', '/api/inquiries', form({ ...good, persetujuan: 'false' }))).s, 400); ok('tanpa persetujuan ditolak');
    assert.equal((await call('POST', '/api/inquiries', form({ ...good, email: 'salah' }))).s, 400); ok('email tidak valid ditolak');
    assert.equal((await call('POST', '/api/inquiries', form({ ...good, jenis: 'Kementerian' }))).s, 400); ok('nilai di luar daftar ditolak');
    assert.equal((await call('POST', '/api/inquiries', form(good, { name: 'x.exe', data: 'MZ' }))).s, 400); ok('dokumen .exe ditolak');
    assert.equal((await call('POST', '/api/inquiries', form(good, { name: 'palsu.pdf', data: 'bukan pdf' }))).s, 400); ok('PDF palsu (isi tidak cocok) ditolak');
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5.5 * 1024 * 1024)]);
    assert.equal((await call('POST', '/api/inquiries', form(good, { name: 'besar.pdf', data: big }))).s, 400); ok('dokumen > 5 MB ditolak');
    const hp = await call('POST', '/api/inquiries', form({ ...good, website: 'bot' })); assert.equal(hp.s, 200);
    assert.equal(db.prepare('select count(*) c from inquiries').get().c, 0); ok('honeypot tidak membuat data');
    const r1 = await call('POST', '/api/inquiries', form(good, { name: 'KAK proyek.pdf', data: '%PDF-1.4 uji' })); assert.equal(r1.s, 200);
    assert.match(r1.j.no, /^IBB-\d{4}-0001$/); assert.equal(r1.j.kode.length, 10); ok('inquiry valid tersimpan: ' + r1.j.no);
    assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length, 1); ok('dokumen tersimpan di luar folder publik');
    assert.equal(db.prepare('select count(*) c from outbox where tiket=?').get(r1.j.no).c, 1); ok('email konfirmasi dicatat ke outbox');

    console.log('Status tiket');
    assert.equal((await call('GET', `/api/status?no=${r1.j.no}&kode=SALAHSALAH`)).s, 404); ok('kode akses salah ditolak');
    const st = await call('GET', `/api/status?no=${r1.j.no}&kode=${r1.j.kode}`); assert.equal(st.j.stage, 0); ok('status dengan kode benar: tahap Baru');

    console.log('Login');
    assert.equal((await call('POST', '/api/login', { email: 'admin@uji.local', password: 'salah' })).s, 401); ok('password salah ditolak');
    const lg = await call('POST', '/api/login', { email: 'admin@uji.local', password: 'password-admin-uji' }); assert.equal(lg.s, 200);
    const A = lg.c; assert.ok(/sid=/.test(A)); assert.ok(/HttpOnly/i.test(lg.h.get('set-cookie'))); ok('login admin berhasil, cookie HttpOnly');

    console.log('CRM sebagai administrator');
    let S = (await call('GET', '/api/state', null, A)).j; const lead = S.leads[0];
    assert.equal(lead.skor, 30 + 25 + 25 + 10); assert.equal(lead.prio, 'Tinggi'); assert.equal(lead.file, 'KAK proyek.pdf'); ok('skor v2 dihitung server: 90 (Tinggi)');
    assert.ok(lead.due > lead.created); ok('batas SLA dihitung dalam jam kerja');
    // buat PIC & manajer
    assert.equal((await call('POST', '/api/users', { nama: 'Rina', email: 'rina@uji.local', peran: 'pic', password: 'pendek' }, A)).s, 400); ok('password < 10 karakter ditolak');
    assert.equal((await call('POST', '/api/users', { nama: 'Rina', email: 'rina@uji.local', peran: 'pic', password: 'password-rina-uji' }, A)).s, 200);
    assert.equal((await call('POST', '/api/users', { nama: 'Dimas', email: 'dimas@uji.local', peran: 'pic', password: 'password-dimas-uji' }, A)).s, 200);
    assert.equal((await call('POST', '/api/users', { nama: 'Manajer', email: 'mgr@uji.local', peran: 'manajer', password: 'password-mgr-uji!' }, A)).s, 200);
    const users = (await call('GET', '/api/state', null, A)).j.users; const rina = users.find((u) => u.nama === 'Rina'), dimas = users.find((u) => u.nama === 'Dimas'); ok('pengguna PIC dan manajer dibuat');
    assert.equal((await call('POST', `/api/leads/${lead.no}/pic`, { pic_id: rina.id }, A)).s, 200); ok('PIC ditugaskan');
    assert.equal((await call('POST', `/api/leads/${lead.no}/stage`, { to: 1 }, A)).s, 200);
    assert.equal((await call('GET', `/api/status?no=${r1.j.no}&kode=${r1.j.kode}`)).j.stage, 1); ok('tahapan berubah dan terlihat di status publik');
    assert.equal((await call('POST', `/api/leads/${lead.no}/stage`, { to: 9 }, A)).s, 400); ok('tahapan tidak valid ditolak');
    const act = await call('POST', `/api/leads/${lead.no}/activities`, { jenis: 'Telepon / WhatsApp', catatan: 'Konfirmasi jadwal', pengingat: Date.now() + 36e5 }, A); assert.equal(act.s, 200);
    S = (await call('GET', '/api/state', null, A)).j; const aid = S.leads[0].acts.find((a) => a.rem).id;
    assert.equal((await call('POST', `/api/leads/${lead.no}/activities/${aid}/done`, {}, A)).s, 200); ok('aktivitas dengan pengingat dicatat dan diselesaikan');
    const em = await call('POST', `/api/leads/${lead.no}/email`, { subjek: 'Tindak lanjut', isi: 'Halo' }, A); assert.equal(em.s, 200); assert.match(em.j.status, /tersimpan|terkirim/); ok('email balasan diproses: ' + em.j.status);
    const dl = await fetch(base + `/api/leads/${lead.no}/file`, { headers: { Cookie: A } }); assert.equal(dl.status, 200); assert.equal((await dl.text()).slice(0, 4), '%PDF'); ok('dokumen dapat diunduh oleh staf');
    assert.equal((await fetch(base + `/api/leads/${lead.no}/file`)).status, 401); ok('dokumen tidak dapat diunduh tanpa login');
    const csv = await fetch(base + '/api/export.csv', { headers: { Cookie: A } }); assert.match(await csv.text(), /IBB-\d{4}-0001/); ok('ekspor CSV berfungsi');
    S = (await call('GET', '/api/state', null, A)).j; assert.ok(S.logs.some((l) => l.a === 'Tahapan diubah')); ok('log audit mencatat perubahan');
    const cfg = S.cfg; cfg.tgt['Dalam 1 bulan'] = 10;
    assert.equal((await call('PUT', '/api/config', { cfg, recalc: true }, A)).s, 200);
    assert.equal((await call('GET', '/api/state', null, A)).j.leads[0].skor, 70); ok('ubah bobot + hitung ulang: skor 90 → 70');
    cfg.tgt['Dalam 1 bulan'] = -5; assert.equal((await call('PUT', '/api/config', { cfg }, A)).s, 400); ok('pengaturan tidak valid ditolak');

    console.log('Hak akses per peran');
    const R = (await call('POST', '/api/login', { email: 'rina@uji.local', password: 'password-rina-uji' })).c;
    const D = (await call('POST', '/api/login', { email: 'dimas@uji.local', password: 'password-dimas-uji' })).c;
    const M = (await call('POST', '/api/login', { email: 'mgr@uji.local', password: 'password-mgr-uji!' })).c;
    assert.equal((await call('GET', '/api/state', null, R)).j.leads.length, 1); assert.equal((await call('GET', '/api/state', null, D)).j.leads.length, 0); ok('PIC hanya melihat prospek miliknya');
    assert.equal((await call('POST', `/api/leads/${lead.no}/stage`, { to: 2 }, D)).s, 404); ok('PIC lain tidak dapat membuka prospek orang lain');
    assert.equal((await call('POST', `/api/leads/${lead.no}/pic`, { pic_id: dimas.id }, R)).s, 403); ok('PIC tidak dapat menugaskan PIC');
    assert.equal((await call('POST', `/api/leads/${lead.no}/stage`, { to: 2 }, M)).s, 403); ok('manajer tidak dapat mengubah prospek (hanya baca)');
    assert.equal((await call('PUT', '/api/config', { cfg }, R)).s, 403); ok('PIC tidak dapat mengubah pengaturan');
    assert.equal((await call('GET', '/api/state', null, M)).j.leads.length, 1); ok('manajer melihat seluruh prospek');
    assert.equal((await call('POST', `/api/leads/${lead.no}/stage`, { to: 4 }, R)).s, 200);
    assert.equal((await call('POST', `/api/leads/${lead.no}/stage`, { to: 2 }, R)).s, 409); ok('prospek selesai tidak dapat diubah lagi');

    console.log('Ketahanan');
    assert.equal((await call('POST', `/api/users/${rina.id}/toggle`, {}, A)).s, 200);
    assert.equal((await call('GET', '/api/state', null, R)).s, 401); ok('akun dinonaktifkan: sesi langsung tidak berlaku');
    for (let i = 0; i < 5; i++) await call('POST', '/api/login', { email: 'dimas@uji.local', password: 'salah' });
    assert.equal((await call('POST', '/api/login', { email: 'dimas@uji.local', password: 'password-dimas-uji' })).s, 429); ok('login dikunci setelah 5 kegagalan');
    const lo = await call('POST', '/api/logout', {}, A); assert.equal(lo.s, 200); assert.equal((await call('GET', '/api/me', null, A)).s, 401); ok('logout mengakhiri sesi');
    console.log(`\nSEMUA ${n} PENGUJIAN LULUS`); srv.close(); process.exit(0);
  } catch (e) { console.error('\nGAGAL:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')); srv.close(); process.exit(1); }
})();
