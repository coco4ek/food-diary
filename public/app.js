"use strict";
const MEALS=[["breakfast","Завтрак"],["lunch","Обед"],["dinner","Ужин"],["snack","Перекус"]];
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,"0");
const key=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const r1=n=>Math.round((+n||0)*10)/10;
const uidGen=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);

let day=new Date(); day.setHours(12,0,0,0);
let meal=(h=>h<11?"breakfast":h<16?"lunch":h<22?"dinner":"snack")(new Date().getHours());
let dayData={entries:[]}; let goal=2000; const openSet=new Set();
let draft=[]; let draftNote=""; let photos=[]; let maxPhotos=4;

const cache={};

/* ---------- server API ---------- */
async function api(path,opts={}){
  // never hang forever: 30 s by default, longer for photo recognition
  const ctrl=new AbortController(),ms=opts.timeout||30000,t=setTimeout(()=>ctrl.abort(),ms);
  let res;
  try{res=await fetch("/api"+path,{credentials:"same-origin",cache:"no-store",signal:ctrl.signal,headers:opts.body?{"content-type":"application/json"}:{},method:opts.method,body:opts.body?JSON.stringify(opts.body):undefined})}
  catch(e){throw Object.assign(new Error(e.name==="AbortError"?"Сервер не ответил вовремя. Проверь интернет и попробуй ещё раз.":"Нет связи с сервером. Проверь интернет."),{code:0})}
  finally{clearTimeout(t)}
  if(res.status===401&&!path.startsWith("/auth/")){showLogin();throw Object.assign(new Error("Нужно войти"),{code:401})}
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(new Error(data.error||("Ошибка "+res.status)),{code:res.status,data});
  return data;
}
let me=null;
async function store(k,v){
  try{await api("/days/"+k,{method:"PUT",body:v});}
  catch(e){showMsg("Не удалось сохранить: "+e.message+". Проверь интернет и повтори.",true)}
}
async function prefetch(from,to){
  const missing=[];for(let d=new Date(from);key(d)<=key(to);d.setDate(d.getDate()+1))if(!(key(d) in cache))missing.push(key(d));
  if(!missing.length)return;
  const {days}=await api(`/days?from=${missing[0]}&to=${missing[missing.length-1]}`);
  for(const k of missing)if(!(k in cache)){const v=days[k]||{entries:[]};v.entries=(v.entries||[]).map(normEntry);cache[k]=v}
}
const normI=i=>({name:String(i.name||"Ингредиент"),grams:+i.grams||0,kcal:+i.kcal||0,protein:+i.protein||0,fat:+i.fat||0,carbs:+i.carbs||0});
const normEntry=e=>{if(!e.dishes){e.dishes=(e.items||[]).map(i=>({name:i.name,items:[i]}));delete e.items}return e};
async function getDay(k){ if(!(k in cache)){const d=new Date(k+"T12:00:00");await prefetch(d,d)} return cache[k]; }
const sumI=items=>items.reduce((t,i)=>(t.kcal+=+i.kcal||0,t.protein+=+i.protein||0,t.fat+=+i.fat||0,t.carbs+=+i.carbs||0,t.grams+=+i.grams||0,t),{kcal:0,protein:0,fat:0,carbs:0,grams:0});
const scale=(i,f)=>{i.grams*=f;i.kcal*=f;i.protein*=f;i.fat*=f;i.carbs*=f};
const macroTxt=t=>`Б ${r1(t.protein)} · Ж ${r1(t.fat)} · У ${r1(t.carbs)}`;
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function xbtn(label,fn){const x=el("button","x","×");x.setAttribute("aria-label",label);x.onclick=ev=>{ev.stopPropagation();fn()};return x}

