# Memories アプリ 動画機能追加 — Claude Code引き継ぎ資料

## 作成日: 2026年2月20日
## 状況: 動画アップロードは動作するが、再生時に音ズレ・速度低下が発生し未解決

---

## 1. プロジェクト概要

- **アプリ名**: Memories - 子供の成長記録
- **本番URL**: https://starlit-jelly-84dacb.netlify.app/
- **技術構成**: 単一index.html（約3,400行）+ 外部CSS 4ファイル + Firebase（Firestore, Auth, Storage）
- **Firebase Project**: kids-growth-700b0（Blazeプラン/従量課金）
- **ホスティング**: Netlify（手動デプロイ/ドラッグ&ドロップ）

### ファイル構成
```
デプロイフォルダ/
├── index.html          ← メインファイル（全JS含む）
├── index0209.html      ← 2/9時点のバックアップ
├── css/
│   ├── reset.css
│   ├── variables.css
│   ├── components.css  ← ※ユーザーのローカルフォルダになかった。Netlifyの2/9デプロイから復元済み
│   └── main.css
├── assets/
├── js/
└── 名称未設定フォルダ/
```

### 本番の現在の状態
- **2月9日デプロイ版に戻してある（動画機能なし）**
- 動画機能付きのindex.htmlは作成済みだが本番には反映していない

---

## 2. やったこと（claude.ai上での作業）

### 成功した部分
- ファイル入力の `accept` に動画形式を追加（MP4, MOV, WebM）
- 動画バリデーション（100MB上限）
- `isVideoFile()`, `generateVideoThumbnail()`, `getVideoDuration()` ヘルパー関数の実装
- 動画アップロード処理（プログレス表示付き）
- サムネイルの自動生成（動画の0.5秒目フレーム）とFirebase Storageへの保存
- Firestoreのphotos配列に `type: "video"` / `type: "image"` と `thumbnailURL` フィールドを追加
- タイムラインカードでの動画アイコン（▶）表示
- アルバムグリッド、思い出ふりかえり、編集モーダルの動画対応
- 既存データとの後方互換性（typeフィールドがない場合は画像として扱う）
- **テスト投稿済み**: 2MBの8秒動画を1件アップロード。Firestoreに保存され、サムネイルも正常に表示された

### 未解決の問題
- **詳細モーダルでの動画再生時、映像と音声がずれる・通常より遅い**
- 動画ファイルは2MB/8秒と小さいため、Firebase Storageの帯域問題ではない

### 試した修正（効果なし）
1. `preload="metadata"` → `preload="auto"` に変更 → 効果なし
2. CSS修正: `.photo-gallery` の `position: absolute` / `opacity`トランジション / `aspect-ratio: 4/3` が動画に干渉していると推測し、動画の場合のみ無効化 → 効果なし

---

## 3. 音ズレの原因として調査すべきこと

### 最有力: components.css の `.photo-gallery` スタイル
```css
/* components.css の該当部分 */
.photo-gallery {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;      /* ← 動画の本来のアスペクト比と異なる可能性 */
    overflow: hidden;           /* ← 動画プレーヤーUIが制約される */
    border-radius: var(--radius-md);
    background: var(--border-light);
    margin-bottom: var(--space-4);
}

.photo-gallery img {
    position: absolute;         /* ← これがvideoにも適用される可能性 */
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 0.3s ease;  /* ← 描画負荷 */
}

.photo-gallery img.active {
    opacity: 1;
}
```

CSSの修正だけでは直らなかったため、以下の可能性もある:

### 可能性2: Firebase StorageのURLがRange Requestに対応していない
- ブラウザの`<video>`タグはRange Request（部分ダウンロード）を使ってストリーミングする
- Firebase StorageのURLがこれに完全対応していない場合、全ダウンロード後に再生しようとして音ズレが起きる
- 確認方法: Chrome DevToolsのNetworkタブで動画リクエストのResponse Headerを確認（`Accept-Ranges: bytes` があるか）

### 可能性3: 動画のコーデック/コンテナの問題
- スマホで撮影した動画がHEVC(H.265)の場合、ブラウザでのデコードに負荷がかかる
- 確認方法: アップロードした動画のコーデック情報を確認

### 可能性4: video要素の生成方法
- `document.createElement('video')` で動的に生成し、ギャラリーコンテナ内に追加している
- ギャラリーの画像切り替え（スワイプ）のイベントリスナーが動画にも影響している可能性

---

## 4. 動画再生の実装コード（現状）

