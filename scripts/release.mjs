#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const RELEASE = '5.14.0';
const SCRIPT_ID = '1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g';
const DEPLOYMENT_ID = 'AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA';
const PATCH_BASES = [
  '40_Matching_Profile',
  '50_Operator_Queue',
  '60_Striven_Write',
  '70_Workflow_Automation',
  '95_Public_Runners'
];

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const root = resolve(new URL('..', import.meta.url).pathname);
const work = resolve(root, '.release-v5.14.0');
const live = resolve(work, 'live');
const before = resolve(work, 'before');
const verify = resolve(work, 'verify');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, commandArgs, options = {}) {
  const cwd = options.cwd || root;
  console.log('> ' + command + ' ' + commandArgs.join(' '));
  const r = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: options.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit'
  });
  if (options.capture) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
  return r;
}

function clasp(commandArgs, options = {}) {
  return run(npx, ['-y', '@google/clasp@3.3.0', ...commandArgs], options);
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function files(dir) {
  return readdirSync(dir)
    .filter(name => name !== '.clasp.json')
    .filter(name => statSync(resolve(dir, name)).isFile())
    .sort();
}

function logicalName(name) {
  return /\.(?:js|gs)$/.test(name) ? name.replace(/\.(?:js|gs)$/, '') : name;
}

function inventory(dir) {
  const out = new Map();
  for (const name of files(dir)) out.set(logicalName(name), { name, sha: sha(resolve(dir, name)) });
  return out;
}

function findLiveTarget(base, dir = live) {
  const matches = readdirSync(dir).filter(name => name === base + '.js' || name === base + '.gs');
  if (matches.length !== 1) {
    throw new Error('Expected exactly one live target for ' + base + '; found ' + matches.length + ': ' + matches.join(', '));
  }
  return resolve(dir, matches[0]);
}

function normalizedText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function requireMarker(path, marker) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(marker)) throw new Error('Missing release marker ' + marker + ' in ' + basename(path));
}

console.log('======================================================================');
console.log(' CF ServiceOps v5.14.0 — CANONICAL END-TO-END PRODUCTION RELEASE');
console.log('======================================================================');
console.log('Script ID:      ' + SCRIPT_ID);
console.log('Deployment ID:  ' + DEPLOYMENT_ID);
console.log('Patch modules:  ' + PATCH_BASES.join(', '));

if (!execute) {
  console.log('');
  console.log('DRY RUN ONLY — no Apps Script write will occur.');
  console.log('Run: node scripts/release.mjs --execute');
  process.exit(0);
}

for (const base of PATCH_BASES) {
  const src = resolve(root, 'src', base + '.gs');
  if (!existsSync(src)) throw new Error('Missing canonical source file: ' + src);
}

requireMarker(resolve(root, 'src', '70_Workflow_Automation.gs'), 'CF_SERVICEOPS_V5_14_0_CANONICAL_AUTOMATION_OVERWRITE_R1');
requireMarker(resolve(root, 'src', '95_Public_Runners.gs'), 'CF_SERVICEOPS_V5_14_0_CANONICAL_PUBLIC_ENTRYPOINTS_R1');
requireMarker(resolve(root, 'src', '60_Striven_Write.gs'), 'CF_SERVICEOPS_V5_13_9_TARGETED_POST_CUSTOMER_LOCATION_RECONCILIATION_R1');

console.log('\n=== 1/10 Authenticate ===');
clasp(['show-authorized-user', '--json']);

console.log('\n=== 2/10 Pull exact current live project ===');
rmSync(work, { recursive: true, force: true });
mkdirSync(live, { recursive: true });
mkdirSync(verify, { recursive: true });
writeFileSync(resolve(live, '.clasp.json'), JSON.stringify({ scriptId: SCRIPT_ID, rootDir: '.' }, null, 2) + '\n');
clasp(['pull'], { cwd: live });
if (!existsSync(resolve(live, 'appsscript.json'))) throw new Error('Live pull did not contain appsscript.json.');

console.log('\n=== 3/10 Create live checkpoint ===');
cpSync(live, before, { recursive: true });
const beforeInv = inventory(before);
writeFileSync(
  resolve(work, 'before.sha256.json'),
  JSON.stringify(Object.fromEntries([...beforeInv].map(([k, v]) => [k, v])), null, 2) + '\n'
);
console.log('Checkpoint: ' + before);

