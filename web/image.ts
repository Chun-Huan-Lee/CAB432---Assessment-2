export type ImagePart = { type: "image"; data: string; mimeType: string };

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function fileToImagePart(file: Blob): Promise<ImagePart> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("Only image files can be attached.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Image is larger than 4 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return { type: "image", data: btoa(binary), mimeType: file.type || "image/png" };
}
