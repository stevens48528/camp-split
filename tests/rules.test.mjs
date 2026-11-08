// 用 Firestore 模擬器測試 firestore.rules：npm test
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, arrayUnion } from "firebase/firestore";

let env;
const TRIP = "trip1";
// 規則白名單裡可以建立露營的 UID
const OWNER = "K9pYZJfk12bjxNbng3OR14mtbs12";
const settings = { name: "宜蘭", days: 3, meals: ["d1-d"], groups: [{ id: "g1", name: "A", people: 2 }] };
const expense = (by, extra = {}) => ({ title: "食材", amount: 500, payer: "g1", mode: "people", createdBy: by, ...extra });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-camp-split",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  // owner 建立露營，member 已加入，outsider 不是成員
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, "trips", TRIP), { ...settings, ownerUid: OWNER, members: [OWNER, "member"], createdAt: 1 });
    await setDoc(doc(db, "trips", TRIP, "expenses", "byOwner"), expense(OWNER));
    await setDoc(doc(db, "trips", TRIP, "expenses", "byMember"), expense("member"));
    // 白名單：member 和 outsider 可以使用；stranger 不在清單上
    for (const u of ["member", "outsider"]) await setDoc(doc(db, "allow", `${u}@test.com`), { note: u, addedAt: 1 });
  });
});
// 每個測試帳號都有已驗證的 Email：<uid>@test.com
const as = (uid, token = {}) => (uid
  ? env.authenticatedContext(uid, { email: `${uid}@test.com`, email_verified: true, ...token })
  : env.unauthenticatedContext()).firestore();

test("未登入的人什麼都讀不到", async () => {
  await assertFails(getDoc(doc(as(null), "trips", TRIP)));
  await assertFails(getDocs(collection(as(null), "trips", TRIP, "expenses")));
});

test("不在白名單的人登入後什麼都讀寫不到，拿到邀請連結也一樣", async () => {
  const db = as("stranger");
  await assertFails(getDoc(doc(db, "trips", TRIP)));
  await assertFails(getDocs(query(collection(db, "trips"), where("members", "array-contains", "stranger"))));
  await assertFails(updateDoc(doc(db, "trips", TRIP), { members: arrayUnion("stranger") }));
  await assertFails(getDocs(collection(db, "trips", TRIP, "expenses")));
});

test("從白名單移除後，原本的成員也會被擋", async () => {
  await assertSucceeds(getDocs(collection(as("member"), "trips", TRIP, "expenses")));
  await env.withSecurityRulesDisabled(ctx => deleteDoc(doc(ctx.firestore(), "allow", "member@test.com")));
  await assertFails(getDocs(collection(as("member"), "trips", TRIP, "expenses")));
  await assertFails(getDoc(doc(as("member"), "trips", TRIP)));
  await assertFails(setDoc(doc(as("member"), "trips", TRIP, "expenses", "x"), expense("member")));
});

test("Email 沒有驗證過，就算在白名單上也不行", async () => {
  await assertFails(getDoc(doc(as("member", { email_verified: false }), "trips", TRIP)));
});

test("白名單：每個人只查得到自己那一筆，只有管理者能看全部和修改", async () => {
  await assertSucceeds(getDoc(doc(as("member"), "allow", "member@test.com")));
  await assertSucceeds(getDoc(doc(as("stranger"), "allow", "stranger@test.com")));
  await assertFails(getDoc(doc(as("stranger"), "allow", "member@test.com")));
  await assertFails(getDoc(doc(as("member"), "allow", "outsider@test.com")));
  await assertFails(getDocs(collection(as("member"), "allow")));
  await assertFails(setDoc(doc(as("stranger"), "allow", "stranger@test.com"), { note: "", addedAt: 1 }));
  await assertFails(deleteDoc(doc(as("member"), "allow", "outsider@test.com")));
  await assertSucceeds(getDocs(collection(as(OWNER), "allow")));
  await assertSucceeds(setDoc(doc(as(OWNER), "allow", "new@test.com"), { note: "新朋友", addedAt: 2 }));
  await assertFails(setDoc(doc(as(OWNER), "allow", "Upper@test.com"), { note: "", addedAt: 2 }));
  await assertFails(setDoc(doc(as(OWNER), "allow", "x@test.com"), { note: "", addedAt: 2, admin: true }));
  await assertSucceeds(deleteDoc(doc(as(OWNER), "allow", "new@test.com")));
});

