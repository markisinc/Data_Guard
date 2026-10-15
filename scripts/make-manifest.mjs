// Writes dist/manifest.xml for the hosted add-in: same as manifest.xml (the localhost dev one),
// but pointing at SITE_URL and with its own add-in ID, so the dev and hosted versions can be installed side by side.
//
//   SITE_URL=https://you.github.io/dataguard node scripts/make-manifest.mjs
//
// In GitHub Actions SITE_URL is filled in automatically from the repo name (see .github/workflows/pages.yml).
import fs from 'node:fs';

const site = (process.env.SITE_URL || process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(site)) {
  console.error('Set SITE_URL to the https address the add-in is served from, e.g. https://you.github.io/dataguard');
  process.exit(1);
}
const origin = new URL(site).origin;
const PROD_ID = '082d9b6c-5561-488a-8efd-749272d4c25e';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = `${pkg.version.split('-')[0]}.0`.split('.').slice(0, 4).join('.');

let xml = fs.readFileSync('manifest.xml', 'utf8');
xml = xml
  .replace(/<Id>[^<]+<\/Id>/, `<Id>${PROD_ID}</Id>`)
  .replace(/<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`)
  .replace(/<AppDomain>https:\/\/localhost:3000<\/AppDomain>/, `<AppDomain>${origin}</AppDomain>`)
  .replaceAll('https://localhost:3000', site);
if (xml.includes('localhost')) {
  console.error('manifest still mentions localhost: check manifest.xml');
  process.exit(1);
}
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/manifest.xml', xml);
console.log(`dist/manifest.xml -> ${site} (v${version})`);
