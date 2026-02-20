const functions = require("firebase-functions");
const admin = require("firebase-admin");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");

admin.initializeApp();

const storage = admin.storage();
const db = admin.firestore();

// ffmpegのパスを設定
ffmpeg.setFfmpegPath(ffmpegStatic);

/**
 * Firebase Storageに動画がアップロードされたら自動的に
 * H.264 / CFR(30fps) / AAC / faststart に変換する
 */
exports.convertVideo = functions
  .runWith({
    timeoutSeconds: 540,  // 最大9分
    memory: "2GB",
  })
  .storage.object()
  .onFinalize(async (object) => {
    const filePath = object.name;        // records/{childId}/xxx.mp4
    const contentType = object.contentType;
    const bucket = storage.bucket(object.bucket);

    // 動画ファイル以外はスキップ
    if (!contentType || !contentType.startsWith("video/")) {
      console.log("動画ではないのでスキップ:", filePath);
      return null;
    }

    // 変換済みファイル(_web.mp4)はスキップ（無限ループ防止）
    if (filePath.includes("_web.mp4")) {
      console.log("変換済みファイルなのでスキップ:", filePath);
      return null;
    }

    // サムネイル(_thumb.jpg)はスキップ
    if (filePath.includes("_thumb.")) {
      console.log("サムネイルなのでスキップ:", filePath);
      return null;
    }

    console.log("動画変換を開始:", filePath);

    // 一時ファイルパス
    const fileName = path.basename(filePath);
    const fileNameNoExt = path.parse(fileName).name;
    const tempInput = path.join(os.tmpdir(), fileName);
    const tempOutput = path.join(os.tmpdir(), `${fileNameNoExt}_web.mp4`);

    // 変換後のStorageパス
    const dirPath = path.dirname(filePath);
    const convertedPath = `${dirPath}/${fileNameNoExt}_web.mp4`;

    try {
      // 1. 元動画をダウンロード
      console.log("ダウンロード中...");
      await bucket.file(filePath).download({ destination: tempInput });

      // 2. ffmpegで変換 (H.264 / 30fps固定 / AAC / faststart)
      console.log("変換中...");
      await new Promise((resolve, reject) => {
        ffmpeg(tempInput)
          .videoCodec("libx264")
          .outputOptions([
            "-r 30",                      // 固定30fps
            "-profile:v baseline",        // 広い互換性
            "-pix_fmt yuv420p",           // 標準ピクセルフォーマット
            "-movflags +faststart",       // Web再生最適化
            "-preset fast",               // エンコード速度優先
            "-crf 23",                    // 品質（18-28、低いほど高品質）
          ])
          .audioCodec("aac")
          .audioBitrate("128k")
          .on("start", (cmd) => console.log("ffmpeg開始:", cmd))
          .on("progress", (p) => {
            if (p.percent) console.log(`変換進捗: ${Math.round(p.percent)}%`);
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

      // 3. 変換後ファイルをアップロード
      console.log("アップロード中:", convertedPath);
      await bucket.upload(tempOutput, {
        destination: convertedPath,
        metadata: {
          contentType: "video/mp4",
          metadata: {
            originalPath: filePath,
          },
        },
      });

      // 4. 変換後ファイルの公開URLを取得
      const convertedFile = bucket.file(convertedPath);
      await convertedFile.makePublic();
      const convertedURL = `https://storage.googleapis.com/${object.bucket}/${convertedPath}`;

      // 5. 元動画のURLを取得（Firestoreから検索するため）
      const originalFile = bucket.file(filePath);
      const [originalMeta] = await originalFile.getMetadata();
      // Firebase StorageのdownloadURLを組み立て
      const token = originalMeta.metadata && originalMeta.metadata.firebaseStorageDownloadTokens;
      const encodedPath = encodeURIComponent(filePath);
      const originalURL = `https://firebasestorage.googleapis.com/v0/b/${object.bucket}/o/${encodedPath}?alt=media${token ? "&token=" + token : ""}`;

      // 6. Firestoreで該当レコードを検索し、convertedURLを追加
      console.log("Firestore更新中...");
      const recordsSnapshot = await db.collection("records").get();
      let updated = false;

      for (const doc of recordsSnapshot.docs) {
        const data = doc.data();
        if (!data.photos || !Array.isArray(data.photos)) continue;

        const photoIndex = data.photos.findIndex(
          (p) => p.type === "video" && p.photoURL && p.photoURL.includes(encodedPath)
        );

        if (photoIndex !== -1) {
          // photosの該当要素にconvertedURLを追加
          const photos = [...data.photos];
          photos[photoIndex] = {
            ...photos[photoIndex],
            convertedURL: convertedURL,
          };

          await doc.ref.update({ photos });
          console.log(`レコード ${doc.id} を更新しました（photo index: ${photoIndex}）`);
          updated = true;
          break;
        }
      }

      if (!updated) {
        console.log("該当するFirestoreレコードが見つかりませんでした。convertedURLの手動設定が必要です。");
        console.log("convertedURL:", convertedURL);
      }

      // 7. 一時ファイル削除
      fs.unlinkSync(tempInput);
      fs.unlinkSync(tempOutput);

      console.log("動画変換処理が完了しました:", convertedPath);
      return null;

    } catch (error) {
      console.error("動画変換処理でエラー:", error);
      // 一時ファイルのクリーンアップ
      try { fs.unlinkSync(tempInput); } catch (e) {}
      try { fs.unlinkSync(tempOutput); } catch (e) {}
      throw error;
    }
  });
