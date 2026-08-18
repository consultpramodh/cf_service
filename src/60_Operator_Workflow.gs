// /************************************************************
//  * APPS SCRIPT — 60_Operator_Workflow.gs
//  * CF ServiceOps — Operator Review, Approval and Completion
//  * Version: 4.2.2
//  ************************************************************/
// var CF = CF || {};

// CF.Operator = (function () {
//   'use strict';

//   var MODULE_NAME = '60_Operator_Workflow';
//   var VERSION = '4.2.2';

//   function deps_() {
//     if (!CF.Config || !CF.Util || !CF.ServiceRequestMatching || !CF.StrivenWrite) {
//       throw new Error('CF.Config, CF.Util, CF.ServiceRequestMatching and CF.StrivenWrite are required.');
//     }
//     return { config: CF.Config, util: CF.Util, matching: CF.ServiceRequestMatching, write: CF.StrivenWrite };
//   }


//   function refreshSummaryRow_(rowNumber) {
//     if (CF.Layout && typeof CF.Layout.refreshServiceRequestSummaries === 'function') {
//       CF.Layout.refreshServiceRequestSummaries({ rowNumber: rowNumber });
//     }
//   }

//   function selected_() {
//     var d = deps_();
//     var sheet = d.util.getSpreadsheet().getActiveSheet();
//     if (!sheet || sheet.getName() !== d.config.getSheetName('SERVICE_REQUESTS')) throw new Error('Select a row on Service Requests.');
//     var row = sheet.getActiveRange().getRow();
//     if (row < 2) throw new Error('Select a Service Request data row.');
//     var record = d.util.getRowObject('SERVICE_REQUESTS', row);
//     if (!record) throw new Error('Selected Service Request could not be read.');
//     return record;
//   }

//   function previewSelectedAction() {
//     var d = deps_();
//     var record = selected_();
//     var matching = d.matching.previewRequest(record.__rowNumber);
//     var writePreview;
//     try { writePreview = d.write.previewRequest(record.__rowNumber); }
//     catch (error) { writePreview = { ok: false, error: error.message || String(error) }; }
//     return { ok: true, requestId: record['Request ID'], matching: matching, write: writePreview };
//   }

//   function approveSelectedAction(options) {
//     options = options || {};
//     var d = deps_();
//     var record = selected_();
//     var actor = options.actor || d.util.activeUserEmail() || 'OPERATOR';
//     var now = d.util.nowString();
//     var plan = d.util.parseJson(record['Transaction Plan JSON'], null);
//     if (!plan) {
//       d.matching.resolveRequest(record.__rowNumber);
//       record = d.util.getRowObject('SERVICE_REQUESTS', record.__rowNumber);
//       plan = d.util.parseJson(record['Transaction Plan JSON'], {});
//     }
//     if (record['Manual Review?'] === 'YES' && options.overrideReview !== true) {
//       throw new Error('This request requires manual resolution before approval. Correct the matched IDs/actions or use an explicit reviewed override.');
//     }
//     var fingerprint = d.util.canonicalHash({ requestId: record['Request ID'], plan: plan, approvedBy: actor, approvedAt: now });
//     d.util.updateRowObject('SERVICE_REQUESTS', record.__rowNumber, {
//       'Approved By': actor,
//       'Approved At': now,
//       'Write Fingerprint': fingerprint,
//       'Work Order Approval Fingerprint': fingerprint,
//       'Operator Action': 'APPROVE PROPOSED ACTION',
//       'Current Stage': 'APPROVED FOR STRIVEN WRITE',
//       'Request Status': 'IN PROGRESS',
//       'Next Action': 'EXECUTE APPROVED STRIVEN ACTION',
//       'Last Operator Update At': now,
//       'Last Operator Update By': actor
//     });
//     refreshSummaryRow_(record.__rowNumber);
//     return { ok: true, requestId: record['Request ID'], approvedBy: actor, approvedAt: now, fingerprint: fingerprint };
//   }

//   function executeSelectedAction(options) {
//     options = options || {};
//     var d = deps_();
//     var record = selected_();
//     var action = d.util.cleanText(record['Operator Action']).toUpperCase();

