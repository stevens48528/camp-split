// 分攤與結算邏輯的測試
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharesFor, settle, defaultMeals } from "../public/split.js";

const meals = defaultMeals(3);
const trip = { days: 3, meals, groups: [
  { id: "a", people: 4, meals: [...meals], nights: [1, 2] },
  { id: "b", people: 2, meals: [...meals], nights: [1, 2] },
  { id: "c", people: 3, meals: ["d1-l", "d1-d", "d2-b"], nights: [1] },
]};
const all = ["a", "b", "c"];

test("依人數", () => {
  const s = sharesFor({ amount: 900, mode: "people", groups: all }, trip);
  assert.deepEqual(s, { a: 400, b: 200, c: 300 });
});

test("依餐數：只參加部分餐次的組只分攤吃到的", () => {
  // a: 4×7=28, b: 2×7=14, c: 3×3=9，共 51
  const s = sharesFor({ amount: 5100, mode: "meals", groups: all, meals }, trip);
  assert.equal(Math.round(s.a), 2800);
  assert.equal(Math.round(s.b), 1400);
  assert.equal(Math.round(s.c), 900);
});

test("依晚數（每組）：只住一晚的組付一半", () => {
  const s = sharesFor({ amount: 5000, mode: "nights", unit: "group", groups: all }, trip);
  assert.deepEqual(s, { a: 2000, b: 2000, c: 1000 });
});

test("使用比例：半包米只分攤一半", () => {
  const s = sharesFor({ amount: 400, pct: 50, mode: "group", groups: ["a", "b"] }, trip);
  assert.deepEqual(s, { a: 100, b: 100 });
});

test("結算：總收付相等，轉帳筆數最少", () => {
  const r = settle(trip, [
    { amount: 900, mode: "people", groups: all, payer: "a" },
    { amount: 300, mode: "group", groups: all, payer: "b" },
  ]);
  const net = {};
  for (const t of r.transfers) { net[t.from] = (net[t.from] || 0) - t.amt; net[t.to] = (net[t.to] || 0) + t.amt; }
  for (const g of trip.groups) assert.equal(net[g.id] || 0, Math.round(r.rows[g.id].paid - r.rows[g.id].owe));
  assert.ok(r.transfers.length <= trip.groups.length - 1);
});

test("四組、部分組別缺席的實際案例：轉帳結果正確", () => {
  const m = ["d1-d","d2-b","d2-l","d2-d","d3-b"];
  const t = { days: 3, meals: m, groups: [
    { id: "y", people: 3, meals: m, nights: [1, 2] }, { id: "f", people: 2, meals: m, nights: [1, 2] },
    { id: "d", people: 1, meals: m, nights: [1, 2] }, { id: "x", people: 2, meals: ["d2-d","d3-b"], nights: [2] },
  ]};
  const r = settle(t, [
    { amount: 8400, mode: "custom", custom: { y: 2880, f: 2880, d: 1440, x: 1200 }, payer: "y" },
    { amount: 253, mode: "people", groups: ["y","f","d"], payer: "y" },
    { amount: 400, mode: "people", groups: ["y","f","d"], payer: "y" },
    { amount: 1140, mode: "people", groups: ["y","f","d","x"], payer: "y" },
    { amount: 920, mode: "people", groups: ["y","f","d","x"], payer: "y" },
  ]);
  assert.deepEqual(r.transfers, [
    { from: "f", to: "y", amt: 3613 }, { from: "d", to: "y", amt: 1806 }, { from: "x", to: "y", amt: 1715 },
  ]);
});

test("不抵銷的兩兩互付：合計和抵銷後的差額一致", async () => {
  const { pairwise } = await import("../public/split.js");
  const exps = [
    { id: "1", amount: 900, mode: "people", groups: all, payer: "a" },
    { id: "2", amount: 600, mode: "group", groups: all, payer: "b" },
    { id: "3", amount: 300, mode: "group", groups: ["a", "c"], payer: "c" },
  ];
  const { bal } = settle(trip, exps);
  const pw = pairwise(trip, exps);
  // 每組的兩兩淨額加總要等於這組的差額
  for (const g of trip.groups){
    const net = pw.reduce((s, t) => s + (t.to === g.id ? t.amt : t.from === g.id ? -t.amt : 0), 0);
    assert.equal(net, bal[g.id]);
  }
  // b 欠 a 200（第 1 筆），a 欠 b 200（第 2 筆）→ 互抵為 0，不會出現
  assert.ok(!pw.some(t => [t.from, t.to].sort().join() === "a,b"));
});
