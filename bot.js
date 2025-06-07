const TelegramBot = require('node-telegram-bot-api');
const supabase = require('./supabaseClient');
const OpenAI = require('openai');

require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!token || !openaiApiKey) {
    throw new Error('Telegram Bot Token or OpenAI API Key is not defined in .env file');
}

const bot = new TelegramBot(token);
const openai = new OpenAI({ apiKey: openaiApiKey });

// In-memory state for registration process
// { telegram_id: { step: 'ask_gender', data: { name: 'John' } } }
const registrationState = {};
const manualAddState = {};

// --- OpenAI Image Recognition ---
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
  "carbs": "углеводы в граммах (число)",
  "reasoning": "Краткое пояснение, как ты пришел к такому выводу на русском языке"
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
        // Sometimes the model might return the JSON inside a code block
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
        throw new Error('SERVER_URL is not defined in .env file');
    }
    const webhookPath = `/api/telegram-webhook`;
    bot.setWebHook(`${url}${webhookPath}`);

    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

    console.log('Telegram bot webhook is set up.');

    // --- Command Handlers ---

    bot.onText(/\/start/, async (msg) => {
        const { id: telegram_id, username, first_name, last_name } = msg.from;
        const chat_id = msg.chat.id;

        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('telegram_id')
                .eq('telegram_id', telegram_id)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 = 'Not a single row was found'
                throw error;
            }

            if (data) {
                // User exists
                bot.sendMessage(chat_id, `С возвращением, ${first_name}! Чем могу помочь?`, {
                    reply_markup: {
                        inline_keyboard: [
                             [{ text: '📸 Распознать еду по фото', callback_data: 'photo_food' }],
                             [{ text: '✍️ Добавить еду вручную', callback_data: 'add_manual' }]
                        ]
                    }
                });
            } else {
                // New user - start registration
                registrationState[telegram_id] = { step: 'ask_name', data: { telegram_id, username, first_name, last_name, chat_id } };
                bot.sendMessage(chat_id, 'Привет! 👋 Я твой личный помощник по подсчёту калорий. Давай для начала зарегистрируемся. Как тебя зовут?');
            }
        } catch (dbError) {
            console.error('Error checking user profile:', dbError.message);
            bot.sendMessage(chat_id, 'Произошла ошибка при проверке вашего профиля. Пожалуйста, попробуйте позже.');
        }
    });

    bot.onText(/\/photo/, (msg) => {
        bot.sendMessage(msg.chat.id, 'Пожалуйста, отправьте мне фотографию вашей еды, и я постараюсь её распознать.');
    });

    // --- Message Handler for Registration & Photos ---

    bot.on('message', async (msg) => {
        const telegram_id = msg.from.id;
        const chat_id = msg.chat.id;

        // Photo handler
        if (msg.photo) {
            const thinkingMessage = await bot.sendMessage(chat_id, 'Получил ваше фото! 📸 Анализирую с помощью ИИ, это может занять несколько секунд...');

            try {
                // Get the highest resolution photo
                const photo = msg.photo[msg.photo.length - 1];
                const fileInfo = await bot.getFile(photo.file_id);
                const photoUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.filePath}`;
                
                const recognitionResult = await recognizeFoodFromPhoto(photoUrl);

                if (recognitionResult.success) {
                    const { dish_name, calories, protein, fat, carbs, ingredients, weight_g, reasoning } = recognitionResult.data;
                    
                    // Prepare data for callback query. It has a 64-byte limit.
                    // We can't pass all the data. We'll pass the essentials and re-use the text from the message.
                    const callback_data = `meal_save_photo_${calories}_${protein}_${fat}_${carbs}_${weight_g}`;
                    const ingredientsString = ingredients.join(', ');

                    const responseText = `*${dish_name}* (Примерно ${weight_g} г)

*Ингредиенты:* ${ingredientsString}
*КБЖУ:*
- Калории: ${calories} ккал
- Белки: ${protein} г
- Жиры: ${fat} г
- Углеводы: ${carbs} г

*Комментарий ИИ:* _${reasoning}_

Сохранить этот приём пищи?`;

                    await bot.editMessageText(responseText, {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                     { text: '✅ Да, сохранить', callback_data },
                                     { text: '❌ Нет, отменить', callback_data: 'meal_cancel' }
                                ]
                            ]
                        }
                    });

                } else {
                    await bot.editMessageText(`К сожалению, не удалось распознать блюдо. Причина: ${recognitionResult.reason}`, {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id
                    });
                }
            } catch (error) {
                console.error('Error processing photo:', error);
                 await bot.editMessageText('Произошла критическая ошибка при обработке вашего фото. Пожалуйста, попробуйте еще раз.', {
                    chat_id: thinkingMessage.chat.id,
                    message_id: thinkingMessage.message_id
                });
            }
            return; // Stop further processing
        }

        // Check if the user is in the middle of registration
        if (registrationState[telegram_id] && !msg.text.startsWith('/')) {
            const state = registrationState[telegram_id];
            const text = msg.text;

            switch (state.step) {
                case 'ask_name':
                    state.data.name = text;
                    state.step = 'ask_gender';
                    bot.sendMessage(chat_id, 'Приятно познакомиться! Теперь укажи свой пол.', {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Мужской 👨', callback_data: 'register_gender_male' }],
                                [{ text: 'Женский 👩', callback_data: 'register_gender_female' }]
                            ]
                        }
                    });
                    break;
                case 'ask_age':
                    const age = parseInt(text, 10);
                    if (isNaN(age) || age < 10 || age > 100) {
                        bot.sendMessage(chat_id, 'Пожалуйста, введите корректный возраст (от 10 до 100 лет).');
                        return;
                    }
                    state.data.age = age;
                    state.step = 'ask_height';
                    bot.sendMessage(chat_id, 'Принято. Какой у тебя рост в сантиметрах?');
                    break;
                case 'ask_height':
                    const height = parseInt(text, 10);
                    if (isNaN(height) || height < 100 || height > 250) {
                        bot.sendMessage(chat_id, 'Пожалуйста, введите корректный рост (от 100 до 250 см).');
                        return;
                    }
                    state.data.height_cm = height;
                    state.step = 'ask_weight';
                    bot.sendMessage(chat_id, 'Супер. И последний шаг: твой текущий вес в килограммах?');
                    break;
                case 'ask_weight':
                    const weight = parseFloat(text.replace(',', '.'));
                    if (isNaN(weight) || weight < 30 || weight > 200) {
                        bot.sendMessage(chat_id, 'Пожалуйста, введите корректный вес (от 30 до 200 кг).');
                        return;
                    }
                    state.data.weight_kg = weight;
                    state.step = 'ask_goal';
                     bot.sendMessage(chat_id, 'Отлично! Какая у тебя основная цель?', {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Сбросить вес', callback_data: 'register_goal_lose_weight' }],
                                [{ text: 'Поддерживать вес', callback_data: 'register_goal_maintain_weight' }],
                                [{ text: 'Набрать массу', callback_data: 'register_goal_gain_mass' }]
                            ]
                        }
                    });
                    break;
            }
        }
    });

    // --- Callback Query Handler for Registration & Meals ---

    bot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const telegram_id = callbackQuery.from.id;
        const chat_id = msg.chat.id;
        const [action, subject, ...params] = callbackQuery.data.split('_');
        
        if (action === 'meal') {
            await bot.answerCallbackQuery(callbackQuery.id);
            if (subject === 'save' && params[0] === 'photo') {
                const [calories, protein, fat, carbs, weight_g] = params.slice(1);
                
                // Extracting dish_name and ingredients from the message text itself to overcome callback_data limit
                const messageText = msg.text;
                const dish_name = messageText.match(/^\*(.*?)\*/)[1];
                const ingredientsMatch = messageText.match(/\*Ингредиенты:\* (.*?)\n/);
                const ingredients = ingredientsMatch ? ingredientsMatch[1].split(', ') : [];

                try {
                    // 1. Get user's internal ID from profiles table
                    const { data: profile, error: profileError } = await supabase
                        .from('profiles')
                        .select('id')
                        .eq('telegram_id', telegram_id)
                        .single();
                    
                    if (profileError || !profile) throw new Error('User profile not found.');

                    // 2. Insert into meals table
                    const mealData = {
                        user_id: profile.id,
                        description: dish_name,
                        calories: parseInt(calories),
                        protein: parseFloat(protein),
                        fat: parseFloat(fat),
                        carbs: parseFloat(carbs),
                        weight_g: parseInt(weight_g),
                        ingredients: ingredients,
                        meal_type: 'photo'
                    };
                    const { error: mealError } = await supabase.from('meals').insert(mealData);

                    if (mealError) throw mealError;

                    bot.editMessageText(`✅ Сохранено: ${dish_name} (${calories} ккал).`, {
                        chat_id,
                        message_id: msg.message_id,
                        reply_markup: null
                    });

                } catch (dbError) {
                    console.error('Error saving meal:', dbError.message);
                    bot.sendMessage(chat_id, 'Не удалось сохранить приём пищи. Пожалуйста, попробуйте снова.');
                }
            } else if (subject === 'cancel') {
                bot.editMessageText('Действие отменено.', {
                    chat_id,
                    message_id: msg.message_id,
                    reply_markup: null
                });
            }
             return;
        }

        if (action === 'register' && registrationState[telegram_id]) {
            const state = registrationState[telegram_id];
            
            switch (state.step) {
                case 'ask_gender':
                    if (subject === 'gender') {
                        state.data.gender = value; // 'male' or 'female'
                        state.step = 'ask_age';
                        bot.editMessageText('Отлично. Сколько тебе полных лет?', { chat_id, message_id: msg.message_id });
                    }
                    break;
                case 'ask_goal':
                    if (subject === 'goal') {
                        state.data.goal = value;
                        
                        // End of registration, save to DB
                        try {
                             const profileData = {
                                telegram_id: state.data.telegram_id,
                                username: state.data.username,
                                first_name: state.data.name, // Use the name they provided
                                last_name: state.data.last_name,
                                chat_id: state.data.chat_id,
                                gender: state.data.gender,
                                age: state.data.age,
                                height_cm: state.data.height_cm,
                                weight_kg: state.data.weight_kg,
                                goal: state.data.goal
                            };

                            const { error } = await supabase.from('profiles').insert(profileData);
                            if (error) throw error;

                            await bot.editMessageText(`🎉 Регистрация завершена!

Твой профиль:
- Имя: ${profileData.first_name}
- Пол: ${profileData.gender === 'male' ? 'Мужской' : 'Женский'}
- Возраст: ${profileData.age}
- Рост: ${profileData.height_cm} см
- Вес: ${profileData.weight_kg} кг
- Цель: ${profileData.goal.replace('_', ' ')}

Теперь ты можешь добавлять приёмы пищи. Воспользуйся меню для навигации.`, { chat_id, message_id: msg.message_id });
                            
                            // Clean up state
                            delete registrationState[telegram_id];

                        } catch (dbError) {
                            console.error('Error saving user profile:', dbError.message);
                            bot.sendMessage(chat_id, 'Не удалось сохранить твой профиль. Попробуй /start еще раз.');
                        }
                    }
                    break;
            }
        }
         bot.answerCallbackQuery(callbackQuery.id);
    });

};

module.exports = { setupBot }; 