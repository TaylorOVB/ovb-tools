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
      case 'createCustomer':      result = await createCustomer(grantKey, params);      break;
      case 'getOrgInfo':          result = await getOrgInfo(grantKey);                   break;
      case 'getContact':          result = await getContact(grantKey, params);           break;
      case 'updateJobSiteVisit':      result = await updateJobSiteVisit(grantKey, params);      break;
      case 'discoverFields':          result = await discoverFields(grantKey);                   break;
      case 'discoverLocationFields':  result = await discoverLocationFields(grantKey, params);  break;
      default: return res.status(400).json({ error: 'Unknown operation: ' + operation });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[jobtread proxy] ' + operation + ' error:', err.message);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
};

// ─── Customer field IDs (hardcoded from OVB JT account 2026-03-21) ───────────

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

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeBudget(val) {
  if (!val) return val;
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
  var key = val.toLowerCase().replace(/[\s\-\u2013\u2014]/g, '');
  return lookup[key] || val;
}

function normalizeFinancing(val) {
  var map = {
    'cash':              'Cash',
    'heloc':             'HELOC',
    'constructionloan':  'Construction Loan',
    'financingready':    'Construction Loan',
    'exploringoptions':  'Unknown - Needs Guidance',
    'notsure':           'Unknown',
    'unknown':           'Unknown',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\-]/g, '');
  return map[key] || val;
}

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

function normalizeQualScore(val) {
  if (!val) return val;
  var v = val.toLowerCase();
  if (v.indexOf('hot') !== -1)  return 'Hot';
  if (v.indexOf('warm') !== -1) return 'Warm';
  if (v.indexOf('dq') !== -1)   return "DQ'd";
  if (v.indexOf('cold') !== -1 || v.indexOf('filler') !== -1) return 'Cold';
  return val;
}

// Map site visit utility status → JT Location picklist value
function normalizeUtilityStatus(val) {
  var map = {
    'allconnected': 'All Connected',
    'partial':      'Partial',
    'none':         'None on Site',
    'unknown':      'Unknown',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\/]/g, '');
  return map[key] || val;
}

// Map foundation type → JT Location picklist
function normalizeFoundationType(val) {
  var map = {
    'slab':             'Slab',
    'crawlspace':       'Crawl Space',
    'fullbasement':     'Full Basement',
    'walkoutbasement':  'Walkout Basement',
    'stemwall':         'Stem Wall',
    'unknown':          'Unknown',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\/]/g, '');
  return map[key] || val;
}

// ─── Core Pave helper ─────────────────────────────────────────────────────────

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

// ─── Shared helpers ───────────────────────────────────────────────────────────

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

// ─── Hardcoded field IDs from OVB JT account (sourced via discoverLocationFields 2026-03-25) ───

// Job-level custom field IDs
var JF = {
  jobStatus: '22P93aBUAE5W',
};

// Location-level custom field IDs
var LF = {
  foundationType:  '22PC8EYPHWPT',
  basementType:    '22PDgc8VnatZ',
  entryCode:       '22PCKKNmNkkQ',
  notes:           '22PC8EYhkE3E',
  siteAccessNotes: '22PDgcBpz8ng',
  lotSize:         '22PDgcDmaB2R',
  utilityStatus:   '22PDgcVExe9m',
  permitNumber:    '22PDgcXqRe8v',
  subdivisionHOA:  '22PDgcZLYaLb',
  stagingArea:     '22PDgcadTyVp',
};

// No longer needed — IDs are hardcoded above
// async function getOrgCustomFields() {}


// Find a job by its display number (e.g. 747) — returns full job node or null
async function getJobByNumber(grantKey, orgId, jobNumber) {
  var data = await pave(grantKey, {
    organization: {
      $: { id: orgId },
      jobs: {
        $: { number: parseInt(jobNumber, 10) },
        nodes: {
          id: {},
          number: {},
          name: {},
          location: { id: {}, name: {} },
        },
      },
    },
  });
  var nodes = (data && data.query && data.query.organization && data.query.organization.jobs && data.query.organization.jobs.nodes)
           || (data && data.organization && data.organization.jobs && data.organization.jobs.nodes)
           || [];
  return nodes[0] || null;
}

// ─── Operations ───────────────────────────────────────────────────────────────

// Debug helper — returns org info and hardcoded field ID map
async function discoverFields(grantKey) {
  var org = await getOrgInfo(grantKey);
  return { org: org, fields: { jobs: JF, locations: LF } };
}

