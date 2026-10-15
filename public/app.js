"use strict";
const MEALS=[["breakfast","Завтрак"],["lunch","Обед"],["dinner","Ужин"],["snack","Перекус"]];
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,"0");
const key=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const r1=n=>Math.round((+n||0)*10)/10;
const uidGen=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);

let day=new Date(); day.setHours(12,0,0,0);
// Default meal for a new entry comes from the clock; «Перекус» is only ever chosen by the person.
// 04:00–10:59 завтрак, 11:00–15:59 обед, 16:00–03:59 ужин
const mealByTime=(h=new Date().getHours())=>h>=4&&h<11?"breakfast":h>=11&&h<16?"lunch":"dinner";
let meal=mealByTime();
// when the food was eaten: from the photo (EXIF) or the clock; editable in the sheet
let mealAt=null,mealManual=false,timeManual=false;
let dayData={entries:[]}; let goal=2000; const openSet=new Set();
let draft=[]; let draftNote=""; let photos=[]; let maxPhotos=4;

const cache={};

/* ---------- server API ---------- */
async function api(path,opts={}){
  // never hang forever: 30 s by default, longer for photo recognition
  const ctrl=new AbortController(),ms=opts.timeout||30000,t=setTimeout(()=>ctrl.abort(),ms);
  if(opts.signal)opts.signal.addEventListener("abort",()=>ctrl.abort(),{once:true});
  let res;
  try{res=await fetch("/api"+path,{credentials:"same-origin",cache:"no-store",signal:ctrl.signal,headers:opts.body?{"content-type":"application/json"}:{},method:opts.method,body:opts.body?JSON.stringify(opts.body):undefined})}
  catch(e){if(opts.signal&&opts.signal.aborted)throw Object.assign(new Error("Отменено"),{code:-1});
    throw Object.assign(new Error(e.name==="AbortError"?"Сервер не ответил вовремя. Проверь интернет и попробуй ещё раз.":"Нет связи с сервером. Проверь интернет."),{code:0})}
  finally{clearTimeout(t)}
  if(res.status===401&&!path.startsWith("/auth/")){showLogin();throw Object.assign(new Error("Нужно войти"),{code:401})}
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(new Error(data.error||("Ошибка "+res.status)),{code:res.status,data});
  return data;
}
let me=null;
/* Days that failed to save stay here and are retried on demand, when the network returns,
   and when the app comes back to the foreground. Always the latest version of the day is sent. */
