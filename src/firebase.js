import admin from 'firebase-admin'
import { config } from './config.js'

if (!admin.apps.length) {
  const credential = getFirebaseCredential()
  admin.initializeApp({
    projectId: config.firebaseProjectId,
    ...(credential ? { credential } : {}),
  })
}

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue
const MAX_VISIBLE_ORDER_NUMBER = 50

function formatOrderNumber(sequence) {
  const safeSequence = Math.max(1, Math.trunc(sequence))
  const visibleNumber = ((safeSequence - 1) % MAX_VISIBLE_ORDER_NUMBER) + 1
  return `#${String(visibleNumber).padStart(3, '0')}`
}

export async function getCatalog() {
  const basePath = db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('catalog')
    .doc('current')

  const [categoriesSnap, productsSnap, quickExtrasSnap] = await Promise.all([
    basePath.collection('categories').orderBy('sortOrder', 'asc').get(),
    basePath.collection('products').orderBy('sortOrder', 'asc').get(),
    basePath.collection('settings').doc('quick_extras').get(),
  ])

  const categories = categoriesSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((category) => category.isActive !== false && category.isVisible !== false)

  const products = productsSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((product) => product.isActive !== false && product.isVisible !== false && product.availability !== 'soldout')

  const quickExtras = quickExtrasSnap.exists && Array.isArray(quickExtrasSnap.data().list)
    ? quickExtrasSnap.data().list
    : []

  return { categories, products, quickExtras }
}

export async function createWhatsappOrder(input) {
  const todayKey = getTodayKey()
  const dayRef = db.collection('restaurants').doc(config.restaurantId).collection('days').doc(todayKey)
  const orderRef = dayRef.collection('orders').doc()
  const normalizedInput = normalizeOrderInput(input)

  const result = await db.runTransaction(async (transaction) => {
    const daySnap = await transaction.get(dayRef)
    const nextSequence = daySnap.exists ? Number(daySnap.data().sequence || 0) + 1 : 1
    const displayNumber = formatOrderNumber(nextSequence)
    const now = FieldValue.serverTimestamp()

    if (daySnap.exists) {
      transaction.update(dayRef, {
        sequence: nextSequence,
        updatedAt: now,
      })
    } else {
      transaction.set(dayRef, {
        dayKey: todayKey,
        restaurantId: config.restaurantId,
        sequence: nextSequence,
        createdAt: now,
        updatedAt: now,
      })
    }

    const orderPayload = {
      id: orderRef.id,
      sequence: nextSequence,
      displayNumber,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      items: normalizedInput.items,
      total: normalizedInput.total,
      productSubtotal: normalizedInput.productSubtotal,
      deliveryFee: normalizedInput.deliveryFee,
      deliveryDistanceKm: normalizedInput.deliveryDistanceKm,
      deliveryQuoteStatus: normalizedInput.deliveryQuoteStatus,
      deliveryQuoteNote: normalizedInput.deliveryQuoteNote,
      payment: buildPendingPayment(normalizedInput.expectedPaymentMethod),
      paymentStatus: 'pending',
      paymentMethod: null,
      qrProofReceived: normalizedInput.qrProofReceived,
      paymentReviewNote: normalizedInput.paymentReviewNote,
      expectedPaymentMethod: normalizedInput.expectedPaymentMethod,
      orderSource: 'whatsapp',
      fulfillmentType: normalizedInput.fulfillmentType,
      tableInfo: '',
      customerName: normalizedInput.customerName,
      customerPhone: normalizedInput.customerPhone,
      deliveryAddress: normalizedInput.deliveryAddress,
      createdBy: normalizedInput.createdBy,
      whatsappChatId: normalizedInput.chatId,
    }

    transaction.set(orderRef, orderPayload)

    return { orderId: orderRef.id, displayNumber }
  })

  return result
}

