-- ВРЕМЕННОЕ ОТКЛЮЧЕНИЕ RLS ДЛЯ СИСТЕМЫ ЧЕЛЛЕНДЖЕЙ
-- Выполните этот скрипт в Supabase SQL Editor

-- Отключаем RLS для таблицы weekly_challenges
ALTER TABLE weekly_challenges DISABLE ROW LEVEL SECURITY;

-- Отключаем RLS для таблицы steps_tracking  
ALTER TABLE steps_tracking DISABLE ROW LEVEL SECURITY;

-- Проверяем что RLS отключен
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables 
WHERE tablename IN ('weekly_challenges', 'steps_tracking');

-- Если нужно будет включить обратно (НЕ ВЫПОЛНЯЙТЕ СЕЙЧАС):
-- ALTER TABLE weekly_challenges ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE steps_tracking ENABLE ROW LEVEL SECURITY; 