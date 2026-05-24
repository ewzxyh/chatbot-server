const CHATCASE_TEMPLATE_IDS = {
  WHATSAPP_MENU_BASIC: 'chatcase-whatsapp-menu-basic',
  ECOMMERCE_ORDERS: 'chatcase-ecommerce-orders',
  CLINIC_SCHEDULING: 'chatcase-clinic-scheduling',
  RESTAURANT_DELIVERY: 'chatcase-restaurant-delivery',
  REAL_ESTATE_LEADS: 'chatcase-real-estate-leads',
  EDUCATION_COURSES: 'chatcase-education-courses'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function textButton(value) {
  return {
    type: 'text',
    value,
    label: value
  };
}

function messageAction(text, buttons) {
  const message = {
    type: 'text',
    text
  };

  if (buttons && buttons.length) {
    message.attributes = {
      attachment: {
        type: 'text',
        buttons: buttons.map(textButton)
      }
    };
  }

  return {
    _tdActionType: 'reply',
    text,
    attributes: {
      disableInputMessage: false,
      commands: [
        { type: 'wait', time: 300 },
        {
          type: 'message',
          message
        }
      ]
    }
  };
}

function intent({ id, name, question, answer, buttons, aliases, x, y }) {
  const item = {
    webhook_enabled: false,
    enabled: true,
    intent_id: id,
    intent_display_name: name,
    answer,
    actions: [messageAction(answer, buttons)],
    attributes: {
      position: { x, y },
      aliases: aliases || []
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
    nativeInteractions: {
      whatsapp: 'buttons',
      casezap: 'menu'
    },
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
      buttons: ['Ver planos', 'Falar atendente'],
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-menu',
      name: 'menu',
      question: 'menu',
      aliases: ['Menu'],
      answer: 'Menu ChatCase:\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.',
      buttons: ['Ver planos', 'Falar atendente'],
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-plans',
      name: 'plans',
      question: '1',
      aliases: ['Ver planos'],
      answer: 'Planos ChatCase:\n\n- Starter: atendimento basico e canais essenciais.\n- Business: automacoes, equipe e integracoes avancadas.\n\nDigite 2 para falar com uma atendente ou menu para voltar.',
      buttons: ['Falar atendente', 'Menu'],
      x: 460,
      y: 360
    }),
    intent({
      id: 'cc-human-handoff',
      name: 'human_handoff',
      question: '2',
      aliases: ['Falar atendente', 'Atendente'],
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
    nativeInteractions: {
      whatsapp: 'buttons',
      casezap: 'menu'
    },
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
      buttons: ['Status pedido', 'Trocas', 'Atendente'],
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-ecommerce-menu',
      name: 'menu',
      question: 'menu',
      answer: 'Menu da loja:\n\n1 - Status do pedido\n2 - Trocas ou devolucoes\n3 - Falar com atendente',
      buttons: ['Status pedido', 'Trocas', 'Atendente'],
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-ecommerce-order-status',
      name: 'order_status',
      question: '1',
      aliases: ['Status pedido', 'Pedido', 'Entrega'],
      answer: 'Para consultar seu pedido, envie o numero do pedido ou CPF usado na compra. Uma atendente confirma o status em seguida.',
      x: 420,
      y: 360
    }),
    intent({
      id: 'cc-ecommerce-exchange-return',
      name: 'exchange_return',
      question: '2',
      aliases: ['Trocas', 'Devolucao', 'Trocas ou devolucoes'],
      answer: 'Para troca ou devolucao, envie o numero do pedido, o item e o motivo. Vamos conferir a politica e te orientar.',
      x: 680,
      y: 360
    }),
    intent({
      id: 'cc-ecommerce-human-handoff',
      name: 'human_handoff',
      question: '3',
      aliases: ['Atendente', 'Falar com atendente'],
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
    nativeInteractions: {
      whatsapp: 'buttons',
      casezap: 'menu'
    },
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
      buttons: ['Agendar', 'Valores', 'Recepcao'],
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-clinic-menu',
      name: 'menu',
      question: 'menu',
      answer: 'Menu da recepcao:\n\n1 - Agendar horario\n2 - Valores e convenios\n3 - Falar com recepcao',
      buttons: ['Agendar', 'Valores', 'Recepcao'],
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-clinic-schedule',
      name: 'schedule',
      question: '1',
      aliases: ['Agendar', 'Agendar horario'],
      answer: 'Para agendar, envie seu nome completo, especialidade desejada e os melhores dias/horarios para atendimento.',
      x: 420,
      y: 360
    }),
    intent({
      id: 'cc-clinic-prices',
      name: 'prices',
      question: '2',
      aliases: ['Valores', 'Convenios', 'Valores e convenios'],
      answer: 'Para valores e convenios, envie a especialidade ou procedimento. A recepcao confirma as opcoes disponiveis.',
      x: 680,
      y: 360
    }),
    intent({
      id: 'cc-clinic-human-handoff',
      name: 'human_handoff',
      question: '3',
      aliases: ['Recepcao', 'Falar com recepcao'],
      answer: 'Certo, vou chamar a recepcao. Descreva em uma mensagem o que voce precisa.',
      x: 940,
      y: 360
    })
  ]
});