const unsaved=new Set();
const dayBody=d=>d.toilet&&d.toilet.length?{entries:d.entries,toilet:d.toilet}:{entries:d.entries};
async function store(k,v){
  try{await api("/days/"+k,{method:"PUT",body:v});unsaved.delete(k)}
  catch(e){
    if(e.code===401)return;
    unsaved.add(k);
    const net=!e.code||e.code>=500;
    toast(net?"Не сохранилось: нет связи с сервером. Запись не потеряна.":"Не сохранилось: "+e.message,true,{label:"Повторить",fn:flushUnsaved});
  }
}
let flushing=false;
async function flushUnsaved(){
  if(flushing||!unsaved.size)return;flushing=true;
  try{for(const k of [...unsaved]){if(cache[k])await api("/days/"+k,{method:"PUT",body:dayBody(cache[k])});unsaved.delete(k)}
    toast("Сохранено")}
  catch(e){toast("Всё ещё нет связи. Попробую сам, когда она появится.",true,{label:"Повторить",fn:flushUnsaved})}
  finally{flushing=false}
}
window.addEventListener("online",()=>flushUnsaved());
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")flushUnsaved()});
window.addEventListener("beforeunload",e=>{if(unsaved.size){e.preventDefault();e.returnValue=""}});
async function prefetch(from,to){
  const missing=[];for(let d=new Date(from);key(d)<=key(to);d.setDate(d.getDate()+1))if(!(key(d) in cache))missing.push(key(d));
  if(!missing.length)return;
  const {days}=await api(`/days?from=${missing[0]}&to=${missing[missing.length-1]}`);
  for(const k of missing)if(!(k in cache)){const v=days[k]||{entries:[]};v.entries=(v.entries||[]).map(normEntry);cache[k]=v}
}
const normI=i=>({name:String(i.name||"Ингредиент"),grams:+i.grams||0,kcal:+i.kcal||0,protein:+i.protein||0,fat:+i.fat||0,carbs:+i.carbs||0,...(i.fiber!=null?{fiber:+i.fiber||0}:{})});
const normEntry=e=>{if(!e.dishes){e.dishes=(e.items||[]).map(i=>({name:i.name,items:[i]}));delete e.items}return e};
async function getDay(k){ if(!(k in cache)){const d=new Date(k+"T12:00:00");await prefetch(d,d)} return cache[k]; }
const sumI=items=>items.reduce((t,i)=>(t.kcal+=+i.kcal||0,t.protein+=+i.protein||0,t.fat+=+i.fat||0,t.carbs+=+i.carbs||0,t.fiber+=+i.fiber||0,t.grams+=+i.grams||0,i.fiber!=null&&(t.hasFiber=true),t),{kcal:0,protein:0,fat:0,carbs:0,fiber:0,grams:0,hasFiber:false});
const scale=(i,f)=>{i.grams*=f;i.kcal*=f;i.protein*=f;i.fat*=f;i.carbs*=f;if(i.fiber!=null)i.fiber*=f};
/* Per-gram values are remembered on first edit, so clearing the field (0 g) never loses the ratio. */
const dens=it=>it._d||(it.grams>0?(it._d={kcal:it.kcal/it.grams,protein:it.protein/it.grams,fat:it.fat/it.grams,carbs:it.carbs/it.grams,fiber:it.fiber!=null?it.fiber/it.grams:null}):null);
function setGrams(it,g){const d=dens(it);it.grams=g;if(d){it.kcal=d.kcal*g;it.protein=d.protein*g;it.fat=d.fat*g;it.carbs=d.carbs*g;if(d.fiber!=null)it.fiber=d.fiber*g}}
function setKcal(it,v){it.kcal=v;if(it.grams>0){const d=dens(it)||{protein:0,fat:0,carbs:0};it._d={...d,kcal:v/it.grams}}}
/* "120 г" that turns into a number field; commits on Enter/blur, Esc cancels */
function gramsBtn(grams,label,onCommit){
  const b=el("button","gbtn",`${Math.round(grams)} г`);b.title="Изменить вес";b.setAttribute("aria-label",`${label}: изменить вес, сейчас ${Math.round(grams)} г`);
  b.onclick=ev=>{
    ev.stopPropagation();
    const inp=el("input","gin");inp.type="number";inp.inputMode="numeric";inp.min="1";inp.value=Math.round(grams);inp.setAttribute("aria-label",label+", граммы");
    let done=false;const finish=ok=>{if(done)return;done=true;const v=Math.round(+inp.value);if(ok&&v>0&&v!==Math.round(grams))onCommit(v);else inp.replaceWith(b)};
    inp.onkeydown=e=>{if(e.key==="Enter")finish(true);if(e.key==="Escape")finish(false)};
    inp.onblur=()=>finish(true);inp.onclick=e=>e.stopPropagation();
    b.replaceWith(inp);inp.focus();inp.select();
  };
  return b;
}
const macroTxt=t=>`Б ${r1(t.protein)} · Ж ${r1(t.fat)} · У ${r1(t.carbs)}${+t.fiber>=.5?` · Кл ${r1(t.fiber)}`:""}`;
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
  for(const [k,l] of MEALS){const b=document.createElement("button");b.textContent=l;b.setAttribute("aria-pressed",k===meal);b.onclick=()=>{meal=k;mealManual=true;renderSeg()};$("mealSeg").append(b)}
}
/* meal time: the viewed day + a clock time */
const atOn=(d,h,m)=>{const x=new Date(d);x.setHours(h,m,0,0);return x.getTime()};
function setMealAt(at,src){
  mealAt=at;$("mealTime").value=hm(at);$("mealTimeSrc").textContent=src||"";
  if(!mealManual){meal=mealByTime(new Date(at).getHours());renderSeg()}
}
function resetMealTime(){
  mealManual=false;timeManual=false;const now=new Date();
  setMealAt(key(day)===key(now)?now.getTime():atOn(day,now.getHours(),now.getMinutes()),"");
}
$("mealTime").onchange=()=>{const [h,m]=$("mealTime").value.split(":").map(Number);if(isNaN(h))return;timeManual=true;setMealAt(atOn(day,h,m),"")};
/* EXIF DateTimeOriginal of a JPEG (camera/gallery photo), as local time; null if absent */
async function exifTime(file){
  try{
    const b=new DataView(await file.slice(0,256*1024).arrayBuffer());
    if(b.getUint16(0)!==0xFFD8)return null;
    let o=2;
    while(o+4<b.byteLength){
      const mk=b.getUint16(o),len=b.getUint16(o+2);
      if(mk===0xFFE1&&b.getUint32(o+4)===0x45786966){ // "Exif"
        const t=o+10,le=b.getUint16(t)===0x4949,u16=x=>b.getUint16(t+x,le),u32=x=>b.getUint32(t+x,le);
        const tags=(ifd)=>{const n=u16(ifd),r={};for(let i=0;i<n;i++){const e=ifd+2+i*12;r[u16(e)]={type:u16(e+2),count:u32(e+4),val:u32(e+8)}}return r};
        const str=(tg)=>{let s="";for(let i=0;i<Math.min(tg.count,20);i++)s+=String.fromCharCode(b.getUint8(t+tg.val+i));return s};
        const ifd0=tags(u32(4));let tg=null;
        if(ifd0[0x8769]){const ex=tags(ifd0[0x8769].val);tg=ex[0x9003]||ex[0x9004]}
        tg=tg||ifd0[0x0132];if(!tg)return null;
        const m=str(tg).match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/);if(!m)return null;
        return new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5]).getTime();
      }
      if((mk&0xFF00)!==0xFF00)break;o+=2+len;
    }
  }catch(e){}
  return null;
}
function renderDay(){
  const today=new Date();today.setHours(12,0,0,0);
  if(view==="diary")setTitle();
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
  for(const [id,v,tg] of [["p",t.protein,tgt.p],["f",t.fat,tgt.f],["c",t.carbs,tgt.c],["x",t.fiber,30]]){
    $("b"+id).style.width=Math.min(v/tg*100,100)+"%";
    $("t"+id).textContent=`${Math.round(v)} / ${Math.round(tg)} г`;
  }
  renderWc();
  const box=$("meals");box.innerHTML="";
  if(!dayData.entries.length){
    box.innerHTML=`<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/></svg>Пока пусто. Нажми на камеру внизу и сфотографируй тарелку.</div>`;return;
  }
  for(const [k,l] of MEALS){
    const es=dayData.entries.filter(e=>e.meal===k).sort((a,b)=>(a.at||0)-(b.at||0)); if(!es.length)continue;
    const sec=document.createElement("div");sec.className="meal";
    const kc=Math.round(totals(es).kcal);
    const h3=el("h3"),lab=el("div","mh");lab.append(el("b",null,l));
    for(const e of es)if(e.at)lab.append(timeChip(e));
    h3.append(lab,el("span",null,`${kc} ккал`));sec.append(h3);const list=el("div","mlist");sec.append(list);
    for(const e of es) e.dishes.forEach((d,di)=>{
      const t=sumI(d.items), key2=e.id+":"+di;
      const multi=d.items.length>1||(d.items[0]&&d.items[0].name!==d.name);
      const wrap=el("div","dish"), row=el("div","item");
      const nm=el(multi?"button":"div","nm");a11yName(nm);
      const txt=el("div");txt.append(el("div",null,d.name),el("small",null,`${macroTxt(t)}${multi?` · ${d.items.length} ингр.`:""}`));
      nm.append(el("span","chev",multi?"▸":""),txt);
      const gb=gramsBtn(t.grams,d.name,v=>mutate(e.id,en=>{const dd=en.dishes[di],tg=sumI(dd.items).grams;if(tg>0)dd.items.forEach(i=>scale(i,v/tg));else dd.items[0].grams=v}));
      row.append(nm,gb,el("div","k",Math.round(t.kcal)),xbtn("Удалить "+d.name,()=>removeDish(e.id,di)));
      wrap.append(swipe(row,()=>removeDish(e.id,di)));
      if(multi){
        const ings=el("div","ings");const open=openSet.has(key2);ings.hidden=!open;nm.setAttribute("aria-expanded",open);
        d.items.forEach((it,ii)=>{
          const r=el("div","ing"),a=el("div");
          a.append(el("div",null,it.name),el("small",null,macroTxt(it)));
          const ib=gramsBtn(it.grams,it.name,v=>mutate(e.id,en=>{const x=en.dishes[di].items[ii];if(x.grams>0)scale(x,v/x.grams);else x.grams=v}));
          r.append(a,ib,el("div","k",Math.round(it.kcal)),xbtn("Удалить "+it.name,()=>removeIng(e.id,di,ii)));ings.append(swipe(r,()=>removeIng(e.id,di,ii)));
        });
        nm.onclick=()=>{if(swiping)return;const o=!openSet.has(key2);o?openSet.add(key2):openSet.delete(key2);ings.hidden=!o;nm.setAttribute("aria-expanded",o)};
        wrap.append(ings);
      }
      list.append(wrap);
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
  const filled=vals.filter(v=>v>0),avg=filled.length?filled.reduce((a,b)=>a+b,0)/filled.length:0,inGoal=filled.filter(v=>v<=goal*1.05).length;
  const ws=$("weekStats");ws.innerHTML="";
  for(const [v,s] of [[filled.length?Math.round(avg):"—","ккал в среднем"],[`${inGoal}/${filled.length||0}`,"дней в цели"],[filled.length?Math.round(Math.max(...filled)):"—","максимум"]]){
    const c=el("div","wstat");c.append(el("b",null,String(v)),el("small",null,s));ws.append(c)}
  if(view==="week")setTitle();
  box.innerHTML="";
  const gl=document.createElement("div");gl.className="goalline";
  // column area = box height minus the two label lines (~36px)
  const H=box.clientHeight||170;gl.style.bottom=(36+(H-36)*goal/max)+"px";box.append(gl);
  days.forEach((d,i)=>{
    const b=document.createElement("button");b.className="wk"+(key(d)===key(day)?" cur":"");
    b.setAttribute("aria-label",`${dayName(d)}: ${Math.round(vals[i])} ккал`);
    b.innerHTML=`<div class="col"><i class="${vals[i]>goal?"over":""}" style="height:${vals[i]/max*100}%"></i></div><b>${vals[i]?Math.round(vals[i]):"—"}</b><small>${d.toLocaleDateString("ru-RU",{weekday:"short"})}</small>`;
    b.onclick=()=>{day=d;haptic();go("diary");openDay()};box.append(b);
  });
  if(view==="week")renderWcReport();
}
/* time of a meal in the diary: tap to correct it */
function timeChip(e){
  const b=el("button","mtchip",hm(e.at));b.setAttribute("aria-label",`Время приёма ${hm(e.at)}: изменить`);
  b.onclick=()=>{
    const inp=el("input","mtin");inp.type="time";inp.value=hm(e.at);inp.setAttribute("aria-label","Время приёма пищи");
    let done=false;const fin=ok=>{if(done)return;done=true;const [h,m]=inp.value.split(":").map(Number);
      if(ok&&!isNaN(h)&&inp.value!==hm(e.at))mutate(e.id,en=>{en.at=atOn(day,h,m)});else inp.replaceWith(b)};
    inp.onchange=()=>fin(true);inp.onblur=()=>fin(true);inp.onkeydown=ev=>{if(ev.key==="Escape")fin(false)};
    b.replaceWith(inp);inp.focus();
  };
  return b;
}
/* ---------- toilet log: one tap = one mark with the time, then the stool type (Bristol scale 1–7) ---------- */
const hm=ts=>new Date(ts).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
const times=n=>n%10===1&&n%100!==11?"раз":[2,3,4].includes(n%10)&&![12,13,14].includes(n%100)?"раза":"раз";
const BRISTOL=[null,
  ["Твёрдые комки","сильный запор"],["Комковатая колбаска","запор"],["Колбаска с трещинами","норма"],
  ["Гладкая и мягкая","норма"],["Мягкие кусочки","мягче нормы"],["Кашица","лёгкая диарея"],["Жидкий","диарея"]];
const bsColor=t=>t<=2?"var(--f)":t<=4?"var(--c)":t===5?"var(--muted)":"var(--warn)";
const BS_SVG=[null,
  '<circle cx="7" cy="11" r="4"/><circle cx="16" cy="9" r="4.4"/><circle cx="25" cy="11.5" r="3.8"/>',
  '<circle cx="7" cy="10" r="4.6"/><circle cx="13" cy="9" r="4.8"/><circle cx="19.5" cy="10.5" r="4.6"/><circle cx="25.5" cy="9.5" r="4.4"/>',
  '<rect x="2.5" y="4.5" width="27" height="11" rx="5.5"/><path d="M9 4.5v3.5M15.5 15.5v-4M21 4.5v3M26 15.5v-3" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/>',
  '<rect x="2" y="5" width="28" height="10" rx="5"/>',
  '<ellipse cx="7.5" cy="10.5" rx="4.8" ry="3.4"/><ellipse cx="16.5" cy="9" rx="4.4" ry="3.2"/><ellipse cx="25" cy="11" rx="4.6" ry="3.3"/>',
  '<path d="M3 12c1-4 4-5 6-3 1-3 5-4 6.5-1 2-3 5.5-2 6 .5 3-1.5 6.5.5 5.5 3.5-1 3-4 2.5-5.5 2-2 2.5-5 2-6.5.5-2 1.8-5 1.5-6-.3-3 .8-6.5-.2-6-3.2z"/>',
  '<path d="M2 13.5c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0 5-2.2 7.5 0 4.2 2 5.5.6V17H2z"/><circle cx="9" cy="7" r="1.6"/><circle cx="17" cy="5" r="1.3"/><circle cx="23.5" cy="8" r="1.5"/>'];
const bsIcon=t=>`<svg viewBox="0 0 32 20" aria-hidden="true" fill="currentColor">${BS_SVG[t]}</svg>`;
const marksOf=d=>(d&&d.toilet||[]).map(x=>typeof x==="number"?{at:x}:x).sort((a,b)=>a.at-b.at);
let wcPick=null,wcNew=false; // the mark whose editor is open; wcNew = just added (offer «Пропустить»)
function renderWc(){
  const card=$("wc");card.hidden=!(me&&me.toilet);if(card.hidden)return;
  const list=marksOf(dayData),n=list.length,isToday=key(day)===key(new Date());
  $("wcCount").textContent=n?`${n} ${times(n)}${isToday?" сегодня":""} · последний в ${hm(list[n-1].at)}`:(isToday?"Сегодня ещё не отмечено":"Отметок нет");
  const box=$("wcList");box.innerHTML="";
  for(const m of list){
    const b=el("button","wcchip"+(m.at===wcPick?" sel":""));
    b.innerHTML=(m.t?`<i style="background:${bsColor(m.t)}"></i>`:"")+`<span>${hm(m.at)}</span>`+(m.t?`<small>${m.t}</small>`:"");
    b.setAttribute("aria-label",`Отметка в ${hm(m.at)}${m.t?", тип "+m.t+" — "+BRISTOL[m.t][0]:""}: изменить`);
    b.onclick=()=>{wcNew=false;wcPick=wcPick===m.at?null:m.at;renderWc()};box.append(b);
  }
  const pk=$("wcPick"),m=list.find(x=>x.at===wcPick);pk.hidden=!m;pk.innerHTML="";if(!m){wcPick=null;return}
  const head=el("div","wcph");const ttl=el("div");
  ttl.append(el("b",null,"Какой стул?"),el("small",null,m.t?`Тип ${m.t} — ${BRISTOL[m.t][0].toLowerCase()} (${BRISTOL[m.t][1]})`:"Бристольская шкала: от твёрдого к жидкому"));
  const tm=el("input","wctime");tm.type="time";tm.value=hm(m.at);tm.setAttribute("aria-label","Время");
  tm.onchange=()=>{const [h,mi]=tm.value.split(":").map(Number);if(isNaN(h))return;const d=new Date(m.at);d.setHours(h,mi,0,0);const at=d.getTime();wcPick=at;wcSet(list.map(x=>x.at===m.at?{...x,at}:x))};
  head.append(ttl,tm);
  const grid=el("div","bs");
  for(let t=1;t<=7;t++){
    const b=el("button","bsb"+(m.t===t?" on":""));b.style.setProperty("--bc",bsColor(t));
    b.innerHTML=`${bsIcon(t)}<b>${t}</b>`;b.title=`${t} — ${BRISTOL[t][0]} (${BRISTOL[t][1]})`;b.setAttribute("aria-label",b.title);
    b.setAttribute("aria-pressed",m.t===t);
    // the panel stays open (the choice can be changed); it closes on «Готово»
    b.onclick=()=>{haptic(10);wcNew=false;wcSet(list.map(x=>x.at===m.at?{...x,t}:x))};
    grid.append(b);
  }
  const foot=el("div","row");
  const del=el("button","ghost danger","Удалить");del.onclick=()=>{const was=list.slice();wcPick=null;wcSet(list.filter(x=>x.at!==m.at));toast("Отметка удалена",false,{label:"Вернуть",fn:()=>wcSet(was)})};
  const done=el("button","ghost",wcNew&&!m.t?"Пропустить":"Готово");done.onclick=()=>{wcPick=null;wcNew=false;renderWc()};
  foot.append(del,el("span","spacer"),done);
  pk.append(head,grid,foot);
}
async function wcSet(list){
  const k=key(day),d=await getDay(k);d.toilet=list.slice().sort((a,b)=>a.at-b.at);dayData=d;renderWc();
  if(view==="week")renderWeek();
  await store(k,dayBody(d));
}
$("wcAdd").onclick=async()=>{
  haptic(12);
  const now=new Date(),isToday=key(day)===key(now);
  let at=now.getTime();
  if(!isToday){const d=new Date(day);d.setHours(now.getHours(),now.getMinutes(),0,0);at=d.getTime()} // another day: same clock time, editable
  const d=await getDay(key(day)),was=marksOf(d);
  wcPick=at;wcNew=true;
  await wcSet([...was,{at}]);
  $("wcPick").scrollIntoView({block:"nearest",behavior:"smooth"});
  toast(`Отмечено в ${hm(at)}`,false,{label:"Отменить",fn:()=>{wcPick=null;wcSet(was)}});
};
$("wcToggle").onchange=async()=>{
  const on=$("wcToggle").checked;
  try{await api("/me",{method:"PUT",body:{toilet:on}});me.toilet=on;renderDay();renderWeek();toast(on?"Кнопка «Туалет» на экране «Сегодня»":"Отметки скрыты, записанное сохранено")}
  catch(e){$("wcToggle").checked=!on;toast(e.message,true)}
};

/* report: how often and what kind, against what and how much was eaten */
function pearson(xs,ys){
  const n=xs.length;if(n<3)return null;
  const mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0,syy=0;for(let i=0;i<n;i++){const dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sxx+=dx*dx;syy+=dy*dy}
  return sxx&&syy?sxy/Math.sqrt(sxx*syy):null;
}
const strength=r=>{const a=Math.abs(r);return a<.2?"связи почти нет":a<.4?"слабая связь":a<.6?"заметная связь":"сильная связь"};
const MIN_DAYS=7;
const dec=(v,d=1)=>v.toFixed(d).replace(".",",");
const plDays=n=>n%10===1&&n%100!==11?"день":[2,3,4].includes(n%10)&&![12,13,14].includes(n%100)?"дня":"дней";
function corrList(rows,y,up,down){
  const feats=[
    ["Калории в тот же день",r=>r.t.kcal],["Калории накануне",r=>r.prev?.food?r.prev.t.kcal:null],
    ["Вес еды в тот же день",r=>r.t.grams],["Вес еды накануне",r=>r.prev?.food?r.prev.t.grams:null],
    ["Углеводы накануне",r=>r.prev?.food?r.prev.t.carbs:null],["Жиры накануне",r=>r.prev?.food?r.prev.t.fat:null],
    ["Белки накануне",r=>r.prev?.food?r.prev.t.protein:null],
    ["Клетчатка в тот же день",r=>r.t.hasFiber?r.t.fiber:null],["Клетчатка накануне",r=>r.prev?.food&&r.prev.t.hasFiber?r.prev.t.fiber:null],
  ];
  // food tags: was there such a dish that day / the day before (only tags seen on some days but not all)
  const tagDays={};for(const r of rows)for(const t of r.tags)tagDays[t]=(tagDays[t]||0)+1;
  for(const [t,c] of Object.entries(tagDays))if(c>=2&&c<=rows.length-2){
    const T=t[0].toUpperCase()+t.slice(1);
    feats.push([`${T} в тот же день`,r=>r.tagged?(r.tags.has(t)?1:0):null],[`${T} накануне`,r=>r.prev?.food&&r.prev.tagged?(r.prev.tags.has(t)?1:0):null]);
  }
  const res=feats.map(([name,f])=>{const xs=[],ys=[];for(const r of rows){const x=f(r),v=y(r);if(x!=null&&v!=null){xs.push(x);ys.push(v)}}
    return{name,r:xs.length>=MIN_DAYS?pearson(xs,ys):null,n:xs.length}}).filter(x=>x.r!==null).sort((a,b)=>Math.abs(b.r)-Math.abs(a.r)).slice(0,8);
  const list=el("div");
  for(const x of res){
    const c=el("div","corr"),top=el("div","cr");
    top.append(el("b",null,x.name),el("span","r "+(x.r>0?"pos":"neg"),(x.r>0?"+":"")+dec(x.r,2)));
    const bar=el("div","corrbar"),i=el("i");const w=Math.abs(x.r)*50;i.style.width=w+"%";i.style.left=x.r>0?"50%":(50-w)+"%";i.style.background=x.r>0?"var(--accent)":"var(--p)";bar.append(i);
    const what=Math.abs(x.r)<.2?"":x.r>0?" — "+up:" — "+down;
    c.append(top,bar,el("small",null,`${strength(x.r)}${what} · ${x.n} дн.`));list.append(c);
  }
  return list;
}
async function renderWcReport(){
  const card=$("wcReport");card.hidden=!(me&&me.toilet);if(card.hidden)return;
  const end=new Date(day),start=new Date(day);start.setDate(start.getDate()-60);
  try{await prefetch(start,end)}catch(e){return}
  const ds=[];for(let d=new Date(start);key(d)<=key(end);d.setDate(d.getDate()+1))ds.push(new Date(d));
  const info=ds.map(d=>{const v=cache[key(d)]||{entries:[]},t=totals(v.entries),marks=marksOf(v),typed=marks.filter(m=>m.t);
    const dishes=v.entries.flatMap(e=>e.dishes||[]),tags=new Set(dishes.flatMap(x=>x.tags||[]));
    return{d,k:key(d),t,marks,tags,tagged:dishes.some(x=>Array.isArray(x.tags)),count:marks.length,food:t.kcal>0,entries:v.entries,type:typed.length?typed.reduce((a,m)=>a+m.t,0)/typed.length:null}});
  const first=info.findIndex(x=>x.count>0);
  const body=$("wcBody");body.innerHTML="";
  if(first<0){$("wcN").textContent="";body.append(el("div","msg","Отмечай походы кнопкой «Туалет» на экране «Сегодня» и записывай еду. Через неделю здесь появится, как одно связано с другим."));return}
  // days since the first mark, with food logged (a day without marks then counts as 0 visits)
  const rows=info.map((x,i)=>({...x,prev:info[i-1]})).slice(first).filter(x=>x.food);
  const n=rows.length;$("wcN").textContent=`${n} ${plDays(n)}`;
  const counts=rows.map(r=>r.count),avg=n?counts.reduce((a,b)=>a+b,0)/n:0;
  // hours from the previous meal to each visit
  const gaps=[];info.slice(first).forEach((x,i)=>{const meals=[...(info[first+i-1]?.entries||[]),...x.entries].map(e=>e.at).filter(Boolean);
    for(const m of x.marks){const before=meals.filter(a=>a<m.at&&m.at-a<=864e5);if(before.length)gaps.push((m.at-Math.max(...before))/36e5)}});
  gaps.sort((a,b)=>a-b);const med=gaps.length?gaps[Math.floor(gaps.length/2)]:null;
  const stat=(items)=>{const st=el("div","wcstats");for(const [v,l] of items){const c=el("div");c.append(el("b",null,v),el("small",null,l));st.append(c)}return st};
  body.append(stat([[n?dec(avg):"—","в среднем за день"],[n?String(Math.max(...counts)):"—","больше всего"],[med!==null?(med<1?Math.round(med*60)+" мин":dec(med)+" ч"):"—","от еды до туалета"]]));
  // stool type: distribution and the usual type
  const typed=info.slice(first).flatMap(x=>x.marks.filter(m=>m.t));
  if(typed.length){
    const dist=[0,0,0,0,0,0,0,0];typed.forEach(m=>dist[m.t]++);
    const mode=dist.indexOf(Math.max(...dist.slice(1)),1),norm=(dist[3]+dist[4])/typed.length,mean=typed.reduce((a,m)=>a+m.t,0)/typed.length;
    body.append(el("h4","wch","Консистенция"));
    body.append(stat([[`тип ${mode}`,"чаще всего"],[Math.round(norm*100)+"%","в норме (3–4)"],[dec(mean),"средний тип"]]));
    const bar=el("div","bsdist");
    for(let t=1;t<=7;t++)if(dist[t]){const s=el("i");s.style.flex=dist[t];s.style.background=bsColor(t);s.title=`Тип ${t}: ${dist[t]}`;s.textContent=dist[t]/typed.length>=.08?t:"";bar.append(s)}
    body.append(bar,el("small","bslegend",`${typed.length} оценок · жёлтый — твёрже нормы, зелёный — норма, красный — жиже`));
  }
  if(n<MIN_DAYS){body.append(el("div","msg",`Для выводов нужно хотя бы ${MIN_DAYS} дней с едой и отметками, сейчас ${n}. Лучше — две-три недели.`));return}
  body.append(el("h4","wch","Как часто — и что влияет"),corrList(rows,r=>r.count,"когда больше, ходишь чаще","когда больше, ходишь реже"));
  const typedDays=rows.filter(r=>r.type!==null).length;
  if(typedDays>=MIN_DAYS)body.append(el("h4","wch","Консистенция — и что влияет"),corrList(rows,r=>r.type,"когда больше, стул мягче","когда больше, стул твёрже"));
  else if(typed.length)body.append(el("div","msg",`Для связи консистенции с едой нужно ${MIN_DAYS} дней с оценками, сейчас ${typedDays}.`));
  body.append(el("div","msg","Корреляция показывает, что числа меняются вместе, но не доказывает причину. Чем больше дней, тем надёжнее вывод."));
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
  if(typeof updReset==="function")setTimeout(updReset);
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
        ig.oninput=()=>{const ng=+ig.value;if(!(ng>0))return;setGrams(it,ng);ik.value=Math.round(it.kcal)||"";refreshHead()};
        ik.oninput=()=>{setKcal(it,+ik.value||0);refreshHead()};
        r.append(n,ig,ik,xbtn("Убрать ингредиент",()=>{d.items.splice(ii,1);if(!d.items.length){draft.splice(di,1);renderDraft();return}buildIngs();refreshHead()}));
        ings.append(r);
      });
      const add=el("button","addIng","+ ингредиент");
      add.onclick=()=>{d.items.push({name:"",grams:100,kcal:0,protein:0,fat:0,carbs:0});buildIngs();refreshHead();$(`in${di}_${d.items.length-1}`).focus()};
      ings.append(add);
    };
    nm.oninput=()=>{if(d.items.length===1&&d.items[0].name===d.name)d.items[0].name=nm.value;d.name=nm.value;if(d._open)buildIngs()};
    g.oninput=()=>{const ng=+g.value,t=sumI(d.items);if(ng>0&&t.grams>0){const f=ng/t.grams;d.items.forEach(i=>setGrams(i,i.grams*f));buildIngs();refreshHead(false)}};
    tog.onclick=()=>{d._open=!d._open;ings.hidden=!d._open;refreshHead(false)};
    buildIngs();refreshHead();
    box.append(head,meta,ings);list.append(box);
  });
  updTotal();
  $("note").hidden=!draftNote;$("note").textContent=draftNote;
}
function showMsg(t,err,working,action){
  if(!sheetOpen()){if(t)toast(t,err,action);return}
  const m=$("msg");m.hidden=!t;m.className=working?"working":"msg"+(err?" err":"")+(action?" withact":"");m.textContent="";
  if(working){m.append(el("span","spin"),el("span",null,t))}else m.append(el("span",null,t||""));
  if(action&&t){const b=el("button","btn act",action.label);b.type="button";b.onclick=()=>{haptic();action.fn()};m.append(b)}
}
let toastT;
function toast(t,err,action){
  const x=$("toast");x.textContent="";x.append(el("span",null,t));x.classList.toggle("err",!!err);x.classList.toggle("act",!!action);
  if(action){const b=el("button",null,action.label);b.type="button";b.onclick=()=>{x.classList.remove("on");haptic();action.fn()};x.append(b)}
  x.classList.add("on");clearTimeout(toastT);toastT=setTimeout(()=>x.classList.remove("on"),action?9000:err?4200:2400);
}
const haptic=(ms=8)=>{try{navigator.vibrate&&navigator.vibrate(ms)}catch(e){}};

