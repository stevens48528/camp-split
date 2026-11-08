import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where, onSnapshot, setDoc, updateDoc, getDoc, getDocs, arrayUnion, writeBatch }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { SLOTS, CATS, catOf, MODES, PCTS, money, mealIds, defaultMeals, dayLabel, mealLabel, nightsOf,
  sharedAmount, sharesFor, settle, describe } from "./split.js";

// 這段設定本來就會公開在網頁上，安全性由 Firebase Auth 和 firestore.rules 負責
const firebaseConfig = {
  apiKey: "AIzaSyClBGCdUK-T2zFWnVbP8pKvW6DyQ_LPIm4",
  authDomain: "camp-split-b3a20.web.app",
  projectId: "camp-split-b3a20",
  storageBucket: "camp-split-b3a20.firebasestorage.app",
  messagingSenderId: "451437047186",
  appId: "1:451437047186:web:142e4107286d17eef1e54b",
};
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// 資料先存在手機上（IndexedDB），營地沒訊號也能記帳，有網路時自動上傳
const db = initializeFirestore(fb, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})});

const S = {
  mode:"loading",     // loading | signedout | noaccess | live | demo
  view:null,          // "admin"：成員管理頁
  allow:[], allowDraft:{email:"", note:""},
  user:null, trips:[], tripId:null, expenses:[], tab:"list",
  invite:null,        // {id, name}：從邀請連結進來、還不是成員的露營
  form:null, settingsDraft:null, confirm:null,
  menu:null,          // null | "main" | "install"：右上角選單
  newTrip:null,       // 新增露營的表單
  skipBind:{},        // 這次先不選組別的露營
  offline:!navigator.onLine,
  summaries:{},       // 露營清單用：{露營ID: {total, transfers, count}}
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

// 可以建立露營的人（Firebase Auth UID），要和 firestore.rules 的 isCreator() 一致
const CREATORS = ["K9pYZJfk12bjxNbng3OR14mtbs12"];
const myId = () => S.mode === "demo" ? "u1" : S.user?.uid;
const currentTrip = () => S.trips.find(t => t.id === S.tripId) || null;
const amOwner = () => S.mode !== "demo" && currentTrip()?.ownerUid === myId();
const canCreate = () => S.mode === "live" && CREATORS.includes(S.user?.uid);
// 範例模式讓大家試玩設定；正式資料只有建立者能改
const canEditSettings = () => S.mode === "demo" || amOwner();
const groupName = (trip, gid) => (trip.groups.find(g => g.id === gid) || {}).name || "已移除的組";
const who = e => e.createdBy === myId() ? "你" : (e.createdByName || "某位朋友");
const canEditExp = e => e.createdBy === myId() || amOwner();
// 登入者在這場露營是哪一組（存在露營的 memberGroups）；組被刪掉就當作還沒選
const myGroup = (trip, uid = myId()) => {
  const b = trip.memberGroups?.[uid];
  return b && trip.groups.some(g => g.id === b.g) ? b.g : null;
};
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const peopleOf = trip => trip.groups.reduce((a,g) => a + (+g.people||0), 0);
const tripLine = trip => `${trip.startDate ? esc(dayLabel(trip,1)) + " 出發 · " : ""}${trip.days} 天 ${trip.days-1} 夜 · ${trip.groups.length} 組 ${peopleOf(trip)} 人`;
const inviteLink = id => `${location.origin}${location.pathname}?trip=${encodeURIComponent(id)}&openExternalBrowser=1`;
// LINE、Facebook 等 App 內建瀏覽器會被 Google 擋下登入
const inApp = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent);

// from：沿用某次露營的組別（同樣的組 ID，朋友選過的組別也會跟著沿用）
function newTrip(name, days = 3, startDate = "", from = null){
  const meals = defaultMeals(days), nights = nightsOf({days});
  const base = from ? from.groups.map(g => ({id:g.id, name:g.name, people:g.people}))
    : [1,2].map(n => ({id:uid(), name:`第 ${n} 組`, people:2}));
  return {name, startDate, days, meals, groups:base.map(g => ({...g, meals:[...meals], nights:[...nights]}))};
}

