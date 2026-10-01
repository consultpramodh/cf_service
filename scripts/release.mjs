#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const configPath = resolve(root, 'release.config.json');
if (!existsSync(configPath)) throw new Error('Missing release.config.json.');
const CONFIG = JSON.parse(readFileSync(configPath, 'utf8'));

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const selfTestOnly = args.includes('--self-test');
const description = readArgValue('--description') || `${CONFIG.projectName} v${CONFIG.releaseVersion}`;
const requestedModules = readRepeatedArg('--module');
const patchModules = requestedModules.length
  ? requestedModules
  : [...CONFIG.defaultPatchModules];

const sourceDir = resolve(root, CONFIG.sourceDir || 'src');
const workRoot = resolve(root, '.release-work');
const live = resolve(workRoot, 'live');
const verify = resolve(workRoot, 'verify');
const rollbackVerify = resolve(workRoot, 'rollback-verify');
const checkpointRoot = resolve(root, '.release-checkpoints');
const checkpointId = `${timestampForPath()}-v${CONFIG.releaseVersion}`;
const checkpoint = resolve(checkpointRoot, checkpointId);
const before = resolve(checkpoint, 'before');
const reportPath = resolve(checkpoint, 'release-report.json');
const localClasp = resolve(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'clasp.cmd' : 'clasp'
);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const report = {
  project: CONFIG.projectName,
  releaseVersion: CONFIG.releaseVersion,
  description,
  checkpointId,
  startedAt: new Date().toISOString(),
  scriptId: CONFIG.scriptId,
  deploymentId: CONFIG.deploymentId,
  patchModules,
  status: 'STARTED',
  steps: []
};
let pushedRemoteHead = false;
let deploymentUpdated = false;

function readArgValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  if (index + 1 >= args.length || String(args[index + 1]).startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return String(args[index + 1]);
}

function readRepeatedArg(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    if (i + 1 >= args.length || String(args[i + 1]).startsWith('--')) {
      throw new Error(`${name} requires a value.`);
    }
    values.push(String(args[i + 1]));
  }
  return [...new Set(values)];
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function step(name, data = {}) {
  report.steps.push({ name, at: new Date().toISOString(), ...data });
}

function saveReport(extra = {}) {
  Object.assign(report, extra);
  mkdirSync(checkpoint, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

function run(command, commandArgs, options = {}) {
  const cwd = options.cwd || root;
  console.log('> ' + command + ' ' + commandArgs.join(' '));
  const useInput = Object.prototype.hasOwnProperty.call(options, 'input');
  const r = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    shell: false,
    input: useInput ? options.input : undefined,
    stdio: useInput
      ? ['pipe', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit']
      : (options.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit')
  });
  if (options.capture) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Command failed (${r.status || 1}): ${command} ${commandArgs.join(' ')}`);
  return r;
}

function clasp(commandArgs, options = {}) {
  if (existsSync(localClasp)) return run(localClasp, commandArgs, options);
  console.warn('CLASP_LOCAL_DEPENDENCY_MISSING — using pinned npx fallback @google/clasp@3.3.0.');
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
  for (const name of files(dir)) {
    out.set(logicalName(name), { name, sha: sha(resolve(dir, name)) });
  }
  return out;
}

function inventoryObject(inv) {
  return Object.fromEntries([...inv.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function findTarget(base, dir) {
  const matches = readdirSync(dir).filter(name => name === `${base}.js` || name === `${base}.gs`);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one target for ${base}; found ${matches.length}`);
  }
  return resolve(dir, matches[0]);
}

