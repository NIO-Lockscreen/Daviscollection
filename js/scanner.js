/* ---------- Barcode lookup + camera scanner ---------- */
const LOOKUP_URL='https://api.upcitemdb.com/prod/trial/lookup?upc=';
const LOOKUP_TIMEOUT_MS=8000;
const NATIVE_FORMATS=['ean_13','ean_8','upc_a','upc_e','code_128','code_39'];
const NATIVE_MAX_ERRORS=10;      // consecutive detect() errors before giving up on the native detector
const QUAGGA_URL='https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js';
const QUAGGA_SRI='sha384-IkRTkdAeAAAqE2ct5zNAfMiX8+H35pGJp8j7+ZFwh7PKaJh5eunsOFAb9l6Z9R7r';
const QUAGGA_READERS=['ean_reader','ean_8_reader','upc_reader','upc_e_reader','code_128_reader','code_39_reader'];
const QUAGGA_CONFIRM_MS=2000;    // Quagga must read the same code twice within this window
const SCAN_COOLDOWN_MS=2500;     // continuous targets (phone scanner): the same code is reported again only after it was out of view this long
let scanTarget=null;             // where the running camera draws and reports, see addScanTarget(); remote-scan.js passes its own
let scanRecent=new Map();        // code -> last time it was seen (continuous targets only)
let scanStream=null;
let scanTimer=null;
let scanDetector=null;
let scanSession=0;               // bumped on every start/stop so stale async work can bail out
let scanMsg='';
let nativeErrors=0;
let quaggaLoading=null;
let quaggaInit=null;
let quaggaActive=false;
let quaggaHit=null;
let lookupSeq=0;
let lookupCtl=null;
let ownedNote='';
let warnedKey='';

/* ---- barcode validation + duplicate guard ---- */
function normalizeBarcode(c){c=String(c||'').trim(); return /^[\d\s-]+$/.test(c)?c.replace(/[\s-]/g,''):c}
function barcodeKey(c){c=normalizeBarcode(c); return /^\d+$/.test(c)?c.replace(/^0+/,''):c.toLowerCase()}
// EAN-13 / UPC-A / EAN-8 / GTIN-14: weights 3,1,3,1… counted from the digit next to the check digit
function gtinCheckOk(c){let s=0; for(let i=c.length-2,w=3;i>=0;i--,w=4-w) s+=(+c[i])*w; return (10-s%10)%10===+c[c.length-1]}
// UPC-E (8 digits) is validated through its UPC-A expansion
function upcEToA(c){
  const d=c.slice(1,7), l=d[5];
  const body=l<='2'?d.slice(0,2)+l+'0000'+d.slice(2,5):l==='3'?d.slice(0,3)+'00000'+d.slice(3,5):l==='4'?d.slice(0,4)+'00000'+d[4]:d.slice(0,5)+'0000'+l;
  return c[0]+body+c[7];
}
function isRetailLength(c){return /^\d+$/.test(c) && [8,12,13,14].includes(c.length)}
function retailCheckOk(c){return gtinCheckOk(c) || (c.length===8 && /^[01]/.test(c) && gtinCheckOk(upcEToA(c)))}
function isValidBarcode(code,format){
  code=String(code||'').trim();
  if(isRetailLength(code)) return retailCheckOk(code);
  return /^code_(128|39)$/.test(format||'') && code.length>=6;   // non-retail Code 128 / Code 39
}
function findOwnedByBarcode(code){
  const k=barcodeKey(code); if(!k) return null;
  const hits=(state.movies||[]).filter(m=>m.barcode && barcodeKey(m.barcode)===k);
  return hits.length?{movie:hits[0],count:hits.length}:null;
}
function ownedMessage(o){return `You already own this: ${o.movie.title} (${o.movie.section||'no section'})`+(o.count>1?` + ${o.count-1} more with this barcode`:'')}
// Shows/clears the duplicate warning in the scan status; toasts when it newly applies (or always when force)
function checkOwned(code,force=false){
  const o=findOwnedByBarcode(code), key=o?barcodeKey(code):'';
  ownedNote=o?ownedMessage(o)+'.':'';
  if(o && (force || key!==warnedKey)) toast(ownedMessage(o));
  warnedKey=key;
  setScanStatus(scanMsg);
  return o;
}

