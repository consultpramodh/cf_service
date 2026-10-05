#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const MIN_BASE = [5, 14, 2];
const CONTACT_LOCK = 'CF_SERVICEOPS_CONTACT_IDENTITY_FINALIZED_LOCK_R1';
const API_LOCK = 'CF_SERVICEOPS_API_EFFICIENCY_FINALIZED_LOCK_R1';
const CUSTOMER_TTL_LOCK = 'CF_SERVICEOPS_CUSTOMER_CACHE_EFFECTIVE_TTL_ALIGNMENT_LOCK_R1';
const NO_BACKGROUND_CUSTOMER_LOCK = 'CF_SERVICEOPS_NO_BACKGROUND_CUSTOMER_REPORT_REFRESH_LOCK_R1';

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
function parseVersion(s){const m=String(s||'').match(/^(\d+)\.(\d+)\.(\d+)$/);return m?[+m[1],+m[2],+m[3]]:null;}
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
      if(c==='"'||c==="'"||c==='`'){state='string';quote=c;continue;}
      if(c==='{')depth++; else if(c==='}'){depth--;if(depth===0)return{start,open,end:i+1,text:src.slice(start,i+1)};}
    } else if(state==='line'){if(c==='\n')state='code';}
    else if(state==='block'){if(c==='*'&&n==='/'){state='code';i++;}}
    else if(state==='string'){if(c==='\\'){i++;continue;}if(c===quote){state='code';quote='';}}
  }
  die(`Closing brace for ${functionName} not found.`);
}
function replaceRange(src,a,b,repl){return src.slice(0,a)+repl+src.slice(b);}
function rel(f){return path.relative(root,f).replace(/\\/g,'/');}
function replaceOnce(src, re, repl, label){
  const matches=src.match(new RegExp(re.source, re.flags.includes('g')?re.flags:re.flags+'g'))||[];
  if(matches.length!==1)die(`${label}: expected one match, found ${matches.length}.`);
  return src.replace(re,repl);
}
function findCanonicalHealthVersion(runnerSrc){
  const dg=findFunctionBlock(runnerSrc,'doGet');
  const m=dg.text.match(/service\s*:\s*['"]CF ServiceOps['"]\s*,[\s\S]{0,1200}?version\s*:\s*['"](\d+\.\d+\.\d+)['"]\s*,/);
  if(!m)die('Canonical doGet health version not found.');
  return m[1];
}

const files=walk(root);
if(!files.length)die(`No Apps Script .js/.gs files under ${root}`);

const writeFile=findUniqueFile(files,['function reconcileKnownContact_','CONTACT_OWNERSHIP_CONFLICT','CF.CustomerScopedContactIdentity'],'Striven write / identity implementation');
const hardeningFile=findUniqueFile(files,['function CFH_installOperationalMaintenanceTrigger_','function CFH_refreshOperationalCacheIfIdle','CFH_OPERATIONAL_HANDLER'],'production hardening implementation');
const runnerFile=findUniqueFile(files,['function doGet(','CF ServiceOps','CF.PublicRunners'],'public runner / health implementation');

let writeSrc=fs.readFileSync(writeFile,'utf8');
let hardSrc=fs.readFileSync(hardeningFile,'utf8');
let runnerSrc=fs.readFileSync(runnerFile,'utf8');

const baseVersionText=findCanonicalHealthVersion(runnerSrc);
const baseVersion=parseVersion(baseVersionText);
if(!baseVersion||cmp(baseVersion,MIN_BASE)<0)die(`Live canonical health is stale: ${baseVersionText}; required >= ${ver(MIN_BASE)}.`);
const targetVersion=[baseVersion[0],baseVersion[1],baseVersion[2]+1];
const target=ver(targetVersion);

const allInstalled = writeSrc.includes(CONTACT_LOCK) && writeSrc.includes(CUSTOMER_TTL_LOCK) &&
  writeSrc.includes(NO_BACKGROUND_CUSTOMER_LOCK) && hardSrc.includes(API_LOCK) &&
  runnerSrc.includes(`apiEfficiencyLock:'${API_LOCK}'`);
if(allInstalled)die(`Finalized v${baseVersionText} locks already installed. Refusing duplicate release/version bump.`);

// ---------------------------------------------------------------------------
// LOCK 1: Contact identity. Exact phone/email/alt-phone is authoritative.
// Names remain supporting evidence only. Customer ownership is separate and
// mandatory. Multiple distinct exact Contact IDs remain ambiguous/fail-closed.
// ---------------------------------------------------------------------------
if(!writeSrc.includes(CONTACT_LOCK)){
  let recon=findFunctionBlock(writeSrc,'reconcileKnownContact_');
  const helper=`  /* ${CONTACT_LOCK}\n`+
`   * FINALIZED CONTRACT — change only through an explicit later release.\n`+
`   * Exact normalized email, phone, or alt phone establishes Contact identity.\n`+
`   * Name is supporting evidence only. Customer ownership is a separate hard check.\n`+
`   */\n`+
`  function contactIdentityDecisionLocked_(input){\n`+
`    input=input||{};\n`+
`    function normEmail(v){return String(v||'').trim().toLowerCase();}\n`+
`    function normPhone(v){var x=String(v||'').replace(/\\D/g,'');if(x.length===11&&x.charAt(0)==='1')x=x.slice(1);return x;}\n`+
`    function upper(v){return String(v||'').trim().toUpperCase();}\n`+
`    var reqEmail=normEmail(input.requestEmail),reqPhone=normPhone(input.requestPhone),reqAltPhone=normPhone(input.requestAltPhone);\n`+
`    var remoteEmails=(Array.isArray(input.remoteEmails)?input.remoteEmails:[]).map(normEmail).filter(Boolean);\n`+
`    var remotePhones=(Array.isArray(input.remotePhones)?input.remotePhones:[]).map(normPhone).filter(Boolean);\n`+
`    var emailMatch=!!reqEmail&&remoteEmails.indexOf(reqEmail)!==-1;\n`+
`    var phoneMatch=!!reqPhone&&remotePhones.indexOf(reqPhone)!==-1;\n`+
`    var altPhoneMatch=!!reqAltPhone&&remotePhones.indexOf(reqAltPhone)!==-1;\n`+
`    var reqFirst=upper(input.requestFirstName),reqLast=upper(input.requestLastName);\n`+
`    var remoteFirst=upper(input.remoteFirstName),remoteLast=upper(input.remoteLastName);\n`+
`    var firstConflict=!!(reqFirst&&remoteFirst&&reqFirst!==remoteFirst);\n`+
`    var surnameConflict=!!(reqLast&&remoteLast&&reqLast!==remoteLast);\n`+
`    return{ok:emailMatch||phoneMatch||altPhoneMatch,emailMatch:emailMatch,phoneMatch:phoneMatch,altPhoneMatch:altPhoneMatch,nameConflict:firstConflict||surnameConflict,nameDecision:'SUPPORTING_ONLY',policyLock:'${CONTACT_LOCK}',policy:'EXACT_NORMALIZED_EMAIL_OR_PHONE_OR_ALT_PHONE_PLUS_SEPARATE_CUSTOMER_OWNERSHIP',remoteFirstName:remoteFirst,remoteLastName:remoteLast};\n`+
`  }\n\n`;
  writeSrc=writeSrc.slice(0,recon.start)+helper+writeSrc.slice(recon.start);

  recon=findFunctionBlock(writeSrc,'reconcileKnownContact_');
  const ident=findFunctionBlock(writeSrc,'identity_',recon.start,recon.end);
  const newIdentity=`function identity_(c){\n`+
`      var reqEmail=normEmail_(record['Normalized Email']||record['Email']);\n`+
`      var reqPhone=normPhone_(record['Normalized Phone']||record['Phone']);\n`+
`      var reqAltPhone=normPhone_(record['Normalized Alt Phone']||record['Alt Phone']);\n`+
`      var reqFirst=upper_(record['First Name']),reqLast=upper_(record['Last Name']);\n`+
`      var gotFirst=upper_(prop_(c,['FirstName','firstName'])),gotLast=upper_(prop_(c,['LastName','lastName']));\n`+
`      var emails=arr_(prop_(c,['Emails','emails'])).map(function(x){return normEmail_(prop_(x,['Email','email']));}).filter(Boolean);\n`+
`      var phones=arr_(prop_(c,['Phones','phones'])).map(function(x){return normPhone_(prop_(x,['Number','number']));}).filter(Boolean);\n`+
`      return contactIdentityDecisionLocked_({requestEmail:reqEmail,requestPhone:reqPhone,requestAltPhone:reqAltPhone,requestFirstName:reqFirst,requestLastName:reqLast,remoteFirstName:gotFirst,remoteLastName:gotLast,remoteEmails:emails,remotePhones:phones});\n`+
`    }`;
  writeSrc=replaceRange(writeSrc,ident.start,ident.end,newIdentity);

  // The newer customer-scoped Contact resolver must obey the same finalized rule.
  const scopedStart=writeSrc.indexOf('CF.CustomerScopedContactIdentity = (function ()');
  if(scopedStart<0)die('Customer-scoped Contact identity module not found.');
  const scopedEnd=writeSrc.indexOf('})();',scopedStart);
  if(scopedEnd<0)die('Customer-scoped Contact identity module end not found.');
  const score=findFunctionBlock(writeSrc,'score_',scopedStart,scopedEnd+4);
  const newScore=`function score_(request,row){\n`+
`    var reqEmail=normEmail_(request['Normalized Email']||request['Email']);\n`+
`    var reqPhone=normPhone_(request['Normalized Phone']||request['Phone']);\n`+
`    var reqAlt=normPhone_(request['Normalized Alt Phone']||request['Alt Phone']);\n`+
`    var gotEmail=normEmail_(row['Normalized Email']||row['Email']);\n`+
`    var gotPhone=normPhone_(row['Normalized Phone']||row['Phone']);\n`+
`    var signals=[],score=0;\n`+
`    if(reqEmail&&gotEmail&&reqEmail===gotEmail){signals.push('EXACT_EMAIL');score+=100;}\n`+
`    if(reqPhone&&gotPhone&&reqPhone===gotPhone){signals.push('EXACT_PHONE');score+=90;}\n`+
`    if(reqAlt&&gotPhone&&reqAlt===gotPhone){signals.push('EXACT_ALT_PHONE');score+=80;}\n`+
`    if(!signals.length)return{ok:false,score:0,signals:[],reason:'NO_PRIMARY_IDENTITY_MATCH'};\n`+
`    var reqFirst=upper_(request['First Name']),reqLast=upper_(request['Last Name']);\n`+
`    var gotFirst=upper_(row['First Name']),gotLast=upper_(row['Last Name']),full=upper_(row['Full Name']||row['Customer Name']);\n`+
`    var nameConflict=false;\n`+
`    if(reqLast&&(gotLast===reqLast||full.indexOf(reqLast)!==-1)){signals.push('LAST_NAME_SUPPORT');score+=20;}else if(reqLast&&gotLast){nameConflict=true;}\n`+
`    if(reqFirst&&(gotFirst===reqFirst||full.indexOf(reqFirst)!==-1)){signals.push('FIRST_NAME_SUPPORT');score+=10;}else if(reqFirst&&gotFirst){nameConflict=true;}\n`+
`    if(nameConflict)signals.push('NAME_CONFLICT_SUPPORTING_ONLY');\n`+
`    return{ok:true,score:score,signals:signals,nameConflict:nameConflict,nameDecision:'SUPPORTING_ONLY',policyLock:'${CONTACT_LOCK}'};\n`+
`  }`;
  writeSrc=replaceRange(writeSrc,score.start,score.end,newScore);

  // De-duplicate repeated report rows by Contact ID, then fail closed if more
  // than one distinct exact Contact ID remains for the resolved Customer.
  const scopedStart2=writeSrc.indexOf('CF.CustomerScopedContactIdentity = (function ()');
  const scopedEnd2=writeSrc.indexOf('})();',scopedStart2);
  const resolve=findFunctionBlock(writeSrc,'resolveRequest',scopedStart2,scopedEnd2+4);
  let resolveText=resolve.text;
  const oldAmbiguity=`    var rows=contactRowsForCustomer_(customerId),scored=[];\n    rows.forEach(function(row){var s=score_(r,row);if(s.ok)scored.push({row:row,match:s,id:clean_(row['Contact ID']||row['Entity ID'])});});\n    scored.sort(function(a,b){return b.match.score-a.match.score||String(a.id).localeCompare(String(b.id));});\n    if(!scored.length)return{ok:false,status:'CUSTOMER_SCOPED_CONTACT_ID_NOT_FOUND',requestId:clean_(r['Request ID']),customerId:customerId,candidateCount:0,changed:false,liveWriteExecuted:false,strivenMutationExecuted:false};\n    if(scored.length>1&&scored[0].match.score===scored[1].match.score&&scored[0].id!==scored[1].id){\n      return{ok:false,status:'CUSTOMER_SCOPED_CONTACT_ID_AMBIGUOUS',requestId:clean_(r['Request ID']),customerId:customerId,candidateIds:scored.slice(0,5).map(function(x){return x.id;}),changed:false,liveWriteExecuted:false,strivenMutationExecuted:false};\n    }\n    return persist_(r,scored[0].row,scored[0].match);`;
  const newAmbiguity=`    var rows=contactRowsForCustomer_(customerId),byId={};\n    rows.forEach(function(row){var s=score_(r,row),id=clean_(row['Contact ID']||row['Entity ID']);if(!s.ok||!id)return;var prior=byId[id];if(!prior||Number(s.score||0)>Number(prior.match.score||0))byId[id]={row:row,match:s,id:id};});\n    var scored=Object.keys(byId).map(function(id){return byId[id];});\n    scored.sort(function(a,b){return b.match.score-a.match.score||String(a.id).localeCompare(String(b.id));});\n    if(!scored.length)return{ok:false,status:'CUSTOMER_SCOPED_CONTACT_ID_NOT_FOUND',requestId:clean_(r['Request ID']),customerId:customerId,candidateCount:0,changed:false,liveWriteExecuted:false,strivenMutationExecuted:false};\n    if(scored.length>1){\n      return{ok:false,status:'CUSTOMER_SCOPED_CONTACT_ID_AMBIGUOUS',requestId:clean_(r['Request ID']),customerId:customerId,candidateIds:scored.slice(0,5).map(function(x){return x.id;}),changed:false,liveWriteExecuted:false,strivenMutationExecuted:false};\n    }\n    return persist_(r,scored[0].row,scored[0].match);`;
  if(resolveText.indexOf(oldAmbiguity)<0)die('Customer-scoped ambiguity block changed unexpectedly.');
  resolveText=resolveText.replace(oldAmbiguity,newAmbiguity);
  writeSrc=replaceRange(writeSrc,resolve.start,resolve.end,resolveText);

  if(!writeSrc.includes('function reconcileExistingContactById(')){
    const reconNow=findFunctionBlock(writeSrc,'reconcileKnownContact_');
    const insertAt=writeSrc.indexOf('function buildPreview_',reconNow.end);
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
    const exportRe=/executeControlledContactCreate\s*:\s*executeControlledContactCreate\s*,/;
    const exportMatch=exportRe.exec(writeSrc);
    if(!exportMatch)die('Contact module export object not found.');
    const exportText=exportMatch[0];
    writeSrc=writeSrc.slice(0,exportMatch.index)+exportText+`\n    reconcileExistingContactById: reconcileExistingContactById,\n    evaluateContactIdentityPolicyForTest: contactIdentityDecisionLocked_,`+writeSrc.slice(exportMatch.index+exportMatch[0].length);
  }
}

// ---------------------------------------------------------------------------
// LOCK 2: Align the Customer-create write-layer freshness threshold to the
// ALREADY-ENFORCED 120-minute data-layer API brake. This does not extend the
// current effective report freshness; it stops pointless 15..119 minute
// refresh requests/rerun loops that the data layer already refuses.
// ---------------------------------------------------------------------------
if(!writeSrc.includes(CUSTOMER_TTL_LOCK)){
  const ttlRe=/var\s+CUSTOMER_CACHE_MAX_AGE_MINUTES\s*=\s*15\s*;/;
  if(!ttlRe.test(writeSrc))die('Expected 15-minute Customer write-layer freshness constant not found.');
  writeSrc=writeSrc.replace(ttlRe,`/* ${CUSTOMER_TTL_LOCK} */\n  var CUSTOMER_CACHE_MAX_AGE_MINUTES = 120;`);
}

// ---------------------------------------------------------------------------
// LOCK 3: Background Customer-scoped identity maintenance is cache-only.
// Persistent unresolved historical rows must never force an 18-page Customer
// report refresh. Full refresh remains available only by explicit forceRefresh
// and at the existing real Customer-create freshness boundary.
// ---------------------------------------------------------------------------
if(!writeSrc.includes(NO_BACKGROUND_CUSTOMER_LOCK)){
  const scopedStart=writeSrc.indexOf('CF.CustomerScopedContactIdentity = (function ()');
  if(scopedStart<0)die('Customer-scoped Contact identity module not found for maintenance patch.');
  const scopedEnd=writeSrc.indexOf('})();',scopedStart);
  const maintenance=findFunctionBlock(writeSrc,'maintenance',scopedStart,scopedEnd+4);
  let mt=maintenance.text;
  const refreshRe=/var\s+refreshNeeded\s*=\s*force\|\|\(!lastMs&&initial\.unresolved>0\)\|\|\(\(initial\.unresolved>0\)&&\(Date\.now\(\)-lastMs>REPORT_REFRESH_TTL_MS\)\);/;
  if(!refreshRe.test(mt))die('Customer-scoped automatic report refresh condition changed unexpectedly.');
  mt=mt.replace(refreshRe,`/* ${NO_BACKGROUND_CUSTOMER_LOCK} */\n    var refreshNeeded=force;`);
  mt=mt.replace("var out={ok:!reportRefresh||reportRefresh.ok!==false,version:VERSION,status:'CUSTOMER_SCOPED_CONTACT_MAINTENANCE_COMPLETE'",
    "var out={ok:!reportRefresh||reportRefresh.ok!==false,version:VERSION,status:'CUSTOMER_SCOPED_CONTACT_MAINTENANCE_COMPLETE',backgroundReportRefreshDisabled:true");
  writeSrc=replaceRange(writeSrc,maintenance.start,maintenance.end,mt);
  // This module changed in this release; expose the canonical project release.
  const scopedStart2=writeSrc.indexOf('CF.CustomerScopedContactIdentity = (function ()');
  const scopedEnd2=writeSrc.indexOf('})();',scopedStart2);
  const scopedText=writeSrc.slice(scopedStart2,scopedEnd2+4);
  const updatedScoped=scopedText.replace(/var VERSION='5\.14\.2';/,`var VERSION='${target}';`);
  if(updatedScoped===scopedText)die('Customer-scoped Contact module VERSION marker not found.');
  writeSrc=replaceRange(writeSrc,scopedStart2,scopedEnd2+4,updatedScoped);
}

// Safety prerequisite before disabling background Operational refresh: the
// normal Sales Order flow must still contain an on-demand operational refresh.
if(!/refreshOperationalData\s*\(\s*\{\s*\}\s*\)/.test(writeSrc))die('On-demand Operational refresh prerequisite missing; refusing background disable.');
if(!/OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED/.test(writeSrc))die('Operational refresh rerun guard missing.');

// ---------------------------------------------------------------------------
// LOCK 4: No periodic background Operational report refresh. Sales-order
// creation retains the existing on-demand freshness boundary.
// ---------------------------------------------------------------------------
if(!hardSrc.includes(API_LOCK)){
  hardSrc=replaceOnce(hardSrc,/var\s+CFH_VERSION\s*=\s*['"]5\.14\.2['"]\s*;/,`var CFH_VERSION = '${target}';`,'CFH version');
  const install=findFunctionBlock(hardSrc,'CFH_installOperationalMaintenanceTrigger_');
  const installReplacement=`function CFH_installOperationalMaintenanceTrigger_(){\n`+
`  /* ${API_LOCK} */\n`+
`  var removed=0;\n`+
`  ScriptApp.getProjectTriggers().forEach(function(t){\n`+
`    try{if(CFH_clean_(t.getHandlerFunction&&t.getHandlerFunction())===CFH_OPERATIONAL_HANDLER){ScriptApp.deleteTrigger(t);removed++;}}catch(ignored){}\n`+
`  });\n`+
`  return{removedExisting:removed,installed:false,cadenceMinutes:null,policy:'DISABLED_BACKGROUND_OPERATIONAL_REFRESH_ON_DEMAND_ONLY',version:CFH_VERSION};\n`+
`}`;
  hardSrc=replaceRange(hardSrc,install.start,install.end,installReplacement);

  const refresh=findFunctionBlock(hardSrc,'CFH_refreshOperationalCacheIfIdle');
  const refreshReplacement=`function CFH_refreshOperationalCacheIfIdle(){\n`+
`  /* ${API_LOCK}\n`+
`   * Legacy trigger retirement path. ZERO Striven calls.\n`+
`   * Operational refresh remains on-demand at the Sales Order boundary.\n`+
`   */\n`+
`  var removed=0;\n`+
`  ScriptApp.getProjectTriggers().forEach(function(t){\n`+
`    try{if(CFH_clean_(t.getHandlerFunction&&t.getHandlerFunction())===CFH_OPERATIONAL_HANDLER){ScriptApp.deleteTrigger(t);removed++;}}catch(ignored){}\n`+
`  });\n`+
`  var contactRecovery=null;\n`+
`  if(removed>0&&typeof FIX_CF_REEVALUATE_FALSE_CONTACT_IDENTITY_CONFLICTS==='function'){try{contactRecovery=FIX_CF_REEVALUATE_FALSE_CONTACT_IDENTITY_CONFLICTS();}catch(recoveryError){contactRecovery={ok:false,error:String(recoveryError&&recoveryError.message||recoveryError)};}}\n`+
`  return{ok:true,version:CFH_VERSION,status:'BACKGROUND_OPERATIONAL_REFRESH_DISABLED',removedLegacyTriggers:removed,apiCallsSuppressed:true,contactRecovery:contactRecovery,liveWriteExecuted:false};\n`+
`}`;
  hardSrc=replaceRange(hardSrc,refresh.start,refresh.end,refreshReplacement);
}
if(/newTrigger\s*\(\s*CFH_OPERATIONAL_HANDLER\s*\)[\s\S]{0,180}?everyMinutes\s*\(/.test(hardSrc))die('Periodic Operational trigger installer still exists after patch.');
if(/refreshOperationalData\s*\(/.test(findFunctionBlock(hardSrc,'CFH_refreshOperationalCacheIfIdle').text))die('Retired Operational handler still calls refreshOperationalData.');

// ---------------------------------------------------------------------------
// Health and recovery surface.
// ---------------------------------------------------------------------------
let doGet=findFunctionBlock(runnerSrc,'doGet');
let dg=doGet.text;
const healthRe=/(service\s*:\s*['"]CF ServiceOps['"]\s*,\s*\n\s*)version\s*:\s*['"]\d+\.\d+\.\d+['"]\s*,/;
if(!healthRe.test(dg))die('Canonical health version field not found inside doGet.');
dg=dg.replace(healthRe,`$1version: '${target}',`);
if(!dg.includes(`contactIdentityLock:'${CONTACT_LOCK}'`)){
  const service=/service\s*:\s*['"]CF ServiceOps['"]\s*,/;
  dg=dg.replace(service,m=>m+`\n    contactIdentityLock:'${CONTACT_LOCK}',\n    apiEfficiencyLock:'${API_LOCK}',\n    customerFreshnessLock:'${CUSTOMER_TTL_LOCK}',\n    noBackgroundCustomerRefreshLock:'${NO_BACKGROUND_CUSTOMER_LOCK}',\n    operationalBackgroundRefresh:'DISABLED_ON_DEMAND_ONLY',\n    customerScopedBackgroundRefresh:'CACHE_ONLY',\n    customerCreateFreshnessMinutes:120,`);
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
  runnerSrc+=`\n\n/* FINALIZED CONTRACT REGRESSION — ZERO Striven calls */\n`+
`function ${testFn}(){\n`+
`  var failures=[];\n`+
`  if(typeof CF==='undefined'||!CF.StrivenControlledContactCreate)failures.push('CONTACT_MODULE_MISSING');\n`+
`  else if(typeof CF.StrivenControlledContactCreate.evaluateContactIdentityPolicyForTest!=='function')failures.push('CONTACT_POLICY_TEST_SURFACE_MISSING');\n`+
`  else{\n`+
`    var p=CF.StrivenControlledContactCreate.evaluateContactIdentityPolicyForTest;\n`+
`    var byPhone=p({requestPhone:'416-555-0101',requestFirstName:'CHRISTINE',requestLastName:'PENNEY',remoteFirstName:'ROBERT',remoteLastName:'PENNEY',remotePhones:['(416) 555-0101']});\n`+
`    var byEmail=p({requestEmail:'x@example.com',requestFirstName:'A',requestLastName:'B',remoteFirstName:'C',remoteLastName:'D',remoteEmails:['X@example.com']});\n`+
`    var byAlt=p({requestAltPhone:'4165550202',remotePhones:['416-555-0202']});\n`+
`    var noChannel=p({requestEmail:'no@example.com',requestPhone:'4165559999',remoteEmails:['other@example.com'],remotePhones:['4165550000']});\n`+
`    if(!byPhone.ok||!byPhone.phoneMatch||byPhone.nameDecision!=='SUPPORTING_ONLY')failures.push('PHONE_RULE_FAILED');\n`+
`    if(!byEmail.ok||!byEmail.emailMatch)failures.push('EMAIL_RULE_FAILED');\n`+
`    if(!byAlt.ok||!byAlt.altPhoneMatch)failures.push('ALT_PHONE_RULE_FAILED');\n`+
`    if(noChannel.ok)failures.push('NO_CHANNEL_FALSE_POSITIVE');\n`+
`  }\n`+
`  var activeOperationalTriggers=[];\n`+
`  ScriptApp.getProjectTriggers().forEach(function(t){try{if(String(t.getHandlerFunction&&t.getHandlerFunction())==='CFH_refreshOperationalCacheIfIdle')activeOperationalTriggers.push(String(t.getUniqueId&&t.getUniqueId()||''));}catch(e){}});\n`+
`  return{ok:failures.length===0&&activeOperationalTriggers.length===0,version:'${target}',contactIdentityLock:'${CONTACT_LOCK}',apiEfficiencyLock:'${API_LOCK}',customerFreshnessLock:'${CUSTOMER_TTL_LOCK}',noBackgroundCustomerRefreshLock:'${NO_BACKGROUND_CUSTOMER_LOCK}',failures:failures,activeOperationalTriggers:activeOperationalTriggers,liveWriteExecuted:false,strivenApiCallsExecuted:0};\n`+
`}\n`;
}

const staticChecks={
  canonicalBaseVersion:baseVersionText,
  targetVersion:target,
  contactLock:writeSrc.includes(CONTACT_LOCK),
  exactChannelAuthoritative:/ok:emailMatch\|\|phoneMatch\|\|altPhoneMatch/.test(writeSrc),
  nameSupportingOnly:writeSrc.includes("nameDecision:'SUPPORTING_ONLY'"),
  ownershipConflictPreserved:writeSrc.includes('CONTACT_OWNERSHIP_CONFLICT'),
  directExistingContactRecovery:writeSrc.includes('reconcileExistingContactById: reconcileExistingContactById'),
  scopedAmbiguityFailClosed:writeSrc.includes("if(scored.length>1){")&&writeSrc.includes("status:'CUSTOMER_SCOPED_CONTACT_ID_AMBIGUOUS'"),
  customerTtlAligned:writeSrc.includes(CUSTOMER_TTL_LOCK)&&/CUSTOMER_CACHE_MAX_AGE_MINUTES\s*=\s*120/.test(writeSrc),
  backgroundCustomerBulkRefreshDisabled:writeSrc.includes(NO_BACKGROUND_CUSTOMER_LOCK)&&/var refreshNeeded=force;/.test(writeSrc),
  explicitCustomerForceRefreshPreserved:writeSrc.includes('options.forceRefresh===true')&&writeSrc.includes('refreshCustomerData({})'),
  onDemandOperationalRefreshPreserved:/refreshOperationalData\s*\(\s*\{\s*\}\s*\)/.test(writeSrc),
  operationalBackgroundDisabled:hardSrc.includes(API_LOCK)&&hardSrc.includes('BACKGROUND_OPERATIONAL_REFRESH_DISABLED'),
  noPeriodicOperationalTrigger:!/newTrigger\s*\(\s*CFH_OPERATIONAL_HANDLER\s*\)[\s\S]{0,180}?everyMinutes\s*\(/.test(hardSrc),
  healthLocks:runnerSrc.includes(`contactIdentityLock:'${CONTACT_LOCK}'`)&&runnerSrc.includes(`apiEfficiencyLock:'${API_LOCK}'`)&&runnerSrc.includes(`noBackgroundCustomerRefreshLock:'${NO_BACKGROUND_CUSTOMER_LOCK}'`)
};
const failed=Object.keys(staticChecks).filter(k=>staticChecks[k]===false);
if(failed.length)die(`Finalized-contract checks failed: ${failed.join(', ')}`);

fs.writeFileSync(writeFile,writeSrc,'utf8');
fs.writeFileSync(hardeningFile,hardSrc,'utf8');
fs.writeFileSync(runnerFile,runnerSrc,'utf8');

process.stdout.write(JSON.stringify({
  ok:true,
  baseVersion:baseVersionText,
  targetVersion:target,
  locks:{contact:CONTACT_LOCK,apiEfficiency:API_LOCK,customerFreshness:CUSTOMER_TTL_LOCK,noBackgroundCustomerRefresh:NO_BACKGROUND_CUSTOMER_LOCK},
  changedFiles:[rel(writeFile),rel(hardeningFile),rel(runnerFile)],
  publicTestFunction:testFn,
  recoveryFunction:recoveryFn,
  policy:{
    contactIdentity:'EXACT_NORMALIZED_PHONE_OR_EMAIL_OR_ALT_PHONE; NAME SUPPORTING ONLY; CUSTOMER OWNERSHIP HARD REQUIRED; MULTIPLE DISTINCT EXACT IDS FAIL CLOSED',
    operationalRefresh:'NO PERIODIC BACKGROUND STRIVEN REPORT REFRESH; ON-DEMAND SALES-ORDER BOUNDARY ONLY',
    customerCreateFreshness:'120 MINUTES TO MATCH EXISTING DATA-LAYER API BRAKE',
    customerScopedMaintenance:'CACHE-ONLY IN BACKGROUND; FULL CUSTOMER REPORT ONLY EXPLICIT FORCE OR REAL PREWRITE FRESHNESS BOUNDARY'
  },
  staticChecks
},null,2)+'\n');