import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const settingsPath = config.settingsPath
const legacyPickupOnlyMessage = 'Por el momento solo estamos trabajando pedidos para recojo en el restaurante. Si te parece bien, puedo registrar tu pedido para que pases a recogerlo.'

export const defaultSettings = {
  // Cuantas veces se uso el borrado de ventas. El limite es 2: una para probar el sistema y
  // otra para entregarlo limpio. Se guarda aca (no en el navegador) para que no se pueda
  // reiniciar borrando datos del navegador.
  salesResetsUsed: 0,
  openHour: 17,
  closeHour: 23,
  acceptingOrders: true,
  acceptingOrdersPausedUntil: '',
  acceptingOrdersPauseReason: '',
  pickupOnlyMode: false,
  pickupOnlyMessage: 'Por el momento no tenemos delivery disponible. Solo estamos recibiendo pedidos para recojo en el restaurante. Si te parece bien, puedo registrar tu pedido para que pases a recogerlo.',
  autoRepliesEnabled: true,
  // En modo manual el bot informa y guarda chats recientes, pero caja arma el pedido desde el
  // catalogo del sistema. Desactivarlo restaura el flujo automatico anterior completo.
  manualOrderEntryMode: true,
  // Por ahora el dueño reenvia manualmente cada delivery al grupo. Mantener esto apagado evita
  // que llegue una copia automatica adicional al confirmar el pedido en caja.
  autoSendDeliveryGroupOrders: false,
  deliveryGroupName: config.deliveryGroupName,
  deliveryGroupId: config.deliveryGroupId,
  ownerAlertGroupName: config.ownerAlertGroupName,
  ownerAlertChatId: config.ownerAlertChatId,
  closedMessage: `Gracias por escribir a ${config.businessName}. Nuestro horario de pedidos por WhatsApp es de 5:00 pm a 11:00 pm. Te esperamos en ese horario para atenderte con gusto.`,
  pausedOrdersMessage: 'En este momento no estamos recibiendo pedidos por WhatsApp. Por favor intenta nuevamente mas tarde.',
  qrPaymentMessage: 'Cuando envies el comprobante por este chat, caja revisara el pago y te avisare el tiempo de salida.',
  confirmationPromptMessage: '¿Confirmas el pedido?\nDespués de confirmarlo, no podremos realizar modificaciones. Si necesitas cambiar algo, con gusto podemos registrarlo como un nuevo pedido.',
  registeredOrderFooterMessage: 'Una vez registrado, no podremos modificar este pedido. Si necesitas cambiar o agregar algo, con gusto podemos registrarlo como un nuevo pedido.',
  deliveryPricingMessage: 'Te paso el tarifario de delivery y la ubicacion de Burger Lab para que puedas estimar el envio. El costo final puede variar por zona, clima, subida, ruta o disponibilidad del repartidor.',
  humanHelpMessage: 'Dame un momento, por favor. Voy a pedir apoyo para confirmarte eso correctamente.',
  personality: config.personality,
}

let currentSettings = { ...defaultSettings }

export async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8')
    currentSettings = normalizeSettings(JSON.parse(raw))
  } catch {
    currentSettings = { ...defaultSettings }
    await saveSettings(currentSettings)
  }

  return currentSettings
}

export function getSettings() {
  return currentSettings
}

export async function updateSettings(patch) {
  currentSettings = normalizeSettings({
    ...currentSettings,
    ...pickAllowedSettings(patch),
  })
  await saveSettings(currentSettings)
  return currentSettings
}

/** Suma un uso al borrado de ventas. Es el unico camino para modificar ese contador. */
export async function registerSalesReset() {
  currentSettings = { ...currentSettings, salesResetsUsed: Number(currentSettings.salesResetsUsed || 0) + 1 }
  await saveSettings(currentSettings)
  return currentSettings.salesResetsUsed
}

async function saveSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function normalizeSettings(value) {
  return {
    ...defaultSettings,
    ...pickAllowedSettings(value || {}),
    acceptingOrders: value?.acceptingOrders !== false,
    acceptingOrdersPausedUntil: typeof value?.acceptingOrdersPausedUntil === 'string' ? value.acceptingOrdersPausedUntil : '',
    acceptingOrdersPauseReason: typeof value?.acceptingOrdersPauseReason === 'string' ? value.acceptingOrdersPauseReason : '',
    pickupOnlyMode: value?.pickupOnlyMode === true,
    pickupOnlyMessage:
      typeof value?.pickupOnlyMessage === 'string' && value.pickupOnlyMessage !== legacyPickupOnlyMessage
        ? value.pickupOnlyMessage
        : defaultSettings.pickupOnlyMessage,
    confirmationPromptMessage:
      typeof value?.confirmationPromptMessage === 'string' && value.confirmationPromptMessage.trim()
        ? value.confirmationPromptMessage.trim()
        : defaultSettings.confirmationPromptMessage,
    registeredOrderFooterMessage:
      typeof value?.registeredOrderFooterMessage === 'string' && value.registeredOrderFooterMessage.trim()
        ? value.registeredOrderFooterMessage.trim()
        : defaultSettings.registeredOrderFooterMessage,
    autoRepliesEnabled: value?.autoRepliesEnabled !== false,
    manualOrderEntryMode: value?.manualOrderEntryMode !== false,
  }
}

function pickAllowedSettings(value) {
  const allowed = {}
  for (const key of Object.keys(defaultSettings)) {
    // El contador de borrados NO se puede tocar desde afuera: si se pudiera, alcanzaria con
    // mandarlo en cero para saltarse el limite de dos usos.
    if (key === 'salesResetsUsed') continue
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      allowed[key] = value[key]
    }
  }
  return allowed
}
