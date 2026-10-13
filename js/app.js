const STORAGE_KEY = 'movieVault.privateCollection.v1';
const UNSORTED_SECTION = 'UNSORTED / NOT PLACED';
const formats = ['All formats','4K UHD','4K Steelbook','Blu-ray','DVD','TV / Series','Blu-ray / DVD','Box set'];
const els = {};
let state = loadState();
let activeScreen = 'library';
let compact = localStorage.getItem('movieVault.viewMode') === 'list';
let duplicatesOnly = false;
let editingId = null;
const FIRST_BATCH = 80, NEXT_BATCH = 100;        // cards rendered up front / per scroll step
let viewList = [], viewDupes = {}, viewShown = 0; // current filtered list, its duplicate map, how many cards are in the DOM
let gridObserver = null, searchTimer = 0, sectionFilterSig = '';
let selectMode = false, shelfIds = [], lastShelf = '';
const selected = new Set();

function $(id){return document.getElementById(id)}
function init(){
  ['totalCount','totalLabel','totalStat','duplicatesStat','duplicateCount','duplicateMicro','smartFilterStat','smartFilterLabel','smartFilterMicro','fourKCount','collectionValue','collectionValueStat','searchInput','sectionFilter','formatFilter','seenFilter','sortSelect','unsortedBtn','viewToggle','movieGrid','resultText','newTitle','newSection','customSection','newFormat','newBarcode','newSeen','newPoster','newNotes','addMovieBtn','posterLookupBtn','barcodeLookupBtn','scanner','scanVideo','scannerText','startScanBtn','stopScanBtn','scanStatus','backupMenuBtn','backupMenu','exportJsonBtn','importBtn','importFile','blueprintPreview','downloadBlueprintBtn','downloadBlueprintTextBtn','printBlueprintBtn','editModal','editPreview','closeModalBtn','editMovieTitle','editSection','editCustomSection','editFormat','editBarcode','editSeen','editPoster','editNotes','deleteMovieBtn','removePosterBtn','editPosterLookupBtn','saveEditBtn','valueModal','valueCloseBtn','valueCurrentText','valueMode','valueAmount','valueNote','valuePreviewText','valueWarning','valueConfirmLine','valueConfirm','rollbackValueBtn','applyValueBtn','valueHistoryList','toast','posterPickerModal','pickerTitle','pickerSubtitle','pickerSearchInput','pickerSearchBtn','pickerStatus','pickerGrid','pickerUrlInput','pickerUrlBtn','pickerCloseBtn','gridSentinel','clearFiltersBtn','selectToggle','selectBar','selectCount','selectAllBtn','selectMoveBtn','selectSeenBtn','selectUnseenBtn','selectCancelBtn','titleDupeNote','shelfModal','shelfTitle','shelfWhat','shelfSelect','shelfNewField','shelfNewInput','shelfOkBtn','shelfCancelBtn'].forEach(id=>els[id]=$(id));
  initCovers();
  document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>showScreen(btn.dataset.screen)));
  els.searchInput.addEventListener('input',()=>{clearTimeout(searchTimer); searchTimer=setTimeout(renderFresh,150);});   // debounced: no full re-render per keystroke
  els.searchInput.addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(searchTimer); renderFresh();}});
  ['sectionFilter','formatFilter','seenFilter','sortSelect'].forEach(id=>els[id].addEventListener('input', renderFresh));
  els.movieGrid.addEventListener('click', onGridClick);   // one delegated handler for every card button (covers.js buttons carry the same data-* attributes)
  els.clearFiltersBtn.addEventListener('click', clearFilters);
  els.selectToggle.addEventListener('click',()=>setSelectMode(!selectMode));
  els.selectAllBtn.addEventListener('click', toggleSelectAll);
  els.selectMoveBtn.addEventListener('click',()=>openShelfPicker([...selected]));
  els.selectSeenBtn.addEventListener('click',()=>bulkSeen(true));
  els.selectUnseenBtn.addEventListener('click',()=>bulkSeen(false));
  els.selectCancelBtn.addEventListener('click',()=>setSelectMode(false));
  els.shelfSelect.addEventListener('change', onShelfChoice);
  els.shelfNewInput.addEventListener('input', updateShelfOk);
  els.shelfNewInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault(); confirmShelf();}});
  els.shelfOkBtn.addEventListener('click', confirmShelf);
  els.shelfCancelBtn.addEventListener('click', closeShelfPicker);
  els.shelfModal.addEventListener('click',e=>{if(e.target===els.shelfModal) closeShelfPicker();});
  els.newTitle.addEventListener('input', updateTitleDupes);
  els.duplicatesStat.addEventListener('click', toggleDuplicatesOnly);
  els.duplicatesStat.addEventListener('keydown', e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault(); toggleDuplicatesOnly();}});
  els.smartFilterStat.addEventListener('click', applySmartCountFilter);
  els.smartFilterStat.addEventListener('keydown', e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault(); applySmartCountFilter();}});
  els.viewToggle.textContent=compact?'Cover view':'List view';
  els.viewToggle.addEventListener('click',()=>{compact=!compact; localStorage.setItem('movieVault.viewMode', compact?'list':'cover'); els.viewToggle.textContent=compact?'Cover view':'List view'; renderFresh();});
  els.unsortedBtn.addEventListener('click',()=>{setSectionFilter(UNSORTED_SECTION); renderFresh(); showScreen('library');});
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
  initScanner();
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
  window.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal(); closePosterPicker(); closeValueModal(); closeShelfPicker();}});
  initBackupUi();
  populateSelects();
  if (window.matchMedia('(max-width: 720px)').matches) showScreen('add');
  renderFresh();
  updateBlueprintPreview();
}

