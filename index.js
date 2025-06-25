require('dotenv').config();
const express = require('express');
const { setupBot } = require('./bot');
const { handleWebhook, checkPaymentStatus, getUserPaymentHistory } = require('./yukassaClient');

const app = express();
const port = process.env.PORT || 3000;

// Middleware для парсинга JSON
app.use(express.json());

// === ОСНОВНЫЕ ENDPOINTS ===

app.get('/', (req, res) => {
    res.send('Calorie Counter Bot is running!');
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// === ЮKASSA INTEGRATION ===

/**
 * Webhook endpoint для получения уведомлений от ЮKassa
 * POST /webhook/yukassa
 */
app.post('/webhook/yukassa', async (req, res) => {
    try {
        console.log('📨 Получен webhook от ЮKassa:', req.body);
        
        const result = await handleWebhook(req);
        
        if (result.success) {
            if (result.activated) {
                console.log(`✅ Подписка активирована через webhook для пользователя ${result.telegram_id}`);
                
                // Здесь можно отправить уведомление пользователю в Telegram
                // bot.sendMessage(result.telegram_id, '🎉 Ваша подписка успешно активирована!');
            }
            
            res.status(200).json({ status: 'ok' });
        } else {
            console.error('❌ Ошибка обработки webhook:', result.error);
            res.status(400).json({ error: result.error });
        }
        
    } catch (error) {
        console.error('❌ Критическая ошибка webhook:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

/**
 * API endpoint для проверки статуса платежа
 * GET /api/payment/:payment_id/status
 */
app.get('/api/payment/:payment_id/status', async (req, res) => {
    try {
        const { payment_id } = req.params;
        
        if (!payment_id) {
            return res.status(400).json({ error: 'payment_id обязателен' });
        }
        
        const result = await checkPaymentStatus(payment_id);
        
        if (result.success) {
            res.json({
                payment_id: payment_id,
                status: result.status,
                paid: result.paid,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(400).json({ error: result.error });
        }
        
    } catch (error) {
        console.error('Ошибка проверки статуса платежа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

/**
 * API endpoint для получения истории платежей пользователя
 * GET /api/user/:telegram_id/payments
 */
app.get('/api/user/:telegram_id/payments', async (req, res) => {
    try {
        const { telegram_id } = req.params;
        
        if (!telegram_id) {
            return res.status(400).json({ error: 'telegram_id обязателен' });
        }
        
        const result = await getUserPaymentHistory(parseInt(telegram_id));
        
        if (result.success) {
            res.json({
                telegram_id: parseInt(telegram_id),
                payments: result.payments,
                count: result.payments.length,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(400).json({ error: result.error });
        }
        
    } catch (error) {
        console.error('Ошибка получения истории платежей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// === TELEGRAM BOT SETUP ===

// Setup the bot and its webhook with error handling
try {
    console.log('🤖 Starting bot setup...');
    setupBot(app);
    console.log('✅ Bot setup completed successfully');
} catch (error) {
    console.error('❌ Error setting up bot:', error);
    process.exit(1);
}

// === SERVER START ===

app.listen(port, () => {
    console.log(`🚀 Server is listening on port ${port}`);
    console.log(`📡 Webhook endpoint: /webhook/yukassa`);
    console.log(`🔍 Payment API: /api/payment/:payment_id/status`);
    console.log(`📊 User payments API: /api/user/:telegram_id/payments`);
}); 