import { ref, uploadBytes } from 'firebase/storage';
import { storage } from '../firebase';

const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.82;
/** A file older than this was almost certainly picked from the camera roll. */
const MAX_FILE_AGE_MS = 5 * 60 * 1000;

export interface PreparedPhoto {
  blob: Blob;
  previewUrl: string;
  originalBytes: number;
  bytes: number;
  /** True when the file's own timestamp says it was not taken just now. */
  looksPreExisting: boolean;
}

/**
 * Downscales and re-encodes the captured image.
 *
 * Crews are often on one bar of signal, and a modern phone camera produces
 * 4-8 MB files. 1600 px on the long edge is still plenty to recognise a face,
 * a van, or a site board, and it uploads in a second or two instead of a minute.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new Error('That file is not a photo.');
  }

  const looksPreExisting =
    Number.isFinite(file.lastModified) && Date.now() - file.lastModified > MAX_FILE_AGE_MS;

  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the photo on this device.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('Could not process the photo on this device.');

  return {
    blob,
    previewUrl: URL.createObjectURL(blob),
    originalBytes: file.size,
    bytes: blob.size,
    looksPreExisting,
  };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap applies the EXIF orientation for us; the <img> fallback
  // covers older Safari, where sideways photos are cosmetically wrong but the
  // content — which is all we need — is intact.
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not read that photo.'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Uploads the prepared photo and returns its Storage path.
 *
 * The path is unguessable and single-use: Storage rules forbid overwriting an
 * existing object, and the clock function burns the path so it cannot back a
 * second punch.
 */
export async function uploadPhoto(uid: string, prepared: PreparedPhoto): Promise<string> {
  const token =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  const path = `clock-photos/${uid}/${Date.now()}-${token}.jpg`;

  await uploadBytes(ref(storage, path), prepared.blob, {
    contentType: 'image/jpeg',
    cacheControl: 'private, max-age=0, no-store',
  });

  return path;
}
