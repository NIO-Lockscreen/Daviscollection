/* ---------- Phone as scanner ----------
   The PC shows a QR code. The phone opens the app through it (?pair=ID), scans barcodes with scanner.js's camera code
   and sends each one to the PC over a WebRTC data channel (PeerJS + its free public signaling server, no server of our own).
   The PC looks the barcode up, checks the collection and queues it on the Add / scan screen; the reply goes back to the phone.
   PeerJS and the QR library are loaded lazily, only when someone pairs, pinned to an exact version with an SRI hash.
   Messages: phone -> PC {type:'barcode',code} {type:'ping'}; PC -> phone {type:'result',code,title,owned,error?} {type:'pong'}. */
const PEERJS_URL='https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
const PEERJS_SRI='sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu';
const QR_URL='https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const QR_SRI='sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k';
const RS_PAIR_KEY='movieVault.remotePair';   // sessionStorage on the phone: {id,peerhost}, so a reload stays paired
const RS_ID_RE=/^mv-[a-z0-9]{8,40}$/;
const RS_ALPHABET='abcdefghijklmnopqrstuvwxyz234567';   // 32 symbols: one random byte & 31, no modulo bias
const RS_PING_MS=8000;           // phone -> PC keep-alive; every message from the other side counts as a sign of life
const RS_DEAD_MS=24000;          // silence this long = the channel is dead (a sleeping phone does not always close it cleanly)
const RS_CONNECT_MS=20000;       // one connection attempt gets this long to open the data channel
const RS_RETRIES=5;              // bounded automatic retries (backoff 1.5 s, 3 s, 4.5 s ...)
const RS_QUEUE_MAX=100;
const RS_NO_SERVER='Could not reach the pairing server (0.peerjs.com). Both devices need internet access.';
const RS_STATUS={connecting:'Connecting…', waiting:'Waiting for phone', connected:'Phone connected ✓', disconnected:'Disconnected'};
const rsLoading={};
let rsPeerHost='';               // test hook: ?peerhost=localhost:9000 points PeerJS at a local `peer` server (loopback only)

