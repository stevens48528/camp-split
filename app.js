import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, collection, doc, query, where, onSnapshot, setDoc, updateDoc, getDoc, arrayUnion, writeBatch }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { SLOTS, CATS, catOf, MODES, PCTS, money, mealIds, defaultMeals, dayLabel, mealLabel, nightsOf,
  sharedAmount, sharesFor, settle, describe } from "./split.js";

// 這段設定本來就會公開在網頁上，安全性由 Firebase Auth 和 firestore.rules 負責
const firebaseConfig = {
  apiKey: "AIzaSyClBGCdUK-T2zFWnVbP8pKvW6DyQ_LPIm4",
  authDomain: "camp-split-b3a20.firebaseapp.com",
  projectId: "camp-split-b3a20",
  storageBucket: "camp-split-b3a20.firebasestorage.app",
  messagingSenderId: "451437047186",
  appId: "1:451437047186:web:142e4107286d17eef1e54b",
};
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const S = {
  mode:"loading",     // loading | signedout | live | demo
  user:null, trips:[], tripId:null, expenses:[], tab:"list",
  invite:null,        // {id, name}：從邀請連結進來、還不是成員的露營
  form:null, settingsDraft:null, confirm:null,
};
let unsubTrips = null, unsubExp = null, DEMO = null;

