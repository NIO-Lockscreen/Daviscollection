/* ---------- Local storage, normalisation, backup import/export, blueprint export ---------- */
const SCHEMA_VERSION = 2;
const KNOWN_FORMATS = ['4K UHD','4K Steelbook','Blu-ray','DVD','TV / Series','Blu-ray / DVD','Box set'];
const COVER_CACHE_KEY_START = 'movieVault.smartCoverCache'; // any version suffix
const SNAPSHOT_KEY = 'movieVault.preImportSnapshot';
const LAST_EXPORT_KEY = 'movieVault.lastExportAt';
const LAST_CHANGE_KEY = 'movieVault.lastChangeAt';
const PRE_MIGRATION_KEY = 'movieVault.preMigrationBackup'; // raw copy of a pre-v2 save, kept before it is migrated
const UNREADABLE_KEY = 'movieVault.unreadableSave';        // raw copy of a save that could not be parsed
const BACKUP_REMINDER_DAYS = 7;
const TO_SORT_DEFAULT_RE = /TEMPORARY|NEED TO BE ARRANGED|NOT PLACED/i; // shelves that count as "still waiting to be sorted" when a save has no toSortShelves list yet
let loadNotice = '', storagePersisted = null, shareSupported = false, hasSnapshot = false, pendingImport = null, lastSaveWarnAt = 0, lastSyncAt = 0, syncTimer = 0;

function vaultGet(key){try{return localStorage.getItem(key)}catch(e){return null}}
function vaultSet(key,value){try{localStorage.setItem(key,value); return true}catch(e){return false}}
function vaultDrop(key){try{localStorage.removeItem(key)}catch(e){}}
function isQuotaError(e){return !!e && (e.name==='QuotaExceededError' || e.name==='NS_ERROR_DOM_QUOTA_REACHED' || e.code===22 || e.code===1014)}
function purgeCoverCache(){
  try{
    const keys=[]; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k && k.startsWith(COVER_CACHE_KEY_START)) keys.push(k);}
    keys.forEach(k=>localStorage.removeItem(k)); return keys.length;
  }catch(e){return 0}
}
// setItem that survives a full storage: on a quota error drop the (re-creatable) cover cache and retry once.
function writeKey(key,value){
  try{localStorage.setItem(key,value); return true}
  catch(e){
    if(!isQuotaError(e)) return false;
    purgeCoverCache();
    try{localStorage.setItem(key,value); return true}catch(e2){return false}
  }
}
function writeState(s){return writeKey(STORAGE_KEY, JSON.stringify(s))}

