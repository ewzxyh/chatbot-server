const axios = require('axios').default;
const winston = require('../winston');

class WhatsappService {

    constructor() {

        const requiredVars = ["FB_APP_ID", "FB_APP_SECRET", "META_GRAPH_URL"]
        const missing = requiredVars.filter(v => !process.env[v]);

        if (missing.length > 0) {
            throw new Error(`Missing variables: ${missing.join(", ")}`);
        }

        this.fb_app_id = process.env.FB_APP_ID;
        this.fb_app_secret = process.env.FB_APP_SECRET;
        this.graph_url = process.env.META_GRAPH_URL || process.env.GRAPH_URL;

    }

    /**
     *  ONBOARDING SECTION - START
     */
    async handleOnboarding(code, business_id, waba_id, phone_number_id) {

        try {
            const { access_token: shortLivedToken } = await this.exchangeCodeForToken(code);
            const { access_token: accessToken } = await this.getLongLivedAccessToken(shortLivedToken);
            const business = await this.getBusinessAccount(business_id, accessToken);
            const waba = await this.getWabaAccount(waba_id, accessToken);
            const phone = await this.getPhoneNumberInfo(phone_number_id, accessToken);

            return {
                access_token: accessToken,
                business_account_id: business.id,
                waba_id: waba.id,
                phone_number: phone.display_phone_number,
                phone_number_id: phone.id,
                verified_name: phone.verified_name
            };

        } catch (err) {
            winston.error("(wab) handle onboarding error: ", err);
            throw new Error(err.response?.data?.error?.message || err.message || "Unknown error");
        }
    }

    async exchangeCodeForToken(code) {
        const res = await axios.get(`${this.graph_url}oauth/access_token`, {
            params: {
                client_id: this.fb_app_id,
                client_secret: this.fb_app_secret,
                redirect_uri: "",
                code: code
            }
        });
        return res.data;
    }

    async getLongLivedAccessToken(short_lived_token) {
        const res = await axios.get(`${this.graph_url}oauth/access_token`, {
            params: {
                grant_type: 'fb_exchange_token',
                client_id: this.fb_app_id,
                client_secret: this.fb_app_secret,
                fb_exchange_token: short_lived_token
            }
        });
        return res.data;
    }

    async getBusinessAccount(business_id, access_token) {
        const res = await axios.get(`${this.graph_url}${business_id}`, {
            params: {
                fields: "name",
                access_token: access_token
            }
        });
        return res.data;
    }

    async getWabaAccount(waba_id, access_token) {
        const res = await axios.get(`${this.graph_url}${waba_id}`, {
            params: {
                fields: "timezone_id",
                access_token: access_token
            }
        });
        return res.data;
    }

    async getPhoneNumberInfo(phone_number_id, access_token) {
        const res = await axios.get(`${this.graph_url}${phone_number_id}`, {
            params: {
                fields: "display_phone_number,verified_name,quality_rating",
                access_token: access_token
            }
        });
        return res.data;
    }
    /**
     *  ONBOARDING SECTION - END
     */

    
    async registerNumber(access_token, phone_number_id, pin,) {
        const finalPin = (pin === null || pin === undefined) ? "123456" : pin;
        let data = JSON.stringify({
            "messaging_product": "whatsapp",
            "pin": finalPin
        })

        let headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + access_token,
        }
        try {
            const res = await axios.post(
                `${this.graph_url}${phone_number_id}/register`, 
                data,
                { headers }
            );
            winston.verbose("(wab) register number response: ", res.data);
            return res.data;
        } catch (error) {
            console.error('(wab) error registering number:', error.response?.data || error.message);
            throw error; 
        }
    }

    async connectNumber(access_token, waba_id) {
        try {
            const res = await axios.post(`${this.graph_url}${waba_id}/subscribed_apps`, {}, {
                params: {
                    access_token: access_token
                }
            });
            winston.verbose("(wab) connect number response: ", res.data);
            return res.data;
        } catch (error) {
            console.error('(wab) error connecting number:', error.response?.data || error.message);
            throw error; 
        }
    }

}

const whatsappService = new WhatsappService();
module.exports = whatsappService;

