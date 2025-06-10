-- 📊 SQL СХЕМА ДЛЯ СИСТЕМЫ ЕЖЕНЕДЕЛЬНОЙ АНАЛИТИКИ ВЕСА

-- Таблица подписок пользователей
CREATE TABLE IF NOT EXISTS user_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    plan VARCHAR(20) NOT NULL DEFAULT 'free', -- 'free', 'premium', 'vip'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE, -- NULL для бесплатной подписки
    payment_id VARCHAR(255), -- ID платежа для отслеживания
    UNIQUE(user_id)
);

-- Таблица ежедневного использования
CREATE TABLE IF NOT EXISTS daily_usage (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    date DATE NOT NULL,
    photos_analyzed INTEGER NOT NULL DEFAULT 0,
    ai_questions_asked INTEGER NOT NULL DEFAULT 0,
    workouts_generated INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, date)
);

-- Таблица истории веса
CREATE TABLE IF NOT EXISTS weight_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    weight DECIMAL(5,2) NOT NULL, -- Вес в кг (например: 75.50)
    notes TEXT, -- Дополнительные заметки
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Таблица для напоминаний
CREATE TABLE IF NOT EXISTS weight_reminders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    reminder_date DATE NOT NULL,
    is_sent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, reminder_date)
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan ON user_subscriptions(plan);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_active ON user_subscriptions(is_active);

CREATE INDEX IF NOT EXISTS idx_daily_usage_user_id ON daily_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);

CREATE INDEX IF NOT EXISTS idx_weight_history_user_id ON weight_history(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_history_recorded_at ON weight_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_weight_history_user_recorded ON weight_history(user_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_weight_reminders_user_id ON weight_reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_reminders_date ON weight_reminders(reminder_date);

-- Функция для увеличения счетчика использования
CREATE OR REPLACE FUNCTION increment_usage(
    p_user_id BIGINT,
    p_date DATE,
    p_field VARCHAR(50)
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO daily_usage (user_id, date, photos_analyzed, ai_questions_asked, workouts_generated)
    VALUES (p_user_id, p_date, 
            CASE WHEN p_field = 'photos_analyzed' THEN 1 ELSE 0 END,
            CASE WHEN p_field = 'ai_questions_asked' THEN 1 ELSE 0 END,
            CASE WHEN p_field = 'workouts_generated' THEN 1 ELSE 0 END)
    ON CONFLICT (user_id, date) 
    DO UPDATE SET
        photos_analyzed = CASE WHEN p_field = 'photos_analyzed' THEN daily_usage.photos_analyzed + 1 ELSE daily_usage.photos_analyzed END,
        ai_questions_asked = CASE WHEN p_field = 'ai_questions_asked' THEN daily_usage.ai_questions_asked + 1 ELSE daily_usage.ai_questions_asked END,
        workouts_generated = CASE WHEN p_field = 'workouts_generated' THEN daily_usage.workouts_generated + 1 ELSE daily_usage.workouts_generated END,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Функция для получения статистики использования
CREATE OR REPLACE FUNCTION get_user_usage_stats(p_user_id BIGINT)
RETURNS TABLE(
    today_photos INTEGER,
    today_questions INTEGER,
    month_workouts INTEGER,
    total_weight_records INTEGER,
    last_weight DECIMAL(5,2),
    weight_trend VARCHAR(20)
) AS $$
DECLARE
    this_month_start DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    today DATE := CURRENT_DATE;
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(du.photos_analyzed, 0) as today_photos,
        COALESCE(du.ai_questions_asked, 0) as today_questions,
        COALESCE(monthly.total_workouts, 0)::INTEGER as month_workouts,
        COALESCE(weight_stats.total_records, 0)::INTEGER as total_weight_records,
        weight_stats.last_weight,
        weight_stats.trend
    FROM (
        SELECT p_user_id as user_id
    ) u
    LEFT JOIN daily_usage du ON du.user_id = u.user_id AND du.date = today
    LEFT JOIN (
        SELECT 
            user_id,
            SUM(workouts_generated) as total_workouts
        FROM daily_usage 
        WHERE user_id = p_user_id 
        AND date >= this_month_start
        GROUP BY user_id
    ) monthly ON monthly.user_id = u.user_id
    LEFT JOIN (
        SELECT 
            user_id,
            COUNT(*) as total_records,
            (SELECT weight FROM weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1) as last_weight,
            CASE 
                WHEN COUNT(*) < 2 THEN 'insufficient_data'
                WHEN (SELECT weight FROM weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1) > 
                     (SELECT weight FROM weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1 OFFSET 1) 
                THEN 'increasing'
                WHEN (SELECT weight FROM weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1) < 
                     (SELECT weight FROM weight_history WHERE user_id = p_user_id ORDER BY recorded_at DESC LIMIT 1 OFFSET 1) 
                THEN 'decreasing'
                ELSE 'stable'
            END as trend
        FROM weight_history 
        WHERE user_id = p_user_id
        GROUP BY user_id
    ) weight_stats ON weight_stats.user_id = u.user_id;
END;
$$ LANGUAGE plpgsql;

-- Политики безопасности (RLS)
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_reminders ENABLE ROW LEVEL SECURITY;

-- Политики для пользователей (доступ только к своим данным)
CREATE POLICY "Users can view own subscription" ON user_subscriptions
    FOR SELECT USING (user_id = current_user_id());

CREATE POLICY "Users can view own usage" ON daily_usage
    FOR SELECT USING (user_id = current_user_id());

CREATE POLICY "Users can view own weight history" ON weight_history
    FOR SELECT USING (user_id = current_user_id());

CREATE POLICY "Users can insert own weight records" ON weight_history
    FOR INSERT WITH CHECK (user_id = current_user_id());

-- Комментарии к таблицам
COMMENT ON TABLE user_subscriptions IS 'Подписки пользователей (free, premium, vip)';
COMMENT ON TABLE daily_usage IS 'Ежедневная статистика использования функций';
COMMENT ON TABLE weight_history IS 'История записей веса пользователей';
COMMENT ON TABLE weight_reminders IS 'Напоминания о записи веса';

COMMENT ON COLUMN weight_history.weight IS 'Вес в килограммах с точностью до 2 знаков после запятой';
COMMENT ON COLUMN user_subscriptions.expires_at IS 'Дата истечения подписки (NULL для бесплатной)';
COMMENT ON COLUMN daily_usage.photos_analyzed IS 'Количество проанализированных фото за день';
COMMENT ON COLUMN daily_usage.ai_questions_asked IS 'Количество вопросов ИИ за день';
COMMENT ON COLUMN daily_usage.workouts_generated IS 'Количество сгенерированных программ тренировок за день';

-- Тестовые данные для разработки (УДАЛИТЬ В ПРОДАКШЕНЕ!)
-- INSERT INTO user_subscriptions (user_id, plan, is_active) VALUES 
-- (123456789, 'vip', true),
-- (987654321, 'premium', true),
-- (555666777, 'free', true);

-- INSERT INTO weight_history (user_id, weight, recorded_at) VALUES
-- (123456789, 75.5, NOW() - INTERVAL '7 days'),
-- (123456789, 75.2, NOW() - INTERVAL '14 days'),
-- (123456789, 75.8, NOW() - INTERVAL '21 days'); 