// api/jobtread.js — OVB Tools · JobTread Proxy
// Deploy at /api/jobtread.js in repo root.
// Set JOBTREAD_GRANT_KEY in Vercel -> Settings -> Environment Variables.

// Only these origins may call this proxy. Anything else gets a 403.
var ALLOWED_ORIGINS = [
  'https://tools.ogdenvalleybuilders.com',
  'https://www.ogdenvalleybuilders.com',
  'https://ogdenvalleybuilders.com',
  'http://localhost:3000',
];

// Read operations are safe. Write operations change data in JobTread and
// require the WRITE_TOKEN header on top of the origin check.
var READ_OPS = {
  getOrgInfo: 1, getContact: 1, discoverFields: 1,
  discoverLocationFields: 1, discoverJobFields: 1,
  dashboard: 1, activeJobs: 1, pipeline: 1, receivables: 1, payables: 1,
};
var WRITE_OPS = { createCustomer: 1, updateJobSiteVisit: 1 };

function resolveOrigin(req) {
  var origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return origin;
  // Vercel preview deployments
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return origin;
  return null;
}

module.exports = async function handler(req, res) {
  var allowed = resolveOrigin(req);

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-OVB-Write-Token');
    res.setHeader('Vary', 'Origin');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Same-origin calls from the tools site send no Origin header. Browser calls
  // from anywhere else do, and must be on the list.
  if (req.headers.origin && !allowed) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const grantKey = process.env.JOBTREAD_GRANT_KEY;
  if (!grantKey) return res.status(500).json({ error: 'JOBTREAD_GRANT_KEY not set in Vercel env vars' });

  const { operation, params = {} } = req.body || {};
  if (!operation) return res.status(400).json({ error: 'Missing operation' });
  if (!READ_OPS[operation] && !WRITE_OPS[operation]) {
    return res.status(400).json({ error: 'Unknown operation: ' + operation });
  }

  // Writes need a shared secret. Set OVB_WRITE_TOKEN in Vercel and send it as
  // the X-OVB-Write-Token header from any tool that creates or updates records.
  if (WRITE_OPS[operation]) {
    var expected = process.env.OVB_WRITE_TOKEN;
    if (expected && req.headers['x-ovb-write-token'] !== expected) {
      return res.status(403).json({ error: 'Write token missing or invalid' });
    }
  }

  try {
    let result;
    switch (operation) {
      // ── reads ──
      case 'dashboard':               result = await dashboard(grantKey, params);                break;
      case 'activeJobs':              result = await activeJobs(grantKey, params);               break;
      case 'pipeline':                result = await pipeline(grantKey, params);                 break;
      case 'receivables':             result = await receivables(grantKey, params);              break;
      case 'payables':                result = await payables(grantKey, params);                 break;
      case 'getOrgInfo':              result = await getOrgInfo(grantKey);                       break;
      case 'getContact':              result = await getContact(grantKey, params);               break;
      case 'discoverFields':          result = await discoverFields(grantKey);                   break;
      case 'discoverLocationFields':  result = await discoverLocationFields(grantKey, params);   break;
      case 'discoverJobFields':       result = await discoverJobFields(grantKey, params);        break;
      // ── writes ──
      case 'createCustomer':          result = await createCustomer(grantKey, params);           break;
      case 'updateJobSiteVisit':      result = await updateJobSiteVisit(grantKey, params);       break;
    }
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', allowed);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Cache-Control', 'no-store');
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
    'allconnected':      'All Utilities Active',
    'allutilitiesactive':'All Utilities Active',
    'partial':           'Partial',
    'none':              'None on Site',
    'noneonsite':        'None on Site',
    'unknown':           'Unknown',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\/]/g, '');
  return map[key] || val;
}

