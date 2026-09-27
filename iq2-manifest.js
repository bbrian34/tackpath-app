// IQ2 inbound manifest / ASN and location-registry CSV handling.
//
// Used by iq2-admin.html (browser) and by the tests (Node). This is a
// PREVIEW: it gives the office immediate, row-by-row feedback. The
// database function iq2_admin_import_manifest re-validates everything and
// is the only authority -- nothing here can make bad data importable.
(function(root){
  'use strict';

  // RFC 4180 CSV: quoted fields, doubled quotes, commas/newlines in quotes,
  // CRLF or LF, optional UTF-8 BOM. Returns an array of string arrays.
  function parseCsv(text){
    const s=String(text==null?'':text).replace(/^﻿/,'');
    const rows=[]; let row=[], field='', i=0, quoted=false;
    while(i<s.length){
      const c=s[i];
      if(quoted){
        if(c==='"'){ if(s[i+1]==='"'){ field+='"'; i+=2; continue; } quoted=false; i++; continue; }
        field+=c; i++; continue;
      }
      if(c==='"'&&field===''){ quoted=true; i++; continue; }
      if(c===','){ row.push(field); field=''; i++; continue; }
      if(c==='\r'){ i++; continue; }
      if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; i++; continue; }
      field+=c; i++;
    }
    if(field!==''||row.length){ row.push(field); rows.push(row); }
    return rows.filter(r=>r.some(v=>String(v).trim()!==''));
  }

  const key=h=>String(h||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');

  const MANIFEST_COLUMNS={
    load_ref:        ['load_ref','load','load_reference','load_id','asn','asn_number','asn_id','shipment','shipment_id','inbound_ref'],
    pallet:          ['pallet','pallet_id','pallet_barcode','pallet_label','pallet_code'],
    carton_barcode:  ['carton_barcode','carton','carton_id','carton_code','case_barcode','case_id','barcode','handling_unit'],
    sku:             ['sku','item','item_number','item_code','product_code'],
    description:     ['description','product','product_description','item_description','product_name'],
    units_per_carton:['units_per_carton','qty_per_carton','units_per_case','case_pack','pack_qty','inner_qty'],
    cartons:         ['cartons','cartons_expected','expected_cartons','carton_qty','carton_quantity','cases','case_qty']
  };
  const MANIFEST_REQUIRED=['load_ref','pallet','carton_barcode','sku','units_per_carton','cartons'];

  const LOCATION_COLUMNS={
    code:   ['code','location','location_code','loc','label'],
    aisle:  ['aisle'],
    bay:    ['bay','position','bay_position'],
    shelf:  ['shelf','level','shelf_level'],
    enabled:['enabled','active','status']
  };

  function mapHeader(header, spec){
    const idx={}, keys=header.map(key);
    Object.keys(spec).forEach(f=>{
      const at=keys.findIndex(k=>spec[f].includes(k));
      if(at>=0) idx[f]=at;
    });
    return idx;
  }

  const norm=v=>String(v==null?'':v).trim().toUpperCase();
  const isPosInt=v=>/^[0-9]{1,7}$/.test(String(v).trim())&&parseInt(v,10)>=1;

  // → {rows, errors, warnings, summary}. rows are the objects the server
  // function takes; `row` is the 1-based line number in the file.
  function parseManifest(text){
    const table=parseCsv(text);
    const errors=[], warnings=[];
    if(!table.length) return {rows:[],errors:[{row:0,field:'file',message:'The file is empty.'}],warnings,summary:null};
    const idx=mapHeader(table[0], MANIFEST_COLUMNS);
    const missing=MANIFEST_REQUIRED.filter(f=>idx[f]===undefined);
    if(missing.length){
      return {rows:[],warnings,summary:null,errors:[{row:1,field:'header',
        message:'Missing required column(s): '+missing.join(', ')+'. Found: '+table[0].join(', ')}]};
    }
    const rows=table.slice(1).map((r,i)=>{
      const o={row:i+2};
      Object.keys(MANIFEST_COLUMNS).forEach(f=>{ o[f]=idx[f]===undefined?'':String(r[idx[f]]==null?'':r[idx[f]]).trim(); });
      return o;
    });
    if(!rows.length) errors.push({row:1,field:'file',message:'The file has a header but no data rows.'});

    rows.forEach(o=>{
      if(!o.load_ref) errors.push({row:o.row,field:'load_ref',message:'Load reference is required.'});
      if(!o.pallet) errors.push({row:o.row,field:'pallet',message:'Pallet barcode is required.'});
      if(!o.carton_barcode) errors.push({row:o.row,field:'carton_barcode',message:'Carton barcode is required.'});
      if(!o.sku) errors.push({row:o.row,field:'sku',message:'SKU is required.'});
      if(!isPosInt(o.units_per_carton)) errors.push({row:o.row,field:'units_per_carton',message:'Units per carton must be a whole number of at least 1 (got "'+o.units_per_carton+'").'});
      if(!isPosInt(o.cartons)) errors.push({row:o.row,field:'cartons',message:'Carton quantity must be a whole number of at least 1 (got "'+o.cartons+'").'});
    });

    const group=(keyFn)=>{ const m=new Map(); rows.forEach(o=>{ const k=keyFn(o); if(k==null)return; if(!m.has(k))m.set(k,[]); m.get(k).push(o); }); return m; };
    group(o=>o.pallet&&o.carton_barcode?norm(o.pallet)+'\u0000'+norm(o.carton_barcode):null).forEach(list=>{
      if(list.length>1) errors.push({row:list[1].row,field:'carton_barcode',message:'Carton barcode '+list[0].carton_barcode+' appears more than once on pallet '+list[0].pallet+' (rows '+list.map(o=>o.row).join(', ')+'). List it once with the total carton quantity.'});
    });
    group(o=>o.pallet?norm(o.pallet):null).forEach(list=>{
      const refs=[...new Set(list.map(o=>o.load_ref).filter(Boolean))];
      if(refs.length>1) errors.push({row:list[0].row,field:'load_ref',message:'Pallet '+list[0].pallet+' is listed under more than one load reference ('+refs.join(', ')+').'});
    });
    group(o=>o.carton_barcode?norm(o.carton_barcode):null).forEach(list=>{
      const kinds=new Set(list.filter(o=>o.sku&&isPosInt(o.units_per_carton)).map(o=>o.sku+'\u0000'+parseInt(o.units_per_carton,10)));
      if(kinds.size>1) errors.push({row:list[0].row,field:'carton_barcode',message:'Carton barcode '+list[0].carton_barcode+' is listed with different contents (SKU/units per carton) on rows '+list.map(o=>o.row).join(', ')+'.'});
    });
    group(o=>o.sku||null).forEach(list=>{
      const d=new Set(list.map(o=>o.description));
      if(d.size>1) errors.push({row:list[0].row,field:'description',message:'SKU '+list[0].sku+' has different descriptions on rows '+list.map(o=>o.row).join(', ')+'.'});
    });

    errors.sort((a,b)=>a.row-b.row);
    const valid=rows.filter(o=>isPosInt(o.units_per_carton)&&isPosInt(o.cartons));
    const summary={
      rows:rows.length,
      loads:new Set(rows.map(o=>o.load_ref).filter(Boolean)).size,
      pallets:new Set(rows.map(o=>norm(o.pallet)).filter(Boolean)).size,
      skus:new Set(rows.map(o=>o.sku).filter(Boolean)).size,
      cartons:valid.reduce((n,o)=>n+parseInt(o.cartons,10),0),
      units:valid.reduce((n,o)=>n+parseInt(o.cartons,10)*parseInt(o.units_per_carton,10),0)
    };
    return {rows,errors,warnings,summary};
  }

  function parseLocations(text){
    const table=parseCsv(text);
    if(!table.length) return {rows:[],errors:[{row:0,field:'file',message:'The file is empty.'}]};
    const idx=mapHeader(table[0], LOCATION_COLUMNS);
    if(idx.code===undefined) return {rows:[],errors:[{row:1,field:'header',message:'Missing required column: code (or location).'}]};
    const errors=[];
    const rows=table.slice(1).map((r,i)=>{
      const o={row:i+2};
      Object.keys(LOCATION_COLUMNS).forEach(f=>{ o[f]=idx[f]===undefined?'':String(r[idx[f]]==null?'':r[idx[f]]).trim(); });
      if(!o.enabled) o.enabled='true';
      return o;
    });
    const seen=new Map();
    rows.forEach(o=>{
      const code=norm(o.code).replace(/^(LOC|LOCATION)[:\s-]*/,'');
      if(!/^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(code)) errors.push({row:o.row,field:'code',message:'Location code is required: letters, digits, - _ . / only, up to 40 characters.'});
      else if(seen.has(code)) errors.push({row:o.row,field:'code',message:'Location '+code+' is listed more than once (also row '+seen.get(code)+').'});
      else seen.set(code,o.row);
      if(!['true','false','yes','no','1','0','y','n'].includes(o.enabled.toLowerCase())) errors.push({row:o.row,field:'enabled',message:'Enabled must be true/false/yes/no/1/0.'});
    });
    return {rows,errors};
  }

  const api={parseCsv,parseManifest,parseLocations,MANIFEST_COLUMNS,LOCATION_COLUMNS};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.IQ2Manifest=api;
})(typeof window!=='undefined'?window:this);
