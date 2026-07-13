import { SETUP_CSS } from './assets.js'

/**
 * Static assets for the engine-served HUD-layout editor (/settings/hud-layout?surface=<id>). Same discipline as
 * assets.ts: inert data, all decision-bearing rendering lives in surface-editor.ts (pure, node-tested);
 * the browser script here is thin event-delegation wiring over the EXISTING surface routes (GET/PUT
 * /layouts/surfaces[/:id]) — it composes them, adds no engine capability. The stylesheet reuses the
 * setup palette (SETUP_CSS) and adds the block-row widgets. Authored without backticks / ${ / </script
 * so it embeds safely in a template.
 */

export const SURFACE_EDITOR_CSS =
  SETUP_CSS +
  `
.prow input#surf-name{background:#0c0e13;color:var(--ink);border:1px solid var(--line);border-radius:6px;
  padding:6px 9px;font-size:14px;font-weight:600;width:220px}
h2{margin:26px 0 10px}
.blockrow{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:9px;
  padding:10px 12px;margin-bottom:8px;background:var(--card)}
.bmove{display:flex;flex-direction:column;gap:3px}
.bmove button,.bdel button{padding:2px 8px;font-size:12px}
.bmain{flex:1;min-width:0}
.btype{font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--accent);font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bchips{display:flex;gap:5px}
.bchip{font-family:var(--mono);font-size:10px;letter-spacing:.04em;text-transform:none;color:var(--muted);
  border:1px solid var(--line);border-radius:5px;padding:1px 6px;background:#0c0e13}
.bnote{color:var(--faint);font-size:11.5px;margin-top:4px}
.bctrls{display:flex;gap:14px;align-items:center;margin-top:8px;flex-wrap:wrap}
.bfield{color:var(--muted);font-size:12.5px;display:flex;gap:5px;align-items:center}
.bfield input[type=number]{width:58px;background:#0c0e13;color:var(--ink);border:1px solid var(--line);
  border-radius:6px;padding:4px 6px;font-size:12.5px}
.b-show{background:#0c0e13;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px 6px;font-size:12.5px}
.addblock{display:flex;gap:8px;align-items:center;margin:6px 0 4px}
.addblock select{background:#0c0e13;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-size:12.5px}
#raw-json{width:100%;min-height:220px;box-sizing:border-box;background:#0c0e13;color:var(--ink);
  border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-family:var(--mono);font-size:12px;margin-top:6px}
.rawbtns{margin-top:8px}
.srow{display:flex;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.srow:first-child{border-top:0}
.srow .pid{font-family:var(--mono);font-size:11px;color:var(--faint)}
.srow>*:last-child{margin-left:auto}
.srow .badge{margin-left:8px}
`

