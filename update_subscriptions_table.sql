-- 📊 ОБНОВЛЕНИЕ ТАБЛИЦЫ ПОДПИСОК ДЛЯ СИСТЕМЫ ПРОМО

-- Добавляем колонки для промо-системы если их нет
ALTER TABLE public.user_subscriptions 
ADD COLUMN IF NOT EXISTS promo_activated_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS promo_expires_at TIMESTAMP WITH TIME ZONE;

-- Обновим существующие записи для бесплатных пользователей
UPDATE public.user_subscriptions 
SET plan = 'free' 
WHERE plan IS NULL;

-- Создаем индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_promo_expires 
ON public.user_subscriptions(promo_expires_at) 
WHERE promo_expires_at IS NOT NULL;

-- Функция для получения подписки пользователя
CREATE OR REPLACE FUNCTION get_user_subscription_by_telegram_id(p_telegram_id BIGINT)
RETURNS TABLE(
    tier TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    promo_activated_at TIMESTAMP WITH TIME ZONE,
    promo_expires_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        us.plan as tier,
        us.expires_at,
        us.promo_activated_at,
        us.promo_expires_at
    FROM public.user_subscriptions us
    JOIN public.profiles p ON p.id = us.user_id
    WHERE p.telegram_id = p_telegram_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN public.user_subscriptions.promo_activated_at IS 'Время, когда пользователь активировал промо-период';
COMMENT ON COLUMN public.user_subscriptions.promo_expires_at IS 'Время, когда промо-период истекает'; 