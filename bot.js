const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./supabaseClient');
const OpenAI = require('openai');
const crypto = require('crypto');
const cron = require('node-cron');
const { USER_WORKOUT_PROGRAMS } = require('./user_workout_programs');

require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!token || !openaiApiKey) {
    throw new Error('Telegram Bot Token or OpenAI API Key is not defined in .env file');
}

// 🤖 Telegram Bot с улучшенной обработкой ошибок
const bot = new TelegramBot(token, {
    polling: false // Отключаем автозапуск, контролируется setupBot()
});

// Обработка ошибок polling
bot.on('polling_error', (error) => {
    logEvent('error', 'Telegram polling error', { 
        error: error.message,
        code: error.code 
    });
});

const openai = new OpenAI({ apiKey: openaiApiKey });

// === 🛡️ КРИТИЧЕСКИ ВАЖНЫЕ МОДУЛИ ===

// 🚨 1. ERROR HANDLING & STABILITY
const withErrorHandling = async (apiCall, fallbackMessage = 'Сервис временно недоступен. Попробуйте позже.') => {
    try {
        return await apiCall();
    } catch (error) {
        console.error('API Error:', error);
        return { success: false, error: fallbackMessage, details: error.message };
    }
};

const withTimeout = (promise, timeoutMs = 30000) => {
    return Promise.race([
        promise,
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
        )
    ]);
};

// 🚫 2. RATE LIMITING (Anti-spam protection)
const userRateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 минута
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 запросов в минуту

const checkRateLimit = (userId) => {
    const now = Date.now();
    const userRequests = userRateLimits.get(userId) || [];
    
    // Удаляем старые запросы
    const recentRequests = userRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
        return false; // Превышен лимит
    }
    
    recentRequests.push(now);
    userRateLimits.set(userId, recentRequests);
    return true; // Можно продолжать
};

// ✅ 3. DATA VALIDATION
const validateUserInput = {
    weight: (value) => {
        const num = parseFloat(value);
        return !isNaN(num) && num > 0 && num < 300;
    },
    height: (value) => {
        const num = parseInt(value);
        return !isNaN(num) && num > 100 && num < 250;
    },
    age: (value) => {
        const num = parseInt(value);
        return !isNaN(num) && num > 0 && num < 120;
    },
    waterAmount: (value) => {
        const num = parseInt(value);
        return !isNaN(num) && num > 0 && num < 5000;
    },
    calories: (value) => {
        const num = parseInt(value);
        return !isNaN(num) && num > 0 && num < 10000;
    },
    name: (value) => {
        return typeof value === 'string' && value.length >= 2 && value.length <= 50 && /^[a-zA-Zа-яА-ЯёЁ\s-]+$/.test(value);
    }
};

