// api/jobtread.js — OVB Tools · JobTread Proxy
// Deploy at /api/jobtread.js in repo root.
// Set JOBTREAD_GRANT_KEY in Vercel → Settings → Environment Variables.
//
// Operations (POST body):
//   { operation: 'createCustomer', params: { name, phone, email, ...fields, notes } }
//   { operation: 'getOrgInfo' }  ← run once to verify connection + see field IDs

export default async function handler(req, res) {
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
}

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
  const data = await pave(grantKey, {
    organization: {
      $: {},
      id: {},
      name: {},
      customFields: {
        $: { size: 50 },
        nodes: { id: {}, name: {}, },
      },
    },
  });
  return data?.query?.organization ?? data?.organization ?? {};
}

// ─── Create customer (multi-step) ─────────────────────────────────────────────

async function createCustomer(grantKey, params) {
  // 1. Get org ID + custom field definitions
  const org = await getOrgInfo(grantKey);
  const orgId = org?.id;
  if (!orgId) throw new Error('Could not retrieve org ID. Verify grant key.');

  // 2. Create the customer account
  const createData = await pave(grantKey, {
    createAccount: {
      $: {
        name: params.name,
        type: 'customer',
        organizationId: orgId,
        ...(params.email && { email: params.email }),
        ...(params.phone && { phone: params.phone }),
      },
      createdAccount: { id: {}, name: {}, type: {} },
    },
  });

  const account =
    createData?.query?.createAccount?.createdAccount ??
    createData?.createAccount?.createdAccount;
  if (!account?.id) throw new Error('Account created but no ID returned. Check JobTread.');

  const accountId = account.id;

  // 3. Set custom fields — matched by name against your JT field definitions
  // Field names here must match exactly what's in JobTread Settings → Custom Fields.
  // Run { operation: 'getOrgInfo' } to see all names and IDs in your account.
  const fieldDefs = org?.customFields?.nodes ?? [];
  const FIELD_MAP = {
    'Budget Range':             params.budgetRange,
    'Needs':                    params.projectType,
    'Lead Source':              params.leadSource,
    'Referred By':              params.referredBy,
    'Preferred Contact Method': params.contactMethod,
    'Financing Type':           params.financing,
    'Decision Makers':          params.decisionMakers,
    'Competing Bids':           params.competingBids,
    'Timeline/Urgency':         params.timeline,
    'Project Location':         params.county ? `${params.county} County` : undefined,
    'Qualification Score':      params.qualificationScore,
    'DQ Flag':                  params.dqFlag,
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
        account: { id: {}, name: {} },
      },
    }).catch(err => console.warn('[jobtread proxy] Custom fields non-fatal:', err.message));
  }

  // 4. Post full JT summary as a comment on the customer record
  if (params.notes) {
    await pave(grantKey, {
      createComment: {
        $: { entityId: accountId, entityType: 'Account', body: params.notes },
        createdComment: { id: {} },
      },
    }).catch(err => console.warn('[jobtread proxy] Comment non-fatal:', err.message));
  }

  return {
    accountId,
    accountName: account.name,
    url: `https://app.jobtread.com/accounts/${accountId}`,
    customFieldsSet: Object.keys(customFieldValues).length,
    fieldDefsFound: fieldDefs.length,
  };
}