/* ---------- helpers ---------- */
const $ = (s, el=document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const store = {
  get(k){ try{ return localStorage.getItem(k); }catch{ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch{} },
};
function toast(msg){
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg; t.setAttribute("role","status");
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
function download(filename, text, type){
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyText(text, okMsg){
  try { await navigator.clipboard.writeText(text); toast(okMsg); return; } catch {}
  const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  ta.remove(); toast(ok ? okMsg : "無法自動複製，請手動複製");
}
const safeName = s => (String(s).replace(/[\\/:*?"<>|]/g, "").trim() || "露營");

const myId = () => S.mode === "demo" ? "u1" : S.user?.uid;
const currentTrip = () => S.trips.find(t => t.id === S.tripId) || null;
const amOwner = () => S.mode !== "demo" && currentTrip()?.ownerUid === myId();
const groupName = (trip, gid) => (trip.groups.find(g => g.id === gid) || {}).name || "已移除的組";
const who = e => e.createdBy === myId() ? "你" : (e.createdByName || "某位朋友");
const canEditExp = e => e.createdBy === myId() || amOwner();
const inviteLink = id => `${location.origin}${location.pathname}?trip=${encodeURIComponent(id)}&openExternalBrowser=1`;
// LINE、Facebook 等 App 內建瀏覽器會被 Google 擋下登入
const inApp = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent);

function newTrip(name){
  const days = 3, meals = defaultMeals(days);
  return {
    name, startDate:"", days, meals,
    groups:[1,2].map(n => ({id:uid(), name:`第 ${n} 組`, people:2, meals:[...meals], nights:[1,2]})),
  };
}

/* ---------- data layer ---------- */
function errMsg(e){
  const c = e && e.code;
  if (c === "permission-denied") return "沒有權限做這件事。只能修改自己記的花費，刪除露營只有建立的人可以。";
  if (c === "unavailable") return "目前連不上伺服器，請確認網路後再試一次。";
  if (c === "resource-exhausted") return "今天的免費額度用完了，請明天再試。";
  return "儲存失敗，請稍後再試一次。";
}
async function write(fn, demoFn){
  if (S.mode === "demo"){ demoFn(); render(); return true; }
  try { await fn(); return true; }
  catch(e){ console.error(e); toast(errMsg(e)); return false; }
}
function selectTrip(id){
  S.tripId = id; S.expenses = []; S.settingsDraft = null; S.confirm = null;
  if (S.mode !== "demo") store.set("camp.trip", id || "");
  if (unsubExp){ unsubExp(); unsubExp = null; }
  if (S.mode === "demo") S.expenses = DEMO.expenses;
  else if (id){
    unsubExp = onSnapshot(collection(db, "trips", id, "expenses"),
      snap => { S.expenses = snap.docs.map(d => ({id:d.id, ...d.data()})); render(); },
      e => { console.error(e); toast("讀取花費失敗，請重新整理頁面。"); });
  }
  render();
}
function subscribeTrips(){
  if (unsubTrips) unsubTrips();
  let first = true;
  unsubTrips = onSnapshot(query(collection(db, "trips"), where("members", "array-contains", S.user.uid)), snap => {
    if (S.mode === "demo") return;
    S.trips = snap.docs.map(x => ({id:x.id, ...x.data()})).sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
    // pendingSelect：剛建立、剛加入或剛匯入的露營，出現在清單後就切過去
    const want = S.pendingSelect;
    if (want && S.trips.some(t => t.id === want)){ S.pendingSelect = null; first = false; selectTrip(want); }
    else if (first || !currentTrip()){
      first = false;
      const saved = store.get("camp.trip");
      selectTrip(S.trips.some(t => t.id === saved) ? saved : (S.trips[0]?.id || null));
    } else render();
  }, e => { console.error(e); toast("讀取露營資料失敗，請重新整理頁面。"); });
}
// 處理網址上的 ?trip=：已經是成員就直接打開，不是成員就顯示加入畫面
async function handleInviteParam(){
  const params = new URLSearchParams(location.search);
  const id = params.get("trip");
  if (!id) return;
  history.replaceState(null, "", location.pathname);
  try {
    const snap = await getDoc(doc(db, "trips", id));
    if (!snap.exists()){ toast("找不到這次露營，可能已經被刪除。"); return; }
    const t = snap.data();
    if ((t.members || []).includes(S.user.uid)){ S.pendingSelect = id; if (S.trips.some(x => x.id === id)) selectTrip(id); }
    else { S.invite = {id, name:t.name}; render(); }
  } catch(e){ console.error(e); toast("讀取邀請連結失敗。"); }
}
async function joinTrip(){
  const {id} = S.invite;
  try {
    await updateDoc(doc(db, "trips", id), {members: arrayUnion(S.user.uid)});
    S.invite = null; S.pendingSelect = id; S.tab = "list";
    if (S.trips.some(x => x.id === id)) selectTrip(id); else render();
    toast("已加入");
  } catch(e){ console.error(e); toast(errMsg(e)); }
}
async function signIn(){
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); }
  catch(e){
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      console.error(e); toast("登入失敗，請再試一次。");
    }
  }
}
onAuthStateChanged(auth, user => {
  S.user = user;
  if (S.mode === "demo") return;
  if (!user){
    if (unsubTrips){ unsubTrips(); unsubTrips = null; }
    if (unsubExp){ unsubExp(); unsubExp = null; }
    S.mode = "signedout"; S.trips = []; S.tripId = null; S.expenses = [];
    render(); return;
  }
  S.mode = "live";
  render();
  subscribeTrips();
  handleInviteParam();
});

/* ---------- demo data (local only, never saved) ---------- */
function startDemo(){
  const meals = defaultMeals(3);
  const trip = {id:"demo", name:"範例：武陵農場三天兩夜", startDate:"2026-10-24", days:3, meals, createdAt:0, ownerUid:"u9", groups:[
    {id:"g1", name:"阿明家", people:4, meals:[...meals], nights:[1,2]},
    {id:"g2", name:"小華組", people:2, meals:[...meals], nights:[1,2]},
    {id:"g3", name:"大偉組", people:3, meals:["d1-l","d1-d","d2-b"], nights:[1]},
  ]};
  const all = ["g1","g2","g3"];
  const mk = (id, by, byName, x) => ({id, createdBy:by, createdByName:byName, groups:all, pct:100, ...x});
  DEMO = {trip, expenses:[
    mk("e1","u1","", {title:"營位 2 晚 × 3 帳", cat:"site", amount:7200, payer:"g1", mode:"nights", unit:"group", createdAt:1}),
    mk("e2","u2","小華", {title:"全聯採買（肉、菜、調味料）", cat:"food", amount:4280, payer:"g2", mode:"meals", meals:[...meals], createdAt:2}),
    mk("e3","u2","小華", {title:"米一包（用了半包）", cat:"food", amount:380, payer:"g2", mode:"meals", meals:[...meals], pct:50, createdAt:3}),
    mk("e4","u3","大偉", {title:"第二天早餐吐司蛋", cat:"food", amount:520, payer:"g3", mode:"meals", meals:["d2-b"], createdAt:4}),
    mk("e5","u3","大偉", {title:"木炭、冰塊", cat:"other", amount:560, payer:"g3", mode:"people", createdAt:5}),
    mk("e6","u1","", {title:"啤酒一箱", cat:"drink", amount:960, payer:"g1", mode:"custom", custom:{g1:480, g3:480}, groups:["g1","g3"], createdAt:6}),
  ]};
  if (unsubExp){ unsubExp(); unsubExp = null; }
  S.mode = "demo"; S.trips = [trip]; S.tab = "list";
  selectTrip("demo");
}
function leaveDemo(){
  DEMO = null; S.form = null; S.tab = "list"; S.trips = []; S.tripId = null; S.expenses = [];
  if (S.user){ S.mode = "live"; subscribeTrips(); }
  else S.mode = "signedout";
  render();
}

/* ---------- render ---------- */
function render(){
  const app = $("#app");
  const trip = currentTrip();
  let h = `<header class="top"><div><div class="label">營地分帳本</div><h1>${trip ? esc(trip.name) : "營地分帳本"}</h1>`;
  if (trip) h += `<div class="small muted">${trip.startDate ? esc(dayLabel(trip,1)) + " 出發 · " : ""}${trip.days} 天 ${trip.days-1} 夜 · ${trip.groups.length} 組 ${trip.groups.reduce((a,g)=>a+(+g.people||0),0)} 人</div>`;
  h += `</div><div class="tripbar">`;
  if (S.mode === "live"){
    if (S.trips.length > 1) h += `<select class="trip" id="trip-select" aria-label="切換露營">${S.trips.map(t => `<option value="${esc(t.id)}" ${t.id===S.tripId?"selected":""}>${esc(t.name)}</option>`).join("")}</select>`;
    h += `<button class="btn" data-act="new-trip">新增露營</button>`;
  }
  if (S.user && S.mode !== "demo"){
    h += `<span class="userchip">${S.user.photoURL ? `<img src="${esc(S.user.photoURL)}" alt="" referrerpolicy="no-referrer">` : ""}${esc(S.user.displayName || "")}<button class="btn ghost" data-act="signout">登出</button></span>`;
  }
  h += `</div></header>`;

  if (S.mode === "demo"){
    h += `<div class="banner"><span>這是範例資料，只在你的畫面上試算，不會儲存。</span><button class="btn" data-act="leave-demo">結束範例</button></div>`;
  }
  if (S.invite && S.mode === "live"){
    h += `<div class="panel stack"><h2>加入「${esc(S.invite.name)}」</h2>
      <p class="muted" style="margin:0">朋友邀請你一起記這次露營的花費。加入後就能看到明細，也能新增自己墊付的錢。</p>
      <div class="row"><button class="btn primary" data-act="join">加入</button><button class="btn" data-act="dismiss-invite">先不要</button></div></div>`;
  }
  if (S.mode === "loading"){
    h += `<div class="panel muted">載入中…</div>`;
  } else if (S.mode === "signedout"){
    h += `<section class="panel hero"><h2>露營結束，三分鐘分完帳</h2>
      <p class="muted">每組自己記下墊付的花費，依人數、餐數或住宿晚數分攤，最後算出最少的轉帳筆數，複製到 LINE 群組就好。</p>
      ${inApp ? `<p class="err">你正在 App 內建的瀏覽器裡，Google 不允許在這裡登入。請點右上角選單，選擇「用預設瀏覽器開啟」。</p>` : ""}
      <div class="row"><button class="btn primary" data-act="signin">用 Google 帳號登入</button><button class="btn" data-act="demo">先看範例</button></div></section>`;
  } else if (!trip){
    if (S.mode === "live" && !S.invite) h += `<div class="panel stack"><h2>還沒有任何露營紀錄</h2>
      <p class="muted" style="margin:0">建立一次露營，設定天數、有幾組、每組幾個人和實際參加的餐次，再把邀請連結丟到 LINE 群組。朋友加入後，每個人都可以自己新增墊付的花費。</p>
      <div class="row"><button class="btn primary" data-act="new-trip">建立露營</button>
      <label class="btn filebtn">從備份匯入<input type="file" id="import-file" accept=".json,application/json"></label>
      <button class="btn" data-act="demo">先看範例</button></div></div>`;
  } else {
    h += renderSettle(trip);
    h += `<div class="tabs" role="tablist">
      <button class="tab" role="tab" aria-selected="${S.tab==="list"}" data-tab="list">花費明細 <span class="muted small">${S.expenses.length}</span></button>
      <button class="tab" role="tab" aria-selected="${S.tab==="setup"}" data-tab="setup">組別與出席</button></div>`;
    h += S.tab === "list" ? renderList(trip) : renderSetup(trip);
  }
  app.innerHTML = h;
  // 表單開著時不重畫，別人同步進來的資料才不會打斷輸入
  if (!S.form) renderLayer();
}

function renderSettle(trip){
  const {rows, total, transfers} = settle(trip, S.expenses);
  let h = `<section class="panel settle" aria-label="結算">
    <div class="settle-head"><div><div class="label">共同花費</div><div class="total num">${money(total)}</div></div>
    <div class="row">${S.mode === "live" ? `<button class="btn" data-act="invite">邀請朋友</button>` : ""}
    <button class="btn" data-act="copy" ${transfers.length ? "" : "disabled"}>複製結算到 LINE</button>
    <button class="btn" data-act="export" ${S.expenses.length ? "" : "disabled"}>匯出 CSV</button></div></div>`;
  if (!S.expenses.length){
    h += `<div class="empty">還沒有花費。按下方「新增花費」，記下誰先墊了多少。</div>`;
  } else if (!transfers.length){
    h += `<div class="empty">大家已經打平，不需要轉帳。</div>`;
  } else {
    h += `<div><div class="label" style="margin-bottom:6px">轉帳 ${transfers.length} 筆就結清</div><ul class="transfers">${transfers.map(t =>
      `<li class="transfer"><span>${esc(groupName(trip,t.from))}</span><span class="arrow" aria-label="轉給">→</span><span class="to">${esc(groupName(trip,t.to))}</span><span class="amt num">${money(t.amt)}</span></li>`).join("")}</ul></div>`;
  }
  h += `<div class="tablewrap"><table><thead><tr><th>組別</th><th>人數</th><th>先墊付</th><th>應分攤</th><th>每人約</th><th>差額</th></tr></thead><tbody>`;
  for (const g of trip.groups){
    const r = rows[g.id], diff = Math.round(r.paid - r.owe);
    h += `<tr><td>${esc(g.name)}</td><td class="num">${+g.people||0}</td><td class="num">${money(r.paid)}</td><td class="num">${money(r.owe)}</td><td class="num muted">${g.people>0?money(r.owe/g.people):"-"}</td>
      <td class="num ${diff>0?"pos":diff<0?"neg":""}">${diff>0?"收 ":diff<0?"付 ":""}${money(Math.abs(diff))}</td></tr>`;
  }
  h += `</tbody></table></div><div class="hint">金額四捨五入到元。差額「收」代表這組會收到錢，「付」代表要轉出。</div></section>`;
  return h;
}

function renderList(trip){
  const tip = amOwner() ? "你是這次露營的建立者，可以修改任何一筆花費" : "你只能修改自己記的花費，別人記的可以點開查看";
  let h = `<section class="stack"><div class="list-head"><span class="muted small">${tip}</span><button class="btn primary" data-act="add">＋ 新增花費</button></div>`;
  if (!S.expenses.length){
    h += `<div class="empty">誰買了食材、誰訂了營位，都在這裡各自記一筆。<br>只用了一部分的東西（例如半包米），可以設定使用比例。</div>`;
  }
  for (const c of CATS){
    const items = S.expenses.filter(e => catOf(e.cat).id === c.id).sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
    if (!items.length) continue;
    const sum = items.reduce((a,e) => a + Object.values(sharesFor(e, trip)).reduce((x,y)=>x+y,0), 0);
    h += `<div class="cat"><div class="cat-title"><span>${c.label}</span><span class="num">${money(sum)}</span></div>`;
    for (const e of items){
      const sh = sharesFor(e, trip);
      const shared = Object.values(sh).reduce((a,b)=>a+b,0);
      const pct = Number(e.pct ?? 100);
      const bad = e.mode === "custom" ? Math.round(shared) !== Math.round(sharedAmount(e)) : !Object.keys(sh).length;
      h += `<button class="exp" data-edit="${esc(e.id)}"><span class="t">${esc(e.title || "未命名")}</span><span class="a num">${money(e.amount)}</span>
        <span class="meta"><span>${esc(groupName(trip, e.payer))} 墊付 · ${esc(who(e))}記錄</span><span class="pill">${esc(describe(e))}</span>
        ${canEditExp(e) ? "" : `<span class="pill">僅檢視</span>`}
        ${pct !== 100 ? `<span class="pill acc">只分攤 ${pct}%：${money(sharedAmount(e))}</span>` : ""}
        ${bad ? `<span class="pill warn">${e.mode==="custom" ? `自訂合計 ${money(shared)}，與分攤金額不符` : "沒有可分攤的組別"}</span>` : ""}
        <span>${Object.entries(sh).map(([g,v]) => `${esc(groupName(trip,g))} ${money(v)}`).join(" · ")}</span></span></button>`;
    }
    h += `</div>`;
  }
  return h + `</section>`;
}

function renderSetup(trip){
  const d = S.settingsDraft || (S.settingsDraft = JSON.parse(JSON.stringify(trip)));
  const allMeals = mealIds(d.days);
  let h = `<section class="panel stack">`;
  if (S.mode === "live"){
    h += `<div class="field"><span>邀請連結（貼到 LINE 群組，朋友用 Google 登入後就能加入）</span>
      <div class="invite-box"><input type="text" id="invite-url" readonly value="${esc(inviteLink(trip.id))}"><button class="btn" data-act="invite">複製</button></div></div>`;
  }
  h += `<div class="row"><label class="field" style="flex:2 1 220px"><span>露營名稱</span><input type="text" id="s-name" value="${esc(d.name)}"></label>
    <label class="field"><span>出發日</span><input type="date" id="s-date" value="${esc(d.startDate||"")}"></label>
    <label class="field" style="flex:0 1 110px"><span>天數</span><input type="number" id="s-days" min="1" max="7" value="${d.days}"></label></div>
    <div class="field"><span>這次有開伙的餐次</span><div class="chips">${allMeals.map(m => `<button class="chip" aria-pressed="${d.meals.includes(m)}" data-tmeal="${m}">${esc(mealLabel(d,m))}</button>`).join("")}</div></div>
    <div class="stack"><h3>組別</h3>`;
  for (const g of d.groups){
    h += `<div class="group-row"><label class="field"><span>組名</span><input type="text" id="g-name-${g.id}" data-gname="${g.id}" value="${esc(g.name)}"></label>
      <label class="field"><span>人數</span><input type="number" id="g-ppl-${g.id}" data-gppl="${g.id}" min="0" step="0.5" value="${g.people}"></label>
      <button class="btn ghost" data-gdel="${g.id}" ${d.groups.length<=1?"disabled":""} aria-label="移除 ${esc(g.name)}">移除</button></div>`;
  }
  h += `<div><button class="btn" data-act="add-group">＋ 新增一組</button></div>
    <div class="hint">小孩吃得少可以算 0.5 人。</div></div>
    <div class="stack"><h3>各組實際出席</h3><div class="hint">只參加兩天一夜的組，把沒到的餐次和晚上取消勾選，食材和營位就只會算到他們有參加的部分。</div>
    <div class="grid-att"><table><thead><tr><th>組別</th>${d.meals.map(m => `<th class="small">${esc(mealLabel(d,m))}</th>`).join("")}${nightsOf(d).map(n => `<th class="small">第${n}晚</th>`).join("")}</tr></thead><tbody>`;
  for (const g of d.groups){
    h += `<tr><td>${esc(g.name)}</td>${d.meals.map(m => `<td><input type="checkbox" class="cb" id="att-${g.id}-${m}" data-att="${g.id}|m|${m}" ${g.meals.includes(m)?"checked":""} aria-label="${esc(g.name)} ${esc(mealLabel(d,m))}"></td>`).join("")}
      ${nightsOf(d).map(n => `<td><input type="checkbox" class="cb" id="att-${g.id}-n${n}" data-att="${g.id}|n|${n}" ${g.nights.includes(n)?"checked":""} aria-label="${esc(g.name)} 第${n}晚"></td>`).join("")}</tr>`;
  }
  h += `</tbody></table></div></div>
    <div class="actions">`;
  if (S.mode === "live") h += `<button class="btn ghost" data-act="backup">下載備份</button>`;
  if (S.mode === "live" && amOwner()) h += S.confirm === "trip"
    ? `<span class="err">刪除後所有花費都會消失。</span><button class="btn danger" data-act="del-trip-yes">確定刪除</button><button class="btn" data-act="cancel-confirm">取消</button>`
    : `<button class="btn ghost" data-act="del-trip">刪除這次露營</button>`;
  h += `<span class="spacer"></span><button class="btn" data-act="reset-setup">還原</button><button class="btn primary" data-act="save-setup">儲存設定</button></div>
  </section>`;
  return h;
}

/* ---------- expense form ---------- */
function openForm(e){
  const trip = currentTrip();
  const all = trip.groups.map(g => g.id);
  S.form = e ? JSON.parse(JSON.stringify(e)) : {
    title:"", cat:"food", amount:"", payer: store.get("camp.payer." + trip.id) || trip.groups[0]?.id,
    mode:"meals", unit:"group", groups:all, meals:[...trip.meals], pct:100, custom:{},
  };
  if (!trip.groups.some(g => g.id === S.form.payer)) S.form.payer = trip.groups[0]?.id;
  S.form.groups = S.form.groups || all; S.form.meals = S.form.meals || [...trip.meals]; S.form.custom = S.form.custom || {};
  S.form.unit = S.form.unit || "group"; S.form.err = ""; S.confirm = null;
  S.form.readOnly = !!e && !canEditExp(e);
  renderLayer();
  setTimeout(() => $("#f-title")?.focus(), 30);
}
function previewHTML(f, trip){
  const sh = sharesFor({...f, amount:Number(f.amount)||0}, trip);
  const shared = sharedAmount({...f, amount:Number(f.amount)||0});
  const sum = Object.values(sh).reduce((a,b)=>a+b,0);
  return `<div class="pr"><span class="muted">分攤預覽</span><span class="num">${money(sum)}${f.mode!=="custom" && Number(f.pct)!==100 ? ` <span class="muted small">（${money(Number(f.amount)||0)} × ${esc(f.pct)}%）</span>` : ""}</span></div>
    ${Object.keys(sh).length ? trip.groups.filter(g => sh[g.id]).map(g => `<div class="pr"><span>${esc(g.name)}</span><span class="num">${money(sh[g.id])}</span></div>`).join("") : `<div class="muted">填入金額並選擇分攤的組後會顯示。</div>`}
    ${f.mode==="custom" && Number(f.amount) && Math.round(sum) !== Math.round(shared) ? `<div class="err">自訂合計和金額 ${money(shared)} 不同，結算會以自訂合計為準。</div>` : ""}`;
}
// 打字時只更新預覽，不重畫輸入框，游標才不會跑掉
function updatePreview(){
  const f = S.form, box = $("#f-preview");
  if (!f || !box) return;
  box.innerHTML = previewHTML(f, currentTrip());
  document.querySelectorAll("[data-pct]").forEach(b => b.setAttribute("aria-pressed", String(Number(f.pct) === Number(b.dataset.pct))));
}
function renderLayer(){
  const layer = $("#layer");
  const trip = currentTrip();
  if (!S.form || !trip){ layer.innerHTML = ""; return; }
  const f = S.form;
  let h = `<div class="overlay" data-act="close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="f-head">
    <div class="sheet-head"><h2 id="f-head">${f.readOnly ? "花費內容" : f.id ? "修改花費" : "新增花費"}</h2><button class="btn ghost" data-act="close" aria-label="關閉">關閉</button></div>
    <div class="stack">
    ${f.id ? `<div class="hint">${esc(who(f))}記錄${f.readOnly ? "，只有記錄的人可以修改或刪除。" : f.createdBy !== myId() ? "。你是建立者，可以幫忙修正。" : ""}</div>` : ""}
    <fieldset class="fs" ${f.readOnly ? "disabled" : ""}><div class="stack">
    <label class="field"><span>買了什麼</span><input type="text" id="f-title" maxlength="100" value="${esc(f.title)}" placeholder="例如：全聯採買、營位訂金"></label>
    <div class="row"><label class="field"><span>金額（元）</span><input type="number" id="f-amount" inputmode="decimal" min="0" value="${esc(f.amount)}" placeholder="0"></label>
      <label class="field"><span>誰先墊付</span><select class="in" id="f-payer">${trip.groups.map(g => `<option value="${esc(g.id)}" ${g.id===f.payer?"selected":""}>${esc(g.name)}</option>`).join("")}</select></label></div>
    <div class="field"><span>類別</span><div class="chips">${CATS.map(c => `<button class="chip" aria-pressed="${f.cat===c.id}" data-cat="${c.id}">${c.label}</button>`).join("")}</div></div>
    <div class="field"><span>怎麼分攤</span><div class="chips">${catOf(f.cat).modes.map(k => `<button class="chip" aria-pressed="${f.mode===k}" data-mode="${k}">${MODES[k].label}</button>`).join("")}</div>
      <div class="hint">${MODES[f.mode].hint}</div></div>`;
  if (f.mode === "nights"){
    h += `<div class="field"><span>計算單位</span><div class="chips"><button class="chip" aria-pressed="${f.unit!=="person"}" data-unit="group">每組（一組一帳）</button><button class="chip" aria-pressed="${f.unit==="person"}" data-unit="person">每人</button></div></div>`;
  }
  if (f.mode === "meals"){
    h += `<div class="field"><span>這筆是哪幾餐用的</span><div class="chips">${trip.meals.map(m => `<button class="chip" aria-pressed="${f.meals.includes(m)}" data-meal="${m}">${esc(mealLabel(trip,m))}</button>`).join("")}</div>
      <div class="hint">不確定的話全選就好，系統會依各組實際出席的餐次計算。</div></div>`;
  }
  if (f.mode === "custom"){
    h += `<div class="field"><span>每組要付多少</span><div class="stack" style="gap:8px">${trip.groups.map(g => `<label class="row" style="align-items:center"><span style="flex:1">${esc(g.name)}</span><input type="number" id="f-c-${g.id}" data-custom="${g.id}" min="0" style="max-width:140px" value="${esc(f.custom[g.id] ?? "")}"></label>`).join("")}</div></div>`;
  } else {
    h += `<div class="field"><span>參與分攤的組</span><div class="chips">${trip.groups.map(g => `<button class="chip" aria-pressed="${f.groups.includes(g.id)}" data-grp="${g.id}">${esc(g.name)}</button>`).join("")}</div></div>
      <div class="field"><span>實際用掉多少（選填）</span><div class="chips">${PCTS.map(p => `<button class="chip" aria-pressed="${Number(f.pct)===p}" data-pct="${p}">${p===100?"全部":p+"%"}</button>`).join("")}
        <label class="row" style="align-items:center;gap:4px"><input type="number" id="f-pct" min="1" max="100" style="width:80px" value="${esc(f.pct)}" aria-label="自訂使用比例">%</label></div>
      <div class="hint">例如米只用了半包，選 50%，剩下的算墊付者自己的。</div></div>`;
  }
  h += `</div></fieldset><div class="preview" id="f-preview" aria-live="polite">${previewHTML(f, trip)}</div>
    ${f.err ? `<div class="err" role="alert">${esc(f.err)}</div>` : ""}
    ${f.readOnly ? `<div class="actions"><button class="btn" data-act="close">關閉</button></div>` : `<div class="actions">${f.id ? (S.confirm==="exp" ? `<button class="btn danger" data-act="del-yes">確定刪除</button><button class="btn" data-act="cancel-confirm">取消</button>` : `<button class="btn ghost" data-act="del">刪除</button>`) : ""}
      <span class="spacer"></span><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save">${f.id ? "儲存修改" : "新增"}</button></div>`}
    </div></div></div>`;
  const focusId = document.activeElement?.id;
  const sheetScroll = $(".sheet", layer)?.scrollTop;
  layer.innerHTML = h;
  if (sheetScroll) $(".sheet", layer).scrollTop = sheetScroll;
  if (focusId) document.getElementById(focusId)?.focus();
}
function setErr(m){ S.form.err = m; renderLayer(); }
async function saveForm(){
  const trip = currentTrip(), f = S.form;
  const amount = Number(f.amount);
  if (!f.title.trim()) return setErr("請填寫買了什麼。");
  if (!(amount > 0)) return setErr("請填寫大於 0 的金額。");
  if (!Object.keys(sharesFor({...f, amount}, trip)).length) return setErr(f.mode==="custom" ? "請至少填一組要付的金額。" : "目前沒有組別需要分攤這筆，請檢查參與的組或餐次。");
  const pct = Math.min(100, Math.max(1, Number(f.pct) || 100));
  const data = {title:f.title.trim(), cat:f.cat, amount, payer:f.payer, mode:f.mode, unit:f.unit, groups:f.groups, meals:f.meals, pct,
    custom:Object.fromEntries(Object.entries(f.custom).filter(([,v]) => Number(v) > 0).map(([k,v]) => [k, Number(v)])),
    createdBy: f.id ? f.createdBy : myId(),
    createdByName: f.id ? (f.createdByName || "") : (S.user?.displayName || ""),
    createdAt:f.createdAt || Date.now(), updatedAt:Date.now()};
  store.set("camp.payer." + trip.id, f.payer);
  const id = f.id || doc(collection(db, "trips", trip.id, "expenses")).id;
  const ok = await write(
    () => setDoc(doc(db, "trips", trip.id, "expenses", id), data),
    () => { const i = DEMO.expenses.findIndex(x => x.id === id); const row = {id, ...data}; if (i >= 0) DEMO.expenses[i] = row; else DEMO.expenses.push(row); S.expenses = DEMO.expenses; }
  );
  if (ok){ S.form = null; renderLayer(); toast(f.id ? "已更新" : "已新增"); }
}
async function deleteExpense(){
  const trip = currentTrip(), id = S.form.id;
  const ok = await write(async () => { const b = writeBatch(db); b.delete(doc(db, "trips", trip.id, "expenses", id)); await b.commit(); },
    () => { DEMO.expenses = DEMO.expenses.filter(x => x.id !== id); S.expenses = DEMO.expenses; });
  if (ok){ S.form = null; S.confirm = null; renderLayer(); toast("已刪除"); }
}

/* ---------- trip actions ---------- */
function setDays(d, n){
  n = Math.max(1, Math.min(7, Math.round(n) || 1));
  const valid = new Set(mealIds(n));
  const old = d.days, grew = n > old;
  d.days = n;
  d.meals = d.meals.filter(m => valid.has(m));
  if (grew){ for (const m of mealIds(n)) if (+m.match(/^d(\d+)/)[1] > old && m !== `d${n}-d`) d.meals.push(m); }
  for (const g of d.groups){
    g.meals = g.meals.filter(m => valid.has(m));
    g.nights = g.nights.filter(x => x < n);
    if (grew) for (let x = old; x < n; x++) if (!g.nights.includes(x)) g.nights.push(x);
  }
}
function tripSettings(d){
  d.meals.sort((a,b) => mealIds(d.days).indexOf(a) - mealIds(d.days).indexOf(b));
  return {name:String(d.name).trim().slice(0, 60) || "未命名露營", startDate:d.startDate||"", days:d.days, meals:d.meals,
    groups:d.groups.map(g => ({id:g.id, name:String(g.name).trim() || "未命名", people:Math.max(0, Number(g.people)||0), meals:g.meals.filter(m => d.meals.includes(m)), nights:g.nights}))};
}
async function saveSetup(){
  const d = S.settingsDraft, trip = currentTrip();
  if (!d.name.trim()) return toast("請填寫露營名稱。");
  const data = tripSettings(d);
  const ok = await write(() => updateDoc(doc(db, "trips", trip.id), data), () => { Object.assign(DEMO.trip, data); });
  if (ok){ S.settingsDraft = null; render(); toast("設定已儲存"); }
}
async function createTrip(settings, expenses = []){
  const ref = doc(collection(db, "trips"));
  const b = writeBatch(db);
  b.set(ref, {...settings, ownerUid:S.user.uid, members:[S.user.uid], createdAt:Date.now()});
  await b.commit();
  // 花費的權限規則要先確認自己是成員，所以露營建立完成後再寫入
  for (let i = 0; i < expenses.length; i += 400){
    const eb = writeBatch(db);
    for (const e of expenses.slice(i, i + 400)) eb.set(doc(collection(db, "trips", ref.id, "expenses")), e);
    await eb.commit();
  }
  return ref.id;
}
async function newTripAction(){
  try {
    const id = await createTrip(tripSettings(newTrip(`${new Date().getMonth()+1} 月露營`)));
    S.tab = "setup"; S.pendingSelect = id; store.set("camp.trip", id);
    toast("已建立，先設定組別和出席");
  } catch(e){ console.error(e); toast(errMsg(e)); }
}
async function deleteTrip(){
  const trip = currentTrip();
  try {
    const ids = S.expenses.map(e => e.id);
    for (let i = 0; i < ids.length; i += 400){
      const b = writeBatch(db);
      for (const id of ids.slice(i, i + 400)) b.delete(doc(db, "trips", trip.id, "expenses", id));
      await b.commit();
    }
    const b = writeBatch(db); b.delete(doc(db, "trips", trip.id)); await b.commit();
    S.confirm = null; S.tripId = null; toast("已刪除");
  } catch(e){ console.error(e); toast(errMsg(e)); }
}
function exportCsv(){
  const trip = currentTrip(), {rows, transfers} = settle(trip, S.expenses), gs = trip.groups;
  const q = v => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const r0 = n => Math.round(n);
  const lines = [[`${trip.name} 分帳明細`], [],
    ["類別","項目","金額","使用比例","分攤金額","墊付組","分攤方式","記錄者", ...gs.map(g => `${g.name} 分攤`)]];
  for (const e of [...S.expenses].sort((a,b) => (a.createdAt||0) - (b.createdAt||0))){
    const sh = sharesFor(e, trip), sum = Object.values(sh).reduce((a,b) => a+b, 0);
    lines.push([catOf(e.cat).label, e.title, e.amount, `${e.pct ?? 100}%`, r0(sum), groupName(trip, e.payer),
      describe(e), e.createdByName || who(e), ...gs.map(g => sh[g.id] ? r0(sh[g.id]) : "")]);
  }
  lines.push([], ["組別","人數","先墊付","應分攤","差額（正數為收款）"]);
  for (const g of gs) lines.push([g.name, g.people, r0(rows[g.id].paid), r0(rows[g.id].owe), r0(rows[g.id].paid - rows[g.id].owe)]);
  lines.push([], ["轉出","轉入","金額"]);
  for (const t of transfers) lines.push([groupName(trip, t.from), groupName(trip, t.to), t.amt]);
  download(`${safeName(trip.name)}-分帳.csv`, "﻿" + lines.map(r => r.map(q).join(",")).join("\r\n"), "text/csv;charset=utf-8");
}
// 備份檔：露營設定 + 所有花費，可以再匯入成一次新的露營
function exportBackup(){
  const trip = currentTrip();
  const strip = ({id, createdBy, ...rest}) => rest;
  const data = {app:"camp-split", version:1, exportedAt:new Date().toISOString(), trip:tripSettings(JSON.parse(JSON.stringify(trip))), expenses:S.expenses.map(strip)};
  download(`${safeName(trip.name)}-備份.json`, JSON.stringify(data, null, 2), "application/json");
}
async function importBackup(file){
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("這個檔案不是有效的備份檔。"); }
  if (data?.app !== "camp-split" || !data.trip || !Array.isArray(data.expenses)) return toast("這個檔案不是營地分帳本的備份檔。");
  try {
    const settings = tripSettings(data.trip);
    const me = S.user.uid, myName = S.user.displayName || "";
    const exps = data.expenses.map(e => ({...e, title:String(e.title||"").slice(0,100) || "未命名", amount:Number(e.amount)||0,
      createdBy:me, createdByName: e.createdByName || myName})).filter(e => e.amount > 0);
    const id = await createTrip(settings, exps);
    S.pendingSelect = id; store.set("camp.trip", id); S.tab = "list";
    toast(`已匯入「${settings.name}」，共 ${exps.length} 筆花費`);
  } catch(e){ console.error(e); toast(errMsg(e)); }
}
function copySettle(){
  const trip = currentTrip(), {rows, total, transfers} = settle(trip, S.expenses);
  const lines = [`【${trip.name}】分帳結果`, `共同花費 ${money(total)}`, "",
    ...transfers.map(t => `${groupName(trip,t.from)} → ${groupName(trip,t.to)}  ${money(t.amt)}`), "",
    ...trip.groups.map(g => `${g.name}（${g.people} 人）墊付 ${money(rows[g.id].paid)}，分攤 ${money(rows[g.id].owe)}`)];
  copyText(lines.join("\n"), "已複製，可以直接貼到 LINE");
}
function copyInvite(){
  const trip = currentTrip();
  copyText(`一起記「${trip.name}」的露營花費：\n${inviteLink(trip.id)}\n（用 Google 帳號登入後按「加入」）`, "已複製邀請連結，貼到 LINE 群組就好");
}

/* ---------- events ---------- */
document.addEventListener("click", ev => {
  const t = ev.target.closest("button, .overlay");
  if (!t) return;
  const a = t.dataset;
  const f = S.form, d = S.settingsDraft;
  if (a.act === "close-bg"){ if (ev.target === t){ S.form = null; renderLayer(); } return; }
  if (a.tab){ S.tab = a.tab; S.confirm = null; render(); return; }
  if (a.edit){ openForm(S.expenses.find(e => e.id === a.edit)); return; }
  if (f && a.cat){
    const c = catOf(a.cat); f.cat = a.cat;
    if (!c.modes.includes(f.mode) || (!f.id && !f.touchedMode)){ f.mode = c.modes[0]; if (c.unit) f.unit = c.unit; }
    renderLayer(); return;
  }
  if (f && a.mode){ f.mode = a.mode; f.touchedMode = true; renderLayer(); return; }
  if (f && a.unit){ f.unit = a.unit; renderLayer(); return; }
  if (f && a.meal){ f.meals = f.meals.includes(a.meal) ? f.meals.filter(x => x !== a.meal) : [...f.meals, a.meal]; renderLayer(); return; }
  if (f && a.grp){ f.groups = f.groups.includes(a.grp) ? f.groups.filter(x => x !== a.grp) : [...f.groups, a.grp]; renderLayer(); return; }
  if (f && a.pct){ f.pct = Number(a.pct); renderLayer(); return; }
  if (d && a.tmeal){ d.meals = d.meals.includes(a.tmeal) ? d.meals.filter(x => x !== a.tmeal) : [...d.meals, a.tmeal];
    if (d.meals.includes(a.tmeal)) d.groups.forEach(g => { if (!g.meals.includes(a.tmeal)) g.meals.push(a.tmeal); });
    render(); return; }
  if (d && a.gdel){ d.groups = d.groups.filter(g => g.id !== a.gdel); render(); return; }
  switch (a.act){
    case "signin": signIn(); break;
    case "signout": signOut(auth); break;
    case "join": joinTrip(); break;
    case "dismiss-invite": S.invite = null; render(); break;
    case "invite": copyInvite(); break;
    case "add": openForm(null); break;
    case "close": S.form = null; S.confirm = null; renderLayer(); break;
    case "save": saveForm(); break;
    case "del": S.confirm = "exp"; renderLayer(); break;
    case "del-yes": deleteExpense(); break;
    case "cancel-confirm": S.confirm = null; S.form ? renderLayer() : render(); break;
    case "demo": startDemo(); break;
    case "leave-demo": leaveDemo(); break;
    case "new-trip": newTripAction(); break;
    case "copy": copySettle(); break;
    case "export": exportCsv(); break;
    case "backup": exportBackup(); break;
    case "add-group": d.groups.push({id:uid(), name:`第 ${d.groups.length+1} 組`, people:2, meals:[...d.meals], nights:nightsOf(d)}); render(); break;
    case "reset-setup": S.settingsDraft = null; render(); break;
    case "save-setup": saveSetup(); break;
    case "del-trip": S.confirm = "trip"; render(); break;
    case "del-trip-yes": deleteTrip(); break;
  }
});
document.addEventListener("input", ev => {
  const el = ev.target, f = S.form, d = S.settingsDraft;
  if (f){
    if (el.id === "f-title"){ f.title = el.value; return; }
    if (el.id === "f-amount"){ f.amount = el.value; updatePreview(); return; }
    if (el.id === "f-pct"){ f.pct = el.value; updatePreview(); return; }
    if (el.dataset.custom){ f.custom[el.dataset.custom] = el.value; updatePreview(); return; }
  }
  if (d){
    if (el.id === "s-name"){ d.name = el.value; return; }
    if (el.dataset.gname){ d.groups.find(g => g.id === el.dataset.gname).name = el.value; return; }
    if (el.dataset.gppl){ d.groups.find(g => g.id === el.dataset.gppl).people = el.value; return; }
  }
});
document.addEventListener("change", ev => {
  const el = ev.target, f = S.form, d = S.settingsDraft;
  if (el.id === "import-file" && el.files[0]){ importBackup(el.files[0]); el.value = ""; return; }
  if (el.id === "trip-select"){ S.tab = "list"; selectTrip(el.value); return; }
  if (f && el.id === "f-payer"){ f.payer = el.value; renderLayer(); return; }
  if (d){
    if (el.id === "s-date"){ d.startDate = el.value; render(); return; }
    if (el.id === "s-days"){ setDays(d, Number(el.value)); render(); return; }
    if (el.dataset.gname || el.dataset.gppl){ render(); return; }
    if (el.dataset.att){
      const [gid, kind, v] = el.dataset.att.split("|"), g = d.groups.find(x => x.id === gid);
      const key = kind === "m" ? "meals" : "nights", val = kind === "m" ? v : Number(v);
      g[key] = el.checked ? [...g[key], val] : g[key].filter(x => x !== val);
    }
  }
});
document.addEventListener("keydown", ev => { if (ev.key === "Escape" && S.form){ S.form = null; renderLayer(); } });

render();