// 📝 4. LOGGING SYSTEM
const logEvent = (level, message, meta = {}) => {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        level,
        message,
        ...meta
    };
    
    console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`, meta);
    
    // В продакшене здесь можно добавить отправку в файл или внешний сервис логирования
};

// 🗄️ 5. DATABASE ERROR HANDLING
const withDatabaseErrorHandling = async (operation, fallbackMessage = 'Ошибка базы данных. Попробуйте позже.') => {
    try {
        const result = await operation();
        if (result.error) {
            logEvent('error', 'Database operation failed', { 
                error: result.error.message, 
                code: result.error.code 
            });
            return { success: false, error: fallbackMessage, details: result.error };
        }
        return { success: true, data: result.data };
    } catch (error) {
        logEvent('error', 'Database exception', { error: error.toString() });
        return { success: false, error: fallbackMessage, details: error };
    }
};

// Обработка необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
    logEvent('error', 'Unhandled Rejection', { reason: reason.toString(), promise });
});

process.on('uncaughtException', (error) => {
    logEvent('error', 'Uncaught Exception', { error: error.toString(), stack: error.stack });
});

// 🚀 GRACEFUL SHUTDOWN для Railway
process.on('SIGTERM', () => {
    logEvent('info', 'Received SIGTERM, shutting down gracefully');
    console.log('🔄 Railway перезапускает приложение...');
    
    // Даем время завершить текущие операции
    setTimeout(() => {
        process.exit(0);
    }, 5000);
});

process.on('SIGINT', () => {
    logEvent('info', 'Received SIGINT, shutting down gracefully');
    console.log('🛑 Получен сигнал остановки...');
    process.exit(0);
});

// 📊 6. HEALTH CHECK ENDPOINT
const performHealthCheck = async () => {
    const healthStatus = {
        timestamp: new Date().toISOString(),
        status: 'healthy',
        services: {}
    };

    // Проверка OpenAI
    try {
        await withTimeout(openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 1
        }), 5000);
        healthStatus.services.openai = 'healthy';
    } catch (error) {
        healthStatus.services.openai = 'unhealthy';
        healthStatus.status = 'degraded';
    }

    // Проверка Supabase
    try {
        const { error } = await supabase.from('profiles').select('count').limit(1);
        healthStatus.services.database = error ? 'unhealthy' : 'healthy';
        if (error) healthStatus.status = 'degraded';
    } catch (error) {
        healthStatus.services.database = 'unhealthy';
        healthStatus.status = 'degraded';
    }

    logEvent('info', 'Health check completed', healthStatus);
    return healthStatus;
};

// In-memory states
const registrationState = {};
const manualAddState = {};
const mealConfirmationCache = {};
const workoutPlanState = {};
const nutritionPlanState = {};
const waterInputState = {};
const profileEditState = {};
const challengeStepsState = {};

// Состояние для ожидания вопросов от пользователя
const questionState = {};

// Состояние для анализа медицинских данных
const medicalAnalysisState = {};

// 💎 СИСТЕМА ПОДПИСОК И ЛИМИТОВ
const SUBSCRIPTION_PLANS = {
    free: {
        name: 'Бесплатная',
        daily_photos: 1,
        daily_ai_questions: 3,
        monthly_workouts: 1,
        priority_support: false,
        features: ['Базовый профиль', 'Ручной ввод (до 7 дней)', 'История только 7 дней']
    },
    premium: {
        name: 'Премиум',
        daily_photos: -1,
        daily_ai_questions: 100,
        monthly_workouts: -1,
        priority_support: false,
        price: 199,
        features: [
            'Безлимитный анализ фото',
            'Персональные программы тренировок',
            'Планы питания',
            'Умные напоминания',
            'Ежедневные отчеты',
            'Полная история'
        ]
    },
    vip: {
        name: 'VIP',
        daily_photos: -1,
        daily_ai_questions: -1,
        monthly_workouts: -1,
        priority_support: true,
        price: 349,
        features: [
            'Все из Premium',
            'ИИ-нутрициолог (персональный помощник)',
            'Голосовые сообщения',
            'Анализ медицинских показателей',
            'Еженедельная аналитика веса',
            'Отчеты за день/неделю/месяц',
            'Приоритетная поддержка'
        ]
    }
};

// Получение подписки пользователя (адаптировано под существующую схему)
const getUserSubscription = async (telegramId) => {
    try {
        // Сначала получаем внутренний ID пользователя из profiles
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegramId)
            .single();

        if (profileError || !profile) {
            logEvent('error', 'Profile not found for subscription check', { error: profileError?.toString(), telegramId });
            return { plan: 'free', is_active: true, user_id: null };
        }

        const { data, error } = await supabase
            .from('user_subscriptions')
            .select('*')
            .eq('user_id', profile.id)
            .single();
        
        if (error || !data) {
            // Если подписки нет, создаем бесплатную
            const newSubscription = {
                user_id: profile.id,
                plan: 'free',
                expires_at: null,
                is_active: true
            };
            
            // Создаем запись о подписке
            await supabase
                .from('user_subscriptions')
                .insert(newSubscription)
                .select()
                .single();
            
            return newSubscription;
        }
        
        // Проверяем, не истекла ли подписка
        if (data.expires_at && new Date(data.expires_at) < new Date()) {
            // Подписка истекла, возвращаем к бесплатной
            await supabase
                .from('user_subscriptions')
                .update({ plan: 'free', is_active: false })
                .eq('user_id', profile.id);
            
            return { ...data, plan: 'free', is_active: false };
        }
        
        return data;
        
    } catch (error) {
        logEvent('error', 'Error getting user subscription', { error: error.toString(), telegramId });
        return { plan: 'free', expires_at: null, is_active: true, user_id: null };
    }
};

// Получение использования пользователя за сегодня (адаптировано)
const getTodayUsage = async (telegramId) => {
    try {
        // Сначала получаем внутренний ID пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegramId)
            .single();

        if (profileError || !profile) {
            logEvent('error', 'Profile not found for usage check', { error: profileError?.toString(), telegramId });
            return {
                photos_analyzed: 0,
                ai_questions_asked: 0,
                workouts_generated: 0,
                manual_entries: 0
            };
        }

        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        const { data, error } = await supabase
            .from('daily_usage')
            .select('*')
            .eq('user_id', profile.id)
            .eq('date', today)
            .single();
        
        if (error || !data) {
            // Создаем запись для сегодня
            const newUsage = {
                user_id: profile.id,
                date: today,
                photos_analyzed: 0,
                ai_questions_asked: 0,
                workouts_generated: 0,
                manual_entries: 0
            };
            
            await supabase
                .from('daily_usage')
                .insert(newUsage);
            
            return newUsage;
        }
        
        return data;
        
    } catch (error) {
        logEvent('error', 'Error getting today usage', { error: error.toString(), telegramId });
        return {
            photos_analyzed: 0,
            ai_questions_asked: 0,
            workouts_generated: 0,
            manual_entries: 0
        };
    }
};

// Проверка лимитов для действия (адаптировано)
const checkActionLimit = async (telegramId, action) => {
    try {
        const subscription = await getUserSubscription(telegramId);
        const usage = await getTodayUsage(telegramId);
        const limits = SUBSCRIPTION_PLANS[subscription.plan];
        
        switch (action) {
            case 'photo_analysis':
                if (limits.daily_photos === -1) return { allowed: true }; // безлимит
                if (usage.photos_analyzed >= limits.daily_photos) {
                    return {
                        allowed: false,
                        message: `🚫 Достигнут дневной лимит анализа фото (${limits.daily_photos}/день).\n\n💎 Получите безлимитный доступ с Премиум подпиской за 199₽/месяц!`,
                        upgrade_needed: true
                    };
                }
                break;
                
            case 'ai_question':
                if (limits.daily_ai_questions === -1) return { allowed: true }; // безлимит
                if (usage.ai_questions_asked >= limits.daily_ai_questions) {
                    return {
                        allowed: false,
                        message: `🚫 Достигнут дневной лимит вопросов ИИ (${limits.daily_ai_questions}/день).\n\n💎 Получите безлимитный доступ с Премиум подпиской за 199₽/месяц!`,
                        upgrade_needed: true
                    };
                }
                break;
                
            case 'workout_generation':
                // Для тренировок проверяем месячный лимит
                if (!subscription.user_id) {
                    return { allowed: false, message: 'Ошибка проверки лимитов. Попробуйте позже.' };
                }
                
                const thisMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
                const { data: monthlyUsage } = await supabase
                    .from('daily_usage')
                    .select('workouts_generated')
                    .eq('user_id', subscription.user_id)
                    .gte('date', `${thisMonth}-01`)
                    .lt('date', `${thisMonth}-32`);
                
                const totalWorkouts = monthlyUsage?.reduce((sum, day) => sum + day.workouts_generated, 0) || 0;
                
                if (limits.monthly_workouts === -1) return { allowed: true }; // безлимит
                if (totalWorkouts >= limits.monthly_workouts) {
                    return {
                        allowed: false,
                        message: `🚫 Достигнут месячный лимит программ тренировок (${limits.monthly_workouts}/месяц).\n\n💎 Получите безлимитный доступ с Премиум подпиской за 199₽/месяц!`,
                        upgrade_needed: true
                    };
                }
                break;
        }
        
        return { allowed: true };
        
            } catch (error) {
        logEvent('error', 'Error checking action limit', { error: error.toString(), telegramId, action });
        return { allowed: true }; // В случае ошибки разрешаем действие
    }
};

// Увеличение счетчика использования (адаптировано)
const incrementUsage = async (telegramId, action) => {
    try {
        // Получаем внутренний ID пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegramId)
            .single();

        if (profileError || !profile) {
            logEvent('error', 'Profile not found for usage increment', { error: profileError?.toString(), telegramId });
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        
        let updateField = '';
        switch (action) {
            case 'photo_analysis':
                updateField = 'photos_analyzed';
                break;
            case 'ai_question':
                updateField = 'ai_questions_asked';
                break;
            case 'workout_generation':
                updateField = 'workouts_generated';
                break;
            case 'manual_entry':
                updateField = 'manual_entries';
                break;
            default:
                return;
        }
        
        // Увеличиваем счетчик
        await supabase.rpc('increment_usage', {
            p_user_id: profile.id,
            p_date: today,
            p_field: updateField
        });
        
        logEvent('info', 'Usage incremented', { telegramId, userId: profile.id, action, field: updateField });
        
    } catch (error) {
        logEvent('error', 'Error incrementing usage', { error: error.toString(), telegramId, action });
    }
};

// 📊 СИСТЕМА ЕЖЕНЕДЕЛЬНОЙ АНАЛИТИКИ ВЕСА (VIP фича)
const weightTrackingState = {};

// Сохранение веса в базу данных (адаптировано)
const saveWeightRecord = async (telegramId, weight, notes = '') => {
    try {
        // Получаем внутренний ID пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegramId)
            .single();

        if (profileError || !profile) {
            logEvent('error', 'Profile not found for weight record', { error: profileError?.toString(), telegramId });
            return false;
        }

        const { data, error } = await supabase
            .from('weight_history')
            .insert({
                user_id: profile.id,
                weight_kg: parseFloat(weight),
                notes: notes,
                source: 'weekly_check',
                recorded_at: new Date().toISOString()
            });
        
        if (error) {
            logEvent('error', 'Error saving weight record', { error: error.toString(), telegramId, userId: profile.id });
            return false;
        }
        
        logEvent('info', 'Weight record saved', { telegramId, userId: profile.id, weight });
        return true;
        
    } catch (error) {
        logEvent('error', 'Exception saving weight record', { error: error.toString(), telegramId });
        return false;
    }
};

// Получение истории веса пользователя (адаптировано)
const getWeightHistory = async (telegramId, limit = 10) => {
    try {
        // Получаем внутренний ID пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegramId)
            .single();

        if (profileError || !profile) {
            logEvent('error', 'Profile not found for weight history', { error: profileError?.toString(), telegramId });
            return [];
        }

        const { data, error } = await supabase
            .from('weight_history')
            .select('*')
            .eq('user_id', profile.id)
            .order('recorded_at', { ascending: false })
            .limit(limit);
        
        if (error) {
            logEvent('error', 'Error getting weight history', { error: error.toString(), telegramId, userId: profile.id });
            return [];
        }
        
        return data || [];
        
    } catch (error) {
        logEvent('error', 'Exception getting weight history', { error: error.toString(), telegramId });
        return [];
    }
};

// Анализ прогресса веса с ИИ-рекомендациями
const analyzeWeightProgress = async (telegramId, currentWeight) => {
    try {
        const weightHistory = await getWeightHistory(telegramId, 8); // 8 недель истории
        const userProfile = await getUserProfile(telegramId);
        
        if (weightHistory.length < 2) {
            return `🎯 **ДОБРО ПОЖАЛОВАТЬ В АНАЛИТИКУ ВЕСА!**

