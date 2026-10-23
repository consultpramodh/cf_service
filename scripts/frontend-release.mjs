// JavaScript / Node.js: checkpointed, three-file Apps Script release.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {patchReadinessCounts} from './readiness-patch.mjs';
const root=process.cwd(), work=path.join(root,'.frontend-release');
const scriptId='1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g';
const deployment='AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA';
const targets=['50_Operator_Queue','70_Workflow_Automation','95_Public_Runners'];
function run(cmd,args,cwd=root){const r=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(r.status!==0)throw Error(cmd+' failed: '+r.stderr);return r.stdout;}
function clasp(args,cwd){return run('npx',['-y','@google/clasp@3.3.0',...args],cwd);}
function pull(name){const dir=path.join(work,name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'.clasp.json'),JSON.stringify({scriptId,rootDir:'.'}));clasp(['pull'],dir);return dir;}
function norm(s){return s.replace(/\r\n/g,'\n').trimEnd()+'\n';}
function inventory(dir){const out={};for(const f of fs.readdirSync(dir)){if(!/\.(gs|js|json)$/.test(f)||f==='.clasp.json')continue;const key=f.replace(/\.(gs|js)$/, '');if(out[key])throw Error('DUPLICATE_LOGICAL_FILE');const text=norm(fs.readFileSync(path.join(dir,f),'utf8'));out[key]={file:f,text,sha:createHash('sha256').update(text).digest('hex')};}return out;}
function equal(a,b){if(JSON.stringify(Object.keys(a).sort())!==JSON.stringify(Object.keys(b).sort()))throw Error('SOURCE_INVENTORY_DRIFT');for(const k of Object.keys(a))if(a[k].sha!==b[k].sha)throw Error('SOURCE_DRIFT_STOP '+k);}
const mode=process.argv[2];
if(mode==='prepare'){
  if(!/^[a-f0-9]{40}$/.test(process.env.FRONTEND_BASE_SHA||''))throw Error('BASE_SHA_REQUIRED');
  const live=pull('before'),actual=inventory(live),expected={};
  for(const f of fs.readdirSync('src')){if(!/\.(gs|json)$/.test(f))continue;let text=run('git',['show',process.env.FRONTEND_BASE_SHA+':src/'+f]);if(f==='30_Striven_Data.gs')text=patchReadinessCounts(text);text=norm(text);expected[f.replace(/\.gs$/,'')]={sha:createHash('sha256').update(text).digest('hex')};}
  if(Object.keys(actual).length!==17)throw Error('EXPECTED_17_LIVE_FILES');equal(actual,expected);
  fs.writeFileSync(path.join(work,'before-hashes.json'),JSON.stringify(Object.fromEntries(Object.entries(actual).map(([k,v])=>[k,v.sha])),null,2));
  const deployments=clasp(['deployments'],live);
  const entry=deployments.split('\n').find(line=>line.includes(deployment+' @'));
  const oldVersion=entry&&entry.match(/ @(\d+)\b/);
  if(!oldVersion)throw Error('PREVIOUS_DEPLOYMENT_VERSION_REQUIRED');
  fs.writeFileSync(path.join(work,'previous-version.txt'),oldVersion[1]+'\n');
  console.log('LIVE_BASELINE_PARITY_PASS; complete checkpoint ready; no source changed.');
}else if(mode==='apply'){
  const before=inventory(path.join(work,'before')),current=inventory(pull('prepush'));equal(before,current);
  const candidate=path.join(work,'candidate');fs.cpSync(path.join(work,'before'),candidate,{recursive:true});
  for(const key of targets){const text=fs.readFileSync('src/'+key+'.gs','utf8');new vm.Script(text,{filename:key+'.gs'});fs.writeFileSync(path.join(candidate,before[key].file),text);}
  const expected=inventory(candidate);const changed=Object.keys(before).filter(k=>before[k].sha!==expected[k].sha);
  if(changed.length!==3||changed.some(k=>!targets.includes(k)))throw Error('THREE_FILE_PATCH_SCOPE_FAILED');
  fs.writeFileSync(path.join(work,'mutation-started.txt'),'three-file source push attempted\n');
  clasp(['push','--force'],candidate);equal(expected,inventory(pull('verify')));
  console.log('REMOTE_SHA_PARITY_PASS; exactly three source files changed.');
  const versionText=clasp(['version','CF ServiceOps v5.14.5 frontend durable refresh 20261023-R1'],candidate);
  const match=versionText.match(/version\s+(\d+)/i);if(!match)throw Error('VERSION_PARSE_FAILED');
  const result=JSON.parse(clasp(['redeploy',deployment,'--versionNumber',match[1],'--description','CF ServiceOps v5.14.5 frontend durable refresh 20261023-R1','--json'],candidate));
  if(result.deploymentId!==deployment||String(result.versionNumber)!==match[1])throw Error('DEPLOYMENT_PIN_FAILED');
  fs.writeFileSync(path.join(work,'deployed-version.txt'),match[1]+'\n');
  console.log('FRONTEND_RELEASE_DEPLOYED version='+match[1]);
}else if(mode==='rollback'){
  if(!fs.existsSync(path.join(work,'mutation-started.txt'))){console.log('NO_SOURCE_MUTATION_ATTEMPTED');process.exit(0);}
  const before=inventory(path.join(work,'before')),current=inventory(pull('rollback-check'));
  let alreadyBefore=false;
  try{equal(before,current);alreadyBefore=true;}catch(e){equal(inventory(path.join(work,'candidate')),current);}
  if(!alreadyBefore)clasp(['push','--force'],path.join(work,'before'));
  equal(before,inventory(pull('rollback-verify')));
  const previous=fs.readFileSync(path.join(work,'previous-version.txt'),'utf8').trim();
  if(!/^\d+$/.test(previous))throw Error('ROLLBACK_VERSION_INVALID');
  const pinned=JSON.parse(clasp(['redeploy',deployment,'--versionNumber',previous,'--description','Rollback frontend refresh to verified checkpoint','--json'],path.join(work,'before')));
  if(pinned.deploymentId!==deployment||String(pinned.versionNumber)!==previous)throw Error('ROLLBACK_PIN_FAILED');
  console.log('ROLLBACK_SOURCE_HASHES_AND_DEPLOYMENT_VERIFIED version='+previous);
}else throw Error('Use prepare, apply, or rollback');
