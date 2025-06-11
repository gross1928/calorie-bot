const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./supabaseClient');
const OpenAI = require('openai');
const crypto = require('crypto');
const cron = require('node-cron');

require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!token || !openaiApiKey) {
    throw new Error('Telegram Bot Token or OpenAI API Key is not defined in .env file');
}

// 🤖 Telegram Bot с улучшенной обработкой ошибок
const bot = new TelegramBot(token, {
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
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
const workoutInjuryState = {};

// Состояние для ожидания вопросов от пользователя
const questionState = {};

// Состояние для анализа медицинских данных
const medicalAnalysisState = {};

// Защита от повторных нажатий (debounce для callbacks)
const callbackDebounce = {};

// Очистка debounce данных каждую минуту
setInterval(() => {
    const now = Date.now();
    for (const key in callbackDebounce) {
        if (now - callbackDebounce[key] > 60000) { // Удаляем записи старше 1 минуты
            delete callbackDebounce[key];
        }
    }
}, 60000);

// Полная очистка всех состояний пользователя
const clearUserStates = (telegram_id) => {
    delete registrationState[telegram_id];
    delete manualAddState[telegram_id];
    delete workoutPlanState[telegram_id];
    delete nutritionPlanState[telegram_id];
    delete waterInputState[telegram_id];
    delete profileEditState[telegram_id];
    delete challengeStepsState[telegram_id];
    delete workoutInjuryState[telegram_id];
    delete questionState[telegram_id];
    delete medicalAnalysisState[telegram_id];
};

// Умная очистка состояний - закрывает только конфликтующие операции
const closeConflictingStates = (telegram_id, currentOperation) => {
    switch (currentOperation) {
        case 'workout_plan':
            // Закрываем состояния, которые конфликтуют с планом тренировок
            delete nutritionPlanState[telegram_id];
            delete manualAddState[telegram_id];
            delete waterInputState[telegram_id];
            delete challengeStepsState[telegram_id];
            delete questionState[telegram_id];
            delete medicalAnalysisState[telegram_id];
            break;
            
        case 'nutrition_plan':
            // Закрываем состояния, которые конфликтуют с планом питания
            delete workoutPlanState[telegram_id];
            delete workoutInjuryState[telegram_id];
            delete manualAddState[telegram_id];
            delete waterInputState[telegram_id];
            delete challengeStepsState[telegram_id];
            delete questionState[telegram_id];
            delete medicalAnalysisState[telegram_id];
            break;
            
        case 'manual_food_entry':
            // Закрываем состояния, которые конфликтуют с ручным вводом еды
            delete workoutPlanState[telegram_id];
            delete workoutInjuryState[telegram_id];
            delete nutritionPlanState[telegram_id];
            delete waterInputState[telegram_id];
            delete challengeStepsState[telegram_id];
            delete questionState[telegram_id];
            delete medicalAnalysisState[telegram_id];
            break;
            
        case 'water_tracking':
            // Закрываем состояния, которые конфликтуют с отслеживанием воды
            delete workoutPlanState[telegram_id];
            delete workoutInjuryState[telegram_id];
            delete nutritionPlanState[telegram_id];
            delete manualAddState[telegram_id];
            delete challengeStepsState[telegram_id];
            delete questionState[telegram_id];
            delete medicalAnalysisState[telegram_id];
            break;
            
        case 'challenge_input':
            // Закрываем состояния, которые конфликтуют с вводом данных челленджа
            delete workoutPlanState[telegram_id];
            delete workoutInjuryState[telegram_id];
            delete nutritionPlanState[telegram_id];
            delete manualAddState[telegram_id];
            delete waterInputState[telegram_id];
            delete questionState[telegram_id];
            delete medicalAnalysisState[telegram_id];
            break;
            
        case 'question_mode':
            // Закрываем все активные операции ввода при переходе в режим вопросов
            delete workoutPlanState[telegram_id];
            delete workoutInjuryState[telegram_id];
            delete nutritionPlanState[telegram_id];
            delete manualAddState[telegram_id];
            delete waterInputState[telegram_id];
            delete challengeStepsState[telegram_id];
            delete medicalAnalysisState[telegram_id];
            break;
            
        case 'workout_injury_input':
            // Закрываем только конфликтующие операции ввода, но сохраняем workoutPlanState
            delete nutritionPlanState[telegram_id];
            delete manualAddState[telegram_id];
            delete waterInputState[telegram_id];
            delete challengeStepsState[telegram_id];
            delete questionState[telegram_id];
            delete medicalAnalysisState[telegram_id];
            break;
            
        case 'profile_menu':
            // Полная очистка при переходе в профиль (оставляем как есть)
            clearUserStates(telegram_id);
            break;
            
        default:
            // По умолчанию не очищаем ничего, только если явно не указано
            console.log(`Unknown operation: ${currentOperation}, no state changes`);
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
    
    // Убираем ### символы из заголовков
    formatted = formatted.replace(/^###\s*/gm, '');
    formatted = formatted.replace(/^####\s*/gm, '');
    
    // Заменяем обычные переносы на двойные для лучшего разделения
    formatted = formatted.replace(/\n([А-Я])/g, '\n\n$1');
    
    // Выделяем важные числа жирным шрифтом (убираем серое выделение)
    formatted = formatted.replace(/([0-9,]+[\-\s]*[0-9,]*)\s*(ккал|калори[ийя]|кг|км|мин|раз|подход|день|недел[ьяи]|месяц[аов]?)/gi, '**$1 $2**');
    
    // Выделяем важные термины жирным
    formatted = formatted.replace(/(белк[иоа]|жир[ыаи]|углевод[ыаи]|КБЖУ|БЖУ)/gi, '**$1**');
    formatted = formatted.replace(/(завтрак|обед|ужин|перекус)/gi, '**$1**');
    
    // Делаем жирными важные заголовки и добавляем эмодзи
    formatted = formatted.replace(/^(Питание|Рацион|Диета):/gmi, '🍽️ **$1:**');
    formatted = formatted.replace(/^(Тренировки|Упражнения|Активность):/gmi, '💪 **$1:**'); 
    formatted = formatted.replace(/^(Рекомендации|Советы):/gmi, '💡 **$1:**');
    formatted = formatted.replace(/^(Важно|Внимание):/gmi, '⚠️ **$1:**');
    formatted = formatted.replace(/^(Здоровье|Самочувствие):/gmi, '🏥 **$1:**');
    formatted = formatted.replace(/^(Результат|Итог|Заключение):/gmi, '🎯 **$1:**');
    formatted = formatted.replace(/^(Распределение КБЖУ|КБЖУ|БЖУ):/gmi, '📊 **$1:**');
    
    // Делаем жирными все остальные заголовки с двоеточием
    formatted = formatted.replace(/^([А-Я][^:\n]*):(?!\s*\*\*)/gm, '**$1:**');
    
    // Улучшаем списки
    formatted = formatted.replace(/^- /gm, '• ');
    formatted = formatted.replace(/^(\d+)\. /gm, '**$1.** ');
    
    // Выделяем процентные соотношения
    formatted = formatted.replace(/(\d+)-(\d+)%/g, '**$1-$2%**');
    formatted = formatted.replace(/(\d+)%/g, '**$1%**');
    
    // Добавляем красивую рамку для длинных ответов (более 200 символов)
    if (formatted.length > 200) {
        formatted = `┌─────────────────────────────┐\n│  🤖 **ПЕРСОНАЛЬНЫЙ ОТВЕТ**  │\n└─────────────────────────────┘\n\n${formatted}\n\n─────────────────────────\n💬 *Есть ещё вопросы? Спрашивайте!*`;
    }
    
    return formatted;
};

// --- Helper Functions ---
const getDateRange = (period) => {
    const now = new Date();
    let startDate, endDate;
    
    if (period === 'today') {
        // Расширяем диапазон, чтобы учесть разные часовые пояса
        startDate = new Date(now);
        startDate.setUTCHours(0, 0, 0, 0);
        startDate.setUTCDate(startDate.getUTCDate() - 1); // Начинаем с предыдущего дня
        
        endDate = new Date(now);
        endDate.setUTCHours(23, 59, 59, 999);
        endDate.setUTCDate(endDate.getUTCDate() + 1); // Заканчиваем следующим днем
    } else if (period === 'week') {
        const day = now.getUTCDay();
        const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
        startDate = new Date(now);
        startDate.setUTCDate(diff);
        startDate.setUTCHours(0, 0, 0, 0);
        
        endDate = new Date(now);
        endDate.setUTCHours(23, 59, 59, 999);
    } else if (period === 'month') {
        startDate = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
        startDate.setUTCHours(0, 0, 0, 0);
        
        endDate = new Date(now);
        endDate.setUTCHours(23, 59, 59, 999);
    }
    
    return { startDate, endDate };
};

const calculateAndSaveNorms = async (profile) => {
    try {
        if (!profile) throw new Error('Profile object is null or undefined.');

        const { telegram_id, gender, age, height_cm, weight_kg, goal } = profile;

        let bmr;
        if (gender === 'male') {
            bmr = 88.362 + (13.397 * parseFloat(weight_kg)) + (4.799 * height_cm) - (5.677 * age);
        } else { // female
            bmr = 447.593 + (9.247 * parseFloat(weight_kg)) + (3.098 * height_cm) - (4.330 * age);
        }

        // 🔥 Улучшенный расчет калорий с правильными коэффициентами
        const activityFactor = 1.4; // Повышен с 1.2 до 1.4 (легкая активность)
        let daily_calories = bmr * activityFactor;

        switch (goal) {
            case 'lose_weight':
                daily_calories *= 0.80; // 20% дефицит для эффективного похудения
                break;
            case 'gain_mass':
                daily_calories *= 1.25; // 25% избыток для набора массы (было 15%)
                break;
        }

        const daily_protein = (daily_calories * 0.30) / 4;
        const daily_fat = (daily_calories * 0.30) / 9;
        const daily_carbs = (daily_calories * 0.40) / 4;

        const { error: updateError } = await supabase
            .from('profiles')
            .update({
                daily_calories: Math.round(daily_calories),
                daily_protein: Math.round(daily_protein),
                daily_fat: Math.round(daily_fat),
                daily_carbs: Math.round(daily_carbs)
            })
            .eq('telegram_id', telegram_id);

        if (updateError) throw updateError;
        
        console.log(`✅ Daily norms calculated and saved for user ${telegram_id}`);

    } catch (error) {
        console.error(`Error calculating norms for user ${profile.telegram_id}:`, error.message);
    }
};

const recognizeFoodFromText = async (inputText) => {
    logEvent('info', 'Food text recognition started', { inputLength: inputText.length });
    
    return withErrorHandling(async () => {
        const response = await withTimeout(openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `Ты — эксперт-диетолог. Твоя задача — проанализировать текстовое описание еды и ее вес, и вернуть ТОЛЬКО JSON-объект со следующей структурой:
{
  "dish_name": "Название блюда на русском языке",
  "ingredients": ["ингредиент 1", "ингредиент 2", "..."],
  "weight_g": вес блюда в граммах (число),
  "calories": калорийность (число),
  "protein": "белки в граммах (число)",
  "fat": "жиры в граммах (число)",
  "carbs": "углеводы в граммах (число)"
}
Вес в JSON должен соответствовать весу, указанному пользователем. Остальные значения (калории, БЖУ, ингредиенты) рассчитай для этого веса. Никакого текста до или после JSON-объекта. Если в тексте не еда, верни JSON с "dish_name": "не еда".`
                },
                {
                    role: 'user',
                    content: `Проанализируй этот прием пищи и оцени его состав и КБЖУ: "${inputText}"`,
                },
            ],
            max_tokens: 500,
        }), 15000);

        const content = response.choices[0].message.content;
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedContent = JSON.parse(jsonString);

        if (parsedContent.dish_name === 'не еда') {
            logEvent('warn', 'Non-food text detected', { input: inputText });
            return { success: false, reason: 'Не удалось распознать еду в вашем описании.' };
        }

        logEvent('info', 'Food text recognition successful', { 
            dish: parsedContent.dish_name, 
            calories: parsedContent.calories 
        });
        return { success: true, data: parsedContent };

    }, 'Произошла ошибка при анализе вашего описания. Попробуйте еще раз.');
};

const recognizeFoodFromPhoto = async (photoUrl) => {
    logEvent('info', 'Food photo recognition started', { photoUrl });
    
    return withErrorHandling(async () => {
        const response = await withTimeout(openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `Ты — эксперт-диетолог. Твоя задача — проанализировать изображение еды и вернуть ТОЛЬКО JSON-объект со следующей структурой:
{
  "dish_name": "Название блюда на русском языке",
  "ingredients": ["ингредиент 1", "ингредиент 2", "..."],
  "weight_g": вес блюда в граммах (число),
  "calories": калорийность (число),
  "protein": "белки в граммах (число)",
  "fat": "жиры в граммах (число)",
  "carbs": "углеводы в граммах (число)"
}
Никакого текста до или после JSON-объекта. Если на фото не еда, верни JSON с "dish_name": "не еда".`
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Что на этом изображении? Оцени состав и КБЖУ.' },
                        {
                            type: 'image_url',
                            image_url: {
                                url: photoUrl,
                            },
                        },
                    ],
                },
            ],
            max_tokens: 500,
        }), 20000);

        const content = response.choices[0].message.content;
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedContent = JSON.parse(jsonString);

        if (parsedContent.dish_name === 'не еда') {
            logEvent('warn', 'Non-food photo detected', { photoUrl });
            return { success: false, reason: 'На фото не удалось распознать еду.' };
        }

        logEvent('info', 'Food photo recognition successful', { 
            dish: parsedContent.dish_name, 
            calories: parsedContent.calories 
        });
        return { success: true, data: parsedContent };

    }, 'Произошла ошибка при анализе изображения. Попробуйте еще раз.');
};

const generateWorkoutPlan = async (profileData, additionalData) => {
    try {
        const { first_name, gender, age, height_cm, weight_kg, goal } = profileData;
        const { experience, goal: workoutGoal, priority_zones, injuries, location, frequency, duration } = additionalData;

        console.log('Generating workout plan with OpenAI...');
        
        const systemPrompt = `Ты - профессиональный фитнес-тренер с многолетним опытом. Твоя задача - создать персональный план тренировок на неделю.

ПРОФИЛЬ КЛИЕНТА:
- Имя: ${first_name}
- Пол: ${gender === 'male' ? 'мужской' : 'женский'}
- Возраст: ${age} лет
- Рост: ${height_cm} см
- Текущий вес: ${weight_kg} кг
${additionalData.target_weight_kg ? `- Целевой вес: ${additionalData.target_weight_kg} кг` : ''}
${additionalData.timeframe_months ? `- Срок достижения цели: ${additionalData.timeframe_months} месяцев` : ''}
- Общая цель: ${goal === 'lose_weight' ? 'похудение' : goal === 'gain_mass' ? 'набор массы' : 'поддержание веса'}
- Опыт тренировок: ${experience}
- Цель тренировок: ${workoutGoal}
- Приоритетные зоны: ${priority_zones?.join(', ') || 'нет'}
- Травмы/ограничения: ${injuries || 'нет'}
- Место тренировок: ${location}
- Частота тренировок: ${frequency} раз в неделю
- Время тренировки: ${duration} минут

ТРЕБОВАНИЯ К ПЛАНУ:
1. План на 7 дней с указанием дней отдыха
2. Упражнения должны быть безопасными и подходящими для уровня опыта
3. Укажи количество подходов, повторений и время отдыха
4. Включи разминку и заминку
5. Ответ дай СТРОГО в формате Markdown с таблицами

ФОРМАТ ОТВЕТА:
# 🏋️ Персональный план тренировок для ${first_name}

## 📊 Общая информация
- **Цель:** [цель тренировок]
- **Уровень:** [уровень опыта] 
- **Частота:** [количество тренировок в неделю]

## 📅 Недельный план

### День 1 - [Название тренировки]
| Упражнение | Подходы | Повторения | Отдых |
|------------|---------|------------|-------|
| [упражнение] | [подходы] | [повторения] | [время отдыха] |

### День 2 - [Название тренировки или Отдых]
[аналогично]

[...продолжи для всех 7 дней]

## 💡 Рекомендации
- [важные советы по выполнению]
- [рекомендации по питанию во время тренировок]
- [советы по восстановлению]`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Создай персональный план тренировок учитывая все мои данные.` }
            ],
            max_tokens: 2000,
        });

        const plan = response.choices[0].message.content;
        return { success: true, plan };

    } catch (error) {
        console.error('Error generating workout plan:', error);
        return { success: false, error: error.message };
    }
};

const generateNutritionPlan = async (profileData, additionalData) => {
    try {
        const { first_name, gender, age, height_cm, weight_kg, goal, daily_calories, daily_protein, daily_fat, daily_carbs } = profileData;
        const { preferences, activity, allergies, mealsCount } = additionalData;

        console.log('Generating nutrition plan with OpenAI...');
        
        const systemPrompt = `Ты - квалифицированный диетолог с многолетним опытом. Твоя задача - создать персональный план питания на неделю.

ПРОФИЛЬ КЛИЕНТА:
- Имя: ${first_name}
- Пол: ${gender === 'male' ? 'мужской' : 'женский'}
- Возраст: ${age} лет
- Рост: ${height_cm} см
- Текущий вес: ${weight_kg} кг
${profileData.target_weight_kg ? `- Целевой вес: ${profileData.target_weight_kg} кг` : ''}
${profileData.timeframe_months ? `- Срок достижения цели: ${profileData.timeframe_months} месяцев` : ''}
- Цель: ${goal === 'lose_weight' ? 'похудение' : goal === 'gain_mass' ? 'набор массы' : 'поддержание веса'}
- Дневная норма калорий: ${daily_calories} ккал
- Белки: ${daily_protein} г
- Жиры: ${daily_fat} г
- Углеводы: ${daily_carbs} г
- Уровень активности: ${activity}
- Пищевые предпочтения: ${preferences}
- Аллергии: ${allergies || 'нет'}
- Приёмов пищи в день: ${mealsCount === 'three' ? '3 основных' : '5-6 маленьких'}

ТРЕБОВАНИЯ К ПЛАНУ:
1. План на 7 дней с 5 приемами пищи (завтрак, перекус, обед, перекус, ужин)
2. Соблюдение КБЖУ в рамках нормы (+/- 5%)
3. Учет пищевых предпочтений и аллергий
4. Разнообразие блюд
5. Ответ дай СТРОГО в формате Markdown с таблицами

ФОРМАТ ОТВЕТА:
# 🍽️ Персональный план питания для ${first_name}

## 📊 Дневные нормы
- **Калории:** ${daily_calories} ккал
- **Белки:** ${daily_protein} г
- **Жиры:** ${daily_fat} г  
- **Углеводы:** ${daily_carbs} г

## 📅 Недельное меню

### День 1
| Прием пищи | Блюдо | Калории | Белки | Жиры | Углеводы |
|------------|-------|---------|-------|------|----------|
| Завтрак | [блюдо с весом] | [ккал] | [г] | [г] | [г] |
| Перекус | [блюдо с весом] | [ккал] | [г] | [г] | [г] |
| Обед | [блюдо с весом] | [ккал] | [г] | [г] | [г] |
| Перекус | [блюдо с весом] | [ккал] | [г] | [г] | [г] |
| Ужин | [блюдо с весом] | [ккал] | [г] | [г] | [г] |
| **ИТОГО** | | [общие ккал] | [общие г] | [общие г] | [общие г] |

[...продолжи для всех 7 дней]

## 💡 Рекомендации
- [советы по приготовлению]
- [рекомендации по времени приема пищи]
- [альтернативы блюдам]`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Создай персональный план питания учитывая все мои данные и предпочтения.` }
            ],
            max_tokens: 2500,
        });

        const plan = response.choices[0].message.content;
        return { success: true, plan };

    } catch (error) {
        console.error('Error generating nutrition plan:', error);
        return { success: false, error: error.message };
    }
};

const answerUserQuestionStream = async (chat_id, message_id, question, profileData = null) => {
    try {
        // Показываем красивые этапы обработки
        const statusMessage = await bot.sendMessage(chat_id, '🤔 Анализирую ваш вопрос...');
        
        await new Promise(resolve => setTimeout(resolve, 800));
        await bot.editMessageText('💭 Размышляю над ответом...', {
            chat_id: chat_id,
            message_id: statusMessage.message_id
        });

        let systemPrompt = `Ты — дружелюбный и знающий ассистент по здоровому образу жизни. Дай подробный и полезный ответ на вопрос пользователя. 

ВАЖНЫЕ ПРАВИЛА ФОРМАТИРОВАНИЯ:
- Используй четкую структуру с заголовками
- Начинай каждый новый раздел с заглавной буквы и двоеточия (например, "Рекомендации:", "Питание:", "Тренировки:")
- Делай нумерованные списки для пошаговых инструкций
- Включай конкретные цифры (калории, граммы, минуты, дни)
- Используй термины "калории", "белки", "жиры", "углеводы", "КБЖУ"
- Упоминай приемы пищи: "завтрак", "обед", "ужин", "перекус"

Всегда отвечай на русском языке. Структурируй ответ логично и дай практические советы.`;

        if (profileData) {
            systemPrompt += `\n\nКонтекст пользователя (используй его для персонализации ответа):
- Имя: ${profileData.first_name}
- Пол: ${profileData.gender}, Возраст: ${profileData.age} лет
- Рост: ${profileData.height_cm} см, Вес: ${profileData.weight_kg} кг
- Цель: ${profileData.goal}`;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        await bot.editMessageText('🧠 Формулирую персональный ответ...', {
            chat_id: chat_id,
            message_id: statusMessage.message_id
        });

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question }
            ],
            max_tokens: 800,
            temperature: 0.7,
        });

        const fullResponse = response.choices[0].message.content;
        
        await new Promise(resolve => setTimeout(resolve, 500));
        await bot.editMessageText('✍️ Оформляю ответ...', {
            chat_id: chat_id,
            message_id: statusMessage.message_id
        });

        // Форматируем финальный ответ
        const initialText = `🎤 **Ваш вопрос:** "${question}"\n\n`;
        const beautifiedResponse = formatAIResponse(fullResponse);
        const finalText = initialText + beautifiedResponse;

        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Показываем финальный ответ
        await bot.editMessageText(finalText, {
            chat_id: chat_id,
            message_id: statusMessage.message_id,
            parse_mode: 'Markdown'
        });

        return { success: true };

    } catch (error) {
        console.error('Критическая ошибка в answerUserQuestionStream:', error);
        try {
            await bot.sendMessage(chat_id, `Произошла ошибка при генерации ответа. Пожалуйста, попробуйте еще раз.`);
        } catch (e) {
            console.error('Не удалось отправить сообщение об ошибке пользователю:', e);
        }
        return { success: false, error: 'Failed to generate or send answer.' };
    }
};

// Функция-заглушка для совместимости
const answerUserQuestion = async (question, profileData = null) => {
    // Эта функция больше не будет вызываться для потоковой передачи,
    // но оставляем ее для возможного использования в других местах
    // или для тестов.
    console.warn("Вызвана устаревшая функция answerUserQuestion");
    return { success: false, answer: "Произошла ошибка конфигурации." };
};

// --- Voice Message Processing ---
const processVoiceMessage = async (fileUrl) => {
    const fs = require('fs');
    const path = require('path');
    
    let tempFilePath = null;
    
    try {
        console.log('Processing voice message with Whisper...');
        
        // Скачиваем файл
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Создаем временный файл
        tempFilePath = path.join('/tmp', `voice_${Date.now()}.oga`);
        fs.writeFileSync(tempFilePath, buffer);
        
        // Создаем поток для чтения файла
        const audioStream = fs.createReadStream(tempFilePath);
        
        const transcription = await openai.audio.transcriptions.create({
            file: audioStream,
            model: 'whisper-1',
            language: 'ru',
        });

        return { success: true, text: transcription.text };
    } catch (error) {
        console.error('Error transcribing voice message:', error);
        return { success: false, error: 'Не удалось распознать голосовое сообщение' };
    } finally {
        // Удаляем временный файл
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
            } catch (cleanupError) {
                console.error('Error cleaning up temp file:', cleanupError);
            }
        }
    }
};

