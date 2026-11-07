'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { db, ST, LISTS } = L;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const UPLOADS = path.join(L.DATA, 'uploads');

// ---------- bootstrap admin pertama ----------
if (!db.prepare('select 1 from users limit 1').get()) {
  const email = process.env.ADMIN_EMAIL || 'admin@indobuanaberkah.local';
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('insert into users(nama,email,password_hash,peran) values(?,?,?,?)').run('Administrator', email, bcrypt.hashSync(pw, 10), 'admin');
  console.log('\n=== AKUN ADMIN DIBUAT ===\nEmail   : ' + email + '\nPassword: ' + pw + '\nSimpan password ini lalu segera ganti/buat pengguna baru.\n');
}

// ---------- header keamanan ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '100kb' }));
// perlindungan CSRF sederhana: seluruh permintaan penulisan wajib membawa header khusus (cookie SameSite=Lax juga dipakai)
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Requested-With') !== 'fetch') return res.status(400).json({ error: 'Permintaan tidak valid.' });
  next();
});

// ---------- pembatas laju ----------
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms);
  a.push(now); hits.set(key, a);
  return a.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some((t) => n - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const tooMany = (res) => res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa saat lagi.' });

// ---------- sesi ----------
const cookie = (req, n) => (req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).find((p) => p[0] === n)?.[1];
function setSession(res, uid) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('insert into sessions(id,user_id,expires) values(?,?,?)').run(L.sha(sid), uid, Date.now() + 8 * 3600e3);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${PROD ? '; Secure' : ''}`);
}
function auth(...roles) {
  return (req, res, next) => {
    const sid = cookie(req, 'sid');
    const u = sid && db.prepare('select u.id,u.nama,u.email,u.peran from sessions s join users u on u.id=s.user_id where s.id=? and s.expires>? and u.aktif=1').get(L.sha(sid), Date.now());
    if (!u) return res.status(401).json({ error: 'Sesi berakhir. Silakan masuk kembali.' });
    if (roles.length && !roles.includes(u.peran)) return res.status(403).json({ error: 'Anda tidak memiliki akses.' });
    req.user = u; next();
  };
}

// ---------- validasi ----------
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;
function clean(b, manual) {
  const d = { nama: str(b.nama, 100), email: str(b.email, 120).toLowerCase(), instansi: str(b.instansi, 150), jenis: str(b.jenis, 20), kat: str(b.kategori ?? b.kat, 60), tgt: str(b.target ?? b.tgt, 30), ang: str(b.anggaran ?? b.ang, 40), ket: str(b.keterangan ?? b.ket, 3000), jadwal: str(b.jadwal, 40), sumber: manual ? str(b.sumber, 20) : 'Formulir web' };
  if (!d.nama || !d.instansi || !d.ket) return { error: 'Lengkapi seluruh kolom wajib.' };
  if (!emailOk(d.email)) return { error: 'Format email tidak valid.' };
  if (!LISTS.jenis.includes(d.jenis) || !LISTS.kat.includes(d.kat) || !LISTS.tgt.includes(d.tgt) || !LISTS.ang.includes(d.ang) || !LISTS.jadwal.includes(d.jadwal) || !LISTS.sumber.includes(d.sumber)) return { error: 'Pilihan formulir tidak valid.' };
  return { d };
}
const MAGIC = { pdf: (b) => b.slice(0, 4).toString() === '%PDF', docx: (b) => b[0] === 0x50 && b[1] === 0x4b, xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b, doc: (b) => b.slice(0, 4).toString('hex') === 'd0cf11e0', xls: (b) => b.slice(0, 4).toString('hex') === 'd0cf11e0' };
function saveFile(f) {
  if (!f) return null;
  const ext = path.extname(f.originalname).slice(1).toLowerCase();
  if (!MAGIC[ext]) throw Object.assign(new Error('Dokumen harus berformat PDF, DOC, DOCX, XLS, atau XLSX.'), { status: 400 });
  if (!MAGIC[ext](f.buffer)) throw Object.assign(new Error('Isi berkas tidak sesuai dengan formatnya.'), { status: 400 });
  const simpan = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS, simpan), f.buffer, { mode: 0o600 });
  return { nama: path.basename(f.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 120), simpan, tipe: ext, ukuran: f.size };
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 } });

// ---------- API publik ----------
app.post('/api/inquiries', (req, res, next) => {
  if (limited('inq:' + req.ip, 10, 3600e3)) return tooMany(res);
  upload.single('lampiran')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran dokumen maksimal 5 MB.' : 'Gagal membaca formulir.' });
    next();
  });
}, async (req, res) => {
  try {
    if (req.body.website) return res.json({ no: 'IBB-0000-0000', kode: 'XXXXXXXXXX' }); // honeypot: bot dibuat seolah berhasil
    if (req.body.persetujuan !== 'true') return res.status(400).json({ error: 'Persetujuan penggunaan data wajib dicentang.' });
    const v = clean(req.body, false);
    if (v.error) return res.status(400).json({ error: v.error });
    const file = saveFile(req.file);
    const r = L.createInquiry(v.d, file, 'Pengunjung');
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    L.sendMail(v.d.email, `Permintaan Anda diterima (${r.no})`, `Yth. ${v.d.nama},\n\nTerima kasih telah menghubungi PT Indo Buana Berkah. Permintaan Anda untuk ${v.d.kat} telah kami terima.\n\nNomor tiket : ${r.no}\nKode akses  : ${r.kode}\nCek status  : ${base}/#contact\n\nTim kami akan menghubungi Anda paling lambat 1x24 jam kerja.\n\nSalam,\nPT Indo Buana Berkah`, r.no).catch(() => {});
    if (process.env.ADMIN_NOTIFY) L.sendMail(process.env.ADMIN_NOTIFY, `Inquiry baru ${r.no}: ${v.d.instansi}`, `${v.d.instansi} (${v.d.jenis}) mengajukan ${v.d.kat}.\nPrioritas ${r.prio} (skor ${r.skor}).`, r.no).catch(() => {});
    res.json({ no: r.no, kode: r.kode });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Terjadi kesalahan pada server.' }); }
});
app.get('/api/status', (req, res) => {
  if (limited('st:' + req.ip, 30, 600e3)) return tooMany(res);
  const no = str(req.query.no, 20).toUpperCase(), kode = str(req.query.kode, 20).toUpperCase();
  const r = db.prepare('select i.kode_hash h,i.nomor_tiket no,i.kategori kat,i.dibuat_pada created,i.jadwal,l.tahapan stage from inquiries i join leads l on l.inquiry_id=i.id where i.nomor_tiket=?').get(no);
  const ok = r && crypto.timingSafeEqual(Buffer.from(r.h), Buffer.from(L.sha(kode)));
  if (!ok) return res.status(404).json({ error: 'Tiket tidak ditemukan. Periksa nomor tiket dan kode akses pada email konfirmasi.' });
  res.json({ no: r.no, kat: r.kat, created: r.created, stage: r.stage, jadwal: r.jadwal });
});

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const email = str(req.body.email, 120).toLowerCase(), key = 'login:' + req.ip + ':' + email;
  if ((hits.get(key) || []).filter((t) => Date.now() - t < 900e3).length >= 5) return tooMany(res);
  const u = db.prepare('select * from users where email=? and aktif=1').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    limited(key, 99, 900e3); L.audit(email || '-', 'Login gagal', req.ip);
    return res.status(401).json({ error: 'Email atau password salah.' });
  }
  hits.delete(key); setSession(res, u.id); L.audit(u.nama, 'Login', u.peran);
  res.json({ ok: true });
});
app.post('/api/logout', auth(), (req, res) => {
  db.prepare('delete from sessions where id=?').run(L.sha(cookie(req, 'sid')));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true });
});
app.get('/api/me', auth(), (req, res) => res.json(req.user));

