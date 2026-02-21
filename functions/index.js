const { onObjectFinalized } = require("firebase-functions/v2/storage");
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
 * 動画アップロード時に自動でVFR→CFR変換
 *
 * スマホ動画はVFR（可変フレームレート）で保存されるため、
 * HTML5 videoタグで再生すると音ズレが起きる。
 * H.264/CFR(30fps)/AAC/faststartに変換して解消する。
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

  console.log("=== 動画の変換開始 ===", filePath);

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
          "-vsync cfr",
          "-r 30",
          "-crf 18",
          "-preset medium",
          "-profile:v high",
          "-pix_fmt yuv420p",
          "-movflags +faststart",
        ])
        .audioCodec("aac")
        .audioBitrate("192k")
        .audioFilters("aresample=async=1")
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

    // Firestoreのレコードを更新
    const pathParts = filePath.split("/");
    const childId = pathParts.length >= 3 ? pathParts[1] : null;
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
  } finally {
    try { fs.unlinkSync(tempInput); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(tempOutput); } catch (e) { /* ignore */ }
  }
});
