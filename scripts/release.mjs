#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const RELEASE = '5.14.4';
const SCRIPT_ID = '1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g';
const DEPLOYMENT_ID = 'AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA';
const PATCH_BASES = [
  '20_Intake_Processing',
  '40_Matching_Profile',
  '50_Operator_Queue',
  '60_Striven_Write',
  '70_Workflow_Automation',
  '95_Public_Runners',
  '99_Production_Hardening'
];
const OBSOLETE_V2_BASES = [
  'CF_ServiceOps_V2_Shadow_Resolver',
  'CF_ServiceOps_V2_Core_Ensurers',
  'CF_ServiceOps_V2_Orchestrator',
  'CF_ServiceOps_V2_Migration',
  'CF_ServiceOps_V2_Worker_Bridge',
  'CF_ServiceOps_V2_Sheet_Runners',
  'V2_Installer'
];
const FORBIDDEN_V2_SOURCE_MARKERS = [
  'CF_SERVICEOPS_V2_',
  'CF.V2',
  'V2_addMenu',
  'INSTALL_V2_SHADOW_AND_TEST',
  'PATCH_V2_LIVE_FINDINGS_',
  'PATCH_V2_SELECTED_CANARY_SAFETY_'
];
const FORBIDDEN_AUTOMATION_NAMES = [
  'CF.AutoCustomerStructure',
  'AUTO_processCustomerStructure',
  'AUTO_00_E2E_Route_Request',
  'AUTO_01_E2E_Customer_Match_Create',
  'AUTO_02_E2E_Location_Reconcile',
  'AUTO_03_E2E_Contact_Create_Recover',
  'AUTO_04_E2E_Customer_Contact_Info_Sync',
  'AUTO_05_E2E_Sales_Order_Create_Verify',
  'AUTO_99_E2E_Safe_Stop_Review',
  'AUTO_E2E_runPhase_',
  'AUTO_98_E2E_Recovery_Watchdog_BASE_V5115_R1_',
  '__CFH_BASE_WORKER',
  'CFH_patchEventDrivenWorker_'
];

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const root = resolve(new URL('..', import.meta.url).pathname);
const work = resolve(root, '.release-v5.14.4');
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
function clasp(args, options = {}) {
  return run(npx, ['-y', '@google/clasp@3.3.0', ...args], options);
}
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function files(dir) {
  return readdirSync(dir)
    .filter(name => name !== '.clasp.json')
    .filter(name => statSync(resolve(dir, name)).isFile())
    .sort();
}
function logicalName(name) { return /\.(?:js|gs)$/.test(name) ? name.replace(/\.(?:js|gs)$/, '') : name; }
function inventory(dir) {
  const out = new Map();
  for (const name of files(dir)) out.set(logicalName(name), { name, sha: sha(resolve(dir, name)) });
  return out;
}
function findTarget(base, dir) {
  const matches = readdirSync(dir).filter(name => name === base + '.js' || name === base + '.gs');
  if (matches.length !== 1) throw new Error('Expected exactly one target for ' + base + '; found ' + matches.length);
  return resolve(dir, matches[0]);
}
function normalizedText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n';
}
function requireMarker(path, marker) {
  if (!readFileSync(path, 'utf8').includes(marker)) throw new Error('Missing marker ' + marker + ' in ' + basename(path));
}
function normalizeReleaseMetadataText(text) {
  return String(text)
    .replace(/(\*\s*Version:\s*)\d+\.\d+\.\d+/g, '$1' + RELEASE)
    .replace(/(\bvar\s+VERSION\s*=\s*['"])\d+\.\d+\.\d+(['"]\s*;?)/g, '$1' + RELEASE + '$2')
    .replace(/(\bVERSION:\s*['"])\d+\.\d+\.\d+(['"])/g, '$1' + RELEASE + '$2')
    .replace(/(\bvar\s+CFH_VERSION\s*=\s*['"])\d+\.\d+\.\d+(['"]\s*;?)/g, '$1' + RELEASE + '$2')
    .replace(/(\bversion\s*:\s*['"])\d+\.\d+\.\d+(['"])/g, '$1' + RELEASE + '$2')
    .replace(/(Final ServiceOps v)\d+\.\d+\.\d+/g, '$1' + RELEASE)
    .replace(/(Activate final ServiceOps v)\d+\.\d+\.\d+/g, '$1' + RELEASE);
}
function normalizeLiveVersionMetadata(dir) {
  const touched = [];
  for (const name of files(dir)) {
    if (!/\.(?:js|gs)$/.test(name)) continue;
    const path = resolve(dir, name);
    const beforeText = readFileSync(path, 'utf8');
    const afterText = normalizeReleaseMetadataText(beforeText);
    if (afterText === beforeText) continue;
    writeFileSync(path, afterText);
    touched.push(logicalName(name));
    console.log('NORMALIZE VERSION -> ' + name + ' => ' + RELEASE);
  }
  return touched.sort();
}
function assertUniformReleaseMetadata(dir) {
  const findings = [];
  for (const name of files(dir)) {
    if (!/\.(?:js|gs)$/.test(name)) continue;
    const path = resolve(dir, name);
    const text = readFileSync(path, 'utf8');
    if (normalizeReleaseMetadataText(text) !== text) findings.push(name);
  }
  if (findings.length) throw new Error('VERSION_METADATA_MISMATCH: ' + findings.join(', '));
  console.log('VERSION_METADATA_UNIFORM_PASS: ' + RELEASE);
}
function assertNoLegacyAutomation(dir) {
  const findings = [];
  for (const name of files(dir)) {
    if (!/\.(?:js|gs)$/.test(name)) continue;
    const text = readFileSync(resolve(dir, name), 'utf8');
    for (const legacy of FORBIDDEN_AUTOMATION_NAMES) {
      if (text.includes(legacy)) findings.push(name + ': ' + legacy);
    }
  }
  if (findings.length) throw new Error('LEGACY_AUTOMATION_SOURCE_FOUND\n' + findings.join('\n'));
  console.log('LEGACY_AUTOMATION_SOURCE_ABSENT');
}
function assertNoV2GenerationSource(dir) {
  const findings = [];
  for (const name of files(dir)) {
    if (!/\.(?:js|gs)$/.test(name)) continue;
    const text = readFileSync(resolve(dir, name), 'utf8');
    for (const marker of FORBIDDEN_V2_SOURCE_MARKERS) {
      if (text.includes(marker)) findings.push(name + ': ' + marker);
    }
  }
  if (findings.length) throw new Error('V2_GENERATION_SOURCE_FOUND\n' + findings.join('\n'));
  console.log('V2_GENERATION_SOURCE_ABSENT');
}

console.log('======================================================================');
console.log(' CF ServiceOps v5.14.4 — SINGLE AUTOMATION MODEL PRODUCTION RELEASE');
console.log('======================================================================');
console.log('Script ID:      ' + SCRIPT_ID);
console.log('Deployment ID:  ' + DEPLOYMENT_ID);
console.log('Patch modules:  ' + PATCH_BASES.join(', '));

if (!execute) {
  console.log('\nDRY RUN ONLY — no Apps Script write will occur.');
  console.log('Run: node scripts/release.mjs --execute');
  process.exit(0);
}

for (const base of PATCH_BASES) {
  const src = resolve(root, 'src', base + '.gs');
  if (!existsSync(src)) throw new Error('Missing canonical source: ' + src);
}
requireMarker(resolve(root, 'src', '20_Intake_Processing.gs'), 'CF_SERVICEOPS_V5_14_1_CANONICAL_INTAKE_R1');
requireMarker(resolve(root, 'src', '70_Workflow_Automation.gs'), 'CF_SERVICEOPS_V5_14_1_SINGLE_AUTOMATION_MODEL_R1');
requireMarker(resolve(root, 'src', '95_Public_Runners.gs'), 'CF_SERVICEOPS_V5_14_1_SINGLE_PUBLIC_AUTOMATION_R1');
requireMarker(resolve(root, 'src', '99_Production_Hardening.gs'), 'Version: 5.14.4');
assertNoLegacyAutomation(resolve(root, 'src'));
assertNoV2GenerationSource(resolve(root, 'src'));

console.log('\n=== 1/10 Authenticate ===');
clasp(['show-authorized-user', '--json']);

console.log('\n=== 2/10 Pull exact live project ===');
rmSync(work, { recursive: true, force: true });
mkdirSync(live, { recursive: true });
mkdirSync(verify, { recursive: true });
writeFileSync(resolve(live, '.clasp.json'), JSON.stringify({scriptId: SCRIPT_ID, rootDir: '.'}, null, 2) + '\n');
clasp(['pull'], {cwd: live});
if (!existsSync(resolve(live, 'appsscript.json'))) throw new Error('Live pull did not contain appsscript.json.');

console.log('\n=== 3/10 Checkpoint complete live project ===');
cpSync(live, before, {recursive: true});
const beforeInv = inventory(before);
writeFileSync(resolve(work, 'before.sha256.json'), JSON.stringify(Object.fromEntries(beforeInv), null, 2) + '\n');
console.log('Checkpoint: ' + before);

console.log('\n=== 4/10 Replace finalized modules + normalize live version metadata + remove obsolete V2 shadow generation ===');
for (const base of PATCH_BASES) {
  const src = resolve(root, 'src', base + '.gs');
  const target = findTarget(base, live);
  cpSync(src, target);
  console.log(base + ' -> ' + basename(target));
}
const normalizedVersionBases = normalizeLiveVersionMetadata(live);
const removedV2 = [];
for (const base of OBSOLETE_V2_BASES) {
  const entry = beforeInv.get(base);
  if (!entry) continue;
  rmSync(resolve(live, entry.name), { force: true });
  removedV2.push(base);
  console.log('REMOVE obsolete V2 -> ' + entry.name);
}
removedV2.sort();

console.log('\n=== 5/10 Verify patch scope + approved V2 cleanup ===');
const afterInv = inventory(live);
const beforeKeys = [...beforeInv.keys()].sort();
const afterKeys = [...afterInv.keys()].sort();
const expectedRemoved = beforeKeys.filter(k => OBSOLETE_V2_BASES.includes(k)).sort();
if (JSON.stringify(removedV2) !== JSON.stringify(expectedRemoved)) {
  throw new Error('Unexpected V2 removal scope. Removed=' + removedV2.join(', ') + ' Expected=' + expectedRemoved.join(', '));
}
const expectedAfterKeys = beforeKeys.filter(k => !OBSOLETE_V2_BASES.includes(k)).sort();
if (JSON.stringify(afterKeys) !== JSON.stringify(expectedAfterKeys)) {
  throw new Error('Live file inventory changed outside approved V2 cleanup; refusing push.');
}
const changed = expectedAfterKeys.filter(k => beforeInv.get(k).sha !== afterInv.get(k).sha).sort();
const unexpectedChanged = changed.filter(k => !PATCH_BASES.includes(k) && !normalizedVersionBases.includes(k));
if (unexpectedChanged.length) {
  throw new Error('Unexpected patch scope outside finalized modules/version normalization: ' + unexpectedChanged.join(', '));
}
for (const base of normalizedVersionBases.filter(k => !PATCH_BASES.includes(k))) {
  const beforeEntry = beforeInv.get(base);
  if (!beforeEntry) throw new Error('VERSION_NORMALIZATION_SOURCE_MISSING: ' + base);
  const expected = normalizeReleaseMetadataText(normalizedText(resolve(before, beforeEntry.name)));
  const actual = normalizedText(findTarget(base, live));
  if (expected !== actual) throw new Error('VERSION_NORMALIZATION_SCOPE_FAILED: ' + base);
}
for (const base of PATCH_BASES) {
  const expectedPath = resolve(root, 'src', base + '.gs');
  const livePath = findTarget(base, live);
  if (normalizedText(expectedPath) !== normalizedText(livePath)) {
    throw new Error('CANONICAL_MODULE_PARITY_FAILED: ' + base);
  }
}
console.log('PATCH_SCOPE_PASS: ' + (changed.length ? changed.join(', ') : 'none; live modules already canonical'));
console.log('CANONICAL_MODULE_PARITY_PASS: ' + PATCH_BASES.join(', '));
console.log('OBSOLETE_V2_REMOVAL_PASS: ' + (removedV2.length ? removedV2.join(', ') : 'none present'));

console.log('\n=== 6/10 Syntax + single-model checks ===');
for (const base of PATCH_BASES) run(process.execPath, ['--check', findTarget(base, live)]);
requireMarker(findTarget('20_Intake_Processing', live), 'CF_SERVICEOPS_V5_14_1_CANONICAL_INTAKE_R1');
requireMarker(findTarget('70_Workflow_Automation', live), 'CF_SERVICEOPS_V5_14_1_SINGLE_AUTOMATION_MODEL_R1');
requireMarker(findTarget('95_Public_Runners', live), 'CF_SERVICEOPS_V5_14_1_SINGLE_PUBLIC_AUTOMATION_R1');
requireMarker(findTarget('99_Production_Hardening', live), 'Version: 5.14.4');
assertNoLegacyAutomation(live);
assertNoV2GenerationSource(live);
assertUniformReleaseMetadata(live);
console.log('SELF_TEST_PASS');

console.log('\n=== 7/10 Push complete project to SAME Script ID ===');
clasp(['status'], {cwd: live});
clasp(['push', '--force'], {cwd: live});

console.log('\n=== 8/10 Pull remote source and verify exact parity ===');
writeFileSync(resolve(verify, '.clasp.json'), JSON.stringify({scriptId: SCRIPT_ID, rootDir: '.'}, null, 2) + '\n');
clasp(['pull'], {cwd: verify});
for (const base of PATCH_BASES) {
  const expectedPath = resolve(root, 'src', base + '.gs');
  const remotePath = findTarget(base, verify);
  if (normalizedText(expectedPath) !== normalizedText(remotePath)) throw new Error('REMOTE_CONTENT_MISMATCH: ' + base);
  console.log('REMOTE_CONTENT_PASS: ' + base);
}
for (const base of normalizedVersionBases) {
  const livePath = findTarget(base, live);
  const remotePath = findTarget(base, verify);
  if (normalizedText(livePath) !== normalizedText(remotePath)) throw new Error('REMOTE_VERSION_METADATA_MISMATCH: ' + base);
}
assertUniformReleaseMetadata(verify);
const remoteInv = inventory(verify);
const remoteObsoleteV2 = OBSOLETE_V2_BASES.filter(base => remoteInv.has(base));
if (remoteObsoleteV2.length) {
  throw new Error('REMOTE_OBSOLETE_V2_SOURCE_FOUND: ' + remoteObsoleteV2.join(', '));
}
console.log('REMOTE_OBSOLETE_V2_SOURCE_ABSENT');
assertNoLegacyAutomation(verify);
assertNoV2GenerationSource(verify);

console.log('\n=== 9/10 Version and redeploy existing /exec ===');
const description = 'CF ServiceOps v5.14.4 single automation model';
const versionResult = clasp(['version', description], {cwd: live, capture: true});
const versionText = String(versionResult.stdout || '') + '\n' + String(versionResult.stderr || '');
const match = versionText.match(/version\s+(\d+)/i);
if (!match) throw new Error('Could not parse Apps Script version.');
const versionNumber = match[1];
const redeployResult = clasp([
  'redeploy',
  DEPLOYMENT_ID,
  '--versionNumber',
  versionNumber,
  '--description',
  description,
  '--json'
], {cwd: live, capture: true});
const redeployText = String(redeployResult.stdout || '').trim();
let redeployJson = null;
try { redeployJson = JSON.parse(redeployText); } catch (ignoredRedeployJson) {}
if (!redeployJson ||
    String(redeployJson.deploymentId || '') !== DEPLOYMENT_ID ||
    String(redeployJson.versionNumber || '') !== String(versionNumber)) {
  throw new Error('REDEPLOY_VERIFY_FAILED: ' + redeployText);
}
const deploymentsResult = clasp(['deployments'], {cwd: live, capture: true});
const deploymentsText = String(deploymentsResult.stdout || '') + '\n' + String(deploymentsResult.stderr || '');
if (!deploymentsText.includes(DEPLOYMENT_ID + ' @' + versionNumber)) {
  throw new Error('DEPLOYMENT_PIN_VERIFY_FAILED: expected ' + DEPLOYMENT_ID + ' @' + versionNumber);
}
console.log('DEPLOYMENT_PIN_PASS: ' + DEPLOYMENT_ID + ' @' + versionNumber);
writeFileSync(resolve(work, 'deployed-version.txt'), versionNumber + '\n');

console.log('\n=== 10/10 Final source report ===');
console.log('DEPLOY_SOURCE_VERIFY_PASS');
console.log('Release:          v' + RELEASE);
console.log('Apps Script ver:  ' + versionNumber);
console.log('Canonical worker: AUTO_FINAL_ServiceOps');
console.log('Watchdog:         AUTO_98_E2E_Recovery_Watchdog');
console.log('Legacy source:    ABSENT');
console.log('Obsolete V2:      ABSENT');
console.log('');
console.log('The existing watchdog trigger uses the same public watchdog function name.');
console.log('On its next run it will normalize the trigger topology, recover the recent queue,');
console.log('and schedule AUTO_FINAL_ServiceOps. Verify with FINALIZE_20260930_verifySingleServiceOpsModel().');