export async function testFirestoreWrite() {
  const ref = db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('diagnostics')
    .doc('bot-write-test')

  await ref.set({
    ok: true,
    source: 'whatsapp-bot',
    checkedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  const snap = await ref.get()
  return { exists: snap.exists, data: snap.exists ? snap.data() : null }
}

function normalizeOrderInput(input) {
  const total = Number(input.total || 0)
  return {
    items: Array.isArray(input.items) ? input.items.map(normalizeOrderItem) : [],
    total,
    productSubtotal: Number(input.productSubtotal ?? total),
    deliveryFee: Number(input.deliveryFee ?? 0),
    deliveryDistanceKm: input.deliveryDistanceKm ?? null,
    deliveryQuoteStatus: input.deliveryQuoteStatus || 'not_needed',
    deliveryQuoteNote: input.deliveryQuoteNote || '',
    expectedPaymentMethod: input.expectedPaymentMethod || 'cash',
    qrProofReceived: Boolean(input.qrProofReceived),
    paymentReviewNote: input.paymentReviewNote || '',
    fulfillmentType: input.fulfillmentType || 'pickup',
    customerName: input.customerName || 'Cliente WhatsApp',
    customerPhone: input.customerPhone || '',
    deliveryAddress: input.deliveryAddress || '',
    createdBy: input.createdBy || 'whatsapp-bot',
    chatId: input.chatId || '',
  }
}

function normalizeOrderItem(item) {
  const modifiers = item.modifiers || {}
  return {
    id: item.id || item.productId || '',
    name: item.name || 'Producto',
    basePrice: Number(item.basePrice || 0),
    quantity: Number(item.quantity || 1),
    modifiers: {
      extras: Array.isArray(modifiers.extras) ? modifiers.extras.map(normalizeExtra) : [],
      options: Array.isArray(modifiers.options) ? modifiers.options.map((option) => String(option || '')).filter(Boolean) : [],
      note: modifiers.note || '',
    },
    lineTotal: Number(item.lineTotal || 0),
  }
}

function normalizeExtra(extra) {
  return {
    id: extra?.id || '',
    name: extra?.name || '',
    price: Number(extra?.price || 0),
  }
}

function sanitizeFirestoreValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeFirestoreValue).filter((item) => item !== undefined)
  }

  if (value && typeof value === 'object') {
    const sanitized = {}
    for (const [key, childValue] of Object.entries(value)) {
      const nextValue = sanitizeFirestoreValue(childValue)
      if (nextValue !== undefined) sanitized[key] = nextValue
    }
    return sanitized
  }

  return value === undefined ? null : value
}

export async function findOrder(orderId) {
  const todayKey = getTodayKey()
  const ref = db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('days')
    .doc(todayKey)
    .collection('orders')
    .doc(orderId)

  const snap = await ref.get()
  if (snap.exists) return { id: snap.id, dayKey: todayKey, ...snap.data() }

  const now = new Date()
  for (let i = 1; i <= 7; i += 1) {
    const day = new Date(now)
    day.setDate(now.getDate() - i)
    const dayKey = getTodayKey(day)
    const pastRef = db
      .collection('restaurants')
      .doc(config.restaurantId)
      .collection('days')
      .doc(dayKey)
      .collection('orders')
      .doc(orderId)
    const pastSnap = await pastRef.get()
    if (pastSnap.exists) return { id: pastSnap.id, dayKey, ...pastSnap.data() }
  }

  return null
}

// Ultimo pedido del dia de ese cliente, para poder contestarle cuanto tiene que pagar sin que
// nadie tenga que buscarlo a mano. Se lee tal cual quedo cargado en caja: el bot no calcula nada.
export async function getLatestOrderForCustomer({ chatId, phone }) {
  const todayKey = getTodayKey()
  const snap = await db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('days')
    .doc(todayKey)
    .collection('orders')
    .limit(200)
    .get()

  const digits = String(phone || '').replace(/\D/g, '')
  const chatDigits = String(chatId || '').replace(/\D/g, '')

  const matches = snap.docs
    .map((doc) => ({ id: doc.id, dayKey: todayKey, ...doc.data() }))
    .filter((order) => order.status !== 'cancelled')
    .filter((order) => {
      if (chatId && order.whatsappChatId === chatId) return true
      const orderDigits = String(order.customerPhone || '').replace(/\D/g, '')
      if (!orderDigits) return false
      // Los numeros se guardan con y sin codigo de pais segun quien los cargue, asi que se
      // comparan por el final: 59171234567 y 71234567 son el mismo cliente.
      const candidate = digits || chatDigits
      if (!candidate) return false
      const corto = orderDigits.length <= candidate.length ? orderDigits : candidate
      const largo = orderDigits.length <= candidate.length ? candidate : orderDigits
      return corto.length >= 7 && largo.endsWith(corto)
    })

  if (matches.length === 0) return null

  const toMillis = (value) => (value?.toMillis ? value.toMillis() : new Date(value || 0).getTime() || 0)
  matches.sort((left, right) => toMillis(right.createdAt) - toMillis(left.createdAt))
  return matches[0]
}

export async function getWhatsappOrdersPendingConfirmationNotice() {
  const todayKey = getTodayKey()
  const snap = await db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('days')
    .doc(todayKey)
    .collection('orders')
    .where('status', '==', 'preparing')
    .limit(50)
    .get()

  return snap.docs
    .map((doc) => ({ id: doc.id, dayKey: todayKey, ...doc.data() }))
    .filter((order) => order.orderSource === 'whatsapp' && !order.whatsappConfirmationSentAt)
    .filter((order) => order.whatsappChatId || order.customerPhone)
}

