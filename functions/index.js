const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");

admin.initializeApp();

const storage = admin.storage();
const db = admin.firestore();

// ffmpegのパスを設定
ffmpeg.setFfmpegPath(ffmpegStatic);

/**
 * 動画をVFR→CFR変換する共通処理
 * @param {Object} bucket - Storage bucket
 * @param {string} filePath - 元動画のStorageパス
 * @returns {{ convertedPath: string, convertedURL: string }}
 */
async function convertVideoFile(bucket, filePath) {
  const fileName = path.basename(filePath);
  const fileNameNoExt = path.parse(fileName).name;
  const uid = Date.now();
  const tempInput = path.join(os.tmpdir(), `in_${uid}_${fileName}`);
  const tempOutput = path.join(os.tmpdir(), `out_${uid}_${fileNameNoExt}_web.mp4`);

  const dirPath = path.dirname(filePath);
  const convertedPath = `${dirPath}/${fileNameNoExt}_web.mp4`;

  try {
    // 1. ダウンロード
    console.log("ダウンロード中:", filePath);
    await bucket.file(filePath).download({ destination: tempInput });

    // 2. ffmpegでVFR→CFR変換（高画質）
    console.log("VFR→CFR変換中...");
    await new Promise((resolve, reject) => {
      ffmpeg(tempInput)
        .videoCodec("libx264")
        .outputOptions([
          "-crf 18",              // ほぼ視覚的にロスレス
          "-preset medium",       // 品質とエンコード速度のバランス
          "-r 30",                // CFR 30fps（VFR→CFR変換で音ズレ解消）
          "-profile:v high",      // high profile（高画質）
          "-pix_fmt yuv420p",     // ブラウザ互換性
          "-movflags +faststart", // ストリーミング最適化
        ])
        .audioCodec("aac")
        .audioBitrate("192k")
        .on("start", (cmd) => console.log("ffmpeg:", cmd))
        .on("progress", (p) => {
          if (p.percent) console.log(`進捗: ${Math.round(p.percent)}%`);
        })
        .on("end", () => {
          console.log("変換完了");
          resolve();
        })
        .on("error", (err) => {
          console.error("変換エラー:", err);
          reject(err);
        })
        .save(tempOutput);
    });

    // 3. Firebase Storage用のダウンロードトークンを生成
    const downloadToken = crypto.randomUUID();

    // 4. アップロード（トークン付きメタデータ）
    console.log("アップロード中:", convertedPath);
    await bucket.upload(tempOutput, {
      destination: convertedPath,
      metadata: {
        contentType: "video/mp4",
        metadata: {
          originalPath: filePath,
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });

    // 5. Firebase Storage URL を生成（GCS公開URLではなく、トークン付きURL）
    const bucketName = bucket.name;
    const encodedPath = encodeURIComponent(convertedPath);
    const convertedURL = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${downloadToken}`;

    console.log("変換済みURL:", convertedURL);
    return { convertedPath, convertedURL };

  } finally {
    try { fs.unlinkSync(tempInput); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(tempOutput); } catch (e) { /* ignore */ }
  }
}

/**
 * Firebase Storageに動画がアップロードされたら自動的に
 * VFR→CFR変換（音ズレ解消）+ 高画質再エンコード
 */
exports.convertVideo = functions
  .runWith({
    timeoutSeconds: 540,
    memory: "2GB",
  })
  .storage.object()
  .onFinalize(async (object) => {
    const filePath = object.name;
    const contentType = object.contentType;
    const bucket = storage.bucket(object.bucket);

    // 動画ファイル以外はスキップ
    if (!contentType || !contentType.startsWith("video/")) {
      return null;
    }
    // 変換済みファイル(_web.mp4)はスキップ（無限ループ防止）
    if (filePath.includes("_web.mp4")) {
      return null;
    }
    // サムネイルはスキップ
    if (filePath.includes("_thumb.")) {
      return null;
    }

    console.log("=== 新規動画の変換開始 ===", filePath);

    // パスからchildIdを抽出（records/{childId}/xxx.mp4）
    const pathParts = filePath.split("/");
    const childId = pathParts.length >= 3 ? pathParts[1] : null;

    try {
      const { convertedURL } = await convertVideoFile(bucket, filePath);

      // Firestoreで該当レコードを検索し、convertedURLを追加
      console.log("Firestore更新中...");
      const encodedOrigPath = encodeURIComponent(filePath);

      let recordsSnapshot;
      if (childId) {
        recordsSnapshot = await db.collection("records")
          .where("childId", "==", childId)
          .limit(100)
          .get();
      } else {
        recordsSnapshot = await db.collection("records")
          .limit(200)
          .get();
      }

      let updated = false;
      for (const doc of recordsSnapshot.docs) {
        const data = doc.data();
        if (!data.photos || !Array.isArray(data.photos)) continue;

        const photoIndex = data.photos.findIndex(
          (p) => p.type === "video" && p.photoURL && p.photoURL.includes(encodedOrigPath)
        );

        if (photoIndex !== -1) {
          const photos = [...data.photos];
          photos[photoIndex] = {
            ...photos[photoIndex],
            convertedURL: convertedURL,
          };
          await doc.ref.update({ photos });
          console.log(`レコード ${doc.id} を更新（photo index: ${photoIndex}）`);
          updated = true;
          break;
        }
      }

      if (!updated) {
        console.log("Firestoreレコードが見つからず:", convertedURL);
      }

      console.log("=== 動画変換完了 ===");
      return null;

    } catch (error) {
      console.error("動画変換でエラー:", error);
      throw error;
    }
  });

/**
 * 既存の動画をすべて再変換するHTTP関数
 * ブラウザから GET /reprocessVideos で呼び出す
 */
exports.reprocessVideos = functions
  .runWith({
    timeoutSeconds: 540,
    memory: "2GB",
  })
  .https.onRequest(async (req, res) => {
    // CORS対応
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).send("");
      return;
    }

    console.log("=== 既存動画の再変換開始 ===");

    const bucket = storage.bucket();
    const results = [];

    try {
      // 全レコードから動画を探す
      const snapshot = await db.collection("records").get();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (!data.photos || !Array.isArray(data.photos)) continue;
        if (data.isDeleted) continue;

        for (let i = 0; i < data.photos.length; i++) {
          const photo = data.photos[i];
          if (photo.type !== "video" || !photo.photoURL) continue;

          console.log(`レコード ${doc.id} の動画を再変換中...`);

          try {
            // 元動画のStorageパスを取得
            const match = photo.photoURL.match(/\/o\/([^?]+)/);
            if (!match) {
              results.push({ docId: doc.id, status: "skip", reason: "URL解析失敗" });
              continue;
            }
            const originalPath = decodeURIComponent(match[1]);

            // 元動画が存在するか確認
            const [exists] = await bucket.file(originalPath).exists();
            if (!exists) {
              results.push({ docId: doc.id, status: "skip", reason: "元動画なし" });
              continue;
            }

            // 古い_web.mp4を削除（あれば）
            const ext = path.extname(originalPath);
            const basePath = originalPath.substring(0, originalPath.length - ext.length);
            const oldWebPath = basePath + "_web.mp4";
            try {
              await bucket.file(oldWebPath).delete();
              console.log("古い変換ファイルを削除:", oldWebPath);
            } catch (e) {
              // ファイルがなくてもOK
            }

            // 再変換
            const { convertedURL } = await convertVideoFile(bucket, originalPath);

            // Firestore更新
            const photos = [...data.photos];
            photos[i] = { ...photos[i], convertedURL };
            await doc.ref.update({ photos });

            results.push({ docId: doc.id, status: "ok", convertedURL });
            console.log(`レコード ${doc.id} の再変換完了`);

          } catch (err) {
            console.error(`レコード ${doc.id} の再変換失敗:`, err.message);
            results.push({ docId: doc.id, status: "error", error: err.message });
          }
        }
      }

      console.log("=== 再変換完了 ===", JSON.stringify(results));

      res.json({
        message: "再変換完了",
        results,
      });

    } catch (error) {
      console.error("再変換処理でエラー:", error);
      res.status(500).json({ error: error.message });
    }
  });
