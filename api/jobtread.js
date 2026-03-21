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
      case 'getAccountFields': result = await getAccountFields(grantKey, params.accountId); break;
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
  if (!org?.id) throw new Error('Could not get org from currentGrant.');
  return org;
}

// ─── Get customer account's own custom fields (correct IDs for this entity) ──

async function getAccountFields(grantKey, accountId) {
  const data = await pave(grantKey, {
    account: {
      $: { id: accountId },
      id: {},
      name: {},
      customFieldValues: {
        $: { size: 100 },
        nodes: {
          id: {},
          value: {},
          customField: { id: {}, name: {} },
        },
      },
    },
  });
  return data?.query?.account ?? data?.account ?? {};
}

// ─── Create customer ──────────────────────────────────────────────────────────

async function createCustomer(grantKey, params) {
  const results = { steps: {} };

  // Step 1: get org ID
  const org = await getOrgInfo(grantKey);
  const orgId = org?.id;
  if (!orgId) throw new Error('Could not retrieve org ID.');

  // Step 2: create account (name only)
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

  // Step 3: fetch the account's OWN custom field definitions
  // This gives us only customer-entity field IDs — avoids mixing in job/vendor fields
  const accountData = await getAccountFields(grantKey, accountId);
  const fieldNodes = accountData?.customFieldValues?.nodes ?? [];
  results.steps.customerFieldsFound = fieldNodes.length;

  // Build a name→id map from the account's actual fields
  const fieldIdByName = {};
  for (const node of fieldNodes) {
    if (node?.customField?.name && node?.customField?.id) {
      fieldIdByName[node.customField.name] = node.customField.id;
    }
  }
  results.steps.fieldNames = Object.keys(fieldIdByName);

  // Map our call values to exact JT picklist values
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

  // Build customFieldValues using only field IDs that exist on this account
  const customFieldValues = {};
  for (const [name, val] of Object.entries(FIELD_MAP)) {
    const id = fieldIdByName[name];
    if (id && val) customFieldValues[id] = val;
  }
  results.steps.fieldsToSet = Object.keys(customFieldValues).length;

  if (Object.keys(customFieldValues).length > 0) {
    await pave(grantKey, {
      updateAccount: {
        $: { id: accountId, customFieldValues },
      },
    }).then(() => {
      results.steps.customFieldsSet = true;
    }).catch(err => {
      console.warn('[jobtread proxy] Custom fields:', err.message);
      results.steps.customFieldsError = err.message;
    });
  }

  // Step 4: create contact (name only — JT doesn't accept email/phone on createContact)
  await pave(grantKey, {
    createContact: {
      $: { accountId, name: params.name },
      createdContact: { id: {}, name: {} },
    },
  }).then(d => {
    const contactId =
      d?.query?.createContact?.createdContact?.id ??
      d?.createContact?.createdContact?.id;
    results.steps.contactCreated = true;

    // Step 4b: add phone number to contact
    if (contactId && params.phone) {
      pave(grantKey, {
        createPhoneNumber: {
          $: { contactId, number: params.phone, type: 'mobile' },
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

    await pave(grantKey, {
      createLocation: {
        $: {
          accountId,
          name: params.address,
          address1: street,
          ...(city && { city }),
          state: 'UT',
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
