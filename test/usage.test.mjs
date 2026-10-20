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

test('account-wide Workers, D1 and AI neuron usage comes from GraphQL', async () => {
  const calls=[];
  const fetcher=async (_url,init)=>{
    const req=JSON.parse(init.body);
    calls.push(req);
    assert.equal(init.headers.Authorization,'Bearer read-only-token');
    assert.equal(req.variables.accountTag,'cf-account');
    let dataset;
    if(req.query.includes('aiInferenceAdaptiveGroups')){
      assert.match(req.query,/sum \{ totalNeurons \}/);
      dataset={aiInferenceAdaptiveGroups:[{sum:{totalNeurons:5.53}},{sum:{totalNeurons:5.47}}]};
    }else if(req.query.includes('d1AnalyticsAdaptiveGroups')){
      dataset={d1AnalyticsAdaptiveGroups:[{sum:{rowsRead:230,rowsWritten:15}}]};
    }else{
      dataset={workersInvocationsAdaptive:[{sum:{requests:10}},{sum:{requests:20}}]};
    }
    return Response.json({data:{viewer:{accounts:[dataset]}}});
  };
  const result=await getAnalyticsMetrics({CF_ANALYTICS_TOKEN:'read-only-token',CF_ACCOUNT_ID:'cf-account'},{now:new Date('2026-10-20T01:00:00Z'),fetcher});
  assert.equal(calls.length,3);
  assert.deepEqual(result.metrics.workers,{available:true,used:30});
  assert.deepEqual(result.metrics.d1Reads,{available:true,used:230});
  assert.deepEqual(result.metrics.d1Writes,{available:true,used:15});
  assert.deepEqual(result.metrics.aiNeurons,{available:true,used:11});
});

test('AI GraphQL unavailable leaves Neurons unknown without hiding Workers and D1',async()=>{
  const fetcher=async (_url,init)=>{
    const query=JSON.parse(init.body).query;
    if(query.includes('aiInferenceAdaptiveGroups'))return Response.json({errors:[{message:'field unavailable'}]});
    return Response.json({data:{viewer:{accounts:[query.includes('d1AnalyticsAdaptiveGroups')?
      {d1AnalyticsAdaptiveGroups:[{sum:{rowsRead:4,rowsWritten:2}}]}:
      {workersInvocationsAdaptive:[{sum:{requests:8}}]}
    ]}}});
  };
  const out=await getAnalyticsMetrics({CF_ANALYTICS_TOKEN:'x',CF_ACCOUNT_ID:'a'},{fetcher});
  assert.equal(out.metrics.aiNeurons.available,false);
  assert.equal(out.metrics.workers.used,8);
  assert.equal(out.metrics.d1Reads.used,4);
});
test('upstream analytics failure never becomes zero usage', async () => {
  const out=await getAnalyticsMetrics({CF_ANALYTICS_TOKEN:'x',CF_ACCOUNT_ID:'a'}, {fetcher:async()=>new Response('Unauthorized',{status:403})});
  assert.ok(Object.values(out.metrics).every(x=>x.available===false));
});
