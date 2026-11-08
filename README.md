# 營地分帳本

露營共同花費分帳工具：每組自行記錄墊付，依人數、餐數、晚數或使用比例分攤，算出最少轉帳筆數。

- 網站：https://camp-split-b3a20.web.app （Firebase Hosting，檔案在 `public/`）
- 登入與資料庫：Firebase Auth（Google）＋ Cloud Firestore
- 權限：`firestore.rules`
- 舊網址 https://stevens48528.github.io/camp-split/ 只剩轉址頁（`docs/`）

登入網域（authDomain）和網站同一個網域，iPhone 等會隔離跨網站資料的瀏覽器才能正常登入。

## 開發

```bash
npm install
npm test                                     # 計算邏輯 + 權限規則（需要 Java，用 Firestore 模擬器）
firebase deploy --only hosting               # 部署網站（只會上傳 public/）
firebase deploy --only firestore:rules       # 部署權限規則
```