function escapeHtml(str=''){return String(str).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function cleanNotes(str=''){return String(str).replace(/\bImported from blueprint\b/gi,'').replace(/^\s*[—\-:]+\s*/,'').replace(/\s*[—\-:]+\s*$/,'').trim();}
function titleKey(t){return (t||'').toLowerCase().replace(/[^a-z0-9æøå]+/g,' ').trim()}
function hueFor(str){let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))%360; return h;}
// opts.action={label,fn} adds a button (e.g. Undo); opts.warn overrides the "ms>=8000 means warning" rule.
// Warnings and action toasts are "held": ordinary toasts do not bury them while they are showing.
function toast(msg,ms=2600,opts={}){
  const warn = opts.warn!==undefined ? !!opts.warn : ms>=8000, held = warn || !!opts.action;
  if(!held && Date.now()<(toast._hold||0)) return;
  toast._hold = held ? Date.now()+ms : 0;
  els.toast.textContent=msg;
  if(opts.action){
    const b=document.createElement('button'); b.type='button'; b.className='toastBtn'; b.textContent=opts.action.label;
    b.addEventListener('click',()=>{clearTimeout(toast._t); toast._hold=0; els.toast.classList.remove('show'); opts.action.fn();});
    els.toast.append(b);
  }
  els.toast.classList.toggle('warn',warn); els.toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>els.toast.classList.remove('show'),ms);
}

