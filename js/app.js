const STORAGE_KEY = 'movieVault.privateCollection.v1';
const UNSORTED_SECTION = 'UNSORTED / NOT PLACED';
// True for shelves whose titles are still waiting for a permanent place: UNSORTED / NOT PLACED plus the shelves listed in state.toSortShelves (managed in the Shelves dialog).
// Card markup, counters, the "To sort" filter and the Place-on-shelf picker all ask this.
function isToBeSorted(section){return section===UNSORTED_SECTION || state.toSortShelves.includes(section);}
const TOSORT_FILTER = '__tosort__';   // pseudo value of the Section filter: every shelf that is still waiting to be sorted
const LAST_FORMAT_KEY = 'movieVault.lastFormat';
const formats = ['All formats', ...KNOWN_FORMATS];   // KNOWN_FORMATS (storage.js) is the one list of formats; fillFormatSelects() builds the Add / Movie details pickers from it
const els = {};
let state = loadState();
let activeScreen = 'library';
let compact = localStorage.getItem('movieVault.viewMode') === 'list';
let duplicatesOnly = false;
let editingId = null;
const FIRST_BATCH = 80, NEXT_BATCH = 100;        // cards rendered up front / per scroll step
let viewList = [], viewDupes = {}, viewShown = 0; // current filtered list, its duplicate map, how many cards are in the DOM
let viewGrouped = false, viewGroupN = new Map();    // "By shelf" sort: shelf headings are emitted between the cards; viewGroupN = titles per shelf in the current list
let gridObserver = null, searchTimer = 0, sectionFilterSig = '';
let selectMode = false, shelfIds = [], lastShelf = '';
const selected = new Set();

