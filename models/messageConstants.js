module.exports = {
    CHAT_MESSAGE_STATUS : {
        FAILED : -100,
        SENDING : 0,
        SENT : 100, //saved into sender timeline
        DELIVERED : 150, //delivered to recipient timeline
        RECEIVED : 200, //received from the recipient client
        RETURN_RECEIPT: 250, //return receipt from the recipient client
        SEEN : 300 //seen

    },
    CHANNEL_TYPE : {
        GROUP : "group",
        DIRECT : "direct",    
    },

    MESSAGE_TYPE : {
        TEXT : "text",
        IMAGE : "image",    
        FRAME: "frame"
    },


    LABELS : {
        EN : {
            // JOIN_OPERATOR_MESSAGE : "We are putting you in touch with an operator..",
            NO_AVAILABLE_OPERATOR_MESSAGE : "Olá, nenhum atendente está disponível no momento. Deixe uma mensagem no chat e responderemos em breve.",
            // TOUCHING_OPERATOR: "We are putting you in touch with an operator. Please wait..",
            TOUCHING_OPERATOR: "Uma nova solicitação de suporte foi atribuída a você"
            // THANKS_MESSAGE: "Thank you for using our support system",
            // REOPEN_MESSAGE : "Chat re-opened"
        },
        IT : {
            // JOIN_OPERATOR_MESSAGE : "La stiamo mettendo in contatto con un operatore. Attenda...",
            NO_AVAILABLE_OPERATOR_MESSAGE : "Salve al momento non è disponibile alcun operatore. Lasci un messaggio in chat, la contatteremo presto.",
            TOUCHING_OPERATOR: "Una nuova richiesta di supporto è stata assegnata a te"
            // TOUCHING_OPERATOR :"La stiamo mettendo in contatto con un operatore. Attenda...",
            // THANKS_MESSAGE: "Grazie per aver utilizzato il nostro sistema di supporto",
            // REOPEN_MESSAGE : "Chat riaperta"
        },
        "IT-IT" : {
            // JOIN_OPERATOR_MESSAGE : "La stiamo mettendo in contatto con un operatore. Attenda...",
            NO_AVAILABLE_OPERATOR_MESSAGE : "Salve al momento non è disponibile alcun operatore. Lasci un messaggio in chat, la contatteremo presto.",
            TOUCHING_OPERATOR: "Una nuova richiesta di supporto è stata assegnata a te"
            // TOUCHING_OPERATOR :"La stiamo mettendo in contatto con un operatore. Attenda...",
            // THANKS_MESSAGE: "Grazie per aver utilizzato il nostro sistema di supporto",
            // REOPEN_MESSAGE : "Chat riaperta"
        },
        PT : {
            NO_AVAILABLE_OPERATOR_MESSAGE : "Olá, nenhum atendente está disponível no momento. Deixe uma mensagem no chat e responderemos em breve.",
            TOUCHING_OPERATOR: "Uma nova solicitação de suporte foi atribuída a você"
        },
        "PT-BR" : {
            NO_AVAILABLE_OPERATOR_MESSAGE : "Olá, nenhum atendente está disponível no momento. Deixe uma mensagem no chat e responderemos em breve.",
            TOUCHING_OPERATOR: "Uma nova solicitação de suporte foi atribuída a você"
        }
    }
}
