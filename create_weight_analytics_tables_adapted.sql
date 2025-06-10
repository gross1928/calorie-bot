-- 📊 АДАПТИРОВАННАЯ SQL СХЕМА ДЛЯ СИСТЕМЫ ЕЖЕНЕДЕЛЬНОЙ АНАЛИТИКИ ВЕСА
-- Совместимо с существующей базой данных

-- Таблица подписок пользователей (адаптировано под существующую схему)
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    plan VARCHAR(20) NOT NULL DEFAULT 'free', -- 'free', 'premium', 'vip'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE, -- NULL для бесплатной подписки
    payment_id VARCHAR(255), -- ID платежа для отслеживания
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id)
);

-- Таблица ежедневного использования (адаптировано)
CREATE TABLE IF NOT EXISTS public.daily_usage (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    photos_analyzed INTEGER NOT NULL DEFAULT 0,
    ai_questions_asked INTEGER NOT NULL DEFAULT 0,
    workouts_generated INTEGER NOT NULL DEFAULT 0,
    manual_entries INTEGER NOT NULL DEFAULT 0, -- ручной ввод еды
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, date)
);

-- Таблица истории веса (расширение существующих данных)
CREATE TABLE IF NOT EXISTS public.weight_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    weight_kg DECIMAL(5,2) NOT NULL, -- Совместимо с profiles.weight_kg
    notes TEXT, -- Дополнительные заметки
    source VARCHAR(20) DEFAULT 'manual', -- 'manual', 'profile_update', 'weekly_check'
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Таблица для напоминаний о весе
CREATE TABLE IF NOT EXISTS public.weight_reminders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reminder_date DATE NOT NULL,
    reminder_type VARCHAR(20) DEFAULT 'weekly', -- 'weekly', 'monthly', 'custom'
    is_sent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, reminder_date)
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON public.user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan ON public.user_subscriptions(plan);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_active ON public.user_subscriptions(is_active);

