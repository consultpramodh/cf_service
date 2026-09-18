/************************************************************
 * CF ServiceOps — V2 Migration / Feature Gate
 * Version: 0.5.0-candidate
 * Date: 2026-09-17
 *
 * Modes:
 * OFF      -> legacy production only
 * SHADOW   -> V2 read-only diagnostics only
 * SELECTED -> V2 only for explicitly selected Request IDs
 * LIVE     -> V2 becomes production controller
 ************************************************************/
var CF = CF || {};

CF.V2Migration = (function () {
  'use strict';

  var VERSION='0.5.1-candidate';
  var MODE_PROP='CF_SERVICEOPS_V2_MODE';
  var SELECTED_PROP='CF_SERVICEOPS_V2_SELECTED_REQUEST_IDS';
  var WRITE_PROP='CF_SERVICEOPS_V2_WRITE_ENABLED';
  var REL_PROP='CF_SERVICEOPS_V2_RELATIONSHIP_PAYLOAD_MODE';

  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function props_(){return PropertiesService.getScriptProperties();}
  function mode_(){return upper_(props_().getProperty(MODE_PROP)||'OFF');}
  function selected_(){return String(props_().getProperty(SELECTED_PROP)||'').split(',').map(clean_).filter(Boolean);}
  function requiredModules_(){
    return {
      shadow:!!(CF.V2ShadowResolver&&typeof CF.V2ShadowResolver.inspectRequest==='function'),
      ensurers:!!(CF.V2CoreEnsurers&&typeof CF.V2CoreEnsurers.preview==='function'),
      orchestrator:!!(CF.V2Orchestrator&&typeof CF.V2Orchestrator.processRequest==='function')
    };
  }
  function modulesReady_(){var m=requiredModules_();return m.shadow&&m.ensurers&&m.orchestrator;}

  function relationshipModeReady_(){
    return ['CUSTOMER_OBJECT','CUSTOMER_ID','CUSTOMER_OBJECT_WITH_ID'].indexOf(upper_(props_().getProperty(REL_PROP)))!==-1;
  }

  function regressionReadiness_(){
    if(!modulesReady_())return {ok:false,status:'V2_MODULES_MISSING',modules:requiredModules_()};
    var rows=CF.V2Orchestrator.shadowRegression(),fail=rows.filter(function(x){return x.ok!==true;});
    return {ok:fail.length===0,status:fail.length?'V2_REGRESSION_READ_FAILURE':'V2_REGRESSION_READ_OK',rows:rows,failures:fail};
  }

  function readiness_(){
    var regression=regressionReadiness_();
    return {
      ok:regression.ok,
      version:VERSION,
      mode:mode_(),
      modules:requiredModules_(),
      regression:regression,
      relationshipPayloadModeReady:relationshipModeReady_(),
      writesEnabled:upper_(props_().getProperty(WRITE_PROP))==='TRUE',
      note:'Direct Customer email is diagnostic only; customer-facing email is verified on Contact/PrimaryContact. Relationship payload mode is a fallback contract and is enforced only if a request actually reaches ENSURE_RELATIONSHIP.'
    };
  }

  function isV2Request_(requestId){
    var m=mode_(),id=clean_(requestId);
    if(m==='LIVE')return true;
    if(m==='SELECTED')return selected_().indexOf(id)!==-1;
    return false;
  }

  function shadow(requestId){
    if(!modulesReady_())return {ok:false,status:'V2_MODULES_MISSING',liveWriteExecuted:false};
    return CF.V2Orchestrator.preview(requestId);
  }

  function process(requestId,options){
    options=options||{};
    var m=mode_();
    if(m==='OFF'||m==='SHADOW')return {ok:true,status:'V2_NOT_CONTROLLING_REQUEST',mode:m,requestId:clean_(requestId),shadow:shadow(requestId),liveWriteExecuted:false};
    if(!isV2Request_(requestId))return {ok:true,status:'V2_REQUEST_NOT_SELECTED',mode:m,requestId:clean_(requestId),liveWriteExecuted:false};
    if(!modulesReady_())return {ok:false,status:'V2_MODULES_MISSING',mode:m,requestId:clean_(requestId),liveWriteExecuted:false};
    return CF.V2Orchestrator.processRequest(requestId,{confirmLiveWrite:options.confirmLiveWrite===true,updateOperatorView:true});
  }

  function setShadowMode(){
    props_().setProperty(MODE_PROP,'SHADOW');
    props_().setProperty(WRITE_PROP,'FALSE');
    return {ok:true,status:'V2_SHADOW_ENABLED',mode:'SHADOW',writesEnabled:false};
  }

  function setSelectedMode(requestIds){
    var ids=(requestIds||[]).map(clean_).filter(Boolean);
    if(!ids.length)throw new Error('At least one Request ID is required for SELECTED mode.');
    props_().setProperty(SELECTED_PROP,ids.join(','));
    props_().setProperty(MODE_PROP,'SELECTED');
    props_().setProperty(WRITE_PROP,'TRUE');
    return {ok:true,status:'V2_SELECTED_ENABLED',mode:'SELECTED',requestIds:ids,writesEnabled:true};
  }

  function setLiveMode(){
    var ready=readiness_();
    if(!ready.ok)throw new Error('V2_LIVE_BLOCKED | Readiness checks are not complete.');
    props_().setProperty(MODE_PROP,'LIVE');
    props_().setProperty(WRITE_PROP,'TRUE');
    return {ok:true,status:'V2_LIVE_ENABLED',mode:'LIVE',readiness:ready,writesEnabled:true};
  }

  function disable(){
    props_().setProperty(MODE_PROP,'OFF');
    props_().setProperty(WRITE_PROP,'FALSE');
    return {ok:true,status:'V2_DISABLED',mode:'OFF',writesEnabled:false};
  }

  return {
    version:VERSION,
    readiness:readiness_,
    mode:mode_,
    isV2Request:isV2Request_,
    shadow:shadow,
    process:process,
    setShadowMode:setShadowMode,
    setSelectedMode:setSelectedMode,
    setLiveMode:setLiveMode,
    disable:disable
  };
})();