Текущий вес: **${currentWeight} кг**

Это ваша первая запись! Продолжайте взвешиваться еженедельно, и я буду анализировать ваш прогресс с персональными рекомендациями.

💡 **Совет:** Взвешивайтесь в одно и то же время, желательно утром натощак для точности.`;
        }
        
        // Подготавливаем данные для ИИ
        const weightData = weightHistory.map((record, index) => ({
            week: index + 1,
            weight: record.weight_kg,
            date: new Date(record.recorded_at).toLocaleDateString('ru-RU'),
            change: index === 0 ? 0 : (record.weight_kg - weightHistory[index - 1].weight_kg).toFixed(1)
        }));
        
        const prompt = `
Ты профессиональный диетолог-аналитик. Проанализируй динамику веса пользователя и дай персональные рекомендации.

ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ:
- Имя: ${userProfile?.name || 'Не указано'}
- Пол: ${userProfile?.gender || 'Не указано'}
- Возраст: ${userProfile?.age || 'Не указано'} лет
- Рост: ${userProfile?.height || 'Не указано'} см
- Цель: ${userProfile?.goal || 'Не указано'}

ИСТОРИЯ ВЕСА (от новых к старым):
${weightData.map(w => `Неделя ${w.week}: ${w.weight} кг (${w.change > 0 ? '+' : ''}${w.change} кг) - ${w.date}`).join('\n')}

ТЕКУЩИЙ ВЕС: ${currentWeight} кг

ЗАДАЧА:
1. Проанализируй тренд (растет/падает/стабилен)
2. Оцени темп изменений (нормальный/быстрый/медленный)
3. Дай конкретные рекомендации по питанию и активности
4. Укажи, соответствует ли прогресс заявленной цели
5. Мотивируй пользователя

