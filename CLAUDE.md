# プロジェクト概要

子供の成長記録アプリ「Memories」。写真・動画・コメントを投稿し、タイムライン・アルバム・メモリーズで閲覧できる。

## 技術構成

- フロントエンド: deploy/index.html（単一HTMLファイル + CSS）
- バックエンド: functions/index.js（Firebase Cloud Functions）
- DB/Storage: Firebase Firestore + Cloud Storage
- ホスティング: Netlify（フロントエンド）、Firebase（Cloud Functions）

## ファイル構成

```
deploy/
  index.html          ... フロントエンド全体（HTML + JS）
  css/
    variables.css     ... CSS変数（カラー、サイズ等）
    components.css    ... 共通コンポーネント
    main.css          ... メインスタイル
    reset.css         ... リセットCSS
functions/
  index.js            ... Cloud Functions（動画変換処理）
  package.json        ... 依存関係
```

## デプロイ構成（重要）

| 対象 | 方法 | 反映タイミング |
|---|---|---|
| フロントエンド（deploy/） | Netlify | mainブランチにマージすると自動デプロイ |
| Cloud Functions（functions/） | Firebase | `firebase deploy --only functions` を手動実行が必要 |

本番URL: https://starlit-jelly-84dacb.netlify.app/
Firebase Project: kids-growth-700b0（Blazeプラン）

## 動画機能の仕組み

1. ユーザーがスマホ動画をアップロード
2. Cloud Functions（convertVideo）が自動トリガー
3. ffmpegでVFR→CFR変換（音ズレ解消）+ H.264再エンコード
4. 変換済み動画URLをFirestoreに保存（convertedURL）
5. フロントエンドは convertedURL || photoURL で再生

スマホ動画はVFR（可変フレームレート）なのでHTML5 videoタグで音ズレする。
CFR（固定30fps）に変換することで解消している。

## 現在のffmpeg設定（functions/index.js）

- CRF 18（ほぼロスレス画質）
- preset medium
- CFR 30fps
- profile:v high
- aresample=async=1（音声同期）

CRF値を上げると画質が落ちる。18より大きくしないこと。

## Git運用

- mainに直接pushできない
- claude/ で始まるブランチで作業してPRを出す
- フロントエンドはmainマージで自動デプロイ
- Cloud Functionsの変更はユーザーが手動で firebase deploy する必要がある

## 注意事項

- この環境からfirebase CLIの認証はできない。Cloud Functionsの変更をした場合、ユーザーに `cd functions && npm install && cd .. && firebase deploy --only functions` の実行を依頼すること
- deploy/index.html は巨大な単一ファイル（3000行超）。変更時は行番号を確認してから編集すること
- CSS変数は deploy/css/variables.css に定義されている。新しいCSS変数を使う場合は必ずここに定義を追加すること
