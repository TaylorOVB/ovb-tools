// /api/jobtread.js — OVB Tools Vercel Serverless Proxy
// Proxies all requests to JobTread Pave API.
// Grant key stored in Vercel env var: JOBTREAD_GRANT_KEY

const PAVE_URL = 'https://api.jobtread.com/pave';

// ─── Custom Field IDs (OVB account) ───────────────────────────────────────────
const F = {
  status:             '22PC8F47A63H',
  customerType:       '22PC8EvauCvJ',
  budgetRange:        '22PTyjrdmBSZ',
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
  plansStatus:        '22PTykNeedID', // ← PLACEHOLDER — run getFieldId to get real ID
};

// ─── Budget Range normalization ─────────────────────────────────────────────
// Form uses en-dash (–). JT picklist uses hyphen (-). Map everything.
function normalizeBudget(val) {
  const map = {
    'Under $50K':   'Under $100K',  // DQ but still create record
    'Under $100K':  'Under $100K',
    '$100K–$200K':  '$100K-$200K',
    '$200K–$400K':  '$200K-$400K',
    '$400K–$600K':  '$400K-$600K',
    '$600K–$800K':  '$600K-$800K',
    '$800K–$1M':    '$800K-$1M',
    '$1M+':         '$1M+',
    'Not Sure':     'Not Sure',
  };
  return map[val] || val;
}

// ─── Qualification Score normalization ──────────────────────────────────────
// Form sends "Hot (10 pts)" / "Warm (8 pts)" etc. JT wants "Hot" / "Warm" only.
function normalizeScore(val) {
  if (!val) return 'Cold';
  const s = val.toString().trim();
  if (s.startsWith('Hot'))  return 'Hot';
  if (s.startsWith('Warm')) return 'Warm';
  if (s.startsWith('Cold')) return 'Cold';
  if (s.startsWith('DQ'))   return "DQ'd";
  if (s === "DQ'd")         return "DQ'd";
  return s; // pass through if already clean
}