/* ---------- data layer ---------- */
function errMsg(e){
  const c = e && e.code;
  if (c === "permission-denied") return "沒有權限做這件事。只能修改自己記的花費，刪除露營只有建立的人可以。";
  if (c === "unavailable") return "目前連不上伺服器，請確認網路後再試一次。";
  if (c === "resource-exhausted") return "今天的免費額度用完了，請明天再試。";
  return "儲存失敗，請稍後再試一次。";
}
// 寫入會先存在手機上，不等伺服器回應，沒訊號時也不會卡住；真的失敗（例如沒權限）再提示
function write(fn, demoFn){
  if (S.mode === "demo"){ demoFn(); render(); return true; }
  try { fn().catch(e => { console.error(e); toast(errMsg(e)); }); return true; }
  catch(e){ console.error(e); toast(errMsg(e)); return false; }
}
function selectTrip(id){
  S.tripId = id; S.expenses = []; S.settingsDraft = null; S.confirm = null; S.form = null;
  if (unsubExp){ unsubExp(); unsubExp = null; }
  if (S.mode === "demo") S.expenses = DEMO.expenses;
  else if (id){
    unsubExp = onSnapshot(collection(db, "trips", id, "expenses"), {includeMetadataChanges:true},
      snap => { S.expenses = snap.docs.map(d => ({id:d.id, ...d.data(), pending:d.metadata.hasPendingWrites})); render(); },
      e => { console.error(e); toast("讀取花費失敗，請重新整理頁面。"); });
  }
  render();
}
function subscribeTrips(){
  if (unsubTrips) unsubTrips();
  unsubTrips = onSnapshot(query(collection(db, "trips"), where("members", "array-contains", S.user.uid)), snap => {
    if (S.mode === "demo") return;
    S.trips = snap.docs.map(x => ({id:x.id, ...x.data()})); S.tripsLoaded = true;
    // pendingSelect：剛建立、剛加入或剛匯入的露營，出現在清單後就切過去
    const want = S.pendingSelect;
    if (want && S.trips.some(t => t.id === want)){ S.pendingSelect = null; openTrip(want); }
    else route();
  }, e => { console.error(e); toast("讀取露營資料失敗，請重新整理頁面。"); });
}
function openWhenReady(id){
  if (S.trips.some(t => t.id === id)){ S.pendingSelect = null; openTrip(id); }
  else { S.pendingSelect = id; render(); }
}
// 網址的 #露營ID 代表正在看哪一場，沒有就是露營清單；手機按返回鍵可以回到清單
function openTrip(id, replace){
  const url = location.pathname + (id ? "#" + encodeURIComponent(id) : "");
  if (url !== location.pathname + location.hash) history[replace ? "replaceState" : "pushState"](null, "", url);
  route();
}
function route(){
  if (S.mode !== "live") return;
  let id = decodeURIComponent(location.hash.slice(1));
  if (id === "admin" && canCreate()){
    if (S.tripId) selectTrip(null);
    S.view = "admin"; watchAllow(); render(); return;
  }
  S.view = null; unwatchAllow();
  if (id && !S.trips.some(t => t.id === id)){ id = ""; history.replaceState(null, "", location.pathname); }
  if (id !== (S.tripId || "")){ S.tab = S.nextTab || "list"; S.nextTab = null; selectTrip(id || null); }
  else render();
  if (!id) loadSummaries();
}
addEventListener("popstate", route);
// 成員管理頁打開時才讀白名單
let unsubAllow = null;
function watchAllow(){
  if (unsubAllow) return;
  unsubAllow = onSnapshot(collection(db, "allow"), snap => {
    S.allow = snap.docs.map(d => ({email:d.id, ...d.data()})).sort((a,b) => (b.addedAt||0) - (a.addedAt||0));
    if (S.view === "admin") render();
  }, e => { console.error(e); toast("讀取成員名單失敗。"); });
}
function unwatchAllow(){ if (unsubAllow){ unsubAllow(); unsubAllow = null; } }
// 帳號白名單：管理者一定可以；其他人查 allow/{自己的 Email} 存不存在。真正的把關在權限規則
async function checkAccess(user){
  if (CREATORS.includes(user.uid)) return true;
  const email = (user.email || "").toLowerCase();
  if (!email) return false;
  try { return (await getDoc(doc(db, "allow", email))).exists(); }
  catch(e){
    if (e.code === "permission-denied") return false;
    // 沒網路又沒有快取時先放行，畫面上能顯示的也只有手機裡已經存過的資料
    console.error(e); return true;
  }
}
// 露營清單要顯示每場的總花費，打開清單時把各場的花費讀一次來算
let summarySeq = 0;
async function loadSummaries(){
  const seq = ++summarySeq;
  const res = await Promise.all(S.trips.map(t => getDocs(collection(db, "trips", t.id, "expenses"))
    .then(snap => {
      const {total, transfers} = settle(t, snap.docs.map(d => d.data()));
      const mg = myGroup(t), sumOf = list => list.reduce((a, x) => a + x.amt, 0);
      const mine = mg && {pay:sumOf(transfers.filter(x => x.from === mg)), get:sumOf(transfers.filter(x => x.to === mg))};
      return [t.id, {total, transfers:transfers.length, count:snap.size, mine}];
    })
    .catch(e => { console.error(e); return [t.id, null]; })));
  if (seq !== summarySeq) return;
  S.summaries = Object.fromEntries(res);
  if (!S.tripId) render();
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
    if ((t.members || []).includes(S.user.uid)) openWhenReady(id);
    else { S.invite = {id, name:t.name}; render(); }
  } catch(e){ console.error(e); toast("讀取邀請連結失敗。"); }
}
async function joinTrip(){
  const {id} = S.invite;
  try {
    await updateDoc(doc(db, "trips", id), {members: arrayUnion(S.user.uid)});
    S.invite = null;
    openWhenReady(id);
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
onAuthStateChanged(auth, async user => {
  S.user = user;
  if (S.mode === "demo") return;
  if (!user){
    if (unsubTrips){ unsubTrips(); unsubTrips = null; }
    if (unsubExp){ unsubExp(); unsubExp = null; }
    unwatchAllow();
    S.mode = "signedout"; S.trips = []; S.tripId = null; S.expenses = []; S.view = null;
    render(); return;
  }
  S.mode = "loading"; render();
  const ok = await checkAccess(user);
  if (S.user !== user || S.mode === "demo") return;
  if (!ok){ S.mode = "noaccess"; render(); return; }
  S.mode = "live"; S.tripsLoaded = false;
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
  if (S.user){ S.mode = "live"; S.tripsLoaded = false; subscribeTrips(); }
  else S.mode = "signedout";
  render();
}

/* ---------- render ---------- */
function render(){
  const app = $("#app");
  const trip = currentTrip();
  const admin = S.mode === "live" && S.view === "admin";
  const home = S.mode === "live" && !trip && !admin && S.trips.length > 0;
  let h = `<header class="top"><div>`;
  if (S.mode === "live" && (trip || admin)) h += `<button class="btn ghost back" data-act="home">← 全部露營</button>`;
  h += `<div class="label">營地分帳本</div><h1>${trip ? esc(trip.name) : admin ? "成員管理" : home ? "我的露營" : "營地分帳本"}</h1>`;
  if (trip) h += `<div class="small muted">${tripLine(trip)}</div>`;
  else if (home) h += `<div class="small muted">共 ${S.trips.length} 場</div>`;
  h += `</div><div class="tripbar">`;
  if (home && canCreate()) h += `<button class="btn" data-act="new-trip">新增露營</button>`;
  if ((S.user && S.mode === "live") || S.mode === "demo"){
    const photo = S.mode === "live" && S.user.photoURL;
    h += `<button class="btn menubtn" data-act="menu" aria-haspopup="dialog">${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : ""}選單</button>`;
  }
  h += `</div></header>`;
  if (S.offline && S.mode === "live"){
    h += `<div class="banner"><span>目前沒有網路。新記的花費會先存在這支手機，有訊號時自動上傳。</span></div>`;
  }

  if (S.mode === "demo"){
    h += `<div class="banner"><span>這是範例資料，只在你的畫面上試算，不會儲存。</span><button class="btn" data-act="leave-demo">結束範例</button></div>`;
  }
  if (S.invite && S.mode === "live"){
    h += `<div class="panel stack"><h2>加入「${esc(S.invite.name)}」</h2>
      <p class="muted" style="margin:0">朋友邀請你一起記這次露營的花費。加入後就能看到明細，也能新增自己墊付的錢。</p>
      <div class="row"><button class="btn primary" data-act="join">加入</button><button class="btn" data-act="dismiss-invite">先不要</button></div></div>`;
  }
  if (S.mode === "loading" || (S.mode === "live" && !S.tripsLoaded)){
    h += `<div class="panel muted">載入中…</div>`;
  } else if (S.mode === "signedout"){
    h += `<section class="panel hero"><h2>露營結束，三分鐘分完帳</h2>
      <p class="muted">每組自己記下墊付的花費，依人數、餐數或住宿晚數分攤，最後算出最少的轉帳筆數，複製到 LINE 群組就好。</p>
      ${inApp ? `<p class="err">你正在 App 內建的瀏覽器裡，Google 不允許在這裡登入。請點右上角選單，選擇「用預設瀏覽器開啟」。</p>` : ""}
      <div class="row"><button class="btn primary" data-act="signin">用 Google 帳號登入</button><button class="btn" data-act="demo">先看範例</button></div></section>`;
  } else if (S.mode === "noaccess"){
    const email = S.user?.email || "";
    h += `<section class="panel stack"><h2>你還沒有使用權限</h2>
      <p class="muted" style="margin:0">這個分帳本只開放給受邀的朋友。請把下面的 Email 傳給建立露營的朋友，他加入名單後，重新整理這一頁就能使用。</p>
      <div class="invite-box"><input type="text" readonly value="${esc(email)}" aria-label="你的 Email"><button class="btn" data-act="copy-email">複製</button></div>
      <div class="row"><button class="btn primary" data-act="recheck">重新整理</button><button class="btn" data-act="signout">換一個帳號</button></div></section>`;
  } else if (admin){
    h += renderAdmin();
  } else if (home){
    h += renderHome();
  } else if (!trip){
    if (S.mode === "live" && S.pendingSelect) h += `<div class="panel muted">載入中…</div>`;
    else if (S.mode === "live" && !S.invite && !canCreate()) h += `<div class="panel stack"><h2>還沒有加入任何露營</h2>
      <p class="muted" style="margin:0">請跟建立露營的朋友要邀請連結，點開後按「加入」，就能一起記帳。</p>
      <div class="row"><button class="btn" data-act="demo">先看範例</button></div></div>`;
    else if (S.mode === "live" && !S.invite) h += `<div class="panel stack"><h2>還沒有任何露營紀錄</h2>
      <p class="muted" style="margin:0">建立一次露營，設定天數、有幾組、每組幾個人和實際參加的餐次，再把邀請連結丟到 LINE 群組。朋友加入後，每個人都可以自己新增墊付的花費。</p>
      <div class="row"><button class="btn primary" data-act="new-trip">建立露營</button>
      <label class="btn filebtn">從備份匯入<input type="file" id="import-file" accept=".json,application/json"></label>
      <button class="btn" data-act="demo">先看範例</button></div></div>`;
  } else {
    if (S.mode === "live" && trip.groups.length && !myGroup(trip) && !S.skipBind[trip.id]){
      h += `<div class="panel stack bind"><h2>你是哪一組？</h2>
        <p class="muted" style="margin:0">選了之後，新增花費會自動帶入你這組，露營清單也會顯示你要付或要收多少。之後可以在右上角選單更改。</p>
        <div class="chips">${trip.groups.map(g => `<button class="chip" data-mygroup="${esc(g.id)}">${esc(g.name)}</button>`).join("")}</div>
        <div><button class="btn ghost" data-act="skip-bind">之後再說</button></div></div>`;
    }
    h += renderSettle(trip);
    h += `<div class="tabs" role="tablist">
      <button class="tab" role="tab" aria-selected="${S.tab==="list"}" data-tab="list">花費明細 <span class="muted small">${S.expenses.length}</span></button>
      <button class="tab" role="tab" aria-selected="${S.tab==="setup"}" data-tab="setup">組別與出席</button></div>`;
    h += S.tab === "list" ? renderList(trip) : renderSetup(trip);
  }
  app.innerHTML = h;
  // 表單開著時不重畫，別人同步進來的資料才不會打斷輸入
  if (!S.form && !S.newTrip) renderLayer();
}

// 依出發日排序（沒填就用建立日），新的在前，按年份分段
const tripDate = t => t.startDate || new Date(t.createdAt || 0).toISOString().slice(0, 10);
function renderHome(){
  const trips = [...S.trips].sort((a,b) => tripDate(b).localeCompare(tripDate(a)) || (b.createdAt||0) - (a.createdAt||0));
  let h = "", year = "";
  for (const t of trips){
    const y = tripDate(t).slice(0, 4);
    if (y !== year){ h += `${year ? "</section>" : ""}<section class="stack year"><h2 class="label">${y}</h2>`; year = y; }
    const s = S.summaries[t.id];
    const status = t.settledAt ? `<span class="pill acc">✓ 已結清</span>`
      : !s ? ""
      : !s.count ? `<span class="pill">還沒有花費</span>`
      : !s.transfers ? `<span class="pill acc">已打平</span>`
      : `<span class="pill warn">待結清</span>`;
    const sum = !s ? `<span class="muted">計算中…</span>`
      : `總花費 <span class="num">${money(s.total)}</span>${s.transfers && !t.settledAt ? ` · ${s.transfers} 筆轉帳` : ""}`;
    const m = s?.mine && !t.settledAt && s.count
      ? s.mine.pay ? `<span class="meta you neg">你這組要付 <span class="num">${money(s.mine.pay)}</span></span>`
      : s.mine.get ? `<span class="meta you pos">你這組會收到 <span class="num">${money(s.mine.get)}</span></span>`
      : `<span class="meta you">你這組不用轉帳</span>` : "";
    h += `<button class="tripcard${t.settledAt ? " done" : ""}" data-open="${esc(t.id)}">
      <span class="t">${esc(t.name)}</span>${status}
      <span class="meta">${tripLine(t)}</span><span class="meta">${sum}</span>${m}</button>`;
  }
  return h + "</section>";
}

function renderAdmin(){
  const d = S.allowDraft;
  let h = `<section class="panel stack">
    <p class="muted" style="margin:0">只有名單上的 Google 帳號可以使用這個網站。不在名單上的人登入後什麼都看不到，拿到邀請連結也一樣。</p>
    <div class="row admin-add"><label class="field" style="flex:2 1 220px"><span>Email</span><input type="email" id="a-email" autocomplete="off" value="${esc(d.email)}" placeholder="name@gmail.com"></label>
      <label class="field"><span>備註（選填）</span><input type="text" id="a-note" maxlength="40" value="${esc(d.note)}" placeholder="例如：小華"></label>
      <button class="btn primary" data-act="allow-add">加入</button></div>
    <div class="hint">朋友登入後如果看到「還沒有使用權限」，畫面上會顯示他的 Email，請他複製給你。移除後對方馬上無法使用，但原本記的花費會保留。</div></section>
    <section class="stack"><h2 class="label">已允許 ${S.allow.length} 個帳號（你自己是管理者，不需要在名單上）</h2>`;
  for (const a of S.allow){
    const asking = S.confirm === "allow:" + a.email;
    h += `<div class="allow-row"><div><div class="num">${esc(a.email)}</div><div class="hint">${a.note ? esc(a.note) + " · " : ""}${a.addedAt ? new Date(a.addedAt).toLocaleDateString("zh-TW") + " 加入" : ""}</div></div>
      ${asking ? `<span class="row"><button class="btn danger" data-unallow="${esc(a.email)}">確定移除</button><button class="btn" data-act="cancel-confirm">取消</button></span>`
        : `<button class="btn ghost" data-ask-unallow="${esc(a.email)}">移除</button>`}</div>`;
  }
  return h + `</section>`;
}
function addAllow(){
  const email = S.allowDraft.email.trim().toLowerCase(), note = S.allowDraft.note.trim().slice(0, 40);
  if (!/^[^\s@\/]+@[^\s@\/]+\.[^\s@\/]+$/.test(email)) return toast("請輸入正確的 Email。");
  write(() => setDoc(doc(db, "allow", email), {note, addedAt:Date.now()}), () => {});
  S.allowDraft = {email:"", note:""}; render(); toast(`已加入 ${email}`);
}
function removeAllow(email){
  write(() => writeBatch(db).delete(doc(db, "allow", email)).commit(), () => {});
  S.confirm = null; toast(`已移除 ${email}`);
}

function renderSettle(trip){
  const {rows, total, transfers} = settle(trip, S.expenses);
  let h = `<section class="panel settle" aria-label="結算">
    <div class="settle-head"><div><div class="label">共同花費${trip.settledAt ? ` <span class="pill acc">✓ 已結清</span>` : ""}</div><div class="total num">${money(total)}</div></div>
    <button class="btn" data-act="copy" ${transfers.length ? "" : "disabled"}>複製結算到 LINE</button></div>`;
  if (!S.expenses.length){
    h += `<div class="empty">還沒有花費。按下方「新增花費」，記下誰先墊了多少。</div>`;
  } else if (!transfers.length){
    h += `<div class="empty">大家已經打平，不需要轉帳。</div>`;
  } else {
    h += `<div><div class="label" style="margin-bottom:6px">${trip.settledAt ? "已結清，當時的轉帳如下" : `轉帳 ${transfers.length} 筆就結清`}</div><ul class="transfers">${transfers.map(t =>
      `<li class="transfer${[t.from, t.to].includes(myGroup(trip)) ? " mine" : ""}"><span>${esc(groupName(trip,t.from))}</span><span class="arrow" aria-label="轉給">→</span><span class="to">${esc(groupName(trip,t.to))}</span><span class="amt num">${money(t.amt)}</span></li>`).join("")}</ul></div>`;
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
        ${e.pending ? `<span class="pill warn">等待上傳</span>` : ""}
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
  if (!canEditSettings()) h += `<div class="hint">只有建立這次露營的人可以修改設定。如果組別、人數或出席有錯，請跟他說。</div>`;
  h += `<fieldset class="fs" ${canEditSettings() ? "" : "disabled"}><div class="stack">
    <div class="row"><label class="field" style="flex:2 1 220px"><span>露營名稱</span><input type="text" id="s-name" value="${esc(d.name)}"></label>
    <label class="field"><span>出發日</span><input type="date" id="s-date" value="${esc(d.startDate||"")}"></label>
    <label class="field" style="flex:0 1 110px"><span>天數</span><input type="number" id="s-days" min="1" max="7" value="${d.days}"></label></div>
    <div class="field"><span>這次有開伙的餐次</span><div class="chips">${allMeals.map(m => `<button class="chip" aria-pressed="${d.meals.includes(m)}" data-tmeal="${m}">${esc(mealLabel(d,m))}</button>`).join("")}</div></div>
    <div class="stack"><h3>組別</h3>`;
  for (const g of d.groups){
    h += `<div class="group-row"><label class="field"><span>組名</span><input type="text" id="g-name-${g.id}" data-gname="${g.id}" value="${esc(g.name)}"></label>
      <label class="field"><span>人數</span><input type="number" id="g-ppl-${g.id}" data-gppl="${g.id}" min="0" step="0.5" value="${g.people}"></label>
      <button class="btn ghost" data-gdel="${g.id}" ${d.groups.length<=1?"disabled":""} aria-label="移除 ${esc(g.name)}">移除</button></div>`;
    const names = Object.entries(trip.memberGroups || {}).filter(([u]) => (trip.members || []).includes(u) && myGroup(trip, u) === g.id)
      .map(([u, b]) => u === myId() ? "你" : (b.name || "某位朋友"));
    if (names.length) h += `<div class="hint">已選這組：${names.map(esc).join("、")}</div>`;
  }
  h += `<div><button class="btn" data-act="add-group">＋ 新增一組</button></div>
    <div class="hint">小孩吃得少可以算 0.5 人。</div></div>
    <div class="stack"><h3>各組實際出席</h3><div class="hint">只參加兩天一夜的組，把沒到的餐次和晚上取消勾選，食材和營位就只會算到他們有參加的部分。</div>
    <div class="grid-att"><table><thead><tr><th>組別</th>${d.meals.map(m => `<th class="small">${esc(mealLabel(d,m))}</th>`).join("")}${nightsOf(d).map(n => `<th class="small">第${n}晚</th>`).join("")}</tr></thead><tbody>`;
  for (const g of d.groups){
    h += `<tr><td>${esc(g.name)}</td>${d.meals.map(m => `<td><input type="checkbox" class="cb" id="att-${g.id}-${m}" data-att="${g.id}|m|${m}" ${g.meals.includes(m)?"checked":""} aria-label="${esc(g.name)} ${esc(mealLabel(d,m))}"></td>`).join("")}
      ${nightsOf(d).map(n => `<td><input type="checkbox" class="cb" id="att-${g.id}-n${n}" data-att="${g.id}|n|${n}" ${g.nights.includes(n)?"checked":""} aria-label="${esc(g.name)} 第${n}晚"></td>`).join("")}</tr>`;
  }
  h += `</tbody></table></div></div></div></fieldset>
    <div class="actions">`;
  if (S.mode === "live" && amOwner()) h += S.confirm === "trip"
    ? `<span class="err">刪除後所有花費都會消失。</span><button class="btn danger" data-act="del-trip-yes">確定刪除</button><button class="btn" data-act="cancel-confirm">取消</button>`
    : `<button class="btn ghost" data-act="del-trip">刪除這次露營</button>`;
  h += `<span class="spacer"></span>`;
  if (canEditSettings()) h += `<button class="btn" data-act="reset-setup">還原</button><button class="btn primary" data-act="save-setup">儲存設定</button>`;
  h += `</div></section>`;
  return h;
}

/* ---------- expense form ---------- */
function openForm(e){
  const trip = currentTrip();
  const all = trip.groups.map(g => g.id);
  S.form = e ? JSON.parse(JSON.stringify(e)) : {
    title:"", cat:"food", amount:"", payer: myGroup(trip) || store.get("camp.payer." + trip.id) || trip.groups[0]?.id,
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
// 右上角選單：不常用的功能都收在這裡，主畫面只留記帳和結算
function menuHTML(){
  const trip = currentTrip(), live = S.mode === "live";
  const item = (act, label, extra = "") => `<button class="menu-item" data-act="${act}" ${extra}>${label}</button>`;
  let h = `<div class="overlay" data-act="close-bg"><div class="sheet menu" role="dialog" aria-modal="true" aria-labelledby="m-head">
    <div class="sheet-head"><h2 id="m-head">${S.menu === "install" ? "加到手機主畫面" : "選單"}</h2><button class="btn ghost" data-act="close">關閉</button></div>`;
  if (S.menu === "install"){
    h += `<div class="stack"><p style="margin:0">${isIOS
      ? "請用 Safari 打開這個網頁，點下方的「分享」按鈕，往下找「加入主畫面」。"
      : "請點瀏覽器右上角的選單（⋮），選擇「加到主畫面」或「安裝應用程式」。"}</p>
      <p class="hint" style="margin:0">加入後從主畫面打開，第一次需要再用 Google 登入一次。</p></div>`;
    return h + `</div></div>`;
  }
  if (live) h += `<div class="userchip">${S.user.photoURL ? `<img src="${esc(S.user.photoURL)}" alt="" referrerpolicy="no-referrer">` : ""}${esc(S.user.displayName || S.user.email || "")}</div>`;
  if (trip && trip.groups.length){
    const mg = myGroup(trip);
    h += `<div class="field"><span>你是哪一組</span><div class="chips">${trip.groups.map(g =>
      `<button class="chip" aria-pressed="${g.id === mg}" data-mygroup="${esc(g.id)}">${esc(g.name)}</button>`).join("")}</div></div>`;
  }
  h += `<nav class="menu-list">`;
  if (trip){
    if (live) h += item("invite", "複製邀請連結");
    h += item("export", "匯出 CSV（Excel）", S.expenses.length ? "" : "disabled");
    if (live) h += item("backup", "下載備份");
    if (canEditSettings() && S.expenses.length) h += item("settled", trip.settledAt ? "取消已結清" : "標記已結清");
  } else if (canCreate() && S.view !== "admin"){
    h += `<label class="menu-item filebtn">從備份匯入<input type="file" id="import-file" accept=".json,application/json"></label>`;
  }
  if (canCreate() && S.view !== "admin") h += item("admin", "成員管理");
  if (!standalone) h += item("install", "加到手機主畫面");
  if (S.mode === "demo") h += item("leave-demo", "結束範例");
  if (live) h += item("signout", "登出");
  return h + `</nav></div></div>`;
}
function newTripHTML(){
  const n = S.newTrip, src = S.trips.find(t => t.id === n.from);
  return `<div class="overlay" data-act="close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="n-head">
    <div class="sheet-head"><h2 id="n-head">新增露營</h2><button class="btn ghost" data-act="close">關閉</button></div>
    <div class="stack">
    <label class="field"><span>露營名稱</span><input type="text" id="n-name" maxlength="60" value="${esc(n.name)}" placeholder="例如：宜蘭幸福城"></label>
    <div class="row"><label class="field"><span>出發日</span><input type="date" id="n-date" value="${esc(n.startDate)}"></label>
      <label class="field" style="flex:0 1 110px"><span>天數</span><input type="number" id="n-days" min="1" max="7" value="${n.days}"></label></div>
    ${n.lastId ? `<div class="field"><span>組別</span><div class="chips">
      <button class="chip" aria-pressed="${!!src}" data-from="${esc(n.lastId)}">沿用「${esc(S.trips.find(t => t.id === n.lastId).name)}」</button>
      <button class="chip" aria-pressed="${!src}" data-from="">從頭設定</button></div>
      <div class="hint">${src ? `${src.groups.map(g => `${esc(g.name)} ${+g.people||0} 人`).join("、")}。朋友選過的組別也會沿用，出席的餐次之後再調整。` : "先建立兩組，之後再改組名和人數。"}</div></div>` : ""}
    <div class="actions"><span class="spacer"></span><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="create-trip">建立</button></div>
    </div></div></div>`;
}
function setLayer(h){
  const layer = $("#layer");
  const focusId = document.activeElement?.id;
  const sheetScroll = $(".sheet", layer)?.scrollTop;
  layer.innerHTML = h;
  if (sheetScroll) $(".sheet", layer).scrollTop = sheetScroll;
  if (focusId) document.getElementById(focusId)?.focus();
}
function closeLayer(){ S.form = null; S.menu = null; S.newTrip = null; S.confirm = null; renderLayer(); }
function renderLayer(){
  if (S.menu) return setLayer(menuHTML());
  if (S.newTrip) return setLayer(newTripHTML());
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
  setLayer(h);
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
async function toggleSettled(){
  const trip = currentTrip(), v = trip.settledAt ? null : Date.now();
  const ok = await write(() => updateDoc(doc(db, "trips", trip.id), {settledAt:v}), () => { DEMO.trip.settledAt = v; });
  if (ok) toast(v ? "已標記結清" : "已取消結清");
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
function openNewTrip(){
  // 預設沿用最近一次露營的組別（同一群朋友通常是同樣幾組）
  const last = [...S.trips].sort((a,b) => tripDate(b).localeCompare(tripDate(a)) || (b.createdAt||0) - (a.createdAt||0))[0];
  S.menu = null;
  S.newTrip = {name:"", startDate:"", days:3, from:last?.id || "", lastId:last?.id || ""};
  renderLayer();
  setTimeout(() => $("#n-name")?.focus(), 30);
}
async function newTripAction(){
  const n = S.newTrip, src = S.trips.find(t => t.id === n.from);
  const days = Math.max(1, Math.min(7, Math.round(Number(n.days)) || 3));
  const d = newTrip(n.name.trim() || `${new Date().getMonth()+1} 月露營`, days, n.startDate, src);
  const extra = {};
  if (src?.memberGroups){
    extra.memberGroups = Object.fromEntries(Object.entries(src.memberGroups).filter(([, b]) => d.groups.some(g => g.id === b.g)));
  }
  try {
    const id = await createTrip({...tripSettings(d), ...extra});
    S.newTrip = null; renderLayer();
    S.nextTab = "setup"; openWhenReady(id);
    toast("已建立，確認一下組別和出席");
  } catch(e){ console.error(e); toast(errMsg(e)); }
}
function setMyGroup(gid){
  const trip = currentTrip(), me = myId();
  const v = {g:gid, name:String(S.user?.displayName || "").slice(0, 60)};
  write(() => updateDoc(doc(db, "trips", trip.id), {[`memberGroups.${me}`]: v}),
    () => { DEMO.trip.memberGroups = {...DEMO.trip.memberGroups, [me]: v}; });
}
let installEvent = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; });
async function installApp(){
  if (!installEvent){ S.menu = "install"; renderLayer(); return; }
  closeLayer();
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
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
    // 先回到清單、停止讀取這場的花費，再刪除露營本身
    S.confirm = null; openTrip(null, true);
    const b = writeBatch(db); b.delete(doc(db, "trips", trip.id)); await b.commit();
    toast("已刪除");
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
  const strip = ({id, createdBy, pending, ...rest}) => rest;
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
    openWhenReady(id);
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
  if (a.act === "close-bg"){ if (ev.target === t) closeLayer(); return; }
  if (a.mygroup){ setMyGroup(a.mygroup); return; }
  if (S.newTrip && a.from !== undefined){ S.newTrip.from = a.from; renderLayer(); return; }
  // 選單裡的項目按下後先關掉選單
  if (S.menu && a.act && !["close", "install", "menu"].includes(a.act)){ S.menu = null; renderLayer(); }
  if (a.tab){ S.tab = a.tab; S.confirm = null; render(); return; }
  if (a.edit){ openForm(S.expenses.find(e => e.id === a.edit)); return; }
  if (a.open){ openTrip(a.open); return; }
  if (a.askUnallow){ S.confirm = "allow:" + a.askUnallow; render(); return; }
  if (a.unallow){ removeAllow(a.unallow); return; }
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
    case "close": closeLayer(); break;
    case "menu": S.menu = "main"; renderLayer(); break;
    case "install": installApp(); break;
    case "skip-bind": S.skipBind[S.tripId] = true; render(); break;
    case "create-trip": newTripAction(); break;
    case "save": saveForm(); break;
    case "del": S.confirm = "exp"; renderLayer(); break;
    case "del-yes": deleteExpense(); break;
    case "cancel-confirm": S.confirm = null; S.form ? renderLayer() : render(); break;
    case "demo": startDemo(); break;
    case "leave-demo": leaveDemo(); break;
    case "new-trip": openNewTrip(); break;
    case "home": openTrip(null); break;
    case "admin": openTrip("admin"); break;
    case "allow-add": addAllow(); break;
    case "recheck": location.reload(); break;
    case "copy-email": copyText(S.user?.email || "", "已複製 Email"); break;
    case "settled": toggleSettled(); break;
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
  if (el.id === "a-email"){ S.allowDraft.email = el.value; return; }
  if (el.id === "a-note"){ S.allowDraft.note = el.value; return; }
  if (S.newTrip){
    if (el.id === "n-name"){ S.newTrip.name = el.value; return; }
    if (el.id === "n-date"){ S.newTrip.startDate = el.value; return; }
    if (el.id === "n-days"){ S.newTrip.days = el.value; return; }
  }
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
  if (el.id === "import-file" && el.files[0]){ S.menu = null; renderLayer(); importBackup(el.files[0]); el.value = ""; return; }
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
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && (S.form || S.menu || S.newTrip)) closeLayer();
  if (ev.key === "Enter" && ["a-email", "a-note"].includes(ev.target.id)) addAllow();
});
addEventListener("online", () => { S.offline = false; render(); });
addEventListener("offline", () => { S.offline = true; render(); });
// 把網頁存在手機上，沒網路也能打開
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e => console.error(e));

render();