/* ---------- rendering ---------- */
function totals(entries){return sumI(entries.flatMap(e=>e.dishes.flatMap(d=>d.items)))}
function dayName(d){
  const today=new Date();today.setHours(12,0,0,0);
  const diff=Math.round((today-d)/864e5);
  if(diff===0)return"Сегодня"; if(diff===1)return"Вчера";
  return d.toLocaleDateString("ru-RU",{day:"numeric",month:"long",weekday:"short"});
}
function renderSeg(){
  $("mealSeg").innerHTML="";
  for(const [k,l] of MEALS){const b=document.createElement("button");b.textContent=l;b.setAttribute("aria-pressed",k===meal);b.onclick=()=>{meal=k;renderSeg()};$("mealSeg").append(b)}
}
function renderDay(){
  const today=new Date();today.setHours(12,0,0,0);
  $("dayLabel").textContent=dayName(day);
  $("next").disabled=day>=today;
  const t=totals(dayData.entries);
  const left=Math.round(goal-t.kcal);
  $("eaten").textContent=Math.round(t.kcal);
  $("left").textContent=Math.abs(left);
  $("left").classList.toggle("over",left<0);
  $("leftLabel").textContent=left<0?"ккал сверх цели":"ккал осталось";
  const C=326.7, frac=Math.min(t.kcal/goal,1);
  $("ringProg").style.strokeDashoffset=C*(1-frac);
  $("ringProg").setAttribute("stroke",left<0?"var(--warn)":"var(--accent)");
  // macro targets: 30% / 30% / 40% of goal kcal
  const tgt={p:goal*.3/4,f:goal*.3/9,c:goal*.4/4};
  for(const [id,v,tg] of [["p",t.protein,tgt.p],["f",t.fat,tgt.f],["c",t.carbs,tgt.c]]){
    $("b"+id).style.width=Math.min(v/tg*100,100)+"%";
    $("t"+id).textContent=`${Math.round(v)} / ${Math.round(tg)} г`;
  }
  const box=$("meals");box.innerHTML="";
  if(!dayData.entries.length){
    box.innerHTML=`<div class="empty">Пока пусто. Сфотографируй тарелку — продукты и калории появятся здесь.</div>`;return;
  }
  for(const [k,l] of MEALS){
    const es=dayData.entries.filter(e=>e.meal===k); if(!es.length)continue;
    const sec=document.createElement("div");sec.className="meal";
    const kc=Math.round(totals(es).kcal);
    sec.innerHTML=`<h3>${l}<span>${kc} ккал</span></h3>`;
    for(const e of es) e.dishes.forEach((d,di)=>{
      const t=sumI(d.items), key2=e.id+":"+di;
      const multi=d.items.length>1||(d.items[0]&&d.items[0].name!==d.name);
      const wrap=el("div","dish"), row=el("div","item");
      const nm=el(multi?"button":"div","nm");
      const txt=el("div");txt.append(el("div",null,d.name),el("small",null,`${Math.round(t.grams)} г · ${macroTxt(t)}${multi?` · ${d.items.length} ингр.`:""}`));
      nm.append(el("span","chev",multi?"▸":""),txt);
      row.append(nm,el("div","k",Math.round(t.kcal)),xbtn("Удалить "+d.name,()=>removeDish(e.id,di)));
      wrap.append(row);
      if(multi){
        const ings=el("div","ings");const open=openSet.has(key2);ings.hidden=!open;nm.setAttribute("aria-expanded",open);
        d.items.forEach((it,ii)=>{
          const r=el("div","ing"),a=el("div");
          a.append(el("div",null,it.name),el("small",null,`${Math.round(it.grams)} г · ${macroTxt(it)}`));
          r.append(a,el("div","k",Math.round(it.kcal)),xbtn("Удалить "+it.name,()=>removeIng(e.id,di,ii)));ings.append(r);
        });
        nm.onclick=()=>{const o=!openSet.has(key2);o?openSet.add(key2):openSet.delete(key2);ings.hidden=!o;nm.setAttribute("aria-expanded",o)};
        wrap.append(ings);
      }
      sec.append(wrap);
    });
    box.append(sec);
  }
}
async function renderWeek(){
  const box=$("week");
  const days=[];for(let i=6;i>=0;i--){const d=new Date(day);d.setDate(d.getDate()-i);days.push(d)}
  await prefetch(days[0],days[6]);
  const data=days.map(d=>cache[key(d)]);
  const vals=data.map(x=>totals(x.entries).kcal);
  const max=Math.max(goal*1.25,...vals);
  box.innerHTML="";
  const gl=document.createElement("div");gl.className="goalline";
  // column area = 120px minus labels (~34px)
  gl.style.bottom=(34+(120-34)*goal/max)+"px";box.append(gl);
  days.forEach((d,i)=>{
    const b=document.createElement("button");b.className="wk"+(key(d)===key(day)?" cur":"");
    b.setAttribute("aria-label",`${dayName(d)}: ${Math.round(vals[i])} ккал`);
    b.innerHTML=`<div class="col"><i class="${vals[i]>goal?"over":""}" style="height:${vals[i]/max*100}%"></i></div><b>${vals[i]?Math.round(vals[i]):"—"}</b><small>${d.toLocaleDateString("ru-RU",{weekday:"short"})}</small>`;
    b.onclick=()=>{day=d;openDay()};box.append(b);
  });
}
async function openDay(){
  const from=new Date(day);from.setDate(from.getDate()-6);
  try{await prefetch(from,day)}catch(e){if(e.code!==401)showMsg("Не удалось загрузить дневник: "+e.message,true);return}
  dayData=cache[key(day)]; renderDay(); renderWeek();
}

