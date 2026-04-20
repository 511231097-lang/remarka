"use client";

import { motion } from "motion/react";
import {
  Calendar,
  Mail,
  Crown,
  Check,
  Sparkles,
  Sun,
  Moon,
} from "lucide-react";
import { currentUser } from "@/lib/mockData";
import Link from "next/link";
import { useTheme } from "@/lib/ThemeContext";
import { UserAvatar } from "@/components/UserAvatar";

interface ProfileProps {
  authUser: {
    name: string | null;
    email: string | null;
    image: string | null;
  };
}

export function Profile({ authUser }: ProfileProps) {
  const displayName = authUser.name?.trim() || currentUser.name;
  const displayEmail = authUser.email?.trim() || currentUser.email;
  const showPlans = false;
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Profile Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <div className="flex flex-col sm:flex-row items-center sm:items-center gap-6 mb-8">
            <UserAvatar
              name={displayName}
              image={authUser.image}
              size="md"
              fallbackTextClassName="text-4xl"
            />
            <div className="flex-1 text-center sm:text-left">
              <h1 className="text-4xl text-foreground mb-2 break-words">
                {displayName}
              </h1>
              <div className="flex items-center justify-center sm:justify-start gap-2 text-muted-foreground mb-4">
                <Mail className="w-4 h-4" />
                <span className="break-all">{displayEmail}</span>
              </div>
              <div className="flex items-center justify-center sm:justify-start gap-2 text-sm text-muted-foreground">
                <Calendar className="w-4 h-4" />
                <span>На платформе с марта 2026</span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Current Plan */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="mb-12"
        >
          <h2 className="text-2xl text-foreground mb-6">Тарифный план</h2>

          <div className="p-6 bg-card border border-border rounded-lg mb-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                {currentUser.plan.type === "plus" && (
                  <Crown className="w-6 h-6 text-primary" />
                )}
                <div>
                  <h3 className="text-lg text-foreground">
                    Тариф {currentUser.plan.name}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {currentUser.plan.type === "plus"
                      ? "Безлимитные возможности"
                      : "Базовые функции"}
                  </p>
                </div>
              </div>
              {currentUser.plan.type === "basic" && (
                <Link
                  href="/plans"
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  Обновить
                </Link>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-primary" />
                <span className="text-muted-foreground">
                  {currentUser.plan.features.maxBooks === "unlimited"
                    ? "Безлимитно книг"
                    : `До ${currentUser.plan.features.maxBooks} книг`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {currentUser.plan.features.advancedAnalysis ? (
                  <Check className="w-4 h-4 text-primary" />
                ) : (
                  <div className="w-4 h-4" />
                )}
                <span
                  className={
                    currentUser.plan.features.advancedAnalysis
                      ? "text-muted-foreground"
                      : "text-muted-foreground/50"
                  }
                >
                  Расширенный анализ
                </span>
              </div>
              <div className="flex items-center gap-2">
                {currentUser.plan.features.exportFeatures ? (
                  <Check className="w-4 h-4 text-primary" />
                ) : (
                  <div className="w-4 h-4" />
                )}
                <span
                  className={
                    currentUser.plan.features.exportFeatures
                      ? "text-muted-foreground"
                      : "text-muted-foreground/50"
                  }
                >
                  Экспорт анализов
                </span>
              </div>
            </div>
          </div>

          {showPlans && currentUser.plan.type === "basic" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
            >
              <div className="p-6 bg-card border border-border rounded-lg">
                <h4 className="text-foreground mb-2">Базовый</h4>
                <div className="mb-4">
                  <span className="text-3xl text-foreground">Бесплатно</span>
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground mb-6">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary" />
                    До 5 книг
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary" />
                    Базовый анализ
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary" />
                    Доступ к каталогу
                  </li>
                </ul>
                <button
                  disabled
                  className="w-full px-4 py-2 bg-secondary text-muted-foreground rounded-lg cursor-not-allowed"
                >
                  Текущий план
                </button>
              </div>

              <div className="p-6 bg-gradient-to-br from-primary/10 to-primary/5 border-2 border-primary rounded-lg relative">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-primary text-primary-foreground rounded-full text-xs">
                  Рекомендуем
                </div>
                <h4 className="text-foreground mb-2 flex items-center gap-2">
                  <Crown className="w-5 h-5 text-primary" />
                  Плюс
                </h4>
                <div className="mb-4">
                  <span className="text-3xl text-foreground">₽399</span>
                  <span className="text-sm text-muted-foreground">/месяц</span>
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground mb-6">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary" />
                    Безлимитно книг
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary" />
                    Расширенный анализ
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary" />
                    Приоритетная обработка
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary" />
                    Экспорт в PDF и Markdown
                  </li>
                </ul>
                <button className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
                  Обновить план
                </button>
              </div>
            </motion.div>
          )}
        </motion.div>

        {/* Settings Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <h2 className="text-2xl text-foreground mb-6">Настройки</h2>

          <div className="space-y-4">
            <div className="p-6 bg-card border border-border rounded-lg">
              <h3 className="text-foreground mb-2">Внешний вид</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Выберите тему оформления приложения
              </p>
              <button
                onClick={toggleTheme}
                className="flex items-center gap-3 px-4 py-3 bg-secondary rounded-lg hover:bg-secondary/80 transition-colors w-full"
              >
                {theme === "light" ? (
                  <>
                    <Moon className="w-5 h-5 text-foreground" />
                    <div className="flex-1 text-left">
                      <p className="text-sm text-foreground">Тёмная тема</p>
                      <p className="text-xs text-muted-foreground">
                        Переключить на тёмное оформление
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <Sun className="w-5 h-5 text-foreground" />
                    <div className="flex-1 text-left">
                      <p className="text-sm text-foreground">Светлая тема</p>
                      <p className="text-xs text-muted-foreground">
                        Переключить на светлое оформление
                      </p>
                    </div>
                  </>
                )}
              </button>
            </div>

            <div className="p-6 bg-card border border-border rounded-lg">
              <h3 className="text-foreground mb-2">Аккаунт</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Управление вашим аккаунтом и данными
              </p>
              <button className="text-sm text-destructive hover:underline">
                Удалить аккаунт
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
