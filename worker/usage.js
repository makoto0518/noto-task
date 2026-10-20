/**
 * Read-only Cloudflare Analytics adapter. Only the configured owner may use it.
 * No API token is sent to browsers; Cloudflare credentials must be Worker secrets.
 * Missing / failing metrics are null, NEVER zero (zero would suggest full allowance).
 */
const endpoints = 'https://api.cloudflare.com/client/v4/graphql';
export const QUOTA_DAY_LIMITS = Object.freeze({workers: 100000, d1Reads: 5000000, d1Writes: 100000, aiNeurons: 10000});
export function utcDay(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { day: start.toISOString().slice(0, 10), since: start.toISOString(), until: now.toISOString() };
}
export function sumMetric(groups, name, maxGroups=999) {
  if (!Array.isArray(groups) || groups.length > maxGroups) return null;
  let total = 0;
  for (const group of groups) {
    const value = group?.sum?.[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return total;
}
async function graphql(env, query, variables, fetcher) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetcher(endpoints, {
      method:'POST',
      headers: {'Authorization': `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type':'application/json'},
      body:JSON.stringify({query, variables}),signal:controller.signal,
    });
    if (!response.ok) throw new Error('Cloudflare Analytics unavailable');
    const json = await response.json();
    if (json.errors?.length) throw new Error('Cloudflare Analytics query error');
    return json.data?.viewer?.accounts?.[0];
  } finally { clearTimeout(timeout); }
}
/** Analytics must be account-wide because all Workers/D1 resources share Free quotas. */
export async function getAnalyticsMetrics(env, {now=new Date(), fetcher=fetch}={}) {
  const metrics = {
    workers: {available:false,used:null}, d1Reads:{available:false,used:null},
    d1Writes:{available:false,used:null}, aiNeurons:{available:false,used:null},
  };
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return {configured:false,metrics,observedAt:null};
  const {day,since,until} = utcDay(now);
  const variables={accountTag:env.CF_ACCOUNT_ID, since, until, day};
  // Use explicit 999-row cap: any truncated response must NOT be shown as a total.
  const workerQuery=`query($accountTag: string, $since: string, $until: string) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $since, datetime_leq: $until}) {
        sum { requests }
      }
    } }
  }`;
  const d1Query=`query($accountTag: string!, $day: Date) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: {date_geq: $day, date_leq: $day}) {
        sum { rowsRead rowsWritten }
      }
    } }
  }`;
  // Workers AI: the account-scoped inference dataset reports billable Neurons
  // directly. Never estimate from app call counts, token counts or model prices.
  // The UTC day filter matches the daily Cloudflare Free allowance reset.
  // Schema/permission mismatches leave AI marked "unavailable" without
  // affecting already-working Workers and D1 usage data.
  const aiQuery=`query($accountTag: string!, $day: Date) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      aiInferenceAdaptiveGroups(limit: 1000, filter: {date_geq: $day, date_leq: $day}) {
        sum { totalNeurons }
      }
    } }
  }`;
  await Promise.all([
    (async()=>{try {
      const data=await graphql(env,workerQuery,variables,fetcher);
      const groups=data?.workersInvocationsAdaptive;
      const value= sumMetric(groups,'requests');
      if(value !== null) metrics.workers={available:true,used:value};
    }catch{/* Show 'unavailable', not fake zero. */}})(),
    (async()=>{try {
      const data=await graphql(env,d1Query,variables,fetcher);
      const groups=data?.d1AnalyticsAdaptiveGroups;
      const read=sumMetric(groups,'rowsRead'),write=sumMetric(groups,'rowsWritten');
      if(read!==null)metrics.d1Reads={available:true,used:read};
      if(write!==null)metrics.d1Writes={available:true,used:write};
    }catch{/* Schema or permission errors are explicitly unknown. */}})(),
    (async()=>{try {
      const data=await graphql(env,aiQuery,variables,fetcher);
      const used=sumMetric(data?.aiInferenceAdaptiveGroups,'totalNeurons');
      if(used!==null)metrics.aiNeurons={available:true,used};
    }catch{/* Unsupported field, permissions, or service outage: do not invent 0. */}})(),
  ]);
  return {configured:true,metrics,observedAt:now.toISOString()};
}
