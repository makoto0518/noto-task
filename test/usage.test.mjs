import test from 'node:test';
import assert from 'node:assert/strict';
import {utcDay, sumMetric, getAnalyticsMetrics, QUOTA_DAY_LIMITS} from '../worker/usage.js';
import {quotaView, FREE_LIMITS} from '../public/quota.js';

test('a missing metric is unknown, never 0 or 100% available', () => {
  assert.deepEqual(quotaView(null, 100000), {known:false,percent:null,remaining:null});
  assert.deepEqual(quotaView(undefined, 100000), {known:false,percent:null,remaining:null});
  assert.deepEqual(quotaView(-1, 100000), {known:false,percent:null,remaining:null});
  assert.deepEqual(quotaView(3000, 100000), {known:true,percent:3,remaining:97000});
  assert.equal(quotaView(120000, 100000).remaining, 0);
});

test('quota values include all free services', () => {
  for (const q of FREE_LIMITS) assert.equal(q.limit, QUOTA_DAY_LIMITS[q.key]);
});

test('day boundary follows UTC 00:00 instead of local midnight', () => {
  const t=utcDay(new Date('2026-10-20T00:02:03Z'));
  assert.equal(t.day, '2026-10-20');
  assert.equal(t.since, '2026-10-20T00:00:00.000Z');
});

test('GraphQL aggregation fails closed when counts are absent or truncated', () => {
  assert.equal(sumMetric([{sum:{requests:2}},{sum:{requests:5}}],'requests'),7);
  assert.equal(sumMetric([{sum:{requests:2}},{sum:{}}],'requests'),null);
  assert.equal(sumMetric([{sum:{requests:2}}],'requests',0),null);
});

test('without a read-only Cloudflare token every item is unknown', async () => {
  const out=await getAnalyticsMetrics({}, {fetcher:()=>{throw Error('must not call')}});
  assert.equal(out.configured,false);
  assert.ok(Object.values(out.metrics).every(x=>!x.available&&x.used===null));
});

test('account-wide GraphQL metrics are mapped, AI is not approximated', async () => {
  const calls=[];
  const fetcher=async (_url, init)=>{
    calls.push(init);
    assert.equal(init.headers.Authorization,'Bearer read-only-token');
    const variables=JSON.parse(init.body).variables;
    assert.equal(variables.accountTag,'cf-account');
    const d1=init.body.includes('d1AnalyticsAdaptiveGroups');
    return new Response(JSON.stringify({data:{viewer:{accounts:[d1?
      {d1AnalyticsAdaptiveGroups:[{sum:{rowsRead:230,rowsWritten:15}}]} :
      {workersInvocationsAdaptive:[{sum:{requests:10}},{sum:{requests:20}}]}
    ]}}}),{status:200});
  };
  const result=await getAnalyticsMetrics({CF_ANALYTICS_TOKEN:'read-only-token',CF_ACCOUNT_ID:'cf-account'}, {now:new Date('2026-10-20T01:00:00Z'),fetcher});
  assert.equal(calls.length,2);
  assert.deepEqual(result.metrics.workers,{available:true,used:30});
  assert.deepEqual(result.metrics.d1Reads,{available:true,used:230});
  assert.deepEqual(result.metrics.d1Writes,{available:true,used:15});
  assert.equal(result.metrics.aiNeurons.available,false);
});

test('upstream analytics failure never becomes zero usage', async () => {
  const out=await getAnalyticsMetrics({CF_ANALYTICS_TOKEN:'x',CF_ACCOUNT_ID:'a'}, {fetcher:async()=>new Response('Unauthorized',{status:403})});
  assert.ok(Object.values(out.metrics).every(x=>x.available===false));
});