/* ---- status + Google fallback ---- */
function setScanStatus(msg){
  scanMsg=msg||'';
  els.scanStatus.textContent=[ownedNote,scanMsg].filter(Boolean).join('\n');   // .scanStatus is white-space:pre-line
  els.scanStatus.classList.toggle('warn',!!ownedNote);
}
function showSearchFallback(code){
  const box=$('scanFallback'), a=$('scanGoogleLink'); if(!box||!a) return;
  a.href='https://www.google.com/search?q='+encodeURIComponent(code);
  a.textContent='Search Google for '+code;
  box.hidden=false;
}
function hideSearchFallback(){const box=$('scanFallback'); if(box) box.hidden=true}

/* ---- barcode lookup ---- */
/* Asks upcitemdb about a barcode. Never throws, has its own timeout, and signal (optional) cancels it.
   Returns {ok:true,item,title,poster,notes} or {ok:false,kind,msg,status?}.
   kind: rate | server | refused | unreadable | service | none | timeout | network | aborted (aborted = the caller's signal fired). */
async function fetchBarcodeInfo(code, signal){
  code=normalizeBarcode(code);
  const ctl=new AbortController(), fail=(kind,msg,status)=>({ok:false,kind,msg,status});
  const onAbort=()=>ctl.abort();
  if(signal){if(signal.aborted) ctl.abort(); else signal.addEventListener('abort',onAbort,{once:true});}
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true; ctl.abort();},LOOKUP_TIMEOUT_MS);
  try{
    const res=await fetch(LOOKUP_URL+encodeURIComponent(code),{signal:ctl.signal});
    if(!res.ok){
      if(res.status===429) return fail('rate','Daily barcode lookup limit reached (the free service allows only about 100 a day). Try again tomorrow.',429);
      if(res.status>=500) return fail('server',`Barcode service is down or busy right now (HTTP ${res.status}).`,res.status);
      return fail('refused',`Barcode service refused the lookup (HTTP ${res.status}).`,res.status);
    }
    let data=null;
    try{data=await res.json();}catch(e){if(ctl.signal.aborted) throw e;}   // aborted = timeout / superseded, handled below
    if(!data) return fail('unreadable','Barcode service sent an unreadable reply (captive portal or outage?).');
    const item=data.items && data.items[0];
    if(item) return {ok:true, item, title:cleanLookupTitle(item.title || ''), poster:item.images?.[0] || '', notes:[item.brand, item.description].filter(Boolean).join(' — ').slice(0,350)};
    if(data.code && data.code!=='OK') return fail('service',`Barcode service said: ${data.message||data.code}.`);
    return fail('none','No product data found for this barcode.');
  }catch(e){
    if(timedOut) return fail('timeout',`Barcode lookup timed out after ${LOOKUP_TIMEOUT_MS/1000} seconds.`);
    if(ctl.signal.aborted) return fail('aborted','Lookup cancelled.');
    return fail('network','Could not reach the barcode service (offline or blocked).');
  }finally{
    clearTimeout(timer);
    if(signal) signal.removeEventListener('abort',onAbort);
  }
}
async function lookupBarcode(code, fillForm=false){
  code=normalizeBarcode(code);
  if(!code){toast('Scan or type a barcode first.'); return;}
  if(els.newBarcode.value!==code) els.newBarcode.value=code;
  hideSearchFallback();
  const owned=checkOwned(code,true);
  const note=isRetailLength(code) && !retailCheckOk(code) ? 'Check digit does not match, so double-check the digits. ' : '';
  const fail=reason=>{
    setScanStatus(note+reason);
    if(!owned) toast(reason);
    showSearchFallback(code);
  };
  const seq=++lookupSeq;
  if(lookupCtl) lookupCtl.abort();
  const ctl=lookupCtl=new AbortController();
  setScanStatus('Looking up barcode…');
  try{
    const r=await fetchBarcodeInfo(code,ctl.signal);
    if(seq!==lookupSeq) return;   // superseded by a newer lookup
    if(!r.ok){fail(r.msg); return;}
    if(fillForm || !els.newTitle.value.trim()) els.newTitle.value = r.title;
    if(r.poster && !els.newPoster.value.trim()) els.newPoster.value = r.poster;
    if(!els.newNotes.value.trim()) els.newNotes.value = r.notes;
    if(!owned) toast('Barcode found. Check title and section before adding.');
    setScanStatus(note+'Barcode found. Check title and section before adding.');
  }finally{
    if(lookupCtl===ctl) lookupCtl=null;
  }
}
function cleanLookupTitle(t){return String(t||'').replace(/\s+(?:\(?\s*(?:blu[- ]?ray|dvd|4k|uhd|ultra hd)\s*\)?).*$/i,'').trim()}

