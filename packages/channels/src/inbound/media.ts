import sharp from "sharp";

/** Pi's maximum accepted inline image size. Fitting is strict (<), not <=. */
export const MAX_IMAGE_BYTES = 1_000_000;

export interface SharpEncodeRequest {
  quality: number;
  longestEdge: number;
}

export interface SharpEncodeResult {
  data: Buffer;
  info: { size: number };
}

export interface SharpAdapter {
  encode(input: Buffer, request: SharpEncodeRequest): Promise<SharpEncodeResult>;
}

/** Default Sharp adapter: auto-orient before aspect-preserving resize/encode. */
export const defaultSharpAdapter: SharpAdapter = {
  async encode(input, request) {
    const result = await sharp(input)
      .autoOrient()
      .resize({
        width: request.longestEdge,
        height: request.longestEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: request.quality })
      .toBuffer({ resolveWithObject: true });
    return { data: result.data, info: { size: result.info.size } };
  },
};

const QUALITY_STEPS = [80, 70, 60, 50, 40, 30, 20, 10];
const EDGE_STEPS = [8192, 6144, 4096, 3072, 2048, 1536, 1024, 768, 512];
const ENCODE_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("image encoding timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Encode sequentially, lowering quality before the longest edge. The first
 * fitting result is the highest-quality/largest-dimension result under the
 * strict byte budget because candidates are visited in descending order.
 */
export async function fitImageToBudget(
  input: Buffer,
  adapter: SharpAdapter = defaultSharpAdapter,
): Promise<SharpEncodeResult> {
  let lastError: unknown;
  for (const longestEdge of EDGE_STEPS) {
    for (const quality of QUALITY_STEPS) {
      try {
        const result = await withTimeout(
          adapter.encode(input, { quality, longestEdge }),
          ENCODE_TIMEOUT_MS,
        );
        if (result.info.size < MAX_IMAGE_BYTES) return result;
      } catch (error) {
        lastError = error;
      }
    }
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`photo could not be encoded under 1 MB${suffix}`);
}