let estCtrl=null;
const cancelEstimate=()=>{if(estCtrl){estCtrl.abort();estCtrl=null}};
async function estimate(){
  if(estCtrl)return; // already running
  const text=$("text").value.trim();
  if(!text&&!photos.length){showMsg("Сфотографируй еду или опиши её словами.",true);return}
  $("calc").disabled=true;$("shoot").classList.add("busy");
  const what=photos.length?"Смотрю на фото и считаю":"Считаю",t0=Date.now();
  const ctrl=estCtrl=new AbortController();
  showMsg(what+"…",false,true,{label:"Отменить",fn:()=>{cancelEstimate();showMsg("Отменено. Фото и текст на месте — можно поправить и отправить снова.",false,false,{label:"Отправить снова",fn:estimate})}});
  const tick=()=>{const s=Math.round((Date.now()-t0)/1000),sp=$("msg").querySelector("span:nth-child(2)");if(sp&&s>=5)sp.textContent=`${what}… ${s} с${s>40?" — модель думает, это нормально":""}`};const timer=setInterval(tick,1000);updReset();
  try{
    const images=await Promise.all(photos.map(async p=>p.data||(p.data=await toDataURL(p.blob))));
    const res=await api("/estimate",{method:"POST",signal:ctrl.signal,timeout:((me&&me.llmTimeoutSec)||300)*1000+30000,body:{text,images,date:key(new Date())}});
    const raw=res&&Array.isArray(res.dishes)?res.dishes:res&&Array.isArray(res.items)?res.items.map(i=>({name:i.name,items:[i]})):[];
    const dishes=raw.map(d=>({name:String(d.name||"Блюдо"),tags:Array.isArray(d.tags)?d.tags.map(String):[],items:(Array.isArray(d.items)&&d.items.length?d.items:[d]).map(normI),_open:false})).filter(d=>d.items.length);
    if(!dishes.length){showMsg(res&&res.note?String(res.note):"Не получилось разобрать еду. Попробуй другое фото или добавь пару слов.",true);return}
    draft=dishes;draftNote=String(res.note||"");showMsg("");renderDraft();haptic(12);
    if(res.stats){const st=res.stats,total=Math.round((Date.now()-t0)/1000),model=st.sec||0;
      const parts=[`Распознано за ${total} с`,`модель ${model} с`];
      if(total-model>=3)parts.push(`связь ${Math.round(total-model)} с`);
      if(st.reasoningTokens)parts.push(`размышления ${st.reasoningTokens} ток.`);
      if(st.imageKb)parts.push(`фото ${st.imageKb} КБ`);
      toast(parts.join(" · "))}
    $("more").open=false;
  }catch(e){
    if(e.code===-1||ctrl.signal.aborted)return; // cancelled: the message is already shown
    if(e.code===503&&me&&me.isAdmin){closeSheet();go("settings");toast(e.message,true);return}
    // everything is kept (photos, text, meal): one tap sends it again
    const retry={label:"Повторить",fn:()=>{if(!sheetOpen())openSheet(photos.length?"photo":"text");estimate()}};
    if(e.code!==401)showMsg(e.message||String(e),true,false,e.code===400||e.code===429?null:retry);
  }finally{clearInterval(timer);if(estCtrl===ctrl)estCtrl=null;$("calc").disabled=false;$("shoot").classList.remove("busy");updReset()}
}
/* «Сбросить»: drop photos, text and the recognised dishes and close the sheet */
const hasEntry=()=>!!(draft.length||photos.length||$("text").value.trim()||estCtrl);
function updReset(){const b=$("sheetReset");b.hidden=!hasEntry();b.textContent="Сбросить";delete b.dataset.armed}
function resetEntry(){
  cancelEstimate();draft=[];draftNote="";$("text").value="";clearPhoto();renderDraft();showMsg("");
  closeSheet();toast("Запись сброшена");
}
async function saveDraft(){ try{ await saveDraftInner() }catch(e){ console.error(e); showMsg("Не удалось добавить: "+(e.message||e),true) } }
async function saveDraftInner(){
  const dishes=draft.map(d=>{const dn=d.name.trim()||(d.items[0]&&d.items[0].name.trim())||"Блюдо";
    return{name:dn,...(d.tags&&d.tags.length?{tags:d.tags}:{}),items:d.items.filter(i=>i.kcal>0).map(i=>({...normI(i),name:i.name.trim()||dn}))}}).filter(d=>d.items.length);
  if(!dishes.length){showMsg("Укажи калории хотя бы для одного ингредиента.",true);return}
  const k=key(day); const d=await getDay(k);
  const [hh,mm]=($("mealTime").value||"").split(":").map(Number);
  const at=isNaN(hh)?(mealAt||Date.now()):atOn(day,hh,mm);
  d.entries.push({id:uidGen(),meal,text:$("text").value.trim(),at,dishes});
  const kc=Math.round(sumI(dishes.flatMap(x=>x.items)).kcal),ml=(MEALS.find(m=>m[0]===meal)||[0,""])[1];
  draft=[];draftNote="";$("text").value="";clearPhoto();renderDraft();showMsg("");
  closeSheet();go("diary");haptic(15);toast(`${ml}: +${kc} ккал`);
  renderDay();renderWeek();
  await store(k,dayBody(d));
}
async function mutate(eid,fn){
  const k=key(day); const d=await getDay(k);
  const e=d.entries.find(x=>x.id===eid); if(!e)return;
  const before=e.dishes.length;
  fn(e); e.dishes=e.dishes.filter(x=>x.items.length);
  if(!e.dishes.length)d.entries=d.entries.filter(x=>x!==e);
  if(e.dishes.length!==before)[...openSet].forEach(x=>x.startsWith(eid+":")&&openSet.delete(x));
  dayData=d;renderDay();renderWeek();
  await store(k,dayBody(d));
}
const removeDish=(eid,di)=>mutate(eid,e=>e.dishes.splice(di,1));
const removeIng=(eid,di,ii)=>mutate(eid,e=>e.dishes[di].items.splice(ii,1));
function clearPhoto(){photos.forEach(p=>URL.revokeObjectURL(p.url));photos=[];$("photo").value="";$("gallery").value="";renderThumbs()}
function renderThumbs(){
  setTimeout(()=>typeof updReset==="function"&&updReset());
  const box=$("thumbs");box.innerHTML="";box.hidden=!photos.length;
  photos.forEach((p,i)=>{const f=document.createElement("figure");const im=document.createElement("img");im.src=p.url;im.alt="Фото еды "+(i+1);
    const x=document.createElement("button");x.textContent="×";x.setAttribute("aria-label","Убрать фото");x.onclick=()=>{URL.revokeObjectURL(p.url);photos.splice(i,1);renderThumbs()};
    f.append(im,x);box.append(f)});
  if(photos.length&&photos.length<maxPhotos){
    const cam=el("label","addphoto");cam.htmlFor="photo";cam.title="Сделать ещё фото";
    cam.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.6"/></svg><small>Камера</small>';
    const gal=el("label","addphoto");gal.htmlFor="gallery";gal.title="Добавить из галереи";
    gal.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8.5 8.5"/></svg><small>Галерея</small>';
    box.append(cam,gal)}
}
const toDataURL=b=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(b)});
/* phone photos are large: shrink to 1280px JPEG before sending (fewer image tokens = faster answer) */
async function shrink(file){
  try{
    const bmp=await createImageBitmap(file);
    const sc=Math.min(1,1280/Math.max(bmp.width,bmp.height));
    const c=document.createElement("canvas");c.width=Math.round(bmp.width*sc);c.height=Math.round(bmp.height*sc);
    c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(b=>r(b||file),"image/jpeg",.82));
  }catch(e){return file}
}

