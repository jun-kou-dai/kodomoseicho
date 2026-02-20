const functions = require("firebase-functions/v1");
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
 * MP4コンテナに再パッケージ（映像・音声はコピー、画質劣化なし）
 * faststartフラグを付与してストリーミング再生に最適化
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

    // パスからchildIdを抽出（records/{childId}/xxx.mp4）
    const pathParts = filePath.split("/");
    const childId = pathParts.length >= 3 ? pathParts[1] : null;

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

      // 2. ffmpegでMP4に再パッケージ（映像・音声はそのままコピー、画質劣化なし）
      console.log("MP4再パッケージ中（画質劣化なし）...");
      await new Promise((resolve, reject) => {
        ffmpeg(tempInput)
          .outputOptions([
            "-c:v copy",
            "-c:a copy",
            "-movflags +faststart",
          ])
          .on("start", (cmd) => console.log("ffmpeg開始:", cmd))
          .on("progress", (p) => {
            if (p.percent) console.log(`進捗: ${Math.round(p.percent)}%`);
          })
          .on("end", () => {
            console.log("再パッケージ完了");
            resolve();
          })
          .on("error", (err) => {
            console.error("再パッケージエラー:", err);
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

      // 5. Firestoreで該当レコードを検索し、convertedURLを追加
      console.log("Firestore更新中...");
      const encodedPath = encodeURIComponent(filePath);

      // インデックス不要なクエリ（childIdのみで絞り込み）
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
          (p) => p.type === "video" && p.photoURL && p.photoURL.includes(encodedPath)
        );

        if (photoIndex !== -1) {
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
        console.log("該当するFirestoreレコードが見つかりませんでした。");
        console.log("convertedURL:", convertedURL);
      }

      // 6. 一時ファイル削除
      fs.unlinkSync(tempInput);
      fs.unlinkSync(tempOutput);

      console.log("動画変換処理が完了しました:", convertedPath);
      return null;

    } catch (error) {
      console.error("動画変換処理でエラー:", error);
      try { fs.unlinkSync(tempInput); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tempOutput); } catch (e) { /* ignore */ }
      throw error;
    }
  });