//     if (action === 'MARK DUPLICATE') return markDuplicate_(record);
//     if (action === 'CANCEL') return cancel_(record);
//     if (action === 'REQUEST INFORMATION') return requestInformation_(record);
//     if (action === 'PREVIEW PROPOSED ACTION') return previewSelectedAction();
//     if (action === 'APPROVE PROPOSED ACTION' || !record['Approved By']) approveSelectedAction(options);
//     return d.write.processRequest(record.__rowNumber, options);
//   }

//   function markDuplicate_(record) {
//     var d = deps_();
//     d.util.updateRowObject('SERVICE_REQUESTS', record.__rowNumber, {
//       'Current Stage': 'DUPLICATE',
//       'Request Status': 'DUPLICATE',
//       'Final Outcome': 'DUPLICATE_REQUEST',
//       'Completed At': d.util.nowString(),
//       'Next Action': '',
//       'Operator Action': ''
//     });
//     refreshSummaryRow_(record.__rowNumber);
//     return { ok: true, requestId: record['Request ID'], outcome: 'DUPLICATE_REQUEST' };
//   }

//   function cancel_(record) {
//     var d = deps_();
//     d.util.updateRowObject('SERVICE_REQUESTS', record.__rowNumber, {
//       'Current Stage': 'CANCELLED',
//       'Request Status': 'CANCELLED',
//       'Final Outcome': 'CANCELLED',
//       'Completed At': d.util.nowString(),
//       'Next Action': '',
//       'Operator Action': ''
//     });
//     refreshSummaryRow_(record.__rowNumber);
//     return { ok: true, requestId: record['Request ID'], outcome: 'CANCELLED' };
//   }

//   function requestInformation_(record) {
//     var d = deps_();
//     d.util.updateRowObject('SERVICE_REQUESTS', record.__rowNumber, {
//       'Current Stage': 'NEEDS REVIEW',
//       'Request Status': 'BLOCKED',
//       'Next Action': 'CONTACT CUSTOMER FOR INFORMATION',
//       'Blocking Issue': record['Operator Notes'] || 'Additional information requested by operator.',
//       'Manual Review?': 'YES',
//       'Manual Review Reason': record['Operator Notes'] || 'Additional information required.',
//       'Operator Action': ''
//     });
//     refreshSummaryRow_(record.__rowNumber);
//     return { ok: true, requestId: record['Request ID'], status: 'INFORMATION REQUESTED' };
//   }

//   function processApproved(options) {
//     return deps_().write.processApproved(options || {});
//   }

//   function reconcileSelected() {
//     var record = selected_();
//     return deps_().write.reconcileRequest(record.__rowNumber);
//   }

//   function completeSelected(options) {
//     options = options || {};
//     var d = deps_();
//     var record = selected_();
//     if (!record['Work Order ID']) throw new Error('A Work Order ID is required before completion.');
//     if (d.config.getDefault('REQUIRE_TASK_CONFIRMATION') && !record['Task ID']) {
//       throw new Error('A confirmed Task ID is required before completion.');
//     }
//     var outcome = record['Created Customer ID'] ? 'COMPLETED_NEW_CUSTOMER' :
//       (record['Existing Active Work Order ID'] ? 'COMPLETED_LINKED_EXISTING_WORK_ORDER' : 'COMPLETED_EXISTING_CUSTOMER');
//     d.util.updateRowObject('SERVICE_REQUESTS', record.__rowNumber, {
//       'Current Phase': d.config.getPhase('RECONCILIATION'),
//       'Request Status': 'COMPLETED',
//       'Current Stage': 'COMPLETED',
//       'Reconciliation Status': 'COMPLETE',
//       'Final Outcome': outcome,
//       'Completed At': d.util.nowString(),
//       'Last Reconciled At': d.util.nowString(),
//       'Next Action': ''
//     });
//     refreshSummaryRow_(record.__rowNumber);
//     return { ok: true, requestId: record['Request ID'], outcome: outcome };
//   }

//   return {
//     moduleName: MODULE_NAME,
//     version: VERSION,
//     previewSelectedAction: previewSelectedAction,
//     approveSelectedAction: approveSelectedAction,
//     executeSelectedAction: executeSelectedAction,
//     processApproved: processApproved,
//     reconcileSelected: reconcileSelected,
//     completeSelected: completeSelected
//   };
// })();

// CF.OperatorWorkflow = CF.Operator;
// CF.OperatorActions = CF.Operator;