/* ---------- screens ---------- */
let view="diary";
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const dateLong=d=>d.toLocaleDateString("ru-RU",{day:"numeric",month:"long",weekday:"long"});
function setTitle(){
  const t=$("dayLabel"),s=$("subtitle");
  if(view==="diary"){const n=dayName(day);t.textContent=n.charAt(0).toUpperCase()+n.slice(1);s.textContent=["Сегодня","Вчера"].includes(n)?dateLong(day):""}
  else if(view==="week"){t.textContent="Отчет";const a=addDays(day,-6);s.textContent=`${a.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})} — ${day.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})}`}
  else{t.textContent="Настройки";s.textContent=""}
}
function go(v,replace){
  if(!["diary","week","settings"].includes(v))return;
  if(v===view&&!replace)return;
  view=v;
  $("vDiary").hidden=v!=="diary";$("vWeek").hidden=v!=="week";$("settings").hidden=v!=="settings";
  const nav=v!=="settings";$("prev").hidden=!nav;$("next").hidden=!nav;$("gear").hidden=!nav;$("back").hidden=nav;
  document.querySelectorAll(".tab[data-view]").forEach(t=>t.dataset.view===v?t.setAttribute("aria-current","page"):t.removeAttribute("aria-current"));
  document.body.classList.toggle("pushed",v==="settings");
  setTitle();window.scrollTo(0,0);
  if(v==="settings"){if(me&&me.isAdmin){loadConfig();loadPeople();loadUpdate()}if(!replace)history.pushState({v:"settings"},"")}
  if(v==="week")renderWeek();
  if(v==="diary")renderDay();
}
// only real screen tabs navigate; «Галерея» and «Описать» in the bar are actions
document.querySelectorAll(".tab[data-view]").forEach(t=>t.onclick=()=>{haptic();go(t.dataset.view)});
function shiftDay(n){
  const today=new Date();today.setHours(12,0,0,0);
  let d=addDays(day,n);if(d>today)d=today;if(key(d)===key(day))return;
  day=d;haptic();openDay();
}
window.addEventListener("scroll",()=>$("nav").classList.toggle("scrolled",scrollY>4),{passive:true});

