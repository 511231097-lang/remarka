"use client";

import { motion } from "motion/react";
import { Crown, Check, Sparkles } from "lucide-react";
import { currentUser, plans } from "@/lib/mockData";

export function Plans() {
  const isPlusUser = currentUser.plan.type === "plus";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="text-4xl text-foreground mb-4">Выберите тарифный план</h1>
          <p className="text-xl text-muted-foreground">
            Получите больше возможностей для анализа литературы
          </p>
        </motion.div>

        {/* Plans Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          {/* Basic Plan */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-8 bg-card border border-border rounded-lg"
          >
            <h2 className="text-2xl text-foreground mb-2">Базовый</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Для начала работы с анализом
            </p>

            <div className="mb-6">
              <span className="text-5xl text-foreground">Бесплатно</span>
            </div>

            <ul className="space-y-4 mb-8">
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">До 5 книг</p>
                  <p className="text-sm text-muted-foreground">
                    Загрузите до пяти произведений
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">Публичные книги</p>
                  <p className="text-sm text-muted-foreground">
                    Делитесь анализами с сообществом
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">Базовый анализ</p>
                  <p className="text-sm text-muted-foreground">
                    Персонажи, темы, события и цитаты
                  </p>
                </div>
              </li>
            </ul>

            {!isPlusUser ? (
              <button
                disabled
                className="w-full px-6 py-3 bg-secondary text-muted-foreground rounded-lg cursor-not-allowed"
              >
                Текущий план
              </button>
            ) : (
              <button className="w-full px-6 py-3 border border-border text-foreground rounded-lg hover:bg-secondary transition-colors">
                Перейти на Базовый
              </button>
            )}
          </motion.div>

          {/* Plus Plan */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="p-8 bg-gradient-to-br from-primary/10 to-primary/5 border-2 border-primary rounded-lg relative"
          >
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-primary text-primary-foreground rounded-full text-sm flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Рекомендуем
            </div>

            <div className="flex items-center gap-2 mb-2">
              <Crown className="w-6 h-6 text-primary" />
              <h2 className="text-2xl text-foreground">Плюс</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Для серьёзного изучения литературы
            </p>

            <div className="mb-6">
              <span className="text-5xl text-foreground">₽399</span>
              <span className="text-lg text-muted-foreground">/месяц</span>
            </div>

            <ul className="space-y-4 mb-8">
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">Безлимитно книг</p>
                  <p className="text-sm text-muted-foreground">
                    Загружайте сколько угодно произведений
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">Приватные книги</p>
                  <p className="text-sm text-muted-foreground">
                    Создавайте личные анализы для себя
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">Расширенный анализ</p>
                  <p className="text-sm text-muted-foreground">
                    Глубинные инсайты и связи между элементами
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">Экспорт анализов</p>
                  <p className="text-sm text-muted-foreground">
                    Сохраняйте в PDF и Markdown
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">Приоритетная поддержка</p>
                  <p className="text-sm text-muted-foreground">
                    Быстрые ответы на ваши вопросы
                  </p>
                </div>
              </li>
            </ul>

            {isPlusUser ? (
              <button
                disabled
                className="w-full px-6 py-3 bg-primary/20 text-primary rounded-lg cursor-not-allowed"
              >
                Текущий план
              </button>
            ) : (
              <button className="w-full px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
                Обновить до Плюс
              </button>
            )}
          </motion.div>
        </div>

        {/* Features Comparison */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <h2 className="text-2xl text-foreground mb-6">Сравнение тарифов</h2>

          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary">
                <tr>
                  <th className="text-left p-4 text-foreground">Функция</th>
                  <th className="text-center p-4 text-foreground">Базовый</th>
                  <th className="text-center p-4 text-foreground">Плюс</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="p-4 text-foreground">Количество книг</td>
                  <td className="p-4 text-center text-muted-foreground">До 5</td>
                  <td className="p-4 text-center text-foreground">Безлимитно</td>
                </tr>
                <tr>
                  <td className="p-4 text-foreground">Приватные книги</td>
                  <td className="p-4 text-center">
                    <span className="text-muted-foreground">—</span>
                  </td>
                  <td className="p-4 text-center">
                    <Check className="w-5 h-5 text-primary mx-auto" />
                  </td>
                </tr>
                <tr>
                  <td className="p-4 text-foreground">Базовый анализ</td>
                  <td className="p-4 text-center">
                    <Check className="w-5 h-5 text-primary mx-auto" />
                  </td>
                  <td className="p-4 text-center">
                    <Check className="w-5 h-5 text-primary mx-auto" />
                  </td>
                </tr>
                <tr>
                  <td className="p-4 text-foreground">Расширенный анализ</td>
                  <td className="p-4 text-center">
                    <span className="text-muted-foreground">—</span>
                  </td>
                  <td className="p-4 text-center">
                    <Check className="w-5 h-5 text-primary mx-auto" />
                  </td>
                </tr>
                <tr>
                  <td className="p-4 text-foreground">Экспорт анализов</td>
                  <td className="p-4 text-center">
                    <span className="text-muted-foreground">—</span>
                  </td>
                  <td className="p-4 text-center">
                    <Check className="w-5 h-5 text-primary mx-auto" />
                  </td>
                </tr>
                <tr>
                  <td className="p-4 text-foreground">Поддержка</td>
                  <td className="p-4 text-center text-muted-foreground">Базовая</td>
                  <td className="p-4 text-center text-foreground">Приоритетная</td>
                </tr>
              </tbody>
            </table>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