const RESTAURANT_DELIVERY = createTemplate({
  _id: CHATCASE_TEMPLATE_IDS.RESTAURANT_DELIVERY,
  name: 'ChatCase Restaurante e delivery',
  title: 'Restaurante e delivery',
  description: 'Fluxo para restaurantes, lanchonetes e operacoes de delivery com cardapio, horario, status do pedido e atendimento humano.',
  short_description: 'Menu para cardapio, horario de funcionamento, status do pedido e atendimento.',
  shortDescription: 'Menu para cardapio, horario de funcionamento, status do pedido e atendimento.',
  mainCategory: 'Increase Sales',
  tags: ['whatsapp', 'casezap', 'restaurante', 'delivery', 'cardapio', 'pedidos'],
  certifiedTags: [
    { name: 'WhatsApp', color: '#25833e' },
    { name: 'CaseZap', color: '#0049bd' }
  ],
  templateFeatures: [
    'Atendimento inicial para delivery',
    'Opcoes de cardapio, horario e status do pedido',
    'Handoff para atendente quando precisar'
  ],
  attributes: {
    source: 'chatcase-static-template',
    channels: ['whatsapp', 'casezap'],
    segment: 'restaurant',
    nativeInteractions: {
      whatsapp: 'buttons',
      casezap: 'menu'
    },
    rules: []
  },
  intents: [
    intent({
      id: 'cc-restaurant-default-fallback',
      name: 'defaultFallback',
      answer: 'Nao entendi sua mensagem. Digite menu para ver as opcoes do restaurante.',
      x: 740,
      y: 520
    }),
    intent({
      id: 'cc-restaurant-start',
      name: 'start',
      question: '\\start',
      answer: 'Ola! Sou o assistente do restaurante.\n\n1 - Ver cardapio\n2 - Horario e entrega\n3 - Status do pedido\n4 - Falar com atendente\n\nResponda com o numero da opcao.',
      buttons: ['Cardapio', 'Horario', 'Pedido', 'Atendente'],
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-restaurant-menu',
      name: 'menu',
      question: 'menu',
      aliases: ['Menu'],
      answer: 'Menu do restaurante:\n\n1 - Ver cardapio\n2 - Horario e entrega\n3 - Status do pedido\n4 - Falar com atendente',
      buttons: ['Cardapio', 'Horario', 'Pedido', 'Atendente'],
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-restaurant-menu-link',
      name: 'menu_link',
      question: '1',
      aliases: ['Cardapio', 'Ver cardapio'],
      answer: 'Envie aqui o link do seu cardapio ou substitua esta mensagem pelo cardapio do dia. Para fazer um pedido, informe os itens e o endereco de entrega.',
      x: 300,
      y: 360
    }),
    intent({
      id: 'cc-restaurant-hours',
      name: 'hours_delivery',
      question: '2',
      aliases: ['Horario', 'Horario e entrega', 'Entrega'],
      answer: 'Nosso horario de atendimento e entrega pode ser configurado aqui. Informe seu bairro para confirmarmos prazo e taxa de entrega.',
      x: 540,
      y: 360
    }),
    intent({
      id: 'cc-restaurant-order-status',
      name: 'order_status',
      question: '3',
      aliases: ['Pedido', 'Status do pedido', 'Status pedido'],
      answer: 'Para consultar seu pedido, envie o nome usado na compra ou o numero do pedido.',
      x: 780,
      y: 360
    }),
    intent({
      id: 'cc-restaurant-human-handoff',
      name: 'human_handoff',
      question: '4',
      aliases: ['Atendente', 'Falar com atendente'],
      answer: 'Certo, vou chamar uma atendente. Descreva em uma mensagem o que voce precisa.',
      x: 1020,
      y: 360
    })
  ]
});