/* ---------- bottom sheet ---------- */
const sheetOpen=()=>!$("sheet").hidden;
function openSheet(mode){
  const s=$("sheet"),sc=$("scrim");
  if(!sheetOpen()){
    // a fresh entry: pick breakfast/lunch/dinner by the current time (a draft in progress keeps its choice)
    if(!draft.length&&!photos.length){resetMealTime();renderSeg()}
    s.hidden=false;sc.hidden=false;void s.offsetHeight;s.classList.add("on");sc.classList.add("on");
    document.body.style.overflow="hidden";history.pushState({sheet:1},"");
  }
  $("sheetTitle").textContent=mode==="text"?"Без фото":"Новая запись";
  updReset();
  if(mode==="text"){$("more").open=true;setTimeout(()=>$("text").focus(),280)}
}
function closeSheet(fromHistory){
  if(!sheetOpen())return;
  const s=$("sheet"),sc=$("scrim");s.style.transform="";s.classList.remove("on");sc.classList.remove("on");document.body.style.overflow="";
  setTimeout(()=>{if(!s.classList.contains("on")){s.hidden=true;sc.hidden=true}},320);
  if(!fromHistory&&history.state&&history.state.sheet)history.back();
}
$("sheetClose").onclick=()=>closeSheet();
$("sheetReset").onclick=()=>{
  const b=$("sheetReset");
  if(draft.length&&!b.dataset.armed){b.dataset.armed=1;b.textContent="Точно?";haptic();setTimeout(()=>{if(b.dataset.armed){delete b.dataset.armed;b.textContent="Сбросить"}},3500);return}
  haptic(15);resetEntry();
};
$("text").addEventListener("input",()=>updReset());
$("scrim").onclick=()=>closeSheet();
$("addText").onclick=()=>{haptic();openSheet("text")};
window.addEventListener("popstate",()=>{if(sheetOpen()){closeSheet(true);return}if(view==="settings")go("diary",true)});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sheetOpen())closeSheet()});
// drag the sheet down by its header to dismiss
(()=>{let y0=null,dy=0;const s=$("sheet");
  const start=e=>{y0=e.touches[0].clientY;dy=0;s.classList.add("drag")};
  const move=e=>{if(y0==null)return;dy=Math.max(0,e.touches[0].clientY-y0);s.style.transform=`translateY(${dy}px)`};
  const end=()=>{if(y0==null)return;s.classList.remove("drag");s.style.transform="";if(dy>110)closeSheet();y0=null};
  for(const h of [$("sheetHead"),s.querySelector(".grab")]){h.addEventListener("touchstart",start,{passive:true});h.addEventListener("touchmove",move,{passive:true});h.addEventListener("touchend",end)}
})();

/* ---------- gestures: swipe a row left to delete, swipe the day sideways ---------- */
let swiping=false,openRow=null;
function swipe(row,onDelete){
  const box=el("div","sw"),del=el("button","swdel","Удалить"),c=el("div","swc");
  del.onclick=()=>{haptic(15);onDelete()};del.tabIndex=-1;
  c.append(row);box.append(del,c);
  let x0=null,y0=0,dx=0,lock=null,base=0;
  c.addEventListener("touchstart",e=>{if(openRow&&openRow!==c){openRow.style.transform="";openRow=null}x0=e.touches[0].clientX;y0=e.touches[0].clientY;dx=0;lock=null;base=c===openRow?-88:0},{passive:true});
  c.addEventListener("touchmove",e=>{if(x0==null)return;const mx=e.touches[0].clientX-x0,my=e.touches[0].clientY-y0;
    if(lock==null&&(Math.abs(mx)>8||Math.abs(my)>8))lock=Math.abs(mx)>Math.abs(my)?"x":"y";
    if(lock!=="x")return;swiping=true;dx=Math.min(0,Math.max(-120,base+mx));c.classList.add("drag");c.style.transform=`translateX(${dx}px)`},{passive:true});
  c.addEventListener("touchend",()=>{c.classList.remove("drag");if(lock==="x"){const open=dx<-44;c.style.transform=open?"translateX(-88px)":"";openRow=open?c:null;if(open)haptic()}
    x0=null;setTimeout(()=>swiping=false,50)});
  return box;
}
document.addEventListener("touchstart",e=>{if(openRow&&!openRow.parentNode.contains(e.target)){openRow.style.transform="";openRow=null}},{passive:true});
function a11yName(){}
(()=>{let x0=null,y0=0,skip=false;const v=$("vDiary");
  v.addEventListener("touchstart",e=>{skip=!!e.target.closest(".sw,input,textarea,.dial .goal");x0=e.touches[0].clientX;y0=e.touches[0].clientY},{passive:true});
  v.addEventListener("touchend",e=>{if(x0==null||skip)return;const t=e.changedTouches[0],dx=t.clientX-x0,dy=t.clientY-y0;x0=null;
    if(Math.abs(dx)>70&&Math.abs(dy)<45){shiftDay(dx>0?-1:1)}},{passive:true});
})();