### 詳細モーダルでのvideo要素生成
```javascript
if (photo.type === 'video') {
    const video = document.createElement('video');
    video.src = photo.photoURL;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.poster = photo.thumbnailURL || '';
    video.className = index === 0 ? 'active' : '';
    video.style.cssText = 'width:100%;max-height:400px;object-fit:contain;background:#000;border-radius:12px;';
    gallery.appendChild(video);
}
```

### 追加したインラインCSS（index.html内の`<style>`タグ）
```css
#photoGallery video {
    display: none;
    width: 100%;
    max-height: 400px;
    object-fit: contain;
    background: #000;
    border-radius: 12px;
    position: relative;
    opacity: 1;
    transition: none;
}
#photoGallery video.active {
    display: block;
    position: relative;
    opacity: 1;
}
```

---

## 5. Firestoreのデータ構造

### recordsコレクションのphotos配列（動画機能追加後）
```javascript
photos: [
    {
        photoURL: "https://firebasestorage.googleapis.com/...",  // 動画またはリサイズ済み画像のURL
        thumbnailURL: "https://firebasestorage.googleapis.com/...",  // 動画のサムネイル（動画のみ）
        type: "video",  // "video" または "image"（既存データにはこのフィールドなし）
        displayOrder: 0,
        uploadedAt: "2026-02-20T..."
    }
]
```

### 既存データとの互換性
- `type`フィールドがない場合: 全て `photo.type === 'video'` → `undefined === 'video'` → `false` → 画像として扱う
- テスト投稿が1件Firestoreに残っている（2026/2/11 17:07、コメント「俺のおもちゃ」）

---

## 6. Firebase Storage パス
- 画像: `records/{childId}/{timestamp}_{random}.{ext}`
- 動画: `records/{childId}/{timestamp}_{random}.{ext}`（同じパス構造）
- サムネイル: `records/{childId}/{timestamp}_{random}_thumb.jpg`

---

## 7. コスト見積もり（Blazeプラン）
月20本の動画（1分/720p）を想定:
- Storage: 600MB〜1.2GB → ¥2〜5/月
- 家族3人が毎日閲覧: ¥75〜150/月
- **月額合計: 約¥80〜155**

---

## 8. 音ズレの原因（確定）

複数のAI（ChatGPT、Gemini含む）に確認し、全てが同じ原因を指摘：

**スマホ動画のVFR（可変フレームレート）とHEVC（H.265）コーデックが原因。**
- スマホは可変フレームレートで動画を保存する
- HTML5のvideoタグは固定フレームレート（CFR）前提で設計されている
- 結果、音声は進むが映像のデコードが追いつかず音ズレが起きる

### フロントエンドの修正では直らない（検証済み）
以下を試したが全て効果なし：
- CSS: GPU強制（transform: translateZ(0), will-change, backface-visibility）
- CSS: photo-galleryのposition: absolute / opacity / aspect-ratio無効化
- JS: video要素を1つだけ使い回す方式に変更
- JS: preload="auto"への変更

### 根本解決策
**動画をアップロード後にH.264 / CFR(30fps) / AAC / faststartに自動変換する**

方法は2つ：
1. **Firebase Cloud Functions**（推奨）: アップロードをトリガーにffmpegで変換
2. **クライアント側**: FFmpeg.wasmでブラウザ内変換（重い）

## 9. 推奨アプローチ

1. まずローカルでffmpegを使い、テスト動画を手動変換して音ズレが直ることを確認
   ```bash
   ffmpeg -i input.mp4 -c:v libx264 -r 30 -c:a aac -movflags +faststart output_cfr.mp4
   ```
2. 確認できたらFirebase Cloud Functionsで自動変換を実装
3. フロントは変換後のURLを再生する仕組みに変更

---

## 10. 注意事項
- **本番は2月9日版（動画機能なし）に戻してある**
- ユーザーのローカルのcssフォルダにcomponents.cssがなかった（原因不明）。Netlifyの2/9デプロイには存在する。本リポジトリ内に復元済みのcomponents.cssあり
- Netlifyのデプロイ履歴から以前のバージョンに戻せる（Deploys → 該当日 → 公開・展開）
- ユーザーは手動デプロイ（フォルダをドラッグ&ドロップ）
- Firestoreにテスト投稿が1件残っている（2026/2/11 17:07、コメント「俺のおもちゃ」、2MB/8秒の動画）
- **この環境（claude.ai）では動画再生テストができないため、必ずローカルで確認しながら作業すること**