const REAL_ESTATE_LEADS = createTemplate({
  _id: CHATCASE_TEMPLATE_IDS.REAL_ESTATE_LEADS,
  name: 'ChatCase Imobiliaria e visitas',
  title: 'Imobiliaria e visitas',
  description: 'Fluxo para imobiliarias e corretores captarem interesse, filtrarem compra ou aluguel, agendarem visitas e encaminharem para atendimento.',
  short_description: 'Menu para compra, aluguel, agendamento de visita e atendimento com corretor.',
  shortDescription: 'Menu para compra, aluguel, agendamento de visita e atendimento com corretor.',
  mainCategory: 'Increase Sales',
  tags: ['whatsapp', 'casezap', 'imobiliaria', 'imoveis', 'visitas', 'leads'],
  certifiedTags: [
    { name: 'WhatsApp', color: '#25833e' },
    { name: 'CaseZap', color: '#0049bd' }
  ],
  templateFeatures: [
    'Qualificacao inicial para compra ou aluguel',
    'Coleta de bairro, faixa de valor e tipo de imovel',
    'Agendamento de visita com corretor'
  ],
  attributes: {
    source: 'chatcase-static-template',
    channels: ['whatsapp', 'casezap'],
    segment: 'real-estate',
    nativeInteractions: {
      whatsapp: 'buttons',
      casezap: 'menu'
    },
    rules: []
  },
  intents: [
    intent({
      id: 'cc-real-estate-default-fallback',
      name: 'defaultFallback',
      answer: 'Nao entendi sua mensagem. Digite menu para ver as opcoes da imobiliaria.',
      x: 740,
      y: 520
    }),
    intent({
      id: 'cc-real-estate-start',
      name: 'start',
      question: '\\start',
      answer: 'Ola! Sou o assistente da imobiliaria.\n\n1 - Comprar imovel\n2 - Alugar imovel\n3 - Agendar visita\n4 - Falar com corretor\n\nResponda com o numero da opcao.',
      buttons: ['Comprar', 'Alugar', 'Visita', 'Corretor'],
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-real-estate-menu',
      name: 'menu',
      question: 'menu',
      aliases: ['Menu'],
      answer: 'Menu da imobiliaria:\n\n1 - Comprar imovel\n2 - Alugar imovel\n3 - Agendar visita\n4 - Falar com corretor',
      buttons: ['Comprar', 'Alugar', 'Visita', 'Corretor'],
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-real-estate-buy',
      name: 'buy_property',
      question: '1',
      aliases: ['Comprar', 'Comprar imovel'],
      answer: 'Para compra, envie bairro desejado, tipo de imovel, faixa de valor e se precisa de financiamento.',
      x: 300,
      y: 360
    }),
    intent({
      id: 'cc-real-estate-rent',
      name: 'rent_property',
      question: '2',
      aliases: ['Alugar', 'Alugar imovel'],
      answer: 'Para aluguel, envie bairro desejado, tipo de imovel, faixa de valor e data prevista de mudanca.',
      x: 540,
      y: 360
    }),
    intent({
      id: 'cc-real-estate-visit',
      name: 'schedule_visit',
      question: '3',
      aliases: ['Visita', 'Agendar visita'],
      answer: 'Para agendar visita, envie o codigo ou link do imovel e os melhores dias/horarios.',
      x: 780,
      y: 360
    }),
    intent({
      id: 'cc-real-estate-human-handoff',
      name: 'human_handoff',
      question: '4',
      aliases: ['Corretor', 'Falar com corretor'],
      answer: 'Certo, vou chamar um corretor. Descreva em uma mensagem o que voce procura.',
      x: 1020,
      y: 360
    })
  ]
});

