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
.slot .note{color:var(--faint);font-size:12px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:7px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row input,.row select{background:#0c0e13;color:var(--ink);border:1px solid var(--line);
  border-radius:6px;padding:5px 8px;font-size:12.5px}
.row .f-name{width:120px}.row .f-url{flex:1;min-width:170px;font-family:var(--mono)}
.row .f-model{width:150px}.row .f-keyref{width:150px}
.row .ro{flex:1;color:var(--muted);font-size:12.5px;font-family:var(--mono)}
.rowbtns{display:flex;gap:5px}
.probe{flex-basis:100%;font-family:var(--mono);font-size:11.5px;color:var(--muted);padding-left:2px;min-height:0}
.probe.ok{color:var(--ok)}.probe.bad{color:var(--bad)}
.secrets .row input{width:auto}#secret-ref{width:180px}#secret-val{flex:1;min-width:180px}
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
    var probe=row.querySelector('.probe'); probe.className='probe'; probe.textContent='testing…';
    var ep=rowToEndpoint(row);
    if(!ep){probe.className='probe bad';probe.textContent='could not read this endpoint';return;}
    if(ep.kind==='http'&&!ep.url){probe.className='probe bad';probe.textContent='enter a URL first';return;}
    jf('POST','/fabric/test',ep).then(function(r){
      var p=r.json;
      if(p&&p.ok){probe.className='probe ok';
        probe.textContent='reachable'+(p.latencyMs!=null?' · '+p.latencyMs+'ms':'')+(p.tokPerSec!=null?' · '+p.tokPerSec+' tok/s (last measured)':'');}
      else{probe.className='probe bad';
        probe.textContent=((p&&p.error)?p.error:'unreachable')+((p&&p.hint)?' — '+p.hint:'');}
    });
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
      location.href='/setup?edit='+encodeURIComponent(nid);});}
  function activate(id){jf('POST','/fabric/profiles/'+encodeURIComponent(id)+'/activate').then(function(r){
    if(!r.ok){alert('Activate failed ('+r.status+')');return;}location.reload();});}
  function del(id){if(!confirm('Delete profile "'+id+'"?'))return;
    jf('DELETE','/fabric/profiles/'+encodeURIComponent(id)).then(function(r){
      if(r.status===409){alert((r.json&&r.json.error)?r.json.error:'Cannot delete the active profile — activate another first.');return;}
      if(!r.ok){alert('Delete failed ('+r.status+')');return;}location.href='/setup';});}
  function addSecret(){var ref=document.getElementById('secret-ref').value.trim();var val=document.getElementById('secret-val').value;
    if(!ref||!val){alert('Enter both a ref and a value.');return;}
    jf('PUT','/fabric/secrets/'+encodeURIComponent(ref),{value:val}).then(function(r){
      if(!r.ok){alert('Save failed ('+r.status+')');return;}location.reload();});}
  function delSecret(ref){if(!confirm('Forget secret "'+ref+'"?'))return;
    jf('DELETE','/fabric/secrets/'+encodeURIComponent(ref)).then(function(r){
      if(!r.ok){alert('Delete failed ('+r.status+')');return;}location.reload();});}
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-act]'); if(!b)return;
    var act=b.dataset.act; var row=b.closest('.row');
    if(act==='test'){testRow(row);}
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
  });
})();
`