export const SURFACE_EDITOR_SCRIPT = `
(function(){
  function jf(method, path, body){
    var init={method:method,headers:{}};
    if(method==='POST'||method==='PUT'||method==='DELETE')init.headers['content-type']='application/json';
    if(body!==undefined)init.body=JSON.stringify(body);
    return fetch(path,init).then(function(r){return r.json().catch(function(){return null;}).then(function(j){return {ok:r.ok,status:r.status,json:j};});});
  }
  function slug(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-\$/g,'');}
  function el(tag,cls,txt){var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e;}
  function futureNote(type){return {ledger:'ledger store lands in P4 \\u2014 renders empty-but-explainable until then.'}[type];}
  function buildRow(type,def){
    var row=el('div','blockrow'); row.dataset.blockNew=type; row.dataset.block=type;
    var move=el('div','bmove');
    var up=el('button',null,'\\u2191'); up.type='button'; up.dataset.act='block-up'; up.title='move up';
    var dn=el('button',null,'\\u2193'); dn.type='button'; dn.dataset.act='block-down'; dn.title='move down';
    move.appendChild(up); move.appendChild(dn); row.appendChild(move);
    var main=el('div','bmain');
    var btype=el('div','btype'); btype.appendChild(document.createTextNode(type));
    if(def.query){var chips=el('span','bchips'); chips.appendChild(el('span','bchip','source '+def.query.source)); btype.appendChild(chips);}
    main.appendChild(btype);
    var nt=futureNote(type); if(nt)main.appendChild(el('div','bnote',nt));
    var ctrls=el('div','bctrls');
    var colLabel=el('label','bfield'); var col=document.createElement('input'); col.type='checkbox'; col.className='b-collapsed'; if(def.collapsed)col.checked=true;
    colLabel.appendChild(col); colLabel.appendChild(document.createTextNode(' collapsed')); ctrls.appendChild(colLabel);
    if(def.query){var topLabel=el('label','bfield'); topLabel.appendChild(document.createTextNode('top ')); var top=document.createElement('input'); top.type='number'; top.min='1'; top.max='50'; top.className='b-top';
      top.value=(def.top!=null?def.top:(def.query.top!=null?def.query.top:'')); topLabel.appendChild(top); ctrls.appendChild(topLabel);}
    var show=document.createElement('select'); show.className='b-show';
    ['','always','on-match','manual'].forEach(function(v){var o=document.createElement('option'); o.value=v; o.textContent=(v===''?'(show: default)':'show: '+v); if(v===(def.show||''))o.selected=true; show.appendChild(o);});
    ctrls.appendChild(show); main.appendChild(ctrls); row.appendChild(main);
    var del=el('div','bdel'); var x=el('button',null,'\\u2715'); x.type='button'; x.dataset.act='block-remove'; x.title='remove'; del.appendChild(x); row.appendChild(del);
    return row;
  }
  function addBlock(){
    var type=document.getElementById('add-block-type').value;
    var defs=JSON.parse(document.getElementById('block-defaults').textContent); var def=defs[type]; if(!def)return;
    document.getElementById('blocks').appendChild(buildRow(type,def));
  }
  function buildSurface(){
    var base=JSON.parse(document.getElementById('base-surface').textContent);
    var defs=JSON.parse(document.getElementById('block-defaults').textContent);
    var rows=document.querySelectorAll('#blocks .blockrow'); var stack=[];
    for(var i=0;i<rows.length;i++){
      var row=rows[i]; var block;
      if(row.dataset.idx!==undefined&&row.dataset.idx!==''){block=base.stack[parseInt(row.dataset.idx,10)];}
      else{block=JSON.parse(JSON.stringify(defs[row.dataset.blockNew]||{}));}
      if(!block)continue;
      var col=row.querySelector('.b-collapsed'); if(col){if(col.checked)block.collapsed=true; else delete block.collapsed;}
      var topEl=row.querySelector('.b-top'); if(topEl){var tv=topEl.value.trim(); if(tv){var n=parseInt(tv,10); if(isNaN(n)||n<1)n=1; if(n>50)n=50; block.top=n;} else {delete block.top;}}
      var showEl=row.querySelector('.b-show'); if(showEl){var sv=showEl.value; if(sv)block.show=sv; else delete block.show;}
      stack.push(block);
    }
    var name=(document.getElementById('surf-name').value||'').trim()||base.name;
    return {id:base.id,name:name,context:base.context,version:base.version,stack:stack};
  }
  function detailMsg(r){return (r.json&&r.json.details)?': '+r.json.details.join('; '):'';}
  function saveSurface(){
    var surf=buildSurface();
    if(!surf.stack.length){alert('A surface needs at least one block.');return;}
    jf('PUT','/layouts/surfaces/'+encodeURIComponent(surf.id),surf).then(function(r){
      if(!r.ok){alert('Save failed ('+r.status+detailMsg(r)+')');return;}
      location.href='/settings/hud-layout?surface='+encodeURIComponent(surf.id);
    });
  }
  function saveJson(){
    var ta=document.getElementById('raw-json'); var doc;
    try{doc=JSON.parse(ta.value);}catch(e){alert('That is not valid JSON.');return;}
    var base=JSON.parse(document.getElementById('base-surface').textContent);
    jf('PUT','/layouts/surfaces/'+encodeURIComponent(base.id),doc).then(function(r){
      if(!r.ok){alert('Save failed ('+r.status+detailMsg(r)+')');return;}
      location.href='/settings/hud-layout?surface='+encodeURIComponent(base.id);
    });
  }
  function cloneSurface(){
    var current=buildSurface(); var name=prompt('Name for the clone?'); if(!name)return;
    var nid=slug(name); if(!nid){alert('That name has no usable id characters.');return;}
    var copy=JSON.parse(JSON.stringify(current)); copy.id=nid; copy.name=name; copy.version=1;
    jf('GET','/layouts/surfaces/'+encodeURIComponent(nid)).then(function(g){
      if(g.ok){alert('A surface with id "'+nid+'" already exists.');return;}
      jf('PUT','/layouts/surfaces/'+encodeURIComponent(nid),copy).then(function(r){
        if(!r.ok){alert('Clone failed ('+r.status+detailMsg(r)+')');return;}
        location.href='/settings/hud-layout?surface='+encodeURIComponent(nid);
      });
    });
  }
  document.addEventListener('submit',function(e){e.preventDefault();});
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-act]'); if(!b)return; e.preventDefault();
    var act=b.dataset.act; var row=b.closest('.blockrow');
    if(act==='block-up'){var p=row.previousElementSibling; if(p&&p.classList.contains('blockrow'))row.parentNode.insertBefore(row,p);}
    else if(act==='block-down'){var n=row.nextElementSibling; if(n&&n.classList.contains('blockrow'))row.parentNode.insertBefore(n,row);}
    else if(act==='block-remove'){row.remove();}
    else if(act==='block-add'){addBlock();}
    else if(act==='surface-save'){saveSurface();}
    else if(act==='surface-save-json'){saveJson();}
    else if(act==='surface-clone'){cloneSurface();}
  });
})();
`