function canonicalSource(base) {
  const gs = resolve(sourceDir, `${base}.gs`);
  const js = resolve(sourceDir, `${base}.js`);
  const matches = [gs, js].filter(existsSync);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one canonical source for ${base}; found ${matches.length}`);
  }
  return matches[0];
}

function normalizedText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function requireMarker(path, marker) {
  if (!readFileSync(path, 'utf8').includes(marker)) {
    throw new Error(`Missing marker ${marker} in ${basename(path)}`);
  }
}

function assertAllowedModules() {
  const allowed = new Set(CONFIG.allowedPatchModules || []);
  const unexpected = patchModules.filter(name => !allowed.has(name));
  if (unexpected.length) {
    throw new Error(`Patch module is not allowlisted: ${unexpected.join(', ')}`);
  }
  for (const name of patchModules) canonicalSource(name);
}

function assertNoForbiddenSource(dir) {
  const findings = [];
  for (const name of files(dir)) {
    if (!/\.(?:js|gs)$/.test(name)) continue;
    const text = readFileSync(resolve(dir, name), 'utf8');
    for (const legacy of CONFIG.forbiddenAutomationNames || []) {
      if (text.includes(legacy)) findings.push(`${name}: ${legacy}`);
    }
    for (const marker of CONFIG.forbiddenSourceMarkers || []) {
      if (text.includes(marker)) findings.push(`${name}: ${marker}`);
    }
  }
  if (findings.length) {
    throw new Error('FORBIDDEN_SOURCE_FOUND\n' + findings.join('\n'));
  }
}

function syntaxCheck(path) {
  const source = readFileSync(path, 'utf8');
  run(process.execPath, ['--check'], { input: source, capture: true });
}

function assertConfig() {
  const required = ['projectName', 'releaseVersion', 'scriptId', 'deploymentId', 'sourceDir'];
  const missing = required.filter(key => !String(CONFIG[key] || '').trim());
  if (missing.length) throw new Error(`release.config.json missing: ${missing.join(', ')}`);
  if (!Array.isArray(CONFIG.defaultPatchModules) || !CONFIG.defaultPatchModules.length) {
    throw new Error('release.config.json defaultPatchModules must be non-empty.');
  }
  assertAllowedModules();
  for (const rule of CONFIG.requiredMarkers || []) {
    requireMarker(canonicalSource(rule.module), rule.marker);
  }
  assertNoForbiddenSource(sourceDir);
}

function assertManifestUnchanged(beforeInv, afterInv) {
  const key = 'appsscript.json';
  const beforeManifest = beforeInv.get(key);
  const afterManifest = afterInv.get(key);
  if (!beforeManifest || !afterManifest) throw new Error('appsscript.json missing from inventory.');
  if (beforeManifest.sha !== afterManifest.sha) {
    throw new Error('appsscript.json changed unexpectedly; refusing push.');
  }
}

function compareInventories(expected, actual, label) {
  const expectedKeys = [...expected.keys()].sort();
  const actualKeys = [...actual.keys()].sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error(`${label}_INVENTORY_MISMATCH`);
  }
  const mismatches = expectedKeys.filter(key => expected.get(key).sha !== actual.get(key).sha);
  if (mismatches.length) throw new Error(`${label}_HASH_MISMATCH: ${mismatches.join(', ')}`);
}

function webAppUrl(ops) {
  return `https://script.google.com/macros/s/${encodeURIComponent(CONFIG.deploymentId)}/exec?ops=${encodeURIComponent(ops)}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { method: 'GET', redirect: 'follow' });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Expected JSON from ${url}; received HTTP ${response.status}.`); }
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`);
  return json;
}

async function verifyHealth() {
  const h = CONFIG.health || {};
  const body = await fetchJson(webAppUrl(h.ops || 'health'));
  const failures = [];
  if (body.ok !== true) failures.push('ok !== true');
  if (h.expectedService && body.service !== h.expectedService) failures.push(`service=${body.service}`);
  if (h.expectedVersion && body.version !== h.expectedVersion) failures.push(`version=${body.version}`);
  if (h.expectedStatus && body.status !== h.expectedStatus) failures.push(`status=${body.status}`);
  if (body.singleModelVerified !== true) failures.push('singleModelVerified !== true');
  if (body.automationEnabled !== true) failures.push('automationEnabled !== true');
  if (failures.length) throw new Error(`POST_DEPLOY_HEALTH_FAILED: ${failures.join(' | ')}`);
  return body;
}

async function verifyAcceptance() {
  const a = CONFIG.acceptance || {};
  const body = await fetchJson(webAppUrl(a.ops || 'release-verify'));
  const failures = [];
  if (body.ok !== true) failures.push('ok !== true');
  if (a.expectedVersion && body.version !== a.expectedVersion) failures.push(`version=${body.version}`);
  if (a.expectedStatus && body.status !== a.expectedStatus) failures.push(`status=${body.status}`);
  if (failures.length) throw new Error(`POST_DEPLOY_ACCEPTANCE_FAILED: ${failures.join(' | ')}`);
  return body;
}

function parseVersionNumber(result) {
  const text = `${String(result.stdout || '')}\n${String(result.stderr || '')}`;
  const match = text.match(/version\s+(\d+)/i);
  if (!match) throw new Error('Could not parse Apps Script version.');
  return match[1];
}

function versionAndRedeploy(cwd, label) {
  const versionResult = clasp(['version', label], { cwd, capture: true });
  const versionNumber = parseVersionNumber(versionResult);
  const redeployResult = clasp([
    'redeploy',
    CONFIG.deploymentId,
    '--versionNumber',
    versionNumber,
    '--description',
    label,
    '--json'
  ], { cwd, capture: true });
  const redeployText = String(redeployResult.stdout || '').trim();
  let redeployJson = null;
  try { redeployJson = JSON.parse(redeployText); } catch {}
  if (!redeployJson ||
      String(redeployJson.deploymentId || '') !== String(CONFIG.deploymentId) ||
      String(redeployJson.versionNumber || '') !== String(versionNumber)) {
    throw new Error(`REDEPLOY_VERIFY_FAILED: ${redeployText}`);
  }
  const deploymentsResult = clasp(['deployments'], { cwd, capture: true });
  const deploymentsText = `${String(deploymentsResult.stdout || '')}\n${String(deploymentsResult.stderr || '')}`;
  if (!deploymentsText.includes(`${CONFIG.deploymentId} @${versionNumber}`)) {
    throw new Error(`DEPLOYMENT_PIN_VERIFY_FAILED: expected ${CONFIG.deploymentId} @${versionNumber}`);
  }
  return versionNumber;
}

function rollback() {
  if (!pushedRemoteHead || !existsSync(before)) return { attempted: false, reason: 'NO_REMOTE_PUSH_TO_ROLL_BACK' };
  console.error('\n=== ROLLBACK — restore exact pre-release live source ===');
  clasp(['push', '--force'], { cwd: before });
  rmSync(rollbackVerify, { recursive: true, force: true });
  mkdirSync(rollbackVerify, { recursive: true });
  writeFileSync(resolve(rollbackVerify, '.clasp.json'), JSON.stringify({ scriptId: CONFIG.scriptId, rootDir: '.' }, null, 2) + '\n');
  clasp(['pull'], { cwd: rollbackVerify });
  compareInventories(inventory(before), inventory(rollbackVerify), 'ROLLBACK_REMOTE_PARITY');
  const rollbackVersion = versionAndRedeploy(
    before,
    `ROLLBACK ${CONFIG.projectName} after failed v${CONFIG.releaseVersion} release`
  );
  return { attempted: true, ok: true, rollbackVersion };
}

function localSelfTest() {
  assertConfig();
  for (const module of patchModules) syntaxCheck(canonicalSource(module));
  step('LOCAL_SELF_TEST_PASS', { patchModules });
  return true;
}

async function main() {
  console.log('======================================================================');
  console.log(` ${CONFIG.projectName} — PERMANENT ONE-COMMAND RELEASE`);
  console.log('======================================================================');
  console.log('Release version: ' + CONFIG.releaseVersion);
  console.log('Script ID:       ' + CONFIG.scriptId);
  console.log('Deployment ID:   ' + CONFIG.deploymentId);
  console.log('Patch modules:   ' + patchModules.join(', '));
  console.log('Description:     ' + description);

  console.log('\n=== 0/12 Local config + syntax self-test ===');
  localSelfTest();
  if (selfTestOnly || !execute) {
    console.log('\nDRY RUN PASS — no Apps Script write occurred.');
    console.log('Execute with: node scripts/release.mjs --execute --description "<change>"');
    saveReport({ status: 'DRY_RUN_PASS', completedAt: new Date().toISOString() });
    return;
  }

  console.log('\n=== 1/12 Authenticate ===');
  clasp(['show-authorized-user', '--json']);
  step('AUTHENTICATION_PASS');

  console.log('\n=== 2/12 Pull exact live project ===');
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(live, { recursive: true });
  mkdirSync(verify, { recursive: true });
  mkdirSync(checkpointRoot, { recursive: true });
  writeFileSync(resolve(live, '.clasp.json'), JSON.stringify({ scriptId: CONFIG.scriptId, rootDir: '.' }, null, 2) + '\n');
  clasp(['pull'], { cwd: live });
  if (!existsSync(resolve(live, 'appsscript.json'))) throw new Error('Live pull did not contain appsscript.json.');
  step('LIVE_PULL_PASS', { fileCount: files(live).length });

  console.log('\n=== 3/12 Create durable checkpoint ===');
  mkdirSync(checkpoint, { recursive: true });
  cpSync(live, before, { recursive: true });
  const beforeInv = inventory(before);
  writeFileSync(resolve(checkpoint, 'before.sha256.json'), JSON.stringify(inventoryObject(beforeInv), null, 2) + '\n');
  step('CHECKPOINT_CREATED', { checkpoint, fileCount: beforeInv.size });
  saveReport();

  console.log('\n=== 4/12 Apply targeted patch ===');
  for (const module of patchModules) {
    const src = canonicalSource(module);
    const target = findTarget(module, live);
    cpSync(src, target);
    console.log(`${module} -> ${basename(target)}`);
  }
  const removed = [];
  for (const module of CONFIG.obsoleteModules || []) {
    const entry = beforeInv.get(module);
    if (!entry) continue;
    rmSync(resolve(live, entry.name), { force: true });
    removed.push(module);
    console.log('REMOVE obsolete -> ' + entry.name);
  }
  step('TARGETED_PATCH_APPLIED', { removedObsoleteModules: removed });

  console.log('\n=== 5/12 Safety diff + inventory guard ===');
  const afterInv = inventory(live);
  const beforeKeys = [...beforeInv.keys()].sort();
  const expectedRemoved = beforeKeys.filter(k => (CONFIG.obsoleteModules || []).includes(k)).sort();
  if (JSON.stringify([...removed].sort()) !== JSON.stringify(expectedRemoved)) {
    throw new Error(`Unexpected obsolete removal scope. Removed=${removed.join(', ')} Expected=${expectedRemoved.join(', ')}`);
  }
  const expectedAfterKeys = beforeKeys.filter(k => !(CONFIG.obsoleteModules || []).includes(k)).sort();
  const afterKeys = [...afterInv.keys()].sort();
  if (JSON.stringify(afterKeys) !== JSON.stringify(expectedAfterKeys)) {
    throw new Error('Live file inventory changed outside approved removals; refusing push.');
  }
  assertManifestUnchanged(beforeInv, afterInv);
  const changed = expectedAfterKeys.filter(k => beforeInv.get(k).sha !== afterInv.get(k).sha).sort();
  const unexpectedChanged = changed.filter(k => !patchModules.includes(k));
  if (unexpectedChanged.length) {
    throw new Error('Unexpected patch scope: ' + unexpectedChanged.join(', '));
  }
  for (const module of patchModules) {
    if (normalizedText(canonicalSource(module)) !== normalizedText(findTarget(module, live))) {
      throw new Error(`CANONICAL_MODULE_PARITY_FAILED: ${module}`);
    }
  }
  step('SAFETY_DIFF_PASS', { changedModules: changed, removedModules: removed });

  console.log('\n=== 6/12 Changed-file syntax + source guardrails ===');
  for (const module of patchModules) syntaxCheck(findTarget(module, live));
  for (const rule of CONFIG.requiredMarkers || []) requireMarker(findTarget(rule.module, live), rule.marker);
  assertNoForbiddenSource(live);
  step('SYNTAX_AND_GUARDRAILS_PASS');

  console.log('\n=== 7/12 Push COMPLETE project to SAME Script ID ===');
  clasp(['status'], { cwd: live });
  clasp(['push', '--force'], { cwd: live });
  pushedRemoteHead = true;
  step('REMOTE_PUSH_COMPLETE');

  console.log('\n=== 8/12 Pull remote and verify whole-project parity ===');
  writeFileSync(resolve(verify, '.clasp.json'), JSON.stringify({ scriptId: CONFIG.scriptId, rootDir: '.' }, null, 2) + '\n');
  clasp(['pull'], { cwd: verify });
  const liveInv = inventory(live);
  const remoteInv = inventory(verify);
  compareInventories(liveInv, remoteInv, 'REMOTE_PARITY');
  assertNoForbiddenSource(verify);
  step('REMOTE_PARITY_PASS', { fileCount: remoteInv.size });

  console.log('\n=== 9/12 Create immutable version + update EXISTING deployment ===');
  const versionNumber = versionAndRedeploy(live, description);
  deploymentUpdated = true;
  writeFileSync(resolve(checkpoint, 'deployed-version.txt'), versionNumber + '\n');
  step('DEPLOYMENT_UPDATED', { versionNumber });

  console.log('\n=== 10/12 Read-only production health check ===');
  const health = await verifyHealth();
  writeFileSync(resolve(checkpoint, 'health.json'), JSON.stringify(health, null, 2) + '\n');
  step('PRODUCTION_HEALTH_PASS', { status: health.status, version: health.version });

  console.log('\n=== 11/12 Targeted release acceptance ===');
  const acceptance = await verifyAcceptance();
  writeFileSync(resolve(checkpoint, 'acceptance.json'), JSON.stringify(acceptance, null, 2) + '\n');
  step('RELEASE_ACCEPTANCE_PASS', { status: acceptance.status, version: acceptance.version });

  console.log('\n=== 12/12 Release checkpoint + report ===');
  writeFileSync(resolve(checkpoint, 'after.sha256.json'), JSON.stringify(inventoryObject(remoteInv), null, 2) + '\n');
  saveReport({
    status: 'VERIFIED',
    completedAt: new Date().toISOString(),
    deployedVersion: versionNumber,
    deploymentUpdated,
    healthStatus: health.status,
    acceptanceStatus: acceptance.status
  });
  console.log('VERIFIED');
  console.log('Checkpoint:      ' + checkpoint);
  console.log('Apps Script ver: ' + versionNumber);
  console.log('Health:          ' + health.status);
  console.log('Acceptance:      ' + acceptance.status);
}

try {
  await main();
} catch (error) {
  const failure = String(error && error.stack ? error.stack : error);
  console.error('\nRELEASE_FAILED\n' + failure);
  let rollbackResult = { attempted: false };
  try {
    rollbackResult = rollback();
    if (rollbackResult.attempted) console.error('ROLLBACK_VERIFIED: ' + JSON.stringify(rollbackResult));
  } catch (rollbackError) {
    rollbackResult = {
      attempted: true,
      ok: false,
      error: String(rollbackError && rollbackError.stack ? rollbackError.stack : rollbackError)
    };
    console.error('ROLLBACK_FAILED\n' + rollbackResult.error);
  }
  saveReport({
    status: rollbackResult.attempted && rollbackResult.ok ? 'FAILED_ROLLED_BACK' : 'FAILED',
    failedAt: new Date().toISOString(),
    failure,
    pushedRemoteHead,
    deploymentUpdated,
    rollback: rollbackResult
  });
  process.exitCode = 1;
}