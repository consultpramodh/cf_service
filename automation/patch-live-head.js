#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const MIN_BASE = [5, 14, 2];
const CONTACT_LOCK = 'CF_SERVICEOPS_CONTACT_IDENTITY_FINALIZED_LOCK_R1';
const API_LOCK = 'CF_SERVICEOPS_API_EFFICIENCY_FINALIZED_LOCK_R1';

function die(message) {
  process.stderr.write(`PATCH_ABORTED: ${message}\n`);
  process.exit(2);
}
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.(?:js|gs)$/i.test(ent.name)) out.push(p);
  }
  return out;
}
function cmp(a,b){for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return(a[i]||0)-(b[i]||0);}return 0;}
function ver(v){return v.join('.');}
function scanHighestVersion(files) {
  let max=[0,0,0];
  for (const f of files) {
    const s=fs.readFileSync(f,'utf8');
    const re=/\b5\.(\d+)\.(\d+)\b/g; let m;
    while((m=re.exec(s))){const v=[5,Number(m[1]),Number(m[2])];if(cmp(v,max)>0)max=v;}
  }
  return max;
}
function findUniqueFile(files, needles, label) {
  const matches=files.filter(f=>{const s=fs.readFileSync(f,'utf8');return needles.every(n=>s.includes(n));});
  if(matches.length!==1)die(`${label}: expected exactly 1 file; found ${matches.length}: ${matches.join(', ')}`);
  return matches[0];
}
function findFunctionBlock(src, functionName, fromIndex=0, toIndex=src.length) {
  const needle=`function ${functionName}`;
  const start=src.indexOf(needle,fromIndex);
  if(start<0||start>=toIndex)die(`Function ${functionName} not found.`);
  const open=src.indexOf('{',start);
  if(open<0||open>=toIndex)die(`Opening brace for ${functionName} not found.`);
  let depth=0,state='code',quote='';
  for(let i=open;i<toIndex;i++){
    const c=src[i],n=src[i+1];
    if(state==='code'){
      if(c==='/'&&n==='/'){state='line';i++;continue;}
      if(c==='/'&&n==='*'){state='block';i++;continue;}
      if(c==='"'||c==="'"||c==='\`'){state='string';quote=c;continue;}
      if(c==='{')depth++; else if(c==='}'){depth--;if(depth===0)return{start,open,end:i+1,text:src.slice(start,i+1)};}
    } else if(state==='line'){if(c==='\n')state='code';}
    else if(state==='block'){if(c==='*'&&n==='/'){state='code';i++;}}
    else if(state==='string'){if(c==='\\'){i++;continue;}if(c===quote){state='code';quote='';}}
  }
  die(`Closing brace for ${functionName} not found.`);
}
function replaceRange(src,a,b,repl){return src.slice(0,a)+repl+src.slice(b);}
function rel(f){return path.relative(root,f).replace(/\\/g,'/');}

const files=walk(root);
if(!files.length)die(`No Apps Script .js/.gs files under ${root}`);
const baseVersion=scanHighestVersion(files);
if(cmp(baseVersion,MIN_BASE)<0)die(`Live HEAD is stale: highest version ${ver(baseVersion)}; required >= ${ver(MIN_BASE)}.`);
const targetVersion=[baseVersion[0],baseVersion[1],baseVersion[2]+1];
const target=ver(targetVersion);

const writeFile=findUniqueFile(files,['function reconcileKnownContact_','CONTACT_OWNERSHIP_CONFLICT','executeControlledContactCreate'],'Contact identity implementation');
const hardeningFile=findUniqueFile(files,['function CFH_installOperationalMaintenanceTrigger_','function CFH_refreshOperationalCacheIfIdle','CFH_OPERATIONAL_HANDLER'],'production hardening implementation');
const runnerFile=findUniqueFile(files,['function doGet()','CF ServiceOps','CF.PublicRunners'],'public runner / health implementation');

let writeSrc=fs.readFileSync(writeFile,'utf8');
let hardSrc=fs.readFileSync(hardeningFile,'utf8');
let runnerSrc=fs.readFileSync(runnerFile,'utf8');

if(writeSrc.includes(CONTACT_LOCK)&&hardSrc.includes(API_LOCK)&&runnerSrc.includes("apiEfficiencyLock:'"+API_LOCK+"'")){
  die('Both finalized locks are already installed. Refusing duplicate version bump.');
}

