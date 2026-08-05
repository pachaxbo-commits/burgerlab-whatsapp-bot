import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, assertRequiredConfig, getRestaurantLocation } from './config.js'
import { ConversationStore } from './state.js'
import { getSettings, loadSettings, registerSalesReset, updateSettings } from './settings.js'
import {
  getCatalog,
  createWhatsappOrder,
  findOrder,
  getWhatsappOrdersPendingConfirmationNotice,
  getWhatsappOrdersPendingDispatchNotice,
  getLatestOrderForCustomer,
  markWhatsappConfirmationSent,
  markWhatsappDispatchSent,
  testFirestoreWrite,
  resetSalesData,
} from './firebase.js'
import { understandMessage } from './gemini.js'
import { WhatsappClient } from './whatsapp.js'
import { applyExplicitOrderNotes, applyTargetedOrderItemChange, filterUnrequestedExtras, preserveItemsDuringAdditiveChange, reconcileInitialBurgerItems } from './orderRules.js'
import { formatCustomerPhone, resolveCustomerPhone } from './contact.js'
import {
  isConfirmedOrderModificationRequest,
  isConfirmedOrderStatusRequest,
  isNonEditingOrderQuestion,
  isPickupArrivalNotice,
  isPostOrderCourtesyText,
  isPreparationTimeQuestion,
  shouldAnswerAsStandaloneQuestion,
  shouldSuppressRepeatedOrderSummary,
} from './postOrderRules.js'

assertRequiredConfig()
await loadSettings()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const menuImagePath = path.resolve(__dirname, '..', 'assets', 'menu-burger-lab.png')
const deliveryTariffImagePath = path.resolve(__dirname, '..', 'assets', 'delivery-tarifario.png')
const paymentQrImagePath = path.resolve(__dirname, '..', 'assets', 'qr-pago-burger-lab.png')
const botVersion = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'local'

const SESSION_GAP_MS = 45 * 60 * 1000

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
  quickExtras: [],
}