/* ---- lazy vendor scripts (same pattern as loadQuagga in scanner.js) ---- */
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
const loadPeerJs=()=>loadVendor(PEERJS_URL,PEERJS_SRI,()=>typeof window.Peer==='function');
const loadQrCode=()=>loadVendor(QR_URL,QR_SRI,()=>typeof window.qrcode==='function');
// PeerJS cloud by default. Tests can set window.MV_PEER_OPTIONS (any PeerJS option) or open the app with ?peerhost=localhost:PORT.
function peerOptions(){
  const o={debug:0}, m=/^(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/.exec(rsPeerHost);
  if(m) Object.assign(o,{host:m[1], port:+m[2]||9000, path:'/', secure:false});
  return Object.assign(o,window.MV_PEER_OPTIONS||{});
}
/* The PC's peer id is the only access control: whoever knows it can connect and send barcodes to this window.
   It is ~80 random bits from crypto.getRandomValues, shown only in this window's QR code / address, and gone when the session stops. */
function rsRandomId(prefix='mv-'){
  const b=new Uint8Array(16); crypto.getRandomValues(b);
  return prefix+Array.from(b,x=>RS_ALPHABET[x&31]).join('');
}
// Only plausible barcodes get through: retail digits (8/12/13/14, check digit must match) or a short Code 128/39 label. Anything else is dropped.
function cleanRemoteCode(c){
  if(typeof c!=='string' || c.length>40) return '';
  c=normalizeBarcode(c);
  if(/^\d+$/.test(c)) return isRetailLength(c) && retailCheckOk(c) ? c : '';
  return /^[A-Za-z0-9][A-Za-z0-9.\-]{4,31}$/.test(c) ? c : '';
}
const rsText=(v,max=200)=>typeof v==='string' ? v.slice(0,max) : '';

/* =====================  PC side  ===================== */
let rsActive=false, rsReady=false, rsState='connecting', rsDetail='';
let rsPeer=null, rsConn=null, rsId='', rsSession=0, rsLastRx=0, rsWatch=0, rsSignalTries=0, rsDropped=0;
let rsQueue=[], rsSeq=0, rsChain=Promise.resolve();

async function startPhoneSession(){
  openRemoteModal();
  if(rsActive) return;
  if(location.protocol==='file:'){rsDetail='Open the app from its web address (not from a file on disk) to pair a phone.'; rsState='disconnected'; rsRender(); return;}
  const sid=++rsSession;
  rsActive=true; rsReady=false; rsState='connecting'; rsDetail=''; rsSignalTries=0; rsId=rsRandomId();
  $('rsQr').textContent=''; delete $('rsQr').dataset.url;
  rsRender();
  try{await loadPeerJs();}
  catch(e){if(sid===rsSession) failPhoneSession('Could not load the pairing library (PeerJS). Both devices need internet access: check this computer\'s connection and try again.'); return;}
  if(sid!==rsSession) return;
  let peer;
  try{peer=rsPeer=new Peer(rsId,peerOptions());}
  catch(e){failPhoneSession('This browser cannot make peer-to-peer (WebRTC) connections.'); return;}
  peer.on('open',()=>{
    if(sid!==rsSession) return;
    rsSignalTries=0; rsReady=true;
    if(rsState==='connecting' || (rsState==='disconnected' && !rsConn)) rsState='waiting';
    if(!rsConn) rsDetail='';
    showPairingQr();
    rsRender();
  });
  peer.on('connection',conn=>onPhoneConnection(sid,conn));
  peer.on('disconnected',()=>{   // lost the signaling server; an open data channel survives that
    if(sid!==rsSession || !rsActive || peer.destroyed) return;
    if(++rsSignalTries>RS_RETRIES){
      if(!rsReady) failPhoneSession(RS_NO_SERVER+' Try again in a moment.');
      else{rsDetail='Lost the pairing server. A phone that is already connected keeps working, but a new one cannot pair until you press Stop and start again.'; rsRender();}
      return;
    }
    setTimeout(()=>{if(sid===rsSession && rsActive && !peer.destroyed && peer.disconnected){try{peer.reconnect();}catch(_){}}},1000*rsSignalTries);
  });
  peer.on('error',err=>{
    if(sid!==rsSession) return;
    const t=err && err.type;
    if(t==='unavailable-id'){stopPhoneSession(); startPhoneSession(); return;}   // id already taken (practically impossible): start over with a new one
    if(t==='browser-incompatible' || t==='invalid-id' || t==='invalid-key' || t==='ssl-unavailable'){failPhoneSession('Pairing failed ('+t+'). This browser cannot be used for the phone scanner.'); return;}
    if(t==='webrtc'){rsDetail='A connection attempt from the phone failed. Some networks block peer-to-peer connections.'; rsRender();}
    // network / socket-* / server-error: the 'disconnected' handler retries and gives up after RS_RETRIES
  });
}
function onPhoneConnection(sid,conn){
  if(sid!==rsSession){try{conn.close();}catch(_){} return;}
  conn.on('open',()=>{
    if(sid!==rsSession){try{conn.close();}catch(_){} return;}
    // One phone at a time: the newest connection replaces the old one, so a phone that reconnects is never locked out by its own stale channel.
    const old=rsConn; rsConn=conn; rsLastRx=Date.now(); rsDetail='';
    if(old && old!==conn){try{old.send({type:'bye'});}catch(_){} setTimeout(()=>{try{old.close();}catch(_){}},300);}   // 'bye' stops that phone from reconnecting (two phones would otherwise keep replacing each other)
    rsState='connected';
    clearInterval(rsWatch); rsWatch=setInterval(()=>{if(rsConn && Date.now()-rsLastRx>RS_DEAD_MS) onPhoneGone(rsConn);},4000);
    rsRender();
  });
  conn.on('data',d=>{if(conn===rsConn){rsLastRx=Date.now(); onPhoneMessage(d);}});
  conn.on('close',()=>onPhoneGone(conn));
  conn.on('error',()=>onPhoneGone(conn));
}
function onPhoneGone(conn){
  if(conn!==rsConn) return;   // an old channel that was replaced
  rsConn=null; clearInterval(rsWatch);
  try{conn.close();}catch(_){}
  rsState='disconnected'; rsDetail='The phone lost contact. It reconnects by itself; if it does not, scan the QR code again.';
  rsRender();
}
function rsSend(msg){try{if(rsConn && rsConn.open) rsConn.send(msg);}catch(_){}}
function onPhoneMessage(d){
  if(!d || typeof d!=='object' || Array.isArray(d)) return;
  if(d.type==='ping'){rsSend({type:'pong'}); return;}
  if(d.type!=='barcode') return;
  const code=cleanRemoteCode(d.code);
  if(!code){rsDropped++; return;}
  queueRemoteCode(code);
}
function teardownPhoneSession(){
  rsSession++; clearInterval(rsWatch);
  const conn=rsConn, peer=rsPeer; rsConn=rsPeer=null;
  try{conn && conn.close();}catch(_){}
  try{peer && peer.destroy();}catch(_){}
  rsActive=rsReady=false;
}
function stopPhoneSession(){
  teardownPhoneSession();
  rsState='connecting'; rsDetail='';
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
  if(rsQueue.length>=RS_QUEUE_MAX){rsSend({type:'result',code,title:'',owned:null,error:'The queue on the computer is full. Add or dismiss some items there first.'}); return;}
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
  rsSend({type:'result', code:it.code, title:it.title, owned:o ? {title:o.movie.title, section:o.movie.section||''} : null, ...(err ? {error:err} : {})});
}
function queueEligible(it){return it.state==='found' && !!it.title && !findOwnedByBarcode(it.code);}
function renderQueue(){
  const panel=$('rsQueuePanel'), box=$('rsQueue'); if(!panel || !box) return;
  panel.hidden = !rsActive && !rsQueue.length;
  const hint = rsActive ? (rsState==='connected' ? 'Phone connected. Scan barcodes with it; they appear here.' : rsState==='waiting' ? 'Waiting for the phone. Scan the QR code to connect it.' : 'The phone is not connected right now.') : 'The phone scanner is stopped. These stay here until you add or dismiss them.';
  $('rsQueueHint').textContent=hint;
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

/* ---- QR modal + pill ---- */
function pairingUrl(){return location.origin+location.pathname+'?pair='+rsId+(rsPeerHost ? '&peerhost='+encodeURIComponent(rsPeerHost) : '');}
async function showPairingQr(){
  const url=pairingUrl(), sid=rsSession, box=$('rsQr');
  $('rsUrl').value=url;
  if(box.dataset.url===url) return;   // already drawn (the pairing server connection came back)
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
function openRemoteModal(){$('rsModal').classList.add('active'); rsRender();}
function closeRemoteModal(){$('rsModal').classList.remove('active');}
function rsRender(){
  const status=$('rsStatus'); if(!status) return;
  status.textContent=RS_STATUS[rsState]; status.dataset.state=rsState;
  const detail=$('rsDetail'); detail.textContent=rsDetail; detail.hidden=!rsDetail;
  const showQr=rsActive && rsReady && !!$('rsQr').dataset.url;
  $('rsQr').hidden=!showQr; $('rsUrlField').hidden=!(rsActive && rsReady);
  $('rsModalStopBtn').hidden=!rsActive; $('rsRestartBtn').hidden=rsActive;
  $('phoneScanBtn').textContent = rsActive ? 'Phone scanner: show QR code' : 'Use phone as scanner';
  const pill=$('rsPill'); pill.hidden=!rsActive;
  $('rsPillText').textContent = rsState==='connected' ? '📱 Phone scanner connected' : rsState==='disconnected' ? '📱 Phone scanner: phone disconnected' : rsState==='waiting' ? '📱 Phone scanner: waiting for phone' : '📱 Phone scanner: connecting…';
  pill.dataset.state=rsState;
  renderQueue();
}

/* =====================  Phone side  ===================== */
let rsPhoneActive=false, rsPhoneId='', rsPhonePeer=null, rsPhoneConn=null, rsPhoneSid=0, rsPhoneTries=0, rsPhoneRx=0, rsPhoneTimer=0, rsPhoneBeat=0, rsPhoneWait=0, rsPhoneLastFail='';
let rsSent=[], rsWake=null;

// Reads ?pair=ID (and clears it from the address bar); falls back to the pairing kept for this tab. Returns {id,peerhost} or null.
function readPairing(){
  let found=null;
  try{
    const q=new URLSearchParams(location.search), id=q.get('pair');
    if(id!==null){
      if(RS_ID_RE.test(id)) found={id, peerhost:q.get('peerhost')||''};
      q.delete('pair'); q.delete('peerhost');
      const qs=q.toString();
      history.replaceState(null,'',location.pathname+(qs?'?'+qs:'')+location.hash);
      if(!found) toast('That pairing link is not valid. Show the QR code on the computer again.', 8000);
      else try{sessionStorage.setItem(RS_PAIR_KEY,JSON.stringify(found));}catch(_){}
    }
  }catch(_){}
  if(!found) try{const s=JSON.parse(sessionStorage.getItem(RS_PAIR_KEY)||'null'); if(s && RS_ID_RE.test(s.id)) found={id:s.id, peerhost:s.peerhost||''};}catch(_){}
  return found;
}
function remoteScanTarget(){return {box:$('rsScanner'), video:$('rsVideo'), text:$('rsScannerText'), status:rsScanStatus, found:rsPhoneSend, continuous:true};}
function rsScanStatus(msg){
  $('rsScanMsg').textContent=msg||'';
  const on=$('rsScanner').classList.contains('active');
  $('rsStartBtn').disabled=on; $('rsStopBtn').disabled=!on;
  if(!on) releaseWake();
}
async function requestWake(){   // keeps the phone's screen on while it scans (the session dies when the phone sleeps)
  try{if(navigator.wakeLock && !rsWake){rsWake=await navigator.wakeLock.request('screen'); rsWake.addEventListener('release',()=>{rsWake=null;});}}catch(_){}
}
function releaseWake(){try{rsWake && rsWake.release();}catch(_){} rsWake=null;}
function setPhoneStatus(text,state,detail=''){
  const s=$('rsPhoneStatus'), d=$('rsPhoneDetail');
  s.textContent=text; s.dataset.state=state;
  d.textContent=detail; d.hidden=!detail;
  $('rsRetryBtn').hidden = state!=='bad';
}
function phoneTeardown(){   // also invalidates every callback of the attempt being torn down (they compare their sid with rsPhoneSid)
  ++rsPhoneSid;
  clearTimeout(rsPhoneTimer); clearInterval(rsPhoneBeat); clearTimeout(rsPhoneWait);
  const conn=rsPhoneConn, peer=rsPhonePeer; rsPhoneConn=rsPhonePeer=null;
  try{conn && conn.close();}catch(_){}
  try{peer && peer.destroy();}catch(_){}
}
async function phoneConnect(retry=false){
  if(!rsPhoneActive) return;
  phoneTeardown();
  const sid=++rsPhoneSid;
  setPhoneStatus(retry ? retryText(rsPhoneLastFail) : 'Connecting to PC…', 'busy');
  try{await loadPeerJs();}
  catch(e){if(sid===rsPhoneSid) setPhoneStatus('Could not load the pairing library.', 'bad', 'Both devices need internet access. Check this phone\'s connection and press Try again.'); return;}
  if(sid!==rsPhoneSid || !rsPhoneActive) return;
  let peer;
  try{peer=rsPhonePeer=new Peer(rsRandomId('mvp-'),peerOptions());}
  catch(e){setPhoneStatus('This browser cannot make peer-to-peer connections.', 'bad'); return;}
  const fail=kind=>{if(sid===rsPhoneSid) phoneAttemptFailed(sid,kind);};
  rsPhoneTimer=setTimeout(()=>fail('timeout'),RS_CONNECT_MS);
  peer.on('open',()=>{
    if(sid!==rsPhoneSid) return;
    const conn=rsPhoneConn=peer.connect(rsPhoneId,{reliable:true, serialization:'json'});
    conn.on('open',()=>{
      if(sid!==rsPhoneSid) return;
      clearTimeout(rsPhoneTimer); rsPhoneTries=0; rsPhoneRx=Date.now();
      setPhoneStatus('Connected ✓','ok');
      phoneFlush();
      clearInterval(rsPhoneBeat);
      rsPhoneBeat=setInterval(()=>{
        if(Date.now()-rsPhoneRx>RS_DEAD_MS){fail('dropped'); return;}
        try{conn.send({type:'ping'});}catch(_){fail('dropped');}
      },RS_PING_MS);
    });
    conn.on('data',d=>{rsPhoneRx=Date.now(); onPcMessage(d);});
    conn.on('close',()=>fail('dropped'));
    conn.on('error',()=>fail('dropped'));
  });
  peer.on('error',err=>{
    const t=err && err.type;
    if(t==='peer-unavailable') fail('notfound');
    else if(t==='network' || t==='socket-error' || t==='socket-closed' || t==='server-error') fail('server');
    else if(t==='webrtc') fail('timeout');
    else if(t==='browser-incompatible'){if(sid===rsPhoneSid) setPhoneStatus('This browser cannot make peer-to-peer connections.', 'bad');}
  });
  peer.on('disconnected',()=>{   // signaling dropped: only a problem while the data channel is not up yet
    if(sid===rsPhoneSid && !(rsPhoneConn && rsPhoneConn.open)) fail('server');
  });
}
const RS_FAIL_TEXT={
  notfound:['PC not found — is the PC window still open?','On the computer, keep the "Use phone as scanner" window open (or the "Phone scanner" pill showing), then press Try again.'],
  timeout:['Could not connect to the PC.','Some networks block direct phone-to-computer connections; try mobile data or another Wi-Fi. Both devices need internet.'],
  server:['Could not reach the pairing server.','Both devices need internet access.'],
  dropped:['Lost the connection to the PC.','Both devices need internet, and the PC window must stay open.']
};
function phoneAttemptFailed(sid,kind){
  if(sid!==rsPhoneSid || !rsPhoneActive) return;
  phoneTeardown();   // (so the close events this causes are ignored)
  const [text,detail]=RS_FAIL_TEXT[kind]||RS_FAIL_TEXT.dropped;
  rsPhoneLastFail=kind;
  if(++rsPhoneTries>RS_RETRIES){setPhoneStatus(text,'bad',detail); return;}
  setPhoneStatus(retryText(kind),'busy');
  rsPhoneWait=setTimeout(()=>phoneConnect(true),1500*rsPhoneTries);
}
function retryText(kind){return (kind==='notfound' ? RS_FAIL_TEXT.notfound[0]+' Retrying' : 'Reconnecting to PC')+` (${rsPhoneTries}/${RS_RETRIES})…`;}
function phoneFlush(){   // (re)sends everything the PC has not answered yet; the PC ignores repeats of a code it already holds
  [...rsSent].reverse().forEach(e=>{if(!e.done) phoneTransmit(e);});
  renderSent();
}
function phoneTransmit(e){
  const c=rsPhoneConn;
  try{if(c && c.open){c.send({type:'barcode',code:e.code}); e.text='sent…'; return;}}catch(_){}
  e.text='waiting for the PC…';
}
function rsPhoneSend(code){   // called by scanner.js for every new barcode
  try{if(navigator.vibrate) navigator.vibrate(60);}catch(_){}
  const e={code, text:'sent…', done:false, cls:''};
  rsSent.unshift(e); rsSent.length=Math.min(rsSent.length,40);
  phoneTransmit(e); renderSent();
}
function onPcMessage(d){
  if(d && typeof d==='object' && d.type==='bye'){
    phoneTeardown();
    setPhoneStatus('Another phone took over this scanner.', 'bad', 'Only one phone can be connected at a time. Press Try again to take the session back.');
    return;
  }
  if(!d || typeof d!=='object' || d.type!=='result' || typeof d.code!=='string') return;
  const o=d.owned && typeof d.owned==='object' ? d.owned : null, title=rsText(d.title), err=rsText(d.error);
  const text = o ? `Already in collection: ${rsText(o.title)}${o.section ? ` (${rsText(o.section)})` : ''}` : title || err || 'No title found.';
  const cls = o ? 'warn' : title ? 'ok' : 'bad';
  rsSent.forEach(e=>{if(!e.done && e.code===d.code){e.done=true; e.text=text; e.cls=cls;}});
  renderSent();
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
function phoneResume(){   // the page came back to the foreground or the network returned: reconnect now if the channel is not alive
  if(!rsPhoneActive || document.hidden) return;
  const alive=rsPhoneConn && rsPhoneConn.open && Date.now()-rsPhoneRx<RS_DEAD_MS;
  if(alive) return;
  if($('rsPhoneStatus').dataset.state==='busy' && rsPhoneTries===0) return;   // a first attempt is still under way
  rsPhoneTries=0; phoneConnect();
}
function enterRemoteMode(pair){
  rsPhoneActive=true; rsPhoneId=pair.id; rsPeerHost=pair.peerhost||rsPeerHost; rsPhoneTries=0; rsSent=[];
  document.body.classList.add('remoteMode');
  showScreen('remote');
  renderSent(); rsScanStatus('');
  phoneConnect();
}
function leaveRemoteMode(){
  rsPhoneActive=false;
  if(curTarget().box===$('rsScanner')) stopScanner(false);
  phoneTeardown(); releaseWake();
  try{sessionStorage.removeItem(RS_PAIR_KEY);}catch(_){}
  document.body.classList.remove('remoteMode');
  showScreen('library');
  showCollectionView();
}

/* ---- init hook (called from init() in app.js). Returns true when this tab is a paired phone scanner ---- */
function initRemoteScan(){
  try{rsPeerHost=new URLSearchParams(location.search).get('peerhost')||'';}catch(_){}
  // PC side
  $('phoneScanBtn').addEventListener('click',startPhoneSession);
  $('rsModalCloseBtn').addEventListener('click',closeRemoteModal);
  $('rsModal').addEventListener('click',e=>{if(e.target===$('rsModal')) closeRemoteModal();});
  window.addEventListener('keydown',e=>{if(e.key==='Escape') closeRemoteModal();});
  $('rsModalStopBtn').addEventListener('click',stopPhoneSession);
  $('rsRestartBtn').addEventListener('click',startPhoneSession);
  $('rsPillMain').addEventListener('click',openRemoteModal);
  $('rsPillStop').addEventListener('click',stopPhoneSession);
  $('rsUrl').addEventListener('focus',e=>e.target.select());
  $('rsQueue').addEventListener('click',onQueueClick);
  $('rsAddAllBtn').addEventListener('click',()=>addQueued(rsQueue.filter(queueEligible)));
  $('rsClearBtn').addEventListener('click',()=>{rsQueue=[]; renderQueue();});
  window.addEventListener('pagehide',()=>{if(rsActive){teardownPhoneSession(); rsState='connecting'; rsRender();}});   // frees the pairing id
  rsRender();
  // phone side
  $('rsStartBtn').addEventListener('click',()=>{startScanner(remoteScanTarget()); requestWake();});
  $('rsStopBtn').addEventListener('click',()=>stopScanner(true));
  $('rsRetryBtn').addEventListener('click',()=>{rsPhoneTries=0; phoneConnect();});
  $('rsExitBtn').addEventListener('click',leaveRemoteMode);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) phoneResume();});
  window.addEventListener('online',phoneResume);
  const pair=readPairing();
  if(!pair) return false;
  enterRemoteMode(pair);
  return true;
}