/* ---------- draft (preview before adding) ---------- */
function updTotal(){$("prevTotal").textContent=draft.length?Math.round(sumI(draft.flatMap(d=>d.items)).kcal)+" ккал":"";$("save").disabled=!draft.length}
function numInput(id,label,v){const i=el("input","n");i.type="number";i.min="0";i.id=id;i.setAttribute("aria-label",label);i.value=Math.round(v)||"";return i}
function renderDraft(){
  $("preview").hidden=!draft.length&&!draftNote;
  const list=$("prevList");list.innerHTML="";
  draft.forEach((d,di)=>{
    const box=el("div","pd"), head=el("div","pi dh");
    const nm=el("input");nm.value=d.name;nm.placeholder="Название блюда";nm.id="pn"+di;
    const g=numInput("pg"+di,"Вес блюда, г",0), kc=el("span","kc");
    head.append(nm,g,kc,xbtn("Убрать блюдо",()=>{draft.splice(di,1);renderDraft()}));
    const meta=el("div","meta"), sm=el("small"), tog=el("button","tog");meta.append(sm,tog);
    const ings=el("div","ings");ings.hidden=!d._open;
    const refreshHead=(setG=true)=>{const t=sumI(d.items);if(setG)g.value=Math.round(t.grams)||"";kc.textContent=Math.round(t.kcal);sm.textContent=macroTxt(t);tog.textContent=`Состав (${d.items.length}) ${d._open?"▴":"▾"}`;tog.setAttribute("aria-expanded",!!d._open);updTotal()};
    const buildIngs=()=>{
      ings.innerHTML="";
      d.items.forEach((it,ii)=>{
        const r=el("div","pi");
        const n=el("input");n.value=it.name;n.placeholder="Ингредиент";n.id=`in${di}_${ii}`;n.oninput=()=>{it.name=n.value};
        const ig=numInput(`ig${di}_${ii}`,"Граммы",it.grams), ik=numInput(`ik${di}_${ii}`,"Ккал",it.kcal);
        ig.oninput=()=>{const ng=+ig.value||0;if(it.grams>0)scale(it,ng/it.grams);else it.grams=ng;ik.value=Math.round(it.kcal)||"";refreshHead()};
        ik.oninput=()=>{it.kcal=+ik.value||0;refreshHead()};
        r.append(n,ig,ik,xbtn("Убрать ингредиент",()=>{d.items.splice(ii,1);if(!d.items.length){draft.splice(di,1);renderDraft();return}buildIngs();refreshHead()}));
        ings.append(r);
      });
      const add=el("button","addIng","+ ингредиент");
      add.onclick=()=>{d.items.push({name:"",grams:100,kcal:0,protein:0,fat:0,carbs:0});buildIngs();refreshHead();$(`in${di}_${d.items.length-1}`).focus()};
      ings.append(add);
    };
    nm.oninput=()=>{if(d.items.length===1&&d.items[0].name===d.name)d.items[0].name=nm.value;d.name=nm.value;if(d._open)buildIngs()};
    g.oninput=()=>{const ng=+g.value||0,t=sumI(d.items);if(ng>0&&t.grams>0){d.items.forEach(i=>scale(i,ng/t.grams));buildIngs();refreshHead(false)}};
    tog.onclick=()=>{d._open=!d._open;ings.hidden=!d._open;refreshHead(false)};
    buildIngs();refreshHead();
    box.append(head,meta,ings);list.append(box);
  });
  updTotal();
  $("note").hidden=!draftNote;$("note").textContent=draftNote;
}
function showMsg(t,err){const m=$("msg");m.hidden=!t;m.textContent=t||"";m.classList.toggle("err",!!err)}