/* ---------- "add to home screen" hint ---------- */
let installEvt=null;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEvt=e;setupInstallHint()});
function setupInstallHint(){
  const standalone=matchMedia("(display-mode: standalone)").matches||navigator.standalone;
  let dismissed=false;try{dismissed=localStorage.getItem("kcal:installHint")==="0"}catch(e){}
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
  const box=$("install");if(standalone||dismissed||(!ios&&!installEvt)){box.hidden=true;return}
  const how=$("installHow");how.textContent="";
  if(installEvt){const b=el("button","linkbtn","Установить");b.onclick=async()=>{installEvt.prompt();await installEvt.userChoice.catch(()=>0);installEvt=null;box.hidden=true};how.append(b)}
  else how.textContent="Нажми «Поделиться» внизу Safari, затем «На экран „Домой“».";
  box.hidden=false;
}
$("installClose").onclick=()=>{$("install").hidden=true;try{localStorage.setItem("kcal:installHint","0")}catch(e){}};

/* ---------- wiring ---------- */
renderSeg();
$("prev").onclick=()=>shiftDay(view==="week"?-7:-1);
$("next").onclick=()=>shiftDay(view==="week"?7:1);
$("calc").onclick=estimate;
$("text").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))estimate()});
$("save").onclick=saveDraft;
$("addRow").onclick=()=>{draft.push({name:"",items:[{name:"",grams:100,kcal:0,protein:0,fat:0,carbs:0}],_open:true});renderDraft();$("pn"+(draft.length-1)).focus()};
$("manual").onclick=()=>{draftNote="";$("addRow").click()};
async function takeFiles(input){
  const fs=[...input.files].slice(0,Math.max(0,maxPhotos-photos.length));input.value="";
  if(!fs.length)return;
  openSheet("photo");
  // the photo knows when the food was eaten (for gallery photos taken earlier)
  if(!timeManual){
    const ts=(await Promise.all(fs.map(exifTime))).filter(t=>t&&t<=Date.now()+5*60e3&&key(new Date(t))===key(day));
    if(ts.length)setMealAt(Math.min(...ts),Math.abs(Date.now()-Math.min(...ts))>10*60e3?"по фото":"");
  }
  for(const f of fs){const b=await shrink(f);photos.push({blob:b,url:URL.createObjectURL(b)})}
  renderThumbs();estimate();
}
$("photo").onchange=()=>takeFiles($("photo"));
$("gallery").onchange=()=>takeFiles($("gallery"));
$("tabText").onclick=()=>{haptic();openSheet("text")};
let goalT;$("goal").oninput=()=>{const v=+$("goal").value;if(v>=800&&v<=6000){goal=v;renderDay();clearTimeout(goalT);goalT=setTimeout(()=>{renderWeek();api("/me",{method:"PUT",body:{goal}}).catch(e=>showMsg(e.message,true))},600)}};

/* ---------- sign-in by email code ---------- */
function loginMsg(t,err){const m=$("loginMsg");m.hidden=!t;m.textContent=t||"";m.classList.toggle("err",!!err)}
function showLogin(){
  $("app").hidden=true;$("login").hidden=false;
  const inv=new URLSearchParams(location.search).get("invite");
  if(inv&&!showLogin.invite){showLogin.invite=1;openInvite(inv);return}
  const jn=new URLSearchParams(location.search).get("join");
  if(jn&&!showLogin.join){showLogin.join=1;openJoin(jn);return}
  if(new URLSearchParams(location.search).get("link")==="invalid")loginMsg("Ссылка недействительна: она уже использована или устарела. Войди по почте.",true);
  try{const last=localStorage.getItem("kcal:email");if(last&&!$("lEmail").value)$("lEmail").value=last}catch(e){}
  setTimeout(()=>($("emailForm").hidden?$("lCode"):$("lEmail")).focus(),50);
}
/* invite link: the address is known — send the code right away and ask only for the code */
async function openInvite(token){
  $("emailForm").hidden=true;$("codeForm").hidden=true;loginMsg("Открываю приглашение…");
  try{
    const {email}=await api("/auth/invite?t="+encodeURIComponent(token));
    history.replaceState(null,"","/");
    $("lEmail").value=email;
    if(!(await requestCode())){$("emailForm").hidden=false}
    else loginMsg("Мы отправили код на твою почту — введи его, и дневник откроется.");
  }catch(e){
    history.replaceState(null,"","/");
    $("emailForm").hidden=false;loginMsg(e.message,true);setTimeout(()=>$("lEmail").focus(),50);
  }
}
/* sign-up link from a messenger: the person types their own email, the link lets it in */
let joinToken=null;
async function openJoin(token){
  $("emailForm").hidden=true;$("codeForm").hidden=true;loginMsg("Открываю приглашение…");
  try{
    const {by}=await api("/auth/join?t="+encodeURIComponent(token));
    joinToken=token;history.replaceState(null,"","/");
    $("emailForm").hidden=false;$("lEmail").value="";
    loginMsg("");const h=$("lHint");h.textContent=(by?`Тебя пригласил(а) ${by}. `:"Тебя пригласили. ")+"Введи свою почту — пришлём код, и дневник откроется. Пароль не нужен.";h.style.color="var(--ink)";
    setTimeout(()=>$("lEmail").focus(),50);
  }catch(e){
    history.replaceState(null,"","/");
    $("emailForm").hidden=false;loginMsg(e.message,true);
  }
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
    const r=await api("/auth/request",{method:"POST",body:joinToken?{email,join:joinToken}:{email}});
    try{localStorage.setItem("kcal:email",email)}catch(e){}
    $("lTo").textContent=email;$("emailForm").hidden=true;$("codeForm").hidden=false;setCode("");$("lCode").focus();
    startResend(r.resendIn||60);return true;
  }catch(e){
    // a code was sent less than a minute ago: go straight to entering it
    if(e.code===429&&e.data&&e.data.retryAfter&&e.data.retryAfter<=60){
      $("lTo").textContent=email;$("emailForm").hidden=true;$("codeForm").hidden=false;$("lCode").focus();startResend(e.data.retryAfter);
      loginMsg("Код уже отправлен — введи его из последнего письма.");return true;
    }
    loginMsg(e.message,true);return false;
  }finally{$("lSend").disabled=false}
}
$("emailForm").onsubmit=ev=>{ev.preventDefault();requestCode()};
$("lResend").onclick=()=>requestCode();
$("lBack").onclick=()=>{$("codeForm").hidden=true;$("emailForm").hidden=false;loginMsg("");$("lEmail").focus()};
/* six cells drawn from the one real input; digits roll in like slot-machine reels */
const otp=$("otp"),otpCells=[...otp.querySelectorAll(".otp-cells span")];
otpCells.forEach((c,i)=>c.style.setProperty("--i",i));
const calm=matchMedia("(prefers-reduced-motion: reduce)").matches;
const rnd=()=>String(Math.floor(Math.random()*10));
const reel=c=>{c.innerHTML='<i class="win"><i class="reel"></i></i>';return c.querySelector(".reel")};
// roll a cell through a few random digits and land on `d` (with a small overshoot)
function rollTo(c,d,{n=5,dur=380,delay=0}={}){
  c.dataset.d=d;
  if(calm){c.textContent=d;return Promise.resolve()}
  const r=reel(c),strip=[...Array(n)].map(rnd).concat(d);
  r.innerHTML=strip.map(x=>`<b>${x}</b>`).join("");
  r.style.transform="translateY(0)";void r.offsetWidth;
  r.style.transition=`transform ${dur}ms cubic-bezier(.18,.89,.32,1.18) ${delay}ms`;
  r.style.transform=`translateY(-${(strip.length-1)*100}%)`;
  return new Promise(ok=>setTimeout(ok,dur+delay));
}
// all reels spin while the code is being checked
function spinAll(){
  if(calm)return;
  otpCells.forEach(c=>{const r=reel(c);r.className="reel spin";r.style.animationDelay=(-Math.random()*.3).toFixed(2)+"s";
    r.innerHTML=[..."01234567890123456789"].map(x=>`<b>${x}</b>`).join("")});
}
// …then stop one by one, left to right, on the entered digits
const stopAll=code=>Promise.all(otpCells.map((c,i)=>rollTo(c,code[i]||"",{n:7,dur:520,delay:i*110})));
function renderOtp(){
  const v=$("lCode").value;
  otpCells.forEach((c,i)=>{
    const d=v[i]||"";c.classList.toggle("fill",!!d);c.classList.toggle("on",i===Math.min(v.length,5)&&!(v.length===6&&i===5&&d));
    if(!d){if(c.dataset.d){c.textContent="";c.dataset.d=""}return}
    if(d!==c.dataset.d)rollTo(c,d);
  });
}
function setCode(v){$("lCode").value=v;otp.classList.remove("ok","err","busy");renderOtp()}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
$("lCode").addEventListener("input",()=>{
  const v=$("lCode").value.replace(/\D/g,"").slice(0,6);$("lCode").value=v;otp.classList.remove("err");renderOtp();
  if(v.length===6)$("codeForm").requestSubmit()});
