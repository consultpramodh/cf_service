const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../src/20_Intake_Processing.gs'),'utf8');
const block=src.slice(src.indexOf('    inspectGravityFormsWebhookFeeds: function'),src.indexOf('    inspectLocalIntakeProgress: function'));
const target='https://script.google.com/macros/s/AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA/exec';
const secret='dummy-sensitive-value';let feeds=[];
const normalize=v=>String(v||'').trim().replace(/^Bearer\s+/i,'');
const context={clean_:v=>String(v||'').trim(),gfConfig_:()=>({formId:'2'}),gfGetJson_:(route,params)=>{assert.equal(route,'forms/2/feeds');assert.equal(params.addon,'gravityformswebhooks');return feeds;},normalizeSecretValue_:normalize,deps_:()=>({util:{requireProperty:key=>{assert.equal(key,'WEBFORM_SHARED_SECRET');return secret;}}}),findSecretInObject_:o=>normalize(o.secret||o.shared_secret||o.Authorization||'')};
vm.runInNewContext('var probe={'+block+'};',context);
function feed(meta){return {id:'5',form_id:'2',addon_slug:'gravityformswebhooks',is_active:true,meta:{requestURL:target,requestMethod:'POST',requestFormat:'json',requestBodyType:'select_fields',...meta}};}
feeds=[feed({fieldValues:[{key:'secret',value:'gf_custom',custom_value:secret}]})];let x=context.probe.inspectGravityFormsWebhookFeeds();assert.equal(x.immediateDeliveryConfigured,true);assert.equal(JSON.stringify(x).includes(secret),false);
feeds=[feed({requestHeaders:[{key:'Authorization',value:'Bearer '+secret}],fieldValues:[]})];x=context.probe.inspectGravityFormsWebhookFeeds();assert.equal(x.feeds[0].headerSecretMatches,true);assert.equal(x.immediateDeliveryConfigured,false);
feeds=[feed({requestURL:target+'?shared_secret='+encodeURIComponent(secret),requestBodyType:'all_fields'})];x=context.probe.inspectGravityFormsWebhookFeeds();assert.equal(x.immediateDeliveryConfigured,true);assert.equal(JSON.stringify(x).includes(secret),false);
feeds=[feed({requestURL:'https://example.com/elsewhere',fieldValues:[{key:'secret',custom_value:secret}]})];assert.equal(context.probe.inspectGravityFormsWebhookFeeds().immediateDeliveryConfigured,false);
feeds=[feed({feed_condition_conditional_logic:'0'})];assert.equal(context.probe.inspectGravityFormsWebhookFeeds().feeds[0].conditionalLogicEnabled,false);
feeds=[feed({feedCondition:'1',feed_condition_object:{conditionalLogic:{rules:[{fieldId:'22',operator:'is',value:secret}]}}})];x=context.probe.inspectGravityFormsWebhookFeeds();assert.equal(x.feeds[0].conditionalLogicEnabled,true);assert.equal(x.feeds[0].conditionalRuleFields[0].fieldId,'22');assert.equal(JSON.stringify(x).includes(secret),false);
feeds={unexpected:true};assert.throws(()=>context.probe.inspectGravityFormsWebhookFeeds(),/RESPONSE_SHAPE_UNSUPPORTED/);
console.log('PASS: feed settings read only; header-only auth distinguished; body/query auth and target verified; secrets omitted.');