ФОРМАТ ОТВЕТА:
📊 **АНАЛИЗ ПРОГРЕССА ЗА ${weightHistory.length} НЕДЕЛЬ**

**Динамика:** [описание тренда]
**Темп:** [оценка скорости изменений]
**Соответствие цели:** [да/нет и почему]

🎯 **ПЕРСОНАЛЬНЫЕ РЕКОМЕНДАЦИИ:**
- [конкретная рекомендация по питанию]
- [рекомендация по активности]
- [дополнительные советы]

💪 **МОТИВАЦИЯ:** [ободряющие слова и план на следующую неделю]

Будь конкретным, заботливым и мотивирующим!
`;

        // Используем кэшированный ИИ для анализа
        const systemPrompt = 'Ты опытный диетолог и тренер с 10-летним стажем. Анализируешь данные о весе и даешь практические рекомендации для достижения целей пользователя.';
        
        const analysis = await cachedOpenAICall(prompt, 'gpt-4o-mini', 1000, systemPrompt);
        
        return analysis;
        
    } catch (error) {
        logEvent('error', 'Error analyzing weight progress', { error: error.toString(), telegramId });
        return `📊 **АНАЛИЗ ВЕСА**

Текущий вес: **${currentWeight} кг**

К сожалению, не удалось провести детальный анализ. Попробуйте позже.

💡 Продолжайте отслеживать вес еженедельно для получения персональных рекомендаций!`;
    }
};

// Отправка еженедельного опроса о весе (только для VIP)
const sendWeeklyWeightCheck = async (telegramId) => {
    try {
        // Проверяем подписку пользователя
        const subscription = await getUserSubscription(telegramId);
        if (subscription.plan !== 'vip') {
            logEvent('info', 'Skipping weight check for non-VIP user', { telegramId });
            return;
        }
        
        // Проверяем, не отправляли ли уже на этой неделе
        const today = new Date();
        const weekStart = new Date(today.setDate(today.getDate() - today.getDay()));
        const weekStartStr = weekStart.toISOString().split('T')[0];
        
        const { data: recentCheck } = await supabase
            .from('weight_history')
            .select('*')
            .eq('user_id', telegramId)
            .gte('recorded_at', weekStartStr)
            .limit(1);
        
        if (recentCheck && recentCheck.length > 0) {
            logEvent('info', 'User already recorded weight this week', { telegramId });
            return;
        }
        
        // Отправляем опрос
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '⚖️ Записать вес', callback_data: 'record_weight' },
                        { text: '📊 Посмотреть историю', callback_data: 'view_weight_history' }
                    ],
                    [
                        { text: '⏰ Напомнить завтра', callback_data: 'weight_remind_tomorrow' }
                    ]
                ]
            }
        };
        
        const message = `👑 **VIP ЕЖЕНЕДЕЛЬНАЯ АНАЛИТИКА**

🎯 Время еженедельного взвешивания!

Для точного анализа прогресса и персональных рекомендаций, запишите ваш текущий вес.

💡 **Совет:** Взвешивайтесь утром натощак для максимальной точности.

