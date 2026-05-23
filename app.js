// Movie Vault — Application Logic
// Depends on: movies-data.js (SEED_DATA)

const STORAGE_KEY = 'movieVault.privateCollection.v1';
const UNSORTED_SECTION = 'UNSORTED / NOT PLACED';
const formats = ['All formats','4K UHD','4K Steelbook','Blu-ray','DVD','TV / Series','Blu-ray / DVD','Box set'];
const els = {};
let state = loadState();
let activeScreen = 'library';
let compact = localStorage.getItem('movieVault.viewMode') === 'list';
let duplicatesOnly = false;
let editingId = null;
let posterPickerState = null;
let scanStream = null;
let scanTimer = null;
let scanDetector = null;
let quaggaLoaded = false;
let quaggaRunning = false;
let coverObserver = null;
const autoCoverQueue = [];
const autoCoverQueued = new Set();
const autoCoverRunning = new Set();
const autoCoverFailedSession = new Set();
const COVER_CACHE_PREFIX = 'movieVault.smartCoverCache:v7:';
const COVER_SUCCESS_CACHE_DAYS = 60;
const COVER_FAIL_CACHE_DAYS = 2;
const AUTO_COVER_CONCURRENCY = 2;

function $(id){return document.getElementById(id)}
async function init(){
  // ── Resolve all DOM element references ────────────────────────────────────
  [
    'totalCount','totalLabel','totalStat','duplicatesStat','duplicateCount','duplicateMicro',
    'smartFilterStat','smartFilterLabel','smartFilterMicro','fourKCount','collectionValue',
    'collectionValueStat','searchInput','sectionFilter','formatFilter','seenFilter','sortSelect',
    'unsortedBtn','viewToggle','movieGrid','resultText',
    'newTitle','newSection','customSection','newFormat','newBarcode','newSeen','newPoster','newNotes',
    'addMovieBtn','posterLookupBtn','barcodeLookupBtn',
    'scanner','scanVideo','scannerText','startScanBtn','stopScanBtn','scanStatus',
    'backupMenuBtn','backupMenu','exportJsonBtn','importBtn','importFile',
    'blueprintPreview','downloadBlueprintBtn','downloadBlueprintTextBtn','printBlueprintBtn',
    'editModal','editPreview','closeModalBtn','editMovieTitle','editSection','editCustomSection',
    'editFormat','editBarcode','editSeen','editPoster','editNotes',
    'deleteMovieBtn','removePosterBtn','editPosterLookupBtn','saveEditBtn',
    'valueModal','valueCloseBtn','valueCurrentText','valueMode','valueAmount','valueNote',
    'valuePreviewText','valueWarning','valueConfirmLine','valueConfirm',
    'rollbackValueBtn','applyValueBtn','valueHistoryList','toast',
    'posterPickerModal','pickerTitle','pickerSubtitle','pickerSearchInput','pickerSearchBtn',
    'pickerStatus','pickerGrid','pickerUrlInput','pickerUrlBtn','pickerCloseBtn',
    // Auth + sync + settings
    'settingsBtn','settingsModal','settingsCloseBtn',
    'syncTokenInput','syncSaveConfigBtn','syncNowBtn','syncStatusText','syncLastPush',
    'changePassOld','changePassNew','changePassConfirm','changePassSaveBtn','changePassError',
  ].forEach(id => els[id] = $(id));
  document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>showScreen(btn.dataset.screen)));
  ['searchInput','sectionFilter','formatFilter','seenFilter','sortSelect'].forEach(id=>els[id].addEventListener('input', render));
  els.duplicatesStat.addEventListener('click', toggleDuplicatesOnly);
  els.duplicatesStat.addEventListener('keydown', e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault(); toggleDuplicatesOnly();}});
  els.smartFilterStat.addEventListener('click', applySmartCountFilter);
  els.smartFilterStat.addEventListener('keydown', e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault(); applySmartCountFilter();}});
  els.viewToggle.textContent=compact?'Cover view':'List view';
  els.viewToggle.addEventListener('click',()=>{compact=!compact; localStorage.setItem('movieVault.viewMode', compact?'list':'cover'); els.viewToggle.textContent=compact?'Cover view':'List view'; render();});
  els.unsortedBtn.addEventListener('click',()=>{els.sectionFilter.value=UNSORTED_SECTION; render(); showScreen('library');});
  els.collectionValueStat.addEventListener('dblclick',openValueModal);
  els.valueCloseBtn.addEventListener('click',closeValueModal);
  els.valueModal.addEventListener('click',e=>{if(e.target===els.valueModal) closeValueModal();});
  ['valueMode','valueAmount','valueNote','valueConfirm'].forEach(id=>els[id].addEventListener('input',updateValuePreview));
  els.applyValueBtn.addEventListener('click',applyValueChange);
  els.rollbackValueBtn.addEventListener('click',rollbackLastValueChange);
  els.pickerCloseBtn.addEventListener('click',closePosterPicker);
  els.posterPickerModal.addEventListener('click',e=>{if(e.target===els.posterPickerModal) closePosterPicker();});
  els.pickerSearchBtn.addEventListener('click',()=>refreshPickerCandidates(els.pickerSearchInput.value.trim()));
  els.pickerSearchInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault(); refreshPickerCandidates(els.pickerSearchInput.value.trim());}});
  els.pickerUrlBtn.addEventListener('click',()=>commitPickerSelection(els.pickerUrlInput.value.trim(),'custom'));
  els.pickerUrlInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault(); commitPickerSelection(els.pickerUrlInput.value.trim(),'custom');}});
  els.addMovieBtn.addEventListener('click', addMovie);
  els.posterLookupBtn.addEventListener('click',()=>lookupPosterForForm('new'));
  els.barcodeLookupBtn.addEventListener('click',()=>lookupBarcode(els.newBarcode.value.trim(), true));
  els.startScanBtn.addEventListener('click',startScanner);
  els.stopScanBtn.addEventListener('click',stopScanner);
  els.backupMenuBtn.addEventListener('click',()=>toggleBackupMenu());
  document.addEventListener('click',e=>{if(!e.target.closest('.backupWrap')) closeBackupMenu();});
  els.exportJsonBtn.addEventListener('click',()=>{exportJson(); closeBackupMenu();});
  els.importBtn.addEventListener('click',()=>els.importFile.click());
  els.importFile.addEventListener('change',importJson);
  els.downloadBlueprintBtn.addEventListener('click',exportBlueprintHtml);
  els.downloadBlueprintTextBtn.addEventListener('click',exportBlueprintText);
  els.printBlueprintBtn.addEventListener('click',printBlueprint);
  els.closeModalBtn.addEventListener('click',closeModal);
  els.saveEditBtn.addEventListener('click',saveEdit);
  els.deleteMovieBtn.addEventListener('click',deleteEditingMovie);
  els.removePosterBtn.addEventListener('click',()=>{if(editingId) removePoster(editingId,{keepModal:true});});
  els.editPosterLookupBtn.addEventListener('click',()=>lookupPosterForForm('edit'));
  ['editMovieTitle','editPoster','editSection','editFormat','editBarcode','editSeen'].forEach(id=>els[id].addEventListener('input',()=>updateEditPreview()));
  window.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal(); closePosterPicker(); closeValueModal(); closeSettings();}});

  // ── Auth gate: show login overlay; resolves when user authenticates ────────
  await authGate();

  // ── Cloud sync: try to pull from Vercel Blob and replace local state ───────
  await syncOnLoad();

  // ── Settings modal listeners ───────────────────────────────────────────────
  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsCloseBtn.addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', e => { if (e.target === els.settingsModal) closeSettings(); });
  els.syncSaveConfigBtn.addEventListener('click', handleSyncSaveConfig);
  els.syncNowBtn.addEventListener('click', handleSyncNow);
  els.changePassSaveBtn.addEventListener('click', handleChangePassword);
  els.syncTokenInput.addEventListener('input', () => { els.syncTokenInput.dataset.dirty = '1'; });

  populateSelects();
  if (window.matchMedia('(max-width: 720px)').matches) showScreen('add');
  render();
  updateBlueprintPreview();
}

// ── Settings modal ─────────────────────────────────────────────────────────────
function openSettings() {
  // Refresh dynamic UI
  const cfg = syncGetConfig();
  els.syncTokenInput.value = '';
  els.syncTokenInput.dataset.dirty = '';
  els.syncTokenInput.placeholder = cfg.token ? 'Token saved ✓ (paste to replace)' : 'vercel_blob_rw_…';
  updateSyncBadge(syncHasToken() ? 'ok' : 'idle');
  // Show/hide old-password field
  els.oldPassField.style.display = authHasPassword() ? '' : 'none';
  // Clear password fields
  ['changePassOld','changePassNew','changePassConfirm'].forEach(id => { els[id].value = ''; });
  els.changePassError.textContent = '';
  els.settingsModal.style.display = 'flex';
}
function closeSettings() {
  els.settingsModal.style.display = 'none';
}

async function handleSyncSaveConfig() {
  const token = els.syncTokenInput.value.trim();
  if (!token) { toast('Paste a Vercel Blob token first.'); return; }
  syncSetConfig({ token });
  els.syncTokenInput.value = '';
  els.syncTokenInput.dataset.dirty = '';
  els.syncTokenInput.placeholder = 'Token saved ✓ (paste to replace)';
  toast('Token saved — syncing now…');
  await syncOnLoad();
  render();
}

async function handleSyncNow() {
  if (!syncHasToken()) { toast('No token configured — open Settings and save a token first.'); return; }
  toast('Syncing…');
  await syncOnLoad();
  render();
}

async function handleChangePassword() {
  const oldPw  = els.changePassOld.value;
  const newPw  = els.changePassNew.value;
  const confPw = els.changePassConfirm.value;
  els.changePassError.textContent = '';
  const err = await authChangePassword(oldPw, newPw, confPw);
  if (err) { els.changePassError.textContent = err; return; }
  ['changePassOld','changePassNew','changePassConfirm'].forEach(id => { els[id].value = ''; });
  toast('Password updated ✓');
}

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
function save(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateBlueprintPreview();
  syncPushSilent(); // fire-and-forget cloud push; defined in sync.js
}
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
function escapeHtml(str=''){return String(str).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function cleanNotes(str=''){return String(str).replace(/\bImported from blueprint\b/gi,'').replace(/^\s*[—\-:]+\s*/,'').replace(/\s*[—\-:]+\s*$/,'').trim();}
function titleKey(t){return (t||'').toLowerCase().replace(/[^a-z0-9æøå]+/g,' ').trim()}
function hueFor(str){let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))%360; return h;}
function toast(msg){els.toast.textContent=msg; els.toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>els.toast.classList.remove('show'),2600)}