/* ---- camera scanner ---- */
/* The camera code serves one "target" at a time: {box,video,text,status,found,continuous}.
   box = the .scanner element (gets .active), video = its <video>, text = the overlay line, status(msg) = progress/error line,
   found(code) = called with a checksum-valid barcode. A single-shot target (the Add screen) stops the camera after a hit;
   a continuous one (the phone scanner in remote-scan.js) keeps scanning and gets each code once per SCAN_COOLDOWN_MS. */
function addScanTarget(){return {box:els.scanner, video:els.scanVideo, text:els.scannerText, status:setScanStatus, found:onBarcodeFound, continuous:false};}
function curTarget(){return scanTarget || (scanTarget=addScanTarget());}
async function startScanner(target){
  stopScanner(false);                       // releases the camera on the previous target
  const T=scanTarget=target && target.box ? target : addScanTarget();   // (a click event passed by mistake falls back to the Add screen)
  const tok=scanSession;
  scanRecent=new Map();
  if(T.box===els.scanner){hideSearchFallback(); ownedNote=''; warnedKey='';}
  if(document.hidden) return;
  T.box.classList.add('active');
  T.status('Checking camera access…');
  T.text.textContent='Point camera at barcode.';
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    T.box.classList.remove('active');
    T.text.textContent='Camera API not available.';
    T.status('Camera needs HTTPS/localhost and a browser with getUserMedia support. Type the barcode manually on this device.');
    return;
  }
  try{
    const detector=await createNativeDetector();
    if(tok!==scanSession) return;
    if(detector){
      const stream=await openBestCameraStream();
      if(tok!==scanSession){stopTracks(stream); return;}
      scanStream=stream; scanDetector=detector; nativeErrors=0;
      const v=T.video;
      v.muted=true; v.playsInline=true; v.setAttribute('playsinline',''); v.setAttribute('muted','');
      v.srcObject=stream;
      await v.play();
      if(tok!==scanSession) return;
      T.status('Camera started. Scanning with native barcode detector…');
      nativeScanLoop(tok);
    }else{
      T.status('This browser cannot read barcodes natively. Starting fallback scanner…');
      await startQuaggaFallback(tok);
    }
  }catch(e){
    if(tok===scanSession) failScanner(cameraErrorMessage(e),'Camera could not start.');
  }
}
function failScanner(msg,text){
  const T=curTarget();
  stopScanner(false);
  T.text.textContent=text;
  T.status(msg);
}
// A barcode was read: single-shot targets get it once and the camera stops (returns true); continuous ones keep going (returns false).
function deliverBarcode(raw){
  const T=curTarget(), code=normalizeBarcode(raw);
  if(!T.continuous){T.found(code); return true;}
  const now=Date.now(), seen=scanRecent.get(code);
  scanRecent.set(code,now);                 // a code that stays in view keeps its cooldown running
  for(const [c,t] of scanRecent) if(now-t>=SCAN_COOLDOWN_MS) scanRecent.delete(c);
  if(seen===undefined || now-seen>=SCAN_COOLDOWN_MS) T.found(code);
  return false;
}
function stopTracks(s){if(s && s.getTracks) s.getTracks().forEach(t=>{try{t.stop()}catch(_){}})}

/* Some browsers (notably desktop Chrome and some Android WebViews) expose BarcodeDetector
   but support zero barcode formats. Only use it when it can really detect something. */
