1) База данных.

Таблица Users:

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    external_user_id VARCHAR(255) UNIQUE, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

В таблицу добавил два индекса:
 - email: индекс для быстрого поиска по почте
 - external_user_id: индекс для поиска при получении вебхука

 Таблица Subscriptions:

 CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id VARCHAR(50) NOT NULL, -
    status VARCHAR(20) NOT NULL DEFAULT 'active', 
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP NOT NULL,
    auto_renew BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

Добавил сюда 3 индекса:
 - user_id + status: для поиска активных подписок пользователя
 - end_date: для работы задачи продления
 - (user_id, plan_id, status): для проверки дубликатов подписки

Таблица Payments:

 CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_payment_id VARCHAR(255) UNIQUE NOT NULL, 
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'RUB',
    status VARCHAR(20) NOT NULL DEFAULT 'pending', 
    payment_date TIMESTAMP NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

Добавил 3 индекса:
 - external_payment_id: для дедупликации вебхуков
 - user_id + status: для аналитики и отчетов
 - subscription_id: для связи с подпиской

Таблица Webhook_events:

CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_event_id VARCHAR(255) UNIQUE, 
    event_type VARCHAR(50) NOT NULL, 
    payload JSONB NOT NULL, -- полный оригинальный payload для дебага
    status VARCHAR(20) NOT NULL DEFAULT 'processing',
    error_message TEXT,
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

Добавил 3 индекса:
 - external_event_id: для дедупликации
 - status + created_at: для обработки в очереди
 - event_type: для фильтрации по типам событий



3) Edge Cases.
 
1. Webhook пришел дважды.
Решается проверкой external_event_id в таблице webhook_events
  - Если событие уже обработано (status = 'processed') → возвращаем 200 с сообщением "Already processed"
  - Если событие в процессе (status = 'processing') → возвращаем 202 "Already processing"
Гарантирует идемпотентность

2. Webhook пришел раньше создания user.
Решается с помощью автоматического создания пользователя по email из вебхука
  - Проверка существования по email или external_user_id
  - Если пользователь не найден, тогда создаем нового пользователя с минимальным набором данных
Логируем как "User auto-created from webhook"

3. Webhook пришел без email, но есть externalPaymentId.
Решается с помощью поиска по external_payment_id в таблице payments
 - Если платеж найден → обновляем существующую запись
 - Если платеж не найден → возвращаем 400 с ошибкой "Missing required fields"
Требуем минимум один уникальный идентификатор

4. Webhook пришел с другой суммой, чем план.
Решается с помощью валидации суммы в бизнес-логике:
  - Сравниваем с ожидаемой суммой для плана
  - Если расхождение > 5% → логируем предупреждение, но все равно обрабатываем
  - Если расхождение > 20% → помечаем платеж как "suspicious", требуем ручной проверки
Не блокируем обработку, но создаем алерт

5. Webhook пришел через неделю.
Решается с помощью проверки временных рамок:
  - Разрешаем обработку вебхуков в течение 30 дней
  - Если событие старше 30 дней → логируем как "stale webhook", возвращаем 200
  - Для событий 7-30 дней → обрабатываем с пометкой "delayed"
Мониторим задержки для анализа проблем с платежной системой

6. Сервер упал после записи payment, но до subscription
Решается через использование транзакций
  - Все операции в одной транзакции: создание платежа + обновление подписки + обновление статуса события
  - При падении сервера передающаяся транзакция откатывается
  - Запускаем фоновый job для проверки "зависших" событий (status = 'processing' старше 5 минут)
Джоб пытается повторить обработку или помечает как "failed"


4) Критические логи, алерты и метрики
Критические логи:
    Вход вебхука:
        Время получения, external_event_id, event_type
        Размер payload, источник IP
        Валидация:
        Результат проверки подписи
        Ошибки валидации с указанием полей
    Дедупликация:
        Обнаружение дубликата с external_event_id
        Статус предыдущей обработки
    Транзакция:
        Начало/окончание транзакции
        Созданные/обновленные сущности
        Время выполнения
    Ошибки:
        Полный стек ошибки
        Состояние БД на момент ошибки
        Повторные попытки
        Метрики:
             Counter-метрики:
                webhook_events_total{event_type, status}  // общее количество событий
                webhook_processing_errors_total{error_type}  // ошибки обработки
                payment_duplicates_total  // дубликаты платежей
                subscription_activations_total{plan_id}  // активации подписок
             Histogram-метрики:
                webhook_processing_duration_seconds{event_type}  // время обработки
                db_query_duration_seconds{query_type}  // время запросов к БД
             Gauge-метрики:
                webhook_events_processing  // количество событий в статусе "processing"
                failed_webhook_events  // количество проваленных событий


Алерты
Критические (немедленное уведомление):
    webhook_processing_errors_total > 10 за 5 минут
    failed_webhook_events > 5 за 15 минут
    Среднее время обработки > 30 секунд
Важные (уведомление в течение часа):
    webhook_events_processing > 50 (зависшие события)
    Дубликаты > 5% от общего количества
    Ошибки валидации > 10% от общего количества
Предупреждения (ежедневный отчет):
    Задержки вебхуков > 1 час
    Подозрительные суммы платежей
    Низкий процент успешных обработок (< 95%)

    
Инструменты для дебага:
Admin-панель для просмотра событий:
    Фильтрация по статусу, типу, дате
    Просмотр полного оригинального payload
    Возможность повторной обработки вручную
API для проверки состояния:
    GET /webhooks/{external_event_id} - статус обработки
    GET /payments/{external_payment_id} - информация о платеже
    GET /users/{email}/subscriptions - подписки пользователя
Инструменты восстановления:
    Скрипт для обработки зависших событий
    Механизм отмены/возврата платежей
    Ручное управление статусами подписок
