/* ---------- Phone as scanner ----------
   The PC shows a QR code. The phone opens the app through it (?pair=ID), scans barcodes with scanner.js's camera code
   and sends each one to the PC through a public pub/sub relay: ntfy.sh (the same trick as the Car-lockscreen app). It is plain HTTPS,
   so it works on any network (the two devices do not have to be on the same Wi-Fi) and we run no server of our own.
   The PC looks the barcode up, checks the collection and queues it on the Add / scan screen; the reply goes back to the phone.
   Two topics per session: mv-<id>-s (phone -> PC) and mv-<id>-r (PC -> phone). Publish = POST <relay>/<topic> with a small JSON body;
   subscribe = EventSource <relay>/<topic>/sse?since=... (polling /json?poll=1 as the fallback). Nothing is sent while idle (no heartbeats):
   ntfy.sh allows only about 250 messages a day per network, and a scan costs two (the scan and the reply).
   Messages (JSON): phone -> PC {t:'hello',ph} {t:'scan',code,n,ph} {t:'bye',ph};  PC -> phone {t:'hi',ph} {t:'result',code,title,owned,error?,ph} {t:'takeover',ph} {t:'bye'}.
   (ph = a random id of that phone page, so a phone only reacts to replies meant for it.)
   When the daily quota is used up nothing is lost: the phone keeps the codes in localStorage and sends them the next time it pairs.
   The QR library is loaded lazily, only when someone pairs, pinned to an exact version with an SRI hash. */
const RELAY_BASE='https://ntfy.sh';   // the one place to point at a self-hosted ntfy later (tests: window.MV_RELAY_BASE or ?relay=http://localhost:PORT)
const QR_URL='https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const QR_SRI='sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k';
const RS_PAIR_KEY='movieVault.remotePair';        // sessionStorage on the phone: {id,relay}, so a reload stays paired
const RS_PENDING_KEY='movieVault.remotePending';  // localStorage on the phone: [{code,at}] scanned while the daily relay quota was used up
const RS_LIMIT_KEY='movieVault.relayLimitDay';    // localStorage: the local date (YYYY-MM-DD) on which the daily relay quota was hit
const RS_B62='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RS_ID_LEN=22;                                // 22 base62 chars = ~131 random bits
const RS_ID_RE=/^[A-Za-z0-9]{22,40}$/;             // topic = 'mv-' + id + '-s' / '-r': at most 45 chars, ntfy allows [-_A-Za-z0-9] up to 64
const RS_PH_RE=/^[A-Za-z0-9]{6,32}$/;
const RS_LOOPBACK_RE=/^http:\/\/(localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
const RS_QUEUE_MAX=100;
const RS_PENDING_MAX=500;
const RS_LIMIT_TEXT='Daily relay limit reached (ntfy.sh). Type the barcode on the PC instead, or try again tomorrow.';
const RS_PC_LIMIT_TEXT='Daily limit reached on this network. Barcodes already here still work; scan the rest tomorrow.';
const RS_NO_RELAY='Could not reach the relay (ntfy.sh). Both devices need internet access.';
const RS_STATUS={connecting:'Connecting…', waiting:'Waiting for phone', connected:'Phone connected ✓', disconnected:'Disconnected'};
// Timings. Kept in one object so they are easy to read (and so a test can shorten them: RS_T.burstWaitMs=500).
const RS_T={
  skewS:90,            // subscribe "since" = session start minus this, so a phone/PC clock that runs a little fast never hides a reply
  sseFails:3,          // EventSource that fails this many times in a row without ever opening -> polling instead
  retryMs:800, retryMaxMs:8000, stableMs:15000,   // reconnect backoff (reset once a connection has stayed up for stableMs)
  watchdogMs:150000,   // no event at all (not even ntfy's keepalive) for this long on an "open" stream: it is dead, reconnect
  connectMs:20000,     // one connection attempt gets this long to open the stream
  pollMs:3000, pollIdleMs:5000, pollIdleAfterMs:40000, pollMaxMs:30000,   // polling fallback (slower when nothing happens: ntfy.sh limits requests too)
  pubTries:4, pubBackoffMs:1000,                  // network failures: bounded retries with backoff 1 s, 2 s, 4 s
  burstTries:3, burstWaitMs:20000,                // short rate-limit 429: wait ~20 s and retry a few times (a daily-quota 429 is never retried)
  helloTries:3, hiWaitMs:8000                     // phone: hello is sent up to this many times, each given this long to be answered with hi
};
const rsLoading={};
let rsRelay=RELAY_BASE, rsRelayParam='';   // rsRelayParam: a loopback override that has to travel in the QR code
let rsTx=0, rsRx=0;                        // messages this device published / received (all of them count against the relay's daily quota)

/* ---- lazy vendor script (same pattern as loadQuagga in scanner.js) ---- */
function loadVendor(url,sri,ready){
  if(ready()) return Promise.resolve();
  if(!rsLoading[url]) rsLoading[url]=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src=url; s.integrity=sri; s.crossOrigin='anonymous';
    s.onload=()=>ready()?resolve():reject(Object.assign(new Error('Library missing'),{load:true}));
    s.onerror=()=>{s.remove(); reject(Object.assign(new Error('Library failed to load'),{load:true}));};
    document.head.appendChild(s);
  }).catch(e=>{delete rsLoading[url]; throw e;});
  return rsLoading[url];
}
const loadQrCode=()=>loadVendor(QR_URL,QR_SRI,()=>typeof window.qrcode==='function');