async function estimate(){
  const text=$("text").value.trim();
  if(!text&&!photos.length){showMsg("Сфотографируй еду или опиши её словами.",true);return}
  $("calc").disabled=true;$("shoot").classList.add("busy");showMsg(photos.length?"Смотрю на фото и считаю…":"Считаю…");
  try{
    const images=await Promise.all(photos.map(p=>toDataURL(p.blob)));
    const res=await api("/estimate",{method:"POST",timeout:150000,body:{text,images,date:key(new Date())}});
    const raw=res&&Array.isArray(res.dishes)?res.dishes:res&&Array.isArray(res.items)?res.items.map(i=>({name:i.name,items:[i]})):[];
    const dishes=raw.map(d=>({name:String(d.name||"Блюдо"),items:(Array.isArray(d.items)&&d.items.length?d.items:[d]).map(normI),_open:false})).filter(d=>d.items.length);
    if(!dishes.length){showMsg(res&&res.note?String(res.note):"Не получилось разобрать еду. Попробуй другое фото или добавь пару слов.",true);return}
    draft=dishes;draftNote=String(res.note||"");showMsg("");renderDraft();
  }catch(e){
    if(e.code!==401)showMsg(e.message||String(e),true);
    if(e.code===503&&me&&me.isAdmin)toggleSettings(true);
  }finally{$("calc").disabled=false;$("shoot").classList.remove("busy")}
}
async function saveDraft(){ try{ await saveDraftInner() }catch(e){ console.error(e); showMsg("Не удалось добавить: "+(e.message||e),true) } }
async function saveDraftInner(){
  const dishes=draft.map(d=>{const dn=d.name.trim()||(d.items[0]&&d.items[0].name.trim())||"Блюдо";
    return{name:dn,items:d.items.filter(i=>i.kcal>0).map(i=>({...normI(i),name:i.name.trim()||dn}))}}).filter(d=>d.items.length);
  if(!dishes.length){showMsg("Укажи калории хотя бы для одного ингредиента.",true);return}
  const k=key(day); const d=await getDay(k);
  d.entries.push({id:uidGen(),meal,text:$("text").value.trim(),at:Date.now(),dishes});
  draft=[];draftNote="";$("text").value="";clearPhoto();renderDraft();showMsg("");
  renderDay();renderWeek();
  await store("day-"+k,{entries:d.entries});
}
async function mutate(eid,fn){
  const k=key(day); const d=await getDay(k);
  const e=d.entries.find(x=>x.id===eid); if(!e)return;
  fn(e); e.dishes=e.dishes.filter(x=>x.items.length);
  if(!e.dishes.length)d.entries=d.entries.filter(x=>x!==e);
  [...openSet].forEach(x=>x.startsWith(eid+":")&&openSet.delete(x));
  dayData=d;renderDay();renderWeek();
  await store("day-"+k,{entries:d.entries});
}
const removeDish=(eid,di)=>mutate(eid,e=>e.dishes.splice(di,1));
const removeIng=(eid,di,ii)=>mutate(eid,e=>e.dishes[di].items.splice(ii,1));
function clearPhoto(){photos.forEach(p=>URL.revokeObjectURL(p.url));photos=[];$("photo").value="";renderThumbs()}
function renderThumbs(){
  const box=$("thumbs");box.innerHTML="";box.hidden=!photos.length;
  photos.forEach((p,i)=>{const f=document.createElement("figure");const im=document.createElement("img");im.src=p.url;im.alt="Фото еды "+(i+1);
    const x=document.createElement("button");x.textContent="×";x.setAttribute("aria-label","Убрать фото");x.onclick=()=>{URL.revokeObjectURL(p.url);photos.splice(i,1);renderThumbs()};
    f.append(im,x);box.append(f)});
}
const toDataURL=b=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(b)});
/* phone photos are large: shrink to 1568px JPEG before sending */
async function shrink(file){
  try{
    const bmp=await createImageBitmap(file);
    const sc=Math.min(1,1568/Math.max(bmp.width,bmp.height));
    const c=document.createElement("canvas");c.width=Math.round(bmp.width*sc);c.height=Math.round(bmp.height*sc);
    c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(b=>r(b||file),"image/jpeg",.85));
  }catch(e){return file}
}

