/**
 * Static assets for the engine-served setup page: the stylesheet and the browser script, kept as
 * plain string constants (no build step — the repo hand-rolls its UI). These are inert data: all the
 * decision-bearing rendering is in view.ts (pure, node-tested); the browser script here is thin
 * event-delegation wiring over the EXISTING fabric/profile/secret routes (it composes them, adds no
 * engine capability). Mutations do their fetch then `location.reload()` so the page always reflects
 * real server state; pre-save endpoint-row edits (add/remove/reorder) are local DOM until Save PUTs
 * the whole profile. Authored without backticks / ${ / </script so it embeds safely in a template.
 */

/** The visual language loosely matches design/renderings (dark, glass, mono accents). */
export const SETUP_CSS = `
:root{--bg:#101216;--ink:#e8eaee;--muted:#8b919c;--faint:#6b7280;--line:#262a31;--card:#16191f;
  --accent:#e06a3c;--warn:#d9a13b;--ok:#4da47a;--bad:#d9534f;
  --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,monospace;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:system-ui,-apple-system,'SF Pro Text','Helvetica Neue',sans-serif;line-height:1.5;
  padding:28px max(16px,calc(50vw - 460px)) 80px}
h1{font-size:20px;font-weight:650;letter-spacing:-.01em;margin:0 0 2px}
h2{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);
  margin:34px 0 12px}
.sub{color:var(--muted);font-size:13px;margin:0 0 8px}
.mono{font-family:var(--mono)}
.banner{border:1px solid rgba(224,106,60,.4);background:rgba(224,106,60,.08);border-radius:11px;
  padding:14px 16px;margin:18px 0 4px;font-size:13.5px;color:var(--ink)}
.banner b{color:var(--accent)}
.ok-banner{border:1px solid rgba(77,164,122,.35);background:rgba(77,164,122,.07)}
.card{border:1px solid var(--line);background:var(--card);border-radius:11px;padding:14px 16px;margin-bottom:12px}
.prow{display:flex;align-items:center;gap:12px}
.prow .pname{font-weight:600;font-size:14px}
.prow .pid{font-family:var(--mono);font-size:11px;color:var(--faint)}
.prow .pdesc{color:var(--muted);font-size:12.5px;margin-top:4px}
.badge{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  border-radius:5px;padding:2px 7px;border:1px solid var(--line)}
.badge.active{color:var(--ok);border-color:rgba(77,164,122,.45);background:rgba(77,164,122,.1)}
.badge.editing{color:var(--accent);border-color:rgba(224,106,60,.45)}
.spacer{margin-left:auto}
button,select,input{font:inherit}
button{background:#1b1f28;color:var(--ink);border:1px solid var(--line);border-radius:7px;
  padding:5px 11px;font-size:12.5px;cursor:pointer}
button:hover{border-color:var(--muted)}
button.primary{background:var(--accent);border-color:var(--accent);color:#150c07;font-weight:600}
a{color:var(--accent);text-decoration:none;font-size:12.5px}
a:hover{text-decoration:underline}
.slot{border:1px solid var(--line);border-radius:9px;padding:11px 12px;margin-bottom:10px}
.slot .slk{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--accent);font-weight:600;margin-bottom:8px}
.slot .note{color:var(--faint);font-size:12px;margin-bottom:8px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:7px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row input,.row select{background:#0c0e13;color:var(--ink);border:1px solid var(--line);
  border-radius:6px;padding:5px 8px;font-size:12.5px}
.row .f-name{width:120px}.row .f-url{flex:1;min-width:170px;font-family:var(--mono)}
.row .f-model{width:150px}.row .f-keyref{width:150px}
.row .ro{flex:1;color:var(--muted);font-size:12.5px;font-family:var(--mono)}
.rowbtns{display:flex;gap:5px}
.probe{flex-basis:100%;font-family:var(--mono);font-size:11.5px;color:var(--muted);padding-left:2px;min-height:0}
.probe.ok{color:var(--ok)}.probe.bad{color:var(--bad)}.probe.warn{color:var(--warn)}
.probe button.hostbtn{font-size:11px;padding:2px 8px;margin-left:6px;font-family:var(--mono);vertical-align:baseline}
.row select.f-model{max-width:300px}
.row .f-keyref.attn{border-color:rgba(217,161,59,.7);box-shadow:0 0 0 3px rgba(217,161,59,.15)}
.secrets .row input{width:auto}#secret-ref{width:180px}#secret-val{flex:1;min-width:180px}
.getstarted{padding:18px 18px 16px}
.gs-head{font-size:16px;font-weight:650;letter-spacing:-.01em;margin-bottom:2px}
.caps{margin:14px 0 4px;display:flex;flex-direction:column;gap:10px}
.cap{display:flex;gap:11px;align-items:flex-start}
.cap-mark{font-family:var(--mono);font-size:14px;line-height:1.3;flex:none;width:16px;text-align:center}
.cap-mark.ok{color:var(--ok)}.cap-mark.no{color:var(--faint)}
.cap-body{flex:1;min-width:0}
.cap-title{font-size:13.5px;font-weight:600}
.cap-what{color:var(--muted);font-weight:400;font-size:12.5px}
.cap-later{color:var(--faint);font-family:var(--mono);font-size:10px;letter-spacing:.06em}
.cap-found{color:var(--ok);font-family:var(--mono);font-size:12px}
.cap-missing{color:var(--muted);font-size:12.5px}
.gs-actions{display:flex;gap:9px;align-items:center;margin-top:14px}
.gs-adv{margin-top:12px;font-size:12.5px}
.starter-offer{margin-top:16px;border-top:1px solid var(--line);padding-top:14px}
.starter-head{font-size:13.5px;font-weight:600;margin-bottom:2px}
.starter{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
.starter:first-of-type{border-top:0}
.starter-body{flex:1;min-width:0}
.starter-name{font-size:13px;font-weight:550}
.starter-meta{font-family:var(--mono);font-size:11px;color:var(--faint);font-weight:400;margin-left:6px}
.starter-desc{color:var(--muted);font-size:12px;margin-top:2px}
.starter-control{flex:none;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.starter-hint{color:var(--muted);font-size:12px}
.starter-hint code{font-family:var(--mono);background:#0c0e13;border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.starter-progress{color:var(--accent);font-family:var(--mono);font-size:12px}
.starter-error{color:var(--bad);font-size:12px}
details.advanced{margin-top:24px;border-top:1px solid var(--line);padding-top:8px}
details.advanced>summary{cursor:pointer;font-size:11px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--faint);padding:8px 0;list-style-position:inside}
details.advanced[open]>summary{color:var(--muted)}
.tryit{padding:18px 18px 16px}
.tryit-consent{color:var(--muted);font-size:12px;margin:8px 0 4px}
.tryit-form{display:flex;gap:9px;margin-top:14px;flex-wrap:wrap}
.tryit-form input{flex:1;min-width:220px;background:#0c0e13;color:var(--ink);border:1px solid var(--line);
  border-radius:7px;padding:8px 11px;font-size:13.5px}
.tryit-voicebar{display:flex;gap:9px;align-items:center;margin-top:10px}
.tryit-voicenote,.tryit-novoice{color:var(--faint);font-size:12px}
.tryit-status{min-height:0;margin-top:14px;font-size:13px;color:var(--muted)}
.tryit-status.ok{color:var(--ok)}.tryit-status.bad{color:var(--bad)}
.tryit-hint{margin-top:6px;color:var(--warn);font-size:12.5px}
.tryit-hint-link{display:inline-block;margin-top:8px}
.tryit-result{margin-top:12px}
.moment-card{display:flex;gap:12px;align-items:flex-start;border:1px solid rgba(77,164,122,.35);
  background:rgba(77,164,122,.06);border-radius:11px;padding:14px 16px}
.moment-glyph{font-size:18px;line-height:1.2;color:var(--ok);flex:none}
.moment-body{flex:1;min-width:0}
.moment-text{font-size:14.5px;font-weight:550;line-height:1.4}
.moment-meta{margin-top:6px;display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;
  font-family:var(--mono);font-size:11px;color:var(--faint)}
.moment-kind{color:var(--ok);text-transform:uppercase;letter-spacing:.08em}
.moment-prov{color:var(--muted)}
.moment-elapsed{margin-left:auto;color:var(--faint)}
`

