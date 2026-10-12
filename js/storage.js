/* ---------- Local storage, normalisation, backup import/export, blueprint export ---------- */
function loadState(){
  try{
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if(saved && Array.isArray(saved.movies)) return normalizeState(saved);
  }catch(e){}
  return normalizeState(structuredClone(SEED_DATA));
}
function normalizeState(input){
  const sectionOrder = Array.isArray(input.sectionOrder) ? input.sectionOrder.map(s=>String(s).trim().toUpperCase()).filter(Boolean) : [];
  if(!sectionOrder.includes(UNSORTED_SECTION)) sectionOrder.unshift(UNSORTED_SECTION);
  const movies = (input.movies || []).map((m,i)=>{
    const fixed=cleanImportedTitleAndCatalog(m.title || 'Untitled', m.catalog || '');
    const section=(m.section || 'UNSORTED').trim().toUpperCase();
    const rawNotes=cleanNotes(m.notes || '');
    const notes = rawNotes || (fixed.catalog ? 'Catalog #'+fixed.catalog : '');
    return {
      id:m.id || cryptoId(),
      title:fixed.title || 'Untitled',
      section,
      format:normalizeFormat(m.format, section, fixed.title || '', m.id),
      barcode:m.barcode || '',
      poster:m.poster || '',
      posterRemoved:m.posterRemoved === true,
      notes,
      catalog:fixed.catalog,
      seen: m.seen === false ? false : true,
      added:m.added || today(),
      updated:m.updated || today()
    };
  }).filter(m=>!isBadImportedTitle(m.title));
  movies.forEach(m=>{if(!sectionOrder.includes(m.section)) sectionOrder.push(m.section)});
  return {movies, sectionOrder, importedFrom:input.importedFrom || 'local', importedCount:input.importedCount || movies.length, collectionValue:Number(input.collectionValue || 0), valueHistory:Array.isArray(input.valueHistory)?input.valueHistory:[]};
}
function save(){localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); updateBlueprintPreview();}
function cryptoId(){return 'm-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)}
function today(){return new Date().toISOString().slice(0,10)}
function cleanImportedTitleAndCatalog(title, catalog=''){
  let t=String(title||'').replace(/\s+/g,' ').trim();
  let cat=String(catalog||'').trim();
  const m=t.match(/^(.*?\S)\s+(\d{3,6})(?:\s*(4K))?$/i);
  if(m && (/[A-Za-zÆØÅæøå]/.test(m[1]) || /^\d{4}$/.test(m[1]))){
    t=m[1].trim();
    if(!cat) cat=m[2];
    if(m[3] && !/\b4K\b/i.test(t)) t+=' 4K';
  }
  return {title:t,catalog:cat};
}
function isBadImportedTitle(title){
  const compact=String(title||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  return !compact || compact==='TEASERDRAMA';
}
function inferFormat(section,title){
  const sec=String(section||'').toUpperCase();
  const t=String(title||'').toUpperCase();
  if(sec.includes('STEELBOOK') && (sec.includes('4K') || /\b(4K|UHD|ULTRA HD)\b/.test(t))) return '4K Steelbook';
  if(sec.includes('4K') || /\b(4K|UHD|ULTRA HD)\b/.test(t)) return '4K UHD';
  if(sec.startsWith('TV SECTION') || /\b(SEASON|COMPLETE SERIES|MINI[- ]?SERIES|TV SERIES)\b/.test(t)) return 'TV / Series';
  if(sec.includes('DVD') && !sec.includes('BLU')) return 'DVD';
  return 'Blu-ray';
}
function normalizeFormat(existing, section, title, id){
  const inferred=inferFormat(section,title);
  const known=['4K UHD','4K Steelbook','Blu-ray','DVD','TV / Series','Blu-ray / DVD','Box set'];
  const value=known.includes(existing)?existing:inferred;
  const sec=String(section||'').toUpperCase();
  const seedOrImported=String(id||'').startsWith('seed-');
  // Repair earlier imports where section names were confused with media formats.
  if(seedOrImported) return inferred;
  if((sec==='TV ROOM' || sec==='TV SERIES SHELF') && value==='TV / Series') return inferred;
  if((sec.includes('STEELBOOK') || /STEELBOOK/i.test(title)) && (sec.includes('4K') || /\b4K\b/i.test(title))) return '4K Steelbook';
  if((sec.includes('4K') || /\b4K\b/i.test(title)) && value!=='4K UHD' && value!=='4K Steelbook') return '4K UHD';
  if(value==='Blu-ray / DVD') return inferred;
  return value;
}

function exportJson(){
  const payload={...state, exportedAt:new Date().toISOString(), app:'Movie Vault'};
  downloadBlob(JSON.stringify(payload,null,2),'movie-vault-backup.json','application/json');
  toast('JSON backup exported.');
}
function importJson(e){
  const file=e.target.files?.[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const parsed=JSON.parse(reader.result);
      const imported=Array.isArray(parsed)?{movies:parsed}:parsed;
      state=normalizeState(imported);
      save(); populateSelects(); render(); updateBlueprintPreview(); toast('Import complete.'); closeBackupMenu();
    }catch(err){toast('Could not import JSON.');}
  };
  reader.readAsText(file);
  e.target.value='';
}
function groupedMovies(){
  const order=[...state.sectionOrder];
  const groups={}; order.forEach(s=>groups[s]=[]);
  state.movies.forEach(m=>{if(!groups[m.section]){groups[m.section]=[]; order.push(m.section)} groups[m.section].push(m)});
  order.forEach(s=>groups[s].sort((a,b)=>a.title.localeCompare(b.title)));
  return {order, groups};
}
function blueprintText(){
  const {order,groups}=groupedMovies();
  const year=new Date().getFullYear();
  let out='THE DIGITAL VIDEO DISC COLLECTION\n\nTHE DIGITAL VIDEO DISC COLLECTION\nFOR\nHARRY A.DAVIS.\n(1998-'+year+')\n\n\n';
  for(const sec of order){
    const list=groups[sec]; if(!list?.length) continue;
    out += sec + ':\t\t';
    list.forEach((m,i)=>{
      const extra=[];
      if(m.catalog) extra.push(m.catalog);
      if(m.seen===false) extra.push('not seen');
      if(m.barcode) extra.push('barcode '+m.barcode);
      const note=extra.length ? ' \t' + extra.join(' · ') : '';
      if(i===0) out += '* ' + m.title + note + '\n';
      else out += '\t\t\t* ' + m.title + note + '\n';
    });
    out += '\n\n';
  }
  return out;
}
function blueprintHtml(){
  const text=blueprintText();
  return `<!doctype html><html><head><meta charset="utf-8"><title>Digital Video Disc Collection Export</title><style>
  @page{margin:22mm 18mm} body{font-family:"Courier New",monospace;color:#111;background:white;font-size:12pt;line-height:1.25} .page{max-width:820px;margin:0 auto} pre{white-space:pre-wrap;margin:0} h1{font-family:Arial,sans-serif;text-align:center;font-size:18pt;margin:0 0 16pt} .meta{text-align:center;font-family:Arial,sans-serif;margin-bottom:22pt} @media print{body{font-size:11pt}.noPrint{display:none}}
  </style></head><body><div class="page"><pre>${escapeHtml(text)}</pre></div></body></html>`;
}
function updateBlueprintPreview(){ if(els.blueprintPreview) els.blueprintPreview.textContent=blueprintText().slice(0,12000) + (blueprintText().length>12000?'\n\n… Preview truncated, export contains the full list.':'');}
function exportBlueprintHtml(){downloadBlob(blueprintHtml(),'digital-video-disc-collection-blueprint.html','text/html'); toast('Blueprint HTML exported.');}
function exportBlueprintText(){downloadBlob(blueprintText(),'digital-video-disc-collection-blueprint.txt','text/plain'); toast('Blueprint TXT exported.');}
function printBlueprint(){
  const w=window.open('','_blank'); if(!w){toast('Popup blocked. Use download instead.'); return;}
  w.document.write(blueprintHtml()); w.document.close(); w.focus(); setTimeout(()=>w.print(),350);
}
function downloadBlob(content,filename,type){
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
}
