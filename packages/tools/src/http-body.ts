/** Maximum response size accepted by the network tools. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Collect a fetch response body without allowing an unbounded response into
 * memory. A declared oversize is rejected before a reader is created; a
 * streamed oversize cancels the reader immediately.
 */
export async function readBoundedResponseBody(
  response: Response,
  maximumBytes = MAX_RESPONSE_BYTES,
  tooLargeMessage = "Response too large (exceeds 5MB limit)",
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  const parsedLength = declaredLength === null ? undefined : Number.parseInt(declaredLength, 10);
  if (parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength > maximumBytes) {
    throw new Error(tooLargeMessage);
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) throw new Error(tooLargeMessage);
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (size + value.byteLength > maximumBytes) {
        await reader.cancel(tooLargeMessage);
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The transport may have closed the stream while cancellation was running.
    }
    throw error;
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
