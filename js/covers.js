/* ---------- Cover / poster lookup: manual picker + automatic lookup for visible cards ----------
   Loadable on its own: nothing below touches els/state/the DOM at load time (initCovers() does that), and
   findAutoCover() needs none of them, so an audit page can include just this file. */
let posterPickerState = null;
let coverObserver = null;
const autoCoverQueue = [];        // cards that scrolled into view (served first)
const autoCoverBulkQueue = [];    // "Load missing covers" (served when nothing visible is waiting)
const autoCoverQueued = new Set();
const autoCoverRunning = new Set();
const autoCoverFailedSession = new Set();
const coverInflight = new Map();  // cacheKey -> pending lookup, so duplicate editions share one request chain
// Every cache key starts with the family prefix; storage.js purges the whole family when localStorage is full.
const COVER_CACHE_FAMILY = 'movieVault.smartCoverCache:';
const COVER_CACHE_PREFIX = COVER_CACHE_FAMILY+'v8:';
const COVER_REJECT_PREFIX = 'movieVault.coverRejects:v1:';   // per-title list of cover URLs the user (or a 404) rejected
const TMDB_KEY_STORAGE = 'movieVault.tmdbApiKey';            // never part of `state`, so never part of a backup
const ITUNES_COUNTRY_STORAGE = 'movieVault.itunesCountry';
const ITUNES_COUNTRIES = {US:'United States',GB:'United Kingdom',NO:'Norway',SE:'Sweden',DK:'Denmark',DE:'Germany'};
const COVER_SUCCESS_CACHE_DAYS = 60;
const COVER_FAIL_CACHE_DAYS = 2;
const AUTO_COVER_CONCURRENCY = 2;
const COVER_RATE_LIMIT_PAUSE_MS = 60000;
let autoCoverPausedUntil = 0;
let autoCoverResumeTimer = 0;
let itunesUseJsonp = false;       // set once fetch() to iTunes failed with a network/CORS TypeError and JSONP worked
let tmdbRejected = false;         // TMDB answered 401 this session: skip it until the key changes
let coverBulk = null;             // running "Load missing covers" job
let coverBulkSummary = '';
const coverCheckQueue = [];       // "Check old covers": served after visible cards and the bulk load
const COVER_CHECK_BATCH = 25;     // results are saved in batches of this many, not once per movie
const COVER_CHECK_OFFLINE_STREAK = 12;   // this many network errors in a row (no answer in between) stop the check
let coverCheck = null;            // running "Check old covers" job
let coverCheckSummary = '';
let coverCheckDirty = 0;          // checked movies not saved yet
let oldCoverHintShown = false;

function initCovers(){
  purgeStaleCoverCache();
  document.addEventListener('error', onCoverImageError, true);   // image errors do not bubble: capture them on the document
  setupCoverSettingsUi();
}
function coverLsGet(key){try{return localStorage.getItem(key);}catch(_){return null;}}
function coverLsSet(key, value){
  try{
    if(value===''||value==null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    return true;
  }catch(_){return false;}
}
function coverError(kind, message, status){const e=new Error(message); e.kind=kind; if(status) e.status=status; return e;}
/* UI feedback only when the app's toast exists (an audit page loading just covers.js has none). */
function coverNotify(message){try{if(typeof toast==='function' && typeof els!=='undefined' && els.toast) toast(message);}catch(_){}}

/* ---------- Cover settings dialog (TMDB key, iTunes country, cache, bulk load) ---------- */
function setupCoverSettingsUi(){
  const closeBtn=$('pickerCloseBtn'), searchBtn=$('pickerSearchBtn');
  if(closeBtn && !$('pickerSettingsBtn')){
    const wrap=document.createElement('div');
    wrap.className='coverHeadBtns';
    const btn=document.createElement('button');
    btn.type='button'; btn.id='pickerSettingsBtn'; btn.className='ghost coverSmallBtn'; btn.title='Cover settings'; btn.setAttribute('aria-label','Cover settings');
    btn.innerHTML='&#9881;<span class="lbl"> Cover settings</span>';
    btn.addEventListener('click', openCoverSettings);
    closeBtn.replaceWith(wrap);
    wrap.append(btn, closeBtn);
  }
  if(searchBtn && !$('pickerGoogleBtn')){
    const g=document.createElement('button');
    g.type='button'; g.id='pickerGoogleBtn'; g.className='ghost'; g.textContent='Google Images'; g.title='Open a Google Images search for this title in a new tab';
    g.addEventListener('click', openImageSearch);
    searchBtn.after(g);
  }
  const sub=$('pickerSubtitle');
  if(sub) sub.textContent='Tap a poster to use it. If none look right, edit the search term, open Google Images, or paste an image URL below.';
  const modal=$('coverSettingsModal');
  if(!modal) return;
  $('coverSettingsCloseBtn').addEventListener('click', closeCoverSettings);
  modal.addEventListener('click', e=>{if(e.target===modal) closeCoverSettings();});
  $('coverSettingsSaveBtn').addEventListener('click', saveCoverSettings);
  $('coverClearCacheBtn').addEventListener('click', ()=>{
    const n=clearCoverCache();
    toast(`Cover cache cleared (${n} entr${n===1?'y':'ies'}). Retrying missing covers…`);
  });
  $('coverBulkBtn').addEventListener('click', toggleBulkCovers);
  $('coverCheckBtn')?.addEventListener('click', toggleCoverCheck);
  window.addEventListener('pagehide', flushCoverCheck);
  // initCovers() runs before app.js registers its own Escape handler, so Escape closes only this dialog when it is on top.
  window.addEventListener('keydown', e=>{
    if(e.key==='Escape' && modal.classList.contains('active')){e.stopImmediatePropagation(); closeCoverSettings();}
  });
}
function openCoverSettings(){
  const modal=$('coverSettingsModal'); if(!modal) return;
  $('tmdbKeyInput').value=getUserTmdbKey();   // the built-in key is never shown
  const current=getCoverSettings().itunesCountry;
  const countries={...ITUNES_COUNTRIES};
  if(!countries[current]) countries[current]=current;
  const select=$('itunesCountrySelect');
  select.innerHTML=Object.entries(countries).map(([code,name])=>`<option value="${escapeHtml(code)}">${escapeHtml(code===name?code:code+' — '+name)}</option>`).join('');
  select.value=current;
  updateBulkUi();
  updateCheckUi();
  modal.classList.add('active');
}
function closeCoverSettings(){$('coverSettingsModal')?.classList.remove('active');}
function saveCoverSettings(){
  const oldKey=getTmdbKey(), oldCountry=getCoverSettings().itunesCountry;   // effective key: user key or built-in
  const key=String($('tmdbKeyInput').value||'').trim().replace(/^bearer\s+/i,'').replace(/^["']|["']$/g,'');
  const country=($('itunesCountrySelect').value || 'US').toUpperCase();
  coverLsSet(TMDB_KEY_STORAGE, key);
  coverLsSet(ITUNES_COUNTRY_STORAGE, country);
  closeCoverSettings();
  tmdbRejected=false;
  if(getTmdbKey()!==oldKey || country!==oldCountry) clearCoverCache();   // different provider/region: old "no match" answers no longer apply
  toast('Cover settings saved.');
  if(key && getTmdbKey()!==oldKey) tmdbRequest('/configuration', {}, key).then(()=>toast('TMDB key verified.'), ()=>{/* a 401 already showed its own message */});
  if(posterPickerState) refreshPickerCandidates(els.pickerSearchInput.value.trim());
}
// Built-in TMDB key, used when no key of your own is saved in Cover settings. It is XOR-scrambled only so it is not a plain-text
// match in the public repo; a browser has to send it to TMDB, so anyone can still read it there. Replace it if it is ever revoked.
const TMDB_BUILTIN_KEY = 'eVgXS0tFdxxEIlgQWUoSUFsLXSpTQkNBFCAaRCUARF4=';
function builtinTmdbKey(){
  try{const salt='Harry A. Davis 1998', raw=atob(TMDB_BUILTIN_KEY); let key=''; for(let i=0;i<raw.length;i++) key+=String.fromCharCode(raw.charCodeAt(i)^salt.charCodeAt(i%salt.length)); return key;}
  catch(_){return '';}
}
function getUserTmdbKey(){return String(coverLsGet(TMDB_KEY_STORAGE) || '').trim();}
function getTmdbKey(){return getUserTmdbKey() || builtinTmdbKey();}
function clearCoverCache(){
  let removed=0;
  try{
    const keys=[];
    for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k && k.startsWith(COVER_CACHE_FAMILY)) keys.push(k);}
    keys.forEach(k=>localStorage.removeItem(k));
    removed=keys.length;
  }catch(_){}
  autoCoverFailedSession.clear();
  autoCoverPausedUntil=0;
  clearTimeout(autoCoverResumeTimer);
  setupVisibleCoverAutoload();
  return removed;
}
/* Remove cover caches of older versions (and expired/corrupt entries of this one). Runs once at startup. */
function purgeStaleCoverCache(){
  try{
    const drop=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(!k || !k.startsWith(COVER_CACHE_FAMILY)) continue;
      if(!k.startsWith(COVER_CACHE_PREFIX)){drop.push(k); continue;}
      try{if(Date.now()>JSON.parse(localStorage.getItem(k)).expiresAt) drop.push(k);}catch(_){drop.push(k);}
    }
    drop.forEach(k=>localStorage.removeItem(k));
  }catch(_){}
}

