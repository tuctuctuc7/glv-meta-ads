// GLV Meta Ads Dashboard — FB Graph API proxy with Upstash Redis cache
// Requires env vars: FB_ACCESS_TOKEN, KV_REST_API_URL, KV_REST_API_TOKEN

const AD_ACCOUNT = '359758259164738';
const FB_API = 'https://graph.facebook.com/v21.0';

// Presets the cron pre-warms; everything else hits Meta live
const CACHED_PRESETS = new Set(['last_7d', 'last_14d', 'last_30d', 'last_90d']);

async function redisGet(key) {
  try {
    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    const r = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch {
    return null;
  }
}

function getAction(actions, type) {
  if (!Array.isArray(actions)) return '0';
  const item = actions.find(a => a.action_type === type);
  return item ? item.value : '0';
}

function getActionValue(action_values, type) {
  if (!Array.isArray(action_values)) return '0';
  const item = action_values.find(a => a.action_type === type);
  return item ? item.value : '0';
}

function getVideoMetric(arr) {
  if (!Array.isArray(arr) || !arr.length) return '0';
  return arr[0].value || '0';
}

function normalizeCampaign(row) {
  return {
    id:   row.campaign_id || '',
    name: row.campaign_name || '',
    amount_spent:                  row.spend || '0',
    impressions:                   row.impressions || '0',
    'actions:link_click':          getAction(row.actions, 'link_click'),
    'actions:omni_purchase':       getAction(row.actions, 'omni_purchase'),
    'actions:initiate_checkout':   getAction(row.actions, 'initiate_checkout'),
    'actions:outbound_click':      getAction(row.actions, 'outbound_click'),
    'action_values:omni_purchase': getActionValue(row.action_values, 'omni_purchase'),
    date_start: row.date_start || null,
    date_stop:  row.date_stop  || null,
  };
}

function normalizeAd(row, statusMap) {
  const adId = row.ad_id || row.id || '';
  return {
    id:   adId,
    name: row.ad_name || '',
    status: statusMap[adId] || 'UNKNOWN',
    campaign_id: row.campaign_id || '',
    amount_spent:                  row.spend || '0',
    impressions:                   row.impressions || '0',
    'actions:link_click':          getAction(row.actions, 'link_click'),
    'actions:omni_purchase':       getAction(row.actions, 'omni_purchase'),
    'actions:initiate_checkout':   getAction(row.actions, 'initiate_checkout'),
    'actions:outbound_click':      getAction(row.actions, 'outbound_click'),
    'action_values:omni_purchase': getActionValue(row.action_values, 'omni_purchase'),
    video_thruplay_watched_actions: getVideoMetric(row.video_thruplay_watched_actions),
    video_3_sec_watched_actions:    getAction(row.actions, 'video_view'),
    video_p100_watched_actions:     getVideoMetric(row.video_p100_watched_actions),
  };
}

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
  const preset = date_preset || 'last_30d';

  // Serve from cache for standard presets (no time_range = custom date)
  if (!time_range && CACHED_PRESETS.has(preset)) {
    const cached = await redisGet(`glv:${type}:${preset}`);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
  }

  // Cache miss or custom range — hit Meta API live
  res.setHeader('X-Cache', 'MISS');
  const dateParam = time_range
    ? `time_range=${encodeURIComponent(time_range)}`
    : `date_preset=${preset}`;
  const auth = `access_token=${token}`;

  try {
    if (type === 'aggregate') {
      const fields = 'campaign_id,campaign_name,spend,impressions,actions,action_values';
      const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=campaign&fields=${fields}&${dateParam}&limit=500&${auth}`;
      const raw = await paginate(url);
      res.json({ rows: raw.map(normalizeCampaign) });

    } else if (type === 'daily') {
      const fields = 'campaign_id,campaign_name,spend,impressions,actions,action_values';
      const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=campaign&fields=${fields}&${dateParam}&time_increment=1&limit=500&${auth}`;
      const raw = await paginate(url);
      res.json({ rows: raw.map(normalizeCampaign) });

    } else if (type === 'ads') {
      const fields = 'ad_id,ad_name,campaign_id,spend,impressions,actions,action_values,video_p100_watched_actions,video_thruplay_watched_actions';
      const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=ad&fields=${fields}&${dateParam}&sort=spend_descending&limit=50&${auth}`;
      const raw = await paginate(url);

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
        } catch(e) {}
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
