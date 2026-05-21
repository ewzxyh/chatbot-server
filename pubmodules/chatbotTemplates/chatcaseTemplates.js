const CHATCASE_WHATSAPP_MENU_BASIC_ID = 'chatcase-whatsapp-menu-basic';

const WHATSAPP_MENU_BASIC = {
  _id: CHATCASE_WHATSAPP_MENU_BASIC_ID,
  certified: true,
  public: true,
  language: 'pt',
  name: 'ChatCase WhatsApp menu basico',
  title: 'Menu basico para WhatsApp',
  description: 'Fluxo inicial de automacao para canais de mensagem: saudacao, menu numerico, planos e encaminhamento para atendimento humano.',
  short_description: 'Menu inicial para WhatsApp, CaseZap e Telegram com saudacao, opcoes numericas e handoff para atendimento humano.',
  shortDescription: 'Menu inicial para WhatsApp, CaseZap e Telegram com saudacao, opcoes numericas e handoff para atendimento humano.',
  type: 'tilebot',
  subtype: 'chatbot',
  intentsEngine: 'none',
  mainCategory: 'Customer Satisfaction',
  bigImage: '/dashboard/assets/img/logos/chatcase-logo.svg',
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
  id_project: 'chatcase-system-templates',
  createdBy: 'chatcase',
  attributes: {
    source: 'chatcase-static-template',
    channels: ['whatsapp', 'casezap', 'telegram'],
    rules: []
  },
  webhook_enabled: false,
  webhook_url: undefined,
  intents: [
    {
      webhook_enabled: false,
      enabled: true,
      intent_id: 'cc-default-fallback',
      intent_display_name: 'defaultFallback',
      answer: 'Nao entendi sua mensagem. Digite menu para ver as opcoes ou 2 para falar com uma atendente.',
      actions: [
        {
          _tdActionType: 'reply',
          text: 'Nao entendi sua mensagem. Digite menu para ver as opcoes ou 2 para falar com uma atendente.',
          attributes: {
            disableInputMessage: false,
            commands: [
              { type: 'wait', time: 300 },
              {
                type: 'message',
                message: {
                  type: 'text',
                  text: 'Nao entendi sua mensagem. Digite menu para ver as opcoes ou 2 para falar com uma atendente.'
                }
              }
            ]
          }
        }
      ],
      attributes: {
        position: { x: 720, y: 500 }
      }
    },
    {
      webhook_enabled: false,
      enabled: true,
      intent_id: 'cc-start',
      intent_display_name: 'start',
      question: '\\start',
      answer: 'Ola! Sou o assistente ChatCase.\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.',
      actions: [
        {
          _tdActionType: 'reply',
          text: 'Ola! Sou o assistente ChatCase.\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.',
          attributes: {
            disableInputMessage: false,
            commands: [
              { type: 'wait', time: 300 },
              {
                type: 'message',
                message: {
                  type: 'text',
                  text: 'Ola! Sou o assistente ChatCase.\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.'
                }
              }
            ]
          }
        }
      ],
      attributes: {
        position: { x: 150, y: 160 }
      }
    },
    {
      webhook_enabled: false,
      enabled: true,
      intent_id: 'cc-menu',
      intent_display_name: 'menu',
      question: 'menu',
      answer: 'Menu ChatCase:\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.',
      actions: [
        {
          _tdActionType: 'reply',
          text: 'Menu ChatCase:\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.',
          attributes: {
            disableInputMessage: false,
            commands: [
              { type: 'wait', time: 300 },
              {
                type: 'message',
                message: {
                  type: 'text',
                  text: 'Menu ChatCase:\n\n1 - Ver planos\n2 - Falar com atendente\n\nResponda com 1 ou 2.'
                }
              }
            ]
          }
        }
      ],
      attributes: {
        position: { x: 460, y: 160 }
      }
    },
    {
      webhook_enabled: false,
      enabled: true,
      intent_id: 'cc-plans',
      intent_display_name: 'plans',
      question: '1',
      answer: 'Planos ChatCase:\n\n- Starter: atendimento basico e canais essenciais.\n- Business: automacoes, equipe e integracoes avancadas.\n\nDigite 2 para falar com uma atendente ou menu para voltar.',
      actions: [
        {
          _tdActionType: 'reply',
          text: 'Planos ChatCase:\n\n- Starter: atendimento basico e canais essenciais.\n- Business: automacoes, equipe e integracoes avancadas.\n\nDigite 2 para falar com uma atendente ou menu para voltar.',
          attributes: {
            disableInputMessage: false,
            commands: [
              { type: 'wait', time: 300 },
              {
                type: 'message',
                message: {
                  type: 'text',
                  text: 'Planos ChatCase:\n\n- Starter: atendimento basico e canais essenciais.\n- Business: automacoes, equipe e integracoes avancadas.\n\nDigite 2 para falar com uma atendente ou menu para voltar.'
                }
              }
            ]
          }
        }
      ],
      attributes: {
        position: { x: 460, y: 360 }
      }
    },
    {
      webhook_enabled: false,
      enabled: true,
      intent_id: 'cc-human-handoff',
      intent_display_name: 'human_handoff',
      question: '2',
      answer: 'Certo, vou chamar uma atendente. Enquanto isso, descreva em uma mensagem o que voce precisa.',
      actions: [
        {
          _tdActionType: 'reply',
          text: 'Certo, vou chamar uma atendente. Enquanto isso, descreva em uma mensagem o que voce precisa.',
          attributes: {
            disableInputMessage: false,
            commands: [
              { type: 'wait', time: 300 },
              {
                type: 'message',
                message: {
                  type: 'text',
                  text: 'Certo, vou chamar uma atendente. Enquanto isso, descreva em uma mensagem o que voce precisa.'
                }
              }
            ]
          }
        }
      ],
      attributes: {
        position: { x: 760, y: 360 }
      }
    }
  ]
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getMetadata(template) {
  const { intents, webhook_url, webhook_enabled, ...metadata } = template;
  return metadata;
}

function listMetadata() {
  return [getMetadata(WHATSAPP_MENU_BASIC)].map(clone);
}

function getTemplateById(id) {
  if (id !== CHATCASE_WHATSAPP_MENU_BASIC_ID) {
    return null;
  }

  return clone(WHATSAPP_MENU_BASIC);
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

module.exports = {
  CHATCASE_WHATSAPP_MENU_BASIC_ID,
  listMetadata,
  getTemplateById,
  getTemplatePayloadById
};
