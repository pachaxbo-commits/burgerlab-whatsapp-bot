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

    try {
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

      const catalog = await getCatalog()
      const result = await understandMessage({
        message: text,
        conversation: state.messages,
        catalog,
      })

      if (result.intent === 'confirm_order' && state.pendingOrder) {
        const created = await createWhatsappOrder(state.pendingOrder.orderInput)
        conversations.setLastOrder(chatId, created.orderId)

        const reply = [
          `Perfecto, registre tu pedido ${created.displayNumber}.`,
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

      if (result.intent === 'order_ready' && result.items.length > 0) {
        const orderInput = buildOrderInput({ result, chatId })
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
      await whatsapp.sendText(
        chatId,
        'Perdon, tuve un problema registrando eso. Me lo puedes mandar otra vez con nombre, pedido, metodo de pago y si es recojo o envio?',
      )
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
  const total = productSubtotal + deliveryFee

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
          'Tu pedido ya salio para delivery. Por favor estate atento al telefono para recibirlo. Gracias por pedir en Burger Lab.',
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
    `Productos: Bs ${orderInput.productSubtotal ?? orderInput.total}`,
    ...deliveryLine,
    `Total: Bs ${orderInput.total}`,
    `Pago: ${paymentLabel}`,
  ].join('\n')
}

function buildDeliverySummaryLines(orderInput) {
  const lines = [
    `Envio: ${orderInput.deliveryAddress || 'ubicacion/direccion pendiente'}`,
  ]

  if (orderInput.deliveryQuoteStatus === 'quoted') {
    lines.push(`Distancia aprox.: ${orderInput.deliveryDistanceKm} km`)
    lines.push(`Costo de envio: Bs ${orderInput.deliveryFee}`)
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
