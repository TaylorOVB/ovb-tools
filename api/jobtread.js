// api/jobtread.js — OVB Tools · JobTread Proxy
// Deploy at /api/jobtread.js in repo root.
// Set JOBTREAD_GRANT_KEY in Vercel -> Settings -> Environment Variables.

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const grantKey = process.env.JOBTREAD_GRANT_KEY;
  if (!grantKey) return res.status(500).json({ error: 'JOBTREAD_GRANT_KEY not set in Vercel env vars' });

  const { operation, params = {} } = req.body || {};
  if (!operation) return res.status(400).json({ error: 'Missing operation' });

  try {
    let result;
    switch (operation) {
      case 'createCustomer': result = await createCustomer(grantKey, params); break;
      case 'getOrgInfo':     result = await getOrgInfo(grantKey); break;
      default: return res.status(400).json({ error: 'Unknown operation: ' + operation });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[jobtread proxy] ' + operation + ' error:', err.message);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
};

// Hardcoded customer field IDs from OVB JT account
// Sourced from getAccountFields on a populated customer 2026-03-21
var F = {
  status:             '22PC8F47A63H',
  customerType:       '22PC8EvauCvJ',
  budgetRange:        '22PTyjrdmBSZ',
  needs:              '22PC8EwY5jUc',
  leadSource:         '22PC8ExjK8js',
  referredBy:         '22PC8F6kzjw6',
  apptDateTime:       '22PRzSrKdQ9x',
  preferredContact:   '22PDggcWaQ7c',
  notes:              '22PC8F6Jsqf8',
  financingType:      '22PTyk3VEJgw',
  decisionMakers:     '22PTyk82js39',
  competingBids:      '22PTykAq8fQQ',
  timeline:           '22PTykFP3inv',
  projectLocation:    '22PTykJYuX3a',
  dqFlag:             '22PTykQuWm3Q',
  qualificationScore: '22PTykURtF6Z',
};

var BUDGET_MAP = {
  'Under $50K':   'Under $100K',
  'Under $100K':  'Under $100K',
  '$100K\u2013$200K':  '$100K - $200K',
  '$200K\u2013$400K':  '$200K - $400K',
  '$400K\u2013$600K':  '$400K - $600K',
  '$600K\u2013$800K':  '$600K - $800K',
  '$800K\u2013$1M':    '$800k - $1M',
  '$1M+':         '$1M+',
  'Not Sure':     'Not Sure',
};

async function pave(grantKey, queryObj) {
  var res = await fetch('https://api.jobtread.com/pave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: Object.assign({ $: { grantKey } }, queryObj) }),
  });
  var text = await res.text();
  if (!res.ok) throw new Error('Pave ' + res.status + ': ' + text.slice(0, 300));
  var data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Pave non-JSON: ' + text.slice(0, 200)); }
  if (data && data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  return data;
}

async function getOrgInfo(grantKey) {
  var grantData = await pave(grantKey, {
    currentGrant: {
      id: {},
      organization: { id: {}, name: {} },
    },
  });
  var org = (grantData && grantData.query && grantData.query.currentGrant && grantData.query.currentGrant.organization)
         || (grantData && grantData.currentGrant && grantData.currentGrant.organization);
  if (!org || !org.id) throw new Error('Could not get org from currentGrant.');
  return org;
}

async function createCustomer(grantKey, params) {
  var results = { steps: {} };

  // Step 1: get org ID
  var org = await getOrgInfo(grantKey);
  var orgId = org.id;
  if (!orgId) throw new Error('Could not retrieve org ID.');

  // Step 2: create account (name only)
  var createData = await pave(grantKey, {
    createAccount: {
      $: {
        name: params.name,
        type: 'customer',
        organizationId: orgId,
      },
      createdAccount: { id: {}, name: {} },
    },
  });

  var account = (createData && createData.query && createData.query.createAccount && createData.query.createAccount.createdAccount)
             || (createData && createData.createAccount && createData.createAccount.createdAccount);
  if (!account || !account.id) throw new Error('Account created but no ID returned.');

  var accountId = account.id;
  results.accountId   = accountId;
  results.accountName = account.name;
  results.url         = 'https://app.jobtread.com/accounts/' + accountId;
  results.steps.accountCreated = true;

  // Step 3: set custom fields using hardcoded IDs
  var customFieldValues = {};

  customFieldValues[F.status]             = '1. New Lead';
  if (params.customerType)   customFieldValues[F.customerType]    = params.customerType;
  if (params.budgetRange)    customFieldValues[F.budgetRange]     = BUDGET_MAP[params.budgetRange] || params.budgetRange;
  if (params.projectType)    customFieldValues[F.needs]           = params.projectType;
  if (params.leadSource)     customFieldValues[F.leadSource]      = params.leadSource;
  if (params.referredBy)     customFieldValues[F.referredBy]      = params.referredBy;
  if (params.contactMethod)  customFieldValues[F.preferredContact]= params.contactMethod;
  if (params.notes)          customFieldValues[F.notes]           = params.notes;
  if (params.financing)      customFieldValues[F.financingType]   = params.financing;
  if (params.decisionMakers) customFieldValues[F.decisionMakers]  = params.decisionMakers;
  if (params.competingBids)  customFieldValues[F.competingBids]   = params.competingBids;
  if (params.timeline)       customFieldValues[F.timeline]        = params.timeline;
  if (params.county)         customFieldValues[F.projectLocation] = params.county + ' County';
  if (params.dqFlag)         customFieldValues[F.dqFlag]          = params.dqFlag;
  if (params.qualificationScore) customFieldValues[F.qualificationScore] = params.qualificationScore;
  if (params.apptDate)       customFieldValues[F.apptDateTime]    = params.apptDate;

  results.steps.fieldsToSet = Object.keys(customFieldValues).length;

  await pave(grantKey, {
    updateAccount: {
      $: { id: accountId, customFieldValues: customFieldValues },
    },
  }).then(function() {
    results.steps.customFieldsSet = true;
  }).catch(function(err) {
    console.warn('[jobtread proxy] Custom fields:', err.message);
    results.steps.customFieldsError = err.message;
  });

  // Step 4: create contact (name only)
  await pave(grantKey, {
    createContact: {
      $: { accountId: accountId, name: params.name },
      createdContact: { id: {}, name: {} },
    },
  }).then(function(d) {
    var contactId = (d && d.query && d.query.createContact && d.query.createContact.createdContact && d.query.createContact.createdContact.id)
                 || (d && d.createContact && d.createContact.createdContact && d.createContact.createdContact.id);
    results.steps.contactCreated = true;

    // Step 4b: add phone
    if (contactId && params.phone) {
      pave(grantKey, {
        createPhoneNumber: {
          $: { contactId: contactId, number: params.phone, type: 'mobile' },
          createdPhoneNumber: { id: {} },
        },
      }).then(function() {
        results.steps.phoneCreated = true;
      }).catch(function(err) {
        results.steps.phoneError = err.message;
      });
    }
  }).catch(function(err) {
    console.warn('[jobtread proxy] Contact:', err.message);
    results.steps.contactError = err.message;
  });

  // Step 5: create location
  if (params.address) {
    var parts = params.address.split(',').map(function(s) { return s.trim(); });
    var street = parts[0] || params.address;
    var city   = parts[1] || '';

    await pave(grantKey, {
      createLocation: {
        $: Object.assign(
          { accountId: accountId, name: params.address, address1: street, state: 'UT' },
          city ? { city: city } : {}
        ),
        createdLocation: { id: {}, name: {} },
      },
    }).then(function() {
      results.steps.locationCreated = true;
    }).catch(function(err) {
      console.warn('[jobtread proxy] Location:', err.message);
      results.steps.locationError = err.message;
    });
  }

  return results;
}
