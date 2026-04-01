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

// ─── yt-dlp stream URL cache ──────────────────────────────────────────────────
// YouTube stream URLs are valid for several hours — no need to call yt-dlp
// for every segment. Caching this saves 2-5 seconds per segment.
interface CachedUrl {
  url: string;
  expiry: number;
}
const streamUrlCache = new Map<string, CachedUrl>();
const URL_TTL_MS = 25 * 60 * 1000; // 25 minutes

async function getStreamUrl(videoUrl: string): Promise<string> {
  const cached = streamUrlCache.get(videoUrl);
  if (cached && Date.now() < cached.expiry) {
    return cached.url;
  }

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

// ─── TTS models ───────────────────────────────────────────────────────────────
export interface TtsVoice {
  id: string;
  name: string;
  gender: string;
}
export interface TtsModel {
  id: string;
  name: string;
  voices: TtsVoice[];
}

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
    voices: [
      { id: "google:ar", name: "عربي", gender: "أنثى" },
    ],
  },
];

// ─── Options ──────────────────────────────────────────────────────────────────
export interface ProcessOptions {
  jobId: string;
  videoUrl: string;
  startTime: number;
  voice?: string;
  speed?: number;
  duration?: number;
}

// ─── Extract audio to in-memory buffer (no intermediate file) ─────────────────
// Uses spawn so ffmpeg stdout is piped directly into memory, then sent straight
// to Whisper. Skips disk writes entirely — saves ~0.5-1 s per segment.
function extractAudioBuffer(
  streamUrl: string,
  startTime: number,
  duration: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-ss", String(startTime),
      "-i", streamUrl,
      "-t", String(duration),
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-f", "mp3",
      "-q:a", "9",      // fastest MP3 quality (lowest bitrate — still fine for Whisper)
      "-loglevel", "quiet",
      "pipe:1",
    ];

    const ffmpeg = spawn("ffmpeg", args);
    const chunks: Buffer[] = [];

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", () => {}); // suppress
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

// ─── Transcribe audio buffer with Whisper (no temp file) ─────────────────────
// Node 18+ has a global File class — wrap the buffer and send directly.
async function transcribeBuffer(audioBuffer: Buffer): Promise<string> {
  const file = new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" });
  const response = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file: file as unknown as File,
  });
  return response.text;
}

// ─── Translate to Arabic ──────────────────────────────────────────────────────
async function translateToArabic(text: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "أنت مترجم محترف. ترجم النص التالي إلى العربية الفصحى الطبيعية. أعطِ الترجمة فقط دون أي شرح أو تعليق.",
      },
      { role: "user", content: text },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

// ─── atempo chain for Google TTS speed ───────────────────────────────────────
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

// ─── Edge TTS ─────────────────────────────────────────────────────────────────
async function synthesizeEdgeTTS(
  text: string,
  voice: string,
  outDir: string,
  speed: number,
): Promise<string> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(outDir, text, { rate: speed });
  return audioFilePath;
}

// ─── Google TTS ───────────────────────────────────────────────────────────────
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
      if (err) reject(err);
      else resolve();
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

// ─── Main pipeline ────────────────────────────────────────────────────────────
export async function processVideoSegment(
  options: ProcessOptions,
): Promise<void> {
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
    // Step 1 — get cached stream URL (fast after first request)
    updateJob(jobId, {
      status: "processing",
      progress: "جاري الحصول على رابط البث...",
    });
    const streamUrl = await getStreamUrl(videoUrl);

    // Step 2 — extract audio to memory buffer (no disk write)
    updateJob(jobId, { progress: "جاري استخراج الصوت..." });
    const audioBuffer = await extractAudioBuffer(streamUrl, startTime, duration);

    // Step 3 — transcribe with Whisper (buffer sent directly, no file read)
    updateJob(jobId, { progress: "جاري التعرف على الكلام..." });
    const transcript = await transcribeBuffer(audioBuffer);

    // Step 4 — translate
    updateJob(jobId, { progress: "جاري الترجمة إلى العربية...", transcript });
    const translation = await translateToArabic(transcript);

    // Step 5 — TTS synthesis
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

    // If stream URL might have expired, clear it from cache so next attempt refetches
    if (
      message.includes("403") ||
      message.includes("410") ||
      message.includes("ffmpeg exited")
    ) {
      streamUrlCache.delete(videoUrl);
    }

    updateJob(jobId, {
      status: "failed",
      progress: "فشلت المعالجة",
      error: message,
    });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