if(!writeSrc.includes(CONTACT_LOCK)){
  let recon=findFunctionBlock(writeSrc,'reconcileKnownContact_');
  const helper=`  /* ${CONTACT_LOCK}\n`+
`   * FINALIZED CONTRACT — change only in a new explicit release.\n`+
`   * Exact normalized email OR exact normalized phone establishes Contact identity.\n`+
`   * Name is supporting evidence only. Customer ownership is a separate hard check.\n`+
`   */\n`+
`  function contactIdentityDecisionLocked_(input){\n`+
`    input=input||{};\n`+
`    function normEmail(v){return String(v||'').trim().toLowerCase();}\n`+
`    function normPhone(v){var x=String(v||'').replace(/\\D/g,'');if(x.length===11&&x.charAt(0)==='1')x=x.slice(1);return x;}\n`+
`    function upper(v){return String(v||'').trim().toUpperCase();}\n`+
`    var reqEmail=normEmail(input.requestEmail),reqPhone=normPhone(input.requestPhone);\n`+
`    var remoteEmails=(Array.isArray(input.remoteEmails)?input.remoteEmails:[]).map(normEmail).filter(Boolean);\n`+
`    var remotePhones=(Array.isArray(input.remotePhones)?input.remotePhones:[]).map(normPhone).filter(Boolean);\n`+
`    var emailMatch=!!reqEmail&&remoteEmails.indexOf(reqEmail)!==-1;\n`+
`    var phoneMatch=!!reqPhone&&remotePhones.indexOf(reqPhone)!==-1;\n`+
`    var reqFirst=upper(input.requestFirstName),reqLast=upper(input.requestLastName);\n`+
`    var remoteFirst=upper(input.remoteFirstName),remoteLast=upper(input.remoteLastName);\n`+
`    var nameConflict=(reqFirst&&remoteFirst&&reqFirst!==remoteFirst)||(reqLast&&remoteLast&&reqLast!==remoteLast);\n`+
`    return{ok:emailMatch||phoneMatch,emailMatch:emailMatch,phoneMatch:phoneMatch,nameConflict:!!nameConflict,nameDecision:'SUPPORTING_ONLY',policyLock:'${CONTACT_LOCK}',policy:'EXACT_NORMALIZED_EMAIL_OR_PHONE_PLUS_SEPARATE_CUSTOMER_OWNERSHIP',remoteFirstName:remoteFirst,remoteLastName:remoteLast};\n`+
`  }\n\n`;
  writeSrc=writeSrc.slice(0,recon.start)+helper+writeSrc.slice(recon.start);

  recon=findFunctionBlock(writeSrc,'reconcileKnownContact_');
  const identStart=recon.text.indexOf('function identity_(c)');
  if(identStart<0)die('Nested identity_(c) not found inside reconcileKnownContact_.');
  const ident=findFunctionBlock(writeSrc,'identity_',recon.start+identStart,recon.end);
  const newIdentity=`function identity_(c){\n`+
`      var reqEmail=normEmail_(record['Normalized Email']||record['Email']);\n`+
`      var reqPhone=normPhone_(record['Normalized Phone']||record['Phone']);\n`+
`      var reqFirst=upper_(record['First Name']),reqLast=upper_(record['Last Name']);\n`+
`      var gotFirst=upper_(prop_(c,['FirstName','firstName'])),gotLast=upper_(prop_(c,['LastName','lastName']));\n`+
`      var emails=arr_(prop_(c,['Emails','emails'])).map(function(x){return normEmail_(prop_(x,['Email','email']));}).filter(Boolean);\n`+
`      var phones=arr_(prop_(c,['Phones','phones'])).map(function(x){return normPhone_(prop_(x,['Number','number']));}).filter(Boolean);\n`+
`      return contactIdentityDecisionLocked_({requestEmail:reqEmail,requestPhone:reqPhone,requestFirstName:reqFirst,requestLastName:reqLast,remoteFirstName:gotFirst,remoteLastName:gotLast,remoteEmails:emails,remotePhones:phones});\n`+
`    }`;
  writeSrc=replaceRange(writeSrc,ident.start,ident.end,newIdentity);

  if(!writeSrc.includes('function reconcileExistingContactById(')){
    const insertAt=writeSrc.indexOf('function buildPreview_');
    if(insertAt<0)die('Contact reconcile wrapper insertion point buildPreview_ not found.');
    const wrapper=`  function reconcileExistingContactById(requestIdOrRow,contactId){\n`+
`    return withWriteLock_(function(){\n`+
`      var record=request_(requestIdOrRow);\n`+
`      if(!record)throw new Error('Service Request not found.');\n`+
`      var customerId=resolvedCustomerId_(record);\n`+
`      contactId=clean_(contactId);\n`+
`      if(!customerId)throw new Error('CONTACT_RECONCILE_BLOCKED | Customer ID is required.');\n`+
`      if(!contactId)throw new Error('CONTACT_RECONCILE_BLOCKED | Contact ID is required.');\n`+
`      return reconcileKnownContact_(record,contactId,customerId);\n`+
`    });\n`+
`  }\n\n`;
    writeSrc=writeSrc.slice(0,insertAt)+wrapper+writeSrc.slice(insertAt);
  }

  if(!writeSrc.includes('evaluateContactIdentityPolicyForTest: contactIdentityDecisionLocked_')){
    const exportRe=/executeControlledContactCreate\s*:\s*executeControlledContactCreate\s*,?/;
    const exportMatch=exportRe.exec(writeSrc);
    if(!exportMatch)die('Contact module export object not found.');
    var exportText=exportMatch[0];
    if(exportText.charAt(exportText.length-1)!==',')exportText+=',';
    writeSrc=writeSrc.slice(0,exportMatch.index)+exportText+`\n    reconcileExistingContactById: reconcileExistingContactById,\n    evaluateContactIdentityPolicyForTest: contactIdentityDecisionLocked_,`+writeSrc.slice(exportMatch.index+exportMatch[0].length);
  }
}