/* ---------- Bulk "Load missing covers" ---------- */
function missingCoverIds(){return state.movies.filter(m=>!m.poster && m.posterRemoved!==true).map(m=>m.id);}
function toggleBulkCovers(){
  if(coverBulk){cancelBulkCovers(); return;}
  const ids=missingCoverIds();
  if(!ids.length){toast('Every title already has a cover, or had it removed on purpose.'); updateBulkUi(); return;}
  coverBulkSummary='';
  coverBulk={ids:new Set(ids), total:ids.length, found:0, timer:setInterval(updateBulkUi, 500)};
  ids.forEach(id=>{autoCoverFailedSession.delete(id); queueAutoCover(id, true);});   // same queue and same findAutoCover(): concurrency limit and 429 pause apply
  updateBulkUi();
}
function cancelBulkCovers(){
  if(!coverBulk) return;
  for(let i=autoCoverBulkQueue.length-1;i>=0;i--){
    if(coverBulk.ids.has(autoCoverBulkQueue[i])){autoCoverQueued.delete(autoCoverBulkQueue[i]); autoCoverBulkQueue.splice(i,1);}
  }
  finishBulkCovers(true);
}
function bulkNote(id, found){
  if(!coverBulk || !coverBulk.ids.delete(id)) return;
  if(found) coverBulk.found++;
  if(coverBulk.ids.size) updateBulkUi(); else finishBulkCovers(false);
}
function finishBulkCovers(cancelled){
  const job=coverBulk;
  clearInterval(job.timer);
  coverBulk=null;
  const checked=job.total-job.ids.size;
  coverBulkSummary=`${cancelled?'Stopped':'Finished'}: ${job.found} cover${job.found===1?'':'s'} found, ${checked-job.found} without a match${cancelled&&job.ids.size?`, ${job.ids.size} not checked`:''}.`;
  updateBulkUi();
  toast(coverBulkSummary);
  if(cancelled) setupVisibleCoverAutoload();   // cards that were waiting in the bulk queue get observed again
}
function updateBulkUi(){
  const btn=$('coverBulkBtn'), status=$('coverBulkStatus'), bar=$('coverBulkProgress');
  if(!btn || !status) return;
  if(coverBulk){
    const done=coverBulk.total-coverBulk.ids.size, wait=autoCoverPausedUntil-Date.now();
    btn.textContent='Cancel loading';
    bar.hidden=false; bar.max=coverBulk.total; bar.value=done;
    status.textContent=`${done} of ${coverBulk.total} checked · ${coverBulk.found} found`+(wait>0?` · paused ${Math.ceil(wait/1000)} s (rate limit)`:'');
  }else{
    btn.textContent='Load missing covers';
    bar.hidden=true;
    const n=missingCoverIds().length;
    status.textContent=coverBulkSummary || (n ? `${n} title${n===1?'':'s'} without a cover.` : 'Every title has a cover (or had it removed on purpose).');
  }
}

/* ---------- Covers from the old version: check them, never overwrite them ----------
   The old app picked covers automatically and left no posterSource, so a wrong automatic cover and a cover the user chose look
   alike (poster set, no posterSource = "legacy"). "Check old covers" looks each one up again with findAutoCover() through the
   same queue (concurrency limit, 429 pause): the same poster is marked verified ('auto'); anything else only FLAGS the card
   ('check') and keeps the stored poster, with the other poster in posterSuggestion. Only the user's "Wrong cover?" replaces one. */
