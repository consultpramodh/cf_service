const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'CF_ServiceOps_V2_Shadow_Resolver.gs'), 'utf8');

function runCase(name, row, remotes, expectedNext, extraChecks) {
  const calls = [];
  const context = {
    CF: {
      Util: {
        findRecord: (sheet, field, id) => id === row['Request ID'] ? row : null,
        readRecords: () => [row]
      },
      StrivenHttp: {
        requestJson: (path, opts) => {
          calls.push({ path, method: String(opts.method || 'get').toLowerCase() });
          assert.strictEqual(String(opts.method || 'get').toLowerCase(), 'get', name + ': mutation method called');
          if (path.includes('/customers/')) return { json: remotes.customer };
          if (path.includes('/contacts/')) return { json: remotes.contact };
          throw new Error('unexpected path ' + path);
        }
      }
    },
    console
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  const out = context.CF.V2ShadowResolver.inspectRequest(row['Request ID']);
  assert.strictEqual(out.nextRequiredFact, expectedNext, name + ': wrong nextRequiredFact');
  assert.strictEqual(out.liveWriteExecuted, false);
  assert.strictEqual(out.safety.strivenMutationExecuted, false);
  assert.ok(calls.every(c => c.method === 'get'), name + ': non-GET call');
  if (extraChecks) extraChecks(out, calls);
  return { name, nextRequiredFact: out.nextRequiredFact, calls: calls.length };
}

const baseRow = {
  'Request ID': 'SR-TEST-1',
  'First Name': 'Jane', 'Last Name': 'Doe', 'Full Name': 'Jane Doe',
  'Phone': '(416) 555-1000', 'Normalized Phone': '4165551000',
  'Alt Phone': '(647) 555-2000', 'Normalized Alt Phone': '6475552000',
  'Email': 'jane@example.com', 'Normalized Email': 'jane@example.com',
  'Matched Customer ID': '100', 'Created Customer ID': '',
  'Matched Contact ID': '200', 'Created Contact ID': '',
  'Matched Location ID': '300', 'Created Location ID': '',
  'Location Match Status': 'MATCHED',
  'Customer Structure Status': 'COMPLETE',
  'Reconciliation Status': 'SALES ORDER 585999 VERIFIED',
  'Current Stage': 'SALES ORDER CREATED',
  'Work Order Status': 'Quoted', 'Work Order ID': '400', 'Work Order Number': '585999'
};

const customerComplete = {
  Id: 100, Name: 'Jane Doe',
  Phones: [{ Number: '4165551000' }, { Number: '6475552000' }],
  Emails: [{ Email: 'jane@example.com' }]
};
const contactComplete = {
  Id: 200, FirstName: 'Jane', LastName: 'Doe',
  Phones: [{ Number: '4165551000' }, { Number: '6475552000' }],
  Emails: [{ Email: 'jane@example.com' }],
  CustomerAssociations: [{ Id: 100 }]
};

const results = [];
results.push(runCase('complete', { ...baseRow }, { customer: customerComplete, contact: contactComplete }, 'COMPLETE'));
results.push(runCase('customer email missing', { ...baseRow, 'Request ID': 'SR-TEST-2' }, {
  customer: { ...customerComplete, Emails: [] }, contact: contactComplete
}, 'CUSTOMER_EMAIL_CONFIRMED', out => assert.strictEqual(out.facts.customer.email.status, 'MISSING')));

const noEmailShape = { ...customerComplete }; delete noEmailShape.Emails;
results.push(runCase('customer email API shape unresolved', { ...baseRow, 'Request ID': 'SR-TEST-3' }, {
  customer: noEmailShape, contact: contactComplete
}, 'CUSTOMER_EMAIL_CONFIRMED', out => assert.strictEqual(out.facts.customer.email.status, 'API_FIELD_UNRESOLVED')));

results.push(runCase('relationship missing', { ...baseRow, 'Request ID': 'SR-TEST-4' }, {
  customer: customerComplete, contact: { ...contactComplete, CustomerAssociations: [] }
}, 'RELATIONSHIP_CONFIRMED', out => assert.strictEqual(out.facts.relationship.status, 'MISSING')));

results.push(runCase('contact email missing', { ...baseRow, 'Request ID': 'SR-TEST-5' }, {
  customer: customerComplete, contact: { ...contactComplete, Emails: [] }
}, 'CONTACT_EMAIL_CONFIRMED', out => assert.strictEqual(out.facts.contact.email.status, 'MISSING')));

results.push(runCase('customer phone missing', { ...baseRow, 'Request ID': 'SR-TEST-6' }, {
  customer: { ...customerComplete, Phones: [{ Number: '4165551000' }] }, contact: contactComplete
}, 'CUSTOMER_PHONE_CONFIRMED', out => {
  assert.strictEqual(out.facts.customer.phone.status, 'MISSING');
  assert.deepStrictEqual(Array.from(out.facts.customer.phone.missing), ['6475552000']);
}));

const conflictRow = { ...baseRow, 'Request ID': 'SR-TEST-7', 'Created Customer ID': '999' };
results.push(runCase('customer durable ID conflict', conflictRow, { customer: customerComplete, contact: contactComplete }, 'CUSTOMER_CONFIRMED', (out, calls) => {
  assert.strictEqual(out.facts.customer.idState.status, 'ID_CONFLICT');
  assert.ok(!calls.some(c => c.path.includes('/customers/')));
}));

console.log(JSON.stringify({ status: 'PASS', tests: results }, null, 2));