function $(id){return document.getElementById(id)}
function init(){
  ['totalCount','totalLabel','totalStat','duplicatesStat','duplicateCount','duplicateMicro','smartFilterStat','smartFilterLabel','smartFilterMicro','fourKCount','collectionValue','collectionValueStat','searchInput','sectionFilter','formatFilter','seenFilter','sortSelect','unsortedBtn','viewToggle','movieGrid','resultText','newTitle','newSection','customSection','newFormat','newBarcode','newSeen','newPoster','newNotes','addMovieBtn','posterLookupBtn','barcodeLookupBtn','scanner','scanVideo','scannerText','scanToggleBtn','scanStatus','backupMenuBtn','backupMenu','exportJsonBtn','importBtn','importFile','blueprintPreview','downloadBlueprintBtn','downloadBlueprintTextBtn','printBlueprintBtn','editModal','editPreview','closeModalBtn','editMovieTitle','editSection','editCustomSection','editFormat','editBarcode','editSeen','editPoster','editNotes','deleteMovieBtn','removePosterBtn','editPosterLookupBtn','saveEditBtn','valueModal','valueCloseBtn','valueCurrentText','valueMode','valueAmount','valueNote','valuePreviewText','valueWarning','valueConfirmLine','valueConfirm','rollbackValueBtn','applyValueBtn','valueHistoryList','toast','posterPickerModal','pickerTitle','pickerSubtitle','pickerSearchInput','pickerSearchBtn','pickerStatus','pickerGrid','pickerUrlInput','pickerUrlBtn','pickerCloseBtn','gridSentinel','clearFiltersBtn','selectToggle','selectBar','selectCount','selectAllBtn','selectMoveBtn','selectSeenBtn','selectUnseenBtn','selectCancelBtn','titleDupeNote','shelfModal','shelfTitle','shelfWhat','shelfSelect','shelfNewField','shelfNewInput','shelfOkBtn','shelfCancelBtn'].forEach(id=>els[id]=$(id));
  initCovers();
  document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>showScreen(btn.dataset.screen)));
  els.searchInput.addEventListener('input',()=>{clearTimeout(searchTimer); searchTimer=setTimeout(renderFresh,150);});   // debounced: no full re-render per keystroke
  els.searchInput.addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(searchTimer); renderFresh();}});
  ['sectionFilter','formatFilter','seenFilter','sortSelect'].forEach(id=>els[id].addEventListener('input', renderFresh));
  els.movieGrid.addEventListener('click', onGridClick);   // one delegated handler for every card button (covers.js buttons carry the same data-* attributes)
  els.clearFiltersBtn.addEventListener('click', clearFilters);
  $('filtersToggle').addEventListener('click',()=>setFiltersOpen(!$('controls').classList.contains('filtersOpen')));
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
  els.unsortedBtn.addEventListener('click',()=>{setSectionFilter(TOSORT_FILTER); renderFresh(); showScreen('library');});
  els.collectionValueStat.addEventListener('click',openValueModal);   // one click or tap opens it; a double-click does too
  els.collectionValueStat.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault(); openValueModal();}});
  els.valueCloseBtn.addEventListener('click',closeValueModal);
  els.valueModal.addEventListener('click',e=>{if(e.target===els.valueModal && Date.now()-valueOpenedAt>600) closeValueModal();});   // (the 2nd click of a double-click lands on the backdrop)
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
  window.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal(); closePosterPicker(); closeValueModal(); closeShelfPicker(); if(els.backupMenu.classList.contains('open')){closeBackupMenu(); els.backupMenuBtn.focus();}}});
  initShelves(); restoreLastFormat();
  initBackupUi();
  populateSelects();
  if(!initRemoteScan()) showCollectionView();   // a phone paired through a QR code shows only the remote scanner: no collection render, no cover lookups
}
function showCollectionView(){
  if (window.matchMedia('(max-width: 720px)').matches) showScreen('add');
  renderFresh();
  updateBlueprintPreview();
  offerOldCoverCheck();
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
  if(screen==='add'){updateTitleDupes(); onAddScreenShown();}   // (remote-scan.js: the computer starts its phone-pairing session here)
  if(typeof rsRender==='function') rsRender();   // the phone-scanner pill is hidden on Add / scan and shown elsewhere
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
function allShelves(){return [...new Set([...state.sectionOrder, UNSORTED_SECTION])];}   // every shelf in sectionOrder (the Shelves dialog sets that order)
function populateSelects(){
  const sections = allShelves(), keepNew = els.newSection.value;
  updateSectionFilter();
  const addOptions = sections.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  els.newSection.innerHTML = addOptions;
  els.newSection.value = sections.includes(keepNew) ? keepNew : UNSORTED_SECTION;   // the shelf picked in the Add form survives a refresh of the lists
  els.editSection.innerHTML = addOptions;
  els.formatFilter.innerHTML = formats.map(f=>`<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  updateBlueprintShelves();
}
function getDuplicateMap(){const c={}; state.movies.forEach(m=>{const k=titleKey(m.title); if(k)c[k]=(c[k]||0)+1}); return c;}
function sectionCounts(){const c={}; state.movies.forEach(m=>{c[m.section]=(c[m.section]||0)+1}); return c;}
// How many titles are on shelves that are still waiting to be sorted.
function toSortCount(counts=sectionCounts()){return [...new Set([UNSORTED_SECTION, ...state.toSortShelves])].reduce((n,s)=>n+(counts[s]||0),0);}
// Section filter: "All sections", "To sort (n)" (every to-sort shelf together), then only the shelves that hold titles (with counts) in sectionOrder order. The selected entry always stays listed.
function updateSectionFilter(){
  const counts=sectionCounts(), cur=els.sectionFilter.value || 'all';
  const secs=allShelves().filter(s=>counts[s] || s===cur);
  const nSort=toSortCount(counts), showSort=nSort>0 || cur===TOSORT_FILTER;
  const sig=(showSort ? nSort : '-')+'\n'+secs.map(s=>s+'\t'+(counts[s]||0)).join('\n');
  if(sig===sectionFilterSig) return;   // nothing to rebuild: same shelves, same counts
  sectionFilterSig=sig;
  els.sectionFilter.innerHTML=['<option value="all">All sections</option>', ...(showSort ? [`<option value="${TOSORT_FILTER}">To sort (${nSort})</option>`] : []), ...secs.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)} (${counts[s]||0})</option>`)].join('');
  els.sectionFilter.value=cur;
  if(els.sectionFilter.value!==cur) els.sectionFilter.value='all';   // that shelf is gone (renamed, merged or deleted elsewhere)
}
function setSectionFilter(sec){
  if(sec!=='all' && ![...els.sectionFilter.options].some(o=>o.value===sec)) els.sectionFilter.add(new Option(sec,sec));   // rebuilt with its count by the next render
  els.sectionFilter.value=sec;
}
// Section clause of getFiltered: a shelf name, 'all', or TOSORT_FILTER (every shelf that is waiting to be sorted).
function sectionMatcher(sec){
  if(sec==='all') return ()=>true;
  if(sec===TOSORT_FILTER){const set=new Set([UNSORTED_SECTION, ...state.toSortShelves]); return m=>set.has(m.section);}
  return m=>m.section===sec;
}
/* ---------- Search: forgiving matching ----------
   "daddys home" finds DADDY’S HOME, "godfather 2" finds ... PART II, "spiderman" finds SPIDER-MAN. */
