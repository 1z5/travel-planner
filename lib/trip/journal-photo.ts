// 限制的是手记缩略图，原图不进入行程文件或网络。
export const JOURNAL_PHOTO_BYTES = 96 * 1024;
export const JOURNAL_PHOTO_EDGE = 960;

export interface JournalPhoto {
  src: string;
  width: number;
  height: number;
}

function jpegBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob?.type === "image/jpeg" ? resolve(blob) : reject(new Error("无法生成照片预览。")),
      "image/jpeg",
      0.78,
    ),
  );
}

export async function prepareJournalPhoto(file: File): Promise<JournalPhoto> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("请选择 JPG、PNG 或 WebP 照片。");
  if (file.size > 24 * 1024 * 1024) throw new Error("照片超过 24 MB，请选择较小的图片。");
  if (typeof createImageBitmap !== "function")
    throw new Error("当前浏览器无法处理照片，仍可保存文字。");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("无法读取这张照片，请重新选择。");
  });
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器无法生成照片预览。");
    let edge = Math.min(JOURNAL_PHOTO_EDGE, Math.max(bitmap.width, bitmap.height));
    while (edge > 0) {
      const scale = edge / Math.max(bitmap.width, bitmap.height);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await jpegBlob(canvas);
      if (jpeg.size <= JOURNAL_PHOTO_BYTES) {
        const src = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
          reader.addEventListener(
            "error",
            () => reject(new Error("读取预览失败，请重新选择照片。")),
            { once: true },
          );
          reader.readAsDataURL(jpeg);
        });
        return { src, width: canvas.width, height: canvas.height };
      }
      edge = Math.floor(edge * 0.7);
    }
    throw new Error("照片过大，请换一张图片。");
  } finally {
    bitmap.close();
  }
}
