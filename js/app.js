const STORAGE_KEY = 'movieVault.privateCollection.v1';
const UNSORTED_SECTION = 'UNSORTED / NOT PLACED';
const formats = ['All formats','4K UHD','4K Steelbook','Blu-ray','DVD','TV / Series','Blu-ray / DVD','Box set'];
const els = {};
let state = loadState();
let activeScreen = 'library';
let compact = localStorage.getItem('movieVault.viewMode') === 'list';
let duplicatesOnly = false;
let editingId = null;

function $(id){return document.getElementById(id)}
function init(){
  ['totalCount','totalLabel','totalStat','duplicatesStat','duplicateCount','duplicateMicro','smartFilterStat','smartFilterLabel','smartFilterMicro','fourKCount','collectionValue','collectionValueStat','searchInput','sectionFilter','formatFilter','seenFilter','sortSelect','unsortedBtn','viewToggle','movieGrid','resultText','newTitle','newSection','customSection','newFormat','newBarcode','newSeen','newPoster','newNotes','addMovieBtn','posterLookupBtn','barcodeLookupBtn','scanner','scanVideo','scannerText','startScanBtn','stopScanBtn','scanStatus','backupMenuBtn','backupMenu','exportJsonBtn','importBtn','importFile','blueprintPreview','downloadBlueprintBtn','downloadBlueprintTextBtn','printBlueprintBtn','editModal','editPreview','closeModalBtn','editMovieTitle','editSection','editCustomSection','editFormat','editBarcode','editSeen','editPoster','editNotes','deleteMovieBtn','removePosterBtn','editPosterLookupBtn','saveEditBtn','valueModal','valueCloseBtn','valueCurrentText','valueMode','valueAmount','valueNote','valuePreviewText','valueWarning','valueConfirmLine','valueConfirm','rollbackValueBtn','applyValueBtn','valueHistoryList','toast','posterPickerModal','pickerTitle','pickerSubtitle','pickerSearchInput','pickerSearchBtn','pickerStatus','pickerGrid','pickerUrlInput','pickerUrlBtn','pickerCloseBtn'].forEach(id=>els[id]=$(id));
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
  window.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal(); closePosterPicker(); closeValueModal();}});
  populateSelects();
  if (window.matchMedia('(max-width: 720px)').matches) showScreen('add');
  render();
  updateBlueprintPreview();
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

init();
