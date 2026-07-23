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

export async function getCatalog() {
  const basePath = db
    .collection('restaurants')
    .doc(config.restaurantId)
    .collection('catalog')
    .doc('current')

  const [categoriesSnap, productsSnap] = await Promise.all([
    basePath.collection('categories').orderBy('sortOrder', 'asc').get(),
    basePath.collection('products').orderBy('sortOrder', 'asc').get(),
  ])

  const categories = categoriesSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((category) => category.isActive !== false && category.isVisible !== false)

  const products = productsSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((product) => product.isActive !== false && product.isVisible !== false && product.availability !== 'soldout')

  return { categories, products }
}

export async function createWhatsappOrder(input) {
  const todayKey = getTodayKey()
  const dayRef = db.collection('restaurants').doc(config.restaurantId).collection('days').doc(todayKey)
  const orderRef = dayRef.collection('orders').doc()
  const normalizedInput = normalizeOrderInput(input)

  const result = await db.runTransaction(async (transaction) => {
    const daySnap = await transaction.get(dayRef)
    const nextSequence = daySnap.exists ? Number(daySnap.data().sequence || 0) + 1 : 1
    const displayNumber = `#${String(nextSequence).padStart(3, '0')}`
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

    const orderPayload = sanitizeFirestoreValue({
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
    })

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

export async function getWhatsappDeliveryOrdersPendingDispatchNotice() {
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
    .filter((order) => order.fulfillmentType === 'delivery')
    .filter((order) => !order.whatsappDispatchSentAt)
    .filter((order) => isRecentTimestamp(order.deliveredAt, 15 * 60 * 1000))
    .filter((order) => isWithinDispatchNoticeWindow(order))
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

function isWithinDispatchNoticeWindow(order) {
  const createdAt = order.createdAt?.toMillis ? order.createdAt.toMillis() : new Date(order.createdAt || 0).getTime()
  const deliveredAt = order.deliveredAt?.toMillis ? order.deliveredAt.toMillis() : new Date(order.deliveredAt || 0).getTime()
  const delayMinutes = Number(order.estimatedDelay || 10)
  const graceMs = 10 * 60 * 1000
  return Number.isFinite(createdAt) && Number.isFinite(deliveredAt) && deliveredAt <= createdAt + delayMinutes * 60 * 1000 + graceMs
}

function getTodayKey(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getFirebaseCredential() {
  if (!config.firebaseServiceAccountJson) return null

  const serviceAccount = JSON.parse(config.firebaseServiceAccountJson)
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n')
  }

  return admin.credential.cert(serviceAccount)
}
