/* ---------- Barcode lookup + camera scanner ---------- */
const LOOKUP_URL='https://api.upcitemdb.com/prod/trial/lookup?upc=';
const LOOKUP_TIMEOUT_MS=8000;
const NATIVE_FORMATS=['ean_13','ean_8','upc_a','upc_e','code_128','code_39'];
const NATIVE_MAX_ERRORS=10;      // consecutive detect() errors before giving up on the native detector
const QUAGGA_URL='https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js';
const QUAGGA_SRI='sha384-IkRTkdAeAAAqE2ct5zNAfMiX8+H35pGJp8j7+ZFwh7PKaJh5eunsOFAb9l6Z9R7r';
const QUAGGA_READERS=['ean_reader','ean_8_reader','upc_reader','upc_e_reader','code_128_reader','code_39_reader'];
const QUAGGA_CONFIRM_MS=2000;    // Quagga must read the same code twice within this window
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
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true; ctl.abort();},LOOKUP_TIMEOUT_MS);
  setScanStatus('Looking up barcode…');
  try{
    const res=await fetch(LOOKUP_URL+encodeURIComponent(code),{signal:ctl.signal});
    if(seq!==lookupSeq) return;
    if(!res.ok){
      if(res.status===429) fail('Daily barcode lookup limit reached (the free service allows only about 100 a day). Try again tomorrow.');
      else if(res.status>=500) fail(`Barcode service is down or busy right now (HTTP ${res.status}).`);
      else fail(`Barcode service refused the lookup (HTTP ${res.status}).`);
      return;
    }
    let data=null;
    try{data=await res.json();}catch(e){if(ctl.signal.aborted) throw e;}   // aborted = timeout / superseded, handled below
    if(seq!==lookupSeq) return;
    if(!data){fail('Barcode service sent an unreadable reply (captive portal or outage?).'); return;}
    const item=data && data.items && data.items[0];
    if(item){
      if(fillForm || !els.newTitle.value.trim()) els.newTitle.value = cleanLookupTitle(item.title || '');
      if(item.images?.[0] && !els.newPoster.value.trim()) els.newPoster.value = item.images[0];
      if(!els.newNotes.value.trim()) els.newNotes.value = [item.brand, item.description].filter(Boolean).join(' — ').slice(0,350);
      if(!owned) toast('Barcode found. Check title and section before adding.');
      setScanStatus(note+'Barcode found. Check title and section before adding.');
    }else if(data && data.code && data.code!=='OK'){
      fail(`Barcode service said: ${data.message||data.code}.`);
    }else{
      fail('No product data found for this barcode.');
    }
  }catch(e){
    if(seq!==lookupSeq) return;   // superseded by a newer lookup
    fail(timedOut?`Barcode lookup timed out after ${LOOKUP_TIMEOUT_MS/1000} seconds.`:'Could not reach the barcode service (offline or blocked).');
  }finally{
    clearTimeout(timer);
    if(lookupCtl===ctl) lookupCtl=null;
  }
}
function cleanLookupTitle(t){return String(t||'').replace(/\s+(?:\(?\s*(?:blu[- ]?ray|dvd|4k|uhd|ultra hd)\s*\)?).*$/i,'').trim()}

