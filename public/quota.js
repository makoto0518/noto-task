/**
 * Quota view only: it is intentionally not mounted on the capture screen.
 * Values come from the authenticated server API; missing numbers stay unknown.
 * Never generate a fictitious usage percentage or infer Neurons from AI call counts.
 */
export const FREE_LIMITS = [
  { key: 'workers', title: 'Workers API', unit: '回 / 日', limit: 100000 },
  { key: 'd1Reads', title: 'D1 読み取り', unit: '行 / 日', limit: 5000000 },
  { key: 'd1Writes', title: 'D1 書き込み', unit: '行 / 日', limit: 100000 },
  { key: 'aiNeurons', title: 'Workers AI', unit: 'Neurons / 日', limit: 10000 },
];

export function quotaView(value, limit) {
  // If Cloudflare analytics is disconnected or delayed, do not claim a remaining allowance.
  if (!Number.isFinite(value) || value < 0) return { known: false, percent: null, remaining: null };
  return {
    known: true,
    percent: Math.min(100, Math.round(value / limit * 1000) / 10),
    remaining: Math.max(0, limit - value),
  };
}

const fmt = new Intl.NumberFormat('ja-JP');
const quotaElement = id => document.getElementById(id);

function quotaCard(def, metric) {
  const outer = document.createElement('article');
  outer.className = 'quota-card glass';
  const head = document.createElement('div'); head.className = 'quota-heading';
  const name = document.createElement('h3'); name.textContent = def.title;
  const status = document.createElement('span'); status.className = 'quota-state';
  head.append(name, status);
  const numbers = document.createElement('div'); numbers.className = 'quota-numbers';
  const used = document.createElement('strong');
  const limit = document.createElement('span'); limit.textContent = `上限 ${fmt.format(def.limit)} ${def.unit}`;
  numbers.append(used, limit);
  const meter = document.createElement('div'); meter.className = 'quota-meter';
  meter.setAttribute('role', 'progressbar'); meter.setAttribute('aria-label', def.title);
  const bar = document.createElement('div'); bar.className = 'quota-meter-fill'; meter.append(bar);
  const foot = document.createElement('p'); foot.className = 'quota-foot';
  const value = metric && metric.available === true ? metric.used : null;
  const result = quotaView(value, def.limit);
  if (!result.known) {
    status.textContent = '未取得'; used.textContent = '—';
    meter.setAttribute('aria-valuetext', '使用量を取得できません');
    bar.style.width = '0%';
    foot.textContent = def.key === 'aiNeurons' ? 'NeuronsはCloudflare管理画面で確認してください。' : '閲覧用のCloudflare Analytics接続が必要です。';
  } else {
    const critical = result.percent >= 95, warning = result.percent >= 80;
    status.textContent = critical ? '残りわずか' : warning ? '注意' : '取得済み';
    status.classList.toggle('warning', warning);
    used.textContent = `${fmt.format(value)} / ${fmt.format(def.limit)}`;
    used.className = 'quota-value';
    meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', String(def.limit));
    meter.setAttribute('aria-valuenow', String(value));
    bar.style.width = `${result.percent}%`; bar.classList.toggle('warning', warning);
    foot.textContent = `残りの目安 ${fmt.format(result.remaining)} ${def.key === 'aiNeurons' ? 'Neurons' : def.unit.split(' ')[0]} · ${result.percent}% 使用`;
  }
  outer.append(head, numbers, meter, foot);
  return outer;
}

export function renderQuotaPanel(data) {
  const list = quotaElement('quota-cards'); if (!list) return;
  list.replaceChildren(...FREE_LIMITS.map(def => quotaCard(def, data?.metrics?.[def.key])));
  const info = quotaElement('quota-source');
  if (data?.observedAt && data?.configured) {
    const stamp = new Date(data.observedAt);
    info.textContent = `${Number.isNaN(stamp.getTime()) ? '時刻不明' : stamp.toLocaleString('ja-JP')} 時点の集計値 · Cloudflare Analytics（反映遅延あり）`;
  } else {
    info.textContent = '現在の使用量は未接続です。値を推測して表示することはありません。';
  }
  // Account totals also contain usage from other Workers and databases. Do not imply
  // that these bars represent only requests initiated by this device/user.
  quotaElement('quota-notice').textContent = data?.message || 'アカウント全体の無料枠が対象です。集計には遅延があります。';
  if (data?.aiCalls && Number.isFinite(data.aiCalls.used)) {
    quotaElement('quota-ai-calls').textContent = `noto.のAIボタン：本日 ${data.aiCalls.used} / 20回（これはNeuronsの使用率ではありません）`;
  } else quotaElement('quota-ai-calls').textContent = 'AIの呼び出し回数も、Googleログイン後に確認できます。';
}