После записи веса вы получите:
📊 Детальный анализ прогресса
🎯 Персональные рекомендации
💪 План на следующую неделю`;
        
        await smartSendMessage(telegramId, message, keyboard);
        
        logEvent('info', 'Weekly weight check sent', { telegramId });
        
    } catch (error) {
        logEvent('error', 'Error sending weekly weight check', { error: error.toString(), telegramId });
    }
};

// Получение всех VIP пользователей для еженедельного опроса
const getAllVIPUsers = async () => {
    try {
        const { data, error } = await supabase
            .from('user_subscriptions')
            .select('user_id')
            .eq('plan', 'vip')
            .eq('is_active', true);
        
        if (error) {
            logEvent('error', 'Error getting VIP users', { error: error.toString() });
            return [];
        }
        
        return data.map(row => row.user_id);
        
    } catch (error) {
        logEvent('error', 'Exception getting VIP users', { error: error.toString() });
        return [];
    }
};

// Массовая отправка еженедельных опросов
const sendWeeklyWeightChecksToAll = async () => {
    try {
        const vipUsers = await getAllVIPUsers();
        
        logEvent('info', 'Starting weekly weight checks for VIP users', { count: vipUsers.length });
        
        for (const userId of vipUsers) {
            await sendWeeklyWeightCheck(userId);
            // Пауза между отправками, чтобы не нагружать API
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        logEvent('info', 'Weekly weight checks completed', { sent: vipUsers.length });
        
    } catch (error) {
        logEvent('error', 'Error in mass weekly weight checks', { error: error.toString() });
    }
};

// Настройка cron job для еженедельной отправки (каждое воскресенье в 10:00)
cron.schedule('0 10 * * 0', async () => {
    logEvent('info', 'Starting scheduled weekly weight checks');
    await sendWeeklyWeightChecksToAll();
}, {
    timezone: "Europe/Moscow"
});

// 💰 КЭШИРОВАНИЕ OpenAI ЗАПРОСОВ для экономии 60-80%
const openaiCache = new Map();
const CACHE_EXPIRY_HOURS = 24; // Кэш живет 24 часа
const MAX_CACHE_SIZE = 1000; // Максимум 1000 записей в кэше

// Функция для создания ключа кэша
const createCacheKey = (prompt, model, maxTokens) => {
    // Создаем хэш из промпта для компактности
    const hash = crypto.createHash('md5').update(JSON.stringify({prompt, model, maxTokens})).digest('hex');
    return hash;
};

// Функция для проверки и очистки устаревшего кэша
const cleanExpiredCache = () => {
    const now = Date.now();
    const expiredKeys = [];
    
    openaiCache.forEach((value, key) => {
        if (now - value.timestamp > CACHE_EXPIRY_HOURS * 60 * 60 * 1000) {
            expiredKeys.push(key);
        }
    });
    
    expiredKeys.forEach(key => openaiCache.delete(key));
    
    // Если кэш слишком большой, удаляем самые старые записи
    if (openaiCache.size > MAX_CACHE_SIZE) {
        const sortedEntries = Array.from(openaiCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        const toDelete = sortedEntries.slice(0, openaiCache.size - MAX_CACHE_SIZE);
        toDelete.forEach(([key]) => openaiCache.delete(key));
    }
    
    logEvent('info', 'Cache cleanup completed', { 
        cacheSize: openaiCache.size, 
        deletedExpired: expiredKeys.length 
    });
};

// Кэшированный вызов OpenAI
const cachedOpenAICall = async (prompt, model = 'gpt-4o-mini', maxTokens = 1500, systemPrompt = '') => {
    try {
        // Создаем ключ кэша
        const cacheKey = createCacheKey(`${systemPrompt}|${prompt}`, model, maxTokens);
        
        // Проверяем кэш
        const cached = openaiCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_HOURS * 60 * 60 * 1000) {
            logEvent('info', 'OpenAI cache hit', { cacheKey: cacheKey.substring(0, 8) });
            return cached.response;
        }
        
        // Если в кэше нет, делаем запрос к OpenAI
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
        
        const response = await withTimeout(
            openai.chat.completions.create({
                model: model,
                messages: messages,
                max_tokens: maxTokens,
                temperature: 0.7
            }),
            15000
        );
        
        const result = response.choices[0].message.content;
        
        // Сохраняем в кэш
        openaiCache.set(cacheKey, {
            response: result,
            timestamp: Date.now()
        });
        
        logEvent('info', 'OpenAI API call and cache save', { 
            cacheKey: cacheKey.substring(0, 8),
            cacheSize: openaiCache.size 
        });
        
        return result;
        
    } catch (error) {
        logEvent('error', 'Cached OpenAI call failed', { error: error.toString() });
        throw error;
    }
};

// Автоматическая очистка кэша каждый час
setInterval(cleanExpiredCache, 60 * 60 * 1000);

// Кэшированный анализ изображений с OpenAI Vision
const cachedImageAnalysis = async (imageUrl, prompt, model = 'gpt-4o-mini', maxTokens = 1500) => {
    try {
        // Создаем ключ кэша на основе URL изображения и промпта
        const cacheKey = createCacheKey(`image:${imageUrl}|${prompt}`, model, maxTokens);
        
        // Проверяем кэш
        const cached = openaiCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_HOURS * 60 * 60 * 1000) {
            logEvent('info', 'Image analysis cache hit', { cacheKey: cacheKey.substring(0, 8) });
            return cached.response;
        }
        
        // Если в кэше нет, делаем запрос к OpenAI Vision
        const response = await withTimeout(
            openai.chat.completions.create({
                model: model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: maxTokens,
                temperature: 0.3 // Меньше температура для более точного анализа еды
            }),
            20000 // Больше времени для анализа изображений
        );
        
        const result = response.choices[0].message.content;
        
        // Сохраняем в кэш
        openaiCache.set(cacheKey, {
            response: result,
            timestamp: Date.now()
        });
        
        logEvent('info', 'Image analysis API call and cache save', { 
            cacheKey: cacheKey.substring(0, 8),
            cacheSize: openaiCache.size 
        });
        
        return result;
        
    } catch (error) {
        logEvent('error', 'Cached image analysis failed', { error: error.toString() });
        throw error;
    }
};

// --- Typing Indicator and Streaming Functions ---
const showTyping = async (chat_id, duration = 3000) => {
    try {
        await bot.sendChatAction(chat_id, 'typing');
        // Повторяем каждые 5 секунд, так как typing action истекает
        const interval = setInterval(() => {
            bot.sendChatAction(chat_id, 'typing');
        }, 4000);
        
        setTimeout(() => {
            clearInterval(interval);
        }, duration);
    } catch (error) {
        console.error('Error showing typing indicator:', error);
    }
};

const streamMessage = async (chat_id, fullText, options = {}) => {
    try {
        const chars = fullText.trim().split('');
        if (chars.length <= 15) { // Короткие сообщения отправляем сразу
            return await bot.sendMessage(chat_id, fullText, options);
        }

        // 🚀 ГИБРИДНЫЙ ПОДХОД: Быстрая анимация + умная отправка
        const UPDATE_INTERVAL_MS = 75; // Обновляем сообщение каждые 75мс
        let lastUpdateTime = 0;
        let accumulatedText = '';

        // Отправляем начальное сообщение
        const sentMessage = await bot.sendMessage(chat_id, '✍️', options);
        accumulatedText = ''; // Сбрасываем после отправки плейсхолдера

        for (let i = 0; i < chars.length; i++) {
            accumulatedText += chars[i];
            const now = Date.now();

            // Отправляем обновление, только если прошло достаточно времени или это последний символ
            if (now - lastUpdateTime > UPDATE_INTERVAL_MS || i === chars.length - 1) {
                try {
                    await bot.editMessageText(accumulatedText, {
                        chat_id: chat_id,
                        message_id: sentMessage.message_id,
                        ...options
                    });
                    lastUpdateTime = now; // Фиксируем время успешного обновления
                } catch (editError) {
                    if (!editError.message.includes('message is not modified')) {
                        console.warn('Stream hybrid update error:', editError.message);
                    }
                }
            }
             // Микро-пауза, чтобы цикл не был слишком агрессивным для CPU.
            await new Promise(resolve => setTimeout(resolve, 1));
        }

        return sentMessage;
    } catch (error) {
        console.error('Error in streamMessage:', error);
        return await bot.sendMessage(chat_id, fullText, options);
    }
};

// Убрана функция streamLongMessage - используем только streamMessage для всех сообщений

const shouldUseStreaming = (text) => {
    // Используем streaming для текстов длиннее 15 символов (гибридный вывод)
    return text && typeof text === 'string' && text.trim().length > 15;
};

const smartSendMessage = async (chat_id, text, options = {}) => {
    if (shouldUseStreaming(text)) {
        return await streamMessage(chat_id, text, options);
    } else {
        return await bot.sendMessage(chat_id, text, options);
    }
};

// Функция красивого форматирования длинных ответов ИИ
const formatAIResponse = (text) => {
    // Добавляем разделители и структуру
    let formatted = text;
    
    // Заменяем обычные переносы на двойные для лучшего разделения
    formatted = formatted.replace(/\n([А-Я])/g, '\n\n$1');
    
    // Выделяем важные моменты черным фоном (моноширинный шрифт)
    formatted = formatted.replace(/([0-9,]+\s*(ккал|кг|г|мл|км|мин|раз|подход|день|неделя|месяц))/gi, '`$1`');
    formatted = formatted.replace(/(калория|калории|калорий|белки|жиры|углеводы|КБЖУ|БЖУ)/gi, '`$1`');
    formatted = formatted.replace(/(завтрак|обед|ужин|перекус)/gi, '`$1`');
    
    // Делаем жирными важные заголовки
    formatted = formatted.replace(/^([А-Я][^:]*:)/gm, '**$1**');
    
    // Улучшаем списки
    formatted = formatted.replace(/^- /gm, '• ');
    formatted = formatted.replace(/^(\d+)\. /gm, '**$1.** ');
    
    // Добавляем эмодзи для разделов
    formatted = formatted.replace(/\*\*(Рекомендации|Советы|Важно|Внимание)\*\*/gi, '💡 **$1**');
    formatted = formatted.replace(/\*\*(Питание|Рацион|Диета)\*\*/gi, '🍽️ **$1**');
    formatted = formatted.replace(/\*\*(Тренировки|Упражнения|Активность)\*\*/gi, '💪 **$1**');
    formatted = formatted.replace(/\*\*(Здоровье|Самочувствие)\*\*/gi, '🏥 **$1**');
    formatted = formatted.replace(/\*\*(Результат|Итог|Заключение)\*\*/gi, '🎯 **$1**');
    
    // Добавляем красивую рамку для длинных ответов (более 200 символов)
    if (formatted.length > 200) {
        formatted = `┌──────────────────────────┐\n│  🤖 **ПЕРСОНАЛЬНЫЙ ОТВЕТ**  │\n└──────────────────────────┘\n\n${formatted}\n\n─────────────────────────\n💬 *Есть ещё вопросы? Спрашивайте!*`;
    }
    
    return formatted;
};

const getUserProfile = async (telegramId) => {
    const { data, error } = await withDatabaseErrorHandling(() => 
        supabase.from('profiles').select('*').eq('telegram_id', telegramId).single()
    );
    return data;
};

const formatUserProgramToMarkdown = (program) => {
    let markdown = `*${program.title}*\n\n`;
    markdown += `_${program.description}_\n\n`;

    if (program.weeks) {
        program.weeks.forEach(weekData => {
            markdown += `*Неделя ${weekData.week}*\n`;
            weekData.days.forEach(day => {
                markdown += `*${day.title}*\n`;
                day.exercises.forEach(ex => {
                    markdown += `  - ${ex.name}: ${ex.sets_reps}${ex.weight ? ` (${ex.weight})` : ''}\n`;
                });
            });
            markdown += '\n';
        });
    }

    if (program.blocks) {
        program.blocks.forEach(blockData => {
            markdown += `*Блок ${blockData.block}*\n`;
            blockData.trainings.forEach(training => {
                markdown += `*${training.title}*\n`;
                training.exercises.forEach(ex => {
                    markdown += `  - ${ex.name}: ${ex.sets_reps} (${ex.intensity})\n`;
                });
            });
            markdown += '\n';
        });
    }
    
    if (program.week_7) {
        markdown += `*${program.week_7.title}*\n`;
        program.week_7.days.forEach(day => {
            markdown += `*${day.title}*\n`;
            day.exercises.forEach(ex => {
                markdown += `  - ${ex.name}: ${ex.sets_reps} (${ex.weight})\n`;
            });
        });
        markdown += '\n';
    }

    return markdown;
};

const generatePersonalizedWorkoutPlan = async (userProfile, goal, experience) => {
    try {
        // Получаем все доступные упражнения из ваших программ
        const allExercises = [];
        
        Object.values(USER_WORKOUT_PROGRAMS).forEach(category => {
            Object.values(category).forEach(gender => {
                Object.values(gender).forEach(program => {
                    if (program.weeks) {
                        program.weeks.forEach(week => {
                            week.days.forEach(day => {
                                allExercises.push(...day.exercises);
                            });
                        });
                    }
                    if (program.blocks) {
                        program.blocks.forEach(block => {
                            block.trainings.forEach(training => {
                                allExercises.push(...training.exercises);
                            });
                        });
                    }
                });
            });
        });

        // Убираем дубликаты упражнений
        const uniqueExercises = allExercises.filter((exercise, index, self) => 
            index === self.findIndex(e => e.name === exercise.name)
        );

        const prompt = `