function showScreen(screen){
  activeScreen=screen;
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===screen));
  document.querySelectorAll('.tab').forEach(btn=>btn.setAttribute('aria-selected', btn.dataset.screen===screen ? 'true':'false'));
  if(screen==='export') updateBlueprintPreview();
  if(screen==='library') requestAnimationFrame(setupVisibleCoverAutoload);
}
function toggleBackupMenu(){
  const open=!els.backupMenu.classList.contains('open');
  els.backupMenu.classList.toggle('open', open);
  els.backupMenuBtn.setAttribute('aria-expanded', open?'true':'false');
}
function closeBackupMenu(){
  els.backupMenu.classList.remove('open');
  els.backupMenuBtn.setAttribute('aria-expanded','false');
}
function populateSelects(){
  const sections = [...new Set([UNSORTED_SECTION, ...state.sectionOrder])];
  const sectionOptions = ['<option value="all">All sections</option>', ...sections.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)].join('');
  els.sectionFilter.innerHTML = sectionOptions;
  const addOptions = sections.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  els.newSection.innerHTML = addOptions;
  if(!els.newSection.value) els.newSection.value=UNSORTED_SECTION;
  els.editSection.innerHTML = addOptions;
  els.formatFilter.innerHTML = formats.map(f=>`<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
}
function getDuplicateMap(){const c={}; state.movies.forEach(m=>{const k=titleKey(m.title); if(k)c[k]=(c[k]||0)+1}); return c;}
function getFiltered(){
  const q=els.searchInput.value.trim().toLowerCase();
  const sec=els.sectionFilter.value;
  const fmt=els.formatFilter.value;
  const seen=els.seenFilter.value;
  const dupes=getDuplicateMap();
  let list=state.movies.filter(m=>{
    const searchBlob=[m.title,m.section,m.format,m.barcode,m.notes].join(' ').toLowerCase();
    const dupeCount=dupes[titleKey(m.title)]||0;
    const duplicateOk = !duplicatesOnly || dupeCount>1;
    const seenOk = seen==='all' || (seen==='seen' && m.seen!==false) || (seen==='unseen' && m.seen===false);
    return (!q || searchBlob.includes(q)) && (sec==='all'||m.section===sec) && (fmt==='All formats'||m.format===fmt) && duplicateOk && seenOk;
  });
  const allowedSorts = new Set(['title-asc','title-desc','added-desc','dupes-first','unseen-first']);
  const sort = allowedSorts.has(els.sortSelect.value) ? els.sortSelect.value : 'title-asc';
  if (els.sortSelect.value !== sort) els.sortSelect.value = sort;
  list.sort((a,b)=>{
    if(sort==='title-asc') return a.title.localeCompare(b.title);
    if(sort==='title-desc') return b.title.localeCompare(a.title);
    if(sort==='added-desc') return (b.added||'').localeCompare(a.added||'') || b.id.localeCompare(a.id);
    if(sort==='unseen-first') return ((a.seen===false?0:1)-(b.seen===false?0:1)) || a.title.localeCompare(b.title);
    if(sort==='dupes-first') return ((dupes[titleKey(b.title)]||0)-(dupes[titleKey(a.title)]||0)) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
  return list;
}
function render(){
  const list=getFiltered();
  populateStats(list);
  els.movieGrid.classList.toggle('compact',compact);
  els.resultText.textContent = `Showing ${list.length.toLocaleString()} of ${state.movies.length.toLocaleString()} titles`;
  if(!list.length){els.movieGrid.innerHTML='<div class="empty">No movies match this filter.</div>'; return;}
  const dupes=getDuplicateMap();
  els.movieGrid.innerHTML=list.map(m=>cardHtml(m, dupes[titleKey(m.title)]||0)).join('');
  els.movieGrid.querySelectorAll('.card').forEach(card=>card.addEventListener('click',e=>{
    if(e.target.closest('button')) return;
    openEdit(card.dataset.id);
  }));
  els.movieGrid.querySelectorAll('[data-edit]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation(); openEdit(btn.dataset.edit)}));
  els.movieGrid.querySelectorAll('[data-searchposter]').forEach(btn=>btn.addEventListener('click',async e=>{e.stopPropagation(); await quickPosterLookup(btn.dataset.searchposter)}));
  els.movieGrid.querySelectorAll('[data-remove-poster]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation(); removePoster(btn.dataset.removePoster)}));
  els.movieGrid.querySelectorAll('[data-toggle-seen]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation(); toggleSeen(btn.dataset.toggleSeen)}));
  setupVisibleCoverAutoload();
}

function isFilterActive(){
  return !!(els.searchInput && els.searchInput.value && els.searchInput.value.trim())
    || (els.sectionFilter && els.sectionFilter.value && els.sectionFilter.value !== 'all')
    || (els.formatFilter && els.formatFilter.value && els.formatFilter.value !== 'All formats')
    || (els.seenFilter && els.seenFilter.value && els.seenFilter.value !== 'all')
    || duplicatesOnly;
}
function toggleDuplicatesOnly(){
  duplicatesOnly = !duplicatesOnly;
  render();
}
function applySmartCountFilter(){
  const unsortedCount = state.movies.filter(m=>m.section===UNSORTED_SECTION).length;
  const mode = unsortedCount > 0 ? 'unsorted' : 'unseen';
  if(mode==='unsorted'){
    const alreadyActive = els.sectionFilter.value===UNSORTED_SECTION;
    els.sectionFilter.value = alreadyActive ? 'all' : UNSORTED_SECTION;
    if(!alreadyActive) els.seenFilter.value = 'all';
  }else{
    const alreadyActive = els.seenFilter.value==='unseen' && els.sectionFilter.value==='all';
    els.seenFilter.value = alreadyActive ? 'all' : 'unseen';
    els.sectionFilter.value = 'all';
  }
  render();
  showScreen('library');
}

function populateStats(filteredList){
  const filterActive = isFilterActive();
  const totalCount = state.movies.length;
  const shown = filteredList ? filteredList.length : totalCount;
  if(filterActive){
    els.totalLabel.textContent = 'Selected titles';
    els.totalCount.textContent = shown.toLocaleString();
    els.totalStat.classList.add('filtered');
  } else {
    els.totalLabel.textContent = 'Total titles';
    els.totalCount.textContent = totalCount.toLocaleString();
    els.totalStat.classList.remove('filtered');
  }
  const dupes = getDuplicateMap();
  const duplicateTitleCount = Object.values(dupes).filter(c => c > 1).length;
  els.duplicateCount.textContent = duplicateTitleCount.toLocaleString();
  els.duplicatesStat.classList.toggle('toggled', duplicatesOnly);
  els.duplicatesStat.setAttribute('aria-pressed', duplicatesOnly ? 'true' : 'false');
  els.duplicateMicro.textContent = duplicatesOnly ? 'Showing duplicates · click to clear' : 'Click to filter';

  const unsortedCount = state.movies.filter(m=>m.section===UNSORTED_SECTION).length;
  const unseenCount = state.movies.filter(m=>m.seen===false).length;
  const smartMode = unsortedCount > 0 ? 'unsorted' : 'unseen';
  const smartCount = smartMode==='unsorted' ? unsortedCount : unseenCount;
  const smartActive = smartMode==='unsorted'
    ? els.sectionFilter.value===UNSORTED_SECTION
    : els.seenFilter.value==='unseen' && els.sectionFilter.value==='all';
  els.smartFilterLabel.textContent = smartMode==='unsorted' ? 'Unsorted' : 'Unseen';
  els.fourKCount.textContent = smartCount.toLocaleString();
  els.smartFilterMicro.textContent = smartActive ? `Showing ${smartMode} · click to clear` : `Click to filter ${smartMode}`;
  els.smartFilterStat.classList.toggle('toggled', smartActive);
  els.smartFilterStat.setAttribute('aria-pressed', smartActive ? 'true' : 'false');
  els.smartFilterStat.title = smartMode==='unsorted' ? 'Click to show unsorted titles' : 'Click to show unseen titles';
  els.collectionValue.textContent=formatMoney(state.collectionValue || 0);
}
function cardHtml(m, dupeCount){
  const hue=hueFor(m.title);
  const dupe = dupeCount>1 ? `<span class="chip">${dupeCount} editions</span>` : '';
  const barcode = m.barcode ? `<span class="chip">${escapeHtml(m.barcode)}</span>` : '';
  const seenChip = m.seen===false ? '<span class="chip unseenPill">Not seen</span>' : '<span class="chip seenPill">Seen</span>';
  const removedChip = (!m.poster && m.posterRemoved===true) ? '<span class="chip posterRemovedPill">Poster removed</span>' : '';
  const seenBtn = m.seen===false ? 'Mark seen' : 'Mark unseen';
  const needsPoster = !m.poster && m.posterRemoved!==true;
  if(compact){
    return `<article class="card" data-id="${escapeHtml(m.id)}" data-needs-poster="${needsPoster?'true':'false'}" style="--hue:${hue}">
      <div class="body"><h3 class="title">${escapeHtml(m.title)}</h3><div class="meta"><span class="chip">${escapeHtml(m.section)}</span>${seenChip}${removedChip}${dupe}${barcode}</div><div class="formatBadge">${escapeHtml(m.format)}</div></div>
    </article>`;
  }
  const img = m.poster ? `<img src="${escapeHtml(m.poster)}" alt="Cover for ${escapeHtml(m.title)}" loading="lazy" onerror="this.remove()">` : '';
  const posterBtn = m.poster
    ? `<button class="miniBtn" data-remove-poster="${escapeHtml(m.id)}">Remove poster</button>`
    : `<button class="miniBtn" data-searchposter="${escapeHtml(m.id)}">${m.posterRemoved===true?'Choose poster':'Find poster'}</button>`;
  return `<article class="card" data-id="${escapeHtml(m.id)}" data-needs-poster="${needsPoster?'true':'false'}" style="--hue:${hue}">
    <div class="cover">${img}<div class="coverTitle">${escapeHtml(shortCoverTitle(m.title))}</div><div class="formatBadge">${escapeHtml(m.format)}</div></div>
    <div class="body"><h3 class="title">${escapeHtml(m.title)}</h3><div class="meta"><span class="chip">${escapeHtml(m.section)}</span>${seenChip}${removedChip}${dupe}${barcode}</div>${m.notes?`<div class="notes">${escapeHtml(m.notes)}</div>`:''}<div class="cardActions"><button class="miniBtn" data-toggle-seen="${escapeHtml(m.id)}">${seenBtn}</button><button class="miniBtn" data-edit="${escapeHtml(m.id)}">Edit</button>${posterBtn}</div></div>
  </article>`;
}
function shortCoverTitle(t){return t.length>52 ? t.slice(0,49)+'…' : t}

function getSectionFromForm(prefix){
  const custom = (prefix==='new'?els.customSection:els.editCustomSection).value.trim();
  const select = prefix==='new'?els.newSection:els.editSection;
  const section = (custom || select.value || 'UNSORTED').trim().toUpperCase();
  if(!state.sectionOrder.includes(section)) state.sectionOrder.push(section);
  return section;
}
function addMovie(){
  const title=els.newTitle.value.trim();
  if(!title){toast('Add a title first.'); els.newTitle.focus(); return;}
  const movie={id:cryptoId(), title, section:getSectionFromForm('new'), format:els.newFormat.value, barcode:els.newBarcode.value.trim(), poster:els.newPoster.value.trim(), posterRemoved:false, notes:els.newNotes.value.trim(), seen:!!els.newSeen.checked, added:today(), updated:today()};
  state.movies.unshift(movie);
  save();
  ['newTitle','customSection','newBarcode','newPoster','newNotes'].forEach(id=>els[id].value=''); els.newSeen.checked=false; els.newSection.value=UNSORTED_SECTION;
  populateSelects(); render(); toast(`Added ${title}`);
}
function openEdit(id){
  const m=state.movies.find(x=>x.id===id); if(!m) return;
  editingId=id;
  els.editMovieTitle.value=m.title; els.editSection.value=m.section; els.editCustomSection.value=''; els.editFormat.value=m.format; els.editBarcode.value=m.barcode; els.editSeen.checked=m.seen!==false; els.editPoster.value=m.poster; els.editNotes.value=m.notes;
  updateEditPreview();
  els.editModal.classList.add('active');
}
function updateEditPreview(){
  if(!els.editPreview) return;
  const title=(els.editMovieTitle?.value || 'Untitled').trim();
  const poster=(els.editPoster?.value || '').trim();
  const section=(els.editCustomSection?.value || els.editSection?.value || '').trim();
  const format=(els.editFormat?.value || '').trim();
  const barcode=(els.editBarcode?.value || '').trim();
  const seen=els.editSeen?.checked ? 'Seen' : 'Not seen yet';
  const currentMovie = editingId ? state.movies.find(x=>x.id===editingId) : null;
  const posterRemoved = !poster && currentMovie?.posterRemoved === true;
  const cover=poster ? `<div class="modalCover"><img src="${escapeHtml(poster)}" alt="Cover for ${escapeHtml(title)}" onerror="this.parentElement.textContent='No cover';"></div>` : `<div class="modalCover">${escapeHtml(shortCoverTitle(title))}</div>`;
  const posterHint = posterRemoved ? 'Poster removed. Auto cover loading is disabled until you choose a new poster.' : 'Click “Find poster” to search again, or paste a cover URL manually.';
  els.editPreview.innerHTML = `${cover}<div class="modalPreviewInfo"><strong style="color:var(--text)">${escapeHtml(title)}</strong><br>${escapeHtml(section || 'No section')} · ${escapeHtml(format || 'No format')} · ${escapeHtml(seen)}${barcode?`<br>Barcode: ${escapeHtml(barcode)}`:''}<br><span>${escapeHtml(posterHint)}</span></div>`;
}
function closeModal(){els.editModal.classList.remove('active'); editingId=null;}
function saveEdit(){
  const m=state.movies.find(x=>x.id===editingId); if(!m) return;
  const title=els.editMovieTitle.value.trim(); if(!title){toast('Movie needs a title.'); return;}
  const oldPoster = m.poster || '';
  const nextPoster = els.editPoster.value.trim();
  m.title=title; m.section=getSectionFromForm('edit'); m.format=els.editFormat.value; m.barcode=els.editBarcode.value.trim(); m.seen=!!els.editSeen.checked; m.poster=nextPoster; m.posterRemoved=nextPoster ? false : !!(oldPoster || m.posterRemoved); m.notes=els.editNotes.value.trim(); m.updated=today();
  save(); populateSelects(); render(); closeModal(); toast('Saved changes.');
}
function deleteEditingMovie(){
  const m=state.movies.find(x=>x.id===editingId); if(!m) return;
  if(!confirm(`Delete “${m.title}”?`)) return;
  state.movies=state.movies.filter(x=>x.id!==editingId);
  save(); render(); closeModal(); toast('Movie deleted.');
}


function toggleSeen(id){
  const m=state.movies.find(x=>x.id===id); if(!m) return;
  m.seen = m.seen===false ? true : false;
  m.updated=today();
  save(); render();
  toast(m.seen ? 'Marked as seen.' : 'Marked as not seen.');
}
function formatMoney(value){
  const n=Number(value||0);
  return new Intl.NumberFormat('nb-NO',{maximumFractionDigits:0}).format(n)+' kr';
}
function parseMoneyInput(value){
  const cleaned=String(value||'').replace(/\s/g,'').replace(',', '.').replace(/[^0-9.\-]/g,'');
  const n=Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}
function openValueModal(){
  els.valueAmount.value=''; els.valueNote.value=''; els.valueMode.value='add'; els.valueConfirm.checked=false;
  els.valueModal.classList.add('active');
  renderValueHistory(); updateValuePreview();
  setTimeout(()=>els.valueAmount.focus(),50);
}
function closeValueModal(){els.valueModal.classList.remove('active');}
function updateValuePreview(){
  const current=Number(state.collectionValue || 0);
  const amount=parseMoneyInput(els.valueAmount.value);
  const mode=els.valueMode.value;
  els.valueCurrentText.textContent='Current value: '+formatMoney(current);
  const invalid=!Number.isFinite(amount);
  if(invalid){
    els.valuePreviewText.textContent='Enter an amount to preview the change.';
    els.valueWarning.classList.remove('show'); els.valueConfirmLine.style.display='none';
    return;
  }
  const next=mode==='set' ? amount : current + amount;
  const delta=next-current;
  els.valuePreviewText.textContent=`${mode==='set'?'Set total to':'Add amount'}: ${formatMoney(amount)} → new total ${formatMoney(next)} (${delta>=0?'+':''}${formatMoney(delta)})`;
  const risky = next < 0 || Math.abs(delta) >= 10000 || (mode==='set' && current>0 && Math.abs(delta/current) > .5) || (mode==='set' && amount===0 && current>0);
  if(risky){
    els.valueWarning.textContent='Safety check: this is a large, negative or reset-style change. Tick the confirmation box before applying.';
    els.valueWarning.classList.add('show'); els.valueConfirmLine.style.display='flex';
  }else{
    els.valueWarning.classList.remove('show'); els.valueConfirmLine.style.display='none'; els.valueConfirm.checked=false;
  }
}
function applyValueChange(){
  const current=Number(state.collectionValue || 0);
  const amount=parseMoneyInput(els.valueAmount.value);
  if(!Number.isFinite(amount)){toast('Enter a valid NOK amount.'); return;}
  const mode=els.valueMode.value;
  const next=mode==='set' ? amount : current + amount;
  const delta=next-current;
  const risky = next < 0 || Math.abs(delta) >= 10000 || (mode==='set' && current>0 && Math.abs(delta/current) > .5) || (mode==='set' && amount===0 && current>0);
  if(risky && !els.valueConfirm.checked){toast('Confirm the safety check first.'); return;}
  if(next < 0){toast('Total value cannot be below 0 kr.'); return;}
  const entry={id:cryptoId(), date:new Date().toISOString(), mode, amount, before:current, after:next, note:els.valueNote.value.trim()};
  state.collectionValue=next;
  state.valueHistory=[entry, ...(state.valueHistory||[])].slice(0,100);
  save(); populateStats(); renderValueHistory(); updateValuePreview();
  els.valueAmount.value=''; els.valueNote.value=''; els.valueConfirm.checked=false;
  toast('Collection value updated.');
}
function rollbackLastValueChange(){
  const history=state.valueHistory||[];
  const last=history.find(h=>!h.rollbackOf);
  if(!last){toast('No value change to rollback.'); return;}
  if(!confirm(`Rollback latest value change from ${formatMoney(last.before)} to ${formatMoney(last.after)}?`)) return;
  const current=Number(state.collectionValue || 0);
  state.collectionValue=Number(last.before || 0);
  const entry={id:cryptoId(), date:new Date().toISOString(), mode:'rollback', amount:state.collectionValue-current, before:current, after:state.collectionValue, note:'Rollback', rollbackOf:last.id};
  state.valueHistory=[entry, ...history].slice(0,100);
  save(); populateStats(); renderValueHistory(); updateValuePreview();
  toast('Rolled back latest value change.');
}
function renderValueHistory(){
  if(!els.valueHistoryList) return;
  const history=state.valueHistory||[];
  if(!history.length){els.valueHistoryList.innerHTML='<div class="empty" style="padding:18px">No value history yet.</div>'; return;}
  els.valueHistoryList.innerHTML=history.slice(0,20).map(h=>{
    const dt=new Date(h.date || Date.now());
    const dateText=dt.toLocaleString('nb-NO',{dateStyle:'medium', timeStyle:'short'});
    const delta=Number(h.after||0)-Number(h.before||0);
    return `<div class="historyItem"><div><strong>${escapeHtml(h.mode==='rollback'?'Rollback':(h.mode==='set'?'Set total':'Added amount'))}: ${delta>=0?'+':''}${formatMoney(delta)}</strong><small>${escapeHtml(dateText)} · ${formatMoney(h.before)} → ${formatMoney(h.after)}${h.note?' · '+escapeHtml(h.note):''}</small></div><button class="miniBtn" data-rollback-id="${escapeHtml(h.id)}">Use before</button></div>`;
  }).join('');
  els.valueHistoryList.querySelectorAll('[data-rollback-id]').forEach(btn=>btn.addEventListener('click',()=>rollbackValueEntry(btn.dataset.rollbackId)));
}
function rollbackValueEntry(id){
  const h=(state.valueHistory||[]).find(x=>x.id===id); if(!h) return;
  if(!confirm(`Set total back to ${formatMoney(h.before)}?`)) return;
  const current=Number(state.collectionValue || 0);
  state.collectionValue=Number(h.before || 0);
  const entry={id:cryptoId(), date:new Date().toISOString(), mode:'rollback', amount:state.collectionValue-current, before:current, after:state.collectionValue, note:'Rollback to selected history item', rollbackOf:h.id};
  state.valueHistory=[entry, ...(state.valueHistory||[])].slice(0,100);
  save(); populateStats(); renderValueHistory(); updateValuePreview();
}

function markCardLoading(id,on){
  const card=[...els.movieGrid.querySelectorAll('.card')].find(c=>c.dataset.id===id);
  const cover=card?.querySelector('.cover');
  if(cover) cover.classList.toggle('loading',!!on);
}
function updateCardPoster(id,poster,title){
  const card=[...els.movieGrid.querySelectorAll('.card')].find(c=>c.dataset.id===id);
  if(!card) return;
  markCardLoading(id,false);
  card.dataset.needsPoster='false';
  const cover=card.querySelector('.cover');
  if(cover){
    const existing=cover.querySelector('img');
    if(existing) existing.src=poster;
    else cover.insertAdjacentHTML('afterbegin', `<img src="${escapeHtml(poster)}" alt="Cover for ${escapeHtml(title)}" loading="lazy" onerror="this.remove()">`);
  }
  const findBtn=card.querySelector('[data-searchposter]');
  if(findBtn) findBtn.remove();
  card.querySelectorAll('.posterRemovedPill').forEach(chip=>chip.remove());
  const actions=card.querySelector('.cardActions');
  if(actions && !actions.querySelector('[data-remove-poster]')){
    const removeBtn=document.createElement('button');
    removeBtn.className='miniBtn';
    removeBtn.dataset.removePoster=id;
    removeBtn.textContent='Remove poster';
    removeBtn.addEventListener('click',e=>{e.stopPropagation(); removePoster(id);});
    actions.appendChild(removeBtn);
  }
}
function removePoster(id, opts={}){
  const m=state.movies.find(x=>x.id===id); if(!m) return;
  if(!m.poster && m.posterRemoved===true){toast('Poster is already removed for this title.'); return;}
  m.poster='';
  m.posterRemoved=true;
  m.updated=today();
  autoCoverQueued.delete(id);
  autoCoverFailedSession.add(id);
  save();
  if(opts.keepModal){
    els.editPoster.value='';
    updateEditPreview();
  }
  render();
  toast('Poster removed. Auto cover loading is disabled for this title.');
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

/* ---------- Poster picker (manual cover selection) ---------- */
async function quickPosterLookup(id){
  const m=state.movies.find(x=>x.id===id); if(!m) return;
  openPosterPicker({
    title: m.title,
    section: m.section,
    format: m.format,
    onSelect: poster => {
      m.poster=poster; m.posterRemoved=false; m.updated=today(); save();
      updateCardPoster(id, poster, m.title);
      toast('Cover added.');
    }
  });
}
function lookupPosterForForm(prefix){
  const isNew=prefix==='new';
  const title=(isNew?els.newTitle:els.editMovieTitle).value.trim();
  if(!title){toast('Type a title first.'); (isNew?els.newTitle:els.editMovieTitle).focus(); return;}
  const section=isNew ? (els.customSection.value.trim() || els.newSection.value) : (els.editCustomSection.value.trim() || els.editSection.value);
  const format=isNew ? els.newFormat.value : els.editFormat.value;
  openPosterPicker({
    title, section, format,
    onSelect: poster => {
      (isNew?els.newPoster:els.editPoster).value=poster;
      if(!isNew) updateEditPreview();
      toast('Cover selected.');
    }
  });
}
function openPosterPicker(opts){
  posterPickerState = {
    title: opts.title,
    section: opts.section || '',
    format: opts.format || '',
    onSelect: opts.onSelect,
    generation: 0
  };
  els.pickerTitle.textContent = `Pick a cover for "${opts.title}"`;
  els.pickerSearchInput.value = cleanMovieTitle(opts.title);
  els.pickerUrlInput.value = '';
  els.pickerGrid.innerHTML = '';
  els.posterPickerModal.classList.add('active');
  refreshPickerCandidates(els.pickerSearchInput.value);
}
function closePosterPicker(){
  if(posterPickerState) posterPickerState.generation++;
  posterPickerState = null;
  els.posterPickerModal.classList.remove('active');
}
function commitPickerSelection(url, source){
  url = String(url||'').trim();
  if(!url){toast('Paste a URL first.'); return;}
  if(!/^https?:\/\//i.test(url)){toast('URL must start with http:// or https://'); return;}
  const cb = posterPickerState?.onSelect;
  closePosterPicker();
  if(cb) cb(url);
}
async function refreshPickerCandidates(searchTerm){
  if(!posterPickerState) return;
  const gen = ++posterPickerState.generation;
  const state0 = posterPickerState;
  els.pickerStatus.textContent = 'Searching candidates…';
  els.pickerGrid.innerHTML = '';
  try{
    const candidates = await gatherPosterCandidates(searchTerm || state0.title, {section:state0.section, format:state0.format, originalTitle: state0.title});
    if(!posterPickerState || posterPickerState.generation !== gen) return; // picker was closed or re-searched
    renderPickerCandidates(candidates);
  }catch(e){
    if(!posterPickerState || posterPickerState.generation !== gen) return;
    els.pickerStatus.textContent = 'Search failed. Try a different term, or paste a URL below.';
    els.pickerGrid.innerHTML = '';
  }
}
function renderPickerCandidates(candidates){
  if(!candidates.length){
    els.pickerStatus.textContent = 'No candidates found.';
    els.pickerGrid.innerHTML = '<div class="pickerEmpty">Nothing matched. Try a different search term, or paste a URL below.</div>';
    return;
  }
  els.pickerStatus.textContent = `${candidates.length} candidate${candidates.length===1?'':'s'} — tap one to use it.`;
  els.pickerGrid.innerHTML = candidates.map((c,i)=>`
    <button class="pickerThumb" data-pickerpick="${i}" title="${escapeHtml(c.label||'')}">
      <img src="${escapeHtml(c.url)}" alt="${escapeHtml(c.label||'Candidate')}" loading="lazy" onerror="this.closest('.pickerThumb').style.display='none'">
      <span class="src">${escapeHtml(c.source)}${c.year?(' · '+c.year):''}</span>
      ${c.label?`<span class="nm">${escapeHtml(c.label)}</span>`:''}
    </button>`).join('');
  els.pickerGrid.querySelectorAll('[data-pickerpick]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const idx = parseInt(btn.dataset.pickerpick,10);
      const c = candidates[idx];
      if(c) commitPickerSelection(c.url, c.source);
    });
  });
}
async function gatherPosterCandidates(searchTerm, options={}){
  const originalTitle = options.originalTitle || searchTerm;
  const all = [];
  const seen = new Set();
  const pushCand = (c) => {
    if(!c || !c.url) return;
    const key = c.url.replace(/^https?:/,'').replace(/\d+x\d+(bb)?/g,'X');
    if(seen.has(key)) return;
    seen.add(key);
    all.push(c);
  };
  // Build the iTunes query list — primary is the user's (edited) search term, then variants from buildPosterQueries
  const baseQueries = [searchTerm.trim(), ...buildPosterQueries(searchTerm, options)];
  const itunesQueries = [...new Set(baseQueries.map(q=>q.trim()).filter(Boolean))].slice(0,3);

  // --- iTunes: strict (movieTerm) US, then broad US, then strict GB ---
  const itunesAttempts = [];
  for(const q of itunesQueries){
    itunesAttempts.push({country:'US', strict:true, q});
  }
  itunesAttempts.push({country:'US', strict:false, q: itunesQueries[0]});
  itunesAttempts.push({country:'GB', strict:true, q: itunesQueries[0]});

  const itunesPromises = itunesAttempts.map(async a => {
    try{
      const attr = a.strict ? '&attribute=movieTerm' : '';
      const url = `https://itunes.apple.com/search?media=movie&entity=movie${attr}&limit=10&country=${a.country}&term=${encodeURIComponent(a.q)}`;
      const res = await fetch(url);
      if(!res.ok) return [];
      const data = await res.json();
      return (data.results||[]).map(r => ({
        url: r.artworkUrl100 ? upgradeArtworkUrl(r.artworkUrl100) : '',
        source: 'iTunes',
        label: r.trackName || r.collectionName || '',
        year: (r.releaseDate||'').slice(0,4) || '',
        score: scorePosterResult(r, originalTitle, a.q, options),
        kind: r.kind || ''
      }));
    }catch(_){ return []; }
  });

  // --- Wikipedia: top page-image hits ---
  const wikiQueries = [searchTerm.trim(), ...buildWikipediaPosterQueries(searchTerm, options)];
  const wikiUnique = [...new Set(wikiQueries.map(q=>q.trim()).filter(Boolean))].slice(0,2);
  const wikiPromises = wikiUnique.map(async q => {
    try{
      const url = 'https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrnamespace=0&gsrlimit=6&gsrsearch='+encodeURIComponent(q)+'&prop=pageimages|description&piprop=thumbnail&pithumbsize=800&format=json&origin=*';
      const res = await fetch(url);
      if(!res.ok) return [];
      const data = await res.json();
      const pages = Object.values(data.query?.pages || {});
      return pages.filter(p=>p.thumbnail?.source).map(p => ({
        url: p.thumbnail.source,
        source: 'Wikipedia',
        label: p.title || '',
        year: '',
        score: scoreWikiPosterPage(p, originalTitle, q, options),
        kind: p.description || ''
      }));
    }catch(_){ return []; }
  });

  const results = await Promise.all([...itunesPromises, ...wikiPromises]);
  for(const arr of results){
    for(const c of arr){
      if(c.url) pushCand(c);
    }
  }
  // Sort: highest score first, but keep all results so user can override
  all.sort((a,b)=>b.score-a.score);
  return all.slice(0,30);
}
function cleanMovieTitle(t){
  let s=String(t||'').trim();
  // Strip trailing "(2)" / "(A)" disambiguation markers used in the catalog
  s=s.replace(/\s*\((?:\d{1,2}|[A-Z])\)\s*$/,'');
  // Strip trailing year-in-parens "(1992)"
  s=s.replace(/\s*\((?:19|20)\d{2}\)\s*$/,'');
  // Iteratively strip edition/format markers from the end
  const markers=[
    'STEELBOOK','LIMITED EDITION','LTD ED','LIMITED','COLLECTORS EDITION','COLLECTOR EDITION','COLL ED','COLLECTORS',
    'SPECIAL EDITION','REMASTERED','EXTENDED EDITION','EXTENDED CUT','EXTENDED',
    "DIRECTOR'S CUT",'DIRECTORS CUT','UNRATED CUT','UNRATED','THEATRICAL CUT','THEATRICAL',
    'DIAMOND EDITION','ANNIVERSARY EDITION','SIGNATURE EDITION',
    'MASTERS OF CINEMA','CRITERION COLLECTION','CRITERION','ARROW VIDEO','ARROW','88 FILMS','MVD','TRIBECA','SHOUT FACTORY','SCREAM FACTORY','SECOND SIGHT',
    '3D','4K UHD','4K','UHD','ULTRA HD','BLU-RAY','BLU RAY','BLURAY','DVD','HD-DVD','HDDVD','LD','VHS','DIGIBOOK','DIGIPAK','MEDIABOOK',
    'VOL\\s*\\d+','VOLUME\\s*\\d+','PART\\s*\\d+','PT\\s*\\d+','DISC\\s*\\d+','DISK\\s*\\d+'
  ];
  const re=new RegExp('[\\s\\-–—:/]+(?:'+markers.join('|')+')\\s*$','i');
  let prev='';
  while(prev!==s){prev=s; s=s.replace(re,'').trim();}
  // Trim leftover punctuation
  s=s.replace(/[\s\-–—:/]+$/,'').trim();
  return s || String(t||'').trim();
}
function normalizeSearchText(t){
  return String(t||'')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g,'')
    .replace(/[^a-z0-9æøåäöüß ]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function buildPosterQueries(title, options={}){
  const raw=String(title||'').trim();
  const clean=cleanMovieTitle(raw);
  const sec=String(options.section||'').toUpperCase();
  const isAnimated=sec.includes('DISNEY') || sec==='TV ROOM' || /\b(DISNEY|PIXAR|DREAMWORKS|GHIBLI|ANIMATED|ANIMATION)\b/i.test(raw+' '+sec);
  const isLive=/\bLIVE[- ]ACTION\b|\bREMAKE\b/i.test(raw);
  const queries=[];
  const push=q=>{q=String(q||'').replace(/\s+/g,' ').trim(); if(q && !queries.includes(q)) queries.push(q);};
  // Aladdin disambiguation — 1992 animated vs 2019 live action
  if(/\bALADDIN\b/i.test(raw)){
    if(isLive) push('Aladdin 2019');
    else push('Aladdin 1992 Disney');
  }
  push(clean);
  if(clean.split(' ').length<=4) push(clean+' movie');
  if(isAnimated && !isLive) push(clean+' disney');
  if(clean!==raw) push(raw);
  return queries.slice(0,4);
}
function scorePosterResult(r, title, query, options={}){
  const cleanT=normalizeSearchText(cleanMovieTitle(title));
  const rawT=normalizeSearchText(title);
  const name=normalizeSearchText(r.trackName || r.collectionName || '');
  if(!name) return 0;
  let score=0;
  if(name===cleanT) score+=60;
  else if(name===rawT) score+=55;
  else if(name.startsWith(cleanT+' ') || name.startsWith(cleanT+':')) score+=42;
  else if(name.includes(cleanT) && cleanT.length>=3) score+=30;
  else if(cleanT.includes(name) && name.length>=3) score+=22;
  // Word overlap bonus
  const tWords=cleanT.split(' ').filter(Boolean);
  const nWords=new Set(name.split(' ').filter(Boolean));
  if(tWords.length){
    const overlap=tWords.filter(w=>nWords.has(w)).length;
    score += Math.round((overlap/tWords.length)*20);
  }
  if(r.kind==='feature-movie') score+=12;
  // Aladdin: prefer 1992 over 2019 unless title says live action / remake
  if(/\bALADDIN\b/i.test(title)){
    const isLive=/LIVE[- ]ACTION|REMAKE/i.test(title);
    const rel=String(r.releaseDate||'');
    if(rel.startsWith('1992') && !isLive) score+=25;
    if(rel.startsWith('2019') && !isLive) score-=20;
    if(rel.startsWith('2019') && isLive) score+=15;
  }
  // Penalize obvious wrong-type matches
  if(/\bsoundtrack\b|\bscore\b|\boriginal motion picture\b/.test(name) && !/\bsoundtrack\b|\bscore\b/.test(cleanT)) score-=30;
  if(name.length>cleanT.length*3+10) score-=10;
  return score;
}
async function findWikipediaPoster(title, options={}){
  const queries=buildWikipediaPosterQueries(title, options);
  let best=null;
  for(const q of queries){
    const url='https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrnamespace=0&gsrlimit=6&gsrsearch='+encodeURIComponent(q)+'&prop=pageimages|description&piprop=thumbnail&pithumbsize=900&format=json&origin=*';
    const res=await fetch(url);
    if(!res.ok) continue;
    const data=await res.json();
    const pages=Object.values(data.query?.pages || {});
    for(const p of pages){
      if(!p.thumbnail?.source) continue;
      const score=scoreWikiPosterPage(p, title, q, options);
      if(!best || score>best.score) best={score,page:p};
    }
    if(best && best.score>=65) break;
  }
  return best?.page?.thumbnail?.source || '';
}
function buildWikipediaPosterQueries(title, options={}){
  const raw=String(title||'').trim();
  const clean=cleanMovieTitle(raw);
  const sec=String(options.section||'').toUpperCase();
  const disneyish=sec.includes('DISNEY') || sec==='TV ROOM' || /\b(DISNEY|PIXAR|ALADDIN|LION KING|CINDERELLA|SNOW WHITE|MULAN|MOANA|FROZEN|BAMBI|PINOCCHIO|BEAUTY|MERMAID|POCAHONTAS|RATATOUILLE|NEMO|DORY|TOY STORY|TARZAN|ZOOTOPIA)\b/i.test(raw);
  const live=/LIVE ACTION|REMAKE/i.test(raw);
  const queries=[]; const push=q=>{q=String(q||'').replace(/\s+/g,' ').trim(); if(q && !queries.includes(q)) queries.push(q);};
  if(/\bALADDIN\b/i.test(raw) && !live) push('Aladdin 1992 Disney animated film');
  if(/\bALADDIN\b/i.test(raw) && live) push('Aladdin 2019 film');
  if(disneyish && !live) push(clean+' Disney film');
  if(disneyish && !live) push(clean+' animated film');
  push(clean+' film');
  push(clean+' movie');
  push(clean);
  return queries.slice(0,6);
}
function scoreWikiPosterPage(page, originalTitle, query, options={}){
  const clean=normalizeSearchText(cleanMovieTitle(originalTitle));
  const name=normalizeSearchText(page.title || '');
  const desc=normalizeSearchText(page.description || '');
  const q=normalizeSearchText(query);
  let score=0;
  if(name===clean) score+=55;
  if(name.includes(clean) || clean.includes(name)) score+=32;
  if(q && (name.includes(q) || q.includes(name))) score+=14;
  const words=clean.split(' ').filter(Boolean);
  score += words.filter(w=>name.includes(w)).length * 8;
  if(/film|movie|animated/.test(name+' '+desc)) score+=18;
  if(/disambiguation|song|album|novel|musical/.test(desc)) score-=25;
  if(/\bALADDIN\b/i.test(originalTitle) && /1992|disney|animated/.test(name+' '+desc)) score+=24;
  return score;
}
function upgradeArtworkUrl(url){
  return String(url).replace(/\/\d+x\d+bb\./,'/1000x1500bb.').replace(/\/\d+x\d+bb\//,'/1000x1500bb/').replace('100x100bb','1000x1500bb').replace('100x100','1000x1500');
}

/* ---------- Smart auto cover lookup + visible-card lazy loading ---------- */
function setupVisibleCoverAutoload(){
  if(coverObserver){coverObserver.disconnect(); coverObserver=null;}
  if(!els.movieGrid || compact || activeScreen!=='library') return;
  const cards=[...els.movieGrid.querySelectorAll('.card[data-needs-poster="true"]')];
  if(!cards.length) return;
  if(!('IntersectionObserver' in window)){
    cards.slice(0,12).forEach(card=>queueAutoCover(card.dataset.id));
    return;
  }
  coverObserver = new IntersectionObserver(entries=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting){
        const card=entry.target;
        coverObserver.unobserve(card);
        queueAutoCover(card.dataset.id);
      }
    });
  }, {root:null, rootMargin:'650px 0px', threshold:0.01});
  cards.forEach(card=>coverObserver.observe(card));
}
function queueAutoCover(id){
  if(!id || autoCoverQueued.has(id) || autoCoverRunning.has(id) || autoCoverFailedSession.has(id)) return;
  const movie=state.movies.find(m=>m.id===id);
  if(!movie || movie.poster || movie.posterRemoved===true) return;
  autoCoverQueued.add(id);
  autoCoverQueue.push(id);
  pumpAutoCoverQueue();
}
function pumpAutoCoverQueue(){
  while(autoCoverRunning.size < AUTO_COVER_CONCURRENCY && autoCoverQueue.length){
    const id=autoCoverQueue.shift();
    autoCoverQueued.delete(id);
    autoCoverRunning.add(id);
    autoLoadVisibleCover(id).finally(()=>{
      autoCoverRunning.delete(id);
      pumpAutoCoverQueue();
    });
  }
}
async function autoLoadVisibleCover(id){
  const movie=state.movies.find(m=>m.id===id);
  if(!movie || movie.poster || movie.posterRemoved===true) return;
  const card=[...els.movieGrid.querySelectorAll('.card')].find(c=>c.dataset.id===id);
  if(!card) return;
  const cacheKey=smartCoverCacheKey(movie.title, {section:movie.section, format:movie.format});
  const cached=getSmartCoverCache(cacheKey);
  if(cached){
    if(cached.posterUrl){
      if(!movie.poster && movie.posterRemoved!==true){movie.poster=cached.posterUrl; movie.posterRemoved=false; movie.updated=today(); save(); updateCardPoster(id, cached.posterUrl, movie.title);}
    }else{
      autoCoverFailedSession.add(id);
    }
    return;
  }
  markCardLoading(id,true);
  try{
    const result=await lookupSmartCover(movie.title, {section:movie.section, format:movie.format}, false);
    if(result?.posterUrl){
      setSmartCoverCache(cacheKey, result, COVER_SUCCESS_CACHE_DAYS);
      const stillMovie=state.movies.find(m=>m.id===id);
      if(stillMovie && !stillMovie.poster && stillMovie.posterRemoved!==true){
        stillMovie.poster=result.posterUrl;
        stillMovie.posterRemoved=false;
        stillMovie.updated=today();
        save();
        updateCardPoster(id, result.posterUrl, stillMovie.title);
      }
    }else{
      setSmartCoverCache(cacheKey, {posterUrl:'', reason:'No strong cover match', fetchedAt:new Date().toISOString()}, COVER_FAIL_CACHE_DAYS);
      autoCoverFailedSession.add(id);
    }
  }catch(e){
    setSmartCoverCache(cacheKey, {posterUrl:'', reason:e.message || String(e), fetchedAt:new Date().toISOString()}, COVER_FAIL_CACHE_DAYS);
    autoCoverFailedSession.add(id);
  }finally{
    markCardLoading(id,false);
  }
}
function getCoverSettings(){
  return {
    itunesCountry:(localStorage.getItem('movieVault.itunesCountry') || 'US').toUpperCase(),
    cacheDays:COVER_SUCCESS_CACHE_DAYS
  };
}
function smartCoverCacheKey(title, options={}){
  const cleaned=normalizeTitle(title);
  const year=options.year || cleaned.year || inferYearFromTitle(cleaned.title);
  return `${cleaned.cacheKey}:${year || ''}:nokey-visible-v7`;
}
function getSmartCoverCache(key){
  try{
    const cached=JSON.parse(localStorage.getItem(COVER_CACHE_PREFIX+key) || 'null');
    if(!cached) return null;
    if(Date.now()>cached.expiresAt){localStorage.removeItem(COVER_CACHE_PREFIX+key); return null;}
    return cached.value;
  }catch(_){return null;}
}
function setSmartCoverCache(key, value, days){
  try{
    localStorage.setItem(COVER_CACHE_PREFIX+key, JSON.stringify({expiresAt:Date.now()+days*24*60*60*1000, value}));
  }catch(_){/* localStorage can fill up; cover lookup should still work without cache */}
}
async function lookupSmartCover(rawTitle, options={}, useCache=true){
  const cleaned=normalizeTitle(rawTitle);
  const year=options.year || cleaned.year || inferYearFromTitle(cleaned.title);
  if(!cleaned.title) return null;
  const cacheKey=smartCoverCacheKey(rawTitle, {...options, year});
  if(useCache){
    const cached=getSmartCoverCache(cacheKey);
    if(cached) return cached.posterUrl ? cached : null;
  }
  const settings=getCoverSettings();
  const providers=[
    ()=>lookupItunes(cleaned, year, settings),
    ()=>lookupWikipediaPageImage(cleaned, year),
    ()=>lookupWikidata(cleaned, year)
  ];
  for(const provider of providers){
    try{
      const result=await provider();
      if(result?.posterUrl){
        if(useCache) setSmartCoverCache(cacheKey, result, COVER_SUCCESS_CACHE_DAYS);
        return result;
      }
    }catch(_){/* next provider */}
  }
  if(useCache) setSmartCoverCache(cacheKey, {posterUrl:'', reason:'No strong cover match', fetchedAt:new Date().toISOString()}, COVER_FAIL_CACHE_DAYS);
  return null;
}
async function gatherPosterCandidates(searchTerm, options={}){
  const cleaned=normalizeTitle(searchTerm || options.originalTitle || '');
  const year=options.year || cleaned.year || inferYearFromTitle(cleaned.title);
  const settings=getCoverSettings();
  const all=[];
  const seen=new Set();
  const push=(r, fallbackScore=0)=>{
    if(!r) return;
    const url=r.posterUrl || r.url;
    if(!url) return;
    const key=url.replace(/^https?:/,'').replace(/\d+x\d+(bb|sr)?/gi,'X');
    if(seen.has(key)) return;
    seen.add(key);
    all.push({
      url,
      source:r.provider || r.source || 'Cover',
      label:r.title || r.label || '',
      year:r.year || '',
      score:Math.round((r.confidence || 0) * 100) || r.score || fallbackScore,
      kind:r.raw?.matchedMethod || r.kind || ''
    });
  };
  try{ push(await lookupItunes(cleaned, year, settings), 86); }catch(_){ }
  try{ push(await lookupWikipediaPageImage(cleaned, year), 82); }catch(_){ }
  try{ push(await lookupWikidata(cleaned, year), 60); }catch(_){ }
  try{
    const extra=await gatherItunesCandidateList(cleaned, year, settings, options);
    extra.forEach(c=>push(c));
  }catch(_){ }
  all.sort((a,b)=>b.score-a.score);
  return all.slice(0,30);
}
async function gatherItunesCandidateList(cleaned, year, settings, options={}){
  const variants=buildTitleVariants(cleaned.title, year).slice(0,4);
  const out=[];
  for(const variant of variants){
    const url=new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', variant);
    url.searchParams.set('media','movie');
    url.searchParams.set('entity','movie');
    url.searchParams.set('country', settings.itunesCountry || 'US');
    url.searchParams.set('limit','18');
    try{
      const data=await fetchJson(url.toString(), {}, 8500);
      for(const item of (data.results || []).filter(x=>x.artworkUrl100)){
        const itemYear=item.releaseDate ? String(item.releaseDate).slice(0,4) : '';
        const titleScore=Math.max(
          similarity(cleaned.title, item.trackName || ''),
          similarity(variant, item.trackName || ''),
          similarity(cleaned.title, item.collectionName || ''),
          similarity(variant, item.collectionName || '')
        );
        const yearScore=year && itemYear===year ? .14 : year && itemYear!==year ? -.07 : 0;
        const movieBonus=item.wrapperType==='track' && item.kind==='feature-movie' ? .04 : 0;
        const confidence=Math.min(.86, titleScore + yearScore + movieBonus);
        if(confidence>=.36){
          out.push({provider:'iTunes', confidence, title:item.trackName || item.collectionName || '', year:itemYear, posterUrl:upgradeArtworkUrl(item.artworkUrl100), raw:item});
        }
      }
    }catch(_){ }
  }
  return out.sort((a,b)=>b.confidence-a.confidence).slice(0,24);
}
function normalizeTitle(rawTitle){
  let title=String(rawTitle || '').trim();
  const original=title;
  const removed=[];
  title=title.replace(/[_]+/g,' ').replace(/\s+/g,' ').trim();
  title=title.replace(/\s*\((?:\d{1,2}|[A-Z])\)\s*$/i,(match)=>{removed.push(match.trim()); return '';}).trim();
  title=title.replace(/[\[{(]([^\]})]+)[\]})]/g,(full,inner)=>{
    const text=inner.trim();
    if(/^(18|19|20)\d{2}$/.test(text)) return full;
    if(looksLikeEditionOrFormat(text)){removed.push(text); return ' ';}
    return full;
  });
  let year='';
  title=title.replace(/\b((?:18|19|20)\d{2})\b\s*$/i,(full,y)=>{year=y; removed.push(`year:${y}`); return ' ';}).trim();
  title=title.replace(/\s+\d{3,7}$/g,(full)=>{
    if(/^\d+$/.test(title.trim())) return full;
    removed.push(`catalog-id:${full.trim()}`);
    return '';
  }).trim();
  const editionPatterns=[
    /\b(4k\s*)?uhd\b/ig,/\b4k\b/ig,/\bsteel\s*book\b/ig,/\bsteelbook\b/ig,/\bblu[\s-]?ray\b/ig,/\bdvd\b/ig,/\b3d\b/ig,
    /\bcriterion\b/ig,/\bremaster(?:ed)?\b/ig,/\bcollector'?s edition\b/ig,/\bspecial edition\b/ig,/\blimited edition\b/ig,
    /\bextended edition\b/ig,/\bdirector'?s cut\b/ig,/\btheatrical cut\b/ig,/\bdisc\s*\d+\b/ig,/\bregion\s*[a-c0-9]+\b/ig,
    /\bsign(?:ature)?\.?\s*coll(?:ection)?\.?\b/ig,/\bdiamond edition\b/ig,/\banniversary\b/ig,/\bltd\.?\s*coll\.?\b/ig,
    /\bdigibook\b/ig,/\bmediabook\b/ig
  ];
  for(const pattern of editionPatterns){
    title=title.replace(pattern,(match)=>{removed.push(match.trim()); return ' ';});
  }
  title=title.replace(/\s+[:\-–—]\s*$/g,'').replace(/\s+/g,' ').trim();
  return {original, title:title || original, year, removed:[...new Set(removed.filter(Boolean))], cacheKey:`${(title || original).toLowerCase()}|${year || ''}`};
}
function cleanMovieTitle(t){return normalizeTitle(t).title;}
function looksLikeEditionOrFormat(text){
  return /\b(4k|uhd|dvd|blu[\s-]?ray|steel\s*book|steelbook|3d|criterion|remaster|collector|special|limited|extended|director|theatrical|region|disc|signature|diamond|digibook|mediabook)\b/i.test(text);
}
async function fetchJson(url, options={}, timeoutMs=8500){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(), timeoutMs);
  const signal=options.signal || controller.signal;
  try{
    const response=await fetch(url, {...options, signal});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }finally{clearTimeout(timeout);}
}
async function lookupItunes(cleaned, year, settings){
  const variants=buildTitleVariants(cleaned.title, year);
  for(const variant of variants){
    const url=new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', variant);
    url.searchParams.set('media','movie');
    url.searchParams.set('entity','movie');
    url.searchParams.set('country', settings.itunesCountry || 'US');
    url.searchParams.set('limit','35');
    const data=await fetchJson(url.toString());
    const candidates=(data.results || []).filter(item=>item.artworkUrl100);
    if(!candidates.length) continue;
    const scored=candidates.map(item=>{
      const itemYear=item.releaseDate ? String(item.releaseDate).slice(0,4) : '';
      const titleScore=Math.max(
        similarity(cleaned.title, item.trackName || ''),
        similarity(variant, item.trackName || ''),
        similarity(cleaned.title, item.collectionName || ''),
        similarity(variant, item.collectionName || '')
      );
      const yearScore=year && itemYear===year ? .14 : year && itemYear!==year ? -.07 : 0;
      const movieBonus=item.wrapperType==='track' && item.kind==='feature-movie' ? .04 : 0;
      return {item, score:titleScore + yearScore + movieBonus, year:itemYear};
    }).sort((a,b)=>b.score-a.score);
    const best=scored[0];
    if(best.score < .42) continue;
    return normalizeResult({provider:'iTunes', confidence:Math.min(.86,best.score), title:best.item.trackName || best.item.collectionName, year:best.year, posterUrl:upgradeArtworkUrl(best.item.artworkUrl100), pageUrl:best.item.trackViewUrl || best.item.collectionViewUrl || '', raw:{matchedAlias:variant, ...best.item}});
  }
  return null;
}
function upgradeArtworkUrl(url){
  if(!url) return url;
  return String(url)
    .replace(/\d+x\d+(bb|sr)?\.(jpg|png|jpeg)$/i,'1200x1800bb.$2')
    .replace(/\/\d+x\d+bb\./,'/1200x1800bb.')
    .replace(/\/\d+x\d+bb\//,'/1200x1800bb/')
    .replace('100x100bb','1200x1800bb')
    .replace('100x100','1200x1800');
}
async function lookupWikipediaPageImage(cleaned, year){
  const variants=buildTitleVariants(cleaned.title, year);
  const lookupYear=year || inferYearFromTitle(cleaned.title);
  const directTitles=buildWikipediaTitleCandidates(variants, lookupYear);
  for(let i=0;i<directTitles.length;i+=40){
    const chunk=directTitles.slice(i,i+40);
    const directUrl=new URL('https://en.wikipedia.org/w/api.php');
    directUrl.searchParams.set('action','query');
    directUrl.searchParams.set('titles', chunk.join('|'));
    directUrl.searchParams.set('redirects','1');
    directUrl.searchParams.set('prop','pageimages|extracts|info|revisions');
    directUrl.searchParams.set('piprop','thumbnail|name|original');
    directUrl.searchParams.set('pithumbsize','900');
    directUrl.searchParams.set('exintro','1');
    directUrl.searchParams.set('explaintext','1');
    directUrl.searchParams.set('inprop','url');
    directUrl.searchParams.set('rvprop','content');
    directUrl.searchParams.set('rvslots','main');
    directUrl.searchParams.set('format','json');
    directUrl.searchParams.set('formatversion','2');
    directUrl.searchParams.set('origin','*');
    const data=await fetchJson(directUrl.toString());
    const pages=pagesFromWikiResponse(data).filter(page=>!page.missing);
    const candidates=pages.map(page=>scoreWikipediaPage(page, variants, cleaned.title, lookupYear, true)).filter(c=>c.accepted).sort((a,b)=>b.score-a.score);
    for(const candidate of candidates){
      const image=candidate.page.original?.source || candidate.page.thumbnail?.source || await getWikipediaInfoboxPosterUrl(candidate.page);
      if(!image) continue;
      return normalizeResult({provider:image.sourceProvider || 'Wikipedia Infobox/PageImages', confidence:Math.min(.94,candidate.score), title:stripArticleQualifier(candidate.page.title), year:candidate.year || lookupYear || '', posterUrl:image.url || image, pageUrl:candidate.page.fullurl || `https://en.wikipedia.org/?curid=${candidate.page.pageid}`, raw:{matchedMethod:image.sourceProvider==='Wikipedia Infobox'?'exact-page-infobox':'exact-page-pageimage', pageid:candidate.page.pageid, pageTitle:candidate.page.title, imageName:image.fileName || candidate.page.pageimage || '', extract:(candidate.page.extract || '').slice(0,450)}});
    }
  }
  for(const variant of variants){
    const searchUrl=new URL('https://en.wikipedia.org/w/api.php');
    searchUrl.searchParams.set('action','query');
    searchUrl.searchParams.set('generator','search');
    searchUrl.searchParams.set('gsrsearch', lookupYear ? `${variant} ${lookupYear} film` : `${variant} film`);
    searchUrl.searchParams.set('gsrlimit','8');
    searchUrl.searchParams.set('prop','pageimages|extracts|info|revisions');
    searchUrl.searchParams.set('piprop','thumbnail|name|original');
    searchUrl.searchParams.set('pithumbsize','900');
    searchUrl.searchParams.set('exintro','1');
    searchUrl.searchParams.set('explaintext','1');
    searchUrl.searchParams.set('inprop','url');
    searchUrl.searchParams.set('rvprop','content');
    searchUrl.searchParams.set('rvslots','main');
    searchUrl.searchParams.set('format','json');
    searchUrl.searchParams.set('formatversion','2');
    searchUrl.searchParams.set('origin','*');
    const data=await fetchJson(searchUrl.toString());
    const pages=pagesFromWikiResponse(data);
    const candidates=pages.map(page=>scoreWikipediaPage(page, variants, cleaned.title, lookupYear, false)).filter(c=>c.accepted).sort((a,b)=>b.score-a.score);
    for(const candidate of candidates){
      const image=candidate.page.original?.source || candidate.page.thumbnail?.source || await getWikipediaInfoboxPosterUrl(candidate.page);
      if(!image) continue;
      return normalizeResult({provider:image.sourceProvider || 'Wikipedia Infobox/PageImages', confidence:Math.min(.88,candidate.score), title:stripArticleQualifier(candidate.page.title), year:candidate.year || lookupYear || '', posterUrl:image.url || image, pageUrl:candidate.page.fullurl || `https://en.wikipedia.org/?curid=${candidate.page.pageid}`, raw:{matchedMethod:image.sourceProvider==='Wikipedia Infobox'?'strict-search-infobox':'strict-search-pageimage', matchedAlias:variant, pageid:candidate.page.pageid, pageTitle:candidate.page.title, imageName:image.fileName || candidate.page.pageimage || '', extract:(candidate.page.extract || '').slice(0,450)}});
    }
  }
  return null;
}
function pagesFromWikiResponse(data){
  const pages=data.query?.pages || [];
  return Array.isArray(pages) ? pages : Object.values(pages);
}
async function getWikipediaInfoboxPosterUrl(page){
  const wikiText=extractWikiText(page);
  const fileName=extractInfoboxImageFileName(wikiText);
  if(!fileName) return null;
  const infoUrl=new URL('https://en.wikipedia.org/w/api.php');
  infoUrl.searchParams.set('action','query');
  infoUrl.searchParams.set('titles', `File:${fileName}`);
  infoUrl.searchParams.set('prop','imageinfo');
  infoUrl.searchParams.set('iiprop','url|mime|size');
  infoUrl.searchParams.set('iiurlwidth','900');
  infoUrl.searchParams.set('format','json');
  infoUrl.searchParams.set('origin','*');
  const data=await fetchJson(infoUrl.toString());
  const filePage=pagesFromWikiResponse(data)[0];
  const imageInfo=filePage?.imageinfo?.[0];
  const url=imageInfo?.thumburl || imageInfo?.url;
  if(!url) return null;
  return {url, fileName, sourceProvider:'Wikipedia Infobox'};
}
function extractWikiText(page){
  const revision=page.revisions?.[0];
  return revision?.slots?.main?.content || revision?.slots?.main?.['*'] || revision?.content || revision?.['*'] || '';
}
function extractInfoboxImageFileName(wikiText){
  const lines=String(wikiText || '').split(String.fromCharCode(10));
  for(const line of lines){
    const trimmed=line.trim();
    const lower=trimmed.toLowerCase();
    if(!lower.startsWith('| image')) continue;
    if(lower.startsWith('| image_size') || lower.startsWith('| image size') || lower.startsWith('| image_alt') || lower.startsWith('| image alt') || lower.startsWith('| image_caption') || lower.startsWith('| caption')) continue;
    const equalsIndex=trimmed.indexOf('=');
    if(equalsIndex<0) continue;
    let value=trimmed.slice(equalsIndex+1).trim();
    value=stripHtmlComments(value).trim();
    value=value.replace(/^\[\[/,'').replace(/\]\]$/,'');
    value=value.replace(/^file:/i,'').replace(/^image:/i,'');
    value=value.split('|')[0].trim();
    value=value.replace(/^[\'\"]+|[\'\"]+$/g,'').trim();
    if(value && !value.includes('{{') && !value.includes('}}')) return value;
  }
  return '';
}
function stripHtmlComments(value){
  let output=String(value || '');
  while(output.includes('<!--') && output.includes('-->')){
    const start=output.indexOf('<!--');
    const end=output.indexOf('-->', start);
    if(end<0) break;
    output=output.slice(0,start)+output.slice(end+3);
  }
  return output;
}
function buildWikipediaTitleCandidates(variants, year){
  const titles=[];
  const add=value=>{
    const cleaned=compactSpaces(value);
    if(!cleaned) return;
    if(!titles.some(existing=>simpleText(existing)===simpleText(cleaned))) titles.push(cleaned);
  };
  for(const variant of variants){
    if(year) add(`${variant} (${year} film)`);
    add(`${variant} (film)`);
    add(variant);
  }
  return titles;
}
function scoreWikipediaPage(page, variants, requestedTitle, year, exactPageMode){
  const articleTitle=page.title || '';
  const bareTitle=stripArticleQualifier(articleTitle);
  const textBlob=`${articleTitle} ${page.extract || ''}`.toLowerCase();
  const articleSimple=simpleText(articleTitle);
  const bareSimple=simpleText(bareTitle);
  const variantSimples=variants.map(simpleText).filter(Boolean);
  const requestedSimple=simpleText(requestedTitle);
  const pageYear=extractYearFromText(`${articleTitle} ${page.extract || ''}`);
  const hasFilmSignals=textBlob.includes('film') || textBlob.includes('directed by') || textBlob.includes('starring') || textBlob.includes('screenplay') || textBlob.includes('animated');
  const hasImage=Boolean(page.thumbnail?.source || page.original?.source || page.pageimage);
  const exactBareMatch=variantSimples.includes(bareSimple) || bareSimple===requestedSimple;
  const exactQualifiedMatch=variantSimples.some(value=>articleSimple===simpleText(`${value} film`) || articleSimple===simpleText(`${value} ${year || ''} film`));
  const yearOk=!year || pageYear===String(year) || articleTitle.includes(String(year));
  const oneWordRequest=requestedSimple.split(' ').filter(Boolean).length===1;
  let accepted=hasFilmSignals && yearOk && (exactBareMatch || exactQualifiedMatch);
  if(oneWordRequest && !exactBareMatch && !exactQualifiedMatch) accepted=false;
  if(!exactPageMode && !exactBareMatch) accepted=false;
  let score=0;
  if(accepted){
    score=.68;
    if(exactBareMatch) score+=.16;
    if(exactQualifiedMatch) score+=.10;
    if(year && yearOk) score+=.10;
    if(hasFilmSignals) score+=.04;
    if(hasImage) score+=.02;
  }
  return {page, accepted, score, year:pageYear};
}
function inferYearFromTitle(title){
  const key=simpleText(title);
  const knownYears={se7en:'1995', seven:'1995', alien:'1979'};
  return knownYears[key] || '';
}
function stripArticleQualifier(title){
  const idx=String(title || '').indexOf(' (');
  return idx>0 ? String(title).slice(0,idx) : String(title || '');
}
function extractYearFromText(text){
  const source=String(text || '');
  const match=source.match(/\b(18|19|20)\d{2}\b/);
  return match ? match[0] : '';
}
async function lookupWikidata(cleaned, year){
  const searchUrl=new URL('https://www.wikidata.org/w/api.php');
  searchUrl.searchParams.set('action','wbsearchentities');
  searchUrl.searchParams.set('search', cleaned.title);
  searchUrl.searchParams.set('language','en');
  searchUrl.searchParams.set('format','json');
  searchUrl.searchParams.set('origin','*');
  searchUrl.searchParams.set('limit','8');
  const searchData=await fetchJson(searchUrl.toString());
  const ids=(searchData.search || []).map(item=>item.id).slice(0,8);
  if(!ids.length) return null;
  const entityUrl=new URL('https://www.wikidata.org/w/api.php');
  entityUrl.searchParams.set('action','wbgetentities');
  entityUrl.searchParams.set('ids', ids.join('|'));
  entityUrl.searchParams.set('props','claims|labels|descriptions');
  entityUrl.searchParams.set('languages','en');
  entityUrl.searchParams.set('format','json');
  entityUrl.searchParams.set('origin','*');
  const entityData=await fetchJson(entityUrl.toString());
  const entities=Object.values(entityData.entities || {});
  const scored=[];
  for(const entity of entities){
    const claims=entity.claims || {};
    const isFilm=(claims.P31 || []).some(claim=>claim.mainsnak?.datavalue?.value?.id==='Q11424');
    const imageClaim=(claims.P18 || [])[0]?.mainsnak?.datavalue?.value;
    const publicationYear=extractWikidataYear(claims.P577);
    const title=entity.labels?.en?.value || '';
    if(!isFilm || !imageClaim) continue;
    const titleScore=similarity(cleaned.title, title);
    const yearScore=year && publicationYear===year ? .16 : 0;
    scored.push({entity, imageClaim, title, publicationYear, score:titleScore + yearScore});
  }
  scored.sort((a,b)=>b.score-a.score);
  const best=scored[0];
  if(!best || best.score < .42) return null;
  return normalizeResult({provider:'Wikidata/P18', confidence:Math.min(.76,best.score), title:best.title, year:best.publicationYear, posterUrl:commonsImageUrl(best.imageClaim, 600), pageUrl:`https://www.wikidata.org/wiki/${best.entity.id}`, raw:{id:best.entity.id, image:best.imageClaim, description:best.entity.descriptions?.en?.value || ''}});
}
function extractWikidataYear(claims){
  const value=(claims || [])[0]?.mainsnak?.datavalue?.value?.time;
  const match=String(value || '').match(/[+-](\d{4})/);
  return match ? match[1] : '';
}
function commonsImageUrl(fileName, width){
  const normalized=String(fileName).replace(/ /g,'_');
  return `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(normalized)}?width=${width}`;
}
function normalizeResult(result){
  return {provider:result.provider, confidence:Number(result.confidence || 0), title:result.title || '', year:result.year || '', posterUrl:result.posterUrl || '', pageUrl:result.pageUrl || '', raw:result.raw || {}, fetchedAt:new Date().toISOString()};
}
function buildTitleVariants(title, year=''){
  const base=compactSpaces(title);
  const variants=[];
  const add=value=>{
    const cleaned=compactSpaces(value);
    if(!cleaned) return;
    if(!variants.some(existing=>simpleText(existing)===simpleText(cleaned))) variants.push(cleaned);
  };
  add(base);
  add(base.split(':').join(' '));
  add(base.split('’').join(''));
  add(base.split("'").join(''));
  add(leetToWords(base));
  const known={'se7en':'Seven','wall e':'WALL-E','walle':'WALL-E','mi':'Mission: Impossible','fifth element':'The Fifth Element','wonderful life':'It’s a Wonderful Life','the mermaid':'The Little Mermaid','hunchback':'The Hunchback of Notre Dame'};
  const key=simpleText(base);
  if(known[key]) add(known[key]);
  if(year && base.includes(String(year))) add(base.split(String(year)).join(''));
  return variants.slice(0,8);
}
function compactSpaces(value){return String(value || '').split(' ').filter(Boolean).join(' ').trim();}
function leetToWords(title){return String(title || '').split('0').join('o').split('1').join('i').split('3').join('e').split('4').join('a').split('5').join('s').split('7').join('v');}
function normalizeSearchText(t){return simpleText(t);}
function simpleText(value){
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\b(the|a|an)\b/g,' ').replace(/\s+/g,' ').trim();
}
function similarity(a,b){
  const x=simpleText(a);
  const y=simpleText(b);
  if(!x || !y) return 0;
  if(x===y) return 1;
  const xParts=x.split(' ').filter(Boolean);
  const yParts=y.split(' ').filter(Boolean);
  const xTokens=new Set(xParts);
  const yTokens=new Set(yParts);
  const intersection=[...xTokens].filter(token=>yTokens.has(token)).length;
  const union=new Set([...xTokens, ...yTokens]).size;
  const tokenScore=union ? intersection/union : 0;
  const editScore=1 - levenshteinDistance(x,y)/Math.max(x.length,y.length);
  let containmentPenalty=0;
  if(xParts.length===1 && yParts.length>1 && yTokens.has(x)) containmentPenalty=.32;
  if(yParts.length===1 && xParts.length>1 && xTokens.has(y)) containmentPenalty=.32;
  return Math.max(0, Math.min(1, tokenScore*.62 + editScore*.38 - containmentPenalty));
}
function levenshteinDistance(a,b){
  const dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) dp[i][0]=i;
  for(let j=0;j<=b.length;j++) dp[0][j]=j;
  for(let i=1;i<=a.length;i++){
    for(let j=1;j<=b.length;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[a.length][b.length];
}

async function lookupBarcode(code, fillForm=false){
  code=String(code||'').trim();
  if(!code){toast('Scan or type a barcode first.'); return;}
  try{
    setScanStatus('Looking up barcode…');
    const res=await fetch('https://api.upcitemdb.com/prod/trial/lookup?upc='+encodeURIComponent(code));
    const data=await res.json();
    const item=data.items?.[0];
    if(item){
      if(fillForm || !els.newTitle.value.trim()) els.newTitle.value = cleanLookupTitle(item.title || '');
      if(item.images?.[0] && !els.newPoster.value.trim()) els.newPoster.value = item.images[0];
      if(!els.newNotes.value.trim()) els.newNotes.value = [item.brand, item.description].filter(Boolean).join(' — ').slice(0,350);
      toast('Barcode found. Check title and section before adding.');
      setScanStatus('Barcode found.');
    }else{
      toast('Barcode scanned, but no product data found. Add title manually.');
      setScanStatus('No product data found. Add title manually.');
    }
  }catch(e){
    toast('Barcode scanned. Lookup failed, so add title manually.');
    setScanStatus('Lookup failed. You can still add it manually.');
  }
}
function cleanLookupTitle(t){return String(t||'').replace(/\s+(?:\(?\s*(?:blu[- ]?ray|dvd|4k|uhd|ultra hd)\s*\)?).*$/i,'').trim()}
function setScanStatus(msg){els.scanStatus.textContent=msg || ''}

async function startScanner(){
  stopScanner(false);
  setScanStatus('Checking camera access…');
  els.scanner.classList.add('active');
  els.scannerText.textContent='Point camera at barcode.';
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    els.scanner.classList.remove('active');
    els.scannerText.textContent='Camera API not available.';
    setScanStatus('Camera needs HTTPS/localhost and a browser with getUserMedia support. Type the barcode manually on this device.');
    return;
  }
  try{
    scanStream=await openBestCameraStream();
    els.scanVideo.srcObject=scanStream;
    els.scanVideo.setAttribute('playsinline','');
    await els.scanVideo.play();
    if('BarcodeDetector' in window){
      scanDetector = new BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128','code_39']});
      nativeScanLoop();
      setScanStatus('Camera started. Scanning with native barcode detector…');
    }else{
      setScanStatus('Camera works, but native detector is unavailable. Trying fallback scanner…');
      stopNativeStreamOnly();
      await startQuaggaFallback();
    }
  }catch(e){
    stopScanner(false);
    const msg=cameraErrorMessage(e);
    els.scannerText.textContent='Camera could not start.';
    setScanStatus(msg);
  }
}

async function openBestCameraStream(){
  const attempts=[
    {video:{facingMode:{exact:'environment'}, width:{ideal:1280}, height:{ideal:720}}, audio:false},
    {video:{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}, audio:false},
    {video:{width:{ideal:1280}, height:{ideal:720}}, audio:false},
    {video:true, audio:false}
  ];
  let lastErr;
  for(const constraints of attempts){
    try{return await navigator.mediaDevices.getUserMedia(constraints)}catch(e){lastErr=e;}
  }
  throw lastErr || new Error('No camera available');
}
function stopNativeStreamOnly(){
  if(scanStream){scanStream.getTracks().forEach(t=>t.stop()); scanStream=null;}
  els.scanVideo.pause(); els.scanVideo.srcObject=null;
}
function cameraErrorMessage(e){
  const name=e?.name || '';
  if(location.protocol!=='https:' && location.hostname!=='localhost' && location.hostname!=='127.0.0.1') return 'Camera blocked: open the app on HTTPS or localhost. Browser camera permission will not work from plain HTTP/file links.';
  if(name==='NotAllowedError' || name==='SecurityError') return 'Camera permission was blocked. Use the browser lock/camera icon, allow camera for this site, then press Start scan again.';
  if(name==='NotFoundError' || name==='OverconstrainedError') return 'No usable camera was found. I tried back camera, any camera, and generic video. Type the barcode manually on this device.';
  if(name==='NotReadableError') return 'Camera is already in use by another app/tab. Close other camera apps and try again.';
  return 'Camera failed after permission. I tried back camera, any camera and fallback scanner. Type barcode manually if this browser still blocks it.';
}

async function nativeScanLoop(){
  if(!scanDetector || !els.scanVideo.srcObject) return;
  try{
    const codes = await scanDetector.detect(els.scanVideo);
    if(codes && codes.length){
      const code = codes[0].rawValue;
      onBarcodeFound(code);
      return;
    }
  }catch(e){}
  scanTimer=requestAnimationFrame(nativeScanLoop);
}
async function startQuaggaFallback(){
  try{
    if(!window.Quagga){
      await loadScript('https://cdn.jsdelivr.net/npm/@ericblade/quagga2/dist/quagga.min.js');
      quaggaLoaded=true;
    }
    els.scanVideo.style.display='none';
    window.Quagga.init({
      inputStream:{type:'LiveStream', target:els.scanner, constraints:{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}},
      decoder:{readers:['ean_reader','ean_8_reader','upc_reader','upc_e_reader','code_128_reader','code_39_reader']},
      locate:true
    }, err=>{
      if(err){setScanStatus(cameraErrorMessage(err) || 'Fallback scanner failed. Type barcode manually.'); els.scannerText.textContent='Fallback scanner failed.'; return;}
      quaggaRunning=true; window.Quagga.start(); setScanStatus('Scanning with fallback detector…');
    });
    window.Quagga.onDetected(result=>{const code=result?.codeResult?.code; if(code) onBarcodeFound(code);});
  }catch(e){setScanStatus('Scanner not supported here. Type barcode manually.');}
}
function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});}
function onBarcodeFound(code){
  els.newBarcode.value=code;
  setScanStatus('Found barcode: '+code);
  stopScanner(false);
  lookupBarcode(code, true);
}
function stopScanner(showToast=true){
  if(scanTimer) cancelAnimationFrame(scanTimer);
  scanTimer=null; scanDetector=null;
  if(scanStream){scanStream.getTracks().forEach(t=>t.stop()); scanStream=null;}
  els.scanVideo.pause(); els.scanVideo.srcObject=null; els.scanVideo.style.display='block';
  if(window.Quagga && quaggaRunning){try{window.Quagga.stop()}catch(e){} quaggaRunning=false;}
  els.scanner.classList.remove('active');
  els.scanner.querySelectorAll('canvas, video:not(#scanVideo)').forEach(n=>n.remove());
  els.scannerText.textContent='Camera is off.';
  if(showToast) setScanStatus('Scanner stopped.');
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

init();
