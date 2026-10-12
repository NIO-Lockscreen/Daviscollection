/* ---------- Barcode lookup + camera scanner ---------- */
let scanStream = null;
let scanTimer = null;
let scanDetector = null;
let quaggaLoaded = false;
let quaggaRunning = false;

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
