const crypto = require('crypto');
const supabase = require('./supabaseClient');

require('dotenv').config();

// === КОНФИГУРАЦИЯ ЮKASSA ===
const YUKASSA_CONFIG = {
    shopId: process.env.YUKASSA_SHOP_ID,
    secretKey: process.env.YUKASSA_SECRET_KEY,
    webhookSecret: process.env.YUKASSA_WEBHOOK_SECRET,
    apiUrl: 'https://api.yookassa.ru/v3',
    
    // Тарифы и их стоимость
    subscriptionPrices: {
        progress: 199.00,
        maximum: 349.00
    },
    
    // Ссылки для быстрой оплаты (ваши существующие)
    quickPaymentLinks: {
        progress: 'https://yookassa.ru/my/i/aFuvni8_S7Z9/l',
        maximum: 'https://yookassa.ru/my/i/aFuv3xVOei-f/l'
    }
};

// === ОСНОВНЫЕ ФУНКЦИИ ===

/**
 * Создание платежа через ЮKassa API
 */
const createPayment = async (telegram_id, subscription_tier) => {
    try {
        const amount = YUKASSA_CONFIG.subscriptionPrices[subscription_tier];
        if (!amount) {
            throw new Error(`Неизвестный тариф: ${subscription_tier}`);
        }

        // Получаем профиль пользователя
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, first_name, username')
            .eq('telegram_id', telegram_id)
            .single();

        if (profileError || !profile) {
            throw new Error('Пользователь не найден');
        }

        // Генерируем уникальный ID платежа
        const paymentId = crypto.randomUUID();
        
        // Данные для создания платежа
        const paymentData = {
            amount: {
                value: amount.toFixed(2),
                currency: 'RUB'
            },
            capture: true,
            description: `Подписка "${subscription_tier.toUpperCase()}" для ${profile.first_name || profile.username}`,
            metadata: {
                telegram_id: telegram_id.toString(),
                subscription_tier: subscription_tier,
                user_id: profile.id.toString()
            },
            confirmation: {
                type: 'redirect',
                return_url: `https://t.me/your_bot_name?start=payment_success`
            }
        };

        // Создаем платеж через API ЮKassa
        const response = await fetch(`${YUKASSA_CONFIG.apiUrl}/payments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotence-Key': paymentId,
                'Authorization': `Basic ${Buffer.from(`${YUKASSA_CONFIG.shopId}:${YUKASSA_CONFIG.secretKey}`).toString('base64')}`
            },
            body: JSON.stringify(paymentData)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`ЮKassa API ошибка: ${errorData.description || 'Неизвестная ошибка'}`);
        }

        const payment = await response.json();

        // Сохраняем платеж в базу данных
        const { error: dbError } = await supabase
            .from('yukassa_payments')
            .insert({
                user_id: profile.id,
                telegram_id: telegram_id,
                payment_id: payment.id,
                amount: amount,
                subscription_tier: subscription_tier,
                status: payment.status,
                payment_url: payment.confirmation.confirmation_url,
                confirmation_token: payment.confirmation.confirmation_token,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 часа
                metadata: payment
            });

        if (dbError) {
            console.error('Ошибка сохранения платежа в БД:', dbError);
        }

        return {
            success: true,
            payment_id: payment.id,
            payment_url: payment.confirmation.confirmation_url,
            amount: amount,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
        };

    } catch (error) {
        console.error('Ошибка создания платежа:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Получение быстрой ссылки для оплаты (ваши существующие ссылки)
 */
const getQuickPaymentLink = (subscription_tier) => {
    return YUKASSA_CONFIG.quickPaymentLinks[subscription_tier] || null;
};

/**
 * Проверка статуса платежа
 */
const checkPaymentStatus = async (payment_id) => {
    try {
        const response = await fetch(`${YUKASSA_CONFIG.apiUrl}/payments/${payment_id}`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${YUKASSA_CONFIG.shopId}:${YUKASSA_CONFIG.secretKey}`).toString('base64')}`
            }
        });

        if (!response.ok) {
            throw new Error('Ошибка проверки статуса платежа');
        }

        const payment = await response.json();
        
        // Обновляем статус в базе данных
        await supabase
            .from('yukassa_payments')
            .update({
                status: payment.status,
                metadata: payment,
                updated_at: new Date().toISOString()
            })
            .eq('payment_id', payment_id);

        return {
            success: true,
            status: payment.status,
            paid: payment.status === 'succeeded',
            payment: payment
        };

    } catch (error) {
        console.error('Ошибка проверки платежа:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Проверка IP адреса отправителя webhook
 */
const isValidYookassaIP = (ip) => {
    const allowedRanges = [
        '185.71.76.0/27',
        '185.71.77.0/27', 
        '77.75.153.0/25',
        '77.75.156.11/32',
        '77.75.156.35/32',
        '77.75.154.128/25'
    ];
    
    // Простая проверка для основных IP
    const allowedIPs = [
        '77.75.156.11',
        '77.75.156.35'
    ];
    
    return allowedIPs.includes(ip) || ip.startsWith('185.71.76.') || ip.startsWith('185.71.77.') || ip.startsWith('77.75.153.') || ip.startsWith('77.75.154.');
};

/**
 * Обработка webhook от ЮKassa
 */
const handleWebhook = async (req) => {
    try {
        // Проверяем IP адрес отправителя
        const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress;
        console.log(`📨 Webhook от IP: ${clientIP}`);
        
        // В production рекомендуется проверять IP, но для Railway может быть проксирован
        // if (!isValidYookassaIP(clientIP)) {
        //     throw new Error(`Неразрешенный IP адрес: ${clientIP}`);
        // }
        
        const signature = req.headers['x-yookassa-signature'];
        const body = JSON.stringify(req.body);
        
        // Проверяем подпись webhook (если настроена)
        if (YUKASSA_CONFIG.webhookSecret) {
            const expectedSignature = crypto
                .createHmac('sha256', YUKASSA_CONFIG.webhookSecret)
                .update(body)
                .digest('hex');
                
            if (signature !== expectedSignature) {
                throw new Error('Неверная подпись webhook');
            }
        }

        const event = req.body;
        
        if (event.event === 'payment.succeeded' && event.object) {
            const payment = event.object;
            const metadata = payment.metadata;
            
            if (metadata && metadata.telegram_id && metadata.subscription_tier) {
                // Активируем подписку
                const { error } = await supabase
                    .rpc('activate_subscription_after_payment', {
                        p_telegram_id: parseInt(metadata.telegram_id),
                        p_subscription_tier: metadata.subscription_tier,
                        p_payment_id: payment.id
                    });

                if (error) {
                    console.error('Ошибка активации подписки:', error);
                    return { success: false, error: error.message };
                }

                console.log(`✅ Подписка активирована для пользователя ${metadata.telegram_id}, тариф: ${metadata.subscription_tier}`);
                
                return {
                    success: true,
                    activated: true,
                    telegram_id: parseInt(metadata.telegram_id),
                    subscription_tier: metadata.subscription_tier
                };
            }
        }

        return { success: true, activated: false };

    } catch (error) {
        console.error('Ошибка обработки webhook:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Получение истории платежей пользователя
 */
const getUserPaymentHistory = async (telegram_id) => {
    try {
        const { data: payments, error } = await supabase
            .from('yukassa_payments')
            .select('*')
            .eq('telegram_id', telegram_id)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(error.message);
        }

        return {
            success: true,
            payments: payments || []
        };

    } catch (error) {
        console.error('Ошибка получения истории платежей:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Отмена платежа
 */
const cancelPayment = async (payment_id, reason = 'requested_by_customer') => {
    try {
        const response = await fetch(`${YUKASSA_CONFIG.apiUrl}/payments/${payment_id}/cancel`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotence-Key': crypto.randomUUID(),
                'Authorization': `Basic ${Buffer.from(`${YUKASSA_CONFIG.shopId}:${YUKASSA_CONFIG.secretKey}`).toString('base64')}`
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Ошибка отмены платежа: ${errorData.description || 'Неизвестная ошибка'}`);
        }

        const payment = await response.json();

        // Обновляем статус в базе данных
        await supabase
            .from('yukassa_payments')
            .update({
                status: 'canceled',
                metadata: payment,
                updated_at: new Date().toISOString()
            })
            .eq('payment_id', payment_id);

        return {
            success: true,
            status: payment.status
        };

    } catch (error) {
        console.error('Ошибка отмены платежа:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

module.exports = {
    createPayment,
    getQuickPaymentLink,
    checkPaymentStatus,
    handleWebhook,
    getUserPaymentHistory,
    cancelPayment,
    YUKASSA_CONFIG
}; 