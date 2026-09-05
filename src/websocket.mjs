import crypto from "node:crypto";

const MAX_WEBSOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

export function websocketFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function websocketFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const largeLength = buffer.readBigUInt64BE(offset + 2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oversized app-server websocket frame");
      length = Number(largeLength);
      headerLength = 10;
    }
    if (length > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("oversized app-server websocket frame");
    if (first & 0x70) throw new Error("unsupported app-server websocket extension");
    if (second & 0x80) throw new Error("masked app-server websocket frame");
    const opcode = first & 0x0f;
    const fin = (first & 0x80) !== 0;
    const isControl = opcode >= 8;
    if (![0, 1, 8, 9, 10].includes(opcode)) throw new Error("unsupported app-server websocket opcode");
    if (isControl && (!fin || length > 125)) throw new Error("invalid app-server websocket control frame");
    if (buffer.length - offset < headerLength + length) break;
    const payload = buffer.subarray(offset + headerLength, offset + headerLength + length);
    frames.push({ fin, opcode, payload });
    offset += headerLength + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function validateWebSocketUpgrade(header, key) {
  const [status, ...lines] = header.split("\r\n");
  const headers = new Map(lines.map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  if (!/^HTTP\/1\.1 101(?: |$)/.test(status)
    || headers.get("sec-websocket-accept") !== accept
    || headers.get("upgrade")?.toLowerCase() !== "websocket"
    || !headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) {
    throw new Error(`app-server websocket upgrade failed: ${status}`);
  }
}

export function createWebSocketDecoder(receive, pong) {
  let wire = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;
  let fragmenting = false;

  return (chunk) => {
    const decoded = websocketFrames(Buffer.concat([wire, chunk]));
    wire = decoded.rest;
    for (const { opcode, fin, payload } of decoded.frames) {
      switch (opcode) {
        case 8:
          throw new Error("codex app-server websocket closed");
        case 9:
          pong(payload);
          continue;
        case 10:
          continue;
        case 0:
          if (!fragmenting) throw new Error("invalid app-server websocket continuation: no message started");
          break;
        case 1:
          if (fragmenting) throw new Error("invalid app-server websocket continuation: message already started");
          break;
      }
      fragmentBytes += payload.length;
      if (fragmentBytes > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("oversized app-server websocket message");
      fragments.push(payload);
      fragmenting = !fin;
      if (fragmenting) continue;
      receive(Buffer.concat(fragments, fragmentBytes).toString("utf8"));
      fragments = [];
      fragmentBytes = 0;
    }
  };
}
