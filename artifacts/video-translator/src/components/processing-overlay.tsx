import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, AudioLines, Sparkles, Languages, Mic } from 'lucide-react';

interface ProcessingOverlayProps {
  isVisible: boolean;
  progressText?: string;
}

export function ProcessingOverlay({ isVisible, progressText = "جاري التجهيز..." }: ProcessingOverlayProps) {
  // Determine icon based on text to make it dynamic
  const getIcon = () => {
    if (progressText.includes('صوت')) return <AudioLines className="w-12 h-12 text-primary mb-6 animate-pulse" />;
    if (progressText.includes('ترجمة') || progressText.includes('نص')) return <Languages className="w-12 h-12 text-primary mb-6 animate-pulse" />;
    if (progressText.includes('توليد') || progressText.includes('عربي')) return <Mic className="w-12 h-12 text-primary mb-6 animate-pulse" />;
    return <Sparkles className="w-12 h-12 text-primary mb-6 animate-pulse" />;
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
          animate={{ opacity: 1, backdropFilter: "blur(12px)" }}
          exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
          transition={{ duration: 0.4 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
        >
          <div className="flex flex-col items-center max-w-md w-full p-8 rounded-3xl bg-card/50 border border-white/5 shadow-2xl relative overflow-hidden">
            {/* Background glowing orb */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-primary/20 rounded-full blur-[80px] pointer-events-none" />
            
            <div className="relative z-10 flex flex-col items-center">
              {getIcon()}
              
              <h2 className="text-3xl font-display font-bold text-foreground mb-4 animate-pulse-glow">
                ⏳ جاري المعالجة...
              </h2>
              
              <div className="flex items-center gap-3 text-muted-foreground bg-black/40 px-6 py-3 rounded-full border border-white/10">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="font-medium">{progressText}</span>
              </div>
              
              <p className="mt-8 text-sm text-center text-muted-foreground max-w-[280px]">
                يرجى الانتظار، لا يمكن التفاعل مع الصفحة حتى تكتمل معالجة المقطع المختار.
              </p>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
