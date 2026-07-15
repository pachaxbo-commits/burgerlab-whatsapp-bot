import express from 'express'
import { config, assertRequiredConfig } from './config.js'
import { ConversationStore } from './state.js'
import { getCatalog, createWhatsappOrder, findOrder } from './firebase.js'
import { understandMessage } from './gemini.js'
import { WhatsappClient } from './whatsapp.js'

assertRequiredConfig()

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

const app = express()
app.use(express.json())

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
    `Tu pedido ${order.displayNumber || ''} ya fue confirmado. Sale aproximadamente en ${delayMinutes} minutos.`,
  )

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

  const total = items.reduce((sum, item) => sum + item.lineTotal, 0)

  return {
    items,
    total,
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
      ? `Envio: ${orderInput.deliveryAddress || 'ubicacion/direccion pendiente'}`
      : 'Recojo en restaurante'

  const paymentLabel = {
    cash: 'Efectivo',
    qr: 'QR',
    mixed: 'Mixto',
  }[orderInput.expectedPaymentMethod] || 'Efectivo'

  return [
    'Te paso el resumen de tu pedido:',
    `Nombre: ${orderInput.customerName}`,
    ...itemLines,
    `Total: Bs ${orderInput.total}`,
    `Pago: ${paymentLabel}`,
    deliveryLine,
  ].join('\n')
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
