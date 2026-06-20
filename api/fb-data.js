// GLV Meta Ads Dashboard — FB Graph API proxy
// Requires env var: FB_ACCESS_TOKEN (long-lived token with ads_read permission)

const AD_ACCOUNT = '359758259164738';
const FB_API = 'https://graph.facebook.com/v21.0';

// ── Helpers ──────────────────────────────────────────────
function getAction(actions, type) {
  if (!Array.isArray(actions)) return '0';
  const item = actions.find(a => a.action_type === type);
  return item ? item.value : '0';
}

function getRoas(purchase_roas) {
  if (!Array.isArray(purchase_roas)) return '0';
  const item = purchase_roas.find(a => a.action_type === 'omni_purchase');
  return item ? item.value : '0';
}

function getActionValue(action_values, type) {
  if (!Array.isArray(action_values)) return null;
  const item = action_values.find(a => a.action_type === type);
  return item ? item.value : null;
}

function getVideoMetric(arr) {
  if (!Array.isArray(arr) || !arr.length) return '0';
  return arr[0].value || '0';
}

// Transform FB API insights row → format the dashboard already expects
function normalizeCampaign(row) {
  const purchaseVal = getActionValue(row.action_values, 'omni_purchase');
  return {
    id:   row.campaign_id || '',
    name: row.campaign_name || '',
    amount_spent: row.spend || '0',
    impressions:  row.impressions || '0',
    purchase_roas: getRoas(row.purchase_roas),
    'actions:link_click':    getAction(row.actions, 'link_click'),
    'actions:omni_purchase': getAction(row.actions, 'omni_purchase'),
    result_values: purchaseVal
      ? [{ indicator: 'omni_purchase', values: [{ value: purchaseVal }] }]
      : [],
    date_start: row.date_start || null,
    date_stop:  row.date_stop  || null,
  };
}

function normalizeAd(row, statusMap) {
  const purchaseVal = getActionValue(row.action_values, 'omni_purchase');
  const adId = row.ad_id || row.id || '';
  return {
    id:   adId,
    name: row.ad_name || '',
    status: statusMap[adId] || 'UNKNOWN',
    campaign_id: row.campaign_id || '',
    amount_spent: row.spend || '0',
    impressions:  row.impressions || '0',
    ctr: row.ctr || '0',
    purchase_roas: getRoas(row.purchase_roas),
    'actions:link_click':    getAction(row.actions, 'link_click'),
    'actions:omni_purchase': getAction(row.actions, 'omni_purchase'),
    result_values: purchaseVal
      ? [{ indicator: 'omni_purchase', values: [{ value: purchaseVal }] }]
      : [],
    video_thruplay_watched_actions: getVideoMetric(row.video_thruplay_watched_actions),
    video_p100_watched_actions:     getVideoMetric(row.video_p100_watched_actions),
  };
}

// Paginate through all FB API results
async function paginate(url) {
  let rows = [];
  let next = url;
  while (next) {
    const r = await fetch(next);
    const data = await r.json();
    if (data.error) throw new Error(`FB API: ${data.error.message} (code ${data.error.code})`);
    rows = rows.concat(data.data || []);
    next = data.paging?.next || null;
  }
  return rows;
}

// ── Handler ───────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const token = process.env.FB_ACCESS_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'FB_ACCESS_TOKEN is not set in Vercel environment variables.' });
    return;
  }

  const { type, date_preset, time_range } = req.query;
  const dateParam = time_range
    ? `time_range=${encodeURIComponent(time_range)}`
    : `date_preset=${date_preset || 'last_30d'}`;
  const auth = `access_token=${token}`;

  try {
    // ── Aggregate: one row per campaign, full period ──────
    if (type === 'aggregate') {
      const fields = 'campaign_id,campaign_name,spend,impressions,purchase_roas,actions,action_values';
      const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=campaign&fields=${fields}&${dateParam}&limit=500&${auth}`;
      const raw = await paginate(url);
      res.json({ rows: raw.map(normalizeCampaign) });

    // ── Daily: one row per campaign per day ───────────────
    } else if (type === 'daily') {
      const fields = 'campaign_id,campaign_name,spend,impressions,purchase_roas,actions,action_values';
      const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=campaign&fields=${fields}&${dateParam}&time_increment=1&limit=500&${auth}`;
      const raw = await paginate(url);
      res.json({ rows: raw.map(normalizeCampaign) });

    // ── Ads: ad-level performance + status ────────────────
    } else if (type === 'ads') {
      const fields = 'ad_id,ad_name,campaign_id,spend,impressions,ctr,actions,action_values,purchase_roas,video_p100_watched_actions,video_thruplay_watched_actions';
      const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=ad&fields=${fields}&${dateParam}&sort=spend_descending&limit=50&${auth}`;
      const raw = await paginate(url);

      // Fetch ad statuses in one batch call
      const adIds = [...new Set(raw.map(r => r.ad_id || r.id).filter(Boolean))];
      let statusMap = {};
      if (adIds.length) {
        try {
          const batchUrl = `${FB_API}/?ids=${adIds.join(',')}&fields=effective_status&${auth}`;
          const sr = await fetch(batchUrl);
          const sd = await sr.json();
          if (!sd.error) {
            for (const [id, d] of Object.entries(sd)) {
              statusMap[id] = d.effective_status || 'UNKNOWN';
            }
          }
        } catch(e) { /* status fetch failed — use UNKNOWN */ }
      }

      res.json({ rows: raw.map(r => normalizeAd(r, statusMap)) });

    } else {
      res.status(400).json({ error: 'Invalid type. Use: aggregate, daily, or ads.' });
    }
  } catch (err) {
    console.error('fb-data error:', err);
    res.status(500).json({ error: err.message });
  }
};
