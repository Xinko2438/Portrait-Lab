const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function assertBounds(buffer, offset, length) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) throw new Error('Invalid or truncated image');
}

function inspectPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { mimeType: 'image/png', extension: '.png', width, height };
}

function inspectJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    assertBounds(buffer, offset, 2);
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2) throw new Error('Invalid JPEG segment');
    if (sofMarkers.has(marker)) {
      assertBounds(buffer, offset, 7);
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return { mimeType: 'image/jpeg', extension: '.jpg', width, height };
    }
    offset += segmentLength;
  }
  throw new Error('JPEG dimensions not found');
}

function readUInt24LE(buffer, offset) {
  assertBounds(buffer, offset, 3);
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function inspectWebp(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = readUInt24LE(buffer, 24) + 1;
    const height = readUInt24LE(buffer, 27) + 1;
    return { mimeType: 'image/webp', extension: '.webp', width, height };
  }
  if (chunk === 'VP8 ') {
    assertBounds(buffer, 20, 10);
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) throw new Error('Invalid VP8 frame');
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { mimeType: 'image/webp', extension: '.webp', width, height };
  }
  if (chunk === 'VP8L') {
    assertBounds(buffer, 20, 5);
    if (buffer[20] !== 0x2f) throw new Error('Invalid VP8L frame');
    const width = 1 + buffer[21] + ((buffer[22] & 0x3f) << 8);
    const height = 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10);
    return { mimeType: 'image/webp', extension: '.webp', width, height };
  }
  throw new Error('Unsupported WebP chunk');
}

export function inspectImage(bytes, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  const buffer = Buffer.from(bytes || []);
  if (!buffer.length) throw new Error('Image file is empty');
  if (buffer.length > maxBytes) throw new Error(`Image exceeds ${maxBytes} bytes`);
  const metadata = inspectPng(buffer) || inspectJpeg(buffer) || inspectWebp(buffer);
  if (!metadata) throw new Error('Only PNG, JPEG, and WebP images are supported');
  if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 1 || metadata.height < 1) {
    throw new Error('Image dimensions are invalid');
  }
  return { ...metadata, bytes: buffer.length };
}

export { MAX_IMAGE_BYTES };