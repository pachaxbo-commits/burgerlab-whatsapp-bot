import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, assertRequiredConfig } from './config.js'
import { ConversationStore } from './state.js'
import {
  getCatalog,
  createWhatsappOrder,
  findOrder,
  getWhatsappOrdersPendingConfirmationNotice,
  getWhatsappDeliveryOrdersPendingDispatchNotice,
  markWhatsappConfirmationSent,
  markWhatsappDispatchSent,
} from './firebase.js'
import { understandMessage } from './gemini.js'
import { WhatsappClient } from './whatsapp.js'

assertRequiredConfig()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const menuImagePath = path.resolve(__dirname, '..', 'assets', 'menu-burger-lab.png')

let botEnabled = config.botEnabled
const conversations = new ConversationStore()
let catalogCache = null
let catalogCacheAt = 0

const whatsapp = new WhatsappClient({
  onMessage: async ({ chatId, text }) => {
    if (!botEnabled) return

    if (!isWithinBusinessHours()) {
      await whatsapp.sendText(
        chatId,
        `Gracias por escribir a ${config.businessName}. Nuestro horario de pedidos por WhatsApp es de 5:00 pm a 11:00 pm. Te esperamos en ese horario para atenderte con gusto.`,
      )
      return
    }

    conversations.add(chatId, 'cliente', text)
    const state = conversations.get(chatId)
    await whatsapp.startTyping(chatId)

    try {
      if (state.pendingOrder && isConfirmText(text)) {
        const created = await createWhatsappOrder(state.pendingOrder.orderInput)
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

      if (isMenuRequest(text)) {
        const caption = 'Claro, te paso nuestro menu. Cuando quieras pedir, mandame tu nombre, pedido, metodo de pago y si es recojo o envio.'
        conversations.add(chatId, 'bot', caption)
        await whatsapp.sendImage(chatId, menuImagePath, caption)
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

      const catalog = await getCachedCatalog()
      const quickResult = inferSimpleOrderFromCatalog(text, catalog)
      if (quickResult.items.length || (state.orderDraft?.items?.length && hasUsefulInferredFields(text))) {
        const baseDraft = state.orderDraft || buildEmptyAiResult()
        const deterministicResult = quickResult.items.length ? quickResult : buildEmptyAiResult()
        const mergedResult = mergeOrderDraft(baseDraft, deterministicResult, text)
        conversations.setOrderDraft(chatId, mergedResult)
        const missingFields = getMissingOrderFields(mergedResult)
        if (missingFields.length > 0) {
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
          const reply = buildMissingFieldsReply(missingFields)
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        const orderInput = buildOrderInput({ result: mergedResult, chatId })
        const summary = buildOrderSummary(orderInput)
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
        const created = await createWhatsappOrder(state.pendingOrder.orderInput)
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
        const reply = 'Sin problema. Lo dejamos pendiente; si quieres cambiar algo, mandame el pedido actualizado y lo armamos bien.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      const mergedResult = mergeOrderDraft(state.orderDraft, result, text)
      conversations.setOrderDraft(chatId, mergedResult)
      const missingFields = getMissingOrderFields(mergedResult)
      if (mergedResult.items.length > 0 && missingFields.length > 0) {
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
      const reply = buildContextualRecoveryReply(state)
      conversations.add(chatId, 'bot', reply)
      await whatsapp.sendText(chatId, reply)
    }
  },
})

await whatsapp.start()
startConfirmationNoticePolling()

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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    botEnabled,
    whatsappConnected: whatsapp.connected,
  })
})

app.post('/bot/on', requireToken, (_req, res) => {
  botEnabled = true
  res.json({ ok: true, botEnabled })
})

app.post('/bot/off', requireToken, (_req, res) => {
  botEnabled = false
  res.json({ ok: true, botEnabled })
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

  res.json({ ok: true })
})

app.listen(config.port, () => {
  console.log(`Bot API escuchando en http://localhost:${config.port}`)
})

async function getCachedCatalog() {
  const now = Date.now()
  if (catalogCache && now - catalogCacheAt < 120000) {
    return catalogCache
  }

  catalogCache = await getCatalog()
  catalogCacheAt = now
  return catalogCache
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
    deliveryAddress: result.deliveryAddress || previous?.deliveryAddress || '',
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
  const possibleName = String(text || '')
    .split(',')
    .map((part) => part.trim())
    .find((part) => /^[\p{L}]{3,}(?:\s+[\p{L}]{3,})?$/u.test(part) && !/qr|efectivo|mixto/i.test(part))
  const introducedName = String(text || '').match(/\b(?:soy|nombre|me llamo)\s+([\p{L}]{3,}(?:\s+[\p{L}]{3,})?)/iu)?.[1]?.trim()

  return {
    paymentMethod,
    fulfillmentType,
    customerName: introducedName || possibleName || '',
  }
}

function hasUsefulInferredFields(text) {
  const inferred = inferFieldsFromText(text)
  return Boolean(inferred.customerName || inferred.paymentMethod || inferred.fulfillmentType)
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
  const products = [...(catalog.products || [])]
    .filter((product) => product.isVisible !== false && product.isActive !== false)
    .sort((left, right) => normalizeText(right.name).length - normalizeText(left.name).length)
  const matched = []

  for (const product of products) {
    const productName = normalizeText(product.name)
    if (!productName || !normalized.includes(productName)) continue
    if (matched.some((item) => item.productId === product.id)) continue
    matched.push({
      productId: product.id,
      name: product.name,
      basePrice: Number(product.price || 0),
      quantity: inferQuantityBeforeProduct(normalized, productName),
      note: '',
      options: [],
      extras: [],
    })
  }

  return {
    ...buildEmptyAiResult(),
    items: matched,
  }
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

function getMissingOrderFields(result) {
  const missing = []
  if (!result.customerName) missing.push('tu nombre')
  if (!result.paymentMethod) missing.push('tu metodo de pago')
  if (!result.fulfillmentType) missing.push('si es recojo o envio')
  if (result.fulfillmentType === 'delivery' && !result.deliveryAddress) missing.push('tu ubicacion de WhatsApp')
  return missing
}

function buildMissingFieldsReply(missingFields) {
  return `Ya tengo el pedido avanzado. Para terminar de registrarlo, me falta: ${missingFields.join(', ')}.`
}

function buildContextualRecoveryReply(state) {
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
  const deliveryQuote =
    result.fulfillmentType === 'delivery'
      ? buildDeliveryQuote(result.deliveryAddress)
      : null
  const deliveryFee = deliveryQuote?.fee ?? 0
  const total = productSubtotal

  return {
    items,
    total,
    productSubtotal,
    deliveryFee,
    deliveryDistanceKm: deliveryQuote?.distanceKm ?? null,
    deliveryQuoteStatus: deliveryQuote?.status ?? 'not_needed',
    deliveryQuoteNote: deliveryQuote?.note ?? '',
    expectedPaymentMethod: result.paymentMethod || 'cash',
    fulfillmentType: result.fulfillmentType || 'pickup',
    customerName: result.customerName,
    customerPhone: result.customerPhone,
    deliveryAddress: result.deliveryAddress,
    chatId,
  }
}

function buildDeliveryQuote(deliveryAddress) {
  const coordinates = extractCoordinates(deliveryAddress)
  if (!coordinates) {
    return {
      status: 'missing_location',
      fee: 0,
      distanceKm: null,
      note: 'No se pudo calcular el envio automaticamente porque falta ubicacion de WhatsApp.',
    }
  }

  const distanceKm = roundToOneDecimal(
    haversineKm(
      config.restaurantLatitude,
      config.restaurantLongitude,
      coordinates.latitude,
      coordinates.longitude,
    ),
  )
  const fee = getDeliveryFee(distanceKm)

  if (fee === null) {
    return {
      status: 'manual_review',
      fee: 0,
      distanceKm,
      note: 'La ubicacion supera el rango automatico de 11.9 km; caja debe revisar la tarifa.',
    }
  }

  return {
    status: 'quoted',
    fee,
    distanceKm,
    note: 'Tarifa calculada por distancia. Puede variar por clima, ruta, subida, trafico o condiciones especiales.',
  }
}

function extractCoordinates(text) {
  const match = String(text || '').match(/q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/)
  if (!match) return null
  return {
    latitude: Number(match[1]),
    longitude: Number(match[2]),
  }
}

function getDeliveryFee(distanceKm) {
  if (distanceKm < 0 || distanceKm > 11.9) return null
  if (distanceKm < 2) return 10
  return 12 + Math.floor(distanceKm - 2) * 2
}

function haversineKm(fromLat, fromLng, toLat, toLng) {
  const earthRadiusKm = 6371
  const dLat = toRadians(toLat - fromLat)
  const dLng = toRadians(toLng - fromLng)
  const lat1 = toRadians(fromLat)
  const lat2 = toRadians(toLat)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function toRadians(value) {
  return (value * Math.PI) / 180
}

function roundToOneDecimal(value) {
  return Math.round(value * 10) / 10
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

function isRestaurantLocationRequest(text) {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

  const isDeliveryContext = /\b(envio|delivery|pedido|pedir|confirmo|mi ubicacion|mi direccion|te mande|mande|mandé)\b/.test(normalized)
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

  if (orderInput.deliveryQuoteStatus === 'quoted') {
    lines.push(`Distancia aprox.: ${orderInput.deliveryDistanceKm} km`)
    lines.push(`Envio estimado: Bs ${orderInput.deliveryFee} (se paga al delivery)`)
    lines.push('Nota: el envio puede subir por clima, ruta, subida, trafico o condiciones especiales.')
    return lines
  }

  if (orderInput.deliveryQuoteStatus === 'manual_review') {
    lines.push(`Distancia aprox.: ${orderInput.deliveryDistanceKm} km`)
    lines.push('Envio: pendiente de revision por distancia/zona.')
    return lines
  }

  lines.push('Envio: pendiente, necesito ubicacion de WhatsApp para cotizar automaticamente.')
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
