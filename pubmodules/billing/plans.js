const PLANS = {
  free: {
    name: 'Free',
    displayName: 'Iniciante',
    type: 'free',
    agents: 1,
    monthlyPrice: 0,
    annualPrice: 0,
    quotes: { chatbots: 2, kbs: 1, namespace: 1, contacts: 200, platforms: 1 },
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
    displayName: 'Standard',
    type: 'payment',
    agents: 5,
    monthlyPrice: 279,
    annualPrice: 2845.80,
    quotes: { chatbots: 5, kbs: 3, namespace: 3, contacts: 1000, platforms: 1 },
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
    displayName: 'Pro',
    type: 'payment',
    agents: 5,
    monthlyPrice: 549,
    annualPrice: 5599.80,
    quotes: { chatbots: 20, kbs: 10, namespace: 10, contacts: 11000, platforms: 5 },
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
    displayName: 'Enterprise',
    type: 'payment',
    agents: 10,
    monthlyPrice: 997,
    annualPrice: 10169.40,
    quotes: { chatbots: 100, kbs: 50, namespace: 50, contacts: 50000, platforms: 5 },
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
