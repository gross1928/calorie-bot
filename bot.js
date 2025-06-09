const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./supabaseClient');
const OpenAI = require('openai');
const crypto = require('crypto');

require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!token || !openaiApiKey) {
    throw new Error('Telegram Bot Token or OpenAI API Key is not defined in .env file');
}

const bot = new TelegramBot(token);
const openai = new OpenAI({ apiKey: openaiApiKey });

// In-memory states
const registrationState = {};
const manualAddState = {};
const mealConfirmationCache = {};

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

        const activityFactor = 1.2;
        let daily_calories = bmr * activityFactor;

        switch (goal) {
            case 'lose_weight':
                daily_calories *= 0.85; // 15% deficit
                break;
            case 'gain_mass':
                daily_calories *= 1.15; // 15% surplus
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
    console.log(`Sending text to OpenAI for recognition: "${inputText}"`);
    try {
        const response = await openai.chat.completions.create({
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
        });

        const content = response.choices[0].message.content;
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedContent = JSON.parse(jsonString);

        if (parsedContent.dish_name === 'не еда') {
            return { success: false, reason: 'Не удалось распознать еду в вашем описании.' };
        }

        return { success: true, data: parsedContent };

    } catch (error) {
        console.error('Error with OpenAI API (text recognition):', error);
        return { success: false, reason: 'Произошла ошибка при анализе вашего описания.' };
    }
};