// --- Universal AI Agent ---
const processUniversalMessage = async (messageText, profileData = null) => {
    try {
        console.log('Processing message with Universal AI Agent...');
        
        let systemPrompt = `Ты — универсальный ИИ-помощник в боте для подсчета калорий и здорового образа жизни.

Проанализируй сообщение пользователя и определи его тип. Верни ТОЛЬКО JSON-объект:

{
  "message_type": "тип сообщения",
  "content_analysis": "краткий анализ содержания",
  "action_required": "какое действие нужно выполнить",
  "extracted_data": {},
  "response_text": "ответ пользователю"
}

ТИПЫ СООБЩЕНИЙ:
1. "food" - описание еды/приема пищи
   - extracted_data: {"dish_name": "название", "estimated_weight": число, "meal_description": "полное описание"}
   - action_required: "analyze_food"

2. "water" - сообщение о питье воды
   - extracted_data: {"amount_ml": число, "description": "описание"}
   - action_required: "add_water"

3. "workout" - рассказ о тренировке
   - extracted_data: {"workout_type": "тип", "duration": "время", "exercises": ["упражнения"], "intensity": "интенсивность"}
   - action_required: "log_workout"

4. "report_request" - запрос отчета
   - extracted_data: {"report_type": "daily|weekly|monthly"}
   - action_required: "generate_report"

5. "medical" - медицинские данные/анализы
   - extracted_data: {"detected_parameters": ["показатели"], "values": ["значения"]}
   - action_required: "analyze_medical"

6. "question" - вопрос о питании/тренировках/здоровье
   - extracted_data: {"topic": "тема вопроса", "question_type": "тип"}
   - action_required: "answer_question"

7. "mood_sharing" - рассказ о самочувствии/настроении/впечатлениях
   - extracted_data: {"mood": "настроение", "energy_level": "уровень энергии", "context": "контекст"}
   - action_required: "supportive_response"

8. "general" - общение, приветствие, благодарность
   - extracted_data: {}
   - action_required: "friendly_response"

ВАЖНО: response_text должен быть дружелюбным, мотивирующим и полезным!`;

        if (profileData) {
            systemPrompt += `\n\nИнформация о пользователе:
- Имя: ${profileData.first_name}
- Пол: ${profileData.gender}
- Возраст: ${profileData.age} лет
- Рост: ${profileData.height_cm} см
- Текущий вес: ${profileData.weight_kg} кг
${profileData.target_weight_kg ? `- Целевой вес: ${profileData.target_weight_kg} кг` : ''}
${profileData.timeframe_months ? `- Срок достижения цели: ${profileData.timeframe_months} месяцев` : ''}
- Цель: ${profileData.goal}`;
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // Быстрая модель для классификации
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Проанализируй это сообщение: "${messageText}"` }
            ],
            max_tokens: 300, // Уменьшили в 2 раза для скорости
            temperature: 0.1, // Более детерминированный результат
        });

        const content = response.choices[0].message.content;
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedContent = JSON.parse(jsonString);

        return { success: true, data: parsedContent };

    } catch (error) {
        console.error('Error processing universal message:', error);
        return { success: false, reason: 'Ошибка при обработке сообщения' };
    }
};

// --- Medical Data Analysis ---
const analyzeMedicalData = async (medicalText, profileData = null) => {
    try {
        console.log('Analyzing medical data with AI...');
        
        let systemPrompt = `Ты — врач-диетолог и нутрициолог. Проанализируй медицинские данные и дай рекомендации по питанию.

Верни JSON-объект:
{
  "detected_parameters": ["список обнаруженных показателей"],
  "analysis_summary": "краткий анализ состояния здоровья",
  "nutrition_recommendations": {
    "foods_to_include": ["продукты которые стоит добавить"],
    "foods_to_avoid": ["продукты которые стоит ограничить"],
    "supplements": ["рекомендуемые добавки"]
  },
  "health_alerts": ["важные предупреждения если есть"]
}`;

        if (profileData) {
            systemPrompt += `\n\nИнформация о пользователе: ${profileData.gender}, ${profileData.age} лет, ${profileData.height_cm} см, ${profileData.weight_kg} кг`;
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: medicalText }
            ],
            max_tokens: 600,
        });

        const content = response.choices[0].message.content;
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedContent = JSON.parse(jsonString);

        return { success: true, data: parsedContent };

    } catch (error) {
        console.error('Error analyzing medical data:', error);
        return { success: false, reason: 'Ошибка при анализе медицинских данных' };
    }
};

// ... rest of the code ...

const addWorkoutRecord = async (telegram_id, workoutData) => {
    try {
        console.log('Adding workout record with data:', workoutData);
        
        // Преобразуем массив упражнений в строку если это массив
        const exercisesString = Array.isArray(workoutData.exercises) 
            ? workoutData.exercises.join(', ') 
            : workoutData.exercises || '';
        
        // Попробуем записать только основные поля сначала
        const basicData = {
            telegram_id: String(telegram_id),
            workout_type: workoutData.workout_type || 'general',
            duration_minutes: parseInt(workoutData.duration) || 30,
            date: new Date().toISOString().split('T')[0]
        };
        
        console.log('Trying to insert basic workout data:', basicData);

        const { data, error } = await supabase
            .from('workout_records')
            .insert({
                ...basicData,
                created_at: new Date().toISOString()
            });

        if (error) {
            console.error('Supabase error details:', error);
            console.error('Full error object:', JSON.stringify(error, null, 2));
            throw error;
        }
        return { success: true, data };
    } catch (error) {
        console.error('Error adding workout record:', error);
        console.error('Full error:', JSON.stringify(error, null, 2));
        return { success: false, error: error.message || JSON.stringify(error) };
    }
};

const getWorkoutTrackingStats = async (telegram_id, period = 'today') => {
    try {
        let startDate;
        const today = new Date();
        
        switch (period) {
            case 'today':
                startDate = new Date(today).toISOString().split('T')[0];
                break;
            case 'week':
                const weekStart = new Date(today.setDate(today.getDate() - 7));
                startDate = weekStart.toISOString().split('T')[0];
                break;
            case 'month':
                const monthStart = new Date(today.setDate(today.getDate() - 30));
                startDate = monthStart.toISOString().split('T')[0];
                break;
        }

        const { data: workouts, error } = await supabase
            .from('workout_records')
            .select('*')
            .eq('telegram_id', telegram_id)
            .gte('date', startDate)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const stats = {
            totalWorkouts: workouts ? workouts.length : 0,
            totalCalories: 0,
            totalDuration: 0,
            workoutTypes: {},
            byDate: {}
        };

        if (workouts && workouts.length > 0) {
            workouts.forEach(workout => {
                stats.totalCalories += workout.calories_burned || 0;
                stats.totalDuration += workout.duration_minutes || 0;
                
                // Группировка по типам
                const type = workout.workout_type || 'other';
                stats.workoutTypes[type] = (stats.workoutTypes[type] || 0) + 1;
                
                // Группировка по датам
                const date = workout.date;
                if (!stats.byDate[date]) {
                    stats.byDate[date] = { count: 0, calories: 0, duration: 0 };
                }
                stats.byDate[date].count += 1;
                stats.byDate[date].calories += workout.calories_burned || 0;
                stats.byDate[date].duration += workout.duration_minutes || 0;
            });
        }

        return { success: true, ...stats, workouts };
    } catch (error) {
        console.error('Error getting workout stats:', error);
        return { success: false, error: error.message };
    }
};

const getWorkoutPlanProgress = async (telegram_id) => {
    try {
        // Сначала получаем user_id по telegram_id
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return { success: false, reason: 'Профиль пользователя не найден' };
        }

        // Получаем план тренировок пользователя
        const { data: planData, error: planError } = await supabase
            .from('workout_plan_data')
            .select('*')
            .eq('user_id', profile.id)
            .single();

        if (planError || !planData) {
            return { success: false, reason: 'План тренировок не найден' };
        }

        // Получаем выполненные тренировки за эту неделю
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Начало недели
        const weekStartStr = weekStart.toISOString().split('T')[0];

        const { data: weekWorkouts, error: workoutError } = await supabase
            .from('workout_records')
            .select('*')
            .eq('telegram_id', telegram_id)
            .gte('date', weekStartStr);

        if (workoutError) throw workoutError;

        const completedWorkouts = weekWorkouts ? weekWorkouts.length : 0;
        const plannedWorkouts = parseInt(planData.frequency_per_week) || 3;
        const progressPercentage = Math.round((completedWorkouts / plannedWorkouts) * 100);

        return {
            success: true,
            completed: completedWorkouts,
            planned: plannedWorkouts,
            progress: Math.min(progressPercentage, 100), // Максимум 100%
            weekWorkouts: weekWorkouts || []
        };
    } catch (error) {
        console.error('Error getting workout plan progress:', error);
        return { success: false, error: error.message };
    }
};

const createWorkoutProgressBar = (completed, planned) => {
    const percentage = Math.round((completed / planned) * 100);
    const filledBlocks = Math.round((percentage / 100) * 10);
    const emptyBlocks = 10 - filledBlocks;
    
    const filled = '🟩'.repeat(filledBlocks);
    const empty = '⬜'.repeat(emptyBlocks);
    
    return `${filled}${empty} ${percentage}%`;
};

const generateWorkoutPlanHTML = (planContent, profileData, planData) => {
    const safeProfileData = {
        first_name: profileData?.first_name || 'Пользователь',
        age: profileData?.age || 'не указан',
        height_cm: profileData?.height_cm || 'не указан',
        weight_kg: profileData?.weight_kg || 'не указан',
        goal: profileData?.goal || 'не указана'
    };

    const safePlanData = {
        experience: planData?.experience || 'не указан',
        frequency_per_week: planData?.frequency_per_week || 'не указана'
    };

    const currentDate = new Date().toLocaleDateString('ru-RU');

    let dayCards = '';
    if (planContent && typeof planContent === 'string') {
        const lines = planContent.split('\n');
        let currentDay = '';
        let exercises = [];

        lines.forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.includes('День') || trimmedLine.includes('DAY')) {
                if (currentDay && exercises.length > 0) {
                    dayCards += `<div class="day-card"><h3>${currentDay}</h3><div class="exercises">${exercises.join('')}</div></div>`;
                }
                currentDay = trimmedLine;
                exercises = [];
            } else if (trimmedLine && !trimmedLine.includes('---') && trimmedLine.length > 3) {
                exercises.push(`<div class="exercise-text">${trimmedLine}</div>`);
            }
        });

        if (currentDay && exercises.length > 0) {
            dayCards += `<div class="day-card"><h3>${currentDay}</h3><div class="exercises">${exercises.join('')}</div></div>`;
        }
    }

    if (!dayCards) {
        dayCards = `
            <div class="day-card">
                <h3>📋 Ваш план тренировок</h3>
                <div class="exercises">
                    <div class="exercise-text">${planContent || 'План тренировок генерируется...'}</div>
                </div>
            </div>
        `;
    }

    return `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>💪 Персональный план тренировок</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
                color: #333;
                line-height: 1.6;
            }
            
            .container {
                max-width: 900px;
                margin: 0 auto;
                background: white;
                border-radius: 20px;
                box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                overflow: hidden;
            }
            
            .header {
                background: linear-gradient(135deg, #FF6B6B, #4ECDC4);
                color: white;
                padding: 40px 30px;
                text-align: center;
            }
            
            .header h1 {
                font-size: 2.5rem;
                margin-bottom: 10px;
                font-weight: 700;
            }
            
            .header p {
                font-size: 1.2rem;
                opacity: 0.9;
            }
            
            .user-info {
                background: #f8f9fa;
                padding: 30px;
                margin: 25px;
                border-radius: 15px;
                border: 2px solid #e9ecef;
            }
            
            .user-info h3 {
                color: #FF6B6B;
                margin-bottom: 20px;
                font-size: 1.4rem;
            }
            
            .info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 15px;
            }
            
            .info-item {
                padding: 15px;
                background: white;
                border-radius: 10px;
                border: 1px solid #dee2e6;
            }
            
            .info-label {
                font-weight: 600;
                color: #6c757d;
                font-size: 0.9rem;
                margin-bottom: 5px;
            }
            
            .info-value {
                color: #FF6B6B;
                font-size: 1.1rem;
                font-weight: 600;
            }
            
            .day-card {
                margin: 25px;
                background: white;
                border-radius: 15px;
                border: 2px solid #e9ecef;
                overflow: hidden;
                box-shadow: 0 5px 15px rgba(0,0,0,0.08);
            }
            
            .day-card h3 {
                background: linear-gradient(135deg, #FF6B6B, #4ECDC4);
                color: white;
                padding: 20px;
                margin: 0;
                font-size: 1.3rem;
                text-align: center;
            }
            
            .exercises {
                padding: 25px;
            }
        
        .exercise-row {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            gap: 15px;
            padding: 15px;
            margin: 10px 0;
            background: #f8f9fa;
            border-radius: 10px;
            border-left: 4px solid #FF6B6B;
            align-items: center;
        }
        
        .exercise-name {
            font-weight: 600;
            color: #333;
            font-size: 1.1rem;
        }
        
        .exercise-sets, .exercise-reps, .exercise-rest {
            text-align: center;
        }
        
        .exercise-label {
            display: block;
            font-size: 0.8rem;
            color: #6c757d;
            margin-bottom: 2px;
        }
        
        .exercise-value {
            font-weight: 600;
            color: #FF6B6B;
            font-size: 1rem;
        }
        
        .rest-day {
            text-align: center;
            padding: 30px;
            font-size: 1.2rem;
            color: #6c757d;
            background: #f8f9fa;
            border-radius: 10px;
        }
        
        .exercise-text {
            margin: 10px 0;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
            border-left: 3px solid #4ECDC4;
        }
        
        .footer {
            background: #f8f9fa;
            padding: 30px;
            text-align: center;
            border-top: 1px solid #e9ecef;
        }
        
        @media (max-width: 768px) {
            .exercise-row {
                grid-template-columns: 1fr;
                text-align: center;
            }
            
            .container {
                margin: 10px;
                border-radius: 15px;
            }
            
            .header {
                padding: 20px 15px;
            }
            
            .header h1 {
                font-size: 2rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>💪 Персональный План Тренировок</h1>
            <p>Создан специально для ${safeProfileData.first_name}</p>
            <p>📅 ${currentDate}</p>
        </div>
        
        <div class="user-info">
            <h3>👤 Информация о пользователе</h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Имя</div>
                    <div class="info-value">${safeProfileData.first_name}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Возраст</div>
                    <div class="info-value">${safeProfileData.age} лет</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Рост</div>
                    <div class="info-value">${safeProfileData.height_cm} см</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Вес</div>
                    <div class="info-value">${safeProfileData.weight_kg} кг</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Цель</div>
                    <div class="info-value">${safeProfileData.goal === 'lose_weight' ? 'Похудение' : safeProfileData.goal === 'gain_mass' ? 'Набор массы' : 'Поддержание формы'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Опыт тренировок</div>
                    <div class="info-value">${safePlanData.experience}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Частота в неделю</div>
                    <div class="info-value">${safePlanData.frequency_per_week} раз</div>
                </div>
            </div>
        </div>
        
        ${dayCards}
        
        <div class="footer">
            <p>🎯 <strong>Следуйте плану регулярно для достижения лучших результатов!</strong></p>
            <p>💡 Не забывайте о правильном питании и достаточном количестве воды</p>
            <p>⚠️ При возникновении дискомфорта или боли немедленно прекратите упражнение</p>
        </div>
    </div>
</body>
</html>
    `;
};

const generateNutritionPlanHTML = (planContent, profileData, planData) => {
    const safeProfileData = {
        first_name: profileData?.first_name || 'Пользователь',
        age: profileData?.age || 'не указан',
        height_cm: profileData?.height_cm || 'не указан',
        weight_kg: profileData?.weight_kg || 'не указан',
        goal: profileData?.goal || 'не указана',
        daily_calories: profileData?.daily_calories || 'не указаны',
        daily_protein: profileData?.daily_protein || 'не указаны',
        daily_fat: profileData?.daily_fat || 'не указаны',
        daily_carbs: profileData?.daily_carbs || 'не указаны'
    };

    const safePlanData = {
        meals_per_day: planData?.meals_per_day || 'не указано',
        mealsCount: planData?.mealsCount || 'не указано'
    };

    const currentDate = new Date().toLocaleDateString('ru-RU');

    // Обработка содержимого плана питания
    let dailyMeals = '';
    if (planContent && typeof planContent === 'string') {
        const lines = planContent.split('\n');
        let currentDay = '';
        let currentMeal = '';
        let mealItems = [];

        lines.forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.includes('День') || trimmedLine.includes('DAY')) {
                if (currentDay && mealItems.length > 0) {
                    dailyMeals += generateDayCard(currentDay, mealItems);
                }
                currentDay = trimmedLine;
                mealItems = [];
                currentMeal = '';
            } else if (trimmedLine.match(/^(Завтрак|Обед|Ужин|Перекус|Breakfast|Lunch|Dinner|Snack)/i)) {
                if (currentMeal && mealItems.length > 0) {
                    // Добавляем предыдущий прием пищи
                }
                currentMeal = trimmedLine;
            } else if (trimmedLine && !trimmedLine.includes('---') && trimmedLine.length > 3) {
                mealItems.push({ meal: currentMeal, item: trimmedLine });
            }
        });

        if (currentDay && mealItems.length > 0) {
            dailyMeals += generateDayCard(currentDay, mealItems);
        }
    }

    function generateDayCard(dayTitle, mealItems) {
        let mealsHtml = '';
        let currentMeal = '';
        
        mealItems.forEach(item => {
            if (item.meal && item.meal !== currentMeal) {
                if (currentMeal) mealsHtml += '</div>';
                mealsHtml += `<div class="meal-title">${item.meal}</div><div class="meal-group">`;
                currentMeal = item.meal;
            }
            mealsHtml += `<div class="meal-item">${item.item}</div>`;
        });
        
        if (currentMeal) mealsHtml += '</div>';
        
        return `
            <div class="day-card">
                <h3>${dayTitle}</h3>
                <div class="meals">
                    ${mealsHtml}
                </div>
            </div>
        `;
    }

    if (!dailyMeals) {
        dailyMeals = `
            <div class="day-card">
                <h3>📋 Ваш план питания</h3>
                <div class="meals">
                    <div class="meal-item">${planContent || 'План питания генерируется...'}</div>
                </div>
            </div>
        `;
    }



    return `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>🥗 Персональный план питания</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
                color: #333;
                line-height: 1.6;
            }
            
            .container {
                max-width: 900px;
                margin: 0 auto;
                background: white;
                border-radius: 20px;
                box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                overflow: hidden;
            }
            
            .header {
                background: linear-gradient(135deg, #4CAF50, #45a049);
                color: white;
                padding: 40px 30px;
                text-align: center;
            }
            
            .header h1 {
                font-size: 2.5rem;
                margin-bottom: 10px;
                font-weight: 700;
            }
            
            .header p {
                font-size: 1.2rem;
                opacity: 0.9;
            }
            
            .user-info {
                background: #f8f9fa;
                padding: 30px;
                margin: 25px;
                border-radius: 15px;
                border: 2px solid #e9ecef;
            }
            
            .user-info h3 {
                color: #4CAF50;
                margin-bottom: 20px;
                font-size: 1.4rem;
            }
            
            .info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 15px;
            }
            
            .info-item {
                padding: 15px;
                background: white;
                border-radius: 10px;
                border: 1px solid #dee2e6;
            }
            
            .info-label {
                font-weight: 600;
                color: #6c757d;
                font-size: 0.9rem;
                margin-bottom: 5px;
            }
            
            .info-value {
                color: #4CAF50;
                font-size: 1.1rem;
                font-weight: 600;
            }
            
            .day-card {
                margin: 25px;
                background: white;
                border-radius: 15px;
                border: 2px solid #e9ecef;
                overflow: hidden;
                box-shadow: 0 5px 15px rgba(0,0,0,0.08);
            }
            
            .day-card h3 {
                background: linear-gradient(135deg, #FF6B6B, #4ECDC4);
                color: white;
                padding: 20px;
                margin: 0;
                font-size: 1.3rem;
                text-align: center;
            }
            
            .meals {
                padding: 25px;
            }
            
            .meal-title {
                margin: 20px 0 10px 0;
                font-size: 1.2rem;
                font-weight: 600;
                color: #4CAF50;
                padding: 10px 15px;
                background: #f8f9fa;
                border-radius: 8px;
                border-left: 4px solid #4CAF50;
            }
            
            .meal-item {
                margin: 8px 0;
                padding: 12px 15px;
                background: #f8f9fa;
                border-radius: 8px;
                border-left: 3px solid #4CAF50;
                transition: transform 0.2s ease;
            }
            
            .meal-item:hover {
                transform: translateX(5px);
                background: #e8f5e9;
            }
            
            .footer {
                background: #333;
                color: white;
                padding: 25px;
                text-align: center;
            }
            
            .footer p {
                margin: 5px 0;
            }
            
            @media (max-width: 768px) {
                .container {
                    margin: 10px;
                    border-radius: 15px;
                }
                
                .info-grid {
                    grid-template-columns: 1fr;
                }
                
                .header {
                    padding: 25px 20px;
                }
                
                .header h1 {
                    font-size: 2rem;
                }
                
                .user-info, .day-card {
                    margin: 15px;
                    padding: 20px;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🥗 Персональный план питания</h1>
                <div class="user-info">
                    <div class="user-details">
                        <p><strong>Имя:</strong> ${profileData.first_name}</p>
                        <p><strong>Цель:</strong> ${goalText}</p>
                        <p><strong>Дневная норма калорий:</strong> ${profileData.daily_calories} ккал</p>
                        <p><strong>План создан:</strong> ${new Date().toLocaleDateString('ru-RU')}</p>
                    </div>
                </div>
                <div class="content">
                    ${planContent}
                </div>
            </div>
        </div>
    </body>
</html>
    `;
};


// Отправка плана в виде HTML документа
const sendPlanAsDocument = async (chatId, planType, htmlContent, filename) => {
    try {
        // Создаем временный файл
        const fs = require('fs');
        const path = require('path');
        const tempDir = path.join(__dirname, 'temp');
        
        // Создаем папку temp если её нет
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const filePath = path.join(tempDir, filename);
        
        // Записываем HTML в файл
        fs.writeFileSync(filePath, htmlContent, 'utf8');
        
        // Отправляем файл
        await bot.sendDocument(chatId, filePath, {
            caption: `📄 Ваш персональный ${planType === 'workout' ? 'план тренировок' : 'план питания'}!\n\n✨ Откройте файл в браузере для лучшего просмотра\n📱 Можно сохранить и распечатать\n🎯 Следуйте плану для достижения целей!`,
            reply_markup: {
                inline_keyboard: [[
                    { text: '📊 Отчет за день', callback_data: 'daily_report' },
                    { text: '🏠 Главное меню', callback_data: 'main_menu' }
                ]]
            }
        });
        
        // Удаляем временный файл
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);
        
    } catch (error) {
        console.error('Ошибка отправки документа:', error);
        await bot.sendMessage(chatId, '❌ Ошибка при создании документа. Попробуйте еще раз.');
    }
};

// --- OCR for Documents ---
const extractTextFromImage = async (imageUrl) => {
    try {
        console.log('Extracting text from image with OCR...');
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'Ты эксперт по распознаванию текста. Извлеки весь текст из изображения, сохраняя структуру документа. Если это медицинский анализ, сохрани все показатели и их значения.'
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Извлеки весь текст из этого изображения:' },
                        {
                            type: 'image_url',
                            image_url: { url: imageUrl }
                        }
                    ]
                }
            ],
            max_tokens: 1000,
        });

        const extractedText = response.choices[0].message.content;
        return { success: true, text: extractedText };

    } catch (error) {
        console.error('Error extracting text from image:', error);
        return { success: false, error: 'Не удалось извлечь текст из изображения' };
    }
};

// --- Water Tracking Functions ---
const calculateWaterNorm = (weight_kg) => {
    // Рекомендуемая норма: 30-35 мл на кг веса
    return Math.round(weight_kg * 32.5); // Берем среднее значение
};

const addWaterIntake = async (telegram_id, amount_ml) => {
    try {
        // Получаем профиль пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            throw new Error('Профиль пользователя не найден');
        }

        // Добавляем запись о воде
        const { error: insertError } = await supabase
            .from('water_intake')
            .insert({
                user_id: profile.id,
                amount_ml: amount_ml,
                recorded_at: new Date().toISOString()
            });

        if (insertError) throw insertError;

        return { success: true };
    } catch (error) {
        console.error('Error adding water intake:', error);
        return { success: false, error: error.message };
    }
};

const getWaterStats = async (telegram_id, period) => {
    try {
        // Получаем профиль пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, weight_kg')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            throw new Error('Профиль пользователя не найден');
        }

        // Получаем данные за период
        const { startDate, endDate } = getDateRange(period);
        
        const { data: waterRecords, error: waterError } = await supabase
            .from('water_intake')
            .select('amount_ml, recorded_at')
            .eq('user_id', profile.id)
            .gte('recorded_at', startDate.toISOString())
            .lte('recorded_at', endDate.toISOString())
            .order('recorded_at', { ascending: false });

        if (waterError) throw waterError;

        const waterNorm = calculateWaterNorm(profile.weight_kg);
        
        let totalWater = 0;
        let dailyStats = {};

        if (waterRecords && waterRecords.length > 0) {
            waterRecords.forEach(record => {
                totalWater += record.amount_ml;
                
                const recordDate = new Date(record.recorded_at).toISOString().split('T')[0];
                if (!dailyStats[recordDate]) {
                    dailyStats[recordDate] = 0;
                }
                dailyStats[recordDate] += record.amount_ml;
            });
        }

        return {
            success: true,
            totalWater,
            waterNorm,
            dailyStats,
            recordsCount: waterRecords ? waterRecords.length : 0
        };
    } catch (error) {
        console.error('Error getting water stats:', error);
        return { success: false, error: error.message };
    }
};

const showWaterMenu = async (chat_id, telegram_id) => {
    try {
        // Получаем сегодняшнюю статистику
        const waterStats = await getWaterStats(telegram_id, 'today');
        
        if (!waterStats.success) {
            bot.sendMessage(chat_id, 'Ошибка при получении данных о воде.');
            return;
        }

        const { totalWater, waterNorm } = waterStats;
        const today = new Date().toISOString().split('T')[0];
        const todayWater = waterStats.dailyStats[today] || 0;
        
        const percentage = Math.round((todayWater / waterNorm) * 100);
        const progressBar = createProgressBar(todayWater, waterNorm);

        let waterText = `💧 **Отслеживание воды**\n\n`;
        waterText += `📊 Сегодня: ${todayWater} / ${waterNorm} мл (${percentage}%)\n`;
        waterText += `${progressBar}\n\n`;
        waterText += `Выберите количество для добавления:`;

        bot.sendMessage(chat_id, waterText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '💧 100 мл', callback_data: 'water_add_100' },
                        { text: '💧 200 мл', callback_data: 'water_add_200' }
                    ],
                    [
                        { text: '💧 250 мл', callback_data: 'water_add_250' },
                        { text: '💧 500 мл', callback_data: 'water_add_500' }
                    ],
                    [
                        { text: '📊 Статистика воды', callback_data: 'water_stats' },
                        { text: '✏️ Свое количество', callback_data: 'water_custom' }
                    ]
                ]
            }
        });
    } catch (error) {
        console.error('Error showing water menu:', error);
        bot.sendMessage(chat_id, 'Произошла ошибка. Попробуйте позже.');
    }
};

const createProgressBar = (consumed, norm) => {
    if (!norm || norm === 0) return '';
    const percentage = Math.min(100, (consumed / norm) * 100);
    const filledBlocks = Math.round(percentage / 10);
    const emptyBlocks = 10 - filledBlocks;
    return `[${'■'.repeat(filledBlocks)}${'□'.repeat(emptyBlocks)}] ${percentage.toFixed(0)}%`;
};

// --- Profile Menu Function ---
const showProfileMenu = async (chat_id, telegram_id) => {
    try {
        // Получаем полную информацию о профиле
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('telegram_id', telegram_id)
            .single();

        if (error || !profile) {
            bot.sendMessage(chat_id, 'Профиль не найден. Нажмите /start для регистрации.');
            return;
        }

        // Преобразуем цель в человекочитаемый вид
        const goalText = profile.goal === 'lose_weight' ? 'Похудение' :
                        profile.goal === 'gain_mass' ? 'Набор массы' :
                        profile.goal === 'maintain' ? 'Поддержание веса' : profile.goal;

        // Экранируем специальные символы для Markdown
        const escapeName = (name) => name.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

        // Формируем текст профиля без markdown для безопасности
        let profileText = `👤 Ваш профиль\n\n`;
        profileText += `👋 Имя: ${escapeName(profile.first_name)}\n`;
        profileText += `👤 Пол: ${profile.gender === 'male' ? '👨 Мужской' : '👩 Женский'}\n`;
        profileText += `🎂 Возраст: ${profile.age} лет\n`;
        profileText += `📏 Рост: ${profile.height_cm} см\n`;
        profileText += `⚖️ Текущий вес: ${profile.weight_kg} кг\n`;
        
        // Проверяем наличие дополнительных полей
        if (profile.target_weight_kg) {
            profileText += `🏆 Целевой вес: ${profile.target_weight_kg} кг\n`;
        }
        
        if (profile.timeframe_months) {
            profileText += `⏱️ Срок достижения: ${profile.timeframe_months} месяцев\n`;
        }
        
        profileText += `🎯 Цель: ${goalText}\n\n`;
        
        profileText += `📊 Дневные нормы:\n`;
        profileText += `🔥 Калории: ${profile.daily_calories} ккал\n`;
        profileText += `🥩 Белки: ${profile.daily_protein} г\n`;
        profileText += `🥑 Жиры: ${profile.daily_fat} г\n`;
        profileText += `🍞 Углеводы: ${profile.daily_carbs} г\n`;
        profileText += `💧 Вода: ${calculateWaterNorm(profile.weight_kg)} мл\n\n`;
        
        profileText += `Что хотите изменить?`;

        bot.sendMessage(chat_id, profileText, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '👋 Имя', callback_data: 'profile_edit_name' },
                        { text: '🎂 Возраст', callback_data: 'profile_edit_age' }
                    ],
                    [
                        { text: '📏 Рост', callback_data: 'profile_edit_height' },
                        { text: '⚖️ Вес', callback_data: 'profile_edit_weight' }
                    ],
                    [
                        { text: '🏆 Целевой вес', callback_data: 'profile_edit_target_weight' },
                        { text: '⏱️ Срок', callback_data: 'profile_edit_timeframe' }
                    ],
                    [
                        { text: '🎯 Цель', callback_data: 'profile_edit_goal' },
                        { text: '👤 Пол', callback_data: 'profile_edit_gender' }
                    ]
                ]
            }
        });
    } catch (error) {
        console.error('Error showing profile menu:', error);
        bot.sendMessage(chat_id, 'Произошла ошибка при загрузке профиля. Попробуйте позже.');
    }
};

// --- Challenge System Functions ---
const generateWeeklyChallenge = async () => {
    try {
        logEvent('info', 'Generating weekly challenge');
        
        const response = await withTimeout(openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `Ты - мотивирующий фитнес-тренер. Создай еженедельный челлендж для пользователей фитнес-бота.

ТРЕБОВАНИЯ:
- Челлендж должен быть связан со здоровьем и фитнесом
- Мотивирующий и достижимый для обычного человека
- Включать конкретную цель с числами
- Быть интересным и разнообразным

ПРИМЕРЫ ХОРОШИХ ЧЕЛЛЕНДЖЕЙ:
- "Пройти 70,000 шагов за неделю!"
- "Выпить 14 литров воды за неделю!"
- "Сделать 500 приседаний за неделю!"
- "Заниматься спортом 5 дней по 30 минут!"
- "Пройти 10 км за неделю!"

Верни ТОЛЬКО JSON в формате:
{
  "title": "Краткое название челленджа",
  "description": "Подробное описание (2-3 предложения)",
  "target_value": число - целевое значение,
  "unit": "единица измерения (шаги, литры, минуты, км, раз)",
  "type": "тип челленджа (steps, water, workout_time, distance, exercises)",
  "motivation": "Мотивирующее сообщение (1-2 предложения)"
}`
                },
                {
                    role: 'user',
                    content: 'Создай новый еженедельный челлендж для этой недели!'
                }
            ],
            max_tokens: 400,
        }), 15000);

        const content = response.choices[0].message.content;
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const challengeData = JSON.parse(jsonString);

        logEvent('info', 'Weekly challenge generated', { title: challengeData.title });
        return { success: true, data: challengeData };

    } catch (error) {
        logEvent('error', 'Error generating weekly challenge', { error: error.toString() });
        // Возвращаем дефолтный челлендж в случае ошибки
        return {
            success: true,
            data: {
                title: "Пройти 70,000 шагов за неделю!",
                description: "Активность - основа здоровья! Двигайтесь каждый день и достигните 70,000 шагов за неделю.",
                target_value: 70000,
                unit: "шагов",
                type: "steps",
                motivation: "Каждый шаг приближает вас к цели! Вы сможете это сделать! 💪"
            }
        };
    }
};

const createWeeklyChallenge = async () => {
    try {
        const challengeResult = await generateWeeklyChallenge();
        if (!challengeResult.success) throw new Error('Failed to generate challenge');

        const challengeData = challengeResult.data;
        const weekStart = new Date();
        const day = weekStart.getDay();
        const diff = weekStart.getDate() - day + (day === 0 ? -6 : 1); // Понедельник
        weekStart.setDate(diff);
        weekStart.setHours(0, 0, 0, 0);

        console.log('Creating challenge for week start:', weekStart.toISOString());

        // Сохраняем челлендж в базу данных и возвращаем сохраненные данные
        const { data: savedChallenge, error } = await supabase
            .from('weekly_challenges')
            .upsert({
                week_start: weekStart.toISOString(),
                title: challengeData.title,
                description: challengeData.description,
                target_value: challengeData.target_value,
                unit: challengeData.unit,
                type: challengeData.type,
                motivation: challengeData.motivation,
                created_at: new Date().toISOString()
            }, { 
                onConflict: 'week_start',
                select: '*'
            })
            .single();

        if (error) {
            console.error('Error saving challenge:', error);
            throw error;
        }

        console.log('Challenge saved successfully:', savedChallenge);

        logEvent('info', 'Weekly challenge created and saved', { 
            title: challengeData.title,
            week_start: weekStart.toISOString()
        });

        return { success: true, data: savedChallenge };
    } catch (error) {
        console.error('Error in createWeeklyChallenge:', error);
        logEvent('error', 'Error creating weekly challenge', { error: error.toString() });
        return { success: false, error: error.message };
    }
};

const getCurrentChallenge = async () => {
    try {
        const now = new Date();
        const weekStart = new Date();
        const day = weekStart.getDay();
        const diff = weekStart.getDate() - day + (day === 0 ? -6 : 1); // Понедельник
        weekStart.setDate(diff);
        weekStart.setHours(0, 0, 0, 0);

        console.log('Getting challenge for week start:', weekStart.toISOString());

        const { data: challenge, error } = await supabase
            .from('weekly_challenges')
            .select('*')
            .eq('week_start', weekStart.toISOString())
            .single();

        console.log('Challenge query result:', { challenge, error });

        if (error || !challenge) {
            console.log('No challenge found, creating new one...');
            // Если челлендж не найден, создаем новый
            const createResult = await createWeeklyChallenge();
            console.log('Create challenge result:', createResult);
            
            if (createResult.success && createResult.data) {
                return { success: true, data: createResult.data };
            }
            return { success: false, error: 'No challenge found and failed to create' };
        }

        return { success: true, data: challenge };
    } catch (error) {
        console.error('Error in getCurrentChallenge:', error);
        logEvent('error', 'Error getting current challenge', { error: error.toString() });
        return { success: false, error: error.message };
    }
};

const addChallengeProgress = async (telegram_id, value) => {
    try {
        if (!value || value <= 0) {
            return { success: false, error: 'Значение должно быть больше 0' };
        }

        // Получаем профиль пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return { success: false, error: 'Профиль не найден' };
        }

        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // Добавляем прогресс в базу данных (используем поле steps для всех типов)
        const { error } = await supabase
            .from('steps_tracking')
            .upsert({
                user_id: profile.id,
                date: today,
                steps: value,
                updated_at: new Date().toISOString()
            }, { 
                onConflict: 'user_id,date',
                ignoreDuplicates: false 
            });

        if (error) throw error;

        logEvent('info', 'Challenge progress added', { telegram_id, value, date: today });
        return { success: true };

    } catch (error) {
        logEvent('error', 'Error adding challenge progress', { telegram_id, value, error: error.toString() });
        return { success: false, error: 'Ошибка при добавлении прогресса' };
    }
};

// Оставляем старую функцию для обратной совместимости
const addSteps = addChallengeProgress;

const getStepsStats = async (telegram_id, period = 'week') => {
    try {
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return { success: false, error: 'Профиль не найден' };
        }

        const now = new Date();
        let startDate, endDate;

        if (period === 'week') {
            // Текущая неделя (понедельник-воскресенье)
            const day = now.getDay();
            const diff = now.getDate() - day + (day === 0 ? -6 : 1);
            startDate = new Date(now);
            startDate.setDate(diff);
            startDate.setHours(0, 0, 0, 0);
            
            endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + 6);
            endDate.setHours(23, 59, 59, 999);
        } else {
            // today
            startDate = new Date(now);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(now);
            endDate.setHours(23, 59, 59, 999);
        }

        const { data: stepsData, error } = await supabase
            .from('steps_tracking')
            .select('date, steps')
            .eq('user_id', profile.id)
            .gte('date', startDate.toISOString().split('T')[0])
            .lte('date', endDate.toISOString().split('T')[0])
            .order('date');

        if (error) throw error;

        const totalSteps = stepsData ? stepsData.reduce((sum, day) => sum + (day.steps || 0), 0) : 0;
        
        const byDate = {};
        if (stepsData) {
            stepsData.forEach(day => {
                byDate[day.date] = day.steps || 0;
            });
        }

        return {
            success: true,
            totalSteps,
            byDate,
            period
        };

    } catch (error) {
        logEvent('error', 'Error getting steps stats', { telegram_id, period, error: error.toString() });
        return { success: false, error: 'Ошибка при получении статистики шагов' };
    }
};

const showChallengeMenu = async (chat_id, telegram_id) => {
    try {
        const challengeResult = await getCurrentChallenge();
        if (!challengeResult.success) {
            bot.sendMessage(chat_id, '❌ Не удалось загрузить текущий челлендж. Попробуйте позже.');
            return;
        }

        const challenge = challengeResult.data;
        const stepsStats = await getStepsStats(telegram_id, 'week');
        
        const totalSteps = stepsStats.success ? stepsStats.totalSteps : 0;
        const progress = Math.min(Math.round((totalSteps / challenge.target_value) * 100), 100);
        
        let challengeText = `🏆 **ЧЕЛЛЕНДЖ НЕДЕЛИ**\n\n`;
        challengeText += `**${challenge.title}**\n`;
        challengeText += `${challenge.description}\n\n`;
        
        challengeText += `📊 **Ваш прогресс:**\n`;
        challengeText += `${createProgressBar(totalSteps, challenge.target_value)}\n`;
        challengeText += `**${totalSteps.toLocaleString()} / ${challenge.target_value.toLocaleString()}** ${challenge.unit} (**${progress}%**)\n\n`;
        
        if (progress >= 100) {
            challengeText += `🎉 **ПОЗДРАВЛЯЕМ!** Вы выполнили челлендж!\n\n`;
        }
        
        // Адаптируем интерфейс под тип челленджа
        let actionText, buttons;
        
        if (challenge.type === 'steps') {
            actionText = `**Добавьте пройденные сегодня шаги:**`;
            buttons = [
                [
                    { text: '1000', callback_data: 'challenge_add_steps_1000' },
                    { text: '2000', callback_data: 'challenge_add_steps_2000' }
                ],
                [
                    { text: '3000', callback_data: 'challenge_add_steps_3000' },
                    { text: '5000', callback_data: 'challenge_add_steps_5000' }
                ],
                [
                    { text: '10000', callback_data: 'challenge_add_steps_10000' },
                    { text: '✏️ Свое число', callback_data: 'challenge_add_custom_steps' }
                ]
            ];
        } else if (challenge.type === 'workout_time' || challenge.unit.includes('минут')) {
            actionText = `**Добавьте время выполнения сегодня:**`;
            buttons = [
                [
                    { text: '5 мин', callback_data: 'challenge_add_steps_5' },
                    { text: '10 мин', callback_data: 'challenge_add_steps_10' }
                ],
                [
                    { text: '15 мин', callback_data: 'challenge_add_steps_15' },
                    { text: '30 мин', callback_data: 'challenge_add_steps_30' }
                ],
                [
                    { text: '60 мин', callback_data: 'challenge_add_steps_60' },
                    { text: '✏️ Свое число', callback_data: 'challenge_add_custom_steps' }
                ]
            ];
        } else if (challenge.type === 'water' || challenge.unit.includes('литр')) {
            actionText = `**Добавьте количество воды сегодня:**`;
            buttons = [
                [
                    { text: '0.5 л', callback_data: 'challenge_add_steps_0.5' },
                    { text: '1 л', callback_data: 'challenge_add_steps_1' }
                ],
                [
                    { text: '1.5 л', callback_data: 'challenge_add_steps_1.5' },
                    { text: '2 л', callback_data: 'challenge_add_steps_2' }
                ],
                [
                    { text: '3 л', callback_data: 'challenge_add_steps_3' },
                    { text: '✏️ Свое число', callback_data: 'challenge_add_custom_steps' }
                ]
            ];
        } else if (challenge.type === 'exercises' || challenge.unit.includes('раз')) {
            actionText = `**Добавьте количество повторений сегодня:**`;
            buttons = [
                [
                    { text: '10 раз', callback_data: 'challenge_add_steps_10' },
                    { text: '20 раз', callback_data: 'challenge_add_steps_20' }
                ],
                [
                    { text: '50 раз', callback_data: 'challenge_add_steps_50' },
                    { text: '100 раз', callback_data: 'challenge_add_steps_100' }
                ],
                [
                    { text: '200 раз', callback_data: 'challenge_add_steps_200' },
                    { text: '✏️ Свое число', callback_data: 'challenge_add_custom_steps' }
                ]
            ];
        } else {
            // Универсальный интерфейс для других типов
            actionText = `**Добавьте прогресс сегодня:**`;
            buttons = [
                [
                    { text: '1', callback_data: 'challenge_add_steps_1' },
                    { text: '5', callback_data: 'challenge_add_steps_5' }
                ],
                [
                    { text: '10', callback_data: 'challenge_add_steps_10' },
                    { text: '25', callback_data: 'challenge_add_steps_25' }
                ],
                [
                    { text: '50', callback_data: 'challenge_add_steps_50' },
                    { text: '✏️ Свое число', callback_data: 'challenge_add_custom_steps' }
                ]
            ];
        }
        
        challengeText += actionText;
        
        // Добавляем кнопку статистики
        buttons.push([
            { text: '📊 Статистика за неделю', callback_data: 'challenge_stats' }
        ]);

        bot.sendMessage(chat_id, challengeText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

    } catch (error) {
        console.error('Error showing challenge menu:', error);
        bot.sendMessage(chat_id, 'Произошла ошибка при загрузке челленджа. Попробуйте позже.');
    }
};

const sendWeeklyChallengeNotifications = async (type = 'new') => {
    try {
        logEvent('info', 'Sending weekly challenge notifications', { type });

        // Получаем всех пользователей с уведомлениями
        const { data: users, error } = await supabase
            .from('profiles')
            .select('telegram_id, first_name')
            .eq('notifications_enabled', true);

        if (error) throw error;

        const challengeResult = await getCurrentChallenge();
        if (!challengeResult.success) {
            logEvent('error', 'Failed to get current challenge for notifications');
            return;
        }

        const challenge = challengeResult.data;
        let messageText = '';

        if (type === 'new') {
            messageText = `🚀 **НОВЫЙ ЧЕЛЛЕНДЖ НЕДЕЛИ!**\n\n`;
            messageText += `**${challenge.title}**\n`;
            messageText += `${challenge.description}\n\n`;
            messageText += `💪 ${challenge.motivation}\n\n`;
            messageText += `Заходите в меню "Челлендж" и начинайте добавлять свои шаги! 🚶‍♂️`;
        } else if (type === 'reminder') {
            messageText = `⏰ **НАПОМИНАНИЕ О ЧЕЛЛЕНДЖЕ**\n\n`;
            messageText += `Не забывайте про текущий челлендж:\n`;
            messageText += `**${challenge.title}**\n\n`;
            messageText += `Проверьте свой прогресс в меню "Челлендж"! 📊`;
        }

        if (!users || users.length === 0) {
            logEvent('warn', 'No users found for challenge notifications');
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        for (const user of users) {
            try {
                await bot.sendMessage(user.telegram_id, messageText, {
                    parse_mode: 'Markdown'
                });
                successCount++;
                
                // Небольшая задержка между сообщениями
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                console.error(`Failed to send challenge notification to ${user.telegram_id}:`, error);
                errorCount++;
            }
        }

        logEvent('info', 'Challenge notifications sent', {
            type,
            total: users.length,
            success: successCount,
            errors: errorCount
        });

    } catch (error) {
        logEvent('error', 'Error sending challenge notifications', { type, error: error.toString() });
    }
};

// --- Daily Reports Functions ---
const generateDailyReport = async (telegram_id) => {
    try {
        // Получаем профиль пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, first_name, weight_kg, daily_calories, daily_protein, daily_fat, daily_carbs')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return null; // Пропускаем пользователей без профиля
        }

        // Получаем данные за сегодня
        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
        const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

        // Получаем еду за сегодня
        const { data: todayMeals } = await supabase
            .from('meals')
            .select('calories, protein, fat, carbs, description')
            .eq('user_id', profile.id)
            .gte('eaten_at', todayStart.toISOString())
            .lte('eaten_at', todayEnd.toISOString());

        // Получаем воду за сегодня
        const waterStats = await getWaterStats(telegram_id, 'today');
        const todayDateString = today.toISOString().split('T')[0];
        const todayWater = waterStats.success ? (waterStats.dailyStats[todayDateString] || 0) : 0;
        const waterNorm = waterStats.success ? waterStats.waterNorm : calculateWaterNorm(profile.weight_kg);

        // Получаем тренировки за сегодня
        const workoutStats = await getWorkoutTrackingStats(telegram_id, 'today');
        const todayWorkoutCalories = workoutStats.success ? (workoutStats.byDate[todayDateString]?.calories || 0) : 0;
        const todayWorkoutCount = workoutStats.success ? (workoutStats.byDate[todayDateString]?.count || 0) : 0;
        const todayWorkoutDuration = workoutStats.success ? (workoutStats.byDate[todayDateString]?.duration || 0) : 0;

        // Подсчитываем калории и БЖУ
        const totals = todayMeals ? todayMeals.reduce((acc, meal) => {
            acc.calories += meal.calories || 0;
            acc.protein += meal.protein || 0;
            acc.fat += meal.fat || 0;
            acc.carbs += meal.carbs || 0;
            return acc;
        }, { calories: 0, protein: 0, fat: 0, carbs: 0 }) : { calories: 0, protein: 0, fat: 0, carbs: 0 };

        // Формируем отчет
        let reportText = `🌙 **Ваш отчет за сегодня, ${profile.first_name}!**\n\n`;

        // Проверяем, есть ли данные
        if ((!todayMeals || todayMeals.length === 0) && todayWater === 0 && todayWorkoutCount === 0) {
            reportText += `📋 Сегодня не было записей о еде, воде и тренировках.\n`;
            reportText += `💡 Не забывайте отслеживать свое питание, водный баланс и активность!\n\n`;
            reportText += `Хорошего вечера! 🌟`;
            return reportText;
        }

        // Статистика питания
        if (todayMeals && todayMeals.length > 0) {
            const caloriePercentage = Math.round((totals.calories / profile.daily_calories) * 100);
            reportText += `🍽️ **Питание:**\n`;
            reportText += `🔥 Калории: ${totals.calories} / ${profile.daily_calories} (${caloriePercentage}%)\n`;
            reportText += `${createProgressBar(totals.calories, profile.daily_calories)}\n\n`;

            reportText += `**БЖУ за день:**\n`;
            reportText += `🥩 Белки: ${totals.protein.toFixed(0)} / ${profile.daily_protein} г\n`;
            reportText += `🥑 Жиры: ${totals.fat.toFixed(0)} / ${profile.daily_fat} г\n`;
            reportText += `🍞 Углеводы: ${totals.carbs.toFixed(0)} / ${profile.daily_carbs} г\n\n`;
        } else {
            reportText += `🍽️ **Питание:** Записей не было\n\n`;
        }

        // Статистика воды
        const waterPercentage = Math.round((todayWater / waterNorm) * 100);
        reportText += `💧 **Вода:**\n`;
        reportText += `${todayWater} / ${waterNorm} мл (${waterPercentage}%)\n`;
        reportText += `${createProgressBar(todayWater, waterNorm)}\n\n`;

        // Статистика тренировок
        if (todayWorkoutCount > 0) {
            reportText += `💪 **Тренировки:**\n`;
            if (todayWorkoutCount === 1) {
                reportText += `🏃‍♂️ Проведена 1 тренировка\n`;
            } else {
                reportText += `🏃‍♂️ Проведено ${todayWorkoutCount} тренировки\n`;
            }
            reportText += `⏱️ Общее время: ${todayWorkoutDuration} мин\n`;
            reportText += `🔥 Сожжено калорий: ~${todayWorkoutCalories} ккал\n\n`;

            // Показываем прогресс по плану
            const progressResult = await getWorkoutPlanProgress(telegram_id);
            if (progressResult.success) {
                reportText += `📊 **Прогресс по плану тренировок:**\n`;
                reportText += `${createWorkoutProgressBar(progressResult.completed, progressResult.planned)}\n`;
                reportText += `Выполнено: ${progressResult.completed} из ${progressResult.planned} на этой неделе\n\n`;
            }
        } else {
            reportText += `💪 **Тренировки:** Сегодня не было\n\n`;
        }

        // Мотивационные сообщения и рекомендации
        reportText += `📊 **Итоги дня:**\n`;
        
        let achievements = [];
        let recommendations = [];

        // Проверяем достижения
        if (todayMeals && totals.calories >= profile.daily_calories * 0.8 && totals.calories <= profile.daily_calories * 1.2) {
            achievements.push('🎯 Отличное соблюдение калорийности!');
        }
        if (waterPercentage >= 100) {
            achievements.push('💧 Дневная норма воды выполнена!');
        }
        if (totals.protein >= profile.daily_protein * 0.8) {
            achievements.push('🥩 Хорошее потребление белка!');
        }
        if (todayWorkoutCount > 0) {
            achievements.push('💪 Сегодня была активность!');
        }
        if (todayWorkoutCalories >= 200) {
            achievements.push('🔥 Отлично сожгли калории!');
        }

        // Формируем рекомендации
        if (!todayMeals || totals.calories < profile.daily_calories * 0.7) {
            recommendations.push('🍽️ Завтра не забывайте добавлять все приемы пищи');
        }
        if (waterPercentage < 80) {
            recommendations.push('💧 Стоит больше пить воды завтра');
        }
        if (totals.protein < profile.daily_protein * 0.7) {
            recommendations.push('🥩 Добавьте больше белковых продуктов');
        }
        if (todayWorkoutCount === 0) {
            recommendations.push('💪 Попробуйте добавить немного активности завтра');
        }
        
        // Проверяем прогресс по плану тренировок
        const progressResult = await getWorkoutPlanProgress(telegram_id);
        if (progressResult.success && progressResult.progress < 50) {
            recommendations.push('🏃‍♂️ Не забывайте про план тренировок на неделе');
        }

        if (achievements.length > 0) {
            reportText += achievements.join('\n') + '\n\n';
        }

        if (recommendations.length > 0) {
            reportText += `💡 **Рекомендации на завтра:**\n`;
            reportText += recommendations.join('\n') + '\n\n';
        }

        if (achievements.length > 0) {
            reportText += `Отличная работа! 🌟`;
        } else {
            reportText += `Завтра новый день для достижения целей! 💪`;
        }

        return reportText;

    } catch (error) {
        console.error(`Error generating daily report for ${telegram_id}:`, error);
        return null;
    }
};

const sendDailyReports = async () => {
    try {
        console.log('📊 Начинаю отправку ежедневных отчетов для платных пользователей...');
        
        // Получаем все профили
        const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('telegram_id, first_name, id');

        if (profilesError || !profiles) {
            console.error('Error fetching profiles for daily reports:', profilesError);
            return;
        }

        // Получаем подписки для фильтрации пользователей (платные + PROMO с активными демо)
        const { data: subscriptions, error: subscriptionsError } = await supabase
            .from('user_subscriptions')
            .select('user_id, plan, promo_expires_at')
            .or('plan.in.(progress,maximum),and(promo_expires_at.gt.' + new Date().toISOString() + ')');

        if (subscriptionsError) {
            console.error('Error fetching subscriptions for daily reports:', subscriptionsError);
            return;
        }

        if (!subscriptions || subscriptions.length === 0) {
            console.log('Нет пользователей с активными подписками для отправки ежедневных отчетов');
            return;
        }

        // Фильтруем пользователей с активными подписками (включая PROMO)
        const activeUserIds = subscriptions.map(sub => sub.user_id);
        const activeUsers = profiles.filter(profile => activeUserIds.includes(profile.id));

        let sentCount = 0;
        let failedCount = 0;

        for (const user of activeUsers) {
            try {
                const report = await generateDailyReport(user.telegram_id);
                
                if (report) {
                    await bot.sendMessage(user.telegram_id, report, {
                        parse_mode: 'Markdown'
                    });
                    sentCount++;
                    console.log(`✅ Ежедневный отчет отправлен пользователю ${user.first_name} (${user.telegram_id})`);
                    
                    // Небольшая задержка между отправками, чтобы не превысить лимиты API
                    await new Promise(resolve => setTimeout(resolve, 100));
                } else {
                    console.log(`⚠️ Пропущен пользователь ${user.telegram_id} (нет данных)`);
                }
            } catch (userError) {
                failedCount++;
                console.error(`❌ Ошибка отправки отчета пользователю ${user.telegram_id}:`, userError.message);
            }
        }

        console.log(`📊 Отправка ежедневных отчетов завершена: ✅ ${sentCount} успешно, ❌ ${failedCount} ошибок`);

    } catch (error) {
        console.error('Error in sendDailyReports:', error);
    }
};

// --- Weekly Reports Functions (VIP Only) ---
const generateWeeklyReport = async (telegram_id) => {
    try {
        // Получаем профиль пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, first_name, weight_kg, daily_calories, daily_protein, daily_fat, daily_carbs')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return null; // Пропускаем пользователей без профиля
        }

        // Проверяем подписку - еженедельные отчеты только для VIP/MAXIMUM
        const subscription = await getUserSubscription(telegram_id);
        if (subscription.tier !== 'maximum') {
            return null; // Еженедельные отчеты только для максимального тарифа
        }

        // Получаем данные за неделю
        const today = new Date();
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - 7);
        const weekEnd = today;

        // Получаем еду за неделю
        const { data: weekMeals } = await supabase
            .from('meals')
            .select('calories, protein, fat, carbs, description, eaten_at')
            .eq('user_id', profile.id)
            .gte('eaten_at', weekStart.toISOString())
            .lte('eaten_at', weekEnd.toISOString());

        // Получаем воду за неделю
        const waterStats = await getWaterStats(telegram_id, 'week');
        
        // Получаем тренировки за неделю
        const workoutStats = await getWorkoutTrackingStats(telegram_id, 'week');

        // Подсчитываем средние значения и тенденции
        const weeklyTotals = weekMeals ? weekMeals.reduce((acc, meal) => {
            acc.calories += meal.calories || 0;
            acc.protein += meal.protein || 0;
            acc.fat += meal.fat || 0;
            acc.carbs += meal.carbs || 0;
            return acc;
        }, { calories: 0, protein: 0, fat: 0, carbs: 0 }) : { calories: 0, protein: 0, fat: 0, carbs: 0 };

        const dailyAverages = {
            calories: Math.round(weeklyTotals.calories / 7),
            protein: Math.round(weeklyTotals.protein / 7),
            fat: Math.round(weeklyTotals.fat / 7),
            carbs: Math.round(weeklyTotals.carbs / 7)
        };

        // Формируем отчет
        let reportText = `📈 **Еженедельный отчет для VIP, ${profile.first_name}!**\n\n`;
        reportText += `📅 **Период:** ${weekStart.toLocaleDateString('ru-RU')} - ${today.toLocaleDateString('ru-RU')}\n\n`;

        // Рассчитываем показатели по дням недели для детального анализа
        const dailyStats = {};
        const dayNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        for (let i = 0; i < 7; i++) {
            const day = new Date(weekStart);
            day.setDate(weekStart.getDate() + i);
            const dayKey = day.toISOString().split('T')[0];
            
            const dayMeals = weekMeals ? weekMeals.filter(meal => {
                const mealDate = new Date(meal.eaten_at).toISOString().split('T')[0];
                return mealDate === dayKey;
            }) : [];
            
            dailyStats[dayNames[i]] = {
                calories: dayMeals.reduce((sum, meal) => sum + (meal.calories || 0), 0),
                protein: dayMeals.reduce((sum, meal) => sum + (meal.protein || 0), 0),
                mealsCount: dayMeals.length,
                waterMl: waterStats.success ? (waterStats.dailyStats[dayKey] || 0) : 0
            };
        }

        // Анализ соответствия целям
        const calorieGoalPercent = (dailyAverages.calories / profile.daily_calories) * 100;
        const proteinGoalPercent = (dailyAverages.protein / profile.daily_protein) * 100;
        const waterNorm = profile.weight_kg * 35;
        const avgWater = waterStats.success ? Math.round(Object.values(waterStats.dailyStats).reduce((sum, water) => sum + water, 0) / 7) : 0;
        const waterGoalPercent = (avgWater / waterNorm) * 100;

        // Определяем самый продуктивный день
        const bestDay = Object.keys(dailyStats).reduce((best, day) => 
            dailyStats[day].calories > dailyStats[best].calories ? day : best
        );

        // АХУЕННЫЙ АНАЛИЗ ПИТАНИЯ
        reportText += `🔥 **ДЕТАЛЬНЫЙ АНАЛИЗ ПИТАНИЯ:**\n`;
        reportText += `📊 Среднесуточно: ${dailyAverages.calories} ккал (${calorieGoalPercent.toFixed(0)}% от цели)\n`;
        reportText += `${createProgressBar(dailyAverages.calories, profile.daily_calories)}\n`;
        
        // Статус по целям
        if (calorieGoalPercent < 80) {
            reportText += `⚠️ **НЕДОБОР КАЛОРИЙ!** Нужно +${(profile.daily_calories - dailyAverages.calories).toFixed(0)} ккал/день\n\n`;
        } else if (calorieGoalPercent > 120) {
            reportText += `🔴 **ПЕРЕИЗБЫТОК КАЛОРИЙ!** Нужно -${(dailyAverages.calories - profile.daily_calories).toFixed(0)} ккал/день\n\n`;
        } else {
            reportText += `✅ **ИДЕАЛЬНЫЙ БАЛАНС КАЛОРИЙ!** 🎯\n\n`;
        }

        reportText += `**Макронутриенты (средние за день):**\n`;
        reportText += `🥩 Белки: ${dailyAverages.protein}г (${proteinGoalPercent.toFixed(0)}% от нормы)\n`;
        reportText += `🥑 Жиры: ${dailyAverages.fat}г\n`;
        reportText += `🍞 Углеводы: ${dailyAverages.carbs}г\n\n`;

        // ДЕТАЛЬНЫЙ АНАЛИЗ ПО ДНЯМ
        reportText += `📅 **АНАЛИЗ ПО ДНЯМ НЕДЕЛИ:**\n`;
        Object.keys(dailyStats).forEach(day => {
            const stats = dailyStats[day];
            const icon = day === bestDay ? '🏆' : 
                        stats.calories > profile.daily_calories * 0.8 ? '✅' : 
                        stats.calories > 0 ? '⚠️' : '❌';
            const shortDay = day.slice(0, 2);
            reportText += `${icon} ${shortDay}: ${stats.calories.toFixed(0)} ккал, ${stats.mealsCount} записей, ${stats.waterMl} мл\n`;
        });
        reportText += `\n🏆 **Лучший день:** ${bestDay} (${dailyStats[bestDay].calories.toFixed(0)} ккал)\n\n`;

        // АНАЛИЗ ГИДРАТАЦИИ
        reportText += `💧 **ВОДНЫЙ БАЛАНС:**\n`;
        reportText += `📊 Среднесуточно: ${avgWater} / ${waterNorm} мл (${waterGoalPercent.toFixed(0)}%)\n`;
        reportText += `${createProgressBar(avgWater, waterNorm)}\n`;
        
        if (waterGoalPercent < 70) {
            reportText += `🚨 **КРИТИЧЕСКОЕ ОБЕЗВОЖИВАНИЕ!** Пей +${(waterNorm - avgWater).toFixed(0)} мл/день\n`;
            reportText += `💡 **Лайфхак:** Ставь напоминания каждый час, купи красивую бутылку\n`;
            reportText += `⚠️ **Риск:** Замедление метаболизма, ухудшение состояния кожи\n\n`;
        } else if (waterGoalPercent < 90) {
            reportText += `⚠️ **Недостаток воды!** Добавь +${(waterNorm - avgWater).toFixed(0)} мл/день\n`;
            reportText += `💡 **Совет:** Начинай день со стакана воды, пей перед каждым приемом пищи\n\n`;
        } else {
            reportText += `✅ **Отличная гидратация!** 🌊\n\n`;
        }

        // АНАЛИЗ ФИЗИЧЕСКОЙ АКТИВНОСТИ
        if (workoutStats.success && workoutStats.totalCount > 0) {
            reportText += `💪 **ФИЗИЧЕСКАЯ АКТИВНОСТЬ:**\n`;
            reportText += `🏃‍♂️ Всего тренировок: ${workoutStats.totalCount}\n`;
            reportText += `⏱️ Общее время: ${workoutStats.totalDuration} мин\n`;
            reportText += `🔥 Сожжено калорий: ~${workoutStats.totalCalories} ккал\n`;
            reportText += `📈 В среднем за тренировку: ${(workoutStats.totalCalories / workoutStats.totalCount).toFixed(0)} ккал\n`;
            
            if (workoutStats.totalCount >= 5) {
                reportText += `🔥 **ФЕНОМЕНАЛЬНАЯ АКТИВНОСТЬ!** Ты машина! 💪\n\n`;
            } else if (workoutStats.totalCount >= 3) {
                reportText += `✅ **Отличная активность!** Продолжай! 💪\n\n`;
            } else {
                reportText += `⚡ **Хорошее начало!** Можно добавить еще тренировок 💪\n\n`;
            }
        } else {
            reportText += `💪 **ФИЗИЧЕСКАЯ АКТИВНОСТЬ:**\n`;
            reportText += `❌ За неделю не было записей о тренировках\n`;
            reportText += `🎯 **СРОЧНО НУЖНО:** Добавить 2-3 тренировки в неделю!\n\n`;
        }

        // АХУЕННЫЕ ПЕРСОНАЛЬНЫЕ РЕКОМЕНДАЦИИ
        reportText += `🧠 **ПЕРСОНАЛЬНЫЕ РЕКОМЕНДАЦИИ ДЛЯ МАКСИМАЛЬНОГО РЕЗУЛЬТАТА:**\n\n`;

        // Анализ калорий
        if (calorieGoalPercent < 80) {
            reportText += `🔥 **ПИТАНИЕ:** Ты недоедаешь на ${(profile.daily_calories - dailyAverages.calories).toFixed(0)} ккал/день!\n`;
            reportText += `💡 **Действия:** Добавь орехи (300 ккал), авокадо (200 ккал), оливковое масло (100 ккал)\n`;
            reportText += `⚠️ **Риск:** Замедление метаболизма, потеря мышечной массы\n\n`;
        } else if (calorieGoalPercent > 120) {
            reportText += `🔥 **ПИТАНИЕ:** Переизбыток ${(dailyAverages.calories - profile.daily_calories).toFixed(0)} ккал/день!\n`;
            reportText += `💡 **Действия:** Убери быстрые углеводы, уменьши порции на 20%\n`;
            reportText += `⚠️ **Риск:** Набор лишнего веса, замедление прогресса\n\n`;
        } else {
            reportText += `🔥 **ПИТАНИЕ:** Идеальный баланс! Ты мастер контроля калорий! 🎯\n\n`;
        }

        // Анализ белков
        if (proteinGoalPercent < 80) {
            reportText += `🥩 **БЕЛКИ:** Критический недостаток! Нужно +${(profile.daily_protein - dailyAverages.protein).toFixed(0)}г/день\n`;
            reportText += `💡 **Источники:** Курица (150г = 30г белка), творог (100г = 18г), яйца (2шт = 12г)\n`;
            reportText += `⚠️ **Риск:** Потеря мышечной массы, медленное восстановление\n\n`;
        } else if (proteinGoalPercent > 150) {
            reportText += `🥩 **БЕЛКИ:** Переизбыток белка, сбалансируй с углеводами\n`;
            reportText += `💡 **Действия:** Добавь сложные углеводы: гречку, овсянку, киноа\n\n`;
        } else {
            reportText += `🥩 **БЕЛКИ:** Отличное потребление! Мышцы скажут спасибо! 💪\n\n`;
        }

        // Анализ воды
        if (waterGoalPercent < 70) {
            reportText += `💧 **ВОДА:** КРИТИЧЕСКОЕ ОБЕЗВОЖИВАНИЕ! Пей ${((waterNorm - avgWater)).toFixed(0)} мл больше!\n`;
            reportText += `💡 **Лайфхак:** Ставь напоминания каждый час, купи красивую бутылку\n`;
            reportText += `⚠️ **Риск:** Замедление метаболизма, ухудшение состояния кожи\n\n`;
        } else if (waterGoalPercent < 90) {
            reportText += `💧 **ВОДА:** Недостаток воды! Добавь ${((waterNorm - avgWater)).toFixed(0)} мл/день\n`;
            reportText += `💡 **Совет:** Начинай день со стакана воды, пей перед каждым приемом пищи\n\n`;
        } else {
            reportText += `💧 **ВОДА:** ШИКАРНАЯ ГИДРАТАЦИЯ! Ты водяной гуру! 🌊\n\n`;
        }

        // Анализ тренировок
        if (!workoutStats.success || workoutStats.totalCount === 0) {
            reportText += `🏋️ **ТРЕНИРОВКИ:** Тревожный звонок! Нужна СРОЧНАЯ активность!\n`;
            reportText += `💡 **Старт:** 3 тренировки по 30 мин: понедельник, среда, пятница\n`;
            reportText += `🎯 **Цель:** Кардио (сжигание жира) + силовые (рост мышц)\n\n`;
        } else if (workoutStats.totalCount < 3) {
            reportText += `🏋️ **ТРЕНИРОВКИ:** Добавь еще ${3 - workoutStats.totalCount} тренировки в неделю\n`;
            reportText += `💡 **Совет:** Чередуй кардио и силовые, не забывай про разминку\n\n`;
        } else {
            reportText += `🏋️ **ТРЕНИРОВКИ:** ВЕЛИКОЛЕПНАЯ АКТИВНОСТЬ! Ты настоящий спортсмен! 🔥\n`;
            if (workoutStats.totalCount > 5) {
                reportText += `💡 **Важно:** Не забывай о днях отдыха для восстановления мышц\n\n`;
            }
        }

        // ПЛАН НА РОСТ И ДОСТИЖЕНИЕ ЦЕЛЕЙ
        reportText += `🎯 **СТРАТЕГИЧЕСКИЙ ПЛАН НА СЛЕДУЮЩУЮ НЕДЕЛЮ:**\n`;
        
        if (profile.goal === 'lose') {
            const weeklyDeficit = (profile.daily_calories - dailyAverages.calories) * 7;
            const predictedWeightLoss = weeklyDeficit / 7700; // 1 кг = 7700 ккал
            
            reportText += `📉 **ЦЕЛЬ: ПОХУДЕНИЕ**\n`;
            if (predictedWeightLoss > 0) {
                reportText += `📊 Прогноз потери веса: ${predictedWeightLoss.toFixed(2)} кг/неделю\n`;
            }
            reportText += `• 🔥 Дефицит 300-500 ккал/день (не больше!)\n`;
            reportText += `• 🥩 Белки: ${(profile.weight_kg * 1.6).toFixed(0)}г/день для сохранения мышц\n`;
            reportText += `• 🏃‍♂️ Кардио 3-4 раза по 30-45 мин\n`;
            reportText += `• 💪 Силовые 2-3 раза для поддержания метаболизма\n`;
        } else if (profile.goal === 'gain') {
            reportText += `📈 **ЦЕЛЬ: НАБОР МАССЫ**\n`;
            reportText += `• 🔥 Профицит 300-500 ккал/день\n`;
            reportText += `• 🥩 Белки: ${(profile.weight_kg * 1.8).toFixed(0)}г/день для роста мышц\n`;
            reportText += `• 💪 Силовые 4-5 раз в неделю (прогрессия нагрузок!)\n`;
            reportText += `• 🏃‍♂️ Кардио 1-2 раза для здоровья сердца\n`;
        } else {
            reportText += `⚖️ **ЦЕЛЬ: ПОДДЕРЖАНИЕ ФОРМЫ**\n`;
            reportText += `• 🔥 Баланс калорий (поддерживающая калорийность)\n`;
            reportText += `• 🥩 Белки: ${(profile.weight_kg * 1.4).toFixed(0)}г/день\n`;
            reportText += `• 💪 Силовые 3 раза в неделю\n`;
            reportText += `• 🏃‍♂️ Кардио 2-3 раза в неделю\n`;
        }

        reportText += `\n🏆 **${profile.first_name}, ты делаешь НЕВЕРОЯТНУЮ работу!**\n`;
        reportText += `💎 **Твоя дисциплина - это твоя суперсила!**\n`;
        reportText += `🚀 **Продолжай двигаться к цели, результат не заставит себя ждать!**\n`;
        reportText += `📱 **До встречи в следующем недельном VIP отчете!** ✨`;
        
        return reportText;

    } catch (error) {
        console.error(`Error generating weekly report for ${telegram_id}:`, error);
        return null;
    }
};

const sendWeeklyReports = async () => {
    try {
        console.log('📈 Начинаю отправку еженедельных отчетов для VIP...');
        
        // Получаем VIP пользователей (maximum tier)
        const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('telegram_id, first_name, id');

        if (profilesError || !profiles) {
            console.error('Error fetching profiles for weekly reports:', profilesError);
            return;
        }

        // Получаем подписки для фильтрации VIP пользователей
        const { data: subscriptions, error: subscriptionsError } = await supabase
            .from('user_subscriptions')
            .select('user_id, plan')
            .eq('plan', 'maximum');

        if (subscriptionsError) {
            console.error('Error fetching VIP subscriptions:', subscriptionsError);
            return;
        }

        if (!subscriptions || subscriptions.length === 0) {
            console.log('Нет VIP пользователей для отправки еженедельных отчетов');
            return;
        }

        // Фильтруем VIP пользователей
        const vipUserIds = subscriptions.map(sub => sub.user_id);
        const vipUsers = profiles.filter(profile => vipUserIds.includes(profile.id));

        let sentCount = 0;
        let failedCount = 0;

        for (const user of vipUsers) {
            try {
                const report = await generateWeeklyReport(user.telegram_id);
                
                if (report) {
                    await bot.sendMessage(user.telegram_id, report, {
                        parse_mode: 'Markdown'
                    });
                    sentCount++;
                    console.log(`✅ Еженедельный отчет отправлен VIP пользователю ${user.first_name} (${user.telegram_id})`);
                    
                    // Задержка между отправками
                    await new Promise(resolve => setTimeout(resolve, 150));
                } else {
                    console.log(`⚠️ Пропущен VIP пользователь ${user.telegram_id} (нет данных или не VIP)`);
                }
            } catch (userError) {
                failedCount++;
                console.error(`❌ Ошибка отправки еженедельного отчета VIP пользователю ${user.telegram_id}:`, userError.message);
            }
        }

        console.log(`📈 Отправка еженедельных отчетов завершена: ✅ ${sentCount} успешно, ❌ ${failedCount} ошибок`);
    } catch (error) {
        console.error('Error in sendWeeklyReports:', error);
    }
};

// --- SUBSCRIPTION FUNCTIONS ---

const getUserSubscription = async (telegram_id) => {
    try {
        // Сначала получаем user_id по telegram_id
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return { tier: 'free', expires_at: null, promo_activated_at: null, promo_expires_at: null };
        }

        const { data: subscription, error } = await supabase
            .from('user_subscriptions')
            .select('plan as tier, expires_at, promo_activated_at, promo_expires_at')
            .eq('user_id', profile.id)
            .single();

        const defaultSubscription = { 
            tier: 'free', 
            expires_at: null, 
            promo_activated_at: null,
            promo_expires_at: null 
        };

        if (error && error.code !== 'PGRST116') { // PGRST116 - no rows found
             console.error(`Error getting user subscription for ${telegram_id}:`, error);
             return defaultSubscription;
        }

        if (!subscription) {
            return defaultSubscription;
        }

        // Проверяем, не истек ли основной тариф
        if (subscription.tier !== 'free' && new Date(subscription.expires_at) < new Date()) {
            // Если тариф истек, возвращаем free, но сохраняем данные о промо
            return {
                ...defaultSubscription,
                promo_activated_at: subscription.promo_activated_at,
                promo_expires_at: subscription.promo_expires_at,
            };
        }

        return subscription;
    } catch (error) {
        console.error(`Error getting user subscription for ${telegram_id}:`, error);
        return { tier: 'free', expires_at: null, promo_activated_at: null, promo_expires_at: null };
    }
};

const activatePromo = async (telegram_id) => {
    try {
        // Получаем user_id по telegram_id
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return { success: false };
        }

        const now = new Date();
        const expires = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 дня

        const { data, error } = await supabase
            .from('user_subscriptions')
            .upsert({ 
                user_id: profile.id, 
                plan: 'free', // на случай если записи нет
                promo_activated_at: now.toISOString(),
                promo_expires_at: expires.toISOString()
            }, { onConflict: 'user_id' })
            .select();

        if (error) throw error;
        return { success: true, new_promo_expires_at: expires };

    } catch (error) {
        console.error(`Error activating promo for ${telegram_id}:`, error);
        return { success: false };
    }
};

const getTodayUsage = async (telegram_id) => {
    try {
        // Получаем user_id по telegram_id
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            return {
                photos_processed: 0,
                ai_questions: 0,
                meal_logs: 0
            };
        }

        const today = new Date().toISOString().split('T')[0];
        
        const { data: usage, error } = await supabase
            .from('daily_usage')
            .select('photos_analyzed as photos_processed, ai_questions_asked as ai_questions, manual_entries as meal_logs')
            .eq('user_id', profile.id)
            .eq('date', today)
            .single();

        if (error || !usage) {
            return {
                photos_processed: 0,
                ai_questions: 0,
                meal_logs: 0
            };
        }

        return usage;
    } catch (error) {
        return {
            photos_processed: 0,
            ai_questions: 0,
            meal_logs: 0
        };
    }
};

// Проверить лимиты действий
const checkActionLimit = async (telegram_id, action) => {
    const subscription = await getUserSubscription(telegram_id);
    const usage = await getTodayUsage(telegram_id);

    const isPromoActive = subscription.promo_expires_at && new Date(subscription.promo_expires_at) > new Date();

    // Переименованные тарифы: free, progress, maximum
    const limits = {
        free: { photos_processed: 2, ai_questions: 5, workout_plans: 1, manual_entries: 5 },
        promo: { photos_processed: 15, ai_questions: 20, workout_plans: 1, nutrition_plans: 1, voice_messages: 3, manual_entries: 15 },
        progress: { photos_processed: -1, ai_questions: -1, workout_plans: -1, nutrition_plans: -1, manual_entries: -1 },
        maximum: { photos_processed: -1, ai_questions: -1, workout_plans: -1, nutrition_plans: -1, voice_messages: -1, medical_analysis: -1, manual_entries: -1 }
    };

    let userLimits;
    if (subscription.subscription_type === 'PROMO' && isPromoActive) {
        userLimits = limits.promo;
    } else if (subscription.tier === 'free' && isPromoActive) {
        userLimits = limits.promo;
    } else {
        // Поддержка старых названий на всякий случай
        const tierMap = { premium: 'progress', vip: 'maximum'};
        const currentTier = tierMap[subscription.tier] || subscription.tier;
        userLimits = limits[currentTier] || limits.free;
    }

    const limit = userLimits[action];

    if (limit === undefined) {
        return { allowed: true }; // Нет лимита для этого действия
    }
    if (limit === -1) {
        return { allowed: true }; // Безлимитно
    }

    // Специальная логика для месячного лимита на программы тренировок
    if (action === 'workout_plans' && (subscription.tier === 'free')) {
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // В промо-период лимит на программы тоже месячный, но проверяем его как часть промо.
        // Если пользователь нажмет на генерацию, ему должно засчитаться в месячный лимит.
        const { count, error } = await supabase
            .from('user_actions')
            .select('*', { count: 'exact', head: true })
            .eq('telegram_id', telegram_id)
            .eq('action_type', 'generate_workout_plan')
            .gte('created_at', firstDayOfMonth.toISOString());
        
        const monthlyUsed = error ? 0 : count;
        
        return {
            allowed: monthlyUsed < limit,
            used: monthlyUsed,
            limit: limit,
            period: 'месяц'
        };
    }

    const used = usage[action] || 0;
    return {
        allowed: used < limit,
        used: used,
        limit: limit,
        period: 'день'
    };
};

// Увеличить счетчик использования
const incrementUsage = async (telegram_id, action) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const { data: existing } = await supabase
            .from('daily_usage')
            .select('*')
            .eq('telegram_id', telegram_id)
            .eq('date', today)
            .single();
        
        if (existing) {
            const updateData = {};
            updateData[action] = (existing[action] || 0) + 1;
            
            await supabase
                .from('daily_usage')
                .update(updateData)
                .eq('telegram_id', telegram_id)
                .eq('date', today);
        } else {
            const insertData = {
                telegram_id,
                date: today,
                photos_processed: 0,
                ai_questions: 0,
                meal_logs: 0
            };
            insertData[action] = 1;
            
            await supabase
                .from('daily_usage')
                .insert(insertData);
        }
    } catch (error) {
        console.error('Error incrementing usage:', error);
    }
};

const setupBot = (app) => {
    const url = process.env.SERVER_URL;
    
    if (!url) {
        throw new Error('SERVER_URL не определена. Пожалуйста, установите ее в переменных на Railway.');
    }

    const webhookPath = `/api/telegram-webhook`;
    const fullWebhookUrl = new URL(webhookPath, url).href;

    console.log(`Пытаюсь установить вебхук по адресу: ${fullWebhookUrl}`);

    bot.setWebHook(fullWebhookUrl)
        .then(success => {
            if (success) {
                console.log('✅ Вебхук успешно установлен на URL:', fullWebhookUrl);
            } else {
                console.error('❌ API Telegram вернуло `false` при установке вебхука. Проверьте URL.');
            }
        })
        .catch(error => {
            console.error('❌❌❌ НЕ УДАЛОСЬ УСТАНОВИТЬ ВЕБХУК ❌❌❌');
            console.error('Сообщение об ошибке:', error.message);
            if (error.response && error.response.body) {
                console.error('Ответ от Telegram API:', error.response.body);
            }
        });

    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

    console.log('Обработчик для вебхука на Express настроен.');

    // --- Main Menu Function ---
    const showMainMenu = (chat_id, text) => {
        bot.sendMessage(chat_id, text, {
            reply_markup: {
                keyboard: [
                    [{ text: '📸 Добавить по фото' }],
                    [{ text: '✍️ Добавить вручную' }, { text: '📊 Статистика' }],
                    [{ text: '🏋️ План тренировок' }, { text: '🍽️ План питания' }],
                    [{ text: '💧 Отслеживание воды' }, { text: '🏆 Челлендж' }],
                    [{ text: '👤 Профиль' }]
                ],
                resize_keyboard: true,
                one_time_keyboard: false
            }
        });
    };

    // --- Command Handlers ---
    bot.onText(/\/start/, async (msg) => {
        console.log(`⚡️ Получена команда /start от пользователя: ${msg.from.id} (${msg.from.first_name})`);
        const { id: telegram_id, username, first_name, last_name } = msg.from;
        const chat_id = msg.chat.id;

        try {
            if (registrationState[telegram_id]) delete registrationState[telegram_id];
            if (manualAddState[telegram_id]) delete manualAddState[telegram_id];

            const { data, error } = await supabase
                .from('profiles')
                .select('telegram_id')
                .eq('telegram_id', telegram_id)
                .single();

            if (error && error.code !== 'PGRST116') throw error;

            if (data) {
                showMainMenu(chat_id, `С возвращением, ${first_name}! Чем могу помочь?`);
            } else {
                registrationState[telegram_id] = { step: 'ask_name', data: { telegram_id, username, first_name, last_name, chat_id } };
                bot.sendMessage(chat_id, 'Привет! 👋 Я твой личный помощник по подсчёту калорий. Давай для начала зарегистрируемся. Как тебя зовут?', {
                    reply_markup: { remove_keyboard: true }
                });
            }
        } catch (dbError) {
            console.error('Error checking user profile:', dbError.message);
            bot.sendMessage(chat_id, 'Произошла ошибка при проверке вашего профиля. Пожалуйста, попробуйте позже.');
        }
    });

    // Команда для отладки - проверка данных в базе
    bot.onText(/\/debug/, async (msg) => {
        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;
        
        try {
            // Получаем профиль пользователя
            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('*')
                .eq('telegram_id', telegram_id)
                .single();

            if (profileError || !profile) {
                bot.sendMessage(chat_id, 'Профиль не найден');
            return;
        }

            // Получаем все записи о еде за сегодня
            const { startDate, endDate } = getDateRange('today');

            const { data: allMeals, error: mealsError } = await supabase
                .from('meals')
                .select('*')
                .eq('user_id', profile.id)
                .gte('eaten_at', startDate.toISOString())
                .lte('eaten_at', endDate.toISOString())
                .order('eaten_at', { ascending: false });

            // Фильтруем по текущему дню
            const today = new Date();
            const todayDateString = today.toISOString().split('T')[0];
            
            const todayMeals = allMeals ? allMeals.filter(meal => {
                const mealDate = new Date(meal.eaten_at);
                const mealDateString = mealDate.toISOString().split('T')[0];
                return mealDateString === todayDateString;
            }) : [];

            let debugText = `🔍 Отладочная информация:\n\n`;
            debugText += `👤 Профиль ID: ${profile.id}\n`;
            debugText += `📅 Сегодня: ${todayDateString}\n`;
            debugText += `📅 Диапазон поиска: ${startDate.toISOString()} - ${endDate.toISOString()}\n`;
            debugText += `🍽️ Всего записей в диапазоне: ${allMeals ? allMeals.length : 0}\n`;
            debugText += `🍽️ Записей за сегодня: ${todayMeals.length}\n\n`;

            if (allMeals && allMeals.length > 0) {
                debugText += `📋 Все записи в диапазоне:\n`;
                allMeals.forEach((meal, index) => {
                    const mealDate = new Date(meal.eaten_at);
                    const mealDateString = mealDate.toISOString().split('T')[0];
                    const isToday = mealDateString === todayDateString ? '✅' : '❌';
                    debugText += `${index + 1}. ${isToday} ${meal.description} (${meal.calories} ккал) - ${mealDate.toLocaleString('ru-RU')} [${mealDateString}]\n`;
                });
            }

            bot.sendMessage(chat_id, debugText);

        } catch (error) {
            console.error('Debug error:', error);
            bot.sendMessage(chat_id, `Ошибка отладки: ${error.message}`);
        }
    });

    // Команда для тестирования ежедневных отчетов (только для администратора)
    bot.onText(/\/test_daily_report/, async (msg) => {
        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;

        // Можете поменять этот ID на ваш telegram_id для тестирования
        const adminId = '123456789'; // Замените на ваш telegram_id
        
        if (telegram_id.toString() === adminId) {
            bot.sendMessage(chat_id, '📊 Запускаю тестовую отправку ежедневных отчетов...');
            await sendDailyReports();
            bot.sendMessage(chat_id, '✅ Тестовая отправка завершена! Проверьте логи.');
        } else {
            bot.sendMessage(chat_id, '❌ У вас нет прав для выполнения этой команды.');
        }
    });

    // Команда для получения персонального отчета
    bot.onText(/\/my_report/, async (msg) => {
        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;
        
        bot.sendMessage(chat_id, '📊 Генерирую ваш персональный отчет...');
        
        const report = await generateDailyReport(telegram_id);
        if (report) {
            bot.sendMessage(chat_id, report, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chat_id, '❌ Не удалось сгенерировать отчет. Возможно, у вас нет профиля или данных за сегодня.');
        }
    });

    // 🔧 КОМАНДЫ АДМИНИСТРАТОРА
    const ADMIN_IDS = [6103273611]; // Ваш telegram_id
    
    bot.onText(/\/admin_health/, async (msg) => {
        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;
        
        if (!ADMIN_IDS.includes(telegram_id)) {
            bot.sendMessage(chat_id, '❌ У вас нет прав для выполнения этой команды.');
            return;
        }
        
        bot.sendMessage(chat_id, '🔍 Проверяю состояние системы...');
        const healthStatus = await performHealthCheck();
        
        let statusText = `🏥 **Состояние системы**\n\n`;
        statusText += `⏰ Время: ${healthStatus.timestamp}\n`;
        statusText += `📊 Общий статус: ${healthStatus.status === 'healthy' ? '✅ Здоров' : '⚠️ Проблемы'}\n\n`;
        statusText += `**Сервисы:**\n`;
        statusText += `🤖 OpenAI: ${healthStatus.services.openai === 'healthy' ? '✅' : '❌'}\n`;
        statusText += `🗄️ База данных: ${healthStatus.services.database === 'healthy' ? '✅' : '❌'}\n`;
        
        bot.sendMessage(chat_id, statusText, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/admin_stats/, async (msg) => {
        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;
        
        if (!ADMIN_IDS.includes(telegram_id)) {
            bot.sendMessage(chat_id, '❌ У вас нет прав для выполнения этой команды.');
            return;
        }
        
        bot.sendMessage(chat_id, '📈 Собираю статистику...');
        
        try {
            // Статистика пользователей
            const { data: usersCount } = await supabase
                .from('profiles')
                .select('count');
            
            // Статистика за сегодня
            const today = new Date().toISOString().split('T')[0];
            const { data: todayMeals } = await supabase
                .from('meals')
                .select('count')
                .gte('eaten_at', `${today}T00:00:00`)
                .lte('eaten_at', `${today}T23:59:59`);
            
            // Rate limiting статистика
            const activeUsers = userRateLimits.size;
            
            // Uptime статистика
            const uptimeSeconds = process.uptime();
            const uptimeMinutes = Math.floor(uptimeSeconds / 60);
            const uptimeHours = Math.floor(uptimeMinutes / 60);
            
            let statsText = `📊 **Статистика бота**\n\n`;
            statsText += `⏱️ Uptime: ${uptimeHours}ч ${uptimeMinutes % 60}м\n`;
            statsText += `👥 Всего пользователей: ${usersCount?.length || 0}\n`;
            statsText += `🍽️ Записей о еде сегодня: ${todayMeals?.length || 0}\n`;
            statsText += `⚡ Активных пользователей: ${activeUsers}\n`;
            statsText += `🚫 Rate limit нарушений: ${[...userRateLimits.values()].filter(requests => requests.length >= RATE_LIMIT_MAX_REQUESTS).length}\n`;
            statsText += `💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`;
            
            bot.sendMessage(chat_id, statsText, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chat_id, '❌ Ошибка при получении статистики.');
            logEvent('error', 'Admin stats error', { error: error.toString() });
        }
    });

    // --- Message Handler ---
    bot.on('message', async (msg) => {
        if (msg.text && msg.text.startsWith('/')) return;

        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;

        // 🚫 ПРОВЕРКА RATE LIMITING
        if (!checkRateLimit(telegram_id)) {
            logEvent('warn', 'Rate limit exceeded', { userId: telegram_id, chat_id });
            await bot.sendMessage(chat_id, '⚠️ Слишком много запросов! Подождите минуту перед следующим сообщением.');
            return;
        }

        // 📝 ЛОГИРОВАНИЕ АКТИВНОСТИ
        logEvent('info', 'Message received', { 
            userId: telegram_id, 
            chat_id, 
            messageType: msg.photo ? 'photo' : msg.voice ? 'voice' : 'text',
            textLength: msg.text ? msg.text.length : 0
        });

        // --- Keyboard Button Handling ---
        if (msg.text === '📸 Добавить по фото') {
            bot.sendMessage(chat_id, 'Присылайте фото вашей еды.');
            return;
        }
        if (msg.text === '✍️ Добавить вручную') {
            // 🔒 ПРОВЕРКА ЛИМИТОВ НА РУЧНОЙ ВВОД ЕДЫ
            const limitCheck = await checkActionLimit(telegram_id, 'manual_entries');
            if (!limitCheck.allowed) {
                const subscription = await getUserSubscription(telegram_id);
                let upgradeText = `🚫 **Лимит ручного ввода блюд исчерпан!**\n\n`;
                upgradeText += `📊 Использовано: ${limitCheck.used}/${limitCheck.limit} за ${limitCheck.period}\n\n`;
                
                if (subscription.tier === 'free' && !subscription.promo_expires_at) {
                    upgradeText += `🎁 **Попробуйте промо-период:**\n• 15 ручных записей в день\n• 3 дня бесплатно\n\n`;
                    upgradeText += `Или выберите тариф для безлимитного доступа! 🚀`;
                    
                    await bot.sendMessage(chat_id, upgradeText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🎁 Активировать промо', callback_data: 'activate_promo' }],
                                [{ text: '📋 Тарифы', callback_data: 'subscription_plans' }]
                            ]
                        }
                    });
                } else {
                    upgradeText += `Выберите подходящий тариф для продолжения! 🚀`;
                    await bot.sendMessage(chat_id, upgradeText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📋 Посмотреть тарифы', callback_data: 'subscription_plans' }]
                            ]
                        }
                    });
                }
                return;
            }
            
            // Умная очистка - закрываем конфликтующие состояния перед ручным вводом еды
            closeConflictingStates(telegram_id, 'manual_food_entry');
            manualAddState[telegram_id] = { step: 'awaiting_input' };
            bot.sendMessage(chat_id, 'Введите название блюда и его вес в граммах через запятую.\n\nНапример: `Овсяная каша, 150`', {parse_mode: 'Markdown'});
            return;
        }
        if (msg.text === '📊 Статистика') {
            bot.sendMessage(chat_id, 'За какой период показать статистику?', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'За сегодня', callback_data: 'stats_today' }],
                        [{ text: 'За неделю', callback_data: 'stats_week' }],
                        [{ text: 'За месяц', callback_data: 'stats_month' }]
                    ]
                }
            });
            return;
        }
        if (msg.text === '🏋️ План тренировок') {
            // Проверяем, есть ли профиль пользователя
            try {
                const { data: profile, error } = await supabase
                    .from('profiles')
                    .select('id, first_name, gender, age, height_cm, weight_kg, goal')
                    .eq('telegram_id', telegram_id)
                    .single();

                if (error || !profile) {
                    bot.sendMessage(chat_id, 'Сначала нужно пройти регистрацию. Нажмите /start');
                    return;
                }

                // Проверяем тариф пользователя  
                const subscription = await getUserSubscription(telegram_id);
                if (subscription.subscription_type === 'FREE') {
                    bot.sendMessage(chat_id, '💪 *План тренировок недоступен на бесплатном тарифе*\n\nДля доступа к персональным планам тренировок требуется подписка.', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💎 Посмотреть тарифы', callback_data: 'show_subscription_plans' }]
                            ]
                        }
                    });
                    return;
                }

                // Умная очистка - закрываем конфликтующие состояния, но сохраняем профильные данные
                closeConflictingStates(telegram_id, 'workout_plan');
                
                // Показываем меню выбора действия
                bot.sendMessage(chat_id, 'Мне создать новый план тренировок?', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Да', callback_data: 'workout_action_yes' }],
                            [{ text: '❌ Нет', callback_data: 'workout_action_no' }],
                            [{ text: '🔄 Пройти анкету заново', callback_data: 'workout_action_restart' }]
                        ]
                    }
                });
            } catch (dbError) {
                console.error('Error fetching profile for workout plan:', dbError);
                bot.sendMessage(chat_id, 'Ошибка при получении профиля. Попробуйте позже.');
            }
            return;
        }
        if (msg.text === '🍽️ План питания') {
            // Проверяем, есть ли профиль пользователя
            try {
                const { data: profile, error } = await supabase
                    .from('profiles')
                    .select('id, first_name, gender, age, height_cm, weight_kg, goal, daily_calories, daily_protein, daily_fat, daily_carbs')
                    .eq('telegram_id', telegram_id)
                    .single();

                if (error || !profile) {
                    bot.sendMessage(chat_id, 'Сначала нужно пройти регистрацию. Нажмите /start');
                    return;
                }

                // Умная очистка - закрываем конфликтующие состояния, но сохраняем профильные данные
                closeConflictingStates(telegram_id, 'nutrition_plan');
                
                // Показываем меню выбора действия
                bot.sendMessage(chat_id, 'Мне создать новый план питания?', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Да', callback_data: 'nutrition_action_yes' }],
                            [{ text: '❌ Нет', callback_data: 'nutrition_action_no' }],
                            [{ text: '🔄 Пройти анкету заново', callback_data: 'nutrition_action_restart' }]
                        ]
                    }
                });
            } catch (dbError) {
                console.error('Error fetching profile for nutrition plan:', dbError);
                bot.sendMessage(chat_id, 'Ошибка при получении профиля. Попробуйте позже.');
            }
            return;
        }
        if (msg.text === '💧 Отслеживание воды') {
            // Умная очистка для отслеживания воды (кроме других водных операций)
            closeConflictingStates(telegram_id, 'water_tracking');
            showWaterMenu(chat_id, telegram_id);
            return;
        }
        if (msg.text === '👤 Профиль') {
            // Полная очистка при переходе в профиль
            closeConflictingStates(telegram_id, 'profile_menu');
            showProfileMenu(chat_id, telegram_id);
            return;
        }
        if (msg.text === '🏆 Челлендж') {
            showChallengeMenu(chat_id, telegram_id);
            return;
        }


        // --- Photo Handler ---
        if (msg.photo) {
            await bot.sendChatAction(chat_id, 'typing');
            showTyping(chat_id, 15000); // 15 секунд для анализа фото
            
            const thinkingMessage = await bot.sendMessage(chat_id, '📸 Получил ваше фото! Анализирую...');
            
            try {
                const photo = msg.photo[msg.photo.length - 1];
                const fileInfo = await bot.getFile(photo.file_id);
                const photoUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                
                // Постепенное обновление статуса
                setTimeout(async () => {
                    try {
                        await bot.editMessageText('📸 Распознаю блюда на фото...', {
                            chat_id: chat_id,
                            message_id: undefined
                        });
                    } catch (e) { /* игнорируем ошибки обновления */ }
                }, 2000);
                
                setTimeout(async () => {
                    try {
                        await bot.editMessageText('📸 Анализирую состав и калорийность...', {
                            chat_id: chat_id,
                            message_id: undefined
                        });
                    } catch (e) { /* игнорируем ошибки обновления */ }
                }, 6000);
                
                const recognitionResult = await recognizeFoodFromPhoto(photoUrl);

                if (recognitionResult.success) {
                    const mealData = recognitionResult.data;
                    const confirmationId = crypto.randomUUID();
                    mealConfirmationCache[confirmationId] = { ...mealData, meal_type: 'photo', telegram_id };

                    const callback_data = `meal_confirm_${confirmationId}`;
                    const cancel_callback_data = `meal_cancel_${confirmationId}`;
                    const ingredientsString = mealData.ingredients.join(', ');

                    const responseText = `*${mealData.dish_name}* (Примерно ${mealData.weight_g} г)\n\n*Ингредиенты:* ${ingredientsString}\n*КБЖУ:*\n- Калории: ${mealData.calories} ккал\n- Белки: ${mealData.protein} г\n- Жиры: ${mealData.fat} г\n- Углеводы: ${mealData.carbs} г\n\nСохранить этот приём пищи?`;

                    await bot.editMessageText(responseText, {
                        chat_id: chat_id,
                        message_id: undefined,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Да, сохранить', callback_data }, { text: '❌ Нет, отменить', callback_data: cancel_callback_data }]
                            ]
                        }
                    });
                } else {
                     await bot.editMessageText(`😕 ${recognitionResult.reason}`, {
                        chat_id: chat_id,
                        message_id: undefined
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке фото:", error);
                await bot.editMessageText('Произошла внутренняя ошибка. Не удалось обработать фото.', {
                    chat_id: chat_id,
                    message_id: undefined
                });
            }
            return;
        }

                // --- Voice Message Handler ---
        if (msg.voice) {
            // СРАЗУ показываем индикатор печатания
            await bot.sendChatAction(chat_id, 'typing');
            try {
                const voice = msg.voice;
                const fileInfo = await bot.getFile(voice.file_id);
                const voiceUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                
                const transcriptionResult = await processVoiceMessage(voiceUrl);
                
                if (transcriptionResult.success) {
                    // Убираем промежуточное сообщение - сразу обрабатываем результат

                    // Получаем профиль пользователя
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('first_name, gender, age, height_cm, weight_kg, goal, id')
                        .eq('telegram_id', telegram_id)
                        .single();

                    // Используем универсального агента
                    const universalResult = await processUniversalMessage(transcriptionResult.text, profile);
                    
                    if (universalResult.success) {
                        const analysisData = universalResult.data;
                        
                        // Выполняем действие в зависимости от типа сообщения
                        switch (analysisData.action_required) {
                            case 'analyze_food':
                                // Анализируем еду через OpenAI для получения КБЖУ
                                const foodAnalysisResult = await recognizeFoodFromText(analysisData.extracted_data.meal_description || transcriptionResult.text);
                                
                                if (foodAnalysisResult.success) {
                                    const mealData = foodAnalysisResult.data;
                                    const confirmationId = crypto.randomUUID();
                                    mealConfirmationCache[confirmationId] = { ...mealData, meal_type: 'voice', telegram_id };

                                    const callback_data = `meal_confirm_${confirmationId}`;
                                    const cancel_callback_data = `meal_cancel_${confirmationId}`;
                                    const ingredientsString = mealData.ingredients ? mealData.ingredients.join(', ') : 'Не указаны';

                                    const responseText = `🎤 **Распознанная еда:** ${mealData.dish_name}\n\n*Ингредиенты:* ${ingredientsString}\n*КБЖУ:*\n- Калории: ${mealData.calories} ккал\n- Белки: ${mealData.protein} г\n- Жиры: ${mealData.fat} г\n- Углеводы: ${mealData.carbs} г\n\nСохранить этот приём пищи?`;

                                    await bot.sendMessage(chat_id, responseText, {
                                        parse_mode: 'Markdown',
                                        reply_markup: {
                                            inline_keyboard: [
                                                [{ text: '✅ Да, сохранить', callback_data }, { text: '❌ Нет, отменить', callback_data: cancel_callback_data }]
                                            ]
                                        }
                                    });
                                } else {
                                    await bot.sendMessage(chat_id, analysisData.response_text, { parse_mode: 'Markdown' });
                                }
                                break;

                            case 'add_water':
                                // Добавляем воду
                                const waterAmount = analysisData.extracted_data.amount_ml;
                                
                                if (waterAmount && waterAmount > 0) {
                                    const result = await addWaterIntake(telegram_id, waterAmount);
                                    
                                    if (result.success) {
                                        const waterStats = await getWaterStats(telegram_id, 'today');
                                        const today = new Date().toISOString().split('T')[0];
                                        const todayWater = waterStats.dailyStats[today] || 0;
                                        const percentage = Math.round((todayWater / waterStats.waterNorm) * 100);
                                        
                                        let responseText = `💧 **Добавлено:** ${waterAmount} мл\n\n`;
                                        responseText += `📊 Сегодня выпито: ${todayWater} / ${waterStats.waterNorm} мл (${percentage}%)\n`;
                                        responseText += `${createProgressBar(todayWater, waterStats.waterNorm)}\n\n`;
                                        
                                        if (percentage >= 100) {
                                            responseText += `🎉 Отлично! Вы выполнили дневную норму воды!`;
                                        } else {
                                            const remaining = waterStats.waterNorm - todayWater;
                                            responseText += `💪 Осталось: ${remaining} мл до нормы`;
                                        }
                                        
                                        await bot.sendMessage(chat_id, responseText, { parse_mode: 'Markdown' });
                                    } else {
                                        await bot.sendMessage(chat_id, `❌ Ошибка при добавлении воды: ${result.error}`);
                                    }
                                } else {
                                    await bot.sendMessage(chat_id, analysisData.response_text, { parse_mode: 'Markdown' });
                                }
                                break;

                            case 'log_workout':
                                // Логируем тренировку
                                const workoutData = analysisData.extracted_data;
                                
                                // Определяем тип тренировки
                                let workoutType = 'other';
                                const workoutText = transcriptionResult.text.toLowerCase();
                                if (workoutText.includes('бег') || workoutText.includes('пробег') || workoutText.includes('кардио')) {
                                    workoutType = 'cardio';
                                } else if (workoutText.includes('зал') || workoutText.includes('жим') || workoutText.includes('тяга') || workoutText.includes('силов')) {
                                    workoutType = 'strength';
                                } else if (workoutText.includes('йога') || workoutText.includes('растяжка') || workoutText.includes('стретч')) {
                                    workoutType = 'yoga';
                                } else if (workoutText.includes('плавани') || workoutText.includes('бассейн')) {
                                    workoutType = 'swimming';
                                } else if (workoutText.includes('ходьба') || workoutText.includes('прогулка')) {
                                    workoutType = 'walking';
                                } else if (workoutText.includes('hiit') || workoutText.includes('интервал')) {
                                    workoutType = 'hiit';
                                }

                                // Парсим длительность из текста
                                let duration = 30; // По умолчанию
                                const durationMatch = transcriptionResult.text.match(/(\d+)\s*(минут|мин|час)/i);
                                if (durationMatch) {
                                    duration = parseInt(durationMatch[1]);
                                    if (durationMatch[2].includes('час')) {
                                        duration *= 60;
                                    }
                                }

                                // Извлекаем упражнения
                                const exercises = workoutData.exercises || [];

                                // Рассчитываем калории
                                const caloriesBurned = calculateCaloriesBurned(workoutType, duration, exercises, profile);

                                const workoutRecord = {
                                    workout_type: workoutType,
                                    exercises: exercises,
                                    duration: duration,
                                    intensity: workoutData.intensity || 'средняя',
                                    calories_burned: caloriesBurned,
                                    notes: transcriptionResult.text
                                };

                                const result = await addWorkoutRecord(telegram_id, workoutRecord);
                                
                                if (result.success) {
                                    // Получаем прогресс по плану
                                    const progressResult = await getWorkoutPlanProgress(telegram_id);
                                    
                                    let responseText = `💪 **Тренировка записана!**\n\n`;
                                    
                                    if (exercises.length > 0) {
                                        responseText += `📋 **Упражнения:**\n`;
                                        exercises.forEach(exercise => {
                                            responseText += `• ${exercise}\n`;
                                        });
                                        responseText += `\n`;
                                    }
                                    
                                    responseText += `⏱️ **Длительность:** ${duration} мин\n`;
                                    responseText += `🔥 **Сожжено калорий:** ~${caloriesBurned} ккал\n`;
                                    responseText += `💯 **Интенсивность:** ${workoutRecord.intensity}\n\n`;
                                    
                                    // Добавляем прогресс-бар если есть план
                                    if (progressResult.success) {
                                        responseText += `📊 **Прогресс по плану:**\n`;
                                        responseText += `${createWorkoutProgressBar(progressResult.completed, progressResult.planned)}\n`;
                                        responseText += `Выполнено: ${progressResult.completed} из ${progressResult.planned} тренировок на этой неделе\n\n`;
                                    }
                                    
                                    responseText += `🎉 Отличная работа! Так держать! 💪`;

                                    await bot.editMessageText(responseText, {
                                        chat_id: chat_id,
                                        message_id: undefined,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    await bot.editMessageText(`❌ Ошибка при сохранении тренировки: ${result.error}`, {
                                        chat_id: chat_id,
                                        message_id: undefined
                                    });
                                }
                                break;

                            case 'generate_report':
                                // Генерируем отчет
                                const report = await generateDailyReport(telegram_id);
                                
                                if (report.success) {
                                    await bot.sendMessage(chat_id, report.text, { parse_mode: 'Markdown' });
                                } else {
                                    await bot.sendMessage(chat_id, '❌ Не удалось сгенерировать отчет. Возможно, у вас нет данных за сегодня.');
                                }
                                break;

                            case 'analyze_medical':
                                // Анализируем медицинские данные
                                const medicalResult = await analyzeMedicalData(transcriptionResult.text, profile);
                                
                                if (medicalResult.success) {
                                    const data = medicalResult.data;
                                    let responseText = `🔬 **Анализ медицинских данных**\n\n`;
                                    responseText += `📋 **Обнаруженные показатели:**\n${data.detected_parameters.join(', ')}\n\n`;
                                    responseText += `📊 **Краткий анализ:**\n${data.analysis_summary}\n\n`;
                                    
                                    if (data.nutrition_recommendations.foods_to_include.length > 0) {
                                        responseText += `✅ **Рекомендуемые продукты:**\n${data.nutrition_recommendations.foods_to_include.join(', ')}\n\n`;
                                    }
                                    
                                    responseText += `*Это рекомендации ИИ, не замена консультации врача.*`;

                                    await bot.sendMessage(chat_id, responseText, { parse_mode: 'Markdown' });
                                } else {
                                    await bot.sendMessage(chat_id, analysisData.response_text, { parse_mode: 'Markdown' });
                                }
                                break;

                                                    case 'answer_question':
                            // Отвечаем на вопрос в потоковом режиме
                            await answerUserQuestionStream(chat_id, null, transcriptionResult.text, profile);
                            break;

                        default:
                            // Все остальные случаи - дружелюбный ответ с потоковым выводом
                            const fullResponse = `🎤 **Услышал:** "${transcriptionResult.text}"\n\n${analysisData.response_text}`;
                            if (shouldUseStreaming(fullResponse)) {
                                await streamMessage(chat_id, fullResponse, { parse_mode: 'Markdown' });
                            } else {
                                await bot.sendMessage(chat_id, fullResponse, { parse_mode: 'Markdown' });
                            }
                            break;
                        }
                    } else {
                        await bot.sendMessage(chat_id, `🎤 **Распознано:** "${transcriptionResult.text}"\n\nИзвините, не смог понять ваше сообщение.`, { parse_mode: 'Markdown' });
                    }
                } else {
                    await bot.sendMessage(chat_id, `❌ ${transcriptionResult.error}`);
                }
            } catch (error) {
                console.error("Ошибка при обработке голосового сообщения:", error);
                await bot.sendMessage(chat_id, 'Произошла ошибка при обработке голосового сообщения.');
            }
            return;
        }

                // --- Document Handler ---
        if (msg.document) {
            // СРАЗУ показываем индикатор печатания
            await bot.sendChatAction(chat_id, 'typing');
            try {
                const document = msg.document;
                const fileInfo = await bot.getFile(document.file_id);
                const documentUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                
                // Если это изображение, извлекаем текст через OCR
                if (document.mime_type && document.mime_type.startsWith('image/')) {
                    const extractionResult = await extractTextFromImage(documentUrl);
                    
                    if (extractionResult.success) {
                        await bot.editMessageText(`📄 Анализирую извлеченный текст...`, {
                            chat_id: chat_id,
                            message_id: undefined
                        });

                        const { data: profile } = await supabase
                            .from('profiles')
                            .select('first_name, gender, age, height_cm, weight_kg, goal, id')
                            .eq('telegram_id', telegram_id)
                            .single();

                        // Используем универсального агента для анализа извлеченного текста
                        const universalResult = await processUniversalMessage(extractionResult.text, profile);
                        
                        if (universalResult.success) {
                            const analysisData = universalResult.data;
                            
                            // Выполняем действие в зависимости от типа содержимого
                            switch (analysisData.action_required) {
                                case 'analyze_medical':
                                    // Анализируем медицинские данные
                                    const medicalResult = await analyzeMedicalData(extractionResult.text, profile);
                                    
                                    if (medicalResult.success) {
                                        const data = medicalResult.data;
                                        let responseText = `🔬 **Анализ документа**\n\n`;
                                        responseText += `📋 **Обнаруженные показатели:**\n${data.detected_parameters.join(', ')}\n\n`;
                                        responseText += `📊 **Краткий анализ:**\n${data.analysis_summary}\n\n`;
                                        
                                        if (data.nutrition_recommendations.foods_to_include.length > 0) {
                                            responseText += `✅ **Рекомендуемые продукты:**\n${data.nutrition_recommendations.foods_to_include.join(', ')}\n\n`;
                                        }
                                        
                                        responseText += `*Это рекомендации ИИ, не замена консультации врача.*`;

                                        await bot.editMessageText(responseText, {
                                            chat_id: chat_id,
                                            message_id: undefined,
                                            parse_mode: 'Markdown'
                                        });
                                    } else {
                                        await bot.editMessageText(`📄 **Извлеченный текст:**\n\n${extractionResult.text.substring(0, 800)}${extractionResult.text.length > 800 ? '...' : ''}\n\n${analysisData.response_text}`, {
                                            chat_id: chat_id,
                                            message_id: undefined,
                                            parse_mode: 'Markdown'
                                        });
                                    }
                                    break;

                                default:
                                    // Другие типы документов
                                    await bot.editMessageText(`📄 **Извлеченный текст:**\n\n${extractionResult.text.substring(0, 800)}${extractionResult.text.length > 800 ? '...' : ''}\n\n${analysisData.response_text}`, {
                                        chat_id: chat_id,
                                        message_id: undefined,
                                        parse_mode: 'Markdown'
                                    });
                                    break;
                            }
                        } else {
                            await bot.editMessageText(`📄 **Извлеченный текст:**\n\n${extractionResult.text.substring(0, 1000)}${extractionResult.text.length > 1000 ? '...' : ''}`, {
                                chat_id: chat_id,
                                message_id: undefined,
                                parse_mode: 'Markdown'
                            });
                        }
                    } else {
                        await bot.editMessageText(`❌ ${extractionResult.error}`, {
                            chat_id: chat_id,
                            message_id: undefined
                        });
                    }
                } else {
                    await bot.editMessageText('Пока поддерживаются только изображения документов. Попробуйте отправить фото анализа.', {
                        chat_id: chat_id,
                        message_id: undefined
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке документа:", error);
                await bot.editMessageText('Произошла ошибка при обработке документа.', {
                    chat_id: chat_id,
                    message_id: undefined
                });
            }
            return;
        }

        // --- State-based Input Handlers ---
        const registrationStep = registrationState[telegram_id]?.step;
        const manualAddStep = manualAddState[telegram_id]?.step;
        const isWaitingForQuestion = questionState[telegram_id]?.waiting;
        const isWaitingForWater = waterInputState[telegram_id]?.waiting;
        const isWaitingForSteps = challengeStepsState[telegram_id]?.waiting;
        const isEditingProfile = profileEditState[telegram_id]?.field;
        const isWaitingForInjuryDetails = workoutInjuryState[telegram_id]?.waiting;

        if (isWaitingForQuestion) {
            // Пользователь задает вопрос - обрабатываем его через AI
            delete questionState[telegram_id];
            
            // СРАЗУ показываем индикатор печатания
            await bot.sendChatAction(chat_id, 'typing');
            
            try {
                // Получаем профиль пользователя для персонализированного ответа
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('first_name, gender, age, height_cm, weight_kg, goal, daily_calories, daily_protein, daily_fat, daily_carbs')
                    .eq('telegram_id', telegram_id)
                    .single();

                // Сразу переходим к потоковому ответу без промежуточного сообщения
                await answerUserQuestionStream(chat_id, null, msg.text, profile);

            } catch (error) {
                console.error("Error answering user question:", error);
                await bot.sendMessage(chat_id, '🤖 Извините, произошла ошибка при обработке вашего вопроса. Попробуйте еще раз или используйте основные функции бота.');
            }
            return;
        }

        if (isWaitingForInjuryDetails) {
            // Пользователь описал травмы - сохраняем и переходим к следующему шагу
            delete workoutInjuryState[telegram_id];
            
            const state = workoutPlanState[telegram_id];
            if (!state || state.step !== 'ask_injuries') {
                bot.sendMessage(chat_id, 'Сессия истекла. Пожалуйста, начните заново.');
                return;
            }

            // Сохраняем описание травм
            state.data = { ...state.data, injuries: msg.text.trim() };
            state.step = 'ask_location';

            // Переходим к выбору места тренировок
            bot.sendMessage(chat_id, 'Где вы планируете тренироваться?', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Дома', callback_data: 'workout_location_home' }],
                        [{ text: 'В зале', callback_data: 'workout_location_gym' }],
                        [{ text: 'На улице', callback_data: 'workout_location_outdoor' }]
                    ]
                }
            });
            return;
        }

        if (isWaitingForWater) {
            // Пользователь ввел количество воды
            delete waterInputState[telegram_id];

            // ✅ ВАЛИДАЦИЯ ВОДЫ
            if (!validateUserInput.waterAmount(msg.text)) {
                logEvent('warn', 'Invalid water amount input', { userId: telegram_id, input: msg.text });
                bot.sendMessage(chat_id, '❌ Пожалуйста, введите корректное количество воды от 1 до 5000 мл.');
                return;
            }
            const amount = parseInt(msg.text);

            const result = await addWaterIntake(telegram_id, amount);
            if (result.success) {
                const waterStats = await getWaterStats(telegram_id, 'today');
                const today = new Date().toISOString().split('T')[0];
                const todayWater = waterStats.dailyStats[today] || 0;
                const percentage = Math.round((todayWater / waterStats.waterNorm) * 100);

                let responseText = `✅ Добавлено: ${amount} мл воды\n\n`;
                responseText += `📊 Сегодня выпито: ${todayWater} / ${waterStats.waterNorm} мл (${percentage}%)\n`;
                
                if (percentage >= 100) {
                    responseText += `🎉 Поздравляю! Вы выполнили дневную норму воды!`;
                } else {
                    const remaining = waterStats.waterNorm - todayWater;
                    responseText += `💡 Осталось выпить: ${remaining} мл`;
                }

                bot.sendMessage(chat_id, responseText);
            } else {
                bot.sendMessage(chat_id, `❌ Ошибка при сохранении: ${result.error}`);
            }
            return;
        }

        if (isWaitingForSteps) {
            // Пользователь ввел значение для челленджа
            delete challengeStepsState[telegram_id];

            // Получаем текущий челлендж для определения типа валидации
            const challengeResult = await getCurrentChallenge();
            
            // Валидация ввода значения
            const progressValue = parseFloat(msg.text.replace(',', '.'));
            if (isNaN(progressValue) || progressValue <= 0) {
                bot.sendMessage(chat_id, '❌ Пожалуйста, введите корректное положительное число.');
                return;
            }

            // Дополнительная валидация в зависимости от типа челленджа
            if (challengeResult.success) {
                const challenge = challengeResult.data;
                if (challenge.type === 'steps' && progressValue > 100000) {
                    bot.sendMessage(chat_id, '❌ Количество шагов не может быть больше 100,000.');
                    return;
                } else if ((challenge.type === 'workout_time' || challenge.unit.includes('минут')) && progressValue > 1440) {
                    bot.sendMessage(chat_id, '❌ Время тренировки не может быть больше 1440 минут (24 часа).');
                    return;
                } else if ((challenge.type === 'water' || challenge.unit.includes('литр')) && progressValue > 20) {
                    bot.sendMessage(chat_id, '❌ Количество воды не может быть больше 20 литров.');
                    return;
                }
            }

            const result = await addChallengeProgress(telegram_id, progressValue);
            if (result.success) {
                // Определяем правильное сообщение успеха
                let successMessage = `✅ Добавлено ${progressValue}`;
                if (challengeResult.success) {
                    const challenge = challengeResult.data;
                    if (challenge.type === 'steps') {
                        successMessage = `✅ Добавлено ${progressValue.toLocaleString()} шагов!`;
                    } else if (challenge.type === 'workout_time' || challenge.unit.includes('минут')) {
                        successMessage = `✅ Добавлено ${progressValue} минут тренировки!`;
                    } else if (challenge.type === 'water' || challenge.unit.includes('литр')) {
                        successMessage = `✅ Добавлено ${progressValue} л воды!`;
                    } else if (challenge.type === 'exercises' || challenge.unit.includes('раз')) {
                        successMessage = `✅ Добавлено ${progressValue} повторений!`;
                    } else {
                        successMessage = `✅ Добавлено ${progressValue} ${challenge.unit}!`;
                    }
                }
                
                await bot.sendMessage(chat_id, `${successMessage}\n\nОбновляю ваш прогресс...`);
                
                // Показываем обновленное меню через 2 секунды
                setTimeout(() => {
                    showChallengeMenu(chat_id, telegram_id);
                }, 2000);
            } else {
                bot.sendMessage(chat_id, `❌ Ошибка при добавлении прогресса: ${result.error}`);
            }
            return;
        }

        if (isEditingProfile) {
            // Пользователь редактирует поле профиля
            const field = profileEditState[telegram_id].field;
            let value = msg.text.trim();
            let updateField = '';
            let displayName = '';
            
            // Валидация и преобразование значений
            try {
                switch (field) {
                    case 'name':
                        if (value.length < 1 || value.length > 50) {
                            bot.sendMessage(chat_id, '❌ Имя должно содержать от 1 до 50 символов. Попробуйте еще раз.');
                            return;
                        }
                        updateField = 'first_name';
                        displayName = 'Имя';
                        break;
                    case 'age':
                        const age = parseInt(value);
                        if (isNaN(age) || age < 10 || age > 100) {
                            bot.sendMessage(chat_id, '❌ Возраст должен быть от 10 до 100 лет. Попробуйте еще раз.');
                            return;
                        }
                        value = age;
                        updateField = 'age';
                        displayName = 'Возраст';
                        break;
                    case 'height':
                        const height = parseInt(value);
                        if (isNaN(height) || height < 100 || height > 250) {
                            bot.sendMessage(chat_id, '❌ Рост должен быть от 100 до 250 см. Попробуйте еще раз.');
                            return;
                        }
                        value = height;
                        updateField = 'height_cm';
                        displayName = 'Рост';
                        break;
                    case 'weight':
                        const weight = parseFloat(value.replace(',', '.'));
                        if (isNaN(weight) || weight <= 20 || weight > 300) {
                            bot.sendMessage(chat_id, '❌ Вес должен быть от 20 до 300 кг. Попробуйте еще раз.');
                            return;
                        }
                        value = weight;
                        updateField = 'weight_kg';
                        displayName = 'Вес';
                        break;
                    case 'target_weight':
                        const targetWeight = parseFloat(value.replace(',', '.'));
                        if (isNaN(targetWeight) || targetWeight <= 20 || targetWeight > 300) {
                            bot.sendMessage(chat_id, '❌ Целевой вес должен быть от 20 до 300 кг. Попробуйте еще раз.');
                            return;
                        }
                        value = targetWeight;
                        updateField = 'target_weight_kg';
                        displayName = 'Целевой вес';
                        break;
                    case 'timeframe':
                        const timeframe = parseInt(value);
                        if (isNaN(timeframe) || timeframe < 1 || timeframe > 24) {
                            bot.sendMessage(chat_id, '❌ Срок должен быть от 1 до 24 месяцев. Попробуйте еще раз.');
                            return;
                        }
                        value = timeframe;
                        updateField = 'timeframe_months';
                        displayName = 'Срок достижения цели';
                        break;
                    default:
                        bot.sendMessage(chat_id, '❌ Неизвестное поле для редактирования.');
                        delete profileEditState[telegram_id];
                        return;
                }
                
                if (!updateField) {
                    bot.sendMessage(chat_id, '❌ Произошла внутренняя ошибка: не удалось определить поле для обновления.');
                    console.error(`Update field was not set for state field: ${field}`);
                    delete profileEditState[telegram_id];
                    return;
                }
                
                // Обновляем значение в базе данных
                const { error } = await supabase
                    .from('profiles')
                    .update({ [updateField]: value })
                    .eq('telegram_id', telegram_id);
                
                if (error) throw error;
                
                // Пересчитываем нормы если изменился вес, рост или возраст
                if (['weight_kg', 'height_cm', 'age'].includes(updateField)) {
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('*')
                        .eq('telegram_id', telegram_id)
                        .single();
                    
                    if (profile) {
                        await calculateAndSaveNorms(profile);
                    }
                }
                
                bot.sendMessage(chat_id, `✅ ${displayName} успешно изменен на: ${value}\n\nВозвращаюсь в профиль...`);
                
                // Показываем обновленный профиль через 2 секунды
                setTimeout(() => {
                    showProfileMenu(chat_id, telegram_id);
                }, 2000);
                
            } catch (error) {
                console.error('Error updating profile field:', error);
                bot.sendMessage(chat_id, '❌ Ошибка при обновлении профиля. Попробуйте позже.');
            }
            
            delete profileEditState[telegram_id];
            return;
        }

        if (manualAddStep === 'awaiting_input') {
            delete manualAddState[telegram_id];
            
            // СРАЗУ показываем индикатор печатания
            await bot.sendChatAction(chat_id, 'typing');
            
            try {
                const parts = msg.text.split(',').map(p => p.trim());
                const description = parts[0];
                const weight = parseInt(parts[1], 10);
                if (parts.length !== 2 || !description || isNaN(weight) || weight <= 0) {
                     await bot.sendMessage(chat_id, 'Неверный формат. Пожалуйста, введите данные в формате: `Название, Граммы`.\n\nНапример: `Гречка с курицей, 150`', {
                        parse_mode: 'Markdown'
                    });
                    return;
                }

                const recognitionResult = await recognizeFoodFromText(msg.text);
                if (recognitionResult.success) {
                    const mealData = recognitionResult.data;
                    const confirmationId = crypto.randomUUID();
                    mealConfirmationCache[confirmationId] = { ...mealData, meal_type: 'manual', telegram_id };

                    const callback_data = `meal_confirm_${confirmationId}`;
                    const cancel_callback_data = `meal_cancel_${confirmationId}`;
                    const ingredientsString = mealData.ingredients ? mealData.ingredients.join(', ') : 'Не указаны';

                    const responseText = `*${mealData.dish_name}* (Примерно ${mealData.weight_g} г)\n\n*Ингредиенты:* ${ingredientsString}\n*КБЖУ:*\n- Калории: ${mealData.calories} ккал\n- Белки: ${mealData.protein} г\n- Жиры: ${mealData.fat} г\n- Углеводы: ${mealData.carbs} г\n\nСохранить этот приём пищи?`;

                    await bot.sendMessage(chat_id, responseText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Да, сохранить', callback_data }, { text: '❌ Нет, отменить', callback_data: cancel_callback_data }]
                            ]
                        }
                    });
                } else {
                     await bot.sendMessage(chat_id, `😕 ${recognitionResult.reason}`);
                }
            } catch (error) {
                console.error("Ошибка при обработке ручного ввода:", error);
                await bot.sendMessage(chat_id, 'Произошла внутренняя ошибка. Не удалось обработать ваш запрос.');
            }
            return;
        }

        if (registrationStep) {
            const state = registrationState[telegram_id];
            switch (registrationStep) {
                case 'ask_name':
                    const { data: existingProfile } = await supabase.from('profiles').select('telegram_id').eq('telegram_id', telegram_id).single();
                    if (existingProfile) {
                        logEvent('warn', 'Duplicate registration attempt', { userId: telegram_id });
                        delete registrationState[telegram_id];
                        showMainMenu(chat_id, 'Кажется, ты уже зарегистрирован. Вот твое главное меню:');
                        return;
                    }
                    
                    // ✅ ВАЛИДАЦИЯ ИМЕНИ
                    if (!validateUserInput.name(msg.text)) {
                        bot.sendMessage(chat_id, '❌ Имя должно содержать только буквы и быть от 2 до 50 символов. Попробуйте еще раз.');
                        return;
                    }
                    
                    state.data.first_name = msg.text.trim();
                    state.step = 'ask_gender';
                    logEvent('info', 'Registration name validated', { userId: telegram_id, name: msg.text.trim() });
                    
                    bot.sendMessage(chat_id, 'Приятно познакомиться! Теперь выбери свой пол:', {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Мужской', callback_data: 'register_gender_male' }],
                                [{ text: 'Женский', callback_data: 'register_gender_female' }]
                            ]
                        }
                    });
                    break;
                case 'ask_age':
                    // ✅ ВАЛИДАЦИЯ ВОЗРАСТА
                    if (!validateUserInput.age(msg.text)) {
                        bot.sendMessage(chat_id, '❌ Пожалуйста, введите корректный возраст (от 1 до 120 лет).'); 
                        return;
                    }
                    const age = parseInt(msg.text, 10);
                    state.data.age = age;
                    state.step = 'ask_height';
                    logEvent('info', 'Registration age validated', { userId: telegram_id, age });
                    bot.sendMessage(chat_id, 'Понял. Какой у тебя рост в сантиметрах?');
                    break;
                case 'ask_height':
                    // ✅ ВАЛИДАЦИЯ РОСТА
                    if (!validateUserInput.height(msg.text)) {
                        bot.sendMessage(chat_id, '❌ Пожалуйста, введите корректный рост (от 100 до 250 см).'); 
                        return;
                    }
                    const height = parseInt(msg.text, 10);
                    state.data.height_cm = height;
                    state.step = 'ask_weight';
                    logEvent('info', 'Registration height validated', { userId: telegram_id, height });
                    bot.sendMessage(chat_id, 'И вес в килограммах? (Можно дробное число, например, 65.5)');
                    break;
                case 'ask_weight':
                    // ✅ ВАЛИДАЦИЯ ВЕСА
                    if (!validateUserInput.weight(msg.text.replace(',', '.'))) {
                        bot.sendMessage(chat_id, '❌ Пожалуйста, введите корректный вес (от 1 до 300 кг, например: 75.5).'); 
                        return;
                    }
                    const weight = parseFloat(msg.text.replace(',', '.'));
                    state.data.weight_kg = weight;
                    state.step = 'ask_goal';
                    logEvent('info', 'Registration weight validated', { userId: telegram_id, weight });
                    bot.sendMessage(chat_id, 'И последнее: какая у тебя цель?', {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📉 Похудение', callback_data: 'register_goal_lose' }],
                                [{ text: '⚖️ Поддержание', callback_data: 'register_goal_maintain' }],
                                [{ text: '📈 Набор массы', callback_data: 'register_goal_gain' }]
                            ]
                        }
                    });
                    break;
            }
        }

        // --- Plan State Handlers ---
        const workoutState = workoutPlanState[telegram_id];
        const nutritionState = nutritionPlanState[telegram_id];

        if (workoutState) {
            if (workoutState.step === 'ask_target_weight') {
                const targetWeight = parseFloat(msg.text.replace(',', '.'));
                if (isNaN(targetWeight) || targetWeight <= 0 || targetWeight > 300) {
                    bot.sendMessage(chat_id, 'Пожалуйста, введите корректный вес (число от 1 до 300 кг)');
                    return;
                }
                
                workoutState.data.target_weight_kg = targetWeight;
                workoutState.step = 'ask_timeframe';
                
                bot.sendMessage(chat_id, `В течение какого времени вы хотите к этому прийти? (в месяцах, например: 6)\n\n**Рекомендуемый темп:**\n• Для похудения: 0.5-1 кг в неделю\n• Для набора: 0.2-0.5 кг в неделю`, {
                    parse_mode: 'Markdown'
                });
                return;
            }
            
            if (workoutState.step === 'ask_timeframe') {
                const timeframe = parseInt(msg.text);
                if (isNaN(timeframe) || timeframe <= 0 || timeframe > 24) {
                    bot.sendMessage(chat_id, 'Пожалуйста, введите корректное время (число от 1 до 24 месяцев)');
                    return;
                }
                
                workoutState.data.timeframe_months = timeframe;
                workoutState.step = 'ask_experience';
                
                bot.sendMessage(chat_id, 'Теперь расскажите о вашем опыте тренировок:', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Новичок (меньше 6 месяцев)', callback_data: 'workout_exp_beginner' }],
                            [{ text: 'Средний (6 месяцев - 2 года)', callback_data: 'workout_exp_intermediate' }],
                            [{ text: 'Продвинутый (больше 2 лет)', callback_data: 'workout_exp_advanced' }]
                        ]
                    }
                });
                return;
            }
        }

        if (nutritionState) {
            if (nutritionState.step === 'ask_target_weight') {
                const targetWeight = parseFloat(msg.text.replace(',', '.'));
                if (isNaN(targetWeight) || targetWeight <= 0 || targetWeight > 300) {
                    bot.sendMessage(chat_id, 'Пожалуйста, введите корректный вес (число от 1 до 300 кг)');
                    return;
                }
                
                nutritionState.data.target_weight_kg = targetWeight;
                nutritionState.step = 'ask_timeframe';
                
                bot.sendMessage(chat_id, `В течение какого времени вы хотите к этому прийти? (в месяцах, например: 6)\n\n**Рекомендуемый темп:**\n• Для похудения: 0.5-1 кг в неделю\n• Для набора: 0.2-0.5 кг в неделю`, {
                    parse_mode: 'Markdown'
                });
                return;
            }
            
            if (nutritionState.step === 'ask_timeframe') {
                const timeframe = parseInt(msg.text);
                if (isNaN(timeframe) || timeframe <= 0 || timeframe > 24) {
                    bot.sendMessage(chat_id, 'Пожалуйста, введите корректное время (число от 1 до 24 месяцев)');
                    return;
                }
                
                nutritionState.data.timeframe_months = timeframe;
                nutritionState.step = 'ask_activity';
                
                bot.sendMessage(chat_id, 'Какой у вас уровень активности?', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Низкий (сидячий образ жизни)', callback_data: 'nutrition_activity_sedentary' }],
                            [{ text: 'Легкий (1-3 тренировки в неделю)', callback_data: 'nutrition_activity_light' }],
                            [{ text: 'Активный (3-5 тренировок в неделю)', callback_data: 'nutrition_activity_active' }],
                            [{ text: 'Высокий (6+ тренировок в неделю)', callback_data: 'nutrition_activity_heavy' }]
                        ]
                    }
                });
                return;
            }
        }

        // --- Universal Text Message Handler ---
        // Если сообщение не попало ни в одну из категорий выше, обрабатываем универсальным агентом
        if (msg.text && !msg.text.startsWith('/')) {
            try {
                // СРАЗУ показываем индикатор печатания и красивые статусы
                await bot.sendChatAction(chat_id, 'typing');
                const statusMessage = await bot.sendMessage(chat_id, '🤔 Обрабатываю ваше сообщение...');
                
                // Параллельно получаем профиль пользователя и запускаем универсального агента 
                const profilePromise = supabase
                    .from('profiles')
                    .select('first_name, gender, age, height_cm, weight_kg, goal, id')
                    .eq('telegram_id', telegram_id)
                    .single();

                await new Promise(resolve => setTimeout(resolve, 600));
                await bot.editMessageText('💭 Анализирую содержание...', {
                    chat_id: chat_id,
                    message_id: statusMessage.message_id
                });

                // Начинаем обработку сообщения ПАРАЛЛЕЛЬНО с получением профиля
                const { data: profile } = await profilePromise;
                const universalResult = await processUniversalMessage(msg.text, profile);
                
                if (universalResult.success) {
                    const analysisData = universalResult.data;
                    
                    // Выполняем действие в зависимости от типа сообщения
                    switch (analysisData.action_required) {
                        case 'analyze_food':
                            // Анализируем еду через OpenAI для получения КБЖУ
                            const foodAnalysisResult = await recognizeFoodFromText(analysisData.extracted_data.meal_description || msg.text);
                            
                            if (foodAnalysisResult.success) {
                                const mealData = foodAnalysisResult.data;
                                const confirmationId = crypto.randomUUID();
                                mealConfirmationCache[confirmationId] = { ...mealData, meal_type: 'text', telegram_id };

                                const callback_data = `meal_confirm_${confirmationId}`;
                                const cancel_callback_data = `meal_cancel_${confirmationId}`;
                                const ingredientsString = mealData.ingredients ? mealData.ingredients.join(', ') : 'Не указаны';

                                const responseText = `💬 **Распознанная еда:** ${mealData.dish_name}\n\n*Ингредиенты:* ${ingredientsString}\n*КБЖУ:*\n- Калории: ${mealData.calories} ккал\n- Белки: ${mealData.protein} г\n- Жиры: ${mealData.fat} г\n- Углеводы: ${mealData.carbs} г\n\nСохранить этот приём пищи?`;

                                await bot.editMessageText(responseText, {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id,
                                    parse_mode: 'Markdown',
                                    reply_markup: {
                                        inline_keyboard: [
                                            [{ text: '✅ Да, сохранить', callback_data }, { text: '❌ Нет, отменить', callback_data: cancel_callback_data }]
                                        ]
                                    }
                                });
                            } else {
                                await bot.editMessageText(analysisData.response_text, {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            }
                            break;

                        case 'add_water':
                            // Добавляем воду
                            const waterAmount = analysisData.extracted_data.amount_ml;
                            
                            if (waterAmount && waterAmount > 0) {
                                const result = await addWaterIntake(telegram_id, waterAmount);
                                
                                if (result.success) {
                                    const waterStats = await getWaterStats(telegram_id, 'today');
                                    const today = new Date().toISOString().split('T')[0];
                                    const todayWater = waterStats.dailyStats[today] || 0;
                                    const percentage = Math.round((todayWater / waterStats.waterNorm) * 100);
                                    
                                    let responseText = `💧 **Добавлено:** ${waterAmount} мл\n\n`;
                                    responseText += `📊 Сегодня выпито: ${todayWater} / ${waterStats.waterNorm} мл (${percentage}%)\n`;
                                    responseText += `${createProgressBar(todayWater, waterStats.waterNorm)}\n\n`;
                                    
                                    if (percentage >= 100) {
                                        responseText += `🎉 Отлично! Вы выполнили дневную норму воды!`;
                                    } else {
                                        const remaining = waterStats.waterNorm - todayWater;
                                        responseText += `💪 Осталось: ${remaining} мл до нормы`;
                                    }
                                    
                                    await bot.editMessageText(responseText, {
                                        chat_id: chat_id,
                                        message_id: statusMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    await bot.editMessageText(`❌ Ошибка при добавлении воды: ${result.error}`, {
                                        chat_id: chat_id,
                                        message_id: statusMessage.message_id
                                    });
                                }
                            } else {
                                await bot.editMessageText(analysisData.response_text, {
                                    chat_id: chat_id,
                                    message_id: undefined,
                                    parse_mode: 'Markdown'
                                });
                            }
                            break;

                        case 'log_workout':
                            // Логируем тренировку
                            const workoutData = analysisData.extracted_data;
                            
                            // Определяем тип тренировки
                            let workoutType = 'other';
                            const workoutText = msg.text.toLowerCase();
                            if (workoutText.includes('бег') || workoutText.includes('пробег') || workoutText.includes('кардио')) {
                                workoutType = 'cardio';
                            } else if (workoutText.includes('зал') || workoutText.includes('жим') || workoutText.includes('тяга') || workoutText.includes('силов')) {
                                workoutType = 'strength';
                            } else if (workoutText.includes('йога') || workoutText.includes('растяжка') || workoutText.includes('стретч')) {
                                workoutType = 'yoga';
                            } else if (workoutText.includes('плавани') || workoutText.includes('бассейн')) {
                                workoutType = 'swimming';
                            } else if (workoutText.includes('ходьба') || workoutText.includes('прогулка')) {
                                workoutType = 'walking';
                            } else if (workoutText.includes('hiit') || workoutText.includes('интервал')) {
                                workoutType = 'hiit';
                            }

                            // Парсим длительность из текста
                            let duration = 30; // По умолчанию
                            const durationMatch = msg.text.match(/(\d+)\s*(минут|мин|час)/i);
                            if (durationMatch) {
                                duration = parseInt(durationMatch[1]);
                                if (durationMatch[2].includes('час')) {
                                    duration *= 60;
                                }
                            }

                            // Извлекаем упражнения
                            const exercises = workoutData.exercises || [];

                            // Рассчитываем калории
                            const caloriesBurned = calculateCaloriesBurned(workoutType, duration, exercises, profile);

                            const workoutRecord = {
                                workout_type: workoutType,
                                exercises: exercises,
                                duration: duration,
                                intensity: workoutData.intensity || 'средняя',
                                calories_burned: caloriesBurned,
                                notes: msg.text
                            };

                            const result = await addWorkoutRecord(telegram_id, workoutRecord);
                            
                            if (result.success) {
                                // Получаем прогресс по плану
                                const progressResult = await getWorkoutPlanProgress(telegram_id);
                                
                                let responseText = `💪 **Тренировка записана!**\n\n`;
                                
                                if (exercises.length > 0) {
                                    responseText += `📋 **Упражнения:**\n`;
                                    exercises.forEach(exercise => {
                                        responseText += `• ${exercise}\n`;
                                    });
                                    responseText += `\n`;
                                }
                                
                                responseText += `⏱️ **Длительность:** ${duration} мин\n`;
                                responseText += `🔥 **Сожжено калорий:** ~${caloriesBurned} ккал\n`;
                                responseText += `💯 **Интенсивность:** ${workoutRecord.intensity}\n\n`;
                                
                                // Добавляем прогресс-бар если есть план
                                if (progressResult.success) {
                                    responseText += `📊 **Прогресс по плану:**\n`;
                                    responseText += `${createWorkoutProgressBar(progressResult.completed, progressResult.planned)}\n`;
                                    responseText += `Выполнено: ${progressResult.completed} из ${progressResult.planned} тренировок на этой неделе\n\n`;
                                }
                                
                                responseText += `🎉 Отличная работа! Так держать! 💪`;

                                await bot.editMessageText(responseText, {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot.editMessageText(`❌ Ошибка при сохранении тренировки: ${result.error}`, {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id
                                });
                            }
                            break;

                        case 'generate_report':
                            // Генерируем отчет
                            const report = await generateDailyReport(telegram_id);
                            
                            if (report.success) {
                                await bot.editMessageText(report.text, {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot.editMessageText('❌ Не удалось сгенерировать отчет. Возможно, у вас нет данных за сегодня.', {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id
                                });
                            }
                            break;

                        case 'analyze_medical':
                            // Анализируем медицинские данные
                            const medicalResult = await analyzeMedicalData(msg.text, profile);
                            
                            if (medicalResult.success) {
                                const data = medicalResult.data;
                                let responseText = `🔬 **Анализ медицинских данных**\n\n`;
                                responseText += `📋 **Обнаруженные показатели:**\n${data.detected_parameters.join(', ')}\n\n`;
                                responseText += `📊 **Краткий анализ:**\n${data.analysis_summary}\n\n`;
                                
                                if (data.nutrition_recommendations.foods_to_include.length > 0) {
                                    responseText += `✅ **Рекомендуемые продукты:**\n${data.nutrition_recommendations.foods_to_include.join(', ')}\n\n`;
                                }
                                
                                responseText += `*Это рекомендации ИИ, не замена консультации врача.*`;

                                await bot.editMessageText(responseText, {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot.editMessageText(analysisData.response_text, {
                                    chat_id: chat_id,
                                    message_id: statusMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            }
                            break;

                        case 'answer_question':
                            // Отвечаем на вопрос в потоковом режиме
                            await answerUserQuestionStream(chat_id, null, msg.text, profile);
                            break;

                        default:
                            // Все остальные случаи - дружелюбный ответ через статусное сообщение
                            await bot.editMessageText(analysisData.response_text, {
                                chat_id: chat_id,
                                message_id: statusMessage.message_id,
                                parse_mode: 'Markdown'
                            });
                            break;
                    }
                } else {
                    await bot.editMessageText('Извините, не смог понять ваше сообщение. Попробуйте использовать основные функции бота через меню.', {
                        chat_id: chat_id,
                        message_id: statusMessage.message_id
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке текстового сообщения:", error);
                await bot.editMessageText('Произошла ошибка при обработке сообщения.', {
                    chat_id: chat_id,
                    message_id: statusMessage.message_id
                });
            }
        }
    });

    // --- Callback Query Handler ---
    bot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const telegram_id = callbackQuery.from.id;
        const chat_id = msg.chat.id;
        const data = callbackQuery.data;

        // Защита от повторных нажатий (debounce)
        const callbackKey = `${telegram_id}_${data}`;
        const now = Date.now();
        if (callbackDebounce[callbackKey] && (now - callbackDebounce[callbackKey]) < 1000) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Пожалуйста, подождите...' });
            return;
        }
        callbackDebounce[callbackKey] = now;

        const [action, ...params] = data.split('_');
        
        console.log(`>>> CALLBACK: User: ${telegram_id}, Data: ${data}, Action: ${action}, Params: ${params}`);
        
        // --- Subscription Callbacks ---
        if (data === 'show_subscription_plans') {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            const subscriptionText = `💎 **ТАРИФНЫЕ ПЛАНЫ**\n\n` +
                `🆓 **БЕСПЛАТНЫЙ**\n` +
                `• 2 фото в день\n` +
                `• 5 AI вопросов в день\n` +
                `• 5 ручных записей еды в день\n` +
                `• Статистика только за сегодня\n\n` +
                
                `⭐ **ДЕМО (3 дня бесплатно)**\n` +
                `• 15 фото в день\n` +
                `• 20 AI вопросов в день\n` +
                `• 15 ручных записей еды в день\n` +
                `• 3 голосовых сообщения в день\n` +
                `• 1 план питания в месяц\n` +
                `• Статистика за день и неделю\n` +
                `• Ежедневные VIP отчеты\n\n` +
                
                `🚀 **ПРОГРЕСС** - 199₽/мес\n` +
                `• Безлимитные фото и AI\n` +
                `• Безлимитные ручные записи\n` +
                `• Безлимитные планы тренировок и питания\n` +
                `• Полная статистика\n` +
                `• Ежедневные отчеты\n\n` +
                
                `👑 **УЛЬТРА** - 349₽/мес\n` +
                `• Всё из тарифа ПРОГРЕСС\n` +
                `• Голосовые сообщения\n` +
                `• Анализ медицинских данных\n` +
                `• Еженедельные VIP отчеты с детальными рекомендациями\n`;

            await bot.editMessageText(subscriptionText, {
                chat_id, message_id: msg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🎁 ДЕМО-ДОСТУП НА 3 ДНЯ', callback_data: 'activate_demo' }],
                        [{ text: '🚀 ПРОГРЕСС 199₽/мес', callback_data: 'subscribe_progress' }],
                        [{ text: '👑 УЛЬТРА 349₽/мес', callback_data: 'subscribe_ultra' }]
                    ]
                }
            });
            return;
        }

        if (data === 'activate_demo') {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            const subscription = await getUserSubscription(telegram_id);
            if (subscription.subscription_type !== 'FREE') {
                await bot.editMessageText('У вас уже есть активная подписка! 😊', {
                    chat_id, message_id: msg.message_id
                });
                return;
            }

            // Проверяем, не использовал ли уже пользователь демо
            const { data: existingPromo, error } = await supabase
                .from('user_subscriptions')
                .select('*')
                .eq('telegram_id', telegram_id)
                .in('subscription_type', ['PROMO'])
                .single();

            if (existingPromo && !error) {
                await bot.editMessageText('Демо-доступ можно использовать только один раз 😔\n\nВыберите платную подписку для продолжения использования премиум функций.', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 ПРОГРЕСС 199₽/мес', callback_data: 'subscribe_progress' }],
                            [{ text: '👑 УЛЬТРА 349₽/мес', callback_data: 'subscribe_ultra' }]
                        ]
                    }
                });
                return;
            }

            // Активируем промо
            const result = await activatePromo(telegram_id);
            if (result.success) {
                await bot.editMessageText('🎉 *Демо-доступ активирован на 3 дня!*\n\n✨ Теперь вам доступны:\n• Голосовые сообщения (3 в день)\n• План питания\n• Ежедневные VIP отчеты\n• Расширенная статистика\n\nПриятного использования!', {
                    chat_id, message_id: msg.message_id,
                    parse_mode: 'Markdown'
                });
            } else {
                await bot.editMessageText(`❌ Ошибка активации: ${result.error}`, {
                    chat_id, message_id: msg.message_id
                });
            }
            return;
        }

        if (data === 'subscribe_progress' || data === 'subscribe_ultra') {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            const planName = data === 'subscribe_progress' ? 'ПРОГРЕСС' : 'УЛЬТРА';
            const price = data === 'subscribe_progress' ? '199₽' : '349₽';
            
            await bot.editMessageText(`💳 Для оформления подписки "${planName}" (${price}/мес) свяжитесь с администратором:\n\n@your_admin_username\n\nПосле оплаты ваш тариф будет активирован в течение 1 часа.`, {
                chat_id, message_id: msg.message_id,
                parse_mode: 'Markdown'
            });
            return;
        }

        // --- Challenge Callbacks ---
        if (data.startsWith('challenge_')) {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            if (data.startsWith('challenge_add_steps_')) {
                // Добавление определенного количества прогресса
                const valueString = data.split('_')[3];
                const progressValue = parseFloat(valueString);
                
                // Получаем текущий челлендж чтобы определить тип
                const challengeResult = await getCurrentChallenge();
                let successMessage = `✅ Добавлено ${progressValue}`;
                
                if (challengeResult.success) {
                    const challenge = challengeResult.data;
                    if (challenge.type === 'steps') {
                        successMessage = `✅ Добавлено ${progressValue} шагов!`;
                    } else if (challenge.type === 'workout_time' || challenge.unit.includes('минут')) {
                        successMessage = `✅ Добавлено ${progressValue} минут тренировки!`;
                    } else if (challenge.type === 'water' || challenge.unit.includes('литр')) {
                        successMessage = `✅ Добавлено ${progressValue} л воды!`;
                    } else if (challenge.type === 'exercises' || challenge.unit.includes('раз')) {
                        successMessage = `✅ Добавлено ${progressValue} повторений!`;
                    } else {
                        successMessage = `✅ Добавлено ${progressValue} ${challenge.unit}!`;
                    }
                }
                
                const result = await addChallengeProgress(telegram_id, progressValue);
                
                if (result.success) {
                    await bot.editMessageText(`${successMessage}\n\nОбновляю ваш прогресс...`, {
                        chat_id, message_id: msg.message_id
                    });
                    
                    // Показываем обновленное меню через 2 секунды
                    setTimeout(() => {
                        showChallengeMenu(chat_id, telegram_id);
                    }, 2000);
                } else {
                    await bot.editMessageText(`❌ Ошибка при добавлении прогресса: ${result.error}`, {
                        chat_id, message_id: msg.message_id
                    });
                }
                
            } else if (data === 'challenge_add_custom_steps') {
                // Ввод произвольного количества прогресса
                const challengeResult = await getCurrentChallenge();
                let inputPrompt = 'Введите значение:';
                
                if (challengeResult.success) {
                    const challenge = challengeResult.data;
                    if (challenge.type === 'steps') {
                        inputPrompt = 'Введите количество пройденных шагов:\n\n(например: 7500)';
                    } else if (challenge.type === 'workout_time' || challenge.unit.includes('минут')) {
                        inputPrompt = 'Введите время тренировки в минутах:\n\n(например: 45)';
                    } else if (challenge.type === 'water' || challenge.unit.includes('литр')) {
                        inputPrompt = 'Введите количество воды в литрах:\n\n(например: 2.5)';
                    } else if (challenge.type === 'exercises' || challenge.unit.includes('раз')) {
                        inputPrompt = 'Введите количество повторений:\n\n(например: 150)';
                    } else {
                        inputPrompt = `Введите значение в ${challenge.unit}:\n\n(например: 25)`;
                    }
                }
                
                // Умная очистка перед вводом данных челленджа
                closeConflictingStates(telegram_id, 'challenge_input');
                challengeStepsState[telegram_id] = { waiting: true };
                await bot.editMessageText(inputPrompt, {
                    chat_id, message_id: msg.message_id,
                    reply_markup: null
                });
                
            } else if (data === 'challenge_stats') {
                // Показываем статистику
                const challengeResult = await getCurrentChallenge();
                const stepsStats = await getStepsStats(telegram_id, 'week');
                
                if (challengeResult.success && stepsStats.success) {
                    const challenge = challengeResult.data;
                    const totalSteps = stepsStats.totalSteps;
                    const progress = Math.min(Math.round((totalSteps / challenge.target_value) * 100), 100);
                    
                    // Статистика по дням недели
                    const today = new Date();
                    const weekStart = new Date();
                    const day = weekStart.getDay();
                    const diff = weekStart.getDate() - day + (day === 0 ? -6 : 1);
                    weekStart.setDate(diff);
                    
                    let statsText = `📊 **СТАТИСТИКА НЕДЕЛИ**\n\n`;
                    statsText += `🏆 **Челлендж:** ${challenge.title}\n`;
                    statsText += `🎯 **Прогресс:** ${totalSteps.toLocaleString()} / ${challenge.target_value.toLocaleString()} ${challenge.unit}\n`;
                    statsText += `📈 **Выполнено:** ${progress}%\n\n`;
                    
                    statsText += `📅 **По дням:**\n`;
                    const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
                    
                    for (let i = 0; i < 7; i++) {
                        const currentDay = new Date(weekStart);
                        currentDay.setDate(weekStart.getDate() + i);
                        const dateString = currentDay.toISOString().split('T')[0];
                        const dayProgress = stepsStats.byDate[dateString] || 0;
                        const isToday = dateString === today.toISOString().split('T')[0];
                        
                        // Форматируем значение в зависимости от типа челленджа
                        let dayText;
                        if (challenge.type === 'steps') {
                            dayText = `${dayProgress.toLocaleString()} шагов`;
                        } else if (challenge.type === 'workout_time' || challenge.unit.includes('минут')) {
                            dayText = `${dayProgress} минут`;
                        } else if (challenge.type === 'water' || challenge.unit.includes('литр')) {
                            dayText = `${dayProgress} л`;
                        } else if (challenge.type === 'exercises' || challenge.unit.includes('раз')) {
                            dayText = `${dayProgress} раз`;
                        } else {
                            dayText = `${dayProgress} ${challenge.unit}`;
                        }
                        
                        statsText += `${dayNames[i]}: ${dayText} ${isToday ? '👈' : ''}\n`;
                    }
                    
                    if (progress >= 100) {
                        statsText += `\n🎉 Поздравляем! Челлендж выполнен!`;
                    } else {
                        const remaining = challenge.target_value - totalSteps;
                        const daysLeft = 7 - ((today.getDay() + 6) % 7);
                        const avgNeeded = daysLeft > 0 ? Math.ceil(remaining / daysLeft) : remaining;
                        
                        // Форматируем остаток в зависимости от типа челленджа
                        let remainingText, avgText;
                        if (challenge.type === 'steps') {
                            remainingText = `${remaining.toLocaleString()} шагов`;
                            avgText = `${avgNeeded.toLocaleString()} шагов/день`;
                        } else if (challenge.type === 'workout_time' || challenge.unit.includes('минут')) {
                            remainingText = `${remaining} минут`;
                            avgText = `${avgNeeded} минут/день`;
                        } else if (challenge.type === 'water' || challenge.unit.includes('литр')) {
                            remainingText = `${remaining} л`;
                            avgText = `${avgNeeded} л/день`;  
                        } else if (challenge.type === 'exercises' || challenge.unit.includes('раз')) {
                            remainingText = `${remaining} раз`;
                            avgText = `${avgNeeded} раз/день`;
                        } else {
                            remainingText = `${remaining} ${challenge.unit}`;
                            avgText = `${avgNeeded} ${challenge.unit}/день`;
                        }
                        
                        statsText += `\n💪 Осталось: ${remainingText}`;
                        if (daysLeft > 0) {
                            statsText += `\n📍 В среднем ${avgText}`;
                        }
                    }
                    
                    await bot.editMessageText(statsText, {
                        chat_id, message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔙 Назад к челленджу', callback_data: 'challenge_back' }]
                            ]
                        }
                    });
                } else {
                    await bot.editMessageText('❌ Не удалось загрузить статистику', {
                        chat_id, message_id: msg.message_id
                    });
                }
                
            } else if (data === 'challenge_back') {
                // Возвращаемся к меню челленджа
                showChallengeMenu(chat_id, telegram_id);
            }
            
            return;
        }
        
        // --- Plan Action Callbacks ---
        if (data.startsWith('workout_action_') || data.startsWith('nutrition_action_')) {
        await bot.answerCallbackQuery(callbackQuery.id);

            const [planType, , actionType] = data.split('_');
            
            if (actionType === 'no') {
                // Пользователь выбрал "Нет" - включаем режим ожидания вопроса
                // Умная очистка перед переходом в режим вопросов
                closeConflictingStates(telegram_id, 'question_mode');
                questionState[telegram_id] = { waiting: true };
                await bot.editMessageText('Какой у вас вопрос? 🤔\n\nЯ могу помочь с вопросами о питании, калориях, тренировках и здоровом образе жизни.', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: null
                });
                return;
            }
            
            // Получаем профиль пользователя
            const profileFields = planType === 'workout' 
                ? 'id, first_name, gender, age, height_cm, weight_kg, goal'
                : 'id, first_name, gender, age, height_cm, weight_kg, goal, daily_calories, daily_protein, daily_fat, daily_carbs';
                
            const { data: profile } = await supabase
                .from('profiles')
                .select(profileFields)
                .eq('telegram_id', telegram_id)
                .single();

            if (!profile) {
                await bot.editMessageText('Ошибка при получении профиля. Попробуйте позже.', {
                    chat_id, message_id: msg.message_id
                });
                return;
            }

            if (actionType === 'restart') {
                // Пройти анкету заново - удаляем старые данные
                const tableName = planType === 'workout' ? 'workout_plan_data' : 'nutrition_plan_data';
                await supabase
                    .from(tableName)
                    .delete()
                    .eq('user_id', profile.id);

                // Запускаем анкетирование
                if (planType === 'workout') {
                    workoutPlanState[telegram_id] = { 
                        step: 'ask_experience', 
                        data: { priority_zones: [] },
                        profileData: profile 
                    };

                    await bot.editMessageText('Хорошо! Давайте пересоздадим ваш план тренировок 💪\n\nКакой у вас опыт тренировок?', {
                        chat_id, message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Новичок (меньше 6 месяцев)', callback_data: 'workout_exp_beginner' }],
                                [{ text: 'Средний (6 месяцев - 2 года)', callback_data: 'workout_exp_intermediate' }],
                                [{ text: 'Продвинутый (больше 2 лет)', callback_data: 'workout_exp_advanced' }]
                            ]
                        }
                    });
                } else {
                    nutritionPlanState[telegram_id] = { 
                        step: 'ask_preferences', 
                        data: {},
                        profileData: profile 
                    };

                    await bot.editMessageText('Хорошо! Давайте пересоздадим ваш план питания 🍽️\n\nКакие у вас есть пищевые предпочтения?', {
                        chat_id, message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Обычное питание', callback_data: 'nutrition_pref_regular' }],
                                [{ text: 'Вегетарианство', callback_data: 'nutrition_pref_vegetarian' }],
                                [{ text: 'Веганство', callback_data: 'nutrition_pref_vegan' }],
                                [{ text: 'Кето-диета', callback_data: 'nutrition_pref_keto' }]
                            ]
                        }
                    });
                }
            } else if (actionType === 'yes') {
                // Пользователь выбрал "Да" - проверяем есть ли данные
                const tableName = planType === 'workout' ? 'workout_plan_data' : 'nutrition_plan_data';
                const { data: existingData } = await supabase
                    .from(tableName)
                    .select('*')
                    .eq('user_id', profile.id)
                    .single();

                if (existingData) {
                    // Данные есть, генерируем план сразу
                    const planTypeName = planType === 'workout' ? 'тренировок' : 'питания';
                    
                    // Показываем индикатор печатания
                    await bot.sendChatAction(chat_id, 'typing');
                    
                    const loadingMessage = await bot.editMessageText(`🤖 Анализирую ваши данные...`, {
                        chat_id, message_id: msg.message_id
                    });
                    
                    // Запускаем длительный типинг-индикатор
                    showTyping(chat_id, 30000);

                    try {
                        // Постепенное обновление прогресса
                        setTimeout(async () => {
                            try {
                                await bot.editMessageText(`🤖 Формирую персональные рекомендации для ${profile.first_name}...`, {
                                    chat_id, message_id: loadingMessage.message_id
                                });
                            } catch (e) { /* игнорируем ошибки обновления */ }
                        }, 3000);
                        
                        setTimeout(async () => {
                            try {
                                await bot.editMessageText(`🤖 Создаю план ${planTypeName} с учетом ваших целей...`, {
                                    chat_id, message_id: loadingMessage.message_id
                                });
                            } catch (e) { /* игнорируем ошибки обновления */ }
                        }, 8000);
                        
                        setTimeout(async () => {
                            try {
                                await bot.editMessageText(`🤖 Финализирую детали плана... Почти готово!`, {
                                    chat_id, message_id: loadingMessage.message_id
                                });
                            } catch (e) { /* игнорируем ошибки обновления */ }
                        }, 15000);
                        
                        let planResult;
                        if (planType === 'workout') {
                            const workoutData = {
                                experience: existingData.experience,
                                goal: existingData.goal,
                                priority_zones: existingData.priority_zones,
                                injuries: existingData.injuries,
                                location: existingData.location,
                                frequency: existingData.frequency_per_week,
                                duration: existingData.duration_minutes
                            };
                            planResult = await generateWorkoutPlan(profile, workoutData);
                        } else {
                            const nutritionData = {
                                preferences: existingData.diet_type,
                                activity: existingData.activity_level,
                                allergies: existingData.allergies ? existingData.allergies[0] : 'none',
                                mealsCount: existingData.meals_per_day
                            };
                            planResult = await generateNutritionPlan(profile, nutritionData);
                        }

                        if (planResult.success) {
                            // Отправляем красивый HTML-документ
                            const currentDate = new Date().toLocaleDateString('ru-RU').replace(/\./g, '_');
                            let htmlContent, filename;
                            
                            if (planType === 'workout') {
                                htmlContent = generateWorkoutPlanHTML(planResult.plan, profile, existingData);
                                filename = `План_тренировок_${profile.first_name}_${currentDate}.html`;
                            } else {
                                htmlContent = generateNutritionPlanHTML(planResult.plan, profile, existingData);
                                filename = `План_питания_${profile.first_name}_${currentDate}.html`;
                            }
                            
                            await bot.deleteMessage(chat_id, loadingMessage.message_id);
                            await sendPlanAsDocument(chat_id, planType, htmlContent, filename);
                        } else {
                            await bot.editMessageText(`❌ Произошла ошибка при создании плана: ${planResult.error}`, {
                                chat_id,
                                message_id: loadingMessage.message_id
                            });
                        }
                    } catch (error) {
                        console.error(`Error generating ${planType} plan from existing data:`, error);
                        await bot.editMessageText('❌ Произошла ошибка при создании плана. Попробуйте позже.', {
                            chat_id,
                            message_id: loadingMessage.message_id
                        });
                    }
                } else {
                    // Данных нет, запускаем анкетирование
                    if (planType === 'workout') {
                        workoutPlanState[telegram_id] = { 
                            step: 'ask_target_weight', 
                            data: { priority_zones: [] },
                            profileData: profile 
                        };

                        let weightQuestion = '';
                        if (profile.goal === 'lose_weight') {
                            weightQuestion = `Для составления эффективного плана тренировок, скажите:\n\n**Какой вес для себя вы считаете идеальным?** (в кг, например: 65.5)\n\nВаш текущий вес: ${profile.weight_kg} кг`;
                        } else if (profile.goal === 'gain_mass') {
                            weightQuestion = `Для составления эффективного плана тренировок, скажите:\n\n**До какого веса вы хотите набрать массу?** (в кг, например: 80.5)\n\nВаш текущий вес: ${profile.weight_kg} кг`;
                        } else {
                            weightQuestion = `Для составления эффективного плана тренировок, скажите:\n\n**Какой вес для себя вы считаете идеальным для поддержания?** (в кг, например: 70.5)\n\nВаш текущий вес: ${profile.weight_kg} кг`;
                        }

                        await bot.editMessageText(weightQuestion, {
                            chat_id, message_id: msg.message_id,
                            parse_mode: 'Markdown',
                            reply_markup: null
                        });
                    } else {
                        // Для планов питания проверяем, есть ли уже целевой вес в профиле
                        if (profile.target_weight_kg) {
                            // Целевой вес уже есть, пропускаем вопрос и переходим к следующему шагу
                            nutritionPlanState[telegram_id] = { 
                                step: 'ask_activity', 
                                data: { target_weight_kg: profile.target_weight_kg, timeframe_months: profile.timeframe_months || 6 },
                                profileData: profile 
                            };

                            await bot.editMessageText('Какой у вас уровень активности?', {
                                chat_id, message_id: msg.message_id,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Низкий (сидячий образ жизни)', callback_data: 'nutrition_activity_sedentary' }],
                                        [{ text: 'Легкий (1-3 тренировки в неделю)', callback_data: 'nutrition_activity_light' }],
                                        [{ text: 'Активный (3-5 тренировок в неделю)', callback_data: 'nutrition_activity_active' }],
                                        [{ text: 'Высокий (6+ тренировок в неделю)', callback_data: 'nutrition_activity_heavy' }]
                                    ]
                                }
                            });
                        } else {
                            // Целевого веса нет, спрашиваем
                            nutritionPlanState[telegram_id] = { 
                                step: 'ask_target_weight', 
                                data: {},
                                profileData: profile 
                            };

                            let weightQuestion = '';
                            if (profile.goal === 'lose_weight') {
                                weightQuestion = `Для составления эффективного плана питания, скажите:\n\n**Какой вес для себя вы считаете идеальным?** (в кг, например: 65.5)\n\nВаш текущий вес: ${profile.weight_kg} кг`;
                            } else if (profile.goal === 'gain_mass') {
                                weightQuestion = `Для составления эффективного плана питания, скажите:\n\n**До какого веса вы хотите набрать массу?** (в кг, например: 80.5)\n\nВаш текущий вес: ${profile.weight_kg} кг`;
                            } else {
                                weightQuestion = `Для составления эффективного плана питания, скажите:\n\n**Какой вес для себя вы считаете идеальным для поддержания?** (в кг, например: 70.5)\n\nВаш текущий вес: ${profile.weight_kg} кг`;
                            }

                            await bot.editMessageText(weightQuestion, {
                                chat_id, message_id: msg.message_id,
                                parse_mode: 'Markdown',
                                reply_markup: null
                            });
                        }
                    }
                }
            }
            return;
        }
        
        // --- Water Callbacks ---
        if (action === 'water') {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            if (params[0] === 'add') {
                const amount = parseInt(params[1]);
                const result = await addWaterIntake(telegram_id, amount);
                
                if (result.success) {
                    // Обновляем меню с новой статистикой
                    const waterStats = await getWaterStats(telegram_id, 'today');
                    const today = new Date().toISOString().split('T')[0];
                    const todayWater = waterStats.dailyStats[today] || 0;
                    const percentage = Math.round((todayWater / waterStats.waterNorm) * 100);
                    const progressBar = createProgressBar(todayWater, waterStats.waterNorm);

                    let waterText = `💧 **Отслеживание воды**\n\n`;
                    waterText += `✅ Добавлено: ${amount} мл\n`;
                    waterText += `📊 Сегодня: ${todayWater} / ${waterStats.waterNorm} мл (${percentage}%)\n`;
                    waterText += `${progressBar}\n\n`;
                    waterText += `Выберите количество для добавления:`;

                    await bot.editMessageText(waterText, {
                        chat_id, message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '💧 100 мл', callback_data: 'water_add_100' },
                                    { text: '💧 200 мл', callback_data: 'water_add_200' }
                                ],
                                [
                                    { text: '💧 250 мл', callback_data: 'water_add_250' },
                                    { text: '💧 500 мл', callback_data: 'water_add_500' }
                                ],
                                [
                                    { text: '📊 Статистика воды', callback_data: 'water_stats' },
                                    { text: '✏️ Свое количество', callback_data: 'water_custom' }
                                ]
                            ]
                        }
                    });
                } else {
                    await bot.editMessageText(`❌ Ошибка: ${result.error}`, {
                        chat_id, message_id: msg.message_id
                    });
                }
            } else if (params[0] === 'stats') {
                // Показываем статистику воды
                bot.sendMessage(chat_id, 'За какой период показать статистику воды?', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'За сегодня', callback_data: 'water_period_today' }],
                            [{ text: 'За неделю', callback_data: 'water_period_week' }],
                            [{ text: 'За месяц', callback_data: 'water_period_month' }]
                        ]
                    }
                });
            } else if (params[0] === 'period') {
                const period = params[1];
                const waterStats = await getWaterStats(telegram_id, period);
                
                if (waterStats.success) {
                    let periodText = '';
                    if (period === 'today') periodText = 'сегодня';
                    else if (period === 'week') periodText = 'за неделю';
                    else if (period === 'month') periodText = 'за месяц';

                    let statsText = `💧 **Статистика воды ${periodText}**\n\n`;
                    
                    if (waterStats.recordsCount === 0) {
                        statsText += `За ${periodText} вы еще не добавляли записи о воде.`;
                    } else {
                        if (period === 'today') {
                            const today = new Date().toISOString().split('T')[0];
                            const todayWater = waterStats.dailyStats[today] || 0;
                            const percentage = Math.round((todayWater / waterStats.waterNorm) * 100);
                            const progressBar = createProgressBar(todayWater, waterStats.waterNorm);

                            statsText += `📊 Выпито: ${todayWater} / ${waterStats.waterNorm} мл (${percentage}%)\n`;
                            statsText += `${progressBar}\n\n`;
                            
                            if (percentage >= 100) {
                                statsText += `🎉 Отлично! Вы выполнили дневную норму воды!`;
                            } else {
                                const remaining = waterStats.waterNorm - todayWater;
                                statsText += `💡 Осталось выпить: ${remaining} мл`;
                            }
                        } else {
                            const daysWithData = Object.keys(waterStats.dailyStats).length;
                            const avgDaily = Math.round(waterStats.totalWater / Math.max(daysWithData, 1));
                            
                            statsText += `📈 Всего выпито: ${waterStats.totalWater} мл\n`;
                            statsText += `📅 Дней с записями: ${daysWithData}\n`;
                            statsText += `📊 В среднем в день: ${avgDaily} мл\n`;
                            statsText += `🎯 Дневная норма: ${waterStats.waterNorm} мл\n\n`;
                            
                            const avgPercentage = Math.round((avgDaily / waterStats.waterNorm) * 100);
                            statsText += `💯 Выполнение нормы: ${avgPercentage}%`;
                        }
                    }

                    await bot.editMessageText(statsText, {
                        chat_id, message_id: msg.message_id,
                        parse_mode: 'Markdown'
                    });
                } else {
                    await bot.editMessageText(`❌ Ошибка: ${waterStats.error}`, {
                        chat_id, message_id: msg.message_id
                    });
                }
            } else if (params[0] === 'custom') {
                // Включаем режим ожидания ввода количества воды
                // Умная очистка перед вводом воды (оставляем только водные операции)
                closeConflictingStates(telegram_id, 'water_tracking');
                waterInputState[telegram_id] = { waiting: true };
                await bot.editMessageText('Напишите количество воды в миллилитрах (например, 300):', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: null
                });
            }
            return;
        }

        // --- Registration Callbacks ---
        if (action === 'register' && registrationState[telegram_id]) {
            const state = registrationState[telegram_id];
            const value = params[params.length - 1];
            await bot.answerCallbackQuery(callbackQuery.id);

            if (state.step === 'ask_gender' && params[0] === 'gender') {
                state.data.gender = value;
                state.step = 'ask_age';
                await bot.editMessageText('Принято. Теперь введи свой возраст (полных лет):', {
                    chat_id: chat_id, message_id: msg.message_id,
                });
                return;
            }
            
            if (state.step === 'ask_goal' && params[0] === 'goal') {
                const goalMapping = { 'lose': 'lose_weight', 'maintain': 'maintain_weight', 'gain': 'gain_mass' };
                state.data.goal = goalMapping[value];
                
                try {
                    const { data: newProfile, error } = await supabase.from('profiles').insert([{
                        telegram_id: state.data.telegram_id,
                        username: state.data.username,
                        first_name: state.data.first_name,
                        last_name: state.data.last_name,
                        chat_id: state.data.chat_id,
                        gender: state.data.gender,
                        age: state.data.age,
                        height_cm: state.data.height_cm,
                        weight_kg: state.data.weight_kg,
                        goal: state.data.goal
                    }]).select().single();

                    if (error) throw error;
                    delete registrationState[telegram_id];
                    await calculateAndSaveNorms(newProfile);

                    await bot.editMessageText(`✅ Отлично! Твой профиль сохранён.`, {
                        chat_id: chat_id, message_id: msg.message_id,
                    });
                    
                    showMainMenu(chat_id, `Теперь ты можешь начать отслеживать калории. Чем займёмся?`);
                } catch (dbError) {
                    console.error('Error saving user profile:', dbError.message);
                    await bot.editMessageText('Не удалось сохранить твой профиль. Что-то пошло не так. Попробуй /start еще раз.', {
                        chat_id: chat_id, message_id: msg.message_id,
                    });
                }
                return;
            }
        }

        // --- Meal Confirmation Callbacks ---
        if (action === 'meal') {
            const confirmationAction = params[0]; // 'confirm' or 'cancel'
            const confirmationId = params[1];
            await bot.answerCallbackQuery(callbackQuery.id);

            const mealData = mealConfirmationCache[confirmationId];

            if (!mealData) {
                await bot.editMessageText('🤔 Похоже, эти кнопки устарели. Пожалуйста, попробуйте добавить еду заново.', {
                    chat_id, message_id: msg.message_id, reply_markup: null
                });
            return;
        }

            delete mealConfirmationCache[confirmationId];

            if (confirmationAction === 'confirm') {
                try {
                    const { dish_name, calories, protein, fat, carbs, weight_g, meal_type, telegram_id: meal_telegram_id } = mealData;
                    const { data: profile, error: profileError } = await supabase
                        .from('profiles').select('id').eq('telegram_id', meal_telegram_id).single();

                    if (profileError || !profile) throw new Error(`User profile not found for meal save. Telegram ID: ${meal_telegram_id}`);

                    const mealToInsert = {
                        user_id: profile.id,
                        description: dish_name,
                        calories: parseInt(calories),
                        protein: parseFloat(protein),
                        fat: parseFloat(fat),
                        carbs: parseFloat(carbs),
                        weight_g: parseInt(weight_g),
                        meal_type: meal_type,
                        eaten_at: new Date().toISOString()
                    };

                    console.log(`Сохраняем еду для пользователя ${meal_telegram_id}:`, mealToInsert);

                    const { error: mealError } = await supabase.from('meals').insert([mealToInsert]);
                    if (mealError) throw mealError;

                    console.log(`✅ Еда успешно сохранена для пользователя ${meal_telegram_id}`);
                    
                    // 📊 УЧЕТ ИСПОЛЬЗОВАНИЯ ЛИМИТОВ
                    if (meal_type === 'manual') {
                        await incrementUsage(meal_telegram_id, 'manual_entries');
                        console.log(`📊 Увеличен счетчик ручного ввода для пользователя ${meal_telegram_id}`);
                    } else if (meal_type === 'photo') {
                        // Уже учтено в обработке фото
                        console.log(`📊 Фото уже учтено для пользователя ${meal_telegram_id}`);
                    }

                    await bot.editMessageText(`✅ Сохранено: ${dish_name} (${calories} ккал).`, {
                        chat_id, message_id: msg.message_id, reply_markup: null
                    });
                } catch(dbError) {
                    console.error('Error saving meal:', dbError.message);
                    await bot.editMessageText('Не удалось сохранить приём пищи. Пожалуйста, попробуйте снова.', {
                        chat_id, message_id: msg.message_id
                    });
                }
            } else { // 'cancel'
                await bot.editMessageText('Действие отменено.', {
                    chat_id, message_id: msg.message_id, reply_markup: null
                });
            }
            return;
        }

        // --- Stats Callbacks ---
        if (action === 'stats') {
            const period = params[0];
            await bot.answerCallbackQuery(callbackQuery.id);

            // 🔒 ПРОВЕРКА ДОСТУПА К СТАТИСТИКЕ ПО ТАРИФАМ
            const subscription = await getUserSubscription(telegram_id);
            const tier = subscription.tier;
            
            // Проверяем разрешение на просмотр статистики за определенный период
            if (period === 'week' && tier === 'free') {
                let upgradeText = `🚫 **Недельная статистика доступна только с тарифами PROMO и выше!**\n\n`;
                upgradeText += `📊 **Что вы получите:**\n`;
                upgradeText += `• Статистика за неделю и месяц\n`;
                upgradeText += `• Детальная аналитика прогресса\n`;
                upgradeText += `• Графики и тренды\n\n`;
                
                if (!subscription.promo_expires_at) {
                    upgradeText += `🎁 **Попробуйте промо-период бесплатно!**`;
                    
                    await bot.editMessageText(upgradeText, {
                        chat_id, message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🎁 Активировать промо', callback_data: 'activate_promo' }],
                                [{ text: '📋 Посмотреть тарифы', callback_data: 'subscription_plans' }]
                            ]
                        }
                    });
                } else {
                    upgradeText += `Выберите подходящий тариф для продолжения! 🚀`;
                    await bot.editMessageText(upgradeText, {
                        chat_id, message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📋 Посмотреть тарифы', callback_data: 'subscription_plans' }]
                            ]
                        }
                    });
                }
                return;
            }
            
            if (period === 'month' && (tier === 'free' || tier === 'promo')) {
                let upgradeText = `🚫 **Месячная статистика доступна только с тарифами PROGRESS и выше!**\n\n`;
                upgradeText += `📊 **Что вы получите:**\n`;
                upgradeText += `• Статистика за месяц и год\n`;
                upgradeText += `• Безлимитный анализ еды\n`;
                upgradeText += `• Планы тренировок и питания\n`;
                upgradeText += `• Ежедневные отчеты\n\n`;
                upgradeText += `Выберите подходящий тариф для продолжения! 🚀`;
                
                await bot.editMessageText(upgradeText, {
                    chat_id, message_id: msg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📋 Посмотреть тарифы', callback_data: 'subscription_plans' }]
                        ]
                    }
                });
                return;
            }

            try {
                const { data: profile, error: profileError } = await supabase
                    .from('profiles')
                    .select('id, first_name, weight_kg, daily_calories, daily_protein, daily_fat, daily_carbs')
                    .eq('telegram_id', telegram_id)
                    .single();

                if (profileError || !profile) {
                    await bot.editMessageText('Не удалось найти ваш профиль. Пожалуйста, попробуйте /start, чтобы всё синхронизировать.', {
                        chat_id, message_id: msg.message_id
                    });
                    return;
                }
                
                let periodText = '';
                if (period === 'today') periodText = 'сегодня';
                else if (period === 'week') periodText = 'эту неделю';
                else if (period === 'month') periodText = 'этот месяц';

                const { data: allMeals, error: mealsError } = await supabase
                    .from('meals')
                    .select('calories, protein, fat, carbs, eaten_at, description')
                    .eq('user_id', profile.id)
                    .order('eaten_at', { ascending: false });

                if (mealsError) throw mealsError;

                // Фильтрация по периоду
                let meals = allMeals || [];
                if (period === 'today' && meals.length > 0) {
                    const now = new Date();
                    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
                    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
                    
                    meals = allMeals.filter(meal => {
                        const mealDate = new Date(meal.eaten_at);
                        return mealDate >= todayStart && mealDate <= todayEnd;
                    });
                } else if (period === 'week' && meals.length > 0) {
                    const now = new Date();
                    const weekStart = new Date(now);
                    weekStart.setDate(now.getDate() - 7);
                    
                    meals = allMeals.filter(meal => new Date(meal.eaten_at) >= weekStart);
                } else if (period === 'month' && meals.length > 0) {
                    const now = new Date();
                    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                    
                    meals = allMeals.filter(meal => new Date(meal.eaten_at) >= monthStart);
                }

                let statsText;
                if (!meals || meals.length === 0) {
                    statsText = `За ${periodText}, ${profile.first_name}, у тебя еще не было записей о приемах пищи.`;
                } else {
                    const totals = meals.reduce((acc, meal) => {
                        acc.calories += meal.calories || 0;
                        acc.protein += meal.protein || 0;
                        acc.fat += meal.fat || 0;
                        acc.carbs += meal.carbs || 0;
                        return acc;
                    }, { calories: 0, protein: 0, fat: 0, carbs: 0 });
                    
                    const formatLine = (consumed, norm) => norm ? `${consumed.toFixed(0)} / ${norm} ` : `${consumed.toFixed(0)} `;

                    const { daily_calories, daily_protein, daily_fat, daily_carbs } = profile;
                    
                    // Рассчитываем данные для прогресс-баров долгосрочного трекинга
                    let dailyAverageText = '';
                    let totalCaloriesNormText = '';
                    let totalWaterNormText = '';
                    
                    if (period !== 'today') {
                         // Рассчитываем количество дней
                         let daysInPeriod = 1;
                         if (period === 'week') {
                             daysInPeriod = 7;
                         } else if (period === 'month') {
                             const now = new Date();
                             daysInPeriod = now.getDate(); // дни с начала месяца
                         }
                         
                         const avgCalories = totals.calories / daysInPeriod;
                         dailyAverageText = `📈 Среднесуточно: *${avgCalories.toFixed(0)} ккал/день*\n\n`;
                         
                         // Общий трекер калорий за период
                         const totalCaloriesNorm = daily_calories * daysInPeriod;
                         const caloriesPercentage = Math.round((totals.calories / totalCaloriesNorm) * 100);
                         totalCaloriesNormText = `\n🎯 **Общий прогресс калорий за ${periodText}:**\n` +
                                               `${totals.calories.toFixed(0)} / ${totalCaloriesNorm} ккал (${caloriesPercentage}%)\n` +
                                               `${createProgressBar(totals.calories, totalCaloriesNorm)}\n`;
                    }

                    // Получаем статистику воды
                    const waterStats = await getWaterStats(telegram_id, period);
                    let waterText = '';
                    
                    if (waterStats.success) {
                        if (period === 'today') {
                            const today = new Date().toISOString().split('T')[0];
                            const todayWater = waterStats.dailyStats[today] || 0;
                            const waterPercentage = Math.round((todayWater / waterStats.waterNorm) * 100);
                            waterText = `\n\n💧 Вода: *${todayWater} / ${waterStats.waterNorm} мл (${waterPercentage}%)*\n` +
                                       `${createProgressBar(todayWater, waterStats.waterNorm)}`;
                        } else {
                            const daysWithData = Object.keys(waterStats.dailyStats).length;
                            if (daysWithData > 0) {
                                const avgDaily = Math.round(waterStats.totalWater / Math.max(daysWithData, 1));
                                const avgPercentage = Math.round((avgDaily / waterStats.waterNorm) * 100);
                                
                                // Общий трекер воды за период
                                let daysInPeriod = 1;
                                if (period === 'week') {
                                    daysInPeriod = 7;
                                } else if (period === 'month') {
                                    const now = new Date();
                                    daysInPeriod = now.getDate();
                                }
                                const totalWaterNorm = waterStats.waterNorm * daysInPeriod;
                                const totalWaterPercentage = Math.round((waterStats.totalWater / totalWaterNorm) * 100);
                                
                                totalWaterNormText = `\n🎯 **Общий прогресс воды за ${periodText}:**\n` +
                                                   `${waterStats.totalWater} / ${totalWaterNorm} мл (${totalWaterPercentage}%)\n` +
                                                   `${createProgressBar(waterStats.totalWater, totalWaterNorm)}\n`;
                                
                                waterText = `\n\n💧 Вода среднесуточно: *${avgDaily} мл/день (${avgPercentage}% от нормы)*`;
                            }
                        }
                    }

                    statsText = `*Статистика за ${periodText}, ${profile.first_name}:*\n\n` +
                                `🔥 Калории: *${formatLine(totals.calories, daily_calories)}ккал*\n` +
                                (period === 'today' ? `${createProgressBar(totals.calories, daily_calories)}\n\n` : '') +
                                (period === 'today' ? '' : dailyAverageText) +
                                totalCaloriesNormText +
                                `\n*Общее количество БЖУ:*\n` +
                                `🥩 Белки: ${formatLine(totals.protein, daily_protein)}г\n` +
                                `🥑 Жиры: ${formatLine(totals.fat, daily_fat)}г\n` +
                                `🍞 Углеводы: ${formatLine(totals.carbs, daily_carbs)}г` +
                                waterText +
                                totalWaterNormText;
                }
                
                await bot.editMessageText(statsText, {
                    chat_id, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: null
                });

            } catch (dbError) {
                console.error('Error fetching stats:', dbError.message);
                await bot.editMessageText('Произошла ошибка при получении статистики. Попробуйте позже.', {
                    chat_id, message_id: msg.message_id
                });
            }
            return;
        }

        // --- Workout Plan Callbacks ---
        if (action === 'workout') {
            const subAction = params[0];
            const value = params[1];
            await bot.answerCallbackQuery(callbackQuery.id);

            const state = workoutPlanState[telegram_id];
            if (!state) {
                await bot.editMessageText('Сессия истекла. Пожалуйста, начните заново.', {
                    chat_id, message_id: msg.message_id
                });
                return;
            }

            if (state.step === 'ask_experience' && subAction === 'exp') {
                state.data = { ...state.data, experience: value };
                state.step = 'ask_goals';

                await bot.editMessageText('Какая ваша основная цель тренировок?', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Похудение и жиросжигание', callback_data: 'workout_goal_weightloss' }],
                            [{ text: 'Набор мышечной массы', callback_data: 'workout_goal_muscle' }],
                            [{ text: 'Поддержание формы', callback_data: 'workout_goal_maintain' }],
                            [{ text: 'Общее здоровье и фитнес', callback_data: 'workout_goal_health' }]
                        ]
                    }
                });
            } else if (state.step === 'ask_goals' && subAction === 'goal') {
                state.data = { ...state.data, goal: value };
                state.step = 'ask_priority_zones';

                await bot.editMessageText('Есть ли приоритетные зоны для проработки? (можно выбрать несколько)', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Спина', callback_data: 'workout_zone_back' }, { text: 'Грудь', callback_data: 'workout_zone_chest' }],
                            [{ text: 'Ноги', callback_data: 'workout_zone_legs' }, { text: 'Плечи', callback_data: 'workout_zone_shoulders' }],
                            [{ text: 'Кор/Пресс', callback_data: 'workout_zone_core' }, { text: 'Руки', callback_data: 'workout_zone_arms' }],
                            [{ text: 'Нет приоритетов', callback_data: 'workout_zone_none' }],
                            [{ text: '✅ Готово', callback_data: 'workout_zones_done' }]
                        ]
                    }
                });
                state.data.priority_zones = [];
            } else if (state.step === 'ask_priority_zones' && subAction === 'zone') {
                if (value === 'done' || data === 'workout_zones_done') {
                    state.step = 'ask_injuries';
                    await bot.editMessageText('Есть ли у вас травмы или заболевания, влияющие на тренировки?', {
                        chat_id, message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Нет травм', callback_data: 'workout_injury_none' }],
                                [{ text: 'Проблемы со спиной', callback_data: 'workout_injury_back' }],
                                [{ text: 'Проблемы с коленями', callback_data: 'workout_injury_knees' }],
                                [{ text: 'Другие травмы (напишу)', callback_data: 'workout_injury_custom' }]
                            ]
                        }
                    });
                } else if (value === 'none') {
                    state.data.priority_zones = ['none'];
                    // Переходим сразу к следующему шагу если выбрали "нет приоритетов"
                    state.step = 'ask_injuries';
                    await bot.editMessageText('Есть ли у вас травмы или заболевания, влияющие на тренировки?', {
                        chat_id, message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Нет травм', callback_data: 'workout_injury_none' }],
                                [{ text: 'Проблемы со спиной', callback_data: 'workout_injury_back' }],
                                [{ text: 'Проблемы с коленями', callback_data: 'workout_injury_knees' }],
                                [{ text: 'Другие травмы (напишу)', callback_data: 'workout_injury_custom' }]
                            ]
                        }
                    });
                } else {
                    // Переключаем выбранную зону
                    if (state.data.priority_zones.includes(value)) {
                        // Убираем если уже выбрана
                        state.data.priority_zones = state.data.priority_zones.filter(zone => zone !== value);
                    } else {
                        // Если выбираем конкретную зону, убираем "none"
                        if (value !== 'none' && state.data.priority_zones.includes('none')) {
                            state.data.priority_zones = state.data.priority_zones.filter(zone => zone !== 'none');
                        }
                        // Если выбираем "none", очищаем все остальные
                        if (value === 'none') {
                            state.data.priority_zones = [];
                        }
                        // Добавляем если не выбрана
                        state.data.priority_zones.push(value);
                    }

                    // Создаем кнопки с эмодзи для выбранных зон
                    const createZoneButton = (zoneName, zoneValue) => {
                        const isSelected = state.data.priority_zones.includes(zoneValue);
                        return { 
                            text: isSelected ? `✅ ${zoneName}` : zoneName, 
                            callback_data: `workout_zone_${zoneValue}` 
                        };
                    };

                    await bot.editMessageText('Есть ли приоритетные зоны для проработки? (можно выбрать несколько)', {
                        chat_id, message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                [createZoneButton('Спина', 'back'), createZoneButton('Грудь', 'chest')],
                                [createZoneButton('Ноги', 'legs'), createZoneButton('Плечи', 'shoulders')],
                                [createZoneButton('Кор/Пресс', 'core'), createZoneButton('Руки', 'arms')],
                                [createZoneButton('Нет приоритетов', 'none')],
                                [{ text: '✅ Готово', callback_data: 'workout_zones_done' }]
                            ]
                        }
                    });
                }
            } else if (state.step === 'ask_injuries' && subAction === 'injury') {
                if (value === 'custom') {
                    // Пользователь выбрал "другие травмы" - ожидаем текст
                    // Умная очистка для ввода травм (сохраняем только workoutPlanState)
                    closeConflictingStates(telegram_id, 'workout_injury_input');
                    workoutInjuryState[telegram_id] = { waiting: true };
                    await bot.editMessageText('Опишите ваши травмы или особенности здоровья:\n\n(например: "проблемы с плечом после травмы")', {
                        chat_id, message_id: msg.message_id,
                        reply_markup: null
                    });
                } else {
                    // Сохраняем выбранную травму и переходим к следующему шагу
                    state.data = { ...state.data, injuries: value };
                    state.step = 'ask_location';

                    await bot.editMessageText('Где вы планируете тренироваться?', {
                        chat_id, message_id: msg.message_id,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Дома', callback_data: 'workout_location_home' }],
                                [{ text: 'В зале', callback_data: 'workout_location_gym' }],
                                [{ text: 'На улице', callback_data: 'workout_location_outdoor' }]
                            ]
                        }
                    });
                }
            } else if (state.step === 'ask_location' && subAction === 'location') {
                state.data = { ...state.data, location: value };
                state.step = 'ask_frequency';

                await bot.editMessageText('Сколько тренировок в неделю вы готовы делать?', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '2 раза', callback_data: 'workout_freq_2' }],
                            [{ text: '3 раза', callback_data: 'workout_freq_3' }],
                            [{ text: '4 раза', callback_data: 'workout_freq_4' }],
                            [{ text: '5+ раз', callback_data: 'workout_freq_5' }]
                        ]
                    }
                });
            } else if (state.step === 'ask_frequency' && subAction === 'freq') {
                state.data = { ...state.data, frequency: parseInt(value) };
                state.step = 'ask_duration';

                await bot.editMessageText('Сколько минут вы можете уделять одной тренировке?', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '20-30 минут', callback_data: 'workout_duration_30' }],
                            [{ text: '45-60 минут', callback_data: 'workout_duration_60' }],
                            [{ text: '60-90 минут', callback_data: 'workout_duration_90' }]
                        ]
                    }
                });
            } else if (state.step === 'ask_duration' && subAction === 'duration') {
                state.data = { ...state.data, duration: parseInt(value) };
                state.step = 'generate_plan';

                // Генерируем план тренировок
                const loadingMessage = await bot.editMessageText('🤖 Создаю персональный план тренировок... Это может занять до 30 секунд.', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: null
                });

                try {
                    // Сохраняем данные в базу
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('id')
                        .eq('telegram_id', telegram_id)
                        .single();

                    const workoutData = {
                        user_id: profile.id,
                        experience: state.data.experience,
                        goal: state.data.goal,
                        priority_zones: state.data.priority_zones || ['none'],
                        injuries: state.data.injuries || 'none',
                        location: state.data.location,
                        frequency_per_week: state.data.frequency,
                        duration_minutes: state.data.duration,
                        preferred_types: ['mixed'] // пока оставим по умолчанию
                    };

                    // Сначала пытаемся обновить существующую запись
                    const { data: existingData } = await supabase
                        .from('workout_plan_data')
                        .select('user_id')
                        .eq('user_id', profile.id)
                        .single();

                    let saveError;
                    if (existingData) {
                        // Обновляем существующую запись
                        const { error } = await supabase
                            .from('workout_plan_data')
                            .update(workoutData)
                            .eq('user_id', profile.id);
                        saveError = error;
                    } else {
                        // Создаем новую запись
                        const { error } = await supabase
                            .from('workout_plan_data')
                            .insert(workoutData);
                        saveError = error;
                    }

                    if (saveError) throw saveError;

                    // Показываем индикатор печатания и обновляем статус
                    await bot.sendChatAction(chat_id, 'typing');
                    showTyping(chat_id, 25000);
                    
                    // Постепенное обновление прогресса
                    setTimeout(async () => {
                        try {
                            await bot.editMessageText(`🤖 Анализирую ваши предпочтения...`, {
                                chat_id, message_id: msg.message_id
                            });
                        } catch (e) { /* игнорируем ошибки обновления */ }
                    }, 2000);
                    
                    setTimeout(async () => {
                        try {
                            await bot.editMessageText(`🤖 Формирую персональный план тренировок...`, {
                                chat_id, message_id: msg.message_id
                            });
                        } catch (e) { /* игнорируем ошибки обновления */ }
                    }, 8000);
                    
                    setTimeout(async () => {
                        try {
                            await bot.editMessageText(`🤖 Добавляю последние штрихи... Почти готово!`, {
                                chat_id, message_id: msg.message_id
                            });
                        } catch (e) { /* игнорируем ошибки обновления */ }
                    }, 15000);

                    // 🔒 ПРОВЕРКА ЛИМИТОВ НА ПЛАНЫ ТРЕНИРОВОК
                    const workoutLimitCheck = await checkActionLimit(telegram_id, 'workout_plans');
                    if (!workoutLimitCheck.allowed) {
                        const subscription = await getUserSubscription(telegram_id);
                        let upgradeText = `🚫 **Лимит планов тренировок исчерпан!**\n\n`;
                        upgradeText += `📊 Использовано: ${workoutLimitCheck.used}/${workoutLimitCheck.limit} за ${workoutLimitCheck.period}\n\n`;
                        
                        if (subscription.tier === 'free' && !subscription.promo_expires_at) {
                            upgradeText += `🎁 **Попробуйте промо-период:**\n• Дополнительные планы тренировок\n• 3 дня бесплатно\n\n`;
                            upgradeText += `Или выберите тариф для безлимитного доступа! 🚀`;
                            
                            await bot.editMessageText(upgradeText, {
                                chat_id, message_id: msg.message_id,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '🎁 Активировать промо', callback_data: 'activate_promo' }],
                                        [{ text: '📋 Тарифы', callback_data: 'subscription_plans' }]
                                    ]
                                }
                            });
                        } else {
                            upgradeText += `Выберите подходящий тариф для продолжения! 🚀`;
                            await bot.editMessageText(upgradeText, {
                                chat_id, message_id: msg.message_id,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '📋 Посмотреть тарифы', callback_data: 'subscription_plans' }]
                                    ]
                                }
                            });
                        }
                        delete workoutPlanState[telegram_id];
                        return;
                    }
                    
                    // Генерируем план с OpenAI
                    const planResult = await generateWorkoutPlan(state.profileData, state.data);

                    if (planResult.success) {
                        // ✅ ИНКРЕМЕНТИРУЕМ СЧЕТЧИК ПЛАНОВ ТРЕНИРОВОК
                        await incrementUsage(telegram_id, 'workout_plans');
                        
                        // ✅ СОХРАНЯЕМ ЦЕЛЕВОЙ ВЕС И ВРЕМЯ В ПРОФИЛЬ
                        if (state.data.target_weight_kg && state.data.timeframe_months) {
                            await supabase
                                .from('profiles')
                                .update({
                                    target_weight_kg: state.data.target_weight_kg,
                                    timeframe_months: state.data.timeframe_months
                                })
                                .eq('telegram_id', telegram_id);
                        }
                        
                        // Отправляем красивый HTML-документ
                        const currentDate = new Date().toLocaleDateString('ru-RU').replace(/\./g, '_');
                        const htmlContent = generateWorkoutPlanHTML(planResult.plan, state.profileData, state.data);
                        const filename = `План_тренировок_${state.profileData.first_name}_${currentDate}.html`;
                        
                        await bot.deleteMessage(chat_id, msg.message_id);
                        await sendPlanAsDocument(chat_id, 'workout', htmlContent, filename);
                    } else {
                        await bot.editMessageText(`❌ Произошла ошибка при создании плана: ${planResult.error}`, {
                            chat_id, message_id: msg.message_id
                        });
                    }

                } catch (error) {
                    console.error('Error generating workout plan:', error);
                    await bot.editMessageText('❌ Произошла ошибка при создании плана. Попробуйте позже.', {
                        chat_id, message_id: msg.message_id
                    });
                }

                // Очищаем состояние
                delete workoutPlanState[telegram_id];
           }
            return;
        }

        // --- Nutrition Plan Callbacks ---
        if (action === 'nutrition') {
            const subAction = params[0];
            const value = params[1];
            await bot.answerCallbackQuery(callbackQuery.id);

            const state = nutritionPlanState[telegram_id];
            if (!state) {
                await bot.editMessageText('Сессия истекла. Пожалуйста, начните заново.', {
                    chat_id, message_id: msg.message_id
                });
                return;
            }

            if (state.step === 'ask_activity' && subAction === 'activity') {
                state.data = { ...state.data, activity: value };
                state.step = 'ask_preferences';

                await bot.editMessageText('Теперь расскажите о ваших пищевых предпочтениях:', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Обычное питание', callback_data: 'nutrition_pref_regular' }],
                            [{ text: 'Вегетарианство', callback_data: 'nutrition_pref_vegetarian' }],
                            [{ text: 'Веганство', callback_data: 'nutrition_pref_vegan' }],
                            [{ text: 'Кето-диета', callback_data: 'nutrition_pref_keto' }]
                        ]
                    }
                });
            } else if (state.step === 'ask_preferences' && subAction === 'pref') {
                state.data = { ...state.data, preferences: value };
                state.step = 'ask_allergies';

                await bot.editMessageText('Есть ли у вас пищевые аллергии или непереносимости?', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Нет аллергий', callback_data: 'nutrition_allergy_none' }],
                            [{ text: 'Лактоза', callback_data: 'nutrition_allergy_lactose' }],
                            [{ text: 'Глютен', callback_data: 'nutrition_allergy_gluten' }],
                            [{ text: 'Орехи', callback_data: 'nutrition_allergy_nuts' }],
                            [{ text: 'Другое (напишу сам)', callback_data: 'nutrition_allergy_custom' }]
                        ]
                    }
                });
            } else if (state.step === 'ask_allergies' && subAction === 'allergy') {
                state.data = { ...state.data, allergies: value };
                state.step = 'ask_meals_count';

                await bot.editMessageText('Сколько приёмов пищи в день вам комфортно?', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '3 основных приёма', callback_data: 'nutrition_meals_three' }],
                            [{ text: '5-6 маленьких приёмов', callback_data: 'nutrition_meals_five' }]
                        ]
                    }
                });
            } else if (state.step === 'ask_meals_count' && subAction === 'meals') {
                state.data = { ...state.data, mealsCount: value };
                state.step = 'generate_plan';

                // Генерируем план питания
                await bot.sendChatAction(chat_id, 'typing');
                showTyping(chat_id, 25000);
                
                const loadingMessage = await bot.editMessageText('🤖 Подготавливаю ваш план питания...', {
                    chat_id, message_id: msg.message_id,
                    reply_markup: null
                });

                try {
                    // Сохраняем данные в базу
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('id')
                        .eq('telegram_id', telegram_id)
                        .single();

                    const nutritionData = {
                        user_id: profile.id,
                        activity_level: state.data.activity,
                        calorie_goal: state.profileData.goal, // используем цель из профиля
                        allergies: [state.data.allergies],
                        diet_type: state.data.preferences,
                        meals_per_day: state.data.mealsCount,
                        product_limitations: 'none',
                        supplements_interest: 'no' // пока по умолчанию
                    };

                    // Сначала пытаемся обновить существующую запись
                    const { data: existingData } = await supabase
                        .from('nutrition_plan_data')
                        .select('user_id')
                        .eq('user_id', profile.id)
                        .single();

                    let saveError;
                    if (existingData) {
                        // Обновляем существующую запись
                        const { error } = await supabase
                            .from('nutrition_plan_data')
                            .update(nutritionData)
                            .eq('user_id', profile.id);
                        saveError = error;
                    } else {
                        // Создаем новую запись
                        const { error } = await supabase
                            .from('nutrition_plan_data')
                            .insert(nutritionData);
                        saveError = error;
                    }

                    if (saveError) throw saveError;

                    // Постепенное обновление прогресса
                    setTimeout(async () => {
                        try {
                            await bot.editMessageText(`🤖 Рассчитываю калории и нутриенты...`, {
                                chat_id, message_id: loadingMessage.message_id
                            });
                        } catch (e) { /* игнорируем ошибки обновления */ }
                    }, 3000);
                    
                    setTimeout(async () => {
                        try {
                            await bot.editMessageText(`🤖 Подбираю блюда под ваши предпочтения...`, {
                                chat_id, message_id: loadingMessage.message_id
                            });
                        } catch (e) { /* игнорируем ошибки обновления */ }
                    }, 8000);
                    
                    setTimeout(async () => {
                        try {
                            await bot.editMessageText(`🤖 Составляю недельное меню... Почти готово!`, {
                                chat_id, message_id: loadingMessage.message_id
                            });
                        } catch (e) { /* игнорируем ошибки обновления */ }
                    }, 15000);

                    // 🔒 ПРОВЕРКА ЛИМИТОВ НА ПЛАНЫ ПИТАНИЯ
                    const nutritionLimitCheck = await checkActionLimit(telegram_id, 'nutrition_plans');
                    if (!nutritionLimitCheck.allowed) {
                        const subscription = await getUserSubscription(telegram_id);
                        let upgradeText = `🚫 **Лимит планов питания исчерпан!**\n\n`;
                        upgradeText += `📊 Использовано: ${nutritionLimitCheck.used}/${nutritionLimitCheck.limit} за ${nutritionLimitCheck.period}\n\n`;
                        upgradeText += `🍽️ Планы питания доступны в тарифах ПРОГРЕСС и МАКСИМУМ!\n\n`;
                        upgradeText += `Выберите подходящий тариф для продолжения! 🚀`;
                        
                        await bot.editMessageText(upgradeText, {
                            chat_id, message_id: loadingMessage.message_id,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📋 Посмотреть тарифы', callback_data: 'subscription_plans' }]
                                ]
                            }
                        });
                        delete nutritionPlanState[telegram_id];
                        return;
                    }
                    
                    // Добавляем целевой вес и время в данные профиля для плана питания
                    const enrichedProfileData = {
                        ...state.profileData,
                        target_weight_kg: state.data.target_weight_kg || state.profileData.target_weight_kg,
                        timeframe_months: state.data.timeframe_months || state.profileData.timeframe_months
                    };
                    
                    // Генерируем план с OpenAI
                    const planResult = await generateNutritionPlan(enrichedProfileData, state.data);

                    if (planResult.success) {
                        // ✅ ИНКРЕМЕНТИРУЕМ СЧЕТЧИК ПЛАНОВ ПИТАНИЯ
                        await incrementUsage(telegram_id, 'nutrition_plans');
                        
                        // Отправляем красивый HTML-документ
                        const currentDate = new Date().toLocaleDateString('ru-RU').replace(/\./g, '_');
                        const htmlContent = generateNutritionPlanHTML(planResult.plan, state.profileData, state.data);
                        const filename = `План_питания_${state.profileData.first_name}_${currentDate}.html`;
                        
                        await bot.deleteMessage(chat_id, msg.message_id);
                        await sendPlanAsDocument(chat_id, 'nutrition', htmlContent, filename);
                    } else {
                        await bot.editMessageText(`❌ Произошла ошибка при создании плана: ${planResult.error}`, {
                            chat_id, message_id: msg.message_id
                        });
                    }

                } catch (error) {
                    console.error('Error generating nutrition plan:', error);
                    await bot.editMessageText('❌ Произошла ошибка при создании плана. Попробуйте позже.', {
                        chat_id, message_id: msg.message_id
                    });
                }

                // Очищаем состояние
                delete nutritionPlanState[telegram_id];
            }
            return;
        }

        // --- Profile Edit Callbacks ---
        if (data.startsWith('profile_')) {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            const parts = data.split('_');
            const action = parts[1];
            const field = parts.slice(2).join('_');
            
            if (action === 'edit') {
                // Инициализируем редактирование поля
                profileEditState[telegram_id] = { field: field };
                
                let fieldName = '';
                let question = '';
                let keyboard = null;
                
                switch (field) {
                    case 'name':
                        fieldName = 'имя';
                        question = 'Введите ваше имя:';
                        break;
                    case 'age':
                        fieldName = 'возраст';
                        question = 'Введите ваш возраст (в годах):';
                        break;
                    case 'height':
                        fieldName = 'рост';
                        question = 'Введите ваш рост (в см):';
                        break;
                    case 'weight':
                        fieldName = 'вес';
                        question = 'Введите ваш текущий вес (в кг):';
                        break;
                    case 'target_weight':
                        fieldName = 'целевой вес';
                        question = 'Введите ваш целевой вес (в кг):';
                        break;
                    case 'timeframe':
                        fieldName = 'срок достижения цели';
                        question = 'Введите срок достижения цели (в месяцах):';
                        break;
                    case 'goal':
                        fieldName = 'цель';
                        question = 'Выберите вашу цель:';
                        keyboard = {
                            inline_keyboard: [
                                [{ text: '📉 Похудеть', callback_data: 'profile_update_goal_lose_weight' }],
                                [{ text: '📈 Набрать массу', callback_data: 'profile_update_goal_gain_mass' }],
                                [{ text: '⚖️ Поддерживать вес', callback_data: 'profile_update_goal_maintain' }]
                            ]
                        };
                        break;
                    case 'gender':
                        fieldName = 'пол';
                        question = 'Выберите ваш пол:';
                        keyboard = {
                            inline_keyboard: [
                                [{ text: '👨 Мужской', callback_data: 'profile_update_gender_male' }],
                                [{ text: '👩 Женский', callback_data: 'profile_update_gender_female' }]
                            ]
                        };
                        break;
                }
                
                await bot.editMessageText(`Изменение: ${fieldName}\n\n${question}`, {
                    chat_id, message_id: msg.message_id,
                    reply_markup: keyboard
                });
                
            } else if (action === 'update') {
                // Этот блок обрабатывает нажатия на кнопки (Пол, Цель)
                const fieldToUpdate = parts[2]; // e.g., 'goal'
                const valueToSave = parts.slice(3).join('_'); // e.g., 'lose_weight'

                let updatePayload = {};
                let fieldNameForMessage = '';
                let displayValue = '';

                if (fieldToUpdate === 'goal') {
                    updatePayload.goal = valueToSave;
                    fieldNameForMessage = 'Цель';
                    displayValue = valueToSave === 'lose_weight' ? 'Похудеть' :
                                 valueToSave === 'gain_mass' ? 'Набор массы' : 'Поддерживать вес';
                } else if (fieldToUpdate === 'gender') {
                    updatePayload.gender = valueToSave;
                    fieldNameForMessage = 'Пол';
                    displayValue = valueToSave === 'male' ? 'Мужской' : 'Женский';
                } else {
                    await bot.editMessageText('❌ Неизвестное действие. Попробуйте снова.', {
                        chat_id, message_id: msg.message_id
                    });
                    return;
                }
                
                try {
                    const { error } = await supabase
                        .from('profiles')
                        .update(updatePayload)
                        .eq('telegram_id', telegram_id);
                    
                    if (error) throw error;
                    
                    // Пересчитываем нормы, так как изменились важные параметры
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('*')
                        .eq('telegram_id', telegram_id)
                        .single();
                    
                    if (profile) {
                        await calculateAndSaveNorms(profile);
                    }
                    
                    await bot.editMessageText(`✅ ${fieldNameForMessage} успешно изменена на: ${displayValue}\n\nВозвращаюсь в профиль...`, {
                        chat_id, message_id: msg.message_id,
                    });
                    
                    // Показываем обновленный профиль через 2 секунды
                    setTimeout(() => {
                        showProfileMenu(chat_id, telegram_id);
                    }, 2000);
                    
                } catch (error) {
                    console.error('Error updating profile:', error);
                    await bot.editMessageText('❌ Ошибка при обновлении профиля. Попробуйте позже.', {
                        chat_id, message_id: msg.message_id
                    });
                }
                
            } else if (action === 'recalculate') {
                // Пересчитываем нормы
                try {
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('*')
                        .eq('telegram_id', telegram_id)
                        .single();
                    
                    if (profile) {
                        await calculateAndSaveNorms(profile);
                        await bot.editMessageText('✅ Дневные нормы пересчитаны!\n\nВозвращаюсь в профиль...', {
                            chat_id, message_id: msg.message_id
                        });
                        
                        // Показываем обновленный профиль через 2 секунды
                        setTimeout(() => {
                            showProfileMenu(chat_id, telegram_id);
                        }, 2000);
                    } else {
                        await bot.editMessageText('❌ Ошибка при получении профиля.', {
                            chat_id, message_id: msg.message_id
                        });
                    }
                } catch (error) {
                    console.error('Error recalculating norms:', error);
                    await bot.editMessageText('❌ Ошибка при пересчете норм.', {
                        chat_id, message_id: msg.message_id
                    });
                }
            }
            return;
        }

        // --- SUBSCRIPTION CALLBACKS ---
        if (data === 'activate_promo') {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            const subscription = await getUserSubscription(telegram_id);
            if (subscription.promo_activated_at) {
                await bot.editMessageText('🎁 Промо-период уже был активирован ранее!', {
                    chat_id, message_id: msg.message_id
                });
                return;
            }
            
            const result = await activatePromo(telegram_id);
            if (result.success) {
                const expiresDate = result.new_promo_expires_at.toLocaleDateString('ru-RU');
                await bot.editMessageText(`🎉 *Промо-период активирован!*\n\nТеперь у вас есть доступ к расширенным возможностям до ${expiresDate}:\n\n• 15 анализов фото в день\n• 20 вопросов к ИИ в день\n• Все функции тарифа СТАРТ\n\nИспользуйте команду /subscription для просмотра статуса!`, {
                    chat_id, message_id: msg.message_id,
                    parse_mode: 'Markdown'
                });
            } else {
                await bot.editMessageText('❌ Не удалось активировать промо-период. Попробуйте позже.', {
                    chat_id, message_id: msg.message_id
                });
            }
            return;
        }

        if (data === 'subscribe_progress' || data === 'subscribe_maximum') {
            await bot.answerCallbackQuery(callbackQuery.id);
            
            const tierName = data === 'subscribe_progress' ? 'ПРОГРЕСС' : 'МАКСИМУМ';
            const price = data === 'subscribe_progress' ? '199 ₽/мес' : '349 ₽/мес';
            
            await bot.editMessageText(`🚀 *Тариф "${tierName}" (${price})*\n\nДля оформления подписки обратитесь к администратору: @admin\n\nОн поможет вам:\n• Оформить подписку\n• Настроить автоплатеж\n• Ответить на любые вопросы\n\nПосле оплаты ваш тариф будет активирован автоматически! 🎯`, {
                chat_id, message_id: msg.message_id,
                parse_mode: 'Markdown'
            });
            return;
        }

    });
    return bot;
};

// --- CRON JOBS TEMPORARILY DISABLED FOR DEBUGGING ---
console.log('All cron jobs temporarily disabled for debugging');

module.exports = { setupBot }; 