CREATE INDEX IF NOT EXISTS idx_daily_usage_user_id ON public.daily_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON public.daily_usage(date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON public.daily_usage(user_id, date);

CREATE INDEX IF NOT EXISTS idx_weight_history_user_id ON public.weight_history(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_history_recorded_at ON public.weight_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_weight_history_user_recorded ON public.weight_history(user_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_weight_reminders_user_id ON public.weight_reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_reminders_date ON public.weight_reminders(reminder_date);

-- Функция для увеличения счетчика использования (адаптированная)
CREATE OR REPLACE FUNCTION increment_usage(
    p_user_id BIGINT,
    p_date DATE,
    p_field VARCHAR(50)
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO public.daily_usage (user_id, date, photos_analyzed, ai_questions_asked, workouts_generated, manual_entries)
    VALUES (p_user_id, p_date, 
            CASE WHEN p_field = 'photos_analyzed' THEN 1 ELSE 0 END,
            CASE WHEN p_field = 'ai_questions_asked' THEN 1 ELSE 0 END,
            CASE WHEN p_field = 'workouts_generated' THEN 1 ELSE 0 END,
            CASE WHEN p_field = 'manual_entries' THEN 1 ELSE 0 END)
    ON CONFLICT (user_id, date) 
    DO UPDATE SET
        photos_analyzed = CASE WHEN p_field = 'photos_analyzed' THEN daily_usage.photos_analyzed + 1 ELSE daily_usage.photos_analyzed END,
        ai_questions_asked = CASE WHEN p_field = 'ai_questions_asked' THEN daily_usage.ai_questions_asked + 1 ELSE daily_usage.ai_questions_asked END,
        workouts_generated = CASE WHEN p_field = 'workouts_generated' THEN daily_usage.workouts_generated + 1 ELSE daily_usage.workouts_generated END,
        manual_entries = CASE WHEN p_field = 'manual_entries' THEN daily_usage.manual_entries + 1 ELSE daily_usage.manual_entries END,
        updated_at = timezone('utc'::text, now());
END;
$$ LANGUAGE plpgsql;

-- Функция для получения профиля пользователя по telegram_id (адаптированная)
CREATE OR REPLACE FUNCTION get_user_profile_by_telegram_id(p_telegram_id BIGINT)
RETURNS TABLE(
    id BIGINT,
    telegram_id BIGINT,
    username TEXT,
    first_name TEXT,
    gender TEXT,
    age INT,
    height_cm INT,
    weight_kg NUMERIC(5,2),
    target_weight_kg NUMERIC,
    goal TEXT,
    timeframe_months INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.telegram_id,
        p.username,
        p.first_name,
        p.gender,
        p.age,
        p.height_cm,
        p.weight_kg,
        p.target_weight_kg,
        p.goal,
        p.timeframe_months
    FROM public.profiles p
    WHERE p.telegram_id = p_telegram_id;
END;
$$ LANGUAGE plpgsql;

-- Функция для получения статистики использования (адаптированная)
CREATE OR REPLACE FUNCTION get_user_usage_stats(p_user_id BIGINT)
RETURNS TABLE(
    today_photos INTEGER,
    today_questions INTEGER,
    today_manual_entries INTEGER,
    month_workouts INTEGER,
    total_weight_records INTEGER,
    last_weight DECIMAL(5,2),
    weight_trend VARCHAR(20),
    current_weight DECIMAL(5,2)
) AS $$
DECLARE
    this_month_start DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    today DATE := CURRENT_DATE;
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(du.photos_analyzed, 0) as today_photos,
        COALESCE(du.ai_questions_asked, 0) as today_questions,
        COALESCE(du.manual_entries, 0) as today_manual_entries,
        COALESCE(monthly.total_workouts, 0)::INTEGER as month_workouts,
        COALESCE(weight_stats.total_records, 0)::INTEGER as total_weight_records,
        weight_stats.last_weight,
        weight_stats.trend,
        profile_weight.current_weight
    FROM (
        SELECT p_user_id as user_id
    ) u
    LEFT JOIN public.daily_usage du ON du.user_id = u.user_id AND du.date = today
    LEFT JOIN (
        SELECT 
            user_id,
            SUM(workouts_generated) as total_workouts
        FROM public.daily_usage 
        WHERE user_id = p_user_id 
        AND date >= this_month_start
        GROUP BY user_id
    ) monthly ON monthly.user_id = u.user_id
    LEFT JOIN (
        SELECT 
            user_id,
            COUNT(*) as total_records,
            (SELECT weight_kg FROM public.weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1) as last_weight,
            CASE 
                WHEN COUNT(*) < 2 THEN 'insufficient_data'
                WHEN (SELECT weight_kg FROM public.weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1) > 
                     (SELECT weight_kg FROM public.weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1 OFFSET 1) 
                THEN 'increasing'
                WHEN (SELECT weight_kg FROM public.weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1) < 
                     (SELECT weight_kg FROM public.weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1 OFFSET 1) 
                THEN 'decreasing'
                ELSE 'stable'
            END as trend
        FROM public.weight_history 
        WHERE user_id = p_user_id
        GROUP BY user_id
    ) weight_stats ON weight_stats.user_id = u.user_id
    LEFT JOIN (
        SELECT 
            id as user_id,
            weight_kg as current_weight
        FROM public.profiles
        WHERE id = p_user_id
    ) profile_weight ON profile_weight.user_id = u.user_id;
END;
$$ LANGUAGE plpgsql;

-- Включаем Row Level Security
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weight_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weight_reminders ENABLE ROW LEVEL SECURITY;

-- Простые политики для полного доступа (совместимо с существующим подходом)
CREATE POLICY "Allow public all operations on user_subscriptions" 
ON public.user_subscriptions FOR ALL 
TO public 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Allow public all operations on daily_usage" 
ON public.daily_usage FOR ALL 
TO public 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Allow public all operations on weight_history" 
ON public.weight_history FOR ALL 
TO public 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Allow public all operations on weight_reminders" 
ON public.weight_reminders FOR ALL 
TO public 
USING (true) 
WITH CHECK (true);

-- Комментарии к таблицам
COMMENT ON TABLE public.user_subscriptions IS 'Подписки пользователей (free, premium, vip) - адаптировано под существующую схему';
COMMENT ON TABLE public.daily_usage IS 'Ежедневная статистика использования функций - адаптировано';
COMMENT ON TABLE public.weight_history IS 'История записей веса пользователей - дополняет profiles.weight_kg';
COMMENT ON TABLE public.weight_reminders IS 'Напоминания о записи веса';

COMMENT ON COLUMN public.weight_history.weight_kg IS 'Вес в килограммах (совместимо с profiles.weight_kg)';
COMMENT ON COLUMN public.weight_history.source IS 'Источник записи: manual, profile_update, weekly_check';
COMMENT ON COLUMN public.user_subscriptions.expires_at IS 'Дата истечения подписки (NULL для бесплатной)';

-- Функция для автоматического копирования веса из profiles в weight_history при обновлении
CREATE OR REPLACE FUNCTION sync_weight_to_history()
RETURNS TRIGGER AS $$
BEGIN
    -- Если вес изменился, добавляем запись в историю
    IF OLD.weight_kg IS DISTINCT FROM NEW.weight_kg AND NEW.weight_kg IS NOT NULL THEN
        INSERT INTO public.weight_history (user_id, weight_kg, source, recorded_at)
        VALUES (NEW.id, NEW.weight_kg, 'profile_update', timezone('utc'::text, now()));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Создаем триггер для автоматической синхронизации
DROP TRIGGER IF EXISTS trigger_sync_weight_to_history ON public.profiles;
CREATE TRIGGER trigger_sync_weight_to_history
    AFTER UPDATE OF weight_kg ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION sync_weight_to_history();

-- Добавляем колонку для уведомлений, если ее еще нет
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN DEFAULT true;

-- Создаем тестовые подписки для разработки (закомментировано для безопасности)
/*
INSERT INTO public.user_subscriptions (user_id, plan, is_active) 
SELECT id, 'vip', true FROM public.profiles WHERE telegram_id = YOUR_TELEGRAM_ID
ON CONFLICT (user_id) DO NOTHING;
*/

-- Сообщение об успешном создании
SELECT 'Система еженедельной аналитики веса успешно адаптирована под существующую схему БД! 🎉' as result; 