// Which relay to use: window.MV_RELAY_BASE (tests), else ?relay=http://localhost:PORT / 127.0.0.1 (loopback only, tests), else RELAY_BASE.
function rsPickRelay(param){
  let base=RELAY_BASE;
  if(typeof window.MV_RELAY_BASE==='string' && /^https?:\/\/[^\s/?#]+$/.test(window.MV_RELAY_BASE.replace(/\/+$/,''))) base=window.MV_RELAY_BASE.replace(/\/+$/,'');
  else if(typeof param==='string' && RS_LOOPBACK_RE.test(param)) base=param;
  rsRelay=base;
  rsRelayParam=RS_LOOPBACK_RE.test(base) ? base : '';
}
/* Anyone who knows a session id can publish to its topics and read them: the id is the only access control.
   It is 22 random base62 chars (~131 bits) from crypto.getRandomValues, shown only in this window's QR code / address,
   and gone when the session stops. A phone's own id (ph) is not secret, it only tells phones apart. */
function rsRandomId(len=RS_ID_LEN){
  let out=''; const b=new Uint8Array(64);
  while(out.length<len){
    crypto.getRandomValues(b);
    for(let i=0;i<b.length && out.length<len;i++) if(b[i]<248) out+=RS_B62[b[i]%62];   // 248 = 4*62: no modulo bias
  }
  return out;
}
const rsTopic=(id,dir)=>'mv-'+id+'-'+dir;   // dir 's' = phone -> PC, 'r' = PC -> phone
// Only plausible barcodes get through: retail digits (8/12/13/14, check digit must match) or a short Code 128/39 label. Anything else is dropped.
function cleanRemoteCode(c){
  if(typeof c!=='string' || c.length>40) return '';
  c=normalizeBarcode(c);
  if(/^\d+$/.test(c)) return isRetailLength(c) && retailCheckOk(c) ? c : '';
  return /^[A-Za-z0-9][A-Za-z0-9.\-]{4,31}$/.test(c) ? c : '';
}
const rsText=(v,max=200)=>typeof v==='string' ? v.slice(0,max) : '';

/* ---- the daily quota flag: remembered per local date, so a stale flag from yesterday never blocks anything ---- */
let rsLimitMem='';
function rsToday(){const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function rsLimitDay(){try{const v=localStorage.getItem(RS_LIMIT_KEY); if(v!==null) return v;}catch(_){} return rsLimitMem;}
function rsLimitSet(){rsLimitMem=rsToday(); try{localStorage.setItem(RS_LIMIT_KEY,rsLimitMem);}catch(_){}}
function rsLimitClear(){rsLimitMem=''; try{localStorage.removeItem(RS_LIMIT_KEY);}catch(_){}}
function rsDailyBlocked(){const d=rsLimitDay(); if(!d) return false; if(d===rsToday()) return true; rsLimitClear(); return false;}

/* =====================  Publish  ===================== */
const rsChains=new Map();   // topic -> promise chain: the messages of one topic go out in order
/* rsPublish(topic,msg,{ctl,probe,onWait}) -> Promise<{ok}|{daily}|{burst}|{net}|{status}|{cancelled}>. It never rejects.
   - network failure / 5xx: retried a bounded number of times with backoff; while the device is offline it simply waits for the network.
   - 429: told apart. Daily quota (code 42908 / "daily" in the error text): never retried, the day is remembered and later
     publishes fail at once without touching the network. A short rate limit: waits burstWaitMs and retries burstTries times.
   - probe: ignore the remembered daily flag for this one message (a new pairing handshake gets one real try).
   - ctl {cancelled}: set it to drop the message. */
function rsPublish(topic,msg,o={}){
  const p=(rsChains.get(topic)||Promise.resolve()).then(()=>rsPublishNow(topic,msg,o));
  rsChains.set(topic,p);
  return p;
}
async function rsPublishNow(topic,msg,o){
  const body=JSON.stringify(msg);
  let netTries=0, burstTries=0;
  for(;;){
    if(o.ctl && o.ctl.cancelled) return {cancelled:true};
    if(!o.probe && rsDailyBlocked()) return {daily:true};
    if(navigator.onLine===false){   // queued while offline: sent when the network is back
      if(o.onWait) o.onWait('offline');
      await rsOfflineWait(o.ctl);
      continue;
    }
    let res=null;
    try{res=await fetch(rsRelay+'/'+topic,{method:'POST',body});}catch(_){}
    if(o.ctl && o.ctl.cancelled && !(res && res.ok)) return {cancelled:true};
    if(res && res.ok){
      rsTx++; if(rsLimitDay()) rsLimitClear();
      if(typeof rsRenderCount==='function') rsRenderCount();
      return {ok:true};
    }
    if(res && res.status===429){
      if(await rsIsDailyLimit(res)){rsLimitSet(); return {daily:true};}
      if(++burstTries>RS_T.burstTries) return {burst:true};
      if(o.onWait) o.onWait('busy');
      await rsSleep(RS_T.burstWaitMs,o.ctl);
      continue;
    }
    if(res && res.status>=400 && res.status<500 && res.status!==408) return {status:res.status};   // rejected: retrying cannot help
    if(++netTries>=RS_T.pubTries) return {net:true};
    await rsSleep(RS_T.pubBackoffMs*2**(netTries-1),o.ctl);
  }
}
// The last message of a session (bye): the request starts right now, in the same task, so it still goes out when the page is being closed
// (keepalive). No retries, no waiting; a remembered daily limit just skips it.
function rsSendLast(topic,msg){
  if(rsDailyBlocked()) return Promise.resolve({daily:true});
  let p; try{p=fetch(rsRelay+'/'+topic,{method:'POST',body:JSON.stringify(msg),keepalive:true});}catch(_){return Promise.resolve({net:true});}
  return p.then(async res=>{
    if(res.ok){rsTx++; return {ok:true};}
    if(res.status===429 && await rsIsDailyLimit(res)){rsLimitSet(); return {daily:true};}
    return {status:res.status};
  },()=>({net:true}));
}
async function rsIsDailyLimit(res){   // ntfy answers {"code":42908,"http":429,"error":"limit reached: daily message quota reached"}
  let t=''; try{t=await res.text();}catch(_){}
  let j=null; try{j=JSON.parse(t);}catch(_){}
  return !!(j && (j.code===42908 || /daily/i.test(String(j.error||'')))) || (!j && /daily/i.test(t));
}
async function rsSleep(ms,ctl){
  const end=Date.now()+ms;
  while(Date.now()<end && !(ctl && ctl.cancelled)) await new Promise(r=>setTimeout(r,Math.max(0,Math.min(250,end-Date.now()))));
}
async function rsOfflineWait(ctl){
  const end=Date.now()+10*60*1000;
  while(navigator.onLine===false && Date.now()<end && !(ctl && ctl.cancelled)) await new Promise(r=>setTimeout(r,500));
}

/* =====================  Subscribe  ===================== */
// The cursor belongs to the caller and lives as long as the session: where to continue after a reconnect, and which messages were already handled.
function rsNewCursor(){return {since:String(Math.max(0,Math.floor(Date.now()/1000)-RS_T.skewS)), lastId:'', seen:new Set()};}
/* rsSubscribe(topic,{cursor,onOpen(first),onMessage(obj|null),onTrouble(info)}) -> {close(),kick(),open}
   EventSource <relay>/<topic>/sse?since=<lastId or session start>. On an error the stream is closed and re-created from the last seen
   message id after a short backoff, so nothing is missed and (with the id check) nothing is handled twice. If EventSource does not exist,
   or fails sseFails times in a row without opening, it polls <relay>/<topic>/json?poll=1&since=... instead. */
function rsSubscribe(topic,o){
  const cur=o.cursor;
  const s={closed:false, open:false, opens:0, es:null, timer:0, stableT:0, dog:0, errs:0, fails:0, pollFails:0, polling:false, tick:null, last:Date.now(), quiet:Date.now(), connAt:0};
  const url=rest=>rsRelay+'/'+topic+rest;
  const since=()=>encodeURIComponent(cur.lastId||cur.since);
  function markOpen(){
    if(s.open || s.closed) return;
    s.open=true; s.fails=0; s.pollFails=0; s.last=Date.now();
    clearTimeout(s.stableT); s.stableT=setTimeout(()=>{s.errs=0;},RS_T.stableMs);
    if(o.onOpen) o.onOpen(s.opens++===0);
  }
  function accept(ev){   // one ntfy event object: {id,time,event:'message'|'open'|'keepalive',message}
    if(s.closed || !ev || typeof ev!=='object') return;
    s.last=Date.now();
    if(ev.event==='open'){markOpen(); return;}
    if(ev.event!=='message' || typeof ev.id!=='string' || !ev.id || cur.seen.has(ev.id)) return;
    cur.seen.add(ev.id); if(cur.seen.size>800) cur.seen.delete(cur.seen.values().next().value);
    cur.lastId=ev.id; s.quiet=Date.now();
    let m=null; try{m=JSON.parse(typeof ev.message==='string' ? ev.message : '');}catch(_){}
    o.onMessage(m && typeof m==='object' && !Array.isArray(m) ? m : null);
  }
  function connectSse(){
    if(s.closed || s.polling) return;
    let es;
    try{es=new EventSource(url('/sse?since='+since()));}catch(_){startPolling(); return;}
    s.es=es; s.open=false; s.connAt=Date.now();
    const onData=e=>{
      if(s.es!==es) return;
      if(typeof e.data!=='string'){markOpen(); return;}   // the browser's own 'open' event carries no data
      let ev=null; try{ev=JSON.parse(e.data);}catch(_){}
      accept(ev);
    };
    ['open','message','keepalive'].forEach(t=>es.addEventListener(t,onData));
    es.onerror=()=>{if(s.es===es) sseError();};
  }
  function sseError(){
    const es=s.es; s.es=null;
    try{es && es.close();}catch(_){}
    if(s.closed) return;
    const wasOpen=s.open; s.open=false; clearTimeout(s.stableT);
    s.errs++; if(!wasOpen) s.fails++;
    if(o.onTrouble) o.onTrouble({errs:s.errs, fails:s.fails, pollFails:0});
    if(s.closed) return;
    if(s.fails>=RS_T.sseFails){startPolling(); return;}
    clearTimeout(s.timer);
    s.timer=setTimeout(connectSse,Math.min(RS_T.retryMs*2**(s.errs-1),RS_T.retryMaxMs));
  }
  function startPolling(){
    if(s.closed || s.polling) return;
    s.polling=true; s.open=false; clearTimeout(s.timer);
    const tick=async()=>{
      if(s.closed || !s.polling) return;
      let delay=0;
      try{
        const r=await fetch(url('/json?poll=1&since='+since()));
        if(s.closed || !s.polling) return;
        if(r.status===429){   // ntfy.sh also limits requests per network: slow down
          s.open=false; s.pollFails++; delay=RS_T.pollMaxMs;
          if(o.onTrouble) o.onTrouble({limit:true, pollFails:s.pollFails});
        }else if(!r.ok) throw new Error('http '+r.status);
        else{
          const text=await r.text();
          if(s.closed || !s.polling) return;
          markOpen();
          for(const line of text.split('\n')){   // newline-delimited JSON
            if(!line.trim()) continue;
            let ev=null; try{ev=JSON.parse(line);}catch(_){}
            accept(ev);
            if(s.closed || !s.polling) return;
          }
          s.pollFails=0;
        }
      }catch(_){
        if(s.closed || !s.polling) return;
        s.open=false; s.pollFails++;
        if(o.onTrouble) o.onTrouble({pollFails:s.pollFails});
      }
      if(s.closed || !s.polling) return;
      if(!delay) delay=s.pollFails ? Math.min(RS_T.pollMs*2**Math.min(s.pollFails,5),RS_T.pollMaxMs) : (Date.now()-s.quiet>RS_T.pollIdleAfterMs ? RS_T.pollIdleMs : RS_T.pollMs);
      s.timer=setTimeout(tick,delay);
    };
    s.tick=tick; tick();
  }
  s.close=()=>{
    s.closed=true; s.open=false; clearTimeout(s.timer); clearTimeout(s.stableT); clearInterval(s.dog);
    if(s.es){try{s.es.close();}catch(_){} s.es=null;}
  };
  // Reconnect right now (the page came back to the foreground, or the network returned). Nothing is lost: it continues from the last seen id.
  s.kick=()=>{
    if(s.closed) return;
    clearTimeout(s.timer);
    if(s.polling && typeof EventSource!=='function'){s.tick && s.tick(); return;}
    s.polling=false; s.errs=0; s.fails=0; s.open=false;
    if(s.es){try{s.es.close();}catch(_){} s.es=null;}
    connectSse();
  };
  // Watchdog: ntfy sends a keepalive every ~45 s, so a stream that is silent for this long (a phone that slept, a network that changed) is dead.
  s.dog=setInterval(()=>{
    if(s.closed || s.polling || !s.es) return;
    if(s.open ? Date.now()-s.last>RS_T.watchdogMs : Date.now()-s.connAt>RS_T.connectMs) sseError();
  },5000);
  if(typeof EventSource==='function') connectSse(); else startPolling();
  return s;
}

/* =====================  PC side  ===================== */
let rsActive=false, rsReady=false, rsState='connecting', rsDetail='', rsNote='', rsLimited=false, rsAutoOff=false;   // rsAutoOff: the user pressed Stop, so entering Add / scan does not start a new session by itself
let rsSub=null, rsId='', rsSession=0, rsDropped=0, rsPhone='', rsEverHello=false, rsByeSent=false, rsCtl=null, rsSeenN=new Set();
let rsQueue=[], rsSeq=0, rsChain=Promise.resolve();

function startPhoneSession(){
  if(rsActive) return;
  if(location.protocol==='file:'){rsDetail='Open the app from its web address (not from a file on disk) to pair a phone.'; rsState='disconnected'; rsRender(); return;}
  const sid=++rsSession;
  rsActive=true; rsReady=false; rsState='connecting'; rsDetail=''; rsNote=''; rsLimited=false; rsPhone=''; rsEverHello=false; rsByeSent=false; rsSeenN=new Set(); rsTx=rsRx=0;
  rsId=rsRandomId(); rsCtl={cancelled:false};
  $('rsQr').textContent=''; delete $('rsQr').dataset.url;
  rsRender();
  rsSub=rsSubscribe(rsTopic(rsId,'s'),{
    cursor:rsNewCursor(),
    onOpen:()=>{
      if(sid!==rsSession) return;
      rsReady=true; rsNote='';
      if(rsState==='connecting') rsState=rsPhone ? 'connected' : 'waiting';
      showPairingQr();
      rsRender();
    },
    onMessage:m=>{if(sid===rsSession) onPhoneMessage(m);},
    onTrouble:info=>{
      if(sid!==rsSession) return;
      if(!rsReady){   // never opened: a few polls failed too, so the relay cannot be reached
        if((info.pollFails||0)>=3) failPhoneSession(info.limit ? 'ntfy.sh is limiting requests from this network right now. Wait a minute and try again.' : RS_NO_RELAY+' Check this computer\'s connection and try again.');
        return;
      }
      if(info.limit) rsNote='ntfy.sh is limiting requests from this network right now. Retrying…';
      else if((info.errs||0)>=2 || info.pollFails) rsNote='Lost contact with the relay (ntfy.sh). Trying again…';
      rsRender();
    }
  });
}
// Publishes to the phone. Reports problems on screen; a daily-quota 429 is shown (modal, pill, queue hint) and not retried.
function rsPublishPc(msg,o={}){
  const sid=rsSession;
  return rsPublish(rsTopic(rsId,'r'),msg,{ctl:rsCtl,...o}).then(r=>{
    if(sid!==rsSession || r.cancelled) return r;
    if(r.daily) rsLimited=true;
    else if(r.ok) rsLimited=false;
    else rsNote='A reply could not be sent to the phone (ntfy.sh did not take it).';
    rsRender();
    return r;
  });
}
function rsSend(msg){if(rsActive && rsPhone) rsPublishPc({...msg,ph:rsPhone});}
function onPhoneMessage(m){
  rsRx++; rsRenderCount();
  if(!m || typeof m.t!=='string' || typeof m.ph!=='string' || !RS_PH_RE.test(m.ph)){rsDropped++; return;}
  const ph=m.ph;
  if(m.t==='hello'){onPhoneHello(ph); return;}
  if(m.t==='bye'){   // "Use this phone normally"
    if(ph===rsPhone){rsPhone=''; rsState='waiting'; rsDetail='The phone left the scanner. Scan the QR code again to reconnect it.'; rsRender();}
    return;
  }
  if(m.t!=='scan'){rsDropped++; return;}
  if(ph!==rsPhone) return;   // a phone that was taken over (or never said hello): ignored
  if(!Number.isInteger(m.n) || m.n<0 || m.n>1e9){rsDropped++; return;}
  const key=ph+':'+m.n;
  if(rsSeenN.has(key)) return;   // the same scan published twice (a retry after a lost answer)
  rsSeenN.add(key);
  const code=cleanRemoteCode(m.code);
  if(!code){rsDropped++; return;}
  queueRemoteCode(code);
}
function onPhoneHello(ph){
  // One phone at a time: the newest hello wins. The phone that was connected is told, so it stops (and two phones do not keep replacing each other).
  if(rsPhone && rsPhone!==ph) rsPublishPc({t:'takeover',ph:rsPhone});
  rsPhone=ph; rsEverHello=true; rsState='connected'; rsDetail='';
  rsPublishPc({t:'hi',ph},{probe:true});
  rsRender();
}
function rsSayBye(){   // tells the phone the session is over (once)
  if(!rsActive || !rsEverHello || rsByeSent) return;
  rsByeSent=true;
  rsSendLast(rsTopic(rsId,'r'),{t:'bye'}).then(r=>{if(r.daily){rsLimited=true; rsRender();}});
}
function endPhoneSession(){   // Stop, or the page going away: tell the phone, then drop everything
  rsSayBye();
  teardownPhoneSession();
}
function teardownPhoneSession(){
  rsSession++;
  if(rsCtl) rsCtl.cancelled=true;
  const sub=rsSub; rsSub=null;
  try{sub && sub.close();}catch(_){}
  rsActive=rsReady=false; rsPhone='';
}
function stopPhoneSession(){
  rsAutoOff=true;
  endPhoneSession();
  rsState='disconnected'; rsDetail='Phone scanner stopped. Press Try again to start a new session with a new QR code.'; rsNote='';
  rsRender();
}
function failPhoneSession(msg){
  teardownPhoneSession();
  rsState='disconnected'; rsDetail=msg;
  rsRender();
}

/* ---- the "Scanned on phone" queue ---- */
function queueRemoteCode(code){
  const key=barcodeKey(code), have=rsQueue.find(x=>x.key===key);
  if(have){   // same code again: no second item, show the first one and answer the phone again
    flashQueueItem(have.id);
    if(have.state!=='looking') sendRemoteResult(have);
    return;
  }
  if(rsQueue.length>=RS_QUEUE_MAX){rsSend({t:'result',code,title:'',owned:null,error:'The queue on the computer is full. Add or dismiss some items there first.'}); return;}
  const it={id:++rsSeq, code, key, state:'looking', title:'', format:'', err:''};
  rsQueue.unshift(it);
  renderQueue(); flashQueueItem(it.id);
  rsChain=rsChain.then(()=>lookupQueued(it)).catch(()=>{});   // one lookup at a time: the free service rate-limits bursts
}
async function lookupQueued(it){
  if(!rsQueue.includes(it)){sendRemoteResult(it,'Dismissed on the computer.'); return;}
  const r=await fetchBarcodeInfo(it.code);
  if(r.ok && r.title){it.state='found'; it.title=r.title; it.format=guessFormat(r.item.title);}
  else{it.state='error'; it.err=r.ok ? 'The barcode service has no title for this product.' : r.msg;}
  sendRemoteResult(it);
  renderQueue();
}
function guessFormat(raw){
  raw=String(raw||'');
  if(/\b(4K|UHD|Ultra HD)\b/i.test(raw)) return '4K UHD';
  if(/\bDVD\b/i.test(raw) && !/blu[- ]?ray/i.test(raw)) return 'DVD';
  return /blu[- ]?ray/i.test(raw) ? 'Blu-ray' : '';
}
function sendRemoteResult(it,error){
  const o=findOwnedByBarcode(it.code), err=error || it.err;
  rsSend({t:'result', code:it.code, title:rsText(it.title), owned:o ? {title:rsText(o.movie.title), section:rsText(o.movie.section||'')} : null, ...(err ? {error:rsText(err)} : {})});
}
function queueEligible(it){return it.state==='found' && !!it.title && !findOwnedByBarcode(it.code);}
function renderQueue(){
  const panel=$('rsQueuePanel'), box=$('rsQueue'); if(!panel || !box) return;
  panel.hidden = !rsQueue.length && !rsLimited;   // (the phone's status itself is shown next to the QR code and in the pill)
  const hint = rsActive ? (rsState==='connected' ? 'Phone connected. Scan barcodes with it; they appear here.' : rsState==='waiting' ? 'Waiting for the phone. Scan the QR code to connect it.' : 'The phone is not connected right now.') : 'The phone scanner is stopped. These stay here until you add or dismiss them.';
  $('rsQueueHint').textContent=(rsLimited ? RS_PC_LIMIT_TEXT+' ' : '')+hint;
  box.innerHTML = rsQueue.length ? rsQueue.map(queueItemHtml).join('') : '<div class="rsEmpty">Nothing scanned yet.</div>';
  const n=rsQueue.filter(queueEligible).length;
  $('rsAddAllBtn').textContent = n>1 ? `Add all to Unsorted (${n})` : 'Add all to Unsorted';
  $('rsAddAllBtn').disabled=!n;
  $('rsClearBtn').disabled=!rsQueue.length;
}
function queueItemHtml(it){
  const o=findOwnedByBarcode(it.code), id=it.id;
  const title = it.state==='looking' ? '<span class="rsMuted">Looking up title…</span>' : it.title ? escapeHtml(it.title) : `<span class="rsMuted">${escapeHtml(it.err||'No title found.')}</span>`;
  const own = o ? `<div class="rsOwned">You already own: ${escapeHtml(o.movie.title)} (${escapeHtml(o.movie.section||'no section')})${o.count>1 ? ` + ${o.count-1} more with this barcode` : ''}</div>` : '';
  return `<div class="rsItem${o?' owned':''}" data-id="${id}"><div class="rsInfo"><span class="rsCode">${escapeHtml(it.code)}</span><strong class="rsTitle">${title}</strong>${own}</div>`
    +`<div class="rsBtns"><button class="primary" data-rs="add" data-id="${id}"${it.state==='found'&&it.title?'':' disabled'}>Add to Unsorted</button><button class="ghost" data-rs="edit" data-id="${id}">Edit first</button><button class="ghost" data-rs="dismiss" data-id="${id}">Dismiss</button></div></div>`;
}
function flashQueueItem(id){
  const el=document.querySelector(`#rsQueue .rsItem[data-id="${id}"]`); if(!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  el.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function onQueueClick(e){
  const b=e.target.closest('button[data-rs]'); if(!b) return;
  const it=rsQueue.find(x=>String(x.id)===b.dataset.id); if(!it) return;
  if(b.dataset.rs==='add') addQueued([it]);
  else if(b.dataset.rs==='edit') editQueued(it);
  else{rsQueue=rsQueue.filter(x=>x!==it); renderQueue();}
}
function addQueued(items){
  items=items.filter(it=>it.state==='found' && it.title); if(!items.length) return;
  const added=[...items].reverse().map(it=>newMovie({title:it.title, section:UNSORTED_SECTION, format:it.format||els.newFormat.value, barcode:it.code}));   // oldest scan first, so the newest ends on top
  rsQueue=rsQueue.filter(x=>!items.includes(x));
  const ok=save(); populateSelects(); render(); renderQueue();
  if(ok) toast(items.length===1 ? `Added “${items[0].title}” to Unsorted.` : `Added ${items.length} titles to Unsorted.`, 8000, {warn:false, action:{label:'Undo', fn:()=>undoQueuedAdd(added, items)}});
}
function undoQueuedAdd(movies, items){
  const ids=new Set(movies.map(m=>m.id));
  state.movies=state.movies.filter(m=>!ids.has(m.id));
  items.forEach(it=>{if(!rsQueue.some(x=>x.key===it.key)) rsQueue.push(it);});
  rsQueue.sort((a,b)=>b.id-a.id);
  save(); render(); renderQueue();
  toast(`Took ${movies.length} title${movies.length===1?'':'s'} back to the queue.`);
}
function editQueued(it){   // hands the item to the Add form, where the title / format can be fixed before adding
  els.newTitle.value=it.title; els.newBarcode.value=it.code;
  if(it.format) els.newFormat.value=it.format;
  els.newSection.value=UNSORTED_SECTION; els.customSection.value=''; els.newPoster.value=''; els.newNotes.value=''; els.newSeen.checked=false;
  els.newBarcode.dispatchEvent(new Event('input')); els.newTitle.dispatchEvent(new Event('input'));   // duplicate warnings, like typing it
  rsQueue=rsQueue.filter(x=>x!==it); renderQueue();
  els.newTitle.scrollIntoView({block:'center',behavior:'smooth'});
  els.newTitle.focus({preventScroll:true});
}

/* ---- Add / scan panel (QR code + status) and the pill ---- */
/* Computer or phone? A "computer" is a device whose primary pointer is a mouse or trackpad: matchMedia('(pointer:fine)').
   Phones and tablets report (pointer:coarse) (touch), so they keep the camera scanner; a touch-screen laptop still counts as a computer.
   Tests: Playwright's isMobile + hasTouch context reports coarse, a plain desktop context fine; window.MV_FORCE_DEVICE='computer'|'phone' overrides it. */
function isComputerDevice(){
  if(window.MV_FORCE_DEVICE==='computer') return true;
  if(window.MV_FORCE_DEVICE==='phone') return false;
  try{return window.matchMedia('(pointer:fine)').matches;}catch(_){return false;}
}
const RS_MODE_KEY='movieVault.scanMode';   // localStorage, computers only: 'camera' = the computer's own camera; anything else = pair a phone (the default)
function scanMode(){
  if(!isComputerDevice()) return 'camera';
  try{return localStorage.getItem(RS_MODE_KEY)==='camera' ? 'camera' : 'phone';}catch(_){return 'phone';}
}
function applyScanPanel(){   // what the Add / scan "scanner" panel shows
  const mode=scanMode(), computer=isComputerDevice(), panel=$('scanPanel'); if(!panel) return;
  panel.dataset.mode=mode;
  $('scanPanelTitle').textContent = mode==='phone' ? 'Scan with your phone' : 'Barcode scanner';
  $('phonePane').hidden = mode!=='phone';
  $('cameraPane').hidden = mode==='phone';
  $('scanPanelHint').hidden = mode==='phone';
  $('scanPanelHint').textContent = computer ? 'Hold the barcode inside the frame.' : 'Best in landscape or portrait with the back camera. Hold the barcode inside the frame.';
  const link=$('scanModeLink'); link.hidden=!computer;
  link.textContent = mode==='phone' ? "Use this computer's camera instead" : 'Scan with your phone instead';
}
function setScanMode(mode){   // computers: the choice is remembered
  try{localStorage.setItem(RS_MODE_KEY,mode);}catch(_){}
  if(mode==='camera'){
    if(rsActive){stopPhoneSession();}   // the phone is told (bye) and the pill goes away
    rsAutoOff=false;
  }else{rsAutoOff=false; if(curTarget().box===els.scanner) stopScanner(false);}
  applyScanPanel();
  if(mode==='phone') startPhoneSession();
}
// Called whenever the Add / scan screen is shown. Subscribing to the relay costs no messages (nothing is published until a phone says hello),
// so a computer simply starts (or keeps) its pairing session; leaving the screen does not end it.
function onAddScreenShown(){
  applyScanPanel();
  if(scanMode()==='phone' && !rsActive && !rsAutoOff && !rsPhoneActive) startPhoneSession();
}
function newPhoneCode(){   // "New code" / "Try again": end this session (the phone gets bye) and make a fresh one
  rsAutoOff=false;
  if(rsActive) endPhoneSession();
  startPhoneSession();
}
function goToScanPanel(){   // the pill: back to the QR code
  showScreen('add');
  requestAnimationFrame(()=>{const p=$('scanPanel'); if(p) p.scrollIntoView({behavior:'smooth',block:'center'});});
}
function pairingUrl(){return location.origin+location.pathname+'?pair='+rsId+(rsRelayParam ? '&relay='+encodeURIComponent(rsRelayParam) : '');}
async function showPairingQr(){
  const url=pairingUrl(), sid=rsSession, box=$('rsQr');
  $('rsUrl').value=url;
  if(box.dataset.url===url) return;   // already drawn (the relay connection came back)
  try{
    await loadQrCode();
    if(sid!==rsSession) return;
    const qr=qrcode(0,'M'); qr.addData(url); qr.make();
    const n=qr.getModuleCount(); let d='';
    for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(qr.isDark(r,c)) d+=`M${c} ${r}h1v1h-1z`;
    box.innerHTML=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${n+8} ${n+8}" shape-rendering="crispEdges" aria-hidden="true"><rect x="-4" y="-4" width="${n+8}" height="${n+8}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    box.dataset.url=url;
    rsRender();
  }catch(e){
    if(sid!==rsSession) return;
    box.textContent=''; box.hidden=true;
    rsDetail='The QR code could not be drawn (its library did not load). Type the address below into the phone\'s browser instead.'; rsRender();
  }
}
function rsRenderCount(){   // for debugging the daily quota: every message published or received in this session counts against it
  const el=$('rsCount'); if(el) el.textContent=`Relay messages this session: ${rsTx+rsRx}`;
}
function rsRender(){
  const status=$('rsStatus'); if(!status) return;
  status.textContent=RS_STATUS[rsState]; status.dataset.state=rsState;
  const detail=$('rsDetail'), detailText=[rsLimited ? RS_PC_LIMIT_TEXT : '', rsDetail, rsNote].filter(Boolean).join(' ');
  detail.textContent=detailText; detail.hidden=!detailText;
  const showQr=rsActive && rsReady && !!$('rsQr').dataset.url;
  $('rsQr').hidden=!showQr; $('rsUrlField').hidden=!(rsActive && rsReady);
  $('rsNewCodeBtn').textContent = rsActive ? 'New code' : 'Try again';
  const pill=$('rsPill'); pill.hidden=!rsActive;
  $('rsPillText').textContent = rsLimited ? '📱 '+RS_PC_LIMIT_TEXT : rsState==='connected' ? '📱 Phone scanner connected' : rsState==='disconnected' ? '📱 Phone scanner: phone disconnected' : rsState==='waiting' ? '📱 Phone scanner: waiting for phone' : '📱 Phone scanner: connecting…';
  pill.dataset.state=rsLimited ? 'disconnected' : rsState;
  rsRenderCount();
  renderQueue();
}

/* =====================  Phone side  ===================== */
let rsPhoneActive=false, rsPhoneId='', rsPhoneInst='', rsPhoneSub=null, rsPhoneCur=null, rsPhoneSid=0, rsPhoneLinked=false, rsPhoneOpened=false;
let rsPhoneTimer=0, rsPhoneWait=0, rsPhoneCtl=null, rsPhoneSeq=0, rsPhoneHellos=0, rsPhoneLimited=false, rsPhoneRecon=false, rsPhoneSending=0;
let rsSent=[], rsWake=null;

// Reads ?pair=ID (and clears it from the address bar); falls back to the pairing kept for this tab. Returns {id,relay} or null.
function readPairing(){
  let found=null;
  try{
    const q=new URLSearchParams(location.search), id=q.get('pair');
    if(id!==null){
      if(RS_ID_RE.test(id)) found={id, relay:q.get('relay')||''};
      q.delete('pair'); q.delete('relay');
      const qs=q.toString();
      history.replaceState(null,'',location.pathname+(qs?'?'+qs:'')+location.hash);
      if(!found) toast('That pairing link is not valid. Show the QR code on the computer again.', 8000);
      else try{sessionStorage.setItem(RS_PAIR_KEY,JSON.stringify(found));}catch(_){}
    }
  }catch(_){}
  if(!found) try{const s=JSON.parse(sessionStorage.getItem(RS_PAIR_KEY)||'null'); if(s && RS_ID_RE.test(s.id)) found={id:s.id, relay:s.relay||''};}catch(_){}
  return found;
}
function remoteScanTarget(){return {box:$('rsScanner'), video:$('rsVideo'), text:$('rsScannerText'), status:rsScanStatus, found:rsPhoneSend, continuous:true};}
function rsScanStatus(msg){
  $('rsScanMsg').textContent=msg||'';
  if(!$('rsScanner').classList.contains('active')) releaseWake();
}
async function requestWake(){   // keeps the phone's screen on while it scans
  try{if(navigator.wakeLock && !rsWake){rsWake=await navigator.wakeLock.request('screen'); rsWake.addEventListener('release',()=>{rsWake=null;});}}catch(_){}
}
function releaseWake(){try{rsWake && rsWake.release();}catch(_){} rsWake=null;}
function setPhoneStatus(text,state,detail='',retry=state==='bad'){
  const s=$('rsPhoneStatus'), d=$('rsPhoneDetail');
  s.textContent=text; s.dataset.state=state;
  d.textContent=detail; d.hidden=!detail;
  $('rsRetryBtn').hidden=!retry;
}
// The status line that matches the current state (after something temporary changed it).
function phoneShowStatus(){
  if(rsPhoneLimited) setPhoneStatus(RS_LIMIT_TEXT,'bad','',true);
  else if(rsPhoneLinked) setPhoneStatus('Connected ✓','ok',rsPhoneSending ? `Sending ${rsPhoneSending} saved barcode${rsPhoneSending===1?'':'s'}…` : '');
  else setPhoneStatus('Connecting to PC…','busy');
}
function phoneTeardown(){   // also invalidates every callback of the attempt being torn down (they compare their sid with rsPhoneSid)
  ++rsPhoneSid;
  clearTimeout(rsPhoneTimer); clearTimeout(rsPhoneWait);
  if(rsPhoneCtl) rsPhoneCtl.cancelled=true;
  const sub=rsPhoneSub; rsPhoneSub=null;
  try{sub && sub.close();}catch(_){}
  rsPhoneLinked=false; rsPhoneOpened=false; rsPhoneRecon=false;
}
/* One attempt = open the subscription to the PC's topic, say hello once it is open, and wait for hi. "Connected" = stream open AND the PC answered. */
function phoneConnect(){
  if(!rsPhoneActive) return;
  phoneTeardown();
  const sid=rsPhoneSid;
  rsPhoneCtl={cancelled:false}; rsPhoneHellos=0; rsPhoneLimited=false;
  phoneShowStatus();
  rsPhoneTimer=setTimeout(()=>phoneFail(sid,'relay'),RS_T.connectMs);
  rsPhoneSub=rsSubscribe(rsTopic(rsPhoneId,'r'),{
    cursor:rsPhoneCur,
    onOpen:first=>{
      if(sid!==rsPhoneSid) return;
      rsPhoneOpened=true; clearTimeout(rsPhoneTimer);
      if(first) phoneHello(sid);
      else if(rsPhoneRecon){rsPhoneRecon=false; phoneShowStatus();}
    },
    onMessage:m=>{if(sid===rsPhoneSid) onPcMessage(m);},
    onTrouble:info=>{
      if(sid!==rsPhoneSid) return;
      if(!rsPhoneOpened){if((info.pollFails||0)>=3) phoneFail(sid,'relay'); return;}
      if((info.errs||0)>=2 || info.pollFails){rsPhoneRecon=true; setPhoneStatus('Reconnecting to the relay…','busy');}
    }
  });
}
function phoneHello(sid){
  rsPhoneHellos++;
  rsPublish(rsTopic(rsPhoneId,'s'),{t:'hello',ph:rsPhoneInst},{ctl:rsPhoneCtl, probe:true}).then(r=>{
    if(sid!==rsPhoneSid || r.cancelled) return;
    if(r.ok){rsPhoneWait=setTimeout(()=>phoneNoHi(sid),RS_T.hiWaitMs); return;}
    phoneFail(sid, r.daily ? 'limit' : r.burst ? 'busy' : 'relay');
  });
}
function phoneNoHi(sid){   // no hi in time: say hello again a bounded number of times, then give up
  if(sid!==rsPhoneSid || rsPhoneLinked) return;
  if(rsPhoneHellos<RS_T.helloTries) phoneHello(sid); else phoneFail(sid,'notfound');
}
const RS_FAIL_TEXT={
  notfound:['PC not found — is the PC window still open?','On the computer, keep the "Use phone as scanner" window open (or the "Phone scanner" pill showing), then press Try again.'],
  relay:['Could not reach the relay (ntfy.sh).','Both devices need internet access. Check this phone\'s connection and press Try again.'],
  busy:['The relay (ntfy.sh) is busy.','It is limiting how fast messages are accepted. Wait a minute and press Try again.']
};
function phoneFail(sid,kind){
  if(sid!==rsPhoneSid || !rsPhoneActive) return;
  phoneTeardown();
  if(kind==='limit'){phoneOnDaily(); return;}
  const [text,detail]=RS_FAIL_TEXT[kind]||RS_FAIL_TEXT.relay;
  setPhoneStatus(text,'bad',detail);
}
function phoneLinked(){
  if(rsPhoneLinked) return;
  clearTimeout(rsPhoneWait);
  rsPhoneLinked=true; rsPhoneLimited=false;
  const sid=rsPhoneSid;
  phoneSendSaved(sid);   // codes saved while the daily quota was used up go first, oldest first
  phoneFlush();
  phoneShowStatus();
}
function phoneEnded(){
  phoneTeardown();
  setPhoneStatus('The computer ended the session.','bad','Open "Use phone as scanner" on the computer again and scan the new QR code.',false);
}
function phoneTakenOver(){
  phoneTeardown();
  setPhoneStatus('Another phone took over this scanner.', 'bad', 'Only one phone can be connected at a time. Press Try again to take the session back.');
}
function onPcMessage(m){
  if(!m || typeof m.t!=='string') return;
  const mine=m.ph===rsPhoneInst;
  if(m.t==='hi'){if(mine) phoneLinked(); return;}
  if(m.t==='bye'){phoneEnded(); return;}
  if(m.t==='takeover'){if(mine) phoneTakenOver(); return;}
  if(m.t!=='result' || typeof m.code!=='string' || m.code.length>40) return;
  if(typeof m.ph==='string' && !mine) return;   // meant for an earlier page of this phone
  const o=m.owned && typeof m.owned==='object' ? m.owned : null, title=rsText(m.title), err=rsText(m.error);
  const text = o ? `Already in collection: ${rsText(o.title)}${o.section ? ` (${rsText(o.section)})` : ''}` : title || err || 'No title found.';
  const cls = o ? 'warn' : title ? 'ok' : 'bad';
  rsSent.forEach(e=>{if(!e.done && (e.pub || e.busy) && e.code===m.code){e.done=true; e.text=text; e.cls=cls;}});
  renderSent();
}

/* ---- sending scans (and keeping them when the daily quota is used up) ---- */
function phoneTopicS(){return rsTopic(rsPhoneId,'s');}
function phonePublishScan(e){
  if(!e.n) e.n=++rsPhoneSeq;
  return rsPublish(phoneTopicS(),{t:'scan',code:e.code,n:e.n,ph:rsPhoneInst},{ctl:rsPhoneCtl, onWait:k=>{e.text=k==='offline' ? 'waiting for network…' : 'relay busy, trying again…'; renderSent();}});
}
function phoneTransmit(e){   // a live scan: one message
  if(e.busy || e.pub || e.saved || e.done) return;
  if(!rsPhoneLinked){e.text='waiting for the PC…'; return;}
  e.busy=true; e.text='sent…';
  phonePublishScan(e).then(r=>{
    e.busy=false;
    if(r.cancelled){if(!e.done) e.text='waiting for the PC…';}
    else if(r.ok){
      e.pub=true; if(!e.done) e.text='sent…';
      if(rsPhoneLimited){rsPhoneLimited=false; phoneShowStatus();}
    }else if(r.daily){phoneSave(e); phoneOnDaily();}
    else if(!e.done){e.done=true; e.cls='bad'; e.text=r.burst ? 'Not sent: the relay is busy. Scan it again in a minute.' : 'Not sent. Check this phone\'s internet connection and scan it again.';}
    renderSent(); renderLimitBanner();
  });
}
function phoneFlush(){   // sends what is still waiting for a connection, oldest first
  [...rsSent].reverse().forEach(e=>{if(!e.done && !e.pub && !e.saved && !e.busy) phoneTransmit(e);});
  renderSent();
}
function rsPhoneSend(code){   // called by scanner.js for every new barcode
  try{if(navigator.vibrate) navigator.vibrate(60);}catch(_){}
  const now=Date.now();
  if(rsSent.some(x=>x.code===code && (x.saved || now-x.at<SCAN_COOLDOWN_MS))) return;   // the same code again within the cooldown (or already saved): not sent twice
  const e={code, at:now, n:++rsPhoneSeq, text:'sent…', done:false, cls:'', pub:false, busy:false, saved:false};
  rsSent.unshift(e); trimSent();
  if(rsDailyBlocked()){phoneSave(e); renderSent(); renderLimitBanner(); return;}   // the quota is used up today: no network call, just keep it
  phoneTransmit(e); renderSent();
}
function trimSent(){   // keeps the list short, but never drops a saved code (those are sent from this list later)
  while(rsSent.length>40){
    let i=rsSent.length-1; while(i>=0 && rsSent[i].saved) i--;
    if(i<0) break;
    rsSent.splice(i,1);
  }
}
function phoneSave(e){
  rsPendingAdd(e.code);
  e.saved=true; e.busy=false; e.done=false; e.cls='warn'; e.text='saved for tomorrow';
  renderLimitBanner();
}
// The relay said "daily quota reached": keep everything that has not gone out, tell the user once, stop publishing until tomorrow.
function phoneOnDaily(){
  rsPhoneLimited=true;
  rsSent.forEach(e=>{if(!e.pub && !e.done && !e.saved && !e.busy) phoneSave(e);});
  phoneShowStatus(); renderSent(); renderLimitBanner();
}
// After pairing: send the saved codes, oldest first. A code leaves the storage only after its publish succeeded; a daily 429 stops the rest (they stay saved).
function phoneSendSaved(sid){
  const rows=rsSent.filter(e=>e.saved).reverse();
  if(!rows.length) return;
  rsPhoneSending=rows.length;
  rows.forEach(e=>{
    e.saved=false; e.busy=true; e.text='sending saved barcode…';
    phonePublishScan(e).then(r=>{
      e.busy=false; rsPhoneSending=Math.max(0,rsPhoneSending-1);
      if(r.ok){rsPendingRemove(e.code); e.pub=true; if(!e.done) e.text='sent…';}
      else{
        e.saved=true; e.cls='warn';
        e.text=r.daily ? 'saved for tomorrow' : r.cancelled ? 'saved, sends when connected' : 'saved, could not send now';
        if(r.daily) rsPhoneLimited=true;
      }
      if(sid===rsPhoneSid) phoneShowStatus();
      renderSent(); renderLimitBanner();
    });
  });
  renderSent(); phoneShowStatus();
}
function rsPendingLoad(){
  let list=null;
  try{list=JSON.parse(localStorage.getItem(RS_PENDING_KEY)||'null');}catch(_){}
  if(!Array.isArray(list)) list=rsPendingMem;
  const seen=new Set(), out=[];
  list.forEach(p=>{
    const code=p && cleanRemoteCode(p.code), key=code && barcodeKey(code);
    if(code && !seen.has(key)){seen.add(key); out.push({code, at:Number.isFinite(p.at) ? p.at : 0});}
  });
  return out;
}
let rsPendingMem=[];   // used only when localStorage is unavailable
function rsPendingStore(list){rsPendingMem=list; try{localStorage.setItem(RS_PENDING_KEY,JSON.stringify(list));}catch(_){}}
function rsPendingAdd(code){
  const list=rsPendingLoad(), key=barcodeKey(code);
  if(list.some(p=>barcodeKey(p.code)===key) || list.length>=RS_PENDING_MAX) return;
  list.push({code, at:Date.now()});
  rsPendingStore(list);
}
function rsPendingRemove(code){
  const key=barcodeKey(code);
  rsPendingStore(rsPendingLoad().filter(p=>barcodeKey(p.code)!==key));
}
function renderLimitBanner(){
  const box=$('rsLimitBanner'); if(!box) return;
  const list=rsPendingLoad(), n=list.length, blocked=rsDailyBlocked(), word=n===1 ? 'barcode' : 'barcodes';
  box.hidden=!(n || blocked);
  if(box.hidden) return;
  $('rsLimitText').textContent = blocked
    ? (n ? `Daily limit reached. Scan the rest tomorrow — the ${n} ${word} you scanned ${n===1?'is':'are'} saved on this phone and will be sent automatically the next time you connect to the computer.`
         : 'Daily limit reached. Scan the rest tomorrow, or keep scanning: barcodes are saved on this phone and will be sent automatically the next time you connect to the computer.')
    : `${n} ${word} saved on this phone ${n===1?'is':'are'} waiting. ${n===1?'It':'They'} will be sent automatically as soon as the computer answers.`;
  $('rsPendingSummary').textContent=`Saved barcodes (${n})`;
  $('rsPendingDetails').hidden=!n;
  const ul=$('rsPendingList'); ul.textContent='';
  list.forEach(p=>{const li=document.createElement('li'); li.textContent=p.code; ul.append(li);});
  $('rsPendingClearBtn').hidden=!n;
}
function clearSavedCodes(){
  const n=rsPendingLoad().length; if(!n) return;
  if(!confirm(`Delete the ${n} saved barcode${n===1?'':'s'} from this phone? They have not reached the computer yet.`)) return;
  rsPendingStore([]);
  rsSent=rsSent.filter(e=>!e.saved);
  renderSent(); renderLimitBanner();
}
function renderSent(){
  const ul=$('rsSent'); if(!ul) return;
  ul.textContent='';
  if(!rsSent.length){const li=document.createElement('li'); li.className='rsSentEmpty'; li.textContent='Nothing sent yet. Press Start scan and point the camera at a barcode.'; ul.append(li); return;}
  rsSent.forEach(e=>{
    const li=document.createElement('li'), code=document.createElement('code'), span=document.createElement('span');
    li.className=e.cls||''; code.textContent=e.code; span.textContent=e.text;
    li.append(code,span); ul.append(li);
  });
}
function rsResume(){   // the page came back to the foreground or the network returned: reconnect the streams right now (they continue from the last message seen)
  if(document.hidden) return;
  if(rsPhoneActive && rsPhoneSub) rsPhoneSub.kick();
  if(rsActive && rsSub) rsSub.kick();
}
function enterRemoteMode(pair){
  rsPickRelay(pair.relay);
  rsPhoneActive=true; rsPhoneId=pair.id; rsPhoneInst=rsRandomId(10); rsPhoneCur=rsNewCursor(); rsPhoneSeq=0;
  // codes saved on this phone earlier (daily quota) show up again, ready to be sent as soon as the PC answers
  rsSent=rsPendingLoad().reverse().map(p=>({code:p.code, at:0, n:0, text:rsDailyBlocked() ? 'saved for tomorrow' : 'saved, sends when connected', done:false, cls:'warn', pub:false, busy:false, saved:true}));
  document.body.classList.add('remoteMode');
  showScreen('remote');
  renderSent(); renderLimitBanner(); rsScanStatus('');
  phoneConnect();
}
function leaveRemoteMode(){
  rsPhoneActive=false;
  if(curTarget().box===$('rsScanner')) stopScanner(false);
  if(rsPhoneLinked) rsSendLast(phoneTopicS(),{t:'bye',ph:rsPhoneInst});   // so the PC shows that the phone left
  phoneTeardown(); releaseWake();
  try{sessionStorage.removeItem(RS_PAIR_KEY);}catch(_){}
  document.body.classList.remove('remoteMode');
  showScreen('library');
  showCollectionView();
}

/* ---- init hook (called from init() in app.js). Returns true when this tab is a paired phone scanner ---- */
function initRemoteScan(){
  try{rsPickRelay(new URLSearchParams(location.search).get('relay'));}catch(_){rsPickRelay('');}
  // PC side
  $('rsNewCodeBtn').addEventListener('click',newPhoneCode);
  $('scanModeLink').addEventListener('click',()=>setScanMode(scanMode()==='phone' ? 'camera' : 'phone'));
  $('rsPillMain').addEventListener('click',goToScanPanel);
  $('rsPillStop').addEventListener('click',stopPhoneSession);
  $('rsUrl').addEventListener('focus',e=>e.target.select());
  $('rsQueue').addEventListener('click',onQueueClick);
  $('rsAddAllBtn').addEventListener('click',()=>addQueued(rsQueue.filter(queueEligible)));
  $('rsClearBtn').addEventListener('click',()=>{rsQueue=[]; renderQueue();});
  // Closing / reloading this window ends the session. The phone is told (best effort) at beforeunload, because a request started during pagehide
  // can fail on a page that a service worker controls; pagehide then drops everything.
  window.addEventListener('beforeunload',rsSayBye);
  window.addEventListener('pagehide',()=>{if(rsActive){endPhoneSession(); rsState='connecting'; rsRender();}});
  applyScanPanel(); rsRender();
  // phone side
  bindScanToggle($('rsToggleBtn'),$('rsScanner'),()=>{startScanner(remoteScanTarget()); requestWake();},()=>stopScanner(true));
  $('rsRetryBtn').addEventListener('click',phoneConnect);
  $('rsExitBtn').addEventListener('click',leaveRemoteMode);
  $('rsPendingClearBtn').addEventListener('click',clearSavedCodes);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) rsResume();});
  window.addEventListener('online',rsResume);
  const pair=readPairing();
  if(!pair) return false;
  enterRemoteMode(pair);
  return true;
}