const ROMAN_DIGIT={ii:'2',iii:'3',iv:'4',v:'5',vi:'6',vii:'7',viii:'8',ix:'9',x:'10'};
// Lowercase, accents stripped, apostrophes and quotes dropped, & read as "and", all other punctuation a space.
function searchBase(text){
  return String(text==null?'':text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\u00f8/g,'o').replace(/\u00e6/g,'ae')
    .replace(/['`\u00b4"\u2018\u2019\u201c\u201d\u02bc\u2032]/g,'').replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
// searchBase plus: roman numerals II-X as digits, the words "part"/"pt" dropped.
function normalizeForSearch(text){
  return searchBase(text).split(' ').map(w=>ROMAN_DIGIT[w]||w).filter(w=>w && w!=='part' && w!=='pt').join(' ');
}
function parseSearchQuery(text){   // null when nothing searchable is typed
  const t=normalizeForSearch(text) || searchBase(text); if(!t) return null;   // (a lone "part" is searched as typed, not dropped)
  return {text:t, words:t.split(' '), sq:searchBase(text).replace(/ /g,''), sqn:t.replace(/ /g,'')};
}
const searchCache=new Map();   // movie id -> prepared fields, rebuilt when the movie's text changed
const searchEntryProto={
  // Every query word is in the blob (title, shelf, format, barcode, notes; 1-2 digit numbers as whole words, so "2" is not "12" or "26246"),
  // or the squashed query sits inside the squashed title ("spiderman" in SPIDER-MAN, "xmen" in X-MEN).
  includes(q){
    return q.words.every(w=>/^\d{1,2}$/.test(w) ? this.blobWords.has(w) : this.blob.includes(w)) || this.sq.includes(q.sq) || this.sqn.includes(q.sqn);
  }
};
function searchEntry(m){
  const raw=[m.title,m.section,m.format,m.barcode,m.notes].join('\u0001');
  let e=searchCache.get(m.id);
  if(!e || e.raw!==raw){
    const title=normalizeForSearch(m.title), blob=normalizeForSearch(raw);
    e=Object.assign(Object.create(searchEntryProto),{raw, blob, blobWords:new Set(blob.split(' ')), title, words:new Set(title.split(' ')), sq:searchBase(m.title).replace(/ /g,''), sqn:title.replace(/ /g,'')});
    searchCache.set(m.id,e);
  }
  return e;
}
// Title A-Z with a search: exact title, then titles starting with it, then titles holding every word as a whole word, then the rest. `list` is already A-Z, so each group keeps that order.
function rankByTitleMatch(list,q){
  const groups=[[],[],[],[]];
  list.forEach(m=>{
    const e=searchEntry(m);
    const g = e.title===q.text || e.sq===q.sq || e.sqn===q.sqn ? 0
      : e.title.startsWith(q.text) || e.sq.startsWith(q.sq) || e.sqn.startsWith(q.sqn) ? 1
      : q.words.every(w=>e.words.has(w)) ? 2 : 3;
    groups[g].push(m);
  });
  return groups.flat();
}
function getFiltered(dupes=getDuplicateMap()){
  const q=parseSearchQuery(els.searchInput.value);   // null when empty; matching and ranking live in the search functions above
  const secOk=sectionMatcher(els.sectionFilter.value);
  const fmt=els.formatFilter.value;
  const seen=els.seenFilter.value;
  let list=state.movies.filter(m=>{
    const searchBlob=q ? searchEntry(m) : null;   // .includes(q) below = forgiving match, see searchEntryProto
    const dupeCount=dupes[titleKey(m.title)]||0;
    const duplicateOk = !duplicatesOnly || dupeCount>1;
    const seenOk = seen==='all' || (seen==='seen' && m.seen!==false) || (seen==='unseen' && m.seen===false);
    return (!q || searchBlob.includes(q)) && secOk(m) && (fmt==='All formats'||m.format===fmt) && duplicateOk && seenOk;
  });
  const allowedSorts = new Set(['title-asc','title-desc','added-desc','dupes-first','unseen-first','auto-first','shelf']);
  const sort = allowedSorts.has(els.sortSelect.value) ? els.sortSelect.value : 'title-asc';
  if (els.sortSelect.value !== sort) els.sortSelect.value = sort;
  const shelfRank = sort==='shelf' ? new Map(allShelves().map((s,i)=>[s,i])) : null;   // "By shelf": sectionOrder, then A–Z inside a shelf
  list.sort((a,b)=>{
    if(shelfRank) return ((shelfRank.get(a.section)??1e9)-(shelfRank.get(b.section)??1e9)) || a.section.localeCompare(b.section) || a.title.localeCompare(b.title);
    if(sort==='title-asc') return a.title.localeCompare(b.title);
    if(sort==='title-desc') return b.title.localeCompare(a.title);
    if(sort==='added-desc') return (b.added||'').localeCompare(a.added||'') || b.id.localeCompare(a.id);
    if(sort==='unseen-first') return ((a.seen===false?0:1)-(b.seen===false?0:1)) || a.title.localeCompare(b.title);
    if(sort==='auto-first') return (coverReviewRank(a)-coverReviewRank(b)) || a.title.localeCompare(b.title);   // "Covers to review first": check, auto, old version, the rest (value kept from "Auto covers first")
    if(sort==='dupes-first') return ((dupes[titleKey(b.title)]||0)-(dupes[titleKey(a.title)]||0)) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
  if(q && sort==='title-asc') list=rankByTitleMatch(list,q);
  return list;
}
// Cards are added in batches: FIRST_BATCH now, NEXT_BATCH each time #gridSentinel nears the viewport.
// render({reset:true}) starts again from the first batch (filters, search, sort, view changed); a plain render() after an edit keeps as many cards showing as before.
function renderFresh(){render({reset:true});}
function render(opts){
  const keep = opts && opts.reset ? 0 : viewShown;
  updateChrome();
  updateSectionFilter();
  const dupes=getDuplicateMap(), list=getFiltered(dupes);
  viewList=list; viewDupes=dupes; viewShown=0;
  viewGrouped = els.sortSelect.value==='shelf'; viewGroupN = new Map();
  if(viewGrouped) list.forEach(m=>viewGroupN.set(m.section,(viewGroupN.get(m.section)||0)+1));
  if(selected.size){const ids=new Set(list.map(m=>m.id)); [...selected].forEach(id=>{if(!ids.has(id)) selected.delete(id);});}
  populateStats(list, dupes);
  els.movieGrid.classList.toggle('compact',compact);
  els.movieGrid.classList.toggle('selecting',selectMode);
  els.resultText.textContent = `Showing ${list.length.toLocaleString()} of ${state.movies.length.toLocaleString()} titles`;
  els.clearFiltersBtn.hidden = !isFilterActive();
  updateSelectBar();
  if(!list.length){
    const placed = els.sectionFilter.value===TOSORT_FILTER && !state.movies.some(m=>isToBeSorted(m.section));
    els.movieGrid.innerHTML=`<div class="empty">${placed?'Nothing is waiting to be sorted: every title is on a shelf.':'No movies match this filter.'}${isFilterActive()?'<div><button class="ghost" data-clear-filters>Clear filters</button></div>':''}</div>`;
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
    for(let i=viewShown;i<end;i++){
      const m=viewList[i];
      if(viewGrouped && (i===0 || viewList[i-1].section!==m.section)) html+=shelfHeadHtml(m.section);   // a batch may start in the middle of a shelf: then no new heading
      html+=cardHtml(m, viewDupes[titleKey(m.title)]||0);
    }
    els.movieGrid.insertAdjacentHTML('beforeend', html);
    viewShown=end;
  }
  watchGridEnd();
  setupVisibleCoverAutoload();   // re-callable: observes every .card[data-needs-poster="true"], including the new ones
}
function shelfHeadHtml(sec){return `<h2 class="shelfHead">${escapeHtml(sec)}<span class="shelfHeadN"> · ${(viewGroupN.get(sec)||0).toLocaleString()}</span></h2>`;}
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
  if(d.toggleSeen) toggleSeen(d.toggleSeen);
  else if(d.wrongCover) wrongCover(d.wrongCover);
  else if(d.keepCover) keepCover(d.keepCover);
  else if(d.place) openShelfPicker([d.place]);
}

// Phone: the filter selects sit behind a "Filters" button (CSS shows the button and hides the panel only on narrow screens).
function setFiltersOpen(open){
  $('controls').classList.toggle('filtersOpen', open);
  $('filtersToggle').setAttribute('aria-expanded', open?'true':'false');
}
// Header line ("Harry A. Davis · 2,330 titles on 31 shelves") and the active-filter count on the Filters button; runs on every render.
function updateChrome(){
  const n=state.movies.length, shelves=new Set(state.movies.filter(m=>!isToBeSorted(m.section)).map(m=>m.section)).size;
  $('subtitle').textContent = `Harry A. Davis · ${n.toLocaleString()} title${n===1?'':'s'}`+(shelves ? ` on ${shelves.toLocaleString()} ${shelves===1?'shelf':'shelves'}` : '');
  const active=(els.sectionFilter.value!=='all')+(els.formatFilter.value!=='All formats')+(els.seenFilter.value!=='all'), badge=$('filtersBadge');
  badge.hidden=!active; badge.textContent=active;
  $('filtersToggle').setAttribute('aria-label', active ? `Filters, ${active} active` : 'Filters');
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
  const mode = toSortCount() > 0 ? 'unsorted' : 'unseen';
  if(mode==='unsorted'){
    const alreadyActive = els.sectionFilter.value===TOSORT_FILTER;
    setSectionFilter(alreadyActive ? 'all' : TOSORT_FILTER);
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

  const unsortedCount = toSortCount();   // every title on a shelf that is still waiting to be sorted
  const unseenCount = state.movies.filter(m=>m.seen===false).length;
  const smartMode = unsortedCount > 0 ? 'unsorted' : 'unseen';
  const smartCount = smartMode==='unsorted' ? unsortedCount : unseenCount;
  const smartActive = smartMode==='unsorted'
    ? els.sectionFilter.value===TOSORT_FILTER
    : els.seenFilter.value==='unseen' && els.sectionFilter.value==='all';
  const smartWhat = smartMode==='unsorted' ? 'titles to sort' : 'unseen';
  els.smartFilterLabel.textContent = smartMode==='unsorted' ? 'To sort' : 'Unseen';
  els.fourKCount.textContent = smartCount.toLocaleString();
  els.smartFilterMicro.textContent = smartActive ? `Showing ${smartWhat} · click to clear` : `Click to filter ${smartWhat}`;
  els.smartFilterStat.classList.toggle('toggled', smartActive);
  els.smartFilterStat.setAttribute('aria-pressed', smartActive ? 'true' : 'false');
  els.smartFilterStat.title = smartMode==='unsorted' ? 'Click to show the titles that are waiting to be sorted onto a shelf' : 'Click to show unseen titles';
  els.collectionValue.textContent=formatMoney(state.collectionValue || 0);
}
function cardHtml(m, dupeCount){
  const hue=hueFor(m.title), id=escapeHtml(m.id);
  const dupe = dupeCount>1 ? `<span class="chip">${dupeCount} editions</span>` : '';
  const barcode = m.barcode ? `<span class="chip">${escapeHtml(m.barcode)}</span>` : '';
  const seenChip = m.seen===false ? '<span class="chip unseenPill">Not seen</span>' : '<span class="chip seenPill">Seen</span>';
  const removedChip = (!m.poster && m.posterRemoved===true) ? '<span class="chip posterRemovedPill">Poster removed</span>' : '';
  const checkChip = coverChipHtml(m);
  const needsPoster = !m.poster && m.posterRemoved!==true;
  const isSel = selectMode && selected.has(m.id);
  const selBox = selectMode ? `<input type="checkbox" class="selBox" tabindex="-1" aria-label="Select ${escapeHtml(m.title)}"${isSel?' checked':''}>` : '';
  const cls = isSel ? 'card selected' : 'card';
  const placeBtn = isToBeSorted(m.section) ? `<button class="miniBtn placeBtn" data-place="${id}">Place on shelf</button>` : '';
  if(compact){
    return `<article class="${cls}" data-id="${id}" data-needs-poster="${needsPoster?'true':'false'}" style="--hue:${hue}">${selBox}
      <div class="body"><h3 class="title">${escapeHtml(m.title)}</h3><span class="rowWhere">${els.sortSelect.value==='shelf' ? '' : `<span class="rowShelf">${escapeHtml(m.section)}</span> `}<span class="rowFmt">${escapeHtml(m.format)}</span></span><div class="meta"><span class="chip">${escapeHtml(m.section)}</span>${checkChip}${seenChip}${removedChip}${dupe}${barcode}</div><div class="formatBadge">${escapeHtml(m.format)}</div>${placeBtn}</div>
    </article>`;
  }
  const img = m.poster ? `<img src="${escapeHtml(m.poster)}" alt="Cover for ${escapeHtml(m.title)}" loading="lazy" onerror="this.remove()">` : '';
  const seen = m.seen!==false, sv = seenToggleAttrs(seen);   // the whole card opens the details dialog (Edit, Find / Remove poster live there); only the seen toggle, Place on shelf and Keep / Wrong cover? stay on the card
  const coverBtns = coverButtonsHtml(m);   // Keep / Wrong cover? only on covers flagged by "Check old covers", see covers.js
  const extra = placeBtn || coverBtns ? `<div class="cardExtra">${placeBtn}${coverBtns}</div>` : '';
  return `<article class="${cls}" data-id="${id}" data-needs-poster="${needsPoster?'true':'false'}" style="--hue:${hue}">${selBox}
    <div class="cover">${img}<div class="coverTitle">${escapeHtml(shortCoverTitle(m.title))}</div><div class="formatBadge">${escapeHtml(m.format)}</div></div>
    <div class="body"><h3 class="title">${escapeHtml(m.title)}</h3><div class="meta"><span class="chip">${escapeHtml(m.section)}</span>${checkChip}${removedChip}${dupe}${barcode}</div>${m.notes?`<div class="notes">${escapeHtml(m.notes)}</div>`:''}<div class="cardActions"><button type="button" class="${sv.cls}" data-toggle-seen="${id}" aria-pressed="${seen}" title="${sv.title}">${sv.text}</button></div>${extra}</div>
  </article>`;
}
// Look of the seen toggle on a card; toggleSeen() repaints an existing button from the same values.
function seenToggleAttrs(seen){
  return seen ? {cls:'seenToggle seenPill', text:'Seen ✓', title:'Seen. Tap to mark as not seen.'} : {cls:'seenToggle unseenPill', text:'Not seen', title:'Not seen yet. Tap to mark as seen.'};
}
function shortCoverTitle(t){return t.length>52 ? t.slice(0,49)+'…' : t}

function getSectionFromForm(prefix){
  const custom = (prefix==='new'?els.customSection:els.editCustomSection).value.trim();
  const select = prefix==='new'?els.newSection:els.editSection;
  const section = (custom || select.value || 'UNSORTED').trim().toUpperCase();
  if(!state.sectionOrder.includes(section)) state.sectionOrder.push(section);
  return section;
}
// Puts a new title at the top of the collection (not saved yet: callers save() once). f = {title,section,format,barcode,poster,notes,seen}; used by the Add form and by the phone-scanner queue (remote-scan.js).
// Titles of new purchases are stored in UPPERCASE like the rest of the collection and the blueprint (Edit keeps whatever is typed).
function newMovie(f){
  const movie={id:cryptoId(), title:String(f.title||'').toUpperCase(), section:f.section, format:f.format, barcode:f.barcode||'', poster:f.poster||'', posterRemoved:false, notes:f.notes||'', seen:!!f.seen, added:today(), updated:today()};
  if(movie.poster) movie.posterSource='manual';
  if(!state.sectionOrder.includes(movie.section)) state.sectionOrder.push(movie.section);
  state.movies.unshift(movie);
  return movie;
}
function addMovie(){
  const title=els.newTitle.value.trim();
  if(!title){toast('Add a title first.'); els.newTitle.focus(); return;}
  const movie=newMovie({title, section:getSectionFromForm('new'), format:els.newFormat.value, barcode:els.newBarcode.value.trim(), poster:els.newPoster.value.trim(), notes:els.newNotes.value.trim(), seen:els.newSeen.checked});
  vaultSet(LAST_FORMAT_KEY, movie.format);   // the Add form starts on the format used last
  save();
  ['newTitle','customSection','newBarcode','newPoster','newNotes'].forEach(id=>els[id].value=''); els.newSeen.checked=false; els.newSection.value=UNSORTED_SECTION; syncLookupBtn();
  updateTitleDupes(); populateSelects(); render(); renderQueue(); toast(`Added ${movie.title}`);   // (the phone-scanner queue re-checks "already own")
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
  $('editAdvanced').open=false;
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
  const posterHint = posterRemoved ? 'Poster removed. Auto cover loading is disabled until you choose a new poster.' : `Click “${poster?'Change':'Find'} poster” to search again, or paste a cover URL under Advanced.`;
  els.editPosterLookupBtn.textContent = poster ? 'Change poster' : 'Find poster';
  els.removePosterBtn.hidden = !poster;   // nothing to remove without a poster
  const added = formatAdded(currentMovie?.added);
  els.editPreview.innerHTML = `${cover}<div class="modalPreviewInfo"><strong style="color:var(--text)">${escapeHtml(title)}</strong><br>${escapeHtml(section || 'No section')} · ${escapeHtml(format || 'No format')} · ${escapeHtml(seen)}${barcode?`<br>Barcode: ${escapeHtml(barcode)}`:''}${added?`<br>Added ${escapeHtml(added)}`:''}<br><span>${escapeHtml(posterHint)}</span></div>`;
}
function formatAdded(iso){   // "2026-05-14" -> "14 May 2026"
  if(!iso) return '';
  const d=new Date(iso+'T00:00:00');
  return isNaN(d) ? String(iso) : d.toLocaleDateString('en-GB',{day:'numeric', month:'short', year:'numeric'});
}
function closeModal(){els.editModal.classList.remove('active'); editingId=null;}
function saveEdit(){
  const m=state.movies.find(x=>x.id===editingId); if(!m) return;
  const title=els.editMovieTitle.value.trim(); if(!title){toast('Movie needs a title.'); return;}
  const oldPoster = m.poster || '';
  const nextPoster = els.editPoster.value.trim();
  m.title=title; m.section=getSectionFromForm('edit'); m.format=els.editFormat.value; m.barcode=els.editBarcode.value.trim(); m.seen=!!els.editSeen.checked; m.poster=nextPoster; m.posterRemoved=nextPoster ? false : !!(oldPoster || m.posterRemoved); m.notes=els.editNotes.value.trim(); m.updated=today();
  if(!nextPoster) delete m.posterSource; else if(nextPoster!==oldPoster) m.posterSource='manual';   // picked or pasted by the user (a kept auto cover stays 'auto')
  if(nextPoster!==oldPoster) delete m.posterSuggestion;   // a different cover makes the old suggestion moot
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
  save();
  const btn=cardById(id)?.querySelector('[data-toggle-seen]');
  if(btn && els.seenFilter.value==='all' && els.sortSelect.value!=='unseen-first'){   // nothing moves: repaint the one button (no jump, keeps keyboard focus) and the counters
    const sv=seenToggleAttrs(m.seen);
    btn.className=sv.cls; btn.textContent=sv.text; btn.title=sv.title; btn.setAttribute('aria-pressed', String(m.seen));
    populateStats();
  }else render();
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
  // Targets are real shelves: shelves that are still waiting to be sorted are not offered, and neither is the shelf all chosen titles are already on.
  const secs=allShelves().filter(s=>!isToBeSorted(s) && !movies.every(m=>m.section===s));
  if(movies.some(m=>!isToBeSorted(m.section))) secs.push(UNSORTED_SECTION);   // only offered when something could go back to the to-sort pile
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

/* ---------- Shelf manager: rename / merge, reorder, "waiting to be sorted", delete ---------- */
let renamingShelf = -1;   // index in sectionOrder of the shelf whose name is being edited, -1 = none
function initShelves(){
  ['shelvesBtn','shelvesModal','shelvesList','shelvesCloseBtn','blueprintShelf'].forEach(id=>els[id]=$(id));
  els.shelvesBtn.addEventListener('click', openShelves);
  els.shelvesCloseBtn.addEventListener('click', closeShelves);
  els.shelvesModal.addEventListener('click',e=>{if(e.target===els.shelvesModal) closeShelves();});
  els.shelvesList.addEventListener('click', onShelvesClick);
  els.shelvesList.addEventListener('change', onShelvesChange);
  els.shelvesList.addEventListener('keydown', onShelvesKey);
  window.addEventListener('keydown',e=>{if(e.key==='Escape' && els.shelvesModal.classList.contains('active')) closeShelves();});   // (Escape inside the rename box only cancels the rename, see onShelvesKey)
  els.blueprintShelf.addEventListener('change', updateBlueprintPreview);
}
function fillFormatSelects(){const html=KNOWN_FORMATS.map(f=>`<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join(''); els.newFormat.innerHTML=html; els.editFormat.innerHTML=html;}   // the Format pickers of the Add form and Movie details (empty in index.html)
function restoreLastFormat(){fillFormatSelects(); const f=vaultGet(LAST_FORMAT_KEY); if(f && KNOWN_FORMATS.includes(f)) els.newFormat.value=f;}   // runs once from init(): the options must exist before the last format is picked
function openShelves(){
  renamingShelf=-1; renderShelves();
  els.shelvesModal.classList.add('active');
  setTimeout(()=>els.shelvesCloseBtn.focus({preventScroll:true}),30);
}
function closeShelves(){
  if(!els.shelvesModal.classList.contains('active')) return;
  els.shelvesModal.classList.remove('active'); renamingShelf=-1;
  els.shelvesBtn.focus({preventScroll:true});
}
// focus = {i, sh}: the control to focus again after the list is rebuilt (if it is disabled now, the next best button in that row)
function renderShelves(focus){
  const counts=sectionCounts(), order=state.sectionOrder, last=order.length-1;
  els.shelvesList.innerHTML=order.map((s,i)=>{
    const n=counts[s]||0, esc=escapeHtml(s), fixed=s===UNSORTED_SECTION, sorting=isToBeSorted(s);
    const name = renamingShelf===i
      ? `<input class="shelfRenameInput" value="${esc}" aria-label="New name for ${esc}" autocomplete="off" spellcheck="false"><button type="button" class="miniBtn" data-sh="save">Save</button><button type="button" class="miniBtn" data-sh="cancel">Cancel</button>`
      : `<span class="shelfLabel">${esc}</span><span class="shelfCount">${n.toLocaleString()} title${n===1?'':'s'}</span>`;
    return `<div class="shelfRow${sorting?' sorting':''}" role="listitem" data-i="${i}" data-s="${esc}">
      <div class="shelfNameCell">${name}</div>
      <label class="checkLine shelfSortLbl"><input type="checkbox" data-sh="sort"${sorting?' checked':''}${fixed?' disabled title="New purchases land here, so this shelf always counts as waiting to be sorted"':''}> Waiting to be sorted</label>
      <div class="shelfBtns">
        <button type="button" class="miniBtn" data-sh="rename"${fixed?' disabled title="This shelf keeps its name"':''}>Rename</button>
        <button type="button" class="miniBtn" data-sh="up" aria-label="Move ${esc} up"${i===0?' disabled':''}>▲</button>
        <button type="button" class="miniBtn" data-sh="down" aria-label="Move ${esc} down"${i===last?' disabled':''}>▼</button>
        <button type="button" class="miniBtn dangerBtn" data-sh="del" aria-label="Delete ${esc}"${n||fixed?` disabled title="${fixed?'This shelf cannot be deleted':'Only empty shelves can be deleted: move its titles first'}"`:''}>Delete</button>
      </div>
    </div>`;
  }).join('');
  if(renamingShelf>=0){const inp=els.shelvesList.querySelector('.shelfRenameInput'); if(inp){inp.focus(); inp.select();} return;}
  if(focus){
    const row=els.shelvesList.children[focus.i];
    const pick=[focus.sh, focus.sh==='up'?'down':'up', 'rename'].map(sh=>row && row.querySelector(`[data-sh="${sh}"]:not(:disabled)`)).find(Boolean);
    if(pick) pick.focus();
  }
}
// The row a click / key belongs to; null (and a fresh list) if the shelves changed behind the dialog, e.g. in another tab.
function shelfRowOf(el){
  const row=el.closest('.shelfRow'); if(!row) return null;
  const i=+row.dataset.i;
  if(state.sectionOrder[i]!==row.dataset.s){renamingShelf=-1; renderShelves(); return null;}
  return {i, name:row.dataset.s, row};
}
function onShelvesClick(e){
  const b=e.target.closest('button[data-sh]'); if(!b || b.disabled) return;
  const r=shelfRowOf(b); if(!r) return;
  const act=b.dataset.sh;
  if(act==='rename'){renamingShelf=r.i; renderShelves();}
  else if(act==='cancel'){renamingShelf=-1; renderShelves({i:r.i, sh:'rename'});}
  else if(act==='save') renameShelf(r.i, r.row.querySelector('.shelfRenameInput').value);
  else if(act==='up' || act==='down') moveShelf(r.i, act==='up' ? -1 : 1);
  else if(act==='del') deleteShelf(r.i);
}
function onShelvesChange(e){
  const box=e.target.closest('input[data-sh="sort"]'); if(!box) return;
  const r=shelfRowOf(box); if(r) setShelfToSort(r.i, box.checked);
}
function onShelvesKey(e){
  const inp=e.target.closest('.shelfRenameInput'); if(!inp) return;
  const r=shelfRowOf(inp); if(!r) return;
  if(e.key==='Enter'){e.preventDefault(); renameShelf(r.i, inp.value);}
  else if(e.key==='Escape'){e.preventDefault(); e.stopPropagation(); renamingShelf=-1; renderShelves({i:r.i, sh:'rename'});}
}
// Remembers what a rename / merge / delete of shelf `old` changes (`to` = the new name or the shelf merged into), so its Undo toast can put it back.
function shelfSnap(old, to, renamed){return {old, to, renamed, index:state.sectionOrder.indexOf(old), sorted:state.toSortShelves.includes(old), filter:els.sectionFilter.value, moved:[]};}
function shelvesChanged(focus){   // every change: save, refresh the selects, re-render the list of titles and the dialog. false if the save failed (save() already warned)
  const ok=save(); populateSelects(); render(); renderShelves(focus);
  return ok;
}
function undoShelfOp(snap){
  const byId=new Map(snap.moved.map(b=>[b[0],b]));
  state.movies.forEach(m=>{const b=byId.get(m.id); if(b && m.section===snap.to){m.section=b[1]; m.updated=b[2];}});   // only titles still on that shelf go back
  if(snap.renamed && !state.movies.some(m=>m.section===snap.to)){   // the new name is not used by anything now
    state.sectionOrder=state.sectionOrder.filter(x=>x!==snap.to); state.toSortShelves=state.toSortShelves.filter(x=>x!==snap.to);
  }
  if(!state.sectionOrder.includes(snap.old)) state.sectionOrder.splice(Math.min(snap.index, state.sectionOrder.length), 0, snap.old);
  state.toSortShelves=state.toSortShelves.filter(x=>x!==snap.old); if(snap.sorted) state.toSortShelves.push(snap.old);
  if(snap.to && snap.filter===snap.old && els.sectionFilter.value===snap.to) setSectionFilter(snap.old);
  renamingShelf=-1;
  if(shelvesChanged()) toast('Undone.');
}
function renameShelf(i, raw){
  const old=state.sectionOrder[i], name=String(raw||'').trim().toUpperCase();
  if(old===undefined || old===UNSORTED_SECTION) return;
  if(!name){toast('A shelf needs a name.'); return;}
  if(name===old){renamingShelf=-1; renderShelves({i, sh:'rename'}); return;}
  const n=sectionCounts()[old]||0, merge=state.sectionOrder.includes(name);
  if(merge && !confirm(`Merge ${n} title${n===1?'':'s'} into ${name}?\n\n“${old}” will no longer exist as a shelf.`)) return;
  const snap=shelfSnap(old, name, !merge), t=today(), ns=els.newSection.value;
  state.movies.forEach(m=>{if(m.section===old){snap.moved.push([m.id, old, m.updated]); m.section=name; m.updated=t;}});
  if(merge) state.sectionOrder.splice(i,1); else state.sectionOrder[i]=name;   // a merge keeps the position of the shelf that stays
  state.toSortShelves = merge ? state.toSortShelves.filter(x=>x!==old) : state.toSortShelves.map(x=>x===old ? name : x);
  if(els.sectionFilter.value===old) setSectionFilter(name);
  if(lastShelf===old) lastShelf=name;
  renamingShelf=-1;
  const ok=shelvesChanged({i: merge ? Math.min(i, state.sectionOrder.length-1) : i, sh:'rename'});
  if(ns===old) els.newSection.value=name;
  if(ok) toast(merge ? `Merged ${n} title${n===1?'':'s'} into ${name}.` : `Renamed “${old}” to “${name}”.`, 8000, {warn:false, action:{label:'Undo', fn:()=>undoShelfOp(snap)}});
}
function moveShelf(i, d){
  const order=state.sectionOrder, j=i+d; if(j<0 || j>=order.length) return;
  [order[i], order[j]]=[order[j], order[i]];
  shelvesChanged({i:j, sh:d<0 ? 'up' : 'down'});
}
function setShelfToSort(i, on){
  const s=state.sectionOrder[i]; if(s===undefined || s===UNSORTED_SECTION) return;
  state.toSortShelves = on ? [...new Set([...state.toSortShelves, s])] : state.toSortShelves.filter(x=>x!==s);
  shelvesChanged({i, sh:'sort'});
}
function deleteShelf(i){
  const s=state.sectionOrder[i]; if(s===undefined || s===UNSORTED_SECTION) return;
  if(sectionCounts()[s]){toast('Only empty shelves can be deleted. Move its titles to another shelf first.'); return;}
  if(!confirm(`Delete the empty shelf “${s}”?`)) return;
  const snap=shelfSnap(s, null, false);
  state.sectionOrder.splice(i,1); state.toSortShelves=state.toSortShelves.filter(x=>x!==s);
  if(els.sectionFilter.value===s) setSectionFilter('all');
  if(lastShelf===s) lastShelf='';
  const ok=shelvesChanged({i: Math.min(i, state.sectionOrder.length-1), sh:'rename'});
  if(ok) toast(`Deleted shelf “${s}”.`, 8000, {warn:false, action:{label:'Undo', fn:()=>undoShelfOp(snap)}});
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
let valueOpenedAt=0;
function openValueModal(){
  valueOpenedAt=Date.now();
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