// Map foundation type form values → exact JT picklist values
function normalizeFoundationType(val) {
  var map = {
    'slab':                       'Slab on Grade',
    'slabongrade':                'Slab on Grade',
    'crawlspace':                 'Crawlspace',
    'crawl space':                'Crawlspace',
    'stemwall':                   'Stem Wall w/ CrawlSpace',
    'stem wall':                  'Stem Wall w/ CrawlSpace',
    'stemwallwcrawlspace':        'Stem Wall w/ CrawlSpace',
    'fullbasement':               'Full Basement Foundation',
    'full basement':              'Full Basement Foundation',
    'fullbasementfoundation':     'Full Basement Foundation',
    'walkoutbasement':            'Walk-Out Basement Foundation',
    'walk-out basement':          'Walk-Out Basement Foundation',
    'walkoutbasementfoundation':  'Walk-Out Basement Foundation',
    'daylightbasement':           'Daylight Basement Foundation',
    'daylight basement':          'Daylight Basement Foundation',
    'pierbeam':                   'Pier & Beam',
    'pier & beam':                'Pier & Beam',
    'posttensionslab':            'Post-Tension Slab',
    'unknown':                    'Other (Specify in Notes)',
  };
  if (!val) return val;
  var key = val.toLowerCase().replace(/[\s\-\/]/g, '');
  return map[key] || map[val.toLowerCase()] || val;
}