// ─── Pave request helper ─────────────────────────────────────────────────────
async function pave(grantKey, query) {
  const body = JSON.stringify({
    query: { $: { grantKey }, ...query }
  });
  const res = await fetch(PAVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pave HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Build custom field update array ────────────────────────────────────────
function buildFieldUpdates(params) {
  const updates = [];

  const add = (fieldId, value) => {
    if (value !== undefined && value !== null && value !== '') {
      updates.push({ customFieldId: fieldId, value: String(value) });
    }
  };

  add(F.status,             '1. New Lead');
  add(F.customerType,       params.customerType);
  add(F.budgetRange,        normalizeBudget(params.budgetRange));
  add(F.leadSource,         params.leadSource);
  add(F.referredBy,         params.referredBy);
  add(F.apptDateTime,       params.apptDateTime);
  add(F.preferredContact,   params.preferredContact);
  add(F.notes,              params.notes);
  add(F.financingType,      params.financing);
  add(F.decisionMakers,     params.decisionMakers);
  add(F.competingBids,      params.competingBids);
  add(F.timeline,           params.timeline);
  add(F.projectLocation,    params.county ? `${params.county} County` : params.address);
  add(F.dqFlag,             params.dqFlag || 'None');
  add(F.qualificationScore, normalizeScore(params.qualificationScore));
  // plansStatus: only add if F.plansStatus has a real ID (not placeholder)
  if (params.plansStatus && !F.plansStatus.includes('NeedID')) {
    add(F.plansStatus, params.plansStatus);
  }

  return updates;
}

// ─── Main handler ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const grantKey = process.env.JOBTREAD_GRANT_KEY;
  if (!grantKey) {
    return res.status(500).json({ error: 'JOBTREAD_GRANT_KEY env var not set' });
  }

  const { operation, params = {} } = req.body || {};

  try {

    // ── createCustomer ──────────────────────────────────────────────────────
    if (operation === 'createCustomer') {
      const steps = {};

      // Step 1: Get org ID
      const orgData = await pave(grantKey, {
        currentGrant: { id: {}, organization: { id: {} } }
      });
      const orgId = orgData?.currentGrant?.organization?.id;
      if (!orgId) throw new Error('Could not get org ID from currentGrant');
      steps.orgId = orgId;

      // Step 2: Create account (name only — type must be exact string)
      const accountData = await pave(grantKey, {
        createAccount: {
          $: {
            organizationId: orgId,
            name: params.name,
            type: 'customer',
          },
          id: {},
          name: {},
        }
      });
      const accountId = accountData?.createAccount?.id;
      if (!accountId) throw new Error('createAccount failed: ' + JSON.stringify(accountData));
      steps.accountId = accountId;
      steps.createAccount = accountData;

      // Step 3: Set all custom fields via updateAccount
      const fieldUpdates = buildFieldUpdates(params);
      const updateData = await pave(grantKey, {
        updateAccount: {
          $: {
            id: accountId,
            customFieldValues: fieldUpdates,
          },
          id: {},
        }
      });
      steps.updateAccount = updateData;

      // Step 4: Create contact record (name only — phone/email done separately)
      const contactData = await pave(grantKey, {
        createContact: {
          $: {
            accountId,
            name: params.name,
          },
          id: {},
          name: {},
        }
      });
      const contactId = contactData?.createContact?.id;
      steps.contactId = contactId;
      steps.createContact = contactData;

      // Step 5: Create location record
      if (params.address) {
        const locationData = await pave(grantKey, {
          createLocation: {
            $: {
              accountId,
              name: params.address,
              address: params.address,
            },
            id: {},
          }
        });
        steps.createLocation = locationData;
      }

      // Step 6: Set phone on contact
      // JT uses createPhoneNumber with { contactId, number }
      if (contactId && params.phone) {
        try {
          const phoneData = await pave(grantKey, {
            createPhoneNumber: {
              $: {
                contactId,
                number: params.phone,
              },
              id: {},
            }
          });
          steps.createPhoneNumber = phoneData;
        } catch (e) {
          // Non-fatal — log error but don't fail the whole flow
          steps.createPhoneNumber = { error: e.message };
        }
      }

      // Step 7: Set email on contact
      // JT uses createEmailAddress with { contactId, address }
      if (contactId && params.email) {
        try {
          const emailData = await pave(grantKey, {
            createEmailAddress: {
              $: {
                contactId,
                address: params.email,
              },
              id: {},
            }
          });
          steps.createEmailAddress = emailData;
        } catch (e) {
          // Non-fatal — log error but don't fail the whole flow
          steps.createEmailAddress = { error: e.message };
        }
      }

      return res.json({
        success: true,
        accountId,
        contactId,
        viewUrl: `https://app.jobtread.com/accounts/${accountId}`,
        steps,
      });
    }

    // ── getContact — inspect a contact's phone/email fields ─────────────────
    // Use this to debug: does the contact have phoneNumbers and emailAddresses?
    // Console test: fetch('/api/jobtread', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ operation:'getContact', params:{ contactId:'CONTACT_ID_HERE' }}) }).then(r=>r.json()).then(console.log)
    if (operation === 'getContact') {
      const data = await pave(grantKey, {
        contact: {
          $: { id: params.contactId },
          id: {},
          name: {},
          phoneNumbers: { nodes: { id: {}, number: {} } },
          emailAddresses: { nodes: { id: {}, address: {} } },
        }
      });
      return res.json(data);
    }

    // ── getAccountFields — get custom field IDs from an existing account ─────
    // Use to discover the Plans Status field ID
    // Console test: fetch('/api/jobtread', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ operation:'getAccountFields', params:{ accountId:'ACCOUNT_ID_HERE' }}) }).then(r=>r.json()).then(d=>{ const f=d?.account?.customFieldValues?.nodes||[]; f.forEach(n=>console.log(n.customField.name,'→',n.customField.id)); })
    if (operation === 'getAccountFields') {
      const data = await pave(grantKey, {
        account: {
          $: { id: params.accountId },
          id: {},
          name: {},
          customFieldValues: {
            nodes: {
              id: {},
              value: {},
              customField: { id: {}, name: {} },
            }
          }
        }
      });
      return res.json(data);
    }

    // ── getOrgInfo — get org ID and available field definitions ─────────────
    if (operation === 'getOrgInfo') {
      const data = await pave(grantKey, {
        currentGrant: {
          id: {},
          organization: {
            id: {},
            name: {},
          }
        }
      });
      return res.json(data);
    }

    // ── Unknown operation ────────────────────────────────────────────────────
    return res.status(400).json({ error: `Unknown operation: ${operation}` });

  } catch (err) {
    console.error('[jobtread proxy error]', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