/* ---------- wiring ---------- */
renderSeg();
$("prev").onclick=()=>{day=new Date(day);day.setDate(day.getDate()-1);openDay()};
$("next").onclick=()=>{day=new Date(day);day.setDate(day.getDate()+1);openDay()};
$("calc").onclick=estimate;
$("text").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))estimate()});
$("save").onclick=saveDraft;
$("addRow").onclick=()=>{draft.push({name:"",items:[{name:"",grams:100,kcal:0,protein:0,fat:0,carbs:0}],_open:true});renderDraft();$("pn"+(draft.length-1)).focus()};
$("manual").onclick=()=>{draftNote="";$("addRow").click()};
$("photo").onchange=async()=>{
  const fs=[...$("photo").files].slice(0,Math.max(0,maxPhotos-photos.length));$("photo").value="";
  if(!fs.length)return;
  for(const f of fs){const b=await shrink(f);photos.push({blob:b,url:URL.createObjectURL(b)})}
  renderThumbs();estimate();
};
let goalT;$("goal").oninput=()=>{const v=+$("goal").value;if(v>=800&&v<=6000){goal=v;renderDay();clearTimeout(goalT);goalT=setTimeout(()=>{renderWeek();api("/me",{method:"PUT",body:{goal}}).catch(e=>showMsg(e.message,true))},600)}};

/* ---------- sign-in by email code ---------- */
function loginMsg(t,err){const m=$("loginMsg");m.hidden=!t;m.textContent=t||"";m.classList.toggle("err",!!err)}
function showLogin(){
  $("app").hidden=true;$("login").hidden=false;
  if(new URLSearchParams(location.search).get("link")==="invalid")loginMsg("Ссылка недействительна: она уже использована или устарела. Войди по почте.",true);
  try{const last=localStorage.getItem("kcal:email");if(last&&!$("lEmail").value)$("lEmail").value=last}catch(e){}
  setTimeout(()=>($("emailForm").hidden?$("lCode"):$("lEmail")).focus(),50);
}
let resendT=null;
function startResend(sec){
  clearInterval(resendT);const b=$("lResend");let left=sec;b.disabled=true;
  const tick=()=>{if(left<=0){clearInterval(resendT);b.disabled=false;b.textContent="Отправить ещё раз";return}b.textContent=`Ещё раз через ${left} с`;left--};
  tick();resendT=setInterval(tick,1000);
}
async function requestCode(){
  const email=$("lEmail").value.trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){loginMsg("Проверь адрес почты",true);$("lEmail").focus();return false}
  $("lSend").disabled=true;loginMsg("");
  try{
    const r=await api("/auth/request",{method:"POST",body:{email}});
    try{localStorage.setItem("kcal:email",email)}catch(e){}
    $("lTo").textContent=email;$("emailForm").hidden=true;$("codeForm").hidden=false;$("lCode").value="";$("lCode").focus();
    startResend(r.resendIn||60);return true;
  }catch(e){
    if(e.code===429&&e.data&&e.data.retryAfter&&!$("codeForm").hidden)startResend(e.data.retryAfter);
    loginMsg(e.message,true);return false;
  }finally{$("lSend").disabled=false}
}
$("emailForm").onsubmit=ev=>{ev.preventDefault();requestCode()};
$("lResend").onclick=()=>requestCode();
$("lBack").onclick=()=>{$("codeForm").hidden=true;$("emailForm").hidden=false;loginMsg("");$("lEmail").focus()};
$("lCode").addEventListener("input",()=>{const v=$("lCode").value.replace(/\D/g,"").slice(0,6);$("lCode").value=v;if(v.length===6)$("codeForm").requestSubmit()});
$("codeForm").onsubmit=async ev=>{
  ev.preventDefault();const code=$("lCode").value;if(code.length!==6){loginMsg("Введи 6 цифр из письма",true);return}
  $("lVerify").disabled=true;loginMsg("Проверяю…");
  try{await api("/auth/verify",{method:"POST",body:{email:$("lTo").textContent,code}});
    loginMsg("");$("codeForm").hidden=true;$("emailForm").hidden=false;
    if(!(await boot()))loginMsg("Код принят, но браузер не сохранил вход. Разреши cookie для этого сайта и попробуй ещё раз.",true)}
  catch(e){loginMsg(e.message,true);$("lCode").select()}finally{$("lVerify").disabled=false}
};

