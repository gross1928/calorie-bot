-- Создание таблицы для отслеживания ежедневного использования
CREATE TABLE IF NOT EXISTS public.daily_usage (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    date DATE NOT NULL,
    photos_processed INTEGER DEFAULT 0,
    ai_questions INTEGER DEFAULT 0,
    meal_logs INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(telegram_id, date)
);

-- Создание таблицы для отслеживания действий пользователей
CREATE TABLE IF NOT EXISTS public.user_actions (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    data JSONB
);

-- Индексы для производительности
CREATE INDEX IF NOT EXISTS idx_daily_usage_telegram_id ON public.daily_usage(telegram_id);
CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON public.daily_usage(date);
CREATE INDEX IF NOT EXISTS idx_user_actions_telegram_id ON public.user_actions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_user_actions_type ON public.user_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_user_actions_created_at ON public.user_actions(created_at);

-- Включение RLS
ALTER TABLE public.daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_actions ENABLE ROW LEVEL SECURITY;

-- Политики безопасности
CREATE POLICY "Allow public all operations on daily_usage"
ON public.daily_usage FOR ALL
TO public
USING (true);

CREATE POLICY "Allow public all operations on user_actions"
ON public.user_actions FOR ALL
TO public
USING (true);

-- Комментарии к таблицам
COMMENT ON TABLE public.daily_usage IS 'Ежедневное использование функций пользователями';
COMMENT ON COLUMN public.daily_usage.telegram_id IS 'ID пользователя в Telegram';
COMMENT ON COLUMN public.daily_usage.date IS 'Дата использования';
COMMENT ON COLUMN public.daily_usage.photos_processed IS 'Количество обработанных фото за день';
COMMENT ON COLUMN public.daily_usage.ai_questions IS 'Количество вопросов к ИИ за день';
COMMENT ON COLUMN public.daily_usage.meal_logs IS 'Количество записей о еде за день';

COMMENT ON TABLE public.user_actions IS 'Лог действий пользователей';
COMMENT ON COLUMN public.user_actions.telegram_id IS 'ID пользователя в Telegram';
COMMENT ON COLUMN public.user_actions.action_type IS 'Тип действия';
COMMENT ON COLUMN public.user_actions.data IS 'Дополнительные данные о действии'; 