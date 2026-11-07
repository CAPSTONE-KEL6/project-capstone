'use strict';
const { DatabaseSync } = require('node:sqlite');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'ibb.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
// transaksi sederhana (node:sqlite tidak punya db.transaction)
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

db.exec(`
create table if not exists users(id integer primary key, nama text not null, email text unique not null, password_hash text not null, peran text not null check(peran in ('admin','pic','manajer')), aktif integer not null default 1);
create table if not exists clients(id integer primary key, nama_instansi text unique not null, jenis_instansi text not null);
create table if not exists inquiries(id integer primary key, nomor_tiket text unique not null, client_id integer not null references clients(id), kategori text not null, nama_kontak text not null, email text not null, target_mulai text not null, rentang_anggaran text not null default '', keterangan text not null, jadwal text not null default '', persetujuan integer not null, sumber text not null default 'Formulir web', kode_hash text not null, dibuat_pada integer not null);
create table if not exists attachments(id integer primary key, inquiry_id integer not null references inquiries(id), nama_berkas text not null, nama_simpan text not null, tipe text not null, ukuran_kb integer not null);
create table if not exists leads(id integer primary key, inquiry_id integer unique not null references inquiries(id), pic_id integer references users(id), skor integer not null, prioritas text not null, tahapan integer not null default 0, batas_sla integer not null, respons_pertama integer, rincian_skor text not null);
create table if not exists activities(id integer primary key, lead_id integer not null references leads(id), user_id integer references users(id), oleh text not null, jenis text not null, catatan text not null, pengingat integer, selesai integer not null default 0, dibuat_pada integer not null);
create table if not exists stage_history(id integer primary key, lead_id integer not null references leads(id), dari text not null, ke text not null, oleh text not null, waktu integer not null);
create table if not exists settings(key text primary key, value text not null);
create table if not exists audit_log(id integer primary key, waktu integer not null, pengguna text not null, aksi text not null, rincian text not null default '', tiket text not null default '');
create table if not exists sessions(id text primary key, user_id integer not null references users(id), expires integer not null);
create table if not exists outbox(id integer primary key, waktu integer not null, kepada text not null, subjek text not null, isi text not null, status text not null, tiket text not null default '');
create index if not exists idx_leads_stage on leads(tahapan);
`);

const ST = ['Baru', 'Dikualifikasi', 'Konsultasi', 'Penawaran', 'Selesai'];
const LISTS = {
  jenis: ['BUMN', 'Swasta', 'BUMD'],
  kat: ['Pengembangan Perangkat Lunak', 'Pengadaan Hardware & Software', 'IT Infrastructure', 'Solusi IoT', 'IT Professional Staffing', 'Networking & Security', 'Kartu dan Chip Uang Elektronik', 'Produk Prabayar', 'Lainnya'],
  tgt: ['Dalam 1 bulan', '1 sampai 3 bulan', 'Lebih dari 3 bulan'],
  ang: ['', 'Di bawah Rp100 juta', 'Rp100 juta sampai Rp500 juta', 'Di atas Rp500 juta'],
  jadwal: ['', 'Kamis, 10.00 WIB', 'Kamis, 14.00 WIB', 'Jumat, 09.30 WIB'],
  sumber: ['Formulir web', 'Email', 'WhatsApp', 'Telepon', 'Referral', 'Lainnya'],
};

const CFG0 = {
  version: 2,
  tgt: { 'Dalam 1 bulan': 30, '1 sampai 3 bulan': 20, 'Lebih dari 3 bulan': 10 },
  ang: { 'Di atas Rp500 juta': 25, 'Rp100 juta sampai Rp500 juta': 20, 'Di bawah Rp100 juta': 15, '': 5 },
  ketStrongMin: 120, ketMin: 80, ketShortMin: 40, ketPts: 20, ketStrongPts: 25, ketShortPts: 10,
  katHigh: 20, katLow: 10, katOther: 10, hi: 70, mid: 40,
  sla: { Tinggi: 2, Sedang: 8, Rendah: 16 },
};
function getCfg() {
  const r = db.prepare("select value from settings where key='cfg'").get();
  return r ? { ...CFG0, ...JSON.parse(r.value) } : CFG0;
}
function setCfg(c) {
  db.prepare("insert into settings(key,value) values('cfg',?) on conflict(key) do update set value=excluded.value").run(JSON.stringify(c));
}

