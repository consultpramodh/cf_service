// JavaScript / Node.js: source-aware, single-module Apps Script release.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const scriptId='1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g';
const deployment='AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA';
const work=path.resolve('.location-release');
const base='a2d8780895c94b1c00a20e72ee2f04a72fea2550';
const hash=s=>createHash('sha256').update(s).digest('hex');
const norm=s=>s.replace(/\r\n/g,'\n').trimEnd()+'\n';
function run(cmd,args,cwd=process.cwd()){const r=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(r.error||r.status!==0)throw Error(cmd+' failed: '+(r.stderr||r.error));return r.stdout;}
function clasp(args,cwd){return run('npx',['-y','@google/clasp@3.3.0',...args],cwd);}
function pull(name){let dir=path.join(work,name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'.clasp.json'),JSON.stringify({scriptId,rootDir:'.'}));clasp(['pull'],dir);return dir;}
function inventory(dir){const out={};for(const f of fs.readdirSync(dir)){if(!/\.(gs|js|json|html)$/.test(f)||f==='.clasp.json')continue;const key=f.replace(/\.(gs|js)$/,'');if(out[key])throw Error('DUPLICATE_FILE '+key);out[key]={file:f,sha:hash(norm(fs.readFileSync(path.join(dir,f),'utf8')))};}return out;}
function equal(a,b){if(JSON.stringify(Object.keys(a).sort())!==JSON.stringify(Object.keys(b).sort()))throw Error('INVENTORY_DRIFT');for(const k of Object.keys(a))if(a[k].sha!==b[k].sha)throw Error('SOURCE_DRIFT '+k);}
function baseInventory(){const names=run('git',['ls-tree','-r','--name-only',base,'src/']).trim().split('\n').filter(Boolean);const out={};for(const name of names){const f=path.basename(name);if(!/\.(gs|json|html)$/.test(f))continue;const key=f.replace(/\.gs$/,'');out[key]={file:f,sha:hash(norm(run('git',['show',base+':'+name])))};}return out;}
const mode=process.argv[2];
if(mode==='prepare'){
 const before=pull('before'),a=inventory(before),b=baseInventory();if(Object.keys(a).length!==19)throw Error('EXPECTED_19_LIVE_FILES');equal(a,b);
 const entry=clasp(['deployments'],before).split('\n').find(x=>x.includes(deployment+' @'));const old=entry&&entry.match(/ @(\d+)\b/);if(!old)throw Error('PREVIOUS_DEPLOYMENT_VERSION_REQUIRED');
 fs.writeFileSync(path.join(work,'before-hashes.json'),JSON.stringify(a,null,2));fs.writeFileSync(path.join(work,'previous-version.txt'),old[1]);console.log('LIVE_SOURCE_BASELINE_AND_DEPLOYMENT_PASS');
}else if(mode==='apply'){
 const before=inventory(path.join(work,'before'));equal(before,inventory(pull('prepush')));const candidate=path.join(work,'candidate');fs.cpSync(path.join(work,'before'),candidate,{recursive:true});
 const replacement=fs.readFileSync('src/70_Workflow_Automation.gs','utf8');new vm.Script(replacement);fs.writeFileSync(path.join(candidate,before['70_Workflow_Automation'].file),replacement);
 const expected=inventory(candidate),changed=Object.keys(before).filter(k=>before[k].sha!==expected[k].sha);if(changed.length!==1||changed[0]!=='70_Workflow_Automation')throw Error('PATCH_SCOPE_FAILED');
 fs.writeFileSync(path.join(work,'mutation-started.txt'),'source push attempted');clasp(['push','--force'],candidate);equal(expected,inventory(pull('verify')));
 const out=clasp(['version','CF ServiceOps durable location state recovery R1'],candidate),match=out.match(/version\s+(\d+)/i);if(!match)throw Error('VERSION_PARSE_FAILED');
 const result=JSON.parse(clasp(['redeploy',deployment,'--versionNumber',match[1],'--description','CF ServiceOps durable location state recovery R1','--json'],candidate));if(result.deploymentId!==deployment||String(result.versionNumber)!==match[1])throw Error('DEPLOYMENT_PIN_FAILED');fs.writeFileSync(path.join(work,'deployed-version.txt'),match[1]);console.log('DEPLOYMENT_PINNED '+match[1]);
}else if(mode==='rollback'){
 if(!fs.existsSync(path.join(work,'mutation-started.txt')))process.exit(0);const before=inventory(path.join(work,'before')),current=inventory(pull('rollback-check'));let same=false;try{equal(before,current);same=true;}catch(e){equal(inventory(path.join(work,'candidate')),current);}if(!same)clasp(['push','--force'],path.join(work,'before'));equal(before,inventory(pull('rollback-verify')));
 const old=fs.readFileSync(path.join(work,'previous-version.txt'),'utf8');if(!/^\d+$/.test(old))throw Error('ROLLBACK_VERSION_INVALID');const result=JSON.parse(clasp(['redeploy',deployment,'--versionNumber',old,'--description','Rollback durable location recovery','--json'],path.join(work,'before')));if(result.deploymentId!==deployment||String(result.versionNumber)!==old)throw Error('ROLLBACK_PIN_FAILED');console.log('ROLLBACK_VERIFIED');
}else throw Error('Use prepare, apply, rollback');
