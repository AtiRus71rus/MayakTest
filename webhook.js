// Псевдокод обработчика вебхука
async function handlePaymentWebhook(req, res) {
    try {
        // Шаг 1: Валидация входных данных
        const { error, value } = validateWebhookPayload(req.body);
        if (error) {
            logError('Invalid webhook payload', { error, payload: req.body });
            return res.status(400).json({ error: 'Invalid payload' });
        }
        
        // Шаг 2: Проверка подписи/секрета
        if (!verifyWebhookSignature(req.headers, req.body)) {
            logError('Invalid webhook signature', { headers: req.headers });
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const { external_payment_id, amount, currency, email, event_type } = value;
        
        // Шаг 3: Дедупликация - проверка существования события
        const existingEvent = await WebhookEvent.findOne({
            where: { external_event_id: req.body.id }
        });
        
        if (existingEvent) {
            if (existingEvent.status === 'processed') {
                logInfo('Duplicate webhook - already processed', { 
                    external_event_id: req.body.id,
                    payment_id: existingEvent.payment_id 
                });
                return res.status(200).json({ 
                    status: 'duplicate', 
                    message: 'Already processed' 
                });
            }
            
            // Если событие в процессе обработки - возвращаем 202
            if (existingEvent.status === 'processing') {
                return res.status(202).json({ 
                    status: 'processing', 
                    message: 'Already processing' 
                });
            }
        }
        
        // Шаг 4: Создание записи события в БД (для атомарности)
        const webhookEvent = await WebhookEvent.create({
            external_event_id: req.body.id,
            event_type: event_type,
            payload: req.body,
            status: 'processing'
        });
        
        // Шаг 5: Транзакция для атомарной обработки
        await sequelize.transaction(async (t) => {
            try {
                // Шаг 6: Поиск или создание пользователя
                let user = await User.findOne({ 
                    where: { email: email },
                    transaction: t
                });
                
                if (!user) {
                    user = await User.create({
                        email: email,
                        external_user_id: req.body.external_user_id || null
                    }, { transaction: t });
                }
                
                // Шаг 7: Проверка существования платежа (идемпотентность)
                let payment = await Payment.findOne({
                    where: { external_payment_id: external_payment_id },
                    transaction: t
                });
                
                if (!payment) {
                    // Шаг 8: Создание нового платежа
                    payment = await Payment.create({
                        external_payment_id: external_payment_id,
                        user_id: user.id,
                        amount: amount,
                        currency: currency,
                        status: 'completed',
                        payment_date: new Date(),
                        metadata: {
                            webhook_event_id: webhookEvent.id,
                            original_payload: req.body
                        }
                    }, { transaction: t });
                    
                    // Шаг 9: Активация или продление подписки
                    await activateOrRenewSubscription(user.id, payment, t);
                } else {
                    logInfo('Payment already exists - idempotency', { 
                        payment_id: payment.id,
                        external_payment_id: external_payment_id 
                    });
                }
                
                // Шаг 10: Обновление статуса события
                await webhookEvent.update({
                    status: 'processed',
                    processed_at: new Date()
                }, { transaction: t });
                
                // Шаг 11: Обновление связи платежа с событием
                await payment.update({
                    metadata: {
                        ...payment.metadata,
                        webhook_event_id: webhookEvent.id
                    }
                }, { transaction: t });
                
            } catch (transactionError) {
                // Откат транзакции при ошибке
                await webhookEvent.update({
                    status: 'failed',
                    error_message: transactionError.message
                }, { transaction: t });
                
                throw transactionError;
            }
        });
        
        // Шаг 12: Успешный ответ
        logSuccess('Webhook processed successfully', {
            webhook_event_id: webhookEvent.id,
            payment_id: payment.id,
            user_id: user.id
        });
        
        return res.status(200).json({ 
            status: 'success',
            webhook_event_id: webhookEvent.id,
            payment_id: payment.id
        });
        
    } catch (error) {
        logError('Webhook processing failed', { error, payload: req.body });
        
        // Критические ошибки - 500
        if (error.name === 'DatabaseError' || error.name === 'SequelizeError') {
            return res.status(500).json({ error: 'Internal server error' });
        }
        
        // Ошибки валидации - 400
        return res.status(400).json({ error: error.message });
    }
}

async function activateOrRenewSubscription(userId, payment, transaction) {
    // Поиск активной подписки пользователя
    const activeSubscription = await Subscription.findOne({
        where: {
            user_id: userId,
            status: 'active',
            end_date: { [Op.gt]: new Date() }
        },
        transaction: transaction,
        lock: transaction.LOCK.UPDATE // pessimistic lock для предотвращения race conditions
    });
    
    if (activeSubscription) {
        // Продление существующей подписки
        const newEndDate = new Date(activeSubscription.end_date);
        newEndDate.setMonth(newEndDate.getMonth() + 1); // +1 месяц
        
        await activeSubscription.update({
            end_date: newEndDate,
            updated_at: new Date()
        }, { transaction: transaction });
        
        logInfo('Subscription renewed', {
            subscription_id: activeSubscription.id,
            new_end_date: newEndDate
        });
        
    } else {
        // Создание новой подписки
        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1);
        
        await Subscription.create({
            user_id: userId,
            plan_id: payment.metadata?.plan_id || 'default',
            status: 'active',
            start_date: startDate,
            end_date: endDate,
            auto_renew: true
        }, { transaction: transaction });
        
        logInfo('New subscription created', {
            user_id: userId,
            start_date: startDate,
            end_date: endDate
        });
    }
    
    // Связь платежа с подпиской
    await payment.update({
        subscription_id: activeSubscription?.id || null
    }, { transaction: transaction });
}
