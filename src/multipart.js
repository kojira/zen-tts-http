// Minimal multipart/form-data parser (node built-ins only). Buffers the body up to a total cap,
// then splits it on the boundary. Enough for one small form with a few files.

export class MultipartError extends Error {}

export function boundaryOf(contentType) {
  const match = /^multipart\/form-data\s*;.*\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  if (!match) throw new MultipartError('content-type must be multipart/form-data with a boundary');
  return match[1] ?? match[2];
}

export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new MultipartError(`upload is too large (at most ${maxBytes} bytes in total)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Returns { fields: {name: string}, files: {name: {filename, data: Buffer}} }.
export function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let start = body.indexOf(delimiter);
  if (start < 0) throw new MultipartError('multipart body has no boundary');
  while (true) {
    start += delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body.subarray(start, start + 2).toString() !== '\r\n') throw new MultipartError('malformed multipart body');
    start += 2;
    const next = body.indexOf(delimiter, start);
    if (next < 0) throw new MultipartError('multipart body is truncated');
    const part = body.subarray(start, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new MultipartError('multipart part has no headers');
    const headers = part.subarray(0, headerEnd).toString('utf8');
    const data = part.subarray(headerEnd + 4);
    const disposition = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers);
    if (!disposition) throw new MultipartError('multipart part has no content-disposition');
    const name = /\bname="([^"]*)"/i.exec(disposition[1])?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disposition[1])?.[1];
    if (!name) throw new MultipartError('multipart part has no name');
    if (filename !== undefined) files[name] = { filename, data: Buffer.from(data) };
    else fields[name] = data.toString('utf8');
    start = next;
  }
  return { fields, files };
}
