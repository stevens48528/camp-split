// 分攤與結算的計算邏輯，不依賴畫面或資料庫，方便測試

export const SLOTS = [["b","早"],["l","午"],["d","晚"]];
// modes: 這個類別可以選的分攤方式，第一個是預設
export const CATS = [
  {id:"site", label:"營位", modes:["nights","group","people","custom"], unit:"group"},
  {id:"food", label:"食材", modes:["meals","people","group","custom"]},
  {id:"drink", label:"飲料酒水", modes:["people","group","custom"]},
  {id:"gear", label:"裝備租借", modes:["group","nights","people","custom"], unit:"group"},
  {id:"travel", label:"交通", modes:["people","group","custom"]},
  {id:"other", label:"其他", modes:["people","meals","nights","group","custom"]},
];
export const catOf = id => CATS.find(c => c.id === id) || CATS[CATS.length - 1];
export const MODES = {
  people:{label:"依人數", hint:"按各組人數比例分攤。"},
  meals:{label:"依餐數", hint:"人數 × 有參加的餐數。只有到部分餐次的組，只分攤自己吃到的。"},
  nights:{label:"依晚數", hint:"按住宿晚數分攤，可選擇以「組」或「人」為單位。"},
  group:{label:"每組平均", hint:"參與的組別各付一樣多。"},
  custom:{label:"自訂金額", hint:"自己算好每組要付多少，直接填入。"},
};
export const PCTS = [100, 75, 50, 25];

export const money = n => "$" + Math.round(n).toLocaleString("zh-TW");

export function mealIds(days){
  const out = [];
  for (let d = 1; d <= days; d++) for (const [k] of SLOTS) out.push(`d${d}-${k}`);
  return out;
}
export function defaultMeals(days){
  // 第一天從午餐開始，最後一天吃到午餐
  return mealIds(days).filter(id => !(id === "d1-b") && !(id === `d${days}-d`));
}
export function dayLabel(trip, d){
  if (!trip.startDate) return `第${d}天`;
  const dt = new Date(trip.startDate + "T00:00:00");
  dt.setDate(dt.getDate() + d - 1);
  return `${dt.getMonth()+1}/${dt.getDate()}(${"日一二三四五六"[dt.getDay()]})`;
}
export function mealLabel(trip, id){
  const [, d, k] = id.match(/^d(\d+)-(\w)$/) || [];
  const slot = (SLOTS.find(s => s[0] === k) || [,"?"])[1];
  return `${dayLabel(trip, +d)}${slot}`;
}
export function nightsOf(trip){ return Array.from({length: Math.max(0, trip.days - 1)}, (_, i) => i + 1); }

export function sharedAmount(e){ return (Number(e.amount) || 0) * (Number(e.pct ?? 100) / 100); }
export function weightsFor(e, trip){
  const gs = trip.groups.filter(g => (e.groups || []).includes(g.id));
  const w = {};
  for (const g of gs){
    const p = Number(g.people) || 0;
    if (e.mode === "people") w[g.id] = p;
    else if (e.mode === "group") w[g.id] = 1;
    else if (e.mode === "meals") w[g.id] = p * (e.meals || []).filter(m => (g.meals || []).includes(m)).length;
    else if (e.mode === "nights") w[g.id] = (e.unit === "person" ? p : 1) * (g.nights || []).filter(n => n < trip.days).length;
  }
  return w;
}
export function sharesFor(e, trip){
  if (e.mode === "custom"){
    const out = {};
    for (const [gid, v] of Object.entries(e.custom || {})) if (Number(v)) out[gid] = Number(v);
    return out;
  }
  const w = weightsFor(e, trip), sum = Object.values(w).reduce((a,b) => a+b, 0);
  const amt = sharedAmount(e), out = {};
  if (sum <= 0) return out;
  for (const [gid, x] of Object.entries(w)) if (x > 0) out[gid] = amt * x / sum;
  return out;
}
export function settle(trip, expenses){
  const rows = {};
  for (const g of trip.groups) rows[g.id] = {paid:0, owe:0};
  let total = 0;
  for (const e of expenses){
    const sh = sharesFor(e, trip);
    const sum = Object.values(sh).reduce((a,b) => a+b, 0);
    total += sum;
    if (rows[e.payer]) rows[e.payer].paid += sum;
    for (const [gid, v] of Object.entries(sh)) if (rows[gid]) rows[gid].owe += v;
  }
  // 結算到整數元：先四捨五入每組差額，再把誤差補給絕對值最大的那組
  const bal = trip.groups.map(g => ({id:g.id, b: Math.round(rows[g.id].paid - rows[g.id].owe)}));
  const drift = bal.reduce((a, x) => a + x.b, 0);
  if (drift && bal.length){ [...bal].sort((a,b) => Math.abs(b.b) - Math.abs(a.b))[0].b -= drift; }
  const cred = bal.filter(x => x.b > 0).map(x => ({...x})).sort((a,b) => b.b - a.b);
  const debt = bal.filter(x => x.b < 0).map(x => ({id:x.id, b:-x.b})).sort((a,b) => b.b - a.b);
  const transfers = [];
  while (cred.length && debt.length){
    const c = cred[0], d = debt[0], amt = Math.min(c.b, d.b);
    if (amt > 0) transfers.push({from:d.id, to:c.id, amt});
    c.b -= amt; d.b -= amt;
    if (!c.b) cred.shift(); if (!d.b) debt.shift();
    cred.sort((a,b) => b.b - a.b); debt.sort((a,b) => b.b - a.b);
  }
  return {rows, total, transfers};
}
export function describe(e){
  if (e.mode === "nights") return `依晚數（每${e.unit === "person" ? "人" : "組"}）`;
  if (e.mode === "meals") return `依餐數 · ${(e.meals||[]).length} 餐`;
  return (MODES[e.mode] || MODES.people).label;
}