test("管理者不在白名單上也能使用，不會把自己鎖在外面", async () => {
  await assertSucceeds(getDoc(doc(as(OWNER), "trips", TRIP)));
});

test("登入且有邀請連結的人可以讀到露營本身，但讀不到花費", async () => {
  await assertSucceeds(getDoc(doc(as("outsider"), "trips", TRIP)));
  await assertFails(getDocs(collection(as("outsider"), "trips", TRIP, "expenses")));
  await assertFails(getDoc(doc(as("outsider"), "trips", TRIP, "expenses", "byOwner")));
});

test("清單只查得到自己是成員的露營", async () => {
  await assertSucceeds(getDocs(query(collection(as("member"), "trips"), where("members", "array-contains", "member"))));
  await assertFails(getDocs(collection(as("outsider"), "trips")));
  await assertFails(getDocs(query(collection(as("outsider"), "trips"), where("members", "array-contains", "member"))));
});

test("非成員可以透過邀請把自己加入", async () => {
  await assertSucceeds(updateDoc(doc(as("outsider"), "trips", TRIP), { members: arrayUnion("outsider") }));
  await assertSucceeds(getDocs(collection(as("outsider"), "trips", TRIP, "expenses")));
});

test("非成員不能把別人加入，也不能趁加入時改其他欄位", async () => {
  await assertFails(updateDoc(doc(as("outsider"), "trips", TRIP), { members: arrayUnion("someoneElse") }));
  await assertFails(updateDoc(doc(as("outsider"), "trips", TRIP), { members: arrayUnion("outsider"), name: "改名" }));
  await assertFails(updateDoc(doc(as("outsider"), "trips", TRIP), { members: ["outsider"] }));
});

test("只有建立者可以改設定，而且不能改建立者或成員名單", async () => {
  await assertSucceeds(updateDoc(doc(as(OWNER), "trips", TRIP), { name: "宜蘭幸福城" }));
  await assertFails(updateDoc(doc(as("member"), "trips", TRIP), { name: "改名" }));
  await assertFails(updateDoc(doc(as("member"), "trips", TRIP), { ownerUid: "member" }));
  await assertFails(updateDoc(doc(as(OWNER), "trips", TRIP), { ownerUid: "member" }));
  await assertFails(updateDoc(doc(as(OWNER), "trips", TRIP), { members: [OWNER] }));
});

test("只有建立者可以標記結清", async () => {
  await assertSucceeds(updateDoc(doc(as(OWNER), "trips", TRIP), { settledAt: 1730000000000 }));
  await assertSucceeds(updateDoc(doc(as(OWNER), "trips", TRIP), { settledAt: null }));
  await assertFails(updateDoc(doc(as(OWNER), "trips", TRIP), { settledAt: "yes" }));
  await assertFails(updateDoc(doc(as("member"), "trips", TRIP), { settledAt: 1730000000000 }));
});

test("成員只能選自己是哪一組，不能改別人的", async () => {
  const db = as("member");
  await assertSucceeds(updateDoc(doc(db, "trips", TRIP), { "memberGroups.member": { g: "g1", name: "小華" } }));
  await assertSucceeds(updateDoc(doc(db, "trips", TRIP), { "memberGroups.member": { g: "g2", name: "小華" } }));
  await assertFails(updateDoc(doc(db, "trips", TRIP), { [`memberGroups.${OWNER}`]: { g: "g1", name: "冒名" } }));
  await assertFails(updateDoc(doc(db, "trips", TRIP), { "memberGroups.member": { g: "g1", name: "小華", extra: 1 } }));
  await assertFails(updateDoc(doc(db, "trips", TRIP), { "memberGroups.member": "g1" }));
  await assertFails(updateDoc(doc(db, "trips", TRIP), { "memberGroups.member": { g: "g1", name: "小華" }, name: "改名" }));
  await assertFails(updateDoc(doc(as("outsider"), "trips", TRIP), { "memberGroups.outsider": { g: "g1", name: "路人" } }));
  // 建立者自己選組走的是改設定的權限
  await assertSucceeds(updateDoc(doc(as(OWNER), "trips", TRIP), { [`memberGroups.${OWNER}`]: { g: "g1", name: "我" } }));
});

