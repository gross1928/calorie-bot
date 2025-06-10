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

// Состояние для ожидания вопросов от пользователя
const questionState = {};

// Состояние для анализа медицинских данных
const medicalAnalysisState = {};

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

const getUserProfile = async (userId) => {
    const { data, error } = await withDatabaseErrorHandling(() => 
        supabase.from('profiles').select('*').eq('id', userId).single()
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

        const response = await withTimeout(
            openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'Ты профессиональный персональный тренер с 15-летним опытом. Создаешь безопасные и эффективные программы тренировок.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: 1500,
                temperature: 0.7
            }),
            15000
        );

        return response.choices[0].message.content;
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
            // ... existing code ...
        } else if (msg.text) {
            // ... existing code ...
        } else if (msg.callback_query) {
            const callbackQuery = msg.callback_query;
            if (callbackQuery.data.startsWith('get_workout_plan_')) {
                const [_, goal, gender, experience] = callbackQuery.data.split('_');
                
                // Получаем профиль пользователя
                const userProfile = await getUserProfile(chatId);
                
                // Показываем индикатор загрузки
                await showTyping(chatId, 8000);
                await bot.sendMessage(chatId, '🤖 Анализирую ваш профиль и составляю персональную программу тренировок...');
                
                // Генерируем персональную программу с помощью ИИ
                const personalizedPlan = await generatePersonalizedWorkoutPlan(userProfile, goal, experience);
                
                await smartSendMessage(chatId, personalizedPlan, { parse_mode: 'Markdown' });
            }
        }
    } catch (error) {
        logEvent('error', `Callback query processing error for data: ${callbackQuery.data}`, {
            error: error.toString(),
            stack: error.stack
        });
    }
});