/* ---------- account ---------- */
function showLink(url,label){
  const box=$("linkBox");box.hidden=false;$("linkLabel").textContent=label;$("linkUrl").value=url;$("linkUrl").select();
}
$("copyLink").onclick=async()=>{try{await navigator.clipboard.writeText($("linkUrl").value);$("copyLink").textContent="Скопировано"}catch(e){$("linkUrl").select()}setTimeout(()=>$("copyLink").textContent="Копировать",1500)};
$("deviceLink").onclick=async()=>{try{const {url}=await api("/login-link",{method:"POST"});showLink(url,"Открой эту ссылку на другом устройстве в течение 15 минут. Сработает один раз.")}catch(e){showMsg(e.message,true)}};
$("logout").onclick=async()=>{try{await api("/logout",{method:"POST"})}catch(e){}location.href="/"};
function renderAccount(){
  $("who").textContent=me.name;
  $("whoEmail").textContent=me.email?`Вход по почте ${me.email}`:"";
  $("attachForm").hidden=!!me.email;
}
// accounts made by invite links can attach an email
$("attachForm").onsubmit=async ev=>{
  ev.preventDefault();const email=$("aEmail").value.trim();if(!email)return;
  try{await api("/auth/request",{method:"POST",body:{email}});$("aCodeRow").hidden=false;$("aCode").focus();sMsgA("Код отправлен на "+email)}
  catch(e){sMsgA(e.message,true)}
};
$("aVerify").onclick=async()=>{
  try{await api("/auth/verify",{method:"POST",body:{email:$("aEmail").value.trim(),code:$("aCode").value}});
    me=await api("/me");renderAccount();sMsgA("")}
  catch(e){sMsgA(e.message,true)}
};
function sMsgA(t,err){const m=$("attachForm").querySelector(".msg");m.textContent=t||"Привяжи почту, чтобы входить с любого устройства по коду.";m.classList.toggle("err",!!err)}

/* ---------- people (admins) ---------- */
const ago=ts=>{if(!ts)return"ещё не заходил";const m=Math.round((Date.now()-ts)/60000);if(m<2)return"только что";if(m<60)return m+" мин назад";const h=Math.round(m/60);if(h<24)return h+" ч назад";const d=Math.round(h/24);return d<30?d+" дн назад":new Date(ts).toLocaleDateString("ru-RU")};
function iMsg(t,kind){const m=$("inviteMsg");m.hidden=!t;m.textContent=t||"";m.className="msg"+(kind?" "+kind:"")}
async function loadPeople(){
  let data;try{data=await api("/users")}catch(e){iMsg(e.message,"err");return}
  $("peopleCount").textContent=data.users.length+" чел.";
  const ul=$("userList");ul.innerHTML="";
  for(const u of data.users){
    const r=el("div","urow"+(u.disabled?" off":""));const w=el("div","who");
    const n=el("b",null,u.name);w.append(n);
    if(u.isAdmin)w.append(el("span","tag adm","админ"));
    if(u.disabled)w.append(el("span","tag off","заблокирован"));
    if(u.id===data.me)w.append(el("span","tag","это ты"));
    w.append(el("small",null,`${u.email||"без почты"} · ${ago(u.lastSeen||u.lastLoginAt)}`));
    const acts=el("div","acts");
    if(u.id!==data.me){
      const adm=el("button","ghost",u.isAdmin?"Снять админа":"Сделать админом");adm.onclick=()=>setUser(u.id,{isAdmin:!u.isAdmin});
      const blk=el("button","ghost"+(u.disabled?"":" danger"),u.disabled?"Разблокировать":"Заблокировать");
      blk.onclick=()=>{if(!u.disabled&&!blk.dataset.armed){blk.dataset.armed=1;blk.textContent="Точно?";setTimeout(()=>{delete blk.dataset.armed;blk.textContent="Заблокировать"},4000);return}setUser(u.id,{disabled:!u.disabled})};
      acts.append(adm,blk);
    }
    r.append(w,acts);ul.append(r);
  }
  const il=$("inviteList");il.innerHTML="";
  if(data.invites.length){
    il.append(el("h4",null,"Ждут первого входа"));
    for(const i of data.invites){
      const r=el("div","urow"),w=el("div","who");w.append(el("b",null,i.email),el("small",null,"приглашён "+ago(i.createdAt)));
      const x=el("button","ghost","Отозвать");x.onclick=async()=>{try{await api("/invites/"+encodeURIComponent(i.email),{method:"DELETE"});loadPeople()}catch(e){iMsg(e.message,"err")}};
      const acts=el("div","acts");acts.append(x);r.append(w,acts);il.append(r);
    }
  }
}
async function setUser(id,body){try{await api("/users/"+id,{method:"PUT",body});loadPeople()}catch(e){iMsg(e.message,"err")}}
$("inviteForm").onsubmit=async ev=>{
  ev.preventDefault();const email=$("inviteEmail").value.trim();if(!email){$("inviteEmail").focus();return}
  $("inviteBtn").disabled=true;
  try{const r=await api("/invites",{method:"POST",body:{email}});$("inviteEmail").value="";
    iMsg(r.sent?`Приглашение отправлено на ${r.email}. Он войдёт по коду из письма.`:`${r.email} может входить: пусть откроет ${r.url} и введёт эту почту. Письмо не отправлено — почта на сервере не настроена.`,"ok");loadPeople()}
  catch(e){iMsg(e.message,"err")}finally{$("inviteBtn").disabled=false}
};