// Pedidos ya entregados a los que todavia les falta el aviso al cliente.
//
// Antes esta funcion dejaba fuera dos casos y en los dos el cliente no recibia nada, sin ningun
// error visible en caja:
//   1) Los pedidos para RECOGER. Solo pasaban los de delivery, asi que quien pedia para recoger
//      nunca se enteraba de que su pedido ya estaba listo.
//   2) Los entregados fuera de la "ventana" createdAt + tiempo estimado + 10 min. Un pedido
//      cargado a mano a las 19:00 y entregado 19:35 quedaba fuera y el aviso se descartaba en
//      silencio. Esa ventana sobra: quien pulsa "Entregado" lo esta diciendo a proposito, y el
//      filtro de deliveredAt reciente ya evita avisos por cambios viejos.
export async function getWhatsappOrdersPendingDispatchNotice() {
  const todayKey = getTodayKey()
  const snap = await db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('days')
    .doc(todayKey)
    .collection('orders')
    .where('status', '==', 'delivered')
    .limit(50)
    .get()

  return snap.docs
    .map((doc) => ({ id: doc.id, dayKey: todayKey, ...doc.data() }))
    .filter((order) => order.orderSource === 'whatsapp')
    .filter((order) => order.fulfillmentType === 'delivery' || order.fulfillmentType === 'pickup')
    .filter((order) => !order.whatsappDispatchSentAt)
    .filter((order) => !order.suppressWhatsappDispatchNotice)
    .filter((order) => isRecentTimestamp(order.deliveredAt, 30 * 60 * 1000))
    .filter((order) => order.whatsappChatId || order.customerPhone)
}

export async function markWhatsappConfirmationSent(order) {
  await db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('days')
    .doc(order.dayKey || getTodayKey())
    .collection('orders')
    .doc(order.id)
    .update({
      whatsappConfirmationSentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
}

export async function markWhatsappDispatchSent(order) {
  await db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('days')
    .doc(order.dayKey || getTodayKey())
    .collection('orders')
    .doc(order.id)
    .update({
      whatsappDispatchSentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
}

function buildPendingPayment(method) {
  return {
    method: method || 'cash',
    cashAmount: 0,
    qrAmount: 0,
    cashReceived: 0,
    change: 0,
  }
}

function isRecentTimestamp(value, maxAgeMs) {
  const millis = value?.toMillis ? value.toMillis() : new Date(value || 0).getTime()
  return Number.isFinite(millis) && Date.now() - millis <= maxAgeMs
}

// El dia se calcula SIEMPRE en la zona horaria del restaurante, nunca con la hora local del
// servidor: Railway corre en UTC, asi que con hora local todo pedido hecho despues de las 20:00
// de Bolivia (00:00 UTC) se guardaba en el dia SIGUIENTE. La escritura salia bien y el bot
// respondia "lo paso a caja", pero el comandero mira el dia de hoy en hora local y no lo
// encontraba nunca. Tres pedidos reales quedaron invisibles asi.
function getTodayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function getFirebaseCredential() {
  if (!config.firebaseServiceAccountJson) return null

  const serviceAccount = JSON.parse(config.firebaseServiceAccountJson)
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n')
  }

  return admin.credential.cert(serviceAccount)
}

/**
 * Borra TODAS las ventas: pedidos y documentos de dia (con sus contadores).
 *
 * Sirve para entregar el sistema limpio despues de las pruebas, sin que queden pedidos falsos
 * inflando el historial, los totales del dia/semana/mes ni el conteo de insumos (pan, carne),
 * que se calculan a partir de los pedidos.
 *
 * NO toca el catalogo, los usuarios ni la configuracion del bot: solo el historial de ventas.
 *
 * Va aca y no en el comandero porque las reglas de seguridad prohiben borrar los documentos de
 * dia desde el navegador ("allow delete: if false"). El bot usa credenciales de administrador y
 * si puede, asi no hay que aflojar esas reglas.
 */
export async function resetSalesData() {
  const daysRef = db.collection('restaurants').doc(config.restaurantId).collection('days')
  const daysSnap = await daysRef.get()

  let pedidosBorrados = 0
  let diasBorrados = 0

  for (const dayDoc of daysSnap.docs) {
    const ordersSnap = await dayDoc.ref.collection('orders').get()

    // En lotes, que es como Firestore espera los borrados masivos.
    for (let i = 0; i < ordersSnap.docs.length; i += 400) {
      const batch = db.batch()
      ordersSnap.docs.slice(i, i + 400).forEach((orderDoc) => batch.delete(orderDoc.ref))
      await batch.commit()
    }

    pedidosBorrados += ordersSnap.size
    await dayDoc.ref.delete()
    diasBorrados += 1
  }

  return { pedidosBorrados, diasBorrados }
}