// Map basement type — derived from foundation type selection
function normalizeBasementType(foundVal) {
  var map = {
    'fullbasement':              'Full Basement',
    'fullbasementfoundation':    'Full Basement',
    'walkoutbasement':           'Walk-Out Basement',
    'walkoutbasementfoundation': 'Walk-Out Basement',
    'daylightbasement':          'Daylight Basement',
    'daylightbasementfoundation':'Daylight Basement',
    'crawlspace':                'Crawl Space with Basement Area',
    'stemwallwcrawlspace':       'Crawl Space with Basement Area',
  };
  if (!foundVal) return null;
  var key = foundVal.toLowerCase().replace(/[\s\-\/]/g, '');
  return map[key] || null;
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

// ─── Hardcoded field IDs from OVB JT account (sourced via discoverJobFields 2026-03-25) ───

// Job-level custom field IDs
var JF = {
  jobStatus:        '22P93aBUAE5W',
  notes:            '22PCKJxczTan',
  nextActionDate:   '22PDggbMJDHR',
  contractSigned:   '22PDgbGJVmnq',
  constructionStart:'22PPS4N7rqS',
  targetCompletion: '22PS4NBhVfJA',
  siteVisitDate:    '22PUQqSahKCE',
  // TODO: set a value on job 702 for these 3 fields then run discoverJobFields to get IDs
  plansStatus:      null,
  occupied:         null,
  structuralConcerns: null,
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
  return nodes.find(function(j) { return String(j.number) === String(jobNumber); }) || null;
}

// ─── Operations ───────────────────────────────────────────────────────────────

// Debug helper — returns org info and hardcoded field ID map
async function discoverFields(grantKey) {
  var org = await getOrgInfo(grantKey);
  return { org: org, hardcodedJobFields: JF, hardcodedLocationFields: LF };
}

// Fetch a job's custom field values to discover job-level field IDs
async function discoverJobFields(grantKey, params) {
  var org = await getOrgInfo(grantKey);
  var job = await getJobByNumber(grantKey, org.id, params.jobNumber);
  if (!job) throw new Error('Job #' + params.jobNumber + ' not found.');

  var data = await pave(grantKey, {
    job: {
      $: { id: job.id },
      id: {},
      name: {},
      number: {},
      customFieldValues: {
        nodes: {
          id: {},
          value: {},
          customField: { id: {}, name: {} },
        },
      },
    },
  });

  var j = (data && data.query && data.query.job) || (data && data.job);
  return {
    jobName: job.name,
    jobId: job.id,
    customFields: j && j.customFieldValues && j.customFieldValues.nodes
      ? j.customFieldValues.nodes.map(function(n) {
          return { fieldName: n.customField && n.customField.name, fieldId: n.customField && n.customField.id, currentValue: n.value };
        })
      : [],
  };
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
  if (params.noteBlock)   jobFieldValues[JF.notes]          = params.noteBlock;
  if (params.nextDate)    jobFieldValues[JF.nextActionDate]  = params.nextDate;
  if (params.visitDate)   jobFieldValues[JF.siteVisitDate]   = params.visitDate;
  if (params.plansStatus  && JF.plansStatus)         jobFieldValues[JF.plansStatus]         = params.plansStatus;
  if (params.occupied     && JF.occupied)            jobFieldValues[JF.occupied]            = params.occupied;
  if (params.structural   && JF.structuralConcerns)  jobFieldValues[JF.structuralConcerns]  = params.structural;

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

    // Basement Type — derived from foundation type using exact JT picklist values
    var basementVal = normalizeBasementType(params.foundType);
    if (basementVal) locFieldValues[LF.basementType] = basementVal;

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

// ─── Dashboard read operations ────────────────────────────────────────────────
// Job Status custom field: 22P93aBUAE5W
// Values in use: Pending Site Visit · Estimating · Contract Pending ·
//                Construction - In Progress · Commissioning · On Hold ·
//                Lost · Cancelled

var JOB_STATUS_FIELD = '22P93aBUAE5W';
var BUILD_STATUSES    = ['Construction - In Progress', 'Commissioning'];
var PIPELINE_STATUSES = ['Pending Site Visit', 'Estimating', 'Contract Pending'];

// Jobs whose name matches this are excluded from every dashboard read.
var EXCLUDE_NAME = /^(ZZ|TEST|PRACTICE)/i;

function unwrap(data, key) {
  return (data && data.query && data.query[key]) || (data && data[key]) || null;
}

function statusOf(node) {
  var n = node && node.customFieldValues && node.customFieldValues.nodes;
  return (n && n.length && n[0].value) || null;
}

function round2(n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : n;
}

// Pull open jobs once, tagged with status, so callers can slice them.
async function fetchJobsByStatus(grantKey, statuses, size) {
  var org = await getOrgInfo(grantKey);
  var data = await pave(grantKey, {
    organization: {
      $: { id: org.id },
      jobs: {
        $: { where: ['closedOn', null], size: size || 100 },
        nodes: {
          id: {}, number: {}, name: {}, priceType: {}, createdAt: {},
          projectedPriceWithTax: {}, actualCost: {},
          taskSummary: { progress: {}, endDate: {}, startDate: {} },
          location: { formattedAddress: {} },
          customFieldValues: {
            $: { where: [['customField', 'id'], JOB_STATUS_FIELD], size: 1 },
            nodes: { value: {} },
          },
        },
      },
    },
  });

  var nodes = (unwrap(data, 'organization') || {}).jobs;
  nodes = (nodes && nodes.nodes) || [];

  return nodes
    .filter(function (j) { return !EXCLUDE_NAME.test(j.name || ''); })
    .map(function (j) {
      var price = j.projectedPriceWithTax;
      var cost  = j.actualCost;
      return {
        id: j.id,
        number: j.number,
        name: j.name,
        status: statusOf(j),
        priceType: j.priceType,
        projectedPrice: round2(price),
        actualCost: round2(cost),
        percentSpent: (price && cost) ? Math.round((cost / price) * 100) : null,
        progress: j.taskSummary && typeof j.taskSummary.progress === 'number'
          ? Math.round(j.taskSummary.progress * 100) : null,
        endDate: j.taskSummary && j.taskSummary.endDate,
        address: j.location && j.location.formattedAddress,
        createdAt: j.createdAt,
        url: 'https://app.jobtread.com/jobs/' + j.id,
      };
    })
    .filter(function (j) { return !statuses || statuses.indexOf(j.status) !== -1; });
}

// Jobs actually under construction or in commissioning.
async function activeJobs(grantKey) {
  var jobs = await fetchJobsByStatus(grantKey, BUILD_STATUSES);
  jobs.sort(function (a, b) { return (b.progress || 0) - (a.progress || 0); });
  return { count: jobs.length, jobs: jobs };
}

// Leads and estimates still in play. Excludes On Hold, Lost, Cancelled.
async function pipeline(grantKey) {
  var jobs = await fetchJobsByStatus(grantKey, PIPELINE_STATUSES);
  jobs.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { count: jobs.length, jobs: jobs };
}

// Unpaid customer invoices. NOTE: reflects JobTread only — a payment recorded
// in QuickBooks but not in JT will still show as open here.
async function receivables(grantKey) {
  var org = await getOrgInfo(grantKey);
  var today = new Date().toISOString().slice(0, 10);
  var data = await pave(grantKey, {
    organization: {
      $: { id: org.id },
      documents: {
        $: {
          where: { and: [['type', 'customerInvoice'], ['balance', '!=', 0]] },
          size: 50,
          sortBy: [{ field: 'dueDate', order: 'asc' }],
        },
        count: {},
        sum: { $: 'balance' },
        nodes: {
          id: {}, fullName: {}, status: {}, issueDate: {}, dueDate: {},
          priceWithTax: {}, amountPaid: {}, balance: {},
          job: { number: {}, name: {} },
        },
      },
    },
  });

  var docs = (unwrap(data, 'organization') || {}).documents || {};
  var nodes = (docs.nodes || []).map(function (d) {
    var overdue = d.dueDate && d.dueDate < today;
    return {
      id: d.id,
      name: d.fullName,
      status: d.status,
      jobNumber: d.job && d.job.number,
      jobName: d.job && d.job.name,
      issueDate: d.issueDate,
      dueDate: d.dueDate,
      balance: round2(d.balance),
      overdue: !!overdue,
      daysOverdue: overdue
        ? Math.round((new Date(today) - new Date(d.dueDate)) / 86400000) : 0,
      url: 'https://app.jobtread.com/documents/' + d.id,
    };
  });

  return {
    count: docs.count || nodes.length,
    total: round2(docs.sum || 0),
    overdueTotal: round2(nodes.reduce(function (s, d) { return s + (d.overdue ? d.balance : 0); }, 0)),
    invoices: nodes,
  };
}

// Unpaid vendor bills. Same JobTread-only caveat as receivables.
async function payables(grantKey) {
  var org = await getOrgInfo(grantKey);
  var today = new Date().toISOString().slice(0, 10);
  var data = await pave(grantKey, {
    organization: {
      $: { id: org.id },
      documents: {
        $: {
          where: { and: [['type', 'vendorBill'], ['balance', '!=', 0]] },
          size: 50,
          sortBy: [{ field: 'dueDate', order: 'asc' }],
        },
        count: {},
        sum: { $: 'balance' },
        nodes: {
          id: {}, fullName: {}, status: {}, dueDate: {}, balance: {},
          toName: {}, job: { number: {}, name: {} },
        },
      },
    },
  });

  var docs = (unwrap(data, 'organization') || {}).documents || {};
  var nodes = (docs.nodes || []).map(function (d) {
    var overdue = d.dueDate && d.dueDate < today;
    return {
      id: d.id,
      name: d.fullName,
      vendor: d.toName,
      status: d.status,
      jobNumber: d.job && d.job.number,
      dueDate: d.dueDate,
      balance: round2(d.balance),
      overdue: !!overdue,
      url: 'https://app.jobtread.com/documents/' + d.id,
    };
  });

  return {
    count: docs.count || nodes.length,
    total: round2(docs.sum || 0),
    overdueTotal: round2(nodes.reduce(function (s, d) { return s + (d.overdue ? d.balance : 0); }, 0)),
    bills: nodes,
  };
}

// One call for the whole dashboard. Each section fails independently so a
// single bad query cannot blank the page.
async function dashboard(grantKey) {
  var out = { generatedAt: new Date().toISOString(), errors: {} };

  var all = [];
  try {
    all = await fetchJobsByStatus(grantKey, null);
  } catch (err) {
    out.errors.jobs = err.message;
  }

  var build = all.filter(function (j) { return BUILD_STATUSES.indexOf(j.status) !== -1; });
  var leads = all.filter(function (j) { return PIPELINE_STATUSES.indexOf(j.status) !== -1; });
  var held  = all.filter(function (j) { return j.status === 'On Hold'; });

  build.sort(function (a, b) { return (b.progress || 0) - (a.progress || 0); });
  leads.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

  out.activeJobs = { count: build.length, jobs: build };
  out.pipeline   = { count: leads.length, jobs: leads };
  out.onHold     = { count: held.length, jobs: held };

  out.backlog = round2(build.reduce(function (s, j) {
    return s + ((j.projectedPrice || 0) - (j.actualCost || 0));
  }, 0));

  try { out.receivables = await receivables(grantKey); }
  catch (err) { out.errors.receivables = err.message; }

  try { out.payables = await payables(grantKey); }
  catch (err) { out.errors.payables = err.message; }

  if (out.receivables && out.payables) {
    out.netPosition = round2(out.receivables.total - out.payables.total);
  }

  if (!Object.keys(out.errors).length) delete out.errors;
  return out;
}