/* ---- camera scanner ---- */
async function startScanner(){
  stopScanner(false);
  const tok=scanSession;
  hideSearchFallback();
  ownedNote=''; warnedKey='';
  if(document.hidden) return;
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
    const detector=await createNativeDetector();
    if(tok!==scanSession) return;
    if(detector){
      const stream=await openBestCameraStream();
      if(tok!==scanSession){stopTracks(stream); return;}
      scanStream=stream; scanDetector=detector; nativeErrors=0;
      const v=els.scanVideo;
      v.muted=true; v.playsInline=true; v.setAttribute('playsinline',''); v.setAttribute('muted','');
      v.srcObject=stream;
      await v.play();
      if(tok!==scanSession) return;
      setScanStatus('Camera started. Scanning with native barcode detector…');
      nativeScanLoop(tok);
    }else{
      setScanStatus('This browser cannot read barcodes natively. Starting fallback scanner…');
      await startQuaggaFallback(tok);
    }
  }catch(e){
    if(tok===scanSession) failScanner(cameraErrorMessage(e),'Camera could not start.');
  }
}
function failScanner(msg,text){
  stopScanner(false);
  els.scannerText.textContent=text;
  setScanStatus(msg);
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
  const v=els.scanVideo;
  if(tok!==scanSession || !scanDetector || !v.srcObject) return;
  if(v.readyState>=2){   // skip frames until the video has data, so early InvalidStateErrors do not count
    try{
      const codes=await scanDetector.detect(v);
      if(tok!==scanSession) return;
      nativeErrors=0;
      const hit=(codes||[]).find(c=>isValidBarcode(c.rawValue,c.format));
      if(hit){onBarcodeFound(hit.rawValue); return;}
    }catch(e){
      if(tok!==scanSession) return;
      if(++nativeErrors>=NATIVE_MAX_ERRORS){   // detect() keeps throwing: the native detector is broken on this device
        setScanStatus('Native detector is not working here. Switching to fallback scanner…');
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
    // patchSize 'large': the barcode is held close, inside the guide frame, so it fills a big part of the image
    const base={decoder:{readers:QUAGGA_READERS}, locate:true, frequency:10, numOfWorkers:0, locator:{patchSize:'large', halfSample:true}};
    const attempts=[{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}, {facingMode:{ideal:'environment'}}, {}];
    let err=null;
    for(const constraints of attempts){
      quaggaInit=(async()=>Q.init({...base, inputStream:{type:'LiveStream', target:els.scanner, constraints}}))();
      try{await quaggaInit; err=null; break;}
      catch(e){err=e; if(tok!==scanSession || ['NotAllowedError','SecurityError','NotReadableError'].includes(e?.name)) break;}
      finally{quaggaInit=null;}
    }
    if(tok!==scanSession){releaseCamera(); return;}
    if(err) throw err;
    Q.onDetected(onQuaggaDetected);
    Q.start();
    setScanStatus('Scanning with fallback detector…');
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
  if(quaggaHit && quaggaHit.code===code && now-quaggaHit.t<=QUAGGA_CONFIRM_MS){onBarcodeFound(code); return;}
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
  els.scanner.querySelectorAll('video').forEach(v=>{
    stopTracks(v.srcObject); v.pause(); v.srcObject=null;
    if(v!==els.scanVideo) v.remove();
  });
  els.scanner.querySelectorAll('canvas').forEach(n=>n.remove());
}
function stopScanner(showToast=true){
  scanSession++;
  releaseCamera();
  els.scanner.classList.remove('active');
  els.scannerText.textContent='Camera is off.';
  if(showToast) setScanStatus('Scanner stopped.');
}

/* ---- init hook (called from init() in app.js) ---- */
function initScanner(){
  // the camera must never keep running in the background
  const stopIfRunning=why=>{if(els.scanner.classList.contains('active')){stopScanner(false); setScanStatus(why);}};
  document.addEventListener('visibilitychange',()=>{if(document.hidden) stopIfRunning('Camera turned off because the page was hidden. Press Start scan to resume.');});
  window.addEventListener('pagehide',()=>stopIfRunning('Camera turned off.'));
  const add=$('add');
  if(add) new MutationObserver(()=>{if(!add.classList.contains('active')) stopIfRunning('Camera turned off because you left the Add screen.');}).observe(add,{attributes:true,attributeFilter:['class']});
  // duplicate warning while typing / pasting a barcode
  els.newBarcode.addEventListener('input',()=>{hideSearchFallback(); checkOwned(els.newBarcode.value);});
  // addMovie() clears the field on success: drop the stale warning and fallback link
  els.addMovieBtn.addEventListener('click',()=>{
    if(els.newBarcode.value.trim()) return;
    hideSearchFallback(); ownedNote=''; warnedKey=''; setScanStatus('');
  });
}
