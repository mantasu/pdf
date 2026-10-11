/**
 * Pictures on pages are image stamps (`/Subtype /Stamp`) whose appearance draws a
 * single image XObject. JPEG streams are returned as they are; 8-bit gray/RGB
 * Flate streams (with an optional alpha mask) are re-encoded as PNG. Anything
 * else stays a pdf.js-drawn "other" stamp.
 */
import { crc32, deflateSync } from "node:zlib";
import { PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { key, readName, readNumber, asDict } from "./objects";

type Picture = { mime: "image/jpeg" | "image/png"; bytes: Uint8Array };

export function fromDataUrl(url: string): Picture | undefined {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/u.exec(url);
  return m ? { mime: m[1] as Picture["mime"], bytes: new Uint8Array(Buffer.from(m[2]!, "base64")) } : undefined;
}

const toDataUrl = ({ mime, bytes }: Picture) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, crc]);
}

/** Minimal PNG encoder: 8-bit gray (1), gray+alpha (2), RGB (3) or RGBA (4). */
export function pngOf(width: number, height: number, channels: 1 | 2 | 3 | 4, pixels: Uint8Array): Uint8Array {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, colorType, 0, 0, 0], 8);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

const CHANNELS: Readonly<Record<string, 1 | 3>> = { DeviceGray: 1, DeviceRGB: 3 };

/** Raw 8-bit samples of a Flate image; undefined for unsupported layouts. */
function grayOrColor(stream: PDFRawStream, expected: 1 | 3): Uint8Array | undefined {
  const { dict } = stream;
  const width = readNumber(dict, "Width") ?? 0;
  const height = readNumber(dict, "Height") ?? 0;
  const flat = readName(dict, "Filter") === "FlateDecode" && readNumber(dict, "BitsPerComponent") === 8 && !dict.has(key("DecodeParms"));
  if (!width || !height || !flat) {
    return undefined;
  }
  const data = decodePDFRawStream(stream).decode();
  return CHANNELS[readName(dict, "ColorSpace") ?? ""] === expected && data.length >= width * height * expected ? data : undefined;
}

function decodeImage(stream: PDFRawStream): Picture | undefined {
  const { dict } = stream;
  if (readName(dict, "Filter") === "DCTDecode") {
    return { mime: "image/jpeg", bytes: stream.contents };
  }
  const channels = CHANNELS[readName(dict, "ColorSpace") ?? ""];
  const pixels = channels && grayOrColor(stream, channels);
  if (!channels || !pixels) {
    return undefined;
  }
  const width = readNumber(dict, "Width")!;
  const height = readNumber(dict, "Height")!;
  const maskRef = dict.get(key("SMask"));
  const mask = maskRef && dict.context.lookup(maskRef);
  const alpha = mask instanceof PDFRawStream ? grayOrColor(mask, 1) : undefined;
  if (maskRef && !alpha) {
    return undefined;
  }
  if (!alpha) {
    return { mime: "image/png", bytes: pngOf(width, height, channels, pixels) };
  }
  const out = new Uint8Array(width * height * (channels + 1));
  for (let i = 0; i < width * height; i++) {
    out.set(pixels.subarray(i * channels, (i + 1) * channels), i * (channels + 1));
    out[i * (channels + 1) + channels] = alpha[i]!;
  }
  return { mime: "image/png", bytes: pngOf(width, height, (channels + 1) as 2 | 4, out) };
}

/** The picture of an image stamp as a `data:` URL. */
export function stampPicture(annotation: PDFDict): string | undefined {
  const { context } = annotation;
  const normal = asDict(context, annotation.get(key("AP")))?.get(key("N"));
  const form = normal && context.lookup(normal);
  if (!(form instanceof PDFRawStream)) {
    return undefined;
  }
  const xobjects = asDict(context, asDict(context, form.dict.get(key("Resources")))?.get(key("XObject")));
  const images = (xobjects?.values() ?? []).map((value) => context.lookup(value));
  if (images.length !== 1 || !(images[0] instanceof PDFRawStream) || images[0].dict.get(key("Subtype")) !== PDFName.of("Image")) {
    return undefined;
  }
  const image = decodeImage(images[0]);
  return image && toDataUrl(image);
}
