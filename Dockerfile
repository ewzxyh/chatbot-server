FROM node:18-bullseye

RUN sed -i 's/stable\/updates/stable-security\/updates/' /etc/apt/sources.list


RUN apt-get update

# Create app directory
WORKDIR /usr/src/app

ARG NPM_TOKEN

RUN if [ "$NPM_TOKEN" ]; \
    then RUN COPY .npmrc_ .npmrc \
    else export SOMEVAR=world; \
    fi


# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install --production

RUN sed -i "s/scope: 'whatsapp_business_management,business_management,pages_show_list'/scope: 'whatsapp_business_management,whatsapp_business_messaging'/" node_modules/@tiledesk/tiledesk-whatsapp-connector/template/configure.html || true

RUN rm -f .npmrc

# Bundle app source
COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]

