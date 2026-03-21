// api/jobtread.js — OVB Tools · JobTread Proxy
// Deploy at /api/jobtread.js in repo root.
// Set JOBTREAD_GRANT_KEY in Vercel → Settings → Environment Variables.

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
      default: return res.status(400).json({ error: `Unknown operation: ${operation}` });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(result);
  } catch (err) {
    console.error(`[jobtread proxy] ${operation} error:`, err.message);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
};

// ─── Pave API helper ──────────────────────────────────────────────────────────

async function pave(grantKey, queryObj) {
  const res = await fetch('https://api.jobtread.com/pave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { $: { grantKey }, ...queryObj } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Pave ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Pave non-JSON: ${text.slice(0, 200)}`); }
  if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  return data;
}

// ─── Value mappers ────────────────────────────────────────────────────────────

// Discovery Call budget values → exact JT picklist values
const BUDGET_MAP = {
  'Under $50K':   'Under $100K',
  'Under $100K':  'Under $100K',
  '$100K–$200K':  '$100K - $200K',
  '$200K–$400K':  '$200K - $400K',
  '$400K–$600K':  '$400K - $600K',
  '$600K–$800K':  '$600K - $800K',
  '$800K–$1M':    '$800k - $1M',
  '$1M+':         '$1M+',
  'Not Sure':     'Not Sure',
};

// ─── Get org info ─────────────────────────────────────────────────────────────

async function getOrgInfo(grantKey) {
  const grantData = await pave(grantKey, {
    currentGrant: {
      id: {},
      organization: { id: {}, name: {} },
    },
  });

  const org = grantData?.query?.currentGrant?.organization
           ?? grantData?.currentGrant?.organization;
  if (!org?.id) throw new Error('Could not get org from currentGrant. Check grant key.');

  const orgData = await pave(grantKey, {
    organization: {
      $: { id: org.id },
      id: {},
      name: {},
      customFields: {
        $: { size: 100 },
        nodes: { id: {}, name: {} },
      },
    },
  });

  const full = orgData?.query?.organization ?? orgData?.organization ?? {};
  return { ...org, ...full };
}

// ─── Create customer ──────────────────────────────────────────────────────────

async function createCustomer(grantKey, params) {
  const results = { steps: {} };

  // Step 1: org ID + field defs
  const org = await getOrgInfo(grantKey);
  const orgId = org?.id;
  if (!orgId) throw new Error('Could not retrieve org ID. Verify grant key.');

  // Step 2: create account (name only — no extra fields at creation)
  const createData = await pave(grantKey, {
    createAccount: {
      $: {
        name: params.name,
        type: 'customer',
        organizationId: orgId,
      },
      createdAccount: { id: {}, name: {} },
    },
  });

  const account =
    createData?.query?.createAccount?.createdAccount ??
    createData?.createAccount?.createdAccount;
  if (!account?.id) throw new Error('Account created but no ID returned.');

  const accountId = account.id;
  results.accountId   = accountId;
  results.accountName = account.name;
  results.url         = `https://app.jobtread.com/accounts/${accountId}`;
  results.steps.accountCreated = true;

  // Step 3: set custom fields
  // Exact picklist values from JT Settings → Custom Fields → CUSTOMER ACCOUNTS
  const fieldDefs = org?.customFields?.nodes ?? [];
  const FIELD_MAP = {
    'Status':                   '1. New Lead',
    'Customer Type':            params.customerType || 'Homeowner - Primary Residence',
    'Budget Range':             BUDGET_MAP[params.budgetRange] || params.budgetRange,
    'Needs':                    params.projectType,
    'Lead Source':              params.leadSource,
    'Referred By':              params.referredBy,
    'Preferred Contact Method': params.contactMethod,
    'Financing Type':           params.financing,
    'Decision Makers':          params.decisionMakers,
    'Competing Bids':           params.competingBids,
    'Timeline / Urgency':       params.timeline,
    'Project Location':         params.county ? `${params.county} County` : undefined,
    'DQ Flag':                  params.dqFlag,
    'Qualification Score':      params.qualificationScore,
    'Notes':                    params.notes,
    'Appointment Date & Time':  params.apptDate || undefined,
  };

  const customFieldValues = {};
  for (const def of fieldDefs) {
    const val = FIELD_MAP[def.name];
    if (val) customFieldValues[def.id] = val;
  }

  if (Object.keys(customFieldValues).length > 0) {
    await pave(grantKey, {
      updateAccount: {
        $: { id: accountId, customFieldValues },
        // No return fields requested — avoids the non-null error on account.$
      },
    }).then(() => {
      results.steps.customFieldsSet = Object.keys(customFieldValues).length;
    }).catch(err => {
      console.warn('[jobtread proxy] Custom fields:', err.message);
      results.steps.customFieldsError = err.message;
    });
  }

  // Step 4: create contact (name + email only — phone goes separately)
  await pave(grantKey, {
    createContact: {
      $: {
        accountId,
        name: params.name,
        ...(params.email && { email: params.email }),
      },
      createdContact: { id: {}, name: {} },
    },
  }).then(d => {
    const contactId =
      d?.query?.createContact?.createdContact?.id ??
      d?.createContact?.createdContact?.id;
    results.steps.contactCreated = true;
    results.steps.contactId = contactId;

    // Step 4b: add phone to the contact if we have one and got an ID back
    if (contactId && params.phone) {
      pave(grantKey, {
        createPhoneNumber: {
          $: {
            contactId,
            number: params.phone,
            type: 'mobile',
          },
          createdPhoneNumber: { id: {} },
        },
      }).then(() => {
        results.steps.phoneCreated = true;
      }).catch(err => {
        results.steps.phoneError = err.message;
      });
    }
  }).catch(err => {
    console.warn('[jobtread proxy] Contact:', err.message);
    results.steps.contactError = err.message;
  });

  // Step 5: create location (project address)
  if (params.address) {
    const parts = params.address.split(',').map(s => s.trim());
    const street = parts[0] || params.address;
    const city   = parts[1] || '';
    const state  = 'UT';

    await pave(grantKey, {
      createLocation: {
        $: {
          accountId,
          name: params.address,
          address1: street,
          ...(city && { city }),
          state,
        },
        createdLocation: { id: {}, name: {} },
      },
    }).then(() => {
      results.steps.locationCreated = true;
    }).catch(err => {
      console.warn('[jobtread proxy] Location:', err.message);
      results.steps.locationError = err.message;
    });
  }

  return results;
}