/** Browser wiring: composes existing routes, reloads after mutations, tests endpoints inline. */
export const SETUP_SCRIPT = `
(function(){
  function jf(method, path, body){
    var init={method:method,headers:{}};
    if(body!==undefined){init.headers['content-type']='application/json';init.body=JSON.stringify(body);}
    return fetch(path,init).then(function(r){return r.json().catch(function(){return null;}).then(function(j){return {ok:r.ok,status:r.status,json:j};});});
  }
  function slug(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-\$/g,'');}
  function rowToEndpoint(row){
    if(row.dataset.kind!=='http'){try{return JSON.parse(row.dataset.json);}catch(e){return null;}}
    var q=function(s){return row.querySelector(s);};
    var ep={kind:'http',name:(q('.f-name').value.trim()||'endpoint'),url:q('.f-url').value.trim(),api:(row.dataset.api||'openai-compat')};
    var model=q('.f-model').value.trim(); if(model)ep.model=model;
    var keyRef=q('.f-keyref').value; if(keyRef)ep.auth={keyRef:keyRef};
    return ep;
  }
  function testRow(row){
    var probe=row.querySelector('.probe'); probe.className='probe'; probe.textContent='testing\\u2026';
    var ep=rowToEndpoint(row);
    if(!ep){probe.className='probe bad';probe.textContent='could not read this endpoint';return;}
    if(ep.kind==='http'&&!ep.url){probe.className='probe bad';probe.textContent='enter a URL first';return;}
    // llm rows run ping THEN a real 1-token generation (the ping-lies fix) — a server that answers a GET
    // but can’t load its model is caught. Other slots keep the cheap ping (generation needs their I/O).
    var slotEl=row.closest('.slot'); var slot=slotEl?slotEl.dataset.slot:'';
    var body=(slot==='llm')?Object.assign({},ep,{probe:'generate',slot:slot}):ep;
    jf('POST','/fabric/test',body).then(function(r){
      var p=r.json||{}; var parts=[];
      if(p.ok){parts.push('reachable'+(p.latencyMs!=null?' \\u00b7 '+p.latencyMs+'ms':''));}
      else{parts.push(((p.error)?p.error:'unreachable')+((p.hint)?' \\u2014 '+p.hint:''));}
      if(p.ok&&p.tokPerSec!=null)parts.push(p.tokPerSec+' tok/s (last measured)');
      var g=p.generate; var genBad=false;
      if(g){
        if(g.skipped){parts.push('generation skipped'+(g.note?' ('+g.note+')':''));}
        else if(g.ok){parts.push('generation \\u2713'+(g.latencyMs!=null?' '+g.latencyMs+'ms':''));}
        else{genBad=true; parts.push('generation \\u2717 '+(g.class?g.class+': ':'')+(g.error||g.hint||'failed'));}
      }
      var bad=!p.ok||genBad;
      probe.className='probe '+(bad?'bad':'ok');
      probe.textContent=parts.join(' \\u00b7 ');
    });
  }
  // --- Host-scan → model dropdown (HOST-SCAN + MODEL-DROPDOWN). These mirror the PURE, node-tested
  // decisions in view.ts (capabilitySummary / groupModelsForSlot / modelOptionLabel / modelDropdownHtml /
  // scanStatusLine / bareHostOf) — same discipline as the Try-it diagnose mirror. POST /fabric/scan only.
  var SLOT_ORDER=['llm','stt','tts','vlm','ocr','embed'];
  var SUMMARY_LABEL={llm:'chat'};
  function capSummary(models){
    var counts={}; models.forEach(function(m){(m.slots||[]).forEach(function(s){counts[s]=(counts[s]||0)+1;});});
    var slots=Object.keys(counts);
    slots.sort(function(a,b){var d=counts[b]-counts[a]; if(d)return d;
      var ia=SLOT_ORDER.indexOf(a),ib=SLOT_ORDER.indexOf(b);
      return (ia<0?SLOT_ORDER.length:ia)-(ib<0?SLOT_ORDER.length:ib);});
    return slots.map(function(s){return counts[s]+' '+(SUMMARY_LABEL[s]||s);}).join(' \\u00b7 ');
  }
  function modelOptionLabel(m){return (m.slots&&m.slots.length)?m.id+' \\u2014 '+m.slots.join('/'):m.id;}
  function slotOfRow(row){var s=row.closest('.slot'); return s?(s.dataset.slot||''):'';}
  function buildModelSelect(row,models){
    var slot=slotOfRow(row);
    var old=row.querySelector('.f-model'); if(!old)return;
    var current=(old.value||'').trim(); if(current==='__custom__')current='';
    var sorted=models.slice().sort(function(a,b){return a.id<b.id?-1:(a.id>b.id?1:0);});
    var matching=[],other=[];
    sorted.forEach(function(m){((m.slots||[]).indexOf(slot)>=0?matching:other).push(m);});
    var known=models.some(function(m){return m.id===current;});
    var sel=document.createElement('select'); sel.className='f-model'; sel.title='model \\u2014 discovered by scan';
    function opt(value,label,selected){var o=document.createElement('option'); o.value=value; o.textContent=label; if(selected)o.selected=true; return o;}
    if(current===''){sel.appendChild(opt('','(pick a model)',true));}
    else if(!known){sel.appendChild(opt(current,current+' (current \\u2014 not reported by this server)',true));}
    function group(label,list){if(!list.length)return; var g=document.createElement('optgroup'); g.label=label;
      list.forEach(function(m){g.appendChild(opt(m.id,modelOptionLabel(m),m.id===current));}); sel.appendChild(g);}
    group(slot+' \\u2014 matches this slot',matching);
    group('other models',other);
    sel.appendChild(opt('__custom__','custom\\u2026',false));
    row.dataset.customModel=current;
    old.parentNode.replaceChild(sel,old);
  }
  function bareHost(v){
    v=(v||'').trim(); if(!v)return null;
    if(/^https?:\\/\\//i.test(v)){try{return (new URL(v)).hostname||null;}catch(e){return null;}}
    var h=v.split('/')[0].split(':')[0]; return h||null;
  }
  function renderScanResult(row,h){
    var probe=row.querySelector('.probe'); var kr=row.querySelector('.f-keyref');
    if(h.reachable&&!h.authRequired){
      if(kr)kr.classList.remove('attn');
      if(h.models.length){buildModelSelect(row,h.models);
        probe.className='probe ok';
        probe.textContent='found '+h.models.length+' model'+(h.models.length===1?'':'s')+' \\u2014 '+capSummary(h.models)+' \\u2014 pick one in the model dropdown';}
      else{probe.className='probe'; probe.textContent='reachable \\u2014 no models loaded on this server';}
      return;
    }
    if(h.authRequired){
      probe.className='probe warn';
      probe.textContent='this server wants a key \\u2014 '+((h.error&&h.error.hint)||'add a key in Settings \\u2192 Keys and reference it via keyRef')+' \\u2014 then Scan again';
      if(kr)kr.classList.add('attn');
      return;
    }
    probe.className='probe bad';
    probe.textContent=h.error?(h.error.class+(h.error.message?': '+h.error.message:'')+' \\u2014 '+h.error.hint):'no answer from this server';
  }
  function hostBtn(probe,act,data,label){
    var btn=document.createElement('button'); btn.type='button'; btn.className='hostbtn'; btn.dataset.act=act;
    if(data.host)btn.dataset.host=data.host; if(data.url)btn.dataset.url=data.url; btn.textContent=label;
    probe.appendChild(document.createTextNode(' ')); probe.appendChild(btn);
  }
  function renderHostChoices(row,live,chosenUrl){
    var chosen=null; for(var i=0;i<live.length;i++){if(live[i].url===chosenUrl){chosen=live[i];break;}}
    if(!chosen)chosen=live[0];
    row.__scanHosts=live;
    row.querySelector('.f-url').value=chosen.url;
    renderScanResult(row,chosen);
    var probe=row.querySelector('.probe');
    live.forEach(function(h){
      if(h.url===chosen.url)return;
      hostBtn(probe,'scan-use',{url:h.url},'or use '+h.url+' ('+(h.authRequired?'wants a key':h.models.length+' model'+(h.models.length===1?'':'s'))+')');
    });
  }
  function scanBody(row,body){var kr=row.querySelector('.f-keyref'); if(kr&&kr.value)body.keyRef=kr.value; return body;}
  function scanHostPorts(row,host){
    var probe=row.querySelector('.probe'); probe.className='probe'; probe.textContent='scanning common ports on '+host+'\\u2026';
    jf('POST','/fabric/scan',scanBody(row,{host:host})).then(function(r){
      if(!r.ok){probe.className='probe bad'; probe.textContent='scan failed ('+r.status+((r.json&&r.json.error)?': '+r.json.error:'')+')'; return;}
      var hosts=(r.json&&r.json.hosts)||[];
      var live=hosts.filter(function(h){return h.reachable||h.authRequired;});
      if(!live.length){
        probe.className='probe bad';
        probe.textContent='nothing answered on '+host+' \\u2014 tried '+hosts.map(function(h){var p=h.url.split(':'); return ':'+p[p.length-1];}).join(' \\u00b7 ');
        return;
      }
      renderHostChoices(row,live,live[0].url);
    });
  }
  function scanRow(row){
    var probe=row.querySelector('.probe'); probe.className='probe'; probe.textContent='scanning\\u2026';
    var url=row.querySelector('.f-url').value.trim();
    if(!url){probe.className='probe bad'; probe.textContent='enter a URL (or a bare host) first'; return;}
    if(!/^https?:\\/\\//i.test(url)){
      var h=bareHost(url);
      if(!h){probe.className='probe bad'; probe.textContent='could not read a host from that \\u2014 use http://host:port or a bare host'; return;}
      scanHostPorts(row,h); return;
    }
    jf('POST','/fabric/scan',scanBody(row,{url:url})).then(function(r){
      if(!r.ok){probe.className='probe bad'; probe.textContent='scan failed ('+r.status+((r.json&&r.json.error)?': '+r.json.error:'')+')'; return;}
      var host=(r.json&&r.json.hosts&&r.json.hosts[0]);
      if(!host){probe.className='probe bad'; probe.textContent='scan returned nothing'; return;}
      renderScanResult(row,host);
      if(!host.reachable&&!host.authRequired){
        var bh=bareHost(url);
        if(bh)hostBtn(row.querySelector('.probe'),'scan-host',{host:bh},'scan common ports on '+bh);
      }
    });
  }
  function useScanHost(row,url){
    var live=row.__scanHosts||[];
    renderHostChoices(row,live,url);
  }
  function saveEditor(){
    var form=document.getElementById('editor');
    var base=JSON.parse(document.getElementById('base-fabric').textContent);
    var slots={};for(var k in base.slots)slots[k]=base.slots[k];
    var slotEls=form.querySelectorAll('.slot[data-slot]');
    for(var i=0;i<slotEls.length;i++){
      var sl=slotEls[i];var rows=sl.querySelectorAll('.row');var eps=[];
      for(var j=0;j<rows.length;j++){var ep=rowToEndpoint(rows[j]); if(ep&&(ep.kind!=='http'||ep.url))eps.push(ep);}
      slots[sl.dataset.slot]=eps;
    }
    var fabric={slots:slots}; if(base.memoryBudgetMb!=null)fabric.memoryBudgetMb=base.memoryBudgetMb;
    var targetId=form.dataset.targetId; var req;
    if(targetId){var meta=JSON.parse(form.dataset.profile);
      var profile={id:meta.id,name:meta.name,version:meta.version,fabric:fabric};
      if(meta.description)profile.description=meta.description;
      req=jf('PUT','/fabric/profiles/'+encodeURIComponent(targetId),profile);
    } else { req=jf('PUT','/fabric',fabric); }
    req.then(function(r){if(!r.ok){alert('Save failed ('+r.status+')');return;}location.reload();});
  }
  function addRow(slotKey){
    var sl=document.querySelector('.slot[data-slot="'+slotKey+'"] .rows');
    var tpl=document.getElementById('row-tpl');
    sl.appendChild(tpl.content.cloneNode(true));
  }
  function clone(id){var name=prompt('Name for the clone?'); if(!name)return; var nid=slug(name);
    if(!nid){alert('That name has no usable id characters.');return;}
    jf('POST','/fabric/profiles/'+encodeURIComponent(id)+'/clone',{id:nid,name:name}).then(function(r){
      if(r.status===409){alert('A profile with id "'+nid+'" already exists.');return;}
      if(!r.ok){alert('Clone failed ('+r.status+')');return;}
      location.href='/settings/endpoints?edit='+encodeURIComponent(nid);});}
  function activate(id){jf('POST','/fabric/profiles/'+encodeURIComponent(id)+'/activate').then(function(r){
    if(!r.ok){alert('Activate failed ('+r.status+')');return;}location.reload();});}
  function del(id){if(!confirm('Delete profile "'+id+'"?'))return;
    jf('DELETE','/fabric/profiles/'+encodeURIComponent(id)).then(function(r){
      if(r.status===409){alert((r.json&&r.json.error)?r.json.error:'Cannot delete the active profile — activate another first.');return;}
      if(!r.ok){alert('Delete failed ('+r.status+')');return;}location.href='/settings/profiles';});}
  function addSecret(){var ref=document.getElementById('secret-ref').value.trim();var val=document.getElementById('secret-val').value;
    if(!ref||!val){alert('Enter both a ref and a value.');return;}
    jf('PUT','/fabric/secrets/'+encodeURIComponent(ref),{value:val}).then(function(r){
      if(!r.ok){alert('Save failed ('+r.status+')');return;}location.reload();});}
  function delSecret(ref){if(!confirm('Forget secret "'+ref+'"?'))return;
    jf('DELETE','/fabric/secrets/'+encodeURIComponent(ref)).then(function(r){
      if(!r.ok){alert('Delete failed ('+r.status+')');return;}location.reload();});}
  function useSetup(){
    var el=document.getElementById('suggestion'); if(!el){alert('Nothing to apply.');return;}
    var fabric; try{fabric=JSON.parse(el.textContent);}catch(e){alert('Could not read the detected setup.');return;}
    var profile={id:'config-1',name:'Config 1',version:1,fabric:fabric,description:'Detected local setup.'};
    jf('PUT','/fabric/profiles/config-1',profile).then(function(r){
      if(!r.ok){alert('Setup failed ('+r.status+')');return;}
      jf('POST','/fabric/profiles/config-1/activate').then(function(r2){
        if(!r2.ok){alert('Activate failed ('+r2.status+')');return;}location.href='/settings/try-it';});});}
  // --- Tier zero: download + run a starter model (slice c). Composes existing routes only:
  // POST /fabric/local/download (explicit click), GET /fabric/local/models (poll progress), then
  // "Use this model" writes a local endpoint into config-1 via the existing profile routes.
  function pollStarter(modelId){
    jf('GET','/fabric/local/models').then(function(r){
      var list=r.json||[]; var m=null; for(var i=0;i<list.length;i++){if(list[i].model.id===modelId){m=list[i];break;}}
      if(!m)return;
      if(m.state==='ready'||m.state==='error'){location.reload();return;}
      var el=document.querySelector('.starter[data-id="'+modelId+'"] .starter-control');
      if(el){var pct=m.totalBytes?Math.floor((m.downloadedBytes||0)/m.totalBytes*100):null;
        el.textContent='downloading\\u2026 '+(pct!=null?pct+'%':Math.round((m.downloadedBytes||0)/1000000)+' MB');}
      setTimeout(function(){pollStarter(modelId);},1500);
    });
  }
  function downloadStarter(btn){
    var id=btn.dataset.id; var el=btn.closest('.starter-control'); if(el)el.textContent='starting download\\u2026';
    jf('POST','/fabric/local/download',{modelId:id}).then(function(r){
      if(!r.ok){alert('Download failed ('+r.status+')');location.reload();return;}
      pollStarter(id);
    });
  }
  function useStarter(btn){
    var slot=btn.dataset.slot; var runtime=btn.dataset.runtime; var id=btn.dataset.id; var name=btn.dataset.name;
    var slots={stt:[],tts:[],llm:[],vlm:[],ocr:[],embed:[]};
    slots[slot]=[{kind:'local',name:'starter-'+slot,runtime:runtime,model:id}];
    var profile={id:'config-1',name:'Config 1',version:1,fabric:{slots:slots},description:'Local starter model ('+name+').'};
    jf('PUT','/fabric/profiles/config-1',profile).then(function(r){
      if(!r.ok){alert('Setup failed ('+r.status+')');return;}
      jf('POST','/fabric/profiles/config-1/activate').then(function(r2){
        if(!r2.ok){alert('Activate failed ('+r2.status+')');return;}location.href='/settings/try-it';});});
  }
  // --- Try-it: say something, watch it become a moment (slice b). Composes existing routes only:
  // PUT /flags/:key (consent-flip), POST /sessions, POST /capture/:source, the /events WS, and the
  // read endpoints for honest failure introspection. No new engine capability.
  var tryit={session:null,ws:null,t0:0,done:false,timer:null};
  function readJsonBlob(id){var el=document.getElementById(id); if(!el)return null; try{return JSON.parse(el.textContent);}catch(e){return null;}}
  function tryitStatus(msg,cls){var el=document.getElementById('tryit-status'); if(!el)return; el.className='tryit-status'+(cls?' '+cls:''); el.textContent=msg;}
  function enableFlags(keys){
    return jf('GET','/flags').then(function(r){
      var flags=(r.json||[]); var byKey={}; for(var i=0;i<flags.length;i++)byKey[flags[i].key]=flags[i];
      var chain=Promise.resolve();
      keys.forEach(function(k){
        var f=byKey[k]; if(f&&f.default===true)return;
        chain=chain.then(function(){
          var body={key:k,default:true,scope:(f&&f.scope)||'engine',description:(f&&f.description)||k};
          if(f&&f.minTier)body.minTier=f.minTier;
          return jf('PUT','/flags/'+encodeURIComponent(k),body);
        });
      });
      return chain;
    });
  }
  function renderMoment(m){
    var glyphs=readJsonBlob('moment-glyphs')||{}; var elapsed=(Date.now()-tryit.t0)/1000;
    var res=document.getElementById('tryit-result'); res.textContent='';
    var card=document.createElement('div'); card.className='moment-card kind-'+m.kind;
    var g=document.createElement('span'); g.className='moment-glyph'; g.textContent=(glyphs[m.kind]||'\\u00b7'); card.appendChild(g);
    var body=document.createElement('div'); body.className='moment-body';
    var txt=document.createElement('div'); txt.className='moment-text'; txt.textContent=m.text; body.appendChild(txt);
    var meta=document.createElement('div'); meta.className='moment-meta';
    var kind=document.createElement('span'); kind.className='moment-kind'; kind.textContent=m.kind; meta.appendChild(kind);
    if(m.provenance){var pv=document.createElement('span'); pv.className='moment-prov';
      pv.textContent='via '+m.provenance.endpoint+(m.provenance.model?' \\u00b7 '+m.provenance.model:''); meta.appendChild(pv);}
    var el=document.createElement('span'); el.className='moment-elapsed'; el.textContent=elapsed.toFixed(1)+'s'; meta.appendChild(el);
    body.appendChild(meta); card.appendChild(body); res.appendChild(card);
  }
  function closeTryitWs(){if(tryit.ws){try{tryit.ws.close();}catch(e){} tryit.ws=null;}}
  function openTryitWs(sessionId){
    var proto=(location.protocol==='https:')?'wss://':'ws://'; var ws=new WebSocket(proto+location.host+'/events'); tryit.ws=ws;
    ws.onmessage=function(ev){
      var msg; try{msg=JSON.parse(ev.data);}catch(e){return;}
      if(!msg||!msg.payload||msg.payload.sessionId!==sessionId)return;
      if(msg.name==='distillate.updated'){if(!tryit.done)tryitStatus('Distilled the window \\u2014 extracting the moment\\u2026');}
      else if(msg.name==='moment.created'){
        tryit.done=true; if(tryit.timer)clearTimeout(tryit.timer);
        tryitStatus('Here it is \\u2014 your words became a moment.','ok'); renderMoment(msg.payload);
        jf('POST','/sessions/'+encodeURIComponent(sessionId)+'/end'); closeTryitWs();
      }
    };
  }
  function buildChunk(session,cfg,payload){
    var base={id:'try-'+Date.now(),sessionId:session.id,workspaceId:cfg.workspaceId,source:'mic',sequence:0,capturedAt:new Date().toISOString()};
    if(payload.audio){base.contentType=payload.contentType||'audio/webm'; base.encoding='base64'; base.data=payload.audio;}
    else{base.contentType='text/plain'; base.encoding='utf8'; base.data=payload.text;}
    return base;
  }
  // The Try-it card stops GUESSING (the three-truths rule). Instead of pinging and inferring,
  // it reads GET /queue — the drain records WHY it failed — and tells one of three distinct truths:
  //   1. a real classified failure on the current llm endpoint → THE REAL ERROR + hint + a link to Endpoints
  //   2. the chunk is still pending with no failure → "still queued — the model is slow, your text is safe"
  //   3. a healthy queue with no failure → "no moments found in your input" (the input genuinely had none)
  function tryitRealFailure(f){
    var el=document.getElementById('tryit-status'); if(!el)return;
    el.className='tryit-status bad'; el.textContent='';
    var line=document.createElement('span');
    line.textContent='The model couldn\\u2019t answer \\u2014 '+f.class+(f.serverMessage?': '+f.serverMessage:'')+'.';
    el.appendChild(line);
    if(f.hint){var h=document.createElement('div'); h.className='tryit-hint'; h.textContent=f.hint; el.appendChild(h);}
    var a=document.createElement('a'); a.className='tryit-hint-link'; a.href='/settings/endpoints'; a.textContent='Open Settings \\u2192 Endpoints';
    el.appendChild(a);
  }
  function diagnose(session,cfg){
    if(tryit.done)return;
    Promise.all([jf('GET','/flags'),jf('GET','/fabric'),jf('GET','/moments?workspace='+encodeURIComponent(cfg.workspaceId)+'&session='+encodeURIComponent(session.id)),jf('GET','/queue')]).then(function(rs){
      var flags=rs[0].json||[]; var fabric=rs[1].json||{slots:{}}; var moments=rs[2].json||[]; var queue=rs[3].json||{};
      if(moments&&moments.length){tryit.done=true; tryitStatus('The moment arrived.','ok'); renderMoment(moments[moments.length-1]); return;}
      var byKey={}; flags.forEach(function(f){byKey[f.key]=f;});
      var on=function(k){return byKey[k]&&byKey[k].default===true;};
      if(!on('distill.enabled')||!on('distill.moments')){tryitStatus('The distillation flags did not stick \\u2014 open Advanced setup and check distill.enabled and distill.moments.','bad');return;}
      var llm=(fabric.slots&&fabric.slots.llm)||[];
      if(!llm.length){tryitStatus('No language model is configured \\u2014 add one under Advanced setup and activate it.','bad');return;}
      var ep=llm[0];
      var f=queue&&queue.lastFailure;
      // Truth 1 — a real, classified failure on the endpoint we are actually using: show it, don't guess.
      if(f&&(f.endpoint===ep.name||(ep.url&&f.hint&&f.hint.indexOf(ep.url)>=0))){tryitRealFailure(f);return;}
      // Truth 2 — the text is still in the queue and nothing has failed: it is safe, the model is just slow.
      if(queue&&queue.pendingFiles>0){tryitStatus('Still queued \\u2014 the model is slow, but your text is safe and will process. Give it a moment.');return;}
      // Truth 3 — a healthy queue, no failure: the input genuinely produced no moment.
      tryitStatus('No moments found in your input \\u2014 try a clear commitment or decision, e.g. "we will ship on Thursday".');
    });
  }
  function runTryit(payload){
    var cfg=readJsonBlob('tryit-config'); if(!cfg){tryitStatus('Try-it is unavailable on this page.','bad');return;}
    closeTryitWs(); document.getElementById('tryit-result').textContent=''; tryit.done=false; if(tryit.timer)clearTimeout(tryit.timer);
    var keys=['distill.enabled','distill.moments']; if(payload.audio)keys.push('distill.transcribe');
    tryitStatus('Turning on distillation\\u2026');
    enableFlags(keys).then(function(){
      return jf('POST','/sessions',{workspaceId:cfg.workspaceId,modeId:cfg.modeId,title:'onboarding try-it'});
    }).then(function(r){
      if(!r||!r.ok){tryitStatus('Could not start a session'+(r?' ('+r.status+')':'')+'.','bad');return;}
      var session=r.json; tryit.session=session; openTryitWs(session.id);
      tryitStatus('Sending it to openinfo\\u2026');
      return jf('POST','/capture/mic',buildChunk(session,cfg,payload)).then(function(cr){
        if(!cr.ok){tryitStatus('Capture failed ('+cr.status+').','bad'); closeTryitWs(); return;}
        tryit.t0=Date.now(); tryitStatus('Spooled \\u2014 the drain is distilling it now\\u2026');
        tryit.timer=setTimeout(function(){diagnose(session,cfg);},15000);
      });
    }).catch(function(){tryitStatus('Something went wrong reaching the engine.','bad');});
  }
  function tryitType(){
    var input=document.getElementById('tryit-text'); var text=(input&&input.value||'').trim();
    if(!text){tryitStatus('Type a sentence first.','bad'); if(input)input.focus(); return;}
    runTryit({text:text});
  }
  function tryitVoice(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){tryitStatus('This browser cannot record audio \\u2014 use the type path.','bad');return;}
    tryitStatus('Requesting the microphone\\u2026');
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      var rec; try{rec=new MediaRecorder(stream,{mimeType:'audio/webm'});}catch(e){rec=new MediaRecorder(stream);}
      var parts=[]; rec.ondataavailable=function(e){if(e.data&&e.data.size)parts.push(e.data);};
      rec.onstop=function(){
        stream.getTracks().forEach(function(t){t.stop();});
        var blob=new Blob(parts,{type:rec.mimeType||'audio/webm'}); var reader=new FileReader();
        reader.onloadend=function(){var s=String(reader.result); var comma=s.indexOf(','); var b64=comma>=0?s.slice(comma+1):s;
          runTryit({audio:b64,contentType:(blob.type||'audio/webm').split(';')[0]});};
        reader.readAsDataURL(blob);
      };
      rec.start(); tryitStatus('Listening\\u2026 speak now (about 6 seconds).');
      setTimeout(function(){if(rec.state!=='inactive')rec.stop();},6000);
    }).catch(function(err){tryitStatus('Microphone unavailable'+(err&&err.name?' ('+err.name+')':'')+' \\u2014 use the type path.','bad');});
  }
  document.addEventListener('submit',function(e){e.preventDefault();});
  // The dropdown's escape hatch: choosing "custom…" swaps the select back to a free-text model
  // input (pre-filled with the last typed value) — the user is never trapped in the discovered list.
  document.addEventListener('change',function(e){
    var t=e.target;
    if(!t||!t.classList||!t.classList.contains('f-model')||t.tagName!=='SELECT')return;
    if(t.value!=='__custom__')return;
    var row=t.closest('.row');
    var inp=document.createElement('input'); inp.className='f-model'; inp.autocomplete='off';
    inp.placeholder='model (optional \\u2014 Scan fills a dropdown)';
    inp.value=(row&&row.dataset.customModel)||'';
    t.parentNode.replaceChild(inp,t); inp.focus();
  });
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-act]'); if(!b)return;
    e.preventDefault();
    var act=b.dataset.act; var row=b.closest('.row');
    if(act==='test'){testRow(row);}
    else if(act==='scan'){scanRow(row);}
    else if(act==='scan-host'){scanHostPorts(row,b.dataset.host);}
    else if(act==='scan-use'){useScanHost(row,b.dataset.url);}
    else if(act==='remove'){row.remove();}
    else if(act==='up'){var p=row.previousElementSibling; if(p&&p.classList.contains('row'))row.parentNode.insertBefore(row,p);}
    else if(act==='down'){var n=row.nextElementSibling; if(n&&n.classList.contains('row'))row.parentNode.insertBefore(n,row);}
    else if(act==='addrow'){addRow(b.dataset.slot);}
    else if(act==='save'){saveEditor();}
    else if(act==='activate'){activate(b.dataset.id);}
    else if(act==='clone'){clone(b.dataset.id);}
    else if(act==='delete'){del(b.dataset.id);}
    else if(act==='addsecret'){addSecret();}
    else if(act==='delsecret'){delSecret(b.dataset.ref);}
    else if(act==='use-setup'){useSetup();}
    else if(act==='download-model'){downloadStarter(b);}
    else if(act==='use-starter'){useStarter(b);}
    else if(act==='redetect'){location.href='/settings/get-started?discover=1';}
    else if(act==='tryit-type'){tryitType();}
    else if(act==='tryit-voice'){tryitVoice();}
  });
})();
`
