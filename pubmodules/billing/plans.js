const PLANS = {
  free: {
    name: 'Free',
    type: 'free',
    agents: 1,
    quotes: { chatbots: 2, kbs: 1, namespace: 1 },
    customization: {
      copilot: false,
      webhook: false,
      widgetUnbranding: false,
      smtpSettings: false,
      knowledgeBases: true,
      reindex: false,
      messanger: false,
      telegram: false,
      whatsapp: false,
      chatbot: true
    }
  },
  starter: {
    name: 'Starter',
    type: 'payment',
    agents: 3,
    quotes: { chatbots: 5, kbs: 3, namespace: 3 },
    customization: {
      copilot: false,
      webhook: true,
      widgetUnbranding: true,
      smtpSettings: false,
      knowledgeBases: true,
      reindex: false,
      messanger: false,
      telegram: true,
      whatsapp: true,
      chatbot: true
    }
  },
  pro: {
    name: 'Pro',
    type: 'payment',
    agents: 10,
    quotes: { chatbots: 20, kbs: 10, namespace: 10 },
    customization: {
      copilot: true,
      webhook: true,
      widgetUnbranding: true,
      smtpSettings: true,
      knowledgeBases: true,
      reindex: true,
      messanger: true,
      telegram: true,
      whatsapp: true,
      chatbot: true
    }
  },
  business: {
    name: 'Business',
    type: 'payment',
    agents: 1000,
    quotes: { chatbots: 100, kbs: 50, namespace: 50 },
    customization: {
      copilot: true,
      webhook: true,
      widgetUnbranding: true,
      smtpSettings: true,
      knowledgeBases: true,
      reindex: true,
      messanger: true,
      telegram: true,
      whatsapp: true,
      chatbot: true
    }
  }
};

function getPlan(planName) {
  return PLANS[planName.toLowerCase()] || PLANS.free;
}

function getAllPlans() {
  return Object.entries(PLANS).map(([key, plan]) => ({ key, ...plan }));
}

module.exports = { PLANS, getPlan, getAllPlans };
