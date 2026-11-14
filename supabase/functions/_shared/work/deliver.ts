// WO-124a: delivery stays inside the channel (spec D7). The order is: the file itself (native), then Trainee's own
// owner-scoped, signed and expiring trainee-file page (file_page), then a plain-text builder with a SHA-256 manifest
// (text_builder). This module has no network of its own: the caller hands it the channel's send (channel_artifacts.ts
// bytes-ref seam) and the trainee-file page minting. Nothing here uploads to, or links from, any outside store.

export type Channel = "whatsapp" | "telegram" | "imessage";
export type Delivery = "native" | "file_page" | "text_builder";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// The types each channel takes as a file today. Conservative: a type is listed only where the code already sends it,
// or the channel's own document rail is known to take it.
//  - whatsapp: whatsapp_twilio.ts sends a channel_artifacts bytes-ref as Twilio MediaUrl (resume PDF and DOCX today).
//    WhatsApp's document media takes PDF, Office files and plain text; it refuses archives (benchmark 0010 and 0019).
//  - telegram: telegram.ts sendDocument (multipart bytes) carries the resume PDF/DOCX and channel_shape.ts .md/.txt
//    attachments; Bot API sendDocument takes general files, so Office files, CSV and ICS ride as documents. ZIP is
//    left out until a channel test proves it.
//  - imessage: loopmessage.ts has no file send (no sendDocument on its adapter), so nothing is native there.
export const ACCEPTED: Record<Channel, readonly string[]> = {
  whatsapp: [PDF, DOCX, XLSX, PPTX, "text/plain", "image/png", "image/jpeg"],
  telegram: [PDF, DOCX, XLSX, PPTX, "text/plain", "text/markdown", "text/csv", "text/calendar", "image/png", "image/jpeg"],
  imessage: [],
};
// WhatsApp's document size limit is 100 MB; Telegram's bot upload limit is 50 MB.
export const MAX_NATIVE_BYTES: Record<Channel, number> = { whatsapp: 100 * 1024 * 1024, telegram: 50 * 1024 * 1024, imessage: 0 };
// The trainee-file page serves the bytes behind a signed, expiring, owner-scoped link (file_link.ts).
export const FILE_PAGE_MAX_BYTES = 20 * 1024 * 1024;

const base = (mime: string) => String(mime ?? "").split(";")[0].trim().toLowerCase();

export function chooseDelivery(
  channel: Channel,
  mime: string,
  o: { bytes?: number; filePage?: boolean } = {},
): Delivery {
  const m = base(mime);
  const size = o.bytes ?? 0;
  if ((ACCEPTED[channel] ?? []).includes(m) && size <= (MAX_NATIVE_BYTES[channel] ?? 0)) return "native";
  if (o.filePage !== false && size <= FILE_PAGE_MAX_BYTES) return "file_page";
  return "text_builder";
}

export interface WorkFile { filename: string; mime: string; bytes: Uint8Array }
export interface DeliverIo {
  // The channel's own file send, through the channel_artifacts.ts bytes-ref (whatsapp signs a MediaUrl on its own function).
  sendFile: (f: WorkFile) => Promise<{ ok: boolean }>;
  // Mints Trainee's own trainee-file page for this owner and file; returns its signed, expiring URL, or null.
  filePage?: (f: WorkFile) => Promise<string | null>;
  sendText: (text: string) => Promise<{ ok: boolean }>;
}
export interface DeliverResult { how: Delivery; ok: boolean; url?: string; tried: Delivery[]; note: string }

const NOT_RECALLED = "Copies already sent cannot be recalled.";

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A plain-text builder: each text file between markers, then a manifest of SHA-256 sums the person can check after
// rebuilding. A binary file cannot be carried as text and makes the builder refuse.
export async function textBuilder(files: WorkFile[]): Promise<string | null> {
  const dec = new TextDecoder("utf-8", { fatal: true });
  const body: string[] = [], manifest: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = dec.decode(f.bytes); } catch { return null; }
    if (text.includes("\u0000")) return null;
    body.push(`----- BEGIN FILE ${f.filename} -----\n${text}\n----- END FILE ${f.filename} -----`);
    manifest.push(`${await sha256Hex(f.bytes)}  ${f.filename}`);
  }
  return `${body.join("\n\n")}\n\n----- SHA-256 MANIFEST -----\n${manifest.join("\n")}\n`;
}

// The archive is opened only to build a text builder from its parts; it is never re-sent anywhere else.
async function partsOf(f: WorkFile): Promise<WorkFile[]> {
  if (base(f.mime) !== "application/zip") return [f];
  const { unzipSync } = await import("npm:fflate@0.8.2");
  return Object.entries(unzipSync(f.bytes)).filter(([n]) => !n.endsWith("/")).map(([n, b]) => ({ filename: n, mime: "text/plain", bytes: b }));
}

export async function deliver(channel: Channel, f: WorkFile, io: DeliverIo): Promise<DeliverResult> {
  const tried: Delivery[] = [];
  let how = chooseDelivery(channel, f.mime, { bytes: f.bytes.length, filePage: !!io.filePage });
  if (how === "native") {
    tried.push("native");
    if ((await io.sendFile(f)).ok) return { how, ok: true, tried, note: `${f.filename} was sent as a file. ${NOT_RECALLED}` };
    how = io.filePage && f.bytes.length <= FILE_PAGE_MAX_BYTES ? "file_page" : "text_builder";
  }
  if (how === "file_page" && io.filePage) {
    tried.push("file_page");
    const url = await io.filePage(f);
    if (url && (await io.sendText(`${f.filename}: ${url}\nThis page is yours alone and expires.`)).ok) {
      return { how, ok: true, url, tried, note: `${f.filename} went to your own expiring page. ${NOT_RECALLED}` };
    }
  }
  tried.push("text_builder");
  let text: string | null = null;
  try { text = await textBuilder(await partsOf(f)); } catch { text = null; }
  if (text && (await io.sendText(text)).ok) {
    return { how: "text_builder", ok: true, tried, note: `${f.filename} went as a text builder with a SHA-256 manifest. ${NOT_RECALLED}` };
  }
  return { how: "text_builder", ok: false, tried, note: `${f.filename} could not be delivered in this channel, and nothing was sent elsewhere.` };
}
