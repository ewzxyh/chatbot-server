const CHATCASE_TEMPLATE_IDS = {
  WHATSAPP_MENU_BASIC: 'chatcase-whatsapp-menu-basic',
  ECOMMERCE_ORDERS: 'chatcase-ecommerce-orders',
  CLINIC_SCHEDULING: 'chatcase-clinic-scheduling'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function messageAction(text) {
  return {
    _tdActionType: 'reply',
    text,
    attributes: {
      disableInputMessage: false,
      commands: [
        { type: 'wait', time: 300 },
        {
          type: 'message',
          message: {
            type: 'text',
            text
          }
        }
      ]
    }
  };
}

function intent({ id, name, question, answer, x, y }) {
  const item = {
    webhook_enabled: false,
    enabled: true,
    intent_id: id,
    intent_display_name: name,
    answer,
    actions: [messageAction(answer)],
    attributes: {
      position: { x, y }
    }
  };

  if (question) {
    item.question = question;
  }

  return item;
}

function createTemplate(config) {
  return Object.assign({
    certified: true,
    public: true,
    language: 'pt',
    type: 'tilebot',
    subtype: 'chatbot',
    intentsEngine: 'none',
    bigImage: '/dashboard/assets/img/logos/chatcase-logo.svg',
    id_project: 'chatcase-system-templates',
    createdBy: 'chatcase',
    webhook_enabled: false,
    webhook_url: undefined
  }, config);
}

const WHATSAPP_MENU_BASIC = createTemplate({
  _id: CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
  name: 'ChatCase WhatsApp menu basico',
  title: 'Menu basico para WhatsApp',
  description: 'Fluxo inicial de automacao para canais de mensagem: saudacao, menu numerico, planos e encaminhamento para atendimento humano.',
  short_description: 'Menu inicial para WhatsApp, CaseZap e Telegram com saudacao, opcoes numericas e handoff para atendimento humano.',
  shortDescription: 'Menu inicial para WhatsApp, CaseZap e Telegram com saudacao, opcoes numericas e handoff para atendimento humano.',
  mainCategory: 'Customer Satisfaction',
  tags: ['whatsapp', 'casezap', 'telegram', 'atendimento'],
  certifiedTags: [
    { name: 'WhatsApp', color: '#25833e' },
    { name: 'CaseZap', color: '#0049bd' }
  ],
  templateFeatures: [
    'Saudacao automatica com menu numerico',
    'Respostas para planos e atendimento humano',
    'Compatibilidade inicial com WhatsApp, CaseZap e Telegram'
  ],
  attributes: {
    source: 'chatcase-static-template',
    channels: ['whatsapp', 'casezap', 'telegram'],
    rules: []
  },
  intents: [
    intent({
      id: 'cc-default-fallback',
      name: 'defaultFallback',
      answer: 'Nao entendi sua mensagem. Digite menu para ver as opcoes ou 2 para falar com uma atendente.',
      x: 720,
      y: 500
    }),
    intent({
      id: 'cc-start',
      name: 'start',
      question: '\\start',
      answer: 'Ola! Sou o assistente ChatCase.\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.',
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-menu',
      name: 'menu',
      question: 'menu',
      answer: 'Menu ChatCase:\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.',
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-plans',
      name: 'plans',
      question: '1',
      answer: 'Planos ChatCase:\n\n- Starter: atendimento basico e canais essenciais.\n- Business: automacoes, equipe e integracoes avancadas.\n\nDigite 2 para falar com uma atendente ou menu para voltar.',
      x: 460,
      y: 360
    }),
    intent({
      id: 'cc-human-handoff',
      name: 'human_handoff',
      question: '2',
      answer: 'Certo, vou chamar uma atendente. Enquanto isso, descreva em uma mensagem o que voce precisa.',
      x: 760,
      y: 360
    })
  ]
});

const ECOMMERCE_ORDERS = createTemplate({
  _id: CHATCASE_TEMPLATE_IDS.ECOMMERCE_ORDERS,
  name: 'ChatCase Loja online e pedidos',
  title: 'Loja online e pedidos',
  description: 'Fluxo pronto para lojas que recebem perguntas de WhatsApp sobre pedido, entrega, trocas e atendimento humano.',
  short_description: 'Menu para e-commerce com status de pedido, trocas/devolucoes e handoff para atendente.',
  shortDescription: 'Menu para e-commerce com status de pedido, trocas/devolucoes e handoff para atendente.',
  mainCategory: 'Increase Sales',
  tags: ['whatsapp', 'casezap', 'ecommerce', 'pedidos', 'vendas'],
  certifiedTags: [
    { name: 'WhatsApp', color: '#25833e' },
    { name: 'CaseZap', color: '#0049bd' }
  ],
  templateFeatures: [
    'Triagem de status de pedido e entrega',
    'Orientacao para trocas e devolucoes',
    'Handoff quando o cliente precisa de atendimento humano'
  ],
  attributes: {
    source: 'chatcase-static-template',
    channels: ['whatsapp', 'casezap'],
    segment: 'ecommerce',
    rules: []
  },
  intents: [
    intent({
      id: 'cc-ecommerce-default-fallback',
      name: 'defaultFallback',
      answer: 'Nao consegui identificar sua solicitacao. Digite menu para ver as opcoes da loja.',
      x: 740,
      y: 520
    }),
    intent({
      id: 'cc-ecommerce-start',
      name: 'start',
      question: '\\start',
      answer: 'Ola! Sou o assistente da loja.\n\n1 - Status do pedido\n2 - Trocas ou devolucoes\n3 - Falar com atendente\n\nResponda com o numero da opcao.',
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-ecommerce-menu',
      name: 'menu',
      question: 'menu',
      answer: 'Menu da loja:\n\n1 - Status do pedido\n2 - Trocas ou devolucoes\n3 - Falar com atendente',
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-ecommerce-order-status',
      name: 'order_status',
      question: '1',
      answer: 'Para consultar seu pedido, envie o numero do pedido ou CPF usado na compra. Uma atendente confirma o status em seguida.',
      x: 420,
      y: 360
    }),
    intent({
      id: 'cc-ecommerce-exchange-return',
      name: 'exchange_return',
      question: '2',
      answer: 'Para troca ou devolucao, envie o numero do pedido, o item e o motivo. Vamos conferir a politica e te orientar.',
      x: 680,
      y: 360
    }),
    intent({
      id: 'cc-ecommerce-human-handoff',
      name: 'human_handoff',
      question: '3',
      answer: 'Certo, vou chamar uma atendente. Descreva sua duvida em uma mensagem para agilizar o atendimento.',
      x: 940,
      y: 360
    })
  ]
});

const CLINIC_SCHEDULING = createTemplate({
  _id: CHATCASE_TEMPLATE_IDS.CLINIC_SCHEDULING,
  name: 'ChatCase Clinica e agendamentos',
  title: 'Clinica e agendamentos',
  description: 'Fluxo para clinicas, consultorios e servicos com triagem inicial, agendamento, informacoes de valores/convenios e atendimento humano.',
  short_description: 'Menu para agendamento, valores/convenios e encaminhamento para recepcao.',
  shortDescription: 'Menu para agendamento, valores/convenios e encaminhamento para recepcao.',
  mainCategory: 'Customer Satisfaction',
  tags: ['whatsapp', 'casezap', 'clinica', 'agendamento', 'recepcao'],
  certifiedTags: [
    { name: 'WhatsApp', color: '#25833e' },
    { name: 'CaseZap', color: '#0049bd' }
  ],
  templateFeatures: [
    'Coleta inicial de disponibilidade para agendamento',
    'Resposta guiada sobre valores e convenios',
    'Encaminhamento para recepcao quando precisar'
  ],
  attributes: {
    source: 'chatcase-static-template',
    channels: ['whatsapp', 'casezap'],
    segment: 'clinic',
    rules: []
  },
  intents: [
    intent({
      id: 'cc-clinic-default-fallback',
      name: 'defaultFallback',
      answer: 'Nao entendi sua mensagem. Digite menu para ver as opcoes da recepcao.',
      x: 740,
      y: 520
    }),
    intent({
      id: 'cc-clinic-start',
      name: 'start',
      question: '\\start',
      answer: 'Ola! Sou o assistente da recepcao.\n\n1 - Agendar horario\n2 - Valores e convenios\n3 - Falar com recepcao\n\nResponda com o numero da opcao.',
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-clinic-menu',
      name: 'menu',
      question: 'menu',
      answer: 'Menu da recepcao:\n\n1 - Agendar horario\n2 - Valores e convenios\n3 - Falar com recepcao',
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-clinic-schedule',
      name: 'schedule',
      question: '1',
      answer: 'Para agendar, envie seu nome completo, especialidade desejada e os melhores dias/horarios para atendimento.',
      x: 420,
      y: 360
    }),
    intent({
      id: 'cc-clinic-prices',
      name: 'prices',
      question: '2',
      answer: 'Para valores e convenios, envie a especialidade ou procedimento. A recepcao confirma as opcoes disponiveis.',
      x: 680,
      y: 360
    }),
    intent({
      id: 'cc-clinic-human-handoff',
      name: 'human_handoff',
      question: '3',
      answer: 'Certo, vou chamar a recepcao. Descreva em uma mensagem o que voce precisa.',
      x: 940,
      y: 360
    })
  ]
});

const CHATCASE_TEMPLATES = [
  WHATSAPP_MENU_BASIC,
  ECOMMERCE_ORDERS,
  CLINIC_SCHEDULING
];

const TEMPLATE_BY_ID = CHATCASE_TEMPLATES.reduce((acc, template) => {
  acc[template._id] = template;
  return acc;
}, {});

function getMetadata(template) {
  const { intents, webhook_url, webhook_enabled, ...metadata } = template;
  return Object.assign({}, metadata, { intentsCount: intents.length });
}

function listMetadata() {
  return CHATCASE_TEMPLATES.map(getMetadata).map(clone);
}

function getTemplateById(id) {
  return TEMPLATE_BY_ID[id] ? clone(TEMPLATE_BY_ID[id]) : null;
}

function getTemplatePayloadById(id) {
  const template = getTemplateById(id);

  if (!template) {
    return null;
  }

  return {
    webhook_enabled: template.webhook_enabled,
    webhook_url: template.webhook_url,
    language: template.language,
    name: template.name,
    title: template.title,
    short_description: template.short_description,
    description: template.description,
    type: template.type,
    subtype: template.subtype,
    intentsEngine: template.intentsEngine,
    mainCategory: template.mainCategory,
    attributes: template.attributes,
    intents: template.intents
  };
}

function getTemplateExportById(id) {
  const template = getTemplatePayloadById(id);

  if (!template) {
    return null;
  }

  return Object.assign({}, template, {
    _id: id,
    source: 'chatcase-template-export',
    exportedAt: new Date().toISOString()
  });
}

module.exports = {
  CHATCASE_WHATSAPP_MENU_BASIC_ID: CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
  CHATCASE_TEMPLATE_IDS,
  listMetadata,
  getTemplateById,
  getTemplatePayloadById,
  getTemplateExportById
};