function showScreen(screen){
  activeScreen=screen;
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===screen));
  document.querySelectorAll('.tab').forEach(btn=>btn.setAttribute('aria-selected', btn.dataset.screen===screen ? 'true':'false'));
  if(screen==='export') updateBlueprintPreview();
  if(screen==='add') updateTitleDupes();
  if(screen!=='library' && selectMode) setSelectMode(false);
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
  updateSectionFilter();
  const addOptions = sections.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  els.newSection.innerHTML = addOptions;
  if(!els.newSection.value) els.newSection.value=UNSORTED_SECTION;
  els.editSection.innerHTML = addOptions;
  els.formatFilter.innerHTML = formats.map(f=>`<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
}
function getDuplicateMap(){const c={}; state.movies.forEach(m=>{const k=titleKey(m.title); if(k)c[k]=(c[k]||0)+1}); return c;}
function sectionCounts(){const c={}; state.movies.forEach(m=>{c[m.section]=(c[m.section]||0)+1}); return c;}
// Section filter lists only shelves that hold titles (with counts), in sectionOrder order; the currently selected shelf always stays listed.
function updateSectionFilter(){
  const counts=sectionCounts(), cur=els.sectionFilter.value || 'all';
  const secs=[...new Set([UNSORTED_SECTION, ...state.sectionOrder])].filter(s=>counts[s] || s===cur);
  const sig=secs.map(s=>s+'\t'+(counts[s]||0)).join('\n');
  if(sig===sectionFilterSig) return;   // nothing to rebuild: same shelves, same counts
  sectionFilterSig=sig;
  els.sectionFilter.innerHTML=['<option value="all">All sections</option>', ...secs.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)} (${counts[s]||0})</option>`)].join('');
  els.sectionFilter.value=cur;
}
function setSectionFilter(sec){
  if(sec!=='all' && ![...els.sectionFilter.options].some(o=>o.value===sec)) els.sectionFilter.add(new Option(sec,sec));   // rebuilt with its count by the next render
  els.sectionFilter.value=sec;
}
function getFiltered(dupes=getDuplicateMap()){
  const q=els.searchInput.value.trim().toLowerCase();
  const sec=els.sectionFilter.value;
  const fmt=els.formatFilter.value;
  const seen=els.seenFilter.value;
  let list=state.movies.filter(m=>{
    const searchBlob=[m.title,m.section,m.format,m.barcode,m.notes].join(' ').toLowerCase();
    const dupeCount=dupes[titleKey(m.title)]||0;
    const duplicateOk = !duplicatesOnly || dupeCount>1;
    const seenOk = seen==='all' || (seen==='seen' && m.seen!==false) || (seen==='unseen' && m.seen===false);
    return (!q || searchBlob.includes(q)) && (sec==='all'||m.section===sec) && (fmt==='All formats'||m.format===fmt) && duplicateOk && seenOk;
  });
  const allowedSorts = new Set(['title-asc','title-desc','added-desc','dupes-first','unseen-first','auto-first']);
  const sort = allowedSorts.has(els.sortSelect.value) ? els.sortSelect.value : 'title-asc';
  if (els.sortSelect.value !== sort) els.sortSelect.value = sort;
  list.sort((a,b)=>{
    if(sort==='title-asc') return a.title.localeCompare(b.title);
    if(sort==='title-desc') return b.title.localeCompare(a.title);
    if(sort==='added-desc') return (b.added||'').localeCompare(a.added||'') || b.id.localeCompare(a.id);
    if(sort==='unseen-first') return ((a.seen===false?0:1)-(b.seen===false?0:1)) || a.title.localeCompare(b.title);
    if(sort==='auto-first') return ((b.posterSource==='auto')-(a.posterSource==='auto')) || a.title.localeCompare(b.title);
    if(sort==='dupes-first') return ((dupes[titleKey(b.title)]||0)-(dupes[titleKey(a.title)]||0)) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
  return list;
}
// Cards are added in batches: FIRST_BATCH now, NEXT_BATCH each time #gridSentinel nears the viewport.
// render({reset:true}) starts again from the first batch (filters, search, sort, view changed); a plain render() after an edit keeps as many cards showing as before.
function renderFresh(){render({reset:true});}
function render(opts){
  const keep = opts && opts.reset ? 0 : viewShown;
  updateSectionFilter();
  const dupes=getDuplicateMap(), list=getFiltered(dupes);
  viewList=list; viewDupes=dupes; viewShown=0;
  if(selected.size){const ids=new Set(list.map(m=>m.id)); [...selected].forEach(id=>{if(!ids.has(id)) selected.delete(id);});}
  populateStats(list, dupes);
  els.movieGrid.classList.toggle('compact',compact);
  els.movieGrid.classList.toggle('selecting',selectMode);
  els.resultText.textContent = `Showing ${list.length.toLocaleString()} of ${state.movies.length.toLocaleString()} titles`;
  els.clearFiltersBtn.hidden = !isFilterActive();
  updateSelectBar();
  if(!list.length){
    const placed = els.sectionFilter.value===UNSORTED_SECTION && !state.movies.some(m=>m.section===UNSORTED_SECTION);
    els.movieGrid.innerHTML=`<div class="empty">${placed?'Nothing is unsorted: every title is on a shelf.':'No movies match this filter.'}${isFilterActive()?'<div><button class="ghost" data-clear-filters>Clear filters</button></div>':''}</div>`;
    watchGridEnd();
    return;
  }
  els.movieGrid.textContent='';
  appendCards(Math.max(FIRST_BATCH, keep));
}
function appendCards(n){
  const end=Math.min(viewList.length, viewShown+n);
  if(end>viewShown){
    let html='';
    for(let i=viewShown;i<end;i++){const m=viewList[i]; html+=cardHtml(m, viewDupes[titleKey(m.title)]||0);}
    els.movieGrid.insertAdjacentHTML('beforeend', html);
    viewShown=end;
  }
  watchGridEnd();
  setupVisibleCoverAutoload();   // re-callable: observes every .card[data-needs-poster="true"], including the new ones
}
function watchGridEnd(){
  const more=viewShown<viewList.length;
  if(!('IntersectionObserver' in window)){if(more) appendCards(viewList.length); return;}
  if(!gridObserver) gridObserver=new IntersectionObserver(entries=>{if(viewShown<viewList.length && entries.some(e=>e.isIntersecting)) appendCards(NEXT_BATCH);}, {rootMargin:'1500px 0px'});
  gridObserver.unobserve(els.gridSentinel);   // observe() again so it re-reports even when the sentinel is still near the viewport
  if(more) gridObserver.observe(els.gridSentinel);
}
function onGridClick(e){
  if(e.target.closest('[data-clear-filters]')){clearFilters(); return;}
  const card=e.target.closest('.card'); if(!card || !els.movieGrid.contains(card)) return;
  const id=card.dataset.id;
  if(selectMode){toggleSelect(id); return;}
  const btn=e.target.closest('button'), d=btn ? btn.dataset : null;
  if(!btn){openEdit(id); return;}
  if(d.edit) openEdit(d.edit);
  else if(d.toggleSeen) toggleSeen(d.toggleSeen);
  else if(d.searchposter) quickPosterLookup(d.searchposter);
  else if(d.removePoster) removePoster(d.removePoster);
  else if(d.wrongCover) wrongCover(d.wrongCover);
  else if(d.place) openShelfPicker([d.place]);
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
  renderFresh();
}
function clearFilters(){
  clearTimeout(searchTimer);
  els.searchInput.value=''; setSectionFilter('all'); els.formatFilter.value='All formats'; els.seenFilter.value='all'; duplicatesOnly=false;
  renderFresh();
}
function applySmartCountFilter(){
  const unsortedCount = state.movies.filter(m=>m.section===UNSORTED_SECTION).length;
  const mode = unsortedCount > 0 ? 'unsorted' : 'unseen';
  if(mode==='unsorted'){
    const alreadyActive = els.sectionFilter.value===UNSORTED_SECTION;
    setSectionFilter(alreadyActive ? 'all' : UNSORTED_SECTION);
    if(!alreadyActive) els.seenFilter.value = 'all';
  }else{
    const alreadyActive = els.seenFilter.value==='unseen' && els.sectionFilter.value==='all';
    els.seenFilter.value = alreadyActive ? 'all' : 'unseen';
    setSectionFilter('all');
  }
  renderFresh();
  showScreen('library');
}

function populateStats(filteredList, dupes){
  const filterActive = isFilterActive();
  const totalCount = state.movies.length;
  const shown = (filteredList || viewList).length;
  if(filterActive){
    els.totalLabel.textContent = 'Selected titles';
    els.totalCount.textContent = shown.toLocaleString();
    els.totalStat.classList.add('filtered');
  } else {
    els.totalLabel.textContent = 'Total titles';
    els.totalCount.textContent = totalCount.toLocaleString();
    els.totalStat.classList.remove('filtered');
  }
  dupes = dupes || getDuplicateMap();
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
  const hue=hueFor(m.title), id=escapeHtml(m.id);
  const dupe = dupeCount>1 ? `<span class="chip">${dupeCount} editions</span>` : '';
  const barcode = m.barcode ? `<span class="chip">${escapeHtml(m.barcode)}</span>` : '';
  const seenChip = m.seen===false ? '<span class="chip unseenPill">Not seen</span>' : '<span class="chip seenPill">Seen</span>';
  const removedChip = (!m.poster && m.posterRemoved===true) ? '<span class="chip posterRemovedPill">Poster removed</span>' : '';
  const seenBtn = m.seen===false ? 'Mark seen' : 'Mark unseen';
  const needsPoster = !m.poster && m.posterRemoved!==true;
  const isSel = selectMode && selected.has(m.id);
  const selBox = selectMode ? `<input type="checkbox" class="selBox" tabindex="-1" aria-label="Select ${escapeHtml(m.title)}"${isSel?' checked':''}>` : '';
  const cls = isSel ? 'card selected' : 'card';
  const placeBtn = m.section===UNSORTED_SECTION ? `<button class="miniBtn placeBtn" data-place="${id}">Place on shelf</button>` : '';
  if(compact){
    return `<article class="${cls}" data-id="${id}" data-needs-poster="${needsPoster?'true':'false'}" style="--hue:${hue}">${selBox}
      <div class="body"><h3 class="title">${escapeHtml(m.title)}</h3><div class="meta"><span class="chip">${escapeHtml(m.section)}</span>${seenChip}${removedChip}${dupe}${barcode}</div><div class="formatBadge">${escapeHtml(m.format)}</div>${placeBtn}</div>
    </article>`;
  }
  const img = m.poster ? `<img src="${escapeHtml(m.poster)}" alt="Cover for ${escapeHtml(m.title)}" loading="lazy" onerror="this.remove()">` : '';
  const posterBtn = m.poster
    ? `<button class="miniBtn" data-remove-poster="${id}">Remove poster</button>`
    : `<button class="miniBtn" data-searchposter="${id}">${m.posterRemoved===true?'Choose poster':'Find poster'}</button>`;
  const wrongBtn = m.poster && m.posterSource==='auto' ? `<button class="miniBtn wrongBtn" data-wrong-cover="${id}">Wrong cover?</button>` : '';
  const extra = placeBtn || wrongBtn ? `<div class="cardExtra">${placeBtn}${wrongBtn}</div>` : '';
  return `<article class="${cls}" data-id="${id}" data-needs-poster="${needsPoster?'true':'false'}" style="--hue:${hue}">${selBox}
    <div class="cover">${img}<div class="coverTitle">${escapeHtml(shortCoverTitle(m.title))}</div><div class="formatBadge">${escapeHtml(m.format)}</div></div>
    <div class="body"><h3 class="title">${escapeHtml(m.title)}</h3><div class="meta"><span class="chip">${escapeHtml(m.section)}</span>${seenChip}${removedChip}${dupe}${barcode}</div>${m.notes?`<div class="notes">${escapeHtml(m.notes)}</div>`:''}<div class="cardActions"><button class="miniBtn" data-toggle-seen="${id}">${seenBtn}</button><button class="miniBtn" data-edit="${id}">Edit</button>${posterBtn}</div>${extra}</div>
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
  if(movie.poster) movie.posterSource='manual';
  state.movies.unshift(movie);
  save();
  ['newTitle','customSection','newBarcode','newPoster','newNotes'].forEach(id=>els[id].value=''); els.newSeen.checked=false; els.newSection.value=UNSORTED_SECTION;
  updateTitleDupes(); populateSelects(); render(); toast(`Added ${title}`);
}
// Inline note under the Add title field: titles you already own that equal the typed one or start with it (barcode duplicates are scanner.js's job).
function updateTitleDupes(){
  const note=els.titleDupeNote; if(!note) return;
  const k=titleKey(els.newTitle.value);
  const hits = k.length>=3 ? state.movies.filter(m=>titleKey(m.title).startsWith(k)).sort((a,b)=>(titleKey(b.title)===k)-(titleKey(a.title)===k)) : [];
  note.hidden = !hits.length;
  note.textContent = hits.length ? 'You already have: '+hits.slice(0,3).map(m=>`${m.title} (${m.section})`).join(', ')+(hits.length>3 ? ` and ${hits.length-3} more` : '') : '';
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
  const posterHint = posterRemoved ? 'Poster removed. Auto cover loading is disabled until you choose a new poster.' : `Click “${poster?'Change':'Find'} poster” to search again, or paste a cover URL manually.`;
  els.editPosterLookupBtn.textContent = poster ? 'Change poster' : 'Find poster';
  els.editPreview.innerHTML = `${cover}<div class="modalPreviewInfo"><strong style="color:var(--text)">${escapeHtml(title)}</strong><br>${escapeHtml(section || 'No section')} · ${escapeHtml(format || 'No format')} · ${escapeHtml(seen)}${barcode?`<br>Barcode: ${escapeHtml(barcode)}`:''}<br><span>${escapeHtml(posterHint)}</span></div>`;
}
function closeModal(){els.editModal.classList.remove('active'); editingId=null;}
function saveEdit(){
  const m=state.movies.find(x=>x.id===editingId); if(!m) return;
  const title=els.editMovieTitle.value.trim(); if(!title){toast('Movie needs a title.'); return;}
  const oldPoster = m.poster || '';
  const nextPoster = els.editPoster.value.trim();
  m.title=title; m.section=getSectionFromForm('edit'); m.format=els.editFormat.value; m.barcode=els.editBarcode.value.trim(); m.seen=!!els.editSeen.checked; m.poster=nextPoster; m.posterRemoved=nextPoster ? false : !!(oldPoster || m.posterRemoved); m.notes=els.editNotes.value.trim(); m.updated=today();
  if(!nextPoster) delete m.posterSource; else if(nextPoster!==oldPoster) m.posterSource='manual';   // picked or pasted by the user (a kept auto cover stays 'auto')
  save(); populateSelects(); render(); closeModal(); toast('Saved changes.');
}
function deleteEditingMovie(){
  const idx=state.movies.findIndex(x=>x.id===editingId); if(idx<0) return;
  const m=state.movies[idx];
  if(!confirm(`Delete “${m.title}”?`)) return;
  const prevId=idx>0 ? state.movies[idx-1].id : '';
  state.movies.splice(idx,1); selected.delete(m.id);
  save(); render(); closeModal();
  toast('Movie deleted.', 8000, {warn:false, action:{label:'Undo', fn:()=>undoDelete(m, idx, prevId)}});
}
// Puts a deleted movie back where it was: right after the title that used to precede it, else at its old index.
function undoDelete(m, idx, prevId){
  if(state.movies.some(x=>x.id===m.id)) return;
  const p = prevId ? state.movies.findIndex(x=>x.id===prevId) : -1;
  state.movies.splice(p>=0 ? p+1 : Math.min(idx, state.movies.length), 0, m);
  if(!state.sectionOrder.includes(m.section)) state.sectionOrder.push(m.section);
  const ok=save(); populateSelects(); render();
  if(ok) toast(`Restored “${m.title}”.`);
}

function toggleSeen(id){
  const m=state.movies.find(x=>x.id===id); if(!m) return;
  m.seen = m.seen===false ? true : false;
  m.updated=today();
  save(); render();
  toast(m.seen ? 'Marked as seen.' : 'Marked as not seen.');
}
/* ---------- Select mode + moving titles to a shelf ---------- */
function setSelectMode(on){
  selectMode=!!on;
  if(!selectMode) selected.clear();
  els.selectToggle.setAttribute('aria-pressed', selectMode?'true':'false');
  els.selectToggle.classList.toggle('toggled', selectMode);
  document.body.classList.toggle('selecting', selectMode);
  render();
}
function syncSelectionUi(){
  els.movieGrid.querySelectorAll('.card').forEach(card=>{
    const on=selected.has(card.dataset.id), box=card.querySelector('.selBox');
    card.classList.toggle('selected',on); if(box) box.checked=on;
  });
  updateSelectBar();
}
function toggleSelect(id){
  if(selected.has(id)) selected.delete(id); else selected.add(id);
  const card=cardById(id), on=selected.has(id), box=card && card.querySelector('.selBox');
  if(card) card.classList.toggle('selected',on);
  if(box) box.checked=on;
  updateSelectBar();
}
function toggleSelectAll(){   // selects the whole filtered list, also the cards that are not rendered yet
  if(selected.size===viewList.length) selected.clear(); else viewList.forEach(m=>selected.add(m.id));
  syncSelectionUi();
}
function updateSelectBar(){
  const n=selected.size, all=n>0 && n===viewList.length;
  els.selectBar.hidden = !(selectMode && activeScreen==='library');
  els.selectCount.textContent = `${n.toLocaleString()} selected`;
  els.selectAllBtn.textContent = all ? 'Select none' : `Select all ${viewList.length.toLocaleString()}`;
  els.selectAllBtn.disabled = !viewList.length;
  [els.selectMoveBtn, els.selectSeenBtn, els.selectUnseenBtn].forEach(b=>b.disabled=!n);
}
function bulkSeen(seen){
  const ids=[...selected]; if(!ids.length) return;
  let n=0; const t=today();
  state.movies.forEach(m=>{if(selected.has(m.id) && (m.seen!==false)!==seen){m.seen=seen; m.updated=t; n++;}});
  const ok = n ? save() : true;
  render();
  if(ok) toast(`Marked ${ids.length} title${ids.length===1?'':'s'} as ${seen?'seen':'not seen'}.`);
}
function openShelfPicker(ids){
  const movies=ids.map(id=>state.movies.find(x=>x.id===id)).filter(Boolean); if(!movies.length) return;
  shelfIds=movies.map(m=>m.id);
  const one=movies.length===1, counts=sectionCounts(), opt=(v,t)=>`<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
  els.shelfTitle.textContent = one ? 'Place on shelf' : 'Move to shelf';
  els.shelfWhat.textContent = one ? `${movies[0].title} · now in ${movies[0].section}` : `${movies.length.toLocaleString()} selected titles`;
  const secs=[...new Set(state.sectionOrder)].filter(s=>s!==UNSORTED_SECTION);
  if(movies.some(m=>m.section!==UNSORTED_SECTION)) secs.push(UNSORTED_SECTION);   // only offered when something could go back there
  els.shelfSelect.innerHTML = '<option value="" disabled>Choose a shelf…</option>' + opt('__new__','New shelf…') + secs.map(s=>opt(s, `${s} (${counts[s]||0})`)).join('');
  els.shelfSelect.value = secs.includes(lastShelf) ? lastShelf : '';
  els.shelfNewInput.value='';
  onShelfChoice();
  els.shelfModal.classList.add('active');
  setTimeout(()=>els.shelfSelect.focus(),50);
}
function closeShelfPicker(){els.shelfModal.classList.remove('active'); shelfIds=[];}
function onShelfChoice(){
  const isNew=els.shelfSelect.value==='__new__';
  els.shelfNewField.hidden=!isNew;
  if(isNew && els.shelfModal.classList.contains('active')) els.shelfNewInput.focus();
  updateShelfOk();
}
function shelfChoice(){
  const v=els.shelfSelect.value;
  if(v!=='__new__') return v;
  const name=els.shelfNewInput.value.trim().toUpperCase();
  return state.sectionOrder.find(s=>s.toUpperCase()===name) || name;   // typing an existing shelf in other letter case reuses it
}
function updateShelfOk(){
  const n=shelfIds.length;
  els.shelfOkBtn.disabled=!shelfChoice();
  els.shelfOkBtn.textContent = n>1 ? `Move ${n.toLocaleString()} titles` : 'Move';
}
function confirmShelf(){
  const section=shelfChoice();
  if(!section || !els.shelfModal.classList.contains('active')) return;
  const ids=shelfIds; closeShelfPicker();
  moveToShelf(ids, section);
}
function moveToShelf(ids, section){
  const idSet=new Set(ids), t=today(), before=[];
  const newShelf=!state.sectionOrder.includes(section);
  if(newShelf) state.sectionOrder.push(section);
  state.movies.forEach(m=>{if(idSet.has(m.id) && m.section!==section){before.push([m.id, m.section, m.updated]); m.section=section; m.updated=t;}});
  lastShelf=section;
  ids.forEach(id=>selected.delete(id));
  const ok=save();
  if(newShelf) populateSelects();
  render();
  if(!ok) return;   // save() already showed its warning
  if(!before.length){toast(`Already on ${section}.`); return;}
  const title=state.movies.find(m=>m.id===before[0][0]).title;
  toast(before.length===1 ? `Placed “${title}” on ${section}.` : `Moved ${before.length} titles to ${section}.`, 8000, {warn:false, action:{label:'Undo', fn:()=>undoMove(before, section)}});
}
function undoMove(before, section){   // only titles still on that shelf are put back
  const prev=new Map(before.map(b=>[b[0],b])); let n=0;
  state.movies.forEach(m=>{const b=prev.get(m.id); if(b && m.section===section){m.section=b[1]; m.updated=b[2]; n++;}});
  const ok=save(); render();
  if(ok) toast(`Moved ${n} title${n===1?'':'s'} back.`);
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

init();