console.log('\n=== 4/10 Patch only canonical modules ===');
for (const base of PATCH_BASES) {
  const src = resolve(root, 'src', base + '.gs');
  const target = findLiveTarget(base);
  cpSync(src, target);
  console.log(base + ' -> ' + basename(target));
}

console.log('\n=== 5/10 Verify file inventory and patch scope ===');
const afterInv = inventory(live);
const beforeKeys = [...beforeInv.keys()].sort();
const afterKeys = [...afterInv.keys()].sort();
if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
  throw new Error('Live file inventory changed. Refusing push.');
}
const changed = beforeKeys.filter(k => beforeInv.get(k).sha !== afterInv.get(k).sha).sort();
const expected = [...PATCH_BASES].sort();
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error('Unexpected patch scope. Changed=' + changed.join(', ') + ' Expected=' + expected.join(', '));
}
console.log('PATCH_SCOPE_PASS: ' + changed.join(', '));

console.log('\n=== 6/10 Syntax + release marker checks ===');
for (const base of PATCH_BASES) run(process.execPath, ['--check', findLiveTarget(base)]);
requireMarker(findLiveTarget('70_Workflow_Automation'), 'CF_SERVICEOPS_V5_14_0_CANONICAL_AUTOMATION_OVERWRITE_R1');
requireMarker(findLiveTarget('95_Public_Runners'), 'CF_SERVICEOPS_V5_14_0_CANONICAL_PUBLIC_ENTRYPOINTS_R1');
requireMarker(findLiveTarget('60_Striven_Write'), 'CF_SERVICEOPS_V5_13_9_REQUEST_ID_INTEGRITY_FALSE_PARK_RECOVERY_R1');
if (readFileSync(findLiveTarget('60_Striven_Write'), 'utf8').includes("LocationName: clean_(record['Street']")) {
  throw new Error('Legacy street-based PrimaryLocation.LocationName still exists.');
}
console.log('SELF_TEST_PASS');

console.log('\n=== 7/10 Push complete project to SAME Script ID ===');
clasp(['status'], { cwd: live });
clasp(['push', '--force'], { cwd: live });

console.log('\n=== 8/10 Pull remote source and verify canonical modules ===');
writeFileSync(resolve(verify, '.clasp.json'), JSON.stringify({ scriptId: SCRIPT_ID, rootDir: '.' }, null, 2) + '\n');
clasp(['pull'], { cwd: verify });
for (const base of PATCH_BASES) {
  const src = resolve(root, 'src', base + '.gs');
  const remote = findLiveTarget(base, verify);
  if (normalizedText(src) !== normalizedText(remote)) throw new Error('REMOTE_CONTENT_MISMATCH: ' + base);
  console.log('REMOTE_CONTENT_PASS: ' + base);
}

console.log('\n=== 9/10 Create immutable version and redeploy existing /exec ===');
const description = 'CF ServiceOps v5.14.0 canonical end-to-end automation';
const versionResult = clasp(['version', description], { cwd: live, capture: true });
const versionText = String(versionResult.stdout || '') + '\n' + String(versionResult.stderr || '');
const match = versionText.match(/version\s+(\d+)/i);
if (!match) throw new Error('Could not parse Apps Script version number.');
const versionNumber = match[1];
clasp(['redeploy', DEPLOYMENT_ID, versionNumber, description], { cwd: live });
clasp(['deployments'], { cwd: live });

console.log('\n=== 10/10 Final report ===');
writeFileSync(resolve(work, 'deployed-version.txt'), versionNumber + '\n');
console.log('DEPLOY_VERIFY_PASS');
console.log('Release:          v' + RELEASE);
console.log('Apps Script ver:  ' + versionNumber);
console.log('Checkpoint:       ' + before);
console.log('Remote verify:    ' + verify);
console.log('Canonical worker: AUTO_FINAL_ServiceOps');
console.log('Watchdog:         AUTO_98_E2E_Recovery_Watchdog');
console.log('');
console.log('The next existing automation/watchdog execution will migrate legacy phase triggers');
console.log('to the canonical worker and continue the durable request queue.');
