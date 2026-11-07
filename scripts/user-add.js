'use strict';
// Pemakaian: npm run user:add -- "Nama" email@contoh.com pic|manajer|admin "password-minimal-10"
const bcrypt = require('bcryptjs');
const { db, audit } = require('../lib');
const [nama, email, peran, pw] = process.argv.slice(2);
if (!nama || !email || !['admin', 'pic', 'manajer'].includes(peran) || !pw || pw.length < 10) {
  console.error('Pemakaian: npm run user:add -- "Nama" email peran(admin|pic|manajer) password(min 10 karakter)'); process.exit(1);
}
db.prepare('insert into users(nama,email,password_hash,peran) values(?,?,?,?)').run(nama, email.toLowerCase(), bcrypt.hashSync(pw, 10), peran);
audit('CLI', 'Pengguna ditambahkan', `${email} (${peran})`);
console.log('Pengguna ditambahkan:', email);
