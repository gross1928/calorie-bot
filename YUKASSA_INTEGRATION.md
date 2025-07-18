# 🏦 Интеграция ЮKassa - Руководство по настройке

## 📋 Переменные окружения для Railway

Добавьте следующие переменные в настройки Railway:

```bash
# Основные настройки ЮKassa
YUKASSA_SHOP_ID=ваш_shop_id
YUKASSA_SECRET_KEY=ваш_secret_key
YUKASSA_WEBHOOK_SECRET=ваш_webhook_secret
```

## 🔧 Как получить данные ЮKassa

### 1. Shop ID и Secret Key
1. Войдите в [личный кабинет ЮKassa](https://yookassa.ru/)
2. Перейдите в раздел **"Настройки"** → **"API и webhook"**
3. Скопируйте:
   - **shopId** → `YUKASSA_SHOP_ID`
   - **Секретный ключ** → `YUKASSA_SECRET_KEY`

### 2. Настройка HTTP-уведомлений
1. В личном кабинете перейдите в **"Интеграция"** → **"HTTP-уведомления"**
2. **URL для уведомлений**: `https://ваш-домен-railway.up.railway.app/webhook/yukassa`
3. **Выбранные события** (отметьте галочками):
   - ✅ `payment.succeeded` - Успешный платёж  
   - ✅ `payment.waiting_for_capture` - Поступление платежа
   - ✅ `payment.canceled` - Отмена платежа или ошибка
4. **Секретное слово** (опционально): задайте → `YUKASSA_WEBHOOK_SECRET`

## 🚀 Что уже реализовано

### ✅ Функциональность
- **Быстрые ссылки для оплаты** (ваши существующие)
  - ПРОГРЕСС: `https://yookassa.ru/my/i/aFuvni8_S7Z9/l`
  - МАКСИМУМ: `https://yookassa.ru/my/i/aFuv3xVOei-f/l`
- **Автоматическая активация подписки** через webhook
- **Проверка статуса платежа** в боте
- **Отслеживание платежей** в базе данных

### 🔗 API Endpoints
- `POST /webhook/yukassa` - получение уведомлений от ЮKassa
- `GET /api/payment/:payment_id/status` - проверка статуса платежа
- `GET /api/user/:telegram_id/payments` - история платежей пользователя

## 🎯 Как работает система

### Пользователь оплачивает подписку:
1. Нажимает "💳 Оплатить" в боте
2. Переходит по быстрой ссылке ЮKassa
3. Совершает платеж

### Автоматическая активация:
1. ЮKassa отправляет webhook на `/webhook/yukassa`
2. Система проверяет подпись (если настроена)
3. При успешном платеже активируется подписка
4. Пользователь получает доступ к функциям

### Проверка оплаты:
1. Пользователь может нажать "🔄 Проверить оплату"
2. Система ищет платежи в базе данных
3. Показывает статус и активирует подписку

## 🗄️ База данных

Создана таблица `yukassa_payments` для отслеживания:
- ID платежа от ЮKassa
- Telegram ID пользователя
- Сумма и тариф
- Статус платежа
- Время создания и оплаты

## ⚠️ Важные моменты

1. **Webhook URL**: Обязательно настройте в ЮKassa через "HTTP-уведомления"
2. **HTTPS**: Railway автоматически предоставляет HTTPS (обязательно для ЮKassa)
3. **Порты**: ЮKassa поддерживает только 443 и 8443 (Railway использует 443)
4. **Безопасность**: 
   - Webhook secret защищает от подделки уведомлений
   - IP-адреса ЮKassa проверяются автоматически
   - Обязательно используйте HTTPS/TLS 1.2+
5. **Тестирование**: Используйте тестовый режим ЮKassa для проверки

## 🔒 Безопасность

### IP-адреса ЮKassa
Уведомления приходят только с официальных IP:
- `185.71.76.0/27`, `185.71.77.0/27`
- `77.75.153.0/25`, `77.75.154.128/25`
- `77.75.156.11`, `77.75.156.35`
- `2a02:5180::/32` (IPv6)

### Аутентификация уведомлений
- **По IP**: Автоматическая проверка отправителя
- **По подписи**: HMAC-SHA256 с секретным ключом
- **По статусу**: Дополнительная проверка через API

## 🔍 Мониторинг

### Логи платежей
Все события платежей логируются с префиксами:
- `📨 Получен webhook от ЮKassa`
- `✅ Подписка активирована через webhook`
- `❌ Ошибка обработки webhook`

### Проверка работы
- `GET /health` - статус сервера
- Логи Railway покажут webhook запросы
- В боте кнопка "🔄 Проверить оплату"

## 🎉 Готово к использованию!

После настройки переменных на Railway система автоматически:
- Принимает платежи по вашим ссылкам
- Активирует подписки пользователям
- Ведет учет всех транзакций
- Предоставляет API для мониторинга 