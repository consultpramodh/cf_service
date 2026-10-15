// JavaScript / Node.js: actual HTTP helper tested with mocked UrlFetchApp.
const vm=require('node:vm'),assert=require('node:assert/strict');
const original="function httpRequest(url, options) {\n    options = options || {};\n    var attempts = Math.max(1, Number(options.attempts || 1));\n    var lastError;\n    for (var attempt = 1; attempt <= attempts; attempt++) {\n      try {\n        var response = UrlFetchApp.fetch(url, {\n          method: options.method || 'get',\n          headers: options.headers || {},\n          payload: options.payload,\n          contentType: options.contentType,\n          muteHttpExceptions: true\n        });\n        var status = response.getResponseCode();\n        var text = response.getContentText();\n        if (status >= 200 && status < 300) return { ok: true, status: status, text: text, json: parseJson(text, {}) };\n        lastError = new Error('HTTP ' + status + ': ' + truncate(text, 500));\n        if (status < 500 && status !== 429) throw lastError;\n      } catch (error) {\n        lastError = error;\n      }\n      if (attempt < attempts) Utilities.sleep(Math.min(8000, 500 * Math.pow(2, attempt - 1)));\n    }\n    throw lastError || new Error('HTTP request failed.');\n  }\n\n",patched="function httpRequest(url, options) {\n    options = options || {};\n    var attempts = Math.max(1, Number(options.attempts || 1));\n    var lastError;\n    for (var attempt = 1; attempt <= attempts; attempt++) {\n      var retryable = true;\n      try {\n        var response = UrlFetchApp.fetch(url, {\n          method: options.method || 'get',\n          headers: options.headers || {},\n          payload: options.payload,\n          contentType: options.contentType,\n          muteHttpExceptions: true\n        });\n        var status = response.getResponseCode();\n        var text = response.getContentText();\n        if (status >= 200 && status < 300) return { ok: true, status: status, text: text, json: parseJson(text, {}) };\n        lastError = new Error('HTTP ' + status + ': ' + truncate(text, 500));\n        if (status < 500 && status !== 429) { retryable = false; throw lastError; }\n      } catch (error) {\n        lastError = error;\n        if (!retryable) break;\n      }\n      if (attempt < attempts) Utilities.sleep(Math.min(8000, 500 * Math.pow(2, attempt - 1)));\n    }\n    throw lastError || new Error('HTTP request failed.');\n  }\n\n";
function execute(source,sequence,attempts=3){
 let calls=0,sleeps=0;
 const context={parseJson:JSON.parse,truncate:s=>s,Utilities:{sleep:()=>sleeps++},
 UrlFetchApp:{fetch:()=>{const x=sequence[Math.min(calls++,sequence.length-1)];if(x==='transport')throw Error('network');return {getResponseCode:()=>x,getContentText:()=> '{}'};}}};
 vm.createContext(context);vm.runInContext(source,context);
 let result,error;try{result=context.httpRequest('https://api.striven.com/v1/test',{attempts});}catch(e){error=e.message;}
 return {calls,sleeps,result,error};
}
assert.equal(execute(original,[400]).calls,3);
for(const status of [400,401,403,404,409,422]){
 const x=execute(patched,[status]);assert.equal(x.calls,1);assert.equal(x.sleeps,0);assert.match(x.error,new RegExp('HTTP '+status));
}
for(const failure of [429,500,503,'transport']){
 const x=execute(patched,[failure,200]);assert.equal(x.calls,2);assert.equal(x.result.ok,true);assert.equal(x.sleeps,1);
}
assert.equal(execute(patched,[200]).calls,1);
assert.equal(execute(patched,[500],1).calls,1);
assert.equal(execute(patched,[500]).calls,3);
console.log('PASS: reproduced original triple 400 attempt; patched terminal 4xx single attempt; 429/5xx/transport retries preserved; successful response and attempt cap preserved.');
