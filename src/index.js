import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, assertRequiredConfig } from './config.js'
import { ConversationStore } from './state.js'
import { getSettings, loadSettings, updateSettings } from './settings.js'
import {
  getCatalog,
  createWhatsappOrder,
  findOrder,
  getWhatsappOrdersPendingConfirmationNotice,
  getWhatsappDeliveryOrdersPendingDispatchNotice,
  markWhatsappConfirmationSent,
  markWhatsappDispatchSent,
  testFirestoreWrite,
} from './firebase.js'
import { understandMessage } from './gemini.js'
import { WhatsappClient } from './whatsapp.js'

assertRequiredConfig()
await loadSettings()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const menuImagePath = path.resolve(__dirname, '..', 'assets', 'menu-burger-lab.png')
const deliveryTariffImagePath = path.resolve(__dirname, '..', 'assets', 'delivery-tarifario.png')
const paymentQrImagePath = path.resolve(__dirname, '..', 'assets', 'qr-pago-burger-lab.png')
const botVersion = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'local'

let botEnabled = config.botEnabled
let acceptingOrders = getSettings().acceptingOrders
const conversations = new ConversationStore(config.conversationStatePath)
await conversations.load()
let catalogCache = null
let catalogCacheAt = 0
const fallbackCatalog = {
  categories: [],
  products: [
    { id: 'burger-lab-simple-con-papas', name: 'Burger Lab Simple Con Papas', price: 22, categoryId: 'hamburguesas', extras: [] },
    { id: 'burger-lab-simple-sin-papas', name: 'Burger Lab Simple Sin Papas', price: 19, categoryId: 'hamburguesas', extras: [] },
    { id: 'burger-lab-doble-con-papas', name: 'Burger Lab DOBLE Con Papas', price: 37, categoryId: 'hamburguesas', extras: [] },
    { id: 'burger-lab-doble-sin-papas', name: 'Burger Lab DOBLE Sin Papas', price: 34, categoryId: 'hamburguesas', extras: [] },
    { id: 'bbq-simple-con-papas', name: 'BBQ Simple Con Papas', price: 23, categoryId: 'hamburguesas', extras: [] },
    { id: 'bbq-simple-sin-papas', name: 'BBQ Simple Sin Papas', price: 20, categoryId: 'hamburguesas', extras: [] },
    { id: 'bbq-doble-con-papas', name: 'BBQ DOBLE Con Papas', price: 38, categoryId: 'hamburguesas', extras: [] },
    { id: 'bbq-doble-sin-papas', name: 'BBQ DOBLE Sin Papas', price: 35, categoryId: 'hamburguesas', extras: [] },
    { id: 'coca-cola-300-ml', name: 'Coca Cola 300 ml', price: 5, categoryId: 'gaseosas', extras: [] },
    { id: 'coca-cola-zero-300-ml', name: 'Coca Cola Zero 300 ml', price: 5, categoryId: 'gaseosas', extras: [] },
    { id: 'sprite-300-ml', name: 'Sprite 300 ml', price: 5, categoryId: 'gaseosas', extras: [] },
    { id: 'fanta-naranja-300-ml', name: 'Fanta Naranja 300 ml', price: 5, categoryId: 'gaseosas', extras: [] },
    { id: 'fanta-papaya-300-ml', name: 'Fanta Papaya 300 ml', price: 5, categoryId: 'gaseosas', extras: [] },
    { id: 'fanta-guarana-300-ml', name: 'Fanta Guarana 300 ml', price: 5, categoryId: 'gaseosas', extras: [] },
    { id: 'agua-vital-350-ml', name: 'Agua Vital 350 ml', price: 5, categoryId: 'agua', extras: [] },
    { id: 'pulpa-de-moconchinchi-330-ml', name: 'Pulpa de Moconchinchi 330 ml', price: 5, categoryId: 'refrescos-hervidos', extras: [] },
    { id: 'pulpa-de-moconchinchi-2-litros', name: 'Pulpa de Moconchinchi 2 Litros', price: 20, categoryId: 'refrescos-hervidos', extras: [] },
    { id: 'tamarindo-330-ml', name: 'Tamarindo 330 ml', price: 5, categoryId: 'refrescos-hervidos', extras: [] },
    { id: 'tamarindo-2-litros', name: 'Tamarindo 2 Litros', price: 20, categoryId: 'refrescos-hervidos', extras: [] },
    { id: 'flor-de-jamaica-330-ml', name: 'Flor de Jamaica 330 ml', price: 5, categoryId: 'refrescos-hervidos', extras: [] },
    { id: 'flor-de-jamaica-2-litros', name: 'Flor de Jamaica 2 Litros', price: 20, categoryId: 'refrescos-hervidos', extras: [] },
  ],
}