async function createNativeDetector(){
  if(!('BarcodeDetector' in window)) return null;
  try{
    const supported=typeof BarcodeDetector.getSupportedFormats==='function' ? await BarcodeDetector.getSupportedFormats() : [];
    const formats=NATIVE_FORMATS.filter(f=>(supported||[]).includes(f));
    return formats.length ? new BarcodeDetector({formats}) : null;
  }catch(_){return null}
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
function cameraErrorMessage(e){
  const name=e?.name || '';
  if(location.protocol!=='https:' && location.hostname!=='localhost' && location.hostname!=='127.0.0.1') return 'Camera blocked: open the app on HTTPS or localhost. Browser camera permission will not work from plain HTTP/file links.';
  if(name==='NotAllowedError' || name==='SecurityError') return 'Camera permission was blocked. Use the browser lock/camera icon, allow camera for this site, then press Start scan again.';
  if(name==='NotFoundError' || name==='OverconstrainedError') return 'No usable camera was found. I tried back camera, any camera, and generic video. Type the barcode manually on this device.';
  if(name==='NotReadableError') return 'Camera is already in use by another app/tab. Close other camera apps and try again.';
  return 'Camera failed after permission. I tried back camera, any camera and fallback scanner. Type barcode manually if this browser still blocks it.';
}

async function nativeScanLoop(tok){
  const T=curTarget(), v=T.video;
  if(tok!==scanSession || !scanDetector || !v.srcObject) return;
  if(v.readyState>=2){   // skip frames until the video has data, so early InvalidStateErrors do not count
    try{
      const codes=await scanDetector.detect(v);
      if(tok!==scanSession) return;
      nativeErrors=0;
      const hit=(codes||[]).find(c=>isValidBarcode(c.rawValue,c.format));
      if(hit && deliverBarcode(hit.rawValue)) return;
      if(tok!==scanSession || !scanDetector) return;   // found() may have stopped the camera
    }catch(e){
      if(tok!==scanSession) return;
      if(++nativeErrors>=NATIVE_MAX_ERRORS){   // detect() keeps throwing: the native detector is broken on this device
        T.status('Native detector is not working here. Switching to fallback scanner…');
        releaseCamera();
        await startQuaggaFallback(tok);
        return;
      }
    }
  }
  scanTimer=setTimeout(()=>nativeScanLoop(tok),100);
}

/* Quagga2 is pinned to an exact version (+ SRI hash). Its LiveStream mode reuses the first <video>
   inside the target, i.e. #scanVideo, which keeps its playsinline + muted attributes (iOS Safari)
   and must stay visible (iOS does not decode frames for display:none videos). */
function loadQuagga(){
  if(window.Quagga) return Promise.resolve(window.Quagga);
  if(!quaggaLoading) quaggaLoading=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src=QUAGGA_URL; s.integrity=QUAGGA_SRI; s.crossOrigin='anonymous';
    s.onload=()=>window.Quagga?resolve(window.Quagga):reject(Object.assign(new Error('Quagga missing'),{load:true}));
    s.onerror=()=>{s.remove(); reject(Object.assign(new Error('Quagga failed to load'),{load:true}));};
    document.head.appendChild(s);
  }).catch(e=>{quaggaLoading=null; throw e;});
  return quaggaLoading;
}
async function startQuaggaFallback(tok){
  try{
    const Q=await loadQuagga();
    if(quaggaInit){try{await quaggaInit}catch(_){}}          // a cancelled start may still be initialising
    await new Promise(r=>setTimeout(r,30));                  // let a previous Quagga.stop() finish tearing down
    if(tok!==scanSession) return;
    quaggaActive=true; quaggaHit=null;
    const T=curTarget();
    // patchSize 'large': the barcode is held close, inside the guide frame, so it fills a big part of the image
    const base={decoder:{readers:QUAGGA_READERS}, locate:true, frequency:10, numOfWorkers:0, locator:{patchSize:'large', halfSample:true}};
    const attempts=[{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}, {facingMode:{ideal:'environment'}}, {}];
    let err=null;
    for(const constraints of attempts){
      quaggaInit=(async()=>Q.init({...base, inputStream:{type:'LiveStream', target:T.box, constraints}}))();
      try{await quaggaInit; err=null; break;}
      catch(e){err=e; if(tok!==scanSession || ['NotAllowedError','SecurityError','NotReadableError'].includes(e?.name)) break;}
      finally{quaggaInit=null;}
    }
    if(tok!==scanSession){releaseCamera(); return;}
    if(err) throw err;
    Q.onDetected(onQuaggaDetected);
    Q.start();
    T.status('Scanning with fallback detector…');
  }catch(e){
    if(tok!==scanSession) return;
    if(e && e.load) failScanner('Could not load the fallback scanner (offline?). Type the barcode manually.','Fallback scanner unavailable.');
    else failScanner(cameraErrorMessage(e),'Fallback scanner failed.');
  }
}
// Quagga is noisy: only accept a checksum-valid code seen twice in a row
function onQuaggaDetected(result){
  const cr=result && result.codeResult, code=cr && cr.code;
  if(!quaggaActive || !code) return;
  if(!isValidBarcode(code,cr.format)){quaggaHit=null; return;}
  const now=Date.now();
  if(quaggaHit && quaggaHit.code===code && now-quaggaHit.t<=QUAGGA_CONFIRM_MS){quaggaHit={code,t:now}; deliverBarcode(code); return;}   // (a single-shot target stops the camera, which clears quaggaHit again)
  quaggaHit={code,t:now};
}

