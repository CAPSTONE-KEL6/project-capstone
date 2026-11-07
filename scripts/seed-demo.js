'use strict';
// Mengisi data contoh agar dashboard terlihat hidup. JANGAN dijalankan pada data produksi.
const bcrypt = require('bcryptjs'), crypto = require('crypto');
const { db, createInquiry, ST, addWH, getCfg } = require('../lib');
if (db.prepare('select count(*) c from inquiries').get().c > 0) { console.error('Basis data sudah berisi inquiry. Hentikan.'); process.exit(1); }
const pw = () => crypto.randomBytes(8).toString('base64url');
if (!db.prepare("select 1 from users where peran='admin'").get()) {
  const e = process.env.ADMIN_EMAIL || 'admin@indobuanaberkah.local', p = process.env.ADMIN_PASSWORD || pw();
  db.prepare('insert into users(nama,email,password_hash,peran) values(?,?,?,?)').run('Administrator', e, bcrypt.hashSync(p, 10), 'admin');
  console.log(`Admin: ${e} / ${p}`);
}
const pics = [['Rina', 'rina@contoh.local'], ['Dimas', 'dimas@contoh.local']].map(([n, e]) => {
  const p = pw(); const r = db.prepare('insert into users(nama,email,password_hash,peran) values(?,?,?,?)').run(n, e, bcrypt.hashSync(p, 10), 'pic');
  console.log(`PIC ${n}: ${e} / ${p}`); return { id: r.lastInsertRowid, n };
});
const mp = pw(); db.prepare('insert into users(nama,email,password_hash,peran) values(?,?,?,?)').run('Manajer', 'manajer@contoh.local', bcrypt.hashSync(mp, 10), 'manajer'); console.log(`Manajer: manajer@contoh.local / ${mp}`);
const DAY = 864e5, HR = 36e5, now = Date.now(), LONG = 'Kebutuhan sistem terintegrasi untuk kantor pusat dan seluruh cabang dengan target implementasi yang jelas dan jadwal bertahap, termasuk pelatihan pengguna dan dukungan setelah serah terima.';
const R = [['PT Pupuk Contoh', 'BUMN', 'Pengembangan Perangkat Lunak', 'Dalam 1 bulan', 'Di atas Rp500 juta', 1, 3, 3, 0, 'Email'], ['PT Kartu Nusantara', 'Swasta', 'Kartu dan Chip Uang Elektronik', '1 sampai 3 bulan', 'Di atas Rp500 juta', 1, 9, 4, 1, 'WhatsApp'], ['BUMN Energi Contoh', 'BUMN', 'IT Professional Staffing', 'Dalam 1 bulan', 'Di atas Rp500 juta', 1, 14, 4, 0, 'Email'], ['PT Retail Contoh', 'Swasta', 'Pengadaan Hardware & Software', '1 sampai 3 bulan', 'Rp100 juta sampai Rp500 juta', 1, 16, 2, 1, 'Formulir web'], ['BUMD Air Contoh', 'BUMD', 'Solusi IoT', '1 sampai 3 bulan', '', 1, 21, 4, 0, 'Telepon'], ['PT Manufaktur Contoh', 'Swasta', 'Networking & Security', '1 sampai 3 bulan', 'Rp100 juta sampai Rp500 juta', 1, 37, 3, 0, 'Referral'], ['BUMD Energi Contoh', 'BUMD', 'IT Infrastructure', 'Lebih dari 3 bulan', 'Di bawah Rp100 juta', 0, 44, 4, 0, 'Email'], ['PT Distribusi Contoh', 'Swasta', 'Produk Prabayar', '1 sampai 3 bulan', 'Di bawah Rp100 juta', 0, 52, 4, 1, 'WhatsApp'], ['BUMN Perbankan Contoh', 'BUMN', 'Pengembangan Perangkat Lunak', 'Dalam 1 bulan', 'Di atas Rp500 juta', 1, 0.3, 0, null, 'Formulir web'], ['PT Properti Contoh', 'Swasta', 'Solusi IoT', '1 sampai 3 bulan', '', 0, 1.2, 0, null, 'WhatsApp']];
R.forEach((r, i) => {
  const at = now - r[6] * DAY - (i % 4) * HR, pic = r[8] === null ? null : pics[r[8]];
  const x = createInquiry({ nama: 'Narahubung ' + (i + 1), email: `kontak${i + 1}@contoh.co.id`, instansi: r[0], jenis: r[1], kat: r[2], tgt: r[3], ang: r[4], ket: r[5] ? LONG : 'Kebutuhan singkat.', sumber: r[9] }, null, 'Seed', { at, picId: pic && pic.id });
  if (!pic) return;
  const first = at + (1 + (i * 7) % 9) * HR * .9; db.prepare('update leads set respons_pertama=? where id=?').run(first, x.leadId);
  db.prepare('insert into activities(lead_id,user_id,oleh,jenis,catatan,pengingat,dibuat_pada) values(?,?,?,?,?,?,?)').run(x.leadId, pic.id, pic.n, 'Email', 'Menghubungi calon klien dan mengirim ringkasan layanan.', i % 3 === 0 && r[7] < 4 ? now + (i % 2 ? -1 : 1) * DAY * .5 : null, first);
  let t = at, cur = 0;
  for (let k = 1; k <= r[7]; k++) { t = Math.min(now - HR, t + (1 + (i + k) % 3) * DAY * .7); db.prepare('insert into stage_history(lead_id,dari,ke,oleh,waktu) values(?,?,?,?,?)').run(x.leadId, ST[cur], ST[k], pic.n, t); cur = k; }
  db.prepare('update leads set tahapan=? where id=?').run(cur, x.leadId);
});
console.log('Data contoh dimuat (' + R.length + ' prospek).');