// ---------- CRM ----------
const canEdit = (u, l) => u.peran === 'admin' || (u.peran === 'pic' && l.pic_id === u.id);
const getLead = (req, res) => {
  const l = L.rawLead(req.params.no);
  if (!l || (req.user.peran === 'pic' && l.pic_id !== req.user.id)) { res.status(404).json({ error: 'Prospek tidak ditemukan.' }); return null; }
  return l;
};
app.get('/api/state', auth(), (req, res) => {
  const u = req.user, cfg = L.getCfg();
  const users = u.peran === 'admin' ? db.prepare('select id,nama,email,peran,aktif from users order by id').all()
    : db.prepare("select id,nama,peran,1 aktif from users where peran='pic' and aktif=1").all();
  const logs = u.peran === 'pic' ? [] : db.prepare('select waktu t,pengguna u,aksi a,rincian d,tiket no from audit_log order by id desc limit 200').all();
  res.json({ me: u, leads: L.leadsFor(u), logs, cfg, users });
});
app.post('/api/leads', auth('admin', 'pic'), (req, res) => {
  const v = clean(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = L.createInquiry(v.d, null, req.user.nama, { picId: req.user.peran === 'pic' ? req.user.id : null });
  res.json({ no: r.no });
});
app.post('/api/leads/:no/stage', auth('admin', 'pic'), (req, res) => {
  const l = getLead(req, res); if (!l) return;
  const to = Number(req.body.to);
  if (!canEdit(req.user, l)) return res.status(403).json({ error: 'Anda tidak berwenang mengubah prospek ini.' });
  if (!Number.isInteger(to) || to < 0 || to > 4) return res.status(400).json({ error: 'Tahapan tidak valid.' });
  if (l.tahapan >= 4) return res.status(409).json({ error: 'Prospek sudah selesai dan tidak dapat diubah.' });
  if (to === l.tahapan) return res.json({ ok: true });
  const now = Date.now();
  L.tx(() => {
    db.prepare('update leads set tahapan=?, respons_pertama=coalesce(respons_pertama,?) where id=?').run(to, now, l.lid);
    db.prepare('insert into stage_history(lead_id,dari,ke,oleh,waktu) values(?,?,?,?,?)').run(l.lid, ST[l.tahapan], ST[to], req.user.nama, now);
    L.audit(req.user.nama, 'Tahapan diubah', `${ST[l.tahapan]} → ${ST[to]}`, req.params.no);
  });
  res.json({ ok: true });
});
app.post('/api/leads/:no/pic', auth('admin'), (req, res) => {
  const l = getLead(req, res); if (!l) return;
  const id = req.body.pic_id ? Number(req.body.pic_id) : null;
  if (id && !db.prepare("select 1 from users where id=? and peran='pic' and aktif=1").get(id)) return res.status(400).json({ error: 'PIC tidak valid.' });
  if (l.tahapan >= 4) return res.status(409).json({ error: 'Prospek sudah selesai.' });
  const nm = id ? db.prepare('select nama from users where id=?').get(id).nama : 'belum ada';
  db.prepare('update leads set pic_id=? where id=?').run(id, l.lid);
  db.prepare('insert into activities(lead_id,user_id,oleh,jenis,catatan,dibuat_pada) values(?,?,?,?,?,?)').run(l.lid, req.user.id, req.user.nama, 'Catatan', 'PIC ditetapkan: ' + nm, Date.now());
  L.audit(req.user.nama, 'PIC ditetapkan', nm, req.params.no); res.json({ ok: true });
});
app.post('/api/leads/:no/activities', auth('admin', 'pic'), (req, res) => {
  const l = getLead(req, res); if (!l) return;
  if (!canEdit(req.user, l)) return res.status(403).json({ error: 'Anda tidak berwenang mengubah prospek ini.' });
  const jenis = str(req.body.jenis, 30), cat = str(req.body.catatan, 1000), rem = req.body.pengingat ? Number(req.body.pengingat) : null;
  if (!['Email', 'Telepon / WhatsApp', 'Rapat', 'Catatan'].includes(jenis) || !cat) return res.status(400).json({ error: 'Jenis dan catatan wajib diisi.' });
  const now = Date.now();
  db.prepare('insert into activities(lead_id,user_id,oleh,jenis,catatan,pengingat,dibuat_pada) values(?,?,?,?,?,?,?)').run(l.lid, req.user.id, req.user.nama, jenis, cat, Number.isFinite(rem) ? rem : null, now);
  db.prepare('update leads set respons_pertama=coalesce(respons_pertama,?) where id=?').run(now, l.lid);
  L.audit(req.user.nama, 'Aktivitas dicatat', cat.slice(0, 60), req.params.no); res.json({ ok: true });
});
app.post('/api/leads/:no/activities/:aid/done', auth('admin', 'pic'), (req, res) => {
  const l = getLead(req, res); if (!l) return;
  if (!canEdit(req.user, l)) return res.status(403).json({ error: 'Tidak berwenang.' });
  db.prepare('update activities set selesai=1 where id=? and lead_id=?').run(Number(req.params.aid), l.lid);
  L.audit(req.user.nama, 'Tugas selesai', '', req.params.no); res.json({ ok: true });
});
app.post('/api/leads/:no/email', auth('admin', 'pic'), async (req, res) => {
  const l = getLead(req, res); if (!l) return;
  if (!canEdit(req.user, l)) return res.status(403).json({ error: 'Tidak berwenang.' });
  const subjek = str(req.body.subjek, 150), isi = str(req.body.isi, 5000);
  if (!subjek || !isi) return res.status(400).json({ error: 'Subjek dan isi wajib diisi.' });
  const status = await L.sendMail(l.email, subjek, isi, req.params.no), now = Date.now();
  db.prepare('insert into activities(lead_id,user_id,oleh,jenis,catatan,dibuat_pada) values(?,?,?,?,?,?)').run(l.lid, req.user.id, req.user.nama, 'Email', `Email "${subjek}" — ${status}`, now);
  db.prepare('update leads set respons_pertama=coalesce(respons_pertama,?) where id=?').run(now, l.lid);
  L.audit(req.user.nama, 'Email balasan', status, req.params.no); res.json({ status });
});
app.get('/api/leads/:no/file', auth(), (req, res) => {
  const l = getLead(req, res); if (!l) return;
  const f = db.prepare('select * from attachments where inquiry_id=? order by id limit 1').get(l.iid);
  if (!f) return res.status(404).json({ error: 'Tidak ada dokumen.' });
  L.audit(req.user.nama, 'Dokumen diunduh', f.nama_berkas, req.params.no);
  res.download(path.join(UPLOADS, f.nama_simpan), f.nama_berkas);
});
app.get('/api/export.csv', auth(), (req, res) => {
  const q = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const rows = [['Tiket', 'Masuk', 'Instansi', 'Jenis', 'Kategori', 'Skor', 'Prioritas', 'Tahapan', 'PIC', 'Batas SLA', 'Respons pertama', 'Sumber']].concat(L.leadsFor(req.user).map((l) => [l.no, new Date(l.created).toISOString(), l.instansi, l.jenis, l.kat, l.skor, l.prio, ST[l.stage], l.pic || '', new Date(l.due).toISOString(), l.first ? new Date(l.first).toISOString() : '', l.src]));
  L.audit(req.user.nama, 'Ekspor CSV', rows.length - 1 + ' baris');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="prospek-ibb.csv"');
  res.send('\ufeff' + rows.map((r) => r.map(q).join(',')).join('\r\n'));
});
app.put('/api/config', auth('admin'), (req, res) => {
  const c = req.body.cfg, cur = L.getCfg(), num = (x) => Number.isFinite(+x) && +x >= 0 && +x <= 1000;
  if (!c || !['tgt', 'ang', 'sla'].every((k) => c[k] && Object.keys(cur[k]).every((kk) => num(c[k][kk]))) || !['ketStrongMin', 'ketMin', 'ketShortMin', 'ketPts', 'ketStrongPts', 'ketShortPts', 'katHigh', 'katLow', 'katOther', 'hi', 'mid'].every((k) => num(c[k]))) return res.status(400).json({ error: 'Nilai pengaturan tidak valid.' });
  const next = { ...cur }; for (const k of ['ketStrongMin', 'ketMin', 'ketShortMin', 'ketPts', 'ketStrongPts', 'ketShortPts', 'katHigh', 'katLow', 'katOther', 'hi', 'mid']) next[k] = +c[k];
  for (const g of ['tgt', 'ang', 'sla']) { next[g] = {}; for (const k of Object.keys(cur[g])) next[g][k] = +c[g][k]; }
  L.setCfg(next);
  if (req.body.recalc) L.tx(() => {
    for (const l of L.leadsFor(req.user).filter((x) => x.stage < 4)) {
      const sc = L.scoreOf(l, next);
      db.prepare('update leads set skor=?,prioritas=?,batas_sla=?,rincian_skor=? where id=(select l.id from leads l join inquiries i on i.id=l.inquiry_id where i.nomor_tiket=?)').run(sc.skor, sc.prio, L.addWH(l.created, next.sla[sc.prio]), JSON.stringify(sc.parts), l.no);
    }
  });
  L.audit(req.user.nama, 'Pengaturan diubah', req.body.recalc ? 'Skor dihitung ulang' : 'Disimpan'); res.json({ ok: true });
});
app.post('/api/users', auth('admin'), (req, res) => {
  const nama = str(req.body.nama, 80), email = str(req.body.email, 120).toLowerCase(), peran = str(req.body.peran, 10), pw = String(req.body.password || '');
  if (!nama || !emailOk(email) || !['admin', 'pic', 'manajer'].includes(peran)) return res.status(400).json({ error: 'Data pengguna tidak valid.' });
  if (pw.length < 10) return res.status(400).json({ error: 'Password minimal 10 karakter.' });
  if (db.prepare('select 1 from users where email=?').get(email)) return res.status(409).json({ error: 'Email sudah terdaftar.' });
  db.prepare('insert into users(nama,email,password_hash,peran) values(?,?,?,?)').run(nama, email, bcrypt.hashSync(pw, 10), peran);
  L.audit(req.user.nama, 'Pengguna ditambahkan', `${email} (${peran})`); res.json({ ok: true });
});
app.post('/api/users/:id/toggle', auth('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Anda tidak dapat menonaktifkan akun sendiri.' });
  db.prepare('update users set aktif=1-aktif where id=?').run(id);
  db.prepare('delete from sessions where user_id=?').run(id);
  L.audit(req.user.nama, 'Status pengguna diubah', String(id)); res.json({ ok: true });
});

// ---------- berkas statis ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: PROD ? '1h' : 0 }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Tidak ditemukan.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Terjadi kesalahan pada server.' }); });
setInterval(() => db.prepare('delete from sessions where expires<?').run(Date.now()), 3600e3).unref();

if (require.main === module) app.listen(PORT, () => console.log(`PT Indo Buana Berkah berjalan di http://localhost:${PORT}`));
module.exports = app;