// always type at the end, like separate boxes
const otpEnd=()=>{const i=$("lCode"),n=i.value.length;try{i.setSelectionRange(n,n)}catch(e){}};
$("lCode").addEventListener("focus",()=>{otp.classList.add("focus");otpEnd();renderOtp()});
$("lCode").addEventListener("blur",()=>otp.classList.remove("focus"));
$("lCode").addEventListener("click",otpEnd);$("lCode").addEventListener("keyup",otpEnd);
renderOtp();
$("codeForm").onsubmit=async ev=>{
  ev.preventDefault();const code=$("lCode").value;if(code.length!==6){loginMsg("Введи 6 цифр из письма",true);return}
  $("lVerify").disabled=true;loginMsg("");otp.classList.remove("err","ok");$("lCode").blur();
  await sleep(calm?0:400); // let the last digit land first
  otp.classList.add("busy");spinAll();const t0=Date.now();
  // the reels spin at least ~0.8 s even when the server answers instantly
  const settle=async()=>{await sleep(Math.max(0,800-(Date.now()-t0)));await stopAll(code);otp.classList.remove("busy")};
  try{const body={email:$("lTo").textContent,code};if(joinToken)body.join=joinToken;
    await api("/auth/verify",{method:"POST",body});joinToken=null;
    await settle();otp.classList.add("ok");haptic(12);await sleep(820);
    loginMsg("");setCode("");$("codeForm").hidden=true;$("emailForm").hidden=false;
    if(!(await boot()))loginMsg("Код принят, но браузер не сохранил вход. Разреши cookie для этого сайта и попробуй ещё раз.",true)}
  catch(e){
    await settle();void otp.offsetWidth;otp.classList.add("err");haptic([30,40,30]);loginMsg(e.message,true);
    await sleep(700);setCode("");otp.classList.add("err");$("lCode").focus();
  }finally{otp.classList.remove("busy");$("lVerify").disabled=false}
};

/* ---------- account ---------- */
function showLink(url,label){
  const box=$("linkBox");box.hidden=false;$("linkLabel").textContent=label;$("linkUrl").value=url;$("linkUrl").select();
}
$("copyLink").onclick=async()=>{try{await navigator.clipboard.writeText($("linkUrl").value);$("copyLink").textContent="Скопировано"}catch(e){$("linkUrl").select()}setTimeout(()=>$("copyLink").textContent="Копировать",1500)};
$("deviceLink").onclick=async()=>{try{const {url}=await api("/login-link",{method:"POST"});showLink(url,"Открой эту ссылку на другом устройстве в течение 15 минут. Сработает один раз.")}catch(e){showMsg(e.message,true)}};
$("exportBtn").onclick=()=>{
  const a=document.createElement("a");a.href="/api/export.xlsx?tz="+new Date().getTimezoneOffset();a.download="";document.body.append(a);a.click();a.remove();
  toast("Готовлю файл…");
};
$("logout").onclick=async()=>{try{await api("/logout",{method:"POST"})}catch(e){}location.href="/"};
function renderAccount(){
  $("who").textContent=me.name;
  const letter=(me.name||me.email||"?").trim().charAt(0)||"?";$("avatar").textContent=letter;$("gear").textContent=letter;
  $("whoEmail").textContent=me.email?`Вход по почте ${me.email}`:"";
  $("attachForm").hidden=!!me.email;
  $("wcToggle").checked=!!me.toilet;
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
      const del=el("button","ghost danger","Удалить");
      del.onclick=async()=>{
        if(!del.dataset.armed){del.dataset.armed=1;del.textContent="Удалить навсегда?";haptic();
          iMsg(`Удаление ${u.email||u.name} сотрёт и весь дневник. Это нельзя отменить.`,"err");
          setTimeout(()=>{if(del.dataset.armed){delete del.dataset.armed;del.textContent="Удалить"}},5000);return}
        del.disabled=true;
        try{await api("/users/"+u.id,{method:"DELETE"});haptic(15);iMsg(`${u.email||u.name} удалён(а).`,"ok");loadPeople()}
        catch(e){iMsg(e.message,"err");del.disabled=false}
      };
      acts.append(adm,blk,del);
    }
    r.append(w,acts);ul.append(r);
  }
  renderJoinLinks(data.joinLinks);
  const il=$("inviteList");il.innerHTML="";
  if(data.invites.length){
    il.append(el("h4",null,"Ждут первого входа"));
    for(const i of data.invites){
      const r=el("div","urow"),w=el("div","who");w.append(el("b",null,i.email),el("small",null,"приглашён "+ago(i.createdAt)));
      const x=el("button","ghost","Отозвать");x.onclick=async()=>{try{await api("/invites/"+encodeURIComponent(i.email),{method:"DELETE"});loadPeople()}catch(e){iMsg(e.message,"err")}};
      const again=el("button","ghost","Отправить ещё раз");again.onclick=async()=>{again.disabled=true;
        try{const r2=await api("/invites",{method:"POST",body:{email:i.email}});
          if(r2.sent)iMsg(`Новое приглашение отправлено на ${i.email}.`,"ok");else showLink(r2.url,`Письмо не ушло (почта не настроена). Ссылка для ${i.email}:`)}
        catch(e){iMsg(e.message,"err")}finally{again.disabled=false}};
      const acts=el("div","acts");acts.append(again,x);r.append(w,acts);il.append(r);
    }
  }
}
function renderJoinLinks(list){
  const jl=$("joinList");jl.innerHTML="";
  if(!list||!list.length)return;
  jl.append(el("h4",null,"Ссылки-приглашения"));
  for(const j of list){
    const r=el("div","urow"),w=el("div","who");
    const used=j.uses?` · по ней пришли: ${j.uses}`:"";
    w.append(el("b",null,j.multi?"Многоразовая, без срока":"Одноразовая"),
      el("small",null,j.multi?`создана ${ago(j.createdAt)}${used}`:`создана ${ago(j.createdAt)} · действует до ${new Date(j.expiresAt).toLocaleDateString("ru-RU")}`));
    const x=el("button","ghost danger","Отозвать");
    x.onclick=async()=>{x.disabled=true;try{await api("/join-links/"+j.id,{method:"DELETE"});iMsg("Ссылка отозвана — по ней больше нельзя зарегистрироваться.","ok");loadPeople()}catch(e){iMsg(e.message,"err");x.disabled=false}};
    const acts=el("div","acts");acts.append(x);r.append(w,acts);jl.append(r);
  }
}
async function makeJoin(multi){
  const b=$(multi?"joinMulti":"joinOnce");b.disabled=true;iMsg("");
  try{
    const {url}=await api("/join-links",{method:"POST",body:{multi}});
    const label=multi
      ?"Многоразовая ссылка: по ней может зарегистрироваться сколько угодно людей, пока ты её не отзовёшь. Не выкладывай её в открытые чаты."
      :"Одноразовая ссылка на 7 дней: по ней зарегистрируется один человек.";
    $("joinBox").hidden=false;$("joinLabel").textContent=label+" Ссылка показывается только сейчас.";$("joinUrl").value=url;
    loadPeople();
    if(navigator.share){try{await navigator.share({title:document.title,text:"Приглашаю в дневник калорий: фоткаешь еду — калории считаются сами.",url})}catch(e){}}
    else $("joinUrl").select();
  }catch(e){iMsg(e.message,"err")}finally{b.disabled=false}
}
$("joinOnce").onclick=()=>makeJoin(false);
$("joinMulti").onclick=()=>{const b=$("joinMulti");
  if(!b.dataset.armed){b.dataset.armed=1;b.textContent="Создать? Работает для всех";haptic();setTimeout(()=>{delete b.dataset.armed;b.textContent="Многоразовая ссылка"},4000);return}
  delete b.dataset.armed;b.textContent="Многоразовая ссылка";makeJoin(true)};
$("joinCopy").onclick=async()=>{try{await navigator.clipboard.writeText($("joinUrl").value);$("joinCopy").textContent="Скопировано"}catch(e){$("joinUrl").select()}setTimeout(()=>$("joinCopy").textContent="Копировать",1500)};
async function setUser(id,body){try{await api("/users/"+id,{method:"PUT",body});loadPeople()}catch(e){iMsg(e.message,"err")}}
$("inviteForm").onsubmit=async ev=>{
  ev.preventDefault();const email=$("inviteEmail").value.trim();if(!email){$("inviteEmail").focus();return}
  $("inviteBtn").disabled=true;
  try{const r=await api("/invites",{method:"POST",body:{email}});$("inviteEmail").value="";
    if(r.sent)iMsg(`Приглашение отправлено на ${r.email}. По ссылке из письма сразу откроется ввод кода.`,"ok");
    else{iMsg("");showLink(r.url,`Почта на сервере не настроена, письмо не ушло. Перешли эту ссылку для ${r.email} сам — по ней сразу откроется ввод кода.`)}
    loadPeople()}
  catch(e){iMsg(e.message,"err")}finally{$("inviteBtn").disabled=false}
};

/* ---------- update from GitHub (admins) ---------- */
let updT=null,updWaitBack=false,updAsked=0;
function uMsg(t,kind){const m=$("updMsg");m.textContent=t;m.className="msg"+(kind?" "+kind:"")}
async function loadUpdate(){
  clearTimeout(updT);
  let d;
  try{d=await api("/update",{timeout:8000})}
  catch(e){ // the server restarts during an update: keep waiting
    if(updWaitBack){uMsg("Перезапускаю приложение…");updT=setTimeout(loadUpdate,3000);return}
    uMsg(e.message,"err");return}
  const s=d.status,btn=$("updBtn");
  const ver=s&&(s.to||s.from)||"";$("updVer").textContent=ver?"версия "+ver:"";$("updVer").hidden=!ver;
  $("updLogBox").hidden=!d.log;$("updLog").textContent=d.log||"";
  if(!d.installed){btn.disabled=true;uMsg("Кнопка ещё не подключена. Один раз выполни на сервере в папке приложения: sudo ./deploy/install-updater.sh");return}
  const running=s&&s.state==="running", waiting=d.pending||(updAsked&&(!s||s.at<updAsked));
  btn.disabled=running||waiting;
  if(running){updWaitBack=true;uMsg(s.message+"…");updT=setTimeout(loadUpdate,3000);return}
  if(waiting){
    if(Date.now()-updAsked>20000&&d.pending)uMsg("Сервер не берёт запрос. Проверь на сервере: systemctl status kkal-update.path","err");
    else uMsg("Запрос отправлен, жду сервер…");
    updT=setTimeout(loadUpdate,2000);return}
  if(updWaitBack&&s&&s.state==="done"&&/→/.test(s.message)){uMsg(s.message+". Перезагружаю…","ok");setTimeout(()=>location.reload(),1500);return}
  updWaitBack=false;
  if(s)uMsg(s.message+" · "+ago(s.at),s.state==="failed"?"err":s.state==="done"?"ok":"");
  else uMsg("Скачать новую версию из GitHub и перезапустить приложение.");
}
$("updBtn").onclick=async()=>{
  const b=$("updBtn");
  if(!b.dataset.armed){b.dataset.armed=1;b.textContent="Обновить? Приложение перезапустится";haptic();setTimeout(()=>{delete b.dataset.armed;b.textContent="Обновить из GitHub"},4000);return}
  delete b.dataset.armed;b.textContent="Обновить из GitHub";b.disabled=true;
  try{await api("/update",{method:"POST"});updAsked=Date.now();uMsg("Запрос отправлен, жду сервер…");updT=setTimeout(loadUpdate,1500)}
  catch(e){uMsg(e.message,"err");b.disabled=false}
};

