import React, { useState, useRef, useEffect, useCallback } from 'react';
import YouTube from 'react-youtube';
import { Play, Youtube, Settings, Wand2, RefreshCcw, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { useToast } from '@/hooks/use-toast';
import { useGetTtsModels } from '@workspace/api-client-react';
import { useYoutubeUrl } from '@/hooks/use-youtube-url';
import { ProcessingOverlay } from '@/components/processing-overlay';
import { PipelineBar } from '@/components/pipeline-bar';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card } from '@/components/ui/card';

const POLL_INTERVAL = 1500;

type SegmentDuration = 20 | 60;

interface SegmentJob {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  audioUrl: string | null;
  progress: string;
}

function formatTime(secs: number) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function requestSegment(
  videoUrl: string,
  startTime: number,
  model: string,
  voice: string,
  speed: number,
  duration: number,
): Promise<string> {
  const res = await fetch('/api/translate/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl, startTime, model, voice, speed, duration }),
  });
  const data = await res.json();
  return data.jobId as string;
}

async function pollJob(
  jobId: string,
  onProgress: (p: string) => void,
  signal: AbortSignal
): Promise<SegmentJob> {
  while (!signal.aborted) {
    const res = await fetch(`/api/translate/status/${jobId}`);
    const data = await res.json();
    onProgress(data.progress || '');
    if (data.status === 'completed') {
      return { jobId, status: 'completed', audioUrl: `/api/translate/audio/${jobId}`, progress: data.progress };
    }
    if (data.status === 'failed') {
      return { jobId, status: 'failed', audioUrl: null, progress: data.progress };
    }
    await new Promise<void>(r => {
      const t = setTimeout(r, POLL_INTERVAL);
      signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    });
  }
  throw new Error('aborted');
}

