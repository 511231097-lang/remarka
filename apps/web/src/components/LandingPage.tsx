"use client";

import { motion } from "motion/react";
import { BookOpen, Sparkles, Network, Quote } from "lucide-react";
import Link from "next/link";

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <motion.section
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8 }}
        className="relative min-h-screen flex items-center justify-center px-6"
      >
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.6 }}
          >
            <h1 className="text-4xl sm:text-6xl md:text-7xl mb-6 text-foreground" style={{ fontWeight: 600, lineHeight: 1.1 }}>
              Понимайте<br />литературу глубже
            </h1>
            <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto px-4">
              Анализируйте художественные тексты через структурированные инсайты о персонажах, темах и событиях
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.6 }}
          >
            <Link
              href="/signin"
              className="inline-block px-8 py-4 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
            >
              Начать изучение
            </Link>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6, duration: 0.8 }}
            className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 text-left"
          >
            <div className="space-y-3">
              <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-foreground">Глубокий анализ</h3>
              <p className="text-muted-foreground text-sm">
                Структурированные инсайты о персонажах, мотивациях и развитии сюжета
              </p>
            </div>

            <div className="space-y-3">
              <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
                <Network className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-foreground">Связи и контекст</h3>
              <p className="text-muted-foreground text-sm">
                Исследуйте взаимосвязи между темами, персонажами и событиями
              </p>
            </div>

            <div className="space-y-3">
              <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
                <Quote className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-foreground">Цитаты как доказательства</h3>
              <p className="text-muted-foreground text-sm">
                Короткие фрагменты текста подтверждают каждый инсайт
              </p>
            </div>
          </motion.div>
        </div>
      </motion.section>
    </div>
  );
}