Ты опытный персональный тренер. Составь индивидуальную программу тренировок на основе:

ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ:
- Имя: ${userProfile?.name || 'Не указано'}
- Пол: ${userProfile?.gender || 'Не указано'}
- Возраст: ${userProfile?.age || 'Не указано'}
- Вес: ${userProfile?.weight || 'Не указано'} кг
- Рост: ${userProfile?.height || 'Не указано'} см
- Цель: ${goal}
- Уровень опыта: ${experience}

ДОСТУПНЫЕ УПРАЖНЕНИЯ (выбери самые подходящие):
${uniqueExercises.slice(0, 50).map(ex => `- ${ex.name}: ${ex.sets_reps || ''} ${ex.intensity ? `(${ex.intensity})` : ''}`).join('\n')}

ТРЕБОВАНИЯ:
1. Составь программу на 3-4 дня в неделю
2. Учти уровень опыта пользователя
3. Используй ТОЛЬКО упражнения из предоставленного списка
4. Укажи количество подходов и повторений
5. Добавь рекомендации по отдыху между подходами
6. Структурируй по дням недели

ФОРМАТ ОТВЕТА:
**ПЕРСОНАЛЬНАЯ ПРОГРАММА ТРЕНИРОВОК**

**День 1 - [Название]**
- Упражнение: подходы x повторения (отдых)
- ...