const EDUCATION_COURSES = createTemplate({
  _id: CHATCASE_TEMPLATE_IDS.EDUCATION_COURSES,
  name: 'ChatCase Cursos e matriculas',
  title: 'Cursos e matriculas',
  description: 'Fluxo para escolas, cursos livres e treinamentos responderem sobre cursos, valores, matricula e atendimento humano.',
  short_description: 'Menu para cursos, valores, matricula e atendimento com consultor.',
  shortDescription: 'Menu para cursos, valores, matricula e atendimento com consultor.',
  mainCategory: 'Increase Sales',
  tags: ['whatsapp', 'casezap', 'educacao', 'cursos', 'matriculas', 'leads'],
  certifiedTags: [
    { name: 'WhatsApp', color: '#25833e' },
    { name: 'CaseZap', color: '#0049bd' }
  ],
  templateFeatures: [
    'Triagem de interesse por curso',
    'Resposta inicial sobre valores e formas de pagamento',
    'Encaminhamento para consultor de matricula'
  ],
  attributes: {
    source: 'chatcase-static-template',
    channels: ['whatsapp', 'casezap'],
    segment: 'education',
    nativeInteractions: {
      whatsapp: 'buttons',
      casezap: 'menu'
    },
    rules: []
  },
  intents: [
    intent({
      id: 'cc-education-default-fallback',
      name: 'defaultFallback',
      answer: 'Nao entendi sua mensagem. Digite menu para ver as opcoes de atendimento.',
      x: 740,
      y: 520
    }),
    intent({
      id: 'cc-education-start',
      name: 'start',
      question: '\\start',
      answer: 'Ola! Sou o assistente de matriculas.\n\n1 - Ver cursos\n2 - Valores e bolsas\n3 - Fazer matricula\n4 - Falar com consultor\n\nResponda com o numero da opcao.',
      buttons: ['Cursos', 'Valores', 'Matricula', 'Consultor'],
      x: 150,
      y: 160
    }),
    intent({
      id: 'cc-education-menu',
      name: 'menu',
      question: 'menu',
      aliases: ['Menu'],
      answer: 'Menu de atendimento:\n\n1 - Ver cursos\n2 - Valores e bolsas\n3 - Fazer matricula\n4 - Falar com consultor',
      buttons: ['Cursos', 'Valores', 'Matricula', 'Consultor'],
      x: 460,
      y: 160
    }),
    intent({
      id: 'cc-education-courses',
      name: 'courses',
      question: '1',
      aliases: ['Cursos', 'Ver cursos'],
      answer: 'Informe a area de interesse ou substitua esta mensagem pela lista de cursos disponiveis da escola.',
      x: 300,
      y: 360
    }),
    intent({
      id: 'cc-education-pricing',
      name: 'pricing',
      question: '2',
      aliases: ['Valores', 'Valores e bolsas', 'Bolsas'],
      answer: 'Para valores e bolsas, envie o curso de interesse e a modalidade desejada. Um consultor confirma as condicoes.',
      x: 540,
      y: 360
    }),
    intent({
      id: 'cc-education-enrollment',
      name: 'enrollment',
      question: '3',
      aliases: ['Matricula', 'Fazer matricula'],
      answer: 'Para iniciar a matricula, envie nome completo, curso desejado, telefone e melhor horario para contato.',
      x: 780,
      y: 360
    }),
    intent({
      id: 'cc-education-human-handoff',
      name: 'human_handoff',
      question: '4',
      aliases: ['Consultor', 'Falar com consultor'],
      answer: 'Certo, vou chamar um consultor. Descreva em uma mensagem sua duvida.',
      x: 1020,
      y: 360
    })
  ]
});

const CHATCASE_TEMPLATES = [
  WHATSAPP_MENU_BASIC,
  ECOMMERCE_ORDERS,
  CLINIC_SCHEDULING,
  RESTAURANT_DELIVERY,
  REAL_ESTATE_LEADS,
  EDUCATION_COURSES
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
