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

// ─── Create customer (5-step) ─────────────────────────────────────────────────

async function createCustomer(grantKey, params) {
  const results = { steps: {} };

  // ── Step 1: Get org ID + custom field definitions ──────────────────────────
  const org = await getOrgInfo(grantKey);
  const orgId = org?.id;
  if (!orgId) throw new Error('Could not retrieve org ID. Verify grant key.');
  results.steps.orgId = orgId;

  // ── Step 2: Create the customer account (name only) ────────────────────────
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

  // ── Step 3: Set custom fields on customer account ──────────────────────────
  // Field names match exactly JT Settings → Custom Fields → CUSTOMER ACCOUNTS
  const fieldDefs = org?.customFields?.nodes ?? [];
  const FIELD_MAP = {
    'Status':                   'Lead',
    'Customer Type':            'Residential',
    'Budget Range':             params.budgetRange,
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
        account: { id: {} },
      },
    }).catch(err => {
      console.warn('[jobtread proxy] Custom fields non-fatal:', err.message);
      results.steps.customFieldsError = err.message;
    });
  }
  results.steps.customFieldsSet = Object.keys(customFieldValues).length;

  // ── Step 4: Create contact (name, email, phone) ────────────────────────────
  if (params.name || params.email || params.phone) {
    await pave(grantKey, {
      createContact: {
        $: {
          accountId,
          name: params.name,
          ...(params.email && { email: params.email }),
          ...(params.phone && { phone: params.phone }),
        },
        createdContact: { id: {}, name: {} },
      },
    }).then(() => {
      results.steps.contactCreated = true;
    }).catch(err => {
      console.warn('[jobtread proxy] Contact non-fatal:', err.message);
      results.steps.contactError = err.message;
    });
  }

  // ── Step 5: Create location (project address) ──────────────────────────────
  if (params.address) {
    // Parse address into street + city if possible
    // Expects format like "123 Main St, Ogden" or "123 Main St, Ogden, UT 84401"
    const parts = params.address.split(',').map(s => s.trim());
    const street = parts[0] || params.address;
    const city   = parts[1] || '';
    const state  = parts[2] || 'UT';

    await pave(grantKey, {
      createLocation: {
        $: {
          accountId,
          name: params.address,
          address1: street,
          ...(city  && { city }),
          ...(state && { state }),
        },
        createdLocation: { id: {}, name: {} },
      },
    }).then(() => {
      results.steps.locationCreated = true;
    }).catch(err => {
      console.warn('[jobtread proxy] Location non-fatal:', err.message);
      results.steps.locationError = err.message;
    });
  }

  return results;
}
