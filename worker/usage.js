/**
 * 【無料枠の実データ取得】Cloudflare AnalyticsのGraphQL APIを読み取り専用で呼び出す。
 * worker/index.jsの /api/usage から、管理者本人と確認できた場合のみ利用する。
 * CF_ANALYTICS_TOKENはWorkerのSecretに保存し、ブラウザへは絶対に返さない。
 * 取得失敗を「0」と扱うと残り枠が十分だと誤認するため、null（不明）にする。
 * UI側の public/quota.js が「未取得」という表記に変換する。
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
/**
 * 【アカウント全体を集計】noto.利用者や別のWorkerも同じCloudflare無料枠を共有する。
 * そのためユーザー個人の値ではなくCF_ACCOUNT_ID全体のデータを集計する。
 * テストではfetcherを差し替え、秘密情報や実際のAPIを使わず結果を検証できる。
 */
export async function getAnalyticsMetrics(env, {now=new Date(), fetcher=fetch}={}) {
  const metrics = {
    workers: {available:false,used:null}, d1Reads:{available:false,used:null},
    d1Writes:{available:false,used:null}, aiNeurons:{available:false,used:null},
  };
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return {configured:false,metrics,observedAt:null};
  const {day,since,until} = utcDay(now);
  const variables={accountTag:env.CF_ACCOUNT_ID, since, until, day};
  // 1回の取得上限に達して集計結果が途中で切れた可能性があるときは合計値と断定しない。
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
  // Workers AIのNeuronsはCloudflareが計測した値を直接取得する。
  // 「AIを3回呼んだから何Neurons」と推測しない（モデル・入力によって計算量が異なる）。
  // 集計対象日はUTC（世界標準時）で区切り、Free枠の更新と対応させる。
  // APIの形式や権限が違って取得に失敗しても、Workers/D1の数字まで隠さない。
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
    }catch{/* 取得できない場合は「未取得」。実際に0回使用したとは断定しない。 */}})(),
    (async()=>{try {
      const data=await graphql(env,d1Query,variables,fetcher);
      const groups=data?.d1AnalyticsAdaptiveGroups;
      const read=sumMetric(groups,'rowsRead'),write=sumMetric(groups,'rowsWritten');
      if(read!==null)metrics.d1Reads={available:true,used:read};
      if(write!==null)metrics.d1Writes={available:true,used:write};
    }catch{/* APIの形式・権限エラーは「未取得」として扱う。 */}})(),
    (async()=>{try {
      const data=await graphql(env,aiQuery,variables,fetcher);
      const used=sumMetric(data?.aiInferenceAdaptiveGroups,'totalNeurons');
      if(used!==null)metrics.aiNeurons={available:true,used};
    }catch{/* AIデータの権限不足や障害は0扱いせず「未取得」を維持する。 */}})(),
  ]);
  return {configured:true,metrics,observedAt:now.toISOString()};
}