**День 2 - Отдых**

**День 3 - [Название]**
- Упражнение: подходы x повторения (отдых)
- ...

**РЕКОМЕНДАЦИИ:**
- Общие советы по выполнению
- Прогрессия нагрузки
- Важные моменты техники
`;

        // Используем кэшированный вызов OpenAI
        const systemPrompt = 'Ты профессиональный персональный тренер с 15-летним опытом. Создаешь безопасные и эффективные программы тренировок.';
        
        return await cachedOpenAICall(prompt, 'gpt-4o-mini', 1500, systemPrompt);
    } catch (error) {
        logEvent('error', 'Error generating personalized workout plan', { error: error.toString() });
        return 'Извините, не удалось создать персональную программу. Попробуйте позже.';
    }
};

// --- Основная логика бота ---

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    try {
        if (text === '/start') {
            // ... existing code ...
        } else if (msg.entities && msg.entities[0].type === 'bot_command') {
            // ... existing code ...
        } else if (msg.text && msg.text.startsWith('/')) {
            
            // Команда для тестирования аналитики веса (только для разработки)
            if (text === '/test_weight_analytics') {
                const subscription = await getUserSubscription(userId);
                if (subscription.plan !== 'vip') {
                    await bot.sendMessage(chatId, '👑 Эта команда доступна только для VIP пользователей.\n\n💎 Подключите VIP за 349₽/месяц для доступа к еженедельной аналитике веса!');
                    return;
                }
                
                await sendWeeklyWeightCheck(userId);
                await bot.sendMessage(chatId, '🧪 Тестовое сообщение еженедельной аналитики отправлено!');
                return;
            }
            
            // Команда для просмотра текущего тарифа и статистики
            if (text === '/my_plan' || text === '/subscription') {
                const subscription = await getUserSubscription(userId);
                const usage = await getTodayUsage(userId);
                const plan = SUBSCRIPTION_PLANS[subscription.plan];
                
                let message = `💎 **ВАШ ТАРИФНЫЙ ПЛАН**\n\n`;
                message += `🎯 **Текущий план:** ${plan.name}\n`;
                
                if (subscription.plan !== 'free') {
                    message += `💰 **Стоимость:** ${plan.price}₽/месяц\n`;
                    if (subscription.expires_at) {
                        const expiryDate = new Date(subscription.expires_at).toLocaleDateString('ru-RU');
                        message += `📅 **Действует до:** ${expiryDate}\n`;
                    }
                }
                
                message += `\n📊 **ИСПОЛЬЗОВАНИЕ СЕГОДНЯ:**\n`;
                message += `📸 Анализ фото: ${usage.photos_analyzed}/${plan.daily_photos === -1 ? '∞' : plan.daily_photos}\n`;
                message += `🤖 Вопросы ИИ: ${usage.ai_questions_asked}/${plan.daily_ai_questions === -1 ? '∞' : plan.daily_ai_questions}\n`;
                
                message += `\n✨ **ВОЗМОЖНОСТИ ТАРИФА:**\n`;
                plan.features.forEach(feature => {
                    message += `• ${feature}\n`;
                });
                
                if (subscription.plan === 'free') {
                    message += `\n🚀 **УЛУЧШИТЬ ПЛАН:**\n`;
                    message += `💰 Premium (199₽/мес) - безлимитный анализ фото, персональные программы\n`;
                    message += `👑 VIP (349₽/мес) - ИИ-нутрициолог, аналитика веса, голосовые сообщения`;
                }
                
                await smartSendMessage(chatId, message, { parse_mode: 'Markdown' });
                return;
            }
            
            // ... existing code ...
            
        } else if (msg.text) {
            
            // Обработка ввода веса для VIP пользователей
            if (weightTrackingState[userId]?.step === 'waiting_weight') {
                const weightInput = msg.text.trim().replace(',', '.');
                const weight = parseFloat(weightInput);
                
                if (!validateUserInput.weight(weight)) {
                    await bot.sendMessage(chatId, '❌ Некорректный вес! Введите число от 30 до 300 кг (например: 75.5)');
                    return;
                }
                
                // Сохраняем вес
                const saved = await saveWeightRecord(userId, weight);
                if (!saved) {
                    await bot.sendMessage(chatId, '❌ Ошибка сохранения веса. Попробуйте позже.');
                    return;
                }
                
                // Очищаем состояние
                delete weightTrackingState[userId];
                
                // Показываем индикатор анализа
                await showTyping(chatId, 5000);
                await bot.sendMessage(chatId, '🤖 Анализирую ваш прогресс и готовлю персональные рекомендации...');
                
                // Генерируем анализ прогресса
                const analysis = await analyzeWeightProgress(userId, weight);
                
                await smartSendMessage(chatId, analysis, { parse_mode: 'Markdown' });
                
                logEvent('info', 'Weight recorded and analyzed', { userId, weight });
                return;
            }
            
            // ... existing code for other text messages ...
            
        } else if (msg.callback_query) {
            const callbackQuery = msg.callback_query;
            
            if (callbackQuery.data.startsWith('get_workout_plan_')) {
                const [_, goal, gender, experience] = callbackQuery.data.split('_');
                
                // Проверяем лимит тренировок
                const limitCheck = await checkActionLimit(userId, 'workout_generation');
                if (!limitCheck.allowed) {
                    await bot.sendMessage(chatId, limitCheck.message);
                    return;
                }
                
                // Получаем профиль пользователя
                const userProfile = await getUserProfile(userId);
                
                // Показываем индикатор загрузки
                await showTyping(chatId, 8000);
                await bot.sendMessage(chatId, '🤖 Анализирую ваш профиль и составляю персональную программу тренировок...');
                
                // Генерируем персональную программу с помощью ИИ
                const personalizedPlan = await generatePersonalizedWorkoutPlan(userProfile, goal, experience);
                
                await smartSendMessage(chatId, personalizedPlan, { parse_mode: 'Markdown' });
                
                // Увеличиваем счетчик использования
                await incrementUsage(userId, 'workout_generation');
                
            } else if (callbackQuery.data === 'record_weight') {
                // Обработка записи веса (VIP фича)
                const subscription = await getUserSubscription(userId);
                if (subscription.plan !== 'vip') {
                    await bot.sendMessage(chatId, '👑 Еженедельная аналитика веса доступна только для VIP пользователей!\n\n💎 Подключите VIP за 349₽/месяц и получите персональные рекомендации от ИИ-диетолога.');
                    return;
                }
                
                weightTrackingState[userId] = { step: 'waiting_weight' };
                
                await bot.sendMessage(chatId, '⚖️ **ЗАПИСЬ ВЕСА**\n\nВведите ваш текущий вес в килограммах (например: 75.5):\n\n💡 Для точности взвешивайтесь утром натощак');
                
            } else if (callbackQuery.data === 'view_weight_history') {
                // Просмотр истории веса (VIP фича)
                const subscription = await getUserSubscription(userId);
                if (subscription.plan !== 'vip') {
                    await bot.sendMessage(chatId, '👑 История веса доступна только для VIP пользователей!\n\n💎 Подключите VIP за 349₽/месяц.');
                    return;
                }
                
                const weightHistory = await getWeightHistory(userId, 12);
                
                if (weightHistory.length === 0) {
                    await bot.sendMessage(chatId, '📊 **ИСТОРИЯ ВЕСА**\n\nУ вас пока нет записей о весе.\n\n⚖️ Нажмите "Записать вес", чтобы начать отслеживание прогресса!');
                    return;
                }
                
                let historyMessage = '📊 **ИСТОРИЯ ВЕСА**\n\n';
                
                weightHistory.forEach((record, index) => {
                    const date = new Date(record.recorded_at).toLocaleDateString('ru-RU');
                    const change = index < weightHistory.length - 1 ? 
                        (record.weight_kg - weightHistory[index + 1].weight_kg).toFixed(1) : '0.0';
                    const changeIcon = parseFloat(change) > 0 ? '📈' : parseFloat(change) < 0 ? '📉' : '➡️';
                    
                    historyMessage += `${changeIcon} **${record.weight_kg} кг** (${parseFloat(change) > 0 ? '+' : ''}${change} кг) - ${date}\n`;
                });
                
                historyMessage += '\n💡 Записывайте вес еженедельно для детального анализа прогресса!';
                
                await smartSendMessage(chatId, historyMessage, { parse_mode: 'Markdown' });
                
            } else if (callbackQuery.data === 'weight_remind_tomorrow') {
                // Напоминание завтра
                await bot.sendMessage(chatId, '⏰ Хорошо! Я напомню вам завтра о записи веса.\n\n💡 Для лучших результатов старайтесь взвешиваться регулярно.');
                
                // Здесь можно добавить логику для напоминания завтра
                // Например, сохранить в базе данных задачу на завтра
            }
        }
    } catch (error) {
        logEvent('error', `Callback query processing error for data: ${callbackQuery.data}`, {
            error: error.toString(),
            stack: error.stack
        });
    }
});

// 🚀 ФУНКЦИЯ НАСТРОЙКИ БОТА ДЛЯ ЭКСПОРТА
const setupBot = (app) => {
    // Настройка webhook для продакшена (Railway)
    if (process.env.NODE_ENV === 'production') {
        const webhookUrl = `${process.env.RAILWAY_STATIC_URL}/webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
        
        // Устанавливаем webhook
        bot.setWebHook(webhookUrl).then(() => {
            logEvent('info', 'Webhook set successfully', { webhookUrl });
        }).catch((error) => {
            logEvent('error', 'Failed to set webhook', { error: error.toString() });
        });
        
        // Обработчик webhook
        app.post(`/webhook/${process.env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
            bot.processUpdate(req.body);
            res.sendStatus(200);
        });
        
        logEvent('info', 'Bot configured for production with webhook');
    } else {
        // Режим разработки - polling
        bot.startPolling({
            interval: 300,
            params: {
                timeout: 10
            }
        }).then(() => {
            logEvent('info', 'Bot started with polling');
        }).catch((error) => {
            logEvent('error', 'Failed to start polling', { error: error.toString() });
        });
        
        logEvent('info', 'Bot configured for development with polling');
    }
    
    // Запускаем автоматическую очистку кэша каждые 2 часа
    setInterval(cleanExpiredCache, 2 * 60 * 60 * 1000);
    
    // Запускаем cron job для еженедельной аналитики веса (каждое воскресенье в 10:00 МСК)
    cron.schedule('0 10 * * 0', async () => {
        await sendWeeklyWeightChecksToAll();
    }, {
        timezone: "Europe/Moscow"
    });
    
    logEvent('info', 'Bot setup completed successfully');
};

// 📦 ЭКСПОРТ МОДУЛЯ
module.exports = {
    setupBot
};
