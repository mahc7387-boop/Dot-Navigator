import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AudioLines, Languages, Mic, Download, Sparkles, CheckCircle2 } from 'lucide-react';

export interface PipelineStep {
  id: string;
  label: string;
  percent: number;
  done: boolean;
}

interface PipelineBarProps {
  isVisible: boolean;
  progressText: string;
  segmentLabel: string; // e.g. "0:00 – 0:20"
  done: boolean;
}

function textToPercent(text: string): number {
  if (!text) return 5;
  if (text.includes('تنزيل') || text.includes('استخراج') || text.includes('تجهيز')) return 20;
  if (text.includes('تنقية') || text.includes('تنظيف') || text.includes('صوت')) return 42;
  if (text.includes('نص') || text.includes('Whisper') || text.includes('تحويل')) return 62;
  if (text.includes('ترجمة') || text.includes('GPT')) return 80;
  if (text.includes('توليد') || text.includes('عربي') || text.includes('TTS')) return 92;
  if (text.includes('اكتمل') || text.includes('✅')) return 100;
  return 10;
}

function getIcon(text: string) {
  if (text.includes('نص') || text.includes('تحويل')) return <AudioLines className="w-4 h-4" />;
  if (text.includes('ترجمة')) return <Languages className="w-4 h-4" />;
  if (text.includes('توليد') || text.includes('TTS')) return <Mic className="w-4 h-4" />;
  if (text.includes('تنزيل') || text.includes('استخراج')) return <Download className="w-4 h-4" />;
  if (text.includes('اكتمل') || text.includes('✅')) return <CheckCircle2 className="w-4 h-4" />;
  return <Sparkles className="w-4 h-4" />;
}

export function PipelineBar({ isVisible, progressText, segmentLabel, done }: PipelineBarProps) {
  const [displayPercent, setDisplayPercent] = useState(0);
  const targetPercent = done ? 100 : textToPercent(progressText);

  useEffect(() => {
    if (!isVisible) { setDisplayPercent(0); return; }
    const diff = targetPercent - displayPercent;
    if (Math.abs(diff) < 1) return;
    const step = diff > 0 ? Math.max(1, diff * 0.15) : diff;
    const t = setTimeout(() => setDisplayPercent(p => Math.min(100, Math.max(0, p + step))), 60);
    return () => clearTimeout(t);
  }, [targetPercent, displayPercent, isVisible]);

  // Reset bar on new segment
  useEffect(() => {
    if (isVisible && !done) setDisplayPercent(2);
  }, [segmentLabel]);

  const steps = [
    { label: 'استخراج الصوت', threshold: 20 },
    { label: 'تنقية الصوت', threshold: 42 },
    { label: 'تحويل لنص', threshold: 62 },
    { label: 'ترجمة', threshold: 80 },
    { label: 'توليد صوت', threshold: 92 },
    { label: 'جاهز!', threshold: 100 },
  ];

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          className="fixed bottom-0 left-0 right-0 z-40 px-4 pb-4 pointer-events-none"
        >
          <div className="max-w-3xl mx-auto bg-card/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-4 pointer-events-auto">
            {/* Header row */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <motion.div
                  animate={{ rotate: done ? 0 : 360 }}
                  transition={{ repeat: done ? 0 : Infinity, duration: 2, ease: 'linear' }}
                >
                  {getIcon(progressText)}
                </motion.div>
                <span>معالجة الخلفية</span>
                {segmentLabel && (
                  <span className="font-mono text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                    {segmentLabel}
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground font-mono">
                {Math.round(displayPercent)}%
              </span>
            </div>

            {/* Main progress bar */}
            <div className="relative h-3 bg-black/40 rounded-full overflow-hidden mb-3 border border-white/5">
              {/* Glow shimmer */}
              <motion.div
                className="absolute inset-0 -translate-x-full"
                animate={{ translateX: ['−100%', '200%'] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
                style={{
                  background: 'linear-gradient(90deg, transparent 0%, hsl(var(--primary)/0.4) 50%, transparent 100%)',
                }}
              />
              {/* Fill */}
              <motion.div
                className="h-full rounded-full"
                style={{
                  width: `${displayPercent}%`,
                  background: done
                    ? 'linear-gradient(90deg, hsl(142 76% 36%), hsl(142 76% 46%))'
                    : 'linear-gradient(90deg, hsl(var(--primary)), hsl(var(--primary)/0.7))',
                  boxShadow: done
                    ? '0 0 12px hsl(142 76% 36% / 0.8)'
                    : '0 0 12px hsl(var(--primary)/0.8)',
                  transition: 'width 0.4s ease, background 0.5s ease',
                }}
              />
            </div>

            {/* Step dots */}
            <div className="flex items-center justify-between px-1">
              {steps.map((step, i) => {
                const active = displayPercent >= step.threshold;
                const current = !active && (i === 0 || displayPercent >= steps[i - 1].threshold);
                return (
                  <div key={step.label} className="flex flex-col items-center gap-1 flex-1">
                    <div
                      className="w-2 h-2 rounded-full transition-all duration-500"
                      style={{
                        background: active
                          ? 'hsl(var(--primary))'
                          : current
                          ? 'hsl(var(--primary)/0.5)'
                          : 'hsl(var(--muted-foreground)/0.3)',
                        boxShadow: active ? '0 0 6px hsl(var(--primary))' : 'none',
                        transform: current ? 'scale(1.4)' : 'scale(1)',
                      }}
                    />
                    <span
                      className="text-[9px] leading-tight text-center transition-colors duration-300"
                      style={{ color: active ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground)/0.5)' }}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Current step text */}
            <div className="mt-2 text-center text-xs text-muted-foreground">
              {done ? '✅ اكتمل المقطع، جاري تجهيز التالي...' : progressText || 'جاري المعالجة...'}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