const whatsapp = new WhatsappClient({
  onMessage: async ({ chatId, text }) => {
    if (!botEnabled) return

    await refreshTemporarySettings()
    const settings = getSettings()

    if (!settings.autoRepliesEnabled) return

    if (!acceptingOrders) {
      await whatsapp.sendText(
        chatId,
        settings.pausedOrdersMessage,
      )
      return
    }

    if (!isWithinBusinessHours()) {
      await whatsapp.sendText(
        chatId,
        settings.closedMessage,
      )
      return
    }

    conversations.add(chatId, 'cliente', text)
    const state = conversations.get(chatId)
    const isFirstCustomerMessage = state.messages.filter((entry) => entry.role === 'cliente').length === 1
    await whatsapp.startTyping(chatId)

    try {
      if (state.awaitingPaymentProof) {
        const inferred = inferFieldsFromText(text)
        if (inferred.deliveryAddress) {
          state.awaitingPaymentProof.orderInput.deliveryAddress = inferred.deliveryAddress
          conversations.scheduleSave()
        }
        if (isPaymentProofMessage(text)) {
          state.awaitingPaymentProof.proofReceived = true
          conversations.scheduleSave()
        }

        if (state.awaitingPaymentProof.orderInput.fulfillmentType === 'delivery' && !state.awaitingPaymentProof.orderInput.deliveryAddress) {
          const reply = state.awaitingPaymentProof.proofReceived
            ? 'Perfecto, ya recibi el comprobante. Solo me falta tu ubicacion de WhatsApp o direccion exacta para pasar el pedido a caja.'
            : 'Ya tengo tu pedido listo para QR. Por favor enviame el comprobante y tu ubicacion de WhatsApp o direccion exacta para el envio.'
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        if (state.awaitingPaymentProof.proofReceived) {
          const orderInput = {
            ...state.awaitingPaymentProof.orderInput,
            qrProofReceived: true,
            paymentReviewNote: 'Cliente envio comprobante QR por WhatsApp. Caja debe revisarlo antes de confirmar pago.',
          }
          const created = await createWhatsappOrderWithRetry(orderInput)
          conversations.setLastOrder(chatId, created.orderId)

          const reply = [
            'Perfecto, recibi tu comprobante.',
            'Voy a pasar tu pedido a caja para que revisen el pago y confirmen el tiempo de salida.',
          ].join('\n')

          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        if (isCancelText(text)) {
          state.awaitingPaymentProof = null
          conversations.scheduleSave()
          const reply = 'Sin problema. Dejamos el pago pendiente; si quieres continuar, me mandas el comprobante o actualizamos el metodo de pago.'
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        const reply = 'Para avanzar con tu pedido por QR, por favor enviame el comprobante de pago por este chat. Caja lo revisara antes de confirmar.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (state.pendingOrder && isConfirmText(text)) {
        if (state.pendingOrder.orderInput.expectedPaymentMethod === 'qr') {
          await requestQrPaymentProof(chatId, state.pendingOrder.orderInput, state.pendingOrder.summary)
          return
        }

        const created = await createWhatsappOrderWithRetry(state.pendingOrder.orderInput)
        conversations.setLastOrder(chatId, created.orderId)

        const reply = [
          'Perfecto, registre tu pedido.',
          'En caja lo van a confirmar y te aviso el tiempo exacto de salida.',
        ].join('\n')

        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (state.pendingOrder && isCancelText(text)) {
        state.pendingOrder = null
        conversations.scheduleSave()
        const reply = 'Sin problema. Lo dejamos pendiente; si quieres cambiar algo, mandame el pedido actualizado y lo armamos bien.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (state.pendingOrder && isSummaryRequest(text)) {
        const reply = `${state.pendingOrder.summary}\n\nAun tengo este pedido listo. Respondeme "Si" para confirmarlo o "No" para cancelarlo.`
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (!state.pendingOrder && !state.orderDraft?.items?.length && state.lastOrderId && isThanksText(text)) {
        const reply = 'Con gusto, gracias a ti. Estamos atentos a tu pedido.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      const shouldSendMenuForOrderStart = isFirstCustomerMessage && isOrderStartRequest(text)
      if (isMenuRequest(text) || shouldSendMenuForOrderStart) {
        const caption = 'Claro, te paso nuestro menu. Cuando quieras pedir, mandame tu nombre, pedido, metodo de pago y si es recojo o envio.'
        conversations.add(chatId, 'bot', caption)
        await whatsapp.sendImage(chatId, menuImagePath, caption)
        if (!looksLikeConcreteOrderText(text)) return
      }

      if (isDeliveryPricingRequest(text)) {
        await sendDeliveryPricingInfo(chatId)
        return
      }

      if (isPaymentQrRequest(text) && !state.pendingOrder && !looksLikeConcreteOrderText(text)) {
        await sendPaymentQrInfo(chatId)
        return
      }

      if (isRestaurantLocationRequest(text)) {
        const reply = 'Claro, te envio la ubicacion de Burger Lab.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        await whatsapp.sendLocation(chatId, {
          latitude: config.restaurantLatitude,
          longitude: config.restaurantLongitude,
          name: config.businessName,
          address: config.restaurantAddress,
        })
        return
      }

      const catalog = await getCatalogForParsing()
      const quickResult = inferSimpleOrderFromCatalog(text, catalog)
      if (quickResult.items.length || (state.orderDraft?.items?.length && hasUsefulInferredFields(text))) {
        const baseDraft = state.orderDraft || buildEmptyAiResult()
        const deterministicResult = quickResult.items.length ? quickResult : buildEmptyAiResult()
        const mergedResult = mergeOrderDraft(baseDraft, deterministicResult, text)
        conversations.setOrderDraft(chatId, mergedResult)
        const missingFields = getMissingOrderFields(mergedResult)
        if (missingFields.length > 0) {
          if (shouldProceedWithQrWhileWaitingLocation(mergedResult, missingFields)) {
            const orderInput = buildOrderInput({ result: mergedResult, chatId })
            const summary = buildOrderSummary(orderInput)
            await requestQrPaymentProof(chatId, orderInput, summary)
            return
          }
          const reply = buildMissingFieldsReply(missingFields)
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        const orderInput = buildOrderInput({ result: mergedResult, chatId })
        if (orderInput.fulfillmentType === 'delivery' && orderInput.deliveryQuoteStatus === 'missing_location') {
          const reply = 'Perfecto, ya tengo tu pedido. Para cotizar el envio necesito que me mandes tu ubicacion de WhatsApp, por favor.'
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        const summary = buildOrderSummary(orderInput)
        if (orderInput.expectedPaymentMethod === 'qr') {
          await requestQrPaymentProof(chatId, orderInput, summary)
          return
        }
        conversations.setPendingOrder(chatId, orderInput, summary)
        const reply = `${summary}\n\nConfirmas el pedido?`
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (state.orderDraft?.items?.length && hasUsefulInferredFields(text)) {
        const mergedResult = mergeOrderDraft(state.orderDraft, buildEmptyAiResult(), text)
        conversations.setOrderDraft(chatId, mergedResult)
        const missingFields = getMissingOrderFields(mergedResult)
        if (missingFields.length > 0) {
          if (shouldProceedWithQrWhileWaitingLocation(mergedResult, missingFields)) {
            const orderInput = buildOrderInput({ result: mergedResult, chatId })
            const summary = buildOrderSummary(orderInput)
            await requestQrPaymentProof(chatId, orderInput, summary)
            return
          }
          const reply = buildMissingFieldsReply(missingFields)
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        const orderInput = buildOrderInput({ result: mergedResult, chatId })
        const summary = buildOrderSummary(orderInput)
        if (orderInput.expectedPaymentMethod === 'qr') {
          await requestQrPaymentProof(chatId, orderInput, summary)
          return
        }
        conversations.setPendingOrder(chatId, orderInput, summary)
        const reply = `${summary}\n\nConfirmas el pedido?`
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      const result = await understandMessage({
        message: text,
        conversation: state.messages,
        catalog,
      })

      if (result.intent === 'confirm_order' && state.pendingOrder) {
        if (state.pendingOrder.orderInput.expectedPaymentMethod === 'qr') {
          await requestQrPaymentProof(chatId, state.pendingOrder.orderInput, state.pendingOrder.summary)
          return
        }

        const created = await createWhatsappOrderWithRetry(state.pendingOrder.orderInput)
        conversations.setLastOrder(chatId, created.orderId)

        const reply = [
          'Perfecto, registre tu pedido.',
          'En caja lo van a confirmar y te aviso el tiempo exacto de salida.',
        ].join('\n')

        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (result.intent === 'cancel_order' && state.pendingOrder) {
        state.pendingOrder = null
        conversations.scheduleSave()
        const reply = 'Sin problema. Lo dejamos pendiente; si quieres cambiar algo, mandame el pedido actualizado y lo armamos bien.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (result.intent === 'delivery_pricing') {
        await sendDeliveryPricingInfo(chatId)
        return
      }

      if (result.intent === 'payment_qr_request' && !state.pendingOrder && !result.items.length) {
        await sendPaymentQrInfo(chatId)
        return
      }

      if (result.intent === 'human_help') {
        await notifyHumanSupport(chatId, text)
        const reply = getSettings().humanHelpMessage
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      const mergedResult = mergeOrderDraft(state.orderDraft, result, text)
      conversations.setOrderDraft(chatId, mergedResult)
      const missingFields = getMissingOrderFields(mergedResult)
      if (mergedResult.items.length > 0 && missingFields.length > 0) {
        if (shouldProceedWithQrWhileWaitingLocation(mergedResult, missingFields)) {
          const orderInput = buildOrderInput({ result: mergedResult, chatId })
          const summary = buildOrderSummary(orderInput)
          await requestQrPaymentProof(chatId, orderInput, summary)
          return
        }
        const reply = buildMissingFieldsReply(missingFields)
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (mergedResult.items.length > 0 && missingFields.length === 0) {
        const orderInput = buildOrderInput({ result: mergedResult, chatId })
        if (orderInput.fulfillmentType === 'delivery' && orderInput.deliveryQuoteStatus === 'missing_location') {
          const reply = 'Para cotizar el envio automaticamente necesito que me mandes tu ubicacion de WhatsApp. Asi calculo la distancia y te paso el total con envio.'
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }
        const summary = buildOrderSummary(orderInput)
        if (orderInput.expectedPaymentMethod === 'qr') {
          await requestQrPaymentProof(chatId, orderInput, summary)
          return
        }
        conversations.setPendingOrder(chatId, orderInput, summary)
        const reply = `${summary}\n\nConfirmas el pedido?`

        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (result.intent === 'confirm_order' && !state.pendingOrder) {
        const reply = 'Claro. Antes de confirmarlo necesito tener el pedido completo: nombre, pedido, metodo de pago y si es recojo o envio.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      conversations.add(chatId, 'bot', result.reply)
      await whatsapp.sendText(chatId, result.reply)
    } catch (error) {
      console.error('Error procesando mensaje:', error)
      const recovered = await tryRecoverOrderFromText(chatId, text, state)
      if (recovered.handled) {
        if (recovered.reply) {
          conversations.add(chatId, 'bot', recovered.reply)
          await whatsapp.sendText(chatId, recovered.reply)
        }
        return
      }

      const reply = buildContextualRecoveryReply(state)
      conversations.add(chatId, 'bot', reply)
      await whatsapp.sendText(chatId, reply)
    }
  },
})

async function refreshTemporarySettings() {
  const settings = getSettings()
  if (
    settings.acceptingOrders === false &&
    settings.acceptingOrdersPausedUntil &&
    new Date(settings.acceptingOrdersPausedUntil).getTime() <= Date.now()
  ) {
    const nextSettings = await updateSettings({
      acceptingOrders: true,
      acceptingOrdersPausedUntil: '',
      acceptingOrdersPauseReason: '',
    })
    acceptingOrders = nextSettings.acceptingOrders
    return nextSettings
  }

  acceptingOrders = settings.acceptingOrders
  return settings
}

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.BOT_CORS_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

app.get('/health', async (_req, res) => {
  try {
    await refreshTemporarySettings()
    const settings = getSettings()
    res.json({
      ok: true,
      version: botVersion,
      botEnabled,
      acceptingOrders,
      acceptingOrdersPausedUntil: settings.acceptingOrdersPausedUntil,
      acceptingOrdersPauseReason: settings.acceptingOrdersPauseReason,
      autoRepliesEnabled: settings.autoRepliesEnabled,
      whatsappConnected: whatsapp.connected,
    })
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Health failed' })
  }
})

app.get('/settings', requireToken, (_req, res) => {
  res.json({ ok: true, settings: getSettings() })
})

app.post('/settings', requireToken, async (req, res) => {
  const settings = await updateSettings(req.body || {})
  acceptingOrders = settings.acceptingOrders
  res.json({ ok: true, settings })
})

app.get('/whatsapp/groups', requireToken, async (_req, res) => {
  const groups = await whatsapp.listGroups()
  res.json({ ok: true, groups })
})

app.get('/whatsapp/qr', requireToken, async (_req, res) => {
  try {
    const qrBuffer = await fs.readFile(config.qrPath)
    res.json({
      ok: true,
      connected: whatsapp.connected,
      qrDataUrl: `data:image/png;base64,${qrBuffer.toString('base64')}`,
    })
  } catch {
    res.status(404).json({ ok: false, connected: whatsapp.connected, error: 'No hay QR disponible. Cierra sesion o reconecta WhatsApp para generar uno nuevo.' })
  }
})

app.post('/whatsapp/logout', requireToken, async (_req, res) => {
  await whatsapp.logout()
  await fs.rm(config.authDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(config.qrPath, { force: true }).catch(() => undefined)
  setTimeout(() => void whatsapp.start(), 1500)
  res.json({ ok: true })
})

app.get('/debug/firebase-write', requireToken, async (_req, res) => {
  try {
    const result = await testFirestoreWrite()
    res.json({ ok: true, result })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Firestore write failed',
      code: error?.code || '',
    })
  }
})

app.post('/bot/on', requireToken, (_req, res) => {
  botEnabled = true
  res.json({ ok: true, botEnabled })
})

app.post('/bot/off', requireToken, (_req, res) => {
  botEnabled = false
  res.json({ ok: true, botEnabled })
})

app.post('/orders/accepting/on', requireToken, async (_req, res) => {
  acceptingOrders = true
  const settings = await updateSettings({
    acceptingOrders: true,
    acceptingOrdersPausedUntil: '',
    acceptingOrdersPauseReason: '',
  })
  res.json({ ok: true, acceptingOrders, settings })
})

app.post('/orders/accepting/off', requireToken, async (req, res) => {
  const pausedUntil = typeof req.body?.pausedUntil === 'string' ? req.body.pausedUntil : ''
  const pauseReason = typeof req.body?.pauseReason === 'string' ? req.body.pauseReason : ''
  acceptingOrders = false
  const settings = await updateSettings({
    acceptingOrders: false,
    acceptingOrdersPausedUntil: pausedUntil,
    acceptingOrdersPauseReason: pauseReason,
  })
  res.json({ ok: true, acceptingOrders, settings })
})

app.post('/orders/:orderId/confirmed', requireToken, async (req, res) => {
  const order = await findOrder(req.params.orderId)
  if (!order) {
    res.status(404).json({ ok: false, error: 'Pedido no encontrado.' })
    return
  }

  const delayMinutes = Number(req.body?.delayMinutes || order.estimatedDelay || config.defaultDelayMinutes)
  const chatId = order.whatsappChatId || phoneToChatId(order.customerPhone)
  if (!chatId) {
    res.status(400).json({ ok: false, error: 'El pedido no tiene chat o telefono valido.' })
    return
  }

  await whatsapp.sendText(
    chatId,
    buildConfirmationMessage(delayMinutes),
  )
  await markWhatsappConfirmationSent(order)
  await notifyDeliveryGroupOrderConfirmed(order, delayMinutes)

  res.json({ ok: true })
})

await whatsapp.start()
startConfirmationNoticePolling()

const server = app.listen(config.port, () => {
  console.log(`Bot API escuchando en http://localhost:${config.port}`)
})

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (error) => {
  console.error('Promesa no manejada en el bot:', error)
})

function shutdown(signal) {
  console.log(`Cerrando bot por ${signal}...`)
  server.close(() => {
    console.log('Servidor HTTP cerrado correctamente.')
    process.exit(0)
  })

  setTimeout(() => process.exit(0), 5000).unref()
}

async function requestQrPaymentProof(chatId, orderInput, summary) {
  conversations.setAwaitingPaymentProof(chatId, orderInput, summary)
  const deliveryLine = orderInput.fulfillmentType === 'delivery'
    ? orderInput.deliveryAddress
      ? 'El envio se paga directamente al delivery.'
      : 'Como es envio, tambien necesito tu ubicacion de WhatsApp o direccion exacta.'
    : 'Caja revisara el comprobante antes de confirmar el pedido.'
  const caption = [
    summary,
    '',
    'Te paso el QR del restaurante para pagar el pedido.',
    `Total a pagar por QR: Bs ${orderInput.total}.`,
    getSettings().qrPaymentMessage,
    deliveryLine,
  ].join('\n')

  conversations.add(chatId, 'bot', caption)
  await whatsapp.sendImage(chatId, paymentQrImagePath, caption)
}

async function createWhatsappOrderWithRetry(orderInput) {
  try {
    return await createWhatsappOrder(orderInput)
  } catch (error) {
    console.error('No se pudo registrar pedido en caja. Reintentando:', error)
    await sleep(700)
    return createWhatsappOrder(orderInput)
  }
}

async function sendDeliveryPricingInfo(chatId) {
  const caption = getSettings().deliveryPricingMessage

  conversations.add(chatId, 'bot', caption)
  await whatsapp.sendImage(chatId, deliveryTariffImagePath, caption)
  await whatsapp.sendLocation(chatId, {
    latitude: config.restaurantLatitude,
    longitude: config.restaurantLongitude,
    name: config.businessName,
    address: config.restaurantAddress,
  })
}

async function sendPaymentQrInfo(chatId) {
  const caption = [
    'Claro, puedes pagar por QR.',
    'Cuando hagas tu pedido te pedire el comprobante por este chat para que caja revise el pago antes de confirmarlo.',
    'Si es delivery, el envio se paga directamente al repartidor.',
  ].join('\n')

  conversations.add(chatId, 'bot', caption)
  await whatsapp.sendImage(chatId, paymentQrImagePath, caption)
}

async function notifyHumanSupport(chatId, customerMessage) {
  const targetChatId = await resolveOwnerAlertChatId()
  if (!targetChatId) return

  const message = [
    'Intervencion requerida del bot.',
    `Cliente: ${chatId}`,
    `Mensaje: ${customerMessage}`,
    'El bot no respondio ese punto para evitar dar informacion incorrecta.',
  ].join('\n')

  await whatsapp.sendText(targetChatId, message)
}

async function notifyDeliveryGroupOrderConfirmed(order, delayMinutes) {
  if (order.fulfillmentType !== 'delivery') return

  const targetChatId = await resolveDeliveryGroupChatId()
  if (!targetChatId) return

  const items = (order.items || [])
    .map((item) => {
      const extras = item.modifiers?.extras?.length ? ` Extras: ${item.modifiers.extras.map((extra) => extra.name).join(', ')}` : ''
      const options = item.modifiers?.options?.length ? ` Opciones: ${item.modifiers.options.join(', ')}` : ''
      const note = item.modifiers?.note ? ` Obs: ${item.modifiers.note}` : ''
      return `- ${item.quantity} x ${item.name}${extras}${options}${note}`
    })
    .join('\n')

  const message = [
    `Delivery confirmado ${order.displayNumber || ''}`.trim(),
    `Recoger en ${delayMinutes} minutos.`,
    `Cliente: ${order.customerName || 'Cliente WhatsApp'}`,
    order.customerPhone ? `Telefono: ${order.customerPhone}` : '',
    `Ubicacion/direccion: ${order.deliveryAddress || 'Pendiente en caja'}`,
    'Pedido:',
    items,
    `Total productos: Bs ${order.productSubtotal ?? order.total}`,
    'El envio lo cobra el delivery al cliente.',
  ].filter(Boolean).join('\n')

  await whatsapp.sendText(targetChatId, message)
}

async function resolveDeliveryGroupChatId() {
  const settings = getSettings()
  if (settings.deliveryGroupId) return settings.deliveryGroupId
  return whatsapp.findGroupIdBySubject(settings.deliveryGroupName)
}

async function resolveOwnerAlertChatId() {
  const settings = getSettings()
  if (settings.ownerAlertChatId) return settings.ownerAlertChatId
  return whatsapp.findGroupIdBySubject(settings.ownerAlertGroupName)
}

async function getCachedCatalog() {
  const now = Date.now()
  if (catalogCache && now - catalogCacheAt < 120000) {
    return catalogCache
  }

  catalogCache = await getCatalog()
  catalogCacheAt = now
  return catalogCache
}

async function getCatalogForParsing() {
  try {
    return await getCachedCatalog()
  } catch (error) {
    console.error('No se pudo leer catalogo desde Firebase. Usando catalogo de respaldo:', error)
    return fallbackCatalog
  }
}

function mergeOrderDraft(previous, result, text) {
  const inferred = inferFieldsFromText(text)
  return {
    ...result,
    items: result.items.length ? result.items : previous?.items ?? [],
    customerName: result.customerName || inferred.customerName || previous?.customerName || '',
    customerPhone: result.customerPhone || previous?.customerPhone || '',
    paymentMethod: result.paymentMethod || inferred.paymentMethod || previous?.paymentMethod || null,
    fulfillmentType: result.fulfillmentType || inferred.fulfillmentType || previous?.fulfillmentType || null,
    deliveryAddress: result.deliveryAddress || inferred.deliveryAddress || previous?.deliveryAddress || '',
  }
}

function inferFieldsFromText(text) {
  const normalized = normalizeText(text)
  const paymentMethod = /\bqr\b/.test(normalized)
    ? 'qr'
    : /\b(efectivo|cash)\b/.test(normalized)
      ? 'cash'
      : /\b(mixto|ambos)\b/.test(normalized)
      ? 'mixed'
      : null
  const fulfillmentType = /\b(envio|delivery|domicilio)\b/.test(normalized)
    ? 'delivery'
    : /\b(recojo|recoger|retiro|retirar|local)\b/.test(normalized)
      ? 'pickup'
      : null
  const rawText = String(text || '')
  const deliveryAddress = /https:\/\/maps\.google\.com\/\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/i.test(rawText)
    ? rawText.match(/https:\/\/maps\.google\.com\/\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/i)?.[0] || rawText
    : ''
  const introducedName = rawText.match(/\b(?:soy|nombre|me llamo)\s+([\p{L}]{3,}(?:\s+[\p{L}]{3,})?)/iu)?.[1]?.trim()
  const possibleName = rawText
    .split(/[\n,]/)
    .map((part) => part.trim())
    .find((part) => isLikelyCustomerName(part))

  return {
    paymentMethod,
    fulfillmentType,
    customerName: introducedName || possibleName || '',
    deliveryAddress,
  }
}

function isLikelyCustomerName(value) {
  if (!/^[\p{L}]{3,}(?:\s+[\p{L}]{3,})?$/u.test(value)) return false
  const normalized = normalizeText(value)
  if (/\b(qr|efectivo|mixto|pago|envio|delivery|domicilio|recojo|retiro|local|ubicacion|whatsapp|burger|hamburguesa|papas|coca|fanta|sprite|agua)\b/.test(normalized)) return false
  return true
}
function hasUsefulInferredFields(text) {
  const inferred = inferFieldsFromText(text)
  return Boolean(inferred.customerName || inferred.paymentMethod || inferred.fulfillmentType || inferred.deliveryAddress)
}

function buildEmptyAiResult() {
  return {
    intent: 'order_draft',
    reply: '',
    missingFields: [],
    customerName: '',
    customerPhone: '',
    paymentMethod: null,
    fulfillmentType: null,
    deliveryAddress: '',
    items: [],
  }
}

function inferSimpleOrderFromCatalog(text, catalog) {
  const normalized = normalizeText(text)
  const flexibleItems = inferFlexibleMenuItems(normalized, catalog)
  const products = [...(catalog.products || [])]
    .filter((product) => product.isVisible !== false && product.isActive !== false)
    .sort((left, right) => normalizeText(right.name).length - normalizeText(left.name).length)
  const matched = [...flexibleItems]

  for (const product of products) {
    const productName = normalizeText(product.name)
    if (!productName || !normalized.includes(productName)) continue
    if (matched.some((item) => item.productId === product.id)) continue
    matched.push({
      productId: product.id,
      name: product.name,
      basePrice: Number(product.price || 0),
      quantity: inferQuantityBeforeProduct(normalized, productName),
      note: inferItemNoteFromText(normalized),
      options: [],
      extras: [],
    })
  }

  return {
    ...buildEmptyAiResult(),
    items: matched,
  }
}

function inferFlexibleMenuItems(normalizedText, catalog) {
  const matched = []

  const addProduct = (productId, quantity = 1, note = inferItemNoteFromText(normalizedText)) => {
    const product = findCatalogProduct(catalog, productId)
    if (!product || matched.some((item) => item.productId === product.id)) return
    matched.push({
      productId: product.id,
      name: product.name,
      basePrice: Number(product.price || 0),
      quantity,
      note,
      options: [],
      extras: inferExtrasFromText(normalizedText, product),
    })
  }

  if (/\bbbq\b/.test(normalizedText)) {
    const size = /\bdoble\b/.test(normalizedText) ? 'doble' : 'simple'
    const papas = /\bsin\s+papas?\b/.test(normalizedText) ? 'sin-papas' : 'con-papas'
    addProduct(`bbq-${size}-${papas}`, inferQuantityBeforeProduct(normalizedText, 'bbq'))
  }

  if (/\b(burger lab|burguer lab|burger|hamburguesa)\b/.test(normalizedText) && !/\bbbq\b/.test(normalizedText)) {
    const size = /\bdoble\b/.test(normalizedText) ? 'doble' : 'simple'
    const papas = /\bsin\s+papas?\b/.test(normalizedText) ? 'sin-papas' : 'con-papas'
    addProduct(`burger-lab-${size}-${papas}`, inferQuantityBeforeProduct(normalizedText, 'burger'))
  }

  if (/\bcoca\b/.test(normalizedText)) {
    addProduct(/\bzero\b/.test(normalizedText) ? 'coca-cola-zero-300-ml' : 'coca-cola-300-ml', inferQuantityBeforeProduct(normalizedText, 'coca'))
  }

  if (/\bsprite\b/.test(normalizedText)) addProduct('sprite-300-ml', inferQuantityBeforeProduct(normalizedText, 'sprite'))
  if (/\bfanta\b/.test(normalizedText)) {
    const id = /\bpapaya\b/.test(normalizedText)
      ? 'fanta-papaya-300-ml'
      : /\bguarana\b/.test(normalizedText)
        ? 'fanta-guarana-300-ml'
        : 'fanta-naranja-300-ml'
    addProduct(id, inferQuantityBeforeProduct(normalizedText, 'fanta'))
  }

  if (/\bagua\b/.test(normalizedText)) addProduct('agua-vital-350-ml', inferQuantityBeforeProduct(normalizedText, 'agua'))
  if (/\bmoco(?:chinchi|nchinchi|conchinchi)\b/.test(normalizedText)) {
    addProduct(/\b(2\s*l|2l|dos\s+litros?)\b/.test(normalizedText) ? 'pulpa-de-moconchinchi-2-litros' : 'pulpa-de-moconchinchi-330-ml', inferQuantityBeforeProduct(normalizedText, 'moco'))
  }
  if (/\btamarindo\b/.test(normalizedText)) {
    addProduct(/\b(2\s*l|2l|dos\s+litros?)\b/.test(normalizedText) ? 'tamarindo-2-litros' : 'tamarindo-330-ml', inferQuantityBeforeProduct(normalizedText, 'tamarindo'))
  }
  if (/\bjamaica\b/.test(normalizedText)) {
    addProduct(/\b(2\s*l|2l|dos\s+litros?)\b/.test(normalizedText) ? 'flor-de-jamaica-2-litros' : 'flor-de-jamaica-330-ml', inferQuantityBeforeProduct(normalizedText, 'jamaica'))
  }

  return matched
}

function findCatalogProduct(catalog, productId) {
  return (catalog.products || []).find((product) => product.id === productId && product.isVisible !== false && product.isActive !== false)
}

function inferQuantityBeforeProduct(normalizedText, normalizedProductName) {
  const index = normalizedText.indexOf(normalizedProductName)
  const before = index > 0 ? normalizedText.slice(Math.max(0, index - 18), index) : ''
  const numberMatch = before.match(/\b([2-9])\s*(x|de)?\s*$/)
  if (numberMatch) return Number(numberMatch[1])
  if (/\b(dos)\s*$/.test(before)) return 2
  if (/\b(tres)\s*$/.test(before)) return 3
  return 1
}

function inferItemNoteFromText(normalizedText) {
  const notes = []
  const checks = [
    ['sin mantequilla', /\bsin mantequilla\b/],
    ['sin salsa', /\bsin salsa\b/],
    ['sin salsa de la casa', /\bsin salsa de la casa\b/],
    ['sin salsa bbq', /\bsin (salsa )?bbq\b/],
    ['sin cebolla', /\bsin cebolla\b/],
    ['sin queso', /\bsin queso\b/],
    ['salsa aparte', /\bsalsa aparte\b/],
    ['doble llajua', /\b(doble|extra)\s+(llajua|salsa picante)\b/],
    ['llajua', /\b(llajua|salsa picante|picante)\b/],
  ]

  for (const [label, pattern] of checks) {
    if (pattern.test(normalizedText) && !notes.includes(label)) notes.push(label)
  }

  return notes.join(', ')
}

function inferExtrasFromText(normalizedText, product) {
  const availableExtras = Array.isArray(product.extras) ? product.extras : []
  const extras = []

  for (const extra of availableExtras) {
    const extraName = normalizeText(extra.name)
    if (!extraName) continue
    if (extraName === 'salsa golf' && /\b(salsa\s+)?golf\b/.test(normalizedText)) extras.push(extra)
    if (extraName === 'salsa bbq' && /\bsalsa\s+bbq\b/.test(normalizedText)) extras.push(extra)
  }

  return extras
}

function getMissingOrderFields(result) {
  const missing = []
  if (!result.customerName) missing.push('tu nombre')
  if (!result.paymentMethod) missing.push('tu metodo de pago')
  if (!result.fulfillmentType) missing.push('si es recojo o envio')
  if (result.fulfillmentType === 'delivery' && !result.deliveryAddress) missing.push('tu ubicacion de WhatsApp')
  return missing
}

function shouldProceedWithQrWhileWaitingLocation(result, missingFields) {
  return result.items.length > 0 &&
    result.paymentMethod === 'qr' &&
    result.fulfillmentType === 'delivery' &&
    missingFields.length === 1 &&
    missingFields[0] === 'tu ubicacion de WhatsApp'
}

function buildMissingFieldsReply(missingFields) {
  return `Ya tengo el pedido avanzado. Para terminar de registrarlo, me falta: ${missingFields.join(', ')}.`
}

function buildContextualRecoveryReply(state) {
  if (state.awaitingPaymentProof) {
    const orderInput = state.awaitingPaymentProof.orderInput
    const needsLocation = orderInput.fulfillmentType === 'delivery' && !orderInput.deliveryAddress
    if (state.awaitingPaymentProof.proofReceived && needsLocation) {
      return 'Ya recibi tu comprobante. Solo me falta tu ubicacion de WhatsApp o direccion exacta para pasar el pedido a caja.'
    }

    if (!state.awaitingPaymentProof.proofReceived) {
      return 'Ya tengo tu pedido listo para QR. Por favor enviame el comprobante por este chat para que caja pueda revisar el pago.'
    }

    return 'Ya tengo tu comprobante y los datos del pedido. Tuve un problema pasandolo a caja, pero no necesito que me mandes todo de nuevo. Dame un momento, por favor.'
  }

  if (state.pendingOrder) {
    return `${state.pendingOrder.summary}\n\nSigo teniendo tu pedido listo. Respondeme "Si" para confirmarlo o "No" para cancelarlo.`
  }

  if (state.orderDraft?.items?.length) {
    const missingFields = getMissingOrderFields(state.orderDraft)
    if (missingFields.length > 0) {
      return buildMissingFieldsReply(missingFields)
    }

    return 'Ya tengo tu pedido avanzado. Si esta correcto, respondeme "Si"; si quieres cambiar algo, dime que modificamos.'
  }

  return 'Disculpa, tuve un problema momentaneo leyendo el mensaje. Me puedes mandar tu pedido con nombre, pedido, metodo de pago y si es recojo o envio?'
}

async function tryRecoverOrderFromText(chatId, text, state) {
  try {
    const catalog = await getCatalogForParsing()
    const fallbackResult = mergeOrderDraft(
      state.orderDraft,
      inferSimpleOrderFromCatalog(text, catalog),
      text,
    )

    if (!fallbackResult.items.length) return { handled: false, reply: '' }

    conversations.setOrderDraft(chatId, fallbackResult)
    const missingFields = getMissingOrderFields(fallbackResult)
    if (missingFields.length > 0) {
      if (shouldProceedWithQrWhileWaitingLocation(fallbackResult, missingFields)) {
        const orderInput = buildOrderInput({ result: fallbackResult, chatId })
        const summary = buildOrderSummary(orderInput)
        await requestQrPaymentProof(chatId, orderInput, summary)
        return { handled: true, reply: '' }
      }
      return { handled: true, reply: buildMissingFieldsReply(missingFields) }
    }

    const orderInput = buildOrderInput({ result: fallbackResult, chatId })
    const summary = buildOrderSummary(orderInput)
    if (orderInput.expectedPaymentMethod === 'qr') {
      await requestQrPaymentProof(chatId, orderInput, summary)
      return { handled: true, reply: '' }
    }

    conversations.setPendingOrder(chatId, orderInput, summary)
    return { handled: true, reply: `${summary}\n\nConfirmas el pedido?` }
  } catch (fallbackError) {
    console.error('No se pudo recuperar pedido localmente:', fallbackError)
    return { handled: false, reply: '' }
  }
}

function buildOrderInput({ result, chatId }) {
  const items = result.items.map((item) => {
    const extrasTotal = item.extras.reduce((sum, extra) => sum + Number(extra.price || 0), 0)
    const lineTotal = (Number(item.basePrice || 0) + extrasTotal) * item.quantity
    return {
      id: item.productId,
      name: item.name,
      basePrice: item.basePrice,
      quantity: item.quantity,
      modifiers: {
        extras: item.extras,
        options: item.options,
        note: item.note,
      },
      lineTotal,
    }
  })

  const productSubtotal = items.reduce((sum, item) => sum + item.lineTotal, 0)
  const deliveryFee = 0
  const total = productSubtotal

  return {
    items,
    total,
    productSubtotal,
    deliveryFee,
    deliveryDistanceKm: null,
    deliveryQuoteStatus: result.fulfillmentType === 'delivery' ? 'manual_review' : 'not_needed',
    deliveryQuoteNote: result.fulfillmentType === 'delivery' ? 'El envio lo cobra el delivery directamente al cliente.' : '',
    expectedPaymentMethod: result.paymentMethod || 'cash',
    fulfillmentType: result.fulfillmentType || 'pickup',
    customerName: result.customerName,
    customerPhone: result.customerPhone,
    deliveryAddress: result.deliveryAddress,
    chatId,
  }
}

function requireToken(req, res, next) {
  if (!config.adminToken || req.header('x-bot-token') !== config.adminToken) {
    res.status(401).json({ ok: false, error: 'Token invalido.' })
    return
  }
  next()
}

function phoneToChatId(phone) {
  if (!phone) return ''
  const digits = String(phone).replace(/\D/g, '')
  if (!digits) return ''
  return `${digits}@s.whatsapp.net`
}

function isMenuRequest(text) {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

  return /\b(menu|carta|precios|precio|hamburguesas|promos|promociones|catalogo)\b/.test(normalized)
}

function isOrderStartRequest(text) {
  const normalized = normalizeText(text)
  return /\b(quiero|quisiera|pedido|pedir|ordenar|hamburguesa|burger|bbq|simple|doble|papas|gaseosa|mocochinchi|agua|refresco)\b/.test(normalized)
}

function looksLikeConcreteOrderText(text) {
  const normalized = normalizeText(text)
  return /\b(burger|hamburguesa|bbq|simple|doble|papas|tocino|pina|gaseosa|coca|fanta|sprite|agua|mocochinchi|jamaica|tamarindo|refresco|helado)\b/.test(normalized)
}

function isDeliveryPricingRequest(text) {
  const normalized = normalizeText(text)
  return /\b(cuanto|cuanto sale|costo|precio|tarifa|tarifario|vale)\b/.test(normalized) && /\b(envio|delivery|moto|repartidor)\b/.test(normalized)
}

function isPaymentQrRequest(text) {
  const normalized = normalizeText(text)
  return /\b(qr|codigo|comprobante|pagar|pago)\b/.test(normalized) && /\b(qr|codigo)\b/.test(normalized)
}

function isPaymentProofMessage(text) {
  const normalized = normalizeText(text)
  return normalized === '[imagen_recibida]' || /\b(comprobante|pagado|pague|ya pague|transferencia|qr listo|te mande)\b/.test(normalized)
}

function isRestaurantLocationRequest(text) {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

  const isDeliveryContext = /\b(envio|delivery|pedido|pedir|confirmo|mi ubicacion|mi direccion|te mande|mande|mandÃƒÂ©)\b/.test(normalized)
  if (isDeliveryContext) return false

  return (
    /\b(donde estan|donde queda|como llego)\b/.test(normalized) ||
    /\b(ubicacion|direccion)\b.*\b(local|restaurante|burger lab|burguer lab)\b/.test(normalized) ||
    /\b(local|restaurante|burger lab|burguer lab)\b.*\b(ubicacion|direccion)\b/.test(normalized) ||
    /\b(mandame|pasa|pasame|envia|enviame)\b.*\b(ubicacion|direccion)\b.*\b(local|restaurante)\b/.test(normalized)
  )
}

function startConfirmationNoticePolling() {
  let isChecking = false

  const check = async () => {
    if (isChecking || !botEnabled || !whatsapp.connected) return
    isChecking = true

    try {
      const orders = await getWhatsappOrdersPendingConfirmationNotice()
      for (const order of orders) {
        const delayMinutes = Number(order.estimatedDelay || config.defaultDelayMinutes)
        const chatId = order.whatsappChatId || phoneToChatId(order.customerPhone)
        if (!chatId) continue

        await whatsapp.sendText(
          chatId,
          buildConfirmationMessage(delayMinutes),
        )
        await markWhatsappConfirmationSent(order)
        await notifyDeliveryGroupOrderConfirmed(order, delayMinutes)
      }

      const dispatchOrders = await getWhatsappDeliveryOrdersPendingDispatchNotice()
      for (const order of dispatchOrders) {
        const chatId = order.whatsappChatId || phoneToChatId(order.customerPhone)
        if (!chatId) continue

        await whatsapp.sendText(
          chatId,
          'Tu pedido ya salio para delivery. Por favor, este atento al telefono para recibirlo. Gracias por pedir en Burger Lab.',
        )
        await markWhatsappDispatchSent(order)
      }
    } catch (error) {
      console.error('Error revisando confirmaciones pendientes:', error)
    } finally {
      isChecking = false
    }
  }

  setInterval(check, 5000)
  setTimeout(check, 1500)
}

function buildConfirmationMessage(delayMinutes) {
  return `Listo, tu pedido ya fue confirmado. Sale aproximadamente en ${delayMinutes} minutos.`
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

function isConfirmText(text) {
  const normalized = normalizeText(text)
  return /^(si|confirmo|confirmado|correcto|dale|ok|okay|esta bien|de acuerdo|va|listo|ya)$/.test(normalized)
}

function isCancelText(text) {
  const normalized = normalizeText(text)
  return /^(no|cancelar|cancela|anular|anula|mejor no|ya no)$/.test(normalized)
}

function isThanksText(text) {
  const normalized = normalizeText(text)
  return /^(ok|okay|listo|gracias|muchas gracias|ok gracias|dale gracias|perfecto gracias|ya gracias)$/.test(normalized)
}

function isSummaryRequest(text) {
  const normalized = normalizeText(text)
  return /\b(resumen|total|cuanto|cuanto era|pedido|que pedi)\b/.test(normalized)
}
function buildOrderSummary(orderInput) {
  const itemLines = orderInput.items.map((item) => {
    const extras = item.modifiers.extras.length
      ? ` + ${item.modifiers.extras.map((extra) => extra.name).join(', ')}`
      : ''
    const note = item.modifiers.note ? ` (${item.modifiers.note})` : ''
    return `- ${item.quantity} x ${item.name}${extras}${note}: Bs ${item.lineTotal}`
  })

  const deliveryLine =
    orderInput.fulfillmentType === 'delivery'
      ? buildDeliverySummaryLines(orderInput)
      : ['Recojo en restaurante']

  const paymentLabel = {
    cash: 'Efectivo',
    qr: 'QR',
    mixed: 'Mixto',
  }[orderInput.expectedPaymentMethod] || 'Efectivo'

  return [
    'Te paso el resumen de tu pedido:',
    `Nombre: ${orderInput.customerName}`,
    ...itemLines,
    `Pedido: Bs ${orderInput.productSubtotal ?? orderInput.total}`,
    ...deliveryLine,
    `Total del pedido: Bs ${orderInput.total}`,
    `Pago: ${paymentLabel}`,
  ].join('\n')
}

function buildDeliverySummaryLines(orderInput) {
  const lines = [
    `Envio: ${orderInput.deliveryAddress || 'ubicacion/direccion pendiente'}`,
  ]

  lines.push('Envio: se paga directamente al delivery.')
  return lines
}

function isWithinBusinessHours(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: config.timezone,
    }).format(now),
  )

  return hour >= config.openHour && hour < config.closeHour
}
