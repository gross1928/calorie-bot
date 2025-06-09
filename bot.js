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

const bot = new TelegramBot(token);
const openai = new OpenAI({ apiKey: openaiApiKey });

// In-memory states
const registrationState = {};
const manualAddState = {};
const mealConfirmationCache = {};
const workoutPlanState = {};
const nutritionPlanState = {};
const waterInputState = {};

// Состояние для ожидания вопросов от пользователя
const questionState = {};

// Состояние для анализа медицинских данных
const medicalAnalysisState = {};

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
- Вес: ${weight_kg} кг
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
- Вес: ${weight_kg} кг
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

const answerUserQuestion = async (question, profileData = null) => {
    try {
        console.log('Answering user question with OpenAI...');
        
        const profileInfo = profileData ? `
ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ:
- Имя: ${profileData.first_name}
- Пол: ${profileData.gender === 'male' ? 'мужской' : 'женский'}
- Возраст: ${profileData.age} лет
- Рост: ${profileData.height_cm} см
- Вес: ${profileData.weight_kg} кг
- Цель: ${profileData.goal === 'lose_weight' ? 'похудение' : profileData.goal === 'gain_mass' ? 'набор массы' : 'поддержание веса'}
${profileData.daily_calories ? `- Дневная норма калорий: ${profileData.daily_calories} ккал` : ''}
${profileData.daily_protein ? `- Белки: ${profileData.daily_protein} г` : ''}
${profileData.daily_fat ? `- Жиры: ${profileData.daily_fat} г` : ''}
${profileData.daily_carbs ? `- Углеводы: ${profileData.daily_carbs} г` : ''}
` : '';

        const systemPrompt = `Ты - умный помощник по питанию и здоровому образу жизни. Ты работаешь в Telegram боте для подсчета калорий.

${profileInfo}

ТВОИ ВОЗМОЖНОСТИ:
- Отвечать на вопросы о питании, калориях, КБЖУ, диетах
- Давать советы по здоровому питанию и тренировкам
- Помогать с планированием питания
- Отвечать на вопросы о продуктах и их калорийности
- Давать рекомендации по достижению целей (похудение/набор массы/поддержание веса)

ПРАВИЛА:
1. Отвечай кратко и по делу (максимум 500 символов)
2. Используй эмодзи для лучшего восприятия
3. Если вопрос не по теме питания/здоровья, вежливо перенаправь к основным функциям бота
4. Учитывай профиль пользователя в ответах
5. Не давай медицинских диагнозов и советов, рекомендуй обратиться к врачу при серьезных вопросах

ПРИМЕРЫ ХОРОШИХ ОТВЕТОВ:
- "🥗 Для похудения важен дефицит калорий. Твоя норма ${profileData?.daily_calories || 'XXXX'} ккал, старайся есть на 300-500 ккал меньше."
- "🍎 Яблоко содержит примерно 50 ккал на 100г. Отличный перекус!"
- "💪 Для набора мышечной массы нужно 1.6-2.2г белка на кг веса. У тебя это ${profileData?.daily_protein || 'XX'}г в день."`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question }
            ],
            max_tokens: 300,
        });

        const answer = response.choices[0].message.content;
        return { success: true, answer };

    } catch (error) {
        console.error('Error answering user question:', error);
        return { success: false, error: error.message };
    }
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
- Вес: ${profileData.weight_kg} кг
- Цель: ${profileData.goal}`;
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Проанализируй это сообщение: "${messageText}"` }
            ],
            max_tokens: 600,
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

// --- Workout Tracking Functions ---
const logWorkout = async (telegram_id, workoutData) => {
    try {
        console.log('Logging workout:', workoutData);

        const { data, error } = await supabase
            .from('workout_logs')
            .insert({
                telegram_id,
                workout_type: workoutData.workout_type,
                duration_minutes: workoutData.duration,
                exercises: workoutData.exercises,
                intensity: workoutData.intensity,
                calories_burned: workoutData.calories_burned || null,
                notes: workoutData.notes || null,
                date: new Date().toISOString().split('T')[0]
            });

        if (error) throw error;

        return { success: true, data };
    } catch (error) {
        console.error('Error logging workout:', error);
        return { success: false, error: error.message };
    }
};

