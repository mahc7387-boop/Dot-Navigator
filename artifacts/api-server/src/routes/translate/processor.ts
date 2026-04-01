import { spawn } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire } from "module";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { openai } from "@workspace/integrations-openai-ai-server";
import { updateJob } from "./jobs.js";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

// ─── Audio paths by job ID ────────────────────────────────────────────────────
const audioPaths = new Map<string, string>();
export function getAudioPath(jobId: string): string | null {
  return audioPaths.get(jobId) ?? null;
}

// ─── TTS models ───────────────────────────────────────────────────────────────
export interface TtsVoice { id: string; name: string; gender: string; }
export interface TtsModel { id: string; name: string; voices: TtsVoice[]; }

export const TTS_MODELS: TtsModel[] = [
  {
    id: "edge",
    name: "Microsoft Edge TTS",
    voices: [
      { id: "edge:ar-SA-ZariyahNeural", name: "زارية (عربية سعودية)", gender: "أنثى" },
      { id: "edge:ar-SA-HamedNeural", name: "حامد (عربي سعودي)", gender: "ذكر" },
      { id: "edge:ar-EG-SalmaNeural", name: "سلمى (عربية مصرية)", gender: "أنثى" },
      { id: "edge:ar-EG-ShakirNeural", name: "شاكر (عربي مصري)", gender: "ذكر" },
      { id: "edge:fr-FR-RemyMultilingualNeural", name: "Rémy (متعدد اللغات)", gender: "ذكر" },
    ],
  },
  {
    id: "google",
    name: "Google TTS",
    voices: [{ id: "google:ar", name: "عربي", gender: "أنثى" }],
  },
];

export interface ProcessOptions {
  jobId: string;
  videoUrl: string;
  startTime: number;
  voice?: string;
  speed?: number;
  duration?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// LAYER 1 — yt-dlp stream URL cache
// YouTube stream URLs stay valid for hours. Caching avoids 2-5 s per segment.
// ════════════════════════════════════════════════════════════════════════════
interface CachedUrl { url: string; expiry: number; }
const streamUrlCache = new Map<string, CachedUrl>();
const URL_TTL_MS = 25 * 60 * 1000;

async function getStreamUrl(videoUrl: string): Promise<string> {
  const cached = streamUrlCache.get(videoUrl);
  if (cached && Date.now() < cached.expiry) return cached.url;

  const ytDlp = require("yt-dlp-exec");
  const raw: string = await ytDlp(videoUrl, {
    getUrl: true,
    format: "bestaudio/best",
    noPlaylist: true,
    noCheckCertificate: true,
  });

  const url = raw.trim().split("\n")[0];
  streamUrlCache.set(videoUrl, { url, expiry: Date.now() + URL_TTL_MS });
  return url;
}

// ════════════════════════════════════════════════════════════════════════════
// LAYER 2 — Audio pre-fetch cache
// When segment N starts processing, we immediately start downloading segment
// N+1 audio in the background. By the time N+1 is requested, its audio is
// already in memory — saving the full ffmpeg download wait (~3-8 s).
// ════════════════════════════════════════════════════════════════════════════
const prefetchCache = new Map<string, Promise<Buffer>>();
const PREFETCH_TTL_MS = 10 * 60 * 1000;

function prefetchKey(videoUrl: string, startTime: number): string {
  return `${videoUrl}@${startTime}`;
}

function extractAudioBuffer(
  streamUrl: string,
  startTime: number,
  duration: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-ss", String(startTime),
      "-i", streamUrl,
      "-t", String(duration),
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-f", "mp3",
      "-q:a", "9",
      "-loglevel", "quiet",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", () => {});
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0) { reject(new Error(`ffmpeg exited with code ${code}`)); return; }
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Pre-fetch audio for a future segment (fire-and-forget). */
function prefetchNextSegment(videoUrl: string, startTime: number, duration: number): void {
  const key = prefetchKey(videoUrl, startTime);
  if (prefetchCache.has(key)) return;

  const promise = getStreamUrl(videoUrl)
    .then((streamUrl) => extractAudioBuffer(streamUrl, startTime, duration))
    .catch(() => { prefetchCache.delete(key); return Buffer.alloc(0); });

  prefetchCache.set(key, promise);
  setTimeout(() => prefetchCache.delete(key), PREFETCH_TTL_MS);
}

/** Get audio buffer — uses pre-fetch cache if available. */
async function getAudioBuffer(
  videoUrl: string,
  startTime: number,
  duration: number,
  streamUrl: string,
): Promise<Buffer> {
  const key = prefetchKey(videoUrl, startTime);
  const prefetched = prefetchCache.get(key);
  if (prefetched) {
    prefetchCache.delete(key);
    const buf = await prefetched;
    if (buf.length > 0) return buf;
  }
  return extractAudioBuffer(streamUrl, startTime, duration);
}

// ════════════════════════════════════════════════════════════════════════════
// LAYER 3 — Whisper transcription (buffer → API, no temp file)
// ════════════════════════════════════════════════════════════════════════════
async function transcribeBuffer(audioBuffer: Buffer): Promise<string> {
  const file = new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" });
  const response = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file: file as unknown as File,
  });
  return response.text;
}

// ════════════════════════════════════════════════════════════════════════════
// LAYER 4 — Translation
// ════════════════════════════════════════════════════════════════════════════
async function translateToArabic(text: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "أنت مترجم محترف. ترجم النص التالي إلى العربية الفصحى الطبيعية. أعطِ الترجمة فقط دون أي شرح أو تعليق.",
      },
      { role: "user", content: text },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

// ════════════════════════════════════════════════════════════════════════════
// LAYER 5 — TTS (Edge: parallel sentences / Google: atempo)
// ════════════════════════════════════════════════════════════════════════════

