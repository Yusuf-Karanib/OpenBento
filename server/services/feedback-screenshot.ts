const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_DATA_URL_CHARS = 7 * 1024 * 1024;
const PNG_PREFIX = "data:image/png;base64,";
const JPEG_PREFIX = "data:image/jpeg;base64,";

type ScreenshotValidation =
  | { ok: true }
  | { ok: false; error: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function validateFeedbackScreenshot(value: string): ScreenshotValidation {
  if (value.length > MAX_SCREENSHOT_DATA_URL_CHARS) {
    return { ok: false, error: "Screenshot too large. Must be under 5MB." };
  }

  const imageType = value.startsWith(PNG_PREFIX)
    ? "png"
    : value.startsWith(JPEG_PREFIX)
      ? "jpeg"
      : null;
  if (!imageType) {
    return { ok: false, error: "Screenshot must be a PNG or JPEG image." };
  }

  const payload = value.slice(imageType === "png" ? PNG_PREFIX.length : JPEG_PREFIX.length);
  if (!payload || payload.length % 4 !== 0) {
    return { ok: false, error: "Screenshot contains invalid image data." };
  }

  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) {
    return { ok: false, error: "Screenshot contains invalid image data." };
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    return { ok: false, error: "Screenshot too large. Must be under 5MB." };
  }

  const hasExpectedSignature = imageType === "png"
    ? bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    : bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);

  return hasExpectedSignature
    ? { ok: true }
    : { ok: false, error: "Screenshot file does not match its image type." };
}