// Fetch a location's custom field values directly to discover location field IDs
async function discoverLocationFields(grantKey, params) {
  var org = await getOrgInfo(grantKey);
  var job = await getJobByNumber(grantKey, org.id, params.jobNumber);
  if (!job) throw new Error('Job #' + params.jobNumber + ' not found.');
  if (!job.location || !job.location.id) throw new Error('Job has no location attached.');

  var data = await pave(grantKey, {
    location: {
      $: { id: job.location.id },
      id: {},
      name: {},
      customFieldValues: {
        nodes: {
          id: {},
          value: {},
          customField: { id: {}, name: {} },
        },
      },
    },
  });

  var loc = (data && data.query && data.query.location) || (data && data.location);
  return {
    jobName: job.name,
    locationId: job.location.id,
    locationName: job.location.name,
    customFields: loc && loc.customFieldValues && loc.customFieldValues.nodes
      ? loc.customFieldValues.nodes.map(function(n) {
          return { fieldName: n.customField && n.customField.name, fieldId: n.customField && n.customField.id, currentValue: n.value };
        })
      : [],
    rawLocation: loc,
  };
}

// Push site visit data into an existing JT job
async function updateJobSiteVisit(grantKey, params) {
  var results = { steps: {} };

  // 1. Org
  var org = await getOrgInfo(grantKey);
  var orgId = org.id;

  // 2. Find the job by number
  if (!params.jobNumber) throw new Error('jobNumber is required.');
  var job = await getJobByNumber(grantKey, orgId, params.jobNumber);
  if (!job) throw new Error('Job #' + params.jobNumber + ' not found. Check the number and try again.');
  var jobId = job.id;
  results.jobId   = jobId;
  results.jobName = job.name;
  results.url     = 'https://app.jobtread.com/jobs/' + jobId;
  results.steps.jobFound = true;

  // 3. Update job-level fields
  var jobFieldValues = {};
  jobFieldValues[JF.jobStatus] = 'Estimating';
  if (params.noteBlock) jobFieldValues['22PC8F6Jsqf8'] = params.noteBlock; // Job Notes field (same as customer notes)

  await pave(grantKey, {
    updateJob: { $: { id: jobId, customFieldValues: jobFieldValues } },
  }).then(function() {
    results.steps.jobFieldsUpdated = true;
  }).catch(function(err) {
    console.warn('[jobtread proxy] updateJob fields:', err.message);
    results.steps.jobFieldsError = err.message;
  });

  // 4. Update location fields
  var location = job.location;
  if (location && location.id) {
    var locFieldValues = {};

    if (params.foundType)  locFieldValues[LF.foundationType]  = normalizeFoundationType(params.foundType);
    if (params.entryCode)  locFieldValues[LF.entryCode]       = params.entryCode;
    if (params.siteAccess) locFieldValues[LF.siteAccessNotes] = params.siteAccess;
    if (params.lotSize)    locFieldValues[LF.lotSize]         = params.lotSize;
    if (params.utilities)  locFieldValues[LF.utilityStatus]   = normalizeUtilityStatus(params.utilities);
    if (params.staging)    locFieldValues[LF.stagingArea]     = params.staging;
    if (params.hoaName)    locFieldValues[LF.subdivisionHOA]  = params.hoaName;
    if (params.scopeDesc)  locFieldValues[LF.notes]           = params.scopeDesc;

    // Basement Type — derive from foundation type
    if (params.foundType) {
      var ft = params.foundType.toLowerCase().replace(/\s/g, '');
      if (ft === 'fullbasement' || ft === 'walkoutbasement') {
        locFieldValues[LF.basementType] = params.foundType;
      }
    }

    if (Object.keys(locFieldValues).length > 0) {
      await pave(grantKey, {
        updateLocation: { $: { id: location.id, customFieldValues: locFieldValues } },
      }).then(function() {
        results.steps.locationFieldsUpdated = true;
      }).catch(function(err) {
        console.warn('[jobtread proxy] updateLocation fields:', err.message);
        results.steps.locationFieldsError = err.message;
      });
    }
  } else {
    results.steps.locationSkipped = 'No location found on this job — location fields not updated.';
  }

  return results;
}

// ─── Existing operations (unchanged) ─────────────────────────────────────────

async function createCustomer(grantKey, params) {
  var results = { steps: {} };

  var org = await getOrgInfo(grantKey);
  var orgId = org.id;
  if (!orgId) throw new Error('Could not retrieve org ID.');

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