if(!/refreshOperationalData\s*\(\s*\{\s*\}\s*\)/.test(writeSrc)){
  die('On-demand operational refresh prerequisite missing from Striven write flow; refusing to disable background refresh.');
}
if(!/(OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED|SALES_ORDER_OPERATIONAL_REFRESH_RERUN)/.test(writeSrc)){
  die('Operational-refresh rerun safety status not found; refusing to disable background refresh.');
}

if(!hardSrc.includes(API_LOCK)){
  const install=findFunctionBlock(hardSrc,'CFH_installOperationalMaintenanceTrigger_');
  const installReplacement=`function CFH_installOperationalMaintenanceTrigger_(){\n`+
`  /* ${API_LOCK} */\n`+
`  var removed=0;\n`+
`  ScriptApp.getProjectTriggers().forEach(function(t){\n`+
`    try{if(CFH_clean_(t.getHandlerFunction&&t.getHandlerFunction())===CFH_OPERATIONAL_HANDLER){ScriptApp.deleteTrigger(t);removed++;}}catch(ignored){}\n`+
`  });\n`+
`  return{removedExisting:removed,installed:false,cadenceMinutes:null,policy:'DISABLED_BACKGROUND_OPERATIONAL_REFRESH_ON_DEMAND_ONLY',version:'${target}'};\n`+
`}`;
  hardSrc=replaceRange(hardSrc,install.start,install.end,installReplacement);

  const refresh=findFunctionBlock(hardSrc,'CFH_refreshOperationalCacheIfIdle');
  const refreshReplacement=`function CFH_refreshOperationalCacheIfIdle(){\n`+
`  /* ${API_LOCK}\n`+
`   * This legacy trigger is intentionally retired. It performs ZERO Striven calls.\n`+
`   * If an old installed trigger survives deployment, this invocation deletes it.\n`+
`   * Operational cache refresh remains available on-demand at the Sales Order boundary.\n`+
`   */\n`+
`  var removed=0;\n`+
`  ScriptApp.getProjectTriggers().forEach(function(t){\n`+
`    try{if(CFH_clean_(t.getHandlerFunction&&t.getHandlerFunction())===CFH_OPERATIONAL_HANDLER){ScriptApp.deleteTrigger(t);removed++;}}catch(ignored){}\n`+
`  });\n`+
`  var contactRecovery=null;\n`+
`  if(removed>0&&typeof FIX_CF_REEVALUATE_FALSE_CONTACT_IDENTITY_CONFLICTS==='function'){try{contactRecovery=FIX_CF_REEVALUATE_FALSE_CONTACT_IDENTITY_CONFLICTS();}catch(recoveryError){contactRecovery={ok:false,error:String(recoveryError&&recoveryError.message||recoveryError)};}}\n`+
`  return{ok:true,version:'${target}',status:'BACKGROUND_OPERATIONAL_REFRESH_DISABLED',removedLegacyTriggers:removed,apiCallsSuppressed:true,contactRecovery:contactRecovery,liveWriteExecuted:false};\n`+
`}`;
  hardSrc=replaceRange(hardSrc,refresh.start,refresh.end,refreshReplacement);
}