export default function Home() {
  const { toast } = useToast();
  const { url, setUrl, videoId, isValid } = useYoutubeUrl();

  const ytPlayerRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastTimeRef = useRef<number>(0);
  const isSeekingRef = useRef(false);
  const isSyncingRef = useRef(false);
  const activeSegmentKeyRef = useRef<number>(0);

  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [segmentDuration, setSegmentDuration] = useState<SegmentDuration>(20);
  const segDurRef = useRef<number>(20);

  const [isPlaying, setIsPlaying] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [overlayProgress, setOverlayProgress] = useState('جاري تهيئة المقطع...');
  const [hasStarted, setHasStarted] = useState(false);

  const [pipelineVisible, setPipelineVisible] = useState(false);
  const [pipelineProgress, setPipelineProgress] = useState('');
  const [pipelineSegmentLabel, setPipelineSegmentLabel] = useState('');
  const [pipelineDone, setPipelineDone] = useState(false);

  const segmentCacheRef = useRef<Map<number, SegmentJob>>(new Map());
  const inFlightRef = useRef<Map<number, Promise<SegmentJob>>>(new Map());
  const furthestQueuedRef = useRef<number>(-1);
  const chainAbortRef = useRef<AbortController | null>(null);

  const { data: modelsData, isLoading: isLoadingModels } = useGetTtsModels();

  const normalizeStart = useCallback((t: number) =>
    Math.floor(t / segDurRef.current) * segDurRef.current, []);

  useEffect(() => {
    if (modelsData?.models?.length && !selectedModel) {
      const first = modelsData.models[0];
      setSelectedModel(first.id);
      if (first.voices?.length) setSelectedVoice(first.voices[0].id);
    }
  }, [modelsData, selectedModel]);

  useEffect(() => {
    if (selectedModel && modelsData?.models) {
      const model = modelsData.models.find(m => m.id === selectedModel);
      if (model?.voices?.length && !model.voices.some(v => v.id === selectedVoice)) {
        setSelectedVoice(model.voices[0].id);
      }
    }
  }, [selectedModel, modelsData, selectedVoice]);

  const resetPlayback = useCallback(() => {
    chainAbortRef.current?.abort();
    segmentCacheRef.current.clear();
    inFlightRef.current.clear();
    furthestQueuedRef.current = -1;
    setHasStarted(false);
    setShowOverlay(false);
    setPipelineVisible(false);
    setPipelineDone(false);
  }, []);

  useEffect(() => { resetPlayback(); }, [url, resetPlayback]);

  useEffect(() => {
    segDurRef.current = segmentDuration;
    resetPlayback();
  }, [segmentDuration, resetPlayback]);

  const fetchSegment = useCallback(async (
    startTime: number,
    signal: AbortSignal,
    onProgress?: (p: string) => void,
    pipelineUpdate = false
  ): Promise<SegmentJob> => {
    const key = normalizeStart(startTime);
    const dur = segDurRef.current;
    const label = `${formatTime(key)} – ${formatTime(key + dur)}`;

    if (pipelineUpdate) {
      setPipelineSegmentLabel(label);
      setPipelineDone(false);
      setPipelineProgress('جاري استخراج الصوت...');
    }

    const jobId = await requestSegment(url, key, selectedModel, selectedVoice, speed, dur);

    const job = await pollJob(jobId, (p) => {
      onProgress?.(p);
      if (pipelineUpdate) setPipelineProgress(p);
    }, signal);

    if (job.status === 'completed') {
      segmentCacheRef.current.set(key, job);
      if (pipelineUpdate) {
        setPipelineDone(true);
        setTimeout(() => setPipelineDone(false), 800);
      }
    }

    return job;
  }, [url, selectedModel, selectedVoice, speed, normalizeStart]);

  const startChain = useCallback(async (fromSegment: number, signal: AbortSignal) => {
    let current = normalizeStart(fromSegment);
    while (!signal.aborted) {
      const key = current;
      if (!segmentCacheRef.current.has(key)) {
        try {
          furthestQueuedRef.current = key;
          await fetchSegment(key, signal, undefined, true);
        } catch {
          if (signal.aborted) break;
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
      }
      current += segDurRef.current;
      await new Promise<void>(r => {
        const t = setTimeout(r, 500);
        signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  }, [fetchSegment, normalizeStart]);

  const playSegment = useCallback(async (startTime: number, showLoading: boolean) => {
    const key = normalizeStart(startTime);

    ytPlayerRef.current?.pauseVideo();
    audioRef.current?.pause();
    setIsPlaying(false);

    let job = segmentCacheRef.current.get(key);

    if (!job) {
      const abortCtrl = new AbortController();
      if (showLoading) {
        setShowOverlay(true);
        setOverlayProgress('جاري تجهيز المقطع...');
        try {
          job = await fetchSegment(key, abortCtrl.signal, (p) => setOverlayProgress(p));
        } catch {
          setShowOverlay(false);
          toast({ title: '❌ خطأ', description: 'فشل تحميل المقطع.', variant: 'destructive' });
          return;
        }
      } else {
        while (!segmentCacheRef.current.has(key)) {
          await new Promise(r => setTimeout(r, 400));
        }
        job = segmentCacheRef.current.get(key);
      }
    }

    setShowOverlay(false);

    if (!job || job.status === 'failed') {
      toast({ title: '❌ فشل المقطع', variant: 'destructive' });
      return;
    }

    if (audioRef.current && job.audioUrl) {
      isSyncingRef.current = true;
      ytPlayerRef.current?.seekTo(key, true);
      audioRef.current.src = job.audioUrl;
      audioRef.current.load();
      await new Promise(r => setTimeout(r, 600));
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
      ytPlayerRef.current?.playVideo();
      activeSegmentKeyRef.current = key;
      lastTimeRef.current = key;
      setIsPlaying(true);
      setTimeout(() => { isSyncingRef.current = false; }, 800);
    }
  }, [fetchSegment, toast, normalizeStart]);

  const handleInitialPlay = useCallback(async () => {
    if (!isValid || !selectedModel || !selectedVoice) {
      toast({ title: 'بيانات ناقصة', description: 'تأكد من الرابط والنموذج والصوت.', variant: 'destructive' });
      return;
    }

    chainAbortRef.current?.abort();
    segmentCacheRef.current.clear();
    inFlightRef.current.clear();

    const time = ytPlayerRef.current?.getCurrentTime() || 0;
    setHasStarted(true);
    setShowOverlay(true);
    setOverlayProgress('جاري استخراج الصوت...');

    const abortCtrl = new AbortController();
    chainAbortRef.current = abortCtrl;

    const key = normalizeStart(time);

    try {
      const job = await fetchSegment(key, abortCtrl.signal, (p) => setOverlayProgress(p));
      setShowOverlay(false);

      if (!job || job.status === 'failed') {
        toast({ title: '❌ فشل المقطع', variant: 'destructive' });
        return;
      }

      if (audioRef.current && job.audioUrl) {
        isSyncingRef.current = true;
        ytPlayerRef.current?.seekTo(key, true);
        audioRef.current.src = job.audioUrl;
        audioRef.current.load();
        await new Promise(r => setTimeout(r, 600));
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(() => {});
        ytPlayerRef.current?.playVideo();
        activeSegmentKeyRef.current = key;
        lastTimeRef.current = key;
        setIsPlaying(true);
        setTimeout(() => { isSyncingRef.current = false; }, 800);
      }

      setPipelineVisible(true);
      const nextKey = key + segDurRef.current;
      startChain(nextKey, abortCtrl.signal);

    } catch {
      setShowOverlay(false);
      toast({ title: '❌ خطأ في الاتصال', variant: 'destructive' });
    }
  }, [isValid, selectedModel, selectedVoice, fetchSegment, startChain, toast, normalizeStart]);

  const handleAudioEnded = useCallback(() => {
    const nextKey = activeSegmentKeyRef.current + segDurRef.current;
    playSegment(nextKey, false);
  }, [playSegment]);

  useEffect(() => {
    if (!hasStarted) return;
    const timer = setInterval(() => {
      if (!ytPlayerRef.current || !isPlaying) return;
      const time = ytPlayerRef.current.getCurrentTime();
      if (Math.abs(time - lastTimeRef.current) > 4 && !isSeekingRef.current) {
        isSeekingRef.current = true;
        const key = normalizeStart(time);
        const cached = segmentCacheRef.current.has(key);
        playSegment(time, !cached);

        chainAbortRef.current?.abort();
        const abortCtrl = new AbortController();
        chainAbortRef.current = abortCtrl;
        const nextKey = key + segDurRef.current;
        startChain(nextKey, abortCtrl.signal);

        setTimeout(() => { isSeekingRef.current = false; }, 1200);
      }
      lastTimeRef.current = time;
    }, 500);
    return () => clearInterval(timer);
  }, [hasStarted, isPlaying, playSegment, startChain, normalizeStart]);

  const handleYoutubeStateChange = (event: any) => {
    if (isSyncingRef.current) return;
    if (event.data === 1 && !showOverlay) {
      setIsPlaying(true);
      if (audioRef.current?.src && audioRef.current.paused && !audioRef.current.ended) {
        audioRef.current.play().catch(() => {});
      }
    } else if (event.data === 2) {
      setIsPlaying(false);
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
    }
  };

  const currentModelObj = modelsData?.models?.find(m => m.id === selectedModel);

  return (
    <div className="min-h-screen bg-background text-foreground relative pb-40">
      <div className="absolute inset-0 z-0 opacity-40 pointer-events-none">
        <img
          src={`${import.meta.env.BASE_URL}images/hero-bg.png`}
          alt=""
          className="w-full h-[60vh] object-cover"
          style={{ maskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)' }}
        />
      </div>

      <ProcessingOverlay isVisible={showOverlay} progressText={overlayProgress} />

      <PipelineBar
        isVisible={pipelineVisible && !showOverlay}
        progressText={pipelineProgress}
        segmentLabel={pipelineSegmentLabel}
        done={pipelineDone}
      />

      <audio ref={audioRef} onEnded={handleAudioEnded} preload="auto" />

      <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-12">

        <header className="text-center mb-12">
          <div className="inline-flex items-center justify-center p-3 mb-6 bg-primary/10 rounded-2xl border border-primary/20 shadow-[0_0_30px_hsl(var(--primary)/0.2)]">
            <Wand2 className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-4xl md:text-5xl font-display font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white to-white/60 mb-4">
            مترجم الفيديوهات الذكي
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            ضع رابط أي فيديو يوتيوب، وسنقوم بعزل الصوت، ترجمته، ودبلجته إلى العربية بصوت طبيعي متزامن تماماً.
          </p>
        </header>

        <Card className="p-2 mb-8 bg-card/60 backdrop-blur-md border-white/5 shadow-xl shadow-black/20">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none">
              <Youtube className="w-5 h-5 text-muted-foreground" />
            </div>
            <Input
              dir="ltr"
              type="text"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="pl-4 pr-12 py-6 text-lg bg-black/40 border-transparent focus-visible:ring-primary/50 text-left font-sans placeholder:text-right"
              disabled={showOverlay}
            />
          </div>
        </Card>

        <AnimatePresence mode="wait">
          {isValid && videoId && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="youtube-container">
                <YouTube
                  videoId={videoId}
                  opts={{ height: '100%', width: '100%', playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 } }}
                  onReady={(e) => { ytPlayerRef.current = e.target; }}
                  onStateChange={handleYoutubeStateChange}
                />
              </div>

              <Card className="p-6 bg-card/80 backdrop-blur-xl border-white/10 shadow-2xl">
                <div className="flex items-center gap-2 mb-6 border-b border-border/50 pb-4">
                  <Settings className="w-5 h-5 text-primary" />
                  <h3 className="text-xl font-display font-bold">إعدادات الدبلجة</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="space-y-3">
                    <label className="text-sm font-semibold text-muted-foreground">مزود الأصوات (TTS)</label>
                    <Select disabled={isLoadingModels || showOverlay} value={selectedModel} onValueChange={setSelectedModel}>
                      <SelectTrigger className="w-full h-12 bg-black/40 border-white/10">
                        <SelectValue placeholder="اختر المزود..." />
                      </SelectTrigger>
                      <SelectContent>
                        {modelsData?.models.map(m => (
                          <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-3">
                    <label className="text-sm font-semibold text-muted-foreground">الصوت</label>
                    <Select disabled={!selectedModel || showOverlay} value={selectedVoice} onValueChange={setSelectedVoice}>
                      <SelectTrigger className="w-full h-12 bg-black/40 border-white/10">
                        <SelectValue placeholder="اختر الصوت..." />
                      </SelectTrigger>
                      <SelectContent>
                        {currentModelObj?.voices.map(v => (
                          <SelectItem key={v.id} value={v.id}>
                            <div className="flex items-center gap-4">
                              <span>{v.name}</span>
                              <span className="text-xs text-muted-foreground">({v.gender})</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-4 flex flex-col justify-center">
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-semibold text-muted-foreground">سرعة الصوت</label>
                      <span className="text-sm font-mono bg-black/40 px-2 py-1 rounded text-primary">{speed.toFixed(1)}x</span>
                    </div>
                    <Slider
                      disabled={showOverlay}
                      value={[speed]} min={1.0} max={5.0} step={0.1}
                      onValueChange={([v]) => setSpeed(v)}
                      className="cursor-pointer"
                    />
                  </div>
                </div>

                <div className="mt-6 pt-5 border-t border-border/40">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-2 text-muted-foreground shrink-0">
                      <Clock className="w-4 h-4 text-primary" />
                      <span className="text-sm font-semibold">مدة المقطع:</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        disabled={showOverlay}
                        onClick={() => setSegmentDuration(20)}
                        className={`px-5 py-2 rounded-xl text-sm font-bold transition-all duration-200 border ${
                          segmentDuration === 20
                            ? 'bg-primary text-primary-foreground border-primary shadow-[0_0_16px_hsl(var(--primary)/0.4)]'
                            : 'bg-black/30 text-muted-foreground border-white/10 hover:border-primary/40 hover:text-foreground'
                        }`}
                      >
                        ٢٠ ثانية
                      </button>
                      <button
                        disabled={showOverlay}
                        onClick={() => setSegmentDuration(60)}
                        className={`px-5 py-2 rounded-xl text-sm font-bold transition-all duration-200 border ${
                          segmentDuration === 60
                            ? 'bg-primary text-primary-foreground border-primary shadow-[0_0_16px_hsl(var(--primary)/0.4)]'
                            : 'bg-black/30 text-muted-foreground border-white/10 hover:border-primary/40 hover:text-foreground'
                        }`}
                      >
                        دقيقة كاملة
                      </button>
                    </div>
                    <span className="text-xs text-muted-foreground/70 mr-1">
                      {segmentDuration === 20
                        ? 'استجابة أسرع — مناسب للمعاينة'
                        : 'ترجمة أكثر سياقاً — مناسب للمشاهدة الكاملة'}
                    </span>
                  </div>
                </div>

                <div className="mt-8 flex justify-center">
                  <Button
                    size="lg"
                    onClick={handleInitialPlay}
                    disabled={showOverlay || !selectedModel || !selectedVoice}
                    className="w-full md:w-auto px-16 h-16 rounded-2xl text-xl font-display font-bold shadow-[0_0_40px_hsl(var(--primary)/0.3)] hover:shadow-[0_0_60px_hsl(var(--primary)/0.5)] transition-all duration-300 hover:-translate-y-1 active:translate-y-0"
                  >
                    {showOverlay ? (
                      <><RefreshCcw className="w-6 h-6 ml-3 animate-spin" />جاري المعالجة...</>
                    ) : (
                      <><Play className="w-6 h-6 ml-3 fill-current" />بدء التشغيل والدبلجة</>
                    )}
                  </Button>
                </div>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {!isValid && url.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center mt-8 text-destructive">
            الرابط المدخل غير صحيح، يرجى إدخال رابط يوتيوب صالح.
          </motion.div>
        )}
      </div>
    </div>
  );
}
