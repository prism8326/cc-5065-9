/* 无 root 提取 Chromium headless 运行库：node test/fetch-libs.js */
const fs = require('fs');
const { execSync } = require('child_process');

const idx = fs.readFileSync('/tmp/Packages', 'utf8');
const want = process.argv.slice(2);
const stanzas = idx.split('\n\n');
const meta = {};
for (const st of stanzas) {
  const m = /^Package: (.+)$/m.exec(st);
  const f = /^Filename: (.+)$/m.exec(st);
  if (m && f && want.includes(m[1]) && !meta[m[1]]) meta[m[1]] = f[1];
}
const dir = '/workspace/.uitest/debs';
fs.mkdirSync(dir, { recursive: true });
(async () => {
  for (const name of want) {
    const file = meta[name];
    if (!file) { console.error('NOT IN INDEX:', name); continue; }
    const url = 'http://deb.debian.org/debian/' + file;
    const out = dir + '/' + file.split('/').pop();
    if (!fs.existsSync(out)) {
      process.stdout.write('download ' + name + ' ... ');
      const res = await fetch(url);
      if (!res.ok) throw new Error(url + ' -> ' + res.status);
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      console.log('ok');
    }
    execSync('dpkg-deb -x "' + out + '" /workspace/.uitest/sysroot');
  }
  console.log('done');
})();