const recognizeFoodFromPhoto = async (photoUrl) => {
    console.log('Sending image to OpenAI for recognition...');
    try {
        const response = await openai.chat.completions.create({
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
        });

        const content = response.choices[0].message.content;
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedContent = JSON.parse(jsonString);

        if (parsedContent.dish_name === 'не еда') {
            return { success: false, reason: 'На фото не удалось распознать еду.' };
        }

        return { success: true, data: parsedContent };

    } catch (error) {
        console.error('Error with OpenAI API:', error);
        return { success: false, reason: 'Произошла ошибка при анализе изображения.' };
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
                    [{ text: '✍️ Добавить вручную' }, { text: '📊 Статистика' }]
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

    // --- Message Handler ---
    bot.on('message', async (msg) => {
        if (msg.text && msg.text.startsWith('/')) return;

        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;

        // --- Keyboard Button Handling ---
        if (msg.text === '📸 Добавить по фото') {
            bot.sendMessage(chat_id, 'Присылайте фото вашей еды.');
            return;
        }
        if (msg.text === '✍️ Добавить вручную') {
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

        // --- Photo Handler ---
        if (msg.photo) {
            const thinkingMessage = await bot.sendMessage(chat_id, 'Получил ваше фото! 📸 Анализирую с помощью ИИ, это может занять несколько секунд...');
            try {
                const photo = msg.photo[msg.photo.length - 1];
                const fileInfo = await bot.getFile(photo.file_id);
                const photoUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                
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
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Да, сохранить', callback_data }, { text: '❌ Нет, отменить', callback_data: cancel_callback_data }]
                            ]
                        }
                    });
                } else {
                     await bot.editMessageText(`😕 ${recognitionResult.reason}`, {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке фото:", error);
                await bot.editMessageText('Произошла внутренняя ошибка. Не удалось обработать фото.', {
                    chat_id: thinkingMessage.chat.id,
                    message_id: thinkingMessage.message_id
                });
            }
            return;
        }

        // --- State-based Input Handlers ---
        const registrationStep = registrationState[telegram_id]?.step;
        const manualAddStep = manualAddState[telegram_id]?.step;

        if (manualAddStep === 'awaiting_input') {
            delete manualAddState[telegram_id];
            const thinkingMessage = await bot.sendMessage(chat_id, 'Получил ваш запрос! ✍️ Анализирую с помощью ИИ, это может занять несколько секунд...');
            try {
                const parts = msg.text.split(',').map(p => p.trim());
                const description = parts[0];
                const weight = parseInt(parts[1], 10);
                if (parts.length !== 2 || !description || isNaN(weight) || weight <= 0) {
                     await bot.editMessageText('Неверный формат. Пожалуйста, введите данные в формате: `Название, Граммы`.\n\nНапример: `Гречка с курицей, 150`', {
                        chat_id: thinkingMessage.chat.id, message_id: thinkingMessage.message_id, parse_mode: 'Markdown'
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

                    await bot.editMessageText(responseText, {
                        chat_id: thinkingMessage.chat.id, message_id: thinkingMessage.message_id, parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Да, сохранить', callback_data }, { text: '❌ Нет, отменить', callback_data: cancel_callback_data }]
                            ]
                        }
                    });
                } else {
                     await bot.editMessageText(`😕 ${recognitionResult.reason}`, {
                        chat_id: thinkingMessage.chat.id, message_id: thinkingMessage.message_id
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке ручного ввода:", error);
                await bot.editMessageText('Произошла внутренняя ошибка. Не удалось обработать ваш запрос.', {
                    chat_id: thinkingMessage.chat.id, message_id: thinkingMessage.message_id
                });
            }
            return;
        }

        if (registrationStep) {
            const state = registrationState[telegram_id];
            switch (registrationStep) {
                case 'ask_name':
                    const { data: existingProfile } = await supabase.from('profiles').select('telegram_id').eq('telegram_id', telegram_id).single();
                    if (existingProfile) {
                        console.warn(`User ${telegram_id} already exists but tried to register again. Aborting.`);
                        delete registrationState[telegram_id];
                        showMainMenu(chat_id, 'Кажется, ты уже зарегистрирован. Вот твое главное меню:');
                        return;
                    }
                    state.data.first_name = msg.text;
                    state.step = 'ask_gender';
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
                    const age = parseInt(msg.text, 10);
                    if (isNaN(age) || age < 10 || age > 100) {
                        bot.sendMessage(chat_id, 'Пожалуйста, введи корректный возраст (от 10 до 100).'); return;
                    }
                    state.data.age = age;
                    state.step = 'ask_height';
                    bot.sendMessage(chat_id, 'Понял. Какой у тебя рост в сантиметрах?');
                    break;
                case 'ask_height':
                    const height = parseInt(msg.text, 10);
                    if (isNaN(height) || height < 100 || height > 250) {
                        bot.sendMessage(chat_id, 'Пожалуйста, введи корректный рост (от 100 до 250 см).'); return;
                    }
                    state.data.height_cm = height;
                    state.step = 'ask_weight';
                    bot.sendMessage(chat_id, 'И вес в килограммах? (Можно дробное число, например, 65.5)');
                    break;
                case 'ask_weight':
                    const weight = parseFloat(msg.text.replace(',', '.'));
                     if (isNaN(weight) || weight <= 20 || weight > 300) {
                         bot.sendMessage(chat_id, 'Пожалуйста, введи корректный вес (например, 75.5).'); return;
                    }
                    state.data.weight_kg = weight;
                    state.step = 'ask_goal';
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
    });

    // --- Callback Query Handler ---
    bot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const telegram_id = callbackQuery.from.id;
        const chat_id = msg.chat.id;
        const data = callbackQuery.data;

        const [action, ...params] = data.split('_');
        
        console.log(`>>> CALLBACK: User: ${telegram_id}, Data: ${data}, Action: ${action}, Params: ${params}`);
        
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

            try {
                console.log(`=== STATS DEBUG ===`);
                console.log(`Пользователь telegram_id: ${telegram_id}`);
                console.log(`Период: ${period}`);

                const { data: profile, error: profileError } = await supabase
                    .from('profiles')
                    .select('id, first_name, daily_calories, daily_protein, daily_fat, daily_carbs')
                    .eq('telegram_id', telegram_id)
                    .single();

                console.log(`Профиль пользователя:`, profile);
                console.log(`Ошибка профиля:`, profileError);

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

                console.log(`Profile ID для поиска еды: ${profile.id}`);

                // ПРОСТОЙ запрос: получаем ВСЕ записи пользователя
                const { data: allMeals, error: mealsError } = await supabase
                    .from('meals')
                    .select('*')
                    .eq('user_id', profile.id)
                    .order('eaten_at', { ascending: false });

                console.log(`Ошибка получения еды:`, mealsError);
                console.log(`Всего записей в БД для user_id ${profile.id}:`, allMeals ? allMeals.length : 0);
                
                if (allMeals && allMeals.length > 0) {
                    console.log(`Первые 3 записи:`, allMeals.slice(0, 3));
                }

                if (mealsError) throw mealsError;

                // Упрощенная фильтрация для "сегодня"
                let meals = allMeals || [];
                if (period === 'today' && meals.length > 0) {
                    const now = new Date();
                    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
                    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
                    
                    console.log(`Фильтрация за сегодня: ${todayStart.toISOString()} - ${todayEnd.toISOString()}`);
                    
                    meals = allMeals.filter(meal => {
                        const mealDate = new Date(meal.eaten_at);
                        const isToday = mealDate >= todayStart && mealDate <= todayEnd;
                        if (isToday) {
                            console.log(`Найдена еда за сегодня: ${meal.description} - ${meal.eaten_at}`);
                        }
                        return isToday;
                    });
                    
                    console.log(`Записей за сегодня: ${meals.length}`);
                } else if (period === 'week' && meals.length > 0) {
                    const now = new Date();
                    const weekStart = new Date(now);
                    weekStart.setDate(now.getDate() - 7);
                    
                    meals = allMeals.filter(meal => new Date(meal.eaten_at) >= weekStart);
                    console.log(`Записей за неделю: ${meals.length}`);
                } else if (period === 'month' && meals.length > 0) {
                    const now = new Date();
                    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                    
                    meals = allMeals.filter(meal => new Date(meal.eaten_at) >= monthStart);
                    console.log(`Записей за месяц: ${meals.length}`);
                }

                console.log(`Итого найдено записей для периода ${period}: ${meals.length}`);

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
                    const createProgressBar = (consumed, norm) => {
                        if (!norm) return '';
                        const percentage = Math.min(100, (consumed / norm) * 100);
                        const filledBlocks = Math.round(percentage / 10);
                        const emptyBlocks = 10 - filledBlocks;
                        return `[${'■'.repeat(filledBlocks)}${'□'.repeat(emptyBlocks)}] ${percentage.toFixed(0)}%`;
                    };

                    const { daily_calories, daily_protein, daily_fat, daily_carbs } = profile;
                    
                    let dailyAverageText = '';
                    if (period !== 'today') {
                         const dayDifference = (new Date().getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
                         const daysInPeriod = Math.max(1, Math.ceil(dayDifference));
                         const avgCalories = totals.calories / daysInPeriod;
                         dailyAverageText = `📈 Среднесуточно: *${avgCalories.toFixed(0)} ккал/день*\n\n`;
                    }

                    statsText = `*Статистика за ${periodText}, ${profile.first_name}:*\n\n` +
                                `🔥 Калории: *${formatLine(totals.calories, daily_calories)}ккал*\n` +
                                `${createProgressBar(totals.calories, daily_calories)}\n\n` +
                                (period === 'today' ? '' : dailyAverageText) +
                                `*Общее количество БЖУ:*\n` +
                                `🥩 Белки: ${formatLine(totals.protein, daily_protein)}г\n` +
                                `🥑 Жиры: ${formatLine(totals.fat, daily_fat)}г\n` +
                                `🍞 Углеводы: ${formatLine(totals.carbs, daily_carbs)}г`;
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

    });
    return bot;
};

module.exports = { setupBot };