/* ---------- settings panel ---------- */
$("gear").onclick=()=>{haptic();go("settings")};
$("back").onclick=()=>history.state&&history.state.v==="settings"?history.back():go("diary");
/* ---------- settings (admins): forms generated from the server's field list ---------- */
const GROUPS=[["model","Модель распознавания"],["limits","Лимиты"],["mail","Почта"],["site","Сайт"],["login","Вход"]];
const SRC={app:"задано здесь",env:"из .env",default:"по умолчанию"};
let cfgFields=[],cfgEnvOnly=[];
async function loadConfig(){try{const r=await api("/settings");cfgFields=r.fields;cfgEnvOnly=r.envOnly||[];renderConfig()}catch(e){$("cfg").textContent=e.message}}
function fieldEl(f){
  const id="c_"+f.key;
  if(f.type==="bool"){
    const l=el("label","check");l.htmlFor=id;const c=el("input");c.type="checkbox";c.id=id;c.checked=f.value==="1"||f.value==="true";
    const t=el("span",null,f.label);if(f.help)t.append(el("small",null,f.help));l.append(c,t);return l;
  }
  const l=el("label","fld");l.htmlFor=id;
  const lab=el("span","lab");lab.append(el("span",null,f.label),el("span","src"+(f.source==="app"?" app":""),SRC[f.source]));
  if(f.source==="app"&&f.type!=="secret"){const r=el("button","reset","сбросить");r.type="button";r.title="Вернуть значение из .env или по умолчанию";r.onclick=()=>saveCfg({[f.key]:null},l.closest("form"));lab.append(r)}
  l.append(lab);
  let inp;
  if(f.type==="select"){
    // a list of known models + «Другая модель…» that reveals a text field; the text field carries the value
    const sel=el("select","txt");sel.id=id+"_sel";
    const known=(f.options||[]).some(o=>o.value===f.value);
    for(const o of f.options||[]){const op=el("option",null,o.label);op.value=o.value;sel.append(op)}
    const other=el("option",null,"Другая модель…");other.value="__other";sel.append(other);
    const txt=el("input","txt");txt.id=id;txt.type="text";txt.spellcheck=false;txt.autocapitalize="off";txt.placeholder="Название модели, например openai/gpt-4o-mini";txt.value=f.value||"";
    sel.value=known?f.value:"__other";txt.hidden=known;
    sel.onchange=()=>{if(sel.value==="__other"){txt.hidden=false;txt.value=known?"":f.value;txt.focus()}else{txt.hidden=true;txt.value=sel.value}};
    l.htmlFor=sel.id;l.append(sel,txt);if(f.help)l.append(el("small",null,f.help));return l;
  }
  if(f.type==="textarea"){inp=el("textarea","txt");inp.rows=2;inp.value=f.value||""}
  else{
    inp=el("input","txt");inp.type=f.type==="secret"?"password":f.type==="number"?"number":f.type==="url"?"url":f.type==="email"?"email":"text";
    inp.value=f.type==="secret"?"":(f.value??"");
    if(f.type==="number"){if(f.min!=null)inp.min=f.min;if(f.max!=null)inp.max=f.max;inp.step=f.step||1;inp.inputMode=f.step&&f.step<1?"decimal":"numeric"}
    if(f.type==="secret"){inp.autocomplete="off";inp.placeholder=f.isSet?"Оставь пустым, чтобы не менять":"Не задано"}
    if(f.options){const dl=el("datalist");dl.id=id+"_l";for(const o of f.options){const op=el("option");op.value=o.value;op.label=o.label;dl.append(op)}inp.setAttribute("list",dl.id);l.append(dl)}
  }
  inp.id=id;inp.spellcheck=false;if(f.placeholder&&!inp.placeholder)inp.placeholder=f.placeholder;
  if(f.type==="secret"){
    const row=el("span","row");const sh=el("button","ghost","Показать");sh.type="button";
    sh.onclick=()=>{const v=inp.type==="password";inp.type=v?"text":"password";sh.textContent=v?"Скрыть":"Показать"};
    row.append(inp,sh);
    if(f.source==="app"){const del=el("button","ghost danger","Удалить");del.type="button";
      del.onclick=()=>{if(!del.dataset.armed){del.dataset.armed=1;del.textContent="Точно?";setTimeout(()=>{delete del.dataset.armed;del.textContent="Удалить"},4000);return}saveCfg({[f.key]:null},l.closest("form"))};row.append(del)}
    l.append(row);
    if(f.isSet)l.append(el("small",null,`Сейчас: ${f.hint}${f.source==="env"?" (из .env)":""}`));
  }else l.append(inp);
  if(f.help)l.append(el("small",null,f.help));
  return l;
}
function cMsg(form,t,kind){const m=form.querySelector(".msg");m.hidden=!t;m.textContent=t||"";m.className="msg"+(kind?" "+kind:"")}
async function saveCfg(values,form){
  if(!Object.keys(values).length){cMsg(form,"Изменений нет");return}
  const g=form.dataset.group;
  try{const r=await api("/settings",{method:"PUT",body:{values}});cfgFields=r.fields;renderConfig();
    const nf=$("cfg").querySelector(`form[data-group="${g}"]`);cMsg(nf,"Сохранено","ok");
    if("daily_limit" in values||"llm_timeout_sec" in values)me=await api("/me").catch(()=>me);
  }catch(e){cMsg(form,e.message,"err")}
}
function renderConfig(){
  const box=$("cfg");box.innerHTML="";
  for(const [g,title] of GROUPS){
    const fs=cfgFields.filter(f=>f.group===g);if(!fs.length)continue;
    const form=el("form","card cfgcard");form.noValidate=true;form.dataset.group=g;
    const head=el("div","row");head.append(el("span","label",title),el("span","spacer"));
    if(g==="model"){const k=fs.find(f=>f.key==="llm_api_key");head.append(el("span","pill "+(k&&k.isSet?"ok":"bad"),k&&k.isSet?"ключ задан":"ключ не задан"))}
    if(g==="mail"){const h=fs.find(f=>f.key==="smtp_host");head.append(el("span","pill "+(h&&h.value?"ok":""),h&&h.value?"настроена":"письма в лог"))}
    if(g==="login"){const c=fs.find(f=>f.key==="static_login_code");if(c&&c.isSet)head.append(el("span","pill bad","постоянный код включён"))}
    form.append(head);
    for(const f of fs)form.append(fieldEl(f));
    const acts=el("div","row");
    if(g==="model"){const b=el("button","ghost","Проверить");b.type="button";b.onclick=async()=>{b.disabled=true;cMsg(form,"Проверяю сохранённые настройки…");try{const r=await api("/settings/test",{method:"POST",timeout:((me&&me.llmTimeoutSec)||300)*1000+30000});cMsg(form,r.message,"ok")}catch(e){cMsg(form,e.message,"err")}finally{b.disabled=false}};acts.append(b)}
    if(g==="mail"){const b=el("button","ghost","Отправить тестовое письмо");b.type="button";b.onclick=async()=>{b.disabled=true;cMsg(form,"Отправляю…");try{const r=await api("/settings/test-mail",{method:"POST",timeout:60000});cMsg(form,r.message,"ok")}catch(e){cMsg(form,e.message,"err")}finally{b.disabled=false}};acts.append(b)}
    const save=el("button","btn","Сохранить");save.type="submit";acts.append(el("span","spacer"),save);
    form.append(acts);const m=el("div","msg");m.hidden=true;form.append(m);
    form.onsubmit=ev=>{
      ev.preventDefault();const values={};
      for(const f of fs){
        const inp=$("c_"+f.key);if(!inp)continue;
        if(f.type==="bool"){const v=inp.checked?"1":"0";if(v!==(f.value==="1"||f.value==="true"?"1":"0"))values[f.key]=inp.checked;continue}
        if(f.type==="secret"){if(inp.value.trim())values[f.key]=inp.value.trim();continue}
        const v=inp.value.trim();if(v!==String(f.value??"").trim())values[f.key]=v===""?null:v;
      }
      saveCfg(values,form);
    };
    box.append(form);
  }
  if(cfgEnvOnly.length)box.append(el("div","cfgnote",`Только в файле .env на сервере (нужны до запуска): ${cfgEnvOnly.join(", ")}.`));
}

async function boot(){
  try{me=await api("/me")}catch(e){if(e.code!==401&&e.code!==undefined){$("login").hidden=true;$("app").hidden=false;toast("Сервер недоступен: "+e.message,true)}return false}
  if(location.search)history.replaceState(null,"","/");
  goal=me.goal;$("goal").value=goal;
  renderAccount();$("people").hidden=!me.isAdmin;$("updater").hidden=!me.isAdmin;$("cfg").hidden=!me.isAdmin;
  $("login").hidden=true;$("app").hidden=false;
  go(location.hash==="#week"?"week":"diary",true);setupInstallHint();
  await openDay();
  return true;
}
boot();
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});