function isLegacyCover(m){return !!m && !!m.poster && !m.posterSource;}
function legacyCoverIds(){return state.movies.filter(isLegacyCover).map(m=>m.id);}
/* Sort rank of "Covers to review first": check, auto, legacy, then the rest. */
function coverReviewRank(m){return m.posterSource==='check' ? 0 : m.posterSource==='auto' ? 1 : isLegacyCover(m) ? 2 : 3;}
/* The same picture, whatever size the URL asks for (coverUrlKey ignores iTunes sizes; Wikimedia thumbnail widths and TMDB sizes are ignored here too). */
function coverSameImage(a, b){
  const flat=u=>coverUrlKey(u).replace(/\/\d+px-/,'/Npx-').replace(/\/t\/p\/(?:w\d+|original)\//,'/t/p/S/');
  return coverUrlKey(a)===coverUrlKey(b) || flat(a)===flat(b);
}
function toggleCoverCheck(){
  if(coverCheck){cancelCoverCheck(); return;}
  const ids=legacyCoverIds();
  if(!ids.length){updateCheckUi(); return;}
  coverCheckSummary='';
  coverCheck={ids:new Set(ids), total:ids.length, confirmed:0, review:0, errors:0, streak:0, timer:setInterval(updateCheckUi, 500)};
  coverCheckQueue.push(...ids);
  updateCheckUi();
  pumpAutoCoverQueue();
}
function cancelCoverCheck(){if(coverCheck) finishCoverCheck('cancelled');}
/* Returns 'confirmed' | 'review' | 'error' | 'skipped' | 'requeued'. Only a lookup that gave an answer changes the movie; a thrown error leaves it for a later run. */
async function checkLegacyCover(id){
  const job=coverCheck, movie=state.movies.find(m=>m.id===id);
  if(!job || !isLegacyCover(movie)) return 'skipped';
  const poster=movie.poster;
  let result;
  try{result=await findAutoCover(movie, {useCache:true});}
  catch(e){
    if(e?.kind==='ratelimit' && coverCheck===job){coverCheckQueue.unshift(id); return 'requeued';}   // the 429 already paused the queue
    return 'error';
  }
  const m=state.movies.find(x=>x.id===id);
  if(coverCheck!==job || !isLegacyCover(m) || m.poster!==poster) return 'skipped';   // cancelled, or the user changed this cover meanwhile
  if(result?.posterUrl && coverSameImage(result.posterUrl, poster)){m.posterSource='auto'; delete m.posterSuggestion;}
  else{
    m.posterSource='check';
    if(result?.posterUrl) m.posterSuggestion=result.posterUrl; else delete m.posterSuggestion;
  }
  syncCardCoverFlags(id);
  if(++coverCheckDirty>=COVER_CHECK_BATCH) flushCoverCheck();
  return m.posterSource==='auto' ? 'confirmed' : 'review';
}
function noteCoverCheck(id, outcome){
  const job=coverCheck;
  if(!job || !job.ids.delete(id)) return;
  if(outcome==='confirmed') job.confirmed++;
  else if(outcome==='review') job.review++;
  else if(outcome==='error') job.errors++;
  if(outcome==='error') job.streak++; else if(outcome!=='skipped') job.streak=0;
  if(job.streak>=COVER_CHECK_OFFLINE_STREAK) finishCoverCheck('offline');
  else if(job.ids.size) updateCheckUi();
  else finishCoverCheck('done');
}
function flushCoverCheck(){
  if(!coverCheckDirty) return;
  if(save()) coverCheckDirty=0;
}
function finishCoverCheck(how){
  const job=coverCheck;
  clearInterval(job.timer);
  coverCheck=null;
  coverCheckQueue.length=0;
  flushCoverCheck();
  const n=v=>v.toLocaleString();
  coverCheckSummary=(how==='cancelled' ? 'Stopped. ' : how==='offline' ? 'Stopped: the cover services could not be reached. ' : '')
    +`${n(job.confirmed+job.review)} checked: ${n(job.confirmed)} confirmed, ${n(job.review)} need a look`
    +(job.errors ? `, ${n(job.errors)} could not be checked (run it again to retry them)` : '')+'.';
  updateCheckUi();
  toast(coverCheckSummary, 6000);
  if(typeof els!=='undefined' && els.sortSelect?.value==='auto-first') render();   // the review order may have changed
}
function updateCheckUi(){
  const btn=$('coverCheckBtn'), status=$('coverCheckStatus'), bar=$('coverCheckProgress');
  if(!btn || !status) return;
  if(coverCheck){
    const j=coverCheck, done=j.total-j.ids.size, wait=autoCoverPausedUntil-Date.now();
    btn.disabled=false; btn.textContent='Cancel check';
    bar.hidden=false; bar.max=j.total; bar.value=done;
    status.textContent=`${done.toLocaleString()} of ${j.total.toLocaleString()} checked · ${j.confirmed.toLocaleString()} confirmed · ${j.review.toLocaleString()} need a look`+(j.errors?` · ${j.errors} could not be checked`:'')+(wait>0?` · paused ${Math.ceil(wait/1000)} s (rate limit)`:'');
  }else{
    const left=legacyCoverIds().length;
    btn.textContent='Check old covers';
    btn.disabled=!left;
    bar.hidden=true;
    status.textContent=[coverCheckSummary,
      left ? `${left.toLocaleString()} cover${left===1?'':'s'} from an older version ${left===1?"hasn't":"haven't"} been checked.` : (coverCheckSummary ? '' : 'No covers from an older version are waiting to be checked.')
    ].filter(Boolean).join(' ');
  }
}
/* At startup: one gentle toast per session when legacy covers exist. It only opens Cover settings: the check itself makes hundreds of requests, so the user starts it. */
function offerOldCoverCheck(){
  const attempt=tries=>{
    if(oldCoverHintShown || typeof toast!=='function' || !legacyCoverIds().length) return;
    if(Date.now()<(toast._hold||0)){if(tries<6) setTimeout(()=>attempt(tries+1), 3000); return;}   // never bury a warning or an Undo toast
    oldCoverHintShown=true;
    toast('Some covers came from the old version and may be wrong.', 12000, {warn:false, action:{label:'Check them', fn:openCoverSettings}});
  };
  setTimeout(()=>attempt(0), 2500);
}
/* "Keep" on a flagged card: the user confirms the cover, so it counts as chosen by them. */
function keepCover(id){
  const m=state.movies.find(x=>x.id===id);
  if(!m || !m.poster) return;
  m.posterSource='manual'; delete m.posterSuggestion;
  m.updated=today();
  save();
  syncCardCoverFlags(id);
  updateCheckUi();
  toast('Cover kept.');
}
/* The "Check cover" chip and the Keep / Wrong cover? buttons are drawn from the movie's state, both by cardHtml (app.js) and by syncCardCoverFlags. */
function coverChipHtml(m){
  return m.poster && m.posterSource==='check' ? '<span class="chip checkPill" title="This cover came from an older version and may be the wrong film">Check cover</span>' : '';
}
// Only covers flagged by "Check old covers" get Keep / Wrong cover? on the card; any other cover is changed from the
// details dialog (Change poster / Remove poster), so ordinary cards stay uncluttered.
function coverButtonsHtml(m){
  if(!m.poster || m.posterSource!=='check') return '';
  const id=escapeHtml(m.id);
  return `<button class="miniBtn keepBtn" data-keep-cover="${id}">Keep</button><button class="miniBtn wrongBtn" data-wrong-cover="${id}">Wrong cover?</button>`;
}

/* ---------- Poster picker (manual cover selection) ---------- */
async function quickPosterLookup(id, opts={}){
  const m=state.movies.find(x=>x.id===id); if(!m) return;
  openPosterPicker({
    title: m.title,
    section: m.section,
    format: m.format,
    suggestion: opts.suggestion,
    onSelect: poster => {
      if(m.poster && m.poster!==poster) rejectCover(m.title, m.poster);
      unrejectCover(m.title, poster);
      m.poster=poster; m.posterSource='manual'; delete m.posterSuggestion; m.posterRemoved=false; m.updated=today(); save();
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
  const current=!isNew && editingId ? state.movies.find(x=>x.id===editingId) : null;
  openPosterPicker({
    title, section, format,
    onSelect: poster => {
      if(current?.poster && current.poster!==poster) rejectCover(title, current.poster);   // replacing a cover: never suggest the old one again
      unrejectCover(title, poster);
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
    suggestion: opts.suggestion || '',   // a poster findAutoCover() proposed earlier (see "Check old covers"): listed first
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
function openImageSearch(){
  const term=((els.pickerSearchInput.value.trim() || posterPickerState?.title || '')+' movie poster').trim();
  window.open('https://www.google.com/search?tbm=isch&q='+encodeURIComponent(term), '_blank', 'noopener');
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
  const warnings = [];
  const suggested = state0.suggestion ? [{url:state0.suggestion, source:'Suggested', label:'Suggested match', suggested:true}] : [];
  els.pickerStatus.textContent = 'Searching candidates…';
  els.pickerGrid.innerHTML = '';
  if(suggested.length){renderPickerCandidates(suggested); els.pickerStatus.textContent = 'Suggested match shown first. Searching for more…';}   // no waiting for the network
  try{
    const candidates = await gatherPosterCandidates(searchTerm || state0.title, {section:state0.section, format:state0.format, originalTitle: state0.title, warn:(name,e)=>warnings.push(coverWarning(name,e))});
    if(!posterPickerState || posterPickerState.generation !== gen) return; // picker was closed or re-searched
    renderPickerCandidates([...suggested, ...candidates.filter(c=>!suggested.some(sg=>coverUrlKey(sg.url)===coverUrlKey(c.url)))], [...new Set(warnings)]);
  }catch(e){
    if(!posterPickerState || posterPickerState.generation !== gen) return;
    els.pickerStatus.textContent = 'Search failed. Try a different term, or paste a URL below.';
    if(!suggested.length) els.pickerGrid.innerHTML = '';
  }
}
function coverWarning(name, e){
  if(e?.kind==='ratelimit') return `${name} is rate-limiting requests; try again in a minute.`;
  if(e?.kind==='auth') return `${name} rejected the API key (see Cover settings).`;
  return `${name} could not be reached.`;
}
function renderPickerCandidates(candidates, warnings=[]){
  const note=warnings.length ? ' '+warnings.join(' ') : '';
  if(!candidates.length){
    els.pickerStatus.textContent = 'No candidates found.'+note;
    els.pickerGrid.innerHTML = `<div class="pickerEmpty">Nothing matched. Check the spelling, try the original title, or find a cover yourself:
      <div class="pickerEmptyActions"><button class="ghost" id="pickerEmptyGoogleBtn">Search Google Images</button></div>
      In the results, long-press or right-click the cover, choose “Copy image address”, then paste it into the URL field below.</div>`;
    $('pickerEmptyGoogleBtn').addEventListener('click', openImageSearch);
    return;
  }
  els.pickerStatus.textContent = `${candidates.length} candidate${candidates.length===1?'':'s'} — tap one to use it.`+note;
  els.pickerGrid.innerHTML = candidates.map((c,i)=>`
    <button class="pickerThumb${c.rejected?' rejected':''}${c.suggested?' suggested':''}"data-pickerpick="${i}" title="${escapeHtml(c.rejected?'Rejected before for this title. '+(c.label||''):(c.label||''))}">
      <img src="${escapeHtml(c.url)}" alt="${escapeHtml(c.label||'Candidate')}" loading="lazy" onerror="this.closest('.pickerThumb').style.display='none'">
      <span class="src">${escapeHtml(c.source)}${c.year?(' · '+c.year):''}${c.rejected?' · rejected':''}</span>
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

/* ---------- Visible-card lazy loading + queue ---------- */
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
function queueAutoCover(id, bulk=false){
  if(!id || autoCoverQueued.has(id) || autoCoverRunning.has(id) || autoCoverFailedSession.has(id)) return;
  const movie=state.movies.find(m=>m.id===id);
  if(!movie || movie.poster || movie.posterRemoved===true) return;
  autoCoverQueued.add(id);
  (bulk ? autoCoverBulkQueue : autoCoverQueue).push(id);
  pumpAutoCoverQueue();
}
function requeueAutoCover(id){
  autoCoverQueued.add(id);
  (coverBulk?.ids.has(id) ? autoCoverBulkQueue : autoCoverQueue).unshift(id);
}
function pumpAutoCoverQueue(){
  while(Date.now()>=autoCoverPausedUntil && autoCoverRunning.size < AUTO_COVER_CONCURRENCY && (autoCoverQueue.length || autoCoverBulkQueue.length || coverCheckQueue.length)){
    const check=!autoCoverQueue.length && !autoCoverBulkQueue.length;   // old-cover checks are served last
    const id=autoCoverQueue.length ? autoCoverQueue.shift() : autoCoverBulkQueue.length ? autoCoverBulkQueue.shift() : coverCheckQueue.shift();
    autoCoverQueued.delete(id);
    autoCoverRunning.add(id);
    (check ? checkLegacyCover(id) : autoLoadVisibleCover(id))
      .then(outcome=>{if(outcome!=='requeued') check ? noteCoverCheck(id, outcome) : bulkNote(id, outcome==='found');}, ()=>check ? noteCoverCheck(id, 'error') : bulkNote(id, false))
      .finally(()=>{
        autoCoverRunning.delete(id);
        pumpAutoCoverQueue();
      });
  }
}
/* Any provider answering HTTP 429 pauses the whole auto queue; the title that hit it is re-queued, not marked failed. */
function noteCoverRateLimit(){
  autoCoverPausedUntil=Date.now()+COVER_RATE_LIMIT_PAUSE_MS;   // no toast: Cover settings shows "paused N s (rate limit)" in the bulk / check progress
  clearTimeout(autoCoverResumeTimer);
  autoCoverResumeTimer=setTimeout(pumpAutoCoverQueue, COVER_RATE_LIMIT_PAUSE_MS+100);
}
/* Returns 'found' | 'none' | 'skipped' | 'requeued'. The lookup itself is findAutoCover(); this only applies its answer. */
async function autoLoadVisibleCover(id){
  const movie=state.movies.find(m=>m.id===id);
  if(!movie || movie.poster || movie.posterRemoved===true || autoCoverFailedSession.has(id)) return 'skipped';
  markCardLoading(id,true);
  try{
    const result=await findAutoCover(movie, {useCache:true});   // caches successes and genuine "no match" itself
    if(!result?.posterUrl){autoCoverFailedSession.add(id); return 'none';}
    const m=state.movies.find(x=>x.id===id);
    if(!m || m.poster || m.posterRemoved===true) return 'skipped';
    m.poster=result.posterUrl; m.posterSource='auto'; delete m.posterSuggestion; m.posterRemoved=false; m.updated=today();
    save();
    updateCardPoster(id, result.posterUrl, m.title);
    return 'found';
  }catch(e){
    if(e?.kind==='ratelimit'){requeueAutoCover(id); return 'requeued';}
    autoCoverFailedSession.add(id);   // network error / timeout / HTTP error: skip for this session, but do not cache a failure
    return 'none';
  }finally{
    markCardLoading(id,false);
  }
}
function getCoverSettings(){
  return {
    itunesCountry:String(coverLsGet(ITUNES_COUNTRY_STORAGE) || 'US').toUpperCase(),
    tmdbKey:getTmdbKey(),
    cacheDays:COVER_SUCCESS_CACHE_DAYS
  };
}

/* ---------- Cover cache (compact: only what is needed to re-use a hit) + per-title reject list ---------- */
function smartCoverCacheKey(title, options={}){
  const cleaned=normalizeTitle(title);
  const year=options.year || cleaned.year || inferYearFromTitle(cleaned.title);
  return `${cleaned.cacheKey}:${year || ''}:auto-v8${options.kind==='tv'?'-tv':''}${options.hint?'-'+options.hint:''}${options.catalogYear?'-c'+options.catalogYear:''}`;
}
function getSmartCoverCache(key){
  try{
    const raw=localStorage.getItem(COVER_CACHE_PREFIX+key);
    if(!raw) return null;
    const cached=JSON.parse(raw);
    if(!cached || Date.now()>cached.expiresAt){localStorage.removeItem(COVER_CACHE_PREFIX+key); return null;}
    return cached.value;
  }catch(_){return null;}
}
function setSmartCoverCache(key, value, days){
  const v=value?.posterUrl
    ? {posterUrl:value.posterUrl, provider:value.provider || '', title:value.title || '', year:value.year || '', confidence:Math.round((Number(value.confidence) || 0)*100)/100}
    : {posterUrl:''};
  try{
    localStorage.setItem(COVER_CACHE_PREFIX+key, JSON.stringify({expiresAt:Date.now()+days*24*60*60*1000, value:v}));
  }catch(_){/* localStorage can fill up; cover lookup should still work without cache */}
}
/* Drops every cache entry of this title (the key also varies with section hint / catalog year). */
function deleteCoverCacheFor(title){
  try{
    const prefix=COVER_CACHE_PREFIX+normalizeTitle(title).cacheKey+':';
    const keys=[];
    for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k && k.startsWith(prefix)) keys.push(k);}
    keys.forEach(k=>localStorage.removeItem(k));
  }catch(_){}
}
function coverUrlKey(url){return String(url||'').replace(/^https?:/,'').replace(/\d+x\d+(bb|sr)?/gi,'X');}
function getRejectedCovers(cacheKey){
  try{const list=JSON.parse(coverLsGet(COVER_REJECT_PREFIX+cacheKey) || '[]'); return Array.isArray(list) ? list : [];}catch(_){return [];}
}
function coverRejectChecker(cacheKey){
  const keys=new Set(getRejectedCovers(cacheKey).map(coverUrlKey));
  return url=>keys.has(coverUrlKey(url));
}
/* Remember that this URL is wrong for this title (removed, replaced or dead) so auto-load and the picker stop suggesting it. */
function rejectCover(title, url){
  if(!title || !url) return;
  const cacheKey=smartCoverCacheKey(title);
  const list=getRejectedCovers(cacheKey);
  if(!list.some(u=>coverUrlKey(u)===coverUrlKey(url))) list.push(url);
  coverLsSet(COVER_REJECT_PREFIX+cacheKey, JSON.stringify(list.slice(-12)));
  deleteCoverCacheFor(title);
}
function unrejectCover(title, url){
  const cacheKey=smartCoverCacheKey(title);
  const list=getRejectedCovers(cacheKey);
  const rest=list.filter(u=>coverUrlKey(u)!==coverUrlKey(url));
  if(rest.length!==list.length) coverLsSet(COVER_REJECT_PREFIX+cacheKey, rest.length ? JSON.stringify(rest) : '');
}

/* ======================================================================================================
   Automatic lookup. Precision first: a missing cover shows a neat title tile, a wrong cover misleads.
   Auto mode therefore never fuzzy-matches: a candidate must have exactly the collection's title (articles, case, punctuation
   and a few collection suffixes ignored). Wikipedia decides WHICH film it is (and whether several films share the title);
   TMDB / iTunes then supply a sharper poster of that same film, with Wikipedia's own poster as the fallback.
   Every image, from every provider, must load and be a portrait poster (logos, title cards, stills and photos are not).
   Anything ambiguous returns null and is left to the manual picker.
   ====================================================================================================== */
const AUTO_AMBIGUOUS = Symbol('ambiguous');
// Section -> weak hint, used ONLY to choose between several films that share the title (never to override a unique match).
const SECTION_HINT_WORDS = {
  asian:/\b(Hong Kong|Chinese|China|Taiwanese|Taiwan|martial arts|kung fu|wuxia|Shaw Brothers|Golden Harvest|Japanese|samurai|Korean)\b/i,
  family:/\b(animated|animation|Disney|Pixar|DreamWorks|children'?s|family|musical)\b/i
};
function sectionHint(section){
  const s=String(section||'').trim().toUpperCase();
  if(/^(KUNG FU|88 |EUREKA|SHOUT 4K)/.test(s)) return 'asian';
  if(/^(4K DISNEY|TV ROOM)/.test(s)) return 'family';
  return '';
}
/* "NATIONAL TREASURE 1 & 2", "SHREK 1,2 & 3", "POLICE STORY TRILOGY", "OH, GOD! COLL.", "BRUCE LEE BOX": one disc set, no single poster.
   (A lone "BOX" is the film.) */
function isMultiFilmTitle(title){
  const t=String(title||'');
  return /\d\s*(?:,|&|\+|\band\b|[-–])\s*\d/i.test(t) || /\b(?:trilogy|quadrilogy|anthology|box\s*set)\b/i.test(t) || /\bcoll(?:ection)?\.?(?=\s|$)/i.test(t) || /\bcomplete\b.*\bseries\b/i.test(t) || /\S\s+box$/i.test(t);
}
/* movie = {title, section, format, catalog}. Resolves to null (nothing safe to assign) or
   {posterUrl, provider, title, year, confidence, pageUrl}. Side-effect free: it never touches `state`, the DOM or storage,
   except that useCache:true reads and writes the compact cover cache. Throws an Error with kind 'ratelimit' (HTTP 429) or
   'network' when providers could not answer, which is different from a decided "no match". */
async function findAutoCover(movie, {useCache=false, validateImage=true}={}){
  const raw=String(movie?.title ?? '');
  const paren=raw.match(/\s*\(((?:18|19|20)\d{2})\)\s*$/);   // "HEAT (1995)": an explicit release year
  const cleaned=normalizeTitle(paren ? raw.slice(0,paren.index) : raw);
  if(!cleaned.title || isMultiFilmTitle(cleaned.title) || /^Box set$/i.test(String(movie?.format||''))) return null;
  const kind=/^TV \/ Series$/i.test(String(movie?.format||'')) ? 'tv' : 'film';   // a TV series is only looked for when the format says TV
  const year=(paren && paren[1]) || cleaned.year || inferYearFromTitle(cleaned.title);
  const catalog=String(movie?.catalog ?? '').trim();
  const catalogYear=/^(?:189\d|19\d\d|20[0-3]\d)$/.test(catalog) ? catalog : '';   // the importer keeps a trailing number of the title in `catalog`
  const hint=sectionHint(movie?.section);
  const cacheKey=smartCoverCacheKey(raw, {year, hint, catalogYear, kind});
  const isRejected=coverRejectChecker(smartCoverCacheKey(raw));
  if(useCache){
    const cached=getSmartCoverCache(cacheKey);
    if(cached && !(cached.posterUrl && isRejected(cached.posterUrl))) return cached.posterUrl ? publicCover(cached) : null;
  }
  const flightKey=cacheKey+(validateImage?'':'|nv');
  if(coverInflight.has(flightKey)) return coverInflight.get(flightKey);
  const variants=buildTitleVariants(cleaned.title, year, true);
  const ctx={cleaned, kind, year, catalogYear, hint, isRejected, validate:validateImage, settings:getCoverSettings(), variants, wanted:new Set(variants.map(simpleText))};
  const task=resolveAutoCover(ctx).then(result=>{
    // Only an answer ("found" or a genuine "no match") is cached. Errors throw and skip this line.
    if(useCache) setSmartCoverCache(cacheKey, result, result ? COVER_SUCCESS_CACHE_DAYS : COVER_FAIL_CACHE_DAYS);
    return result ? publicCover(result) : null;
  }).finally(()=>coverInflight.delete(flightKey));
  coverInflight.set(flightKey, task);
  return task;
}
function publicCover(r){return {posterUrl:r.posterUrl, provider:r.provider || '', title:r.title || '', year:r.year || '', confidence:Number(r.confidence) || 0, pageUrl:r.pageUrl || ''};}
/* Kept for older callers: same as findAutoCover({title, section, format}). */
function lookupSmartCover(rawTitle, options={}, useCache=true){
  return findAutoCover({title:rawTitle, section:options.section, format:options.format, catalog:options.catalog}, {useCache});
}
async function resolveAutoCover(ctx){
  let failed=false;
  const attempt=async fn=>{try{return await fn();}catch(e){if(e?.kind==='ratelimit') throw e; if(e?.kind!=='auth') failed=true; return undefined;}};
  const wiki=await attempt(()=>wikipediaIdentity(ctx));
  if(wiki===undefined) throw coverError('network', 'Wikipedia unavailable: cannot rule out other films with this title');
  if(wiki.status==='ambiguous') return null;
  const film=wiki.status==='unique' ? wiki.film : null;
  const sources=[];   // TMDB / iTunes search movies only; a TV series gets Wikipedia's poster
  if(ctx.kind==='film'){
    if(ctx.settings.tmdbKey && !tmdbRejected) sources.push(()=>tmdbExactFilms(ctx));
    sources.push(()=>itunesExactFilms(ctx));
  }
  const options=[];   // poster candidates for the decided film, best first
  for(const source of sources){
    const films=await attempt(source);
    if(!films?.length) continue;
    const pick=pickFilm(films, ctx, film);
    if(pick===AUTO_AMBIGUOUS) return null;
    if(pick){options.push(pick); break;}
  }
  if(film && film.posterUrl && !ctx.isRejected(film.posterUrl)) options.push(wikipediaCover(film, film.posterUrl, 'Wikipedia Infobox/PageImages'));
  const tried=new Set();
  const usable=async option=>{
    if(tried.has(option.posterUrl)) return false;
    tried.add(option.posterUrl);
    if(!ctx.validate) return true;
    const verdict=await preloadCover(option);
    if(verdict==='error') failed=true;   // the image does not load: never store it, and do not call this a genuine "no match"
    return verdict==='ok';                // 'shape': it loaded but is a logo/photo/title card, a definite "not this one"
  };
  for(const option of options) if(await usable(option)) return option;
  if(film){   // last resort: the infobox of that ONE page names its poster file (the page image was missing, a still, a photo or dead)
    const image=await attempt(()=>getWikipediaInfoboxPosterUrl(film.page));
    if(image && !ctx.isRejected(image.url)){
      const option=wikipediaCover(film, image.url, 'Wikipedia Infobox');
      if(await usable(option)) return option;
    }
  }
  if(failed) throw coverError('network', 'Cover providers unavailable');
  return null;
}
function wikipediaCover(film, url, provider){
  return normalizeResult({provider, confidence:film.year ? .92 : .88, title:film.title, year:film.year, posterUrl:url, pageUrl:film.pageUrl});
}
/* Choose the exact-title film a TMDB/iTunes result list stands for. `film` = identity already fixed by Wikipedia (or null). */
function pickFilm(films, ctx, film){
  const want=film?.year || ctx.year;
  let pool=films;
  if(want) pool=films.filter(f=>yearsClose(f.year, want));
  else{
    const significant=films.filter(f=>f.significant!==false);
    if(yearClusters((significant.length ? significant : films).map(f=>f.year))>1){   // several films share the title, nothing says which
      pool=ctx.catalogYear ? films.filter(f=>yearsClose(f.year, ctx.catalogYear)) : [];
      if(!pool.length) return AUTO_AMBIGUOUS;
    }
  }
  return pool.find(f=>f.posterUrl && !ctx.isRejected(f.posterUrl)) || null;
}
function yearsClose(a, b){const x=Number(a), y=Number(b); return !!x && !!y && Math.abs(x-y)<=1;}
function yearClusters(list){
  const years=[...new Set(list.map(Number).filter(Boolean))].sort((a,b)=>a-b);
  let clusters=0, prev=-9;
  for(const y of years){if(y-prev>1) clusters++; prev=y;}
  return clusters;
}
/* A poster is portrait (at least 1.25x taller than wide) and not tiny. Logos, photos, title cards and stills are landscape or square. */
function isPortrait(width, height){return width>=150 && height>=1.25*width;}
/* Loads the image: 'ok' (a portrait poster), 'shape' (loads fine but is not poster-shaped) or 'error' (dead link / timeout / not an image). */
function imageVerdict(url, timeoutMs=10000){
  return new Promise(resolve=>{
    const img=new Image();
    const timer=setTimeout(()=>{img.onload=img.onerror=null; resolve('error');}, timeoutMs);
    img.onload=()=>{clearTimeout(timer); resolve(isPortrait(img.naturalWidth, img.naturalHeight) ? 'ok' : 'shape');};
    img.onerror=()=>{clearTimeout(timer); resolve('error');};
    img.src=url;
  });
}
async function preloadImage(url, timeoutMs=10000){return (await imageVerdict(url, timeoutMs))==='ok';}
/* Checks the candidate's URLs in turn (iTunes has a smaller alternate size); on 'ok' posterUrl is the one that worked. */
async function preloadCover(c){
  let verdict='error';
  for(const url of [c.posterUrl, c.altUrl]){
    if(!url) continue;
    const v=await imageVerdict(url);
    if(v==='ok'){c.posterUrl=url; return 'ok';}
    if(v==='shape') verdict='shape';
  }
  return verdict;
}

/* ---------- Auto: exact-title films per provider ---------- */
async function itunesExactFilms(ctx){
  for(const variant of ctx.variants.slice(0,3)){
    const data=await itunesSearch(variant, ctx.settings, 35);
    const films=(data.results || [])
      .filter(item=>item.artworkUrl100 && item.trackName && (!item.kind || item.kind==='feature-movie') && ctx.wanted.has(simpleText(item.trackName)))
      .map(item=>({provider:'iTunes', confidence:.86, title:item.trackName, year:item.releaseDate ? String(item.releaseDate).slice(0,4) : '', posterUrl:upgradeArtworkUrl(item.artworkUrl100), altUrl:upgradeArtworkUrl(item.artworkUrl100,'600x900'), pageUrl:item.trackViewUrl || item.collectionViewUrl || ''}));
    if(films.length) return films;
  }
  return [];
}
async function tmdbExactFilms(ctx){
  for(const variant of ctx.variants.slice(0,3)){
    const results=await tmdbSearch(variant, ctx.year, ctx.settings.tmdbKey);
    const films=results
      .filter(r=>ctx.wanted.has(simpleText(r.title)) || ctx.wanted.has(simpleText(r.original_title)))
      .map(r=>({provider:'TMDB', confidence:.9, title:r.title || r.original_title || '', year:r.release_date ? String(r.release_date).slice(0,4) : '', posterUrl:r.poster_path ? 'https://image.tmdb.org/t/p/w500'+r.poster_path : '', pageUrl:'https://www.themoviedb.org/movie/'+r.id, significant:(r.vote_count || 0)>=30}));   // TMDB lists every obscure film: only notable ones make a title "ambiguous"
    if(films.length) return films;
  }
  return [];
}

/* ---------- Wikipedia: which film is it, and do other films share the title? ---------- */
// pilicense=any: film posters are non-free images, which PageImages hides by default. 500 px is a standard Wikimedia thumbnail width.
// `description` is the article's short description ("1995 American crime film directed by Michael Mann").
const WIKI_PAGE_PROPS = {prop:'pageimages|description|extracts|pageprops', piprop:'thumbnail|name', pilicense:'any', pithumbsize:'500', pilimit:'max', exintro:'1', explaintext:'1', exchars:'300', exlimit:'max', ppprop:'disambiguation'};
// What an accepted page must BE. `head` is tested against the first noun phrase of the short description, so "1995 American crime film
// directed by ..." passes while "American film director", "Year", "List of ... films" and "Film series" do not.
const WIKI_KINDS = {
  film:{qualifier:/\b(?:film|movie|(?:tv|television) special)\b/i, head:/\b(?:film|movie|(?:tv|television) special)(?:\s+(?:adaptation|noir))?$/i, sentence:/\b(?:is|was) an? [^.]{0,150}?\b(?:film|movie|(?:tv|television) special)\b/i, probes:['film'], search:'film'},
  tv:{qualifier:/\b(?:tv series|television series|miniseries)\b/i, head:/\b(?:series|miniseries|show|sitcom|serial|soap opera|telenovela)$/i, sentence:/\b(?:is|was) an? [^.]{0,150}?\b(?:series|miniseries|show|sitcom)\b/i, probes:['TV series','miniseries'], search:'television series'}
};
const WIKI_HEAD_END = /\s+(?:by|directed|starring|about|based|from|featuring|set|in|of|with|that|which|written|produced|released|for|on|at|made|where)\b|[,;(:]/i;
function wikiHeadPhrase(description){return String(description).split(WIKI_HEAD_END)[0].trim();}
async function wikiQuery(params){
  const url=new URL('https://en.wikipedia.org/w/api.php');
  for(const [k,v] of Object.entries({action:'query', format:'json', formatversion:'2', origin:'*', ...params})) url.searchParams.set(k, v);
  return fetchJson(url.toString());
}
// Set-index pages ("Batman (film)": "Index of articles associated with the same name") carry no `disambiguation` page property but
// are just as ambiguous.
const WIKI_INDEX_DESCRIPTION = /^(?:Topics referred to by the same term|Index of articles associated with the same name)$/i;
function isDisambiguation(page){return !!(page?.pageprops && 'disambiguation' in page.pageprops) || WIKI_INDEX_DESCRIPTION.test(String(page?.description || '').trim());}
/* null unless the page IS a film (or, kind 'tv', a TV series) whose title (minus "(… film)", "The"/"A") is one of the wanted titles
   (`anyTitle`: a typed lookup redirected here, which is evidence enough of the title). Year, list, disambiguation, person and place
   pages fail the head-noun test. A page image that is not portrait (a still, a logo, a photo) is not offered as the poster:
   posterUrl stays '' and the infobox is consulted instead. */
function wikiFilmInfo(page, wanted, kind='film', anyTitle=false){
  const K=WIKI_KINDS[kind];
  const title=page.title || '';
  if(!anyTitle && !wanted.has(simpleText(stripArticleQualifier(title)))) return null;
  const description=page.description || '';
  const extract=String(page.extract || '').slice(0,300);
  const qualifier=(title.match(/\(([^)]*)\)\s*$/) || [])[1] || '';
  if(qualifier && !K.qualifier.test(qualifier)) return null;   // "Heat (band)"; "Drive (TV series)" when looking for films
  // Without a short description, require both an explicit "(… film)" title and an "X is a … film" opening sentence.
  const ok=description ? K.head.test(wikiHeadPhrase(description)) : (K.qualifier.test(qualifier) && K.sentence.test(extract));
  if(!ok) return null;
  const thumb=page.thumbnail;
  const posterUrl=thumb && thumb.width && thumb.height && !isPortrait(thumb.width, thumb.height) ? '' : (thumb?.source || page.original?.source || '');
  return {fullTitle:title, title:stripArticleQualifier(title), year:extractYearFromText(description) || extractYearFromText(qualifier) || extractYearFromText(extract), description:description || extract, posterUrl, pageUrl:'https://en.wikipedia.org/wiki/'+encodeURIComponent(title.replace(/ /g,'_')), page};
}
const TITLE_SMALL_WORDS = new Set(['a','an','the','and','but','or','nor','for','of','in','on','at','to','by','as','vs','with','from','into']);
/* "SNOW WHITE AND THE SEVEN DWARFS" -> "Snow White and the Seven Dwarfs": article titles are case-sensitive after the first letter. */
function wikiTitleCase(text){
  const words=String(text).split(' ');
  return words.map((w,i)=>{
    if(/^(ii|iii|iv|vi|vii|viii|ix|xi|xii)$/i.test(w)) return w.toUpperCase();
    const lower=w.toLowerCase();
    if(i>0 && i<words.length-1 && TITLE_SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-–/(])([a-z])/g, (m,p,c)=>p+c.toUpperCase());
  }).join(' ');
}
/* Page titles to look up in one batch. `form`: 'year' ("X (1995 film)"), 'qualified' ("X (film)") or 'bare' ("X"). `alt`: the same
   title with "The" added or removed, which only counts when nothing exists under the title as the collection wrote it. */
function wikiProbeTitles(ctx){
  const K=WIKI_KINDS[ctx.kind];
  const out=[], seen=new Set();
  const add=(title, form, alt)=>{title=title.replace(/[|#<>\[\]{}]/g,' ').replace(/\s+/g,' ').trim(); if(title && !seen.has(title)){seen.add(title); out.push({title, form, alt});}};   // characters not allowed in page titles (and "|" separates the batch)
  const years=[ctx.year, ctx.catalogYear].filter(Boolean);
  for(const variant of ctx.variants.slice(0,3)){
    const hasArticle=/^(?:the|a|an)\s/i.test(variant);
    for(const [form, alt] of [[variant, false], [hasArticle ? variant.replace(/^(?:the|a|an)\s+/i,'') : 'The '+variant, true]]){
      for(const f of new Set(form===form.toUpperCase() ? [wikiTitleCase(form)] : [form, wikiTitleCase(form)])){
        years.forEach(y=>K.probes.forEach(k=>add(`${f} (${y} ${k})`, 'year', alt)));
        K.probes.forEach(k=>add(`${f} (${k})`, 'qualified', alt));
        add(f, 'bare', alt);
      }
    }
  }
  return out;
}
/* Which film (or series) is this title? -> {status:'unique', film} | {status:'ambiguous'} | {status:'none'}.
   1. An explicit year in the title names the film (or nothing).
   2. Wikipedia's own primary topic: the title as the collection wrote it has ONE "X (film)" article (a redirect to the most notable
      "X (1995 film)" counts, and so does any redirect from the typed title) -> that film, however many same-named films with year
      qualifiers exist. A different film under the "The"-added/removed title, however, makes it a homonym.
   3. "X (film)" is a disambiguation or set-index page, or several films answer to the title -> only a catalog year or a section hint
      may choose.
   4. A bare "X" film article is the primary topic too. 5. Nothing under the typed title: the same title with "The" added/removed.
   6. Nothing by exact lookup: Wikipedia's case-insensitive search, accepted only if it finds exactly one such film. */
async function wikipediaIdentity(ctx){
  const K=WIKI_KINDS[ctx.kind];
  const probes=wikiProbeTitles(ctx);
  const pages=[], normalized=new Map(), redirects=new Map();
  for(let i=0;i<probes.length;i+=20){
    const data=await wikiQuery({...WIKI_PAGE_PROPS, titles:probes.slice(i,i+20).map(p=>p.title).join('|'), redirects:'1'});
    pagesFromWikiResponse(data).filter(p=>!p.missing).forEach(p=>pages.push(p));
    for(const r of data.query?.normalized || []) normalized.set(r.from, r.to);
    for(const r of data.query?.redirects || []) redirects.set(r.from, r.to);
  }
  const byTitle=new Map(pages.map(p=>[p.title, p]));
  const resolve=title=>{   // -> {page, redirected}: the page a probe lands on, and whether a redirect led there
    let t=normalized.get(title) || title, redirected=false;
    for(let n=0;n<5 && redirects.has(t);n++){t=redirects.get(t); redirected=true;}
    return {page:byTitle.get(t), redirected};
  };
  const films=new Map();   // every matching film article seen, by page title
  const found={typed:{qualified:[], bare:[]}, alt:{qualified:[], bare:[]}};
  const dab={typed:false, alt:false};   // a disambiguation page stands where the "X (film)" article would be: several films share the title
  let anyDab=false;
  const take=(page, anyTitle=false)=>{const info=wikiFilmInfo(page, ctx.wanted, ctx.kind, anyTitle); if(info) films.set(info.fullTitle, info); return info;};
  for(const probe of probes){
    const {page, redirected}=resolve(probe.title);
    if(!page) continue;
    const side=probe.alt ? 'alt' : 'typed';
    if(isDisambiguation(page)){
      if(ctx.wanted.has(simpleText(stripArticleQualifier(page.title)))){anyDab=true; if(probe.form!=='bare') dab[side]=true;}
      continue;
    }
    // A redirect from the title as the collection wrote it is evidence that the target IS that title ("Independence Day 2" ->
    // "Independence Day: Resurgence"), so the target needs no matching name, only the film test. It counts like an "X (film)" find.
    // Redirects from the "The"-added/removed forms are not trusted that far.
    const viaRedirect=redirected && !probe.alt;
    const info=take(page, viaRedirect);
    if(info && probe.form!=='year') found[side][viaRedirect ? 'qualified' : probe.form].push(info);
  }
  const searchFound=[];
  const uniq=list=>[...new Map(list.map(f=>[f.fullTitle, f])).values()];
  const unique=film=>({status:'unique', film});
  const homonyms=()=>{   // several films share the title: only a catalog year or a section hint may choose between them
    const all=[...films.values()];
    if(ctx.catalogYear){const m=all.filter(f=>f.year===ctx.catalogYear); if(m.length===1) return unique(m[0]);}
    if(ctx.hint){const m=all.filter(f=>SECTION_HINT_WORDS[ctx.hint].test(f.description)); if(m.length===1) return unique(m[0]);}
    return {status:'ambiguous'};
  };
  const verdict=searched=>{
    if(ctx.year){
      const match=[...films.values()].filter(f=>f.year===ctx.year);
      if(match.length===1) return unique(match[0]);
      return {status: match.length>1 || films.size || anyDab ? 'ambiguous' : 'none'};
    }
    const typed=uniq([...found.typed.qualified, ...found.typed.bare]);
    // A different film under the "The"-added/removed title is a homonym, not noise ("Graduate (film)" 2011 vs "The Graduate" 1967).
    const alt=uniq([...found.alt.qualified, ...found.alt.bare]).filter(f=>!typed.some(t=>t.fullTitle===f.fullTitle));
    if(typed.length){
      if(typed.length===1 && !dab.typed && !alt.length) return unique(typed[0]);
      return homonyms();
    }
    if(dab.typed || dab.alt || alt.length>1) return homonyms();
    if(alt.length===1) return unique(alt[0]);
    if(!searched) return {status:'none'};
    const hits=uniq(searchFound);
    if(hits.length===1) return unique(hits[0]);
    return hits.length>1 ? homonyms() : {status: anyDab ? 'ambiguous' : 'none'};
  };
  let result=verdict(false);
  // The search is case-insensitive and sees year-qualified titles: it finds films the exact lookups miss, and lists the homonyms
  // a catalog year or section hint needs to choose from. An unresolvable disambiguation page needs no further evidence.
  if(result.status==='none' || (ctx.year && result.status!=='unique') || (result.status==='ambiguous' && (ctx.hint || ctx.catalogYear))){
    for(const variant of ctx.variants.slice(0,2)){
      const data=await wikiQuery({...WIKI_PAGE_PROPS, generator:'search', gsrsearch:`"${variant}" ${K.search}`, gsrlimit:'20', gsrnamespace:'0'});
      for(const page of pagesFromWikiResponse(data)) if(!page.missing && !isDisambiguation(page)){const info=take(page); if(info) searchFound.push(info);}
    }
    result=verdict(true);
  }
  return result;
}

/* ---------- Manual picker candidates (permissive: the user decides) ---------- */
async function gatherPosterCandidates(searchTerm, options={}){
  const cleaned=normalizeTitle(searchTerm || options.originalTitle || '');
  const year=options.year || cleaned.year || inferYearFromTitle(cleaned.title);
  const settings=getCoverSettings();
  const warn=options.warn || (()=>{});
  const isRejected=coverRejectChecker(smartCoverCacheKey(options.originalTitle || searchTerm || ''));
  const jobs=[];
  if(settings.tmdbKey && !tmdbRejected) jobs.push(['TMDB', ()=>gatherTmdbCandidateList(cleaned, year, settings)]);
  jobs.push(
    ['iTunes', ()=>gatherItunesCandidateList(cleaned, year, settings)],
    ['Wikipedia', ()=>lookupWikipediaPageImage(cleaned, year)],
    ['Wikipedia search', ()=>looseWikipediaCandidates(cleaned.title)],
    ['Wikidata', ()=>lookupWikidata(cleaned, year)]
  );
  const results=await Promise.all(jobs.map(([name, run])=>run().catch(e=>{warn(name, e); return null;})));
  const all=[];
  const seen=new Set();
  // Titles that ARE the search term ("10") come before ones that merely contain it ("The Last 10 Years").
  const wanted=new Set(buildTitleVariants(cleaned.title, year).map(simpleText));
  const push=r=>{
    const url=r?.posterUrl || r?.url;
    if(!url) return;
    const key=coverUrlKey(url);
    if(seen.has(key)) return;
    seen.add(key);
    all.push({
      url,
      source:r.provider || r.source || 'Cover',
      label:r.title || r.label || '',
      year:r.year || '',
      score:Math.round((r.confidence || 0) * 100),
      exact:wanted.has(simpleText(stripArticleQualifier(r.title || r.label || ''))),
      votes:r.votes || 0,   // TMDB vote count: among same-named films the well-known one comes first
      rejected:isRejected(url)
    });
  };
  results.forEach(r=>[].concat(r || []).forEach(push));
  all.sort((a,b)=>(a.rejected-b.rejected) || (b.exact-a.exact) || ((b.source==='TMDB')-(a.source==='TMDB')) || (b.votes-a.votes) || (b.score-a.score));
  return all.slice(0,30);
}

/* ---------- iTunes ---------- */
async function itunesSearch(term, settings, limit=35){
  const url=new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', term);
  url.searchParams.set('media','movie');
  url.searchParams.set('entity','movie');
  url.searchParams.set('country', settings.itunesCountry || 'US');
  url.searchParams.set('limit', String(limit));
  if(!itunesUseJsonp){
    try{return await fetchJson(url.toString());}
    catch(e){if(!(e instanceof TypeError)) throw e;}   // TypeError = network/CORS failure: retry as JSONP
  }
  const data=await jsonpFetch(url.toString());
  itunesUseJsonp=true;   // CORS is blocked here, so skip the doomed fetch() from now on (it would double the request count)
  return data;
}
/* JSONP for APIs that support &callback=. Always removes the script tag and the global callback. */
function jsonpFetch(url, timeoutMs=8500){
  return new Promise((resolve, reject)=>{
    const name='__mvJsonp'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    const target=new URL(url);
    target.searchParams.set('callback', name);
    const script=document.createElement('script');
    let timer=0, done=false;
    const finish=(ok, value)=>{
      if(done) return;
      done=true;
      clearTimeout(timer);
      script.onerror=null;
      script.remove();
      delete window[name];   // success, error and timeout all clean up (a response arriving after a timeout is simply ignored)
      if(ok) resolve(value); else reject(value);
    };
    window[name]=data=>finish(true, data);
    script.onerror=()=>finish(false, coverError('network', 'JSONP request failed'));
    timer=setTimeout(()=>finish(false, coverError('timeout', 'JSONP request timed out')), timeoutMs);
    script.src=target.toString();
    document.head.appendChild(script);
  });
}
function scoreItunesItems(items, cleaned, variant, year){
  return (items || []).filter(item=>item.artworkUrl100).map(item=>{
    const itemYear=item.releaseDate ? String(item.releaseDate).slice(0,4) : '';
    const titleScore=Math.max(coverTitleScore(cleaned, variant, item.trackName), coverTitleScore(cleaned, variant, item.collectionName));
    const yearScore=year && itemYear===year ? .14 : year && itemYear!==year ? -.07 : 0;
    const movieBonus=item.wrapperType==='track' && item.kind==='feature-movie' ? .04 : 0;
    return normalizeResult({provider:'iTunes', confidence:Math.min(.86, titleScore + yearScore + movieBonus), title:item.trackName || item.collectionName || '', year:itemYear, posterUrl:upgradeArtworkUrl(item.artworkUrl100), pageUrl:item.trackViewUrl || item.collectionViewUrl || ''});
  });
}
/* Fuzzy similarity of a candidate name to the cleaned title or to the query variant (picker only). */
function coverTitleScore(cleaned, variant, name){
  return name ? Math.max(similarity(cleaned.title, name), similarity(variant, name)) : 0;
}
async function gatherItunesCandidateList(cleaned, year, settings){
  const variants=buildTitleVariants(cleaned.title, year);
  const out=[];
  for(const variant of variants.slice(0,4)){
    try{
      const data=await itunesSearch(variant, settings, 18);
      out.push(...scoreItunesItems(data.results, cleaned, variant, year).filter(c=>c.confidence>=.36));
    }catch(e){
      if(e?.kind==='ratelimit' || !out.length) throw e;   // keep what the earlier variants found
    }
  }
  return out.sort((a,b)=>b.confidence-a.confidence).slice(0,24);
}
function upgradeArtworkUrl(url, size='1200x1800'){
  if(!url) return url;
  return String(url)
    .replace(/\d+x\d+(bb|sr)?\.(jpg|png|jpeg)$/i,`${size}bb.$2`)
    .replace(/\/\d+x\d+bb\./,`/${size}bb.`)
    .replace(/\/\d+x\d+bb\//,`/${size}bb/`)
    .replace('100x100bb',`${size}bb`)
    .replace('100x100',size);
}

/* ---------- TMDB (optional; used first when an API key is set) ---------- */
async function tmdbRequest(path, params, key){
  const url=new URL('https://api.themoviedb.org/3'+path);
  for(const [k,v] of Object.entries(params || {})) if(v) url.searchParams.set(k, v);
  const options={};
  if(key.startsWith('eyJ')) options.headers={Authorization:'Bearer '+key};   // v4 read-access token (a JWT)
  else url.searchParams.set('api_key', key);                                  // v3 API key
  try{return await fetchJson(url.toString(), options);}
  catch(e){
    if(e?.status===401){
      if(!tmdbRejected) coverNotify('TMDB rejected the API key. Check it in Cover settings.');
      tmdbRejected=true;
      throw coverError('auth', 'TMDB key rejected', 401);
    }
    throw e;
  }
}
/* /search/movie for one title (plus the year when known; without it again if that finds nothing). */
async function tmdbSearch(query, year, key){
  let data=await tmdbRequest('/search/movie', {query, year, include_adult:'false'}, key);
  if(year && !(data.results || []).length) data=await tmdbRequest('/search/movie', {query, include_adult:'false'}, key);
  return data.results || [];
}
async function gatherTmdbCandidateList(cleaned, year, settings){
  const variants=buildTitleVariants(cleaned.title, year);
  const out=[];
  for(const variant of variants.slice(0,3)){
    for(const r of await tmdbSearch(variant, year, settings.tmdbKey)){
      if(!r.poster_path) continue;
      const itemYear=r.release_date ? String(r.release_date).slice(0,4) : '';
      const yearScore=year && itemYear===year ? .14 : year && itemYear!==year ? -.07 : 0;
      const confidence=Math.min(.9, Math.max(coverTitleScore(cleaned, variant, r.title), coverTitleScore(cleaned, variant, r.original_title)) + yearScore);
      if(confidence>=.36) out.push({...normalizeResult({provider:'TMDB', confidence, title:r.title || r.original_title || '', year:itemYear, posterUrl:'https://image.tmdb.org/t/p/w500'+r.poster_path, pageUrl:'https://www.themoviedb.org/movie/'+r.id}), votes:r.vote_count || 0});
    }
  }
  return out.sort((a,b)=>b.confidence-a.confidence).slice(0,10);
}

/* ---------- Title cleaning / variants / similarity ---------- */
/* Typographic quotes to plain ones: Wikipedia and iTunes titles use ' and ", collection titles often have ’ (DADDY’S HOME). */
function normalizeQuotes(text){return String(text ?? '').replace(/[‘’ʼ´`]/g,"'").replace(/[“”]/g,'"');}
function normalizeTitle(rawTitle){
  let title=normalizeQuotes(rawTitle || '').trim();
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
  if(!title && year){year=''; removed.pop();}   // the whole title is a number ("1917"): it is the title, not a release year
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
  title=title.replace(/\s+/g,' ').trim();
  // Collection shorthand: "HEAT SE", "GHOST SE 8", "CASABLANCA LD", and a lone trailing A/B marking a second copy ("TOP GUN A").
  // A trailing A/B is only a marker when a real title (2+ words) remains: "PROJECT A" is a title.
  title=title.replace(/\s+(?:SE|LD|CE)(?:\s*\d+)?$/i,match=>{removed.push(match.trim()); return '';}).trim();
  title=title.replace(/\s+[AB]$/i,match=>{if(title.split(' ').length<3) return match; removed.push(match.trim()); return '';}).trim();
  title=title.replace(/\s+[:\-–—]\s*$/g,'').replace(/\s+/g,' ').trim();
  return {original, title:title || original, year, removed:[...new Set(removed.filter(Boolean))], cacheKey:`${(title || original).toLowerCase()}|${year || ''}`};
}
function cleanMovieTitle(t){return normalizeTitle(t).title;}
function looksLikeEditionOrFormat(text){
  return /\b(4k|uhd|dvd|blu[\s-]?ray|steel\s*book|steelbook|3d|criterion|remaster|collector|special|limited|extended|director|theatrical|region|disc|signature|diamond|digibook|mediabook)\b/i.test(text);
}
/* JSON GET with a timeout. Throws errors tagged `kind`: 'ratelimit' (HTTP 429; also pauses the auto queue), 'http', 'timeout',
   or the original TypeError (kind 'network') when the request could not be made at all (offline, blocked, CORS). */
async function fetchJson(url, options={}, timeoutMs=8500){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(), timeoutMs);
  const signal=options.signal || controller.signal;
  try{
    const response=await fetch(url, {...options, signal});
    if(response.status===429){noteCoverRateLimit(); throw coverError('ratelimit', 'HTTP 429', 429);}
    if(!response.ok) throw coverError('http', `HTTP ${response.status}`, response.status);
    let data;
    try{data=await response.json();}catch(_){throw coverError('http', 'Invalid JSON');}
    if(data?.error?.code){   // MediaWiki reports some failures as HTTP 200 with an error object
      const limited=/ratelimit/i.test(data.error.code);
      if(limited) noteCoverRateLimit();
      throw coverError(limited ? 'ratelimit' : 'http', data.error.info || data.error.code);
    }
    return data;
  }catch(e){
    if(e?.name==='AbortError') throw coverError('timeout', 'Request timed out');
    if(e instanceof TypeError && !e.kind) e.kind='network';
    throw e;
  }finally{clearTimeout(timeout);}
}

/* ---------- Wikipedia (picker) ---------- */
/* Best exact-title film article with a poster. Reads the wikitext of ONE page only as a last resort (accepted page, no page image). */
async function lookupWikipediaPageImage(cleaned, year){
  const variants=buildTitleVariants(cleaned.title, year);
  const lookupYear=year || inferYearFromTitle(cleaned.title);
  const directTitles=buildWikipediaTitleCandidates(variants, lookupYear);
  let noImage=null;   // first accepted page without a page image: only used as a last resort
  const consider=(candidates, cap)=>{
    for(const candidate of candidates){
      const image=candidate.page.thumbnail?.source || candidate.page.original?.source;
      if(!image){noImage=noImage || candidate; continue;}
      return wikipediaResult(candidate, image, 'Wikipedia Infobox/PageImages', cap, lookupYear);
    }
    return null;
  };
  for(let i=0;i<directTitles.length;i+=20){
    const data=await wikiQuery({...WIKI_PAGE_PROPS, titles:directTitles.slice(i,i+20).join('|'), redirects:'1'});
    const pages=pagesFromWikiResponse(data).filter(page=>!page.missing);
    const found=consider(pages.map(page=>scoreWikipediaPage(page, variants, cleaned.title, lookupYear, true)).filter(c=>c.accepted).sort((a,b)=>b.score-a.score), .94);
    if(found) return found;
  }
  for(const variant of variants.slice(0,4)){
    const data=await wikiQuery({...WIKI_PAGE_PROPS, generator:'search', gsrsearch: lookupYear ? `${variant} ${lookupYear} film` : `${variant} film`, gsrlimit:'8'});
    const found=consider(pagesFromWikiResponse(data).map(page=>scoreWikipediaPage(page, variants, cleaned.title, lookupYear, false)).filter(c=>c.accepted).sort((a,b)=>b.score-a.score), .88);
    if(found) return found;
  }
  if(noImage){
    const image=await getWikipediaInfoboxPosterUrl(noImage.page);
    if(image) return wikipediaResult(noImage, image.url, 'Wikipedia Infobox', .88, lookupYear);
  }
  return null;
}
function wikipediaResult(candidate, url, provider, cap, lookupYear){
  return normalizeResult({provider, confidence:Math.min(cap, candidate.score), title:stripArticleQualifier(candidate.page.title), year:candidate.year || lookupYear || '', posterUrl:url, pageUrl:'https://en.wikipedia.org/wiki/'+encodeURIComponent(String(candidate.page.title).replace(/ /g,'_'))});
}
function pagesFromWikiResponse(data){
  const pages=data.query?.pages || [];
  return Array.isArray(pages) ? pages : Object.values(pages);
}
async function getWikipediaInfoboxPosterUrl(page){
  const data=await wikiQuery({titles:page.title, prop:'revisions', rvprop:'content', rvslots:'main'});
  const fileName=extractInfoboxImageFileName(extractWikiText(pagesFromWikiResponse(data)[0] || {}));
  if(!fileName) return null;
  const info=await wikiQuery({titles:`File:${fileName}`, prop:'imageinfo', iiprop:'url|mime|size', iiurlwidth:'500'});
  const imageInfo=pagesFromWikiResponse(info)[0]?.imageinfo?.[0];
  const url=imageInfo?.thumburl || imageInfo?.url;
  return url ? {url, fileName} : null;
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
    const cleaned=compactSpaces(String(value).replace(/\|/g,' '));
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
  const textBlob=`${articleTitle} ${page.description || ''} ${page.extract || ''}`.toLowerCase();
  const articleSimple=simpleText(articleTitle);
  const bareSimple=simpleText(bareTitle);
  const variantSimples=variants.map(simpleText).filter(Boolean);
  const requestedSimple=simpleText(requestedTitle);
  const pageYear=extractYearFromText(`${articleTitle} ${page.description || ''} ${page.extract || ''}`);
  const hasFilmSignals=textBlob.includes('film') || textBlob.includes('directed by') || textBlob.includes('starring') || textBlob.includes('screenplay') || textBlob.includes('animated');
  const hasImage=Boolean(page.thumbnail?.source || page.original?.source || page.pageimage);
  const exactBareMatch=variantSimples.includes(bareSimple) || bareSimple===requestedSimple;
  const exactQualifiedMatch=variantSimples.some(value=>articleSimple===simpleText(`${value} film`) || articleSimple===simpleText(`${value} ${year || ''} film`));
  const yearOk=!year || pageYear===String(year) || articleTitle.includes(String(year));
  const qualifier=(articleTitle.match(/\(([^)]*)\)\s*$/) || [])[1] || '';
  const qualifierOk=!qualifier || /film|movie|animated|series|tv/i.test(qualifier);   // "Heat (band)" is not the film
  let accepted=hasFilmSignals && yearOk && qualifierOk && !isDisambiguation(page) && (exactBareMatch || exactQualifiedMatch);
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
/* Picker only: Wikipedia's fuzzy full-text search finds misremembered titles ("3 days in the condor" -> "Three Days of the Condor"). */
async function looseWikipediaCandidates(term){
  const queries=[...new Set([term, numberWordVariant(term)].filter(Boolean))];
  const out=[], seenPages=new Set();
  for(const query of queries){
    const data=await wikiQuery({generator:'search', gsrsearch:`${query} film`, gsrlimit:'10', gsrnamespace:'0', prop:'pageimages|pageprops', piprop:'thumbnail', pilicense:'any', pithumbsize:'500', pilimit:'max', ppprop:'disambiguation'});
    for(const p of pagesFromWikiResponse(data)){
      if(!p.thumbnail?.source || isDisambiguation(p) || seenPages.has(p.pageid)) continue;
      seenPages.add(p.pageid);
      out.push({provider:'Wikipedia search', confidence:Math.min(.7, .25 + Math.max(similarity(term, stripArticleQualifier(p.title)), similarity(query, stripArticleQualifier(p.title)))*.45), title:p.title, year:extractYearFromText(p.title), posterUrl:p.thumbnail.source});
    }
  }
  return out;
}
function inferYearFromTitle(title){
  const key=simpleText(title);
  const knownYears={se7en:'1995', alien:'1979'};
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

/* ---------- Wikidata (picker only) ---------- */
// P18 ("image") is normally a photo, not a poster, so Wikidata never feeds automatic assignment. P3383 ("film poster") is preferred when present.
async function lookupWikidata(cleaned, year){
  const searchData=await fetchJson(wikidataUrl({action:'wbsearchentities', search:cleaned.title, language:'en', limit:'8'}));
  const ids=(searchData.search || []).map(item=>item.id).slice(0,8);
  if(!ids.length) return null;
  const entityData=await fetchJson(wikidataUrl({action:'wbgetentities', ids:ids.join('|'), props:'claims|labels|descriptions', languages:'en'}));
  const scored=[];
  for(const entity of Object.values(entityData.entities || {})){
    const claims=entity.claims || {};
    const isFilm=(claims.P31 || []).some(claim=>claim.mainsnak?.datavalue?.value?.id==='Q11424');
    const posterClaim=(claims.P3383 || [])[0]?.mainsnak?.datavalue?.value;
    const imageClaim=posterClaim || (claims.P18 || [])[0]?.mainsnak?.datavalue?.value;
    const publicationYear=extractWikidataYear(claims.P577);
    const title=entity.labels?.en?.value || '';
    if(!isFilm || !imageClaim) continue;
    const titleScore=similarity(cleaned.title, title);
    const yearScore=year && publicationYear===year ? .16 : 0;
    scored.push(normalizeResult({provider:posterClaim ? 'Wikidata/P3383' : 'Wikidata/P18', confidence:Math.min(posterClaim ? .95 : .76, titleScore + yearScore), title, year:publicationYear, posterUrl:commonsImageUrl(imageClaim, 500), pageUrl:`https://www.wikidata.org/wiki/${entity.id}`}));
  }
  scored.sort((a,b)=>b.confidence-a.confidence);
  const best=scored[0];
  return best && best.confidence>=.42 ? best : null;
}
function wikidataUrl(params){
  const url=new URL('https://www.wikidata.org/w/api.php');
  for(const [k,v] of Object.entries({format:'json', origin:'*', ...params})) url.searchParams.set(k, v);
  return url.toString();
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
  return {provider:result.provider, confidence:Number(result.confidence || 0), title:result.title || '', year:result.year || '', posterUrl:result.posterUrl || '', altUrl:result.altUrl || '', pageUrl:result.pageUrl || ''};
}

/* ---------- Title variants ---------- */
const NUMBER_WORDS={'1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine','10':'ten','11':'eleven','12':'twelve','13':'thirteen','14':'fourteen','15':'fifteen','16':'sixteen','17':'seventeen','18':'eighteen','19':'nineteen','20':'twenty'};
function buildTitleVariants(title, year='', auto=false){
  const base=compactSpaces(normalizeQuotes(title));
  const variants=[];
  const add=value=>{
    const cleaned=compactSpaces(normalizeQuotes(value));
    if(!cleaned) return;
    if(!variants.some(existing=>simpleText(existing)===simpleText(cleaned))) variants.push(cleaned);
  };
  add(base);
  add(base.split(':').join(' '));
  add(base.split('’').join(''));
  add(base.split("'").join(''));
  // Digits-for-letters only inside a word that mixes letters and digits (SE7EN, S1M0NE). Never for plain numbers: 10 -> "io" matched the film "IO".
  const mixed=w=>/[a-z]/i.test(w) && /\d/.test(w);
  if(base.split(' ').some(mixed)) add(base.split(' ').map(w=>mixed(w) ? leetToWords(w) : w).join(' '));
  // Standalone numbers as words ("3 Days of the Condor" -> "three Days..."). A bare number title ("10" -> "ten") only for the manual picker.
  const words=numberWordVariant(base);
  if(words && !(auto && /^\d+$/.test(simpleText(base).replace(/ /g,'')))) add(words);
  const known={'se7en':'Seven','wall e':'WALL-E','walle':'WALL-E','mi':'Mission: Impossible','fifth element':'The Fifth Element','wonderful life':'It’s a Wonderful Life','the mermaid':'The Little Mermaid','hunchback':'The Hunchback of Notre Dame'};
  const key=simpleText(base);
  if(known[key]) add(known[key]);
  if(year && base.includes(String(year))) add(base.split(String(year)).join(''));
  return variants.slice(0,8);
}
function numberWordVariant(title){
  let changed=false;
  const out=String(title || '').split(' ').map(w=>{if(NUMBER_WORDS[w]){changed=true; return NUMBER_WORDS[w];} return w;}).join(' ');
  return changed ? out : '';
}
function compactSpaces(value){return String(value || '').split(' ').filter(Boolean).join(' ').trim();}
function leetToWords(title){return String(title || '').split('0').join('o').split('1').join('i').split('3').join('e').split('4').join('a').split('5').join('s').split('7').join('v');}
function normalizeSearchText(t){return simpleText(t);}
function simpleText(value){
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\b(the|a|an)\b/g,' ').replace(/\s+/g,' ').trim();
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

/* ---------- Card DOM helpers (moved here from app.js) ---------- */
function cardById(id){
  return els.movieGrid ? els.movieGrid.querySelector(`.card[data-id="${CSS.escape(String(id))}"]`) : null;
}
function markCardLoading(id,on){
  const cover=cardById(id)?.querySelector('.cover');
  if(cover) cover.classList.toggle('loading',!!on);
}
/* Redraws one card's "Check cover" chip and Keep / Wrong cover? buttons from the movie's current state (no full render). */
function syncCardCoverFlags(id){
  const card=cardById(id), m=state.movies.find(x=>x.id===id);
  if(!card || !m) return;
  card.querySelectorAll('.checkPill, [data-keep-cover], [data-wrong-cover]').forEach(n=>n.remove());
  const chip=coverChipHtml(m), buttons=coverButtonsHtml(m), actions=card.querySelector('.cardActions');
  if(chip) card.querySelector('.meta .chip')?.insertAdjacentHTML('afterend', chip);
  if(buttons && actions){
    let extra=card.querySelector('.cardExtra');
    if(!extra){extra=document.createElement('div'); extra.className='cardExtra'; actions.after(extra);}
    extra.insertAdjacentHTML('beforeend', buttons);
  }
}
function updateCardPoster(id,poster,title){
  const card=cardById(id);
  if(!card) return;
  markCardLoading(id,false);
  card.dataset.needsPoster='false';
  const cover=card.querySelector('.cover');
  if(cover){
    const existing=cover.querySelector('img');
    if(existing) existing.src=poster;
    else cover.insertAdjacentHTML('afterbegin', `<img src="${escapeHtml(poster)}" alt="Cover for ${escapeHtml(title)}" loading="lazy">`);   // a failing load is handled by onCoverImageError
  }
  card.querySelectorAll('.posterRemovedPill').forEach(chip=>chip.remove());
  syncCardCoverFlags(id);   // "Check cover" / Keep / Wrong cover? depend on where the cover came from
}
function removePoster(id, opts={}){
  const m=state.movies.find(x=>x.id===id); if(!m) return;
  if(!m.poster && m.posterRemoved===true){toast('Poster is already removed for this title.'); return;}
  if(m.poster) rejectCover(m.title, m.poster);   // also drops the title's cache entry: a wrong auto match must not come back from the cache
  m.poster=''; delete m.posterSource; delete m.posterSuggestion;
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
/* "Wrong cover?" on a card with an automatic, flagged or old-version cover: blacklist that URL (and its cache entry) like removePoster does, then open the picker for a replacement.
   A suggestion stored by "Check old covers" goes into the picker, where it is listed first. */
function wrongCover(id){
  const m=state.movies.find(x=>x.id===id); if(!m || !m.poster) return;
  const suggestion=m.posterSuggestion || '';
  rejectCover(m.title, m.poster);
  m.poster=''; delete m.posterSource; delete m.posterSuggestion;
  m.posterRemoved=true;   // like removePoster: no automatic retry; the picker (or "Choose poster" later) picks the replacement
  m.updated=today();
  autoCoverQueued.delete(id);
  autoCoverFailedSession.add(id);
  save();
  render();
  quickPosterLookup(id, {suggestion});
}
/* A saved poster that no longer loads would leave a blank gradient card (its title is hidden while a poster is set).
   Reset the card to "needs poster" state instead, and forget the dead URL. */
function onCoverImageError(e){
  const img=e.target;
  if(!img || img.tagName!=='IMG' || !img.matches('.card .cover img')) return;
  const card=img.closest('.card'), id=card?.dataset.id;
  const m=id && state.movies.find(x=>x.id===id);
  if(!m || !m.poster || img.getAttribute('src')!==m.poster) return;   // ignore stale events from a src that was already replaced
  rejectCover(m.title, m.poster);   // blacklists the dead URL and deletes this title's cache entries
  m.poster=''; delete m.posterSource; delete m.posterSuggestion;   // posterRemoved stays as it was: this is not a user decision
  m.updated=today();
  autoCoverQueued.delete(id);
  autoCoverFailedSession.add(id);   // do not retry in a loop this session
  save();
  card.dataset.needsPoster='true';
  card.querySelectorAll('.cover img').forEach(i=>i.remove());
  markCardLoading(id,false);
  syncCardCoverFlags(id);
}
