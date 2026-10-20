/** 【安全な復元】既存データを上書きしないため、取り込む記録には新しいUUIDを割り当てる。 */
import {safeItems} from './logic.js';
export function previewBackup(raw,{accountId=null,maxBytes=2_000_000}={}){
 if(typeof raw!=='string'||raw.length>maxBytes)throw Error('ファイルが大きすぎます（上限2MB）');
 let data;try{data=JSON.parse(raw)}catch{throw Error('JSONを読み取れませんでした')}
 if(!data||data.format!=='noto-backup'||data.version!==1||!Array.isArray(data.items))throw Error('noto.のバックアップ形式ではありません');
 if(data.items.length>2000)throw Error('取り込める記録は最大2000件です');
 if(data.accountId&&accountId&&data.accountId!==accountId)throw Error('異なるGoogleアカウントのバックアップです');
 const items=safeItems(data.items);
 if(items.length!==data.items.length)throw Error('不正な記録が含まれるため取り込みを中止しました');
 if(items.some(i=>i.content.length>4000))throw Error('長すぎる記録があります');
 return {items,sourceAccount:data.accountId||null,exportedAt:data.exportedAt||null};
}
export function makeRestoreItems(items,existing=[],now=new Date()){
 const current=new Set(existing.map(i=>i.kind+'\0'+i.content+'\0'+(i.dueDate||'')));
 const restored=[];
 for(const item of items){
  const fingerprint=item.kind+'\0'+item.content+'\0'+(item.dueDate||'');
  if(current.has(fingerprint))continue;
  current.add(fingerprint);
  restored.push({...item,id:crypto.randomUUID(),createdAt:now.toISOString(),updatedAt:now.toISOString()});
 }
 return restored;
}
