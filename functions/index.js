const { onObjectFinalized } = require("firebase-functions/v2/storage");
const functions = require("firebase-functions");
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

ffmpeg.setFfmpegPath(ffmpegStatic);

/**
 * 動画をVFR→CFR変換する共通処理
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
    console.log("ダウンロード中:", filePath);
    await bucket.file(filePath).download({ destination: tempInput });

    console.log("VFR→CFR変換中...");
    await new Promise((resolve, reject) => {
      ffmpeg(tempInput)
        .videoCodec("libx264")
        .outputOptions([
          "-crf 18",
          "-preset medium",
          "-r 30",
          "-profile:v high",
          "-pix_fmt yuv420p",
          "-movflags +faststart",
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

    const downloadToken = crypto.randomUUID();

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
 * 動画アップロード時に自動でVFR→CFR変換 (Gen 2)
 */
exports.convertVideo = onObjectFinalized({
  timeoutSeconds: 540,
  memory: "2GiB",
}, async (event) => {
  const filePath = event.data.name;
  const contentType = event.data.contentType;
  const bucket = storage.bucket(event.data.bucket);

  if (!contentType || !contentType.startsWith("video/")) return;
  if (filePath.includes("_web.mp4")) return;
  if (filePath.includes("_thumb.")) return;

  console.log("=== 新規動画の変換開始 ===", filePath);

  const pathParts = filePath.split("/");
  const childId = pathParts.length >= 3 ? pathParts[1] : null;

  const { convertedURL } = await convertVideoFile(bucket, filePath);

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

  for (const doc of recordsSnapshot.docs) {
    const data = doc.data();
    if (!data.photos || !Array.isArray(data.photos)) continue;

    const photoIndex = data.photos.findIndex(
      (p) => p.type === "video" && p.photoURL && p.photoURL.includes(encodedOrigPath)
    );

    if (photoIndex !== -1) {
      const photos = [...data.photos];
      photos[photoIndex] = { ...photos[photoIndex], convertedURL };
      await doc.ref.update({ photos });
      console.log(`レコード ${doc.id} を更新`);
      break;
    }
  }
});

/**
 * 既存動画の再変換をトリガーするHTTP関数 (Gen 1 = 認証不要)
 *
 * ファイルを上書きコピーすることでconvertVideo(Gen 2)を自動トリガーする。
 * この関数自体はffmpegを使わないため軽量。
 */
exports.reprocessVideos = functions
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    console.log("=== 既存動画の再変換トリガー開始 ===");

    const bucket = storage.bucket();
    const results = [];

    const snapshot = await db.collection("records").get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!data.photos || !Array.isArray(data.photos)) continue;
      if (data.isDeleted) continue;

      for (const photo of data.photos) {
        if (photo.type !== "video" || !photo.photoURL) continue;
        if (photo.convertedURL) {
          results.push({ docId: doc.id, status: "skip", reason: "変換済み" });
          continue;
        }

        try {
          const match = photo.photoURL.match(/\/o\/([^?]+)/);
          if (!match) {
            results.push({ docId: doc.id, status: "skip", reason: "URL解析失敗" });
            continue;
          }
          const originalPath = decodeURIComponent(match[1]);

          const [exists] = await bucket.file(originalPath).exists();
          if (!exists) {
            results.push({ docId: doc.id, status: "skip", reason: "元動画なし" });
            continue;
          }

          // ファイルを自分自身にコピー（上書き）→ onObjectFinalized発火 → convertVideo実行
          await bucket.file(originalPath).copy(originalPath);
          results.push({ docId: doc.id, path: originalPath, status: "triggered" });
          console.log(`トリガー済み: ${originalPath}`);
        } catch (err) {
          results.push({ docId: doc.id, status: "error", error: err.message });
        }
      }
    }

    const triggered = results.filter((r) => r.status === "triggered").length;
    res.json({
      message: `${triggered}件の動画の再変換をトリガーしました。変換はバックグラウンドで実行されます。`,
      results,
    });
  });