const getWorkoutStats = async (telegram_id, period) => {
    try {
        const today = new Date();
        let startDate;

        switch (period) {
            case 'today':
                startDate = new Date(today.setHours(0, 0, 0, 0));
                break;
            case 'week':
                startDate = new Date(today.setDate(today.getDate() - 6));
                break;
            case 'month':
                startDate = new Date(today.setDate(today.getDate() - 29));
                break;
            default:
                startDate = new Date(today.setHours(0, 0, 0, 0));
        }

        const { data: workoutRecords, error } = await supabase
            .from('workout_logs')
            .select('*')
            .eq('telegram_id', telegram_id)
            .gte('date', startDate.toISOString().split('T')[0])
            .order('date', { ascending: false });

        if (error) throw error;

        const stats = {
            totalWorkouts: workoutRecords ? workoutRecords.length : 0,
            totalDuration: 0,
            totalCalories: 0,
            workoutTypes: {},
            recentWorkouts: workoutRecords ? workoutRecords.slice(0, 5) : []
        };

        if (workoutRecords && workoutRecords.length > 0) {
            workoutRecords.forEach(workout => {
                stats.totalDuration += workout.duration_minutes || 0;
                stats.totalCalories += workout.calories_burned || 0;
                
                const type = workout.workout_type || 'Неизвестно';
                stats.workoutTypes[type] = (stats.workoutTypes[type] || 0) + 1;
            });
        }

        return { success: true, ...stats };
    } catch (error) {
        console.error('Error getting workout stats:', error);
        return { success: false, error: error.message };
    }
};

const estimateCaloriesBurned = (workoutType, duration, weight_kg) => {
    // Примерный расчет калорий на основе типа тренировки, времени и веса
    const metValues = {
        'кардио': 7,
        'силовая': 5,
        'йога': 3,
        'пилатес': 3,
        'бег': 8,
        'плавание': 6,
        'велосипед': 6,
        'ходьба': 3.5,
        'танцы': 5,
        'фитнес': 5,
        'тренажерный зал': 5,
        'общая': 4.5
    };

    const workoutTypeLower = workoutType.toLowerCase();
    let met = metValues['общая']; // значение по умолчанию

    // Поиск соответствующего MET значения
    for (const [type, value] of Object.entries(metValues)) {
        if (workoutTypeLower.includes(type)) {
            met = value;
            break;
        }
    }

    // Формула: калории = MET × вес (кг) × время (часы)
    const hours = duration / 60;
    const calories = Math.round(met * weight_kg * hours);
    
    return calories;
};

// --- Workout Tracking Functions ---
const calculateCaloriesBurned = (workoutType, duration, exercises, profileData) => {
    // Базовые коэффициенты калорий в минуту для разного веса (70кг базовый)
    const calorieRates = {
        'cardio': 8.5,      // Бег, велосипед
        'strength': 4.5,    // Силовые тренировки
        'yoga': 2.5,        // Йога, растяжка
        'hiit': 10.0,       // Высокоинтенсивные тренировки
        'swimming': 7.0,    // Плавание
        'walking': 3.5,     // Ходьба
        'other': 5.0        // Другие виды
    };

    const weightFactor = profileData?.weight_kg ? profileData.weight_kg / 70 : 1;
    const baseRate = calorieRates[workoutType] || calorieRates['other'];
    
    // Дополнительные калории за конкретные упражнения
    let exerciseCalories = 0;
    if (exercises && exercises.length > 0) {
        exercises.forEach(exercise => {
            const exerciseName = exercise.toLowerCase();
            if (exerciseName.includes('отжимани') || exerciseName.includes('push')) {
                exerciseCalories += 0.5 * (exercise.match(/\d+/) ? parseInt(exercise.match(/\d+/)[0]) : 10);
            } else if (exerciseName.includes('приседани') || exerciseName.includes('squat')) {
                exerciseCalories += 0.4 * (exercise.match(/\d+/) ? parseInt(exercise.match(/\d+/)[0]) : 10);
            } else if (exerciseName.includes('планка') || exerciseName.includes('plank')) {
                exerciseCalories += 5; // За минуту планки
            }
        });
    }

    const totalCalories = Math.round((baseRate * duration * weightFactor) + exerciseCalories);
    return Math.max(totalCalories, 10); // Минимум 10 калорий
};