function loadState(){
  let raw=null;
  try{
    raw=localStorage.getItem(STORAGE_KEY);
    const saved=raw ? JSON.parse(raw) : null;
    if(saved && Array.isArray(saved.movies)){
      const s=normalizeState(saved);
      if(!isCurrentSchema(saved)){ // older save: the legacy repairs just ran once, store the result as v2 so they never run again
        if(vaultGet(PRE_MIGRATION_KEY)===null) vaultSet(PRE_MIGRATION_KEY, raw);
        if(writeState(s) && vaultGet(LAST_CHANGE_KEY)===null) vaultSet(LAST_CHANGE_KEY, new Date().toISOString()); // data that was never exported counts as unbacked-up
      }else if(!Array.isArray(saved.toSortShelves)) writeState(s); // first load after toSortShelves was added: store the default list once (not a user change, so LAST_CHANGE stays)
      return s;
    }
  }catch(e){}
  if(raw){ // something is stored but unusable: keep a copy of it before anything can overwrite it
    if(vaultGet(UNREADABLE_KEY)===null) vaultSet(UNREADABLE_KEY, raw);
    loadNotice='Your saved collection could not be read, so the built-in list was loaded. The unreadable data is still kept in this browser (movieVault.unreadableSave).';
    return normalizeState(structuredClone(SEED_DATA));
  }
  const s=normalizeState(structuredClone(SEED_DATA)); // first run: the embedded seed is v1 data, migrated once
  writeState(s);
  return s;
}
function isCurrentSchema(input){return Number(input && input.schemaVersion) >= SCHEMA_VERSION}
const txt=v=>v==null ? '' : String(v);
// Current-version data is kept exactly as stored; only missing fields get defaults.
function currentMovie(m){
  const title=txt(m.title).trim() ? txt(m.title) : 'Untitled';
  const section=txt(m.section).trim() ? txt(m.section) : UNSORTED_SECTION;
  return {...m, id:txt(m.id) || cryptoId(), title, section, format:KNOWN_FORMATS.includes(m.format) ? m.format : inferFormat(section,title), barcode:txt(m.barcode), poster:txt(m.poster), posterRemoved:m.posterRemoved === true, notes:txt(m.notes), catalog:txt(m.catalog), seen:m.seen !== false, added:m.added || today(), updated:m.updated || today()};
}
// Legacy repairs (schemaVersion missing or < 2): title/catalog cleanup, notes catalog fill, format inference. Behaviour is unchanged from before v2.
function legacyMovie(m){
  const fixed=cleanImportedTitleAndCatalog(m.title || 'Untitled', m.catalog || '');
  const section=String(m.section || 'UNSORTED').trim().toUpperCase();
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
}
function normalizeState(input){
  input=input || {};
  const current=isCurrentSchema(input);
  const sectionOrder = Array.isArray(input.sectionOrder)
    ? (current ? input.sectionOrder.map(txt).filter(s=>s.trim()) : input.sectionOrder.map(s=>String(s).trim().toUpperCase()).filter(Boolean))
    : [];
  if(!sectionOrder.includes(UNSORTED_SECTION)) sectionOrder.unshift(UNSORTED_SECTION);
  const list=(Array.isArray(input.movies) ? input.movies : []).filter(m=>m && typeof m==='object');
  const movies = current ? list.map(currentMovie) : list.map(legacyMovie).filter(m=>!isBadImportedTitle(m.title));
  movies.forEach(m=>{if(!sectionOrder.includes(m.section)) sectionOrder.push(m.section)});
  // Shelves still waiting to be sorted (UNSORTED / NOT PLACED always counts and is not stored). A missing list is filled from the shelf names once.
  const toSortShelves = Array.isArray(input.toSortShelves)
    ? [...new Set(input.toSortShelves.map(s=>current ? txt(s) : String(s).trim().toUpperCase()).filter(s=>s.trim() && s!==UNSORTED_SECTION && sectionOrder.includes(s)))]
    : sectionOrder.filter(s=>s!==UNSORTED_SECTION && TO_SORT_DEFAULT_RE.test(s));
  return {schemaVersion:SCHEMA_VERSION, movies, sectionOrder, toSortShelves, importedFrom:input.importedFrom || 'local', importedCount:input.importedCount || movies.length, collectionValue:Number(input.collectionValue || 0), valueHistory:Array.isArray(input.valueHistory)?input.valueHistory:[]};
}
function save(){
  if(!writeState(state)){warnSaveFailed(); return false;}
  vaultSet(LAST_CHANGE_KEY, new Date().toISOString());
  updateBackupUi();
  if(activeScreen==='export') updateBlueprintPreview();
  return true;
}
function warnSaveFailed(){
  if(Date.now()-lastSaveWarnAt<6000) return; // covers.js can call save() in bursts
  lastSaveWarnAt=Date.now();
  toast('Could not save your collection in this browser (storage is full or unavailable). Export a backup NOW: Backup ▾ → Export JSON backup. Changes made since the last successful save may be lost.', 12000);
}
function cryptoId(){return 'm-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)}
function today(){return new Date().toISOString().slice(0,10)}
function localDateStamp(d=new Date()){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
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
// Legacy format repair, only used when migrating pre-v2 data (see legacyMovie).
function normalizeFormat(existing, section, title, id){
  const inferred=inferFormat(section,title);
  const value=KNOWN_FORMATS.includes(existing)?existing:inferred;
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

/* ---------- Export ---------- */
function exportPayload(){return {...state, schemaVersion:SCHEMA_VERSION, exportedAt:new Date().toISOString(), app:'Movie Vault'}}
function backupFilename(){return 'movie-vault-backup-'+localDateStamp()+'.json'}
function markExported(){vaultSet(LAST_EXPORT_KEY, new Date().toISOString()); updateBackupUi();}
function exportJson(){
  downloadBlob(JSON.stringify(exportPayload(),null,2),backupFilename(),'application/json');
  markExported();
  toast('JSON backup exported.');
}
async function shareBackup(){
  const file=new File([JSON.stringify(exportPayload(),null,2)], backupFilename(), {type:'application/json'});
  try{
    await navigator.share({files:[file], title:'Movie Vault backup'});
    markExported(); toast('Backup shared.');
  }catch(e){
    if(e && e.name==='AbortError') return; // user closed the share sheet
    toast('Sharing did not work here. Use Export JSON backup instead.');
  }
}
function canShareBackupFiles(){
  try{return !!(navigator.share && navigator.canShare && navigator.canShare({files:[new File(['{}'],'movie-vault-backup.json',{type:'application/json'})]}))}catch(e){return false}
}
function csvCell(v){const s=txt(v); return /[";\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s}
function collectionCsv(){ // ';' separated + UTF-8 BOM so Norwegian-locale Excel opens it correctly
  const {order,groups}=groupedMovies();
  const rows=[['Title','Section','Format','Seen','Barcode','Catalog','Notes','Added','Updated','Poster URL']];
  order.forEach(sec=>groups[sec].forEach(m=>rows.push([m.title,m.section,m.format,m.seen===false?'no':'yes',m.barcode,m.catalog,m.notes,m.added,m.updated,m.poster])));
  return '﻿'+rows.map(r=>r.map(csvCell).join(';')).join('\r\n')+'\r\n';
}
function exportCsv(){
  downloadBlob(collectionCsv(),'movie-vault-collection-'+localDateStamp()+'.csv','text/csv;charset=utf-8');
  toast('Spreadsheet (CSV) exported.');
}

/* ---------- Import: validate, ask, snapshot, merge/replace, undo ---------- */
function importJson(e){
  const file=e.target.files?.[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>beginImport(String(reader.result||''));
  reader.onerror=()=>toast('Could not read that file.');
  reader.readAsText(file);
  e.target.value='';
  closeBackupMenu();
}
function parseBackup(text){
  let data; try{data=JSON.parse(text)}catch(e){return {error:'That file is not valid JSON, so it cannot be imported.'}}
  if(Array.isArray(data)) data={movies:data};
  if(!data || typeof data!=='object' || !Array.isArray(data.movies)) return {error:'That file is not a Movie Vault backup (no movie list found).'};
  const movies=data.movies.filter(m=>m && typeof m==='object' && !Array.isArray(m));
  if(!movies.length) return {error:'That backup has no movies in it.'};
  if(!movies.some(m=>typeof m.title==='string' && m.title.trim())) return {error:'That file does not look like a movie list (no titles found).'};
  return {data:{...data, movies}};
}
function beginImport(text){
  const parsed=parseBackup(text);
  if(parsed.error){toast(parsed.error, 4500); return;}
  let incoming; try{incoming=normalizeState(parsed.data)}catch(err){toast('Could not read that backup file.', 4500); return;}
  if(!incoming.movies.length){toast('That backup has no usable movies in it.', 4500); return;}
  pendingImport={incoming, exportedAt:parsed.data.exportedAt, listed:Array.isArray(parsed.data.toSortShelves)};
  showImportDialog();
}
function mergeStates(cur, inc, incListed=true){ // incListed: the file had its own toSortShelves (an older backup only has the name-based default, which must not re-flag shelves you already know)
  const movies=cur.movies.slice(), at=new Map(), addedIds=new Set(); let added=0, updated=0;
  movies.forEach((m,i)=>at.set(m.id,i));
  inc.movies.forEach(m=>{
    const i=at.get(m.id);
    if(i===undefined){at.set(m.id,movies.length); movies.push(m); addedIds.add(m.id); added++;}
    else if(String(m.updated||'')>String(movies[i].updated||'')){movies[i]=m; if(!addedIds.has(m.id)) updated++;}
  });
  const hasValue=s=>!!s.collectionValue || (s.valueHistory||[]).length>0;
  const useFileValue=!hasValue(cur) && hasValue(inc);
  const toSortShelves=[...cur.toSortShelves, ...inc.toSortShelves.filter(s=>incListed || !cur.sectionOrder.includes(s))];
  const state=normalizeState({schemaVersion:SCHEMA_VERSION, movies, sectionOrder:[...cur.sectionOrder, ...inc.sectionOrder], toSortShelves, importedFrom:cur.importedFrom, importedCount:movies.length,
    collectionValue:useFileValue ? inc.collectionValue : cur.collectionValue, valueHistory:useFileValue ? inc.valueHistory : cur.valueHistory});
  state.sectionOrder=[...new Set(state.sectionOrder)];
  return {state, added, updated};
}
function showImportDialog(){
  const p=pendingImport, modal=$('importModal'); if(!p || !modal) return;
  const when=p.exportedAt && !isNaN(Date.parse(p.exportedAt)) ? 'exported '+new Date(p.exportedAt).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) : 'export date unknown';
  $('importSummary').textContent=`This file: ${p.incoming.movies.length} movies, ${when} · Your current collection: ${state.movies.length} movies`;
  const m=mergeStates(state,p.incoming,p.listed);
  $('importMergeInfo').textContent=`adds the movies you don't have yet and keeps the newer version of movies in both (${m.added} to add, ${m.updated} to update). Your current movies stay.`;
  $('importReplaceInfo').textContent=`swaps your whole collection for the ${p.incoming.movies.length} movies in this file.`;
  modal.classList.add('active');
  dialogOpened(modal, {close:cancelImport, focus:$('importMergeBtn')});   // (Escape and Back cancel the import)
}
function closeImportModal(){const m=$('importModal'); if(m){m.classList.remove('active'); dialogClosed(m);} pendingImport=null;}
function cancelImport(){if(!pendingImport) return; closeImportModal(); toast('Import cancelled. Nothing was changed.');}
// Saves the current collection so the import can be undone. Returns false if the user chose not to go on without an undo copy.
function takeSnapshot(){
  vaultDrop(SNAPSHOT_KEY); // never leave an older snapshot around that "Undo" would wrongly restore
  hasSnapshot=writeKey(SNAPSHOT_KEY, JSON.stringify({...state, snapshotAt:new Date().toISOString()}));
  updateBackupUi();
  return hasSnapshot || confirm('There is not enough browser storage left to keep an undo copy of your current collection.\n\nContinue with the import anyway? It cannot be undone afterwards.\n\n(Tip: press Cancel, export a JSON backup first, then import again.)');
}
function applyImport(mode){
  const p=pendingImport; if(!p) return;
  const merged=mode==='merge' ? mergeStates(state,p.incoming,p.listed) : null;
  if(!takeSnapshot()){cancelImport(); return;}
  state=merged ? merged.state : p.incoming;
  closeImportModal();
  save(); populateSelects(); render();
  toast(merged ? `Merged: ${merged.added} added, ${merged.updated} updated` : `Replaced: ${state.movies.length} movies`);
}
function undoImport(){
  let snap=null; try{snap=JSON.parse(vaultGet(SNAPSHOT_KEY))}catch(e){}
  if(!snap || !Array.isArray(snap.movies)){hasSnapshot=false; updateBackupUi(); toast('There is no import to undo.'); return;}
  if(!confirm('Restore your collection to how it was before the last import?\n\nAnything you changed after that import will be lost.')) return;
  state=normalizeState(snap);
  vaultDrop(SNAPSHOT_KEY); hasSnapshot=false;
  save(); populateSelects(); render();
  toast(`Import undone: ${state.movies.length} movies restored`);
}

/* ---------- Backup menu: last backup, reminder dot, persistence, multi-tab sync ---------- */
function relativeDate(t){
  const d=new Date(t), n=new Date();
  const days=Math.round((new Date(n.getFullYear(),n.getMonth(),n.getDate())-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/864e5);
  if(days<=0) return 'today';
  if(days===1) return 'yesterday';
  if(days<14) return days+' days ago';
  if(days<60) return Math.floor(days/7)+' weeks ago';
  const months=Math.floor(days/30.4);
  return months<24 ? months+' months ago' : Math.floor(days/365)+' years ago';
}
function backupInfo(){
  const exp=Date.parse(vaultGet(LAST_EXPORT_KEY)||''), chg=Date.parse(vaultGet(LAST_CHANGE_KEY)||'');
  const hasExp=Number.isFinite(exp), changed=Number.isFinite(chg) && (!hasExp || chg>exp);
  const stale=!hasExp || Date.now()-exp > BACKUP_REMINDER_DAYS*864e5;
  return {hasExp, exp, changed, due:changed && stale};
}
function updateBackupUi(){
  const info=backupInfo(), set=(id,fn)=>{const el=$(id); if(el) fn(el)};
  set('backupStatus',el=>{
    el.textContent='Last backup: '+(info.hasExp ? relativeDate(info.exp) : 'never')+(info.changed ? ' · changes since then are not backed up' : '');
    el.title=info.hasExp ? new Date(info.exp).toLocaleString() : '';
    el.classList.toggle('due',info.due);
  });
  set('backupDot',el=>el.classList.toggle('show',info.due));
  set('backupMenuBtn',el=>{el.title=info.due ? (info.hasExp ? `Backup reminder: your last backup is more than ${BACKUP_REMINDER_DAYS} days old and you have made changes since.` : 'Backup reminder: you have changes that were never backed up.') : '';});
  set('undoImportBtn',el=>{el.hidden=!hasSnapshot});
  set('shareBackupBtn',el=>{el.hidden=!shareSupported});
  set('storageNote',el=>{
    el.textContent='Saved in this browser on this device only. It does NOT sync between devices — use Export / Import to move it. '
      + (storagePersisted===true ? 'Storage is persistent.' : 'Storage is not guaranteed: the browser may clear it — export backups regularly.');
  });
}
async function requestPersistence(){
  try{
    if(navigator.storage?.persist){
      storagePersisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if(!storagePersisted) storagePersisted = await navigator.storage.persist();
    }
  }catch(e){}
  updateBackupUi();
}
function syncFromOtherTab(){
  const run=()=>{
    syncTimer=0;
    if(vaultGet(STORAGE_KEY)!==null){ // (if the collection was removed elsewhere, keep what is on screen: the next save writes it back)
      state=loadState(); populateSelects(); render(); updateBackupUi();
      toast('Collection updated from another tab');
    }
    lastSyncAt=Date.now(); // stamped after the (slow) render
  };
  // First change after a quiet period is applied right away; a burst (e.g. cover autoload saves in the other tab) is rate-limited to one full re-render per 2 s, the last one always lands.
  const wait=lastSyncAt+2000-Date.now();
  if(wait<=0) run();
  else if(!syncTimer) syncTimer=setTimeout(run,wait);
}
function onStorageEvent(e){
  if(e.storageArea && e.storageArea!==localStorage) return;
  if(e.key===STORAGE_KEY) syncFromOtherTab();
  else if(e.key===SNAPSHOT_KEY){hasSnapshot=vaultGet(SNAPSHOT_KEY)!==null; updateBackupUi();}
  else if(e.key===LAST_EXPORT_KEY || e.key===LAST_CHANGE_KEY) updateBackupUi();
}
function initBackupUi(){
  const on=(id,fn)=>{const el=$(id); if(el) el.addEventListener('click',fn)};
  on('exportCsvBtn',()=>{exportCsv(); closeBackupMenu();});
  on('shareBackupBtn',()=>{closeBackupMenu(); shareBackup();});
  on('undoImportBtn',()=>{closeBackupMenu(); undoImport();});
  on('importMergeBtn',()=>applyImport('merge'));
  on('importReplaceBtn',()=>applyImport('replace'));
  on('importCancelBtn',cancelImport);
  on('backupMenuBtn',updateBackupUi); // refresh the relative "last backup" text each time the menu is opened
  $('importModal')?.addEventListener('click',e=>{if(e.target===$('importModal')) cancelImport();});
  window.addEventListener('storage',onStorageEvent);
  shareSupported=canShareBackupFiles();
  hasSnapshot=vaultGet(SNAPSHOT_KEY)!==null;
  updateBackupUi();
  requestPersistence();
  if(loadNotice) toast(loadNotice, 12000);
}

/* ---------- Blueprint export ---------- */
function groupedMovies(){
  const order=[...state.sectionOrder];
  const groups={}; order.forEach(s=>groups[s]=[]);
  state.movies.forEach(m=>{if(!groups[m.section]){groups[m.section]=[]; order.push(m.section)} groups[m.section].push(m)});
  order.forEach(s=>groups[s].sort((a,b)=>a.title.localeCompare(b.title)));
  return {order, groups};
}
// The Shelf selector on the Blueprint export screen: '' = all shelves, otherwise one shelf name.
function blueprintScope(){return (typeof els!=='undefined' && els.blueprintShelf && els.blueprintShelf.value) || '';}
function blueprintFileName(ext){
  const shelf=blueprintScope(), slug=shelf.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return 'digital-video-disc-collection-blueprint'+(shelf ? '-'+(slug||'shelf') : '')+'.'+ext;
}
function blueprintText(shelf=blueprintScope()){
  const {order,groups}=groupedMovies();
  const year=new Date().getFullYear();
  let out='THE DIGITAL VIDEO DISC COLLECTION\n\nTHE DIGITAL VIDEO DISC COLLECTION\nFOR\nHARRY A.DAVIS.\n(1998-'+year+')\n\n\n';
  for(const sec of order){
    if(shelf && sec!==shelf) continue;
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
function blueprintHtml(shelf=blueprintScope()){
  const text=blueprintText(shelf);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Digital Video Disc Collection Export</title><style>
  @page{margin:22mm 18mm} body{font-family:"Courier New",monospace;color:#111;background:white;font-size:12pt;line-height:1.25} .page{max-width:820px;margin:0 auto} pre{white-space:pre-wrap;margin:0} h1{font-family:Arial,sans-serif;text-align:center;font-size:18pt;margin:0 0 16pt} .meta{text-align:center;font-family:Arial,sans-serif;margin-bottom:22pt} @media print{body{font-size:11pt}.noPrint{display:none}}
  </style></head><body><div class="page"><pre>${escapeHtml(text)}</pre></div></body></html>`;
}
// Options of the Shelf selector: "All shelves" plus every shelf that holds titles (with counts). Rebuilt only when that list changed; a shelf that is gone falls back to all.
let blueprintShelfSig = '';
function updateBlueprintShelves(){
  const sel=els.blueprintShelf; if(!sel) return;
  const counts=sectionCounts(), secs=allShelves().filter(s=>counts[s]);
  const sig=secs.map(s=>s+'\t'+counts[s]).join('\n');
  if(sig!==blueprintShelfSig){
    blueprintShelfSig=sig;
    const cur=sel.value;
    sel.innerHTML='<option value="">All shelves</option>'+secs.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)} (${counts[s]})</option>`).join('');
    sel.value=secs.includes(cur) ? cur : '';
  }
}
function updateBlueprintPreview(){
  if(!els.blueprintPreview) return;
  updateBlueprintShelves();
  const text=blueprintText();
  els.blueprintPreview.textContent=text.slice(0,12000) + (text.length>12000?'\n\n… Preview truncated, export contains the full list.':'');
}
function exportBlueprintHtml(){downloadBlob(blueprintHtml(),blueprintFileName('html'),'text/html'); toast('Blueprint HTML exported.');}
function exportBlueprintText(){downloadBlob(blueprintText(),blueprintFileName('txt'),'text/plain'); toast('Blueprint TXT exported.');}
function printBlueprint(){
  const w=window.open('','_blank'); if(!w){toast('Popup blocked. Use download instead.'); return;}
  w.document.write(blueprintHtml()); w.document.close(); w.focus(); setTimeout(()=>w.print(),350);
}
function downloadBlob(content,filename,type){
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
}