if(/newTrigger\s*\(\s*CFH_OPERATIONAL_HANDLER\s*\)[\s\S]{0,160}?everyMinutes\s*\(/.test(hardSrc)){
  die('Periodic Operational trigger installer still exists after patch.');
}
const refreshedHandler=findFunctionBlock(hardSrc,'CFH_refreshOperationalCacheIfIdle').text;
if(/refreshOperationalData\s*\(/.test(refreshedHandler))die('Disabled background handler still calls refreshOperationalData.');

let doGet=findFunctionBlock(runnerSrc,'doGet');
let dg=doGet.text;
dg=dg.replace(/version\s*:\s*['"]5\.\d+\.\d+['"]\s*,/,`version:'${target}',`);
if(!dg.includes(`contactIdentityLock:'${CONTACT_LOCK}'`)){
  const service=/service\s*:\s*['"]CF ServiceOps['"]\s*,/;
  if(!service.test(dg))die('doGet service marker not found.');
  dg=dg.replace(service,m=>m+`\n    contactIdentityLock:'${CONTACT_LOCK}',\n    apiEfficiencyLock:'${API_LOCK}',\n    operationalBackgroundRefresh:'DISABLED_ON_DEMAND_ONLY',`);
}
runnerSrc=replaceRange(runnerSrc,doGet.start,doGet.end,dg);

const recoveryFn='FIX_CF_REEVALUATE_FALSE_CONTACT_IDENTITY_CONFLICTS';
if(!runnerSrc.includes(`function ${recoveryFn}()`)){
  runnerSrc+=`\n\n/* ${CONTACT_LOCK} — reusable direct-GET reconciliation for parked false identity conflicts */\n`+
`function ${recoveryFn}(){\n`+
`  if(typeof CF==='undefined'||!CF.Util||!CF.StrivenControlledContactCreate||typeof CF.StrivenControlledContactCreate.reconcileExistingContactById!=='function')throw new Error('CONTACT_RECOVERY_DEPENDENCY_MISSING');\n`+
`  var rows=CF.Util.readRecords('SERVICE_REQUESTS')||[],targets=[];\n`+
`  rows.forEach(function(r){\n`+
`    var recon=String(r['Reconciliation Status']||'').toUpperCase();\n`+
`    var next=String(r['Next Action']||'');\n`+
`    if(recon!=='CONTACT DIRECT IDENTITY CONFLICT'&&next.toUpperCase().indexOf('REVIEW CONTACT IDENTITY ')!==0)return;\n`+
`    var m=next.match(/REVIEW CONTACT IDENTITY\\s+(\\d+)/i);\n`+
`    if(!m)return;\n`+
`    targets.push({requestId:String(r['Request ID']||'').trim(),contactId:m[1]});\n`+
`  });\n`+
`  var results=[];\n`+
`  targets.slice(0,25).forEach(function(t){\n`+
`    try{var x=CF.StrivenControlledContactCreate.reconcileExistingContactById(t.requestId,t.contactId);results.push({requestId:t.requestId,contactId:t.contactId,result:x});if(x&&x.ok&&CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.kick==='function'){try{CF.EventDrivenServiceAutomation.kick(t.requestId);}catch(ignoredKick){}}}\n`+
`    catch(e){results.push({requestId:t.requestId,contactId:t.contactId,ok:false,error:String(e&&e.message||e)});}\n`+
`  });\n`+
`  return{ok:true,version:'${target}',status:'FALSE_CONTACT_IDENTITY_CONFLICTS_REEVALUATED',targets:targets.length,processed:results.length,results:results,bulkReportRefreshExecuted:false,liveStrivenWriteExecuted:false};\n`+
`}\n`;
}

const testFn=`TESTING_CF_API_AND_CONTACT_LOCKS_${target.replace(/\./g,'_')}`;
if(!runnerSrc.includes(`function ${testFn}()`)){
  runnerSrc+=`\n\n/* ${CONTACT_LOCK} + ${API_LOCK} REGRESSION */\n`+
`function ${testFn}(){\n`+
`  var failures=[];\n`+
`  if(typeof CF==='undefined'||!CF.StrivenControlledContactCreate)failures.push('CONTACT_MODULE_MISSING');\n`+
`  else if(typeof CF.StrivenControlledContactCreate.evaluateContactIdentityPolicyForTest!=='function')failures.push('CONTACT_POLICY_TEST_SURFACE_MISSING');\n`+
`  else{\n`+
`    var p=CF.StrivenControlledContactCreate.evaluateContactIdentityPolicyForTest;\n`+
`    var byPhone=p({requestPhone:'416-555-0101',requestFirstName:'CHRISTINE',requestLastName:'PENNEY',remoteFirstName:'ROBERT',remoteLastName:'PENNEY',remotePhones:['(416) 555-0101']});\n`+
`    var byEmail=p({requestEmail:'x@example.com',requestFirstName:'A',requestLastName:'B',remoteFirstName:'C',remoteLastName:'D',remoteEmails:['X@example.com']});\n`+
`    var noChannel=p({requestEmail:'no@example.com',requestPhone:'4165559999',remoteEmails:['other@example.com'],remotePhones:['4165550000']});\n`+
`    if(!byPhone.ok||!byPhone.phoneMatch||byPhone.nameDecision!=='SUPPORTING_ONLY')failures.push('PHONE_RULE_FAILED');\n`+
`    if(!byEmail.ok||!byEmail.emailMatch)failures.push('EMAIL_RULE_FAILED');\n`+
`    if(noChannel.ok)failures.push('NO_CHANNEL_FALSE_POSITIVE');\n`+
`  }\n`+
`  var activeOperationalTriggers=[];\n`+
`  ScriptApp.getProjectTriggers().forEach(function(t){try{if(String(t.getHandlerFunction&&t.getHandlerFunction())==='CFH_refreshOperationalCacheIfIdle')activeOperationalTriggers.push(String(t.getUniqueId&&t.getUniqueId()||''));}catch(e){}});\n`+
`  return{ok:failures.length===0&&activeOperationalTriggers.length===0,version:'${target}',contactIdentityLock:'${CONTACT_LOCK}',apiEfficiencyLock:'${API_LOCK}',failures:failures,activeOperationalTriggers:activeOperationalTriggers,liveWriteExecuted:false,strivenApiCallsExecuted:0};\n`+
`}\n`;
}

const staticChecks={
  contactLock:writeSrc.includes(CONTACT_LOCK),
  exactChannelAuthoritative:/ok:emailMatch\|\|phoneMatch/.test(writeSrc),
  nameSupportingOnly:writeSrc.includes("nameDecision:'SUPPORTING_ONLY'"),
  ownershipConflictPreserved:writeSrc.includes('CONTACT_OWNERSHIP_CONFLICT'),
  directExistingContactRecovery:writeSrc.includes('reconcileExistingContactById: reconcileExistingContactById'),
  ambiguousContactProtectionPreserved:/CONTACT_MATCH_AMBIGUOUS|DUPLICATE_CONTACT_IDS_AMBIGUOUS/.test(writeSrc),
  onDemandOperationalRefreshPreserved:/refreshOperationalData\s*\(\s*\{\s*\}\s*\)/.test(writeSrc),
  operationalBackgroundDisabled:hardSrc.includes(API_LOCK)&&hardSrc.includes('BACKGROUND_OPERATIONAL_REFRESH_DISABLED'),
  noPeriodicOperationalTrigger:!/newTrigger\s*\(\s*CFH_OPERATIONAL_HANDLER\s*\)[\s\S]{0,160}?everyMinutes\s*\(/.test(hardSrc),
  healthLocks:runnerSrc.includes(`contactIdentityLock:'${CONTACT_LOCK}'`)&&runnerSrc.includes(`apiEfficiencyLock:'${API_LOCK}'`)
};
const failed=Object.keys(staticChecks).filter(k=>!staticChecks[k]);
if(failed.length)die(`Finalized-contract checks failed: ${failed.join(', ')}`);

fs.writeFileSync(writeFile,writeSrc,'utf8');
fs.writeFileSync(hardeningFile,hardSrc,'utf8');
fs.writeFileSync(runnerFile,runnerSrc,'utf8');

process.stdout.write(JSON.stringify({
  ok:true,
  baseVersion:ver(baseVersion),
  targetVersion:target,
  locks:{contact:CONTACT_LOCK,apiEfficiency:API_LOCK},
  changedFiles:[rel(writeFile),rel(hardeningFile),rel(runnerFile)],
  publicTestFunction:testFn,
  recoveryFunction:recoveryFn,
  policy:{
    contactIdentity:'EXACT_NORMALIZED_PHONE_OR_EMAIL; NAME SUPPORTING ONLY; CUSTOMER OWNERSHIP HARD REQUIRED',
    operationalRefresh:'NO PERIODIC BACKGROUND STRIVEN REPORT REFRESH; ON-DEMAND SALES-ORDER BOUNDARY ONLY',
    customerBulkTtl:'UNCHANGED_PENDING_REQUEST_SCOPED_PREWRITE_DUPLICATE_PROOF'
  },
  staticChecks
},null,2)+'\n');
