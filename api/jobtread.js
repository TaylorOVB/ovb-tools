// api/jobtread.js — OVB Tools · JobTread Proxy
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
      case 'updateJobSiteVisit':  result = await updateJobSiteVisit(grantKey, params);  break;
      case 'discoverFields':      result = await discoverFields(grantKey);               break;
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

// Returns flat map of { "Field Name": "fieldId" } for all org custom fields
async function getOrgCustomFields(grantKey, orgId) {
  var data = await pave(grantKey, {
    organization: {
      $: { id: orgId },
      customFields: {
        nodes: { id: {}, name: {} },
      },
    },
  });
  var nodes = (data && data.query && data.query.organization && data.query.organization.customFields && data.query.organization.customFields.nodes)
           || (data && data.organization && data.organization.customFields && data.organization.customFields.nodes)
           || [];
  var all = {};
  nodes.forEach(function(f) { all[f.name] = f.id; });
  // Return same map for both jobs and locations — scoping is handled by updateJob / updateLocation calls
  return { jobs: all, locations: all };
}

// Find a job by its display number (e.g. 747) — returns full job node or null
async function getJobByNumber(grantKey, orgId, jobNumber) {
  var data = await pave(grantKey, {
    jobs: {
      $: { organizationId: orgId },
      nodes: {
        id: {},
        number: {},
        name: {},
        locations: { nodes: { id: {}, name: {} } },
      },
    },
  });
  var nodes = (data && data.query && data.query.jobs && data.query.jobs.nodes)
           || (data && data.jobs && data.jobs.nodes)
           || [];
  return nodes.find(function(j) { return String(j.number) === String(jobNumber); }) || null;
}

// ─── Operations ───────────────────────────────────────────────────────────────

// Debug helper — call once via Postman or fetch to see all field IDs in account
async function discoverFields(grantKey) {
  var org = await getOrgInfo(grantKey);
  var fields = await getOrgCustomFields(grantKey, org.id);
  return { org: org, fields: fields };
}

// Push site visit data into an existing JT job
async function updateJobSiteVisit(grantKey, params) {
  var results = { steps: {} };

  // 1. Org
  var org = await getOrgInfo(grantKey);
  var orgId = org.id;

  // 2. Discover field IDs dynamically (no hardcoding needed for job/location fields)
  var fields = await getOrgCustomFields(grantKey, orgId);
  var JF = fields.jobs;
  var LF = fields.locations;
  results.steps.fieldsDiscovered = true;
  results.debug = { jobFieldNames: Object.keys(JF), locationFieldNames: Object.keys(LF) };

  // 3. Find the job
  if (!params.jobNumber) throw new Error('jobNumber is required.');
  var job = await getJobByNumber(grantKey, orgId, params.jobNumber);
  if (!job) throw new Error('Job #' + params.jobNumber + ' not found. Check the number and try again.');
  var jobId = job.id;
  results.jobId   = jobId;
  results.jobName = job.name;
  results.url     = 'https://app.jobtread.com/jobs/' + jobId;
  results.steps.jobFound = true;

  // 4. Update job-level fields
  var jobFieldValues = {};

  // Advance status to Estimating
  if (JF['Job Status']) jobFieldValues[JF['Job Status']] = 'Estimating';

  // Write the full site visit note block into Notes
  if (JF['Notes'] && params.noteBlock) {
    jobFieldValues[JF['Notes']] = params.noteBlock;
  }

  // Next action date
  if (JF['Next Action Date'] && params.nextDate) {
    jobFieldValues[JF['Next Action Date']] = params.nextDate;
  }

  if (Object.keys(jobFieldValues).length > 0) {
    await pave(grantKey, {
      updateJob: { $: { id: jobId, customFieldValues: jobFieldValues } },
    }).then(function() {
      results.steps.jobFieldsUpdated = true;
    }).catch(function(err) {
      console.warn('[jobtread proxy] updateJob fields:', err.message);
      results.steps.jobFieldsError = err.message;
    });
  }

  // 5. Update location fields
  var location = job.locations && job.locations.nodes && job.locations.nodes[0];
  if (location && location.id) {
    var locFieldValues = {};

    if (LF['Foundation Type'] && params.foundType)
      locFieldValues[LF['Foundation Type']] = normalizeFoundationType(params.foundType);

    // Basement Type — derive from foundation type
    if (LF['Basement Type'] && params.foundType) {
      var ft = params.foundType.toLowerCase().replace(/\s/g, '');
      if (ft === 'fullbasement' || ft === 'walkoutbasement') {
        locFieldValues[LF['Basement Type']] = params.foundType;
      }
    }

    if (LF['Entry Code'] && params.entryCode)
      locFieldValues[LF['Entry Code']] = params.entryCode;

    if (LF['Site Access Notes'] && params.siteAccess)
      locFieldValues[LF['Site Access Notes']] = params.siteAccess;

    if (LF['Lot Size / Acreage'] && params.lotSize)
      locFieldValues[LF['Lot Size / Acreage']] = params.lotSize;

    if (LF['Utility Status'] && params.utilities)
      locFieldValues[LF['Utility Status']] = normalizeUtilityStatus(params.utilities);

    if (LF['Staging Area'] && params.staging)
      locFieldValues[LF['Staging Area']] = params.staging;

    if (LF['Subdivision / HOA'] && params.hoaName)
      locFieldValues[LF['Subdivision / HOA']] = params.hoaName;

    // Location notes — scope description
    if (LF['Notes'] && params.scopeDesc)
      locFieldValues[LF['Notes']] = params.scopeDesc;

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