async function handleIncomingMessage({ chatId, text, displayName = '' }) {
    if (!botEnabled) return

    await refreshTemporarySettings()
    const settings = getSettings()

    conversations.touchContact(chatId, {
      displayName,
      phone: resolveCustomerPhone(chatId, ''),
      text,
    })

    if (!settings.autoRepliesEnabled) return

    const explicitReset = settings.manualOrderEntryMode
      ? isExplicitManualResetRequest(text)
      : isExplicitResetRequest(text)
    if (conversations.isNewSession(chatId, SESSION_GAP_MS) || explicitReset) {
      conversations.resetSession(chatId)
    }

    if (!isWithinBusinessHours()) {
      if (settings.manualOrderEntryMode && await handleClosedManualInformationMessage({ chatId, text })) return
      if (explicitReset) {
        await whatsapp.sendText(
          chatId,
          `Memoria de prueba reiniciada con exito.\n\n${settings.closedMessage}`,
        )
        return
      }
      await whatsapp.sendText(
        chatId,
        settings.closedMessage,
      )
      return
    }

    if (!acceptingOrders) {
      await whatsapp.sendText(
        chatId,
        settings.pausedOrdersMessage,
      )
      return
    }

    conversations.add(chatId, 'cliente', text)
    const state = conversations.get(chatId)
    const previousPendingSummary = state.pendingOrder?.summary || ''
    const isFirstCustomerMessage = state.messages.filter((entry) => entry.role === 'cliente').length === 1

    if (settings.manualOrderEntryMode) {
      await handleManualOrderEntryMessage({ chatId, text, state })
      return
    }

    await whatsapp.startTyping(chatId)

    try {
      if (state.awaitingPaymentProof) {
        if (isCancelText(text)) {
          state.awaitingPaymentProof = null
          conversations.scheduleSave()
          const reply = 'Sin problema. Dejamos el pago pendiente; si quieres continuar, me mandas el comprobante o actualizamos el metodo de pago.'
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        const inferred = inferFieldsFromText(text)
        const isProof = isPaymentProofMessage(text)
        // isQuestionOrEditRequest se queda corto: su lista tiene "papas" y "tocino" pero no
        // "cebolla", asi que "Perdon quiero que una sea sin cebolla" no contaba como edicion y el
        // bot le volvia a pedir el comprobante ignorando el cambio. messageCanChangeItems ya
        // conoce todo el vocabulario de productos y extras.
        const isEditItemsRequest = (isQuestionOrEditRequest(text) || messageCanChangeItems(text)) && !isProof && !inferred.deliveryAddress

        if (isEditItemsRequest) {
          // Hay que devolver el pedido al borrador ANTES de soltar la espera del comprobante:
          // setAwaitingPaymentProof vacia pendingOrder y orderDraft, asi que sin esto el cliente
          // pierde todo lo que ya habia armado y tiene que empezar de cero.
          state.orderDraft = pendingOrderToDraft({ orderInput: state.awaitingPaymentProof.orderInput })
          state.awaitingPaymentProof = null
          conversations.scheduleSave()
        } else {
          if (inferred.deliveryAddress) {
            state.awaitingPaymentProof.orderInput.deliveryAddress = inferred.deliveryAddress
            conversations.scheduleSave()
          }
          if ((inferred.customerName || inferred.weakGuessedName) && !state.awaitingPaymentProof.orderInput.customerName) {
            state.awaitingPaymentProof.orderInput.customerName = inferred.customerName || inferred.weakGuessedName
            conversations.scheduleSave()
          }
          if (isProof) {
            state.awaitingPaymentProof.proofReceived = true
            conversations.scheduleSave()
          }

          if (state.awaitingPaymentProof.orderInput.fulfillmentType === 'delivery' && !state.awaitingPaymentProof.orderInput.deliveryAddress) {
            const reply = state.awaitingPaymentProof.proofReceived
              ? 'Perfecto, ya recibi tu comprobante. Solo me falta tu ubicacion normal de WhatsApp (no en tiempo real) o direccion exacta para pasar el pedido a caja.'
              : 'Ya tengo tu pedido listo para QR. Por favor enviame el comprobante y tu ubicacion normal de WhatsApp (no en tiempo real) o direccion exacta para el envio.'
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
            state.awaitingPaymentProof = null
            conversations.scheduleSave()

            const reply = buildRegisteredOrderReply([
              'Perfecto, recibi tu comprobante.',
              'Voy a pasar tu pedido a caja para que revisen el pago y confirmen el tiempo de salida.',
            ])

            conversations.add(chatId, 'bot', reply)
            await whatsapp.sendText(chatId, reply)
            return
          }

          const reply = 'Para avanzar con tu pedido por QR, por favor enviame el comprobante de pago por este chat. Caja lo revisara antes de confirmar.'
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }
      }

      // Respuesta a "¿como prefieres pagar?" (solo recojo). El pedido todavia no entro al
      // sistema: si paga en el restaurante entra ahora, y si elige QR se le manda y entra recien
      // cuando llegue el comprobante.
      if (state.pendingClarification === 'payment_pickup' && state.pendingOrder) {
        if (isPayAtRestaurantAnswer(text)) {
          const orderInput = state.pendingOrder.orderInput
          state.pendingClarification = null
          await registerConfirmedOrder(chatId, orderInput, {
            expectedPaymentMethod: 'cash',
            paymentReviewNote: 'El cliente paga al recoger en el restaurante.',
          })
          const reply = buildRegisteredOrderReply([
            'Perfecto, registré tu pedido.',
            `Pagas los Bs ${orderInput.total} en el restaurante cuando recojas.`,
            'En caja lo van a confirmar y te aviso el tiempo exacto de salida.',
          ])
          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        if (isPayNowQrAnswer(text)) {
          const orderInput = { ...state.pendingOrder.orderInput, expectedPaymentMethod: 'qr' }
          const summary = state.pendingOrder.summary
          state.pendingClarification = null
          await requestQrPaymentProof(chatId, orderInput, summary)
          return
        }

        const reply = `No me quedo claro. ${PICKUP_PAYMENT_QUESTION}`
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (isPaymentProofMessage(text)) {
        if (state.pendingOrder) {
          const orderInput = {
            ...state.pendingOrder.orderInput,
            expectedPaymentMethod: 'qr',
            paymentMethod: 'qr',
            qrProofReceived: true,
            paymentReviewNote: 'Cliente envio comprobante QR por WhatsApp. Caja debe revisarlo antes de confirmar pago.',
          }
          const created = await createWhatsappOrderWithRetry(orderInput)
          conversations.setLastOrder(chatId, created.orderId)
          state.pendingOrder = null
          state.orderDraft = null
          conversations.scheduleSave()

          const reply = buildRegisteredOrderReply([
            'Perfecto, recibi tu comprobante.',
            'Voy a pasar tu pedido a caja para que revisen el pago y confirmen el tiempo de salida.',
          ])

          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        if (state.orderDraft?.items?.length) {
          const mergedResult = mergeOrderDraft(state.orderDraft, buildEmptyAiResult(), text)
          const orderInput = buildOrderInput({ result: { ...mergedResult, paymentMethod: 'qr' }, chatId })
          orderInput.qrProofReceived = true
          orderInput.paymentReviewNote = 'Cliente envio comprobante QR por WhatsApp. Caja debe revisarlo antes de confirmar pago.'

          const created = await createWhatsappOrderWithRetry(orderInput)
          conversations.setLastOrder(chatId, created.orderId)
          state.orderDraft = null
          conversations.scheduleSave()

          const reply = buildRegisteredOrderReply([
            'Perfecto, recibi tu comprobante.',
            'Voy a pasar tu pedido a caja para que revisen el pago y confirmen el tiempo de salida.',
          ])

          conversations.add(chatId, 'bot', reply)
          await whatsapp.sendText(chatId, reply)
          return
        }

        const reply = 'Recibí tu comprobante por este chat. Para registrar tu pedido, por favor envíame primero los detalles de tu pedido en texto.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (state.pendingOrder && isConfirmText(text)) {
        await handleOrderConfirmation(chatId, state)
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

      // Igual que arriba pero para cuando el cliente todavia esta a mitad de dar los datos (sin
      // llegar a ver el resumen todavia) - antes "cancelar" en ese punto no tenia ningun manejo y
      // el bot solo seguia pidiendo el formato sin entender que el cliente se queria bajar.
      if (state.orderDraft?.items?.length && isCancelText(text)) {
        state.orderDraft = null
        conversations.scheduleSave()
        const reply = 'Sin problema, cancelado. Si quieres pedir algo, aquí estoy.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (!state.pendingOrder && !state.orderDraft?.items?.length && state.lastOrderId && isPostOrderCourtesyText(text)) {
        const reply = isPickupArrivalNotice(text)
          ? 'Con gusto, te esperamos.'
          : 'Con gusto, gracias a ti. Estamos atentos a tu pedido.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      // El pedido ya se registro y el cliente solo acusa recibo ("Perfecto", "Ya esta", "Dale").
      // Esto NO puede llegar a la IA: el historial de la conversacion todavia tiene el resumen
      // del pedido, asi que la IA lo lee, devuelve esos mismos items y el bot vuelve a preguntar
      // "Confirmas el pedido?" - y con el "Si" del cliente el MISMO pedido entra dos veces al
      // sistema. Ya le paso a un cliente real.
      if (
        !state.pendingOrder &&
        !state.orderDraft?.items?.length &&
        state.lastOrderId &&
        isAcknowledgementText(text) &&
        !isExplicitResetRequest(text)
      ) {
        const reply = 'Listo. Cualquier cosa me avisas, estamos atentos a tu pedido.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      // El pedido anterior ya se confirmo (fue a cocina) y no hay nada pendiente/en borrador -
      // una consulta de estado requiere que caja confirme la situacion real. Se avisa al equipo
      // y el bot guarda silencio para no afirmar que salio o que sigue en cocina sin saberlo.
      if (!state.pendingOrder && !state.orderDraft?.items?.length && state.lastOrderId && isConfirmedOrderStatusRequest(text)) {
        await notifyOrderStatusRequest(chatId, state.lastOrderId, text)
        return
      }

      // El pedido anterior ya se confirmo (fue a cocina) y no hay nada pendiente/en borrador -
      // si el cliente ahora quiere agregar/cambiar algo, NO lo reescribimos solos (ya se le avisa
      // a caja/cocina y modificarlo por atras podria desincronizarse con lo que ya estan
      // preparando). Avisamos directo a los duenos en vez de tocar Firestore de mas.
      if (!state.pendingOrder && !state.orderDraft?.items?.length && state.lastOrderId && isConfirmedOrderModificationRequest(text) && !isExplicitResetRequest(text)) {
        await notifyOrderModificationRequest(chatId, state.lastOrderId, text)
        return
      }

      // El menu, la ubicacion y el tarifario ya NO se deciden por palabras clave antes de la IA.
      // Ese atajo interceptaba mensajes que la IA sabia manejar: "quiero pedir para comer ahi en
      // el restaurante" recibia el formato y se cortaba ahi, sin llegar nunca a explicarle que
      // eso se pide en caja. Ahora se decide despues, segun lo que la IA entendio.
      const currentOrderDraft = state.orderDraft || pendingOrderToDraft(state.pendingOrder)
      if (currentOrderDraft?.items?.length && isPreparationTimeQuestion(text) && !messageCanChangeItems(text)) {
        const reply = 'El tiempo aproximado de preparación es de 15 a 20 minutos. Te avisamos apenas esté listo.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      const catalog = await getCatalogForParsing()

      // ENTENDER es tarea de la IA, no de listas de palabras. Antes habia un "camino rapido" que
      // interpretaba el mensaje con expresiones regulares y solo caia en la IA si no reconocia
      // nada. Ese atajo fue la causa de casi todos los errores: no encontraba "burguer" porque
      // buscaba "burger", sumaba en vez de restar por la palabra suelta "y", se quedaba con
      // "recoger" de una pregunta como si el cliente ya hubiera elegido. El espanol tiene
      // infinitas formas de escribir lo mismo y cada lista de palabras siempre va a estar
      // incompleta. Ahora todos los mensajes van a la IA y el codigo se limita a VERIFICAR.
      // El mensaje actual ya quedo guardado en el historial antes de llegar aca, asi que hay que
      // sacarlo: mandarselo dos veces a la IA (una dentro del historial y otra como "mensaje
      // nuevo") le hacia devolver el pedido VACIO. Comprobado con el mismo texto: con historial
      // limpio devuelve los productos, con el mensaje duplicado devuelve cero. Esto venia pasando
      // en TODOS los mensajes y era lo que parecia "variabilidad" del modelo.
      const previousMessages = state.messages.slice(0, -1)
      const aiResult = await understandMessage({
        message: text,
        conversation: previousMessages,
        catalog,
        currentDraft: currentOrderDraft,
      })

      // La IA avisa cuando prefiere no arriesgar una respuesta: se le pasa a una persona y el bot
      // se queda callado, que es mejor que contestar cualquier cosa.
      if (aiResult.needsHuman) {
        await notifyHumanSupport(chatId, text)
        return
      }

      const previousItems = state.orderDraft?.items || pendingOrderToDraft(state.pendingOrder)?.items || []
      const interpretedItems = applyTargetedOrderItemChange(
        previousItems,
        previousItems.length ? aiResult.items : reconcileInitialBurgerItems(aiResult.items, text, catalog),
        text,
        catalog,
      )
      const catalogItems = enforceCatalogItems(
        preserveItemsDuringAdditiveChange(previousItems, interpretedItems, text),
        catalog,
      )
      const result = {
        ...aiResult,
        items: applyExplicitOrderNotes(
          fixExtrasCountedTwice(
            enforceTripleRule(
              enforcePapasRule(
                previousItems,
                filterUnrequestedExtras(previousItems, catalogItems, text),
                text,
                catalog,
              ),
              catalog,
            ),
          ),
          text,
        ),
      }

      if (result.intent === 'confirm_order' && state.pendingOrder) {
        await handleOrderConfirmation(chatId, state)
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

      // Igual que con los atajos deterministicos: si el cliente ya viene llenando el formato
      // (dio nombre, celular o tipo de entrega), una palabra suelta como "envio" o "qr" es su
      // respuesta a ese campo, no una pregunta suelta sobre tarifas o como pagar - no lo
      // interrumpamos con informacion generica que le hace perder lo que ya escribio.
      const isMidTemplateFlow = Boolean(
        state.orderDraft?.customerName || state.orderDraft?.customerPhone ||
        state.orderDraft?.fulfillmentType || state.orderDraft?.items?.length ||
        state.pendingOrder,
      )

      if (result.intent === 'delivery_pricing' && !isMidTemplateFlow) {
        await sendDeliveryPricingInfo(chatId)
        return
      }

      if (result.intent === 'payment_qr_request' && !state.pendingOrder && !result.items.length && !isMidTemplateFlow) {
        await sendPaymentQrInfo(chatId)
        return
      }

      if (result.intent === 'human_help') {
        await notifyHumanSupport(chatId, text)
        return
      }

      if (result.intent === 'menu_request' && !result.items.length) {
        const caption = buildOrderTemplateMessage()
        conversations.add(chatId, 'bot', caption)
        await whatsapp.sendImage(chatId, menuImagePath, caption)
        return
      }

      // Primer mensaje de alguien que todavia no dio NADA util: se le manda el formato para que
      // sepa como pedir. Se decide con lo que entendio la IA y no con palabras clave, asi una
      // pregunta concreta (que la IA marca como "question") se responde en vez de recibir el
      // formato y quedar cortada.
      // Ojo con el "no dio nada": si mando su nombre o celular hay que dejarlo seguir al flujo
      // normal aunque no haya elegido productos todavia, porque este atajo corta sin guardar el
      // borrador y esos datos se perdian - despues el bot le volvia a pedir el nombre que ya
      // habia dado.
      const gaveSomethingUseful = Boolean(
        result.items.length || result.customerName || result.customerPhone || result.fulfillmentType || result.deliveryAddress,
      )
      if (isFirstCustomerMessage && !gaveSomethingUseful && ['greeting', 'order_draft', 'other'].includes(result.intent)) {
        const caption = buildOrderTemplateMessage()
        conversations.add(chatId, 'bot', caption)
        await whatsapp.sendImage(chatId, menuImagePath, caption)
        return
      }

      // Pregunta normal del negocio (horario, ubicacion, metodos de pago, etc.) que no trae
      // items nuevos: respondela directo, sin tocar el pedido en curso/pendiente. Si no hiciera
      // esta excepcion, un pedido pendiente "absorbe" la pregunta (como ya tiene items) y en vez
      // de contestar solo vuelve a mostrar el resumen, ignorando lo que el cliente pregunto.
      const inferredCurrentFields = inferFieldsFromText(text)
      const carriesCustomerLocation = Boolean(inferredCurrentFields.deliveryAddress) && !isRestaurantLocationRequest(text)
      const carriesConcreteOrder = looksLikeConcreteOrderText(text) || looksLikeStructuredOrderMessage(text)
      const protectsCurrentOrderQuestion = Boolean(
        previousItems.length &&
        isNonEditingOrderQuestion(text) &&
        !messageCanChangeItems(text) &&
        !carriesCustomerLocation &&
        !carriesConcreteOrder,
      )
      if (protectsCurrentOrderQuestion || shouldAnswerAsStandaloneQuestion({
        intent: result.intent,
        itemCount: result.items.length,
        carriesCustomerLocation,
        carriesConcreteOrder,
      })) {
        // Igual guardamos cualquier dato que la IA haya sacado de paso (ej. el cliente dijo su
        // nombre en el mismo mensaje que hizo la pregunta) - solo evitamos volver a mostrar el
        // resumen del pedido en vez de contestar lo que realmente pregunto.
        if (!state.pendingOrder && (result.customerName || result.customerPhone || result.fulfillmentType || result.deliveryAddress)) {
          const mergedResult = mergeOrderDraft(state.orderDraft || pendingOrderToDraft(state.pendingOrder), result, text)
          conversations.setOrderDraft(chatId, mergedResult)
        }
        conversations.add(chatId, 'bot', result.reply)
        await whatsapp.sendText(chatId, result.reply)
        // Si ademas preguntaba donde quedamos, le mandamos el pin. Esto no intercepta el mensaje:
        // la IA ya decidio que era una pregunta y ya la contesto, esto solo agrega la ubicacion.
        if (isRestaurantLocationRequest(text)) {
          const restaurantLocation = getRestaurantLocation()
          await whatsapp.sendLocation(chatId, {
            latitude: restaurantLocation.latitude,
            longitude: restaurantLocation.longitude,
            name: config.businessName,
            address: config.restaurantAddress,
          })
        }
        return
      }

      const mergedResult = mergeOrderDraft(state.orderDraft || pendingOrderToDraft(state.pendingOrder), result, text)

      // "Tiene algo que ver con armar un pedido?" - si es asi, guardamos el progreso (aunque sea
      // parcial, ej. solo el nombre) y seguimos pidiendo lo que falte, SIN reiniciar ni perder lo
      // ya dado. Si no hay ninguna senal de pedido (saludo suelto, pregunta del negocio, etc.), no
      // entra aca y sigue el flujo normal de conversacion mas abajo. El chequeo de intent por si
      // solo no es 100% confiable (la IA a veces clasifica un intento de pedido como "question" u
      // "other"), asi que tambien nos apoyamos en isOrderStartRequest sobre el texto real.
      const hasOrderSignal = Boolean(
        mergedResult.items.length ||
        mergedResult.customerName ||
        mergedResult.customerPhone ||
        mergedResult.fulfillmentType ||
        mergedResult.deliveryAddress ||
        result.intent === 'order_draft' ||
        result.intent === 'order_ready' ||
        isOrderStartRequest(text),
      )

      // Red de seguridad contra pedidos duplicados, por si algun mensaje que no es un acuse
      // simple igual llega hasta aca. Con un pedido ya registrado y nada pendiente ni en
      // borrador, los items que devuelve la IA solo pueden venir del historial de la
      // conversacion, no de lo que el cliente acaba de escribir. Rearmar el pedido en ese caso
      // es volver a pedir confirmacion por algo ya registrado, y termina en un duplicado. Para
      // empezar de nuevo exigimos que el mensaje actual traiga contenido de pedido de verdad.
      const wouldResurrectRegisteredOrder = Boolean(
        state.lastOrderId &&
        !state.pendingOrder &&
        !state.orderDraft?.items?.length &&
        mergedResult.items.length &&
        !looksLikeConcreteOrderText(text) &&
        !looksLikeStructuredOrderMessage(text) &&
        !isExplicitResetRequest(text),
      )

      if (wouldResurrectRegisteredOrder) {
        const reply = 'Tu pedido anterior ya quedó registrado. Si quieres pedir algo más, mándame el pedido nuevo y lo armamos.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      if (hasOrderSignal) {
        conversations.setOrderDraft(chatId, mergedResult)
        await finalizeOrderDraft({ chatId, state, draft: mergedResult, catalog, text, aiReply: result.reply, previousPendingSummary })
        return
      }

      if (result.intent === 'confirm_order' && !state.pendingOrder) {
        const reply = buildOrderTemplateMessage()
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      conversations.add(chatId, 'bot', result.reply)
      await whatsapp.sendText(chatId, result.reply)
    } catch (error) {
      // Si algo falla no se vuelve a adivinar el pedido con expresiones regulares (eso registraba
      // pedidos distintos de los que el cliente pidio). Se avisa a una persona y el bot guarda
      // silencio para no agregar otra respuesta potencialmente incorrecta.
      console.error('Error procesando mensaje:', error)
      await notifyHumanSupport(chatId, text).catch(() => undefined)
      return
    }
}

const TEST_MODE = process.env.BOT_TEST_MODE === '1'

const whatsapp = new WhatsappClient({
  onMessage: handleIncomingMessage,
  testMode: TEST_MODE,
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
      manualOrderEntryMode: settings.manualOrderEntryMode,
      autoSendDeliveryGroupOrders: settings.autoSendDeliveryGroupOrders === true,
      whatsappConnected: whatsapp.connected,
    })
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Health failed' })
  }
})

app.get('/settings', requireToken, (_req, res) => {
  res.json({ ok: true, settings: getSettings() })
})

app.get('/conversations', requireToken, (_req, res) => {
  const activeList = Array.from(conversations.byChatId.entries()).map(([chatId, state]) => ({
    chatId,
    lastMessageAt: state.lastMessageAt,
    messages: state.messages || [],
    hasPendingOrder: Boolean(state.pendingOrder),
    hasOrderDraft: Boolean(state.orderDraft),
    hasAwaitingPaymentProof: Boolean(state.awaitingPaymentProof),
    draftItems: state.orderDraft?.items || state.pendingOrder?.orderInput?.items || [],
  }))
  res.json({ ok: true, conversations: activeList })
})

app.get('/whatsapp/recent-chats', requireToken, (_req, res) => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const chats = Array.from(conversations.byChatId.entries())
    .filter(([chatId, state]) => chatId.endsWith('@s.whatsapp.net') && state.lastMessageAt >= cutoff)
    .map(([chatId, state]) => ({
      chatId,
      phone: state.contactPhone || resolveCustomerPhone(chatId, ''),
      name: state.contactName || '',
      lastMessage: state.lastCustomerMessage || '',
      lastMessageAt: state.lastMessageAt,
      recentMessages: (state.messages || [])
        .filter((message) => message.role === 'cliente')
        .slice(-6)
        .map((message) => ({ text: message.text, at: message.at })),
    }))
    .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
    .slice(0, 50)

  res.json({ ok: true, chats })
})

app.post('/settings', requireToken, async (req, res) => {
  const settings = await updateSettings(req.body || {})
  acceptingOrders = settings.acceptingOrders
  res.json({ ok: true, settings })
})

const MAX_BORRADOS_DE_VENTAS = 2

/**
 * Borra TODAS las ventas para entregar el sistema limpio despues de las pruebas.
 *
 * Limitado a dos usos: uno para probar y otro para la entrega final. El contador vive en los
 * ajustes del bot y no se puede modificar desde afuera, asi que no alcanza con borrar datos del
 * navegador para reiniciarlo.
 *
 * Solo toca pedidos y documentos de dia. El catalogo, los usuarios y la configuracion del bot
 * quedan intactos.
 */
app.post('/admin/reset-sales', requireToken, async (_req, res) => {
  const usados = Number(getSettings().salesResetsUsed || 0)

  if (usados >= MAX_BORRADOS_DE_VENTAS) {
    res.status(409).json({
      ok: false,
      error: `Ya se uso las ${MAX_BORRADOS_DE_VENTAS} veces permitidas. No quedan usos disponibles.`,
      usados,
      restantes: 0,
    })
    return
  }

  try {
    const resultado = await resetSalesData()
    const nuevosUsados = await registerSalesReset()
    console.log(`Ventas borradas: ${resultado.pedidosBorrados} pedidos en ${resultado.diasBorrados} dias. Usos: ${nuevosUsados}/${MAX_BORRADOS_DE_VENTAS}`)
    res.json({
      ok: true,
      ...resultado,
      usados: nuevosUsados,
      restantes: Math.max(0, MAX_BORRADOS_DE_VENTAS - nuevosUsados),
    })
  } catch (error) {
    console.error('No se pudo borrar el historial de ventas:', error)
    res.status(500).json({ ok: false, error: 'No se pudo borrar el historial de ventas.' })
  }
})

/** Cuantos borrados de ventas quedan, para mostrarlo en el boton de administracion. */
app.get('/admin/reset-sales/status', requireToken, (_req, res) => {
  const usados = Number(getSettings().salesResetsUsed || 0)
  res.json({ usados, restantes: Math.max(0, MAX_BORRADOS_DE_VENTAS - usados), maximo: MAX_BORRADOS_DE_VENTAS })
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
  if (!WHATSAPP_CONNECTION_DISABLED) {
    setTimeout(() => void whatsapp.start(), 1500)
  }
  res.json({ ok: true, whatsappConnectionDisabled: WHATSAPP_CONNECTION_DISABLED })
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

const confirmationSentViaEndpoint = new Set()

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

  if (order.whatsappConfirmationSentAt) {
    conversations.setLastOrder(chatId, order.id)
    res.json({ ok: true, alreadySent: true })
    return
  }

  // Mark in-memory FIRST to prevent polling from also sending
  confirmationSentViaEndpoint.add(order.id)

  // Mark in Firestore BEFORE sending the message to prevent race condition with polling
  await markWhatsappConfirmationSent(order)

  await whatsapp.sendText(
    chatId,
    buildConfirmationMessage(delayMinutes),
  )
  conversations.setLastOrder(chatId, order.id)
  await notifyDeliveryGroupOrderConfirmed(order, delayMinutes)

  res.json({ ok: true })
})

// Interruptor de emergencia (ver commit anterior): se reactiva la conexion ahora que la sesion
// vieja e incompatible (creada con Baileys 6.7.23) ya se borro a mano con "Cerrar sesion". Si
// hiciera falta frenar de nuevo, poner WHATSAPP_CONNECTION_DISABLED=1 en las variables de Railway.
const WHATSAPP_CONNECTION_DISABLED = process.env.WHATSAPP_CONNECTION_DISABLED === '1'

if (!TEST_MODE) {
  if (WHATSAPP_CONNECTION_DISABLED) {
    console.log('WHATSAPP_CONNECTION_DISABLED: no se intentara conectar a WhatsApp por ahora (freno de emergencia por error 405). El resto del bot sigue activo.')
  } else {
    await whatsapp.start()
    startConfirmationNoticePolling()
  }

  // El servidor de Railway corre en UTC y el restaurante esta en Bolivia. Dejar esto escrito al
  // arrancar hace que el desfase se vea de una: ya paso que pedidos hechos despues de las 20:00
  // de Bolivia se guardaran en el dia siguiente y nadie los viera en caja.
  const server = app.listen(config.port, () => {
    const settings = getSettings()
    const ahora = new Date()
    const horaLocalRestaurante = new Intl.DateTimeFormat('es-BO', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: config.timezone,
    }).format(ahora)
    const openHour = typeof settings.openHour === 'number' ? settings.openHour : config.openHour
    const closeHour = typeof settings.closeHour === 'number' ? settings.closeHour : config.closeHour
    console.log(`Zona horaria del restaurante: ${config.timezone}`)
    console.log(`Hora del servidor: ${ahora.toISOString()} | Hora en el restaurante: ${horaLocalRestaurante}`)
    console.log(`Horario de atencion: ${openHour}:00 a ${closeHour}:00 (hora del restaurante). Ahora mismo: ${isWithinBusinessHours() ? 'ABIERTO' : 'CERRADO'}`)
    console.log(`Bot API escuchando en http://localhost:${config.port}`)
  })

  const shutdown = (signal) => {
    console.log(`Cerrando bot por ${signal}...`)
    server.close(() => {
      console.log('Servidor HTTP cerrado correctamente.')
      process.exit(0)
    })

    setTimeout(() => process.exit(0), 5000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

process.on('unhandledRejection', (error) => {
  console.error('Promesa no manejada en el bot:', error)
})

export { handleIncomingMessage, whatsapp, TEST_MODE }

// Pedirle el comprobante por el chat solo tiene sentido si el cliente va a pagar por QR AHORA.
// Si avisa que paga en persona ("con qr pero pagare ahi"), mandarle el QR y quedarse esperando
// un comprobante que nunca va a llegar deja el pedido trabado sin registrarse.
function shouldRequestQrPaymentProof(orderInput) {
  // En delivery no se cobra nunca por el chat, aunque el cliente pida el QR: el total lo cobra la
  // moto al entregar (efectivo o QR) y el envio va aparte. Mandarle el QR del restaurante lo
  // haria pagar dos veces o pagar de menos.
  if (orderInput?.fulfillmentType === 'delivery') return false
  return orderInput?.expectedPaymentMethod === 'qr' && !orderInput?.paymentOnArrival
}

async function requestQrPaymentProof(chatId, orderInput, summary) {
  conversations.setAwaitingPaymentProof(chatId, orderInput, summary)
  const deliveryLine = orderInput.fulfillmentType === 'delivery'
    ? 'El envio se paga directamente al delivery.'
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

function buildRegisteredOrderReply(lines) {
  return [...lines, '', getSettings().registeredOrderFooterMessage].join('\n')
}

const PICKUP_PAYMENT_QUESTION = [
  '¿Cómo prefieres pagar?',
  '',
  '- *Con QR ahora* por este chat (te envío el QR y me mandas el comprobante)',
  '- *Directo en el restaurante* cuando recojas tu pedido',
].join('\n')

function isPayAtRestaurantAnswer(text) {
  const normalized = normalizeText(text)
  if (/\bqr\b/.test(normalized)) return false
  return /\b(restaurante|local|efectivo|cash|ahi|alli|alla|al recoger|cuando recoja|cuando vaya|al llegar|en persona|directo|contra entrega|contraentrega|despues|luego)\b/.test(normalized)
}

function isPayNowQrAnswer(text) {
  return /\bqr\b/.test(normalizeText(text))
}

// El pago del delivery nunca pasa por el chat: la moto cobra el total al entregar, en efectivo o
// QR, y el envio se cotiza aparte. Por eso el pedido de delivery entra al sistema apenas se
// confirma, sin pedir comprobante.
async function registerConfirmedOrder(chatId, orderInput, { paymentReviewNote = '', expectedPaymentMethod = null } = {}) {
  const finalInput = {
    ...orderInput,
    ...(expectedPaymentMethod ? { expectedPaymentMethod } : {}),
    ...(paymentReviewNote ? { paymentReviewNote } : {}),
  }
  const created = await createWhatsappOrderWithRetry(finalInput)
  conversations.setLastOrder(chatId, created.orderId)
  return created
}

async function handleOrderConfirmation(chatId, state) {
  const orderInput = state.pendingOrder.orderInput

  if (orderInput.fulfillmentType === 'delivery') {
    await registerConfirmedOrder(chatId, orderInput, {
      paymentReviewNote: 'El cliente paga el total directamente al delivery (efectivo o QR). El envio se cobra aparte.',
    })
    const reply = buildRegisteredOrderReply([
      'Perfecto, registré tu pedido.',
      '',
      `El total de Bs ${orderInput.total} lo pagas directamente con la moto, ya sea en efectivo o por QR.`,
      'El costo del envio se cotiza aparte y tambien lo pagas con el delivery.',
      '',
      'En caja lo van a confirmar y te aviso el tiempo exacto de salida.',
    ])
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  // Recojo: el pedido todavia NO entra al sistema. Primero se define como paga, porque si elige
  // QR hay que esperar el comprobante antes de mandarlo a caja.
  state.pendingClarification = 'payment_pickup'
  conversations.scheduleSave()
  conversations.add(chatId, 'bot', PICKUP_PAYMENT_QUESTION)
  await whatsapp.sendText(chatId, PICKUP_PAYMENT_QUESTION)
}

// Ultimo tramo comun a los dos caminos (el deterministico y el de la IA): faltantes, aclaracion
// de papas y resumen. Estaba duplicado y era cuestion de tiempo que los dos caminos se
// desincronizaran y uno preguntara cosas que el otro no.
async function finalizeOrderDraft({ chatId, state, draft, catalog, text, aiReply = '', previousPendingSummary = '' }) {
  const customerPhone = resolveCustomerPhone(chatId, draft.customerPhone)
  if (customerPhone && customerPhone !== draft.customerPhone) {
    draft = { ...draft, customerPhone }
    conversations.setOrderDraft(chatId, draft)
  }

  // Si el cliente pregunto algo en el mismo mensaje del pedido ("...Tiene motito ? O mando a
  // recoger ?"), la respuesta de la IA se antepone: antes se descartaba y el bot solo pedia el
  // dato que faltaba, dejando la pregunta sin contestar.
  // Hay que sacar las URLs antes de buscar el signo de pregunta: el link de ubicacion de WhatsApp
  // trae uno en la query ("maps.google.com/?q=...") y hacia que el bot creyera que el cliente
  // preguntaba algo, colando una respuesta suelta arriba del resumen.
  const textWithoutUrls = String(text || '').replace(/https?:\/\/\S+/gi, '')
  const shouldIncludeServiceNotice = draft.pickupOnlyAdjusted === true
  const prefix = aiReply && (/\?/.test(textWithoutUrls) || shouldIncludeServiceNotice) ? `${aiReply}\n\n` : ''
  const missingFields = getMissingOrderFields(draft)
  if (missingFields.length > 0) {
    if (shouldProceedWithQrWhileWaitingLocation(draft, missingFields)) {
      const orderInput = buildOrderInput({ result: draft, chatId })
      await requestQrPaymentProof(chatId, orderInput, buildOrderSummary(orderInput))
      return
    }
    const reply = `${prefix}${buildMissingFieldsReply(missingFields, { text, catalog, state })}`
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  const orderInput = buildOrderInput({ result: draft, chatId })
  if (orderInput.fulfillmentType === 'delivery' && orderInput.deliveryQuoteStatus === 'missing_location') {
    const reply = 'Perfecto, ya tengo tu pedido. Para el envio, mandame tu ubicacion normal de WhatsApp, no la ubicacion en tiempo real, por favor.'
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  const summary = buildOrderSummary(orderInput)
  if (shouldRequestQrPaymentProof(orderInput)) {
    await requestQrPaymentProof(chatId, orderInput, summary)
    return
  }

  conversations.setPendingOrder(chatId, orderInput, summary)
  if (shouldSuppressRepeatedOrderSummary(previousPendingSummary, summary, text)) {
    console.log(`Resumen identico omitido para ${chatId}; el pedido sigue esperando confirmacion.`)
    return
  }
  const reply = `${prefix}${summary}\n\n${getSettings().confirmationPromptMessage}`
  conversations.add(chatId, 'bot', reply)
  await whatsapp.sendText(chatId, reply)
}

async function createWhatsappOrderWithRetry(orderInput) {
  // BOT_TEST_MODE nunca debe escribir un pedido real en Firestore - el chat de prueba local
  // ya escribio pedidos reales por error una vez porque esta funcion no tenia este freno.
  if (TEST_MODE) {
    const fakeOrderId = 'test-order-' + Date.now()
    console.log(`\n[MODO PRUEBA] No se registro nada en Firestore. Pedido simulado (${fakeOrderId}):`, JSON.stringify(orderInput, null, 2))
    return { orderId: fakeOrderId, displayNumber: '#TEST' }
  }
  try {
    return await createWhatsappOrder(orderInput)
  } catch (error) {
    console.error('No se pudo registrar pedido en caja. Reintentando:', error)
    await sleep(700)
    return createWhatsappOrder(orderInput)
  }
}

async function handleManualOrderEntryMessage({ chatId, text, state }) {
  const normalized = normalizeText(text)

  if (text === '[audio_recibido]') {
    const reply = 'Para registrar correctamente tu pedido, por favor enviamelo todo por escrito. No podemos tomar pedidos por audio.'
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  if (isDeliveryPricingRequest(text)) {
    await sendDeliveryPricingInfo(chatId)
    return
  }

  if (isRestaurantLocationRequest(text) || isGeneralRestaurantLocationQuestion(text)) {
    const restaurantLocation = getRestaurantLocation()
    await whatsapp.sendLocation(chatId, {
      latitude: restaurantLocation.latitude,
      longitude: restaurantLocation.longitude,
      name: config.businessName,
      address: config.restaurantAddress,
    })
    return
  }

  if (isBusinessHoursQuestion(text)) {
    const settings = getSettings()
    const openHour = Number(settings.openHour ?? config.openHour)
    const closeHour = Number(settings.closeHour ?? config.closeHour)
    const reply = `Atendemos pedidos por WhatsApp de ${formatHour(openHour)} a ${formatHour(closeHour)}.`
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  if (isDeliveryAvailabilityQuestion(text)) {
    const settings = getSettings()
    const reply = settings.pickupOnlyMode
      ? settings.pickupOnlyMessage
      : 'Si, contamos con delivery. El costo del envio se cotiza aparte y se paga directamente al repartidor.'
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  if (isOrderTotalQuestion(text) && (await replyWithRegisteredOrderTotal({ chatId, state }))) return

  if (isQrRequest(text)) {
    if (hasDeliveryContext(state, text)) {
      const reply = 'En pedidos con delivery no enviamos el QR del restaurante. El total del pedido y el costo del envio se pagan directamente a la moto, en efectivo o por QR.'
      conversations.add(chatId, 'bot', reply)
      await whatsapp.sendText(chatId, reply)
    }
    return
  }

  const concreteOrder = looksLikeManualOrderContent(text)
  const wantsMenu = isMenuRequest(text)
  const wantsToStartOrder = isGenericOrderStart(text) && !concreteOrder
  const greetingOnly = !concreteOrder && isGreetingMessage(text)

  if (wantsMenu || wantsToStartOrder || greetingOnly) {
    if (!state.manualMenuInstructionsSent) {
      const instructions = buildOrderTemplateMessage()
      state.manualMenuInstructionsSent = true
      conversations.scheduleSave()
      conversations.add(chatId, 'bot', instructions)
      await whatsapp.sendText(chatId, instructions)
    }
    await whatsapp.sendImage(chatId, menuImagePath, '')
    return
  }

  // Pedidos, ubicaciones del cliente, comprobantes y cambios quedan para caja. El bot guarda el
  // chat reciente, pero no interpreta ni contesta para no alterar cantidades o productos.
  if (concreteOrder && getSettings().pickupOnlyMode && hasDeliveryContext(state, text)) {
    const reply = getSettings().pickupOnlyMessage
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  if (concreteOrder || isCustomerLocationMessage(text) || isPaymentProofMessage(text)) return

  if (isPostOrderCourtesyText(text) || isAcknowledgementText(text)) return

  // El registro es manual: los mensajes operativos quedan en contactos recientes y no deben
  // llenar el grupo de soporte. Solo se deriva una consulta realmente excepcional, con un
  // intervalo por chat para evitar varias alertas seguidas sobre el mismo asunto.
  if (!isExceptionalSupportQuestion(text)) return
  if (Date.now() - Number(state.lastManualSupportAlertAt || 0) < 10 * 60 * 1000) return
  state.lastManualSupportAlertAt = Date.now()
  conversations.scheduleSave()
  await notifyHumanSupport(chatId, text)
}

// "cuanto es", "cuanto me sale", "cual es el total"... Se pide que la frase hable de plata: si
// solo dice "cuanto falta" (tiempo) no entra aca.
function isOrderTotalQuestion(text) {
  const normalized = normalizeText(text)
  if (!/\b(cuanto|cuantos|total|monto|precio|cuenta)\b/.test(normalized)) return false
  if (/\b(demora|tarda|falta para|minutos|tiempo|rato)\b/.test(normalized)) return false
  return /\b(total|monto|precio|cuenta|es|sale|seria|debo|pago|pagar|salio|cuesta|vale)\b/.test(normalized)
}

// Contesta el total leyendo el pedido tal cual quedo cargado en caja. Si no hay pedido registrado
// devuelve false y el mensaje sigue su curso normal: preferimos no contestar antes que inventar
// una cifra.
async function replyWithRegisteredOrderTotal({ chatId, state }) {
  let order = null
  try {
    order = await getLatestOrderForCustomer({ chatId, phone: chatIdToPhone(chatId) })
  } catch (error) {
    console.error('No se pudo leer el pedido para responder el total:', error)
    return false
  }

  if (!order || !Number.isFinite(Number(order.total)) || Number(order.total) <= 0) return false

  const lines = [`El total de tu pedido es Bs ${Number(order.total)}.`]

  if (order.paymentStatus === 'paid') {
    lines.push('Ya figura como pagado, no tienes nada pendiente.')
  } else if (order.fulfillmentType === 'delivery') {
    lines.push('Ese monto lo pagas directo a la moto, en efectivo o por QR. El envio se cotiza aparte y tambien se paga a la moto.')
  } else {
    lines.push('Lo puedes pagar al momento de recoger tu pedido, en efectivo o por QR.')
  }

  const reply = lines.join(' ')
  conversations.add(chatId, 'bot', reply)
  await whatsapp.sendText(chatId, reply)
  if (state) conversations.scheduleSave()
  return true
}

function chatIdToPhone(chatId) {
  return String(chatId || '').split('@')[0].replace(/\D/g, '')
}

async function handleClosedManualInformationMessage({ chatId, text }) {
  if (isMenuRequest(text)) {
    await whatsapp.sendImage(chatId, menuImagePath, '')
    return true
  }

  if (isBusinessHoursQuestion(text)) {
    const settings = getSettings()
    const openHour = Number(settings.openHour ?? config.openHour)
    const closeHour = Number(settings.closeHour ?? config.closeHour)
    await whatsapp.sendText(chatId, `Atendemos pedidos por WhatsApp de ${formatHour(openHour)} a ${formatHour(closeHour)}.`)
    return true
  }

  if (isRestaurantLocationRequest(text) || isGeneralRestaurantLocationQuestion(text)) {
    const restaurantLocation = getRestaurantLocation()
    await whatsapp.sendLocation(chatId, {
      latitude: restaurantLocation.latitude,
      longitude: restaurantLocation.longitude,
      name: config.businessName,
      address: config.restaurantAddress,
    })
    return true
  }

  return false
}

function isMenuRequest(text) {
  const normalized = normalizeText(text)
  return /\b(menu|carta|productos|precios|que tienen|que venden)\b/.test(normalized)
}

function isGenericOrderStart(text) {
  const normalized = normalizeText(text)
  return /\b(quiero|quisiera|deseo|necesito|voy a|puedo)\b[^.\n]{0,35}\b(hacer|realizar|poner|pedir|pedido)\b|\bquiero pedir\b/.test(normalized)
}

function isExplicitManualResetRequest(text) {
  const normalized = normalizeText(text)
  return /\b(nuevo pedido|pedido nuevo|empezar de nuevo|cancelar pedido|borrar pedido)\b/.test(normalized)
}

function isGreetingMessage(text) {
  const normalized = normalizeText(text)
  return /^(hola+|ola|buenas(?:\s+(?:tardes|noches))?|buen dia|que tal)\b/.test(normalized)
}

function looksLikeManualOrderContent(text) {
  const normalized = normalizeText(text)
  if (text === '[imagen_recibida]' || text === '[comprobante_recibido]') return true
  const hasProduct = /\b(burger|burguer|hamburguesa|bbq|barbacoa|papas|tocino|pina|coca|fanta|sprite|agua|mocochinchi|jamaica|tamarindo|refresco|helado)\b/.test(normalized)
  const hasOrderVerb = /\b(quiero|quisiera|dame|deme|pedido|pedir|anade|agrega|aumenta|quita|cambia|modifica|sin)\b/.test(normalized)
  const structured = text.split(/\r?\n/).filter((line) => line.trim()).length >= 3
  return hasProduct || (structured && hasOrderVerb)
}

function isBusinessHoursQuestion(text) {
  const normalized = normalizeText(text)
  return /\b(horario|hora de apertura|hora abren|a que hora abren|hasta que hora|cuando abren|cuando cierran|a que hora cierran)\b/.test(normalized)
}

function isDeliveryAvailabilityQuestion(text) {
  const normalized = normalizeText(text)
  return /\b(tienen|hay|hacen|cuentan con|manejan)\b[^.\n]{0,25}\b(delivery|envio|moto)\b/.test(normalized)
}

function isQrRequest(text) {
  const normalized = normalizeText(text)
  return /\b(qr|codigo qr)\b/.test(normalized) && /\b(pagar|pago|pasame|mandame|envia|quiero|puedo|qr)\b/.test(normalized)
}

function hasDeliveryContext(state, text) {
  const recentCustomerText = (state.messages || [])
    .filter((message) => message.role === 'cliente')
    .slice(-6)
    .map((message) => message.text)
    .join(' ')
  const normalized = normalizeText(`${recentCustomerText} ${text}`)
  const lastPickup = Math.max(normalized.lastIndexOf('recojo'), normalized.lastIndexOf('recoger'), normalized.lastIndexOf('retiro'))
  const lastDelivery = Math.max(normalized.lastIndexOf('delivery'), normalized.lastIndexOf('envio'), normalized.lastIndexOf('moto'))
  return lastDelivery >= 0 && lastDelivery > lastPickup
}

function isCustomerLocationMessage(text) {
  const normalized = normalizeText(text)
  return /maps\.google\.com|maps\.app\.goo\.gl|ubicacion de whatsapp|\b(mi ubicacion|mi direccion|vivo en|entregar en)\b/.test(normalized)
}

function isGeneralRestaurantLocationQuestion(text) {
  const normalized = normalizeText(text)
  if (/\b(mi ubicacion|mi direccion|te mando|te envio|ya mande)\b/.test(normalized)) return false
  return /\b(cual es|pasame|mandame|me pasas|me mandas|me pasa|me manda|necesito|quiero)\b[^.\n]{0,40}\b(ubicacion|direccion)\b/.test(normalized)
}

function isExceptionalSupportQuestion(text) {
  const normalized = normalizeText(text)
  return /\b(factura|facturacion|nit|alergia|alergico|alergenos|gluten|vegetariano|vegano|ingredientes?|aceite|reclamo|queja|devolucion|reembolso|reserva|evento|mayorista|corporativo|proveedor|publicidad|colaboracion|convenio|trabajo|empleo)\b/.test(normalized)
}

function formatHour(hour) {
  const normalized = ((Number(hour) % 24) + 24) % 24
  const period = normalized >= 12 ? 'pm' : 'am'
  const display = normalized % 12 || 12
  return `${display}:00 ${period}`
}

async function sendDeliveryPricingInfo(chatId) {
  const caption = getSettings().deliveryPricingMessage
  const restaurantLocation = getRestaurantLocation()

  conversations.add(chatId, 'bot', caption)
  await whatsapp.sendImage(chatId, deliveryTariffImagePath, caption)
  await whatsapp.sendLocation(chatId, {
    latitude: restaurantLocation.latitude,
    longitude: restaurantLocation.longitude,
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

  const customer = getCustomerContact(chatId)

  const message = [
    'Intervencion requerida del bot.',
    `Cliente: ${customer.name}`,
    `Numero: ${customer.displayPhone}`,
    `Abrir chat: ${customer.chatUrl}`,
    `Mensaje: ${customerMessage}`,
    'El bot no respondio ese punto para evitar dar informacion incorrecta.',
  ].join('\n')

  await whatsapp.sendText(targetChatId, message)
}

async function notifyOrderModificationRequest(chatId, orderId, customerMessage) {
  const targetChatId = await resolveOwnerAlertChatId()
  if (!targetChatId) return

  const order = await findOrder(orderId).catch(() => null)
  const customer = getCustomerContact(chatId, {
    name: order?.customerName,
    phone: order?.customerPhone,
  })

  const message = [
    'Cliente quiere modificar un pedido que YA fue confirmado.',
    `Pedido: ${order?.displayNumber || orderId}`,
    `Cliente: ${order?.customerName || customer.name}`,
    `Numero: ${customer.displayPhone}`,
    `Abrir chat: ${customer.chatUrl}`,
    `Mensaje: ${customerMessage}`,
    'El bot no lo modifico solo para evitar descoordinacion con cocina - contactar directamente.',
  ].join('\n')

  await whatsapp.sendText(targetChatId, message)
}

async function notifyOrderStatusRequest(chatId, orderId, customerMessage) {
  const targetChatId = await resolveOwnerAlertChatId()
  if (!targetChatId) return

  const order = await findOrder(orderId).catch(() => null)
  const customer = getCustomerContact(chatId, {
    name: order?.customerName,
    phone: order?.customerPhone,
  })

  const message = [
    'Cliente consulta el estado de un pedido confirmado.',
    `Pedido: ${order?.displayNumber || orderId}`,
    `Cliente: ${order?.customerName || customer.name}`,
    `Numero: ${customer.displayPhone}`,
    `Abrir chat: ${customer.chatUrl}`,
    `Mensaje: ${customerMessage}`,
    'El bot no respondio para evitar informar un estado incorrecto - contactar directamente.',
  ].join('\n')

  await whatsapp.sendText(targetChatId, message)
}

async function notifyDeliveryGroupOrderConfirmed(order, delayMinutes) {
  if (order.fulfillmentType !== 'delivery') return
  if (getSettings().autoSendDeliveryGroupOrders !== true) return

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

function getCustomerContact(chatId, preferred = {}) {
  const state = conversations.get(chatId)
  const draft = state.orderDraft || pendingOrderToDraft(state.pendingOrder)
  const pendingInput = state.awaitingPaymentProof?.orderInput
  const phoneDigits = resolveCustomerPhone(chatId, preferred.phone || draft?.customerPhone || pendingInput?.customerPhone || '')

  return {
    name: preferred.name || draft?.customerName || pendingInput?.customerName || 'Cliente WhatsApp',
    displayPhone: formatCustomerPhone(phoneDigits),
    chatUrl: phoneDigits ? `https://wa.me/${phoneDigits}` : 'No disponible',
  }
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

function getAllowedExtrasForProduct(product, catalog) {
  const allowed = [...(product?.extras || [])]
  if (product?.categoryId === 'hamburguesas' && Array.isArray(catalog?.quickExtras)) {
    catalog.quickExtras.forEach((quickExtra) => {
      if (!allowed.some((extra) => extra.id === quickExtra.id)) allowed.push(quickExtra)
    })
  }
  return allowed
}

// EL CATALOGO MANDA, NO LA IA. Este es el freno que hace seguro dejar que la IA interprete todo:
// puede equivocarse en entender, pero no puede inventar un producto, un extra ni un precio. Todo
// lo que no exista en el catalogo se descarta, y nombre y precio se reescriben con los del
// catalogo, que es lo que realmente se cobra.
function resolveCatalogProduct(item, catalog) {
  const products = catalog?.products || []
  const itemName = normalizeText(item.name)
  const burgerHint = getBurgerCatalogHint(`${item.productId || ''} ${item.name || ''}`)
  return (
    products.find((candidate) => candidate.id === item.productId) ||
    products.find((candidate) => normalizeText(candidate.name) === itemName) ||
    (burgerHint
      ? products.find((candidate) => {
          if (candidate.categoryId !== 'hamburguesas') return false
          const candidateHint = getBurgerCatalogHint(`${candidate.id || ''} ${candidate.name || ''}`)
          return candidateHint === burgerHint
        })
      : null) ||
    (itemName
      ? products.find((candidate) => {
          const candidateName = normalizeText(candidate.name)
          return candidateName.includes(itemName) || itemName.includes(candidateName)
        })
      : null) ||
    null
  )
}

function getBurgerCatalogHint(value) {
  const normalized = normalizeText(value)
  if (!/burger|burguer|hamburguesa|bbq|barbacoa|barbakoa/.test(normalized)) return ''
  const brand = /\bbbq\b|barbacoa|barbakoa/.test(normalized) ? 'bbq' : 'burger-lab'
  const size = /doble|double/.test(normalized) ? 'doble' : 'simple'
  const fries = /sin\s+papas?/.test(normalized) ? 'sin-papas' : 'con-papas'
  return `${brand}:${size}:${fries}`
}

function enforceCatalogItems(items, catalog) {
  const discarded = []

  const cleaned = (items || [])
    .map((item) => {
      const product = resolveCatalogProduct(item, catalog)
      if (!product) {
        discarded.push(`producto "${item.name || item.productId}"`)
        return null
      }

      const quantity = Math.max(1, Math.round(Number(item.quantity) || 1))
      return {
        ...item,
        productId: product.id,
        name: product.name,
        basePrice: Number(product.price || 0),
        quantity,
      }
    })
    .filter(Boolean)

  if (discarded.length) {
    console.warn(`Descartado por no existir en el catalogo: ${discarded.join(', ')}`)
  }

  return enforceCatalogExtras(cleaned, catalog)
}

function enforceCatalogExtras(items, catalog) {
  const discarded = []

  const cleaned = (items || []).map((item) => {
    const product = resolveCatalogProduct(item, catalog)
    if (!product) return item

    const allowed = getAllowedExtrasForProduct(product, catalog)
    const extras = (item.extras || [])
      .map((extra) => {
        const extraName = normalizeText(extra.name)
        const match =
          allowed.find((candidate) => candidate.id === extra.id) ||
          allowed.find((candidate) => normalizeText(candidate.name) === extraName) ||
          // Rescate por nombre parcial: asi "Sandwich de queso/huevo" vuelve a ser "Queso", que
          // es lo que el cliente realmente pidio, en vez de perderse.
          allowed.find((candidate) => {
            const candidateName = normalizeText(candidate.name)
            return Boolean(extraName) && (extraName.includes(candidateName) || candidateName.includes(extraName))
          })

        if (match) return { id: match.id, name: match.name, price: Number(match.price) || 0 }
        discarded.push(`"${extra.name}" en "${product.name}"`)
        return null
      })
      .filter(Boolean)

    return { ...item, extras }
  })

  if (discarded.length) {
    console.warn(`Extras descartados por no existir en el catalogo del producto: ${discarded.join(', ')}`)
  }

  return cleaned
}

function sanitizeOrderItems(items) {
  // OJO: los extras repetidos SI son validos (2 entradas iguales = 2 unidades de ese extra,
  // ej. "doble porcion de tocino"). No deduplicar por id/name aca - eso colapsaba cualquier
  // pedido de mas de 1 unidad del mismo extra a solo 1.
  return (items || []).map((item) => {
    const rawExtras = Array.isArray(item.extras) ? item.extras : Array.isArray(item.modifiers?.extras) ? item.modifiers.extras : []
    return {
      ...item,
      extras: rawExtras.filter((extra) => extra && (extra.id || extra.name)),
    }
  })
}



function mergeOrderDraft(previous, result, text) {
  const inferred = inferFieldsFromText(text)
  // La IA siempre devuelve la lista COMPLETA del pedido (ve el borrador actual en el prompt), asi
  // que reemplaza, nunca se suma a lo anterior: combinarlas duplicaba cantidades. Si vino vacia,
  // se conserva lo que ya habia.
  // El freno de keepPreviousItems sigue siendo necesario: la IA rearma la lista en CADA respuesta,
  // incluso cuando el mensaje no hablaba de comida, y a veces la devuelve cambiada. A un cliente
  // real le convirtio "Tocino, Tocino" en "Salsa BBQ, Salsa BBQ" (Bs 30 -> Bs 26) cuando lo unico
  // que escribio fue que pagaria con QR. Un mensaje que no menciona productos ni pide un cambio
  // no puede tocar lo que el cliente ya vio y aprobo.
  const keepPreviousItems = Boolean(previous?.items?.length) && !messageCanChangeItems(text)
  const mergedItems = keepPreviousItems
    ? previous.items
    : result.items.length
      ? result.items
      : previous?.items || []
  const merged = {
    ...result,
    items: sanitizeOrderItems(mergedItems),
    customerName: result.customerName || inferred.customerName || previous?.customerName || inferred.weakGuessedName || '',
    customerPhone: result.customerPhone || inferred.customerPhone || previous?.customerPhone || '',
    paymentMethod: result.paymentMethod || inferred.paymentMethod || previous?.paymentMethod || null,
    paymentOnArrival: Boolean(inferred.paymentOnArrival || previous?.paymentOnArrival),
    extrasPerUnit: Boolean(inferred.extrasPerUnit || previous?.extrasPerUnit),
    fulfillmentType: result.fulfillmentType || inferred.fulfillmentType || previous?.fulfillmentType || null,
    deliveryAddress: result.deliveryAddress || inferred.deliveryAddress || previous?.deliveryAddress || '',
  }

  if (getSettings().pickupOnlyMode && merged.fulfillmentType === 'delivery') {
    return {
      ...merged,
      fulfillmentType: 'pickup',
      deliveryAddress: '',
      pickupOnlyAdjusted: true,
      reply: merged.reply ? `${getSettings().pickupOnlyMessage}\n\n${merged.reply}` : getSettings().pickupOnlyMessage,
    }
  }

  return merged
}

function isExplicitResetRequest(text) {
  const norm = normalizeText(text)
  return /\b(nuevo pedido|pedido nuevo|otro pedido|otra vez|de nuevo|un pedido mas|otro mas|reiniciar|empezar de nuevo|borrar pedido|cancelar pedido|menu de cero)\b/.test(norm)
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
  const explicitlyChoosesMoto = /\b(?:si\s+)?(?:por|con)\s+(?:la\s+)?mot(?:o|ito)\b|\bmand(?:a|alo|enlo|amelo)\b[^.\n]{0,20}\bmot(?:o|ito)\b/.test(normalized)
  const fulfillmentType = /\b(envio|delivery|domicilio)\b/.test(normalized) || explicitlyChoosesMoto
    ? 'delivery'
    : /\b(recojo|recoger|retiro|retirar|local)\b/.test(normalized)
      ? 'pickup'
      : null
  const rawText = String(text || '').trim()

  let deliveryAddress = ''
  const mapsMatch = rawText.match(/https:\/\/maps\.google\.com\/\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/i)
  if (mapsMatch) {
    deliveryAddress = mapsMatch[0]
  } else if (/\b(ubicacion|direccion|calle|av|avenida|barrio|zona|pasaje|esquina)\b/i.test(rawText)) {
    // Solo tratamos el mensaje entero como direccion si de verdad PARECE solo una direccion
    // (corto, sin productos del menu) - antes cualquier mensaje que mencionara "delivery" en
    // cualquier parte (incluido el pedido completo con nombre/celular/items) se guardaba entero
    // como direccion, dejando el campo real de ubicacion siempre "lleno" con basura.
    const looksLikeOrderNotAddress = looksLikeConcreteOrderText(normalized)
    if (rawText.length >= 5 && rawText.length <= 140 && !looksLikeOrderNotAddress && !isConfirmText(text) && !isCancelText(text) && !paymentMethod) {
      deliveryAddress = rawText
    }
  }

  // Sacamos las URLs antes de buscar el nombre - si no, palabras como "https" o "maps"
  // (de un link de ubicacion de WhatsApp) pasan el chequeo de "parece un nombre".
  const cleanTextForName = rawText.replace(/[*_~]/g, '').replace(/https?:\/\/\S+/gi, '').trim()
  const introducedName = cleanTextForName.match(/\b(?:mi\s+nombre\s+es|nombre\s*(?:es\s+|:\s*)?|me\s+llamo\s+|soy\s+)[ \t:]*([\p{L}]{2,}(?:[ \t]+[\p{L}]{2,}){0,2})/iu)?.[1]?.trim()
  const possibleName = cleanTextForName
    .split(/[\n,:.]/)
    .map((part) => part.replace(/\b(mi\s+nombre\s+es|nombre|me\s+llamo|soy)\b/gi, '').trim())
    .find((part) => isLikelyCustomerName(part))

  const phoneMatch = rawText.match(/(?:\+?591[\s-]?)?\b([67]\d{7})\b/)
  const customerPhone = phoneMatch ? phoneMatch[1] : ''

  return {
    paymentMethod,
    paymentOnArrival: isPayOnArrivalText(text),
    // "2 bbq con tocino cada una" = un tocino por hamburguesa. Sin esta señal explicita, un extra
    // pedido junto a varias hamburguesas se entiende como uno solo en total.
    // Solo formas con "cada", que no son ambiguas. Se probo con "las dos con"/"ambas con" y hay
    // que dejarlas fuera: la respuesta "las dos con papas" las activaba y volvia a cobrar el
    // extra dos veces. Ante la duda conviene el falso negativo, que nunca cobra de mas.
    extrasPerUnit: /\b(cada una|cada uno|en cada|a cada|para cada)\b/.test(normalized),
    fulfillmentType,
    deliveryAddress,
    // introducedName ("me llamo X"/"soy X") es una senal fuerte y explicita - puede corregir un
    // nombre previo. possibleName es solo una adivinanza (cualquier palabra de 1-2 palabras que
    // no esta en la lista negra) - nunca debe pisar un nombre ya confirmado, solo sirve como
    // ultimo recurso cuando todavia no hay ninguno.
    customerName: introducedName || '',
    weakGuessedName: possibleName || '',
    customerPhone,
  }
}

function isLikelyCustomerName(value) {
  if (!/^[\p{L}]{3,}(?:\s+[\p{L}]{3,})?$/u.test(value)) return false
  const normalized = normalizeText(value)
  if (/\b(qr|efectivo|mixto|pago|envio|delivery|domicilio|recojo|retiro|local|ubicacion|whatsapp|burger|hamburguesa|papas|coca|fanta|sprite|agua)\b/.test(normalized)) return false
  // Saludos y muletillas comunes no son nombres, aunque cumplan el patron de "1-2 palabras con letras".
  if (/\b(hol+a+|buen(a|o)s?|dias?|tardes?|noches?|gracias|porfa(vor)?|disculp[ae]|permis[oa]|que\s*tal|alo|ola|chau|adios|si|no|ok|okay|listo|dale)\b/.test(normalized)) return false
  return true
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




function findCatalogProduct(catalog, productId) {
  return (catalog.products || []).find((product) => product.id === productId && product.isVisible !== false && product.isActive !== false)
}





// --- Papas: nunca asumir, porque cambia el precio (BBQ Simple: Bs 23 con papas, Bs 20 sin) ---





// Regla del dueño: si el cliente no escribe "sin papas", la hamburguesa va CON papas. Es la
// version que mas se pide y evita tener que preguntar en cada pedido. Solo un "sin papas"
// explicito cambia el producto. Ademas esto tapa un error real: la IA entendio "que una sea sin
// cebolla" como "sin papas" y le cambio la hamburguesa de Bs 22 a Bs 19 - una nota nunca puede
// cambiar el producto.
function enforcePapasRule(previousItems, items, text, catalog) {
  const normalized = normalizeText(text)
  const explicitlyWithoutFries = (
    /\bsin\s+papas?\b/.test(normalized) ||
    /\bno\s+(?:te\s+)?(?:dije|pedi|quiero|queria)\b[^.?!]*\bcon\s+papas?\b/.test(normalized)
  )
  if (explicitlyWithoutFries) {
    const burgerItems = (items || []).filter((item) => getBurgerCatalogHint(`${item.productId || ''} ${item.name || ''}`))
    if (burgerItems.length !== 1) return items

    return (items || []).map((item) => {
      const hint = getBurgerCatalogHint(`${item.productId || ''} ${item.name || ''}`)
      if (!hint || item !== burgerItems[0]) return item
      const targetHint = hint.replace(/:(?:con|sin)-papas$/, ':sin-papas')
      const withoutFries = (catalog.products || []).find((product) => (
        product.categoryId === 'hamburguesas' &&
        getBurgerCatalogHint(`${product.id || ''} ${product.name || ''}`) === targetHint
      ))
      if (!withoutFries) return item
      return { ...item, productId: withoutFries.id, name: withoutFries.name, basePrice: Number(withoutFries.price || 0) }
    })
  }

  return (items || []).map((item) => {
    if (!item.productId?.includes('-sin-papas')) return item
    // Si ya lo tenia asi de antes, el cliente lo pidio sin papas en otro mensaje: se respeta.
    if ((previousItems || []).some((previous) => previous.productId === item.productId)) return item
    const conPapas = findCatalogProduct(catalog, item.productId.replace('-sin-papas', '-con-papas'))
    if (!conPapas) return item
    return { ...item, productId: conPapas.id, name: conPapas.name, basePrice: Number(conPapas.price || 0) }
  })
}

// "Triple" no existe como producto: es la DOBLE con una carne extra. La IA marca en cada item el
// tamaño que pidio el cliente (sizeRequested), asi que se aplica exactamente a las que pidio
// triples y no a las demas: en "2 bbq triple y 1 burger lab doble", las dos bbq llevan carne extra
// y la burger lab no. Sin esto se cobraba la doble a secas, Bs 15 menos por hamburguesa.
function enforceTripleRule(items, catalog) {
  const carneExtra = (catalog?.quickExtras || []).find((extra) => /carne/i.test(extra.name || ''))

  return (items || []).flatMap((item) => {
    const esTriple = item.customerAskedTriple === true && /^(burger-lab|bbq)-/.test(item.productId || '')
    if (!esTriple) return [item]

    let base = item
    if (base.productId.includes('-simple-')) {
      const doble = findCatalogProduct(catalog, base.productId.replace('-simple-', '-doble-'))
      if (doble) base = { ...base, productId: doble.id, name: doble.name, basePrice: Number(doble.price || 0) }
    }

    // Con la carne extra en la lista, la nota "(carne extra (triple))" que a veces agrega la IA
    // sobra y la cocina puede leerla como una segunda carne.
    base = {
      ...base,
      note: String(base.note || '')
        .replace(/\(?\s*carne\s+extra\s*(\(triple\))?\s*\)?/gi, '')
        .replace(/\(?\s*triples?\s*\)?/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s,;.]+|[\s,;.]+$/g, ''),
    }

    if (!carneExtra) return [base]

    const otrosExtras = (base.extras || []).filter((extra) => extra.id !== carneExtra.id)
    const cantidad = Math.max(1, Number(base.quantity) || 1)

    // Cada triple lleva SU carne extra. Con varias, la linea se separa en unidades para que cada
    // una la tenga: el precio se calcula por linea, asi que dejarlas juntas cobraria una sola
    // carne para todas. Los demas extras siguen la regla normal y van en una sola unidad.
    if (cantidad === 1) return [{ ...base, extras: [...otrosExtras, carneExtra] }]

    return Array.from({ length: cantidad }, (_unused, indice) => ({
      ...base,
      quantity: 1,
      extras: indice === 0 ? [...otrosExtras, carneExtra] : [carneExtra],
    }))
  })
}

// Si el adicional va uno por unidad, en la lista tiene que figurar UNA sola vez: el precio ya se
// multiplica por la cantidad del item. La IA a veces lo repite tantas veces como unidades hay y
// ahi se cobra al cuadrado - a un cliente que pidio "3 BBQ LAB con extra piña" le salian 9 piñas.
// Solo se corrige cuando la repeticion coincide EXACTO con la cantidad, que es la firma de ese
// error; un pedido legitimo como "2 hamburguesas con 2 piñas cada una" no se toca.
function fixExtrasCountedTwice(items) {
  return (items || []).map((item) => {
    const quantity = Number(item.quantity) || 1
    if (!item.extrasForEachUnit || quantity < 2 || !(item.extras || []).length) return item

    const porExtra = new Map()
    for (const extra of item.extras) {
      const clave = extra.id || extra.name
      porExtra.set(clave, [...(porExtra.get(clave) || []), extra])
    }

    const extras = []
    for (const repetidos of porExtra.values()) {
      extras.push(...(repetidos.length === quantity ? [repetidos[0]] : repetidos))
    }

    return { ...item, extras }
  })
}

function getMissingOrderFields(result) {
  const missing = []
  if (!result.customerName) missing.push('tu nombre')
  if (!result.customerPhone) missing.push('tu numero de celular')
  if (!result.fulfillmentType) missing.push('si es recojo o envio')
  if (result.fulfillmentType === 'delivery' && !result.deliveryAddress) missing.push('tu ubicacion de WhatsApp')
  if (!result.items?.length) missing.push('tu pedido')
  return missing
}

// Quedo sin uso: adelantaba el cobro por QR de un pedido con delivery mientras se esperaba la
// ubicacion, y en delivery ya no se cobra nunca por el chat (el total lo cobra la moto).
function shouldProceedWithQrWhileWaitingLocation() {
  return false
}

const ORDER_FORMAT_REDIRECT_MESSAGE = 'Claro, por favor llenar los datos según formato (como en el ejemplo)'

function buildOrderTemplateMessage() {
  const pickupOnly = getSettings().pickupOnlyMode
  const deliveryLine = pickupOnly
    ? `- Recojo en el local (${getSettings().pickupOnlyMessage})`
    : `- Delivery o Recoger (En caso de delivery enviar ubicación GPS)`

  return `¡Hola! 🍔 Para que tu pedido de hamburguesas por WhatsApp sea más fácil y preciso, te pedimos los siguientes datos:

- Nombre o apellido
${deliveryLine}
- Número de Celular
- Pedido (Renglón saltado, como en el ejemplo de abajo)
- Si deseas pagar con QR, indícalo en tu mensaje (si no se especifica, el pedido se registra en efectivo)

*Ejemplo:*
Ramirez
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
}

// El formato ya se le mando en esta conversacion? El mensaje corto dice "como en el ejemplo", asi
// que mandarlo sin haber mostrado el ejemplo deja al cliente preguntando "que ejemplo?" - paso de
// verdad, y repetirle lo mismo lo dejaba en un callejon sin salida.
function hasSeenOrderTemplate(state) {
  return (state?.messages || []).some(
    (entry) => entry.role === 'bot' && String(entry.text || '').includes('*Ejemplo:*'),
  )
}

function buildMissingFieldsReply(missingFields, { text = '', catalog = null, state = null } = {}) {
  if (missingFields.length === 1 && missingFields[0] === 'tu ubicacion de WhatsApp') {
    return 'Ya tengo tu pedido casi listo. Por favor enviame tu *ubicacion normal de WhatsApp* (no en tiempo real) o una direccion exacta para finalizar.'
  }

  if (missingFields.includes('tu pedido')) {
    // Dijo "hamburguesas" sin decir cuales: preguntarle cuales, que es lo unico que destraba la
    // conversacion. Repetirle el formato no le responde nada.
    if (catalog && mentionsBurgersWithoutChoosing(text)) {
      return buildBurgerChoicesReply(catalog)
    }

    if (state && !hasSeenOrderTemplate(state)) {
      return buildOrderTemplateMessage()
    }

    return ORDER_FORMAT_REDIRECT_MESSAGE
  }

  // Ya hay productos y solo faltan datos sueltos: decir cuales. El cliente que va dando los datos
  // de a un mensaje recibia cuatro veces seguidas el mismo "llenar los datos segun formato" sin
  // enterarse nunca de que era lo que faltaba.
  const pending = missingFields.join(', ').replace(/, ([^,]*)$/, ' y $1')
  return `Ya tengo tu pedido anotado. Solo me falta ${pending}.`
}

// Inverso de buildOrderInput: una vez que el pedido pasa a "pendingOrder" (ya se mostro el
// resumen y se espera "Confirmas?"), el orderDraft se limpia. Sin esto, si el cliente manda una
// correccion en ese punto ("es doble porcion de tocino"), la IA no tiene ningun contexto del
// pedido que ya se armó y no puede aplicar el cambio.
function pendingOrderToDraft(pendingOrder) {
  if (!pendingOrder?.orderInput) return null
  const orderInput = pendingOrder.orderInput
  return {
    intent: 'order_draft',
    reply: '',
    missingFields: [],
    customerName: orderInput.customerName || '',
    customerPhone: orderInput.customerPhone || '',
    paymentMethod: orderInput.expectedPaymentMethod || null,
    paymentOnArrival: Boolean(orderInput.paymentOnArrival),
    fulfillmentType: orderInput.fulfillmentType || null,
    deliveryAddress: orderInput.deliveryAddress || '',
    items: (orderInput.items || []).map((item) => ({
      productId: item.id,
      name: item.name,
      basePrice: item.basePrice,
      quantity: item.quantity,
      note: item.modifiers?.note || '',
      options: item.modifiers?.options || [],
      extras: item.modifiers?.extras || [],
    })),
  }
}

// El cliente pidio "2 BBQ LAB" y "1 tocino extra": pidio UN tocino, no uno por hamburguesa. El
// precio de cada linea se calcula como (base + extras) x cantidad, asi que dejar ese extra en una
// linea de 2 unidades lo cobraba dos veces (a un cliente real le sumo Bs 6 de mas). Separamos una
// unidad con los extras y el resto sin ellos: la cuenta da bien y la cocina ve cual lleva que.
// Si el cliente dijo "cada una", entonces si van en todas y no se separa nada.
function distributeExtrasOverUnits(items, extrasPerUnit) {
  const result = []
  for (const item of items || []) {
    const quantity = Number(item.quantity) || 1
    // Que el adicional sea uno por cada unidad o uno en total depende de como lo escribio el
    // cliente, no de una regla fija: "3 BBQ LAB con extra piña" son tres piñas, una por
    // hamburguesa, pero "2 BBQ LAB simple" con "1 tocino extra" en otro renglon es un solo
    // tocino. Eso lo decide la IA por item (extrasForEachUnit); antes lo decidia este codigo
    // siempre igual y a un cliente le puso las 3 piñas en una sola hamburguesa.
    if (extrasPerUnit || item.extrasForEachUnit) {
      result.push(item)
      continue
    }
    if (quantity > 1 && (item.extras || []).length) {
      result.push({ ...item, quantity: 1 })
      result.push({ ...item, quantity: quantity - 1, extras: [] })
    } else {
      result.push(item)
    }
  }
  return result
}

function buildOrderInput({ result, chatId }) {
  const items = distributeExtrasOverUnits(result.items, result.extrasPerUnit).map((item) => {
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
    paymentOnArrival: Boolean(result.paymentOnArrival),
    fulfillmentType: result.fulfillmentType || 'pickup',
    customerName: result.customerName,
    customerPhone: resolveCustomerPhone(chatId, result.customerPhone),
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


function looksLikeStructuredOrderMessage(text) {
  const inferred = inferFieldsFromText(text)
  const providedCount = [inferred.customerName, inferred.customerPhone, inferred.fulfillmentType].filter(Boolean).length
  return providedCount >= 2
}

// Unica fuente de verdad para reconocer la familia "burger lab". La gente la escribe de muchas
// formas (burguer, burguerlab, hamburguesa, burguesa) y tener la lista copiada a mano en cada
// funcion fue justo lo que rompio el pedido "Dos burguer lab con papas": la deteccion aceptaba
// "burguer", pero la cuenta de cantidad buscaba el texto literal "burger", no lo encontraba y
// caia al valor por defecto de 1. Cualquier variante nueva se agrega solo aca.
const BURGER_FAMILY_SOURCE = '(?:burguer\\s*lab|burger\\s*lab|hamburguesas?|burguesas?|burguers?|burgers?)'

function burgerFamilyRegex(flags = '') {
  return new RegExp(`\\b${BURGER_FAMILY_SOURCE}\\b`, flags)
}

function isOrderStartRequest(text) {
  const normalized = normalizeText(text)
  return (
    burgerFamilyRegex().test(normalized) ||
    /\b(quiero|quisiera|pedido|pedir|ordenar|bbq|barbacoa|simple|doble|triple|papas|gaseosa|mocochinchi|agua|refresco)\b/.test(normalized)
  )
}

function looksLikeConcreteOrderText(text) {
  const normalized = normalizeText(text)
  return (
    burgerFamilyRegex().test(normalized) ||
    /\b(bbq|barbacoa|simple|doble|triple|papas|tocino|pina|gaseosa|coca|fanta|sprite|agua|mocochinchi|jamaica|tamarindo|refresco|helado)\b/.test(normalized)
  )
}

// Solo un mensaje que nombra productos o pide explicitamente un cambio puede modificar los
// items del pedido. Ojo con agregar palabras sueltas y comunes aca (como "con" o "por"): son
// justo las que aparecen en mensajes que NO hablan de comida ("que sea con qr por favor"), y
// dejarlas pasar reabre el bug de que la IA reescriba el pedido por su cuenta.
function messageCanChangeItems(text) {
  const normalized = normalizeText(text)
  // Correccion de cantidad sin nombrar el producto ("no espera, mejor 3"). Se exige que despues
  // de la palabra venga un numero: si no, "mejor pago con qr" contaria como cambio de pedido y
  // volveria a dejar que la IA reescriba los productos, que es el bug que ya costo caro antes.
  const quantityCorrection = /\b(mejor|solo|solamente|unicamente|que sean|que sea|dejame|deja|ponme|pon)\s+(?:sean\s+)?(\d+|un|una|uno|dos|tres|cuatro|cinco|seis)\b/.test(normalized)
  return (
    looksLikeConcreteOrderText(text) ||
    isOrderStartRequest(text) ||
    quantityCorrection ||
    /\b(agrega|agregame|agregale|aumenta|aumentame|anade|anadir|saca|sacame|sacale|saquen|quita|quitame|quitale|elimina|eliminar|borra|borrar|cambia|cambiame|cambiale|modifica|modificame|sin|extra|extras|adicional|adicionales|porcion|porciones)\b/.test(normalized)
  )
}

// "pagare ahi", "pago al recoger", "cancelo cuando llegue": el cliente avisa que va a pagar en
// persona, no por el chat. Aunque diga QR no hay que mandarle el QR ni quedarse esperando un
// comprobante, porque nunca lo va a enviar y el pedido queda trabado sin registrarse.
function isPayOnArrivalText(text) {
  const normalized = normalizeText(text)
  return (
    /\b(pagare|pagaria|pago|pagar|cancelo|cancelare|abono|abonare)\b/.test(normalized) &&
    /\b(ahi|ahi mismo|alli|alla|en el local|en el restaurante|al recoger|al retirar|cuando recoja|cuando llegue|cuando llegues|al llegar|al recibir|en persona|al delivery|al repartidor|con el delivery|contra entrega|en la entrega)\b/.test(normalized)
  )
}


// El cliente nombro hamburguesas pero sin decir cuales ("quiero 2 hamburguesas"). No alcanza
// para armar el pedido: hay que preguntarle cuales quiere, con las opciones a la vista.
function mentionsBurgersWithoutChoosing(text) {
  return burgerFamilyRegex().test(normalizeText(text))
}

function buildBurgerChoicesReply(catalog) {
  const burgers = (catalog?.products || [])
    .filter((product) => product.categoryId === 'hamburguesas')
    .map((product) => `- ${product.name}: Bs ${product.price}`)

  if (!burgers.length) return ORDER_FORMAT_REDIRECT_MESSAGE

  return [
    '¿Cuáles hamburguesas quieres? Estas son las opciones:',
    ...burgers,
    '',
    'Dime cuántas de cada una (y si quieres algo sin cebolla o con extras) y te armo el pedido.',
  ].join('\n')
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
  return (
    normalized === '[imagen_recibida]' ||
    normalized === '[comprobante_recibido]' ||
    normalized === '[documento_recibido]' ||
    /\b(comprobante|pagado|pague|ya pague|transferencia|qr listo|te mande)\b/.test(normalized)
  )
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
  let firestoreBackoffUntil = 0
  let firestoreBackoffMs = 15000

  const isQuotaExceededError = (error) => {
    const message = String(error?.message || error?.details || '')
    return error?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(message)
  }

  const registerFirestoreFailure = (error) => {
    if (!isQuotaExceededError(error)) return
    firestoreBackoffUntil = Date.now() + firestoreBackoffMs
    firestoreBackoffMs = Math.min(firestoreBackoffMs * 2, 5 * 60 * 1000)
  }

  const registerFirestoreSuccess = () => {
    firestoreBackoffMs = 15000
  }

  const check = async () => {
    if (isChecking || !botEnabled || !whatsapp.connected || Date.now() < firestoreBackoffUntil || !isWithinNoticePollingWindow()) return
    isChecking = true

    try {
      const orders = await getWhatsappOrdersPendingConfirmationNotice()
      for (const order of orders) {
        // Skip if already confirmed via the HTTP endpoint
        if (confirmationSentViaEndpoint.has(order.id)) {
          confirmationSentViaEndpoint.delete(order.id)
          continue
        }
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

      const dispatchOrders = await getWhatsappOrdersPendingDispatchNotice()
      for (const order of dispatchOrders) {
        const chatId = order.whatsappChatId || phoneToChatId(order.customerPhone)
        if (!chatId) continue

        await whatsapp.sendText(chatId, buildDispatchMessage(order))
        await markWhatsappDispatchSent(order)
      }
      registerFirestoreSuccess()
    } catch (error) {
      registerFirestoreFailure(error)
      if (!isQuotaExceededError(error)) console.error('Error revisando confirmaciones pendientes:', error)
    } finally {
      isChecking = false
    }
  }

  setInterval(check, 8000)
  setTimeout(check, 1500)
}

function buildConfirmationMessage(delayMinutes) {
  return `Listo, tu pedido ya fue confirmado. Sale aproximadamente en ${delayMinutes} minutos.`
}

// El aviso de "Entregado" tiene que decir cosas distintas segun como recibe el cliente: a quien
// pidio para recoger no se le puede decir que salio la moto.
function buildDispatchMessage(order) {
  if (order.fulfillmentType === 'pickup') {
    return 'Tu pedido ya esta listo para recoger en el restaurante. Te esperamos. Gracias por pedir en Burger Lab.'
  }
  return 'Su moto ya esta en camino. Por favor, este atento al telefono para recibir su pedido. Gracias por pedir en Burger Lab.'
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

// Acuse de recibo suelto: el cliente solo esta diciendo "entendido", sin pedir nada. Ojo que
// varias de estas palabras tambien sirven para confirmar un pedido ("si", "dale", "listo"), asi
// que esto solo se consulta cuando NO hay ningun pedido pendiente de confirmar - ahi no queda
// nada que confirmar y tomarlo como pedido nuevo solo genera duplicados.
function isAcknowledgementText(text) {
  const normalized = normalizeText(text)
  return /^(perfecto|excelente|genial|buenisimo|barbaro|chevere|de una|vale|bien|muy bien|va|ya esta|ya|listo|ok|okay|oka|dale|entendido|claro|correcto|si|sip|sale|joya)$/.test(normalized)
}

function isQuestionOrEditRequest(text) {
  const norm = normalizeText(text)
  return /\?/.test(text) || /\b(por\s*que|porque|cuanto|cuanta|como|no\s+seria|precio|costo|duda|modificar|cambiar|editar|adicional|extra|papas|tocino)\b/.test(norm)
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

  // En delivery el cobro nunca pasa por el chat: se aclara que el total lo paga con la moto y que
  // el envio se cotiza aparte. En recojo no se muestra nada de pago todavia - se le pregunta
  // recien cuando confirma, porque si elige QR hay que esperar el comprobante.
  const paymentLines =
    orderInput.fulfillmentType === 'delivery'
      ? ['Pago: el total lo pagas directamente con la moto, en efectivo o por QR.']
      : orderInput.expectedPaymentMethod === 'qr'
        ? ['Pago: QR']
        : []

  return [
    'Te paso el resumen de tu pedido:',
    `Nombre: ${orderInput.customerName}`,
    `Numero: ${formatCustomerPhone(orderInput.customerPhone)}`,
    ...itemLines,
    `Pedido: Bs ${orderInput.productSubtotal ?? orderInput.total}`,
    ...deliveryLine,
    `Total del pedido: Bs ${orderInput.total}`,
    ...paymentLines,
  ].join('\n')
}

function buildDeliverySummaryLines(orderInput) {
  const lines = [
    `Envio: ${orderInput.deliveryAddress || 'ubicacion/direccion pendiente'}`,
  ]

  lines.push('Envio: se cotiza aparte y tambien lo pagas directamente al delivery.')
  return lines
}

function isWithinBusinessHours(now = new Date()) {
  const settings = getSettings()
  const openHour = typeof settings.openHour === 'number' ? settings.openHour : config.openHour
  const closeHour = typeof settings.closeHour === 'number' ? settings.closeHour : config.closeHour

  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: config.timezone,
    }).format(now),
  )

  return hour >= openHour && hour < closeHour
}

// Los avisos de caja (pedido confirmado / pedido entregado) no dependen de que el cliente pueda
// escribir: dependen de que quede trabajo en curso. Los ultimos pedidos de la noche se entregan
// despues de la hora de cierre, y con el horario estricto esos avisos se descartaban en silencio.
// Se da una hora de margen despues de cerrar, que es lo que tarda en salir la ultima tanda.
const CIERRE_MARGEN_AVISOS_HORAS = 1

function isWithinNoticePollingWindow(now = new Date()) {
  if (isWithinBusinessHours(now)) return true

  const settings = getSettings()
  const openHour = typeof settings.openHour === 'number' ? settings.openHour : config.openHour
  const closeHour = typeof settings.closeHour === 'number' ? settings.closeHour : config.closeHour

  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: config.timezone,
    }).format(now),
  )

  return hour >= closeHour && hour < closeHour + CIERRE_MARGEN_AVISOS_HORAS && closeHour > openHour
}
