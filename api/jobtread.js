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
      case 'getContact':     result = await getContact(grantKey, params); break;
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
var CF = {
  phone: '22P93aBeTXDg',
  email: '22P93aBU4cbB',
};

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

function normalizeBudget(val) {
  if (!val) return val;
  // Strip spaces, normalize all dash variants, lowercase for comparison
  var lookup = {
    'under$50k':  'Under $100K',
    'under$100k': 'Under $100K',
    '$100k$200k': '$100K-$200K',
    '$200k$400k': '$200K-$400K',
    '$400k$600k': '$400K-$600K',
    '$600k$800k': '$600K-$800K',
    '$800k$1m':   '$800K-$1M',
    '$1m+':       '$1M+',
    'notsure':    'Not Sure',
  };
  // Remove all spaces, dashes, en-dashes, em-dashes then lowercase
  var key = val.toLowerCase().replace(/[\s\-\u2013\u2014]/g, '');
  return lookup[key] || val;
}

// Map financing form values to JT picklist
function normalizeFinancing(val) {
  var map = {
    'cash':              'Cash',
    'heloc':             'HELOC',
    'constructionloan':  'Construction Loan',
    'financingready':    'Construction Loan',  // closest match
    'exploringoptions':  'Unknown - Needs Guidance',
    'notsure':           'Unknown',
    'unknown':           'Unknown',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\-]/g, '');
  return map[key] || val;
}

// Map decision makers form values to JT picklist
function normalizeDM(val) {
  var map = {
    'solo':                 'Solo',
    'singledm':             'Solo',
    'spouseinvolved':       'Spouse Involved',
    'multipledms':          'Multiple Stakeholders',
    'multiplestakeholders': 'Multiple Stakeholders',
    'unknown':              'Unknown',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\-]/g, '');
  return map[key] || val;
}

// Map timeline form values to JT picklist
function normalizeTimeline(val) {
  var map = {
    'asap':          'ASAP',
    '13months':      '1-3 Months',
    '1-3months':     '1-3 Months',
    '36months':      '3-6 Months',
    '3-6months':     '3-6 Months',
    '612months':     '6-12 Months',
    '6-12months':    '6-12 Months',
    'justplanning':  'Planning Phase',
    'planningphase': 'Planning Phase',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\u2013\u2014]/g, '');
  return map[key] || val;
}

// Strip pts from qualification score, map to JT options: Hot/Warm/Cold/DQ'd
function normalizeQualScore(val) {
  if (!val) return val;
  var v = val.toLowerCase();
  if (v.indexOf('hot') !== -1)  return 'Hot';
  if (v.indexOf('warm') !== -1) return 'Warm';
  if (v.indexOf('dq') !== -1)   return "DQ'd";
  if (v.indexOf('cold') !== -1 || v.indexOf('filler') !== -1) return 'Cold';
  return val;
}

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
  results.url         = 'https://app.jobtread.com/customers/' + accountId;
  results.steps.accountCreated = true;

  // Step 3: set custom fields using hardcoded IDs
  var customFieldValues = {};

  customFieldValues[F.status]             = '1. New Lead';
  if (params.customerType)   customFieldValues[F.customerType]    = params.customerType;
  if (params.budgetRange)    customFieldValues[F.budgetRange]     = normalizeBudget(params.budgetRange);
  if (params.leadSource)     customFieldValues[F.leadSource]      = params.leadSource;
  if (params.referredBy)     customFieldValues[F.referredBy]      = params.referredBy;
  if (params.contactMethod)  customFieldValues[F.preferredContact]= params.contactMethod;
  if (params.notes)          customFieldValues[F.notes]           = params.notes;
  if (params.financing)      customFieldValues[F.financingType]   = normalizeFinancing(params.financing);
  if (params.decisionMakers) customFieldValues[F.decisionMakers]  = normalizeDM(params.decisionMakers);
  if (params.competingBids)  customFieldValues[F.competingBids]   = params.competingBids;
  if (params.timeline)       customFieldValues[F.timeline]        = normalizeTimeline(params.timeline);
  if (params.county)         customFieldValues[F.projectLocation] = params.county + ' County';
  if (params.dqFlag) {
    // JT DQ Flag options: Budget, Location, Scope, Timeline, None
    var dqMap = {'yes':'Budget','no':'None','none':'None','budget':'Budget','location':'Location','scope':'Scope','timeline':'Timeline'};
    var dqKey = params.dqFlag.toLowerCase();
    customFieldValues[F.dqFlag] = dqMap[dqKey] || params.dqFlag;
  }
  if (params.qualificationScore) customFieldValues[F.qualificationScore] = normalizeQualScore(params.qualificationScore);
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

  // Step 4: create contact, then update with phone + email
  try {
    var contactData = await pave(grantKey, {
      createContact: {
        $: { accountId: accountId, name: params.name },
        createdContact: { id: {}, name: {} },
      },
    });
    var contactId = (contactData && contactData.query && contactData.query.createContact && contactData.query.createContact.createdContact && contactData.query.createContact.createdContact.id)
                 || (contactData && contactData.createContact && contactData.createContact.createdContact && contactData.createContact.createdContact.id);
    results.steps.contactCreated = true;

    // Step 4b: update contact with phone + email via customFieldValues
    if (contactId && (params.phone || params.email)) {
      var contactFieldValues = {};
      if (params.phone) {
        var digits = params.phone.replace(/[^0-9]/g, '');
        contactFieldValues[CF.phone] = (digits.length === 10 ? '+1' : '+') + digits;
      }
      if (params.email) {
        contactFieldValues[CF.email] = params.email;
      }
      await pave(grantKey, {
        updateContact: {
          $: { id: contactId, customFieldValues: contactFieldValues },
        },
      });
      results.steps.contactUpdated = true;
    }
  } catch(err) {
    console.warn('[jobtread proxy] Contact:', err.message);
    results.steps.contactError = err.message;
  }

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

async function getContact(grantKey, params) {
  // Get contacts for account including their custom field values (phone/email are custom field types)
  return await pave(grantKey, {
    account: {
      $: { id: params.accountId },
      contacts: {
        nodes: {
          id: {},
          name: {},
          customFieldValues: {
            nodes: {
              id: {},
              value: {},
              customField: { id: {}, name: {}, type: {} },
            }
          },
        }
      },
    },
  });
}