/* ---------- settings panel ---------- */
function toggleSettings(open){
  const p=$("settings");open=open??p.hidden;p.hidden=!open;$("gear").setAttribute("aria-expanded",open);
  if(open){if(me&&me.isAdmin){loadModel();loadPeople()}p.scrollIntoView({behavior:"smooth",block:"start"})}
}
$("gear").onclick=()=>toggleSettings();
$("closeSettings").onclick=()=>toggleSettings(false);
function sMsg(t,kind){const m=$("sMsg");m.hidden=!t;m.textContent=t||"";m.className="msg"+(kind?" "+kind:"")}
function fillModel(v){
  $("sBase").value=v.baseUrl;$("sModel").value=v.model;$("sThinking").checked=!!v.thinkingOff;$("sKey").value="";
  const st=$("keyState");
  if(v.keySource==="none"){st.textContent="ключ не задан";st.className="pill bad";$("keyHint").textContent="Без ключа распознавание фото не работает."}
  else{st.textContent="ключ задан";st.className="pill ok";
    $("keyHint").textContent=v.keySource==="app"?`Сохранён ключ ${v.keyHint}. Оставь поле пустым, чтобы не менять его.`:`Сейчас используется ключ ${v.keyHint} из файла .env на сервере. Новый ключ отсюда заменит его.`}
  $("sClearKey").hidden=v.keySource!=="app";
}
async function loadModel(){try{fillModel(await api("/settings"))}catch(e){sMsg(e.message,"err")}}
$("sShow").onclick=()=>{const k=$("sKey");const show=k.type==="password";k.type=show?"text":"password";$("sShow").textContent=show?"Скрыть":"Показать"};
$("modelForm").onsubmit=async ev=>{
  ev.preventDefault();$("sSave").disabled=true;
  try{const v=await api("/settings",{method:"PUT",body:{baseUrl:$("sBase").value,model:$("sModel").value,apiKey:$("sKey").value,thinkingOff:$("sThinking").checked}});
    fillModel(v);$("sKey").type="password";$("sShow").textContent="Показать";sMsg("Сохранено","ok")}
  catch(e){sMsg(e.message,"err")}finally{$("sSave").disabled=false}
};
$("sTest").onclick=async()=>{
  $("sTest").disabled=true;sMsg("Проверяю сохранённые настройки…");
  try{const r=await api("/settings/test",{method:"POST"});sMsg(r.message,"ok")}catch(e){sMsg(e.message,"err")}finally{$("sTest").disabled=false}
};
let clearArmed=null;
$("sClearKey").onclick=async()=>{
  if(!clearArmed){$("sClearKey").textContent="Точно удалить?";clearArmed=setTimeout(()=>{clearArmed=null;$("sClearKey").textContent="Удалить ключ"},4000);return}
  clearTimeout(clearArmed);clearArmed=null;$("sClearKey").textContent="Удалить ключ";
  try{fillModel(await api("/settings",{method:"PUT",body:{clearKey:true}}));sMsg("Ключ удалён","ok")}catch(e){sMsg(e.message,"err")}
};

async function boot(){
  try{me=await api("/me")}catch(e){if(e.code!==401&&e.code!==undefined){$("login").hidden=true;$("app").hidden=false;showMsg("Сервер недоступен: "+e.message,true)}return false}
  if(location.search)history.replaceState(null,"","/");
  goal=me.goal;$("goal").value=goal;
  renderAccount();$("people").hidden=!me.isAdmin;$("modelForm").hidden=!me.isAdmin;
  $("login").hidden=true;$("app").hidden=false;
  await openDay();
  return true;
}
boot();
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});
