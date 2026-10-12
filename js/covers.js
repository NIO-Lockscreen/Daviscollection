/* ---------- Cover / poster lookup: manual picker + automatic lookup for visible cards ---------- */
let posterPickerState = null;
let coverObserver = null;
const autoCoverQueue = [];
const autoCoverQueued = new Set();
const autoCoverRunning = new Set();
const autoCoverFailedSession = new Set();
const COVER_CACHE_PREFIX = 'movieVault.smartCoverCache:v7:';
const COVER_SUCCESS_CACHE_DAYS = 60;
const COVER_FAIL_CACHE_DAYS = 2;
const AUTO_COVER_CONCURRENCY = 2;

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