const addWorkoutRecord = async (telegram_id, workoutData) => {
    try {
        const { data, error } = await supabase
            .from('workout_records')
            .insert({
                telegram_id,
                workout_type: workoutData.workout_type,
                exercises: workoutData.exercises,
                duration_minutes: workoutData.duration,
                intensity: workoutData.intensity,
                calories_burned: workoutData.calories_burned,
                notes: workoutData.notes || '',
                date: new Date().toISOString().split('T')[0],
                created_at: new Date().toISOString()
            });

        if (error) throw error;
        return { success: true, data };
    } catch (error) {
        console.error('Error adding workout record:', error);
        return { success: false, error: error.message };
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

// --- HTML Document Generation ---
const generateWorkoutPlanHTML = (planContent, profileData, planData) => {
    const currentDate = new Date().toLocaleDateString('ru-RU');
    
    // Парсим контент плана из Markdown в структурированные данные
    const days = planContent.split('### День').filter(day => day.trim());
    
    let dayCards = '';
    days.forEach((day, index) => {
        if (index === 0) return; // Пропускаем первый элемент (заголовок)
        
        const lines = day.trim().split('\n');
        const dayTitle = lines[0].replace(/^\d+\s*-\s*/, '');
        
        let exercises = '';
        let isTable = false;
        
        lines.forEach(line => {
            if (line.includes('|') && !line.includes('Упражнение')) {
                isTable = true;
                const parts = line.split('|').map(p => p.trim()).filter(p => p);
                if (parts.length >= 4) {
                    exercises += `
                        <div class="exercise-row">
                            <span class="exercise-name">${parts[0]}</span>
                            <span class="exercise-sets">${parts[1]} подходов</span>
                            <span class="exercise-reps">${parts[2]}</span>
                            <span class="exercise-rest">${parts[3]}</span>
                        </div>
                    `;
                }
            }
        });
        
        dayCards += `
            <div class="day-card">
                <h3>День ${index} - ${dayTitle}</h3>
                <div class="exercises">
                    ${exercises || '<p class="rest-day">День отдыха 😌</p>'}
                </div>
            </div>
        `;
    });
    
    return `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Персональный план тренировок</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(45deg, #FF6B6B, #4ECDC4);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        
        .header p {
            font-size: 1.2em;
            opacity: 0.9;
        }
        
        .user-info {
            background: #f8f9fa;
            padding: 20px;
            border-left: 5px solid #4ECDC4;
            margin: 20px;
            border-radius: 10px;
        }
        
        .user-info h3 {
            color: #333;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
        }
        
        .user-info h3::before {
            content: "👤";
            margin-right: 10px;
            font-size: 1.2em;
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
        }
        
        .info-item {
            padding: 10px;
            background: white;
            border-radius: 8px;
            border: 1px solid #e9ecef;
        }
        
        .info-label {
            font-weight: bold;
            color: #666;
            font-size: 0.9em;
        }
        
        .info-value {
            color: #333;
            font-size: 1.1em;
            margin-top: 5px;
        }
        
        .day-card {
            margin: 20px;
            background: white;
            border-radius: 15px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.08);
            overflow: hidden;
            border: 1px solid #e9ecef;
        }
        
        .day-card h3 {
            background: linear-gradient(45deg, #6c5ce7, #fd79a8);
            color: white;
            padding: 20px;
            margin: 0;
            font-size: 1.3em;
            text-align: center;
        }
        
        .exercises {
            padding: 20px;
        }
        
        .exercise-row {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            gap: 15px;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 10px;
            margin-bottom: 10px;
            border-left: 4px solid #6c5ce7;
            transition: transform 0.2s ease;
        }
        
        .exercise-row:hover {
            transform: translateX(5px);
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .exercise-name {
            font-weight: bold;
            color: #333;
        }
        
        .exercise-sets {
            color: #e74c3c;
            font-weight: 500;
        }
        
        .exercise-reps {
            color: #2ecc71;
            font-weight: 500;
        }
        
        .exercise-rest {
            color: #3498db;
            font-weight: 500;
        }
        
        .rest-day {
            text-align: center;
            color: #666;
            font-size: 1.2em;
            padding: 20px;
            background: #f1f3f4;
            border-radius: 10px;
        }
        
        .footer {
            background: #2c3e50;
            color: white;
            padding: 20px;
            text-align: center;
        }
        
        .tips {
            margin: 20px;
            padding: 20px;
            background: linear-gradient(45deg, #ffecd2, #fcb69f);
            border-radius: 15px;
            border-left: 5px solid #f39c12;
        }
        
        .tips h3 {
            color: #d35400;
            margin-bottom: 15px;
        }
        
        .tips ul {
            list-style: none;
            padding-left: 0;
        }
        
        .tips li {
            margin: 8px 0;
            padding-left: 25px;
            position: relative;
        }
        
        .tips li::before {
            content: "💡";
            position: absolute;
            left: 0;
        }
        
        @media print {
            body {
                background: white;
                padding: 0;
            }
            
            .container {
                box-shadow: none;
                border-radius: 0;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>💪 Персональный план тренировок</h1>
            <p>Создан специально для вас</p>
        </div>
        
        <div class="user-info">
            <h3>Информация о пользователе</h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Имя</div>
                    <div class="info-value">${profileData.first_name}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Возраст</div>
                    <div class="info-value">${profileData.age} лет</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Вес</div>
                    <div class="info-value">${profileData.weight_kg} кг</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Цель</div>
                    <div class="info-value">${profileData.goal}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Опыт</div>
                    <div class="info-value">${planData.experience}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Частота</div>
                    <div class="info-value">${planData.frequency} раз в неделю</div>
                </div>
            </div>
        </div>
        
        ${dayCards}
        
        <div class="tips">
            <h3>💡 Полезные советы</h3>
            <ul>
                <li>Всегда начинайте с разминки 5-10 минут</li>
                <li>Пейте воду до, во время и после тренировки</li>
                <li>Отдыхайте между подходами согласно плану</li>
                <li>Прислушивайтесь к своему телу и не переусердствуйте</li>
                <li>Постепенно увеличивайте нагрузку</li>
                <li>Обязательно делайте растяжку после тренировки</li>
            </ul>
        </div>
        
        <div class="footer">
            <p>План создан ${currentDate} | Telegram Bot NutriAI</p>
            <p style="margin-top: 10px; opacity: 0.8;">Следите за прогрессом и достигайте целей! 🎯</p>
        </div>
    </div>
</body>
</html>
    `;
};

const generateNutritionPlanHTML = (planContent, profileData, planData) => {
    const currentDate = new Date().toLocaleDateString('ru-RU');
    
    // Парсим план питания
    const sections = planContent.split('##').filter(section => section.trim());
    
    let dailyMeals = '';
    let recommendations = '';
    
    sections.forEach(section => {
        if (section.includes('День') || section.includes('день')) {
            const lines = section.trim().split('\n');
            const dayTitle = lines[0].trim();
            
            let meals = '';
            lines.slice(1).forEach(line => {
                if (line.includes('**') && (line.includes('Завтрак') || line.includes('Обед') || line.includes('Ужин') || line.includes('Перекус'))) {
                    const mealName = line.replace(/\*\*/g, '').trim();
                    meals += `<h4 class="meal-title">${mealName}</h4>`;
                } else if (line.trim() && !line.includes('**')) {
                    meals += `<p class="meal-item">${line.trim()}</p>`;
                }
            });
            
            dailyMeals += `
                <div class="day-card">
                    <h3>${dayTitle}</h3>
                    <div class="meals">
                        ${meals}
                    </div>
                </div>
            `;
        } else if (section.includes('рекомендаци') || section.includes('совет')) {
            recommendations = section.trim();
        }
    });
    
    return `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Персональный план питания</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(45deg, #FF9A8B, #A8E6CF);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        
        .user-info {
            background: #f8f9fa;
            padding: 20px;
            border-left: 5px solid #A8E6CF;
            margin: 20px;
            border-radius: 10px;
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
        }
        
        .info-item {
            padding: 10px;
            background: white;
            border-radius: 8px;
            border: 1px solid #e9ecef;
        }
        
        .day-card {
            margin: 20px;
            background: white;
            border-radius: 15px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.08);
            overflow: hidden;
            border: 1px solid #e9ecef;
        }
        
        .day-card h3 {
            background: linear-gradient(45deg, #FF9A8B, #FECFEF);
            color: white;
            padding: 20px;
            margin: 0;
            font-size: 1.3em;
            text-align: center;
        }
        
        .meals {
            padding: 20px;
        }
        
        .meal-title {
            color: #2d3436;
            margin: 15px 0 10px 0;
            font-size: 1.2em;
            padding: 10px;
            background: linear-gradient(45deg, #fd79a8, #fdcb6e);
            border-radius: 8px;
            color: white;
        }
        
        .meal-item {
            margin: 8px 0;
            padding: 8px 15px;
            background: #f1f3f4;
            border-radius: 5px;
            border-left: 3px solid #fd79a8;
        }
        
        .footer {
            background: #2c3e50;
            color: white;
            padding: 20px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🥗 Персональный план питания</h1>
            <p>Здоровое питание для достижения ваших целей</p>
        </div>
        
        <div class="user-info">
            <h3>👤 Информация о пользователе</h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Имя</div>
                    <div class="info-value">${profileData.first_name}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Цель по калориям</div>
                    <div class="info-value">${profileData.daily_calories} ккал</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Белки</div>
                    <div class="info-value">${profileData.daily_protein} г</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Жиры</div>
                    <div class="info-value">${profileData.daily_fat} г</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Углеводы</div>
                    <div class="info-value">${profileData.daily_carbs} г</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Приемов пищи</div>
                    <div class="info-value">${planData.mealsCount}</div>
                </div>
            </div>
        </div>
        
        ${dailyMeals}
        
        <div class="footer">
            <p>План создан ${currentDate} | Telegram Bot NutriAI</p>
            <p style="margin-top: 10px; opacity: 0.8;">Питайтесь правильно и достигайте целей! 🎯</p>
        </div>
    </div>
</body>
</html>
    `;
};

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
        console.log('📊 Начинаю отправку ежедневных отчетов...');
        
        // Получаем всех пользователей
        const { data: users, error } = await supabase
            .from('profiles')
            .select('telegram_id, first_name');

        if (error) {
            console.error('Error fetching users for daily reports:', error);
            return;
        }

        if (!users || users.length === 0) {
            console.log('Нет пользователей для отправки отчетов');
            return;
        }

        let sentCount = 0;
        let failedCount = 0;

        for (const user of users) {
            try {
                const report = await generateDailyReport(user.telegram_id);
                
                if (report) {
                    await bot.sendMessage(user.telegram_id, report, {
                        parse_mode: 'Markdown'
                    });
                    sentCount++;
                    console.log(`✅ Отчет отправлен пользователю ${user.first_name} (${user.telegram_id})`);
                    
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

        console.log(`📊 Отправка отчетов завершена: ✅ ${sentCount} успешно, ❌ ${failedCount} ошибок`);

    } catch (error) {
        console.error('Error in sendDailyReports:', error);
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
                    [{ text: '💧 Отслеживание воды' }]
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
            showWaterMenu(chat_id, telegram_id);
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

                // --- Voice Message Handler ---
        if (msg.voice) {
            const thinkingMessage = await bot.sendMessage(chat_id, '🎤 Получил голосовое сообщение! Преобразую речь в текст...');
            try {
                const voice = msg.voice;
                const fileInfo = await bot.getFile(voice.file_id);
                const voiceUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                
                const transcriptionResult = await processVoiceMessage(voiceUrl);
                
                if (transcriptionResult.success) {
                    await bot.editMessageText(`🎤 Обрабатываю сообщение: "${transcriptionResult.text}"`, {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id
                    });

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
                                    await bot.editMessageText(analysisData.response_text, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
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
                                            chat_id: thinkingMessage.chat.id,
                                            message_id: thinkingMessage.message_id,
                                            parse_mode: 'Markdown'
                                        });
                                    } else {
                                        await bot.editMessageText(`❌ Ошибка при добавлении воды: ${result.error}`, {
                                            chat_id: thinkingMessage.chat.id,
                                            message_id: thinkingMessage.message_id
                                        });
                                    }
                                } else {
                                    await bot.editMessageText(analysisData.response_text, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
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
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    await bot.editMessageText(`❌ Ошибка при сохранении тренировки: ${result.error}`, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id
                                    });
                                }
                                break;

                            case 'generate_report':
                                // Генерируем отчет
                                const report = await generateDailyReport(telegram_id);
                                
                                if (report.success) {
                                    await bot.editMessageText(report.text, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    await bot.editMessageText('❌ Не удалось сгенерировать отчет. Возможно, у вас нет данных за сегодня.', {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id
                                    });
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

                                    await bot.editMessageText(responseText, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    await bot.editMessageText(analysisData.response_text, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                }
                                break;

                            case 'answer_question':
                                // Отвечаем на вопрос
                                const questionResult = await answerUserQuestion(transcriptionResult.text, profile);
                                
                                if (questionResult.success) {
                                    await bot.editMessageText(`🎤 **Ваш вопрос:** "${transcriptionResult.text}"\n\n${questionResult.answer}`, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    await bot.editMessageText(analysisData.response_text, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                }
                                break;

                            default:
                                // Все остальные случаи - дружелюбный ответ
                                await bot.editMessageText(`🎤 **Услышал:** "${transcriptionResult.text}"\n\n${analysisData.response_text}`, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                                break;
                        }
                    } else {
                        await bot.editMessageText(`🎤 **Распознано:** "${transcriptionResult.text}"\n\nИзвините, не смог понять ваше сообщение.`, {
                            chat_id: thinkingMessage.chat.id,
                            message_id: thinkingMessage.message_id,
                            parse_mode: 'Markdown'
                        });
                    }
                } else {
                    await bot.editMessageText(`❌ ${transcriptionResult.error}`, {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке голосового сообщения:", error);
                await bot.editMessageText('Произошла ошибка при обработке голосового сообщения.', {
                    chat_id: thinkingMessage.chat.id,
                    message_id: thinkingMessage.message_id
                });
            }
            return;
        }

                // --- Document Handler ---
        if (msg.document) {
            const thinkingMessage = await bot.sendMessage(chat_id, '📄 Получил документ! Анализирую содержимое...');
            try {
                const document = msg.document;
                const fileInfo = await bot.getFile(document.file_id);
                const documentUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                
                // Если это изображение, извлекаем текст через OCR
                if (document.mime_type && document.mime_type.startsWith('image/')) {
                    const extractionResult = await extractTextFromImage(documentUrl);
                    
                    if (extractionResult.success) {
                        await bot.editMessageText(`📄 Анализирую извлеченный текст...`, {
                            chat_id: thinkingMessage.chat.id,
                            message_id: thinkingMessage.message_id
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
                                            chat_id: thinkingMessage.chat.id,
                                            message_id: thinkingMessage.message_id,
                                            parse_mode: 'Markdown'
                                        });
                                    } else {
                                        await bot.editMessageText(`📄 **Извлеченный текст:**\n\n${extractionResult.text.substring(0, 800)}${extractionResult.text.length > 800 ? '...' : ''}\n\n${analysisData.response_text}`, {
                                            chat_id: thinkingMessage.chat.id,
                                            message_id: thinkingMessage.message_id,
                                            parse_mode: 'Markdown'
                                        });
                                    }
                                    break;

                                default:
                                    // Другие типы документов
                                    await bot.editMessageText(`📄 **Извлеченный текст:**\n\n${extractionResult.text.substring(0, 800)}${extractionResult.text.length > 800 ? '...' : ''}\n\n${analysisData.response_text}`, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                    break;
                            }
                        } else {
                            await bot.editMessageText(`📄 **Извлеченный текст:**\n\n${extractionResult.text.substring(0, 1000)}${extractionResult.text.length > 1000 ? '...' : ''}`, {
                                chat_id: thinkingMessage.chat.id,
                                message_id: thinkingMessage.message_id,
                                parse_mode: 'Markdown'
                            });
                        }
                    } else {
                        await bot.editMessageText(`❌ ${extractionResult.error}`, {
                            chat_id: thinkingMessage.chat.id,
                            message_id: thinkingMessage.message_id
                        });
                    }
                } else {
                    await bot.editMessageText('Пока поддерживаются только изображения документов. Попробуйте отправить фото анализа.', {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке документа:", error);
                await bot.editMessageText('Произошла ошибка при обработке документа.', {
                    chat_id: thinkingMessage.chat.id,
                    message_id: thinkingMessage.message_id
                });
            }
            return;
        }

        // --- State-based Input Handlers ---
        const registrationStep = registrationState[telegram_id]?.step;
        const manualAddStep = manualAddState[telegram_id]?.step;
        const isWaitingForQuestion = questionState[telegram_id]?.waiting;
        const isWaitingForWater = waterInputState[telegram_id]?.waiting;

        if (isWaitingForQuestion) {
            // Пользователь задает вопрос - обрабатываем его через AI
            delete questionState[telegram_id];
            const thinkingMessage = await bot.sendMessage(chat_id, '🤔 Думаю над вашим вопросом...');
            
            try {
                // Получаем профиль пользователя для персонализированного ответа
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('first_name, gender, age, height_cm, weight_kg, goal, daily_calories, daily_protein, daily_fat, daily_carbs')
                    .eq('telegram_id', telegram_id)
                    .single();

                const questionResult = await answerUserQuestion(msg.text, profile);

                if (questionResult.success) {
                    await bot.editMessageText(questionResult.answer, {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id,
                        parse_mode: 'Markdown'
                    });
                } else {
                    await bot.editMessageText('🤖 Извините, произошла ошибка при обработке вашего вопроса. Попробуйте еще раз или используйте основные функции бота.', {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id
                    });
                }
            } catch (error) {
                console.error("Error answering user question:", error);
                await bot.editMessageText('🤖 Извините, произошла ошибка при обработке вашего вопроса. Попробуйте еще раз или используйте основные функции бота.', {
                    chat_id: thinkingMessage.chat.id,
                    message_id: thinkingMessage.message_id
                });
            }
            return;
        }

        if (isWaitingForWater) {
            // Пользователь ввел количество воды
            delete waterInputState[telegram_id];

            const amount = parseInt(msg.text);
            if (isNaN(amount) || amount <= 0 || amount > 5000) {
                bot.sendMessage(chat_id, '❌ Пожалуйста, введите корректное количество воды от 1 до 5000 мл.');
                return;
            }

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

        // --- Universal Text Message Handler ---
        // Если сообщение не попало ни в одну из категорий выше, обрабатываем универсальным агентом
        if (msg.text && !msg.text.startsWith('/')) {
            const thinkingMessage = await bot.sendMessage(chat_id, '🤔 Анализирую ваше сообщение...');
            
            try {
                // Получаем профиль пользователя
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('first_name, gender, age, height_cm, weight_kg, goal, id')
                    .eq('telegram_id', telegram_id)
                    .single();

                // Используем универсального агента
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
                                await bot.editMessageText(analysisData.response_text, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
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
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    await bot.editMessageText(`❌ Ошибка при добавлении воды: ${result.error}`, {
                                        chat_id: thinkingMessage.chat.id,
                                        message_id: thinkingMessage.message_id
                                    });
                                }
                            } else {
                                await bot.editMessageText(analysisData.response_text, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
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
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot.editMessageText(`❌ Ошибка при сохранении тренировки: ${result.error}`, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id
                                });
                            }
                            break;

                        case 'generate_report':
                            // Генерируем отчет
                            const report = await generateDailyReport(telegram_id);
                            
                            if (report.success) {
                                await bot.editMessageText(report.text, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot.editMessageText('❌ Не удалось сгенерировать отчет. Возможно, у вас нет данных за сегодня.', {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id
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
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot.editMessageText(analysisData.response_text, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            }
                            break;

                        case 'answer_question':
                            // Отвечаем на вопрос
                            const questionResult = await answerUserQuestion(msg.text, profile);
                            
                            if (questionResult.success) {
                                await bot.editMessageText(questionResult.answer, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot.editMessageText(analysisData.response_text, {
                                    chat_id: thinkingMessage.chat.id,
                                    message_id: thinkingMessage.message_id,
                                    parse_mode: 'Markdown'
                                });
                            }
                            break;

                        default:
                            // Все остальные случаи - дружелюбный ответ
                            await bot.editMessageText(analysisData.response_text, {
                                chat_id: thinkingMessage.chat.id,
                                message_id: thinkingMessage.message_id,
                                parse_mode: 'Markdown'
                            });
                            break;
                    }
                } else {
                    await bot.editMessageText('Извините, не смог понять ваше сообщение. Попробуйте использовать основные функции бота через меню.', {
                        chat_id: thinkingMessage.chat.id,
                        message_id: thinkingMessage.message_id
                    });
                }
            } catch (error) {
                console.error("Ошибка при обработке текстового сообщения:", error);
                await bot.editMessageText('Произошла ошибка при обработке сообщения.', {
                    chat_id: thinkingMessage.chat.id,
                    message_id: thinkingMessage.message_id
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

        const [action, ...params] = data.split('_');
        
        console.log(`>>> CALLBACK: User: ${telegram_id}, Data: ${data}, Action: ${action}, Params: ${params}`);
        
        // --- Plan Action Callbacks ---
        if (data.startsWith('workout_action_') || data.startsWith('nutrition_action_')) {
        await bot.answerCallbackQuery(callbackQuery.id);

            const [planType, , actionType] = data.split('_');
            
            if (actionType === 'no') {
                // Пользователь выбрал "Нет" - включаем режим ожидания вопроса
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
                    const loadingMessage = await bot.editMessageText(`🤖 Использую ваши сохраненные предпочтения для создания нового плана ${planTypeName}... Это может занять до 30 секунд.`, {
                        chat_id, message_id: msg.message_id
                    });

                    try {
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
                            step: 'ask_experience', 
                            data: { priority_zones: [] },
                            profileData: profile 
                        };

                        await bot.editMessageText('Отлично! Давайте создадим персональный план тренировок 💪\n\nДля начала, какой у вас опыт тренировок?', {
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

                        await bot.editMessageText('Отлично! Создадим персональный план питания 🍽️\n\nКакие у вас есть пищевые предпочтения?', {
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
                    
                    let dailyAverageText = '';
                    if (period !== 'today') {
                         const dayDifference = (new Date().getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
                         const daysInPeriod = Math.max(1, Math.ceil(dayDifference));
                         const avgCalories = totals.calories / daysInPeriod;
                         dailyAverageText = `📈 Среднесуточно: *${avgCalories.toFixed(0)} ккал/день*\n\n`;
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
                                waterText = `\n\n💧 Вода: *${waterStats.totalWater} мл всего (${avgDaily} мл/день)*\n` +
                                           `Выполнение нормы: ${avgPercentage}%`;
                            }
                        }
                    }

                    statsText = `*Статистика за ${periodText}, ${profile.first_name}:*\n\n` +
                                `🔥 Калории: *${formatLine(totals.calories, daily_calories)}ккал*\n` +
                                `${createProgressBar(totals.calories, daily_calories)}\n\n` +
                                (period === 'today' ? '' : dailyAverageText) +
                                `*Общее количество БЖУ:*\n` +
                                `🥩 Белки: ${formatLine(totals.protein, daily_protein)}г\n` +
                                `🥑 Жиры: ${formatLine(totals.fat, daily_fat)}г\n` +
                                `🍞 Углеводы: ${formatLine(totals.carbs, daily_carbs)}г` +
                                waterText;
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
                if (value === 'done') {
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
            } else if (action === 'workout' && subAction === 'zones' && value === 'done') {
                // Обработка кнопки "Готово" для выбора зон
                await bot.answerCallbackQuery(callbackQuery.id);
                const state = workoutPlanState[telegram_id];
                if (!state || state.step !== 'ask_priority_zones') {
                    await bot.editMessageText('Сессия истекла. Пожалуйста, начните заново.', {
                        chat_id, message_id: msg.message_id
                    });
                    return;
                }

                // Если ничего не выбрано, устанавливаем "none"
                if (state.data.priority_zones.length === 0) {
                    state.data.priority_zones = ['none'];
                }
                
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
            } else if (state.step === 'ask_injuries' && subAction === 'injury') {
                 state.data = { ...state.data, injuries: value };
                 state.step = 'ask_location';

                 await bot.editMessageText('Где вы планируете заниматься?', {
                     chat_id, message_id: msg.message_id,
                     reply_markup: {
                         inline_keyboard: [
                             [{ text: '🏠 Дома', callback_data: 'workout_location_home' }],
                             [{ text: '🏋️ В спортзале', callback_data: 'workout_location_gym' }],
                             [{ text: '🌳 На улице', callback_data: 'workout_location_outdoor' }]
                         ]
                     }
                 });
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

                     // Генерируем план с OpenAI
                     const planResult = await generateWorkoutPlan(state.profileData, state.data);

                     if (planResult.success) {
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

            if (state.step === 'ask_preferences' && subAction === 'pref') {
                state.data = { ...state.data, preferences: value };
                state.step = 'ask_activity';

                await bot.editMessageText('Какой у вас тип активности в течение дня?', {
                    chat_id, message_id: msg.message_id,
            reply_markup: {
                        inline_keyboard: [
                            [{ text: '💺 Сидячий образ жизни', callback_data: 'nutrition_activity_sedentary' }],
                            [{ text: '🚶 Лёгкая активность', callback_data: 'nutrition_activity_light' }],
                            [{ text: '🏃 Активный образ жизни', callback_data: 'nutrition_activity_active' }],
                            [{ text: '🏋️ Тяжёлая физическая работа', callback_data: 'nutrition_activity_heavy' }]
                        ]
                    }
                });
            } else if (state.step === 'ask_activity' && subAction === 'activity') {
                state.data = { ...state.data, activity: value };
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
                const loadingMessage = await bot.editMessageText('🤖 Создаю персональный план питания... Это может занять до 30 секунд.', {
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

                    // Генерируем план с OpenAI
                    const planResult = await generateNutritionPlan(state.profileData, state.data);

                    if (planResult.success) {
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

    });
    return bot;
};

// --- Daily Reports Cron Job ---
// Запускаем ежедневные отчеты каждый день в 21:00 (по московскому времени)
// Cron pattern: '0 21 * * *' = каждый день в 21:00
cron.schedule('0 21 * * *', () => {
    console.log('🕘 Время для ежедневных отчетов!');
    sendDailyReports();
}, {
    scheduled: true,
    timezone: "Europe/Moscow"
});

console.log('⏰ Планировщик ежедневных отчетов настроен (каждый день в 21:00 МСК)');

module.exports = { setupBot }; 