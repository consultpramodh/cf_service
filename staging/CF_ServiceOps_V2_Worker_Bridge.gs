/************************************************************
 * CF ServiceOps — V2 Worker Bridge
 * Version: 0.6.0-candidate
 * Date: 2026-09-17
 *
 * This bridge is intentionally scheduling-agnostic. The existing
 * EventDrivenServiceAutomation worker keeps ownership of its queue,
 * one-shot trigger chain, logging, and operator-queue refresh.
 ************************************************************/
var CF = CF || {};

CF.V2WorkerBridge = (function () {
  'use strict';

  var VERSION='0.6.0-candidate';

  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}

  function tryProcess(requestId){
    if(!CF.V2Migration||typeof CF.V2Migration.mode!=='function'||typeof CF.V2Migration.process!=='function'){
      return {handled:false,status:'V2_MIGRATION_UNAVAILABLE',liveWriteExecuted:false};
    }
    var mode=upper_(CF.V2Migration.mode());
    if(mode==='OFF'||mode==='SHADOW'){
      return {handled:false,status:'V2_NOT_CONTROLLING',mode:mode,liveWriteExecuted:false};
    }
    if(!CF.V2Migration.isV2Request(requestId)){
      return {handled:false,status:'V2_REQUEST_NOT_SELECTED',mode:mode,requestId:clean_(requestId),liveWriteExecuted:false};
    }

    var result=CF.V2Migration.process(requestId,{confirmLiveWrite:true});
    var after=result&&result.after||null;
    var complete=!!(after&&after.complete===true)||upper_(result&&result.status)==='V2_COMPLETE';
    var category=upper_(result&&result.category);
    var terminal=complete||category==='BUSINESS_REVIEW'||category==='PERMANENT_FAILURE';
    var shouldContinue=!terminal&&result&&result.ok!==false;
    var noProgress=!!(result&&result.progressed===false&&result.liveWriteExecuted!==true);

    if(noProgress&&category==='TECHNICAL_RECOVERY'){
      terminal=true;shouldContinue=false;
    }

    return {
      handled:true,
      version:VERSION,
      mode:mode,
      requestId:clean_(requestId),
      ok:result&&result.ok!==false,
      status:clean_(result&&result.status)||'V2_NO_RESULT',
      category:clean_(result&&result.category),
      complete:complete,
      terminal:terminal,
      dequeue:terminal,
      shouldContinue:shouldContinue,
      continuationReason:result&&result.liveWriteExecuted===true?'V2_AFTER_WRITE':'V2_CONTINUE_FACT_CHAIN',
      noProgress:noProgress,
      result:result,
      liveWriteExecuted:!!(result&&result.liveWriteExecuted===true)
    };
  }

  return {version:VERSION,tryProcess:tryProcess};
})();