/** Split Arabic/Latin text into sentences, keeping punctuation. */
function splitSentences(text: string): string[] {
  const segments: string[] = [];
  let cur = "";
  for (const ch of text) {
    cur += ch;
    if (".!?،؟\n".includes(ch) && cur.trim().length >= 4) {
      segments.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim().length > 0) segments.push(cur.trim());
  return segments.filter((s) => s.length > 0);
}

/**
 * Synthesize a single sentence via Edge TTS → in-memory Buffer.
 * Each call gets its own MsEdgeTTS instance + WebSocket connection.
 */
async function synthesizeSentenceEdge(
  sentence: string,
  voice: string,
  speed: number,
): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const readable = await tts.toStream(sentence, { rate: speed });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on("data", (c: Buffer) => chunks.push(c));
    readable.on("error", reject);
    readable.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Synthesize all sentences in parallel (≤3 concurrent WebSocket calls),
 * then concatenate results in order.
 */
async function synthesizeEdgeTTS(
  text: string,
  voice: string,
  outDir: string,
  speed: number,
): Promise<string> {
  const sentences = splitSentences(text);
  if (sentences.length === 0) throw new Error("لا يوجد نص للتحويل");

  const CONCURRENCY = 3;
  const results: Buffer[] = new Array(sentences.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIdx++;
      if (i >= sentences.length) break;
      results[i] = await synthesizeSentenceEdge(sentences[i], voice, speed);
    }
  }

  const pool = Array.from(
    { length: Math.min(CONCURRENCY, sentences.length) },
    worker,
  );
  await Promise.all(pool);

  const combined = Buffer.concat(results);
  const outputPath = path.join(outDir, "edge_output.mp3");
  fs.writeFileSync(outputPath, combined);
  return outputPath;
}

function buildAtempoFilter(speed: number): string | null {
  if (Math.abs(speed - 1.0) < 0.001) return null;
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0 + 0.001) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(",");
}

async function synthesizeGoogleTTS(
  text: string,
  lang: string,
  tmpDir: string,
  speed: number,
): Promise<string> {
  const rawPath = path.join(tmpDir, "google_raw.mp3");
  const gtts = require("node-gtts")(lang);
  await new Promise<void>((resolve, reject) => {
    gtts.save(rawPath, text, (err: Error | null) => {
      if (err) reject(err); else resolve();
    });
  });

  const atempoFilter = buildAtempoFilter(speed);
  if (!atempoFilter) return rawPath;

  const outputPath = path.join(tmpDir, "google_output.mp3");
  await execAsync(
    `ffmpeg -y -i "${rawPath}" -filter:a "${atempoFilter}" -loglevel quiet "${outputPath}"`,
    { maxBuffer: 1024 * 1024 * 10 },
  );
  return outputPath;
}

// ════════════════════════════════════════════════════════════════════════════
// Main pipeline
// ════════════════════════════════════════════════════════════════════════════
export async function processVideoSegment(options: ProcessOptions): Promise<void> {
  const {
    jobId,
    videoUrl,
    startTime,
    voice = "edge:ar-SA-ZariyahNeural",
    speed = 1.0,
    duration = 20,
  } = options;

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `vtrans-${jobId.slice(0, 8)}-`),
  );

  try {
    // ── Step 1: get (cached) stream URL ─────────────────────────────────────
    updateJob(jobId, { status: "processing", progress: "جاري الحصول على رابط البث..." });
    const streamUrl = await getStreamUrl(videoUrl);

    // ── Kick off pre-fetch for the NEXT segment immediately ──────────────────
    // This runs in the background — by the time the frontend requests N+1,
    // its audio will likely already be in memory.
    prefetchNextSegment(videoUrl, startTime + duration, duration);

    // ── Step 2: extract audio (or use pre-fetched buffer) ────────────────────
    updateJob(jobId, { progress: "جاري استخراج الصوت..." });
    const audioBuffer = await getAudioBuffer(videoUrl, startTime, duration, streamUrl);

    // ── Step 3: transcribe ───────────────────────────────────────────────────
    updateJob(jobId, { progress: "جاري التعرف على الكلام..." });
    const transcript = await transcribeBuffer(audioBuffer);

    // ── Step 4: translate ────────────────────────────────────────────────────
    updateJob(jobId, { progress: "جاري الترجمة إلى العربية...", transcript });
    const translation = await translateToArabic(transcript);

    // ── Step 5: TTS (parallel sentences for Edge) ───────────────────────────
    updateJob(jobId, { progress: "جاري تركيب الصوت العربي...", translation });

    const colonIdx = voice.indexOf(":");
    const provider = colonIdx >= 0 ? voice.slice(0, colonIdx) : "edge";
    const voiceId = colonIdx >= 0 ? voice.slice(colonIdx + 1) : voice;

    let finalAudioPath: string;
    if (provider === "google") {
      finalAudioPath = await synthesizeGoogleTTS(
        translation, voiceId || "ar", tmpDir, speed,
      );
    } else {
      finalAudioPath = await synthesizeEdgeTTS(
        translation, voiceId || "ar-SA-ZariyahNeural", tmpDir, speed,
      );
    }

    audioPaths.set(jobId, finalAudioPath);
    updateJob(jobId, {
      status: "completed",
      progress: "اكتملت المعالجة بنجاح ✓",
      audioPath: finalAudioPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Expired stream URL — clear cache so next attempt re-fetches from yt-dlp
    if (message.includes("403") || message.includes("410") || message.includes("ffmpeg exited")) {
      streamUrlCache.delete(videoUrl);
    }

    updateJob(jobId, { status: "failed", progress: "فشلت المعالجة", error: message });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
