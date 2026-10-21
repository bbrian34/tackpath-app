// Runs TackPath's test suites by workflow area.
//   node tools/ci/run-tests.mjs all            every area, one after another
//   node tools/ci/run-tests.mjs driver-pickup  one area (what each CI check runs)
//   node tools/ci/run-tests.mjs --check        fail if any test file belongs to no area
//   node tools/ci/run-tests.mjs --list         print the area keys as JSON (for the CI matrix)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const AREAS = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/ci/areas.json'), 'utf8'))).filter(([k]) => !k.startsWith('_')));
const filesOf = (a) => [...new Set(a.files.flatMap((g) => fs.globSync(g, { cwd: path.join(ROOT, a.dir) })))].sort();

function check() {
  const owned = new Map();
  for (const [key, a] of Object.entries(AREAS)) for (const f of filesOf(a)) {
    const id = path.join(a.dir, f);
    if (owned.has(id)) { console.error(`${id} is in two areas: ${owned.get(id)} and ${key}`); process.exitCode = 1; }
    owned.set(id, key);
  }
  const all = [...fs.globSync('tests/**/*.test.{js,mjs}', { cwd: ROOT }), ...fs.globSync('operations/tests/*.test.mjs', { cwd: ROOT })]
    .filter((f) => !f.includes('node_modules'));
  const missing = all.filter((f) => !owned.has(f));
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  const notInCi = Object.keys(AREAS).filter((k) => !wf.includes(`area: ${k},`));
  if (notInCi.length) { console.error('Areas missing from the CI matrix in .github/workflows/tests.yml: ' + notInCi.join(', ')); process.exitCode = 1; }
  if (missing.length) { console.error('Test files that no CI area runs (add them to tools/ci/areas.json):\n  ' + missing.join('\n  ')); process.exitCode = 1; }
  else console.log(`All ${all.length} test files belong to an area.`);
}

function run(key) {
  const a = AREAS[key]; if (!a) { console.error(`Unknown area: ${key}`); process.exit(2); }
  const files = filesOf(a); if (!files.length) { console.error(`No test files matched for ${a.name}`); process.exit(1); }
  console.log(`\n=== ${a.name} (${files.length} files) ===`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], { cwd: path.join(ROOT, a.dir), stdio: 'inherit' });
  return r.status === 0;
}

const arg = process.argv[2];
if (arg === '--check') check();
else if (arg === '--list') console.log(JSON.stringify(Object.keys(AREAS)));
else if (!arg || arg === 'all') {
  const failed = Object.keys(AREAS).filter((k) => !run(k));
  if (failed.length) { console.error('\nFailed areas: ' + failed.map((k) => AREAS[k].name).join(', ')); process.exit(1); }
  console.log('\nAll areas passed.');
} else process.exit(run(arg) ? 0 : 1);
