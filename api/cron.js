// Daily cron — runs at 00:00 UTC (07:00 GMT+7)
// Fetches all preset date ranges ending YESTERDAY, stores in Upstash Redis

const AD_ACCOUNT = '359758259164738';
const FB_API = 'https://graph.facebook.com/v21.0';

const PRESETS = ['last_7d', 'last_14d', 'last_30d', 'last_90d'];
const PRESET_DAYS = { last_7d: 6, last_14d: 13, last_30d: 29, last_90d: 89 };
const TTL = 90000; // 25 hours

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function sinceDate(preset) {
  const d = new Date();
  d.setDate(d.getDate() - 1 - PRESET_DAYS[preset]);
  return d.toISOString().slice(0, 10);
}

async function redisCmd(...args) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  return r.json();
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
    id: row.campaign_id || '',
    name: row.campaign_name || '',
    amount_spent: row.spend || '0',
    impressions: row.impressions || '0',
    'actions:link_click': getAction(row.actions, 'link_click'),
    'actions:omni_purchase': getAction(row.actions, 'omni_purchase'),
    'actions:initiate_checkout': getAction(row.actions, 'initiate_checkout'),
    'actions:outbound_click': getAction(row.actions, 'outbound_click'),
    'action_values:omni_purchase': getActionValue(row.action_values, 'omni_purchase'),
    date_start: row.date_start || null,
    date_stop: row.date_stop || null,
  };
}

function normalizeAd(row, statusMap) {
  const adId = row.ad_id || row.id || '';
  return {
    id: adId,
    name: row.ad_name || '',
    status: statusMap[adId] || 'UNKNOWN',
    campaign_id: row.campaign_id || '',
    amount_spent: row.spend || '0',
    impressions: row.impressions || '0',
    'actions:link_click': getAction(row.actions, 'link_click'),
    'actions:omni_purchase': getAction(row.actions, 'omni_purchase'),
    'actions:initiate_checkout': getAction(row.actions, 'initiate_checkout'),
    'actions:outbound_click': getAction(row.actions, 'outbound_click'),
    'action_values:omni_purchase': getActionValue(row.action_values, 'omni_purchase'),
    video_thruplay_watched_actions: getVideoMetric(row.video_thruplay_watched_actions),
    video_3_sec_watched_actions: getVideoMetric(row.video_3_sec_watched_actions),
    video_p100_watched_actions: getVideoMetric(row.video_p100_watched_actions),
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

async function fetchAndCache(token, preset) {
  const until = yesterday();
  const since = sinceDate(preset);
  const dateParam = `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;
  const auth = `access_token=${token}`;
  const errors = [];

  // aggregate
  try {
    const fields = 'campaign_id,campaign_name,spend,impressions,actions,action_values';
    const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=campaign&fields=${fields}&${dateParam}&limit=500&${auth}`;
    const raw = await paginate(url);
    const rows = raw.map(normalizeCampaign);
    await redisCmd('SET', `glv:aggregate:${preset}`, JSON.stringify({ rows }), 'EX', String(TTL));
  } catch (e) {
    errors.push(`aggregate/${preset}: ${e.message}`);
  }

  // daily
  try {
    const fields = 'campaign_id,campaign_name,spend,impressions,actions,action_values';
    const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=campaign&fields=${fields}&${dateParam}&time_increment=1&limit=500&${auth}`;
    const raw = await paginate(url);
    const rows = raw.map(normalizeCampaign);
    await redisCmd('SET', `glv:daily:${preset}`, JSON.stringify({ rows }), 'EX', String(TTL));
  } catch (e) {
    errors.push(`daily/${preset}: ${e.message}`);
  }

  // ads
  try {
    const fields = 'ad_id,ad_name,campaign_id,spend,impressions,actions,action_values,video_p100_watched_actions,video_thruplay_watched_actions,video_3_sec_watched_actions';
    const url = `${FB_API}/act_${AD_ACCOUNT}/insights?level=ad&fields=${fields}&${dateParam}&sort=spend_descending&limit=50&${auth}`;
    const raw = await paginate(url);

    const adIds = [...new Set(raw.map(r => r.ad_id || r.id).filter(Boolean))];
    let statusMap = {};
    if (adIds.length) {
      try {
        const sr = await fetch(`${FB_API}/?ids=${adIds.join(',')}&fields=effective_status&${auth}`);
        const sd = await sr.json();
        if (!sd.error) {
          for (const [id, d] of Object.entries(sd)) statusMap[id] = d.effective_status || 'UNKNOWN';
        }
      } catch (e) {}
    }

    const rows = raw.map(r => normalizeAd(r, statusMap));
    await redisCmd('SET', `glv:ads:${preset}`, JSON.stringify({ rows }), 'EX', String(TTL));
  } catch (e) {
    errors.push(`ads/${preset}: ${e.message}`);
  }

  return errors;
}

module.exports = async (req, res) => {
  // Vercel cron passes this header; block unauthorised calls
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.FB_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'FB_ACCESS_TOKEN not set' });

  const allErrors = [];
  for (const preset of PRESETS) {
    const errs = await fetchAndCache(token, preset);
    allErrors.push(...errs);
  }

  const success = allErrors.length === 0;
  const message = success
    ? `Cache refreshed for ${PRESETS.join(', ')} — data through ${yesterday()}`
    : `Cache refresh completed with errors: ${allErrors.join('; ')}`;

  console.log(message);
  res.json({ ok: success, message });
};
