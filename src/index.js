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

async function handleIncomingMessage({ chatId, text }) {
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

    if (conversations.isNewSession(chatId, SESSION_GAP_MS) || isExplicitResetRequest(text)) {
      conversations.resetSession(chatId)
    }

    if (!isWithinBusinessHours()) {
      if (isExplicitResetRequest(text)) {
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

    conversations.add(chatId, 'cliente', text)
    const state = conversations.get(chatId)
    const isFirstCustomerMessage = state.messages.filter((entry) => entry.role === 'cliente').length === 1
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
              ? 'Perfecto, ya recibi tu comprobante. Solo me falta tu ubicacion de WhatsApp o direccion exacta para pasar el pedido a caja.'
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
            state.awaitingPaymentProof = null
            conversations.scheduleSave()

            const reply = [
              'Perfecto, recibi tu comprobante.',
              'Voy a pasar tu pedido a caja para que revisen el pago y confirmen el tiempo de salida.',
            ].join('\n')

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
          const reply = [
            'Perfecto, registre tu pedido.',
            `Pagas los Bs ${orderInput.total} en el restaurante cuando recojas.`,
            'En caja lo van a confirmar y te aviso el tiempo exacto de salida.',
          ].join('\n')
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

      // Respuesta a "¿con papas o sin papas?". Se resuelve aca y no en el flujo normal: si no,
      // "una con papas" se toma como un pedido nuevo de papas en vez de como la respuesta a la
      // pregunta que el bot acaba de hacer.
      if (
        state.pendingClarification === 'papas' &&
        state.orderDraft?.items?.length &&
        /\b(con|sin)\s+papas?\b/.test(normalizeText(text))
      ) {
        const papasCatalog = await getCatalogForParsing()
        const updatedDraft = {
          ...state.orderDraft,
          items: applyPapasAnswer(state.orderDraft.items, papasCatalog, text),
        }
        state.pendingClarification = null
        conversations.setOrderDraft(chatId, updatedDraft)
        await finalizeOrderDraft({ chatId, state, draft: updatedDraft, catalog: papasCatalog, text })
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

          const reply = [
            'Perfecto, recibi tu comprobante.',
            'Voy a pasar tu pedido a caja para que revisen el pago y confirmen el tiempo de salida.',
          ].join('\n')

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

          const reply = [
            'Perfecto, recibi tu comprobante.',
            'Voy a pasar tu pedido a caja para que revisen el pago y confirmen el tiempo de salida.',
          ].join('\n')

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
      // si el cliente ahora quiere agregar/cambiar algo, NO lo reescribimos solos (ya se le avisa
      // a caja/cocina y modificarlo por atras podria desincronizarse con lo que ya estan
      // preparando). Avisamos directo a los duenos en vez de tocar Firestore de mas.
      if (!state.pendingOrder && !state.orderDraft?.items?.length && state.lastOrderId && looksLikeOrderModificationRequest(text) && !isExplicitResetRequest(text)) {
        await notifyOrderModificationRequest(chatId, state.lastOrderId, text)
        const reply = 'Tu pedido ya se envió a cocina. Le aviso al equipo para que te ayude directamente con ese cambio.'
        conversations.add(chatId, 'bot', reply)
        await whatsapp.sendText(chatId, reply)
        return
      }

      // A quien escribe se le manda el formato, no un saludo generico. Antes esto pedia ademas
      // que el primer mensaje pareciera un pedido, asi que un "Hola" suelto caia en la IA, que
      // contestaba un saludo amable y nada mas - el cliente quedaba sin saber como pedir. Si el
      // mensaje es una pregunta concreta de otra cosa (horarios, envio, ubicacion), eso se
      // responde primero y el formato va despues, cuando de verdad quiera pedir.
      const shouldSendMenuForOrderStart = isFirstCustomerMessage && !isSpecificNonOrderQuestion(text)
      if (isMenuRequest(text) || shouldSendMenuForOrderStart) {
        const caption = buildOrderTemplateMessage()
        conversations.add(chatId, 'bot', caption)
        await whatsapp.sendImage(chatId, menuImagePath, caption)
        if (!looksLikeConcreteOrderText(text) && !looksLikeStructuredOrderMessage(text)) return
      }

      const hasOrderInProgress = Boolean(state.orderDraft?.items?.length || state.pendingOrder)

      if (isDeliveryPricingRequest(text) && !looksLikeStructuredOrderMessage(text) && !hasOrderInProgress) {
        await sendDeliveryPricingInfo(chatId)
        return
      }

      if (
        isPaymentQrRequest(text) &&
        !state.pendingOrder &&
        !looksLikeConcreteOrderText(text) &&
        !looksLikeStructuredOrderMessage(text) &&
        !hasOrderInProgress
      ) {
        await sendPaymentQrInfo(chatId)
        return
      }

      if (isRestaurantLocationRequest(text) && !looksLikeStructuredOrderMessage(text) && !hasOrderInProgress) {
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
      // isSimpleEnoughForQuickPath ya filtra el intento de AGREGAR un item por palabra clave
      // (mas arriba, dentro de inferSimpleOrderFromCatalog), pero el segundo camino de abajo
      // (orderDraft con items + "algun dato util" en el texto) NO pasaba por ese mismo filtro -
      // asi que un mensaje de negacion/remocion como "ya no quiero la coca, sacala" podia
      // colarse igual (el texto "parece util" por una adivinanza debil de nombre) y terminar
      // en el camino determinista, que no entiende negaciones y dejaba todo intacto.
      const isSimpleForQuickPath = isSimpleEnoughForQuickPath(normalizeText(text))
      if (quickResult.items.length || (isSimpleForQuickPath && state.orderDraft?.items?.length && hasUsefulInferredFields(text))) {
        const baseDraft = state.orderDraft || pendingOrderToDraft(state.pendingOrder) || buildEmptyAiResult()
        const deterministicResult = quickResult.items.length ? quickResult : buildEmptyAiResult()
        const mergedResult = mergeOrderDraft(baseDraft, deterministicResult, text)
        conversations.setOrderDraft(chatId, mergedResult)
        await finalizeOrderDraft({ chatId, state, draft: mergedResult, catalog, text })
        return
      }

      if (isSimpleForQuickPath && state.orderDraft?.items?.length && hasUsefulInferredFields(text)) {
        const mergedResult = mergeOrderDraft(state.orderDraft, buildEmptyAiResult(), text)
        conversations.setOrderDraft(chatId, mergedResult)
        await finalizeOrderDraft({ chatId, state, draft: mergedResult, catalog, text })
        return
      }

      const aiResult = await understandMessage({
        message: text,
        conversation: state.messages,
        catalog,
        currentDraft: state.orderDraft || pendingOrderToDraft(state.pendingOrder),
      })
      const previousItems = state.orderDraft?.items || pendingOrderToDraft(state.pendingOrder)?.items || []
      const result = {
        ...aiResult,
        items: keepPapasVariant(previousItems, enforceCatalogExtras(aiResult.items, catalog), text, catalog),
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

      if (result.intent === 'delivery_pricing' && isDeliveryPricingRequest(text) && !isMidTemplateFlow) {
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

      // Pregunta normal del negocio (horario, ubicacion, metodos de pago, etc.) que no trae
      // items nuevos: respondela directo, sin tocar el pedido en curso/pendiente. Si no hiciera
      // esta excepcion, un pedido pendiente "absorbe" la pregunta (como ya tiene items) y en vez
      // de contestar solo vuelve a mostrar el resumen, ignorando lo que el cliente pregunto.
      if (result.intent === 'question' && !result.items.length) {
        // Igual guardamos cualquier dato que la IA haya sacado de paso (ej. el cliente dijo su
        // nombre en el mismo mensaje que hizo la pregunta) - solo evitamos volver a mostrar el
        // resumen del pedido en vez de contestar lo que realmente pregunto.
        if (!state.pendingOrder && (result.customerName || result.customerPhone || result.fulfillmentType || result.deliveryAddress)) {
          const mergedResult = mergeOrderDraft(state.orderDraft || pendingOrderToDraft(state.pendingOrder), result, text, { itemsAreComplete: true })
          conversations.setOrderDraft(chatId, mergedResult)
        }
        conversations.add(chatId, 'bot', result.reply)
        await whatsapp.sendText(chatId, result.reply)
        return
      }

      const mergedResult = mergeOrderDraft(state.orderDraft || pendingOrderToDraft(state.pendingOrder), result, text, { itemsAreComplete: true })

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
        await finalizeOrderDraft({ chatId, state, draft: mergedResult, catalog, text, aiReply: result.reply })
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

  // Mark in-memory FIRST to prevent polling from also sending
  confirmationSentViaEndpoint.add(order.id)

  // Mark in Firestore BEFORE sending the message to prevent race condition with polling
  await markWhatsappConfirmationSent(order)

  await whatsapp.sendText(
    chatId,
    buildConfirmationMessage(delayMinutes),
  )
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

  const server = app.listen(config.port, () => {
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
    const reply = [
      'Perfecto, registre tu pedido.',
      '',
      `El total de Bs ${orderInput.total} lo pagas directamente con la moto, ya sea en efectivo o por QR.`,
      'El costo del envio se cotiza aparte y tambien lo pagas con el delivery.',
      '',
      'En caja lo van a confirmar y te aviso el tiempo exacto de salida.',
    ].join('\n')
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
async function finalizeOrderDraft({ chatId, state, draft, catalog, text, aiReply = '' }) {
  // Si el cliente pregunto algo en el mismo mensaje del pedido ("...Tiene motito ? O mando a
  // recoger ?"), la respuesta de la IA se antepone: antes se descartaba y el bot solo pedia el
  // dato que faltaba, dejando la pregunta sin contestar.
  // Hay que sacar las URLs antes de buscar el signo de pregunta: el link de ubicacion de WhatsApp
  // trae uno en la query ("maps.google.com/?q=...") y hacia que el bot creyera que el cliente
  // preguntaba algo, colando una respuesta suelta arriba del resumen.
  const textWithoutUrls = String(text || '').replace(/https?:\/\/\S+/gi, '')
  const prefix = aiReply && /\?/.test(textWithoutUrls) ? `${aiReply}\n\n` : ''
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

  // Con papas o sin papas cambia el precio, asi que no se asume: se pregunta justo antes del
  // resumen, cuando ya estan el resto de los datos.
  if (needsPapasClarification(draft.items, catalog, state)) {
    state.pendingClarification = 'papas'
    conversations.scheduleSave()
    const reply = buildPapasQuestion(draft.items, catalog)
    conversations.add(chatId, 'bot', reply)
    await whatsapp.sendText(chatId, reply)
    return
  }

  const orderInput = buildOrderInput({ result: draft, chatId })
  if (orderInput.fulfillmentType === 'delivery' && orderInput.deliveryQuoteStatus === 'missing_location') {
    const reply = 'Perfecto, ya tengo tu pedido. Para cotizar el envio necesito que me mandes tu ubicacion de WhatsApp, por favor.'
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
  const reply = `${prefix}${summary}\n\nConfirmas el pedido?`
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

async function notifyOrderModificationRequest(chatId, orderId, customerMessage) {
  const targetChatId = await resolveOwnerAlertChatId()
  if (!targetChatId) return

  const message = [
    'Cliente quiere modificar un pedido que YA fue confirmado.',
    `Pedido: #${orderId}`,
    `Cliente: ${chatId}`,
    `Mensaje: ${customerMessage}`,
    'El bot no lo modifico solo para evitar descoordinacion con cocina - contactar directamente.',
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

function getAllowedExtrasForProduct(product, catalog) {
  const allowed = [...(product?.extras || [])]
  if (product?.categoryId === 'hamburguesas' && Array.isArray(catalog?.quickExtras)) {
    catalog.quickExtras.forEach((quickExtra) => {
      if (!allowed.some((extra) => extra.id === quickExtra.id)) allowed.push(quickExtra)
    })
  }
  return allowed
}

// El catalogo manda, no la IA. Un extra que no existe para ese producto no puede llegar al
// ticket: a un cliente que pidio "doble porcion de queso extra y una porcion de piña" le
// registro "Sandwich de queso/huevo" x2 y "Salsa verde/picante" - productos de la categoria
// "Extras", no extras de la hamburguesa. El prompt ya prohibia sustituir extras y aun asi paso,
// asi que aca se verifica de verdad. Ademas se reescriben nombre y precio con los del catalogo,
// que es lo que se cobra.
function enforceCatalogExtras(items, catalog) {
  const discarded = []

  const cleaned = (items || []).map((item) => {
    const product =
      (catalog?.products || []).find((candidate) => candidate.id === item.productId) ||
      (catalog?.products || []).find((candidate) => normalizeText(candidate.name) === normalizeText(item.name))
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

function applyNotesToItems(items, text) {
  const notesFromText = inferItemNoteFromText(String(text || '').toLowerCase())
  if (!notesFromText || !items || !items.length) return items || []
  return items.map((item) => {
    const isBurger = item.productId?.includes('bbq') || item.productId?.includes('burger') || item.name?.toLowerCase().includes('burger') || item.name?.toLowerCase().includes('hamburguesa')
    if (isBurger) {
      const existing = item.note ? item.note.split(', ').map((n) => n.trim()) : []
      const newNotes = notesFromText.split(', ').map((n) => n.trim())
      const combined = Array.from(new Set([...existing, ...newNotes])).filter(Boolean).join(', ')
      return { ...item, note: combined }
    }
    return item
  })
}

function mergeOrderItems(prev, next, text) {
  const isReset = isExplicitResetRequest(text)
  const prevItems = prev || []
  const nextItems = next || []

  if (isReset || !prevItems.length) return applyNotesToItems(nextItems, text)
  if (!nextItems.length) return applyNotesToItems(prevItems, text)

  // Sumar cuando el cliente queria reemplazar es el error mas caro posible, asi que se exige una
  // señal explicita de agregar. Antes alcanzaba con la palabra suelta "y", con "mas", o con que
  // el mensaje trajera cualquier producto nuevo: "y sacale una hamburguesa, quiero solo una"
  // subia el pedido de 2 a 3, y "cambia una coca por una fanta" dejaba 3 cocas en vez de 1.
  // Un producto nuevo se agrega igual mas abajo; eso no es motivo para sumarle a los que ya estan.
  const wantsReplacement =
    /\b(cambia|cambiame|cambiale|mejor|solo|solamente|unicamente|en vez de|en lugar de|saca|sacame|sacale|quita|quitame|quitale|elimina|eliminar|borra|borrar|dejame|deja|corrige|corregir|que sean|que sea)\b/i.test(text)
  // "una coca mas" tambien es agregar, pero "nada mas" / "algo mas?" no: ahi "mas" solo cierra la
  // frase y tomarlo como agregar duplicaria productos que el cliente no pidio.
  const mentionsMore = /\bmas\b/i.test(text) && !/\b(nada|no|algo|alguna cosa|que)\s+mas\b/i.test(text)
  const wantsAddition =
    /\b(agrega|agregame|agregale|anade|anademe|anadir|suma|sumale|sumame|tambien|ademas|aumenta|aumentame|otra|otro)\b/i.test(text) ||
    mentionsMore
  const isAddition = wantsAddition && !wantsReplacement

  const merged = [...prevItems]
  for (const newItem of nextItems) {
    const existingIdx = merged.findIndex((i) => (i.productId && i.productId === newItem.productId) || (i.name && i.name.toLowerCase() === newItem.name?.toLowerCase()))
    if (existingIdx >= 0) {
      if (isAddition) {
        merged[existingIdx] = {
          ...merged[existingIdx],
          quantity: merged[existingIdx].quantity + newItem.quantity,
          note: newItem.note || merged[existingIdx].note,
          extras: newItem.extras?.length ? newItem.extras : merged[existingIdx].extras,
        }
      } else {
        merged[existingIdx] = { ...merged[existingIdx], ...newItem }
      }
    } else {
      merged.push(newItem)
    }
  }

  return applyNotesToItems(merged, text)
}

function mergeOrderDraft(previous, result, text, { itemsAreComplete = false } = {}) {
  const inferred = inferFieldsFromText(text)
  // Cuando el resultado ya viene con el pedido completo (ej. la IA vio el borrador actual y
  // devolvio la lista final actualizada), no lo volvamos a combinar con lo anterior o se
  // duplicarian cantidades. Si vino vacio, igual conservamos lo anterior como respaldo.
  // Tampoco le aplicamos applyNotesToItems - la IA ya pone la nota (sin cebolla, sin salsa, etc)
  // en su propia respuesta, y volver a agregarla por regex duplicaba el texto en la nota final.
  // La IA rearma la lista de items en CADA respuesta, incluso cuando el mensaje del cliente no
  // hablaba de comida, y a veces la devuelve cambiada. A un cliente real le convirtio
  // "Tocino, Tocino" en "Salsa BBQ, Salsa BBQ" (y le bajo el total de Bs 30 a Bs 26) cuando lo
  // unico que escribio fue que pagaria con QR. Un mensaje que no menciona productos ni pide un
  // cambio no puede tocar lo que el cliente ya vio y aprobo.
  const keepPreviousItems = Boolean(previous?.items?.length) && !messageCanChangeItems(text)
  const mergedItems = keepPreviousItems
    ? previous.items
    : itemsAreComplete
      ? (result.items.length ? result.items : previous?.items || [])
      : mergeOrderItems(previous?.items, result.items, text)
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
  const fulfillmentType = /\b(envio|delivery|domicilio)\b/.test(normalized)
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
function hasUsefulInferredFields(text) {
  const inferred = inferFieldsFromText(text)
  return Boolean(inferred.customerName || inferred.weakGuessedName || inferred.paymentMethod || inferred.fulfillmentType || inferred.deliveryAddress || inferred.customerPhone)
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

function isSimpleEnoughForQuickPath(normalizedText) {
  if (/\btriple\b/.test(normalizedText)) return false
  // Si el cliente pregunta algo, va a la IA aunque el mismo mensaje traiga el pedido: pasa
  // seguido que sean las dos cosas a la vez ("Una BBQ LAB simple con papa a nombre de Viviana.
  // Tiene motito ? O mando a recoger ?"). El camino rapido solo saca datos por palabra clave: se
  // quedaba con "recoger" como si el cliente ya hubiera elegido, y contestaba pidiendo el
  // siguiente dato sin responder nunca lo que le preguntaron.
  if (/\?/.test(normalizedText)) return false
  const burgerFamilyMentions = (normalizedText.match(new RegExp(`\\b(?:${BURGER_FAMILY_SOURCE}|bbq|barbacoa)\\b`, 'g')) || []).length
  if (burgerFamilyMentions > 1) return false
  if (/\by\s+(otra|otro|una|un|1|2|3)\b/.test(normalizedText)) return false
  // El parser rapido solo sabe AGREGAR productos por palabra clave - no entiende negaciones.
  // "ya no quiero la coca, sacala" mencionaria "coca" y la agregaria de nuevo en vez de sacarla.
  // Estos casos necesitan que la IA entienda la intencion real.
  if (/\b(ya no quiero|no quiero|sin el|sin la|sacal[oa]|saquenla|saquenlo|quitar|quita el|quita la|elimina|eliminar|borra|borrar|cambia(lo|la)?\s+por|mejor\s+(que|sea))\b/.test(normalizedText)) return false
  return true
}

function inferSimpleOrderFromCatalog(text, catalog) {
  const normalized = normalizeText(text)
  if (!isSimpleEnoughForQuickPath(normalized)) {
    return { ...buildEmptyAiResult(), items: [] }
  }
  const flexibleItems = inferFlexibleMenuItems(normalized, catalog)
  const products = [...(catalog.products || [])]
    .filter((product) => product.isVisible !== false && product.isActive !== false)
    .sort((left, right) => normalizeText(right.name).length - normalizeText(left.name).length)
  const matched = [...flexibleItems]

  for (const product of products) {
    const productName = normalizeText(product.name)
    if (!productName || !normalized.includes(productName)) continue
    if (matched.some((item) => item.productId === product.id)) continue

    const index = normalized.indexOf(productName)
    const before = index > 0 ? normalized.slice(Math.max(0, index - 15), index) : ''
    const isExplicitExtraPrefix = /\b(extra|adicional|mas)\s*$/.test(before)
    const isAlreadyAnExtraOnItem = matched.some((item) => (item.extras || []).some((ex) => (ex.id && ex.id === product.id) || normalizeText(ex.name) === productName))

    if (isExplicitExtraPrefix || isAlreadyAnExtraOnItem) {
      continue
    }

    matched.push({
      productId: product.id,
      name: product.name,
      basePrice: Number(product.price || 0),
      quantity: inferQuantityBeforeProduct(normalized, productName),
      note: inferItemNoteFromText(normalized),
      options: [],
      extras: inferExtrasFromText(normalized, product, catalog),
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
      extras: inferExtrasFromText(normalizedText, product, catalog),
    })
  }

  const isBurgerSizeDoble = /\bdoble\b(?!\s*(porcion|porciones|racion|raciones))/.test(normalizedText)

  if (/\b(bbq|barbacoa)\b/.test(normalizedText)) {
    const size = isBurgerSizeDoble ? 'doble' : 'simple'
    const papas = /\bsin\s+papas?\b/.test(normalizedText) ? 'sin-papas' : 'con-papas'
    addProduct(`bbq-${size}-${papas}`, inferQuantityBeforeProduct(normalizedText, /\b(?:bbq|barbacoa)\b/))
  }

  if (burgerFamilyRegex().test(normalizedText) && !/\b(bbq|barbacoa)\b/.test(normalizedText)) {
    const size = isBurgerSizeDoble ? 'doble' : 'simple'
    const papas = /\bsin\s+papas?\b/.test(normalizedText) ? 'sin-papas' : 'con-papas'
    addProduct(`burger-lab-${size}-${papas}`, inferQuantityBeforeProduct(normalizedText, burgerFamilyRegex()))
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

function inferQuantityBeforeProduct(normalizedText, productNeedle) {
  // El "needle" puede ser texto o expresion regular. Con texto fijo, un producto que se escribe
  // de varias formas (burger/burguer/hamburguesa) no se encontraba, y como "no encontrado" y
  // "sin cantidad delante" daban el mismo resultado, la cantidad se perdia en silencio.
  const index =
    typeof productNeedle === 'string' ? normalizedText.indexOf(productNeedle) : normalizedText.search(productNeedle)
  const before = index > 0 ? normalizedText.slice(Math.max(0, index - 30), index) : ''
  const digitMatch = before.match(/\b([2-9])\s*(x|de|porcion|porciones|orden|ordenes|paquete|paquetes)?\s*(de)?\s*$/i)
  if (digitMatch) return Number(digitMatch[1])
  if (/\b(doble|dos)\s*(x|de|porcion|porciones|orden|ordenes|paquete|paquetes)?\s*(de)?\s*$/i.test(before)) return 2
  if (/\b(triple|tres)\s*(x|de|porcion|porciones|orden|ordenes|paquete|paquetes)?\s*(de)?\s*$/i.test(before)) return 3
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

function inferExtrasFromText(normalizedText, product, catalog) {
  const availableExtras = [...(Array.isArray(product.extras) ? product.extras : [])]
  if (product.categoryId === 'hamburguesas' && Array.isArray(catalog?.quickExtras)) {
    for (const quickExtra of catalog.quickExtras) {
      if (!availableExtras.some((extra) => extra.id === quickExtra.id)) {
        availableExtras.push(quickExtra)
      }
    }
  }

  const extras = []
  for (const extra of availableExtras) {
    const extraName = normalizeText(extra.name)
    if (!extraName) continue
    const coreKey = extraName.replace(/\b(extra|adicional|mas)\b/gi, '').trim()

    const nameRegex = new RegExp(`\\b${extraName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const coreRegex = coreKey.length >= 3 ? new RegExp(`\\b${coreKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null

    const isMatched = nameRegex.test(normalizedText) || (coreRegex && coreRegex.test(normalizedText))
    if (!isMatched) continue

    const quantity = inferExtraQuantity(normalizedText, coreKey || extraName)
    for (let i = 0; i < quantity; i += 1) extras.push(extra)
  }

  return extras
}

function inferExtraQuantity(normalizedText, normalizedExtraName) {
  const index = normalizedText.indexOf(normalizedExtraName)
  const before = index > 0 ? normalizedText.slice(Math.max(0, index - 35), index) : ''
  const connector = '(x|de|porcion|porciones|racion|raciones|extra|extras|adicional|adicionales)?\\s*(de)?'

  const digitMatch = before.match(new RegExp(`\\b([2-9])\\s*${connector}\\s*$`))
  if (digitMatch) return Number(digitMatch[1])

  if (new RegExp(`\\b(doble|dos)\\s*${connector}\\s*$`).test(before)) return 2
  if (new RegExp(`\\b(triple|tres)\\s*${connector}\\s*$`).test(before)) return 3

  return 1
}

// --- Papas: nunca asumir, porque cambia el precio (BBQ Simple: Bs 23 con papas, Bs 20 sin) ---

const SPANISH_NUMBER_WORDS = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 }

// Los ids del catalogo siguen el patron "...-con-papas" / "...-sin-papas", asi que la otra
// version del mismo producto se encuentra cambiando esa parte del id.
function getPapasSibling(catalog, productId) {
  if (!productId) return null
  if (productId.includes('-con-papas')) return findCatalogProduct(catalog, productId.replace('-con-papas', '-sin-papas'))
  if (productId.includes('-sin-papas')) return findCatalogProduct(catalog, productId.replace('-sin-papas', '-con-papas'))
  return null
}

function customerSpecifiedPapas(state) {
  return (state?.messages || []).some(
    (entry) => entry.role === 'cliente' && /\b(con|sin)\s+papas?\b/.test(normalizeText(entry.text)),
  )
}

function needsPapasClarification(items, catalog, state) {
  if (customerSpecifiedPapas(state)) return false
  return (items || []).some((item) => getPapasSibling(catalog, item.productId))
}

function buildPapasQuestion(items, catalog) {
  const ambiguous = (items || []).filter((item) => getPapasSibling(catalog, item.productId))
  const total = ambiguous.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0)
  if (total > 1) {
    return `¿Las ${total} hamburguesas las quieres *con papas* o *sin papas*? Si quieres unas de cada una, dime cuántas (por ejemplo: "una con papas").`
  }
  return '¿La hamburguesa la quieres *con papas* o *sin papas*?'
}

// Interpreta la respuesta contando cuantas van de cada tipo. El dueño lo pidio explicito: si
// pidio dos y contesta "una con papas", la otra queda sin papas.
function parsePapasAnswer(text, totalUnits) {
  const normalized = normalizeText(text)
  const regex = /(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|todas|todos|ambas|ambos|ninguna|ninguno)?\s*(con|sin)\s+papas?/g
  const counts = { con: null, sin: null }
  let found = false
  let match

  while ((match = regex.exec(normalized)) !== null) {
    found = true
    const rawCount = match[1]
    const choice = match[2]
    if (!rawCount || /^(todas|todos|ambas|ambos)$/.test(rawCount)) {
      counts[choice] = totalUnits
    } else if (/^(ninguna|ninguno)$/.test(rawCount)) {
      counts[choice] = 0
    } else if (/^\d+$/.test(rawCount)) {
      counts[choice] = Number(rawCount)
    } else {
      counts[choice] = SPANISH_NUMBER_WORDS[rawCount] ?? totalUnits
    }
  }

  if (!found) return null

  // Lo que no se menciono es el resto: "una con papas" de dos hamburguesas deja una sin papas.
  if (counts.con === null) counts.con = Math.max(0, totalUnits - (counts.sin ?? 0))
  if (counts.sin === null) counts.sin = Math.max(0, totalUnits - counts.con)

  return { con: Math.min(counts.con, totalUnits), sin: Math.min(counts.sin, totalUnits) }
}

// Reparte las unidades ambiguas entre la version con papas y la sin papas, y las reagrupa en
// lineas. Los dos productos tienen ids distintos, asi que quedan como dos lineas separadas y la
// cocina ve exactamente cuantas van de cada una.
function applyPapasAnswer(items, catalog, answerText) {
  const ambiguous = (items || []).filter((item) => getPapasSibling(catalog, item.productId))
  if (!ambiguous.length) return items

  const totalUnits = ambiguous.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0)
  const plan = parsePapasAnswer(answerText, totalUnits)
  if (!plan) return items

  let remainingCon = plan.con
  const result = []

  for (const item of items || []) {
    if (!getPapasSibling(catalog, item.productId)) {
      result.push(item)
      continue
    }

    const quantity = Number(item.quantity) || 1
    const conUnits = Math.max(0, Math.min(remainingCon, quantity))
    const sinUnits = quantity - conUnits
    remainingCon -= conUnits

    const conProduct = item.productId.includes('-con-papas') ? null : getPapasSibling(catalog, item.productId)
    const sinProduct = item.productId.includes('-sin-papas') ? null : getPapasSibling(catalog, item.productId)
    const asCon = conProduct ? { productId: conProduct.id, name: conProduct.name, basePrice: Number(conProduct.price || 0) } : {}
    const asSin = sinProduct ? { productId: sinProduct.id, name: sinProduct.name, basePrice: Number(sinProduct.price || 0) } : {}

    // Los extras quedan en la linea con papas si existe; si no, en la otra. Asi no se duplican.
    if (conUnits > 0) result.push({ ...item, ...asCon, quantity: conUnits })
    if (sinUnits > 0) result.push({ ...item, ...asSin, quantity: sinUnits, extras: conUnits > 0 ? [] : item.extras })
  }

  return result
}

// "sin cebolla" es una NOTA del item, no otro producto. La IA lo confundio con "sin papas" y le
// cambio a un cliente una hamburguesa Con Papas (Bs 22) por una Sin Papas (Bs 19) cuando lo unico
// que pidio fue que una fuera sin cebolla. Si el mensaje no habla de papas, la version del
// producto que el cliente ya tenia no se toca.
function keepPapasVariant(previousItems, nextItems, text, catalog) {
  if (/\bpapas?\b/.test(normalizeText(text))) return nextItems
  if (!previousItems?.length) return nextItems

  return (nextItems || []).map((item) => {
    const sibling = getPapasSibling(catalog, item.productId)
    if (!sibling) return item
    if (previousItems.some((previous) => previous.productId === item.productId)) return item
    if (!previousItems.some((previous) => previous.productId === sibling.id)) return item
    return { ...item, productId: sibling.id, name: sibling.name, basePrice: Number(sibling.price || 0) }
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
    return 'Ya tengo tu pedido casi listo. Por favor envíame tu *ubicación de WhatsApp* (o dirección exacta) para finalizar.'
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
      return buildMissingFieldsReply(missingFields, { state })
    }

    return 'Ya tengo tu pedido avanzado. Si esta correcto, respondeme "Si"; si quieres cambiar algo, dime que modificamos.'
  }

  return ORDER_FORMAT_REDIRECT_MESSAGE
}

async function tryRecoverOrderFromText(chatId, text, state) {
  try {
    const catalog = await getCatalogForParsing()
    const fallbackResult = mergeOrderDraft(
      state.orderDraft || pendingOrderToDraft(state.pendingOrder),
      inferSimpleOrderFromCatalog(text, catalog),
      text,
    )

    if (!fallbackResult.items.length) return { handled: false, reply: '' }

    conversations.setOrderDraft(chatId, fallbackResult)
    // Mismo cierre que el flujo normal, para que este camino de recuperacion no se saltee la
    // pregunta de las papas y termine asumiendo la opcion mas cara.
    await finalizeOrderDraft({ chatId, state, draft: fallbackResult, catalog, text })
    return { handled: true, reply: '' }
  } catch (fallbackError) {
    console.error('No se pudo recuperar pedido localmente:', fallbackError)
    return { handled: false, reply: '' }
  }
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
  if (extrasPerUnit) return items

  const result = []
  for (const item of items || []) {
    const quantity = Number(item.quantity) || 1
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

  return /\b(menu|carta|catalogo|promos|promociones)\b/.test(normalized)
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

function looksLikeOrderModificationRequest(text) {
  const normalized = normalizeText(text)
  return isOrderStartRequest(text) || /\b(agregar|agregame|aumentar|aumentame|cambiar|cambiame|sacar|sacame|quitar|quitame|modificar|modificame|anadir)\b/.test(normalized)
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

// Pregunta concreta sobre otra cosa que no es hacer un pedido (horarios, envio, ubicacion, como
// pagar). Solo en ese caso se responde eso en vez de mandar el formato. Un saludo suelto o un
// "quiero 2 hamburguesas" NO entran aca: esos van derecho al formato.
function isSpecificNonOrderQuestion(text) {
  const normalized = normalizeText(text)
  if (isOrderStartRequest(text) || looksLikeConcreteOrderText(text) || looksLikeStructuredOrderMessage(text)) {
    return false
  }
  return (
    isDeliveryPricingRequest(text) ||
    isPaymentQrRequest(text) ||
    isRestaurantLocationRequest(text) ||
    /\b(horario|horarios|abren|abierto|cierran|cerrado|a que hora|hasta que hora|donde estan|donde queda|ubicacion|direccion|telefono|reclamo|factura)\b/.test(normalized)
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
    if (isChecking || !botEnabled || !whatsapp.connected || Date.now() < firestoreBackoffUntil || !isWithinBusinessHours()) return
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
