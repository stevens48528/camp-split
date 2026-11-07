// 用 Firestore 模擬器測試 firestore.rules：npm test
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, arrayUnion } from "firebase/firestore";

let env;
const TRIP = "trip1";
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
    await setDoc(doc(db, "trips", TRIP), { ...settings, ownerUid: "owner", members: ["owner", "member"], createdAt: 1 });
    await setDoc(doc(db, "trips", TRIP, "expenses", "byOwner"), expense("owner"));
    await setDoc(doc(db, "trips", TRIP, "expenses", "byMember"), expense("member"));
  });
});
const as = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

test("未登入的人什麼都讀不到", async () => {
  await assertFails(getDoc(doc(as(null), "trips", TRIP)));
  await assertFails(getDocs(collection(as(null), "trips", TRIP, "expenses")));
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

test("成員可以改設定，但不能改建立者或成員名單", async () => {
  await assertSucceeds(updateDoc(doc(as("member"), "trips", TRIP), { name: "宜蘭幸福城" }));
  await assertFails(updateDoc(doc(as("member"), "trips", TRIP), { ownerUid: "member" }));
  await assertFails(updateDoc(doc(as("member"), "trips", TRIP), { members: ["member"] }));
});

test("建立露營時建立者和成員必須是自己", async () => {
  const db = as("member");
  await assertSucceeds(setDoc(doc(db, "trips", "t2"), { ...settings, ownerUid: "member", members: ["member"], createdAt: 2 }));
  await assertFails(setDoc(doc(db, "trips", "t3"), { ...settings, ownerUid: "owner", members: ["member"], createdAt: 2 }));
  await assertFails(setDoc(doc(db, "trips", "t4"), { ...settings, ownerUid: "member", members: ["member", "outsider"], createdAt: 2 }));
});

test("成員新增花費時，記錄者必須是自己", async () => {
  const db = as("member");
  await assertSucceeds(setDoc(doc(db, "trips", TRIP, "expenses", "new1"), expense("member")));
  await assertFails(setDoc(doc(db, "trips", TRIP, "expenses", "new2"), expense("owner")));
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
  await assertFails(updateDoc(doc(as("member"), "trips", TRIP, "expenses", "byMember"), { createdBy: "owner" }));
  await assertFails(updateDoc(doc(as("owner"), "trips", TRIP, "expenses", "byMember"), { createdBy: "owner" }));
});

test("建立者可以修改和刪除任何人的花費", async () => {
  const db = as("owner");
  await assertSucceeds(updateDoc(doc(db, "trips", TRIP, "expenses", "byMember"), { amount: 700 }));
  await assertSucceeds(deleteDoc(doc(db, "trips", TRIP, "expenses", "byMember")));
});

test("只有建立者可以刪除露營", async () => {
  await assertFails(deleteDoc(doc(as("member"), "trips", TRIP)));
  await assertFails(deleteDoc(doc(as("outsider"), "trips", TRIP)));
  await assertSucceeds(deleteDoc(doc(as("owner"), "trips", TRIP)));
});
