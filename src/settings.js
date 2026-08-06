import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const settingsPath = config.settingsPath
const legacyPickupOnlyMessage = 'Por el momento solo estamos trabajando pedidos para recojo en el restaurante. Si te parece bien, puedo registrar tu pedido para que pases a recogerlo.'

export const defaultOrderTemplateMessage = `¡Hola!  🍔 Para que tu pedido de hamburguesas por WhatsApp sea más fácil y preciso, te pedimos los siguientes datos:

- Nombre completo (Nombre y apellido)
- Delivery o Recoger (En caso de delivery enviar ubicación GPS)
- Número de Celular (Escrito)
- Pedido (Renglon saltado, como en el ejemplo de abajo)

*Ejemplo:*
Carlos Ramirez
Recoger
72210742
1 burger lab sin cebolla
2 burger lab
2 bbq lab dobles sin papa
1 bbq lab doble con piña y tocino
1 bbq lab doble con tocino
4 cocas

‼️Nota: Le pedimos realizar su pedido con este formato y revisarlo bien antes de confirmarlo.
*POR FAVOR*
*NO EDITAR MENSAJES,*
*NO MANDAR AUDIOS,*
*NO LLAMAR*`

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
  // Mensaje de bienvenida con el formato de pedido. Es el que mas cambia, asi que se edita desde
  // el sistema. Si queda vacio se usa este texto.
  orderTemplateMessage: defaultOrderTemplateMessage,
  // Ubicacion del local que el bot manda cuando se la piden. Vacio = se usa la de las variables
  // de entorno, que es como venia funcionando.
  restaurantLatitude: '',
  restaurantLongitude: '',
  restaurantAddress: '',
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
    // Un mensaje vacio dejaria al cliente sin saber como pedir, asi que se vuelve al texto por
    // defecto. Borrar el campo en el sistema es la forma de restaurarlo.
    orderTemplateMessage:
      typeof value?.orderTemplateMessage === 'string' && value.orderTemplateMessage.trim()
        ? value.orderTemplateMessage.trim()
        : defaultOrderTemplateMessage,
    restaurantLatitude: normalizeCoordinate(value?.restaurantLatitude),
    restaurantLongitude: normalizeCoordinate(value?.restaurantLongitude),
    restaurantAddress: typeof value?.restaurantAddress === 'string' ? value.restaurantAddress.trim() : '',
  }
}

// Las coordenadas se guardan como texto para poder distinguir "sin configurar" (vacio) de un cero
// legitimo. Cualquier cosa que no sea un numero valido se descarta y el bot sigue usando la
// ubicacion de las variables de entorno.
function normalizeCoordinate(value) {
  if (value === null || value === undefined || value === '') return ''
  const numero = Number(value)
  return Number.isFinite(numero) ? String(numero) : ''
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