// ---------- skor dan SLA (jam kerja Senin-Jumat 09.00-17.00, zona waktu server) ----------
function nextWork(d) {
  d = new Date(d);
  for (;;) {
    const w = d.getDay(), h = d.getHours() + d.getMinutes() / 60;
    if (w > 0 && w < 6 && h >= 9 && h < 17) return d;
    if (w > 0 && w < 6 && h < 9) { d.setHours(9, 0, 0, 0); return d; }
    d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  }
}
function addWH(t, h) {
  let d = nextWork(t);
  while (h > 1e-9) {
    const e = new Date(d); e.setHours(17, 0, 0, 0);
    const av = (e - d) / 36e5;
    if (h <= av) return +d + h * 36e5;
    h -= av; d = nextWork(+e + 1000);
  }
  return +d;
}
function scoreOf(x, cfg) {
  const n = (x.ket || '').trim().length;
  const p = {
    'Urgensi kebutuhan': cfg.tgt[x.tgt] || 0,
    'Kejelasan anggaran': cfg.ang[x.ang || ''] ?? cfg.ang[''],
    'Kelengkapan kebutuhan': n >= cfg.ketStrongMin ? cfg.ketStrongPts : n >= cfg.ketMin ? cfg.ketPts : n >= cfg.ketShortMin ? cfg.ketShortPts : 0,
    'Kesesuaian layanan': /Kartu|Chip|Prabayar/i.test(x.kat) ? cfg.katLow : /Lainnya/i.test(x.kat) ? cfg.katOther : cfg.katHigh,
  };
  const skor = Object.values(p).reduce((a, b) => a + b, 0);
  return { parts: p, skor, prio: skor >= cfg.hi ? 'Tinggi' : skor >= cfg.mid ? 'Sedang' : 'Rendah' };
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function audit(pengguna, aksi, rincian = '', tiket = '') {
  db.prepare('insert into audit_log(waktu,pengguna,aksi,rincian,tiket) values(?,?,?,?,?)').run(Date.now(), pengguna, aksi, String(rincian).slice(0, 300), tiket);
}
function ticketNo(d) {
  const p = 'IBB-' + String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + '-';
  const r = db.prepare('select max(cast(substr(nomor_tiket,-4) as integer)) m from inquiries where nomor_tiket like ?').get(p + '%');
  return p + String((r.m || 0) + 1).padStart(4, '0');
}

// ---------- membuat inquiry + prospek ----------
function createInquiry(d, file, actor, opt = {}) {
  const cfg = getCfg(), at = opt.at || Date.now();
  return tx(() => {
    let c = db.prepare('select id from clients where nama_instansi=?').get(d.instansi);
    if (!c) c = { id: db.prepare('insert into clients(nama_instansi,jenis_instansi) values(?,?)').run(d.instansi, d.jenis).lastInsertRowid };
    const no = ticketNo(new Date(at));
    const kode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const i = db.prepare('insert into inquiries(nomor_tiket,client_id,kategori,nama_kontak,email,target_mulai,rentang_anggaran,keterangan,jadwal,persetujuan,sumber,kode_hash,dibuat_pada) values(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(no, c.id, d.kat, d.nama, d.email, d.tgt, d.ang || '', d.ket, d.jadwal || '', 1, d.sumber || 'Formulir web', sha(kode), at);
    const sc = scoreOf(d, cfg);
    const l = db.prepare('insert into leads(inquiry_id,pic_id,skor,prioritas,tahapan,batas_sla,rincian_skor) values(?,?,?,?,0,?,?)')
      .run(i.lastInsertRowid, opt.picId || null, sc.skor, sc.prio, addWH(at, cfg.sla[sc.prio]), JSON.stringify(sc.parts));
    db.prepare('insert into stage_history(lead_id,dari,ke,oleh,waktu) values(?,?,?,?,?)').run(l.lastInsertRowid, '-', 'Baru', 'Sistem', at);
    if (file) db.prepare('insert into attachments(inquiry_id,nama_berkas,nama_simpan,tipe,ukuran_kb) values(?,?,?,?,?)').run(i.lastInsertRowid, file.nama, file.simpan, file.tipe, Math.ceil(file.ukuran / 1024));
    audit(actor, 'Inquiry masuk', `${d.instansi} (${d.sumber || 'Formulir web'})`, no);
    return { no, kode, leadId: l.lastInsertRowid, skor: sc.skor, prio: sc.prio };
  });
}

// ---------- tampilan prospek ----------
const LEAD_SQL = `select i.nomor_tiket no, i.nama_kontak nama, i.email, c.nama_instansi instansi, c.jenis_instansi jenis, i.kategori kat, i.target_mulai tgt, i.rentang_anggaran ang, i.keterangan ket, i.jadwal, i.sumber src, i.dibuat_pada created,
 l.id lid, l.pic_id picId, u.nama pic, l.skor, l.prioritas prio, l.tahapan stage, l.batas_sla due, l.respons_pertama first, l.rincian_skor parts, i.id iid
 from leads l join inquiries i on i.id=l.inquiry_id join clients c on c.id=i.client_id left join users u on u.id=l.pic_id`;
function enrich(rows) {
  return rows.map((r) => {
    const acts = db.prepare('select id, dibuat_pada t, jenis, catatan cat, oleh by, pengingat rem, selesai done from activities where lead_id=? order by id').all(r.lid)
      .map((a) => ({ ...a, done: !!a.done, rem: a.rem || 0 }));
    const hist = db.prepare('select waktu t, dari, ke, oleh by from stage_history where lead_id=? order by id').all(r.lid);
    const f = db.prepare('select id, nama_berkas from attachments where inquiry_id=? order by id limit 1').get(r.iid);
    const { lid, iid, ...rest } = r;
    return { ...rest, parts: JSON.parse(r.parts), acts, hist, file: f ? f.nama_berkas : '' };
  });
}
function leadsFor(user) {
  const rows = user.peran === 'pic' ? db.prepare(LEAD_SQL + ' where l.pic_id=? order by i.dibuat_pada desc').all(user.id)
    : db.prepare(LEAD_SQL + ' order by i.dibuat_pada desc').all();
  return enrich(rows);
}
function leadByNo(no) {
  const r = db.prepare(LEAD_SQL + ' where i.nomor_tiket=?').get(no);
  return r ? enrich([r])[0] : null;
}
const rawLead = (no) => db.prepare('select l.id lid, l.pic_id, l.tahapan, l.respons_pertama, i.id iid, i.email, i.nama_kontak from leads l join inquiries i on i.id=l.inquiry_id where i.nomor_tiket=?').get(no);

// ---------- email (SMTP bila diatur; selain itu dicatat di outbox) ----------
const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null;
async function sendMail(to, subject, text, tiket = '') {
  let status = 'tersimpan (SMTP belum diatur)';
  if (transporter) {
    try { await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text }); status = 'terkirim'; }
    catch (e) { status = 'gagal: ' + String(e.message).slice(0, 120); }
  }
  db.prepare('insert into outbox(waktu,kepada,subjek,isi,status,tiket) values(?,?,?,?,?,?)').run(Date.now(), to, subject, text, status, tiket);
  return status;
}

module.exports = { db, tx, DATA, ST, LISTS, CFG0, getCfg, setCfg, addWH, scoreOf, sha, audit, createInquiry, leadsFor, leadByNo, rawLead, sendMail, transporter };
