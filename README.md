# 營地分帳本

露營共同花費分帳工具：每組自行記錄墊付，依人數、餐數、晚數或使用比例分攤，算出最少轉帳筆數。

- 網站：GitHub Pages（`index.html`、`app.js`、`split.js`、`style.css`）
- 登入與資料庫：Firebase Auth（Google）＋ Cloud Firestore
- 權限：`firestore.rules`

## 開發

```bash
npm install
npm test                                   # 計算邏輯 + 權限規則（需要 Java，用 Firestore 模擬器）
firebase deploy --only firestore:rules     # 部署權限規則
```
