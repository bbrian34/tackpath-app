/** RFC-style CSV reader. Keeps rejected rows; never silently filters intake. */
export function readCSV(text){
 const rows=[];let fields=[],field='',quoted=false,afterQuote=false,line=1,start=1,error=null;
 const endField=()=>{fields.push(field.trim());field='';afterQuote=false};
 const endRow=()=>{endField();if(fields.some(v=>v!==''))rows.push({line:start,fields,error});fields=[];error=null;start=line+1};
 text=String(text).replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++}else{quoted=false;afterQuote=true}}else{field+=c;if(c==='\n')line++}continue}
  if(c==='"'&&!field&&!afterQuote){quoted=true;continue}
  if(c===','){endField();continue}
  if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;endRow();line++;continue}
  if(afterQuote&&c.trim())error='Unexpected content after quoted field';
  field+=c;
 }
 if(quoted)error='Unclosed quoted field';
 if(field||fields.length||error)endRow();
 return rows;
}
const key=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
const aliases={order_id:['orderid','ordernumber','order','packageid','barcode'],tracking_number:['trackingnumber','tracking','carrierbarcode'],recipient:['recipient','recipientname','company','customer','customername'],address:['address','deliveryaddress','street','streetaddress'],city:['city'],state:['state','province'],zip:['zip','zipcode','postalcode'],packages:['packages','pieces','packagecount','quantity'],route_hint:['routehint','route','routeid'],piece_tracking:['piecetracking','trackingnumbers']};
export function parseManifest(text){
 const input=readCSV(text);if(!input.length)return [{row_number:1,packages:null,error:'empty_manifest',raw:[]}];
 const headers=input.shift().fields.map(key);const positions={};
 for(const [name,names] of Object.entries(aliases))positions[name]=headers.findIndex(h=>names.includes(h));
 const output=input.map((row,i)=>{
  const read=name=>positions[name]<0?'':row.fields[positions[name]]||'';
  const rawCount=read('packages');const count=positions.packages<0?1:/^[1-9]\d{0,4}$/.test(rawCount)?Number(rawCount):null;
  const errors=[row.error];if(row.fields.length!==headers.length)errors.push('column_count_mismatch');if(count===null)errors.push('invalid_quantity');
  const address=[read('address'),read('city'),read('state'),read('zip')].filter(Boolean).join(', ');
  if(!address||positions.address<0)errors.push('missing_address');
  const tracking=read('tracking_number');const order=read('order_id');
  return {row_number:i+1,source_line:row.line,order_id:order||null,tracking_number:tracking||null,recipient:read('recipient'),address,packages:count,route_hint:read('route_hint')||null,piece_tracking:read('piece_tracking').split(/[;|]/).map(s=>s.trim()).filter(Boolean),error:errors.filter(Boolean).join('; ')||null,raw:row.fields};
 });
 const counts=new Map();for(const r of output)if(r.order_id)counts.set(r.order_id.toUpperCase(),(counts.get(r.order_id.toUpperCase())||0)+1);
 for(const r of output)r.order_alias=!!r.order_id&&counts.get(r.order_id.toUpperCase())===1&&r.packages===1;
 if(!output.length)output.push({row_number:1,packages:null,error:'manifest_has_no_data_rows',raw:[]});
 return output;
}
export function distance(a,b){const rad=Math.PI/180;const dlat=(b.lat-a.lat)*rad,dlng=(b.lng-a.lng)*rad;const x=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlng/2)**2;return 6371000*2*Math.asin(Math.sqrt(Math.min(1,x)))}
export function sequence(rows,origin){
 const remaining=[...rows].sort((a,b)=>a.row_number-b.row_number),out=[];let last=origin||remaining[0]?.raw.coords;
 while(remaining.length){let idx=0;for(let i=1;i<remaining.length;i++)if(distance(last,remaining[i].raw.coords)<distance(last,remaining[idx].raw.coords))idx=i;const row=remaining.splice(idx,1)[0];out.push(row);last=row.raw.coords}
 // Deterministic open-path 2-opt, anchored at the warehouse.
 for(let pass=0;pass<10;pass++){let changed=false;for(let i=0;i<out.length-1;i++)for(let j=i+1;j<out.length;j++){const a=i?out[i-1].raw.coords:origin;if(!a)continue;const b=out[i].raw.coords,c=out[j].raw.coords,d=out[j+1]?.raw.coords;if(distance(a,c)+(d?distance(b,d):0)+0.01<distance(a,b)+(d?distance(c,d):0)){out.splice(i,j-i+1,...out.slice(i,j+1).reverse());changed=true}}if(!changed)break}
 return out;
}
export function planRoutes(rows,origin,maxPieces=30){
 const groups=new Map();
 for(const row of [...rows].sort((a,b)=>a.row_number-b.row_number)){const hint=row.raw.route_hint||'auto';if(!groups.has(hint))groups.set(hint,[]);groups.get(hint).push(row)}
 const plans=[];
 for(const [hint,group] of groups){const ordered=sequence(group,origin);let bucket=[],count=0,index=0;const flush=()=>{if(bucket.length)plans.push({key:hint+':'+(++index),rows:bucket.map(r=>r.id)});bucket=[];count=0};for(const row of ordered){if(hint==='auto'&&count+row.expected_pieces>maxPieces)flush();bucket.push(row);count+=row.expected_pieces}flush()}
 return plans;
}