test("建立露營時可以沿用上次的組別選擇", async () => {
  await assertSucceeds(setDoc(doc(as(OWNER), "trips", "t6"), { ...settings, ownerUid: OWNER, members: [OWNER], createdAt: 3,
    memberGroups: { member: { g: "g1", name: "小華" } } }));
});

test("只有白名單的人可以建立露營，建立者和成員必須是自己", async () => {
  await assertSucceeds(setDoc(doc(as(OWNER), "trips", "t2"), { ...settings, ownerUid: OWNER, members: [OWNER], createdAt: 2 }));
  await assertFails(setDoc(doc(as("member"), "trips", "t3"), { ...settings, ownerUid: "member", members: ["member"], createdAt: 2 }));
  await assertFails(setDoc(doc(as(OWNER), "trips", "t4"), { ...settings, ownerUid: OWNER, members: [OWNER, "member"], createdAt: 2 }));
  await assertFails(setDoc(doc(as("member"), "trips", "t5"), { ...settings, ownerUid: OWNER, members: [OWNER], createdAt: 2 }));
});

test("成員新增花費時，記錄者必須是自己", async () => {
  const db = as("member");
  await assertSucceeds(setDoc(doc(db, "trips", TRIP, "expenses", "new1"), expense("member")));
  await assertFails(setDoc(doc(db, "trips", TRIP, "expenses", "new2"), expense(OWNER)));
  await assertFails(setDoc(doc(as("outsider"), "trips", TRIP, "expenses", "new3"), expense("outsider")));
});

test("花費金額和名稱要合理", async () => {
  const db = as("member");
  await assertFails(setDoc(doc(db, "trips", TRIP, "expenses", "bad1"), expense("member", { amount: -5 })));
  await assertFails(setDoc(doc(db, "trips", TRIP, "expenses", "bad2"), expense("member", { amount: "500" })));
  await assertFails(setDoc(doc(db, "trips", TRIP, "expenses", "bad3"), expense("member", { title: "" })));
});

test("成員只能改或刪自己記的花費", async () => {
  const db = as("member");
  await assertSucceeds(updateDoc(doc(db, "trips", TRIP, "expenses", "byMember"), { amount: 600 }));
  await assertFails(updateDoc(doc(db, "trips", TRIP, "expenses", "byOwner"), { amount: 600 }));
  await assertFails(deleteDoc(doc(db, "trips", TRIP, "expenses", "byOwner")));
  await assertSucceeds(deleteDoc(doc(db, "trips", TRIP, "expenses", "byMember")));
});

test("不能把花費的記錄者改成別人", async () => {
  await assertFails(updateDoc(doc(as("member"), "trips", TRIP, "expenses", "byMember"), { createdBy: OWNER }));
  await assertFails(updateDoc(doc(as(OWNER), "trips", TRIP, "expenses", "byMember"), { createdBy: OWNER }));
});

test("建立者可以修改和刪除任何人的花費", async () => {
  const db = as(OWNER);
  await assertSucceeds(updateDoc(doc(db, "trips", TRIP, "expenses", "byMember"), { amount: 700 }));
  await assertSucceeds(deleteDoc(doc(db, "trips", TRIP, "expenses", "byMember")));
});

test("只有建立者可以刪除露營", async () => {
  await assertFails(deleteDoc(doc(as("member"), "trips", TRIP)));
  await assertFails(deleteDoc(doc(as("outsider"), "trips", TRIP)));
  await assertSucceeds(deleteDoc(doc(as(OWNER), "trips", TRIP)));
});