function onBarcodeFound(code){
  code=normalizeBarcode(code);
  els.newBarcode.value=code;
  setScanStatus('Found barcode: '+code);
  stopScanner(false);
  lookupBarcode(code, true);
}
// Synchronous + idempotent: releases every camera handle we might hold
function releaseCamera(){
  if(scanTimer){clearTimeout(scanTimer); scanTimer=null;}
  scanDetector=null;
  stopTracks(scanStream); scanStream=null;
  const Q=window.Quagga;
  if(Q){
    try{Q.offDetected(onQuaggaDetected)}catch(_){}
    try{Promise.resolve(Q.stop()).catch(()=>{})}catch(_){}
    try{Promise.resolve(Q.CameraAccess && Q.CameraAccess.release()).catch(()=>{})}catch(_){}
  }
  quaggaActive=false; quaggaHit=null;
  const T=curTarget();
  T.box.querySelectorAll('video').forEach(v=>{
    stopTracks(v.srcObject); v.pause(); v.srcObject=null;
    if(v!==T.video) v.remove();
  });
  T.box.querySelectorAll('canvas').forEach(n=>n.remove());
}
function stopScanner(showToast=true){
  const T=curTarget();
  scanSession++;
  releaseCamera();
  T.box.classList.remove('active');
  T.text.textContent='Camera is off.';
  if(showToast) T.status('Scanner stopped.');
}

/* ---- init hook (called from init() in app.js) ---- */
function initScanner(){
  // the camera must never keep running in the background (whichever target uses it)
  const stopIfRunning=(why,addOnly)=>{
    const T=curTarget();
    if(addOnly && T.box!==els.scanner) return;
    if(T.box.classList.contains('active')){stopScanner(false); T.status(why);}
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden) stopIfRunning('Camera turned off because the page was hidden. Press Start scan to resume.');});
  window.addEventListener('pagehide',()=>stopIfRunning('Camera turned off.'));
  const add=$('add');
  if(add) new MutationObserver(()=>{if(!add.classList.contains('active')) stopIfRunning('Camera turned off because you left the Add screen.',true);}).observe(add,{attributes:true,attributeFilter:['class']});
  // duplicate warning while typing / pasting a barcode
  els.newBarcode.addEventListener('input',()=>{hideSearchFallback(); checkOwned(els.newBarcode.value);});
  // addMovie() clears the field on success: drop the stale warning and fallback link
  els.addMovieBtn.addEventListener('click',()=>{
    if(els.newBarcode.value.trim()) return;
    hideSearchFallback(); ownedNote=''; warnedKey=''; setScanStatus('');
  });
}
